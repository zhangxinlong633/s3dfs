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
