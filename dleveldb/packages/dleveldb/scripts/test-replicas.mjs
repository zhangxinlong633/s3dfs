/**
 * 多进程副本测试：三个独立进程、不同 data dir 和端口，通过 DLEVELDB_PEERS 加入环，
 * N=3、W=2。杀掉主副本所在进程后，对象仍可从剩余节点读取。
 * 剩余节点达到写法定人数时可以继续写入。主节点带着原数据目录回来后，会把较新的值补回自己的分片。
 *
 *   npm run build
 *   npm run test:replicas
 *
 * 子进程模式（测试脚本自己会 spawn）：
 *   node scripts/test-replicas.mjs --serve
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const root = path.join(path.dirname(here), '..');
const dist = path.join(root, 'dist', 'index.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function log(msg) {
  console.log(msg);
}

if (process.argv.includes('--serve')) {
  if (!fs.existsSync(dist)) {
    console.error('dleveldb dist missing');
    process.exit(1);
  }
  const { DLevelDB, loadConfig, listenDLevelDB } = await import(pathToFileURL(dist).href);
  const cfg = loadConfig();
  const db = await DLevelDB.open(cfg);
  const server = await listenDLevelDB(db);
  const shutdown = async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  process.send?.({ ready: true, address: cfg.advertiseAddr, nodeId: cfg.nodeId });
  log(`serve ${cfg.nodeId} ${cfg.advertiseAddr} ${cfg.dataDir}`);
} else {
  await runHarness();
}

async function runHarness() {
  if (!fs.existsSync(dist)) {
    throw new Error('cannot load dleveldb dist; run: npm run build');
  }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dleveldb-replicas-'));
  const nodes = [
    { nodeId: 'nodeA', port: 19011, dataDir: path.join(base, 'A'), peers: '' },
    { nodeId: 'nodeB', port: 19021, dataDir: path.join(base, 'B'), peers: '127.0.0.1:19011' },
    { nodeId: 'nodeC', port: 19031, dataDir: path.join(base, 'C'), peers: '127.0.0.1:19011' },
  ];

  const children = [];
  try {
    for (const n of nodes) {
      children.push(await startNode(n));
    }
    await waitForRing(nodes, 3);

    const key = 'logs/2026/replicated.log';
    const value = Buffer.from('replica-payload-v1');
    await put(nodes[0], key, value);

    let remoteKey = '';
    for (let i = 0; i < 64 && !remoteKey; i += 1) {
      const candidate = `logs/scan-${i}`;
      await put(nodes[1], candidate, Buffer.from('scan-owned-elsewhere'));
      const local = await scan(nodes[0], 'logs/scan-', '/_dleveldb/scan');
      if (!local.objects.some((obj) => obj.key === candidate)) {
        remoteKey = candidate;
      }
    }
    assert(remoteKey, 'expected a key whose primary shard is not on the seed');
    const merged = await scan(nodes[0], 'logs/scan-', '/_dleveldb/kv/scan');
    assert(
      merged.objects.some((obj) => obj.key === remoteKey),
      'seed with an empty peer list must list keys stored on nodes that joined later',
    );

    for (const n of nodes) {
      let got = null;
      for (let attempt = 0; attempt < 50 && !(got && got.equals(value)); attempt += 1) {
        got = await get(n, key);
        if (!(got && got.equals(value))) {
          await sleep(20);
        }
      }
      assert(got && got.equals(value), `get from ${n.nodeId} before failure`);
    }

    const lookup = await json(`http://127.0.0.1:${nodes[0].port}/_dleveldb/cluster/lookup?key=${encodeURIComponent(key)}`);
    const primaryId = lookup.primary?.nodeId;
    assert(primaryId, 'lookup should return a primary');
    const primary = nodes.find((n) => n.nodeId === primaryId);
    const survivors = nodes.filter((n) => n.nodeId !== primaryId);
    assert(primary && survivors.length === 2, 'need primary + 2 survivors');

    await stopNode(children, primary.nodeId);
    await sleep(500);

    const got = await get(survivors[0], key);
    assert(got && got.equals(value), `readable from ${survivors[0].nodeId} after primary ${primaryId} is down`);
    const got2 = await get(survivors[1], key);
    assert(got2 && got2.equals(value), `readable from ${survivors[1].nodeId} after primary is down`);

    let writeFailed = false;
    const next = Buffer.from('written-while-primary-down');
    try {
      await put(survivors[0], key, next);
    } catch (err) {
      writeFailed = true;
      log(String(err));
    }
    assert(!writeFailed, 'write should succeed on a survivor while the primary is down');
    let updated = null;
    for (let attempt = 0; attempt < 50 && !(updated && updated.equals(next)); attempt += 1) {
      updated = await get(survivors[1], key);
      if (!(updated && updated.equals(next))) {
        await sleep(20);
      }
    }
    assert(updated && updated.equals(next), 'the other survivor must read the write accepted while the primary is down');

    const restarted = await startNode({
      nodeId: primary.nodeId,
      port: primary.port,
      dataDir: primary.dataDir,
      peers: `127.0.0.1:${survivors[0].port}`,
    });
    children.push(restarted);
    await sleep(1500);
    const caughtUp = await get(primary, key);
    assert(caughtUp && caughtUp.equals(next), 'restarted primary must catch up the write made while it was down');

    log('ok replicas', { dir: base, primary: primaryId, survivors: survivors.map((s) => s.nodeId) });
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    for (const child of children) {
      if (child.proc.exitCode === null && child.proc.signalCode === null) {
        child.proc.kill('SIGTERM');
      }
    }
    await sleep(300);
  }
}

function startNode(n) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [here, '--serve'], {
      env: {
        ...process.env,
        DLEVELDB_DATA_DIR: n.dataDir,
        DLEVELDB_NODE_ID: n.nodeId,
        DLEVELDB_ADVERTISE_ADDR: `127.0.0.1:${n.port}`,
        DLEVELDB_PORT: String(n.port),
        DLEVELDB_PEERS: n.peers,
        DLEVELDB_VNODES: '1',
        DLEVELDB_REPLICAS: '3',
        DLEVELDB_WRITE_QUORUM: '2',
        DLEVELDB_SYNC: 'true',
        DLEVELDB_STABILIZE_INTERVAL_MS: '200',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    proc.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`timeout starting ${n.nodeId}: ${stderr || stdout}`));
    }, 15000);
    proc.on('message', (msg) => {
      if (msg && msg.ready) {
        clearTimeout(timer);
        resolve({ ...n, proc });
      }
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`${n.nodeId} exited early code=${code} signal=${signal} ${stderr || stdout}`));
    });
  }).then((started) => {
    started.proc.removeAllListeners('exit');
    return started;
  });
}

async function stopNode(children, nodeId) {
  const child = children.find((c) => c.nodeId === nodeId);
  if (!child) return;
  child.proc.kill('SIGTERM');
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 3000);
    child.proc.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function waitForRing(nodes, physical) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const statuses = await Promise.all(nodes.map((n) => json(`http://127.0.0.1:${n.port}/_dleveldb/cluster`)));
      if (statuses.every((s) => s.physicalNodes >= physical && s.effectiveReplicas === physical)) {
        return statuses;
      }
    } catch {
      // still joining
    }
    await sleep(200);
  }
  throw new Error('timeout waiting for ring membership');
}

function put(node, key, value) {
  return request(`http://127.0.0.1:${node.port}/_dleveldb/kv/put`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-dleveldb-key': encodeURIComponent(key) },
    body: value,
  }).then((res) => {
    if (res.status >= 400) {
      throw new Error(`put ${res.status}: ${res.body.toString()}`);
    }
  });
}

async function scan(node, prefix, path) {
  const res = await request(`http://127.0.0.1:${node.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ prefix, maxKeys: 100 })),
  });
  if (res.status >= 400) {
    throw new Error(`scan ${path} ${res.status}: ${res.body.toString()}`);
  }
  return JSON.parse(res.body.toString());
}

async function get(node, key) {
  const res = await request(`http://127.0.0.1:${node.port}/_dleveldb/kv/get?key=${encodeURIComponent(key)}`);
  if (res.status === 404) return null;
  if (res.status >= 400) throw new Error(`get ${res.status}: ${res.body.toString()}`);
  return res.body;
}

function json(url) {
  return request(url).then((res) => {
    if (res.status >= 400) throw new Error(`${url} -> ${res.status} ${res.body.toString()}`);
    return JSON.parse(res.body.toString());
  });
}

function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`timeout ${url}`));
    });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
