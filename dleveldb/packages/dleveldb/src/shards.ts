import fs from 'node:fs';
import path from 'node:path';
import { describeVnode } from './chord.js';
import { isLevelDbDir, LevelStore, type LevelStoreStats } from './store.js';
import type { VnodeInfo } from './types.js';

export interface LocalShard {
  info: VnodeInfo;
  dataDir: string;
  store: LevelStore;
  legacy: boolean;
}

/** 兼容旧名：现在表示目录里是否已有 LevelDB。 */
export function legacyLayoutExists(dataDir: string): boolean {
  return isLevelDbDir(dataDir);
}

/** 标准品一律使用 shards/{node}-{seq}，不再打开 packed-block 旧布局。 */
export function shouldUseLegacyLayout(_dataDir: string, _vnodeCount: number): boolean {
  return false;
}

export function shardDataDir(dataDir: string, vnodeId: string): string {
  return path.join(dataDir, 'shards', vnodeId);
}

export function replicaDataDir(dataDir: string, ownerVnodeId: string): string {
  return path.join(dataDir, 'replicas', ownerVnodeId);
}

export async function openLocalShards(opts: {
  dataDir: string;
  nodeId: string;
  address: string;
  vnodeCount: number;
  sync: boolean;
}): Promise<{ shards: LocalShard[]; usesLegacyLayout: boolean }> {
  const { dataDir, nodeId, address, vnodeCount, sync } = opts;
  const shards: LocalShard[] = [];
  fs.mkdirSync(path.join(dataDir, 'shards'), { recursive: true });
  for (let seq = 0; seq < vnodeCount; seq++) {
    const info = describeVnode(nodeId, seq, address);
    const dir = shardDataDir(dataDir, info.id);
    fs.mkdirSync(dir, { recursive: true });
    shards.push({
      info,
      dataDir: dir,
      store: await LevelStore.open(dir, { sync }),
      legacy: false,
    });
  }
  return { shards, usesLegacyLayout: false };
}

export class ReplicaStoreSet {
  private readonly stores = new Map<string, LevelStore>();

  constructor(
    private readonly dataDir: string,
    private readonly sync: boolean,
  ) {}

  async open(ownerVnodeId: string): Promise<LevelStore> {
    const existing = this.stores.get(ownerVnodeId);
    if (existing) {
      return existing;
    }
    const dir = replicaDataDir(this.dataDir, ownerVnodeId);
    fs.mkdirSync(dir, { recursive: true });
    const store = await LevelStore.open(dir, { sync: this.sync });
    this.stores.set(ownerVnodeId, store);
    return store;
  }

  async get(ownerVnodeId: string): Promise<LevelStore | undefined> {
    if (this.stores.has(ownerVnodeId)) {
      return this.stores.get(ownerVnodeId);
    }
    const dir = replicaDataDir(this.dataDir, ownerVnodeId);
    if (isLevelDbDir(dir)) {
      return this.open(ownerVnodeId);
    }
    return undefined;
  }

  all(): LevelStore[] {
    return [...this.stores.values()];
  }

  ids(): string[] {
    return [...this.stores.keys()];
  }

  async discover(): Promise<void> {
    const root = path.join(this.dataDir, 'replicas');
    if (!fs.existsSync(root)) {
      return;
    }
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      if (!this.stores.has(name) && fs.statSync(dir).isDirectory() && isLevelDbDir(dir)) {
        await this.open(name);
      }
    }
  }

  async flush(): Promise<void> {
    for (const store of this.stores.values()) {
      await store.flush();
    }
  }

  async compact(): Promise<void> {
    for (const store of this.stores.values()) {
      await store.compact();
    }
  }

  async close(): Promise<void> {
    for (const store of this.stores.values()) {
      await store.flush();
      await store.close();
    }
    this.stores.clear();
  }
}

export function sumStats(parts: LevelStoreStats[]): LevelStoreStats {
  const out: LevelStoreStats = {
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
    indexSlots: 0,
  };
  for (const s of parts) {
    out.objects += s.objects;
    out.deleted += s.deleted;
    out.bytesLogical += s.bytesLogical;
    out.bytesOnDisk += s.bytesOnDisk;
    out.blockFiles += s.blockFiles;
    out.puts += s.puts;
    out.gets += s.gets;
    out.deletes += s.deletes;
    out.flushes += s.flushes;
    out.fsyncs += s.fsyncs;
    out.indexSlots += s.indexSlots;
  }
  return out;
}
