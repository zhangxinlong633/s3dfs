import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { assertProductionAuth } from './s3/auth-gate';
import { openRequestBody, readAllBody } from './s3/body-stream';
import { errorXml } from './s3/s3.xml';

type RawRequest = IncomingMessage & { rawBody?: Buffer; bodyStream?: AsyncIterable<Buffer>; originalUrl?: string };

async function bootstrap() {
  try {
    assertProductionAuth();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  app.enableCors({ origin: true });
  app.enableShutdownHooks();

  app.use((req: RawRequest, res: ServerResponse, next: () => void) => {
    const method = req.method ?? 'GET';
    if (method !== 'PUT' && method !== 'POST' && method !== 'DELETE') {
      next();
      return;
    }
    const maxBytes = Number(process.env.S3DFS_MAX_OBJECT_BYTES ?? 1024 * 1024 * 1024);
    const sha = String(req.headers['x-amz-content-sha256'] ?? '');
    const encoding = String(req.headers['content-encoding'] ?? '');
    const chunked = encoding.toLowerCase().includes('aws-chunked') || sha.startsWith('STREAMING-');
    const pending = chunked ? readAllBody(req, maxBytes).then((body) => ({ body })) : openRequestBody(req, maxBytes);
    void pending
      .then((opened) => {
        if ('body' in opened) {
          req.rawBody = opened.body;
        } else {
          req.rawBody = Buffer.alloc(0);
          req.bodyStream = opened.stream;
        }
        next();
      })
      .catch((err: unknown) => {
        const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
        if (code === 'ENTITY_TOO_LARGE') {
          const xml = errorXml('EntityTooLarge', 'Object is larger than S3DFS_MAX_OBJECT_BYTES');
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/xml');
          res.end(xml);
          return;
        }
        next();
      });
  });

  const port = Number(process.env.S3DFS_API_PORT ?? 9000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
