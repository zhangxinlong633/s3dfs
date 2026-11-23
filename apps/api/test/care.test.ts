import { describe, expect, test } from 'bun:test';
import { decodeCareState, deliverCare, emptyCareState, encodeCareState, reviewCare, type CareInput } from '../src/s3/care';

function input(partial: Partial<CareInput> = {}): CareInput {
  return {
    now: Date.parse('2026-11-20T12:00:00Z'),
    indexOk: false,
    layoutOk: true,
    strict: true,
    lost: 0,
    buckets: [],
    draining: null,
    cooldownMs: 300_000,
    contact: '找值班同学：ops@example.com',
    publicBase: 'http://api.example',
    tried: ['已运行副本修复'],
    ...partial,
  };
}

describe('care incidents', () => {
  test('opens one incident when health would stay 503', () => {
    const first = reviewCare(emptyCareState(), input());
    expect(first.pending).toHaveLength(1);
    expect(first.pending[0]?.severity).toBe('action_needed');
    expect(first.pending[0]?.url).toBe(`http://api.example/_s3dfs/incidents/${encodeURIComponent(first.pending[0]!.id)}`);
    first.state.open[Object.keys(first.state.open)[0]!]!.delivered = true;
    const second = reviewCare(first.state, input());
    expect(second.pending).toHaveLength(0);
  });

  test('sends a recovered event after the failure clears', () => {
    const opened = reviewCare(emptyCareState(), input());
    opened.state.open[Object.keys(opened.state.open)[0]!]!.delivered = true;
    const recovered = reviewCare(opened.state, input({ indexOk: true }));
    expect(recovered.pending.map((item) => item.severity)).toEqual(['recovered']);
  });

  test('keeps a failed delivery for the next cycle', () => {
    const opened = reviewCare(emptyCareState(), input());
    const again = reviewCare(opened.state, input());
    expect(again.pending.map((item) => item.id)).toEqual([opened.pending[0]?.id]);
  });

  test('tells an assistant not to repair an object that is already lost', () => {
    const opened = reviewCare(emptyCareState(), input({ indexOk: true, lost: 1, buckets: ['logs'] }));
    expect(opened.pending[0]?.doNot.join('')).toContain('不能靠修复补回');
    expect(opened.pending[0]?.scope).toBe('logs');
  });
});

describe('care delivery', () => {
  test('does not post when no alert address is configured', async () => {
    const opened = reviewCare(emptyCareState(), input());
    const posts: string[] = [];
    const ok = await deliverCare(opened.pending[0]!, {
      webhookUrls: [],
      post: async (url) => {
        posts.push(url);
        return true;
      },
      log: () => undefined,
    });
    expect(ok).toBe(false);
    expect(posts).toEqual([]);
    expect(opened.state.open['index_down:cluster']).toBeDefined();
  });

  test('posts the same note to the alert address and the bucket webhook', async () => {
    const opened = reviewCare(emptyCareState(), input({ indexOk: true, lost: 1, buckets: ['logs'] }));
    const posts: string[] = [];
    const ok = await deliverCare(opened.pending[0]!, {
      alertUrl: 'http://alerts.example/hook',
      webhookUrls: ['http://bucket.example/hook'],
      post: async (url) => {
        posts.push(url);
        return true;
      },
      log: () => undefined,
    });
    expect(ok).toBe(true);
    expect(posts).toEqual(['http://alerts.example/hook', 'http://bucket.example/hook']);
  });

  test('a failed post can be retried with the same incident', async () => {
    const opened = reviewCare(emptyCareState(), input());
    const first = await deliverCare(opened.pending[0]!, {
      alertUrl: 'http://alerts.example/hook',
      webhookUrls: [],
      post: async () => false,
      log: () => undefined,
    });
    expect(first).toBe(false);
    const again = reviewCare(opened.state, input());
    expect(again.pending[0]?.id).toBe(opened.pending[0]?.id);
  });

  test('an open incident survives a restart of the saved state', () => {
    const opened = reviewCare(emptyCareState(), input());
    const loaded = decodeCareState(encodeCareState(opened.state));
    const again = reviewCare(loaded, input());
    expect(Object.keys(loaded.open)).toEqual(Object.keys(opened.state.open));
    expect(again.pending[0]?.id).toBe(opened.pending[0]?.id);
  });
});
