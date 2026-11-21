import { describe, expect, test } from 'bun:test';
import { handleS3, type S3Backend } from '../src/s3/handle';

class Store implements S3Backend {
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
    return { truncated: false, objects: [], prefixes: [] };
  }
  async put(_bucket: string, key: string, value: Buffer): Promise<void> {
    this.objects.set(key, value);
  }
  async putStream(_bucket: string, key: string, chunks: AsyncIterable<Buffer>): Promise<{ size: number; crc: number }> {
    const parts: Buffer[] = [];
    for await (const chunk of chunks) {
      parts.push(chunk);
    }
    const body = Buffer.concat(parts);
    this.objects.set(key, body);
    return { size: body.length, crc: 1 };
  }
  async head(_bucket: string, key: string) {
    const value = this.objects.get(key);
    return value ? { size: value.length, crc: 1, mtimeMs: 1 } : null;
  }
  async get(_bucket: string, key: string) {
    const value = this.objects.get(key);
    return value ? { value, size: value.length, crc: 1, mtimeMs: 1 } : null;
  }
  async getRange() {
    return null;
  }
  async delete(): Promise<boolean> {
    return true;
  }
}

describe('sse that stays readable', () => {
  test('a put larger than 1 MiB with AES256 reads back as plaintext', async () => {
    const plain = Buffer.concat([Buffer.alloc(700_000, 3), Buffer.alloc(700_000, 4)]);
    async function* chunks() {
      yield plain.subarray(0, 700_000);
      yield plain.subarray(700_000);
    }
    const store = new Store();
    const put = await handleS3(
      {
        method: 'PUT',
        path: '/logs/big.bin',
        query: new URLSearchParams(),
        headers: { 'x-amz-server-side-encryption': 'AES256' },
        body: Buffer.alloc(0),
        bodyStream: chunks(),
      },
      store,
      undefined as never,
      { sseSecret: 'current-key' },
    );
    expect(put.status).toBe(200);
    const got = await handleS3(
      { method: 'GET', path: '/logs/big.bin', query: new URLSearchParams(), headers: {}, body: Buffer.alloc(0) },
      store,
      undefined as never,
      { sseSecret: 'current-key' },
    );
    expect(got.status).toBe(200);
    expect(got.body.equals(plain)).toBe(true);
  });

  test('an object sealed with the previous key still opens', async () => {
    const store = new Store();
    const put = await handleS3(
      {
        method: 'PUT',
        path: '/logs/a.txt',
        query: new URLSearchParams(),
        headers: { 'x-amz-server-side-encryption': 'AES256' },
        body: Buffer.from('hello'),
      },
      store,
      undefined as never,
      { sseSecret: 'first-key' },
    );
    expect(put.status).toBe(200);
    const got = await handleS3(
      { method: 'GET', path: '/logs/a.txt', query: new URLSearchParams(), headers: {}, body: Buffer.alloc(0) },
      store,
      undefined as never,
      { sseSecret: 'second-key', ssePrevious: 'first-key' },
    );
    expect(got.status).toBe(200);
    expect(got.body.toString()).toBe('hello');
  });
});
