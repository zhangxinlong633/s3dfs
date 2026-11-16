import { blockCompact, blockDelete, blockFlush, blockGet, blockHead, blockPut } from './block-client.js';
import { isVisibleObjectKey, locatorKey } from './keys.js';
import type { IndexClient } from './kv-client.js';
import type { NodeRegistry } from './registry.js';
import type { BlockHealth, ObjectLocator, ObjectValue } from './types.js';
import { ControlError } from './types.js';

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
}

export class ObjectCluster {
  constructor(
    private readonly kv: IndexClient,
    private readonly registry: NodeRegistry,
    private readonly dataReplicas: number,
  ) {}

  objectKey(bucket: string, key?: string): string {
    return key ? `${bucket}/${key}` : `${bucket}/`;
  }

  async put(bucket: string, key: string, value: Buffer): Promise<void> {
    const objectKey = this.objectKey(bucket, key);
    const targets = this.registry.pick(objectKey, this.dataReplicas);
    const writes = await Promise.allSettled(targets.map((n) => blockPut(n.address, objectKey, value)));
    const ok: { nodeId: string; address: string; size: number; crc: number; mtimeMs: number }[] = [];
    for (let i = 0; i < writes.length; i++) {
      const result = writes[i]!;
      const node = targets[i]!;
      if (result.status === 'fulfilled') {
        ok.push({ nodeId: node.nodeId, address: node.address, ...result.value });
      }
    }
    if (ok.length === 0) {
      throw new ControlError('BLOCK_UNAVAILABLE', `failed to write ${objectKey} to any block node`);
    }
    const meta = ok[0]!;
    for (let i = 0; i < ok.length; i++) {
      const loc: ObjectLocator = {
        v: 1,
        replica: i,
        replicaCount: ok.length,
        nodeId: ok[i]!.nodeId,
        address: ok[i]!.address,
        storageKey: objectKey,
        size: meta.size,
        crc: meta.crc,
        mtimeMs: meta.mtimeMs,
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
    const locs = this.prefer(await this.locators(this.objectKey(bucket, key)));
    let last: unknown;
    for (const loc of locs) {
      try {
        const got = await blockGet(loc.address, loc.storageKey);
        if (got) {
          return got;
        }
      } catch (err) {
        last = err;
      }
    }
    if (locs.length > 0 && last) {
      throw new ControlError('BLOCK_UNAVAILABLE', `all data replicas failed for ${bucket}/${key}: ${String(last)}`);
    }
    return null;
  }

  async head(bucket: string, key: string): Promise<Omit<ObjectValue, 'value'> | null> {
    const locs = this.prefer(await this.locators(this.objectKey(bucket, key)));
    if (locs[0]) {
      const loc = locs[0];
      if (!this.registry.isDown(loc.nodeId)) {
        try {
          const live = await blockHead(loc.address, loc.storageKey);
          if (live) {
            return live;
          }
        } catch {
          // Fall back to the index metadata.
        }
      }
      return { size: loc.size, crc: loc.crc, mtimeMs: loc.mtimeMs };
    }
    return null;
  }

  async delete(bucket: string, key: string): Promise<boolean> {
    const objectKey = this.objectKey(bucket, key);
    const locs = await this.locators(objectKey);
    if (locs.length === 0) {
      return false;
    }
    await Promise.allSettled(locs.map((loc) => blockDelete(loc.address, loc.storageKey)));
    for (const loc of locs) {
      await this.kv.delete(locatorKey(objectKey, loc.replica));
    }
    return true;
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

  async list(bucket: string, prefix = '', startAfter?: string, maxKeys = 1000) {
    const fullPrefix = prefix ? `${bucket}/${prefix}` : `${bucket}/`;
    const after = startAfter ? `${bucket}/${startAfter}` : undefined;
    const result = await this.kv.scan({
      prefix: fullPrefix,
      startAfter: after,
      maxKeys: Math.max(maxKeys * 3, maxKeys),
    });
    const objects = result.objects
      .filter((o) => isVisibleObjectKey(o.key) && o.key !== `${bucket}/`)
      .map((o) => ({
        ...o,
        key: o.key.slice(bucket.length + 1),
      }))
      .slice(0, maxKeys);
    return { truncated: result.truncated || objects.length === maxKeys, objects };
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
}
