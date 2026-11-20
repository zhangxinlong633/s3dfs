import { describe, expect, test } from 'bun:test';
import { ObjectCluster } from '../src/cluster.ts';
import { NodeRegistry } from '../src/registry.ts';
import type { IndexClient, ScanResult } from '../src/kv-client.ts';

class MemIndex {
  readonly endpoints = ['http://mem'];
  private readonly map = new Map<string, Buffer>();

  async put(key: string, value: Buffer): Promise<void> {
    this.map.set(key, Buffer.from(value));
  }

  async get(key: string) {
    const value = this.map.get(key);
    if (!value) {
      return null;
    }
    return { key, value, size: value.length, crc: 0, mtimeMs: 1 };
  }

  async head(key: string) {
    const value = this.map.get(key);
    return value ? { size: value.length, crc: 0, mtimeMs: 1 } : null;
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }

  async scan(opts: { prefix?: string; startAfter?: string; maxKeys?: number }): Promise<ScanResult> {
    const prefix = opts.prefix ?? '';
    const keys = [...this.map.keys()]
      .filter((key) => key.startsWith(prefix) && (!opts.startAfter || key > opts.startAfter))
      .sort();
    const cap = opts.maxKeys ?? keys.length;
    const slice = keys.slice(0, cap);
    return {
      truncated: keys.length > slice.length,
      objects: slice.map((key) => ({ key, size: this.map.get(key)!.length, crc: 0, mtimeMs: 1 })),
    };
  }

  has(key: string): boolean {
    return this.map.has(key);
  }
}

function cluster(kv: MemIndex): ObjectCluster {
  return new ObjectCluster(kv as unknown as IndexClient, new NodeRegistry(kv as unknown as IndexClient, []), 1, 'none');
}

describe('deleteBucket', () => {
  test('removes an empty bucket marker and keeps a bucket that still has an object', async () => {
    const kv = new MemIndex();
    const objects = cluster(kv);
    await objects.createBucket('logs');
    expect(await objects.deleteBucket('logs')).toBe('ok');
    expect(kv.has('logs/')).toBe(false);
    expect(await objects.deleteBucket('logs')).toBe('missing');

    await kv.put('logs/a.txt', Buffer.from('{"v":3}'));
    expect(await objects.deleteBucket('logs')).toBe('notempty');
    expect(kv.has('logs/a.txt')).toBe(true);
  });
});
