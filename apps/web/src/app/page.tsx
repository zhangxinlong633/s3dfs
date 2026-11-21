'use client';

import { useCallback, useEffect, useState } from 'react';

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
};

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
  indexUrls?: string[];
  indexOk?: boolean;
  blockNodes?: BlockNode[];
};

type Bucket = { name: string; mtimeMs: number };

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:9000';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n < 1024 * 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return `${(n / 1024 / 1024 / 1024 / 1024).toFixed(2)} TB`;
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

function writeText(node: BlockNode): string {
  if (node.status !== 'up') return '不可用';
  if (node.maintenanceReason) {
    const until = node.maintenanceUntilMs ? `，至 ${new Date(node.maintenanceUntilMs).toLocaleString()}` : '';
    return `维护中：${node.maintenanceReason}${until}`;
  }
  if (node.draining) return '退出中';
  if (node.disk === 'low' || node.disk === 'full' || node.disk === 'readonly' || node.disk === 'error') return '磁盘不接收新写入';
  if (node.block === 'starting' || node.block === 'compacting') return '暂不追加';
  return '可写';
}

export default function Page() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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

  async function post(path: string, label: string) {
    setMessage(null);
    const r = await fetch(`/api/s3dfs/${path}`, { method: 'POST' });
    if (!r.ok) {
      setError(`${label} failed: ${r.status}`);
      return;
    }
    setMessage(`${label} 完成`);
    await refresh();
  }

  const cards = stats
    ? [
        ['对象数', String(stats.objects)],
        ['已删除', String(stats.deleted)],
        ['Block 文件', String(stats.blockFiles)],
        ['逻辑容量', fmtBytes(stats.bytesLogical)],
        ['盘上占用', fmtBytes(stats.bytesOnDisk)],
        ['数据副本', `${stats.effectiveDataReplicas ?? '-'} / ${stats.dataReplicas ?? '-'}`],
        ['写入次数', String(stats.puts)],
        ['Flush', String(stats.flushes)],
      ]
    : [];

  const nodes = stats?.blockNodes ?? [];

  return (
    <main>
      <h1>s3dfs</h1>
      <p className="lead">
        索引在独立的 dleveldb 集群，正文在可扩展的 block 机器上。S3 API 在 {apiBase}，控制台只读状态并触发 flush / compaction。
      </p>
      {error ? (
        <p className="err">
          {error}。请先启动 <code>pnpm dev:index</code>、<code>pnpm dev:block</code> 和 <code>pnpm dev:api</code>。
        </p>
      ) : null}
      {message ? <p className="ok">{message}</p> : null}
      {stats ? (
        <>
          <p className="lead">
            索引：{(stats.indexUrls ?? []).join(', ') || '未配置'}（{stats.indexOk ? '可达' : '不可达'}）
          </p>
          <div className="grid">
            {cards.map(([label, value]) => (
              <div className="card" key={label}>
                <div className="label">{label}</div>
                <div className="value">{value}</div>
              </div>
            ))}
          </div>
        </>
      ) : null}
      <section>
        <button type="button" onClick={() => void refresh()}>
          刷新
        </button>
        <button type="button" onClick={() => void post('flush', 'Flush')}>
          Flush
        </button>
        <button type="button" onClick={() => void post('compact', 'Compact')}>
          Compact
        </button>
      </section>
      <section className="card nodes" style={{ marginTop: 24, padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>编号</th>
              <th>地址</th>
              <th>节点</th>
              <th>磁盘</th>
              <th>剩余空间</th>
              <th>block</th>
              <th>写入</th>
              <th>最近一次检查</th>
            </tr>
          </thead>
          <tbody>
            {nodes.length === 0 ? (
              <tr>
                <td colSpan={8}>还没有 block 节点</td>
              </tr>
            ) : (
              nodes.map((n) => (
                <tr key={n.nodeId}>
                  <td>{n.nodeId}</td>
                  <td>{n.address}</td>
                  <td>{nodeText(n.status)}{n.lastError ? `（${n.lastError}）` : ''}</td>
                  <td>{diskText(n.disk)}</td>
                  <td>{typeof n.freeBytes === 'number' ? fmtBytes(n.freeBytes) : '-'}</td>
                  <td>{blockText(n.block)}</td>
                  <td className="write">{writeText(n)}</td>
                  <td>{n.lastSeenMs ? new Date(n.lastSeenMs).toLocaleString() : '-'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
      <section className="card" style={{ marginTop: 24, padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>桶</th>
              <th>创建 / 最早对象时间</th>
            </tr>
          </thead>
          <tbody>
            {buckets.length === 0 ? (
              <tr>
                <td colSpan={2}>还没有桶</td>
              </tr>
            ) : (
              buckets.map((b) => (
                <tr key={b.name}>
                  <td>{b.name}</td>
                  <td>{new Date(b.mtimeMs).toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
