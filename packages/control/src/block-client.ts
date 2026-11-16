import type { BlockHealth, BlockStats, CompressType, ExtentLocator, ObjectValue } from './types.js';
import { ControlError, extentFromLocator } from './types.js';

export interface BlockPutMeta {
  compressType?: CompressType;
  origSize?: number;
  origCrc?: number;
}

function blockUrl(address: string, path: string): string {
  const base = address.startsWith('http://') || address.startsWith('https://') ? address : `http://${address}`;
  return `${base}${path}`;
}

function locatorHeaders(key: string, loc?: ExtentLocator): Record<string, string> {
  const headers: Record<string, string> = {
    'x-s3dfs-key': encodeURIComponent(key),
  };
  if (loc) {
    headers['x-s3dfs-locator'] = encodeURIComponent(JSON.stringify(extentFromLocator(loc)));
  }
  return headers;
}

export async function blockHealth(address: string, timeoutMs = 2000): Promise<BlockHealth | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(blockUrl(address, '/health'), { signal: ac.signal });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as BlockHealth;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function blockPut(
  address: string,
  key: string,
  value: Buffer,
  meta?: BlockPutMeta,
): Promise<ExtentLocator> {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    ...locatorHeaders(key),
  };
  if (meta) {
    headers['x-s3dfs-meta'] = encodeURIComponent(JSON.stringify(meta));
  }
  const res = await fetch(blockUrl(address, '/_s3dfs/block/put'), {
    method: 'POST',
    headers,
    body: value,
  });
  if (!res.ok) {
    throw new ControlError('BLOCK_UNAVAILABLE', `block put ${address} ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as ExtentLocator;
}

export async function blockGet(address: string, key: string, loc: ExtentLocator): Promise<ObjectValue | null> {
  const res = await fetch(blockUrl(address, `/_s3dfs/block/get?key=${encodeURIComponent(key)}`), {
    headers: locatorHeaders(key, loc),
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new ControlError('BLOCK_UNAVAILABLE', `block get ${address} ${res.status}`);
  }
  const value = Buffer.from(await res.arrayBuffer());
  return {
    value,
    size: Number(res.headers.get('x-s3dfs-size') ?? value.length),
    crc: Number(res.headers.get('x-s3dfs-crc') ?? 0),
    mtimeMs: Number(res.headers.get('x-s3dfs-mtime') ?? 0),
  };
}

export async function blockHead(address: string, key: string, loc: ExtentLocator): Promise<Omit<ObjectValue, 'value'> | null> {
  const res = await fetch(blockUrl(address, `/_s3dfs/block/head?key=${encodeURIComponent(key)}`), {
    method: 'GET',
    headers: locatorHeaders(key, loc),
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new ControlError('BLOCK_UNAVAILABLE', `block head ${address} ${res.status}`);
  }
  return (await res.json()) as { size: number; crc: number; mtimeMs: number };
}

export async function blockFlush(address: string): Promise<void> {
  const res = await fetch(blockUrl(address, '/_s3dfs/block/flush'), { method: 'POST' });
  if (!res.ok) {
    throw new ControlError('BLOCK_UNAVAILABLE', `block flush ${address} ${res.status}`);
  }
}

export async function blockStats(address: string): Promise<BlockStats> {
  const res = await fetch(blockUrl(address, '/_s3dfs/block/stats'));
  if (!res.ok) {
    throw new ControlError('BLOCK_UNAVAILABLE', `block stats ${address} ${res.status}`);
  }
  return (await res.json()) as BlockStats;
}

export async function blockTombstone(address: string, key: string): Promise<void> {
  const res = await fetch(blockUrl(address, '/_s3dfs/block/delete'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...locatorHeaders(key) },
    body: JSON.stringify({ key }),
  });
  if (!res.ok && res.status !== 404) {
    throw new ControlError('BLOCK_UNAVAILABLE', `block tombstone ${address} ${res.status}`);
  }
}

export async function blockScan(address: string): Promise<{ key: string; locator: ExtentLocator }[]> {
  const res = await fetch(blockUrl(address, '/_s3dfs/block/scan'));
  if (!res.ok) {
    throw new ControlError('BLOCK_UNAVAILABLE', `block scan ${address} ${res.status}`);
  }
  return (await res.json()) as { key: string; locator: ExtentLocator }[];
}
