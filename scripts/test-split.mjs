import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dleveldbCli = path.resolve(root, '../dleveldb/packages/dleveldb/src/dleveldb.ts');
const blockMain = path.join(root, 'apps/block/src/block.ts');
const bun = process.env.BUN_BIN ?? 'bun';
process.env.S3DFS_STRICT_LAYOUT ??= '0';

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
  parseByteRange,
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
  S3DFS_COMPACT_INTERVAL_MS: '0',
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
if (locs[0].v !== 3 || locs[0].compressType !== 'none' || typeof locs[0].recId !== 'number' || !(locs[0].recId > 0)) {
  throw new Error(`unexpected short-object locator ${JSON.stringify(locs[0])}`);
}
if (!(await kv.get('demo/path/to/obj.txt:1'))) {
  throw new Error('missing key:1 locator');
}

const compressible = Buffer.alloc(4096, 0x61);
await cluster.put('demo', 'path/to/comp.bin', compressible);
const clocs = await cluster.locators('demo/path/to/comp.bin');
if (clocs.length !== 2 || clocs[0].compressType !== 'zstd' || !(clocs[0].storedSize < clocs[0].size)) {
  throw new Error(`expected zstd locator with savings, got ${JSON.stringify(clocs[0])}`);
}
const cgot = await cluster.get('demo', 'path/to/comp.bin');
if (!cgot || !cgot.value.equals(compressible)) {
  throw new Error('decompressed get mismatch');
}

const listed = await cluster.list('demo', 'path/');
const listedKeys = listed.objects.map((o) => o.key).sort();
if (listedKeys.join(',') !== 'path/to/comp.bin,path/to/obj.txt') {
  throw new Error(`list should hide replica suffixes and show both objects, got ${JSON.stringify(listed.objects)}`);
}

const rootListing = await cluster.list('demo', '', undefined, 1000, '/');
if (rootListing.prefixes.slice().sort().join(',') !== 'path/' || rootListing.objects.length !== 0) {
  throw new Error(`delimiter list at bucket root expected only path/, got ${JSON.stringify(rootListing)}`);
}
const toListing = await cluster.list('demo', 'path/to/', undefined, 1000, '/');
if (toListing.objects.map((o) => o.key).sort().join(',') !== 'path/to/comp.bin,path/to/obj.txt' || toListing.prefixes.length !== 0) {
  throw new Error(`delimiter list under path/to/ got ${JSON.stringify(toListing)}`);
}
await cluster.put('demo', 'empty-dir/', Buffer.alloc(0));
const withEmpty = await cluster.list('demo', '', undefined, 1000, '/');
if (!withEmpty.prefixes.includes('empty-dir/') || !withEmpty.prefixes.includes('path/')) {
  throw new Error(`empty directory marker should appear as a prefix, got ${JSON.stringify(withEmpty.prefixes)}`);
}

const ranged = await cluster.getRange('demo', 'path/to/obj.txt', 6, 9);
if (!ranged || ranged.value.toString() !== 'from' || ranged.totalSize !== payload.length) {
  throw new Error(`getRange expected "from" of ${payload.length}, got ${ranged && ranged.value.toString()} total=${ranged && ranged.totalSize}`);
}
const suffix = parseByteRange('bytes=-4', payload.length);
if (suffix.kind !== 'partial' || suffix.start !== payload.length - 4 || suffix.end !== payload.length - 1) {
  throw new Error(`parseByteRange suffix failed: ${JSON.stringify(suffix)}`);
}
if (parseByteRange('bytes=100-200', payload.length).kind !== 'unsatisfiable') {
  throw new Error('parseByteRange should reject a range past the end');
}


const extra = Buffer.from('to-be-deleted-for-compact');
await cluster.put('demo', 'path/to/gone.txt', extra);
if (!(await cluster.get('demo', 'path/to/gone.txt'))) {
  throw new Error('missing object that should be deleted before compact');
}
await cluster.flush();
const statsUrl = (port) => `http://127.0.0.1:${port}/_s3dfs/block/stats`;
const statsBefore = await Promise.all([19100, 19101].map(async (port) => (await fetch(statsUrl(port))).json()));
const beforeDisk = statsBefore.reduce((sum, st) => sum + st.bytesOnDisk, 0);
await cluster.delete('demo', 'path/to/gone.txt');
if (await cluster.get('demo', 'path/to/gone.txt')) {
  throw new Error('get after delete of gone.txt should be empty');
}
await cluster.compact();
const statsAfter = await Promise.all([19100, 19101].map(async (port) => (await fetch(statsUrl(port))).json()));
const afterDisk = statsAfter.reduce((sum, st) => sum + st.bytesOnDisk, 0);
if (statsAfter.some((st) => st.deadBytes !== 0)) {
  throw new Error(`expected deadBytes 0 after compact, got ${JSON.stringify(statsAfter)}`);
}
if (!(afterDisk < beforeDisk)) {
  throw new Error(`compact should shrink disk ${beforeDisk} -> ${afterDisk}`);
}
const stillObj = await cluster.get('demo', 'path/to/obj.txt');
if (!stillObj || stillObj.value.toString() !== payload.toString()) {
  throw new Error('obj.txt should still be readable after compact');
}
const stillComp = await cluster.get('demo', 'path/to/comp.bin');
if (!stillComp || !stillComp.value.equals(compressible)) {
  throw new Error('comp.bin should still be readable after compact');
}
const recIdBefore = locs[0].recId;
const locsAfter = await cluster.locators('demo/path/to/obj.txt');
if (locsAfter[0].recId !== recIdBefore) {
  throw new Error(`index recId must stay stable across compact: ${recIdBefore} -> ${locsAfter[0].recId}`);
}

const block3 = run(bun, [blockMain], blockEnv('block3', 19102));
await waitPort(19102);
await registry.checkAll();
if (registry.live().length !== 3) {
  throw new Error(`expected 3 live after block3, got ${registry.live().map((n) => n.nodeId).join(',')}`);
}
const beforeRepair = await cluster.locators('demo/path/to/obj.txt');
if (beforeRepair.length !== 2) {
  throw new Error(`expected 2 locators before repair, got ${beforeRepair.length}`);
}
const repair = await cluster.repair();
if (repair.repaired < 1) {
  throw new Error(`expected repair to add replicas, got ${JSON.stringify(repair)}`);
}
const afterRepair = await cluster.locators('demo/path/to/obj.txt');
if (afterRepair.length !== 3 || !afterRepair.some((l) => l.nodeId === 'block3')) {
  throw new Error(`expected a third copy on block3, got ${JSON.stringify(afterRepair)}`);
}
const repairedGet = await cluster.get('demo', 'path/to/obj.txt');
if (!repairedGet || repairedGet.value.toString() !== payload.toString()) {
  throw new Error('get after repair mismatch');
}
const clocsRepaired = await cluster.locators('demo/path/to/comp.bin');
if (clocsRepaired.length !== 3) {
  throw new Error(`comp.bin should be topped up to 3 copies, got ${clocsRepaired.length}`);
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
console.log('ok: index + two block nodes; put, list, repair onto a third node, kill one replica, still read, then delete');
