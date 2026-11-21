import { describe, expect, test } from 'bun:test';
import { alertBodies, postAlerts } from '../src/s3/alerts';

describe('alerts', () => {
  test('a lost key is sent only when an address is configured', async () => {
    const bodies = alertBodies({ lostKeys: ['logs/a.txt'], layoutOk: true });
    expect(bodies).toEqual(['lost logs/a.txt']);
    const seen: string[] = [];
    await postAlerts(undefined, bodies, (async () => {
      throw new Error('should not send');
    }) as typeof fetch);
    await postAlerts('http://oncall.local/alerts', bodies, (async (_url: string, init?: { body?: string }) => {
      seen.push(init?.body ?? '');
      return new Response('ok');
    }) as typeof fetch);
    expect(seen).toEqual(['lost logs/a.txt']);
  });
});