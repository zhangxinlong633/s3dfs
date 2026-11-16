import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dispatchRpc, type BufferedRequest } from '@s3dfs/dleveldb';
import { EngineService } from '../engine/engine.service';

@Injectable()
export class DLevelDBMiddleware implements NestMiddleware {
  constructor(private readonly engine: EngineService) {}

  async use(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
    const handled = await dispatchRpc(this.engine.kv(), req as BufferedRequest, res);
    if (!handled) {
      next();
    }
  }
}
