import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module';
import { KvModule } from './kv/kv.module';

@Module({
  imports: [KvModule, AdminModule],
})
export class AppModule {
  readonly moduleName = 'AppModule' as const;
}
