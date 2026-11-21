import { Controller, Get, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { EngineService } from '../engine/engine.service';
import { adminWriteAllowed } from '../s3/admin-auth';

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
  async flush(@Req() req: Request) {
    this.allow(req);
    await this.engine.flush();
    return { ok: true, stats: await this.engine.stats() };
  }

  @Post('compact')
  async compact(@Req() req: Request) {
    this.allow(req);
    await this.engine.compact();
    return { ok: true, stats: await this.engine.stats() };
  }

  @Post('repair')
  async repair(@Req() req: Request) {
    this.allow(req);
    const report = await this.engine.repair();
    return { ok: true, report, stats: await this.engine.stats() };
  }

  private allow(req: Request): void {
    const path = new URL(req.originalUrl || req.url, 'http://127.0.0.1').pathname;
    if (!adminWriteAllowed({ headers: req.headers, env: process.env, path })) {
      throw new UnauthorizedException();
    }
  }
}
