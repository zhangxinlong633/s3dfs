import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { dispatchRpc, type BufferedRequest } from 'dleveldb';
import { AppModule } from './app.module';
import { KvService } from './kv/kv.service';

type RawRequest = IncomingMessage & { rawBody?: Buffer };

async function bootstrap() {
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
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      chunks.push(c);
    });
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks);
      next();
    });
    req.on('error', () => {
      next();
    });
    void res;
  });

  const kv = app.get(KvService);
  app.use(async (req: RawRequest, res: ServerResponse, next: () => void) => {
    const handled = await dispatchRpc(kv.kv(), req as BufferedRequest, res);
    if (!handled) {
      next();
    }
  });

  const port = Number(process.env.DLEVELDB_PORT ?? process.env.S3DFS_API_PORT ?? 9000);
  await app.listen(port, '0.0.0.0');
  console.log(`dleveldb api listening on ${port}`);
}

void bootstrap();
