import { createHash } from 'node:crypto';
import { blockCompact, blockFlush, blockGet, blockHead, blockPut, blockScan, blockTombstone, blockWriteBegin } from './block-client.js';
import { relayChunks } from './stream.js';
import { compressValue, crc32, decompressValue, parseCompressType, type CompressType } from './compress.js';
import { BACK_PREFIX, CHANGE_PREFIX, GC_PREFIX, LOST_PREFIX, MAINT_PREFIX, MAINTENANCE_MS, isVisibleObjectKey, locatorKey, lostKey, maintKey, usageKey } from './keys.js';
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

/** A full set must match the configured replica count and zones. One zone down still writes when the rest meet quorum. */
export function assessLayout(
  nodes: { zone?: string; status?: string }[],
  dataReplicas: number,
): LayoutReport {
  const reasons: string[] = [];
  const quorum = writeQuorum(dataReplicas);
  const present = nodes.filter((node) => node.status !== 'down');
  const degraded = nodes.some((node) => node.status === 'down');
  const zones = new Set(present.map((node) => node.zone).filter((zone): zone is string => Boolean(zone)));
  const needNodes = degraded ? quorum : dataReplicas;
  const needZones = degraded ? quorum : dataReplicas;
  if (present.length < needNodes) {
    reasons.push(`live block nodes ${present.length} < configured replicas ${dataReplicas}`);
  }
  if (dataReplicas > 1) {
    if (present.some((node) => !node.zone)) {
      reasons.push('block nodes are missing a failure domain');
    }
    if (zones.size < needZones) {
      reasons.push(`failure domains ${zones.size} < configured replicas ${dataReplicas}`);
    }
  }
  return {
    ok: reasons.length === 0,
    strict: strictLayoutEnabled(),
    dataReplicas,
    liveBlocks: present.length,
    failureDomains: zones.size,
    reasons,
  };
}

const LIMITS_TTL_MS = 1000;

type BucketLimits = { quotaBytes?: number; compress?: boolean; shared?: boolean };

/** Logical bytes covered by one segment checksum. */
export const SEGMENT_BYTES = 64 * 1024;

export function segmentCrcs(value: Buffer, segmentBytes = SEGMENT_BYTES): number[] {
  const out: number[] = [];
  for (let start = 0; start < value.length; start += segmentBytes) {
    out.push(crc32(value.subarray(start, Math.min(value.length, start + segmentBytes))));
  }
  return out.length > 0 ? out : [crc32(value)];
}

/** Writable bytes in a zone are the smaller disk. A second, larger disk does not raise that number. */
export function tightestDisks(
  nodes: { zone?: string; status?: string; freeBytes?: number }[],
): { zone: string; writableBytes: number; uneven: boolean }[] {
  const byZone = new Map<string, number[]>();
  for (const node of nodes) {
    if (node.status === 'down' || !node.zone || typeof node.freeBytes !== 'number') {
      continue;
    }
    const sizes = byZone.get(node.zone) ?? [];
    sizes.push(node.freeBytes);
    byZone.set(node.zone, sizes);
  }
  return [...byZone.entries()].map(([zone, sizes]) => {
    const writableBytes = Math.min(...sizes);
    const biggest = Math.max(...sizes);
    return { zone, writableBytes, uneven: biggest > 0 && writableBytes * 2 <= biggest };
  });
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
  /** Nodes that announced they are back. kept records still match the index; removed records did not. */
  returned: { nodeId: string; kept: number; removed: number }[];
}

export interface MaintenanceLeave {
  nodeId: string;
  reason: string;
  leftAtMs: number;
  untilMs: number;
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

function parseLocator(value: Buffer): ObjectLocator | null {
  try {
    const parsed = JSON.parse(value.toString('utf8')) as ObjectLocator;
    if (parsed.v !== 3 || typeof parsed.recId !== 'number' || typeof parsed.address !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export class ObjectCluster {
  constructor(
    private readonly kv: IndexClient,
    private readonly registry: NodeRegistry,
    private readonly dataReplicas: number,
    private readonly compressType: CompressType = parseCompressType(process.env.S3DFS_COMPRESS),
  ) {}

  private lostTotal = 0;
  private changeSeq = 0;
  private replOpened = false;
  private replSent = 0;
  private readonly limitsCache = new Map<string, { at: number; limits: BucketLimits }>();
  private readonly usageMem = new Map<string, number>();

  lostCount(): number {
    return this.lostTotal;
  }

  /** Count lost keys in the index. A new process starts at 0 until this runs. */
  async syncLost(): Promise<number> {
    let count = 0;
    let startAfter: string | undefined;
    for (;;) {
      const listed = await this.kv.scan({ prefix: LOST_PREFIX, startAfter, maxKeys: 1000 });
      count += listed.objects.length;
      if (!listed.truncated || listed.objects.length === 0) {
        break;
      }
      startAfter = listed.objects[listed.objects.length - 1]!.key;
    }
    this.lostTotal = count;
    return count;
  }

  zoneDisks(): { zone: string; writableBytes: number; uneven: boolean }[] {
    return tightestDisks(this.registry.list());
  }

  async listChanges(): Promise<{ op: string; bucket: string; key: string; mtimeMs: number }[]> {
    const records = await this.listChangeRecords();
    return records.map(({ op, bucket, key, mtimeMs }) => ({ op, bucket, key, mtimeMs }));
  }

  private async listChangeRecords(): Promise<{ id: string; op: string; bucket: string; key: string; mtimeMs: number }[]> {
    const out: { id: string; op: string; bucket: string; key: string; mtimeMs: number }[] = [];
    let startAfter: string | undefined;
    for (;;) {
      const listed = await this.kv.scan({ prefix: CHANGE_PREFIX, startAfter, maxKeys: 1000 });
      for (const obj of listed.objects) {
        const raw = await this.kv.get(obj.key);
        if (!raw) {
          continue;
        }
        try {
          const parsed = JSON.parse(raw.value.toString('utf8')) as { op: string; bucket: string; key: string; mtimeMs: number };
          out.push({ id: obj.key, op: parsed.op, bucket: parsed.bucket, key: parsed.key, mtimeMs: parsed.mtimeMs });
        } catch {
          // Skip a torn journal record.
        }
      }
      if (!listed.truncated || listed.objects.length === 0) {
        break;
      }
      startAfter = listed.objects[listed.objects.length - 1]!.key;
    }
    return out;
  }

  async setBucketLimits(bucket: string, limits: { quotaBytes?: number; compress?: boolean }): Promise<void> {
    await this.createBucket(bucket);
    const markerKey = this.objectKey(bucket);
    const raw = await this.kv.get(markerKey);
    const prev = raw ? (JSON.parse(raw.value.toString('utf8')) as Record<string, unknown>) : { v: 1, kind: 'bucket', mtimeMs: Date.now() };
    const next = { ...prev, ...limits };
    await this.kv.put(markerKey, Buffer.from(JSON.stringify(next)));
    const parsed: BucketLimits = {
      quotaBytes: typeof next.quotaBytes === 'number' ? next.quotaBytes : undefined,
      compress: typeof next.compress === 'boolean' ? next.compress : undefined,
      shared: prev.shared === true ? true : undefined,
    };
    this.limitsCache.set(bucket, { at: Date.now(), limits: parsed });
    if (typeof parsed.quotaBytes === 'number' && !this.usageMem.has(bucket)) {
      const rawUsage = await this.kv.get(usageKey(bucket));
      const used = rawUsage ? Number(rawUsage.value.toString('utf8')) : await this.sumVisibleBytes(bucket);
      const total = Number.isFinite(used) ? used : 0;
      this.usageMem.set(bucket, total);
      if (!rawUsage) {
        await this.kv.put(usageKey(bucket), Buffer.from(String(total)));
      }
    }
  }

  objectKey(bucket: string, key?: string): string {
    return key ? `${bucket}/${key}` : `${bucket}/`;
  }

  async put(bucket: string, key: string, value: Buffer): Promise<void> {
    const layout = assessLayout(this.registry.list(), this.dataReplicas);
    if (layout.strict && !layout.ok) {
      throw new ControlError('BLOCK_UNAVAILABLE', layout.reasons.join('; '));
    }
    const objectKey = this.objectKey(bucket, key);
    const limits = await this.limitsFor(bucket);
    let previous: ObjectLocator[] | undefined;
    if (typeof limits.quotaBytes === 'number' || limits.shared) {
      previous = await this.locators(objectKey);
      if (typeof limits.quotaBytes === 'number') {
        await this.assertQuota(bucket, value.length - (previous[0]?.size ?? 0), limits);
      }
    }
    const blockKey = previous && (await this.heldByOthers(previous)) ? this.freshDataKey() : objectKey;
    const packed = compressValue(value, limits.compress === false ? 'none' : this.compressType);
    const digest = crc32(value);
    const targets = this.registry.pick(objectKey, this.dataReplicas);
    const meta = { compressType: packed.compressType, origSize: value.length, origCrc: digest };
    const writes = await Promise.allSettled(targets.map((n) => blockPut(n.address, blockKey, packed.stored, meta)));
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
    const segments = segmentCrcs(value);
    const changeP = this.noteChange('put', bucket, key);
    const locatorKeys = accepted.map((_, i) => locatorKey(objectKey, i));
    const indexed = await Promise.allSettled(
      accepted.map(async (ev, i) => {
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
          segments,
          segmentBytes: SEGMENT_BYTES,
          ...(blockKey === objectKey ? {} : { dataKey: blockKey }),
        };
        await this.kv.put(locatorKeys[i]!, Buffer.from(JSON.stringify(loc)));
      }),
    );
    const failed = indexed.find((item) => item.status === 'rejected');
    if (failed && failed.status === 'rejected') {
      const changeKey = await changeP.catch(() => undefined);
      await Promise.all([
        ...locatorKeys.map((indexKey) => this.kv.delete(indexKey).catch(() => false)),
        changeKey ? this.kv.delete(changeKey).catch(() => false) : Promise.resolve(false),
      ]);
      throw failed.reason;
    }
    try {
      await changeP;
    } catch (err) {
      await Promise.all(locatorKeys.map((indexKey) => this.kv.delete(indexKey).catch(() => false)));
      throw err;
    }
    if (previous && blockKey !== objectKey) {
      await Promise.all(previous.map((loc) => this.releaseLocator(loc, objectKey)));
    }
    await this.addUsage(bucket, value.length - (previous?.[0]?.size ?? 0), limits);
  }

  /**
   * Stream an object in chunks. Copies land uncompressed so the API can drop each chunk.
   * `extraKey` receives the same bytes, used for a version that must outlive the next overwrite.
   */
  async putStream(bucket: string, key: string, chunks: AsyncIterable<Buffer>, extraKey?: string): Promise<{ size: number; crc: number }> {
    const layout = assessLayout(this.registry.list(), this.dataReplicas);
    if (layout.strict && !layout.ok) {
      throw new ControlError('BLOCK_UNAVAILABLE', layout.reasons.join('; '));
    }
    const keys = [key, ...(extraKey ? [extraKey] : [])];
    const opened: { objectKey: string; nodeId: string; address: string; writer: Awaited<ReturnType<typeof blockWriteBegin>> }[] = [];
    for (const one of keys) {
      const objectKey = this.objectKey(bucket, one);
      const targets = this.registry.pick(objectKey, this.dataReplicas);
      for (const node of targets) {
        opened.push({ objectKey, nodeId: node.nodeId, address: node.address, writer: await blockWriteBegin(node.address, objectKey) });
      }
    }
    const relayed = await relayChunks(chunks, opened.map((item) => item.writer));
    const byKey = new Map<string, { nodeId: string; address: string; loc: import('./types.js').ExtentLocator }[]>();
    opened.forEach((item, index) => {
      const loc = relayed.locs[index];
      if (!loc) {
        return;
      }
      const list = byKey.get(item.objectKey) ?? [];
      list.push({ nodeId: item.nodeId, address: item.address, loc });
      byKey.set(item.objectKey, list);
    });
    for (const one of keys) {
      const objectKey = this.objectKey(bucket, one);
      const accepted = byKey.get(objectKey) ?? [];
      const targets = this.registry.pick(objectKey, this.dataReplicas);
      if (accepted.length < writeQuorum(targets.length)) {
        throw new ControlError('BLOCK_UNAVAILABLE', `wrote ${accepted.length} of ${targets.length} replicas for ${objectKey}`);
      }
      await this.commitLocators(objectKey, accepted, relayed.size, relayed.crc);
    }
    return { size: relayed.size, crc: relayed.crc };
  }

  private async commitLocators(
    objectKey: string,
    accepted: { nodeId: string; address: string; loc: import('./types.js').ExtentLocator }[],
    size: number,
    crc: number,
  ): Promise<void> {
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
          recId: ev.loc.recId,
          chained: ev.loc.chained,
          generation: ev.loc.generation,
          extentCount: ev.loc.extentCount,
          size,
          storedSize: ev.loc.size,
          compressType: 'none',
          crc,
          mtimeMs: ev.loc.mtimeMs,
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
    const primary = parseLocator(primaryRaw.value);
    const count = Math.max(primary?.replicaCount ?? 3, 1);
    const out: ObjectLocator[] = [];
    if (primary) {
      out.push(primary);
    }
    for (let i = 1; i < count; i++) {
      const raw = await this.kv.get(locatorKey(objectKey, i));
      if (!raw) {
        continue;
      }
      const parsed = parseLocator(raw.value);
      if (parsed) {
        out.push(parsed);
      }
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
        const got = await blockGet(loc.address, loc.dataKey ?? objectKey, loc);
        if (!got) {
          continue;
        }
        const value = decompressValue(got.value, loc.compressType ?? 'none');
        if (loc.size && value.length !== loc.size) {
          last = new Error(`decompressed size ${value.length} != ${loc.size}`);
          continue;
        }
        if (loc.crc && crc32(value) !== loc.crc) {
          if ((loc.segments?.length ?? 0) > 1) {
            const repaired = await this.repairBadSegments(objectKey, locs, loc, value);
            if (repaired) {
              return repaired;
            }
          }
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
        const got = await blockGet(loc.address, loc.dataKey ?? objectKey, loc, { start, end });
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
    await Promise.allSettled(locs.map((loc) => this.releaseLocator(loc, objectKey)));
    const size = locs[0]?.size ?? 0;
    for (const loc of locs) {
      await this.kv.delete(locatorKey(objectKey, loc.replica));
    }
    await Promise.all([this.addUsage(bucket, -size), this.noteChange('delete', bucket, key)]);
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
    const map = new Map<string, number>();
    let startAfter: string | undefined;
    for (;;) {
      const listed = await this.kv.scan({ prefix: '', startAfter, maxKeys: 1000 });
      if (listed.objects.length === 0) {
        break;
      }
      for (const obj of listed.objects) {
        if (!isVisibleObjectKey(obj.key)) {
          continue;
        }
        const slash = obj.key.indexOf('/');
        if (slash <= 0) {
          continue;
        }
        const name = obj.key.slice(0, slash);
        if (!map.has(name)) {
          map.set(name, obj.mtimeMs);
        }
      }
      const last = listed.objects[listed.objects.length - 1]!;
      const slash = last.key.indexOf('/');
      if (listed.truncated && slash > 0 && isVisibleObjectKey(last.key)) {
        const name = last.key.slice(0, slash);
        const bound = `${name}/\uffff`;
        startAfter = last.key.startsWith(`${name}/`) && last.key < bound ? bound : last.key;
      } else {
        startAfter = last.key;
      }
      if (!listed.truncated) {
        break;
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
    return assessLayout(this.registry.list(), this.dataReplicas);
  }

  async probeLayout(): Promise<LayoutReport> {
    await this.registry.checkAll();
    return this.layout();
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
      let startAfter: string | undefined;
      for (;;) {
        const listed = await this.kv.scan({ prefix: '', startAfter, maxKeys: 1000 });
        if (listed.objects.length === 0) {
          break;
        }
        for (const obj of listed.objects) {
          startAfter = obj.key;
          if (!isVisibleObjectKey(obj.key) || obj.key.endsWith('/')) {
            continue;
          }
          acc.objects++;
        }
        if (!listed.truncated) {
          break;
        }
      }
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
   * Drop locators that point at a down node when a live copy remains, and add
   * copies back up to the configured replica count once a node is live again.
   */
  async repair(opts: { maxObjects?: number } = {}): Promise<RepairReport> {
    await this.registry.checkAll();
    const returned = await this.admitReturns();
    const paused = await this.maintenanceHolds(Date.now());
    await this.sweepGarbage();
    const report: RepairReport = { scanned: 0, alreadyOk: 0, repaired: 0, skipped: 0, failed: 0, lost: 0, returned };
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
        if (!isVisibleObjectKey(obj.key) && !obj.key.includes('/$ver/')) {
          continue;
        }
        report.scanned++;
        const result = await this.repairObject(obj.key, paused);
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

  private async repairObject(objectKey: string, paused: Set<string>): Promise<'alreadyOk' | 'repaired' | 'skipped' | 'failed' | 'lost'> {
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
    const liveIds = new Set(live.map((node) => node.nodeId));
    const liveLocs = locs.filter((loc) => liveIds.has(loc.nodeId));
    const away = locs.filter((loc) => paused.has(loc.nodeId) && !liveIds.has(loc.nodeId));
    const downLocs = locs.filter((loc) => !liveIds.has(loc.nodeId) && !paused.has(loc.nodeId));
    if (liveLocs.length === 0) {
      if (away.length > 0) {
        return 'skipped';
      }
      await this.noteLost(objectKey);
      return 'lost';
    }
    if (downLocs.length === 0 && (liveLocs.length >= wanted || liveLocs.length + away.length >= this.dataReplicas)) {
      await this.clearLost(objectKey);
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
      const source = liveLocs[0]!;
      if (source.size > 1_048_576) {
        for (const node of targets) {
          try {
            accepted.push(await this.copyRanges(objectKey, source, node));
          } catch {
            // A later target can still satisfy the missing copy.
          }
        }
        if (accepted.length === 0) {
          return 'failed';
        }
      }
      const got = accepted.length > 0 ? null : await this.get(parts.bucket, parts.key);
      if (accepted.length === 0 && !got) {
        return 'failed';
      }
      const packed = got ? compressValue(got.value, this.compressType) : null;
      const digest = got ? got.crc || crc32(got.value) : source.crc;
      for (const node of accepted.length > 0 ? [] : targets) {
        try {
          const ev = await blockPut(node.address, source.dataKey ?? objectKey, packed!.stored, {
            compressType: packed!.compressType,
            origSize: got!.value.length,
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
            size: got!.value.length,
            storedSize: ev.size,
            compressType: packed!.compressType,
            crc: digest,
            mtimeMs: ev.mtimeMs,
            segments: source.segments,
            segmentBytes: source.segmentBytes,
            dataKey: source.dataKey,
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
    for (const loc of locs) {
      if (keep.some((item) => item.nodeId === loc.nodeId && item.recId === loc.recId)) {
        continue;
      }
      await this.releaseOrQueue(loc, objectKey);
    }
    await this.clearLost(objectKey);
    return downLocs.length > 0 || accepted.length > 0 ? 'repaired' : 'alreadyOk';
  }

  private async copyRanges(
    objectKey: string,
    source: ObjectLocator,
    node: { nodeId: string; address: string },
  ): Promise<ObjectLocator> {
    const writer = await blockWriteBegin(node.address, source.dataKey ?? objectKey);
    const chunk = 1_048_576;
    for (let start = 0; start < source.size; start += chunk) {
      const end = Math.min(source.size, start + chunk) - 1;
      const part = await blockGet(source.address, source.dataKey ?? objectKey, source, { start, end });
      if (!part) {
        await writer.abort();
        throw new ControlError('BLOCK_UNAVAILABLE', `missing range ${start} of ${objectKey}`);
      }
      await writer.write(part.value);
    }
    const ev = await writer.finish({ compressType: source.compressType, origSize: source.size, origCrc: source.crc });
    return {
      v: 3,
      replica: 0,
      replicaCount: 0,
      nodeId: node.nodeId,
      address: node.address,
      recId: ev.recId,
      chained: ev.chained,
      generation: ev.generation,
      extentCount: ev.extentCount,
      size: source.size,
      storedSize: ev.size,
      compressType: source.compressType,
      crc: source.crc,
      mtimeMs: ev.mtimeMs,
      segments: source.segments,
      segmentBytes: source.segmentBytes,
      dataKey: source.dataKey,
    };
  }

  private async repairBadSegments(
    objectKey: string,
    locs: ObjectLocator[],
    loc: ObjectLocator,
    value: Buffer,
  ): Promise<ObjectValue | null> {
    if (!loc.segments) {
      return null;
    }
    const span = loc.segmentBytes || SEGMENT_BYTES;
    const parts: Buffer[] = [];
    for (let i = 0; i < loc.segments.length; i++) {
      const start = i * span;
      const sliceEnd = Math.min(value.length, start + span);
      const piece = value.subarray(start, sliceEnd);
      const expect = loc.segments[i]!;
      if (crc32(piece) === expect) {
        parts.push(piece);
        continue;
      }
      let fixed: Buffer | null = null;
      for (const other of locs) {
        if (other.address === loc.address && other.recId === loc.recId) {
          continue;
        }
        const otherExpect = other.segments?.[i] ?? expect;
        try {
          const got = await blockGet(other.address, other.dataKey ?? objectKey, other, { start, end: sliceEnd - 1 });
          if (got && crc32(got.value) === otherExpect) {
            fixed = got.value;
            break;
          }
        } catch {
          // Try the next replica for this segment only.
        }
      }
      if (!fixed) {
        return null;
      }
      parts.push(fixed);
    }
    const out = Buffer.concat(parts);
    return { value: out, size: out.length, crc: loc.crc, mtimeMs: loc.mtimeMs, compressType: loc.compressType };
  }

  private refStorageKey(loc: ObjectLocator): string {
    return `$ref/${loc.nodeId}/${loc.recId}`;
  }

  private async heldByOthers(locs: ObjectLocator[]): Promise<boolean> {
    for (const loc of locs) {
      const raw = await this.kv.get(this.refStorageKey(loc));
      if (raw && Number(raw.value.toString('utf8')) > 1) {
        return true;
      }
    }
    return false;
  }

  private async releaseLocator(loc: ObjectLocator, objectKey: string): Promise<void> {
    const storage = this.refStorageKey(loc);
    const raw = await this.kv.get(storage);
    if (!raw) {
      await blockTombstone(loc.address, loc.dataKey ?? objectKey);
      return;
    }
    const next = Number(raw.value.toString('utf8')) - 1;
    if (next <= 0) {
      await this.kv.delete(storage);
      await blockTombstone(loc.address, loc.dataKey ?? objectKey);
    } else {
      await this.kv.put(storage, Buffer.from(String(next)));
    }
  }

  /** Tombstone a copy the index no longer names. A down node keeps a ticket until it returns. */
  private async releaseOrQueue(loc: ObjectLocator, objectKey: string): Promise<void> {
    if (this.registry.isDown(loc.nodeId)) {
      await this.queueGc(loc, objectKey);
      return;
    }
    try {
      await this.releaseLocator(loc, objectKey);
    } catch {
      await this.queueGc(loc, objectKey);
    }
  }

  private async queueGc(loc: ObjectLocator, objectKey: string): Promise<void> {
    const ticket = {
      nodeId: loc.nodeId,
      address: loc.address,
      recId: loc.recId,
      dataKey: loc.dataKey ?? objectKey,
      objectKey,
    };
    await this.kv.put(`${GC_PREFIX}${loc.nodeId}/${loc.recId}`, Buffer.from(JSON.stringify(ticket)));
  }

  /**
   * A block node wrote `$back/<nodeId>` after opening its disks.
   * Records whose recId is still in the index are kept. The rest are tombstoned.
   */
  async admitReturns(): Promise<{ nodeId: string; kept: number; removed: number }[]> {
    const notices: { key: string; nodeId: string; address: string }[] = [];
    let startAfter: string | undefined;
    for (;;) {
      const listed = await this.kv.scan({ prefix: BACK_PREFIX, startAfter, maxKeys: 1000 });
      for (const obj of listed.objects) {
        const raw = await this.kv.get(obj.key);
        if (!raw) {
          continue;
        }
        try {
          const parsed = JSON.parse(raw.value.toString('utf8')) as { nodeId?: string; address?: string };
          if (parsed.nodeId && parsed.address) {
            notices.push({ key: obj.key, nodeId: parsed.nodeId, address: parsed.address });
          }
        } catch {
          // A torn notice is left for the next pass.
        }
      }
      if (!listed.truncated || listed.objects.length === 0) {
        break;
      }
      startAfter = listed.objects[listed.objects.length - 1]!.key;
    }
    if (notices.length === 0) {
      return [];
    }
    const referenced = await this.referencedRecs();
    const reports: { nodeId: string; kept: number; removed: number }[] = [];
    for (const notice of notices) {
      let records: { key: string; locator: { recId?: number } }[];
      try {
        records = await blockScan(notice.address);
      } catch {
        continue;
      }
      const known = this.registry.get(notice.nodeId);
      await this.registry.upsert({
        nodeId: notice.nodeId,
        address: notice.address,
        status: 'up',
        lastSeenMs: Date.now(),
        zone: known?.zone,
        draining: false,
      });
      this.registry.noteDraining(notice.nodeId, false);
      await this.kv.delete(maintKey(notice.nodeId));
      let kept = 0;
      let removed = 0;
      for (const record of records) {
        const recId = record.locator?.recId ?? 0;
        if (!recId) {
          continue;
        }
        if (referenced.has(`${notice.nodeId}/${recId}`)) {
          kept++;
          await this.kv.delete(`${GC_PREFIX}${notice.nodeId}/${recId}`);
          continue;
        }
        try {
          await blockTombstone(notice.address, record.key);
          removed++;
          await this.kv.delete(`${GC_PREFIX}${notice.nodeId}/${recId}`);
        } catch {
          // Leave any ticket in place and try on the next announce.
        }
      }
      await this.kv.delete(notice.key);
      reports.push({ nodeId: notice.nodeId, kept, removed });
    }
    return reports;
  }

  private async referencedRecs(): Promise<Set<string>> {
    const referenced = new Set<string>();
    let startAfter: string | undefined;
    for (;;) {
      const listed = await this.kv.scan({ prefix: '', startAfter, maxKeys: 1000 });
      for (const obj of listed.objects) {
        if (!isVisibleObjectKey(obj.key) && !obj.key.includes('/$ver/')) {
          continue;
        }
        const locs = await this.locators(obj.key);
        for (const loc of locs) {
          referenced.add(`${loc.nodeId}/${loc.recId}`);
        }
      }
      if (!listed.truncated || listed.objects.length === 0) {
        break;
      }
      startAfter = listed.objects[listed.objects.length - 1]!.key;
    }
    return referenced;
  }

  private async sweepGarbage(): Promise<void> {
    let startAfter: string | undefined;
    for (;;) {
      const listed = await this.kv.scan({ prefix: GC_PREFIX, startAfter, maxKeys: 1000 });
      for (const obj of listed.objects) {
        const raw = await this.kv.get(obj.key);
        if (!raw) {
          continue;
        }
        let ticket: { nodeId: string; address: string; recId: number; dataKey: string; objectKey: string };
        try {
          ticket = JSON.parse(raw.value.toString('utf8')) as typeof ticket;
        } catch {
          continue;
        }
        if (this.registry.isDown(ticket.nodeId)) {
          continue;
        }
        const live = await this.locators(ticket.objectKey);
        if (live.some((loc) => loc.nodeId === ticket.nodeId && loc.recId === ticket.recId)) {
          await this.kv.delete(obj.key);
          continue;
        }
        try {
          await this.releaseLocator(
            {
              v: 3,
              replica: 0,
              replicaCount: 1,
              nodeId: ticket.nodeId,
              address: ticket.address,
              recId: ticket.recId,
              chained: false,
              generation: 1,
              extentCount: 1,
              size: 0,
              storedSize: 0,
              compressType: 'none',
              crc: 0,
              mtimeMs: 0,
              dataKey: ticket.dataKey,
            },
            ticket.objectKey,
          );
          await this.kv.delete(obj.key);
        } catch {
          // The node blinked. The ticket stays for the next pass.
        }
      }
      if (!listed.truncated || listed.objects.length === 0) {
        break;
      }
      startAfter = listed.objects[listed.objects.length - 1]!.key;
    }
  }

  async shareCopy(srcBucket: string, srcKey: string, dstBucket: string, dstKey: string): Promise<boolean> {
    const srcObject = this.objectKey(srcBucket, srcKey);
    const locs = await this.locators(srcObject);
    if (locs.length === 0) {
      return false;
    }
    const dstObject = this.objectKey(dstBucket, dstKey);
    let sharedLocs = locs;
    if (locs.some((loc) => (loc.dataKey ?? srcObject) === srcObject)) {
      const blockKey = this.freshDataKey();
      const moved: ObjectLocator[] = [];
      for (const loc of locs) {
        const got = await blockGet(loc.address, loc.dataKey ?? srcObject, loc);
        if (!got) {
          return false;
        }
        const ev = await blockPut(loc.address, blockKey, got.value, {
          compressType: loc.compressType,
          origSize: loc.size,
          origCrc: loc.crc,
        });
        moved.push({ ...loc, recId: ev.recId, storedSize: ev.size, mtimeMs: ev.mtimeMs, dataKey: blockKey });
      }
      for (const loc of moved) {
        await this.kv.put(locatorKey(srcObject, loc.replica), Buffer.from(JSON.stringify(loc)));
      }
      await Promise.all(locs.map((loc) => blockTombstone(loc.address, loc.dataKey ?? srcObject)));
      sharedLocs = moved;
    }
    for (const loc of sharedLocs) {
      const storage = this.refStorageKey(loc);
      const raw = await this.kv.get(storage);
      const next = raw ? Number(raw.value.toString('utf8')) + 1 : 2;
      await this.kv.put(storage, Buffer.from(String(next)));
      const shared: ObjectLocator = { ...loc, dataKey: loc.dataKey ?? srcObject };
      await this.kv.put(locatorKey(srcObject, loc.replica), Buffer.from(JSON.stringify(shared)));
      await this.kv.put(locatorKey(dstObject, loc.replica), Buffer.from(JSON.stringify(shared)));
    }
    await this.markShared(srcBucket);
    await this.markShared(dstBucket);
    await this.noteChange('put', dstBucket, dstKey);
    return true;
  }

  async scrub(opts: { maxObjects?: number } = {}): Promise<{ checked: number; repaired: number; lost: number }> {
    const report = { checked: 0, repaired: 0, lost: 0 };
    const maxObjects = Math.max(1, opts.maxObjects ?? Number.MAX_SAFE_INTEGER);
    let startAfter: string | undefined;
    while (report.checked < maxObjects) {
      const listed = await this.kv.scan({ prefix: '', startAfter, maxKeys: Math.min(1000, maxObjects - report.checked) });
      if (listed.objects.length === 0) {
        break;
      }
      for (const obj of listed.objects) {
        startAfter = obj.key;
        if (!isVisibleObjectKey(obj.key)) {
          continue;
        }
        report.checked++;
        const outcome = await this.scrubObject(obj.key);
        if (outcome === 'repaired') {
          report.repaired++;
        }
        if (outcome === 'lost') {
          report.lost++;
        }
        if (report.checked >= maxObjects) {
          break;
        }
      }
      if (!listed.truncated || report.checked >= maxObjects) {
        break;
      }
    }
    await this.kv.put('$scrub/report', Buffer.from(JSON.stringify(report)));
    return report;
  }

  /** Counts from the last scrub. A new process reads the same numbers without running scrub. */
  async scrubReport(): Promise<{ checked: number; repaired: number; lost: number } | null> {
    const got = await this.kv.get('$scrub/report');
    if (!got) {
      return null;
    }
    const parsed = JSON.parse(got.value.toString('utf8')) as { checked: number; repaired: number; lost: number };
    return { checked: parsed.checked, repaired: parsed.repaired, lost: parsed.lost };
  }

  private async scrubObject(objectKey: string): Promise<'ok' | 'repaired' | 'lost' | 'skipped'> {
    const locs = await this.locators(objectKey);
    if (locs.length === 0 || locs[0]?.v !== 3) {
      return 'skipped';
    }
    let good: Buffer | null = null;
    const bad: ObjectLocator[] = [];
    for (const loc of locs) {
      try {
        const got = await blockGet(loc.address, loc.dataKey ?? objectKey, loc);
        if (!got) {
          bad.push(loc);
          continue;
        }
        const value = decompressValue(got.value, loc.compressType ?? 'none');
        if (loc.crc && crc32(value) !== loc.crc) {
          bad.push(loc);
          continue;
        }
        if (!good) {
          good = value;
        }
      } catch {
        bad.push(loc);
      }
    }
    if (!good) {
      await this.noteLost(objectKey);
      return 'lost';
    }
    for (const loc of bad) {
      const ev = await blockPut(loc.address, loc.dataKey ?? objectKey, good, {
        compressType: loc.compressType,
        origSize: good.length,
        origCrc: loc.crc,
      });
      const replaced: ObjectLocator = { ...loc, recId: ev.recId, mtimeMs: ev.mtimeMs, storedSize: ev.size };
      await this.kv.put(locatorKey(objectKey, loc.replica), Buffer.from(JSON.stringify(replaced)));
    }
    if (bad.length > 0) {
      return 'repaired';
    }
    await this.clearLost(objectKey);
    return 'ok';
  }

  async rebalance(nodeId: string): Promise<{ moved: number; bytes: number }> {
    const node = this.registry.list().find((item) => item.nodeId === nodeId);
    if (!node) {
      throw new ControlError('BAD_REQUEST', `unknown block node ${nodeId}`);
    }
    let moved = 0;
    let bytes = 0;
    let startAfter: string | undefined;
    for (;;) {
      const listed = await this.kv.scan({ prefix: '', startAfter, maxKeys: 1000 });
      if (listed.objects.length === 0) {
        break;
      }
      for (const obj of listed.objects) {
        startAfter = obj.key;
        if (!isVisibleObjectKey(obj.key)) {
          continue;
        }
        const locs = await this.locators(obj.key);
        if (locs.length === 0 || locs.some((loc) => loc.nodeId === nodeId)) {
          continue;
        }
        const source = locs.find((loc) => !this.registry.isDown(loc.nodeId));
        if (!source) {
          continue;
        }
        const got = await blockGet(source.address, source.dataKey ?? obj.key, source);
        if (!got) {
          continue;
        }
        const ev = await blockPut(node.address, source.dataKey ?? obj.key, got.value, {
          compressType: source.compressType,
          origSize: got.value.length,
          origCrc: source.crc,
        });
        const fresh: ObjectLocator = {
          ...source,
          nodeId: node.nodeId,
          address: node.address,
          recId: ev.recId,
          storedSize: ev.size,
          mtimeMs: ev.mtimeMs,
        };
        const retired = locs[locs.length - 1]!;
        await this.kv.delete(locatorKey(obj.key, retired.replica));
        const keep = locs.slice(0, -1);
        keep.push(fresh);
        for (let i = 0; i < keep.length; i++) {
          keep[i] = { ...keep[i]!, replica: i, replicaCount: keep.length };
          await this.kv.put(locatorKey(obj.key, i), Buffer.from(JSON.stringify(keep[i])));
        }
        await this.releaseOrQueue(retired, obj.key);
        moved++;
        bytes += got.value.length;
      }
      if (!listed.truncated) {
        break;
      }
    }
    return { moved, bytes };
  }

  async sendChanges(
    target: { put(bucket: string, key: string, value: Buffer): Promise<void>; delete?(bucket: string, key: string): Promise<void> },
    options?: { deletes?: boolean },
  ): Promise<{ sent: number }> {
    this.replOpened = true;
    const changes = await this.listChangeRecords();
    let sent = 0;
    for (const change of changes) {
      if (change.op === 'delete') {
        if (options?.deletes && target.delete) {
          await target.delete(change.bucket, change.key);
          await this.kv.delete(change.id);
          sent++;
          this.replSent++;
        }
        continue;
      }
      const got = await this.get(change.bucket, change.key);
      if (!got) {
        continue;
      }
      await target.put(change.bucket, change.key, got.value);
      await this.kv.delete(change.id);
      sent++;
      this.replSent++;
    }
    return { sent };
  }

  /** Sent journal entries, and how many remain. Both stay at 0 until replication runs. */
  async replicationProgress(): Promise<{ sent: number; pending: number }> {
    if (!this.replOpened) {
      return { sent: 0, pending: 0 };
    }
    return { sent: this.replSent, pending: (await this.listChanges()).length };
  }

  /** Sum logical sizes for one bucket, following every index page. */
  async bucketUsage(bucket: string): Promise<{ objects: number; bytes: number }> {
    let objects = 0;
    let bytes = 0;
    let startAfter: string | undefined;
    for (;;) {
      const listed = await this.kv.scan({ prefix: `${bucket}/`, startAfter, maxKeys: 1000 });
      for (const obj of listed.objects) {
        if (!isVisibleObjectKey(obj.key) || obj.key.endsWith('/')) {
          continue;
        }
        const raw = await this.kv.get(obj.key);
        if (!raw) {
          continue;
        }
        try {
          const loc = JSON.parse(raw.value.toString('utf8')) as { v?: number; size?: number };
          if (loc.v !== 3) {
            continue;
          }
          objects++;
          bytes += loc.size ?? 0;
        } catch {
          // A torn locator is not a counted object.
        }
      }
      if (!listed.truncated || listed.objects.length === 0) {
        break;
      }
      startAfter = listed.objects[listed.objects.length - 1]!.key;
    }
    return { objects, bytes };
  }

  /** Step a block node out for two hours. Copies stay put and the reason is kept in the index. */
  async leaveForMaintenance(nodeId: string, reason: string, now = Date.now()): Promise<MaintenanceLeave> {
    const text = reason.trim();
    if (!text) {
      throw new ControlError('BAD_REQUEST', 'maintenance reason is required');
    }
    if (!this.registry.get(nodeId)) {
      throw new ControlError('BAD_REQUEST', `unknown block node ${nodeId}`);
    }
    const leave: MaintenanceLeave = { nodeId, reason: text, leftAtMs: now, untilMs: now + MAINTENANCE_MS };
    await this.kv.put(maintKey(nodeId), Buffer.from(JSON.stringify(leave)));
    this.registry.noteDraining(nodeId, true);
    return leave;
  }

  async maintenanceLeaves(now = Date.now()): Promise<MaintenanceLeave[]> {
    const holds = await this.maintenanceHolds(now);
    const out: MaintenanceLeave[] = [];
    for (const nodeId of holds) {
      const raw = await this.kv.get(maintKey(nodeId));
      if (!raw) {
        continue;
      }
      try {
        out.push(JSON.parse(raw.value.toString('utf8')) as MaintenanceLeave);
      } catch {
        // A torn record is not shown.
      }
    }
    return out;
  }

  private async maintenanceHolds(now: number): Promise<Set<string>> {
    const holds = new Set<string>();
    let startAfter: string | undefined;
    for (;;) {
      const listed = await this.kv.scan({ prefix: MAINT_PREFIX, startAfter, maxKeys: 1000 });
      for (const obj of listed.objects) {
        const raw = await this.kv.get(obj.key);
        if (!raw) {
          continue;
        }
        let leave: MaintenanceLeave;
        try {
          leave = JSON.parse(raw.value.toString('utf8')) as MaintenanceLeave;
        } catch {
          continue;
        }
        if (!leave.nodeId || leave.untilMs <= now) {
          await this.kv.delete(obj.key);
          if (leave.nodeId) {
            this.registry.noteDraining(leave.nodeId, false);
          }
          continue;
        }
        holds.add(leave.nodeId);
        this.registry.noteDraining(leave.nodeId, true);
      }
      if (!listed.truncated || listed.objects.length === 0) {
        break;
      }
      startAfter = listed.objects[listed.objects.length - 1]!.key;
    }
    return holds;
  }

  /**
   * Copy every replica that lives on `nodeId` onto another live node, then drop it
   * from the locator. Replica count stays the same. Does nothing until called.
   */
  async drain(nodeId: string): Promise<{ moved: number; bytes: number }> {
    const known = this.registry.list().some((item) => item.nodeId === nodeId);
    if (!known) {
      throw new ControlError('BAD_REQUEST', `unknown block node ${nodeId}`);
    }
    let moved = 0;
    let bytes = 0;
    let startAfter: string | undefined;
    for (;;) {
      const listed = await this.kv.scan({ prefix: '', startAfter, maxKeys: 1000 });
      if (listed.objects.length === 0) {
        break;
      }
      for (const obj of listed.objects) {
        startAfter = obj.key;
        if (!isVisibleObjectKey(obj.key)) {
          continue;
        }
        const locs = await this.locators(obj.key);
        const leaving = locs.filter((loc) => loc.nodeId === nodeId);
        if (leaving.length === 0) {
          continue;
        }
        for (const loc of leaving) {
          const source = locs.find((item) => item.nodeId !== nodeId && !this.registry.isDown(item.nodeId));
          const dest = this.registry.live().find((node) => node.nodeId !== nodeId && !locs.some((item) => item.nodeId === node.nodeId));
          if (!source || !dest) {
            continue;
          }
          const got = await blockGet(source.address, source.dataKey ?? obj.key, source);
          if (!got) {
            continue;
          }
          const ev = await blockPut(dest.address, source.dataKey ?? obj.key, got.value, {
            compressType: source.compressType,
            origSize: got.value.length,
            origCrc: source.crc,
          });
          const replaced: ObjectLocator = {
            ...loc,
            nodeId: dest.nodeId,
            address: dest.address,
            recId: ev.recId,
            storedSize: ev.size,
            mtimeMs: ev.mtimeMs,
          };
          await this.kv.put(locatorKey(obj.key, loc.replica), Buffer.from(JSON.stringify(replaced)));
          await this.releaseOrQueue(loc, obj.key);
          const idx = locs.findIndex((item) => item.replica === loc.replica);
          if (idx >= 0) {
            locs[idx] = replaced;
          }
          moved++;
          bytes += got.value.length;
        }
      }
      if (!listed.truncated) {
        break;
      }
    }
    return { moved, bytes };
  }

  async lostKeys(): Promise<string[]> {
    const keys: string[] = [];
    let startAfter: string | undefined;
    for (;;) {
      const listed = await this.kv.scan({ prefix: LOST_PREFIX, startAfter, maxKeys: 1000 });
      for (const obj of listed.objects) {
        keys.push(obj.key.slice(LOST_PREFIX.length));
      }
      if (!listed.truncated || listed.objects.length === 0) {
        break;
      }
      startAfter = listed.objects[listed.objects.length - 1]!.key;
    }
    return keys;
  }

  private async noteLost(objectKey: string): Promise<void> {
    await this.kv.put(lostKey(objectKey), Buffer.from(JSON.stringify({ v: 1, mtimeMs: Date.now() })));
  }

  private async clearLost(objectKey: string): Promise<void> {
    await this.kv.delete(lostKey(objectKey));
  }

  private freshDataKey(): string {
    this.changeSeq += 1;
    return `$obj/${Date.now().toString(36)}-${this.changeSeq}`;
  }

  private changeRecord(op: 'put' | 'delete', bucket: string, key: string): { key: string; value: Buffer } {
    this.changeSeq += 1;
    const id = `${String(Date.now()).padStart(16, '0')}-${String(this.changeSeq).padStart(6, '0')}`;
    return {
      key: `${CHANGE_PREFIX}${id}`,
      value: Buffer.from(JSON.stringify({ op, bucket, key, mtimeMs: Date.now() })),
    };
  }

  private async noteChange(op: 'put' | 'delete', bucket: string, key: string): Promise<string> {
    const record = this.changeRecord(op, bucket, key);
    await this.kv.put(record.key, record.value);
    return record.key;
  }

  private async markShared(bucket: string): Promise<void> {
    const markerKey = this.objectKey(bucket);
    const raw = await this.kv.get(markerKey);
    let prev: Record<string, unknown> = { v: 1, kind: 'bucket', mtimeMs: Date.now() };
    if (raw) {
      try {
        prev = JSON.parse(raw.value.toString('utf8')) as Record<string, unknown>;
      } catch {
        prev = { v: 1, kind: 'bucket', mtimeMs: Date.now() };
      }
    }
    if (prev.shared !== true) {
      await this.kv.put(markerKey, Buffer.from(JSON.stringify({ ...prev, shared: true })));
    }
    const hit = this.limitsCache.get(bucket);
    if (hit) {
      hit.limits = { ...hit.limits, shared: true };
    } else {
      this.limitsCache.set(bucket, { at: Date.now(), limits: { shared: true } });
    }
  }

  private async bucketMarker(bucket: string): Promise<BucketLimits> {
    const raw = await this.kv.get(this.objectKey(bucket));
    if (!raw) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw.value.toString('utf8')) as { kind?: string; quotaBytes?: number; compress?: boolean; shared?: boolean };
      if (parsed.kind !== 'bucket') {
        return {};
      }
      return {
        quotaBytes: typeof parsed.quotaBytes === 'number' ? parsed.quotaBytes : undefined,
        compress: typeof parsed.compress === 'boolean' ? parsed.compress : undefined,
        shared: parsed.shared === true ? true : undefined,
      };
    } catch {
      return {};
    }
  }

  private async limitsFor(bucket: string): Promise<BucketLimits> {
    const hit = this.limitsCache.get(bucket);
    if (hit && Date.now() - hit.at < LIMITS_TTL_MS) {
      return hit.limits;
    }
    const limits = await this.bucketMarker(bucket);
    this.limitsCache.set(bucket, { at: Date.now(), limits });
    return limits;
  }

  private async usageCached(bucket: string): Promise<number> {
    const mem = this.usageMem.get(bucket);
    if (mem !== undefined) {
      return mem;
    }
    const n = await this.usage(bucket);
    this.usageMem.set(bucket, n);
    return n;
  }

  private async sumVisibleBytes(bucket: string): Promise<number> {
    let total = 0;
    let startAfter: string | undefined;
    const prefix = this.objectKey(bucket);
    for (;;) {
      const listed = await this.kv.scan({ prefix, startAfter, maxKeys: 1000 });
      for (const obj of listed.objects) {
        if (!isVisibleObjectKey(obj.key)) {
          continue;
        }
        const raw = await this.kv.get(obj.key);
        const loc = raw ? parseLocator(raw.value) : null;
        if (loc) {
          total += loc.size;
        }
      }
      if (!listed.truncated || listed.objects.length === 0) {
        break;
      }
      startAfter = listed.objects[listed.objects.length - 1]!.key;
    }
    return total;
  }

  private async usage(bucket: string): Promise<number> {
    const raw = await this.kv.get(usageKey(bucket));
    if (!raw) {
      return 0;
    }
    const n = Number(raw.value.toString('utf8'));
    return Number.isFinite(n) ? n : 0;
  }

  private async addUsage(bucket: string, delta: number, limits?: BucketLimits): Promise<void> {
    if (delta === 0) {
      return;
    }
    const marker = limits ?? (await this.limitsFor(bucket));
    if (typeof marker.quotaBytes !== 'number') {
      return;
    }
    const next = Math.max(0, (await this.usageCached(bucket)) + delta);
    this.usageMem.set(bucket, next);
    await this.kv.put(usageKey(bucket), Buffer.from(String(next)));
  }

  private async assertQuota(bucket: string, delta: number, limits?: BucketLimits): Promise<void> {
    const marker = limits ?? (await this.limitsFor(bucket));
    if (typeof marker.quotaBytes !== 'number' || delta <= 0) {
      return;
    }
    const used = await this.usageCached(bucket);
    if (used + delta > marker.quotaBytes) {
      throw new ControlError('BAD_REQUEST', `bucket ${bucket} quota ${marker.quotaBytes}`);
    }
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
