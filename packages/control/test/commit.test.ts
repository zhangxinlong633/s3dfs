import { describe, expect, test } from 'bun:test';
import { ObjectCluster, serviceHealthy } from '../src/cluster.ts';
import { NodeRegistry } from '../src/registry.ts';
import type { IndexClient, ScanResult } from '../src/kv-client.ts';

class MemIndex {
  readonly endpoints = ['http://mem'];
  readonly map = new Map<string, Buffer>();
  failOn = '';

  async put(key: string, value: Buffer): Promise<void> {
    if (this.failOn && key === this.failOn) {
      throw new Error(`index put failed for ${key}`);
    }
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
    return {
      truncated: false,
      objects: [...this.map.keys()].map((key) => ({ key, size: 1, crc: 0, mtimeMs: 1 })),
    };
  }
  async ping(): Promise<boolean> {
    return true;
  }
}

const blockOk = JSON.stringify({ chained: false, crc: 1, mtimeMs: 1, size: 3, generation: 1, extentCount: 1, recId: 7 });

describe('index commit', () => {
  test('removes every locator when a later index write fails', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(blockOk, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const kv = new MemIndex();
    kv.failOn = 'logs/a.txt:1';
    const registry = new NodeRegistry(kv as unknown as IndexClient, [
      { nodeId: 'a', address: '10.0.0.1:9100', zone: 'z1' },
      { nodeId: 'b', address: '10.0.0.2:9100', zone: 'z2' },
    ]);
    const cluster = new ObjectCluster(kv as unknown as IndexClient, registry, 2, 'none');
    try {
      await expect(cluster.put('logs', 'a.txt', Buffer.from('abc'))).rejects.toThrow(/index put failed/);
      expect(kv.map.has('logs/a.txt')).toBe(false);
      expect(kv.map.has('logs/a.txt:1')).toBe(false);
    } finally {
      globalThis.fetch = previous;
    }
  });
});

describe('lost objects', () => {
  test('repair counts an object whose copies are all gone', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => new Response('down', { status: 500 })) as typeof fetch;
    const kv = new MemIndex();
    await kv.put(
      'logs/gone.txt',
      Buffer.from(JSON.stringify({ v: 3, replica: 0, replicaCount: 1, nodeId: 'missing', address: '10.0.0.9:9100', recId: 1, chained: false, generation: 1, extentCount: 1, size: 1, storedSize: 1, compressType: 'none', crc: 1, mtimeMs: 1 })),
    );
    const registry = new NodeRegistry(kv as unknown as IndexClient, [{ nodeId: 'a', address: '10.0.0.1:9100', zone: 'z1' }]);
    const cluster = new ObjectCluster(kv as unknown as IndexClient, registry, 1, 'none');
    try {
      const report = await cluster.repair();
      expect(report.lost).toBe(1);
      expect(cluster.lostCount()).toBe(1);
      expect(serviceHealthy(true, cluster.layout(), cluster.lostCount())).toBe(false);
    } finally {
      globalThis.fetch = previous;
    }
  });
});
