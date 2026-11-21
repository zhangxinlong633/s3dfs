import { describe, expect, test } from 'bun:test';
import {
  compactSnapshot,
  executePatrol,
  modelAllowed,
  patrolAuthorized,
  reviewPatrol,
  type PatrolSnapshot,
} from '../src/s3/patrol';

function snapshot(partial: Partial<PatrolSnapshot> = {}): PatrolSnapshot {
  return {
    now: 1_700_000_000_000,
    index: { ok: true, keys: 10, latencyP99Ms: 5, copiesMatch: true },
    block: {
      nodes: [
        { nodeId: 'b1', up: true, zone: 'a', bytesOnDisk: 100, deadBytes: 0, locators: 1, draining: false, unflushedBytes: 0 },
      ],
    },
    layout: { ok: true, strict: true, dataReplicas: 3, liveBlocks: 3, failureDomains: 3 },
    repair: { lost: 0, shortCopies: 0 },
    api: { inflight: 1, latencyP99Ms: 5, maxInflight: 128 },
    scale: { wants: 'none', upConfigured: false, streak: 0, highStreak: 3, lastActionMs: 0, cooldownMs: 300_000, draining: false },
    care: { open: 0 },
    compactDeadRatio: 0.2,
    highLatencyMs: 200,
    ...partial,
  };
}

describe('patrol review', () => {
  test('repairs when live copies are short and compacts a hole-heavy node', async () => {
    const report = reviewPatrol(
      snapshot({
        repair: { lost: 0, shortCopies: 2 },
        block: {
          nodes: [
            { nodeId: 'b1', up: true, zone: 'a', bytesOnDisk: 100, deadBytes: 40, locators: 1, draining: false, unflushedBytes: 0 },
          ],
        },
      }),
    );
    expect(report.decisions.map((item) => item.action).sort()).toEqual(['compact', 'repair']);
    expect(report.decisions.every((item) => item.apply)).toBe(true);
    const called: string[] = [];
    await executePatrol(report, {
      repair: async () => {
        called.push('repair');
      },
      compact: async () => {
        called.push('compact');
      },
      flush: async () => {
        called.push('flush');
      },
      scaleUp: async () => {
        called.push('scale_up');
      },
    });
    expect(called.sort()).toEqual(['compact', 'repair']);
  });

  test('flushes a dirty buffer and scales up only when the script exists and cooldown has passed', async () => {
    const report = reviewPatrol(
      snapshot({
        block: {
          nodes: [
            { nodeId: 'b1', up: true, zone: 'a', bytesOnDisk: 10, deadBytes: 0, locators: 1, draining: false, unflushedBytes: 4096 },
          ],
        },
        scale: { wants: 'up', upConfigured: true, streak: 3, highStreak: 3, lastActionMs: 0, cooldownMs: 300_000, draining: false },
      }),
    );
    expect(report.apply).toEqual(['flush', 'scale_up']);
  });

  test('records loss, layout, and scale-down without executing them', async () => {
    const report = reviewPatrol(
      snapshot({
        repair: { lost: 1, shortCopies: 0 },
        layout: { ok: false, strict: true, dataReplicas: 3, liveBlocks: 1, failureDomains: 1 },
        scale: { wants: 'down', upConfigured: true, streak: 0, highStreak: 3, lastActionMs: 0, cooldownMs: 300_000, draining: true },
      }),
    );
    expect(report.apply).toEqual([]);
    expect(report.decisions.every((item) => item.apply === false)).toBe(true);
    expect(report.decisions.some((item) => item.summary.includes('不能靠修复补回'))).toBe(true);
    const called: string[] = [];
    await executePatrol(report, {
      repair: async () => called.push('repair'),
      compact: async () => called.push('compact'),
      flush: async () => called.push('flush'),
      scaleUp: async () => called.push('scale_up'),
    });
    expect(called).toEqual([]);
  });

  test('keeps a module snapshot inside 8KB by dropping extra block nodes', () => {
    const nodes = Array.from({ length: 400 }, (_, i) => ({
      nodeId: `block-${i}`,
      up: true,
      zone: 'z',
      bytesOnDisk: 1,
      deadBytes: 0,
      locators: 1,
      draining: false,
      unflushedBytes: 0,
    }));
    const packed = compactSnapshot(snapshot({ block: { nodes } }));
    expect(Buffer.byteLength(JSON.stringify(packed))).toBeLessThanOrEqual(8192);
    expect(packed.truncated).toBe(true);
    expect(packed.block.nodes.length).toBeGreaterThan(0);
  });

  test('does not scale up again while the cooldown is still running', () => {
    const report = reviewPatrol(
      snapshot({
        now: 1_000_000,
        scale: { wants: 'up', upConfigured: true, streak: 3, highStreak: 3, lastActionMs: 900_000, cooldownMs: 300_000, draining: false },
      }),
    );
    expect(report.apply).not.toContain('scale_up');
    expect(report.decisions.some((item) => item.summary.includes('只记录'))).toBe(true);
  });

  test('briefs the operator with changes, a down node, errors, and the open incident', () => {
    const first = reviewPatrol(snapshot());
    const report = reviewPatrol(
      snapshot({
        block: {
          nodes: [
            { nodeId: 'b1', up: false, zone: 'a', bytesOnDisk: 100, deadBytes: 0, locators: 1, draining: false, unflushedBytes: 0 },
          ],
        },
        api: { inflight: 1, latencyP99Ms: 80, maxInflight: 128, requests: 100, serverErrors: 10 },
        care: {
          open: 1,
          incidents: [{ id: 'lost:logs:1', symptom: 'logs 有对象没有活副本', next: '联系值班确认是否接受丢失' }],
        },
      }),
      first.findings,
    );
    expect(report.decisions.some((item) => item.summary.includes('b1'))).toBe(true);
    expect(report.changes).toContainEqual({ module: 'api', metric: 'latencyP99Ms', previous: 5, current: 80 });
    expect(report.watch.some((line) => line.includes('b1'))).toBe(true);
    expect(report.watch.some((line) => line.includes('联系值班确认是否接受丢失'))).toBe(true);
    expect(report.brief).toContain('现状');
    expect(report.brief).toContain('相比上次');
    expect(report.brief).toContain('已执行');
    expect(report.brief).toContain('值班下一步');
  });

  test('says a single-node layout without zones is not a production failure', () => {
    const report = reviewPatrol(
      snapshot({
        layout: { ok: true, strict: false, dataReplicas: 1, liveBlocks: 1, failureDomains: 0 },
      }),
    );
    expect(report.brief).toContain('严格布局关闭');
    expect(report.watch.some((line) => line.includes('故障域'))).toBe(false);
  });

  test('requires the patrol token and a model of at least 26B', () => {
    expect(patrolAuthorized(undefined, {})).toBe(false);
    expect(patrolAuthorized('secret', { S3DFS_PATROL_TOKEN: 'secret' })).toBe(true);
    expect(patrolAuthorized('nope', { S3DFS_PATROL_TOKEN: 'secret' })).toBe(false);
    expect(modelAllowed(26_000_000_000)).toBe(true);
    expect(modelAllowed(25_000_000_000)).toBe(false);
    expect(modelAllowed(undefined)).toBe(true);
  });
});
