import { Controller, All, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ControlError, parseByteRange } from '@s3dfs/control';
import { EngineService } from '../engine/engine.service';
import { errorXml, etagFromCrc, listBucketsXml, listObjectsXml } from './s3.xml';

type RawReq = Request & { rawBody?: Buffer };

function parsePath(urlPath: string): { bucket?: string; key?: string } {
  const trailingSlash = urlPath.endsWith('/') && urlPath !== '/';
  const parts = urlPath.split('/').filter(Boolean);
  if (parts.length === 0) {
    return {};
  }
  if (parts[0] === '_s3dfs') {
    return {};
  }
  const bucket = parts[0];
  // /bucket and /bucket/ are bucket operations; only object keys keep a trailing slash.
  if (parts.length === 1) {
    return { bucket };
  }
  const key = parts.slice(1).join('/') + (trailingSlash ? '/' : '');
  return { bucket, key };
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
  constructor(private readonly engine: EngineService) {}

  @All('{*splat}')
  async handle(@Req() req: RawReq, @Res() res: Response): Promise<void> {
    const url = new URL(req.originalUrl || req.url, 'http://127.0.0.1');
    if (url.pathname === '/_s3dfs' || url.pathname.startsWith('/_s3dfs/')) {
      res.status(404).end();
      return;
    }

    const { bucket, key } = parsePath(url.pathname);
    const method = req.method.toUpperCase();

    try {
      if (!bucket) {
        if (method === 'GET') {
          res.setHeader('Content-Type', 'application/xml');
          res.status(200).send(listBucketsXml(await this.engine.listBuckets()));
          return;
        }
        res.setHeader('Content-Type', 'application/xml');
        res.status(405).send(errorXml('MethodNotAllowed', 'Method not allowed'));
        return;
      }

      if (key === undefined) {
        await this.handleBucket(method, bucket, url, res);
        return;
      }
      await this.handleObject(method, bucket, key, req, res);
    } catch (err) {
      if (!sendServiceError(res, err)) {
        throw err;
      }
    }
  }

  private async handleBucket(method: string, bucket: string, url: URL, res: Response): Promise<void> {
    if (method === 'PUT') {
      await this.engine.createBucket(bucket);
      res.status(200).end();
      return;
    }
    if (method === 'GET' || method === 'HEAD') {
      if (!(await this.engine.bucketExists(bucket))) {
        res.setHeader('Content-Type', 'application/xml');
        res.status(404).send(errorXml('NoSuchBucket', 'The specified bucket does not exist', bucket));
        return;
      }
      const prefix = url.searchParams.get('prefix') ?? '';
      const startAfter =
        url.searchParams.get('start-after') ?? url.searchParams.get('continuation-token') ?? undefined;
      const maxKeys = Number(url.searchParams.get('max-keys') ?? 1000);
      const delimiter = url.searchParams.get('delimiter') ?? '';
      const listed = await this.engine.list(bucket, prefix, startAfter, maxKeys, delimiter);
      if (method === 'HEAD') {
        res.status(200).end();
        return;
      }
      res.setHeader('Content-Type', 'application/xml');
      res.status(200).send(
        listObjectsXml({
          bucket,
          prefix,
          maxKeys,
          truncated: listed.truncated,
          objects: listed.objects,
          delimiter,
          prefixes: listed.prefixes,
          nextToken: listed.nextToken,
        }),
      );
      return;
    }
    res.setHeader('Content-Type', 'application/xml');
    res.status(405).send(errorXml('MethodNotAllowed', 'Method not allowed', bucket));
  }

  private async handleObject(method: string, bucket: string, key: string, req: RawReq, res: Response): Promise<void> {
    if (method === 'PUT') {
      await this.engine.createBucket(bucket);
      const body = req.rawBody ?? Buffer.alloc(0);
      await this.engine.put(bucket, key, body);
      const meta = await this.engine.head(bucket, key);
      if (meta) {
        res.setHeader('ETag', etagFromCrc(meta.crc));
      }
      res.status(200).end();
      return;
    }
    if (method === 'GET' || method === 'HEAD') {
      const meta = await this.engine.head(bucket, key);
      if (!meta) {
        res.setHeader('Content-Type', 'application/xml');
        res.status(404).send(errorXml('NoSuchKey', 'The specified key does not exist', `/${bucket}/${key}`));
        return;
      }
      const rangeHeader = req.headers['range'];
      const range = parseByteRange(Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader, meta.size);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('ETag', etagFromCrc(meta.crc));
      res.setHeader('Last-Modified', new Date(meta.mtimeMs).toUTCString());
      res.setHeader('Content-Type', 'application/octet-stream');
      if (range.kind === 'unsatisfiable') {
        res.setHeader('Content-Range', `bytes */${meta.size}`);
        res.status(416).end();
        return;
      }
      const partial = range.kind === 'partial';
      const start = partial ? range.start : 0;
      const end = partial ? range.end : Math.max(0, meta.size - 1);
      const length = meta.size === 0 ? 0 : end - start + 1;
      if (partial) {
        res.setHeader('Content-Range', `bytes ${start}-${end}/${meta.size}`);
      }
      res.setHeader('Content-Length', String(length));
      if (method === 'HEAD') {
        res.status(partial ? 206 : 200).end();
        return;
      }
      const obj = partial
        ? await this.engine.getRange(bucket, key, start, end)
        : await this.engine.get(bucket, key);
      if (!obj) {
        res.setHeader('Content-Type', 'application/xml');
        res.status(404).send(errorXml('NoSuchKey', 'The specified key does not exist', `/${bucket}/${key}`));
        return;
      }
      res.status(partial ? 206 : 200).send(obj.value);
      return;
    }
    if (method === 'DELETE') {
      await this.engine.delete(bucket, key);
      res.status(204).end();
      return;
    }
    res.setHeader('Content-Type', 'application/xml');
    res.status(405).send(errorXml('MethodNotAllowed', 'Method not allowed', `/${bucket}/${key}`));
  }
}
