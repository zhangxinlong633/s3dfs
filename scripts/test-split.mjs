import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dleveldbCli = path.resolve(root, '../dleveldb/packages/dleveldb/src/cli.ts');
const blockMain = path.join(root, 'apps/block/src/main.ts');
const bun = process.env.BUN_BIN ?? 'bun';

if (!existsSync(dleveldbCli)) {
  console.error(`missing dleveldb at ${dleveldbCli}`);
  process.exit(1);
}

const work = mkdtempSync(path.join(tmpdir(), 's3dfs-split-'));
const children = [];

function run(command, args, env = {}) {
  const cwd = args[0] === blockMain ? path.join(root, 'apps/block') : root;
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (buf) => process.stdout.write(`[${path.basename(String(args[0] ?? command))}] ${buf}`));
  child.stderr.on('data', (buf) => process.stderr.write(`[${path.basename(String(args[0] ?? command))}] ${buf}`));
  children.push(child);
  return child;
}

async function waitPort(port, timeoutMs = 15_000) {
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
    await new Promise((r) => setTimeout(r, 100));
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

const {
  IndexClient,
  NodeRegistry,
  ObjectCluster,
  isReplicaLocatorKey,
  isVisibleObjectKey,
  locatorKey,
} = await import(pathToFileURL(path.join(root, 'packages/control/src/index.ts')).href);

if (locatorKey('logs/a.log', 0) !== 'logs/a.log' || locatorKey('logs/a.log', 1) !== 'logs/a.log:1') {
  throw new Error('locatorKey failed');
}
if (!isReplicaLocatorKey('logs/a.log:2') || isVisibleObjectKey('logs/a.log:2') || !isVisibleObjectKey('logs/a.log')) {
  throw new Error('visible-key filter failed');
}

run(bun, [dleveldbCli], {
  DLEVELDB_PORT: '19800',
  DLEVELDB_ADVERTISE_ADDR: '127.0.0.1:19800',
  DLEVELDB_DATA_DIR: path.join(work, 'index'),
  DLEVELDB_NODE_ID: 'index1',
  DLEVELDB_VNODES: '1',
  DLEVELDB_REPLICAS: '1',
});
await waitPort(19800);

const blockEnv = (id, port) => ({
  S3DFS_BLOCK_NODE_ID: id,
  S3DFS_BLOCK_PORT: String(port),
  S3DFS_ADVERTISE_ADDR: `127.0.0.1:${port}`,
  S3DFS_DATA_DIR: path.join(work, id),
  S3DFS_INDEX_URLS: 'http://127.0.0.1:19800',
  S3DFS_FLUSH_INTERVAL_MS: '20',
});

const block1 = run(bun, [blockMain], blockEnv('block1', 19100));
const block2 = run(bun, [blockMain], blockEnv('block2', 19101));
await waitPort(19100);
await waitPort(19101);

const kv = new IndexClient(['http://127.0.0.1:19800']);
const registry = new NodeRegistry(kv, [
  { nodeId: 'block1', address: '127.0.0.1:19100' },
  { nodeId: 'block2', address: '127.0.0.1:19101' },
]);
const cluster = new ObjectCluster(kv, registry, 3);
await registry.checkAll();
if (registry.live().length !== 2) {
  throw new Error(`expected 2 live block nodes, got ${registry.live().map((n) => n.nodeId).join(',')}`);
}

const payload = Buffer.from('hello-from-split-test');
await cluster.createBucket('demo');
await cluster.put('demo', 'path/to/obj.txt', payload);

const got = await cluster.get('demo', 'path/to/obj.txt');
if (!got || got.value.toString() !== payload.toString()) {
  throw new Error('get after put mismatch');
}

const locs = await cluster.locators('demo/path/to/obj.txt');
if (locs.length !== 2) {
  throw new Error(`expected 2 locators (min(3, live)=2), got ${locs.length}`);
}
if (!(await kv.get('demo/path/to/obj.txt:1'))) {
  throw new Error('missing key:1 locator');
}

const listed = await cluster.list('demo', 'path/');
if (listed.objects.length !== 1 || listed.objects[0].key !== 'path/to/obj.txt') {
  throw new Error(`list should hide replica suffixes, got ${JSON.stringify(listed.objects)}`);
}

const downId = locs[0].nodeId;
const down = downId === 'block1' ? block1 : block2;
console.log(`stopping ${downId} to verify replica read`);
await stop(down);
const idx = children.indexOf(down);
if (idx >= 0) children.splice(idx, 1);
await registry.checkAll();
if (!registry.isDown(downId)) {
  throw new Error(`${downId} should be marked down`);
}

const again = await cluster.get('demo', 'path/to/obj.txt');
if (!again || again.value.toString() !== payload.toString()) {
  throw new Error('get after killing one block replica failed');
}

const deleted = await cluster.delete('demo', 'path/to/obj.txt');
if (!deleted) {
  throw new Error('delete should return true');
}
if (await cluster.get('demo', 'path/to/obj.txt')) {
  throw new Error('get after delete should be empty');
}

await cleanup();
console.log('ok: index + two block nodes; put, list, kill one replica, still read, then delete');
