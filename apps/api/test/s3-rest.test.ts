import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { crc32 } from '@s3dfs/control';
import { handleS3, type S3Backend, type S3Request } from '../src/s3/handle';
import { MemoryUploadStore, MultipartUploads } from '../src/s3/multipart';
import { MemoryConfigStore, MemoryVersionStore, sseKeyFromSecret } from '../src/s3/product';
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
});
