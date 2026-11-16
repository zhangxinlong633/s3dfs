import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { IndexClient, nodeKey, parseIndexUrls, type BlockNodeInfo } from '@s3dfs/control';
import { Store } from '@s3dfs/engine';

const dataDir = path.resolve(process.env.S3DFS_DATA_DIR ?? './data/block');
const nodeId = process.env.S3DFS_BLOCK_NODE_ID ?? 'block1';
const port = Number(process.env.S3DFS_BLOCK_PORT ?? 9100);
const host = process.env.S3DFS_BLOCK_HOST ?? '0.0.0.0';
const advertise = process.env.S3DFS_ADVERTISE_ADDR ?? `127.0.0.1:${port}`;
const flushInterval = Number(process.env.S3DFS_FLUSH_INTERVAL_MS ?? 50);
const healthInterval = Number(process.env.S3DFS_HEALTH_INTERVAL_MS ?? 5000);

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

function snapshot(): BlockNodeInfo & { stats: ReturnType<Store['stats']> } {
  return {
    nodeId,
    address: advertise,
    status: 'up',
    lastSeenMs: Date.now(),
    stats: store.stats(),
  };
}

async function announce(): Promise<void> {
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
    store.put(key, value);
    const meta = store.head(key);
    if (!meta) {
      sendJson(res, 500, { error: 'put succeeded but head is missing' });
      return;
    }
    sendJson(res, 200, meta);
    return;
  }
  if ((pathname === '/_s3dfs/block/get' || pathname === '/_s3dfs/block/head') && method === 'GET') {
    const key = requestKey(req, url);
    if (!key) {
      sendJson(res, 400, { error: 'missing key' });
      return;
    }
    if (pathname.endsWith('/head')) {
      const meta = store.head(key);
      if (!meta) {
        res.statusCode = 404;
        res.end();
        return;
      }
      metaHeaders(res, meta);
      sendJson(res, 200, meta);
      return;
    }
    const found = store.get(key);
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
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { key?: string };
    const key = body.key ?? requestKey(req, url);
    if (!key) {
      sendJson(res, 400, { error: 'missing key' });
      return;
    }
    sendJson(res, 200, { deleted: store.delete(key) });
    return;
  }
  if (pathname === '/_s3dfs/block/flush' && method === 'POST') {
    store.flush();
    sendJson(res, 200, { ok: true, stats: store.stats() });
    return;
  }
  if (pathname === '/_s3dfs/block/compact' && method === 'POST') {
    store.compact();
    sendJson(res, 200, { ok: true, stats: store.stats() });
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
  void announce();
}, healthInterval);
healthTimer.unref();

server.listen(port, host, () => {
  console.log(`s3dfs block ${nodeId} listening on ${host}:${port} (advertise ${advertise}, data ${dataDir})`);
  void announce();
});

const shutdown = () => {
  clearInterval(flushTimer);
  clearInterval(healthTimer);
  server.close(() => {
    store.flush();
    store.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
