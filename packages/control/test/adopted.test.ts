import { describe, expect, test } from 'bun:test';
import { ObjectCluster, tightestDisks } from '../src/cluster.ts';
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

function cluster(kv: MemIndex, compress: 'none' | 'zstd' = 'none'): ObjectCluster {
  const registry = new NodeRegistry(kv as unknown as IndexClient, [
    { nodeId: 'a', address: '10.0.0.1:9100', zone: 'z1' },
    { nodeId: 'b', address: '10.0.0.2:9100', zone: 'z2' },
  ]);
  return new ObjectCluster(kv as unknown as IndexClient, registry, 2, compress);
}

const locator = {
  v: 3,
  replica: 0,
  replicaCount: 2,
  nodeId: 'a',
  address: '10.0.0.1:9100',
  recId: 1,
  chained: false,
  generation: 1,
  extentCount: 1,
  size: 4,
  storedSize: 4,
  compressType: 'none',
  crc: 0,
  mtimeMs: 1,
};

describe('bad locator', () => {
  test('reads the next replica when the first locator is not JSON', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes('10.0.0.2')) {
        return new Response(Buffer.from('good'), { status: 200 });
      }
      return new Response('no', { status: 500 });
    }) as typeof fetch;
    const kv = new MemIndex();
    await kv.put('logs/a.txt', Buffer.from('not-json'));
    const second = { ...locator, replica: 1, nodeId: 'b', address: '10.0.0.2:9100', crc: 0 };
    await kv.put('logs/a.txt:1', Buffer.from(JSON.stringify(second)));
    try {
      const got = await cluster(kv).get('logs', 'a.txt');
      expect(got?.value.toString('utf8')).toBe('good');
    } finally {
      globalThis.fetch = previous;
    }
  });
});

describe('durable lost', () => {
  test('a new process still counts a lost key stored in the index', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => new Response('down', { status: 500 })) as typeof fetch;
    const kv = new MemIndex();
    await kv.put('logs/gone.txt', Buffer.from(JSON.stringify({ ...locator, replicaCount: 1, nodeId: 'missing', address: '10.0.0.9:9100' })));
    try {
      await cluster(kv).repair();
      const again = cluster(kv);
      expect(again.lostCount()).toBe(0);
      expect(await again.syncLost()).toBe(1);
      expect(again.lostCount()).toBe(1);
    } finally {
      globalThis.fetch = previous;
    }
  });
});

describe('change journal', () => {
  test('records put and delete without the object bytes', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ chained: false, crc: 1, mtimeMs: 1, size: 3, generation: 1, extentCount: 1, recId: 7 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const kv = new MemIndex();
    const body = 'journal-secret-body';
    try {
      const c = cluster(kv);
      await c.put('logs', 'a.txt', Buffer.from(body));
      await c.delete('logs', 'a.txt');
      const changes = await c.listChanges();
      expect(changes.map((item) => item.op)).toEqual(['put', 'delete']);
      expect(JSON.stringify(changes)).not.toContain(body);
    } finally {
      globalThis.fetch = previous;
    }
  });
});

describe('bucket limits', () => {
  test('rejects a put past the bucket quota and keeps compression off', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ chained: false, crc: 1, mtimeMs: 1, size: 8, generation: 1, extentCount: 1, recId: 7 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const kv = new MemIndex();
    try {
      const c = cluster(kv, 'zstd');
      await c.setBucketLimits('logs', { quotaBytes: 4, compress: false });
      await expect(c.put('logs', 'big.txt', Buffer.from('12345'))).rejects.toThrow(/quota/);
      expect(kv.map.has('logs/big.txt')).toBe(false);
      await c.setBucketLimits('pics', { compress: false });
      await c.put('pics', 'a.txt', Buffer.alloc(80, 1));
      const loc = JSON.parse(kv.map.get('pics/a.txt')!.toString('utf8')) as { compressType: string };
      expect(loc.compressType).toBe('none');
    } finally {
      globalThis.fetch = previous;
    }
  });
});

describe('tightest disk', () => {
  test('a zone reports the smaller disk and ignores a larger one added beside it', () => {
    const rows = tightestDisks([
      { zone: 'z1', status: 'up', freeBytes: 100 },
      { zone: 'z1', status: 'up', freeBytes: 1000 },
      { zone: 'z2', status: 'up', freeBytes: 50 },
    ]);
    expect(rows.find((row) => row.zone === 'z1')).toEqual({ zone: 'z1', writableBytes: 100, uneven: true });
    expect(rows.find((row) => row.zone === 'z2')?.writableBytes).toBe(50);
  });
});
