import { describe, expect, test } from 'bun:test';
import { crc32 } from '@s3dfs/control';
import { handleS3, type S3Backend } from '../src/s3/handle';
import { MultipartUploads } from '../src/s3/multipart';

function chunked(parts: Buffer[], opts: { signed?: boolean; trailer?: string } = {}): Buffer {
  const pieces: Buffer[] = [];
  for (const part of parts) {
    const hex = part.length.toString(16);
    const sig = opts.signed ? `;chunk-signature=${'a'.repeat(64)}` : '';
    pieces.push(Buffer.from(`${hex}${sig}\r\n`), part, Buffer.from('\r\n'));
  }
  const endSig = opts.signed ? `;chunk-signature=${'b'.repeat(64)}` : '';
  pieces.push(Buffer.from(`0${endSig}\r\n`));
  if (opts.trailer) {
    pieces.push(Buffer.from(`${opts.trailer}\r\n\r\n`));
  } else {
    pieces.push(Buffer.from('\r\n'));
  }
  return Buffer.concat(pieces);
}

function etag(body: Buffer): string {
  return `"${crc32(body).toString(16).padStart(8, '0')}"`;
}

class MemBackend implements S3Backend {
  buckets = new Map<string, number>();
  objects = new Map<string, Buffer>();

  async createBucket(bucket: string): Promise<void> {
    if (!this.buckets.has(bucket)) {
      this.buckets.set(bucket, Date.now());
    }
  }

  async bucketExists(bucket: string): Promise<boolean> {
    if (this.buckets.has(bucket)) {
      return true;
    }
    for (const key of this.objects.keys()) {
      if (key.startsWith(`${bucket}/`)) {
        return true;
      }
    }
    return false;
  }

  async deleteBucket(bucket: string): Promise<'ok' | 'missing' | 'notempty'> {
    if (!(await this.bucketExists(bucket))) {
      return 'missing';
    }
    for (const key of this.objects.keys()) {
      if (key.startsWith(`${bucket}/`)) {
        return 'notempty';
      }
    }
    this.buckets.delete(bucket);
    return 'ok';
  }

  async listBuckets(): Promise<{ name: string; mtimeMs: number }[]> {
    return [...this.buckets.entries()].map(([name, mtimeMs]) => ({ name, mtimeMs }));
  }

  async list() {
    return { truncated: false, objects: [], prefixes: [] as string[], nextToken: undefined };
  }

  async put(bucket: string, key: string, value: Buffer): Promise<void> {
    await this.createBucket(bucket);
    this.objects.set(`${bucket}/${key}`, Buffer.from(value));
  }

  async head(bucket: string, key: string) {
    const value = this.objects.get(`${bucket}/${key}`);
    if (!value) {
      return null;
    }
    return { size: value.length, crc: crc32(value), mtimeMs: 1, compressType: 'none' as const };
  }

  async get(bucket: string, key: string) {
    const value = this.objects.get(`${bucket}/${key}`);
    if (!value) {
      return null;
    }
    return { value, size: value.length, crc: crc32(value), mtimeMs: 1, compressType: 'none' as const };
  }

  async getRange(bucket: string, key: string, start: number, end: number) {
    const got = await this.get(bucket, key);
    if (!got) {
      return null;
    }
    const value = got.value.subarray(start, end + 1);
    return { ...got, value, size: value.length, totalSize: got.size };
  }

  async delete(bucket: string, key: string): Promise<boolean> {
    return this.objects.delete(`${bucket}/${key}`);
  }
}

function call(
  backend: MemBackend,
  uploads: MultipartUploads,
  method: string,
  path: string,
  body: Buffer = Buffer.alloc(0),
  headers: Record<string, string> = {},
) {
  const url = new URL(path, 'http://127.0.0.1:9000');
  return handleS3(
    {
      method,
      path: url.pathname,
      query: url.searchParams,
      headers,
      body,
      host: '127.0.0.1:9000',
    },
    backend,
    uploads,
  );
}

describe('aws cli request body', () => {
  test('stores decoded bytes from a signed aws-chunked put and drops the checksum trailer', async () => {
    const backend = new MemBackend();
    const payload = Buffer.from('hello-aws-cli');
    const raw = chunked([Buffer.from('hello-'), Buffer.from('aws-cli')], {
      signed: true,
      trailer: 'x-amz-checksum-crc32:AAAA',
    });
    const res = await call(backend, new MultipartUploads(), 'PUT', '/logs/a.txt', raw, {
      'content-encoding': 'aws-chunked',
      'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER',
      'x-amz-decoded-content-length': String(payload.length),
    });
    expect(res.status).toBe(200);
    expect(backend.objects.get('logs/a.txt')?.equals(payload)).toBe(true);
    expect(res.headers.ETag).toBe(etag(payload));
  });

  test('rejects a decoded length that does not match x-amz-decoded-content-length', async () => {
    const backend = new MemBackend();
    const raw = chunked([Buffer.from('abc')]);
    const res = await call(backend, new MultipartUploads(), 'PUT', '/logs/a.txt', raw, {
      'content-encoding': 'aws-chunked',
      'x-amz-decoded-content-length': '99',
    });
    expect(res.status).toBe(400);
    expect(backend.objects.has('logs/a.txt')).toBe(false);
  });
});

describe('multipart upload', () => {
  test('create, upload parts, complete, and read back one object', async () => {
    const backend = new MemBackend();
    const uploads = new MultipartUploads();
    const created = await call(backend, uploads, 'POST', '/logs/big.bin?uploads');
    expect(created.status).toBe(200);
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(created.body.toString('utf8'))?.[1];
    expect(uploadId).toBeTruthy();
    const part1 = Buffer.from('aaaa');
    const part2 = Buffer.from('bbbbbb');
    const up1 = await call(backend, uploads, 'PUT', `/logs/big.bin?partNumber=1&uploadId=${uploadId}`, part1);
    const up2 = await call(backend, uploads, 'PUT', `/logs/big.bin?partNumber=2&uploadId=${uploadId}`, part2);
    expect(up1.status).toBe(200);
    expect(up2.headers.ETag).toBe(etag(part2));
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUpload>
  <Part><PartNumber>1</PartNumber><ETag>${up1.headers.ETag}</ETag></Part>
  <Part><ETag>${up2.headers.ETag}</ETag><PartNumber>2</PartNumber></Part>
</CompleteMultipartUpload>`;
    const done = await call(
      backend,
      uploads,
      'POST',
      `/logs/big.bin?uploadId=${uploadId}`,
      Buffer.from(xml),
    );
    expect(done.status).toBe(200);
    expect(done.body.toString('utf8')).toContain('<ETag>');
    const whole = Buffer.concat([part1, part2]);
    expect(backend.objects.get('logs/big.bin')?.equals(whole)).toBe(true);
    expect(backend.objects.size).toBe(1);
  });

  test('abort drops the upload and complete of an unknown id is 404', async () => {
    const backend = new MemBackend();
    const uploads = new MultipartUploads();
    const created = await call(backend, uploads, 'POST', '/logs/big.bin?uploads');
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(created.body.toString('utf8'))?.[1] ?? '';
    await call(backend, uploads, 'PUT', `/logs/big.bin?partNumber=1&uploadId=${uploadId}`, Buffer.from('x'));
    const aborted = await call(backend, uploads, 'DELETE', `/logs/big.bin?uploadId=${uploadId}`);
    expect(aborted.status).toBe(204);
    const again = await call(
      backend,
      uploads,
      'POST',
      `/logs/big.bin?uploadId=${uploadId}`,
      Buffer.from('<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"00"</ETag></Part></CompleteMultipartUpload>'),
    );
    expect(again.status).toBe(404);
    expect(backend.objects.size).toBe(0);
  });
});

describe('delete bucket', () => {
  test('deletes an empty bucket and refuses one that still has an object', async () => {
    const backend = new MemBackend();
    const uploads = new MultipartUploads();
    await call(backend, uploads, 'PUT', '/logs', Buffer.alloc(0));
    const empty = await call(backend, uploads, 'DELETE', '/logs');
    expect(empty.status).toBe(204);
    expect(await backend.bucketExists('logs')).toBe(false);
    await call(backend, uploads, 'PUT', '/logs/a.txt', Buffer.from('z'));
    const busy = await call(backend, uploads, 'DELETE', '/logs');
    expect(busy.status).toBe(409);
    expect(busy.body.toString('utf8')).toContain('BucketNotEmpty');
    expect(backend.objects.has('logs/a.txt')).toBe(true);
  });
});
