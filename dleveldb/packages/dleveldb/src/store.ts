import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { ClassicLevel } from 'classic-level';

type DirectDb = ClassicLevel<string, Buffer> & {
  putSync(key: string, value: Buffer, options?: { sync?: boolean }): void;
  batchSync(operations: { type: 'put'; key: string; value: Buffer }[], options?: { sync?: boolean }): void;
};

type JoinedPut = {
  key: string;
  value: Buffer;
  mtimeMs: number;
  span: PutSpan | undefined;
  resolve: () => void;
  reject: (err: unknown) => void;
};
import type { KVEntry, KVMeta, KVValue, ScanOptions, ScanResult } from './types.js';

const MAGIC = Buffer.from('DLKV');
const HEADER_SIZE = 4 + 4 + 8 + 4;

export interface LevelStoreStats {
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

/** 包住一次 put 时，记下这次调用里读取和写入各自的墙钟时间。 */
export interface PutSpan {
  getUs: number;
  writeUs: number;
  local: number;
  proxy: number;
}

export const putSpan = new AsyncLocalStorage<PutSpan>();

function sinceUs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1000;
}

export function isLevelDbDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'CURRENT')) || fs.existsSync(path.join(dir, 'LOCK'));
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const code = (err as { code?: string }).code;
  return code === 'LEVEL_NOT_FOUND' || code === 'NOT_FOUND';
}

function encodeRecord(value: Buffer, mtimeMs = Date.now()): Buffer {
  const rec = Buffer.alloc(HEADER_SIZE + value.length);
  MAGIC.copy(rec, 0);
  rec.writeUInt32LE(crc32(value) >>> 0, 4);
  rec.writeBigUInt64LE(BigInt(mtimeMs), 8);
  rec.writeUInt32LE(value.length, 16);
  value.copy(rec, HEADER_SIZE);
  return rec;
}

function decodeRecord(raw: Buffer): KVValue {
  if (raw.length >= HEADER_SIZE && raw.subarray(0, 4).equals(MAGIC)) {
    const crc = raw.readUInt32LE(4);
    const mtimeMs = Number(raw.readBigUInt64LE(8));
    const size = raw.readUInt32LE(16);
    const end = Math.min(raw.length, HEADER_SIZE + size);
    const value = raw.subarray(HEADER_SIZE, end);
    return { value, size: value.length, crc, mtimeMs };
  }
  return { value: raw, size: raw.length, crc: crc32(raw) >>> 0, mtimeMs: 0 };
}

function dirSize(dir: string): number {
  let total = 0;
  if (!fs.existsSync(dir)) {
    return 0;
  }
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // ignore
        }
      }
    }
  }
  return total;
}

export class LevelStore {
  private puts = 0;
  private gets = 0;
  private deletes = 0;
  private flushes = 0;
  private fsyncs = 0;
  private objects = 0;
  private deleted = 0;
  private bytesLogical = 0;
  /** WAL 里有还没同步的写入。空闲的库不刷。 */
  private dirty = false;
  /** 已经排在这条线程上、还没写进 LevelDB 的 put。 */
  private joined: JoinedPut[] = [];
  private joinedTimer: NodeJS.Immediate | null = null;

  private constructor(
    readonly dataDir: string,
    private readonly db: DirectDb,
    private readonly sync: boolean,
  ) {}

  static async open(dataDir: string, opts: { sync?: boolean } = {}): Promise<LevelStore> {
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new ClassicLevel<string, Buffer>(dataDir, {
      keyEncoding: 'utf8',
      valueEncoding: 'buffer',
    });
    await db.open();
    return new LevelStore(dataDir, db as DirectDb, opts.sync ?? false);
  }

  async put(key: string, value: Buffer, mtimeMs = Date.now()): Promise<void> {
    const span = putSpan.getStore();
    const getStarted = process.hrtime.bigint();
    const existing = this.peek(key);
    if (span) {
      span.getUs += sinceUs(getStarted);
    }
    const writeStarted = process.hrtime.bigint();
    this.db.putSync(key, encodeRecord(value, mtimeMs), { sync: this.sync });
    if (span) {
      span.writeUs += sinceUs(writeStarted);
    }
    this.puts += 1;
    if (this.sync) {
      this.fsyncs += 1;
    } else {
      this.dirty = true;
    }
    if (existing) {
      this.bytesLogical += value.length - existing.size;
    } else {
      this.objects += 1;
      this.bytesLogical += value.length;
    }
  }

  /** 返回路径上的索引。不再先读一遍，也不把线程让出去。 */
  putUnchecked(key: string, value: Buffer, mtimeMs: number): void {
    const span = putSpan.getStore();
    const writeStarted = process.hrtime.bigint();
    this.db.putSync(key, encodeRecord(value, mtimeMs), { sync: this.sync });
    if (span) {
      span.writeUs += sinceUs(writeStarted);
    }
    this.puts += 1;
    this.objects += 1;
    this.bytesLogical += value.length;
    if (this.sync) {
      this.fsyncs += 1;
    } else {
      this.dirty = true;
    }
  }

  /**
   * 和已经排在这条线程上的 put 合成一次写入。
   * 不额外等待后来的请求。
   */
  joinPut(key: string, value: Buffer, mtimeMs: number): Promise<void> {
    const span = putSpan.getStore();
    return new Promise((resolve, reject) => {
      this.joined.push({ key, value, mtimeMs, span, resolve, reject });
      if (!this.joinedTimer) {
        // 先回到事件循环，让这一轮里已经完成的请求进入队列，再写一次。
        this.joinedTimer = setImmediate(() => {
          this.joinedTimer = setImmediate(() => {
            this.joinedTimer = null;
            this.flushJoined();
          });
        });
      }
    });
  }

  /** 已有更新的值，或相同时间上更靠后的值时，不覆盖。 */
  putIfNewer(key: string, value: Buffer, mtimeMs: number): void {
    const span = putSpan.getStore();
    const getStarted = process.hrtime.bigint();
    const existing = this.peek(key);
    if (span) {
      span.getUs += sinceUs(getStarted);
    }
    if (existing) {
      if (existing.mtimeMs > mtimeMs) {
        return;
      }
      if (existing.mtimeMs === mtimeMs && Buffer.compare(existing.value, value) >= 0) {
        return;
      }
    }
    const writeStarted = process.hrtime.bigint();
    this.db.putSync(key, encodeRecord(value, mtimeMs), { sync: this.sync });
    if (span) {
      span.writeUs += sinceUs(writeStarted);
    }
    this.puts += 1;
    if (this.sync) {
      this.fsyncs += 1;
    } else {
      this.dirty = true;
    }
    if (existing) {
      this.bytesLogical += value.length - existing.size;
    } else {
      this.objects += 1;
      this.bytesLogical += value.length;
    }
  }

  async get(key: string): Promise<KVValue | null> {
    const found = this.peek(key);
    if (found) {
      this.gets += 1;
    }
    return found;
  }

  async head(key: string): Promise<KVMeta | null> {
    const found = await this.get(key);
    if (!found) {
      return null;
    }
    return { size: found.size, crc: found.crc, mtimeMs: found.mtimeMs };
  }

  async delete(key: string): Promise<boolean> {
    const existing = this.peek(key);
    if (!existing) {
      return false;
    }
    await this.db.del(key, { sync: this.sync });
    this.deletes += 1;
    this.deleted += 1;
    this.objects = Math.max(0, this.objects - 1);
    this.bytesLogical = Math.max(0, this.bytesLogical - existing.size);
    if (this.sync) {
      this.fsyncs += 1;
    } else {
      this.dirty = true;
    }
    return true;
  }

  async list(opts: ScanOptions = {}): Promise<ScanResult> {
    const prefix = opts.prefix ?? '';
    const startAfter = opts.startAfter;
    const maxKeys = Math.max(1, opts.maxKeys ?? 1000);
    const objects: KVEntry[] = [];
    let truncated = false;
    const iterator = this.db.iterator({
      gte: startAfter && startAfter >= prefix ? startAfter : prefix,
      keys: true,
      values: true,
    });
    try {
      for await (const [key, raw] of iterator) {
        if (prefix && !key.startsWith(prefix)) {
          break;
        }
        if (startAfter && key <= startAfter) {
          continue;
        }
        if (objects.length >= maxKeys) {
          truncated = true;
          break;
        }
        if (raw === undefined) {
          continue;
        }
        const rec = decodeRecord(raw);
        objects.push({ key, size: rec.size, crc: rec.crc, mtimeMs: rec.mtimeMs });
      }
    } finally {
      await iterator.close();
    }
    return { objects, truncated };
  }

  async flush(): Promise<void> {
    if (this.sync || !this.dirty) {
      return;
    }
    this.dirty = false;
    this.flushes += 1;
    // LevelDB 没有单独的刷盘接口。写一条同步记录再删掉，把已有的 WAL 落盘。
    const tick = `__dleveldb_flush__:${Date.now()}:${Math.random()}`;
    try {
      this.db.putSync(tick, Buffer.alloc(0), { sync: true });
      await this.db.del(tick, { sync: true });
    } catch (err) {
      this.dirty = true;
      throw err;
    }
    this.fsyncs += 1;
  }

  async compact(): Promise<void> {
    let first: string | undefined;
    let last: string | undefined;
    for await (const key of this.db.keys()) {
      if (first === undefined) {
        first = key;
      }
      last = key;
    }
    if (first !== undefined && last !== undefined) {
      await this.db.compactRange(first, last);
    }
  }

  async close(): Promise<void> {
    if (this.db.status !== 'closed') {
      await this.db.close();
    }
  }

  stats(): LevelStoreStats {
    return {
      objects: this.objects,
      deleted: this.deleted,
      bytesLogical: this.bytesLogical,
      bytesOnDisk: dirSize(this.dataDir),
      blockFiles: 0,
      puts: this.puts,
      gets: this.gets,
      deletes: this.deletes,
      flushes: this.flushes,
      fsyncs: this.fsyncs,
      indexSlots: this.objects,
    };
  }

  private flushJoined(): void {
    const jobs = this.joined.splice(0);
    const pending = new Set(jobs);
    try {
      const staged = new Map<string, { value: Buffer; mtimeMs: number }>();
      const ops: { type: 'put'; key: string; value: Buffer }[] = [];
      const accepted: JoinedPut[] = [];
      for (const job of jobs) {
        const getStarted = process.hrtime.bigint();
        const stagedHit = staged.get(job.key);
        const existing = stagedHit
          ? { value: stagedHit.value, size: stagedHit.value.length, mtimeMs: stagedHit.mtimeMs }
          : this.peek(job.key);
        if (job.span) {
          job.span.getUs += sinceUs(getStarted);
        }
        if (
          existing &&
          (existing.mtimeMs > job.mtimeMs ||
            (existing.mtimeMs === job.mtimeMs && Buffer.compare(existing.value, job.value) >= 0))
        ) {
          pending.delete(job);
          job.resolve();
          continue;
        }
        staged.set(job.key, { value: job.value, mtimeMs: job.mtimeMs });
        ops.push({ type: 'put', key: job.key, value: encodeRecord(job.value, job.mtimeMs) });
        accepted.push(job);
        this.puts += 1;
        if (this.sync) {
          this.fsyncs += 1;
        } else {
          this.dirty = true;
        }
        if (!existing) {
          this.objects += 1;
          this.bytesLogical += job.value.length;
        } else {
          this.bytesLogical += job.value.length - existing.size;
        }
      }
      const writeStarted = process.hrtime.bigint();
      if (ops.length > 0) {
        this.db.batchSync(ops, { sync: this.sync });
      }
      const each = accepted.length === 0 ? 0 : sinceUs(writeStarted) / accepted.length;
      for (const job of accepted) {
        if (job.span) {
          job.span.writeUs += each;
        }
        pending.delete(job);
        job.resolve();
      }
    } catch (err) {
      for (const job of pending) {
        job.reject(err);
      }
    }
  }

  private peek(key: string): KVValue | null {
    try {
      const raw = this.db.getSync(key);
      if (raw === undefined) {
        return null;
      }
      return decodeRecord(raw);
    } catch (err) {
      if (isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }
}
