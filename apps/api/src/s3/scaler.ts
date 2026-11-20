import { spawn } from 'node:child_process';
import type { IndexClient } from '@s3dfs/control';
import {
  apiStopAllowed,
  blockStopAllowed,
  decideScale,
  indexStopAllowed,
  type ScaleConfig,
  type ScaleLoads,
  type ScaleRole,
} from '@s3dfs/control';

export interface ScaleMemory {
  streak: Record<ScaleRole, number>;
  lastActionMs: Record<ScaleRole, number>;
  extraIndex: number;
  extraApi: number;
  draining: null | { role: ScaleRole; nodeId: string; address: string };
}

export function emptyScaleMemory(): ScaleMemory {
  return {
    streak: { index: 0, block: 0, api: 0 },
    lastActionMs: { index: 0, block: 0, api: 0 },
    extraIndex: 0,
    extraApi: 0,
    draining: null,
  };
}

const LEASE_KEY = '$scale/lease';

export async function acquireScaleLease(
  kv: Pick<IndexClient, 'get' | 'put'>,
  owner: string,
  now: number,
  ttlMs: number,
): Promise<boolean> {
  const current = await kv.get(LEASE_KEY);
  if (current) {
    const held = JSON.parse(current.value.toString('utf8')) as { owner?: string; untilMs?: number };
    if (held.owner && held.owner !== owner && (held.untilMs ?? 0) > now) {
      return false;
    }
  }
  await kv.put(LEASE_KEY, Buffer.from(JSON.stringify({ owner, untilMs: now + ttlMs })));
  const again = await kv.get(LEASE_KEY);
  if (!again) {
    return false;
  }
  const held = JSON.parse(again.value.toString('utf8')) as { owner?: string };
  return held.owner === owner;
}

export interface BlockCandidate {
  nodeId: string;
  address: string;
  zone?: string;
  locators: number;
}

export async function scaleTick(input: {
  now: number;
  config: ScaleConfig;
  loads: ScaleLoads;
  memory: ScaleMemory;
  upCmd?: string;
  downCmd?: string;
  hook: (cmd: string, env: Record<string, string>) => Promise<number>;
  baseIndexNodes: number;
  baseApiNodes: number;
  strict: boolean;
  writeQuorum: number;
  blocks: BlockCandidate[];
  indexReady: boolean;
  apiInflight: number;
  apiNodeId: string;
  apiAddress: string;
}): Promise<ScaleMemory> {
  if (!input.upCmd && !input.downCmd) {
    return input.memory;
  }
  const memory: ScaleMemory = {
    ...input.memory,
    streak: { ...input.memory.streak },
    lastActionMs: { ...input.memory.lastActionMs },
  };
  const loads: ScaleLoads = {
    index: {
      ...input.loads.index,
      nodes: input.baseIndexNodes + memory.extraIndex,
      streak: memory.streak.index,
      lastActionMs: memory.lastActionMs.index,
    },
    block: {
      ...input.loads.block,
      nodes: Math.max(input.loads.block.nodes, input.blocks.length),
      streak: memory.streak.block,
      lastActionMs: memory.lastActionMs.block,
    },
    api: {
      ...input.loads.api,
      nodes: input.baseApiNodes + memory.extraApi,
      inflight: input.apiInflight,
      streak: memory.streak.api,
      lastActionMs: memory.lastActionMs.api,
    },
  };

  if (memory.draining) {
    if (await stopIfReady(input, memory, loads)) {
      memory.draining = null;
    }
    return memory;
  }

  const shrinkable = {
    index: indexStopAllowed(loads.index.nodes - 1, input.writeQuorum),
    block: input.blocks.some((node) =>
      blockStopAllowed({
        locators: 0,
        remaining: input.blocks.filter((other) => other.nodeId !== node.nodeId),
        dataReplicas: input.config.dataReplicas,
        strict: input.strict,
      }),
    ),
    api: loads.api.nodes > 1,
  };
  const decision = decideScale(loads, input.config, input.now, shrinkable);
  memory.streak = decision.streak;
  if (decision.action === 'none' || !decision.role) {
    return memory;
  }
  if (decision.action === 'up') {
    if (!input.upCmd) {
      return memory;
    }
    const code = await input.hook(input.upCmd, {
      S3DFS_SCALE_ROLE: decision.role,
      S3DFS_SCALE_REASON: decision.reason ?? 'latency',
    });
    if (code === 0) {
      memory.lastActionMs[decision.role] = input.now;
      memory.streak[decision.role] = 0;
      if (decision.role === 'index') {
        memory.extraIndex += 1;
      }
      if (decision.role === 'api') {
        memory.extraApi += 1;
      }
    }
    return memory;
  }

  const victim = chooseVictim(decision.role, input, loads);
  if (!victim) {
    return memory;
  }
  memory.draining = victim;
  if (await stopIfReady(input, memory, loads)) {
    memory.draining = null;
  }
  return memory;
}

function chooseVictim(
  role: ScaleRole,
  input: {
    config: ScaleConfig;
    strict: boolean;
    blocks: BlockCandidate[];
    apiNodeId: string;
    apiAddress: string;
  },
  loads: ScaleLoads,
): ScaleMemory['draining'] {
  if (role === 'index') {
    return { role, nodeId: `index-${loads.index.nodes}`, address: '' };
  }
  if (role === 'block') {
    const blocks = [...input.blocks].sort((a, b) => a.locators - b.locators);
    for (const node of blocks) {
      const remaining = input.blocks.filter((other) => other.nodeId !== node.nodeId);
      if (blockStopAllowed({ locators: 0, remaining, dataReplicas: input.config.dataReplicas, strict: input.strict })) {
        return { role, nodeId: node.nodeId, address: node.address };
      }
    }
    return null;
  }
  if (loads.api.nodes > 1) {
    return { role: 'api', nodeId: input.apiNodeId, address: input.apiAddress };
  }
  return null;
}

async function stopIfReady(
  input: {
    now: number;
    config: ScaleConfig;
    downCmd?: string;
    hook: (cmd: string, env: Record<string, string>) => Promise<number>;
    strict: boolean;
    writeQuorum: number;
    blocks: BlockCandidate[];
    indexReady: boolean;
    apiInflight: number;
    baseIndexNodes: number;
    baseApiNodes: number;
  },
  memory: ScaleMemory,
  loads: ScaleLoads,
): Promise<boolean> {
  const draining = memory.draining;
  if (!draining || !input.downCmd) {
    return false;
  }
  const ready =
    draining.role === 'block'
      ? blockStopAllowed({
          locators: input.blocks.find((node) => node.nodeId === draining.nodeId)?.locators ?? 1,
          remaining: input.blocks.filter((node) => node.nodeId !== draining.nodeId),
          dataReplicas: input.config.dataReplicas,
          strict: input.strict,
        })
      : draining.role === 'index'
        ? input.indexReady && indexStopAllowed(loads.index.nodes - 1, input.writeQuorum)
        : apiStopAllowed(input.apiInflight, loads.api.nodes);
  if (!ready) {
    return false;
  }
  const code = await input.hook(input.downCmd, {
    S3DFS_SCALE_ROLE: draining.role,
    S3DFS_SCALE_NODE_ID: draining.nodeId,
    S3DFS_SCALE_ADDRESS: draining.address,
  });
  if (code !== 0) {
    return false;
  }
  memory.lastActionMs[draining.role] = input.now;
  if (draining.role === 'index') {
    memory.extraIndex = Math.max(0, memory.extraIndex - 1);
  }
  if (draining.role === 'api') {
    memory.extraApi = Math.max(0, memory.extraApi - 1);
  }
  return true;
}

const STATE_KEY = '$scale/state';

export async function readScaleMemory(kv: Pick<IndexClient, 'get'>): Promise<ScaleMemory> {
  const raw = await kv.get(STATE_KEY);
  if (!raw) {
    return emptyScaleMemory();
  }
  try {
    const parsed = JSON.parse(raw.value.toString('utf8')) as Partial<ScaleMemory>;
    const blank = emptyScaleMemory();
    return {
      ...blank,
      ...parsed,
      streak: { ...blank.streak, ...parsed.streak },
      lastActionMs: { ...blank.lastActionMs, ...parsed.lastActionMs },
      draining: parsed.draining ?? null,
    };
  } catch {
    return emptyScaleMemory();
  }
}

export async function writeScaleMemory(kv: Pick<IndexClient, 'put'>, memory: ScaleMemory): Promise<void> {
  await kv.put(STATE_KEY, Buffer.from(JSON.stringify(memory)));
}

export function percentile99(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.99) - 1))] ?? 0;
}

export function runScaleCommand(cmd: string, env: Record<string, string>, timeoutMs = 30_000): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      env: { ...process.env, ...env },
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(1);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(1);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}
