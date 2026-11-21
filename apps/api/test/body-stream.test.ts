import { describe, expect, test } from 'bun:test';
import { PUT_CHUNK_BYTES, openRequestBody } from '../src/s3/body-stream';

async function* chunks(parts: Buffer[]): AsyncIterable<Buffer> {
  for (const part of parts) {
    yield part;
  }
}

describe('openRequestBody', () => {
  test('keeps a small body in one buffer and streams a body past one chunk', async () => {
    const small = await openRequestBody(chunks([Buffer.from('abc')]), 1024 * 1024 * 1024);
    expect('body' in small && small.body.toString()).toBe('abc');

    const big = await openRequestBody(
      chunks([Buffer.alloc(PUT_CHUNK_BYTES, 1), Buffer.alloc(8, 2)]),
      1024 * 1024 * 1024,
    );
    if (!('stream' in big)) {
      throw new Error('expected a stream');
    }
    const parts: Buffer[] = [];
    for await (const part of big.stream) {
      parts.push(part);
    }
    expect(Buffer.concat(parts).length).toBe(PUT_CHUNK_BYTES + 8);
  });
});
