/**
 * 包调用：两个节点在进程里打开，Chord 和复制走长连接，不经过 HTTP。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { DLevelDB, loadConfig, listenLink } = await import(pathToFileURL(path.join(root, 'src/index.ts')).href);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dleveldb-link-'));
const aCfg = loadConfig(
  {
    DLEVELDB_PORT: '19121',
    DLEVELDB_ADVERTISE_ADDR: '127.0.0.1:19121',
    DLEVELDB_DATA_DIR: path.join(base, 'a'),
    DLEVELDB_NODE_ID: 'index1',
    DLEVELDB_VNODES: '1',
    DLEVELDB_REPLICAS: '2',
    DLEVELDB_WRITE_QUORUM: '1',
    DLEVELDB_PEERS: '',
    DLEVELDB_SYNC_INTERVAL_MS: '1000',
  },
  { stabilizeIntervalMs: 100 },
);
const bCfg = loadConfig(
  {
    DLEVELDB_PORT: '19122',
    DLEVELDB_ADVERTISE_ADDR: '127.0.0.1:19122',
    DLEVELDB_DATA_DIR: path.join(base, 'b'),
    DLEVELDB_NODE_ID: 'index2',
    DLEVELDB_VNODES: '1',
    DLEVELDB_REPLICAS: '2',
    DLEVELDB_WRITE_QUORUM: '1',
    DLEVELDB_PEERS: '127.0.0.1:19121',
    DLEVELDB_SYNC_INTERVAL_MS: '1000',
  },
  { stabilizeIntervalMs: 100 },
);

const a = await DLevelDB.open(aCfg);
const b = await DLevelDB.open(bCfg);
const linkA = await listenLink(a);
const linkB = await listenLink(b);

try {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && a.ring.physicalNodeCount() < 2) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert(a.ring.physicalNodeCount() === 2, `ring nodes ${a.ring.physicalNodeCount()}`);
  await a.put('pkg/hello', Buffer.from('direct'));
  let got = null;
  for (let i = 0; i < 40 && !got; i++) {
    got = await b.get('pkg/hello');
    if (!got) await new Promise((r) => setTimeout(r, 50));
  }
  assert(got && got.value.toString() === 'direct', 'replica did not arrive over the long connection');
  console.log('link ok');
} finally {
  linkA.close();
  linkB.close();
  await a.close();
  await b.close();
  fs.rmSync(base, { recursive: true, force: true });
}
