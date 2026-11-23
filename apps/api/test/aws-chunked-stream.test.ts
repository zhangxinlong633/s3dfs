import { describe, expect, test } from 'bun:test';
import { openAwsChunked } from '../src/s3/aws-chunked';

function chunk(payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${payload.length.toString(16)}\r\n`), payload, Buffer.from('\r\n')]);
}

describe('aws-chunked stream', () => {
  test('a body over 1 MiB keeps only the unfinished piece', async () => {
    const piece = Buffer.alloc(64 * 1024, 7);
    const frames: Buffer[] = [];
    for (let i = 0; i < 20; i++) {
      frames.push(chunk(piece));
    }
    frames.push(Buffer.from('0\r\n\r\n'));
    async function* source(): AsyncGenerator<Buffer> {
      for (const frame of frames) {
        yield frame.subarray(0, 100);
        yield frame.subarray(100);
      }
    }
    const opened = openAwsChunked(source());
    const out: Buffer[] = [];
    for await (const part of opened.stream) {
      out.push(part);
    }
    expect(Buffer.concat(out).length).toBe(20 * 64 * 1024);
    expect(opened.retained()).toBeLessThanOrEqual(1024 * 1024);
  });
});