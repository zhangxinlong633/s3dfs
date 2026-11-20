export type ScaleRole = 'index' | 'block' | 'api';
export type ScaleReason = 'capacity' | 'latency';

export interface ScaleConfig {
  highRatio: number;
  lowRatio: number;
  highLatencyMs: number;
  lowLatencyMs: number;
  highStreak: number;
  cooldownMs: number;
  blockCapacityBytes?: number;
  indexCapacityBytes?: number;
  indexMaxKeys: number;
  apiMaxInflight: number;
  dataReplicas: number;
}

export interface RoleLoad {
  keys: number;
  bytes: number;
  inflight: number;
  latencyP99Ms: number;
  nodes: number;
  streak: number;
  lastActionMs: number;
}

export interface ScaleLoads {
  index: RoleLoad;
  block: RoleLoad;
  api: RoleLoad;
}

export interface ScaleDecision {
  action: 'none' | 'up' | 'down';
  role?: ScaleRole;
  reason?: ScaleReason;
  streak: Record<ScaleRole, number>;
}

const ORDER: ScaleRole[] = ['index', 'block', 'api'];

export function loadScaleConfig(env: NodeJS.ProcessEnv = process.env): ScaleConfig {
  const optional = (name: string) => {
    const raw = env[name];
    if (!raw) {
      return undefined;
    }
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  return {
    highRatio: Number(env.S3DFS_SCALE_HIGH_RATIO ?? 0.8),
    lowRatio: Number(env.S3DFS_SCALE_LOW_RATIO ?? 0.4),
    highLatencyMs: Number(env.S3DFS_SCALE_HIGH_LATENCY_MS ?? 200),
    lowLatencyMs: Number(env.S3DFS_SCALE_LOW_LATENCY_MS ?? 50),
    highStreak: Math.max(1, Number(env.S3DFS_SCALE_HIGH_STREAK ?? 3) || 3),
    cooldownMs: Number(env.S3DFS_SCALE_COOLDOWN_MS ?? 300_000),
    blockCapacityBytes: optional('S3DFS_BLOCK_CAPACITY_BYTES'),
    indexCapacityBytes: optional('S3DFS_INDEX_CAPACITY_BYTES'),
    indexMaxKeys: Number(env.S3DFS_INDEX_MAX_KEYS ?? 100_000_000),
    apiMaxInflight: Math.max(1, Number(env.S3DFS_API_MAX_INFLIGHT ?? 128) || 128),
    dataReplicas: Math.max(1, Number(env.S3DFS_DATA_REPLICAS ?? 3) || 3),
  };
}

export function decideScale(
  loads: ScaleLoads,
  cfg: ScaleConfig,
  now: number,
  shrinkable: Record<ScaleRole, boolean> = { index: true, block: true, api: true },
): ScaleDecision {
  const streak: Record<ScaleRole, number> = {
    index: loads.index.streak,
    block: loads.block.streak,
    api: loads.api.streak,
  };
  for (const role of ORDER) {
    const sample = loads[role];
    const view = pressure(role, sample, cfg);
    streak[role] = view.high ? sample.streak + 1 : 0;
    const cooled = sample.lastActionMs === 0 || now - sample.lastActionMs >= cfg.cooldownMs;
    if (!cooled) {
      continue;
    }
    if (view.high && streak[role] >= cfg.highStreak) {
      return { action: 'up', role, reason: view.reason, streak };
    }
    if (view.low && shrinkable[role]) {
      return { action: 'down', role, streak };
    }
  }
  return { action: 'none', streak };
}

function pressure(role: ScaleRole, sample: RoleLoad, cfg: ScaleConfig): { high: boolean; low: boolean; reason: ScaleReason } {
  const latencyHigh = sample.latencyP99Ms >= cfg.highLatencyMs;
  const latencyLow = sample.latencyP99Ms < cfg.lowLatencyMs;
  const nodes = Math.max(1, sample.nodes);
  let capacityHigh = false;
  let capacityLow = true;
  if (role === 'block' && cfg.blockCapacityBytes) {
    const ratio = sample.bytes / (cfg.blockCapacityBytes * nodes);
    capacityHigh = ratio >= cfg.highRatio;
    capacityLow = ratio < cfg.lowRatio;
  } else if (role === 'index') {
    const keyHigh = sample.keys >= cfg.indexMaxKeys;
    const keyLow = cfg.indexMaxKeys > 0 && sample.keys / cfg.indexMaxKeys < cfg.lowRatio;
    if (cfg.indexCapacityBytes) {
      const ratio = sample.bytes / (cfg.indexCapacityBytes * nodes);
      capacityHigh = keyHigh || ratio >= cfg.highRatio;
      capacityLow = keyLow && ratio < cfg.lowRatio;
    } else {
      capacityHigh = keyHigh;
      capacityLow = keyLow;
    }
  } else if (role === 'api') {
    const ratio = sample.inflight / cfg.apiMaxInflight;
    capacityHigh = ratio >= cfg.highRatio;
    capacityLow = ratio < cfg.lowRatio;
  }
  return {
    high: capacityHigh || latencyHigh,
    low: capacityLow && latencyLow,
    reason: capacityHigh ? 'capacity' : 'latency',
  };
}

export function blockStopAllowed(input: {
  locators: number;
  remaining: { zone?: string }[];
  dataReplicas: number;
  strict: boolean;
}): boolean {
  if (input.locators > 0 || input.remaining.length < input.dataReplicas) {
    return false;
  }
  if (!input.strict || input.dataReplicas <= 1) {
    return true;
  }
  if (input.remaining.some((node) => !node.zone)) {
    return false;
  }
  return new Set(input.remaining.map((node) => node.zone)).size >= input.dataReplicas;
}

export function indexStopAllowed(remaining: number, writeQuorum: number): boolean {
  return remaining >= 3 && remaining >= writeQuorum;
}

export function apiStopAllowed(inflight: number, nodes: number): boolean {
  return inflight === 0 && nodes > 1;
}
