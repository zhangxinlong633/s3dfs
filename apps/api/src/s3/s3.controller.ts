import { Controller, All, Req, Res } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { ControlError, serviceHealthy } from '@s3dfs/control';
import { EngineService } from '../engine/engine.service';
import { handleS3, type S3Options } from './handle';
import { IndexConfigStore, IndexObjectMeta, IndexUploadStore, IndexVersionStore } from './index-store';
import { RequestMetrics } from './metrics';
import { MultipartUploads } from './multipart';
import { patrolAuthorized } from './patrol';
import { errorXml } from './s3.xml';

type RawReq = Request & { rawBody?: Buffer };

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
      domain: process.env.S3DFS_DOMAIN,
      sseSecret: process.env.S3DFS_SSE_KEY,
      config: new IndexConfigStore(this.engine.index()),
      versions: new IndexVersionStore(this.engine.index()),
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
        const layout = this.engine.layout();
        const lost = this.engine.lostCount();
        const ok = serviceHealthy(indexOk, layout, lost);
        status = ok ? 200 : 503;
        res.status(status).json({ indexOk, lost, ...layout, ok });
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
