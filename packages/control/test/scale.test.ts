import { describe, expect, test } from 'bun:test';
import { NodeRegistry } from '../src/registry.ts';
import type { IndexClient } from '../src/kv-client.ts';
import {
  apiStopAllowed,
  blockStopAllowed,
  decideScale,
  indexStopAllowed,
  type ScaleConfig,
  type ScaleLoads,
} from '../src/scale.ts';

const cfg: ScaleConfig = {
  highRatio: 0.8,
  lowRatio: 0.4,
  highLatencyMs: 200,
  lowLatencyMs: 50,
  highStreak: 3,
  cooldownMs: 300_000,
  blockCapacityBytes: 1000,
  indexCapacityBytes: 1000,
  indexMaxKeys: 100,
  apiMaxInflight: 10,
  dataReplicas: 3,
};

function loads(partial: Partial<ScaleLoads> = {}): ScaleLoads {
  const quiet = { keys: 10, bytes: 100, inflight: 1, latencyP99Ms: 10, nodes: 4, streak: 0, lastActionMs: 0 };
  return {
    index: { ...quiet, ...partial.index },
    block: { ...quiet, nodes: 4, ...partial.block },
    api: { ...quiet, nodes: 2, ...partial.api },
  };
}

describe('scale decisions', () => {
  test('scales the role whose capacity stayed high for the streak', () => {
    const decision = decideScale(
      loads({ index: { keys: 100, bytes: 100, inflight: 0, latencyP99Ms: 10, nodes: 4, streak: 2, lastActionMs: 0 } }),
      cfg,
      1_000_000,
    );
    expect(decision.action).toBe('up');
    expect(decision.role).toBe('index');
    expect(decision.reason).toBe('capacity');
  });

  test('scales the role whose latency stayed high for the streak', () => {
    const decision = decideScale(
      loads({
        index: { keys: 10, bytes: 100, inflight: 0, latencyP99Ms: 100, nodes: 4, streak: 0, lastActionMs: 0 },
        block: { keys: 0, bytes: 100, inflight: 0, latencyP99Ms: 500, nodes: 4, streak: 2, lastActionMs: 0 },
      }),
      cfg,
      1_000_000,
    );
    expect(decision.action).toBe('up');
    expect(decision.role).toBe('block');
    expect(decision.reason).toBe('latency');
  });

  test('does not shrink while the cooldown is still open', () => {
    const now = 1_000_000;
    const decision = decideScale(
      loads({
        index: { keys: 10, bytes: 100, inflight: 0, latencyP99Ms: 10, nodes: 4, streak: 0, lastActionMs: now - 1000 },
        block: { keys: 0, bytes: 100, inflight: 0, latencyP99Ms: 10, nodes: 4, streak: 0, lastActionMs: now - 1000 },
        api: { keys: 0, bytes: 0, inflight: 1, latencyP99Ms: 10, nodes: 2, streak: 0, lastActionMs: now - 1000 },
      }),
      cfg,
      now,
    );
    expect(decision.action).toBe('none');
  });

  test('shrinks once capacity and latency are both low and the cooldown has elapsed', () => {
    const decision = decideScale(loads(), cfg, 1_000_000);
    expect(decision.action).toBe('down');
    expect(decision.role).toBe('index');
  });

  test('acts on the index when every role is hot in the same tick', () => {
    const hot = { keys: 100, bytes: 900, inflight: 10, latencyP99Ms: 500, nodes: 4, streak: 2, lastActionMs: 0 };
    const decision = decideScale(loads({ index: hot, block: { ...hot, nodes: 4 }, api: { ...hot, nodes: 2 } }), cfg, 1_000_000);
    expect(decision.action).toBe('up');
    expect(decision.role).toBe('index');
  });
});

describe('scale drain gates', () => {
  test('refuses to stop a block that still has a live locator', () => {
    expect(
      blockStopAllowed({
        locators: 1,
        remaining: [
          { zone: 'z1' },
          { zone: 'z2' },
          { zone: 'z3' },
        ],
        dataReplicas: 3,
        strict: true,
      }),
    ).toBe(false);
  });

  test('refuses to stop a block when the remaining nodes lose a failure domain', () => {
    expect(
      blockStopAllowed({
        locators: 0,
        remaining: [{ zone: 'z1' }, { zone: 'z1' }],
        dataReplicas: 2,
        strict: true,
      }),
    ).toBe(false);
  });

  test('refuses to stop an index that would fall below quorum or three nodes', () => {
    expect(indexStopAllowed(2, 2)).toBe(false);
    expect(indexStopAllowed(3, 2)).toBe(true);
  });

  test('refuses to stop the last api or one that still has in-flight requests', () => {
    expect(apiStopAllowed(0, 1)).toBe(false);
    expect(apiStopAllowed(2, 3)).toBe(false);
    expect(apiStopAllowed(0, 2)).toBe(true);
  });
});

describe('draining nodes', () => {
  test('placement skips a block marked draining', () => {
    const kv = {
      async put() {},
      async get() {
        return null;
      },
      async head() {
        return null;
      },
      async delete() {
        return false;
      },
      async scan() {
        return { objects: [], truncated: false };
      },
      async ping() {
        return true;
      },
      endpoints: ['http://mem'],
    };
    const registry = new NodeRegistry(kv as unknown as IndexClient, [
      { nodeId: 'a', address: '10.0.0.1:9100', zone: 'z1' },
      { nodeId: 'b', address: '10.0.0.2:9100', zone: 'z2' },
    ]);
    const draining = registry.get('a');
    registry.noteDraining('a', true);
    expect(draining?.nodeId).toBe('a');
    expect(registry.pick('logs/a.txt', 1).map((node) => node.nodeId)).toEqual(['b']);
  });
});
