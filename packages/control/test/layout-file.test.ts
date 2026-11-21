import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { LAYOUT_FILE_NAME, writeLayoutFile } from '../src/layout.ts';

describe('s3dfs layout file', () => {
  test('writes a JSON contract a repair tool can parse', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 's3dfs-layout-'));
    const file = writeLayoutFile(dir);
    expect(file).toBe(path.join(dir, LAYOUT_FILE_NAME));
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      layoutVersion: number;
      block: { record: { magic: string } };
      index: { objectLocator: { v: number } };
      repair: string[];
    };
    expect(doc.layoutVersion).toBe(1);
    expect(doc.block.record.magic).toBe('S3R1');
    expect(doc.index.objectLocator.v).toBe(3);
    expect(doc.repair.length).toBeGreaterThan(0);
  });
});
