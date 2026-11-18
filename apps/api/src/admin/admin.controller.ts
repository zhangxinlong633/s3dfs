import { Controller, Get, Post } from '@nestjs/common';
import { EngineService } from '../engine/engine.service';

@Controller('_s3dfs')
export class AdminController {
  constructor(private readonly engine: EngineService) {}

  @Get('stats')
  async stats() {
    return this.engine.stats();
  }

  @Get('cluster')
  async cluster() {
    return this.engine.stats();
  }

  @Get('buckets')
  async buckets() {
    return { buckets: await this.engine.listBuckets() };
  }

  @Post('flush')
  async flush() {
    await this.engine.flush();
    return { ok: true, stats: await this.engine.stats() };
  }

  @Post('compact')
  async compact() {
    await this.engine.compact();
    return { ok: true, stats: await this.engine.stats() };
  }

  @Post('repair')
  async repair() {
    const report = await this.engine.repair();
    return { ok: true, report, stats: await this.engine.stats() };
  }
}
