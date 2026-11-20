export type PatrolModule = 'index' | 'block' | 'layout' | 'repair' | 'api' | 'scale' | 'care';
export type PatrolAction = 'repair' | 'compact' | 'flush' | 'scale_up' | 'note';

export interface BlockView {
  nodeId: string;
  up: boolean;
  zone?: string;
  bytesOnDisk: number;
  deadBytes: number;
  locators: number;
  draining: boolean;
  unflushedBytes: number;
}

export interface PatrolSnapshot {
  now: number;
  index: { ok: boolean; keys: number; latencyP99Ms: number; copiesMatch: boolean };
  block: { nodes: BlockView[] };
  layout: { ok: boolean; strict: boolean; dataReplicas: number; liveBlocks: number; failureDomains: number };
  repair: { lost: number; shortCopies: number };
  api: { inflight: number; latencyP99Ms: number; maxInflight: number };
  scale: {
    wants: 'up' | 'down' | 'none';
    upConfigured: boolean;
    streak: number;
    highStreak: number;
    lastActionMs: number;
    cooldownMs: number;
    draining: boolean;
  };
  care: { open: number };
  compactDeadRatio: number;
  highLatencyMs: number;
  truncated?: boolean;
}

export interface PatrolFinding {
  module: PatrolModule;
  metric: string;
  value: number;
  threshold: number;
  over: boolean;
}

export interface PatrolDecision {
  id: string;
  module: PatrolModule;
  metric: string;
  value: number;
  threshold: number;
  action: PatrolAction;
  benefit: string;
  apply: boolean;
  summary: string;
}

export interface PatrolReport {
  findings: PatrolFinding[];
  decisions: PatrolDecision[];
  apply: Array<'repair' | 'compact' | 'flush' | 'scale_up'>;
  summary: string;
  truncated: boolean;
}

const SNAPSHOT_BYTES = 8192;
const MIN_MODEL_PARAMS = 26_000_000_000;
const APPLY_ORDER = ['repair', 'compact', 'flush', 'scale_up'] as const;

export function patrolAuthorized(header: string | undefined, env: NodeJS.ProcessEnv): boolean {
  const token = env.S3DFS_PATROL_TOKEN;
  return Boolean(token) && header === token;
}

/** Unset means the operator asserts the configured model is at least 26B. */
export function modelAllowed(params: number | undefined, min = MIN_MODEL_PARAMS): boolean {
  return params === undefined || params >= min;
}

export function compactSnapshot(snapshot: PatrolSnapshot, maxBytes = SNAPSHOT_BYTES): PatrolSnapshot {
  let nodes = snapshot.block.nodes;
  let packed: PatrolSnapshot = { ...snapshot, block: { nodes }, truncated: false };
  while (Buffer.byteLength(JSON.stringify(packed)) > maxBytes && nodes.length > 1) {
    nodes = nodes.slice(0, nodes.length - 1);
    packed = { ...snapshot, block: { nodes }, truncated: true };
  }
  return packed;
}

function finding(module: PatrolModule, metric: string, value: number, threshold: number, over: boolean): PatrolFinding {
  return { module, metric, value, threshold, over };
}

function decision(
  snapshot: PatrolSnapshot,
  item: PatrolFinding,
  action: PatrolAction,
  apply: boolean,
  benefit: string,
  summary: string,
): PatrolDecision {
  return {
    id: `${action}:${item.module}:${item.metric}:${snapshot.now}`,
    module: item.module,
    metric: item.metric,
    value: item.value,
    threshold: item.threshold,
    action,
    benefit,
    apply,
    summary,
  };
}

export function reviewPatrol(snapshot: PatrolSnapshot): PatrolReport {
  const findings: PatrolFinding[] = [
    finding('index', 'ok', snapshot.index.ok ? 1 : 0, 1, !snapshot.index.ok),
    finding('index', 'copiesMatch', snapshot.index.copiesMatch ? 1 : 0, 1, !snapshot.index.copiesMatch),
    finding('index', 'latencyP99Ms', snapshot.index.latencyP99Ms, snapshot.highLatencyMs, snapshot.index.latencyP99Ms > snapshot.highLatencyMs),
    finding('index', 'keys', snapshot.index.keys, 0, false),
    finding('layout', 'ok', snapshot.layout.ok ? 1 : 0, 1, snapshot.layout.strict && !snapshot.layout.ok),
    finding('layout', 'liveBlocks', snapshot.layout.liveBlocks, snapshot.layout.dataReplicas, snapshot.layout.strict && snapshot.layout.liveBlocks < snapshot.layout.dataReplicas),
    finding('layout', 'failureDomains', snapshot.layout.failureDomains, snapshot.layout.dataReplicas, snapshot.layout.strict && snapshot.layout.dataReplicas > 1 && snapshot.layout.failureDomains < snapshot.layout.dataReplicas),
    finding('repair', 'shortCopies', snapshot.repair.shortCopies, 0, snapshot.repair.shortCopies > 0),
    finding('repair', 'lost', snapshot.repair.lost, 0, snapshot.repair.lost > 0),
    finding('api', 'inflight', snapshot.api.inflight, snapshot.api.maxInflight, snapshot.api.inflight >= snapshot.api.maxInflight),
    finding('api', 'latencyP99Ms', snapshot.api.latencyP99Ms, snapshot.highLatencyMs, snapshot.api.latencyP99Ms > snapshot.highLatencyMs),
    finding('scale', 'streak', snapshot.scale.streak, snapshot.scale.highStreak, snapshot.scale.streak >= snapshot.scale.highStreak),
    finding('care', 'open', snapshot.care.open, 0, snapshot.care.open > 0),
  ];
  let maxDead = 0;
  let unflushed = 0;
  for (const node of snapshot.block.nodes) {
    if (node.bytesOnDisk > 0) {
      maxDead = Math.max(maxDead, node.deadBytes / node.bytesOnDisk);
    }
    unflushed += node.unflushedBytes;
  }
  findings.push(finding('block', 'deadRatio', maxDead, snapshot.compactDeadRatio, maxDead >= snapshot.compactDeadRatio && maxDead > 0));
  findings.push(finding('block', 'unflushedBytes', unflushed, 0, unflushed > 0));

  const decisions: PatrolDecision[] = [];
  const short = findings.find((item) => item.module === 'repair' && item.metric === 'shortCopies' && item.over);
  if (short) {
    decisions.push(decision(snapshot, short, 'repair', true, '还有活副本但份数不足，修复能补齐', '活副本不足，执行副本修复'));
  }
  const lost = findings.find((item) => item.module === 'repair' && item.metric === 'lost' && item.over);
  if (lost) {
    decisions.push(decision(snapshot, lost, 'note', false, '没有活副本的对象不能靠修复补回来', '有对象没有任何活副本，不能靠修复补回'));
  }
  const holes = findings.find((item) => item.module === 'block' && item.metric === 'deadRatio' && item.over);
  if (holes) {
    decisions.push(decision(snapshot, holes, 'compact', true, '空洞比例已经超过合并阈值，compact 能收回空间', '空洞比例过高，执行 compact'));
  }
  const dirty = findings.find((item) => item.module === 'block' && item.metric === 'unflushedBytes' && item.over);
  if (dirty) {
    decisions.push(decision(snapshot, dirty, 'flush', true, '写缓冲里还有未落盘的数据', '写缓冲未落盘，执行 flush'));
  }
  const cooled = snapshot.scale.lastActionMs === 0 || snapshot.now - snapshot.scale.lastActionMs >= snapshot.scale.cooldownMs;
  if (snapshot.scale.wants === 'up' && snapshot.scale.upConfigured && cooled) {
    const streak = findings.find((item) => item.module === 'scale' && item.metric === 'streak')!;
    decisions.push(decision(snapshot, { ...streak, over: true }, 'scale_up', true, '负载连续高于阈值，并且已经配置扩容脚本', '负载持续偏高，执行扩容脚本'));
  } else if (snapshot.scale.wants === 'up') {
    const streak = findings.find((item) => item.module === 'scale' && item.metric === 'streak')!;
    decisions.push(decision(snapshot, streak, 'note', false, '负载偏高，但扩容脚本未配置或仍在冷却', '负载偏高，本次只记录'));
  }
  if (snapshot.scale.wants === 'down' || snapshot.scale.draining) {
    const streak = findings.find((item) => item.module === 'scale' && item.metric === 'streak')!;
    decisions.push(decision(snapshot, streak, 'note', false, '缩容只记录，不由巡检执行', '缩容或排空只记录，不由巡检执行'));
  }
  const layout = findings.find((item) => item.module === 'layout' && item.metric === 'ok' && item.over);
  if (layout) {
    decisions.push(decision(snapshot, layout, 'note', false, '存活节点或故障域少于副本数时，写入会继续被拒绝', '布局不满足副本要求，只记录'));
  }
  const indexDown = findings.find((item) => item.module === 'index' && item.metric === 'ok' && item.over);
  if (indexDown) {
    decisions.push(decision(snapshot, indexDown, 'note', false, '索引不可达时不新增写入', '索引不可达，只记录'));
  }
  const copies = findings.find((item) => item.module === 'index' && item.metric === 'copiesMatch' && item.over);
  if (copies) {
    decisions.push(decision(snapshot, copies, 'note', false, '索引副本内容不一致时等待 dleveldb 追平', '索引副本不一致，等待追平'));
  }
  const care = findings.find((item) => item.module === 'care' && item.metric === 'open' && item.over);
  if (care) {
    decisions.push(decision(snapshot, care, 'note', false, '未恢复的故障事件已经在告警里', `还有 ${snapshot.care.open} 条未恢复事件`));
  }

  const apply = APPLY_ORDER.filter((action) => decisions.some((item) => item.apply && item.action === action));
  const summary = decisions.length === 0 ? '各模块未越过执行阈值' : decisions.map((item) => item.summary).join('；');
  return { findings, decisions, apply: [...apply], summary, truncated: Boolean(snapshot.truncated) };
}

export async function executePatrol(
  report: PatrolReport,
  hooks: {
    repair: () => Promise<void>;
    compact: () => Promise<void>;
    flush: () => Promise<void>;
    scaleUp: () => Promise<void>;
  },
): Promise<void> {
  for (const action of report.apply) {
    if (action === 'repair') {
      await hooks.repair();
    } else if (action === 'compact') {
      await hooks.compact();
    } else if (action === 'flush') {
      await hooks.flush();
    } else if (action === 'scale_up') {
      await hooks.scaleUp();
    }
  }
}
