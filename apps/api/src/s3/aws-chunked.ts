import { chunkSignature, sameHex } from './sigv4';

export class AwsChunkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AwsChunkError';
  }
}

export function isAwsChunked(opts: { encoding?: string; contentSha?: string }): boolean {
  const encoding = opts.encoding ?? '';
  if (encoding.split(',').some((part) => part.trim().toLowerCase() === 'aws-chunked')) {
    return true;
  }
  return (opts.contentSha ?? '').startsWith('STREAMING-');
}

/** Decode an `aws-chunked` body. Chunk signatures and the trailing checksum are not part of the object. */
export function decodeAwsChunked(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset);
    if (lineEnd < 0) {
      throw new AwsChunkError('truncated aws-chunked body');
    }
    const hex = body.toString('ascii', offset, lineEnd).split(';', 1)[0]?.trim() ?? '';
    if (!/^[0-9a-fA-F]+$/.test(hex)) {
      throw new AwsChunkError('invalid aws chunk size');
    }
    const size = Number.parseInt(hex, 16);
    offset = lineEnd + 2;
    if (size === 0) {
      return Buffer.concat(parts);
    }
    if (offset + size + 2 > body.length) {
      throw new AwsChunkError('truncated aws chunk');
    }
    parts.push(body.subarray(offset, offset + size));
    offset += size;
    if (body[offset] !== 0x0d || body[offset + 1] !== 0x0a) {
      throw new AwsChunkError('aws chunk missing CRLF');
    }
    offset += 2;
  }
  throw new AwsChunkError('aws-chunked body ended without a zero chunk');
}

/** Decode aws-chunked bytes as they arrive. Only the unfinished chunk is kept. */
export function openAwsChunked(
  source: AsyncIterable<Buffer | Uint8Array | string>,
  verify?: { secret: string; scope: string; amzDate: string; seed: string },
): {
  stream: AsyncIterable<Buffer>;
  retained: () => number;
} {
  let pending = Buffer.alloc(0);
  let retained = 0;
  let previous = verify?.seed ?? '';
  const note = (): void => {
    retained = Math.max(retained, pending.length);
  };
  async function* stream(): AsyncGenerator<Buffer> {
    const iterator = source[Symbol.asyncIterator]();
    const pull = async (): Promise<boolean> => {
      const next = await iterator.next();
      if (next.done) {
        return false;
      }
      const buf = Buffer.isBuffer(next.value) ? Buffer.from(next.value) : Buffer.from(next.value);
      pending = pending.length === 0 ? buf : Buffer.concat([pending, buf]);
      note();
      return true;
    };
    for (;;) {
      const lineEnd = pending.indexOf('\r\n');
      if (lineEnd < 0) {
        if (!(await pull())) {
          throw new AwsChunkError('truncated aws-chunked body');
        }
        continue;
      }
      const line = pending.toString('ascii', 0, lineEnd);
      const hex = line.split(';', 1)[0]?.trim() ?? '';
      if (!/^[0-9a-fA-F]+$/.test(hex)) {
        throw new AwsChunkError('invalid aws chunk size');
      }
      const size = Number.parseInt(hex, 16);
      const dataAt = lineEnd + 2;
      if (pending.length < dataAt + size + 2) {
        if (!(await pull())) {
          throw new AwsChunkError('truncated aws chunk');
        }
        continue;
      }
      if (pending[dataAt + size] !== 0x0d || pending[dataAt + size + 1] !== 0x0a) {
        throw new AwsChunkError('aws chunk missing CRLF');
      }
      const data = pending.subarray(dataAt, dataAt + size);
      if (verify) {
        const sig = /chunk-signature=([0-9a-fA-F]{64})/.exec(line)?.[1];
        if (sig) {
          const expected = chunkSignature(verify.secret, verify.scope, verify.amzDate, previous, Buffer.from(data));
          if (!sameHex(expected, sig)) {
            throw new AwsChunkError('chunk signature does not match');
          }
          previous = sig.toLowerCase();
        }
      }
      if (size === 0) {
        return;
      }
      const step = 1024 * 1024;
      for (let offset = 0; offset < data.length; offset += step) {
        yield Buffer.from(data.subarray(offset, Math.min(data.length, offset + step)));
      }
      pending = pending.subarray(dataAt + size + 2);
      note();
    }
  }
  return { stream: stream(), retained: () => retained };
}

export function objectBytes(opts: {
  encoding?: string;
  contentSha?: string;
  decodedLength?: string;
  body: Buffer;
}): Buffer {
  if (!isAwsChunked(opts)) {
    return opts.body;
  }
  const decoded = decodeAwsChunked(opts.body);
  if (opts.decodedLength !== undefined && opts.decodedLength !== '') {
    const declared = Number(opts.decodedLength);
    if (!Number.isFinite(declared) || declared !== decoded.length) {
      throw new AwsChunkError(`decoded length ${decoded.length} != ${opts.decodedLength}`);
    }
  }
  return decoded;
}
