'use client';

import { useCallback, useEffect, useState } from 'react';

type Tone = 'ok' | 'warn' | 'bad' | 'muted';

type BlockNode = {
  nodeId: string;
  address: string;
  status: 'up' | 'down' | 'unknown';
  lastSeenMs: number;
  lastError?: string;
  zone?: string;
  draining?: boolean;
  freeBytes?: number;
  disk?: 'ok' | 'low' | 'full' | 'readonly' | 'error';
  block?: 'starting' | 'serving' | 'compacting';
  maintenanceReason?: string;
  maintenanceUntilMs?: number;
  stats?: {
    objects?: number;
    bytesOnDisk?: number;
    blockFiles?: number;
    deadBytes?: number;
    unflushedBytes?: number;
    puts?: number;
    gets?: number;
    deletes?: number;
  };
};

type Layout = {
  ok: boolean;
  strict: boolean;
  dataReplicas: number;
  liveBlocks: number;
  failureDomains: number;
  reasons: string[];
};

type Zone = { zone: string; writableBytes: number; uneven: boolean };

type Stats = {
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
  dataReplicas?: number;
  effectiveDataReplicas?: number;
  writeQuorum?: number;
  compressType?: string;
  indexUrls?: string[];
  indexOk?: boolean;
  blockNodes?: BlockNode[];
  layout?: Layout;
  lost?: number;
  zones?: Zone[];
};

type PatrolReport = {
  brief?: string;
  summary?: string;
  modelSummary?: string;
  watch?: string[];
  decisions?: { action?: string; apply?: boolean; summary?: string }[];
  findings?: { module?: string; metric?: string; value?: number; threshold?: number; over?: boolean }[];
};

type Bucket = { name: string; mtimeMs: number };

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:9000';

function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function nodeText(status: BlockNode['status']): string {
  if (status === 'up') return '在线';
  if (status === 'down') return '离线';
  return '尚未探活';
}

function diskText(disk: BlockNode['disk']): string {
  if (disk === 'ok') return '正常';
  if (disk === 'low') return '空间偏低';
  if (disk === 'full') return '已满';
  if (disk === 'readonly') return '只读';
  if (disk === 'error') return '不可读';
  return '未知';
}

function blockText(block: BlockNode['block']): string {
  if (block === 'serving') return '服务中';
  if (block === 'compacting') return '合并中';
  if (block === 'starting') return '启动中';
  return '未知';
}

function diskTone(disk: BlockNode['disk']): Tone {
  if (disk === 'ok') return 'ok';
  if (disk === 'low') return 'warn';
  if (disk === 'full' || disk === 'readonly' || disk === 'error') return 'bad';
  return 'muted';
}

function writeState(node: BlockNode): { text: string; tone: Tone } {
  if (node.status !== 'up') return { text: '不可用', tone: 'bad' };
  if (node.maintenanceReason) return { text: `维护中：${node.maintenanceReason}`, tone: 'warn' };
  if (node.draining) return { text: '退出中', tone: 'warn' };
  if (node.disk === 'low') return { text: '空间偏低，不接收新写入', tone: 'warn' };
  if (node.disk === 'full' || node.disk === 'readonly' || node.disk === 'error') return { text: '磁盘不接收新写入', tone: 'bad' };
  if (node.block === 'starting' || node.block === 'compacting') return { text: '暂不追加', tone: 'warn' };
  return { text: '可写', tone: 'ok' };
}

function nodeTone(node: BlockNode): Tone {
  if (node.status === 'down') return 'bad';
  if (node.status !== 'up') return 'muted';
  return writeState(node).tone;
}

function clusterTone(stats: Stats): Tone {
  const nodes = stats.blockNodes ?? [];
  if (stats.indexOk === false) return 'bad';
  if (nodes.length > 0 && nodes.every((node) => node.status === 'down')) return 'bad';
  if ((stats.lost ?? 0) > 0) return 'warn';
  if (stats.layout && stats.layout.strict && !stats.layout.ok) return 'warn';
  if (nodes.some((node) => nodeTone(node) !== 'ok')) return 'warn';
  if ((stats.zones ?? []).some((zone) => zone.uneven)) return 'warn';
  return 'ok';
}

function clusterText(tone: Tone): string {
  if (tone === 'ok') return '集群正常';
  if (tone === 'warn') return '集群降级';
  return '集群不可用';
}

function layoutNote(layout: Layout): string | null {
  if (layout.ok) return null;
  const parts: string[] = [];
  if (layout.liveBlocks < layout.dataReplicas) {
    parts.push(`在线机器 ${layout.liveBlocks} 台，少于配置的 ${layout.dataReplicas} 份副本`);
  }
  if (layout.dataReplicas > 1 && layout.failureDomains < layout.dataReplicas) {
    parts.push(`故障域 ${layout.failureDomains} 个，少于配置的 ${layout.dataReplicas} 份`);
  }
  return parts.join('。') || '当前布局不满足副本要求';
}

function usedRatio(node: BlockNode): number | null {
  const used = node.stats?.bytesOnDisk;
  const free = node.freeBytes;
  if (typeof used !== 'number' || typeof free !== 'number') return null;
  const total = used + free;
  if (total <= 0) return null;
  return Math.min(1, used / total);
}

function reportHtml(report: PatrolReport): string {
  const esc = (value: unknown) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const decisions = (report.decisions ?? [])
    .map((item) => `<tr><td>${esc(item.action)}</td><td>${item.apply ? '已执行' : '只记录'}</td><td>${esc(item.summary)}</td></tr>`)
    .join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>S3DFS 巡检报告</title></head><body><h1>S3DFS 巡检报告</h1><pre>${esc(report.brief)}</pre><h2>模型结论</h2><p>${esc(report.modelSummary)}</p><table>${decisions}</table></body></html>`;
}

export default function Page() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [report, setReport] = useState<PatrolReport | null>(null);
  const [modelDraft, setModelDraft] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [s, b] = await Promise.all([
        fetch(`${apiBase}/_s3dfs/stats`).then((r) => {
          if (!r.ok) throw new Error(`stats ${r.status}`);
          return r.json() as Promise<Stats>;
        }),
        fetch(`${apiBase}/_s3dfs/buckets`).then((r) => {
          if (!r.ok) throw new Error(`buckets ${r.status}`);
          return r.json() as Promise<{ buckets: Bucket[] }>;
        }),
      ]);
      setStats(s);
      setBuckets(b.buckets);
      setUpdatedAt(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法连接 API');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [refresh]);

  async function post(path: string, label: string, query?: Record<string, string>, body?: unknown) {
    setMessage(null);
    const params = new URLSearchParams(query);
    const suffix = params.size ? `?${params}` : '';
    const r = await fetch(`/api/s3dfs/${path}${suffix}`, {
      method: path === 'decisions' ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) {
      setError(`${label} 没有执行：${r.status}`);
      return null;
    }
    setMessage(`${label} 已完成`);
    await refresh();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  const nodes = stats?.blockNodes ?? [];
  const tone = stats ? clusterTone(stats) : 'muted';
  const online = nodes.filter((node) => node.status === 'up').length;
  const free = nodes.reduce((sum, node) => sum + (node.freeBytes ?? 0), 0);
  const dead = nodes.reduce((sum, node) => sum + (node.stats?.deadBytes ?? 0), 0);
  const unflushed = nodes.reduce((sum, node) => sum + (node.stats?.unflushedBytes ?? 0), 0);

  return (
    <main>
      <header className="top">
        <div className="brand">
          <img src="/s3dfs-logo.jpg" alt="S3DFS" width={210} height={72} />
          <p className="lead">名字在索引里，正文在各台 block 上。S3 地址 {apiBase}</p>
        </div>
        <div className="top-side">
          {stats ? <span className={`pill ${tone}`}><i />{clusterText(tone)}</span> : null}
          {updatedAt ? <span className="stamp">{new Date(updatedAt).toLocaleTimeString()} 更新</span> : null}
          <button type="button" onClick={() => void refresh()}>刷新</button>
          <button type="button" onClick={() => void post('flush', '落盘')}>落盘</button>
          <button type="button" onClick={() => void post('compact', '合并')}>合并</button>
          <button type="button" onClick={() => void post('repair', '修复')}>修复</button>
          <button type="button" onClick={() => void post('scrub', '核对')}>核对</button>
        </div>
      </header>

      {error ? <p className="banner">连不上接口：{error}。先启动索引、block 和 API。</p> : null}
      {message ? <p className="note ok">{message}</p> : null}

      {stats ? (
        <div className="summary">
          <section className="panel">
            <h2>容量</h2>
            <div className="metric">
              <b>{fmtBytes(stats.bytesLogical)}</b>
              <span>逻辑容量</span>
            </div>
            <ul className="facts">
              <li><span>盘上占用</span><b>{fmtBytes(stats.bytesOnDisk)}</b></li>
              <li><span>剩余空间</span><b>{fmtBytes(free)}</b></li>
              <li><span>可回收空洞</span><b>{fmtBytes(dead)}</b></li>
              <li><span>未落盘</span><b>{fmtBytes(unflushed)}</b></li>
            </ul>
          </section>
          <section className="panel">
            <h2>副本</h2>
            <div className="metric">
              <b>{stats.effectiveDataReplicas ?? '-'} / {stats.dataReplicas ?? '-'}</b>
              <span>当前可放置 / 配置副本</span>
            </div>
            <ul className="facts">
              <li><span>写入法定人数</span><b>{stats.writeQuorum ?? '-'}</b></li>
              <li><span>压缩</span><b>{stats.compressType ?? '未报告'}</b></li>
              <li><span>在线机器</span><b>{online} / {nodes.length}</b></li>
              <li><span>没有活副本的对象</span><b className={(stats.lost ?? 0) > 0 ? 'bad' : undefined}>{stats.lost ?? 0}</b></li>
            </ul>
          </section>
          <section className="panel">
            <h2>索引</h2>
            <div className="metric">
              <b className={stats.indexOk ? 'ok' : 'bad'}>{stats.indexOk ? '可达' : '不可达'}</b>
              <span>{(stats.indexUrls ?? []).join('，') || '未配置'}</span>
            </div>
            <ul className="facts">
              <li><span>对象</span><b>{stats.objects}</b></li>
              <li><span>已删除</span><b>{stats.deleted}</b></li>
              <li><span>块文件</span><b>{stats.blockFiles}</b></li>
              <li><span>读 / 写 / 删</span><b>{stats.gets} / {stats.puts} / {stats.deletes}</b></li>
            </ul>
          </section>
          <section className="panel">
            <h2>故障域</h2>
            <div className="metric">
              <b>{stats.layout ? `${stats.layout.failureDomains} / ${stats.layout.dataReplicas}` : '-'}</b>
              <span>{stats.layout?.strict ? '严格布局' : '未启用严格布局'}</span>
            </div>
            <ul className="facts">
              {(stats.zones ?? []).length === 0 ? <li><span>还没有带剩余空间的故障域</span><b>-</b></li> : null}
              {(stats.zones ?? []).map((zone) => (
                <li key={zone.zone}>
                  <span>{zone.zone}{zone.uneven ? '，空间不均' : ''}</span>
                  <b>{fmtBytes(zone.writableBytes)}</b>
                </li>
              ))}
              <li><span>落盘 / 同步</span><b>{stats.flushes} / {stats.fsyncs}</b></li>
            </ul>
            {stats.layout && !stats.layout.ok ? <p className="note warn">{layoutNote(stats.layout)}</p> : null}
          </section>
        </div>
      ) : null}

      <section>
        <div className="section-head">
          <h2>机器</h2>
          <span>{nodes.length} 台 block</span>
        </div>
        {nodes.length === 0 ? <div className="panel empty">还没有 block 节点</div> : (
          <div className="node-grid">
            {nodes.map((node) => {
              const write = writeState(node);
              const ratio = usedRatio(node);
              const barTone = diskTone(node.disk);
              return (
                <article className="node" key={node.nodeId}>
                  <header>
                    <div>
                      <strong>{node.nodeId}</strong>
                      <em>{node.zone ? `故障域 ${node.zone}` : '未标故障域'}</em>
                    </div>
                    <span className={`pill ${nodeTone(node)}`}><i />{nodeText(node.status)}</span>
                  </header>
                  <div className="addr">{node.address}</div>
                  {ratio !== null ? (
                    <div className={`bar ${barTone === 'ok' ? '' : barTone}`} title={`已用 ${Math.round(ratio * 100)}%`}>
                      <span style={{ width: `${Math.max(2, ratio * 100)}%` }} />
                    </div>
                  ) : null}
                  <ul className="facts">
                    <li><span>磁盘</span><b className={diskTone(node.disk)}>{diskText(node.disk)}</b></li>
                    <li><span>剩余</span><b>{typeof node.freeBytes === 'number' ? fmtBytes(node.freeBytes) : '-'}</b></li>
                    <li><span>block</span><b>{blockText(node.block)}</b></li>
                    <li><span>写入</span><b className={write.tone}>{write.text}</b></li>
                    <li><span>本机对象</span><b>{node.stats?.objects ?? '-'}</b></li>
                    <li><span>本机占用</span><b>{typeof node.stats?.bytesOnDisk === 'number' ? fmtBytes(node.stats.bytesOnDisk) : '-'}</b></li>
                    <li><span>空洞 / 未落盘</span><b>{fmtBytes(node.stats?.deadBytes ?? 0)} / {fmtBytes(node.stats?.unflushedBytes ?? 0)}</b></li>
                    <li><span>最近检查</span><b>{node.lastSeenMs ? new Date(node.lastSeenMs).toLocaleString() : '-'}</b></li>
                  </ul>
                  {node.maintenanceUntilMs ? (
                    <p className="note warn">维护到 {new Date(node.maintenanceUntilMs).toLocaleString()}</p>
                  ) : null}
                  {node.lastError ? <p className="note bad">{node.lastError}</p> : null}
                  <form
                    className="actions"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
                      if (!reason) {
                        setError('维护离开要写明原因');
                        return;
                      }
                      void post('maintenance', `${node.nodeId} 维护离开`, { nodeId: node.nodeId, reason });
                    }}
                  >
                    <input name="reason" placeholder="离开原因，例如更换系统盘" />
                    <button type="submit">维护离开 2 小时</button>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`把 ${node.nodeId} 上的副本写到其他机器，并从索引去掉这台？`)) {
                          void post('drain', `${node.nodeId} 退出`, { nodeId: node.nodeId });
                        }
                      }}
                    >
                      退出并搬走
                    </button>
                    <button type="button" onClick={() => void post('rebalance', `${node.nodeId} 迁入`, { nodeId: node.nodeId })}>
                      迁入一份
                    </button>
                  </form>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <div className="section-head">
          <h2>巡检</h2>
          <span>规则简报，模型结论另记</span>
        </div>
        <div className="panel">
          <div className="actions">
            <button
              type="button"
              onClick={() => {
                void post('patrol', '巡检').then((body) => {
                  if (body && typeof body === 'object') {
                    const next = body as PatrolReport;
                    setReport(next);
                    setModelDraft(next.modelSummary ?? '');
                  }
                });
              }}
            >
              开始巡检
            </button>
            <button
              type="button"
              onClick={() => {
                void post('patrol-summary', '模型结论', undefined, { summary: modelDraft }).then((body) => {
                  if (body && typeof body === 'object') setReport(body as PatrolReport);
                });
              }}
            >
              保存模型结论
            </button>
            <button
              type="button"
              onClick={() => {
                if (!report) return;
                const blob = new Blob([reportHtml(report)], { type: 'text/html;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `s3dfs-patrol-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.html`;
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              导出报告
            </button>
          </div>
          {report?.brief ? <pre className="brief">{report.brief}</pre> : <p className="fine">还没有巡检。开始之后，这里给出现状、和上次的差别、已经执行的动作，以及值班下一步。</p>}
          {report?.modelSummary ? (
            <>
              <h2 className="sub">模型结论</h2>
              <p className="note">{report.modelSummary}</p>
            </>
          ) : null}
          <label className="fine" htmlFor="model-draft">把模型或值班的中文结论写回来</label>
          <textarea id="model-draft" value={modelDraft} onChange={(event) => setModelDraft(event.target.value)} rows={4} />
          {(report?.decisions ?? []).length > 0 ? (
            <table>
              <thead>
                <tr><th>动作</th><th>结果</th><th>说明</th></tr>
              </thead>
              <tbody>
                {report?.decisions?.map((item, index) => (
                  <tr key={`${item.action}-${index}`}>
                    <td>{item.action}</td>
                    <td>{item.apply ? '已执行' : '只记录'}</td>
                    <td>{item.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>桶</h2>
          <span>{buckets.length} 个</span>
        </div>
        <div className="panel table">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>创建 / 最早对象</th>
              </tr>
            </thead>
            <tbody>
              {buckets.length === 0 ? (
                <tr><td colSpan={2} className="empty">还没有桶</td></tr>
              ) : buckets.map((bucket) => (
                <tr key={bucket.name}>
                  <td>{bucket.name}</td>
                  <td>{new Date(bucket.mtimeMs).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
