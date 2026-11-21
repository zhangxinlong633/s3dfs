import { describe, expect, test } from 'bun:test';
import { crc32 } from '@s3dfs/control';
import { handleS3, type S3Backend } from '../src/s3/handle';
import { MultipartUploads } from '../src/s3/multipart';
import { MemoryConfigStore, MemoryObjectMeta } from '../src/s3/product';

class MemBackend implements S3Backend {
  objects = new Map<string, Buffer>();
  async createBucket(): Promise<void> {}
  async bucketExists(): Promise<boolean> {
    return true;
  }
  async deleteBucket(): Promise<'ok'> {
    return 'ok';
  }
  async listBuckets() {
    return [];
  }
  async list() {
    return { truncated: false, objects: [], prefixes: [] as string[] };
  }
  async put(bucket: string, key: string, value: Buffer): Promise<void> {
    this.objects.set(`${bucket}/${key}`, Buffer.from(value));
  }
  async head(bucket: string, key: string) {
    const value = this.objects.get(`${bucket}/${key}`);
    if (!value) return null;
    return { size: value.length, crc: crc32(value), mtimeMs: 1, compressType: 'none' as const };
  }
  async get(bucket: string, key: string) {
    const meta = await this.head(bucket, key);
    const value = this.objects.get(`${bucket}/${key}`);
    return meta && value ? { ...meta, value } : null;
  }
  async getRange() {
    return null;
  }
  async delete(bucket: string, key: string): Promise<boolean> {
    return this.objects.delete(`${bucket}/${key}`);
  }
}

function call(
  backend: MemBackend,
  method: string,
  path: string,
  body = Buffer.alloc(0),
  headers: Record<string, string> = {},
  options: Record<string, unknown> = {},
) {
  const url = new URL(path, 'http://127.0.0.1:9000');
  return handleS3(
    { method, path: url.pathname, query: url.searchParams, headers, body, host: '127.0.0.1:9000' },
    backend,
    new MultipartUploads(),
    options,
  );
}

describe('production request checks', () => {
  test('If-None-Match star refuses to overwrite, and If-Match must equal the crc32 etag', async () => {
    const backend = new MemBackend();
    await call(backend, 'PUT', '/logs/a.txt', Buffer.from('one'));
    const again = await call(backend, 'PUT', '/logs/a.txt', Buffer.from('two'), { 'if-none-match': '*' });
    expect(again.status).toBe(412);
    expect(backend.objects.get('logs/a.txt')?.toString()).toBe('one');
    const etag = `"${crc32(Buffer.from('one')).toString(16).padStart(8, '0')}"`;
    const bad = await call(backend, 'PUT', '/logs/a.txt', Buffer.from('two'), { 'if-match': '"00000000"' });
    expect(bad.status).toBe(412);
    const ok = await call(backend, 'PUT', '/logs/a.txt', Buffer.from('two'), { 'if-match': etag });
    expect(ok.status).toBe(200);
    const cached = await call(backend, 'GET', '/logs/a.txt', Buffer.alloc(0), { 'if-none-match': ok.headers.ETag ?? '' });
    expect(cached.status).toBe(304);
  });

  test('stores x-amz-meta headers and returns them on head', async () => {
    const backend = new MemBackend();
    const meta = new MemoryObjectMeta();
    const put = await call(backend, 'PUT', '/logs/a.txt', Buffer.from('m'), { 'x-amz-meta-color': 'blue' }, { meta });
    expect(put.status).toBe(200);
    const head = await call(backend, 'HEAD', '/logs/a.txt', Buffer.alloc(0), {}, { meta });
    expect(head.headers['x-amz-meta-color']).toBe('blue');
  });

  test('DeleteObjects removes every listed key', async () => {
    const backend = new MemBackend();
    await call(backend, 'PUT', '/logs/a.txt', Buffer.from('a'));
    await call(backend, 'PUT', '/logs/b.txt', Buffer.from('b'));
    const xml = '<Delete><Object><Key>a.txt</Key></Object><Object><Key>b.txt</Key></Object></Delete>';
    const res = await call(backend, 'POST', '/logs?delete', Buffer.from(xml));
    expect(res.status).toBe(200);
    expect(res.body.toString()).toContain('<Key>a.txt</Key>');
    expect(backend.objects.size).toBe(0);
  });

  test('bucket and object tagging round-trip through the tagging query', async () => {
    const backend = new MemBackend();
    const config = new MemoryConfigStore();
    const meta = new MemoryObjectMeta();
    const bucketXml = '<Tagging><TagSet><Tag><Key>env</Key><Value>prod</Value></Tag></TagSet></Tagging>';
    const putBucket = await call(backend, 'PUT', '/logs?tagging', Buffer.from(bucketXml), {}, { config });
    expect(putBucket.status).toBe(200);
    const gotBucket = await call(backend, 'GET', '/logs?tagging', Buffer.alloc(0), {}, { config });
    expect(gotBucket.body.toString()).toContain('<Key>env</Key>');
    expect(gotBucket.body.toString()).toContain('<Value>prod</Value>');

    await call(backend, 'PUT', '/logs/a.txt', Buffer.from('m'), { 'x-amz-meta-color': 'blue' }, { meta });
    const objectXml = '<Tagging><TagSet><Tag><Key>kind</Key><Value>log</Value></Tag></TagSet></Tagging>';
    const putObject = await call(backend, 'PUT', '/logs/a.txt?tagging', Buffer.from(objectXml), {}, { meta });
    expect(putObject.status).toBe(200);
    const head = await call(backend, 'HEAD', '/logs/a.txt', Buffer.alloc(0), {}, { meta });
    expect(head.headers['x-amz-meta-color']).toBe('blue');
    const gotObject = await call(backend, 'GET', '/logs/a.txt?tagging', Buffer.alloc(0), {}, { meta });
    expect(gotObject.body.toString()).toContain('<Value>log</Value>');
    const removed = await call(backend, 'DELETE', '/logs/a.txt?tagging', Buffer.alloc(0), {}, { meta });
    expect(removed.status).toBe(204);
    const emptyTags = await call(backend, 'GET', '/logs/a.txt?tagging', Buffer.alloc(0), {}, { meta });
    expect(emptyTags.body.toString()).not.toContain('<Key>');
  });

  test('a matching CORS rule answers the browser preflight', async () => {
    const backend = new MemBackend();
    const config = new MemoryConfigStore();
    const xml =
      '<CORSConfiguration><CORSRule><AllowedOrigin>https://app.example</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>30</MaxAgeSeconds></CORSRule></CORSConfiguration>';
    const put = await call(backend, 'PUT', '/logs?cors', Buffer.from(xml), {}, { config });
    expect(put.status).toBe(200);
    const preflight = await call(
      backend,
      'OPTIONS',
      '/logs/a.txt',
      Buffer.alloc(0),
      { origin: 'https://app.example', 'access-control-request-method': 'GET' },
      { config },
    );
    expect(preflight.status).toBe(200);
    expect(preflight.headers['Access-Control-Allow-Origin']).toBe('https://app.example');
    expect(preflight.headers['Access-Control-Allow-Methods']).toContain('GET');
    expect(preflight.headers['Access-Control-Expose-Headers']).toContain('ETag');
  });

  test('x-amz-checksum-crc32 must match the body', async () => {
    const backend = new MemBackend();
    const body = Buffer.from('checksum');
    const good = Buffer.from([(crc32(body) >>> 24) & 0xff, (crc32(body) >>> 16) & 0xff, (crc32(body) >>> 8) & 0xff, crc32(body) & 0xff]).toString('base64');
    const bad = await call(backend, 'PUT', '/logs/a.txt', body, { 'x-amz-checksum-crc32': 'AAAAAA==' });
    expect(bad.status).toBe(400);
    expect(bad.body.toString()).toContain('BadDigest');
    const ok = await call(backend, 'PUT', '/logs/a.txt', body, { 'x-amz-checksum-crc32': good });
    expect(ok.status).toBe(200);
    const got = await call(backend, 'GET', '/logs/a.txt', Buffer.alloc(0), { 'x-amz-checksum-mode': 'ENABLED' });
    expect(got.headers['x-amz-checksum-crc32']).toBe(good);
  });

  test('rejects a body over the configured limit', async () => {
    const backend = new MemBackend();
    const res = await call(backend, 'PUT', '/logs/a.txt', Buffer.from('12345'), {}, { maxObjectBytes: 4 });
    expect(res.status).toBe(400);
    expect(res.body.toString()).toContain('EntityTooLarge');
    expect(backend.objects.size).toBe(0);
  });
});
