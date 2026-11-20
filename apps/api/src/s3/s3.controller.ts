import { Controller, All, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ControlError } from '@s3dfs/control';
import { EngineService } from '../engine/engine.service';
import { handleS3 } from './handle';
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
  private readonly uploads = new MultipartUploads();

  constructor(private readonly engine: EngineService) {}

  @All('{*splat}')
  async handle(@Req() req: RawReq, @Res() res: Response): Promise<void> {
    const url = new URL(req.originalUrl || req.url, 'http://127.0.0.1');
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
        this.uploads,
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
