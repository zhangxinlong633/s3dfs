import { describe, expect, test } from 'bun:test';
import { countLocators } from '../src/engine/locator-count';

describe('locator counts', () => {
  test('keeps counting after 20000 locators', async () => {
    const total = 20_001;
    const keys = Array.from({ length: total }, (_, i) => `b/k${String(i).padStart(6, '0')}`);
    const counts = await countLocators(
      async (startAfter) => {
        const start = startAfter ? keys.findIndex((key) => key === startAfter) + 1 : 0;
        const objects = keys.slice(start, start + 500).map((key) => ({ key }));
        return { objects, truncated: start + objects.length < keys.length };
      },
      async () => Buffer.from(JSON.stringify({ v: 3, nodeId: 'block1' })),
    );
    expect(counts.get('block1')).toBe(total);
  });
});
