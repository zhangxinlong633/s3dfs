import { describe, expect, test } from 'bun:test';
import { isVisibleObjectKey, type IndexClient, type ScanResult } from '@s3dfs/control';
import { IndexUploadStore } from '../src/s3/index-store';
import { MultipartUploads } from '../src/s3/multipart';

class MemIndex {
  readonly endpoints = ['http://mem'];
  readonly map = new Map<string, Buffer>();
  async put(key: string, value: Buffer): Promise<void> {
    this.map.set(key, Buffer.from(value));
  }
  async get(key: string) {
    const value = this.map.get(key);
    return value ? { key, value, size: value.length, crc: 0, mtimeMs: 1 } : null;
  }
  async head(key: string) {
    const value = this.map.get(key);
    return value ? { size: value.length, crc: 0, mtimeMs: 1 } : null;
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
  async scan(opts: { prefix?: string }): Promise<ScanResult> {
    const prefix = opts.prefix ?? '';
    return {
      truncated: false,
      objects: [...this.map.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, size: this.map.get(key)!.length, crc: 0, mtimeMs: 1 })),
    };
  }
  async ping(): Promise<boolean> {
    return true;
  }
}

describe('multipart parts in the block store', () => {
  test('keeps part bytes out of the index and readable after a new store', async () => {
    const kv = new MemIndex();
    const blocks = new Map<string, Buffer>();
    const objects = {
      async put(bucket: string, key: string, value: Buffer) {
        blocks.set(`${bucket}/${key}`, Buffer.from(value));
      },
      async get(bucket: string, key: string) {
        const value = blocks.get(`${bucket}/${key}`);
        return value ? { value } : null;
      },
      async delete(bucket: string, key: string) {
        blocks.delete(`${bucket}/${key}`);
      },
    };
    const first = new MultipartUploads(new IndexUploadStore(kv as unknown as IndexClient, objects));
    const id = await first.create('logs', 'big.bin');
    await first.putPart('logs', 'big.bin', id, 1, Buffer.from('hello-'));
    await first.putPart('logs', 'big.bin', id, 2, Buffer.from('world'));
    const manifest = kv.map.get(`$upload/${id}`)!;
    expect(manifest.length).toBeLessThan(4096);
    expect(manifest.toString('utf8')).not.toContain('hello-');
    expect([...kv.map.keys()].some((key) => key.includes('/b/'))).toBe(false);
    expect(blocks.get(`logs/$upload/${id}/1`)?.toString()).toBe('hello-');
    expect(isVisibleObjectKey(`logs/$upload/${id}/1`)).toBe(false);

    const second = new MultipartUploads(new IndexUploadStore(kv as unknown as IndexClient, objects));
    const body = await second.complete('logs', 'big.bin', id, [
      { partNumber: 1, etag: (await second.listParts('logs', 'big.bin', id))[0]!.etag },
      { partNumber: 2, etag: (await second.listParts('logs', 'big.bin', id))[1]!.etag },
    ]);
    expect(body.toString()).toBe('hello-world');
  });
});
