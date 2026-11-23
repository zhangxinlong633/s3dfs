import type { ChordTransport, KVEntry, KVValue, ScanOptions, ScanResult, VnodeInfo } from './types.js';
import { DLevelDBError } from './types.js';

function encodeKey(key: string): string {
  return encodeURIComponent(key);
}

function header(headers: Headers, name: string): string | undefined {
  return headers.get(name) ?? undefined;
}

function metaHeader(headers: Headers, field: 'size' | 'crc' | 'mtime'): string | undefined {
  return header(headers, `x-dleveldb-${field}`) ?? header(headers, `x-s3dfs-${field}`);
}

async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) {
      return res.statusText;
    }
    try {
      const json = JSON.parse(text) as { error?: string; message?: string };
      return json.error ?? json.message ?? text;
    } catch {
      return text;
    }
  } catch {
    return res.statusText;
  }
}

export class HttpTransport implements ChordTransport {
  constructor(
    readonly localAddress: string,
    readonly timeoutMs: number,
  ) {}

  isLocal(address: string): boolean {
    return address === this.localAddress;
  }

  url(address: string, path: string, query?: Record<string, string | undefined>): string {
    const u = new URL(path, `http://${address}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) {
          u.searchParams.set(k, v);
        }
      }
    }
    return u.toString();
  }

  async json<T>(
    address: string,
    path: string,
    opts: { method?: string; body?: unknown; query?: Record<string, string | undefined>; timeoutMs?: number } = {},
  ): Promise<T> {
    const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? this.timeoutMs);
    try {
      const res = await fetch(this.url(address, path, opts.query), {
        method,
        headers: {
          connection: 'close',
          ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ac.signal,
      });
      if (!res.ok) {
        const msg = await readError(res);
        if (res.status === 503) {
          throw new DLevelDBError('PRIMARY_UNAVAILABLE', msg);
        }
        throw new DLevelDBError('BAD_REQUEST', `rpc ${method} ${path} -> ${res.status}: ${msg}`);
      }
      if (res.status === 204) {
        return undefined as T;
      }
      const text = await res.text();
      if (!text) {
        return undefined as T;
      }
      return JSON.parse(text) as T;
    } catch (err) {
      if (err instanceof DLevelDBError) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new DLevelDBError('TIMEOUT', `rpc timeout ${path} @ ${address}`);
      }
      throw new DLevelDBError('PRIMARY_UNAVAILABLE', `rpc failed ${path} @ ${address}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async findSuccessor(address: string, hash: string, hops = 0): Promise<VnodeInfo> {
    const body = await this.json<{ vnode: VnodeInfo }>(address, '/_dleveldb/chord/find_successor', {
      method: 'POST',
      body: { hash, hops },
    });
    return body.vnode;
  }

  async notify(address: string, vnode: VnodeInfo, targetId: string): Promise<void> {
    await this.json(address, '/_dleveldb/chord/notify', { method: 'POST', body: { vnode, target: targetId } });
  }

  async getPredecessor(address: string, vnodeId: string): Promise<VnodeInfo | null> {
    const body = await this.json<{ vnode: VnodeInfo | null }>(address, '/_dleveldb/chord/predecessor', {
      query: { vnode: vnodeId },
    });
    return body.vnode;
  }

  async getSuccessorList(address: string, vnodeId: string): Promise<VnodeInfo[]> {
    const body = await this.json<{ vnodes: VnodeInfo[] }>(address, '/_dleveldb/chord/successor_list', {
      query: { vnode: vnodeId },
    });
    return body.vnodes ?? [];
  }

  async ping(address: string): Promise<boolean> {
    try {
      await this.json(address, '/_dleveldb/chord/ping', { method: 'GET', timeoutMs: Math.min(2000, this.timeoutMs) });
      return true;
    } catch {
      return false;
    }
  }

  async announce(address: string, vnodes: VnodeInfo[]): Promise<VnodeInfo[]> {
    const body = await this.json<{ vnodes: VnodeInfo[] }>(address, '/_dleveldb/chord/announce', {
      method: 'POST',
      body: { vnodes },
    });
    return body.vnodes ?? [];
  }

  async proxyPut(address: string, key: string, value: Buffer): Promise<void> {
    await this.sendBytes(address, '/_dleveldb/put', key, value);
  }

  async proxyFailoverPut(address: string, key: string, value: Buffer): Promise<void> {
    await this.sendBytes(address, '/_dleveldb/kv/failover-put', key, value);
  }

  async proxyFailoverDelete(address: string, key: string): Promise<void> {
    await this.json(address, '/_dleveldb/kv/failover-delete', { method: 'POST', body: { key } });
  }

  async replicatePut(address: string, ownerVnodeId: string, key: string, value: Buffer, mtimeMs?: number): Promise<void> {
    await this.sendBytes(address, '/_dleveldb/replicate', key, value, {
      'x-dleveldb-vnode': ownerVnodeId,
      'x-s3dfs-vnode': ownerVnodeId,
      ...(mtimeMs === undefined ? {} : { 'x-dleveldb-mtime': String(mtimeMs), 'x-s3dfs-mtime': String(mtimeMs) }),
    });
  }

  async proxyDelete(address: string, key: string): Promise<boolean> {
    const body = await this.json<{ deleted: boolean }>(address, '/_dleveldb/delete', {
      method: 'POST',
      body: { key },
    });
    return !!body.deleted;
  }

  async replicateDelete(address: string, ownerVnodeId: string, key: string): Promise<void> {
    await this.json(address, '/_dleveldb/replicate-delete', {
      method: 'POST',
      body: { key, vnode: ownerVnodeId },
    });
  }

  async proxyGet(address: string, key: string, vnodeId: string): Promise<KVValue | null> {
    return this.recvBytes(address, '/_dleveldb/get', key, vnodeId);
  }

  async proxyGetAny(address: string, key: string): Promise<KVValue | null> {
    return this.recvBytes(address, '/_dleveldb/get-any', key, '');
  }

  async proxyHeadAny(address: string, key: string): Promise<Omit<KVValue, 'value'> | null> {
    return this.recvHead(address, '/_dleveldb/head-any', key, '');
  }

  async proxyHead(address: string, key: string, vnodeId: string): Promise<Omit<KVValue, 'value'> | null> {
    return this.recvHead(address, '/_dleveldb/head', key, vnodeId);
  }

  private async recvHead(address: string, path: string, key: string, vnodeId: string): Promise<Omit<KVValue, 'value'> | null> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    const query: Record<string, string> = { key };
    if (vnodeId) {
      query.vnode = vnodeId;
    }
    try {
      const res = await fetch(this.url(address, path, query), {
        method: 'GET',
        headers: { connection: 'close' },
        signal: ac.signal,
      });
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        const msg = await readError(res);
        throw new DLevelDBError('PRIMARY_UNAVAILABLE', msg);
      }
      return {
        size: Number(metaHeader(res.headers, 'size') ?? 0),
        crc: Number(metaHeader(res.headers, 'crc') ?? 0),
        mtimeMs: Number(metaHeader(res.headers, 'mtime') ?? 0),
      };
    } catch (err) {
      if (err instanceof DLevelDBError) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new DLevelDBError('TIMEOUT', `head timeout @ ${address}`);
      }
      throw new DLevelDBError('PRIMARY_UNAVAILABLE', `head failed @ ${address}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async proxyScan(address: string, opts: ScanOptions): Promise<ScanResult> {
    return this.json<ScanResult>(address, '/_dleveldb/scan', { method: 'POST', body: opts });
  }

  async proxyScanReplica(address: string, vnodeIds: string[], opts: ScanOptions): Promise<ScanResult> {
    return this.json<ScanResult>(address, '/_dleveldb/scan-replica', {
      method: 'POST',
      body: { ...opts, vnodeIds },
    });
  }

  private async sendBytes(
    address: string,
    path: string,
    key: string,
    value: Buffer,
    extraHeaders?: Record<string, string>,
  ): Promise<void> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.max(this.timeoutMs, 60_000));
    try {
      const res = await fetch(this.url(address, path), {
        method: 'POST',
        headers: {
          connection: 'close',
          'content-type': 'application/octet-stream',
          'x-dleveldb-key': encodeKey(key),
          'x-s3dfs-key': encodeKey(key),
          ...extraHeaders,
        },
        body: new Uint8Array(value),
        signal: ac.signal,
      });
      if (!res.ok) {
        const msg = await readError(res);
        if (res.status === 503) {
          throw new DLevelDBError('QUORUM_FAILED', msg);
        }
        if (res.status === 409) {
          throw new DLevelDBError('NOT_PRIMARY', msg);
        }
        throw new DLevelDBError('PRIMARY_UNAVAILABLE', `put failed ${path} @ ${address}: ${msg}`);
      }
    } catch (err) {
      if (err instanceof DLevelDBError) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new DLevelDBError('TIMEOUT', `put timeout ${path} @ ${address}`);
      }
      throw new DLevelDBError('PRIMARY_UNAVAILABLE', `put failed ${path} @ ${address}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async recvBytes(address: string, path: string, key: string, vnodeId: string): Promise<KVValue | null> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.max(this.timeoutMs, 60_000));
    try {
      const res = await fetch(this.url(address, path, { key, vnode: vnodeId }), {
        method: 'GET',
        headers: { connection: 'close' },
        signal: ac.signal,
      });
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        const msg = await readError(res);
        throw new DLevelDBError('PRIMARY_UNAVAILABLE', msg);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        value: buf,
        size: Number(metaHeader(res.headers, 'size') ?? buf.length),
        crc: Number(metaHeader(res.headers, 'crc') ?? 0),
        mtimeMs: Number(metaHeader(res.headers, 'mtime') ?? 0),
      };
    } catch (err) {
      if (err instanceof DLevelDBError) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new DLevelDBError('TIMEOUT', `get timeout @ ${address}`);
      }
      throw new DLevelDBError('PRIMARY_UNAVAILABLE', `get failed @ ${address}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function decodeKeyHeader(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export type HeaderMap = Record<string, string | string[] | undefined>;

export function getHeader(headers: HeaderMap, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return raw;
}

export function parseJsonBody<T>(body: Buffer | undefined): T {
  if (!body || body.length === 0) {
    return {} as T;
  }
  return JSON.parse(body.toString('utf8')) as T;
}

export function collectScanEntries(results: ScanResult[]): { objects: KVEntry[]; anyTruncated: boolean } {
  const objects: KVEntry[] = [];
  let anyTruncated = false;
  const seen = new Set<string>();
  for (const part of results) {
    if (part.truncated) {
      anyTruncated = true;
    }
    for (const obj of part.objects) {
      if (seen.has(obj.key)) {
        continue;
      }
      seen.add(obj.key);
      objects.push(obj);
    }
  }
  objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { objects, anyTruncated };
}

export function mergeScan(results: ScanResult[], maxKeys: number): ScanResult {
  const { objects, anyTruncated } = collectScanEntries(results);
  const truncated = anyTruncated || objects.length > maxKeys;
  return { objects: objects.slice(0, maxKeys), truncated };
}
