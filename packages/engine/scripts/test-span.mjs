import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const addon = require(path.join(root, 'build', 'Release', 's3dfs_engine.node'));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3dfs-span-'));
const blockSize = 1 * 1024 * 1024; // 1MB, so a few MB already spans
const store = new addon.Store(dir, { blockSize, bufferSize: 64 * 1024, fsyncOnFlush: true });

try {
  const small = Buffer.from('hello-small');
  const smallLoc = store.put('a/small', small);

  // Fill most of the first block, then write an object that must span.
  const filler = Buffer.alloc(blockSize - 8 * 1024, 0x11);
  store.put('a/filler', filler);

  const payload = Buffer.alloc(Math.floor(blockSize * 2.5), 0);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + 13) & 0xff;
  const bigLoc = store.put('a/big', payload);
  store.flush();

  assert(typeof smallLoc.recId === 'number' && smallLoc.recId > 0, `small recId missing: ${JSON.stringify(smallLoc)}`);
  assert(bigLoc && bigLoc.chained && bigLoc.extentCount >= 3, `expected a chained locator, got ${JSON.stringify(bigLoc)}`);
  assert(typeof bigLoc.recId === 'number' && bigLoc.recId > 0, `big recId missing: ${JSON.stringify(bigLoc)}`);
  const got = store.get('a/big', bigLoc);
  assert(got && got.value.equals(payload), 'get mismatch before reopen');
  const span = store.getSpan('a/big', bigLoc, 10, 4);
  assert(span.equals(payload.subarray(10, 14)), 'span should read by offset without returning the whole object');
  const chunks = [Buffer.from('alpha-'), Buffer.from('beta-'), Buffer.from('gamma')];
  const chunkLoc = store.putChunks('a/chunks', chunks);
  assert(chunkLoc.size === Buffer.concat(chunks).length, 'chunked object size is the sum of the chunks');
  const mid = store.getSpan('a/chunks', chunkLoc, 6, 4);
  assert(mid.equals(Buffer.from('beta')), 'chunked span should cross extent boundaries');
  const head = store.head('a/big', bigLoc);
  assert(head && head.size === payload.length, 'head size mismatch');

  const stats = store.stats();
  assert(stats.blockFiles >= 3, `expected >= 3 block files, got ${stats.blockFiles}`);
  store.close();

  const files = fs.readdirSync(path.join(dir, 'blocks')).filter((n) => n.endsWith('.blk')).sort();
  assert(files.length === stats.blockFiles, 'block file count mismatch');
  assert(!fs.existsSync(path.join(dir, 'index')), 'local index directory should not exist');
  assert(fs.existsSync(path.join(dir, 'recmap.s3m')), 'recmap snapshot should be written on close');

  const store2 = new addon.Store(dir, { blockSize, bufferSize: 64 * 1024, fsyncOnFlush: true });
  const got2 = store2.get('a/big', bigLoc);
  assert(got2 && got2.value.equals(payload), 'get mismatch after reopen');
  const small2 = store2.get('a/small', smallLoc);
  assert(small2 && small2.value.equals(small), 'small object lost after reopen');

  const scanned = store2.scan();
  const byKey = Object.fromEntries(scanned.map((e) => [e.key, e.locator]));
  assert(byKey['a/big'] && byKey['a/small'] && byKey['a/filler'], `scan missed keys: ${scanned.map((e) => e.key)}`);
  const scannedBig = store2.get('a/big', byKey['a/big']);
  assert(scannedBig && scannedBig.value.equals(payload), 'get via rebuilt locator mismatch');

  store2.tombstone('a/small');
  store2.flush();
  const afterDelete = store2.scan();
  assert(!afterDelete.some((e) => e.key === 'a/small'), 'tombstone should drop key from scan');
  assert(afterDelete.some((e) => e.key === 'a/big'), 'big object should survive tombstone of small');
  const beforeCompact = store2.stats();
  assert(beforeCompact.deadBytes > 0, `delete should leave dead bytes, got ${JSON.stringify(beforeCompact)}`);
  const compacted = store2.compact();
  assert(compacted.deadBytes === 0, `deadBytes after compact: ${JSON.stringify(compacted)}`);
  assert(compacted.bytesOnDisk < beforeCompact.bytesOnDisk, `compact should shrink disk ${beforeCompact.bytesOnDisk} -> ${compacted.bytesOnDisk}`);
  const stillBig = store2.get('a/big', bigLoc);
  assert(stillBig && stillBig.value.equals(payload), 'get by same recId after compact failed');
  const stillScan = store2.scan();
  assert(!stillScan.some((e) => e.key === 'a/small'), 'small should stay gone after compact');
  assert(stillScan.some((e) => e.key === 'a/big') && stillScan.some((e) => e.key === 'a/filler'), 'live keys missing after compact');
  store2.close();

  const store3 = new addon.Store(dir, { blockSize, bufferSize: 64 * 1024, fsyncOnFlush: true });
  const afterReopen = store3.get('a/big', bigLoc);
  assert(afterReopen && afterReopen.value.equals(payload), 'get by same recId after compact+reopen failed');
  const gone = store3.get('a/small', smallLoc);
  assert(!gone, 'deleted object should stay gone after compact+reopen');
  store3.close();
  assert(fs.existsSync(path.join(dir, 'recmap.s3m')), 'recmap snapshot should exist after compact and close');
  fs.writeFileSync(path.join(dir, 'recmap.s3m'), Buffer.from('not-a-valid-recmap'));
  const store4 = new addon.Store(dir, { blockSize, bufferSize: 64 * 1024, fsyncOnFlush: true });
  const afterCorrupt = store4.get('a/big', bigLoc);
  assert(afterCorrupt && afterCorrupt.value.equals(payload), 'get after a corrupt recmap should fall back to a full scan');
  store4.close();
  console.log('ok', { dir, size: payload.length, blocks: stats.blockFiles, last: bigLoc, scanned: scanned.length, compacted });
} catch (err) {
  try { store.close(); } catch {}
  console.error(err);
  process.exitCode = 1;
}
