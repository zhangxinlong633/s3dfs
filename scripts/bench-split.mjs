import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dleveldbCli = path.resolve(root, '../dleveldb/packages/dleveldb/src/cli.ts');
const blockMain = path.join(root, 'apps/block/src/main.ts');
const bun = process.env.BUN_BIN ?? 'bun';
const ops = Number(process.env.S3DFS_BENCH_OPS ?? 5000);
const warmup = Number(process.env.S3DFS_BENCH_WARMUP ?? 500);
const outFile = process.env.S3DFS_BENCH_OUT ?? '/tmp/s3dfs-bench.json';

if (!existsSync(dleveldbCli)) {
  console.error(`missing dleveldb at ${dleveldbCli}`);
  process.exit(1);
}

const work = mkdtempSync(path.join(os.tmpdir(), 's3dfs-bench-'));
const children = [];
let nextPort = 19_200;

function run(command, args, env = {}) {
  const cwd = args[0] === blockMain ? path.join(root, 'apps/block') : root;
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (buf) => process.stderr.write(`[svc] ${buf}`));
  child.stderr.on('data', (buf) => process.stderr.write(`[svc] ${buf}`));
  children.push(child);
  return child;
}

async function waitPort(port, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => {
        sock.end();
        resolve(true);
      });
      sock.on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for 127.0.0.1:${port}`);
}

function stop(child) {
  if (!child || child.killed || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 2000);
  });
}

async function cleanup() {
  for (const child of children.splice(0).reverse()) {
    await stop(child);
  }
  rmSync(work, { recursive: true, force: true });
}

process.on('SIGINT', () => void cleanup().then(() => process.exit(1)));
process.on('SIGTERM', () => void cleanup().then(() => process.exit(1)));

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function fmtUs(ns) {
  return `${(Number(ns) / 1000).toFixed(0)}µs`;
}

async function measure(name, count, fn) {
  const samples = [];
  for (let i = 0; i < warmup; i++) {
    await fn(i, true);
  }
  const start = process.hrtime.bigint();
  for (let i = 0; i < count; i++) {
    const a = process.hrtime.bigint();
    await fn(i, false);
    samples.push(process.hrtime.bigint() - a);
  }
  const elapsedNs = process.hrtime.bigint() - start;
  const elapsedSec = Number(elapsedNs) / 1e9;
  samples.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const result = {
    name,
    ops: count,
    opsPerSec: count / elapsedSec,
    p50Ns: Number(percentile(samples, 50)),
    p99Ns: Number(percentile(samples, 99)),
    elapsedSec,
  };
  console.log(
    `${name.padEnd(42)} ${result.opsPerSec.toFixed(0).padStart(8)} ops/s   p50 ${fmtUs(result.p50Ns).padStart(8)}   p99 ${fmtUs(result.p99Ns).padStart(8)}`,
  );
  return result;
}

async function measureConcurrent(name, count, inflight, fn) {
  for (let i = 0; i < warmup; i++) {
    await fn(i, true);
  }
  const samples = [];
  let next = 0;
  const start = process.hrtime.bigint();
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= count) return;
      const a = process.hrtime.bigint();
      await fn(i, false);
      samples.push(process.hrtime.bigint() - a);
    }
  }
  await Promise.all(Array.from({ length: inflight }, () => worker()));
  const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
  samples.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const result = {
    name,
    ops: count,
    inflight,
    opsPerSec: count / elapsedSec,
    p50Ns: Number(percentile(samples, 50)),
    p99Ns: Number(percentile(samples, 99)),
    elapsedSec,
  };
  console.log(
    `${name.padEnd(42)} ${result.opsPerSec.toFixed(0).padStart(8)} ops/s   p50 ${fmtUs(result.p50Ns).padStart(8)}   p99 ${fmtUs(result.p99Ns).padStart(8)}`,
  );
  return result;
}

const { IndexClient, NodeRegistry, ObjectCluster, blockPut, blockGet } = await import(
  pathToFileURL(path.join(root, 'packages/control/src/index.ts')).href
);

async function startCluster(blockCount, dataReplicas) {
  const dir = mkdtempSync(path.join(work, `c-`));
  const indexPort = nextPort++;
  run(bun, [dleveldbCli], {
    DLEVELDB_PORT: String(indexPort),
    DLEVELDB_ADVERTISE_ADDR: `127.0.0.1:${indexPort}`,
    DLEVELDB_DATA_DIR: path.join(dir, 'index'),
    DLEVELDB_NODE_ID: `index-${indexPort}`,
    DLEVELDB_VNODES: '1',
    DLEVELDB_REPLICAS: '1',
  });
  await waitPort(indexPort);
  const seeds = [];
  for (let i = 0; i < blockCount; i++) {
    const port = nextPort++;
    const id = `block${i + 1}`;
    run(bun, [blockMain], {
      S3DFS_BLOCK_NODE_ID: id,
      S3DFS_BLOCK_PORT: String(port),
      S3DFS_ADVERTISE_ADDR: `127.0.0.1:${port}`,
      S3DFS_DATA_DIR: path.join(dir, id),
      S3DFS_INDEX_URLS: `http://127.0.0.1:${indexPort}`,
      S3DFS_FLUSH_INTERVAL_MS: '20',
    });
    await waitPort(port);
    seeds.push({ nodeId: id, address: `127.0.0.1:${port}` });
  }
  const kv = new IndexClient([`http://127.0.0.1:${indexPort}`]);
  const registry = new NodeRegistry(kv, seeds);
  const cluster = new ObjectCluster(kv, registry, dataReplicas);
  await registry.checkAll();
  if (registry.live().length !== blockCount) {
    throw new Error(`expected ${blockCount} live blocks`);
  }
  return { kv, cluster, seeds };
}

const results = [];
const payload = (n) => Buffer.alloc(n, 0x61);

console.log(`s3dfs split bench  ops=${ops} warmup=${warmup}`);
console.log(`bun ${process.versions.bun ?? bun}  node-compat ${process.version}  ${os.cpus()[0]?.model ?? ''}  ${os.arch()}`);
console.log('');

{
  const { cluster, seeds } = await startCluster(1, 1);
  const body = payload(1024);
  await cluster.createBucket('bench');
  results.push(
    await measure('direct block put 1KiB (no index)', ops, async (i) => {
      await blockPut(seeds[0].address, `raw/${i}`, body);
    }),
  );
  results.push(
    await measure('direct block get 1KiB (no index)', ops, async (i) => {
      const got = await blockGet(seeds[0].address, `raw/${i}`);
      if (!got) throw new Error('missing');
    }),
  );
  results.push(
    await measure('cluster put 100B  N=1', ops, async (i, warm) => {
      await cluster.put('bench', `${warm ? 'w' : 'p'}-100-${i}`, payload(100));
    }),
  );
  results.push(
    await measure('cluster get 100B  N=1', ops, async (i) => {
      const got = await cluster.get('bench', `p-100-${i}`);
      if (!got) throw new Error('missing');
    }),
  );
  results.push(
    await measure('cluster put 1KiB  N=1', ops, async (i, warm) => {
      await cluster.put('bench', `${warm ? 'w' : 'p'}-1k-${i}`, body);
    }),
  );
  results.push(
    await measure('cluster get 1KiB  N=1', ops, async (i) => {
      const got = await cluster.get('bench', `p-1k-${i}`);
      if (!got) throw new Error('missing');
    }),
  );
  results.push(
    await measure('cluster put 16KiB N=1', Math.min(ops, 2000), async (i, warm) => {
      await cluster.put('bench', `${warm ? 'w' : 'p'}-16k-${i}`, payload(16 * 1024));
    }),
  );
  results.push(
    await measure('cluster get 16KiB N=1', Math.min(ops, 2000), async (i) => {
      const got = await cluster.get('bench', `p-16k-${i}`);
      if (!got) throw new Error('missing');
    }),
  );
  results.push(
    await measureConcurrent('cluster put 1KiB  N=1  32-in-flight', ops, 32, async (i, warm) => {
      await cluster.put('bench', `${warm ? 'cw' : 'c'}-1k-${i}`, body);
    }),
  );
  results.push(
    await measureConcurrent('cluster get 1KiB  N=1  32-in-flight', ops, 32, async (i) => {
      const got = await cluster.get('bench', `c-1k-${i}`);
      if (!got) throw new Error('missing');
    }),
  );
}

{
  const { cluster } = await startCluster(3, 3);
  const body = payload(1024);
  await cluster.createBucket('bench');
  results.push(
    await measure('cluster put 1KiB  N=3', ops, async (i, warm) => {
      await cluster.put('bench', `${warm ? 'w' : 'p'}-1k-${i}`, body);
    }),
  );
  results.push(
    await measure('cluster get 1KiB  N=3', ops, async (i) => {
      const got = await cluster.get('bench', `p-1k-${i}`);
      if (!got) throw new Error('missing');
    }),
  );
  results.push(
    await measureConcurrent('cluster put 1KiB  N=3  32-in-flight', ops, 32, async (i, warm) => {
      await cluster.put('bench', `${warm ? 'cw' : 'c'}-1k-${i}`, body);
    }),
  );
}

const report = {
  measuredAt: new Date().toISOString(),
  timeZone: 'Asia/Shanghai',
  bun: process.versions.bun ?? null,
  nodeCompat: process.version,
  platform: `${os.platform()} ${os.arch()}`,
  cpus: os.cpus().length,
  model: os.cpus()[0]?.model ?? '',
  memoryBytes: os.totalmem(),
  ops,
  warmup,
  results,
};
writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`\nwrote ${outFile}`);
await cleanup();
