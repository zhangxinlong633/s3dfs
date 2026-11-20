import { Controller, All, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ControlError } from '@s3dfs/control';
import { EngineService } from '../engine/engine.service';
import { handleS3, type S3Options } from './handle';
import { IndexConfigStore, IndexObjectMeta, IndexUploadStore, IndexVersionStore } from './index-store';
import { MultipartUploads } from './multipart';
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

  constructor(private readonly engine: EngineService) {}

  private sessions(): MultipartUploads {
    if (!this.uploads) {
      this.uploads = new MultipartUploads(new IndexUploadStore(this.engine.index()));
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
    if (url.pathname === '/_s3dfs/health' && req.method === 'GET') {
      const ok = await this.engine.index().ping();
      res.status(ok ? 200 : 503).json({ ok });
      return;
    }
    if (url.pathname === '/_s3dfs' || url.pathname.startsWith('/_s3dfs/')) {
      res.status(404).end();
      return;
    }

    try {
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
      res.status(out.status);
      if (out.body.length === 0) {
        res.end();
        return;
      }
      res.send(out.body);
    } catch (err) {
      if (!sendServiceError(res, err)) {
        throw err;
      }
    }
  }
}
