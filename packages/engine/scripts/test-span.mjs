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
  store.put('a/small', small);

  // Fill most of the first block, then write an object that must span.
  const filler = Buffer.alloc(blockSize - 8 * 1024, 0x11);
  store.put('a/filler', filler);

  const payload = Buffer.alloc(Math.floor(blockSize * 2.5), 0);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + 13) & 0xff;
  store.put('a/big', payload);
  store.flush();

  const got = store.get('a/big');
  assert(got && got.value.equals(payload), 'get mismatch before reopen');
  const head = store.head('a/big');
  assert(head && head.size === payload.length, 'head size mismatch');
  const listed = store.list({ prefix: 'a/big' });
  assert(listed.objects.length === 1 && listed.objects[0].size === payload.length, 'list size mismatch');

  const stats = store.stats();
  assert(stats.blockFiles >= 3, `expected >= 3 block files, got ${stats.blockFiles}`);
  store.close();

  const store2 = new addon.Store(dir, { blockSize, bufferSize: 64 * 1024, fsyncOnFlush: true });
  const got2 = store2.get('a/big');
  assert(got2 && got2.value.equals(payload), 'get mismatch after reopen');
  const small2 = store2.get('a/small');
  assert(small2 && small2.value.equals(small), 'small object lost after reopen');
  store2.compact();
  const got3 = store2.get('a/big');
  assert(got3 && got3.value.equals(payload), 'get mismatch after compact');
  store2.close();
  console.log('ok', { dir, size: payload.length, blocks: stats.blockFiles });
} catch (err) {
  store.close();
  console.error(err);
  process.exitCode = 1;
}
