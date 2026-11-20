import { describe, expect, test } from 'bun:test';
import type { IndexClient, KvValue } from '@s3dfs/control';
import { loadScaleConfig, type ScaleLoads } from '@s3dfs/control';
import { acquireScaleLease, emptyScaleMemory, scaleTick, type BlockCandidate } from '../src/s3/scaler';

const cfg = loadScaleConfig({
  S3DFS_SCALE_HIGH_RATIO: '0.8',
  S3DFS_SCALE_LOW_RATIO: '0.4',
  S3DFS_SCALE_HIGH_LATENCY_MS: '200',
  S3DFS_SCALE_LOW_LATENCY_MS: '50',
  S3DFS_SCALE_HIGH_STREAK: '3',
  S3DFS_SCALE_COOLDOWN_MS: '300000',
  S3DFS_BLOCK_CAPACITY_BYTES: '1000',
  S3DFS_INDEX_CAPACITY_BYTES: '1000',
  S3DFS_INDEX_MAX_KEYS: '100',
  S3DFS_API_MAX_INFLIGHT: '10',
  S3DFS_DATA_REPLICAS: '3',
});

function loads(): ScaleLoads {
  const quiet = { keys: 50, bytes: 100, inflight: 1, latencyP99Ms: 100, nodes: 4, streak: 0, lastActionMs: 0 };
  return { index: { ...quiet }, block: { ...quiet }, api: { ...quiet, nodes: 2 } };
}

function blocks(locators: number): BlockCandidate[] {
    return ['z1', 'z2', 'z3', 'z4'].map((zone, i) => ({
    nodeId: `b${i}`,
    address: `10.0.0.${i}:9100`,
    zone,
    locators,
  }));
}

describe('scale tick', () => {
  test('a failed scale-up does not start the cooldown', async () => {
    const calls: string[] = [];
    const first = await scaleTick({
      now: 1_000,
      config: cfg,
      loads: {
        ...loads(),
        index: { ...loads().index, keys: 100, latencyP99Ms: 10 },
      },
      memory: { ...emptyScaleMemory(), streak: { index: 2, block: 0, api: 0 } },
      upCmd: 'up',
      downCmd: 'down',
      hook: async (cmd) => {
        calls.push(cmd);
        return 1;
      },
      baseIndexNodes: 4,
      baseApiNodes: 2,
      strict: true,
      writeQuorum: 2,
      blocks: blocks(0),
      indexReady: false,
      apiInflight: 0,
      apiNodeId: 'api-1',
      apiAddress: '10.0.0.10:9000',
    });
    expect(calls).toEqual(['up']);
    expect(first.lastActionMs.index).toBe(0);
    const second = await scaleTick({
      now: 2_000,
      config: cfg,
      loads: { ...loads(), index: { ...loads().index, keys: 100, latencyP99Ms: 10, streak: first.streak.index } },
      memory: first,
      upCmd: 'up',
      downCmd: 'down',
      hook: async () => 0,
      baseIndexNodes: 4,
      baseApiNodes: 2,
      strict: true,
      writeQuorum: 2,
      blocks: blocks(0),
      indexReady: false,
      apiInflight: 0,
      apiNodeId: 'api-1',
      apiAddress: '10.0.0.10:9000',
    });
    expect(second.lastActionMs.index).toBe(2_000);
    expect(second.extraIndex).toBe(1);
  });

  test('does not stop a block that still has a locator', async () => {
    const calls: string[] = [];
    const next = await scaleTick({
      now: 1_000,
      config: cfg,
      loads: {
        ...loads(),
        block: { ...loads().block, latencyP99Ms: 10 },
      },
      memory: emptyScaleMemory(),
      upCmd: 'up',
      downCmd: 'down',
      hook: async (cmd) => {
        calls.push(cmd);
        return 0;
      },
      baseIndexNodes: 3,
      baseApiNodes: 2,
      strict: true,
      writeQuorum: 2,
      blocks: blocks(1),
      indexReady: false,
      apiInflight: 0,
      apiNodeId: 'api-1',
      apiAddress: '10.0.0.10:9000',
    });
    expect(calls).toEqual([]);
    expect(next.draining?.role).toBe('block');
  });
});

describe('scale lease', () => {
  test('a second api does not evaluate while the lease is held', async () => {
    const map = new Map<string, Buffer>();
    const kv = {
      async put(key: string, value: Buffer) {
        map.set(key, Buffer.from(value));
      },
      async get(key: string): Promise<KvValue | null> {
        const value = map.get(key);
        return value ? { key, value, size: value.length, crc: 0, mtimeMs: 1 } : null;
      },
    };
    expect(await acquireScaleLease(kv as unknown as IndexClient, 'api-a', 1_000, 5_000)).toBe(true);
    expect(await acquireScaleLease(kv as unknown as IndexClient, 'api-b', 2_000, 5_000)).toBe(false);
    expect(await acquireScaleLease(kv as unknown as IndexClient, 'api-b', 7_000, 5_000)).toBe(true);
  });
});
