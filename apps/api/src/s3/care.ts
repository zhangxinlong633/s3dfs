export interface CareIncident {
  id: string;
  time: string;
  severity: 'action_needed' | 'recovered';
  symptom: string;
  tried: string[];
  doNot: string[];
  next: string[];
  docs: string[];
  contact: string;
  url: string;
  reason: string;
  scope: string;
  text: string;
}

interface OpenCare {
  id: string;
  delivered: boolean;
  incident: CareIncident;
}

export interface CareState {
  open: Record<string, OpenCare>;
  drainingSince: Record<string, number>;
}

export function emptyCareState(): CareState {
  return { open: {}, drainingSince: {} };
}

export interface CareInput {
  now: number;
  indexOk: boolean;
  layoutOk: boolean;
  strict: boolean;
  lost: number;
  buckets: string[];
  draining: null | { role: string; nodeId: string };
  cooldownMs: number;
  contact: string;
  publicBase: string;
  tried: string[];
}

interface Problem {
  key: string;
  reason: string;
  scope: string;
  buckets: string[];
}

export function reviewCare(state: CareState, input: CareInput): { state: CareState; pending: CareIncident[] } {
  const next: CareState = {
    open: { ...state.open },
    drainingSince: { ...state.drainingSince },
  };
  if (input.draining) {
    next.drainingSince[input.draining.nodeId] ??= input.now;
  }
  const active = problems(input, next);
  const activeKeys = new Set(active.map((item) => item.key));
  const pending: CareIncident[] = [];
  for (const problem of active) {
    const existing = next.open[problem.key];
    if (!existing) {
      const incident = buildIncident(problem, input, 'action_needed');
      next.open[problem.key] = { id: incident.id, delivered: false, incident };
      pending.push(incident);
      continue;
    }
    if (!existing.delivered) {
      pending.push(existing.incident);
    }
  }
  for (const key of Object.keys(next.open)) {
    if (activeKeys.has(key)) {
      continue;
    }
    const previous = next.open[key]!;
    pending.push({
      ...previous.incident,
      severity: 'recovered',
      time: new Date(input.now).toISOString(),
      symptom: `${previous.incident.symptom} 已经恢复。`,
      text: humanText({
        ...previous.incident,
        severity: 'recovered',
        symptom: `${previous.incident.symptom} 已经恢复。`,
      }),
    });
    delete next.open[key];
  }
  for (const nodeId of Object.keys(next.drainingSince)) {
    if (input.draining?.nodeId !== nodeId) {
      delete next.drainingSince[nodeId];
    }
  }
  return { state: next, pending };
}

export async function deliverCare(
  incident: CareIncident,
  opts: {
    alertUrl?: string;
    webhookUrls?: string[];
    post: (url: string, body: string) => Promise<boolean>;
    log: (line: string) => void;
  },
): Promise<boolean> {
  if (!opts.alertUrl) {
    opts.log(incident.text);
    return false;
  }
  const body = JSON.stringify({ text: incident.text, ai: incident });
  const alertOk = await opts.post(opts.alertUrl, body);
  let hooksOk = true;
  for (const url of opts.webhookUrls ?? []) {
    hooksOk = (await opts.post(url, body)) && hooksOk;
  }
  return alertOk && hooksOk;
}

export function markCareDelivered(state: CareState, id: string): CareState {
  const open = { ...state.open };
  for (const [key, item] of Object.entries(open)) {
    if (item.id === id && item.incident.severity === 'action_needed') {
      open[key] = { ...item, delivered: true };
    }
  }
  return { ...state, open };
}

function problems(input: CareInput, state: CareState): Problem[] {
  const found: Problem[] = [];
  if (!input.indexOk) {
    found.push({ key: 'index_down:cluster', reason: 'index_down', scope: 'cluster', buckets: [] });
  }
  if (input.strict && !input.layoutOk) {
    found.push({ key: 'layout:cluster', reason: 'layout', scope: 'cluster', buckets: [] });
  }
  if (input.lost > 0) {
    if (input.buckets.length === 0) {
      found.push({ key: 'lost:cluster', reason: 'lost', scope: 'cluster', buckets: [] });
    } else {
      for (const bucket of input.buckets) {
        found.push({ key: `lost:${bucket}`, reason: 'lost', scope: bucket, buckets: [bucket] });
      }
    }
  }
  if (input.draining) {
    const since = state.drainingSince[input.draining.nodeId] ?? input.now;
    if (input.now - since >= input.cooldownMs) {
      found.push({
        key: `draining:${input.draining.nodeId}`,
        reason: 'draining',
        scope: input.draining.nodeId,
        buckets: [],
      });
    }
  }
  return found;
}

function buildIncident(problem: Problem, input: CareInput, severity: CareIncident['severity']): CareIncident {
  const id = `${problem.key}:${input.now}`;
  const incident: CareIncident = {
    id,
    time: new Date(input.now).toISOString(),
    severity,
    symptom: symptomOf(problem, input),
    tried: input.tried,
    doNot: doNotOf(problem.reason),
    next: nextOf(problem.reason),
    docs: ['docs/design-recovery.md', 'docs/diff/production.md', 'docs/superpowers/specs/2026-11-20-care-design.md'],
    contact: input.contact,
    url: `${input.publicBase.replace(/\/$/, '')}/_s3dfs/incidents/${encodeURIComponent(id)}`,
    reason: problem.reason,
    scope: problem.scope,
    text: '',
  };
  incident.text = humanText(incident);
  return incident;
}

function symptomOf(problem: Problem, input: CareInput): string {
  if (problem.reason === 'index_down') {
    return '索引不可达，健康检查会返回 503。';
  }
  if (problem.reason === 'layout') {
    return '严格布局不成立，健康检查会返回 503。';
  }
  if (problem.reason === 'lost') {
    return `有 ${input.lost} 个对象已经没有活副本。`;
  }
  return `节点 ${problem.scope} 仍在排空，数据还没有迁走。`;
}

function doNotOf(reason: string): string[] {
  if (reason === 'lost') {
    return ['没有活副本的对象不能靠修复补回来。不要重复执行 repair 来期待这些对象重新出现。'];
  }
  if (reason === 'draining') {
    return ['不要把仍在排空的节点放回可写集合，除非确认没有 locator 再指向它。'];
  }
  return ['不要在索引或布局恢复之前把新的写入当成已经持久化。'];
}

function nextOf(reason: string): string[] {
  if (reason === 'lost') {
    return ['查看 GET /_s3dfs/health 里的 lost。', '从剩余副本确认对象是否还在。', '联系 S3DFS_SUPPORT_CONTACT 里的人确认是否接受数据丢失。'];
  }
  if (reason === 'layout') {
    return ['查看健康检查里的 reasons。', '补齐 block 节点和 @zone，使故障域不少于副本数。'];
  }
  if (reason === 'draining') {
    return ['查看该节点上是否还有 locator。', '确认修复任务仍在运行。', '迁不走时联系支持人员决定是否保留该节点。'];
  }
  return ['检查每个索引地址的 /_dleveldb/cluster。', '确认剩余索引节点仍达到法定人数。', '把这份 JSON 交给负责索引的人，或交给能读仓库的 AI。'];
}

function humanText(incident: CareIncident): string {
  return [
    incident.severity === 'recovered' ? 's3dfs 故障已恢复。' : 's3dfs 有一项故障没能自动修好。',
    incident.symptom,
    `影响范围：${incident.scope}。`,
    `已经做过：${incident.tried.join('；') || '无'}。`,
    `还没好的原因：${incident.doNot.join('')}`,
    `怎么找人：${incident.contact || '未配置 S3DFS_SUPPORT_CONTACT'}。`,
    `详情：${incident.url}`,
  ].join('\n');
}
