/**
 * Unofficial capability + performance probe against the C S3 gateway
 * and, on the same stack, ObjectCluster. Not official pnpm bench.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync } from 'node:fs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const gateway = process.env.S3DFS_PROBE_S3 ?? 'http://127.0.0.1:39102';
const indexUrl = process.env.S3DFS_INDEX_URLS ?? 'http://127.0.0.1:39100';
const blockAddr = process.env.S3DFS_PROBE_BLOCK ?? '127.0.0.1:39101';
const ops = Number(process.env.S3DFS_BENCH_OPS ?? 5000);
const warmup = Number(process.env.S3DFS_BENCH_WARMUP ?? 500);
const outFile = process.env.S3DFS_BENCH_OUT ?? '/tmp/s3dfs-bench-c-gateway-2026-11-19.json';

const { IndexClient, NodeRegistry, ObjectCluster } = await import(
  pathToFileURL(path.join(root, 'packages/control/src/index.ts')).href
);

const agent = new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 64 });

function parseBase(url) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 80) };
}
const s3 = parseBase(gateway);

function s3req(method, urlPath, { body, headers, timeoutMs = 15000, close = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        agent: close ? false : agent,
        host: s3.host,
        port: s3.port,
        method,
        path: urlPath,
        headers: {
          ...(body ? { 'content-length': String(body.length) } : {}),
          ...(headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

const results = [];
function record(name, ok, detail) {
  const row = { name, ok: !!ok, ...detail };
  results.push(row);
  const mark = ok ? 'PASS' : 'FAIL';
  const extra = detail?.status != null ? ` status=${detail.status}` : '';
  const more = detail?.note ? ` ${detail.note}` : '';
  console.log(`${mark}  ${name}${extra}${more}`);
  return ok;
}

async function capability() {
  const bucket = 'cap-' + Date.now().toString(36);
  let all = true;

  const created = await s3req('PUT', `/${bucket}`);
  all = record('create bucket', created.status === 200, { status: created.status }) && all;

  const listedB = await s3req('GET', '/');
  const xmlB = listedB.body.toString('utf8');
  all =
    record('list buckets', listedB.status === 200 && xmlB.includes(`<Name>${bucket}</Name>`), {
      status: listedB.status,
    }) && all;

  const payload = Buffer.from('hello-s3dfs-c-gateway');
  const put = await s3req('PUT', `/${bucket}/file.txt`, { body: payload });
  all = record('put object', put.status === 200 && !!put.headers.etag, { status: put.status, etag: put.headers.etag }) && all;

  const got = await s3req('GET', `/${bucket}/file.txt`);
  all =
    record('get object', got.status === 200 && got.body.equals(payload), {
      status: got.status,
      bytes: got.body.length,
    }) && all;

  const head = await s3req('HEAD', `/${bucket}/file.txt`);
  all =
    record('head object', head.status === 200 && Number(head.headers['content-length']) === payload.length, {
      status: head.status,
      contentLength: head.headers['content-length'],
    }) && all;

  await s3req('PUT', `/${bucket}/a/x`, { body: Buffer.from('x') });
  await s3req('PUT', `/${bucket}/a/y`, { body: Buffer.from('y') });
  await s3req('PUT', `/${bucket}/b`, { body: Buffer.from('b') });

  const listed = await s3req('GET', `/${bucket}?prefix=`);
  const xml = listed.body.toString('utf8');
  all =
    record(
      'list objects',
      listed.status === 200 && xml.includes('<Key>file.txt</Key>') && xml.includes('<Key>a/x</Key>') && xml.includes('<Key>b</Key>'),
      { status: listed.status },
    ) && all;

  const delim = await s3req('GET', `/${bucket}?delimiter=${encodeURIComponent('/')}`);
  const dxml = delim.body.toString('utf8');
  all =
    record(
      'list delimiter=/',
      delim.status === 200 &&
        dxml.includes('<Prefix>a/</Prefix>') &&
        dxml.includes('<Key>b</Key>') &&
        dxml.includes('<Key>file.txt</Key>') &&
        !dxml.includes('<Key>a/x</Key>'),
      { status: delim.status, note: dxml.includes('<Prefix>a/</Prefix>') ? 'common prefix a/' : 'missing a/' },
    ) && all;

  const range = await s3req('GET', `/${bucket}/file.txt`, { headers: { range: 'bytes=6-10' } });
  all =
    record(
      'get range 206',
      range.status === 206 && range.body.toString('utf8') === 's3dfs' && String(range.headers['content-range']).includes('6-10'),
      { status: range.status, body: range.body.toString('utf8'), contentRange: range.headers['content-range'] },
    ) && all;

  const over = Buffer.from('overwritten-payload');
  const put2 = await s3req('PUT', `/${bucket}/file.txt`, { body: over });
  const got2 = await s3req('GET', `/${bucket}/file.txt`);
  all =
    record('overwrite', put2.status === 200 && got2.status === 200 && got2.body.equals(over), {
      status: got2.status,
    }) && all;

  const del = await s3req('DELETE', `/${bucket}/file.txt`);
  all = record('delete 204', del.status === 204, { status: del.status }) && all;

  const get404 = await s3req('GET', `/${bucket}/file.txt`, { close: true });
  const head404 = await s3req('HEAD', `/${bucket}/file.txt`, { close: true });
  all = record('get 404 after delete', get404.status === 404, { status: get404.status }) && all;
  all = record('head 404 after delete', head404.status === 404, { status: head404.status }) && all;

  const listed2 = await s3req('GET', `/${bucket}`);
  const xml2 = listed2.body.toString('utf8');
  all =
    record('list omits deleted key', listed2.status === 200 && !xml2.includes('<Key>file.txt</Key>'), {
      status: listed2.status,
    }) && all;

  return all;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function measure(name, count, fn, warmN = warmup) {
  for (let i = 0; i < warmN; i++) {
    await fn(i, true);
  }
  const samples = [];
  const start = process.hrtime.bigint();
  for (let i = 0; i < count; i++) {
    const a = process.hrtime.bigint();
    await fn(i, false);
    samples.push(process.hrtime.bigint() - a);
  }
  const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
  samples.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const result = {
    name,
    ops: count,
    warmup: warmN,
    inflight: 1,
    opsPerSec: count / elapsedSec,
    p50Ns: Number(percentile(samples, 50)),
    p99Ns: Number(percentile(samples, 99)),
    elapsedSec,
  };
  console.log(
    `${name.padEnd(48)} ${result.opsPerSec.toFixed(0).padStart(8)} ops/s   p50 ${(result.p50Ns / 1000).toFixed(0)}µs   p99 ${(result.p99Ns / 1000).toFixed(0)}µs`,
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
    warmup: warmN,
    inflight,
    opsPerSec: count / elapsedSec,
    p50Ns: Number(percentile(samples, 50)),
    p99Ns: Number(percentile(samples, 99)),
    elapsedSec,
  };
  console.log(
    `${name.padEnd(48)} ${result.opsPerSec.toFixed(0).padStart(8)} ops/s   p50 ${(result.p50Ns / 1000).toFixed(0)}µs   p99 ${(result.p99Ns / 1000).toFixed(0)}µs`,
  );
  return result;
}

async function perf() {
  const body1k = Buffer.alloc(1024, 0x61);
  const body1m = Buffer.alloc(1024 * 1024, 0x61);
  const bench = [];

  const bC = 'c-gw-bench';
  const created = await s3req('PUT', `/${bC}`);
  if (created.status !== 200) throw new Error(`create bench bucket ${created.status}`);

  bench.push(
    await measure('c-gateway S3 put 1KiB seq', ops, async (i, warm) => {
      const r = await s3req('PUT', `/${bC}/${warm ? 'w' : 'p'}-1k-${i}`, { body: body1k });
      if (r.status !== 200) throw new Error(`put ${r.status}`);
    }),
  );
  bench.push(
    await measure('c-gateway S3 get 1KiB seq', ops, async (i) => {
      const r = await s3req('GET', `/${bC}/p-1k-${i}`);
      if (r.status !== 200 || r.body.length !== 1024) throw new Error(`get ${r.status} len=${r.body.length}`);
    }),
  );
  bench.push(
    await measureConcurrent(
      'c-gateway S3 put 1KiB 32-in-flight',
      ops,
      32,
      async (i, warm) => {
        const r = await s3req('PUT', `/${bC}/${warm ? 'cw' : 'c'}-1k-${i}`, { body: body1k });
        if (r.status !== 200) throw new Error(`put ${r.status}`);
      },
    ),
  );
  bench.push(
    await measureConcurrent('c-gateway S3 get 1KiB 32-in-flight', ops, 32, async (i) => {
      const r = await s3req('GET', `/${bC}/c-1k-${i}`);
      if (r.status !== 200 || r.body.length !== 1024) throw new Error(`get ${r.status}`);
    }),
  );

  const mibOps = 80;
  const mibWarm = 8;
  const mibPut = await measure(
    'c-gateway S3 put 1MiB seq',
    mibOps,
    async (i, warm) => {
      const r = await s3req('PUT', `/${bC}/${warm ? 'mw' : 'm'}-1m-${i}`, { body: body1m });
      if (r.status !== 200) throw new Error(`put 1MiB ${r.status}`);
    },
    mibWarm,
  );
  mibPut.mibPerSec = (mibOps * body1m.length) / mibPut.elapsedSec / (1024 * 1024);
  console.log(`${''.padEnd(48)} write ${mibPut.mibPerSec.toFixed(1)} MiB/s`);
  bench.push(mibPut);

  const kv = new IndexClient([indexUrl]);
  const registry = new NodeRegistry(kv, [{ nodeId: 'block1', address: blockAddr }]);
  const cluster = new ObjectCluster(kv, registry, 1, 'none');
  await registry.checkAll();
  if (registry.live().length < 1) throw new Error('ObjectCluster: no live block nodes');
  await cluster.createBucket('oc-bench');

  bench.push(
    await measure('ObjectCluster put 1KiB seq (same stack)', ops, async (i, warm) => {
      await cluster.put('oc-bench', `${warm ? 'w' : 'p'}-1k-${i}`, body1k);
    }),
  );
  bench.push(
    await measure('ObjectCluster get 1KiB seq (same stack)', ops, async (i) => {
      const got = await cluster.get('oc-bench', `p-1k-${i}`);
      if (!got || got.value.length !== 1024) throw new Error('missing');
    }),
  );
  bench.push(
    await measureConcurrent('ObjectCluster put 1KiB 32-in-flight (same stack)', ops, 32, async (i, warm) => {
      await cluster.put('oc-bench', `${warm ? 'cw' : 'c'}-1k-${i}`, body1k);
    }),
  );
  bench.push(
    await measureConcurrent('ObjectCluster get 1KiB 32-in-flight (same stack)', ops, 32, async (i) => {
      const got = await cluster.get('oc-bench', `c-1k-${i}`);
      if (!got || got.value.length !== 1024) throw new Error('missing');
    }),
  );

  return bench;
}

const capOk = await capability();
console.log(capOk ? '\ncapability: ALL PASS' : '\ncapability: FAILED');
const bench = await perf();

const published = {
  source: 'docs/bench-2026-11-17.json (official, do not treat this probe as a replacement)',
  measuredAt: '2026-11-17T00:40+08:00',
  method: 'in-process ObjectCluster.put/get, HTTP to index+block, not via S3 gateway',
  'cluster put 1KiB N=1 none seq': 6937,
  'cluster get 1KiB N=1 none seq': 8869,
  'cluster put 1KiB N=1 none 32-in-flight': 31119,
  'cluster get 1KiB N=1 none 32-in-flight': 51859,
};

const report = {
  unofficial: true,
  label: 'exploratory C S3 gateway vs same-stack ObjectCluster, 2026-11-19',
  measuredAt: new Date().toISOString(),
  timeZone: 'Asia/Shanghai',
  platform: `${os.platform()} ${os.arch()}`,
  cpus: os.cpus().length,
  model: os.cpus()[0]?.model ?? '',
  memoryBytes: os.totalmem(),
  method: {
    path: 'isolated stack under /tmp/s3dfs-c-gw-probe',
    ports: { index: 39100, block: 39101, cGateway: 39102 },
    compress: 'none',
    dataReplicas: 1,
    dleveldbSync: 'default true (unset)',
    body: '1KiB 0x61 (and optional 1MiB 0x61)',
    warmup,
    ops,
    concurrency: [1, 32],
    s3Client: 'node:http keep-alive Agent against C gateway',
    clusterClient: 'packages/control ObjectCluster against the same index+block (no S3 gateway)',
    note: 'Not official pnpm bench. Official file docs/bench-2026-11-17.json was not modified.',
  },
  capability: { allPass: capOk, results },
  bench,
  officialPublishedForReference: published,
};

writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`\nwrote ${outFile}`);
agent.destroy();
process.exit(capOk ? 0 : 2);
