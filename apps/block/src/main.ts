import http from 'node:http';
import { statfsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { IndexClient, nodeKey, parseIndexUrls, writeLayoutFile, BACK_PREFIX, type BlockNodeInfo } from '@s3dfs/control';
import { Store } from '@s3dfs/engine';

const dataDir = path.resolve(process.env.S3DFS_DATA_DIR ?? './data/block');
writeLayoutFile(dataDir);
const nodeId = process.env.S3DFS_BLOCK_NODE_ID ?? 'block1';
const port = Number(process.env.S3DFS_BLOCK_PORT ?? 9100);
const host = process.env.S3DFS_BLOCK_HOST ?? '0.0.0.0';
const advertise = process.env.S3DFS_ADVERTISE_ADDR ?? `127.0.0.1:${port}`;
const flushInterval = Number(process.env.S3DFS_FLUSH_INTERVAL_MS ?? 50);
const healthInterval = Number(process.env.S3DFS_HEALTH_INTERVAL_MS ?? 5000);
const compactInterval = Number(process.env.S3DFS_COMPACT_INTERVAL_MS ?? 30_000);
const compactDeadRatio = Number(process.env.S3DFS_COMPACT_DEAD_RATIO ?? 0.2);

const store = Store.open({
  dataDir,
  blockSize: Number(process.env.S3DFS_BLOCK_SIZE ?? 1_073_741_824) || undefined,
  bufferSize: Number(process.env.S3DFS_BUFFER_SIZE ?? 1_048_576) || undefined,
  fsyncOnFlush: process.env.S3DFS_FSYNC_ON_FLUSH !== '0',
});

const indexUrls = parseIndexUrls(process.env.S3DFS_INDEX_URLS);
const kv = indexUrls.length > 0 ? new IndexClient(indexUrls) : null;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

function requestKey(req: IncomingMessage, url: URL): string {
  const header = req.headers['x-s3dfs-key'] ?? req.headers['x-dleveldb-key'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw) {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return url.searchParams.get('key') ?? '';
}

function requestMeta(req: IncomingMessage) {
  const header = req.headers['x-s3dfs-meta'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(decodeURIComponent(raw)) as Parameters<Store['put']>[2];
  } catch {
    return undefined;
  }
}

function requestLocator(req: IncomingMessage, url: URL) {
  const header = req.headers['x-s3dfs-locator'];
  const raw = Array.isArray(header) ? header[0] : (header ?? url.searchParams.get('locator'));
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(decodeURIComponent(raw)) as Parameters<Store['get']>[1];
  } catch {
    return null;
  }
}

const writers = new Map<string, number>();

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function metaHeaders(res: ServerResponse, meta: { size: number; crc: number; mtimeMs: number }): void {
  res.setHeader('x-s3dfs-size', String(meta.size));
  res.setHeader('x-s3dfs-crc', String(meta.crc));
  res.setHeader('x-s3dfs-mtime', String(meta.mtimeMs));
}

function volumeFreeBytes(dir: string): number {
  try {
    const stat = statfsSync(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return 0;
  }
}

function snapshot(): BlockNodeInfo & { stats: ReturnType<Store['stats']>; freeBytes: number } {
  return {
    nodeId,
    address: advertise,
    status: 'up',
    lastSeenMs: Date.now(),
    freeBytes: volumeFreeBytes(dataDir),
    stats: store.stats(),
  };
}

async function announce(back: boolean): Promise<void> {
  if (!kv) {
    return;
  }
  const info: BlockNodeInfo = {
    nodeId,
    address: advertise,
    status: 'up',
    lastSeenMs: Date.now(),
  };
  try {
    await kv.put(nodeKey(nodeId), Buffer.from(JSON.stringify(info)));
    if (back) {
      await kv.put(
        `${BACK_PREFIX}${nodeId}`,
        Buffer.from(JSON.stringify({ nodeId, address: advertise, atMs: Date.now() })),
      );
    }
  } catch (err) {
    console.warn(`block ${nodeId}: index announce failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? advertise}`);
  const method = (req.method ?? 'GET').toUpperCase();
  const pathname = url.pathname;

  if ((pathname === '/health' || pathname === '/_s3dfs/block/health') && method === 'GET') {
    sendJson(res, 200, snapshot());
    return;
  }
  if ((pathname === '/_s3dfs/block/stats' || pathname === '/stats') && method === 'GET') {
    sendJson(res, 200, store.stats());
    return;
  }
  if (pathname === '/_s3dfs/block/put' && method === 'POST') {
    const key = requestKey(req, url);
    if (!key) {
      sendJson(res, 400, { error: 'missing x-s3dfs-key' });
      return;
    }
    const value = await readBody(req);
    const loc = store.put(key, value, requestMeta(req));
    sendJson(res, 200, loc);
    return;
  }
  if (pathname === '/_s3dfs/block/write/begin' && method === 'POST') {
    const key = requestKey(req, url);
    if (!key) {
      sendJson(res, 400, { error: 'missing x-s3dfs-key' });
      return;
    }
    const id = randomBytes(8).toString('hex');
    writers.set(id, store.writeBegin(key));
    sendJson(res, 200, { id });
    return;
  }
  if (pathname === '/_s3dfs/block/write/chunk' && method === 'POST') {
    const header = req.headers['x-s3dfs-write'];
    const id = Array.isArray(header) ? header[0] : header;
    const native = id ? writers.get(id) : undefined;
    if (native === undefined) {
      sendJson(res, 404, { error: 'unknown writer' });
      return;
    }
    store.write(native, await readBody(req));
    sendJson(res, 200, { ok: true });
    return;
  }
  if (pathname === '/_s3dfs/block/write/finish' && method === 'POST') {
    const header = req.headers['x-s3dfs-write'];
    const id = Array.isArray(header) ? header[0] : header;
    const native = id ? writers.get(id) : undefined;
    if (!id || native === undefined) {
      sendJson(res, 404, { error: 'unknown writer' });
      return;
    }
    writers.delete(id);
    const loc = store.writeFinish(native, requestMeta(req));
    sendJson(res, 200, loc);
    return;
  }
  if (pathname === '/_s3dfs/block/write/abort' && method === 'POST') {
    const header = req.headers['x-s3dfs-write'];
    const id = Array.isArray(header) ? header[0] : header;
    const native = id ? writers.get(id) : undefined;
    if (id && native !== undefined) {
      writers.delete(id);
      store.writeAbort(native);
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if ((pathname === '/_s3dfs/block/get' || pathname === '/_s3dfs/block/head') && method === 'GET') {
    const key = requestKey(req, url);
    const loc = requestLocator(req, url);
    if (!key) {
      sendJson(res, 400, { error: 'missing key' });
      return;
    }
    if (!loc) {
      sendJson(res, 400, { error: 'missing x-s3dfs-locator' });
      return;
    }
    if (pathname.endsWith('/head')) {
      const meta = store.head(key, loc);
      if (!meta) {
        res.statusCode = 404;
        res.end();
        return;
      }
      metaHeaders(res, meta);
      sendJson(res, 200, meta);
      return;
    }
    const startRaw = url.searchParams.get('start');
    const endRaw = url.searchParams.get('end');
    if (startRaw !== null && endRaw !== null) {
      const meta = store.head(key, loc);
      if (!meta) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const start = Number(startRaw);
      const end = Number(endRaw);
      const len = end >= start ? end - start + 1 : 0;
      const span = store.getSpan(key, loc, start, len);
      metaHeaders(res, meta);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('x-s3dfs-total-size', String(meta.size));
      res.end(span);
      return;
    }
    const found = store.get(key, loc);
    if (!found) {
      res.statusCode = 404;
      res.end();
      return;
    }
    metaHeaders(res, found);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end(found.value);
    return;
  }
  if (pathname === '/_s3dfs/block/delete' && method === 'POST') {
    const key = requestKey(req, url) || JSON.parse((await readBody(req)).toString('utf8') || '{}').key;
    if (!key) {
      sendJson(res, 400, { error: 'missing key' });
      return;
    }
    store.tombstone(key);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (pathname === '/_s3dfs/block/audit' && method === 'POST') {
    sendJson(res, 200, store.audit());
    return;
  }
  if (pathname === '/_s3dfs/block/scan' && method === 'GET') {
    sendJson(res, 200, store.scan());
    return;
  }
  if (pathname === '/_s3dfs/block/flush' && method === 'POST') {
    store.flush();
    sendJson(res, 200, { ok: true, stats: store.stats() });
    return;
  }
  if (pathname === '/_s3dfs/block/compact' && method === 'POST') {
    const stats = store.compact();
    sendJson(res, 200, stats);
    return;
  }

  res.statusCode = 404;
  res.end();
}

const server = http.createServer((req, res) => {
  void handle(req, res).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: message });
    } else {
      res.end();
    }
  });
});

const flushTimer = setInterval(() => {
  store.flush();
}, flushInterval);
flushTimer.unref();

const healthTimer = setInterval(() => {
  void announce(false);
}, healthInterval);
healthTimer.unref();

function maybeCompact(): void {
  const st = store.stats();
  const disk = st.bytesOnDisk ?? 0;
  if (!st.deadBytes || disk <= 0) {
    return;
  }
  if (st.deadBytes / disk >= compactDeadRatio) {
    store.compact();
  }
}

const compactTimer =
  compactInterval > 0
    ? (() => {
        const timer = setInterval(maybeCompact, compactInterval);
        timer.unref();
        return timer;
      })()
    : null;

server.listen(port, host, () => {
  console.log(`s3dfs block ${nodeId} listening on ${host}:${port} (advertise ${advertise}, data ${dataDir})`);
  void announce(true);
});

const shutdown = () => {
  clearInterval(flushTimer);
  clearInterval(healthTimer);
  if (compactTimer) {
    clearInterval(compactTimer);
  }
  server.close(() => {
    store.flush();
    store.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
