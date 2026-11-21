import { describe, expect, test } from 'bun:test';
import type { IndexClient, ScanResult } from '@s3dfs/control';
import { IndexVersionStore } from '../src/s3/index-store';

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
  async scan(): Promise<ScanResult> {
    return { truncated: false, objects: [] };
  }
  async ping(): Promise<boolean> {
    return true;
  }
}

describe('version bodies', () => {
  test('keeps version bytes in the block store and only a manifest in the index', async () => {
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
    const versions = new IndexVersionStore(kv as unknown as IndexClient, objects);
    await versions.put('logs', 'a.txt', { id: 'v1', body: Buffer.from('hello-version'), deleteMarker: false, mtimeMs: 5 });

    const stored = [...kv.map.entries()].map(([key, value]) => `${key}=${value.toString('utf8')}`).join('\n');
    expect(stored).not.toContain('hello-version');
    expect(blocks.get('logs/$ver/a.txt/v1')?.toString()).toBe('hello-version');

    const got = await versions.get('logs', 'a.txt', 'v1');
    expect(got?.body?.toString()).toBe('hello-version');
    expect(got?.deleteMarker).toBe(false);
  });
});
