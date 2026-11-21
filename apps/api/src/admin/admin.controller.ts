import { Controller, Get, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { EngineService } from '../engine/engine.service';
import { adminWriteAllowed } from '../s3/admin-auth';

@Controller('_s3dfs')
export class AdminController {
  constructor(private readonly engine: EngineService) {}

  @Get('stats')
  async stats() {
    const stats = await this.engine.stats();
    return {
      ...stats,
      layout: this.engine.layout(),
      lost: this.engine.lostCount(),
      zones: this.engine.zoneDisks(),
    };
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

  @Post('bucket-limits')
  async bucketLimits(@Req() req: Request) {
    this.allow(req);
    const url = new URL(req.originalUrl || req.url, 'http://127.0.0.1');
    const bucket = url.searchParams.get('bucket') ?? '';
    if (!bucket) {
      return { ok: false, error: 'missing bucket' };
    }
    const quota = url.searchParams.get('quotaBytes');
    const compress = url.searchParams.get('compress');
    const limits: { quotaBytes?: number; compress?: boolean } = {};
    if (quota !== null && quota !== '') {
      limits.quotaBytes = Number(quota);
    }
    if (compress === 'false' || compress === '0') {
      limits.compress = false;
    } else if (compress === 'true' || compress === '1') {
      limits.compress = true;
    }
    await this.engine.setBucketLimits(bucket, limits);
    return { ok: true };
  }

  @Post('scrub')
  async scrub(@Req() req: Request) {
    this.allow(req);
    return { ok: true, report: await this.engine.scrub() };
  }

  @Post('maintenance')
  async maintenance(@Req() req: Request) {
    this.allow(req);
    const url = new URL(req.originalUrl || req.url, 'http://127.0.0.1');
    const nodeId = url.searchParams.get('nodeId') ?? '';
    const reason = url.searchParams.get('reason') ?? '';
    if (!nodeId || !reason.trim()) {
      return { ok: false, error: 'nodeId and reason are required' };
    }
    return { ok: true, leave: await this.engine.leaveForMaintenance(nodeId, reason) };
  }

  @Post('drain')
  async drain(@Req() req: Request) {
    this.allow(req);
    const url = new URL(req.originalUrl || req.url, 'http://127.0.0.1');
    const nodeId = url.searchParams.get('nodeId') ?? '';
    if (!nodeId) {
      return { ok: false, error: 'missing nodeId' };
    }
    return { ok: true, report: await this.engine.drain(nodeId) };
  }

  @Post('patrol')
  async patrol(@Req() req: Request) {
    this.allow(req);
    return this.engine.patrol();
  }

  @Post('patrol/summary')
  async patrolSummary(@Req() req: Request & { rawBody?: Buffer }) {
    this.allow(req);
    const raw = req.rawBody?.toString('utf8') ?? '';
    let summary = '';
    if (raw) {
      try {
        summary = String((JSON.parse(raw) as { summary?: string }).summary ?? '');
      } catch {
        summary = raw;
      }
    }
    return this.engine.notePatrolSummary(summary);
  }

  @Get('decisions')
  async decisions(@Req() req: Request) {
    this.allow(req);
    return this.engine.decisions();
  }

  @Post('rebalance')
  async rebalance(@Req() req: Request) {
    this.allow(req);
    const url = new URL(req.originalUrl || req.url, 'http://127.0.0.1');
    const nodeId = url.searchParams.get('nodeId') ?? '';
    if (!nodeId) {
      return { ok: false, error: 'missing nodeId' };
    }
    return { ok: true, report: await this.engine.rebalance(nodeId) };
  }

  @Get('changes')
  async changes(@Req() req: Request) {
    this.allow(req);
    return { changes: await this.engine.listChanges() };
  }

  private allow(req: Request): void {
    const path = new URL(req.originalUrl || req.url, 'http://127.0.0.1').pathname;
    if (!adminWriteAllowed({ headers: req.headers, env: process.env, path })) {
      throw new UnauthorizedException();
    }
  }
}
