import { describe, expect, test } from 'bun:test';
import { ObjectCluster } from '../src/cluster.ts';
import { NodeRegistry, parseBlockNodes } from '../src/registry.ts';
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
  test('publishes the copies that reached quorum and leaves the failed node out', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes('10.0.0.3')) {
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
        { nodeId: 'a', address: '10.0.0.1:9100', zone: 'z1' },
        { nodeId: 'b', address: '10.0.0.2:9100', zone: 'z2' },
        { nodeId: 'c', address: '10.0.0.3:9100', zone: 'z3' },
      ]);
      const cluster = new ObjectCluster(kv as unknown as IndexClient, registry, 3, 'none');
      await cluster.put('logs', 'a.txt', Buffer.from('abc'));
      const primary = JSON.parse(kv.map.get('logs/a.txt')!.toString('utf8')) as { replicaCount: number; nodeId: string };
      expect(primary.replicaCount).toBe(2);
      expect(kv.map.has('logs/a.txt:1')).toBe(true);
      expect(kv.map.has('logs/a.txt:2')).toBe(false);
      const ids = [primary.nodeId, JSON.parse(kv.map.get('logs/a.txt:1')!.toString('utf8')).nodeId as string];
      expect(ids).not.toContain('c');
    } finally {
      globalThis.fetch = previous;
    }
  });

  test('does not publish a locator when the write misses quorum', async () => {
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
        { nodeId: 'a', address: '10.0.0.1:9100', zone: 'z1' },
        { nodeId: 'b', address: '10.0.0.2:9100', zone: 'z2' },
      ]);
      const cluster = new ObjectCluster(kv as unknown as IndexClient, registry, 2, 'none');
      await expect(cluster.put('logs', 'a.txt', Buffer.from('abc'))).rejects.toThrow(/1 of 2/);
      expect(kv.map.has('logs/a.txt')).toBe(false);
    } finally {
      globalThis.fetch = previous;
    }
  });
});

describe('placement', () => {
  test('spreads a replica set across zones before filling a zone again', () => {
    const registry = new NodeRegistry({} as IndexClient, [
      { nodeId: 'a', address: '10.0.0.1:9100', zone: 'rack-a' },
      { nodeId: 'b', address: '10.0.0.2:9100', zone: 'rack-a' },
      { nodeId: 'c', address: '10.0.0.3:9100', zone: 'rack-b' },
    ]);
    const picked = registry.pick('logs/a.txt', 2);
    expect(new Set(picked.map((node) => node.zone)).size).toBe(2);
  });

  test('reads a zone suffix on a block seed', () => {
    expect(parseBlockNodes('b1=10.0.0.1:9100@rack-a')[0]).toMatchObject({
      nodeId: 'b1',
      address: '10.0.0.1:9100',
      zone: 'rack-a',
    });
  });
});
