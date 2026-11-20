import { describe, expect, test } from 'bun:test';
import { IndexClient } from '../src/kv-client';

describe('index write failover', () => {
  test('uses the next index url when the first one is down, then sticks to it', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      if (url.startsWith('http://down')) {
        throw new Error('down');
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const kv = new IndexClient(['http://down', 'http://up'], fetchImpl);
    await kv.put('k', Buffer.from('v'));
    await kv.put('k2', Buffer.from('v'));
    expect(seen[0]).toContain('http://down');
    expect(seen.filter((url) => url.startsWith('http://up'))).toHaveLength(2);
    expect(seen.filter((url) => url.startsWith('http://down'))).toHaveLength(1);
  });
});
