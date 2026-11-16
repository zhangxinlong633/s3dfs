import { Module } from '@nestjs/common';
import { EngineModule } from './engine/engine.module';
import { S3Module } from './s3/s3.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [EngineModule, AdminModule, S3Module],
})
export class AppModule {
  readonly moduleName = 'AppModule' as const;
}
