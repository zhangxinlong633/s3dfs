import { describe, expect, test } from 'bun:test';
import type { ExtentLocator } from '../src/types.ts';
import { PUT_CHUNK_BYTES, relayChunks } from '../src/stream.ts';

describe('relayChunks', () => {
  test('forwards 8 MiB without retaining more than one chunk', async () => {
    let held = 0;
    let maxHeld = 0;
    const received: Buffer[] = [];
    const writer = {
      async write(chunk: Buffer) {
        held += chunk.length;
        maxHeld = Math.max(maxHeld, held);
        received.push(Buffer.from(chunk));
        held -= chunk.length;
      },
      async finish(): Promise<ExtentLocator> {
        return { chained: true, crc: 0, mtimeMs: 1, size: received.reduce((sum, part) => sum + part.length, 0), generation: 1, extentCount: received.length, recId: 7 };
      },
      async abort() {},
    };
    const chunks = [Buffer.alloc(PUT_CHUNK_BYTES, 1), Buffer.alloc(PUT_CHUNK_BYTES, 2), Buffer.alloc(PUT_CHUNK_BYTES, 3), Buffer.alloc(PUT_CHUNK_BYTES, 4), Buffer.alloc(PUT_CHUNK_BYTES, 5), Buffer.alloc(PUT_CHUNK_BYTES, 6), Buffer.alloc(PUT_CHUNK_BYTES, 7), Buffer.alloc(PUT_CHUNK_BYTES, 8)];
    const out = await relayChunks(chunks, [writer]);
    expect(out.size).toBe(8 * PUT_CHUNK_BYTES);
    expect(maxHeld).toBe(PUT_CHUNK_BYTES);
    expect(out.locs[0]?.recId).toBe(7);
    expect(Buffer.concat(received).length).toBe(out.size);
  });
});
