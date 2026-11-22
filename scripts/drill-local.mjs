import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { signRequest } from '../apps/api/src/s3/sigv4.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dleveldbCli = path.resolve(root, '../dleveldb/packages/dleveldb/src/dleveldb.ts');
const blockMain = path.join(root, 'apps/block/src/block.ts');
const apiMain = path.join(root, 'apps/api/src/main.ts');
const bun = process.env.BUN_BIN ?? 'bun';
const accessKey = 'drill';
const secretKey = 'drill-secret';
const patrol = 'drill-patrol';
const work = mkdtempSync(path.join(tmpdir(), 's3dfs-drill-'));
const children = [];
const notes = [];
const started = new Date();

const indexPorts = [18210, 18211, 18212];
const blockPorts = [18100, 18101, 18102];
const zones = ['zone-a', 'zone-b', 'zone-c'];
const apiPorts = [18300, 18301];
const indexUrls = indexPorts.map((port) => `http://127.0.0.1:${port}`).join(',');
const blockSeeds = blockPorts
  .map((port, i) => `block${i + 1}=127.0.0.1:${port}@${zones[i]}`)
  .join(',');

function note(step, ok, detail) {
  const row = { at: new Date().toISOString(), step, ok, detail };
  notes.push(row);
  console.log(`${ok ? 'ok' : 'FAIL'}  ${step}  ${detail}`);
}

function run(command, args, env, cwd) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = path.basename(String(args[0] ?? command));
  child.stdout.on('data', (buf) => process.stdout.write(`[${tag}] ${buf}`));
  child.stderr.on('data', (buf) => process.stderr.write(`[${tag}] ${buf}`));
  children.push(child);
  return child;
}

function waitPort(port, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => {
        sock.end();
        resolve();
      });
      sock.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`timeout waiting for 127.0.0.1:${port}`));
          return;
        }
        setTimeout(tick, 100);
      });
    };
    tick();
  });
}

function stop(child) {
  if (!child || child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => resolve();
    child.once('exit', done);
    try {
      child.kill('SIGTERM');
    } catch {
      done();
      return;
    }
    setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          done();
        }
      }
    }, 500);
    setTimeout(done, 1500);
  });
}

async function cleanup() {
  for (const child of children.splice(0).reverse()) {
    await stop(child);
  }
  rmSync(work, { recursive: true, force: true });
}

function indexEnv(i) {
  const port = indexPorts[i];
  return {
    DLEVELDB_PORT: String(port),
    DLEVELDB_ADVERTISE_ADDR: `127.0.0.1:${port}`,
    DLEVELDB_DATA_DIR: path.join(work, `index${i + 1}`),
    DLEVELDB_NODE_ID: `index${i + 1}`,
    DLEVELDB_VNODES: '16',
    DLEVELDB_REPLICAS: '3',
    DLEVELDB_PEERS: i === 0 ? '' : `127.0.0.1:${indexPorts[0]}`,
  };
}

function blockEnv(i) {
  const port = blockPorts[i];
  return {
    S3DFS_BLOCK_NODE_ID: `block${i + 1}`,
    S3DFS_BLOCK_PORT: String(port),
    S3DFS_ADVERTISE_ADDR: `127.0.0.1:${port}`,
    S3DFS_DATA_DIR: path.join(work, `block${i + 1}`),
    S3DFS_INDEX_URLS: indexUrls,
    S3DFS_FLUSH_INTERVAL_MS: '20',
    S3DFS_COMPACT_INTERVAL_MS: '0',
  };
}

function apiEnv(port) {
  return {
    S3DFS_API_PORT: String(port),
    S3DFS_ADVERTISE_ADDR: `127.0.0.1:${port}`,
    S3DFS_ACCESS_KEY: accessKey,
    S3DFS_SECRET_KEY: secretKey,
    S3DFS_PATROL_TOKEN: patrol,
    S3DFS_STRICT_LAYOUT: '1',
    S3DFS_DATA_REPLICAS: '3',
    S3DFS_INDEX_URLS: indexUrls,
    S3DFS_BLOCK_NODES: blockSeeds,
    S3DFS_COMPACT_INTERVAL_MS: '0',
    S3DFS_REPAIR_INTERVAL_MS: '0',
    S3DFS_FLUSH_INTERVAL_MS: '0',
  };
}

function signedHeaders(method, url, body) {
  const u = new URL(url);
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const scope = `${amzDate.slice(0, 8)}/us-east-1/s3/aws4_request`;
  const hash = createHash('sha256').update(body).digest('hex');
  const headers = {
    host: u.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': hash,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=0`,
  };
  const signature = signRequest(secretKey, { method, path: u.pathname, query: u.searchParams, headers, body }, amzDate, scope);
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`;
  return headers;
}

async function s3(port, method, resource, body = Buffer.alloc(0), extra = {}) {
  const url = `http://127.0.0.1:${port}${resource}`;
  const headers = { ...signedHeaders(method, url, body), ...extra };
  const res = await fetch(url, { method, headers, body: body.length > 0 || method === 'POST' || method === 'PUT' ? body : undefined });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body: bytes };
}

async function health(port) {
  const res = await fetch(`http://127.0.0.1:${port}/_s3dfs/health`);
  const json = await res.json();
  return { status: res.status, json };
}

async function repair(port) {
  const res = await fetch(`http://127.0.0.1:${port}/_s3dfs/repair`, {
    method: 'POST',
    headers: { 'x-s3dfs-patrol-token': patrol },
  });
  const text = await res.text();
  return { status: res.status, text };
}

const { IndexClient } = await import(pathToFileURL(path.join(root, 'packages/control/src/kv-client.ts')).href);

let failed = false;
try {
  const indexes = [];
  for (let i = 0; i < 3; i++) {
    indexes.push(run(bun, [dleveldbCli], indexEnv(i), root));
    await waitPort(indexPorts[i]);
  }
  const ringStart = Date.now();
  let ring = [];
  while (Date.now() - ringStart < 20000) {
    ring = await Promise.all(
      indexPorts.map(async (port) => {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/_dleveldb/cluster`);
          const json = await res.json();
          return json.physicalNodes ?? 0;
        } catch {
          return 0;
        }
      }),
    );
    if (ring.every((count) => count >= 3)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ring.every((count) => count >= 3)) {
    throw new Error(`index ring did not reach 3 nodes: ${ring.join(',')}`);
  }
  note('0 index ring', true, `physical nodes ${ring.join(',')}`);
  const blocks = [];
  for (let i = 0; i < 3; i++) {
    blocks.push(run(bun, [blockMain], blockEnv(i), path.join(root, 'apps/block')));
    await waitPort(blockPorts[i]);
  }
  const apis = [];
  for (const port of apiPorts) {
    apis.push(run(bun, [apiMain], apiEnv(port), path.join(root, 'apps/api')));
    await waitPort(port);
  }
  const kv = new IndexClient(indexUrls.split(','));

  const h0 = await health(apiPorts[0]);
  const step1 = h0.status === 200 && h0.json.layout?.ok === true && h0.json.liveBlocks === 3 && h0.json.failureDomains === 3;
  note('1 health', step1, `status ${h0.status} live ${h0.json.liveBlocks} zones ${h0.json.failureDomains} layout.ok ${h0.json.layout?.ok}`);
  failed ||= !step1;

  const bucket = await s3(apiPorts[0], 'PUT', '/drill');
  note('4 create bucket', bucket.status === 200, `status ${bucket.status} ${bucket.body.toString('utf8').slice(0, 180)}`);
  failed ||= bucket.status !== 200;

  await stop(blocks[2]);
  const put1 = await s3(apiPorts[0], 'PUT', '/drill/one-down.txt', Buffer.from('while-one-block-down'));
  const get1 = await s3(apiPorts[0], 'GET', '/drill/one-down.txt');
  const putOk = put1.status === 200 && get1.body.toString('utf8') === 'while-one-block-down';
  const repaired = await repair(apiPorts[0]);
  const locs = await kv.get('drill/one-down.txt');
  const locList = [];
  for (let i = 0; i < 3; i++) {
    const raw = await kv.get(i === 0 ? 'drill/one-down.txt' : `drill/one-down.txt:${i}`);
    if (raw) {
      locList.push(JSON.parse(raw.value.toString('utf8')));
    }
  }
  const pointsAtStopped = locList.some((loc) => loc.nodeId === 'block3');
  const repairOk = repaired.status >= 200 && repaired.status < 300;
  note(
    '2 stop one block',
    putOk && repairOk && locList.length >= 2 && !pointsAtStopped,
    `put ${put1.status} get ${get1.status} repair ${repaired.status} locators ${locList.map((loc) => loc.nodeId).join(',')} primary ${locs ? 'yes' : 'no'}`,
  );
  failed ||= !(putOk && repairOk && !pointsAtStopped);

  blocks[2] = run(bun, [blockMain], blockEnv(2), path.join(root, 'apps/block'));
  await waitPort(blockPorts[2]);
  await health(apiPorts[0]);
  const repairedBack = await repair(apiPorts[0]);
  const restored = [];
  for (let i = 0; i < 3; i++) {
    const raw = await kv.get(i === 0 ? 'drill/one-down.txt' : `drill/one-down.txt:${i}`);
    if (raw) {
      restored.push(JSON.parse(raw.value.toString('utf8')).nodeId);
    }
  }
  note('2 node back', repairedBack.status < 300 && restored.length === 3 && restored.includes('block3'), `repair ${repairedBack.status} locators ${restored.join(',')}`);
  failed ||= restored.length !== 3;

  await stop(blocks[1]);
  await stop(blocks[2]);
  await health(apiPorts[0]);
  const putShort = await s3(apiPorts[0], 'PUT', '/drill/one-left.txt', Buffer.from('nope'));
  const hShort = await health(apiPorts[0]);
  const reasons = JSON.stringify(hShort.json.reasons ?? hShort.json.layout?.reasons ?? []);
  const shortOk = putShort.status >= 400 && hShort.status === 503 && reasons.includes('live block nodes');
  note('2 one block left', shortOk, `put ${putShort.status} health ${hShort.status} reasons ${reasons}`);
  failed ||= !shortOk;
  blocks[1] = run(bun, [blockMain], blockEnv(1), path.join(root, 'apps/block'));
  blocks[2] = run(bun, [blockMain], blockEnv(2), path.join(root, 'apps/block'));
  await waitPort(blockPorts[1]);
  await waitPort(blockPorts[2]);
  const hBack = await health(apiPorts[0]);
  note('2 blocks restored', hBack.status === 200, `health ${hBack.status} live ${hBack.json.liveBlocks}`);

  await stop(indexes[2]);
  const during = Buffer.from('while-one-index-down');
  const putIndex = await s3(apiPorts[0], 'PUT', '/drill/index-down.txt', during);
  const getOther = await s3(apiPorts[1], 'GET', '/drill/index-down.txt');
  note(
    '3 stop one index',
    putIndex.status === 200 && getOther.body.equals(during),
    `put ${putIndex.status} other-api get ${getOther.status} bytes ${getOther.body.length}`,
  );
  failed ||= putIndex.status !== 200 || !getOther.body.equals(during);
  indexes[2] = run(bun, [dleveldbCli], indexEnv(2), root);
  await waitPort(indexPorts[2]);
  await new Promise((r) => setTimeout(r, 2000));
  const getAfter = await s3(apiPorts[0], 'GET', '/drill/index-down.txt');
  const listed = await s3(apiPorts[1], 'GET', '/drill?list-type=2');
  const listOk = listed.body.toString('utf8').includes('index-down.txt');
  note('3 index caught up', getAfter.body.equals(during) && listOk, `get ${getAfter.status} list has key ${listOk}`);
  failed ||= !getAfter.body.equals(during) || !listOk;

  const partA = Buffer.from('aaaa');
  const partB = Buffer.from('bbbb-bbbb');
  const opened = await s3(apiPorts[0], 'POST', '/drill/multi.bin?uploads');
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(opened.body.toString('utf8'))?.[1] ?? '';
  const p1 = await s3(apiPorts[0], 'PUT', `/drill/multi.bin?partNumber=1&uploadId=${encodeURIComponent(uploadId)}`, partA);
  const p2 = await s3(apiPorts[0], 'PUT', `/drill/multi.bin?partNumber=2&uploadId=${encodeURIComponent(uploadId)}`, partB);
  await stop(apis[0]);
  apis[0] = run(bun, [apiMain], apiEnv(apiPorts[0]), path.join(root, 'apps/api'));
  await waitPort(apiPorts[0]);
  const etag = (res) => res.headers.get('etag') ?? '';
  const completeXml = Buffer.from(
    `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag(p1)}</ETag></Part><Part><PartNumber>2</PartNumber><ETag>${etag(p2)}</ETag></Part></CompleteMultipartUpload>`,
  );
  const completed = await s3(apiPorts[0], 'POST', `/drill/multi.bin?uploadId=${encodeURIComponent(uploadId)}`, completeXml);
  const gotMulti = await s3(apiPorts[1], 'GET', '/drill/multi.bin');
  const ranged = await s3(apiPorts[0], 'GET', '/drill/multi.bin', Buffer.alloc(0), { range: 'bytes=0-3' });
  const multiOk = gotMulti.body.equals(Buffer.concat([partA, partB])) && ranged.status === 206 && ranged.body.equals(partA);
  note('4 multipart restart', opened.status === 200 && completed.status === 200 && multiOk, `open ${opened.status} parts ${p1.status}/${p2.status} complete ${completed.status} get ${gotMulti.body.length} range ${ranged.status}`);
  failed ||= !multiOk;

  const removed = await s3(apiPorts[0], 'DELETE', '/drill/one-down.txt');
  const empty = await s3(apiPorts[0], 'PUT', '/empty-drill');
  const removedBucket = await s3(apiPorts[0], 'DELETE', '/empty-drill');
  const unsigned = await fetch('http://127.0.0.1:18300/drill/index-down.txt');
  note('4 signed delete and unsigned', removed.status === 204 && empty.status === 200 && removedBucket.status === 204 && unsigned.status === 403, `delete ${removed.status} empty-bucket ${removedBucket.status} unsigned ${unsigned.status}`);
  failed ||= unsigned.status !== 403;

  for (const key of ['index-down.txt', 'multi.bin']) {
    await s3(apiPorts[0], 'DELETE', `/drill/${key}`);
  }
  const drop = await s3(apiPorts[0], 'DELETE', '/drill');
  const hDone = await health(apiPorts[0]);
  note('5 delete drill bucket', drop.status === 204 && hDone.status === 200 && hDone.json.lost === 0, `delete ${drop.status} health ${hDone.status} lost ${hDone.json.lost}`);
  failed ||= drop.status !== 204 || hDone.status !== 200;

  const lostBucket = await s3(apiPorts[0], 'PUT', '/lost-drill');
  const lostPut = await s3(apiPorts[0], 'PUT', '/lost-drill/gone.txt', Buffer.from('gone'));
  for (const child of blocks) {
    await stop(child);
  }
  const lostRepair = await repair(apiPorts[0]);
  const hLost = await health(apiPorts[0]);
  note('lost object', lostBucket.status === 200 && lostPut.status === 200 && hLost.status === 503 && hLost.json.lost >= 1, `repair ${lostRepair.status} health ${hLost.status} lost ${hLost.json.lost}`);
  failed ||= hLost.json.lost < 1;
} catch (err) {
  failed = true;
  note('exception', false, err instanceof Error ? err.stack ?? err.message : String(err));
} finally {
  const out = path.join(root, 'docs/milestones/2026-11-21-local-drill.md');
  const lines = [
    '# 本机演练',
    '',
    '| | |',
    '| --- | --- |',
    `| 日期 | ${started.toISOString()} |`,
    '| 机器 | 本机 localhost，三个索引进程、三个 block 进程、两个 API 进程 |',
    '| 效力 | 这不是准备承接流量的集群。上线标准要求同一套步骤在目标机器上再做一遍 |',
    '',
    '| 步骤 | 结果 | 记录 |',
    '| --- | --- | --- |',
    ...notes.map((row) => `| ${row.step} | ${row.ok ? '通过' : '失败'} | ${row.detail.replaceAll('|', '/')} |`),
    '',
    failed ? '有步骤失败。目标集群演练仍然开着。' : '本机五步和丢失检查都通过。目标集群演练仍然开着。',
    '',
  ];
  writeFileSync(out, lines.join('\n'));
  console.log(`wrote ${out}`);
  await cleanup();
  process.exit(failed ? 1 : 0);
}
