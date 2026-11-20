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

function cluster(replicas: number, nodes: { nodeId: string; address: string; zone?: string }[]) {
  const kv = new MemIndex();
  const registry = new NodeRegistry(kv as unknown as IndexClient, nodes);
  return { kv, cluster: new ObjectCluster(kv as unknown as IndexClient, registry, replicas, 'none') };
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
});
