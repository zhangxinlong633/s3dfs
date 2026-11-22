import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dleveldbCli = path.resolve(root, '../dleveldb/packages/dleveldb/src/dleveldb.ts');
const blockMain = path.join(root, 'apps/block/src/block.ts');
const bun = process.env.BUN_BIN ?? 'bun';
process.env.S3DFS_STRICT_LAYOUT ??= '0';
const ops = Number(process.env.S3DFS_BENCH_OPS ?? 5000);
const warmup = Number(process.env.S3DFS_BENCH_WARMUP ?? 500);
const focus = process.env.S3DFS_BENCH_FOCUS ?? '';
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

async function stopChildren() {
  for (const child of children.splice(0).reverse()) {
    await stop(child);
  }
}

async function cleanup() {
  await stopChildren();
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

async function measure(name, count, fn, warmN = warmup) {
  const samples = [];
  for (let i = 0; i < warmN; i++) {
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

async function measureConcurrent(name, count, inflight, fn, warmN = warmup) {
  for (let i = 0; i < warmN; i++) {
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

const { IndexClient, NodeRegistry, ObjectCluster, blockPut, blockGet, compressValue, decompressValue } = await import(
  pathToFileURL(path.join(root, 'packages/control/src/index.ts')).href
);
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const addon = require(path.join(root, 'packages/engine/build/Release/s3dfs_engine.node'));

async function startCluster(blockCount, dataReplicas, compressType = 'none') {
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
  const cluster = new ObjectCluster(kv, registry, dataReplicas, compressType);
  await registry.checkAll();
  if (registry.live().length !== blockCount) {
    throw new Error(`expected ${blockCount} live blocks`);
  }
  return { kv, cluster, seeds };
}

function fmtMib(bytesPerSec) {
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MiB/s`;
}

function repeatedPayload(n) {
  return Buffer.alloc(n, 0x61);
}

function randomPayload(n) {
  return randomBytes(n);
}

async function storedStats(cluster, bucket, prefix, count) {
  const sample = Math.min(count, 100);
  let stored = 0;
  let logical = 0;
  let compressType = 'none';
  for (let i = 0; i < sample; i++) {
    const locs = await cluster.locators(`${bucket}/${prefix}${i}`);
    if (!locs[0]) throw new Error(`missing locator ${prefix}${i}`);
    stored += locs[0].storedSize;
    logical += locs[0].size;
    compressType = locs[0].compressType ?? 'none';
  }
  return {
    compressType,
    sample,
    avgLogical: logical / sample,
    avgStored: stored / sample,
    ratio: stored === 0 ? 0 : logical / stored,
    savings: logical === 0 ? 0 : 1 - stored / logical,
  };
}

async function measurePair(label, count, cluster, bucket, prefix, body, warmN = warmup) {
  const put = await measure(`${label} put`, count, async (i, warm) => {
    await cluster.put(bucket, `${warm ? 'w' : prefix}${i}`, body);
  }, warmN);
  const stats = await storedStats(cluster, bucket, prefix, count);
  const get = await measure(`${label} get`, count, async (i) => {
    const got = await cluster.get(bucket, `${prefix}${i}`);
    if (!got) throw new Error('missing');
  }, warmN);
  const putMib = (count * body.length) / put.elapsedSec;
  const getMib = (count * body.length) / get.elapsedSec;
  const extra = {
    label,
    logicalBytes: body.length,
    ...stats,
    putOpsPerSec: put.opsPerSec,
    getOpsPerSec: get.opsPerSec,
    putMibPerSec: putMib / (1024 * 1024),
    getMibPerSec: getMib / (1024 * 1024),
    putP50Ns: put.p50Ns,
    putP99Ns: put.p99Ns,
    getP50Ns: get.p50Ns,
    getP99Ns: get.p99Ns,
  };
  console.log(
    `${''.padEnd(42)} stored ${stats.avgStored.toFixed(0)} / ${stats.avgLogical.toFixed(0)} B   ratio ${stats.ratio.toFixed(2)}x   save ${(stats.savings * 100).toFixed(1)}%   write ${fmtMib(putMib)}   read ${fmtMib(getMib)}`,
  );
  return { put, get, compress: extra };
}

function benchCodec(name, input, prefer, rounds = 200) {
  let packed = compressValue(input, prefer);
  for (let i = 0; i < 8; i++) packed = compressValue(input, prefer);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < rounds; i++) packed = compressValue(input, prefer);
  const compressSec = Number(process.hrtime.bigint() - t0) / 1e9;
  let out = decompressValue(packed.stored, packed.compressType);
  for (let i = 0; i < 8; i++) out = decompressValue(packed.stored, packed.compressType);
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < rounds; i++) out = decompressValue(packed.stored, packed.compressType);
  const decompressSec = Number(process.hrtime.bigint() - t1) / 1e9;
  if (!out.equals(input)) throw new Error(`codec mismatch ${name}`);
  const logical = input.length * rounds;
  const result = {
    name,
    prefer,
    applied: packed.compressType,
    logicalBytes: input.length,
    storedBytes: packed.stored.length,
    ratio: packed.stored.length === 0 ? 0 : input.length / packed.stored.length,
    savings: 1 - packed.stored.length / input.length,
    rounds,
    compressMibPerSec: logical / compressSec / (1024 * 1024),
    decompressMibPerSec: logical / decompressSec / (1024 * 1024),
  };
  console.log(
    `${name.padEnd(42)} ${packed.compressType.padEnd(5)}  ${String(packed.stored.length).padStart(8)} / ${String(input.length).padStart(8)} B   ratio ${result.ratio.toFixed(2)}x   cmp ${result.compressMibPerSec.toFixed(0).padStart(5)} MiB/s   dec ${result.decompressMibPerSec.toFixed(0).padStart(5)} MiB/s`,
  );
  return result;
}

function layoutCheck(name, bodies, logicalBytes) {
  const dir = mkdtempSync(path.join(work, 'layout-'));
  const store = new addon.Store(dir, { fsyncOnFlush: true });
  for (let i = 0; i < bodies.length; i++) store.put(`k/${i}`, bodies[i]);
  store.flush();
  const stats = store.stats();
  store.close();
  const blk = path.join(dir, 'blocks');
  const files = existsSync(blk)
    ? readdirSync(blk)
        .filter((n) => n.endsWith('.blk'))
        .map((n) => {
          const fp = path.join(blk, n);
          return { name: n, size: statSync(fp).size };
        })
    : [];
  const storedPayload = bodies.reduce((s, b) => s + b.length, 0);
  const logical = logicalBytes ?? storedPayload;
  const onDisk = files.reduce((s, f) => s + f.size, 0);
  const result = {
    name,
    objects: bodies.length,
    fileCount: files.length,
    files,
    logicalBytes: logical,
    storedPayloadBytes: storedPayload,
    onDiskBytes: onDisk,
    ratio: onDisk === 0 ? 0 : logical / onDisk,
    flushes: stats.flushes,
    fsyncs: stats.fsyncs,
    indexDir: existsSync(path.join(dir, 'index')),
  };
  console.log(
    `${name.padEnd(42)} ${String(files.length).padStart(2)} files   disk ${onDisk} B   logical ${logical} B   ratio ${result.ratio.toFixed(2)}x   fsyncs ${stats.fsyncs}`,
  );
  return result;
}

if (focus === 'n3') {
  const results = [];
  const { cluster } = await startCluster(3, 3);
  const kib = repeatedPayload(1024);
  const mib = randomPayload(1024 * 1024);
  await cluster.createBucket('bench');
  results.push(
    await measure('cluster put 1KiB  N=3  none', ops, async (i, warm) => {
      await cluster.put('bench', `${warm ? 'w' : 'p'}-1k-${i}`, kib);
    }),
  );
  results.push(
    await measure('cluster get 1KiB  N=3  none', ops, async (i) => {
      const got = await cluster.get('bench', `p-1k-${i}`);
      if (!got || got.value.length !== kib.length) throw new Error('missing');
    }),
  );
  results.push(
    await measure('cluster put 1MiB  N=3  none', 40, async (i, warm) => {
      await cluster.put('bench', `${warm ? 'w' : 'p'}-1m-${i}`, mib);
    }, 4),
  );
  results.push(
    await measure('cluster get 1MiB  N=3  none', 40, async (i) => {
      const got = await cluster.get('bench', `p-1m-${i}`);
      if (!got || got.value.length !== mib.length) throw new Error('missing');
    }, 4),
  );
  await stopChildren();
  const summary = {
    at: new Date().toISOString(),
    host: `${os.cpus()[0]?.model ?? ''} ${os.arch()}`,
    bun: process.versions.bun,
    note: 'localhost, three block processes on one machine, compress=none. Not a target-cluster capacity number.',
    results,
  };
  writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log(`\nwrote ${outFile}`);
  await cleanup();
  process.exit(0);
}

if (focus === 'grid') {
  const results = [];
  const sizes = [
    { label: '1KiB', bytes: 1024, ops: 1000, warm: 100 },
    { label: '10KiB', bytes: 10 * 1024, ops: 400, warm: 40 },
    { label: '100KiB', bytes: 100 * 1024, ops: 80, warm: 8 },
    { label: '1MiB', bytes: 1024 * 1024, ops: 40, warm: 4 },
  ];
  for (const copies of [1, 3]) {
    const { cluster } = await startCluster(copies, copies);
    await cluster.createBucket('bench');
    for (const size of sizes) {
      const body = randomPayload(size.bytes);
      const prefix = `n${copies}-${size.label}-`;
      results.push(
        await measure(`cluster put ${size.label}  N=${copies}  none`, size.ops, async (i, warm) => {
          await cluster.put('bench', `${prefix}${warm ? 'w' : 'p'}${i}`, body);
        }, size.warm),
      );
      results.push(
        await measure(`cluster get ${size.label}  N=${copies}  none`, size.ops, async (i) => {
          const got = await cluster.get('bench', `${prefix}p${i}`);
          if (!got || got.value.length !== body.length) throw new Error('missing');
        }, size.warm),
      );
    }
    await stopChildren();
  }
  const summary = {
    at: new Date().toISOString(),
    host: `${os.cpus()[0]?.model ?? ''} ${os.arch()}`,
    bun: process.versions.bun,
    note: 'localhost, compress=none, random bytes. N is object copies on one machine. Not a target-cluster capacity number.',
    results,
  };
  writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log(`\nwrote ${outFile}`);
  await cleanup();
  process.exit(0);
}

const results = [];
const codecResults = [];
const layoutResults = [];
const payload = (n) => repeatedPayload(n);

console.log(`s3dfs split bench  ops=${ops} warmup=${warmup}`);
console.log('cluster baseline rows use compress=none; compression cases are listed separately');
console.log(`bun ${process.versions.bun ?? bun}  node-compat ${process.version}  ${os.cpus()[0]?.model ?? ''}  ${os.arch()}`);
console.log('');

{
  const { cluster, seeds } = await startCluster(1, 1);
  const body = payload(1024);
  await cluster.createBucket('bench');
  const directLocs = new Array(ops + warmup);
  results.push(
    await measure('direct block put 1KiB (no index)', ops, async (i, warm) => {
      const loc = await blockPut(seeds[0].address, `raw/${warm ? 'w' : 'p'}-${i}`, body);
      if (!warm) directLocs[i] = loc;
    }),
  );
  results.push(
    await measure('direct block get 1KiB (no index)', ops, async (i) => {
      const got = await blockGet(seeds[0].address, `raw/p-${i}`, directLocs[i]);
      if (!got) throw new Error('missing');
    }),
  );
  results.push(
    await measure('cluster put 100B  N=1  none', ops, async (i, warm) => {
      await cluster.put('bench', `${warm ? 'w' : 'p'}-100-${i}`, payload(100));
    }),
  );
  results.push(
    await measure('cluster get 100B  N=1  none', ops, async (i) => {
      const got = await cluster.get('bench', `p-100-${i}`);
      if (!got) throw new Error('missing');
    }),
  );
  results.push(
    await measure('cluster put 1KiB  N=1  none', ops, async (i, warm) => {
      await cluster.put('bench', `${warm ? 'w' : 'p'}-1k-${i}`, body);
    }),
  );
  results.push(
    await measure('cluster get 1KiB  N=1  none', ops, async (i) => {
      const got = await cluster.get('bench', `p-1k-${i}`);
      if (!got) throw new Error('missing');
    }),
  );
  results.push(
    await measure('cluster put 16KiB N=1  none', Math.min(ops, 2000), async (i, warm) => {
      await cluster.put('bench', `${warm ? 'w' : 'p'}-16k-${i}`, payload(16 * 1024));
    }),
  );
  results.push(
    await measure('cluster get 16KiB N=1  none', Math.min(ops, 2000), async (i) => {
      const got = await cluster.get('bench', `p-16k-${i}`);
      if (!got) throw new Error('missing');
    }),
  );
  results.push(
    await measureConcurrent('cluster put 1KiB  N=1  none  32-in-flight', ops, 32, async (i, warm) => {
      await cluster.put('bench', `${warm ? 'cw' : 'c'}-1k-${i}`, body);
    }),
  );
  results.push(
    await measureConcurrent('cluster get 1KiB  N=1  none  32-in-flight', ops, 32, async (i) => {
      const got = await cluster.get('bench', `c-1k-${i}`);
      if (!got) throw new Error('missing');
    }),
  );
  await stopChildren();
}

{
  const { cluster } = await startCluster(3, 3);
  const body = payload(1024);
  await cluster.createBucket('bench');
  results.push(
    await measure('cluster put 1KiB  N=3  none', ops, async (i, warm) => {
      await cluster.put('bench', `${warm ? 'w' : 'p'}-1k-${i}`, body);
    }),
  );
  results.push(
    await measure('cluster get 1KiB  N=3  none', ops, async (i) => {
      const got = await cluster.get('bench', `p-1k-${i}`);
      if (!got) throw new Error('missing');
    }),
  );
  results.push(
    await measureConcurrent('cluster put 1KiB  N=3  none  32-in-flight', ops, 32, async (i, warm) => {
      await cluster.put('bench', `${warm ? 'cw' : 'c'}-1k-${i}`, body);
    }),
  );
  await stopChildren();
}

console.log('\nin-process codec (control plane, no disk)');
const bigRepeat = repeatedPayload(1024 * 1024);
const bigRandom = randomPayload(1024 * 1024);
codecResults.push(benchCodec('codec 1MiB repeated  zstd', bigRepeat, 'zstd'));
codecResults.push(benchCodec('codec 1MiB repeated  gzip', bigRepeat, 'gzip'));
codecResults.push(benchCodec('codec 1MiB random    zstd', bigRandom, 'zstd'));
codecResults.push(benchCodec('codec 1MiB random    gzip', bigRandom, 'gzip'));
codecResults.push(benchCodec('codec 16KiB repeated zstd', repeatedPayload(16 * 1024), 'zstd', 2000));
codecResults.push(benchCodec('codec 16KiB random   zstd', randomPayload(16 * 1024), 'zstd', 2000));

console.log('\ncluster compression (N=1, end-to-end put/get + ratio)');
{
  const cases = [
    { type: 'none', kind: 'repeated', size: 1024, count: ops },
    { type: 'zstd', kind: 'repeated', size: 1024, count: ops },
    { type: 'gzip', kind: 'repeated', size: 1024, count: ops },
    { type: 'zstd', kind: 'random', size: 1024, count: ops },
    { type: 'gzip', kind: 'random', size: 1024, count: ops },
    { type: 'none', kind: 'repeated', size: 16 * 1024, count: Math.min(ops, 2000) },
    { type: 'zstd', kind: 'repeated', size: 16 * 1024, count: Math.min(ops, 2000) },
    { type: 'zstd', kind: 'random', size: 16 * 1024, count: Math.min(ops, 2000) },
    { type: 'none', kind: 'repeated', size: 1024 * 1024, count: 80 },
    { type: 'zstd', kind: 'repeated', size: 1024 * 1024, count: 80 },
    { type: 'zstd', kind: 'random', size: 1024 * 1024, count: 80 },
  ];
  const clusters = {};
  for (const type of ['none', 'zstd', 'gzip']) {
    const started = await startCluster(1, 1, type);
    await started.cluster.createBucket('bench');
    clusters[type] = started.cluster;
  }
  let keySeq = 0;
  for (const c of cases) {
    const body = c.kind === 'random' ? randomPayload(c.size) : repeatedPayload(c.size);
    const sizeLabel = c.size >= 1024 * 1024 ? `${c.size / (1024 * 1024)}MiB` : `${c.size / 1024}KiB`;
    const label = `cluster ${sizeLabel} ${c.kind} ${c.type}`;
    const prefix = `p${keySeq++}-`;
    const warmN = c.size >= 1024 * 1024 ? 8 : warmup;
    const pair = await measurePair(label, c.count, clusters[c.type], 'bench', prefix, body, warmN);
    results.push(pair.put, pair.get);
    results.push({ kind: 'compress', ...pair.compress });
  }
  await stopChildren();
}

console.log('\nengine layout (direct C put, 5000 objects)');
{
  const n = 5000;
  const logical = n * 1024;
  const raw = Array.from({ length: n }, () => repeatedPayload(1024));
  layoutResults.push(layoutCheck('layout 5000 x 1KiB raw repeated', raw, logical));
  const zstdRepeat = raw.map((b) => compressValue(b, 'zstd'));
  layoutResults.push({
    ...layoutCheck('layout 5000 x 1KiB zstd repeated', zstdRepeat.map((p) => p.stored), logical),
    applied: zstdRepeat[0].compressType,
    avgStoredPayload: zstdRepeat.reduce((s, p) => s + p.stored.length, 0) / n,
  });
  const zstdRand = Array.from({ length: n }, () => compressValue(randomPayload(1024), 'zstd'));
  layoutResults.push({
    ...layoutCheck('layout 5000 x 1KiB zstd random', zstdRand.map((p) => p.stored), logical),
    applied: zstdRand[0].compressType,
    avgStoredPayload: zstdRand.reduce((s, p) => s + p.stored.length, 0) / n,
  });
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
  codecResults,
  layoutResults,
};
writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`\nwrote ${outFile}`);
await cleanup();
