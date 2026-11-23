import { expect, test } from 'bun:test';
import { closeSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/index.ts';

const PAGE_HEADER = 22;
const SLOT = 4;

function blockFile(dir) {
  const blocks = path.join(dir, 'blocks');
  const name = readdirSync(blocks).find((entry) => entry.endsWith('.blk'));
  return path.join(blocks, name);
}

function readAt(file, at, len) {
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  readSync(fd, buf, 0, len, at);
  closeSync(fd);
  return buf;
}

test('a later object only rewrites its own recId slot', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 's3dfs-slot-'));
  const store = Store.open({ dataDir: dir, fsyncOnFlush: false, writeBlocks: 1 });
  store.put('a', Buffer.from('alpha'));
  const file = blockFile(dir);
  const slot0 = readAt(file, PAGE_HEADER, SLOT);
  const crcBefore = readAt(file, 18, SLOT);
  expect(slot0.readUInt32LE(0)).toBeGreaterThan(0);
  expect(crcBefore.readUInt32LE(0)).toBe(0);

  const poisonAt = PAGE_HEADER + 5 * SLOT;
  const poison = Buffer.from([0xab, 0xcd, 0xef, 0x11]);
  const fd = openSync(file, 'r+');
  writeSync(fd, poison, 0, poison.length, poisonAt);
  closeSync(fd);

  store.put('b', Buffer.from('bravo'));
  const slot1 = readAt(file, PAGE_HEADER + SLOT, SLOT);
  const left = readAt(file, poisonAt, SLOT);
  const crcAfter = readAt(file, 18, SLOT);
  const timing = store.stats();
  store.close();
  rmSync(dir, { recursive: true, force: true });

  expect(slot1.readUInt32LE(0)).toBeGreaterThan(0);
  expect(left.equals(poison)).toBe(true);
  expect(crcAfter.equals(crcBefore)).toBe(true);
  expect(timing.slotWrites).toBeGreaterThanOrEqual(2);
  expect(timing.bodyWrites).toBeGreaterThanOrEqual(1);
});

test('several writer threads keep separate block files', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 's3dfs-lanes-'));
  const store = Store.open({ dataDir: dir, fsyncOnFlush: false, writeBlocks: 4 });
  const locs = await Promise.all(
    Array.from({ length: 16 }, (_, i) => store.putAsync(`k${i}`, Buffer.from(`v${i}`))),
  );
  const files = readdirSync(path.join(dir, 'blocks')).filter((name) => name.endsWith('.blk'));
  store.close();
  const again = Store.open({ dataDir: dir, writeBlocks: 4 });
  for (let i = 0; i < locs.length; i++) {
    expect(again.get(`k${i}`, locs[i]).value.toString()).toBe(`v${i}`);
  }
  again.close();
  rmSync(dir, { recursive: true, force: true });
  expect(files.length).toBeGreaterThan(1);
});

test('positioned slots still open and read back', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 's3dfs-slot-reopen-'));
  const store = Store.open({ dataDir: dir, fsyncOnFlush: false, writeBlocks: 1 });
  const a = store.put('a', Buffer.from('alpha'));
  const b = store.put('b', Buffer.from('bravo'));
  store.close();

  const again = Store.open({ dataDir: dir });
  expect(again.get('a', a).value.toString()).toBe('alpha');
  expect(again.get('b', b).value.toString()).toBe('bravo');
  again.close();
  rmSync(dir, { recursive: true, force: true });
});
