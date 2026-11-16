import type { BlockHealth, BlockStats, ObjectValue } from './types.js';
import { ControlError } from './types.js';

function blockUrl(address: string, path: string): string {
  const base = address.startsWith('http://') || address.startsWith('https://') ? address : `http://${address}`;
  return `${base}${path}`;
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

export async function blockPut(address: string, key: string, value: Buffer): Promise<{ size: number; crc: number; mtimeMs: number }> {
  const res = await fetch(blockUrl(address, '/_s3dfs/block/put'), {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-s3dfs-key': encodeURIComponent(key),
    },
    body: value,
  });
  if (!res.ok) {
    throw new ControlError('BLOCK_UNAVAILABLE', `block put ${address} ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as { size: number; crc: number; mtimeMs: number };
}

export async function blockGet(address: string, key: string): Promise<ObjectValue | null> {
  const res = await fetch(blockUrl(address, `/_s3dfs/block/get?key=${encodeURIComponent(key)}`));
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

export async function blockHead(address: string, key: string): Promise<Omit<ObjectValue, 'value'> | null> {
  const res = await fetch(blockUrl(address, `/_s3dfs/block/head?key=${encodeURIComponent(key)}`), { method: 'GET' });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new ControlError('BLOCK_UNAVAILABLE', `block head ${address} ${res.status}`);
  }
  const body = (await res.json()) as { size: number; crc: number; mtimeMs: number };
  return body;
}

export async function blockDelete(address: string, key: string): Promise<boolean> {
  const res = await fetch(blockUrl(address, '/_s3dfs/block/delete'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  if (!res.ok) {
    throw new ControlError('BLOCK_UNAVAILABLE', `block delete ${address} ${res.status}`);
  }
  const body = (await res.json()) as { deleted?: boolean };
  return Boolean(body.deleted);
}

export async function blockFlush(address: string): Promise<void> {
  const res = await fetch(blockUrl(address, '/_s3dfs/block/flush'), { method: 'POST' });
  if (!res.ok) {
    throw new ControlError('BLOCK_UNAVAILABLE', `block flush ${address} ${res.status}`);
  }
}

export async function blockCompact(address: string): Promise<void> {
  const res = await fetch(blockUrl(address, '/_s3dfs/block/compact'), { method: 'POST' });
  if (!res.ok) {
    throw new ControlError('BLOCK_UNAVAILABLE', `block compact ${address} ${res.status}`);
  }
}

export async function blockStats(address: string): Promise<BlockStats> {
  const res = await fetch(blockUrl(address, '/_s3dfs/block/stats'));
  if (!res.ok) {
    throw new ControlError('BLOCK_UNAVAILABLE', `block stats ${address} ${res.status}`);
  }
  return (await res.json()) as BlockStats;
}
