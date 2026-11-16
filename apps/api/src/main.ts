import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { NestExpressApplication } from '@nestjs/platform-express';

type RawRequest = IncomingMessage & { rawBody?: Buffer; originalUrl?: string };

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

  const port = Number(process.env.S3DFS_API_PORT ?? 9000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
