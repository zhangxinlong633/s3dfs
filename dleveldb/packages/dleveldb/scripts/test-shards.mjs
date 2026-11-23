/**
 * V=4, 有效 N=1 的单进程分片测试。本地存储是标准 LevelDB。
 *
 *   npm run build
 *   npm run test:shards
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist', 'index.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

if (!fs.existsSync(dist)) {
  throw new Error('cannot load dleveldb dist; run: npm run build');
}

const { DLevelDB, loadConfig, shouldUseLegacyLayout, hashKey } = await import(pathToFileURL(dist).href);
const defaults = loadConfig({}, { dataDir: os.tmpdir(), nodeId: 'defaults', advertiseAddr: '127.0.0.1:1' });
assert(defaults.sync === false, 'default keeps writes in memory');
assert(defaults.syncIntervalMs === 1000, 'default flushes once a second');
void hashKey;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dleveldb-shards-'));
const config = loadConfig({}, {
  dataDir: dir,
  nodeId: 'node1',
  advertiseAddr: '127.0.0.1:19000',
  peers: [],
  vnodeCount: 4,
  replicas: 1,
  writeQuorum: 1,
  sync: true,
});

function prefixKeys(listed, prefix) {
  return listed.objects.map((o) => o.key).filter((k) => k.startsWith(prefix));
}

let db = await DLevelDB.open(config);
try {
  assert(shouldUseLegacyLayout(dir, 4) === false, 'standard layout is always shards/');
  assert(fs.existsSync(path.join(dir, 'shards', 'node1-0')), 'expected shards/node1-0');
  assert(fs.existsSync(path.join(dir, 'shards', 'node1-0', 'CURRENT')), 'expected a LevelDB CURRENT file');
  assert(!fs.existsSync(path.join(dir, 'index')), 'must not create packed-block data/index');
  assert(!fs.existsSync(path.join(dir, 'blocks')), 'must not create packed-block data/blocks');

  const expected = [];
  for (let i = 0; i < 40; i++) {
    const key = `logs/2026/${String(i).padStart(3, '0')}.log`;
    const value = Buffer.from(`payload-${i}-logs`);
    await db.put(key, value);
    expected.push({ key, value });
  }
  await db.put('logs/2019/old.log', Buffer.from('old'));
  await db.put('other/x', Buffer.from('x'));
  await db.put('zz/last', Buffer.from('last'));
  await db.flush();

  const used = new Set();
  for (const item of expected) {
    const got = await db.get(item.key);
    assert(got && got.value.equals(item.value), `get mismatch ${item.key}`);
    const h = await db.head(item.key);
    assert(h && h.size === item.value.length, `head size ${item.key}`);
    used.add(db.lookup(item.key).primary?.id);
  }
  assert(used.size >= 2, `keys should spread across local shards, got ${[...used]}`);

  const listed = await db.scan({ prefix: 'logs/2026/', maxKeys: 1000 });
  const keys = listed.objects.map((o) => o.key);
  assert(keys.length === expected.length, `prefix list size ${keys.length} != ${expected.length}`);
  const ordered = [...keys].sort();
  assert(keys.every((k, i) => k === ordered[i]), `prefix list not ordered: ${keys}`);
  assert(keys.every((k) => k.startsWith('logs/2026/')), 'prefix leak');
  assert(!keys.includes('logs/2019/old.log') && !keys.includes('other/x'), 'prefix isolation');

  const page = await db.scan({ prefix: 'logs/2026/', maxKeys: 5 });
  assert(page.objects.length === 5 && page.truncated === true, 'maxKeys / truncated');
  const page2 = await db.scan({
    prefix: 'logs/2026/',
    startAfter: page.objects[page.objects.length - 1].key,
    maxKeys: 1000,
  });
  assert(page2.objects[0].key > page.objects[page.objects.length - 1].key, 'startAfter');
  assert(page.objects.length + page2.objects.length === expected.length, 'pages cover the prefix');

  const victim = expected[7].key;
  assert(await db.delete(victim) === true, 'delete existing');
  assert((await db.get(victim)) === null, 'deleted key still readable');
  const afterDel = prefixKeys(await db.scan({ prefix: 'logs/2026/', maxKeys: 1000 }), 'logs/2026/');
  assert(!afterDel.includes(victim), 'deleted key still in list');
  assert(afterDel.length === expected.length - 1, 'list count after delete');

  await db.close();

  db = await DLevelDB.open(config);
  const re = await db.get(expected[0].key);
  assert(re && re.value.equals(expected[0].value), 'get after reopen');
  const listed2 = await db.scan({ prefix: 'logs/2026/', maxKeys: 1000 });
  assert(listed2.objects.length === expected.length - 1, 'list after reopen');
  assert((await db.get(victim)) === null, 'delete persisted after reopen');
  assert(db.status().vnodes.length === 4, 'status vnodeCount');
  assert(db.status().effectiveReplicas === 1, 'single process effective N is 1');

  console.log('ok shards', { dir, shards: [...used], objects: listed2.objects.length });
  await db.close();
} catch (err) {
  try {
    await db.close();
  } catch {
    // ignore
  }
  console.error(err);
  process.exitCode = 1;
}
