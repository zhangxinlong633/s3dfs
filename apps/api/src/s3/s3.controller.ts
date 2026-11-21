import { Controller, All, Req, Res } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { ControlError, serviceHealthy } from '@s3dfs/control';
import { EngineService } from '../engine/engine.service';
import { alertBodies, postAlerts } from './alerts';
import { adminWriteAllowed } from './admin-auth';
import { handleS3, type S3Options } from './handle';
import { IamDirectory } from './iam';
import { S3HttpError } from './multipart';
import { verifySigV4 } from './sigv4';
import type { AccessAccount } from './product';
import { IndexConfigStore, IndexObjectMeta, IndexUploadStore, IndexVersionStore } from './index-store';
import { RequestMetrics } from './metrics';
import { MultipartUploads } from './multipart';
import { patrolAuthorized } from './patrol';
import { errorXml } from './s3.xml';

type RawReq = Request & { rawBody?: Buffer; bodyStream?: AsyncIterable<Buffer> };

function accountsFromEnv(): AccessAccount[] | undefined {
  const raw = process.env.S3DFS_ACCOUNTS;
  if (!raw) {
    return undefined;
  }
  const parsed = JSON.parse(raw) as AccessAccount[];
  return Array.isArray(parsed) ? parsed : undefined;
}

function replicaFromEnv(): S3Options['replica'] {
  const base = process.env.S3DFS_REPLICA_URL;
  if (!base) {
    return undefined;
  }
  const root = base.replace(/\/$/, '');
  return {
    async put(bucket, key, body) {
      await fetch(`${root}/${bucket}/${encodeURI(key)}`, { method: 'PUT', body });
    },
    async delete(bucket, key) {
      await fetch(`${root}/${bucket}/${encodeURI(key)}`, { method: 'DELETE' });
    },
  };
}

function accessKeyFrom(headers: Request['headers']): string | undefined {
  const raw = headers.authorization ?? headers.Authorization;
  const auth = Array.isArray(raw) ? raw[0] : raw;
  const cred = /Credential=([^,\s]+)/.exec(auth ?? '')?.[1] ?? '';
  return cred.split('/')[0] || undefined;
}

function iamFromIndex(index: {
  get(key: string): Promise<{ value: Buffer } | null>;
  put(key: string, value: Buffer): Promise<void>;
  delete(key: string): Promise<boolean>;
  scan(opts: { prefix?: string; startAfter?: string; maxKeys?: number }): Promise<{ objects: { key: string }[]; truncated: boolean }>;
}): IamDirectory {
  return new IamDirectory({
    get: (key) => index.get(key),
    put: (key, value) => index.put(key, value),
    delete: (key) => index.delete(key),
    async scan(prefix) {
      const keys: string[] = [];
      let startAfter: string | undefined;
      for (;;) {
        const listed = await index.scan({ prefix, startAfter, maxKeys: 1000 });
        keys.push(...listed.objects.map((item) => item.key));
        if (!listed.truncated || listed.objects.length === 0) {
          return keys;
        }
        startAfter = listed.objects[listed.objects.length - 1]?.key;
      }
    },
  });
}

function sendServiceError(res: Response, err: unknown): boolean {
  if (
    err instanceof ControlError &&
    (err.code === 'INDEX_UNAVAILABLE' || err.code === 'BLOCK_UNAVAILABLE' || err.code === 'QUORUM_FAILED')
  ) {
    res.setHeader('Content-Type', 'application/xml');
    res.status(503).send(errorXml('ServiceUnavailable', err.message));
    return true;
  }
  return false;
}

@Controller()
export class S3Controller {
  private uploads?: MultipartUploads;
  private readonly metrics = new RequestMetrics();

  constructor(private readonly engine: EngineService) {}

  private sessions(): MultipartUploads {
    if (!this.uploads) {
      this.uploads = new MultipartUploads(new IndexUploadStore(this.engine.index(), this.engine));
    }
    return this.uploads;
  }

  private options(): S3Options {
    const accessKeyId = process.env.S3DFS_ACCESS_KEY;
    const secretAccessKey = process.env.S3DFS_SECRET_KEY;
    return {
      credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
      accounts: accountsFromEnv(),
      replica: replicaFromEnv(),
      iam: iamFromIndex(this.engine.index()),
      domain: process.env.S3DFS_DOMAIN,
      sseSecret: process.env.S3DFS_SSE_KEY,
      ssePrevious: process.env.S3DFS_SSE_KEY_PREVIOUS,
      config: new IndexConfigStore(this.engine.index()),
      versions: new IndexVersionStore(this.engine.index(), {
        put: (bucket, key, value) => this.engine.put(bucket, key, value),
        get: (bucket, key) => this.engine.get(bucket, key),
        delete: (bucket, key) => this.engine.delete(bucket, key),
      }),
      meta: new IndexObjectMeta(this.engine.index()),
      maxObjectBytes: Number(process.env.S3DFS_MAX_OBJECT_BYTES ?? 1024 * 1024 * 1024),
    };
  }

  @All('{*splat}')
  async handle(@Req() req: RawReq, @Res() res: Response): Promise<void> {
    const url = new URL(req.originalUrl || req.url, 'http://127.0.0.1');
    const requestId = randomBytes(8).toString('hex');
    const started = Date.now();
    res.setHeader('x-amz-request-id', requestId);
    this.engine.beginRequest();
    let status = 500;
    try {
      if (url.pathname === '/_s3dfs/health' && req.method === 'GET') {
        const indexOk = await this.engine.index().ping();
        const layout = await this.engine.probeLayout();
        const lost = await this.engine.syncLost();
        const lostKeys = await this.engine.lostKeys();
        const zones = this.engine.zoneDisks();
        const ok = serviceHealthy(indexOk, layout, lost);
        status = ok ? 200 : 503;
        void postAlerts(process.env.S3DFS_ALERT_URL, alertBodies({ lostKeys, layoutOk: layout.ok, reasons: layout.reasons })).catch(() => undefined);
        res.status(status).json({ indexOk, lost, lostKeys, zones, ...layout, layout, ok });
        return;
      }
      if (url.pathname === '/_s3dfs/metrics' && req.method === 'GET') {
        status = 200;
        res.status(status).json(this.metrics.snapshot());
        return;
      }
      if (url.pathname === '/_s3dfs/modules' && req.method === 'GET') {
        if (!patrolAuthorized(req.header('x-s3dfs-patrol-token'), process.env)) {
          status = 401;
          res.status(status).end();
          return;
        }
        status = 200;
        res.status(status).json(await this.engine.moduleSnapshot());
        return;
      }
      if (url.pathname === '/_s3dfs/decisions' && req.method === 'GET') {
        if (!patrolAuthorized(req.header('x-s3dfs-patrol-token'), process.env)) {
          status = 401;
          res.status(status).end();
          return;
        }
        status = 200;
        res.status(status).json(this.engine.decisions());
        return;
      }
      if (url.pathname === '/_s3dfs/patrol' && req.method === 'POST') {
        if (!patrolAuthorized(req.header('x-s3dfs-patrol-token'), process.env)) {
          status = 401;
          res.status(status).end();
          return;
        }
        status = 200;
        res.status(status).json(await this.engine.patrol());
        return;
      }
      if (url.pathname === '/_s3dfs/patrol/summary' && req.method === 'POST') {
        if (!patrolAuthorized(req.header('x-s3dfs-patrol-token'), process.env)) {
          status = 401;
          res.status(status).end();
          return;
        }
        const body = JSON.parse((req.rawBody ?? Buffer.alloc(0)).toString('utf8') || '{}') as { summary?: string };
        status = 200;
        res.status(status).json(this.engine.notePatrolSummary(body.summary ?? ''));
        return;
      }
      if (url.pathname.startsWith('/_s3dfs/incidents/') && req.method === 'GET') {
        const id = decodeURIComponent(url.pathname.slice('/_s3dfs/incidents/'.length));
        const incident = this.engine.incident(id);
        status = incident ? 200 : 404;
        if (!incident) {
          res.status(status).end();
          return;
        }
        res.status(status).json(incident);
        return;
      }
      if (url.pathname === '/_s3dfs/iam' && req.method === 'POST') {
        const directory = iamFromIndex(this.engine.index());
        const body = JSON.parse((req.rawBody ?? Buffer.alloc(0)).toString('utf8') || '{}') as Parameters<IamDirectory['apply']>[0];
        const admin = adminWriteAllowed({ headers: req.headers, env: process.env, path: url.pathname });
        if (body.op === 'assumeRole' && !admin) {
          const accessKeyId = accessKeyFrom(req.headers);
          const resolved = accessKeyId ? await directory.resolve(accessKeyId, Date.now()) : null;
          if (!accessKeyId || !resolved || typeof resolved === 'string') {
            status = 401;
            res.status(status).end();
            return;
          }
          verifySigV4(
            { method: 'POST', path: url.pathname, query: url.searchParams, headers: req.headers, body: req.rawBody ?? Buffer.alloc(0) },
            { accessKeyId, secretAccessKey: resolved.secretAccessKey },
          );
          body.parent = accessKeyId;
        } else if (!admin) {
          status = 401;
          res.status(status).end();
          return;
        }
        try {
          const result = await directory.apply(body);
          status = 200;
          res.status(status).json(result);
        } catch (err) {
          if (!(err instanceof S3HttpError)) {
            throw err;
          }
          status = err.status;
          res.status(status).json({ code: err.code, message: err.message });
        }
        return;
      }
      if (url.pathname === '/_s3dfs' || url.pathname.startsWith('/_s3dfs/')) {
        status = 404;
        res.status(status).end();
        return;
      }

      const out = await handleS3(
        {
          method: req.method,
          path: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          body: req.rawBody ?? Buffer.alloc(0),
          bodyStream: req.bodyStream,
          host: req.headers.host,
        },
        this.engine,
        this.sessions(),
        this.options(),
      );
      for (const [name, value] of Object.entries(out.headers)) {
        res.setHeader(name, value);
      }
      status = out.status;
      res.status(status);
      if (out.body.length === 0) {
        res.end();
        return;
      }
      res.send(out.body);
    } catch (err) {
      if (!sendServiceError(res, err)) {
        throw err;
      }
      status = 503;
    } finally {
      this.engine.finishRequest(req.method ?? 'GET', Date.now() - started);
      this.engine.noteHttp(status);
      this.metrics.record(status);
      console.log(
        JSON.stringify({
          requestId,
          method: req.method,
          path: url.pathname,
          status,
          ms: Date.now() - started,
        }),
      );
    }
  }
}
