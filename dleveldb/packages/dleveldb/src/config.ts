import type { DLevelDBConfig } from './types.js';

export function majority(n: number): number {
  if (n <= 0) {
    return 0;
  }
  return Math.floor(n / 2) + 1;
}

/** 有效副本数不能超过不同物理机数量；单机时恒为 1。 */
export function effectiveReplicas(configuredN: number, physicalNodes: number): number {
  const n = Math.max(1, configuredN);
  const p = Math.max(1, physicalNodes);
  return Math.min(n, p);
}

/** 未显式配置时，写法定人数取有效 N 的多数。 */
export function effectiveWriteQuorum(configuredW: number | undefined, effectiveN: number): number {
  if (effectiveN <= 0) {
    return 0;
  }
  if (configuredW === undefined || Number.isNaN(configuredW)) {
    return majority(effectiveN);
  }
  const w = Math.max(1, Math.floor(configuredW));
  return Math.min(w, effectiveN);
}

export function parsePeerList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const addr = part.trim();
    if (!addr || seen.has(addr)) {
      continue;
    }
    seen.add(addr);
    out.push(addr);
  }
  return out;
}

function envFirst(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<DLevelDBConfig> = {}): DLevelDBConfig {
  const port = Number(envFirst(env, 'DLEVELDB_PORT', 'S3DFS_API_PORT') ?? 9000);
  const advertiseAddr = overrides.advertiseAddr ?? envFirst(env, 'DLEVELDB_ADVERTISE_ADDR', 'S3DFS_ADVERTISE_ADDR') ?? `127.0.0.1:${port}`;
  const configuredPeers = parsePeerList(overrides.peers ? overrides.peers.join(',') : envFirst(env, 'DLEVELDB_PEERS', 'S3DFS_PEERS'));
  const peers = configuredPeers.filter((p) => p !== advertiseAddr);

  const vnodeCount = overrides.vnodeCount ?? Math.max(1, Number(envFirst(env, 'DLEVELDB_VNODES', 'S3DFS_VNODES') ?? 1) || 1);
  const replicas = overrides.replicas ?? Math.max(1, Number(envFirst(env, 'DLEVELDB_REPLICAS', 'S3DFS_REPLICAS') ?? 3) || 3);
  const quorumRaw = envFirst(env, 'DLEVELDB_WRITE_QUORUM', 'S3DFS_WRITE_QUORUM');
  const writeQuorum =
    overrides.writeQuorum ??
    (quorumRaw === undefined ? undefined : Math.max(1, Number(quorumRaw) || 1));

  const syncRaw = envFirst(env, 'DLEVELDB_SYNC');
  const syncOff = new Set(['0', 'false', 'no', 'off']);
  const sync =
    overrides.sync ??
    overrides.fsyncOnFlush ??
    (syncRaw === undefined ? false : !syncOff.has(syncRaw.toLowerCase()));
  const intervalRaw = envFirst(env, 'DLEVELDB_SYNC_INTERVAL_MS');
  const syncIntervalMs = sync
    ? 0
    : (overrides.syncIntervalMs ??
      (intervalRaw === undefined ? 1000 : Math.max(0, Number(intervalRaw) || 0)));

  return {
    dataDir: overrides.dataDir ?? envFirst(env, 'DLEVELDB_DATA_DIR', 'S3DFS_DATA_DIR') ?? './data',
    nodeId: overrides.nodeId ?? envFirst(env, 'DLEVELDB_NODE_ID', 'S3DFS_NODE_ID') ?? 'node1',
    advertiseAddr,
    peers,
    vnodeCount,
    replicas,
    writeQuorum,
    sync,
    syncIntervalMs,
    fsyncOnFlush: sync,
    stabilizeIntervalMs:
      overrides.stabilizeIntervalMs ?? (Number(envFirst(env, 'DLEVELDB_STABILIZE_INTERVAL_MS', 'S3DFS_STABILIZE_INTERVAL_MS') ?? 500) || 500),
    rpcTimeoutMs: overrides.rpcTimeoutMs ?? (Number(envFirst(env, 'DLEVELDB_RPC_TIMEOUT_MS', 'S3DFS_RPC_TIMEOUT_MS') ?? 10000) || 10000),
  };
}
