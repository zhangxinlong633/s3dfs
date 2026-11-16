import zlib from 'node:zlib';

export type CompressType = 'none' | 'zstd' | 'gzip';

const MIN_COMPRESS_BYTES = 64;

export function parseCompressType(raw?: string | undefined): CompressType {
  const value = (raw ?? 'zstd').trim().toLowerCase();
  if (value === 'none' || value === 'off' || value === '0' || value === 'false') {
    return 'none';
  }
  if (value === 'gzip' || value === 'gz' || value === 'deflate') {
    return 'gzip';
  }
  return 'zstd';
}

export function crc32(data: Buffer): number {
  return zlib.crc32(data) >>> 0;
}

export function compressValue(value: Buffer, prefer: CompressType): { stored: Buffer; compressType: CompressType } {
  if (prefer === 'none' || value.length < MIN_COMPRESS_BYTES) {
    return { stored: value, compressType: 'none' };
  }
  try {
    const packed = prefer === 'gzip' ? zlib.gzipSync(value) : zlib.zstdCompressSync(value);
    const stored = Buffer.isBuffer(packed) ? packed : Buffer.from(packed);
    if (stored.length < value.length) {
      return { stored, compressType: prefer };
    }
  } catch {
    // Keep the original bytes and record that nothing was applied.
  }
  return { stored: value, compressType: 'none' };
}

export function decompressValue(stored: Buffer, compressType: CompressType | undefined): Buffer {
  if (!compressType || compressType === 'none') {
    return stored;
  }
  if (compressType === 'gzip') {
    const out = zlib.gunzipSync(stored);
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  }
  if (compressType === 'zstd') {
    const out = zlib.zstdDecompressSync(stored);
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  }
  throw new Error(`unknown compressType ${compressType}`);
}
