import { createHash } from 'node:crypto';
import { blockCompact, blockFlush, blockGet, blockHead, blockPut, blockTombstone } from './block-client.js';
import { compressValue, crc32, decompressValue, parseCompressType, type CompressType } from './compress.js';
import { isVisibleObjectKey, locatorKey } from './keys.js';
import type { IndexClient } from './kv-client.js';
import type { NodeRegistry } from './registry.js';
import type { BlockHealth, ObjectLocator, ObjectValue } from './types.js';
import { ControlError } from './types.js';

export interface RepairReport {
  scanned: number;
  alreadyOk: number;
  repaired: number;
  skipped: number;
  failed: number;
}

export interface ClusterStats {
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
  dataReplicas: number;
  effectiveDataReplicas: number;
  indexUrls: string[];
  indexOk: boolean;
  blockNodes: BlockHealth[];
  compressType: CompressType;
}

export class ObjectCluster {
  constructor(
    private readonly kv: IndexClient,
    private readonly registry: NodeRegistry,
    private readonly dataReplicas: number,
    private readonly compressType: CompressType = parseCompressType(process.env.S3DFS_COMPRESS),
  ) {}

  objectKey(bucket: string, key?: string): string {
    return key ? `${bucket}/${key}` : `${bucket}/`;
  }

  async put(bucket: string, key: string, value: Buffer): Promise<void> {
    const objectKey = this.objectKey(bucket, key);
    const packed = compressValue(value, this.compressType);
    const digest = crc32(value);
    const targets = this.registry.pick(objectKey, this.dataReplicas);
    const meta = { compressType: packed.compressType, origSize: value.length, origCrc: digest };
    const writes = await Promise.allSettled(targets.map((n) => blockPut(n.address, objectKey, packed.stored, meta)));
    const accepted: { nodeId: string; address: string; recId: number; chained: boolean; generation: number; extentCount: number; storedSize: number; mtimeMs: number }[] = [];
    for (let i = 0; i < writes.length; i++) {
      const result = writes[i]!;
      const node = targets[i]!;
      if (result.status === 'fulfilled') {
        const ev = result.value;
        accepted.push({
          nodeId: node.nodeId,
          address: node.address,
          recId: ev.recId,
          chained: ev.chained,
          generation: ev.generation,
          extentCount: ev.extentCount,
          storedSize: ev.size,
          mtimeMs: ev.mtimeMs,
        });
      }
    }
    if (accepted.length === 0) {
      throw new ControlError('BLOCK_UNAVAILABLE', `failed to write ${objectKey} to any block node`);
    }
    for (let i = 0; i < accepted.length; i++) {
      const ev = accepted[i]!;
      const loc: ObjectLocator = {
        v: 3,
        replica: i,
        replicaCount: accepted.length,
        nodeId: ev.nodeId,
        address: ev.address,
        recId: ev.recId,
        chained: ev.chained,
        generation: ev.generation,
        extentCount: ev.extentCount,
        size: value.length,
        storedSize: ev.storedSize,
        compressType: packed.compressType,
        crc: digest,
        mtimeMs: ev.mtimeMs,
      };
      await this.kv.put(locatorKey(objectKey, i), Buffer.from(JSON.stringify(loc)));
    }
  }

  async locators(objectKey: string): Promise<ObjectLocator[]> {
    const primaryRaw = await this.kv.get(objectKey);
    if (!primaryRaw) {
      return [];
    }
    const primary = JSON.parse(primaryRaw.value.toString('utf8')) as ObjectLocator;
    const count = Math.max(1, primary.replicaCount ?? 1);
    const out: ObjectLocator[] = [primary];
    for (let i = 1; i < count; i++) {
      const raw = await this.kv.get(locatorKey(objectKey, i));
      if (!raw) {
        continue;
      }
      out.push(JSON.parse(raw.value.toString('utf8')) as ObjectLocator);
    }
    return out;
  }

  private prefer(locs: ObjectLocator[]): ObjectLocator[] {
    return [...locs].sort((a, b) => {
      const ad = this.registry.isDown(a.nodeId) ? 1 : 0;
      const bd = this.registry.isDown(b.nodeId) ? 1 : 0;
      return ad - bd || a.replica - b.replica;
    });
  }

  async get(bucket: string, key: string): Promise<ObjectValue | null> {
    const objectKey = this.objectKey(bucket, key);
    const locs = this.prefer(await this.locators(objectKey));
    let last: unknown;
    for (const loc of locs) {
      try {
        const got = await blockGet(loc.address, objectKey, loc);
        if (!got) {
          continue;
        }
        const value = decompressValue(got.value, loc.compressType ?? 'none');
        if (loc.size && value.length !== loc.size) {
          last = new Error(`decompressed size ${value.length} != ${loc.size}`);
          continue;
        }
        if (loc.crc && crc32(value) !== loc.crc) {
          last = new Error(`crc mismatch for ${objectKey}`);
          continue;
        }
        return { value, size: value.length, crc: loc.crc, mtimeMs: loc.mtimeMs, compressType: loc.compressType };
      } catch (err) {
        last = err;
      }
    }
    if (locs.length > 0 && last) {
      throw new ControlError('BLOCK_UNAVAILABLE', `all data replicas failed for ${bucket}/${key}: ${String(last)}`);
    }
    return null;
  }

  async getRange(
    bucket: string,
    key: string,
    start: number,
    end: number,
  ): Promise<(ObjectValue & { totalSize: number }) | null> {
    const got = await this.get(bucket, key);
    if (!got) {
      return null;
    }
    const totalSize = got.value.length;
    if (totalSize === 0 || start >= totalSize || start > end) {
      return { ...got, value: Buffer.alloc(0), size: 0, totalSize };
    }
    const from = Math.max(0, start);
    const to = Math.min(end, totalSize - 1);
    const value = got.value.subarray(from, to + 1);
    return { ...got, value, size: value.length, totalSize };
  }

  async head(bucket: string, key: string): Promise<Omit<ObjectValue, 'value'> | null> {
    const locs = this.prefer(await this.locators(this.objectKey(bucket, key)));
    if (!locs[0]) {
      return null;
    }
    const loc = locs[0];
    return { size: loc.size, crc: loc.crc, mtimeMs: loc.mtimeMs, compressType: loc.compressType };
  }

  async delete(bucket: string, key: string): Promise<boolean> {
    const objectKey = this.objectKey(bucket, key);
    const locs = await this.locators(objectKey);
    if (locs.length === 0) {
      return false;
    }
    await Promise.allSettled(locs.map((loc) => blockTombstone(loc.address, objectKey)));
    for (const loc of locs) {
      await this.kv.delete(locatorKey(objectKey, loc.replica));
    }
    return true;
  }

  async deleteBucket(bucket: string): Promise<'ok' | 'missing' | 'notempty'> {
    if (!(await this.bucketExists(bucket))) {
      return 'missing';
    }
    const listed = await this.list(bucket, '', undefined, 1);
    if (listed.objects.length > 0 || listed.prefixes.length > 0 || listed.truncated) {
      return 'notempty';
    }
    await this.kv.delete(this.objectKey(bucket));
    return 'ok';
  }

  async createBucket(bucket: string): Promise<void> {
    const marker = this.objectKey(bucket);
    if (!(await this.kv.head(marker))) {
      await this.kv.put(marker, Buffer.from(JSON.stringify({ v: 1, kind: 'bucket', mtimeMs: Date.now() })));
    }
  }

  async bucketExists(bucket: string): Promise<boolean> {
    if (await this.kv.head(this.objectKey(bucket))) {
      return true;
    }
    const listed = await this.kv.scan({ prefix: `${bucket}/`, maxKeys: 8 });
    return listed.objects.some((o) => isVisibleObjectKey(o.key));
  }

  async listBuckets(): Promise<{ name: string; mtimeMs: number }[]> {
    const listed = await this.kv.scan({ prefix: '', maxKeys: 10_000 });
    const map = new Map<string, number>();
    for (const obj of listed.objects) {
      if (!isVisibleObjectKey(obj.key)) {
        continue;
      }
      const slash = obj.key.indexOf('/');
      if (slash <= 0) {
        continue;
      }
      const name = obj.key.slice(0, slash);
      const prev = map.get(name);
      if (prev === undefined || obj.mtimeMs < prev) {
        map.set(name, obj.mtimeMs);
      }
    }
    return [...map.entries()].map(([name, mtimeMs]) => ({ name, mtimeMs }));
  }

  async list(bucket: string, prefix = '', startAfter?: string, maxKeys = 1000, delimiter = '') {
    const cap = Math.max(1, Math.min(maxKeys || 1000, 10_000));
    const fullPrefix = prefix ? `${bucket}/${prefix}` : `${bucket}/`;
    const bucketPrefix = `${bucket}/`;
    const objects: { key: string; size: number; crc: number; mtimeMs: number }[] = [];
    const prefixes: string[] = [];
    const seenPrefixes = new Set<string>();
    let scanAfter = startAfter ? `${bucket}/${startAfter}` : undefined;
    let truncated = false;
    let lastName: string | undefined;

    const emitted = () => objects.length + prefixes.length;
    const relativeKey = (full: string) => full.slice(bucketPrefix.length);
    const visible = (full: string) => isVisibleObjectKey(full) && full !== `${bucket}/`;

    while (emitted() < cap) {
      const result = await this.kv.scan({
        prefix: fullPrefix,
        startAfter: scanAfter,
        maxKeys: Math.max(cap * 3, 64),
      });
      if (result.objects.length === 0) {
        break;
      }

      let stoppedEarly = false;
      for (const obj of result.objects) {
        scanAfter = obj.key;
        if (!visible(obj.key)) {
          continue;
        }
        const key = relativeKey(obj.key);
        if (startAfter && key <= startAfter) {
          continue;
        }

        if (delimiter) {
          const rest = key.startsWith(prefix) ? key.slice(prefix.length) : key;
          const cut = rest.indexOf(delimiter);
          if (cut >= 0) {
            const common = prefix + rest.slice(0, cut + delimiter.length);
            if (startAfter && common <= startAfter) {
              continue;
            }
            if (seenPrefixes.has(common)) {
              continue;
            }
            seenPrefixes.add(common);
            prefixes.push(common);
            lastName = common;
            if (emitted() >= cap) {
              stoppedEarly = true;
              break;
            }
            continue;
          }
        }

        objects.push({
          ...obj,
          key,
        });
        lastName = key;
        if (emitted() >= cap) {
          stoppedEarly = true;
          break;
        }
      }

      if (emitted() >= cap && (stoppedEarly || result.truncated)) {
        truncated = true;
        break;
      }
      if (!result.truncated) {
        break;
      }
    }

    return {
      truncated,
      objects,
      prefixes,
      nextToken: truncated ? lastName : undefined,
    };
  }

  async flush(): Promise<void> {
    await Promise.all(this.registry.live().map((n) => blockFlush(n.address)));
  }

  async compact(): Promise<void> {
    await Promise.all(this.registry.live().map((n) => blockCompact(n.address)));
  }

  async stats(): Promise<ClusterStats> {
    const indexOk = await this.kv.ping();
    const blockNodes = await this.registry.checkAll();
    const acc: ClusterStats = {
      objects: 0,
      deleted: 0,
      bytesLogical: 0,
      bytesOnDisk: 0,
      blockFiles: 0,
      puts: 0,
      gets: 0,
      deletes: 0,
      flushes: 0,
      fsyncs: 0,
      dataReplicas: this.dataReplicas,
      effectiveDataReplicas: Math.min(this.dataReplicas, Math.max(1, this.registry.live().length)),
      indexUrls: this.kv.endpoints,
      indexOk,
      blockNodes,
      compressType: this.compressType,
    };
    try {
      const listed = await this.kv.scan({ prefix: '', maxKeys: 100_000 });
      acc.objects = listed.objects.filter((o) => isVisibleObjectKey(o.key) && !o.key.endsWith('/')).length;
    } catch {
      acc.objects = 0;
    }
    for (const node of blockNodes) {
      const s = node.stats;
      if (!s) {
        continue;
      }
      acc.deleted += s.deleted;
      acc.bytesLogical += s.bytesLogical;
      acc.bytesOnDisk += s.bytesOnDisk;
      acc.blockFiles += s.blockFiles;
      acc.puts += s.puts;
      acc.gets += s.gets;
      acc.deletes += s.deletes;
      acc.flushes += s.flushes;
      acc.fsyncs += s.fsyncs;
    }
    return acc;
  }

  /**
   * Top up objects that have fewer live data copies than
   * min(configured replicas, live block nodes). Adds copies only; does not
   * drop locators for down nodes, and cannot rebuild an object with no live source.
   */
  async repair(opts: { maxObjects?: number } = {}): Promise<RepairReport> {
    await this.registry.checkAll();
    const report: RepairReport = { scanned: 0, alreadyOk: 0, repaired: 0, skipped: 0, failed: 0 };
    const maxObjects = Math.max(1, opts.maxObjects ?? Number.MAX_SAFE_INTEGER);
    let startAfter: string | undefined;
    while (report.scanned < maxObjects) {
      const listed = await this.kv.scan({
        prefix: '',
        startAfter,
        maxKeys: Math.min(1000, maxObjects - report.scanned),
      });
      if (listed.objects.length === 0) {
        break;
      }
      for (const obj of listed.objects) {
        startAfter = obj.key;
        if (!isVisibleObjectKey(obj.key)) {
          continue;
        }
        report.scanned++;
        const result = await this.repairObject(obj.key);
        report[result]++;
        if (report.scanned >= maxObjects) {
          break;
        }
      }
      if (!listed.truncated || report.scanned >= maxObjects) {
        break;
      }
    }
    return report;
  }

  private async repairObject(objectKey: string): Promise<'alreadyOk' | 'repaired' | 'skipped' | 'failed'> {
    const parts = splitObjectKey(objectKey);
    if (!parts) {
      return 'skipped';
    }
    const locs = await this.locators(objectKey);
    if (locs.length === 0 || locs[0]?.v !== 3) {
      return 'skipped';
    }
    const live = this.registry.live();
    const wanted = Math.min(this.dataReplicas, live.length);
    const liveLocs = locs.filter((loc) => live.some((n) => n.nodeId === loc.nodeId));
    if (wanted <= 0 || liveLocs.length >= wanted) {
      return liveLocs.length >= wanted && wanted > 0 ? 'alreadyOk' : 'failed';
    }
    if (liveLocs.length === 0) {
      return 'failed';
    }
    const held = new Set(locs.map((loc) => loc.nodeId));
    const targets = this.pickAdditional(objectKey, wanted - liveLocs.length, held);
    if (targets.length === 0) {
      return 'failed';
    }
    const got = await this.get(parts.bucket, parts.key);
    if (!got) {
      return 'failed';
    }
    const packed = compressValue(got.value, this.compressType);
    const digest = got.crc || crc32(got.value);
    const accepted: ObjectLocator[] = [];
    let nextReplica = Math.max(-1, ...locs.map((loc) => loc.replica)) + 1;
    for (const node of targets) {
      try {
        const ev = await blockPut(node.address, objectKey, packed.stored, {
          compressType: packed.compressType,
          origSize: got.value.length,
          origCrc: digest,
        });
        accepted.push({
          v: 3,
          replica: nextReplica,
          replicaCount: locs.length + accepted.length + 1,
          nodeId: node.nodeId,
          address: node.address,
          recId: ev.recId,
          chained: ev.chained,
          generation: ev.generation,
          extentCount: ev.extentCount,
          size: got.value.length,
          storedSize: ev.size,
          compressType: packed.compressType,
          crc: digest,
          mtimeMs: ev.mtimeMs,
        });
        nextReplica++;
      } catch {
        // Try the remaining targets; a partial top-up is still progress.
      }
    }
    if (accepted.length === 0) {
      return 'failed';
    }
    const all = [...locs, ...accepted];
    for (let i = 0; i < all.length; i++) {
      all[i]!.replicaCount = all.length;
      await this.kv.put(locatorKey(objectKey, all[i]!.replica), Buffer.from(JSON.stringify(all[i])));
    }
    return 'repaired';
  }

  private pickAdditional(objectKey: string, need: number, held: Set<string>) {
    const live = this.registry.live().filter((n) => !held.has(n.nodeId));
    if (live.length === 0 || need <= 0) {
      return [];
    }
    const want = Math.min(need, live.length);
    const start = live.length === 1 ? 0 : createHash('sha1').update(objectKey).digest().readUInt32BE(0) % live.length;
    const out: typeof live = [];
    for (let i = 0; i < live.length && out.length < want; i++) {
      out.push(live[(start + i) % live.length]!);
    }
    return out;
  }
}

function splitObjectKey(objectKey: string): { bucket: string; key: string } | null {
  const slash = objectKey.indexOf('/');
  if (slash <= 0) {
    return null;
  }
  return { bucket: objectKey.slice(0, slash), key: objectKey.slice(slash + 1) };
}
