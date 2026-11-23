/**
 * dleveldb microbenchmarks. Run from the package root:
 *
 *   bun scripts/bench.mjs
 *
 * Prints a markdown table and writes JSON next to this file's output path
 * when --json <file> is given.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src', 'index.ts');
const dist = path.join(root, 'dist', 'index.js');
const modUrl = fs.existsSync(src) ? pathToFileURL(src).href : pathToFileURL(dist).href;
const { DLevelDB, loadConfig, listenDLevelDB } = await import(modUrl);

const results = [];

function nowNs() {
  return process.hrtime.bigint();
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx]) / 1e3; // ns -> µs
}

function fmtOps(n) {
  return n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n.toFixed(0);
}

function fmtUs(us) {
  if (us >= 1000) return `${(us / 1000).toFixed(2)} ms`;
  return `${us.toFixed(0)} µs`;
}

async function measure(name, count, fn) {
  const warmup = Math.min(200, Math.max(20, Math.floor(count / 20)));
  for (let i = 0; i < warmup; i++) await fn(i);
  const samples = new BigInt64Array(count);
  const t0 = nowNs();
  for (let i = 0; i < count; i++) {
    const s = nowNs();
    await fn(i);
    samples[i] = nowNs() - s;
  }
  const totalNs = nowNs() - t0;
  const sorted = Array.from(samples).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const ops = count / (Number(totalNs) / 1e9);
  const row = {
    name,
    count,
    concurrency: 1,
    opsPerSec: ops,
    p50Us: pct(sorted, 50),
    p99Us: pct(sorted, 99),
  };
  results.push(row);
  console.log(`ok  ${name.padEnd(48)} ${fmtOps(ops).padStart(10)} ops/s   p50 ${fmtUs(row.p50Us).padStart(10)}   p99 ${fmtUs(row.p99Us).padStart(10)}`);
  return row;
}

async function measureConcurrent(name, count, concurrency, fn) {
  const warmup = Math.min(200, count);
  for (let i = 0; i < warmup; i++) await fn(i);
  const t0 = nowNs();
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= count) return;
      await fn(i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const totalNs = nowNs() - t0;
  const ops = count / (Number(totalNs) / 1e9);
  const row = {
    name,
    count,
    concurrency,
    opsPerSec: ops,
    p50Us: null,
    p99Us: null,
  };
  results.push(row);
  console.log(`ok  ${name.padEnd(48)} ${fmtOps(ops).padStart(10)} ops/s   concurrency ${concurrency}`);
  return row;
}

function keyOf(prefix, i) {
  return `${prefix}/${String(i).padStart(8, '0')}`;
}

async function openDb(dir, overrides) {
  const config = loadConfig({}, {
    dataDir: dir,
    nodeId: 'node1',
    advertiseAddr: '127.0.0.1:0',
    vnodeCount: 1,
    replicas: 1,
    sync: false,
    stabilizeIntervalMs: 10_000,
    ...overrides,
  });
  return DLevelDB.open(config);
}

async function closeQuiet(db, server) {
  if (server) await new Promise((resolve) => server.close(() => resolve()));
  if (db) await db.close();
}

function httpRequest(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`${method} ${urlPath} ${res.statusCode}: ${buf.toString('utf8')}`));
            return;
          }
          resolve(buf);
        });
      },
    );
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

async function waitForCluster(port, physicalNodes, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const body = JSON.parse((await httpRequest(port, 'GET', '/_dleveldb/cluster')).toString('utf8'));
      if ((body.physicalNodes ?? 0) >= physicalNodes && (body.knownVnodes?.length ?? 0) >= physicalNodes) {
        return body;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`cluster at ${port} did not reach ${physicalNodes} physical nodes`);
}

async function benchLocal() {
  console.log('\n# in-process library (single machine, effective N=1)\n');
  const cases = [
    { label: 'put 100 B, sync=off', op: 'put', size: 100, sync: false, n: 50_000 },
    { label: 'get 100 B, sync=off', op: 'get', size: 100, sync: false, n: 50_000 },
    { label: 'put 1 KiB, sync=off', op: 'put', size: 1024, sync: false, n: 50_000 },
    { label: 'get 1 KiB, sync=off', op: 'get', size: 1024, sync: false, n: 50_000 },
    { label: 'put 16 KiB, sync=off', op: 'put', size: 16 * 1024, sync: false, n: 20_000 },
    { label: 'get 16 KiB, sync=off', op: 'get', size: 16 * 1024, sync: false, n: 20_000 },
    { label: 'put 1 KiB, sync=on', op: 'put', size: 1024, sync: true, n: 2_000 },
    { label: 'get 1 KiB, sync=on', op: 'get', size: 1024, sync: true, n: 20_000 },
  ];

  for (const c of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dleveldb-bench-'));
    const db = await openDb(dir, { sync: c.sync, vnodeCount: 1 });
    const value = Buffer.alloc(c.size, 0x61);
    const prefix = 'bench';
    try {
      if (c.op === 'get') {
        for (let i = 0; i < c.n; i++) await db.put(keyOf(prefix, i), value);
      }
      if (c.op === 'put') {
        await measure(c.label, c.n, (i) => db.put(keyOf(prefix, i), value));
      } else {
        await measure(c.label, c.n, async (i) => {
          const got = await db.get(keyOf(prefix, i));
          if (!got) throw new Error('missing key');
        });
      }
    } finally {
      await closeQuiet(db);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // concurrent puts
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dleveldb-bench-'));
    const db = await openDb(dir, { sync: false, vnodeCount: 1 });
    const value = Buffer.alloc(1024, 0x61);
    try {
      await measureConcurrent('put 1 KiB, sync=off, 32 in flight', 50_000, 32, (i) => db.put(keyOf('c', i), value));
    } finally {
      await closeQuiet(db);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // 4 vnodes
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dleveldb-bench-'));
    const db = await openDb(dir, { sync: false, vnodeCount: 4 });
    const value = Buffer.alloc(1024, 0x61);
    try {
      await measure('put 1 KiB, sync=off, 4 vnodes', 50_000, (i) => db.put(keyOf('v', i), value));
      await measure('get 1 KiB, sync=off, 4 vnodes', 50_000, async (i) => {
        const got = await db.get(keyOf('v', i));
        if (!got) throw new Error('missing key');
      });
    } finally {
      await closeQuiet(db);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // prefix scan
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dleveldb-bench-'));
    const db = await openDb(dir, { sync: false, vnodeCount: 1 });
    const value = Buffer.alloc(100, 0x61);
    const n = 10_000;
    try {
      for (let i = 0; i < n; i++) await db.put(keyOf('logs', i), value);
      await measure('scan 10k keys, prefix logs/, 1 vnode', 20, async () => {
        const r = await db.scan({ prefix: 'logs/', maxKeys: n });
        if (r.objects.length !== n) throw new Error(`scan got ${r.objects.length}`);
      });
    } finally {
      await closeQuiet(db);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function benchCluster() {
  console.log('\n# 3 processes on localhost, N=3 W=2, HTTP RPC\n');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dleveldb-bench-cluster-'));
  const ports = [19111, 19112, 19113];
  const nodes = [];
  try {
    for (let i = 0; i < 3; i++) {
      const dataDir = path.join(base, `node${i}`);
      fs.mkdirSync(dataDir);
      const db = await openDb(dataDir, {
        nodeId: `node${i}`,
        advertiseAddr: `127.0.0.1:${ports[i]}`,
        peers: i === 0 ? [] : ['127.0.0.1:19111'],
        vnodeCount: 1,
        replicas: 3,
        writeQuorum: 2,
        sync: false,
        stabilizeIntervalMs: 200,
      });
      const server = await listenDLevelDB(db);
      nodes.push({ db, server, port: ports[i] });
    }
    await waitForCluster(ports[0], 3);

    const n = 5_000;
    const value = Buffer.alloc(1024, 0x62);
    const port = ports[0];
    await measure('HTTP put 1 KiB, 3 nodes, W=2, sync=off', n, (i) =>
      httpRequest(port, 'POST', '/_dleveldb/kv/put', {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(value.length),
          'x-dleveldb-key': encodeURIComponent(keyOf('r', i)),
        },
        body: value,
      }),
    );
    await measure('HTTP get 1 KiB, 3 nodes, sync=off', n, async (i) => {
      const got = await httpRequest(port, 'GET', `/_dleveldb/kv/get?key=${encodeURIComponent(keyOf('r', i))}`);
      if (got.length !== value.length) throw new Error('bad get');
    });
  } finally {
    for (const n of nodes.reverse()) {
      await closeQuiet(n.db, n.server);
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function hardware() {
  const cpus = os.cpus();
  return {
    platform: `${os.platform()} ${os.arch()}`,
    release: os.release(),
    cpu: cpus[0]?.model?.trim() ?? 'unknown',
    cores: cpus.length,
    memoryGiB: Math.round(os.totalmem() / 1024 / 1024 / 1024),
    bun: typeof Bun !== 'undefined' ? Bun.version : null,
    node: process.version,
    date: new Date().toISOString(),
  };
}

const hw = hardware();
console.log('dleveldb bench');
console.log(`runtime bun ${hw.bun ?? 'n/a'} / node ${hw.node} on ${hw.platform}`);
console.log(`cpu ${hw.cpu} (${hw.cores} logical cores), ${hw.memoryGiB} GiB RAM`);
console.log(`date ${hw.date}`);

await benchLocal();
await benchCluster();

const jsonPath = (() => {
  const idx = process.argv.indexOf('--json');
  return idx >= 0 ? process.argv[idx + 1] : null;
})();
const payload = { hardware: hw, results };
if (jsonPath) {
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  console.log(`\nwrote ${jsonPath}`);
}
