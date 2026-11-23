import path from 'node:path';
import { ChordRing } from './chord.js';
import { effectiveReplicas, effectiveWriteQuorum } from './config.js';
import { hashKey } from './hash.js';
import { LinkTransport } from './link.js';
import { mergeScan } from './rpc.js';
import { openLocalShards, ReplicaStoreSet, sumStats, type LocalShard } from './shards.js';
import { putSpan } from './store.js';
import type {
  DLevelDBConfig,
  DLevelDBStats,
  DLevelDBStatus,
  KVMeta,
  KVValue,
  ScanOptions,
  ScanResult,
  VnodeInfo,
} from './types.js';
import { DLevelDBError } from './types.js';

function preferValue(current: KVValue | null, found: KVValue | null): KVValue | null {
  if (!found) {
    return current;
  }
  if (!current || found.mtimeMs > current.mtimeMs) {
    return found;
  }
  if (found.mtimeMs < current.mtimeMs) {
    return current;
  }
  return Buffer.compare(found.value, current.value) > 0 ? found : current;
}

function preferMeta(current: KVMeta | null, found: KVMeta | null): KVMeta | null {
  if (!found) {
    return current;
  }
  if (!current || found.mtimeMs >= current.mtimeMs) {
    return found;
  }
  return current;
}

const REPAIR_NOTE =
  '大约每小时从一台同伴那里补一段 key，主分片和副本轮流，按较新的 mtime 写入。主节点不可达时，偏好列表里第一个还活着的节点按写法定人数把数据写入副本。';

export class DLevelDB {
  readonly config: DLevelDBConfig;
  readonly ring: ChordRing;
  readonly transport: LinkTransport;
  private readonly shards: LocalShard[];
  private readonly shardById: Map<string, LocalShard>;
  private readonly replicas: ReplicaStoreSet;
  readonly usesLegacyLayout: boolean;
  private stabilizeTimer: ReturnType<typeof setInterval> | undefined;
  private repairTimer: ReturnType<typeof setInterval> | undefined;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  /** 每次写入都刷盘，或者没有周期刷盘时，复制前先把本机那份刷下去。 */
  private readonly flushEachWrite: boolean;
  private joining = false;
  private closed = false;

  private constructor(
    config: DLevelDBConfig,
    shards: LocalShard[],
    usesLegacyLayout: boolean,
    replicas: ReplicaStoreSet,
    ring: ChordRing,
    transport: LinkTransport,
  ) {
    this.config = config;
    const interval = config.syncIntervalMs ?? 0;
    this.flushEachWrite = config.sync === true || interval <= 0;
    this.shards = shards;
    this.usesLegacyLayout = usesLegacyLayout;
    this.replicas = replicas;
    this.ring = ring;
    this.transport = transport;
    this.shardById = new Map(shards.map((s) => [s.info.id, s]));
  }

  static async open(config: DLevelDBConfig): Promise<DLevelDB> {
    const sync = (config.syncIntervalMs ?? 0) > 0 ? false : (config.sync ?? config.fsyncOnFlush ?? true);
    const { shards, usesLegacyLayout } = await openLocalShards({
      dataDir: path.resolve(config.dataDir),
      nodeId: config.nodeId,
      address: config.advertiseAddr,
      vnodeCount: config.vnodeCount,
      sync,
    });
    const ring = new ChordRing({
      nodeId: config.nodeId,
      address: config.advertiseAddr,
      localVnodes: shards.map((s) => s.info),
      successorListLen: Math.max(4, config.replicas),
    });
    const transport = new LinkTransport(config.advertiseAddr, config.rpcTimeoutMs);
    ring.setTransport(transport);
    const replicas = new ReplicaStoreSet(path.resolve(config.dataDir), sync);
    const db = new DLevelDB(config, shards, usesLegacyLayout, replicas, ring, transport);
    if (config.peers.length > 0) {
      void db.joinWithRetry(config.peers);
    }
    db.stabilizeTimer = setInterval(() => {
      void db.ring.stabilize().catch(() => undefined);
    }, config.stabilizeIntervalMs);
    db.stabilizeTimer.unref();
    const repairEvery = 60 * 60 * 1000;
    db.repairTimer = setInterval(() => {
      void db.repairOnJoin().catch(() => undefined);
    }, repairEvery);
    db.repairTimer.unref();
    const flushEvery = config.syncIntervalMs ?? 0;
    if (flushEvery > 0) {
      db.flushTimer = setInterval(() => {
        void db.flush();
      }, flushEvery);
      db.flushTimer.unref();
    }
    return db;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.stabilizeTimer) {
      clearInterval(this.stabilizeTimer);
      this.stabilizeTimer = undefined;
    }
    if (this.repairTimer) {
      clearInterval(this.repairTimer);
      this.repairTimer = undefined;
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.copyQueue.length = 0;
    this.transport.close();
    for (const shard of this.shards) {
      await shard.store.flush();
      await shard.store.close();
    }
    await this.replicas.close();
  }

  putNow(key: string, value: Buffer): void {
    const span = putSpan.getStore();
    if (span) {
      span.local += 1;
    }
    const mtimeMs = Date.now();
    const prefs = this.prefs(key);
    const owner = prefs[0];
    this.writeUnchecked(key, value, mtimeMs, owner);
    const ownerId = owner?.id ?? this.shards[0]?.info.id;
    if (!ownerId) {
      return;
    }
    const runs = this.syncTargets().map((vnode) => () => this.replicatePut(vnode, ownerId, key, value, mtimeMs));
    void this.copiesUntil(runs, 0);
  }

  async put(key: string, value: Buffer): Promise<void> {
    const span = putSpan.getStore();
    if (span) {
      span.local += 1;
    }
    const mtimeMs = Date.now();
    const prefs = this.prefs(key);
    const owner = prefs[0];
    await this.writeLocal(key, value, mtimeMs, owner);
    const ownerId = owner?.id ?? this.shards[0]?.info.id;
    if (!ownerId) {
      return;
    }
    const runs = this.syncTargets().map((vnode) => () => this.replicatePut(vnode, ownerId, key, value, mtimeMs));
    await this.copiesUntil(runs, 0);
  }

  async get(key: string): Promise<KVValue | null> {
    return this.readValue(key, false);
  }

  async head(key: string): Promise<KVMeta | null> {
    const found = await this.readValue(key, true);
    if (!found) {
      return null;
    }
    return { size: found.size, crc: found.crc, mtimeMs: found.mtimeMs };
  }

  async delete(key: string): Promise<boolean> {
    const prefs = this.prefs(key);
    const primary = prefs[0];
    if (!primary) {
      throw new DLevelDBError('PRIMARY_UNAVAILABLE', 'empty preference list');
    }
    if (!this.isLocal(primary.address)) {
      try {
        return await this.transport.proxyDelete(primary.address, key);
      } catch (err) {
        if (!this.primaryUnreachable(err)) {
          throw err;
        }
        return this.deleteWhilePrimaryDown(key, prefs);
      }
    }
    return this.deleteAsPrimary(key, prefs);
  }

  async scan(opts: ScanOptions = {}): Promise<ScanResult> {
    const maxKeys = Math.max(1, opts.maxKeys ?? 1000);
    const normalized: ScanOptions = { ...opts, maxKeys };
    if (this.isSingleStoreFastPath()) {
      return await this.shards[0]!.store.list(normalized);
    }

    const addresses = this.scanTargets();
    const reachable: string[] = [];
    const downNodeIds = new Set<string>();
    const downVnodes: string[] = [];

    for (const addr of addresses) {
      if (this.isLocal(addr)) {
        reachable.push(addr);
        continue;
      }
      const ok = await this.transport.ping(addr);
      if (ok) {
        reachable.push(addr);
      } else {
        for (const vnode of this.ring.sortedKnown()) {
          if (vnode.address === addr) {
            downNodeIds.add(vnode.nodeId);
            downVnodes.push(vnode.id);
          }
        }
      }
    }

    const parts: ScanResult[] = [];
    for (const addr of reachable) {
      if (this.isLocal(addr)) {
        parts.push(await this.scanLocalPrimaries(normalized));
      } else {
        try {
          parts.push(await this.transport.proxyScan(addr, normalized));
        } catch {
          for (const vnode of this.ring.sortedKnown()) {
            if (vnode.address === addr) {
              downVnodes.push(vnode.id);
            }
          }
        }
      }
    }

    const uniqueDown = [...new Set(downVnodes)];
    if (uniqueDown.length > 0) {
      for (const addr of reachable) {
        if (this.isLocal(addr)) {
          parts.push(await this.scanLocalReplicas(uniqueDown, normalized));
        } else {
          try {
            parts.push(await this.transport.proxyScanReplica(addr, uniqueDown, normalized));
          } catch {
            // ignore
          }
        }
      }
    }
    void downNodeIds;
    return mergeScan(parts, maxKeys);
  }

  async flush(): Promise<void> {
    for (const shard of this.shards) {
      await shard.store.flush();
    }
    await this.replicas.flush();
  }

  async compact(): Promise<void> {
    for (const shard of this.shards) {
      await shard.store.compact();
    }
    await this.replicas.compact();
  }

  lookup(key: string): { hash: string; preference: VnodeInfo[]; primary: VnodeInfo | null } {
    const hash = hashKey(key);
    const preference = this.prefs(key);
    return { hash, preference, primary: preference[0] ?? null };
  }

  stats(): DLevelDBStats {
    const base = sumStats(this.shards.map((s) => s.store.stats()));
    return {
      ...base,
      dataDir: path.resolve(this.config.dataDir),
      nodeId: this.config.nodeId,
      vnodeCount: this.config.vnodeCount,
      peers: [...this.config.peers],
      configuredReplicas: this.config.replicas,
      effectiveReplicas: this.effectiveN(),
      writeQuorum: this.writeQuorum(),
    };
  }

  status(): DLevelDBStatus {
    return {
      layer: '分布式 LevelDB',
      nodeId: this.config.nodeId,
      address: this.config.advertiseAddr,
      vnodes: this.ring.snapshot().map((s) => ({
        id: s.info.id,
        seq: s.info.seq,
        hash: s.info.hash,
        successor: s.successor,
        predecessor: s.predecessor,
        successorList: s.successorList,
      })),
      peers: [...this.config.peers],
      knownVnodes: this.ring.sortedKnown(),
      physicalNodes: this.ring.physicalNodeCount(),
      configuredReplicas: this.config.replicas,
      effectiveReplicas: this.effectiveN(),
      writeQuorum: this.writeQuorum(),
      usesLegacyLayout: this.usesLegacyLayout,
      repair: { implemented: true, note: REPAIR_NOTE },
    };
  }

  effectiveN(): number {
    return effectiveReplicas(this.config.replicas, this.ring.physicalNodeCount());
  }

  writeQuorum(): number {
    return effectiveWriteQuorum(this.config.writeQuorum, this.effectiveN());
  }

  isSingleStoreFastPath(): boolean {
    // A seed starts with an empty peer list. After other nodes join, a scan
    // still has to read their shards. The fast path is only a process that
    // is still the only member of the ring.
    return (
      this.config.vnodeCount === 1 &&
      this.config.peers.length === 0 &&
      this.shards.length === 1 &&
      this.ring.physicalNodeCount() <= 1
    );
  }

  async scanLocalPrimaries(opts: ScanOptions): Promise<ScanResult> {
    const maxKeys = Math.max(1, opts.maxKeys ?? 1000);
    const parts = await Promise.all(this.shards.map((s) => s.store.list(opts)));
    return mergeScan(parts, maxKeys);
  }

  async scanLocalReplicas(vnodeIds: string[], opts: ScanOptions): Promise<ScanResult> {
    const maxKeys = Math.max(1, opts.maxKeys ?? 1000);
    const parts: ScanResult[] = [];
    for (const id of vnodeIds) {
      const store = await this.replicas.get(id);
      if (!store) {
        continue;
      }
      parts.push(await store.list(opts));
    }
    return mergeScan(parts, maxKeys);
  }

  async putAsPrimary(key: string, value: Buffer, prefs = this.prefs(key)): Promise<void> {
    const primary = prefs[0];
    if (!primary || !this.shardById.has(primary.id)) {
      throw new DLevelDBError('NOT_PRIMARY', `this node is not primary for ${key}`);
    }
    const shard = this.shardById.get(primary.id)!;
    await shard.store.put(key, value);
    const n = this.effectiveN();
    if (n <= 1) {
      return;
    }
    if (this.flushEachWrite) {
      await shard.store.flush();
    }
    const followers = prefs.slice(1, n);
    await this.copiesUntil(
      followers.map((vnode) => () => this.replicatePut(vnode, primary.id, key, value)),
      this.writeQuorum() - 1,
    );
  }

  /** Primary is down. The first live preference node writes the value onto W live copies. */
  async putWhilePrimaryDown(
    key: string,
    value: Buffer,
    prefs = this.prefs(key),
    forwarded = false,
  ): Promise<void> {
    const live: VnodeInfo[] = [];
    for (const vnode of prefs) {
      if (this.isLocal(vnode.address) || (await this.transport.ping(vnode.address))) {
        live.push(vnode);
      }
    }
    const coordinator = live[0];
    if (!coordinator) {
      throw new DLevelDBError('PRIMARY_UNAVAILABLE', 'no live replica');
    }
    if (!this.isLocal(coordinator.address)) {
      if (forwarded) {
        throw new DLevelDBError('NOT_PRIMARY', 'not the failover coordinator');
      }
      await this.transport.proxyFailoverPut(coordinator.address, key, value);
      return;
    }
    const owner = prefs[0]?.id;
    if (!owner) {
      throw new DLevelDBError('PRIMARY_UNAVAILABLE', 'empty preference list');
    }
    await this.replicatePut(coordinator, owner, key, value);
    const rest = live.slice(1).map((vnode) => () => this.replicatePut(vnode, owner, key, value));
    await this.copiesUntil(rest, this.writeQuorum() - 1);
  }

  private copyQueue: Array<() => Promise<void>> = [];
  private copyActive = false;
  private copyScheduled = false;

  /** 法定人数内的复制一份一份等。多出来的进队列，下一次事件循环再发，避免和本机写入堆在同一次调用里。 */
  private async copiesUntil(runs: Array<() => Promise<void>>, need: number): Promise<void> {
    if (need <= 0) {
      for (const run of runs) {
        this.copyQueue.push(run);
      }
      this.kickCopies();
      return;
    }
    let ok = 0;
    const pending = [...runs];
    while (ok < need && pending.length > 0) {
      const run = pending.shift()!;
      try {
        await run();
        ok += 1;
      } catch {
        // 这一份失败就试下一份。
      }
    }
    for (const run of pending) {
      this.copyQueue.push(run);
    }
    this.kickCopies();
    if (ok < need) {
      throw new DLevelDBError('QUORUM_FAILED', `write quorum needs ${need} more copies, got ${ok}`);
    }
  }

  private kickCopies(): void {
    if (this.copyScheduled || this.closed) {
      return;
    }
    this.copyScheduled = true;
    setImmediate(() => {
      this.copyScheduled = false;
      if (this.closed || this.copyActive || this.copyQueue.length === 0) {
        return;
      }
      const run = this.copyQueue.shift()!;
      this.copyActive = true;
      void run()
        .catch(() => undefined)
        .finally(() => {
          this.copyActive = false;
          this.kickCopies();
        });
    });
  }

  async deleteAsPrimary(key: string, prefs = this.prefs(key)): Promise<boolean> {
    const primary = prefs[0];
    if (!primary || !this.shardById.has(primary.id)) {
      throw new DLevelDBError('NOT_PRIMARY', `this node is not primary for ${key}`);
    }
    const shard = this.shardById.get(primary.id)!;
    const deleted = await shard.store.delete(key);
    for (const other of this.shards) {
      if (other.info.id !== primary.id) {
        await other.store.delete(key);
      }
    }
    const n = this.effectiveN();
    if (n <= 1) {
      return deleted;
    }
    if (this.flushEachWrite) {
      await shard.store.flush();
    }
    const followers = prefs.slice(1, n);
    await this.copiesUntil(
      followers.map((vnode) => () => this.replicateDelete(vnode, primary.id, key)),
      followers.length,
    );
    return deleted;
  }

  /** Primary is down. The first live preference node deletes the key on W live copies. */
  async deleteWhilePrimaryDown(key: string, prefs = this.prefs(key), forwarded = false): Promise<boolean> {
    const live: VnodeInfo[] = [];
    for (const vnode of prefs) {
      if (this.isLocal(vnode.address) || (await this.transport.ping(vnode.address))) {
        live.push(vnode);
      }
    }
    const coordinator = live[0];
    if (!coordinator) {
      throw new DLevelDBError('PRIMARY_UNAVAILABLE', 'no live replica');
    }
    if (!this.isLocal(coordinator.address)) {
      if (forwarded) {
        throw new DLevelDBError('NOT_PRIMARY', 'not the failover coordinator');
      }
      await this.transport.proxyFailoverDelete(coordinator.address, key);
      return true;
    }
    const owner = prefs[0]?.id;
    if (!owner) {
      throw new DLevelDBError('PRIMARY_UNAVAILABLE', 'empty preference list');
    }
    await this.replicateDelete(coordinator, owner, key);
    const rest = live.slice(1).map((vnode) => () => this.replicateDelete(vnode, owner, key));
    await this.copiesUntil(rest, this.writeQuorum() - 1);
    return true;
  }

  async replicateLocalPut(ownerVnodeId: string, key: string, value: Buffer, mtimeMs?: number): Promise<void> {
    const stamp = mtimeMs ?? Date.now();
    const store = this.ownsPrimary(ownerVnodeId)
      ? this.shardById.get(ownerVnodeId)!.store
      : await this.replicas.open(ownerVnodeId);
    store.putIfNewer(key, value, stamp);
    if (this.flushEachWrite && this.effectiveN() > 1) {
      await store.flush();
    }
  }

  async replicateLocalDelete(ownerVnodeId: string, key: string): Promise<boolean> {
    let deleted = false;
    for (const shard of this.shards) {
      if (await shard.store.delete(key)) {
        deleted = true;
      }
    }
    const store = await this.replicas.open(ownerVnodeId);
    if (await store.delete(key)) {
      deleted = true;
    }
    if (this.flushEachWrite && this.effectiveN() > 1) {
      await store.flush();
    }
    return deleted;
  }

  async localPrimaryGet(key: string, vnodeId: string): Promise<KVValue | null> {
    const shard = this.shardById.get(vnodeId);
    if (shard) {
      return shard.store.get(key);
    }
    return null;
  }

  async localPrimaryHead(key: string, vnodeId: string): Promise<KVMeta | null> {
    const shard = this.shardById.get(vnodeId);
    if (shard) {
      return shard.store.head(key);
    }
    return null;
  }

  async localReplicaGet(key: string, ownerVnodeId: string): Promise<KVValue | null> {
    const store = await this.replicas.get(ownerVnodeId);
    return store ? store.get(key) : null;
  }

  async localReplicaHead(key: string, ownerVnodeId: string): Promise<KVMeta | null> {
    const store = await this.replicas.get(ownerVnodeId);
    return store ? store.head(key) : null;
  }

  async localAnyGet(key: string): Promise<KVValue | null> {
    let best: KVValue | null = null;
    for (const shard of this.shards) {
      best = preferValue(best, await shard.store.get(key));
    }
    await this.replicas.discover();
    for (const id of this.replicas.ids()) {
      best = preferValue(best, await this.localReplicaGet(key, id));
    }
    return best;
  }

  async localAnyHead(key: string): Promise<KVMeta | null> {
    let best: KVMeta | null = null;
    for (const shard of this.shards) {
      best = preferMeta(best, await shard.store.head(key));
    }
    await this.replicas.discover();
    for (const id of this.replicas.ids()) {
      best = preferMeta(best, await this.localReplicaHead(key, id));
    }
    return best;
  }

  ownsPrimary(vnodeId: string): boolean {
    return this.shardById.has(vnodeId);
  }

  private async readValue(key: string, headOnly: boolean): Promise<KVValue | null> {
    // Look at every local primary shard and replica store first. After the
    // original primary is evicted, this node may have been promoted, but the
    // bytes still live under data/replicas/{old-owner}/, not the new shard.
    if (headOnly) {
      const meta = await this.localAnyHead(key);
      if (meta) {
        return { ...meta, value: Buffer.alloc(0) };
      }
    } else {
      const found = await this.localAnyGet(key);
      if (found) {
        return found;
      }
    }

    const tried = new Set<string>([this.config.advertiseAddr]);
    const seen = new Set<string>();
    const candidates: VnodeInfo[] = [];
    for (const vnode of [...this.prefs(key), ...this.ring.sortedKnown()]) {
      if (seen.has(vnode.address)) {
        continue;
      }
      seen.add(vnode.address);
      candidates.push(vnode);
    }

    for (const vnode of candidates) {
      if (tried.has(vnode.address)) {
        continue;
      }
      tried.add(vnode.address);
      try {
        if (headOnly) {
          const meta = await this.transport.proxyHeadAny(vnode.address, key);
          if (meta) {
            return { ...meta, value: Buffer.alloc(0) };
          }
          continue;
        }
        const found = await this.transport.proxyGetAny(vnode.address, key);
        if (found) {
          return found;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private writeUnchecked(key: string, value: Buffer, mtimeMs: number, owner: VnodeInfo | undefined): void {
    if (owner && this.shardById.has(owner.id)) {
      this.shardById.get(owner.id)!.store.putUnchecked(key, value, mtimeMs);
      return;
    }
    const shard = this.shards[0];
    if (!shard) {
      throw new DLevelDBError('PRIMARY_UNAVAILABLE', 'no local shard');
    }
    shard.store.putUnchecked(key, value, mtimeMs);
  }

  private writeLocal(key: string, value: Buffer, mtimeMs: number, owner: VnodeInfo | undefined): Promise<void> {
    if (owner && this.shardById.has(owner.id)) {
      return this.shardById.get(owner.id)!.store.joinPut(key, value, mtimeMs);
    }
    const shard = this.shards[0];
    if (!shard) {
      throw new DLevelDBError('PRIMARY_UNAVAILABLE', 'no local shard');
    }
    return shard.store.joinPut(key, value, mtimeMs);
  }

  /** 环上除本进程以外的索引。确认写完本机之后，这些副本进队列。 */
  private syncTargets(): VnodeInfo[] {
    const seen = new Set<string>();
    const targets: VnodeInfo[] = [];
    for (const vnode of this.ring.sortedKnown()) {
      if (this.isLocal(vnode.address) || seen.has(vnode.address)) {
        continue;
      }
      seen.add(vnode.address);
      targets.push(vnode);
    }
    return targets;
  }

  private async replicatePut(vnode: VnodeInfo, ownerVnodeId: string, key: string, value: Buffer, mtimeMs = Date.now()): Promise<void> {
    if (this.isLocal(vnode.address)) {
      await this.replicateLocalPut(ownerVnodeId, key, value, mtimeMs);
      return;
    }
    await this.transport.replicatePut(vnode.address, ownerVnodeId, key, value, mtimeMs);
  }

  private async replicateDelete(vnode: VnodeInfo, ownerVnodeId: string, key: string): Promise<void> {
    if (this.isLocal(vnode.address)) {
      await this.replicateLocalDelete(ownerVnodeId, key);
      return;
    }
    await this.transport.replicateDelete(vnode.address, ownerVnodeId, key);
  }

  private prefs(key: string): VnodeInfo[] {
    return this.ring.preferenceList(hashKey(key), this.effectiveN());
  }

  private isLocal(address: string): boolean {
    return address === this.config.advertiseAddr;
  }

  private scanTargets(): string[] {
    const addrs = new Set<string>([this.config.advertiseAddr, ...this.config.peers, ...this.ring.physicalAddresses()]);
    return [...addrs];
  }

  private async joinWithRetry(peers: string[]): Promise<void> {
    if (this.joining) {
      return;
    }
    this.joining = true;
    const delays = [200, 500, 1000, 2000, 2000, 5000];
    let attempt = 0;
    while (!this.closed) {
      for (const peer of peers) {
        try {
          await this.ring.join(peer);
          await this.ring.stabilize();
          void this.repairOnJoin().catch(() => undefined);
          this.joining = false;
          return;
        } catch {
          // try next peer
        }
      }
      if (this.closed) {
        break;
      }
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 5000;
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /** Copy one page of keys this node is responsible for from one live peer. */
  async repairOnJoin(): Promise<void> {
    if (this.repairing || this.closed) {
      return;
    }
    this.repairing = true;
    try {
      const remotes = this.scanTargets().filter((addr) => !this.isLocal(addr));
      if (remotes.length === 0) {
        return;
      }
      const addr = remotes[this.repairPeer % remotes.length]!;
      this.repairPeer += 1;
      if (!(await this.transport.ping(addr))) {
        return;
      }
      const vnodeIds = this.ring.sortedKnown().map((vnode) => vnode.id);
      await this.repairFrom(addr, vnodeIds);
    } catch {
      // This peer can be down. Another live peer still has the copies.
    } finally {
      this.repairing = false;
    }
  }

  private repairing = false;
  private repairPeer = 0;
  private repairSegment = 0;
  private readonly repairAfter = new Map<string, string>();

  private primaryUnreachable(err: unknown): boolean {
    return err instanceof DLevelDBError && (err.code === 'PRIMARY_UNAVAILABLE' || err.code === 'TIMEOUT');
  }

  private async repairFrom(addr: string, vnodeIds: string[]): Promise<void> {
    const pageSize = 200;
    const primary = this.repairSegment % 2 === 0;
    this.repairSegment += 1;
    const cursorKey = `${addr}:${primary ? 'primary' : 'replica'}`;
    const startAfter = this.repairAfter.get(cursorKey);
    const page = primary
      ? await this.transport.proxyScan(addr, { maxKeys: pageSize, startAfter })
      : vnodeIds.length > 0
        ? await this.transport.proxyScanReplica(addr, vnodeIds, { maxKeys: pageSize, startAfter })
        : { objects: [], truncated: false };
    const last = page.objects[page.objects.length - 1]?.key;
    if (page.truncated && last) {
      this.repairAfter.set(cursorKey, last);
    } else {
      this.repairAfter.delete(cursorKey);
    }
    for (const entry of page.objects) {
        const prefs = this.prefs(entry.key);
        const owner = prefs[0];
        if (!owner || !prefs.some((vnode) => this.isLocal(vnode.address))) {
          continue;
        }
        const remote = await this.transport.proxyGetAny(addr, entry.key);
        if (!remote) {
          continue;
        }
        const local = await this.localAnyGet(entry.key);
        if (local && local.mtimeMs >= remote.mtimeMs) {
          continue;
        }
        if (this.ownsPrimary(owner.id)) {
          const shard = this.shardById.get(owner.id);
          if (shard) {
            await shard.store.put(entry.key, remote.value, remote.mtimeMs);
          }
        } else {
          await this.replicateLocalPut(owner.id, entry.key, remote.value, remote.mtimeMs);
        }
    }
  }
}
