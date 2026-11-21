import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/index.ts';

test('audit reports a record whose frame checksum was flipped', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 's3dfs-audit-'));
  const store = Store.open({ dataDir: dir, fsyncOnFlush: true });
  store.put('a', Buffer.from('alpha'));
  store.put('b', Buffer.from('bravo'));
  store.flush();
  store.close();

  const blocks = path.join(dir, 'blocks');
  const name = readdirSync(blocks).find((entry) => entry.endsWith('.blk'));
  const file = path.join(blocks, name);
  const buf = readFileSync(file);
  const magicAt = buf.indexOf(Buffer.from([0x53, 0x33, 0x52, 0x31]));
  buf[magicAt + 16] ^= 0xff;
  writeFileSync(file, buf);

  const again = Store.open({ dataDir: dir });
  const report = again.audit();
  again.close();
  rmSync(dir, { recursive: true, force: true });

  expect(report.records).toBeGreaterThan(0);
  expect(report.bad).toBeGreaterThan(0);
  expect(report.bytes).toBeGreaterThan(0);
});
