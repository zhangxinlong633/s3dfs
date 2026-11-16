import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { DLevelDBMiddleware } from './dleveldb.middleware';

@Module({})
export class DLevelDBModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // dispatchRpc 只处理 /_s3dfs/cluster|chord|dleveldb，其余路径 next()。
    consumer.apply(DLevelDBMiddleware).forRoutes('*');
  }
}
