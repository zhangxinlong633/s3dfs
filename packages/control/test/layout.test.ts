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
    return {
      truncated: false,
      objects: [...this.map.keys()].map((key) => ({ key, size: this.map.get(key)!.length, crc: 0, mtimeMs: 1 })),
    };
  }
  async ping(): Promise<boolean> {
    return true;
  }
}

function cluster(replicas: number, nodes: { nodeId: string; address: string; zone?: string }[]) {
  const kv = new MemIndex();
  const registry = new NodeRegistry(kv as unknown as IndexClient, nodes);
  return { kv, registry, cluster: new ObjectCluster(kv as unknown as IndexClient, registry, replicas, 'none') };
}

describe('strict layout', () => {
  test('refuses a 3-replica write when only one block is up', async () => {
    const previous = process.env.S3DFS_STRICT_LAYOUT;
    delete process.env.S3DFS_STRICT_LAYOUT;
    try {
      const { kv, cluster: objects } = cluster(3, [{ nodeId: 'a', address: '10.0.0.1:9100', zone: 'z1' }]);
      await expect(objects.put('logs', 'a.txt', Buffer.from('abc'))).rejects.toThrow(/live block nodes 1/);
      expect(kv.map.has('logs/a.txt')).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.S3DFS_STRICT_LAYOUT;
      } else {
        process.env.S3DFS_STRICT_LAYOUT = previous;
      }
    }
  });

  test('refuses replicas that do not have enough failure domains', async () => {
    const previous = process.env.S3DFS_STRICT_LAYOUT;
    delete process.env.S3DFS_STRICT_LAYOUT;
    try {
      const { cluster: objects } = cluster(2, [
        { nodeId: 'a', address: '10.0.0.1:9100', zone: 'rack-a' },
        { nodeId: 'b', address: '10.0.0.2:9100', zone: 'rack-a' },
      ]);
      await expect(objects.put('logs', 'a.txt', Buffer.from('abc'))).rejects.toThrow(/failure domains/);
    } finally {
      if (previous === undefined) {
        delete process.env.S3DFS_STRICT_LAYOUT;
      } else {
        process.env.S3DFS_STRICT_LAYOUT = previous;
      }
    }
  });

  test('accepts a 3-replica write when one zone is down and two remain', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ chained: false, crc: 1, mtimeMs: 1, size: 3, generation: 1, extentCount: 1, recId: 7 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const previous = process.env.S3DFS_STRICT_LAYOUT;
    delete process.env.S3DFS_STRICT_LAYOUT;
    try {
      const { kv, registry, cluster: objects } = cluster(3, [
        { nodeId: 'a', address: '10.0.0.1:9100', zone: 'z1' },
        { nodeId: 'b', address: '10.0.0.2:9100', zone: 'z2' },
        { nodeId: 'c', address: '10.0.0.3:9100', zone: 'z3' },
      ]);
      await registry.upsert({ nodeId: 'a', address: '10.0.0.1:9100', status: 'up', lastSeenMs: 1, zone: 'z1' });
      await registry.upsert({ nodeId: 'b', address: '10.0.0.2:9100', status: 'up', lastSeenMs: 1, zone: 'z2' });
      await registry.upsert({ nodeId: 'c', address: '10.0.0.3:9100', status: 'down', lastSeenMs: 1, zone: 'z3' });
      await objects.put('logs', 'a.txt', Buffer.from('abc'));
      const primary = JSON.parse(kv.map.get('logs/a.txt')!.toString('utf8')) as { replicaCount: number; nodeId: string };
      expect(primary.replicaCount).toBe(2);
      expect(primary.nodeId).not.toBe('c');
      expect(objects.layout().ok).toBe(true);
      expect(objects.layout().liveBlocks).toBe(2);
    } finally {
      globalThis.fetch = previousFetch;
      if (previous === undefined) {
        delete process.env.S3DFS_STRICT_LAYOUT;
      } else {
        process.env.S3DFS_STRICT_LAYOUT = previous;
      }
    }
  });

  test('repair drops the stopped node and restores the third copy when it returns', async () => {
    const down = new Set(['10.0.0.3']);
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const target = String(url);
        if (target.includes('/health')) {
          const id = target.includes('10.0.0.1') ? 'a' : target.includes('10.0.0.2') ? 'b' : 'c';
          const address = id === 'a' ? '10.0.0.1:9100' : id === 'b' ? '10.0.0.2:9100' : '10.0.0.3:9100';
          if ([...down].some((host) => target.includes(host))) {
            return new Response('down', { status: 500 });
          }
          return new Response(JSON.stringify({ nodeId: id, address }), { status: 200 });
        }
      if (target.includes('/_s3dfs/block/get')) {
        return new Response(Buffer.from('abc'), { status: 200, headers: { 'x-s3dfs-size': '3', 'x-s3dfs-crc': '1' } });
      }
      return new Response(JSON.stringify({ chained: false, crc: 1, mtimeMs: 2, size: 3, generation: 1, extentCount: 1, recId: 9 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { kv, cluster: objects } = cluster(3, [
        { nodeId: 'a', address: '10.0.0.1:9100', zone: 'z1' },
        { nodeId: 'b', address: '10.0.0.2:9100', zone: 'z2' },
        { nodeId: 'c', address: '10.0.0.3:9100', zone: 'z3' },
      ]);
      const locator = (nodeId: string, address: string, replica: number) =>
        Buffer.from(JSON.stringify({
          v: 3, replica, replicaCount: 3, nodeId, address, recId: replica + 1,
          chained: false, generation: 1, extentCount: 1, size: 3, storedSize: 3,
          compressType: 'none', crc: 0, mtimeMs: 1,
        }));
      await kv.put('logs/a.txt', locator('a', '10.0.0.1:9100', 0));
      await kv.put('logs/a.txt:1', locator('b', '10.0.0.2:9100', 1));
      await kv.put('logs/a.txt:2', locator('c', '10.0.0.3:9100', 2));
      const first = await objects.repair();
      expect(first.repaired).toBe(1);
      const afterStop = await objects.locators('logs/a.txt');
      expect(afterStop).toHaveLength(2);
      expect(afterStop.map((loc) => loc.nodeId)).not.toContain('c');
      down.clear();
      const second = await objects.repair();
      expect(second.repaired).toBe(1);
      const restored = await objects.locators('logs/a.txt');
      expect(restored).toHaveLength(3);
      expect(restored.map((loc) => loc.nodeId).sort()).toEqual(['a', 'b', 'c']);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
