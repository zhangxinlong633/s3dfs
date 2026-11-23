/**
 * 确认写本机。对方索引连不上时 put 仍然返回，本机读得到。
 * 同一条 key 上较新的 mtime 留下，较旧的复制不能覆盖。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DLevelDB, loadConfig, listenLink } from '../src/index.ts';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dleveldb-local-ack-'));

const alone = await DLevelDB.open(loadConfig({}, {
  dataDir: path.join(dir, 'alone'),
  nodeId: 'alone',
  advertiseAddr: '127.0.0.1:19731',
  peers: [],
  vnodeCount: 1,
  replicas: 1,
  writeQuorum: 1,
  sync: true,
}));
await alone.put('k', Buffer.from('old'));
await new Promise((resolve) => setTimeout(resolve, 5));
await alone.replicateLocalPut('remote-0', 'k', Buffer.from('fresh'));
const newest = await alone.get('k');
assert(newest && newest.value.equals(Buffer.from('fresh')), 'a newer replica must be visible on get');
const freshAt = newest.mtimeMs;
await alone.replicateLocalPut('remote-0', 'k', Buffer.from('stale'), freshAt - 10);
const kept = await alone.get('k');
assert(kept && kept.value.equals(Buffer.from('fresh')), 'an older replica must not replace the newer value');

const a = await DLevelDB.open(loadConfig({}, {
  dataDir: path.join(dir, 'a'),
  nodeId: 'nodeA',
  advertiseAddr: '127.0.0.1:19741',
  peers: [],
  vnodeCount: 1,
  replicas: 2,
  writeQuorum: 2,
  sync: true,
  rpcTimeoutMs: 800,
}));
const linkA = await listenLink(a);
const b = await DLevelDB.open(loadConfig({}, {
  dataDir: path.join(dir, 'b'),
  nodeId: 'nodeB',
  advertiseAddr: '127.0.0.1:19742',
  peers: ['127.0.0.1:19741'],
  vnodeCount: 1,
  replicas: 2,
  writeQuorum: 2,
  sync: true,
  rpcTimeoutMs: 800,
}));
const linkB = await listenLink(b);

const deadline = Date.now() + 5000;
while (Date.now() < deadline && (a.ring.physicalNodeCount() < 2 || b.ring.physicalNodeCount() < 2)) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
assert(a.ring.physicalNodeCount() === 2, 'ring should contain both nodes');

let ownedByB = '';
for (let i = 0; i < 64; i += 1) {
  const key = `owned-${i}`;
  if (a.lookup(key).primary?.nodeId === 'nodeB') {
    ownedByB = key;
    break;
  }
}
assert(ownedByB, 'expected a key whose primary is nodeB');

await a.put(ownedByB, Buffer.from('synced'));
let remote = null;
for (let attempt = 0; attempt < 50 && !(remote && remote.value.equals(Buffer.from('synced'))); attempt += 1) {
  remote = await b.get(ownedByB);
  if (!(remote && remote.value.equals(Buffer.from('synced')))) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
assert(remote && remote.value.equals(Buffer.from('synced')), 'the other index must receive the put after the local ack');

linkB.closeAllConnections?.();
linkB.unref?.();
linkB.close();
await new Promise((resolve) => setTimeout(resolve, 50));

const started = Date.now();
await a.put(ownedByB, Buffer.from('local-first'));
const elapsed = Date.now() - started;
assert(elapsed < 500, `local put waited ${elapsed}ms for the other index`);
const local = await a.get(ownedByB);
assert(local && local.value.equals(Buffer.from('local-first')), 'the writer must read its own put before the other index is back');

console.log('ok local-ack');
process.exit(0);
