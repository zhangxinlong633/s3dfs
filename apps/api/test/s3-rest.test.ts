import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { crc32 } from '@s3dfs/control';
import { handleS3, type S3Backend, type S3Request } from '../src/s3/handle';
import { MemoryUploadStore, MultipartUploads } from '../src/s3/multipart';
import { MemoryConfigStore, MemoryObjectMeta, MemoryVersionStore, sseKeyFromSecret } from '../src/s3/product';
import { signRequest, type SigV4Identity } from '../src/s3/sigv4';

const identity: SigV4Identity = { accessKeyId: 'AKID', secretAccessKey: 'secret' };

class MemBackend implements S3Backend {
  buckets = new Map<string, number>();
  objects = new Map<string, { body: Buffer; mtimeMs: number }>();

  async createBucket(bucket: string): Promise<void> {
    if (!this.buckets.has(bucket)) this.buckets.set(bucket, 1);
  }
  async bucketExists(bucket: string): Promise<boolean> {
    return this.buckets.has(bucket) || [...this.objects.keys()].some((key) => key.startsWith(`${bucket}/`));
  }
  async deleteBucket(): Promise<'ok' | 'missing' | 'notempty'> {
    return 'ok';
  }
  async listBuckets() {
    return [];
  }
  async list(bucket: string) {
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(`${bucket}/`))
      .map(([key, value]) => ({
        key: key.slice(bucket.length + 1),
        size: value.body.length,
        crc: crc32(value.body),
        mtimeMs: value.mtimeMs,
      }));
    return { truncated: false, objects, prefixes: [] as string[] };
  }
  async put(bucket: string, key: string, value: Buffer): Promise<void> {
    await this.createBucket(bucket);
    this.objects.set(`${bucket}/${key}`, { body: Buffer.from(value), mtimeMs: 1_000 });
  }
  async head(bucket: string, key: string) {
    const value = this.objects.get(`${bucket}/${key}`);
    if (!value) return null;
    return { size: value.body.length, crc: crc32(value.body), mtimeMs: value.mtimeMs, compressType: 'none' as const };
  }
  async get(bucket: string, key: string) {
    const meta = await this.head(bucket, key);
    const value = this.objects.get(`${bucket}/${key}`);
    if (!meta || !value) return null;
    return { ...meta, value: value.body };
  }
  async getRange(bucket: string, key: string, start: number, end: number) {
    const got = await this.get(bucket, key);
    if (!got) return null;
    const value = got.value.subarray(start, end + 1);
    return { ...got, value, size: value.length, totalSize: got.size };
  }
  async delete(bucket: string, key: string): Promise<boolean> {
    return this.objects.delete(`${bucket}/${key}`);
  }
}

function call(backend: MemBackend, init: Partial<S3Request> & { method: string; path: string }, options = {}) {
  const url = new URL(init.path, 'http://127.0.0.1:9000');
  const uploads = (options as { uploads?: MultipartUploads }).uploads ?? new MultipartUploads();
  return handleS3(
    {
      method: init.method,
      path: url.pathname,
      query: url.searchParams,
      headers: init.headers ?? {},
      body: init.body ?? Buffer.alloc(0),
      host: init.host ?? '127.0.0.1:9000',
      now: init.now,
    },
    backend,
    uploads,
    options,
  );
}

function authorize(method: string, path: string, body: Buffer, now: number): Record<string, string> {
  const url = new URL(path, 'http://127.0.0.1:9000');
  const amzDate = '20261120T120000Z';
  const scope = '20261120/us-east-1/s3/aws4_request';
  const payloadHash = createHash('sha256').update(body).digest('hex');
  const headers: Record<string, string> = {
    host: '127.0.0.1:9000',
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    authorization: 'AWS4-HMAC-SHA256 Credential=AKID/20261120/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=00',
  };
  const signature = signRequest(identity.secretAccessKey, {
    method,
    path: url.pathname,
    query: url.searchParams,
    headers,
    body,
    now,
  }, amzDate, scope);
  headers.authorization = `AWS4-HMAC-SHA256 Credential=AKID/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`;
  return headers;
}

describe('s3 surface that was still open', () => {
  test('checks SigV4 when access keys are configured', async () => {
    const backend = new MemBackend();
    const body = Buffer.from('signed');
    const now = Date.parse('2026-11-20T12:00:30Z');
    const ok = await call(backend, { method: 'PUT', path: '/logs/a.txt', body, headers: authorize('PUT', '/logs/a.txt', body, now), now }, { credentials: identity });
    expect(ok.status).toBe(200);
    expect(ok.headers['x-s3dfs-etag-algorithm']).toBe('crc32');
    const denied = await call(backend, { method: 'GET', path: '/logs/a.txt', now }, { credentials: identity });
    expect(denied.status).toBe(403);
  });

  test('accepts a presigned query and a virtual-host bucket', async () => {
    const backend = new MemBackend();
    await backend.put('pics', 'a.txt', Buffer.from('pic'));
    const amzDate = '20261120T120000Z';
    const scope = '20261120/us-east-1/s3/aws4_request';
    const query = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `AKID/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': '60',
      'X-Amz-SignedHeaders': 'host',
    });
    const headers = { host: '127.0.0.1:9000', authorization: '' };
    const signature = signRequest(identity.secretAccessKey, {
      method: 'GET',
      path: '/pics/a.txt',
      query,
      headers,
      body: Buffer.alloc(0),
    }, amzDate, scope);
    query.set('X-Amz-Signature', signature);
    const res = await call(
      backend,
      { method: 'GET', path: `/pics/a.txt?${query}`, headers, now: Date.parse('2026-11-20T12:00:30Z') },
      { credentials: identity },
    );
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('pic');

    const virtual = await call(backend, { method: 'GET', path: '/a.txt', host: 'pics.localhost:9000' }, { domain: 'localhost' });
    expect(virtual.status).toBe(200);
    expect(virtual.body.toString()).toBe('pic');
  });

  test('checks Content-MD5 and copies an object', async () => {
    const backend = new MemBackend();
    const body = Buffer.from('copy-me');
    const md5 = createHash('md5').update(body).digest('base64');
    const bad = await call(backend, { method: 'PUT', path: '/logs/a.txt', body, headers: { 'content-md5': 'aaaa' } });
    expect(bad.status).toBe(400);
    const put = await call(backend, { method: 'PUT', path: '/logs/a.txt', body, headers: { 'content-md5': md5 } });
    expect(put.status).toBe(200);
    const copy = await call(backend, { method: 'PUT', path: '/logs/b.txt', headers: { 'x-amz-copy-source': '/logs/a.txt' } });
    expect(copy.status).toBe(200);
    expect(copy.body.toString()).toContain('<ETag>');
    expect(backend.objects.get('logs/b.txt')?.body.equals(body)).toBe(true);
  });

  test('keeps multipart parts in the store across a new uploads object', async () => {
    const backend = new MemBackend();
    const store = new MemoryUploadStore();
    const first = new MultipartUploads(store);
    const created = await call(backend, { method: 'POST', path: '/logs/big.bin?uploads' }, { uploads: first });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(created.body.toString())?.[1] ?? '';
    await call(backend, { method: 'PUT', path: `/logs/big.bin?partNumber=1&uploadId=${uploadId}`, body: Buffer.from('zz') }, { uploads: first });
    const second = new MultipartUploads(store);
    const listed = await call(backend, { method: 'GET', path: `/logs/big.bin?uploadId=${uploadId}` }, { uploads: second });
    expect(listed.status).toBe(200);
    expect(listed.body.toString()).toContain('<PartNumber>1</PartNumber>');
    expect(listed.body.toString()).toContain('<Size>2</Size>');
  });

  test('encrypts with one key, versions, denies by policy, expires, and posts a webhook', async () => {
    const backend = new MemBackend();
    const config = new MemoryConfigStore();
    const versions = new MemoryVersionStore();
    const events: unknown[] = [];
    const options = {
      config,
      versions,
      sseSecret: 'one-key',
      fetchImpl: (async (_url: string, init?: { body?: string }) => {
        events.push(JSON.parse(init?.body ?? '{}'));
        return new Response('ok');
      }) as typeof fetch,
    };
    await call(backend, { method: 'PUT', path: '/logs?versioning', body: Buffer.from('<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>') }, options);
    const put = await call(
      backend,
      { method: 'PUT', path: '/logs/secret.txt', body: Buffer.from('plain'), headers: { 'x-amz-server-side-encryption': 'AES256' } },
      options,
    );
    expect(put.headers['x-amz-server-side-encryption']).toBe('AES256');
    expect(put.headers['x-amz-version-id']).toBeTruthy();
    const stored = backend.objects.get('logs/secret.txt')?.body;
    expect(stored?.subarray(0, 4).toString()).toBe('S3E1');
    expect(sseKeyFromSecret('one-key')).toHaveLength(32);
    const read = await call(backend, { method: 'GET', path: '/logs/secret.txt' }, options);
    expect(read.body.toString()).toBe('plain');
    const versionId = put.headers['x-amz-version-id'] ?? '';
    await call(backend, { method: 'DELETE', path: '/logs/secret.txt' }, options);
    const old = await call(backend, { method: 'GET', path: `/logs/secret.txt?versionId=${versionId}` }, options);
    expect(old.body.toString()).toBe('plain');

    await call(
      backend,
      { method: 'PUT', path: '/logs?lifecycle', body: Buffer.from(JSON.stringify({ rules: [{ prefix: 'old/', days: 1 }] })) },
      options,
    );
    await backend.put('logs', 'old/a', Buffer.from('stale'));
    backend.objects.get('logs/old/a')!.mtimeMs = Date.now() - 3 * 86_400_000;
    const ran = await call(backend, { method: 'POST', path: '/logs?lifecycle', now: Date.now() }, options);
    expect(JSON.parse(ran.body.toString()).expired).toBe(1);
    expect(backend.objects.has('logs/old/a')).toBe(false);

    await call(
      backend,
      {
        method: 'PUT',
        path: '/logs?policy',
        body: Buffer.from(JSON.stringify({ Statement: [{ Effect: 'Deny', Action: 's3:GetObject', Resource: 'logs/*' }] })),
      },
      options,
    );
    const denied = await call(backend, { method: 'GET', path: `/logs/secret.txt?versionId=${versionId}` }, options);
    expect(denied.status).toBe(403);

    await call(backend, { method: 'PUT', path: '/logs?notification', body: Buffer.from(JSON.stringify({ url: 'http://hook.local/s3' })) }, options);
    await call(
      backend,
      { method: 'PUT', path: '/logs?policy', body: Buffer.from(JSON.stringify({ Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] })) },
      options,
    );
    await call(backend, { method: 'PUT', path: '/logs/note.txt', body: Buffer.from('n') }, options);
    expect(events.some((event) => (event as { event: string }).event === 's3:ObjectCreated:Put')).toBe(true);
  });

  test('expires noncurrent versions and reports how much the bucket holds', async () => {
    const backend = new MemBackend();
    const versions = new MemoryVersionStore();
    const config = new MemoryConfigStore();
    const options = { config, versions };
    const day = 86_400_000;
    await versions.put('logs', 'a.txt', { id: 'old', body: Buffer.from('old'), deleteMarker: false, mtimeMs: 1 });
    await versions.put('logs', 'a.txt', { id: 'new', body: Buffer.from('new'), deleteMarker: false, mtimeMs: day * 3 });
    const xml =
      '<LifecycleConfiguration><Rule><Prefix>a</Prefix><NoncurrentVersionExpiration><NoncurrentDays>1</NoncurrentDays></NoncurrentVersionExpiration></Rule></LifecycleConfiguration>';
    await call(backend, { method: 'PUT', path: '/logs?lifecycle', body: Buffer.from(xml) }, options);
    const ran = await call(backend, { method: 'POST', path: '/logs?lifecycle', now: day * 5 }, options);
    expect(JSON.parse(ran.body.toString()).noncurrent).toBe(1);
    expect(await versions.get('logs', 'a.txt', 'old')).toBeNull();
    expect((await versions.get('logs', 'a.txt', 'new'))?.id).toBe('new');

    await backend.put('logs', 'a.txt', Buffer.from('abcd'));
    const usage = await call(backend, { method: 'GET', path: '/logs?usage' });
    expect(JSON.parse(usage.body.toString())).toEqual({ objects: 1, bytes: 4 });
  });

  test('removes a delete marker once it is the only version', async () => {
    const backend = new MemBackend();
    const versions = new MemoryVersionStore();
    const config = new MemoryConfigStore();
    const options = { config, versions };
    await versions.put('logs', 'gone.txt', { id: 'marker', body: null, deleteMarker: true, mtimeMs: 1 });
    const xml =
      '<LifecycleConfiguration><Rule><Prefix></Prefix><Expiration><ExpiredObjectDeleteMarker>true</ExpiredObjectDeleteMarker></Expiration></Rule></LifecycleConfiguration>';
    await call(backend, { method: 'PUT', path: '/logs?lifecycle', body: Buffer.from(xml) }, options);
    const ran = await call(backend, { method: 'POST', path: '/logs?lifecycle', now: 10 }, options);
    expect(JSON.parse(ran.body.toString()).deleteMarkers).toBe(1);
    expect(await versions.get('logs', 'gone.txt', 'marker')).toBeNull();
  });

  test('retention blocks delete until the date, and governance can be bypassed', async () => {
    const backend = new MemBackend();
    const meta = new MemoryObjectMeta();
    const config = new MemoryConfigStore();
    const lock = '<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>';
    await call(backend, { method: 'PUT', path: '/logs?object-lock', body: Buffer.from(lock) }, { config, meta });
    await call(backend, { method: 'PUT', path: '/logs/keep.txt', body: Buffer.from('keep') }, { meta });
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const xml = `<Retention><Mode>GOVERNANCE</Mode><RetainUntilDate>${until}</RetainUntilDate></Retention>`;
    const put = await call(backend, { method: 'PUT', path: '/logs/keep.txt?retention', body: Buffer.from(xml) }, { config, meta });
    expect(put.status).toBe(200);
    const blocked = await call(backend, { method: 'DELETE', path: '/logs/keep.txt' }, { meta });
    expect(blocked.status).toBe(403);
    expect(backend.objects.has('logs/keep.txt')).toBe(true);
    const bypass = await call(
      backend,
      { method: 'DELETE', path: '/logs/keep.txt', headers: { 'x-amz-bypass-governance-retention': 'true' } },
      { meta },
    );
    expect(bypass.status).toBe(204);
    expect(backend.objects.has('logs/keep.txt')).toBe(false);
  });

  test('legal hold blocks delete until it is turned off', async () => {
    const backend = new MemBackend();
    const meta = new MemoryObjectMeta();
    const config = new MemoryConfigStore();
    const lock = '<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>';
    await call(backend, { method: 'PUT', path: '/logs?object-lock', body: Buffer.from(lock) }, { config });
    await call(backend, { method: 'PUT', path: '/logs/hold.txt', body: Buffer.from('hold') }, { meta });
    const on = await call(
      backend,
      { method: 'PUT', path: '/logs/hold.txt?legal-hold', body: Buffer.from('<LegalHold><Status>ON</Status></LegalHold>') },
      { config, meta },
    );
    expect(on.status).toBe(200);
    const blocked = await call(
      backend,
      { method: 'DELETE', path: '/logs/hold.txt', headers: { 'x-amz-bypass-governance-retention': 'true' } },
      { config, meta },
    );
    expect(blocked.status).toBe(403);
    await call(
      backend,
      { method: 'PUT', path: '/logs/hold.txt?legal-hold', body: Buffer.from('<LegalHold><Status>OFF</Status></LegalHold>') },
      { config, meta },
    );
    const removed = await call(backend, { method: 'DELETE', path: '/logs/hold.txt' }, { meta });
    expect(removed.status).toBe(204);
  });

  test('a website index document is returned for a directory request', async () => {
    const backend = new MemBackend();
    const config = new MemoryConfigStore();
    const xml = '<WebsiteConfiguration><IndexDocument><Suffix>index.html</Suffix></IndexDocument></WebsiteConfiguration>';
    const put = await call(backend, { method: 'PUT', path: '/logs?website', body: Buffer.from(xml) }, { config });
    expect(put.status).toBe(200);
    await call(backend, { method: 'PUT', path: '/logs/index.html', body: Buffer.from('home') }, { config });
    await call(backend, { method: 'PUT', path: '/logs/docs/index.html', body: Buffer.from('docs') }, { config });
    const root = await call(backend, { method: 'GET', path: '/logs/' }, { config });
    expect(root.status).toBe(200);
    expect(root.body.toString()).toBe('home');
    const nested = await call(backend, { method: 'GET', path: '/logs/docs/' }, { config });
    expect(nested.body.toString()).toBe('docs');
  });

  test('a tagged lifecycle rule leaves objects that do not have the tag', async () => {
    const backend = new MemBackend();
    const config = new MemoryConfigStore();
    const meta = new MemoryObjectMeta();
    const options = { config, meta };
    const xml =
      '<LifecycleConfiguration><Rule><Filter><Prefix>old/</Prefix><Tag><Key>expire</Key><Value>yes</Value></Tag></Filter><Expiration><Days>1</Days></Expiration></Rule></LifecycleConfiguration>';
    await call(backend, { method: 'PUT', path: '/logs?lifecycle', body: Buffer.from(xml) }, options);
    await call(backend, { method: 'PUT', path: '/logs/old/keep.txt', body: Buffer.from('keep') }, options);
    await call(backend, { method: 'PUT', path: '/logs/old/drop.txt', body: Buffer.from('drop') }, options);
    await call(
      backend,
      { method: 'PUT', path: '/logs/old/drop.txt?tagging', body: Buffer.from('<Tagging><TagSet><Tag><Key>expire</Key><Value>yes</Value></Tag></TagSet></Tagging>') },
      options,
    );
    backend.objects.get('logs/old/keep.txt')!.mtimeMs = 1;
    backend.objects.get('logs/old/drop.txt')!.mtimeMs = 1;
    const ran = await call(backend, { method: 'POST', path: '/logs?lifecycle', now: 3 * 86_400_000 }, options);
    expect(JSON.parse(ran.body.toString()).expired).toBe(1);
    expect(backend.objects.has('logs/old/keep.txt')).toBe(true);
    expect(backend.objects.has('logs/old/drop.txt')).toBe(false);
  });

  test('inventory writes a csv of the current objects', async () => {
    const backend = new MemBackend();
    const config = new MemoryConfigStore();
    const xml =
      '<InventoryConfiguration><Id>daily</Id><Destination><S3BucketDestination><Prefix>reports/</Prefix><Format>CSV</Format></S3BucketDestination></Destination></InventoryConfiguration>';
    const put = await call(backend, { method: 'PUT', path: '/logs?inventory&id=daily', body: Buffer.from(xml) }, { config });
    expect(put.status).toBe(200);
    await call(backend, { method: 'PUT', path: '/logs/a.txt', body: Buffer.from('abcd') }, { config });
    const ran = await call(backend, { method: 'POST', path: '/logs?inventory&id=daily' }, { config });
    expect(ran.status).toBe(200);
    const report = await backend.get('logs', 'reports/daily.csv');
    expect(report?.value.toString()).toContain('a.txt');
    expect(report?.value.toString()).toContain('4');
  });

  test('a notification sends only the events it lists', async () => {
    const backend = new MemBackend();
    const config = new MemoryConfigStore();
    const events: unknown[] = [];
    const options = {
      config,
      fetchImpl: (async (_url: string, init?: { body?: string }) => {
        events.push(JSON.parse(init?.body ?? '{}'));
        return new Response('ok');
      }) as typeof fetch,
    };
    await call(
      backend,
      {
        method: 'PUT',
        path: '/logs?notification',
        body: Buffer.from(JSON.stringify({ url: 'http://hook.local/s3', events: ['s3:ObjectRemoved:*'] })),
      },
      options,
    );
    await call(backend, { method: 'PUT', path: '/logs/a.txt', body: Buffer.from('a') }, options);
    expect(events).toHaveLength(0);
    await call(backend, { method: 'DELETE', path: '/logs/a.txt' }, options);
    expect(events).toHaveLength(1);
    expect((events[0] as { event: string }).event).toBe('s3:ObjectRemoved:Delete');
  });

  test('block public policy rejects an allow-all bucket policy', async () => {
    const backend = new MemBackend();
    const config = new MemoryConfigStore();
    const block =
      '<PublicAccessBlockConfiguration><BlockPublicPolicy>true</BlockPublicPolicy></PublicAccessBlockConfiguration>';
    const put = await call(backend, { method: 'PUT', path: '/logs?publicAccessBlock', body: Buffer.from(block) }, { config });
    expect(put.status).toBe(200);
    const policy = await call(
      backend,
      {
        method: 'PUT',
        path: '/logs?policy',
        body: Buffer.from(JSON.stringify({ Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }] })),
      },
      { config },
    );
    expect(policy.status).toBe(403);
    const saved = await config.get('logs');
    expect(saved.policy).toBeUndefined();
  });

  test('bucket location is stored and a missing website object returns the error page', async () => {
    const backend = new MemBackend();
    const config = new MemoryConfigStore();
    const location = await call(
      backend,
      {
        method: 'PUT',
        path: '/logs?location',
        body: Buffer.from('<CreateBucketConfiguration><LocationConstraint>rack-a</LocationConstraint></CreateBucketConfiguration>'),
      },
      { config },
    );
    expect(location.status).toBe(200);
    const got = await call(backend, { method: 'GET', path: '/logs?location' }, { config });
    expect(got.body.toString()).toContain('rack-a');

    const website =
      '<WebsiteConfiguration><IndexDocument><Suffix>index.html</Suffix></IndexDocument><ErrorDocument><Key>error.html</Key></ErrorDocument></WebsiteConfiguration>';
    await call(backend, { method: 'PUT', path: '/logs?website', body: Buffer.from(website) }, { config });
    await call(backend, { method: 'PUT', path: '/logs/error.html', body: Buffer.from('missing-page') }, { config });
    const missing = await call(backend, { method: 'GET', path: '/logs/no-such.txt' }, { config });
    expect(missing.status).toBe(404);
    expect(missing.body.toString()).toBe('missing-page');
  });

  test('a website routing rule redirects a key prefix', async () => {
    const backend = new MemBackend();
    const config = new MemoryConfigStore();
    const xml =
      '<WebsiteConfiguration><IndexDocument><Suffix>index.html</Suffix></IndexDocument><RoutingRules><RoutingRule><Condition><KeyPrefixEquals>docs/</KeyPrefixEquals></Condition><Redirect><ReplaceKeyPrefixWith>archive/</ReplaceKeyPrefixWith><HttpRedirectCode>302</HttpRedirectCode></Redirect></RoutingRule></RoutingRules></WebsiteConfiguration>';
    await call(backend, { method: 'PUT', path: '/logs?website', body: Buffer.from(xml) }, { config });
    const moved = await call(backend, { method: 'GET', path: '/logs/docs/a.txt' }, { config });
    expect(moved.status).toBe(302);
    expect(moved.headers.Location).toBe('/logs/archive/a.txt');
    const stay = await call(backend, { method: 'GET', path: '/logs/other.txt' }, { config });
    expect(stay.status).toBe(404);
  });

  test('copy can take a byte range and replace metadata and tags', async () => {
    const backend = new MemBackend();
    const meta = new MemoryObjectMeta();
    await call(backend, { method: 'PUT', path: '/logs/src.txt', body: Buffer.from('abcdefgh'), headers: { 'x-amz-meta-color': 'blue' } }, { meta });
    await call(
      backend,
      {
        method: 'PUT',
        path: '/logs/src.txt?tagging',
        body: Buffer.from('<Tagging><TagSet><Tag><Key>kind</Key><Value>log</Value></Tag></TagSet></Tagging>'),
      },
      { meta },
    );
    const copy = await call(
      backend,
      {
        method: 'PUT',
        path: '/logs/dst.txt',
        headers: {
          'x-amz-copy-source': '/logs/src.txt',
          'x-amz-copy-source-range': 'bytes=0-3',
          'x-amz-metadata-directive': 'REPLACE',
          'x-amz-meta-color': 'red',
          'x-amz-tagging-directive': 'REPLACE',
          'x-amz-tagging': 'kind=copy',
        },
      },
      { meta },
    );
    expect(copy.status).toBe(200);
    const got = await call(backend, { method: 'GET', path: '/logs/dst.txt' }, { meta });
    expect(got.body.toString()).toBe('abcd');
    const head = await call(backend, { method: 'HEAD', path: '/logs/dst.txt' }, { meta });
    expect(head.headers['x-amz-meta-color']).toBe('red');
    const tags = await call(backend, { method: 'GET', path: '/logs/dst.txt?tagging' }, { meta });
    expect(tags.body.toString()).toContain('<Value>copy</Value>');
    expect(tags.body.toString()).not.toContain('<Value>log</Value>');
  });

  test('time conditions and upload-part copy', async () => {
    const backend = new MemBackend();
    await call(backend, { method: 'PUT', path: '/logs/a.txt', body: Buffer.from('abcdefgh') });
    const fresh = await call(backend, { method: 'GET', path: '/logs/a.txt', headers: { 'if-modified-since': 'Thu, 01 Jan 1970 00:00:02 GMT' } });
    expect(fresh.status).toBe(304);
    const stale = await call(backend, { method: 'PUT', path: '/logs/a.txt', body: Buffer.from('nope'), headers: { 'if-unmodified-since': 'Thu, 01 Jan 1970 00:00:00 GMT' } });
    expect(stale.status).toBe(412);
    expect(backend.objects.get('logs/a.txt')?.body.toString()).toBe('abcdefgh');

    const uploads = new MultipartUploads();
    const created = await call(backend, { method: 'POST', path: '/logs/part.bin?uploads' }, { uploads });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(created.body.toString())?.[1] ?? '';
    const part = await call(
      backend,
      {
        method: 'PUT',
        path: `/logs/part.bin?partNumber=1&uploadId=${uploadId}`,
        headers: { 'x-amz-copy-source': '/logs/a.txt', 'x-amz-copy-source-range': 'bytes=1-4' },
      },
      { uploads },
    );
    expect(part.status).toBe(200);
    expect(part.body.toString()).toContain('<ETag>');
    const complete = `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${/<ETag>([^<]+)<\/ETag>/.exec(part.body.toString())?.[1] ?? ''}</ETag></Part></CompleteMultipartUpload>`;
    const done = await call(backend, { method: 'POST', path: `/logs/part.bin?uploadId=${uploadId}`, body: Buffer.from(complete) }, { uploads });
    expect(done.status).toBe(200);
    const got = await call(backend, { method: 'GET', path: '/logs/part.bin' });
    expect(got.body.toString()).toBe('bcde');
  });

  test('copy refuses a source that fails if-match or if-unmodified-since', async () => {
    const backend = new MemBackend();
    await call(backend, { method: 'PUT', path: '/logs/src.txt', body: Buffer.from('abcdefgh') });
    const etag = `"${crc32(Buffer.from('abcdefgh')).toString(16).padStart(8, '0')}"`;
    const wrong = await call(backend, {
      method: 'PUT',
      path: '/logs/dst.txt',
      headers: { 'x-amz-copy-source': '/logs/src.txt', 'x-amz-copy-source-if-match': '"00000000"' },
    });
    expect(wrong.status).toBe(412);
    expect(backend.objects.has('logs/dst.txt')).toBe(false);
    const old = await call(backend, {
      method: 'PUT',
      path: '/logs/dst.txt',
      headers: { 'x-amz-copy-source': '/logs/src.txt', 'x-amz-copy-source-if-unmodified-since': 'Thu, 01 Jan 1970 00:00:00 GMT' },
    });
    expect(old.status).toBe(412);
    const ok = await call(backend, {
      method: 'PUT',
      path: '/logs/dst.txt',
      headers: { 'x-amz-copy-source': '/logs/src.txt', 'x-amz-copy-source-if-match': etag },
    });
    expect(ok.status).toBe(200);
    expect(backend.objects.get('logs/dst.txt')?.body.toString()).toBe('abcdefgh');
  });

  test('lists open multipart uploads and keeps a retained object in a batch delete', async () => {
    const backend = new MemBackend();
    const meta = new MemoryObjectMeta();
    const config = new MemoryConfigStore();
    const lock = '<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>';
    await call(backend, { method: 'PUT', path: '/logs?object-lock', body: Buffer.from(lock) }, { config });
    const uploads = new MultipartUploads();
    const created = await call(backend, { method: 'POST', path: '/logs/big.bin?uploads' }, { uploads });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(created.body.toString())?.[1] ?? '';
    const listed = await call(backend, { method: 'GET', path: '/logs?uploads' }, { uploads });
    expect(listed.status).toBe(200);
    expect(listed.body.toString()).toContain('<Key>big.bin</Key>');
    expect(listed.body.toString()).toContain(`<UploadId>${uploadId}</UploadId>`);

    await call(backend, { method: 'PUT', path: '/logs/keep.txt', body: Buffer.from('keep') }, { meta });
    const until = new Date(Date.now() + 86_400_000).toISOString();
    await call(
      backend,
      {
        method: 'PUT',
        path: '/logs/keep.txt?retention',
        body: Buffer.from(`<Retention><Mode>GOVERNANCE</Mode><RetainUntilDate>${until}</RetainUntilDate></Retention>`),
      },
      { config, meta },
    );
    const xml = '<Delete><Object><Key>keep.txt</Key></Object></Delete>';
    const removed = await call(backend, { method: 'POST', path: '/logs?delete', body: Buffer.from(xml) }, { config, meta });
    expect(removed.status).toBe(200);
    expect(removed.body.toString()).toContain('<Code>AccessDenied</Code>');
    expect(backend.objects.has('logs/keep.txt')).toBe(true);
  });

  test('object lock must be enabled before retention, and each notify target gets its events', async () => {
    const backend = new MemBackend();
    const config = new MemoryConfigStore();
    const meta = new MemoryObjectMeta();
    const options = { config, meta };
    const early = await call(
      backend,
      {
        method: 'PUT',
        path: '/logs/a.txt?retention',
        body: Buffer.from('<Retention><Mode>GOVERNANCE</Mode><RetainUntilDate>2099-01-01T00:00:00.000Z</RetainUntilDate></Retention>'),
      },
      options,
    );
    expect(early.status).toBe(400);
    const lock = '<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>';
    expect((await call(backend, { method: 'PUT', path: '/logs?object-lock', body: Buffer.from(lock) }, options)).status).toBe(200);
    const got = await call(backend, { method: 'GET', path: '/logs?object-lock' }, options);
    expect(got.body.toString()).toContain('<ObjectLockEnabled>Enabled</ObjectLockEnabled>');
    expect((await call(backend, { method: 'DELETE', path: '/logs?object-lock' }, options)).status).toBe(405);
    await call(backend, { method: 'PUT', path: '/logs/a.txt', body: Buffer.from('locked') }, options);
    const until = new Date(Date.now() + 86_400_000).toISOString();
    await call(
      backend,
      {
        method: 'PUT',
        path: '/logs/a.txt?retention',
        body: Buffer.from(`<Retention><Mode>GOVERNANCE</Mode><RetainUntilDate>${until}</RetainUntilDate></Retention>`),
      },
      options,
    );
    const blocked = await call(backend, { method: 'DELETE', path: '/logs/a.txt' }, options);
    expect(blocked.status).toBe(403);

    const seen: { url: string; event: string }[] = [];
    const fetchImpl = (async (url: string, init?: { body?: string }) => {
      seen.push({ url, event: (JSON.parse(init?.body ?? '{}') as { event: string }).event });
      return new Response('ok');
    }) as typeof fetch;
    await call(
      backend,
      {
        method: 'PUT',
        path: '/logs?notification',
        body: Buffer.from(JSON.stringify({
          targets: [
            { url: 'http://hook.local/put', events: ['s3:ObjectCreated:*'] },
            { url: 'http://hook.local/del', events: ['s3:ObjectRemoved:*'] },
          ],
        })),
      },
      { ...options, fetchImpl },
    );
    await call(backend, { method: 'PUT', path: '/logs/b.txt', body: Buffer.from('b') }, { ...options, fetchImpl });
    await call(backend, { method: 'DELETE', path: '/logs/b.txt' }, { ...options, fetchImpl });
    expect(seen).toEqual([
      { url: 'http://hook.local/put', event: 's3:ObjectCreated:Put' },
      { url: 'http://hook.local/del', event: 's3:ObjectRemoved:Delete' },
    ]);
  });
});
