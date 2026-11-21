import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const rootDir = path.dirname(fileURLToPath(import.meta.url));

function loadAddon(): { Store: new (dataDir: string, options?: NativeOptions) => NativeStore } {
  const candidates = [
    path.join(rootDir, '..', 'build', 'Release', 's3dfs_engine.node'),
    path.join(rootDir, '..', 'build', 'Debug', 's3dfs_engine.node'),
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

export type CompressType = 'none' | 'zstd' | 'gzip';

export interface PutMeta {
  compressType?: CompressType;
  origSize?: number;
  origCrc?: number;
}

export interface ExtentLocator {
  chained: boolean;
  tombstone?: boolean;
  crc: number;
  mtimeMs: number;
  size: number;
  generation: number;
  extentCount: number;
  recId: number;
  compressType?: CompressType;
  origSize?: number;
  origCrc?: number;
}

export interface ScanEntry {
  key: string;
  locator: ExtentLocator;
}

export interface ObjectMeta {
  size: number;
  crc: number;
  mtimeMs: number;
}

export interface ObjectValue extends ObjectMeta {
  value: Buffer;
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
  deadBytes: number;
  tickets: number;
  unflushedBytes: number;
}

interface NativeStore {
  put(key: string, value: Buffer, meta?: PutMeta): ExtentLocator;
  putBatch(items: { key: string; value: Buffer }[]): ExtentLocator[];
  get(key: string, locator: ExtentLocator): ObjectValue | null;
  getSpan(key: string, locator: ExtentLocator, start: number, len: number): Buffer;
  putChunks(key: string, chunks: Buffer[]): ExtentLocator;
  writeBegin(key: string): number;
  write(id: number, chunk: Buffer): void;
  writeFinish(id: number, meta?: PutMeta): ExtentLocator;
  writeAbort(id: number): void;
  head(key: string, locator: ExtentLocator): ObjectMeta | null;
  tombstone(key: string): void;
  scan(): ScanEntry[];
  flush(): void;
  compact(): StoreStats;
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

  put(key: string, value: Buffer, meta?: PutMeta): ExtentLocator {
    return this.inner.put(key, value, meta);
  }

  putBatch(items: { key: string; value: Buffer }[]): ExtentLocator[] {
    return this.inner.putBatch(items);
  }

  get(key: string, locator: ExtentLocator): ObjectValue | null {
    return this.inner.get(key, locator);
  }

  getSpan(key: string, locator: ExtentLocator, start: number, len: number): Buffer {
    return this.inner.getSpan(key, locator, start, len);
  }

  putChunks(key: string, chunks: Buffer[]): ExtentLocator {
    return this.inner.putChunks(key, chunks);
  }

  writeBegin(key: string): number {
    return this.inner.writeBegin(key);
  }

  write(id: number, chunk: Buffer): void {
    this.inner.write(id, chunk);
  }

  writeFinish(id: number, meta?: PutMeta): ExtentLocator {
    return this.inner.writeFinish(id, meta);
  }

  writeAbort(id: number): void {
    this.inner.writeAbort(id);
  }

  head(key: string, locator: ExtentLocator): ObjectMeta | null {
    return this.inner.head(key, locator);
  }

  tombstone(key: string): void {
    this.inner.tombstone(key);
  }

  scan(): ScanEntry[] {
    return this.inner.scan();
  }

  flush(): void {
    this.inner.flush();
  }

  compact(): StoreStats {
    return this.inner.compact();
  }

  stats(): StoreStats {
    return this.inner.stats();
  }

  close(): void {
    this.inner.close();
  }
}
