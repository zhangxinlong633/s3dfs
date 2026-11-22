import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DLevelDB, loadConfig } from 'dleveldb';
import { DirectIndex } from '../src/direct-index.ts';

const dir = mkdtempSync(join(tmpdir(), 's3dfs-direct-index-'));
const db = await DLevelDB.open(
  loadConfig(
    {
      DLEVELDB_PORT: '19131',
      DLEVELDB_ADVERTISE_ADDR: '127.0.0.1:19131',
      DLEVELDB_DATA_DIR: dir,
      DLEVELDB_NODE_ID: 'index1',
      DLEVELDB_VNODES: '1',
      DLEVELDB_REPLICAS: '1',
      DLEVELDB_WRITE_QUORUM: '1',
      DLEVELDB_PEERS: '',
    },
    {},
  ),
);
try {
  const kv = new DirectIndex(db);
  await kv.put('bench/a', Buffer.from('in-process'));
  const got = await kv.get('bench/a');
  if (!got || got.value.toString() !== 'in-process') {
    throw new Error('direct index did not return the value');
  }
  console.log('direct index ok');
} finally {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
}
