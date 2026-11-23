import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function load(mod) {
  const file = path.join(root, 'dist', mod);
  if (!fs.existsSync(file)) {
    throw new Error(`cannot load dist/${mod}; run: npm run build`);
  }
  return import(pathToFileURL(file).href);
}

const hash = await load('hash.js');
const chord = await load('chord.js');
const config = await load('config.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function sha1(s) {
  return createHash('sha1').update(s).digest('hex');
}

function vnode(nodeId, seq, address = `${nodeId}.local:9000`) {
  return chord.describeVnode(nodeId, seq, address);
}

assert(hash.hashVnode('node1', 0) === sha1('node1:0'), 'vnode hash encoding');
assert(hash.hashVnode('node1', 10) === sha1('node1:10'), 'vnode hash no padding');
assert(hash.hashKey('logs/2026/a.log') === sha1('logs/2026/a.log'), 'key hash encoding');
assert(hash.vnodeName('nodeA', 2) === 'nodeA-2', 'vnode id format');

assert(hash.inRange(5n, 1n, 10n) === true, '(1,10] contains 5');
assert(hash.inRange(1n, 1n, 10n) === false, '(1,10] excludes start');
assert(hash.inRange(10n, 1n, 10n) === true, '(1,10] includes end');
assert(hash.inRange(11n, 1n, 10n) === false, '(1,10] excludes 11');

const maxish = (1n << 160n) - 10n;
assert(hash.inRange(maxish + 5n, maxish, 4n) === true, 'wrap contains after start');
assert(hash.inRange(2n, maxish, 4n) === true, 'wrap contains before end');
assert(hash.inRange(5n, maxish, 4n) === false, 'wrap excludes past end');
assert(hash.inRange(maxish, maxish, 4n) === false, 'wrap excludes start');

assert(hash.inRange(0n, 42n, 42n) === true, '(n,n] is the whole ring');
assert(hash.inRange(42n, 42n, 42n) === true, '(n,n] includes n');

const only = vnode('node1', 0, '127.0.0.1:9000');
const ring1 = new chord.ChordRing({
  nodeId: 'node1',
  address: '127.0.0.1:9000',
  localVnodes: [only],
});
for (const key of ['a/b', 'logs/2026/x', 'z', 'bucket/']) {
  const succ = ring1.successor(hash.hashKey(key));
  assert(succ && succ.id === 'node1-0', `V=1 successor for ${key}`);
  const prefs = ring1.preferenceList(hash.hashKey(key), 3);
  assert(prefs.length === 1 && prefs[0].nodeId === 'node1', `V=1 preference caps at one machine for ${key}`);
}

const locals = [0, 1, 2, 3].map((seq) => vnode('node1', seq, '127.0.0.1:9000'));
const ring4 = new chord.ChordRing({
  nodeId: 'node1',
  address: '127.0.0.1:9000',
  localVnodes: locals,
});
const seen = new Set();
const keys = [];
for (let i = 0; i < 80; i++) keys.push(`logs/2026/${i}.log`);
keys.push('logs/2026/', 'other/x', 'z-last');
for (const key of keys) {
  const h = hash.hashKey(key);
  const succ = ring4.successor(h);
  assert(succ && succ.id.startsWith('node1-'), `routed ${key}`);
  assert(ring4.successor(h).id === succ.id, `stable successor for ${key}`);
  seen.add(succ.id);
  const prefs = ring4.preferenceList(h, 3);
  assert(prefs.length === 1, 'one physical machine => preference list length 1');
  assert(prefs[0].id === succ.id, 'primary is successor');
}
assert(seen.size >= 2, `expected keys to spread across vnodes, got ${[...seen]}`);

const all = [];
for (const node of ['A', 'B', 'C']) {
  for (const seq of [0, 1]) {
    all.push(vnode(node, seq, `${node}:9000`));
  }
}
const ringABC = new chord.ChordRing({
  nodeId: 'A',
  address: 'A:9000',
  localVnodes: all.filter((v) => v.nodeId === 'A'),
});
ringABC.replaceKnown(all);
assert(ringABC.physicalNodeCount() === 3, '3 physical nodes');
for (const key of keys) {
  const prefs = ringABC.preferenceList(hash.hashKey(key), 3);
  assert(prefs.length === 3, `N=3 should yield 3 replicas for ${key}, got ${prefs.length}`);
  const ids = prefs.map((p) => p.nodeId);
  assert(new Set(ids).size === 3, `replicas must be on distinct machines: ${ids}`);
  assert(prefs[0].id === ringABC.successor(hash.hashKey(key)).id, 'first of preference list is successor');
}

const two = all.filter((v) => v.nodeId !== 'C');
const ringAB = new chord.ChordRing({
  nodeId: 'A',
  address: 'A:9000',
  localVnodes: two.filter((v) => v.nodeId === 'A'),
});
ringAB.replaceKnown(two);
const prefs2 = ringAB.preferenceList(hash.hashKey('logs/2026/0.log'), 3);
assert(prefs2.length === 2, `only 2 machines in list, got ${prefs2.length}`);
assert(new Set(prefs2.map((p) => p.nodeId)).size === 2, 'two distinct machines');

assert(config.effectiveReplicas(3, 1) === 1, 'single machine caps N');
assert(config.effectiveReplicas(3, 2) === 2, 'two machines cap N at 2');
assert(config.effectiveReplicas(3, 5) === 3, 'configured N when enough machines');
assert(config.effectiveWriteQuorum(undefined, 3) === 2, 'majority of 3 is 2');
assert(config.effectiveWriteQuorum(undefined, 1) === 1, 'majority of 1 is 1');
assert(config.effectiveWriteQuorum(undefined, 2) === 2, 'majority of 2 is 2');
assert(config.effectiveWriteQuorum(3, 2) === 2, 'configured W cannot exceed effective N');
assert(config.majority(3) === 2 && config.majority(1) === 1, 'majority helper');

const peers = config.parsePeerList('127.0.0.1:9001, 127.0.0.1:9002,127.0.0.1:9001,');
assert(peers.length === 2 && peers[0] === '127.0.0.1:9001', 'peer list parse/dedup');

console.log('ok chord', { vnodeHash: hash.hashVnode('node1', 0), spread: [...seen] });
