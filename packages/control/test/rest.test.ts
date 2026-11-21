import { describe, expect, test } from 'bun:test';
import { crc32 } from '../src/compress.ts';
import { ObjectCluster, segmentCrcs } from '../src/cluster.ts';
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
  async scan(opts: { prefix?: string } = {}): Promise<ScanResult> {
    const prefix = opts.prefix ?? '';
    const objects = [...this.map.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .map((key) => ({ key, size: this.map.get(key)!.length, crc: 0, mtimeMs: 1 }));
    return { truncated: false, objects };
  }
  async ping(): Promise<boolean> {
    return true;
  }
}

const extent = {
  chained: false,
  crc: 0,
  mtimeMs: 1,
  size: 4,
  generation: 1,
  extentCount: 1,
  recId: 9,
};

function nodes() {
  return [
    { nodeId: 'a', address: '10.0.0.1:9100', zone: 'z1' },
    { nodeId: 'b', address: '10.0.0.2:9100', zone: 'z2' },
  ];
}

function open() {
  const kv = new MemIndex();
  const registry = new NodeRegistry(kv as unknown as IndexClient, nodes());
  const cluster = new ObjectCluster(kv as unknown as IndexClient, registry, 2, 'none');
  const bodies = new Map<string, Buffer>();
  const calls: string[] = [];
  const bad = new Set<string>();
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    const parsed = new URL(u);
    const key = parsed.searchParams.get('key') ?? '';
    const address = parsed.host;
    if (u.includes('/write/begin')) {
      return new Response(JSON.stringify({ id: 'w' }), { status: 200 });
    }
    if (u.includes('/write/chunk') || u.includes('/write/abort') || u.includes('/delete')) {
      return new Response(null, { status: 200 });
    }
    if (u.includes('/write/finish') || u.includes('/put')) {
      const headerKey = decodeURIComponent(String((init?.headers as Record<string, string>)['x-s3dfs-key'] ?? ''));
      const body = Buffer.from((init?.body as Uint8Array | undefined) ?? Buffer.alloc(0));
      if (u.includes('/put')) {
        bodies.set(`${address}|${headerKey}`, body);
        bad.delete(address);
      }
      return new Response(JSON.stringify({ ...extent, size: body.length || 4, recId: calls.length }), { status: 200 });
    }
    if (u.endsWith('/health')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (u.includes('/get')) {
      if (bad.has(address)) {
        return new Response(Buffer.from('XXXXX'), { status: 200 });
      }
      const stored = bodies.get(`${address}|${key}`) ?? Buffer.alloc(0);
      const start = parsed.searchParams.get('start');
      const end = parsed.searchParams.get('end');
      const value = start !== null && end !== null ? stored.subarray(Number(start), Number(end) + 1) : stored;
      return new Response(value, { status: 200 });
    }
    return new Response('no', { status: 500 });
  }) as typeof fetch;
  return {
    kv,
    registry,
    cluster,
    calls,
    bodies,
    bad,
    restore: () => {
      globalThis.fetch = previous;
    },
  };
}

describe('remaining designs', () => {
  test('scrub rewrites a bad replica and records lost when none are good', async () => {
    const box = open();
    try {
      await box.cluster.put('logs', 'a.txt', Buffer.from('hello'));
      box.bad.add('10.0.0.1:9100');
      const report = await box.cluster.scrub();
      expect(report.repaired).toBe(1);
      box.bad.delete('10.0.0.1:9100');
      expect((await box.cluster.get('logs', 'a.txt'))?.value.toString('utf8')).toBe('hello');
      box.bad.add('10.0.0.1:9100');
      box.bad.add('10.0.0.2:9100');
      const again = await box.cluster.scrub();
      expect(again.lost).toBe(1);
      expect(await box.cluster.lostKeys()).toContain('logs/a.txt');
      const next = new ObjectCluster(box.kv, new NodeRegistry(nodes()), 3);
      expect(await next.scrubReport()).toEqual(again);
    } finally {
      box.restore();
    }
  });

  test('repair of an object over 1 MiB copies by range', async () => {
    const box = open();
    try {
      const value = Buffer.alloc(1_048_576 + 8, 7);
      const loc = {
        v: 3,
        replica: 0,
        replicaCount: 1,
        nodeId: 'a',
        address: '10.0.0.1:9100',
        recId: 3,
        chained: false,
        generation: 1,
        extentCount: 1,
        size: value.length,
        storedSize: value.length,
        compressType: 'none',
        crc: crc32(value),
        mtimeMs: 1,
      };
      box.bodies.set('10.0.0.1:9100|logs/big', value);
      await box.kv.put('logs/big', Buffer.from(JSON.stringify(loc)));
      const report = await box.cluster.repair();
      expect(report.repaired).toBe(1);
      expect(box.calls.some((url) => url.includes('start='))).toBe(true);
      expect(box.calls.some((url) => url.includes('/_s3dfs/block/put'))).toBe(false);
      expect(box.calls.some((url) => url.includes('start='))).toBe(true);
      expect(box.calls.some((url) => url.includes('/_s3dfs/block/put'))).toBe(false);
    } finally {
      box.restore();
    }
  });

  test('a bad segment is reread from the next replica only', async () => {
    const box = open();
    try {
      const value = Buffer.from('abcdefgh');
      const span = 4;
      const segments = segmentCrcs(value, span);
      const base = {
        v: 3,
        replicaCount: 2,
        recId: 4,
        chained: false,
        generation: 1,
        extentCount: 1,
        size: value.length,
        storedSize: value.length,
        compressType: 'none',
        crc: crc32(value),
        mtimeMs: 1,
        segments,
        segmentBytes: span,
      };
      await box.kv.put(
        'logs/seg',
        Buffer.from(JSON.stringify({ ...base, replica: 0, nodeId: 'a', address: '10.0.0.1:9100' })),
      );
      await box.kv.put(
        'logs/seg:1',
        Buffer.from(JSON.stringify({ ...base, replica: 1, nodeId: 'b', address: '10.0.0.2:9100' })),
      );
      box.bodies.set('10.0.0.1:9100|logs/seg', Buffer.from('XXXX' + 'efgh'));
      box.bodies.set('10.0.0.2:9100|logs/seg', value);
      const got = await box.cluster.get('logs', 'seg');
      expect(got?.value.toString('utf8')).toBe('abcdefgh');
      const ranged = box.calls.filter((url) => url.includes('start='));
      expect(box.calls.some((url) => url.includes('/get') && !url.includes('start='))).toBe(true);
      expect(ranged.filter((url) => url.includes('start=0'))).toHaveLength(1);
      expect(ranged.filter((url) => url.includes('start=4'))).toHaveLength(0);
    } finally {
      box.restore();
    }
  });

  test('copy shares the record and a later overwrite leaves the other side', async () => {
    const box = open();
    try {
      await box.cluster.put('logs', 'a.txt', Buffer.from('one'));
      expect(await box.cluster.shareCopy('logs', 'a.txt', 'logs', 'b.txt')).toBe(true);
      expect((await box.cluster.locators('logs/b.txt'))[0]?.dataKey).toMatch(/^\$obj\//);
      expect((await box.cluster.get('logs', 'b.txt'))?.value.toString('utf8')).toBe('one');
      await box.cluster.put('logs', 'a.txt', Buffer.from('two'));
      expect((await box.cluster.get('logs', 'a.txt'))?.value.toString('utf8')).toBe('two');
      expect((await box.cluster.get('logs', 'b.txt'))?.value.toString('utf8')).toBe('one');
    } finally {
      box.restore();
    }
  });

  test('overwrite keeps the new bytes', async () => {
    const box = open();
    try {
      await box.cluster.put('logs', 'a.txt', Buffer.from('one'));
      expect((await box.cluster.locators('logs/a.txt'))[0]?.dataKey).toBeUndefined();
      await box.cluster.put('logs', 'a.txt', Buffer.from('two'));
      expect((await box.cluster.get('logs', 'a.txt'))?.value.toString('utf8')).toBe('two');
      expect((await box.cluster.locators('logs/a.txt'))[0]?.dataKey).toBeUndefined();
    } finally {
      box.restore();
    }
  });

  test('rebalance moves a copy only when asked', async () => {
    const box = open();
    try {
      await box.cluster.put('logs', 'a.txt', Buffer.from('stay'));
      await box.registry.upsert({ nodeId: 'c', address: '10.0.0.3:9100', status: 'up', lastSeenMs: 1, zone: 'z3' });
      const before = await box.cluster.locators('logs/a.txt');
      expect(before.some((loc) => loc.nodeId === 'c')).toBe(false);
      const report = await box.cluster.rebalance('c');
      expect(report.moved).toBe(1);
      expect(report.bytes).toBe(4);
      const after = await box.cluster.locators('logs/a.txt');
      expect(after.some((loc) => loc.nodeId === 'c')).toBe(true);
      expect(after).toHaveLength(before.length);
    } finally {
      box.restore();
    }
  });

  test('a change sent to another cluster stays after the source delete', async () => {
    const box = open();
    try {
      await box.cluster.put('logs', 'a.txt', Buffer.from('keep'));
      const target = new Map<string, Buffer>();
      const sent = await box.cluster.sendChanges({
        put: async (bucket, key, value) => {
          target.set(`${bucket}/${key}`, Buffer.from(value));
        },
      });
      expect(sent.sent).toBe(1);
      await box.cluster.delete('logs', 'a.txt');
      expect(target.get('logs/a.txt')?.toString('utf8')).toBe('keep');
      expect(await box.cluster.get('logs', 'a.txt')).toBeNull();
    } finally {
      box.restore();
    }
  });

  test('drain moves a replica off the named node and the object still reads', async () => {
    const box = open();
    try {
      await box.cluster.put('logs', 'a.txt', Buffer.from('stay'));
      await box.registry.upsert({ nodeId: 'c', address: '10.0.0.3:9100', status: 'up', lastSeenMs: 1, zone: 'z3' });
      const before = await box.cluster.locators('logs/a.txt');
      expect(before.some((loc) => loc.nodeId === 'a')).toBe(true);
      await box.cluster.drain('a');
      const after = await box.cluster.locators('logs/a.txt');
      expect(after.some((loc) => loc.nodeId === 'a')).toBe(false);
      expect(after).toHaveLength(before.length);
      expect((await box.cluster.get('logs', 'a.txt'))?.value.toString('utf8')).toBe('stay');
    } finally {
      box.restore();
    }
  });

  test('bucket usage follows every index page', async () => {
    const box = open();
    try {
      await box.cluster.put('logs', 'a.txt', Buffer.from('hello'));
      await box.cluster.put('logs', 'b.txt', Buffer.from('yo'));
      const orig = box.kv.scan.bind(box.kv);
      box.kv.scan = async (opts: { prefix?: string; startAfter?: string } = {}) => {
        const full = await orig(opts);
        let objects = full.objects;
        if (opts.startAfter) {
          objects = objects.filter((obj) => obj.key > opts.startAfter!);
        }
        const page = objects.slice(0, 1);
        return { truncated: objects.length > 1, objects: page };
      };
      expect(await box.cluster.bucketUsage('logs')).toEqual({ objects: 2, bytes: 7 });
    } finally {
      box.restore();
    }
  });

  test('replication progress stays at zero until a batch is sent', async () => {
    const box = open();
    try {
      await box.cluster.put('logs', 'a.txt', Buffer.from('keep'));
      expect(await box.cluster.replicationProgress()).toEqual({ sent: 0, pending: 0 });
      await box.cluster.sendChanges({ put: async () => {} });
      expect(await box.cluster.replicationProgress()).toEqual({ sent: 1, pending: 0 });
      await box.cluster.put('logs', 'b.txt', Buffer.from('next'));
      expect(await box.cluster.replicationProgress()).toEqual({ sent: 1, pending: 1 });
    } finally {
      box.restore();
    }
  });

  test('sendChanges deletes on the target only when deletes are requested', async () => {
    const box = open();
    try {
      await box.cluster.put('logs', 'a.txt', Buffer.from('keep'));
      await box.cluster.delete('logs', 'a.txt');
      const removed: string[] = [];
      await box.cluster.sendChanges(
        {
          put: async () => {},
          delete: async (bucket, key) => {
            removed.push(`${bucket}/${key}`);
          },
        },
        { deletes: true },
      );
      expect(removed).toContain('logs/a.txt');
    } finally {
      box.restore();
    }
  });
});
