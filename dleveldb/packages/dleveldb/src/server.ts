import http from 'node:http';
import { listenLink } from './link.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DLevelDB } from './kv.js';
import { decodeKeyHeader, getHeader, parseJsonBody } from './rpc.js';
import { DLevelDBError, type ScanOptions, type VnodeInfo } from './types.js';

export type BufferedRequest = IncomingMessage & { rawBody?: Buffer };

async function readBody(req: BufferedRequest): Promise<Buffer> {
  if (req.rawBody) {
    return req.rawBody;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  req.rawBody = body;
  return body;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof DLevelDBError) {
    const status =
      err.code === 'NOT_PRIMARY'
        ? 409
        : err.code === 'QUORUM_FAILED' || err.code === 'PRIMARY_UNAVAILABLE'
          ? 503
          : err.code === 'TIMEOUT'
            ? 504
            : 400;
    sendJson(res, status, { error: err.message, code: err.code });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: message });
}

function metaHeaders(res: ServerResponse, meta: { size: number; crc: number; mtimeMs: number }): void {
  res.setHeader('x-dleveldb-size', String(meta.size));
  res.setHeader('x-dleveldb-crc', String(meta.crc));
  res.setHeader('x-dleveldb-mtime', String(meta.mtimeMs));
  res.setHeader('x-s3dfs-size', String(meta.size));
  res.setHeader('x-s3dfs-crc', String(meta.crc));
  res.setHeader('x-s3dfs-mtime', String(meta.mtimeMs));
}

function requestKey(req: BufferedRequest, url: URL): string {
  return (
    decodeKeyHeader(getHeader(req.headers, 'x-dleveldb-key')) ||
    decodeKeyHeader(getHeader(req.headers, 'x-s3dfs-key')) ||
    url.searchParams.get('key') ||
    ''
  );
}

function requestVnode(req: BufferedRequest, url: URL): string {
  return getHeader(req.headers, 'x-dleveldb-vnode') || getHeader(req.headers, 'x-s3dfs-vnode') || url.searchParams.get('vnode') || '';
}

/** 把 /_dleveldb/... 与旧的 /_s3dfs/... 路径归一成后缀。 */
export function rpcSuffix(pathname: string): string | null {
  if (pathname === '/_dleveldb' || pathname === '/_s3dfs' || pathname === '/_dleveldb/' || pathname === '/_s3dfs/') {
    return '/';
  }
  for (const prefix of ['/_s3dfs/dleveldb/', '/_dleveldb/', '/_s3dfs/']) {
    if (pathname.startsWith(prefix)) {
      return '/' + pathname.slice(prefix.length);
    }
  }
  return null;
}

/**
 * 处理 /_dleveldb/cluster、/_dleveldb/chord/*、/_dleveldb/kv/* 等 RPC。
 * 同时接受旧的 /_s3dfs/... 别名。不是这些路径时返回 false，交给外层路由。
 */
export async function dispatchRpc(db: DLevelDB, req: BufferedRequest, res: ServerResponse): Promise<boolean> {
  const host = req.headers.host ?? db.config.advertiseAddr;
  const url = new URL(req.url ?? '/', `http://${host}`);
  const suffix = rpcSuffix(url.pathname);
  const method = (req.method ?? 'GET').toUpperCase();
  if (suffix === null) {
    return false;
  }
  const pathname = suffix;

  try {
    if (pathname === '/cluster' && method === 'GET') {
      sendJson(res, 200, db.status());
      return true;
    }
    if (pathname === '/cluster/lookup' && method === 'GET') {
      const key = url.searchParams.get('key') ?? '';
      sendJson(res, 200, db.lookup(key));
      return true;
    }
    if (pathname === '/chord/ping' && (method === 'GET' || method === 'HEAD')) {
      sendJson(res, 200, { ok: true, nodeId: db.config.nodeId, address: db.config.advertiseAddr });
      return true;
    }
    if (pathname === '/chord/find_successor' && method === 'POST') {
      const body = parseJsonBody<{ hash?: string; hops?: number }>(await readBody(req));
      if (!body.hash) {
        sendJson(res, 400, { error: 'missing hash' });
        return true;
      }
      const vnode = await db.ring.findSuccessor(body.hash, body.hops ?? 0);
      sendJson(res, 200, { vnode });
      return true;
    }
    if (pathname === '/chord/notify' && method === 'POST') {
      const body = parseJsonBody<{ vnode?: VnodeInfo; target?: string }>(await readBody(req));
      if (!body.vnode || !body.target) {
        sendJson(res, 400, { error: 'missing vnode or target' });
        return true;
      }
      db.ring.handleNotify(body.target, body.vnode);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (pathname === '/chord/predecessor' && method === 'GET') {
      const vnodeId = url.searchParams.get('vnode') ?? '';
      sendJson(res, 200, { vnode: db.ring.handlePredecessor(vnodeId) });
      return true;
    }
    if (pathname === '/chord/successor_list' && method === 'GET') {
      const vnodeId = url.searchParams.get('vnode') ?? '';
      sendJson(res, 200, { vnodes: db.ring.handleSuccessorList(vnodeId) });
      return true;
    }
    if (pathname === '/chord/announce' && method === 'POST') {
      const body = parseJsonBody<{ vnodes?: VnodeInfo[] }>(await readBody(req));
      db.ring.rememberAll(body.vnodes ?? []);
      db.ring.formLocalRing();
      sendJson(res, 200, { vnodes: db.ring.sortedKnown() });
      return true;
    }
    if (pathname === '/kv/put' && method === 'POST') {
      const key = requestKey(req, url);
      if (!key) {
        sendJson(res, 400, { error: 'missing x-dleveldb-key' });
        return true;
      }
      const value = await readBody(req);
      await db.put(key, value);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (pathname === '/kv/failover-put' && method === 'POST') {
      const key = requestKey(req, url);
      if (!key) {
        sendJson(res, 400, { error: 'missing x-dleveldb-key' });
        return true;
      }
      const value = await readBody(req);
      await db.putWhilePrimaryDown(key, value, undefined, true);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (pathname === '/kv/failover-delete' && method === 'POST') {
      const body = parseJsonBody<{ key?: string }>(await readBody(req));
      if (!body.key) {
        sendJson(res, 400, { error: 'missing key' });
        return true;
      }
      await db.deleteWhilePrimaryDown(body.key, undefined, true);
      sendJson(res, 200, { deleted: true });
      return true;
    }
    if ((pathname === '/kv/get' || pathname === '/kv/head') && method === 'GET') {
      const key = url.searchParams.get('key') ?? '';
      if (!key) {
        sendJson(res, 400, { error: 'missing key' });
        return true;
      }
      if (pathname.endsWith('/head')) {
        const meta = await db.head(key);
        if (!meta) {
          res.statusCode = 404;
          res.end();
          return true;
        }
        metaHeaders(res, meta);
        res.statusCode = 200;
        res.end();
        return true;
      }
      const found = await db.get(key);
      if (!found) {
        res.statusCode = 404;
        res.end();
        return true;
      }
      metaHeaders(res, found);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(found.value);
      return true;
    }
    if (pathname === '/kv/delete' && method === 'POST') {
      const body = parseJsonBody<{ key?: string }>(await readBody(req));
      if (!body.key) {
        sendJson(res, 400, { error: 'missing key' });
        return true;
      }
      const deleted = await db.delete(body.key);
      sendJson(res, 200, { deleted });
      return true;
    }
    if (pathname === '/kv/scan' && method === 'POST') {
      const opts = parseJsonBody<ScanOptions>(await readBody(req));
      sendJson(res, 200, await db.scan(opts));
      return true;
    }
    if (pathname === '/put' && method === 'POST') {
      const key = requestKey(req, url);
      if (!key) {
        sendJson(res, 400, { error: 'missing x-dleveldb-key' });
        return true;
      }
      const value = await readBody(req);
      const prefs = db.lookup(key).preference;
      const primary = prefs[0];
      if (!primary || !db.ownsPrimary(primary.id)) {
        throw new DLevelDBError('NOT_PRIMARY', `not primary for ${key}`);
      }
      await db.putAsPrimary(key, value, prefs);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (pathname === '/replicate' && method === 'POST') {
      const key = requestKey(req, url);
      const vnodeId = requestVnode(req, url);
      if (!key || !vnodeId) {
        sendJson(res, 400, { error: 'missing x-dleveldb-key or x-dleveldb-vnode' });
        return true;
      }
      const value = await readBody(req);
      const mtimeRaw = getHeader(req.headers, 'x-dleveldb-mtime') || getHeader(req.headers, 'x-s3dfs-mtime');
      const mtimeMs = mtimeRaw ? Number(mtimeRaw) : undefined;
      await db.replicateLocalPut(vnodeId, key, value, Number.isFinite(mtimeMs) ? mtimeMs : undefined);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (pathname === '/delete' && method === 'POST') {
      const body = parseJsonBody<{ key?: string }>(await readBody(req));
      if (!body.key) {
        sendJson(res, 400, { error: 'missing key' });
        return true;
      }
      const deleted = await db.delete(body.key);
      sendJson(res, 200, { deleted });
      return true;
    }
    if (pathname === '/replicate-delete' && method === 'POST') {
      const body = parseJsonBody<{ key?: string; vnode?: string }>(await readBody(req));
      if (!body.key || !body.vnode) {
        sendJson(res, 400, { error: 'missing key or vnode' });
        return true;
      }
      const deleted = await db.replicateLocalDelete(body.vnode, body.key);
      sendJson(res, 200, { deleted });
      return true;
    }
    if ((pathname === '/get-any' || pathname === '/head-any') && method === 'GET') {
      const key = url.searchParams.get('key') ?? '';
      if (!key) {
        sendJson(res, 400, { error: 'missing key' });
        return true;
      }
      const headOnly = pathname.endsWith('/head-any');
      if (headOnly) {
        const meta = await db.localAnyHead(key);
        if (!meta) {
          res.statusCode = 404;
          res.end();
          return true;
        }
        metaHeaders(res, meta);
        res.statusCode = 200;
        res.end();
        return true;
      }
      const found = await db.localAnyGet(key);
      if (!found) {
        res.statusCode = 404;
        res.end();
        return true;
      }
      metaHeaders(res, found);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(found.value);
      return true;
    }
    if ((pathname === '/get' || pathname === '/head') && method === 'GET') {
      const key = url.searchParams.get('key') ?? '';
      const vnodeId = url.searchParams.get('vnode') ?? '';
      if (!key || !vnodeId) {
        sendJson(res, 400, { error: 'missing key or vnode' });
        return true;
      }
      const headOnly = pathname.endsWith('/head');
      if (db.ownsPrimary(vnodeId)) {
        if (headOnly) {
          const meta = await db.localPrimaryHead(key, vnodeId);
          if (!meta) {
            res.statusCode = 404;
            res.end();
            return true;
          }
          metaHeaders(res, meta);
          res.statusCode = 200;
          res.end();
          return true;
        }
        const found = await db.localPrimaryGet(key, vnodeId);
        if (!found) {
          res.statusCode = 404;
          res.end();
          return true;
        }
        metaHeaders(res, found);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(found.value);
        return true;
      }
      if (headOnly) {
        const meta = await db.localReplicaHead(key, vnodeId);
        if (!meta) {
          res.statusCode = 404;
          res.end();
          return true;
        }
        metaHeaders(res, meta);
        res.statusCode = 200;
        res.end();
        return true;
      }
      const found = await db.localReplicaGet(key, vnodeId);
      if (!found) {
        res.statusCode = 404;
        res.end();
        return true;
      }
      metaHeaders(res, found);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(found.value);
      return true;
    }
    if (pathname === '/scan' && method === 'POST') {
      const opts = parseJsonBody<ScanOptions>(await readBody(req));
      sendJson(res, 200, await db.scanLocalPrimaries(opts));
      return true;
    }
    if (pathname === '/scan-replica' && method === 'POST') {
      const body = parseJsonBody<ScanOptions & { vnodeIds?: string[] }>(await readBody(req));
      sendJson(res, 200, await db.scanLocalReplicas(body.vnodeIds ?? [], body));
      return true;
    }
    if (pathname === '/stats' && method === 'GET') {
      sendJson(res, 200, db.stats());
      return true;
    }
    if (pathname === '/flush' && method === 'POST') {
      await db.flush();
      sendJson(res, 200, { ok: true, stats: db.stats() });
      return true;
    }
    if (pathname === '/compact' && method === 'POST') {
      await db.compact();
      sendJson(res, 200, { ok: true, stats: db.stats() });
      return true;
    }

    sendJson(res, 404, { error: 'not found' });
    return true;
  } catch (err) {
    sendError(res, err);
    return true;
  }
}

export function createDLevelDBServer(db: DLevelDB): http.Server {
  return http.createServer((req, res) => {
    void dispatchRpc(db, req, res)
      .then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      })
      .catch((err: unknown) => {
        if (!res.headersSent) {
          sendError(res, err);
        }
      });
  });
}

export async function listenDLevelDB(db: DLevelDB, address = db.config.advertiseAddr): Promise<http.Server> {
  const lastColon = address.lastIndexOf(':');
  const host = lastColon === -1 ? '0.0.0.0' : address.slice(0, lastColon);
  const port = lastColon === -1 ? 9000 : Number(address.slice(lastColon + 1));
  const server = createDLevelDBServer(db);
  const link = await listenLink(db, address);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  server.on('close', () => link.close());
  return server;
}
