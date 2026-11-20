import { createHash } from 'node:crypto';
import { blockCompact, blockFlush, blockGet, blockHead, blockPut, blockTombstone } from './block-client.js';
import { compressValue, crc32, decompressValue, parseCompressType, type CompressType } from './compress.js';
import { isVisibleObjectKey, locatorKey } from './keys.js';
import type { IndexClient } from './kv-client.js';
import type { NodeRegistry } from './registry.js';
import type { BlockHealth, ObjectLocator, ObjectValue } from './types.js';
import { ControlError } from './types.js';

/** Majority of the copies selected for this write. S3DFS_WRITE_QUORUM overrides it, clamped to that copy count. */
export function writeQuorum(copies: number): number {
  const majority = Math.floor(Math.max(1, copies) / 2) + 1;
  const raw = process.env.S3DFS_WRITE_QUORUM;
  if (!raw) {
    return Math.min(copies, majority);
  }
  const configured = Number(raw);
  if (!Number.isInteger(configured) || configured < 1) {
    return Math.min(copies, majority);
  }
  return Math.min(copies, configured);
}

export function strictLayoutEnabled(): boolean {
  const raw = process.env.S3DFS_STRICT_LAYOUT;
  if (raw === undefined || raw === '') {
    return true;
  }
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

export interface LayoutReport {
  ok: boolean;
  strict: boolean;
  dataReplicas: number;
  liveBlocks: number;
  failureDomains: number;
  reasons: string[];
}

/** A configured replica count above 1 needs that many live nodes and that many distinct zones. */
export function assessLayout(
  nodes: { zone?: string }[],
  dataReplicas: number,
): LayoutReport {
  const reasons: string[] = [];
  const zones = new Set(nodes.map((node) => node.zone).filter((zone): zone is string => Boolean(zone)));
  if (nodes.length < dataReplicas) {
    reasons.push(`live block nodes ${nodes.length} < configured replicas ${dataReplicas}`);
  }
  if (dataReplicas > 1) {
    if (nodes.some((node) => !node.zone)) {
      reasons.push('block nodes are missing a failure domain');
    }
    if (zones.size < dataReplicas) {
      reasons.push(`failure domains ${zones.size} < configured replicas ${dataReplicas}`);
    }
  }
  return {
    ok: reasons.length === 0,
    strict: strictLayoutEnabled(),
    dataReplicas,
    liveBlocks: nodes.length,
    failureDomains: zones.size,
    reasons,
  };
}

export function serviceHealthy(indexOk: boolean, layout: LayoutReport, lost: number): boolean {
  return indexOk && (!layout.strict || layout.ok) && lost === 0;
}

export interface RepairReport {
  scanned: number;
  alreadyOk: number;
  repaired: number;
  skipped: number;
  failed: number;
  lost: number;
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
  writeQuorum: number;
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

  private lostTotal = 0;

  lostCount(): number {
    return this.lostTotal;
  }

  objectKey(bucket: string, key?: string): string {
    return key ? `${bucket}/${key}` : `${bucket}/`;
  }

  async put(bucket: string, key: string, value: Buffer): Promise<void> {
    const layout = assessLayout(this.registry.live(), this.dataReplicas);
    if (layout.strict && !layout.ok) {
      throw new ControlError('BLOCK_UNAVAILABLE', layout.reasons.join('; '));
    }
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
    if (accepted.length < writeQuorum(targets.length)) {
      throw new ControlError(
        'BLOCK_UNAVAILABLE',
        `wrote ${accepted.length} of ${targets.length} replicas for ${objectKey}`,
      );
    }
    const written: string[] = [];
    try {
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
        const indexKey = locatorKey(objectKey, i);
        await this.kv.put(indexKey, Buffer.from(JSON.stringify(loc)));
        written.push(indexKey);
      }
    } catch (err) {
      await Promise.all(written.map((indexKey) => this.kv.delete(indexKey).catch(() => false)));
      throw err;
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
    const objectKey = this.objectKey(bucket, key);
    const locs = this.prefer(await this.locators(objectKey));
    if (locs.length === 0) {
      return null;
    }
    const totalSize = locs[0]!.size;
    if ((locs[0]!.compressType ?? 'none') !== 'none') {
      const got = await this.get(bucket, key);
      if (!got) {
        return null;
      }
      if (got.value.length === 0 || start >= got.value.length || start > end) {
        return { ...got, value: Buffer.alloc(0), size: 0, totalSize: got.value.length };
      }
      const value = got.value.subarray(start, Math.min(end, got.value.length - 1) + 1);
      return { ...got, value, size: value.length, totalSize: got.value.length };
    }
    let last: unknown;
    for (const loc of locs) {
      try {
        const got = await blockGet(loc.address, objectKey, loc, { start, end });
        if (!got) {
          continue;
        }
        return { value: got.value, size: got.value.length, crc: loc.crc, mtimeMs: loc.mtimeMs, compressType: 'none', totalSize };
      } catch (err) {
        last = err;
      }
    }
    if (last) {
      throw new ControlError('BLOCK_UNAVAILABLE', `ranged read failed for ${bucket}/${key}: ${String(last)}`);
    }
    return null;
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

  layout(): LayoutReport {
    return assessLayout(this.registry.live(), this.dataReplicas);
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
      writeQuorum: writeQuorum(Math.min(this.dataReplicas, Math.max(1, this.registry.live().length))),
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
    const report: RepairReport = { scanned: 0, alreadyOk: 0, repaired: 0, skipped: 0, failed: 0, lost: 0 };
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
    this.lostTotal += report.lost;
    return report;
  }

  private async repairObject(objectKey: string): Promise<'alreadyOk' | 'repaired' | 'skipped' | 'failed' | 'lost'> {
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
    const downLocs = locs.filter((loc) => !live.some((n) => n.nodeId === loc.nodeId));
    if (liveLocs.length === 0) {
      return 'lost';
    }
    if (liveLocs.length >= wanted && downLocs.length === 0) {
      return 'alreadyOk';
    }
    const held = new Set(liveLocs.map((loc) => loc.nodeId));
    const need = Math.max(0, wanted - liveLocs.length);
    const targets = need > 0 ? this.pickAdditional(objectKey, need, held) : [];
    const accepted: ObjectLocator[] = [];
    if (need > 0) {
      if (targets.length === 0) {
        return 'failed';
      }
      const got = await this.get(parts.bucket, parts.key);
      if (!got) {
        return 'failed';
      }
      const packed = compressValue(got.value, this.compressType);
      const digest = got.crc || crc32(got.value);
      for (const node of targets) {
        try {
          const ev = await blockPut(node.address, objectKey, packed.stored, {
            compressType: packed.compressType,
            origSize: got.value.length,
            origCrc: digest,
          });
          accepted.push({
            v: 3,
            replica: 0,
            replicaCount: 0,
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
        } catch {
          // A later target can still satisfy the missing copy.
        }
      }
      if (accepted.length === 0) {
        return 'failed';
      }
    }
    const keep = [...liveLocs, ...accepted];
    for (const loc of locs) {
      await this.kv.delete(locatorKey(objectKey, loc.replica));
    }
    for (let i = 0; i < keep.length; i++) {
      keep[i]!.replica = i;
      keep[i]!.replicaCount = keep.length;
      await this.kv.put(locatorKey(objectKey, i), Buffer.from(JSON.stringify(keep[i])));
    }
    return downLocs.length > 0 || accepted.length > 0 ? 'repaired' : 'alreadyOk';
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
