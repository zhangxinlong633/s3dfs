import { describe, expect, test } from 'bun:test';
import { ObjectCluster } from '../src/cluster.ts';
import { NodeRegistry } from '../src/registry.ts';
import type { IndexClient, ScanResult } from '../src/kv-client.ts';

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

describe('replica write', () => {
  test('does not publish a locator when one chosen replica fails', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes('10.0.0.2')) {
        return new Response('down', { status: 500 });
      }
      return new Response(
        JSON.stringify({ chained: false, crc: 1, mtimeMs: 1, size: 3, generation: 1, extentCount: 1, recId: 7 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const kv = new MemIndex();
      const registry = new NodeRegistry(kv as unknown as IndexClient, [
        { nodeId: 'a', address: '10.0.0.1:9100' },
        { nodeId: 'b', address: '10.0.0.2:9100' },
      ]);
      const cluster = new ObjectCluster(kv as unknown as IndexClient, registry, 2, 'none');
      await expect(cluster.put('logs', 'a.txt', Buffer.from('abc'))).rejects.toThrow(/1 of 2/);
      expect(kv.map.has('logs/a.txt')).toBe(false);
    } finally {
      globalThis.fetch = previous;
    }
  });
});
