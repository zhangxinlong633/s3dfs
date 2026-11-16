import { ControlError } from './types.js';

export interface KvEntry {
  key: string;
  size: number;
  crc: number;
  mtimeMs: number;
}

export interface KvValue extends KvEntry {
  value: Buffer;
}

export interface ScanResult {
  objects: KvEntry[];
  truncated: boolean;
}

/**
 * HTTP client for a standalone dleveldb cluster (typically 3–5 nodes).
 * This process is not a ring member; it talks to `/_dleveldb/kv/*`.
 */
export class IndexClient {
  constructor(private readonly urls: string[]) {
    if (urls.length === 0) {
      throw new ControlError('INDEX_UNAVAILABLE', 'S3DFS_INDEX_URLS is empty');
    }
  }

  get endpoints(): string[] {
    return this.urls;
  }

  async put(key: string, value: Buffer): Promise<void> {
    await this.request('POST', '/_dleveldb/kv/put', {
      headers: {
        'content-type': 'application/octet-stream',
        'x-dleveldb-key': encodeURIComponent(key),
      },
      body: value,
    });
  }

  async get(key: string): Promise<KvValue | null> {
    const res = await this.request('GET', `/_dleveldb/kv/get?key=${encodeURIComponent(key)}`, {
      allow404: true,
    });
    if (res.status === 404) {
      return null;
    }
    const value = Buffer.from(await res.arrayBuffer());
    return {
      key,
      value,
      size: Number(res.headers.get('x-dleveldb-size') ?? value.length),
      crc: Number(res.headers.get('x-dleveldb-crc') ?? 0),
      mtimeMs: Number(res.headers.get('x-dleveldb-mtime') ?? 0),
    };
  }

  async head(key: string): Promise<Omit<KvEntry, 'key'> | null> {
    const res = await this.request('GET', `/_dleveldb/kv/head?key=${encodeURIComponent(key)}`, {
      allow404: true,
    });
    if (res.status === 404) {
      return null;
    }
    return {
      size: Number(res.headers.get('x-dleveldb-size') ?? 0),
      crc: Number(res.headers.get('x-dleveldb-crc') ?? 0),
      mtimeMs: Number(res.headers.get('x-dleveldb-mtime') ?? 0),
    };
  }

  async delete(key: string): Promise<boolean> {
    const res = await this.request('POST', '/_dleveldb/kv/delete', {
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ key })),
    });
    const body = (await res.json()) as { deleted?: boolean };
    return Boolean(body.deleted);
  }

  async scan(opts: { prefix?: string; startAfter?: string; maxKeys?: number } = {}): Promise<ScanResult> {
    const res = await this.request('POST', '/_dleveldb/kv/scan', {
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(opts)),
    });
    return (await res.json()) as ScanResult;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.request('GET', '/_dleveldb/cluster', { timeoutMs: 2000 });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async request(
    method: string,
    path: string,
    opts: {
      headers?: Record<string, string>;
      body?: Buffer;
      allow404?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<Response> {
    let last: unknown;
    for (const base of this.urls) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000);
      try {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: opts.headers,
          body: opts.body,
          signal: ac.signal,
        });
        if (res.ok || (opts.allow404 && res.status === 404)) {
          return res;
        }
        last = new ControlError('INDEX_UNAVAILABLE', `index ${base} returned ${res.status} for ${path}`);
      } catch (err) {
        last = err;
      } finally {
        clearTimeout(timer);
      }
    }
    if (last instanceof ControlError) {
      throw last;
    }
    throw new ControlError('INDEX_UNAVAILABLE', `dleveldb index is unreachable: ${String(last)}`);
  }
}
