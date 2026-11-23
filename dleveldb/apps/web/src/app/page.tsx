'use client';

import { useCallback, useEffect, useState } from 'react';

type Stats = {
  objects: number;
  deleted: number;
  bytesLogical: number;
  bytesOnDisk: number;
  puts: number;
  gets: number;
  deletes: number;
  dataDir: string;
  nodeId: string;
  vnodeCount: number;
  configuredReplicas: number;
  effectiveReplicas: number;
  writeQuorum: number;
};

type Vnode = {
  id: string;
  seq: number;
  hash: string;
  successor: { id: string; address: string } | null;
  predecessor: { id: string; address: string } | null;
};

type Status = {
  nodeId: string;
  address: string;
  physicalNodes: number;
  configuredReplicas: number;
  effectiveReplicas: number;
  writeQuorum: number;
  knownVnodes: { id: string; nodeId: string; address: string; hash: string }[];
  vnodes: Vnode[];
  peers: string[];
  repair?: { implemented: boolean; note: string };
};

type ScanEntry = { key: string; size: number; mtimeMs: number };

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:9000';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${apiBase}${path}`, init);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${path} ${r.status}${text ? `: ${text}` : ''}`);
  }
  return r.json() as Promise<T>;
}

export default function Page() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [key, setKey] = useState('logs/2026/a.log');
  const [value, setValue] = useState('');
  const [prefix, setPrefix] = useState('logs/2026/');
  const [listed, setListed] = useState<ScanEntry[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        api<Stats>('/_dleveldb/stats'),
        api<Status>('/_dleveldb/cluster'),
      ]);
      setStats(s);
      setStatus(c);
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
    try {
      await api(`${path}`, { method: 'POST' });
      setMessage(`${label} 完成`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`);
    }
  }

  async function doGet() {
    setMessage(null);
    try {
      const r = await fetch(`${apiBase}/_dleveldb/kv/get?key=${encodeURIComponent(key)}`);
      if (r.status === 404) {
        setValue('');
        setMessage('找不到这个 key');
        return;
      }
      if (!r.ok) throw new Error(`get ${r.status}`);
      setValue(await r.text());
      setMessage('读取成功');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'get failed');
    }
  }

  async function doPut() {
    setMessage(null);
    try {
      const r = await fetch(`${apiBase}/_dleveldb/kv/put`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-dleveldb-key': encodeURIComponent(key) },
        body: new TextEncoder().encode(value),
      });
      if (!r.ok) throw new Error(`put ${r.status}: ${await r.text()}`);
      setMessage('写入成功');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'put failed');
    }
  }

  async function doDelete() {
    setMessage(null);
    try {
      const body = await api<{ deleted: boolean }>('/_dleveldb/kv/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      setMessage(body.deleted ? '已删除' : '本来就不存在');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'delete failed');
    }
  }

  async function doScan() {
    setMessage(null);
    try {
      const result = await api<{ objects: ScanEntry[] }>('/_dleveldb/kv/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prefix, maxKeys: 100 }),
      });
      setListed(result.objects);
      setMessage(`扫描到 ${result.objects.length} 条`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'scan failed');
    }
  }

  const cards = stats
    ? [
        ['本机 node', stats.nodeId],
        ['虚拟节点', String(stats.vnodeCount)],
        ['有效副本 N', String(status?.effectiveReplicas ?? stats.effectiveReplicas)],
        ['写法定人数 W', String(status?.writeQuorum ?? stats.writeQuorum)],
        ['物理节点', String(status?.physicalNodes ?? 1)],
        ['key 数量', String(stats.objects)],
        ['逻辑容量', fmtBytes(stats.bytesLogical)],
        ['盘上占用', fmtBytes(stats.bytesOnDisk)],
      ]
    : [];

  return (
    <main>
      <h1>dleveldb</h1>
      <p className="lead">
        分布式 LevelDB 控制台。每个分片是一份标准 LevelDB，值直接写进库里。API 在 {apiBase}，集群状态每 3 秒刷新一次。
      </p>
      {error ? <p className="err">{error}。请先启动 <code>pnpm dev:api</code>。</p> : null}
      {message ? <p className="ok">{message}</p> : null}
      {stats ? (
        <>
          <p className="lead">数据目录：{stats.dataDir}{status ? `，监听 ${status.address}` : ''}</p>
          <div className="grid">
            {cards.map(([label, v]) => (
              <div className="card" key={label}>
                <div className="label">{label}</div>
                <div className="value">{v}</div>
              </div>
            ))}
          </div>
        </>
      ) : null}
      <section>
        <button type="button" onClick={() => void refresh()}>刷新</button>
        <button type="button" onClick={() => void post('/_dleveldb/flush', 'Flush')}>Flush</button>
        <button type="button" onClick={() => void post('/_dleveldb/compact', 'Compact')}>Compact</button>
      </section>

      <section className="card">
        <h2>读写</h2>
        <div className="row">
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="key" />
          <button type="button" onClick={() => void doGet()}>Get</button>
          <button type="button" onClick={() => void doPut()}>Put</button>
          <button type="button" onClick={() => void doDelete()}>Delete</button>
        </div>
        <textarea value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" />
      </section>

      <section className="card">
        <h2>前缀扫描</h2>
        <div className="row">
          <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="prefix" />
          <button type="button" onClick={() => void doScan()}>Scan</button>
        </div>
        <table>
          <thead>
            <tr>
              <th>key</th>
              <th>大小</th>
              <th>mtime</th>
            </tr>
          </thead>
          <tbody>
            {listed.length === 0 ? (
              <tr>
                <td colSpan={3}>还没有扫描结果</td>
              </tr>
            ) : (
              listed.map((o) => (
                <tr key={o.key}>
                  <td><code>{o.key}</code></td>
                  <td>{fmtBytes(o.size)}</td>
                  <td>{o.mtimeMs ? new Date(o.mtimeMs).toLocaleString() : ''}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className="card" style={{ padding: 0 }}>
        <div style={{ padding: '16px 18px 0' }}>
          <h2>本机虚拟节点</h2>
        </div>
        <table>
          <thead>
            <tr>
              <th>vnode</th>
              <th>hash</th>
              <th>后继</th>
              <th>前驱</th>
            </tr>
          </thead>
          <tbody>
            {(status?.vnodes ?? []).length === 0 ? (
              <tr>
                <td colSpan={4}>还没有集群信息</td>
              </tr>
            ) : (
              (status?.vnodes ?? []).map((v) => (
                <tr key={v.id}>
                  <td><code>{v.id}</code></td>
                  <td><code>{v.hash.slice(0, 12)}…</code></td>
                  <td><code>{v.successor?.id ?? '—'}</code></td>
                  <td><code>{v.predecessor?.id ?? '—'}</code></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className="card" style={{ padding: 0 }}>
        <div style={{ padding: '16px 18px 0' }}>
          <h2>环上已知节点</h2>
        </div>
        <table>
          <thead>
            <tr>
              <th>vnode</th>
              <th>物理节点</th>
              <th>地址</th>
            </tr>
          </thead>
          <tbody>
            {(status?.knownVnodes ?? []).length === 0 ? (
              <tr>
                <td colSpan={3}>只有本机</td>
              </tr>
            ) : (
              (status?.knownVnodes ?? []).map((v) => (
                <tr key={v.id}>
                  <td><code>{v.id}</code></td>
                  <td>{v.nodeId}</td>
                  <td><code>{v.address}</code></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
