import type { DLevelDB } from 'dleveldb';
import type { KvEntry, KvValue, ScanResult } from './kv-client.js';

/** 本进程里的索引。S3 直接调 dleveldb 的包，不经过 HTTP。 */
export class DirectIndex {
  constructor(private readonly db: DLevelDB) {}

  get endpoints(): string[] {
    return [`http://${this.db.config.advertiseAddr}`, ...this.db.config.peers.map((peer) => `http://${peer}`)];
  }

  async put(key: string, value: Buffer): Promise<void> {
    await this.db.put(key, value);
  }

  putNow(key: string, value: Buffer): void {
    this.db.putNow(key, value);
  }

  async get(key: string): Promise<KvValue | null> {
    const found = await this.db.get(key);
    if (!found) {
      return null;
    }
    return { key, value: Buffer.from(found.value), size: found.size, crc: found.crc, mtimeMs: found.mtimeMs };
  }

  async head(key: string): Promise<Omit<KvEntry, 'key'> | null> {
    const meta = await this.db.head(key);
    if (!meta) {
      return null;
    }
    return { size: meta.size, crc: meta.crc, mtimeMs: meta.mtimeMs };
  }

  async delete(key: string): Promise<boolean> {
    return this.db.delete(key);
  }

  async scan(opts: { prefix?: string; startAfter?: string; maxKeys?: number } = {}): Promise<ScanResult> {
    return this.db.scan(opts);
  }

  async ping(): Promise<boolean> {
    return true;
  }
}
