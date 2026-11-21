import { describe, expect, test } from 'bun:test';
import { ObjectCluster } from '../src/cluster.ts';
import type { IndexClient, ScanResult } from '../src/kv-client.ts';
import { NodeRegistry } from '../src/registry.ts';

class MemIndex {
  readonly endpoints = ['http://mem'];
  readonly map = new Map<string, { value: Buffer; mtimeMs: number }>();
  scans: { maxKeys?: number; startAfter?: string }[] = [];

  async put(key: string, value: Buffer): Promise<void> {
    this.map.set(key, { value: Buffer.from(value), mtimeMs: 1 });
  }

  async get(key: string) {
    const row = this.map.get(key);
    return row ? { key, value: row.value, size: row.value.length, crc: 0, mtimeMs: row.mtimeMs } : null;
  }

  async head(key: string) {
    const row = this.map.get(key);
    return row ? { size: row.value.length, crc: 0, mtimeMs: row.mtimeMs } : null;
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }

  async scan(opts: { prefix?: string; startAfter?: string; maxKeys?: number }): Promise<ScanResult> {
    this.scans.push({ maxKeys: opts.maxKeys, startAfter: opts.startAfter });
    const prefix = opts.prefix ?? '';
    const keys = [...this.map.keys()]
      .filter((key) => key.startsWith(prefix) && (!opts.startAfter || key > opts.startAfter))
      .sort();
    const cap = opts.maxKeys ?? keys.length;
    const slice = keys.slice(0, cap);
    return {
      truncated: keys.length > slice.length,
      objects: slice.map((key) => {
        const row = this.map.get(key)!;
        return { key, size: row.value.length, crc: 0, mtimeMs: row.mtimeMs };
      }),
    };
  }

  async ping(): Promise<boolean> {
    return true;
  }
}

describe('listBuckets', () => {
  test('still lists a later bucket when an earlier bucket has more than 10000 keys', async () => {
    const kv = new MemIndex();
    const objects = new ObjectCluster(kv as unknown as IndexClient, new NodeRegistry(kv as unknown as IndexClient, []), 1, 'none');
    await objects.createBucket('logs');
    await objects.createBucket('metrics');
    for (let i = 0; i < 10_001; i++) {
      kv.map.set(`logs/f${String(i).padStart(5, '0')}`, { value: Buffer.from('x'), mtimeMs: 2 });
    }
    kv.map.set('metrics/a.txt', { value: Buffer.from('y'), mtimeMs: 3 });

    const buckets = await objects.listBuckets();
    expect(buckets.map((bucket) => bucket.name).sort()).toEqual(['logs', 'metrics']);
    expect(kv.scans.length).toBeLessThan(20);
  });
});
