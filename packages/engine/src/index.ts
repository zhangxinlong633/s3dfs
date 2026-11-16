import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));

function loadAddon(): { Store: new (dataDir: string, options?: NativeOptions) => NativeStore } {
  const candidates = [
    path.join(root, '..', 'build', 'Release', 's3dfs_engine.node'),
    path.join(root, '..', 'build', 'Debug', 's3dfs_engine.node'),
  ];
  let last: unknown;
  for (const file of candidates) {
    try {
      return require(file) as { Store: new (dataDir: string, options?: NativeOptions) => NativeStore };
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error('s3dfs native addon not built; run pnpm --filter @s3dfs/engine build');
}

export interface NativeOptions {
  blockSize?: number;
  bufferSize?: number;
  fsyncOnFlush?: boolean;
}

export interface ObjectMeta {
  size: number;
  crc: number;
  mtimeMs: number;
}

export interface ObjectValue extends ObjectMeta {
  value: Buffer;
}

export interface ListedObject {
  key: string;
  size: number;
  crc: number;
  mtimeMs: number;
}

export interface ListResult {
  objects: ListedObject[];
  truncated: boolean;
}

export interface StoreStats {
  objects: number;
  deleted: number;
  bytesLogical: number;
  bytesOnDisk: number;
  blockFiles: number;
  puts: number;
  gets: number;
  deletes: number;
  flushes: number;
  fsyncs: number;
  indexSlots: number;
}

interface NativeStore {
  put(key: string, value: Buffer): void;
  putBatch(items: { key: string; value: Buffer }[]): void;
  get(key: string): ObjectValue | null;
  head(key: string): ObjectMeta | null;
  delete(key: string): boolean;
  list(opts?: { prefix?: string; startAfter?: string; maxKeys?: number }): ListResult;
  flush(): void;
  compact(): void;
  stats(): StoreStats;
  close(): void;
}

const addon = loadAddon();

export interface OpenOptions extends NativeOptions {
  dataDir: string;
}

export class Store {
  private inner: NativeStore;

  private constructor(inner: NativeStore) {
    this.inner = inner;
  }

  static open(options: OpenOptions): Store {
    const { dataDir, ...rest } = options;
    return new Store(new addon.Store(dataDir, rest));
  }

  put(key: string, value: Buffer): void {
    this.inner.put(key, value);
  }

  putBatch(items: { key: string; value: Buffer }[]): void {
    this.inner.putBatch(items);
  }

  get(key: string): ObjectValue | null {
    return this.inner.get(key);
  }

  head(key: string): ObjectMeta | null {
    return this.inner.head(key);
  }

  delete(key: string): boolean {
    return this.inner.delete(key);
  }

  list(opts?: { prefix?: string; startAfter?: string; maxKeys?: number }): ListResult {
    return this.inner.list(opts);
  }

  flush(): void {
    this.inner.flush();
  }

  compact(): void {
    this.inner.compact();
  }

  stats(): StoreStats {
    return this.inner.stats();
  }

  close(): void {
    this.inner.close();
  }
}
