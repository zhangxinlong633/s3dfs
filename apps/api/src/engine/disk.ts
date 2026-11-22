import { accessSync, constants, statfsSync } from 'node:fs';
import path from 'node:path';
import { BACK_PREFIX, IndexClient, nodeKey, parseIndexUrls, writeLayoutFile, type BlockNodeInfo, type BlockState, type DiskState, type ExtentLocator, type KvIndex, type LocalDisk, type ObjectValue } from '@s3dfs/control';
import { Store, type PutMeta } from '@s3dfs/engine';

export interface RunningDisk {
  address: string;
  local: LocalDisk;
  stop(): void;
}

function diskView(dir: string): { disk: DiskState; freeBytes: number } {
  let freeBytes = 0;
  try {
    const stat = statfsSync(dir);
    freeBytes = Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return { disk: 'error', freeBytes: 0 };
  }
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    return { disk: 'readonly', freeBytes };
  }
  const reserve = Number(process.env.S3DFS_DISK_RESERVE_BYTES ?? 1_073_741_824);
  if (freeBytes <= 0) {
    return { disk: 'full', freeBytes };
  }
  if (Number.isFinite(reserve) && reserve > 0 && freeBytes < reserve) {
    return { disk: 'low', freeBytes };
  }
  return { disk: 'ok', freeBytes };
}

/** Open this process's packed-block engine and the peer data port. S3 stays on the API. */
export function startDisk(kv?: KvIndex): RunningDisk {
  const dataDir = path.resolve(process.env.S3DFS_DATA_DIR ?? './data/block');
  writeLayoutFile(dataDir);
  const nodeId = process.env.S3DFS_BLOCK_NODE_ID ?? 'block1';
  const port = Number(process.env.S3DFS_BLOCK_PORT ?? 9100);
  const host = process.env.S3DFS_BLOCK_HOST ?? '0.0.0.0';
  const advertise = process.env.S3DFS_BLOCK_ADVERTISE ?? `127.0.0.1:${port}`;
  const flushInterval = Number(process.env.S3DFS_FLUSH_INTERVAL_MS ?? 1000);
  const fsyncInterval = Number(process.env.S3DFS_FSYNC_INTERVAL_MS ?? 30_000);
  const healthInterval = Number(process.env.S3DFS_HEALTH_INTERVAL_MS ?? 5000);
  const compactInterval = Number(process.env.S3DFS_COMPACT_INTERVAL_MS ?? 30_000);
  const compactDeadRatio = Number(process.env.S3DFS_COMPACT_DEAD_RATIO ?? 0.2);
  const store = Store.open({
    dataDir,
    blockSize: Number(process.env.S3DFS_BLOCK_SIZE ?? 1_073_741_824) || undefined,
    bufferSize: Number(process.env.S3DFS_BUFFER_SIZE ?? 1_048_576) || undefined,
    fsyncOnFlush: process.env.S3DFS_FSYNC_ON_FLUSH !== '0',
    writeThreads: Number(process.env.S3DFS_BLOCK_WRITE_THREADS ?? 4) || 4,
  });
  let blockState: BlockState = 'starting';
  const indexUrls = parseIndexUrls(process.env.S3DFS_INDEX_URLS);
  const index = kv ?? (indexUrls.length > 0 ? new IndexClient(indexUrls) : null);

  function snapshot(): BlockNodeInfo & { stats: ReturnType<Store['stats']>; freeBytes: number } {
    const disk = diskView(dataDir);
    return {
      nodeId,
      address: advertise,
      status: 'up',
      lastSeenMs: Date.now(),
      freeBytes: disk.freeBytes,
      disk: disk.disk,
      block: blockState,
      stats: store.stats(),
    };
  }

  async function announce(back: boolean): Promise<void> {
    if (!index) {
      return;
    }
    const info: BlockNodeInfo = { nodeId, address: advertise, status: 'up', lastSeenMs: Date.now() };
    try {
      await index.put(nodeKey(nodeId), Buffer.from(JSON.stringify(info)));
      if (back) {
        await index.put(`${BACK_PREFIX}${nodeId}`, Buffer.from(JSON.stringify({ nodeId, address: advertise, atMs: Date.now() })));
      }
    } catch (err) {
      console.warn(`block ${nodeId}: index announce failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handle(req: { method: string; url: string; headers: Record<string, string>; body: Buffer }) {
    const url = new URL(req.url || '/', `http://${advertise}`);
    const method = (req.method || 'GET').toUpperCase();
    const pathname = url.pathname;
    const json = (status: number, body: unknown) => ({
      status,
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    if ((pathname === '/health' || pathname === '/_s3dfs/block/health') && method === 'GET') {
      return json(200, snapshot());
    }
    if ((pathname === '/_s3dfs/block/stats' || pathname === '/stats') && method === 'GET') {
      return json(200, store.stats());
    }
    if (pathname === '/_s3dfs/block/audit' && method === 'POST') {
      return json(200, store.audit());
    }
    if (pathname === '/_s3dfs/block/scan' && method === 'GET') {
      return json(200, store.scan());
    }
    if (pathname === '/_s3dfs/block/flush' && method === 'POST') {
      store.sync();
      return json(200, { ok: true, stats: store.stats() });
    }
    if (pathname === '/_s3dfs/block/compact' && method === 'POST') {
      blockState = 'compacting';
      try {
        return json(200, store.compact());
      } finally {
        blockState = 'serving';
      }
    }
    return { status: 404, body: '' };
  }

  const flushTimer = setInterval(() => {
    store.flush();
  }, flushInterval);
  flushTimer.unref();
  const fsyncTimer =
    fsyncInterval > 0
      ? (() => {
          const timer = setInterval(() => {
            store.sync();
          }, fsyncInterval);
          timer.unref();
          return timer;
        })()
      : null;
  const healthTimer = setInterval(() => {
    void announce(false);
  }, healthInterval);
  healthTimer.unref();
  const compactTimer =
    compactInterval > 0
      ? (() => {
          const timer = setInterval(() => {
            const st = store.stats();
            const disk = st.bytesOnDisk ?? 0;
            if (!st.deadBytes || disk <= 0 || st.deadBytes / disk < compactDeadRatio) {
              return;
            }
            blockState = 'compacting';
            try {
              store.compact();
            } finally {
              blockState = 'serving';
            }
          }, compactInterval);
          timer.unref();
          return timer;
        })()
      : null;

  const boundPort = store.serve(host, port, (req) => {
    try {
      return handle(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: 500, body: JSON.stringify({ error: message }), headers: { 'content-type': 'application/json; charset=utf-8' } };
    }
  });
  blockState = 'serving';
  console.log(`s3dfs disk ${nodeId} in this process on ${host}:${boundPort} (advertise ${advertise}, data ${dataDir})`);
  void announce(true);

  const local: LocalDisk = {
    address: advertise,
    put(key: string, value: Buffer, meta?: PutMeta): ExtentLocator {
      return store.put(key, value, meta);
    },
    get(key: string, locator: ExtentLocator, range?: { start: number; end: number }): ObjectValue | null {
      if (!range) {
        return store.get(key, locator);
      }
      const value = store.getSpan(key, locator, range.start, range.end - range.start + 1);
      return { value, size: locator.size, crc: locator.crc, mtimeMs: locator.mtimeMs };
    },
    head(key: string, locator: ExtentLocator) {
      return store.head(key, locator);
    },
    tombstone(key: string) {
      store.tombstone(key);
    },
    beginWrite(key: string) {
      const id = store.writeBegin(key);
      return {
        write(chunk: Buffer) {
          store.write(id, chunk);
        },
        finish(meta?: PutMeta) {
          return store.writeFinish(id, meta);
        },
        abort() {
          store.writeAbort(id);
        },
      };
    },
    flush() {
      store.sync();
    },
    compact() {
      return store.compact();
    },
    scan() {
      return store.scan();
    },
  };

  return {
    address: advertise,
    local,
    stop() {
      clearInterval(flushTimer);
      clearInterval(healthTimer);
      if (fsyncTimer) {
        clearInterval(fsyncTimer);
      }
      if (compactTimer) {
        clearInterval(compactTimer);
      }
      store.sync();
      store.close();
    },
  };
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('/disk.ts') || entry.endsWith('/disk.js')) {
  startDisk();
}
