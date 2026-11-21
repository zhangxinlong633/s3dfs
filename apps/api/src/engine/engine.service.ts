import { hostname } from 'node:os';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ControlError,
  IndexClient,
  NodeRegistry,
  ObjectCluster,
  loadScaleConfig,
  parseBlockNodes,
  parseIndexUrls,
  strictLayoutEnabled,
  type ClusterStats,
  type RepairReport,
} from '@s3dfs/control';
import { IndexConfigStore, IndexUploadStore } from '../s3/index-store';
import { MultipartUploads } from '../s3/multipart';
import { applyLifecycle } from '../s3/product';
import { deliverCare, emptyCareState, markCareDelivered, reviewCare, type CareIncident, type CareState } from '../s3/care';
import { compactSnapshot, executePatrol, reviewPatrol, type PatrolReport, type PatrolSnapshot } from '../s3/patrol';
import {
  acquireScaleLease,
  emptyScaleMemory,
  percentile99,
  readScaleMemory,
  runScaleCommand,
  scaleTick,
  writeScaleMemory,
  type ScaleMemory,
} from '../s3/scaler';

function publicApiBase(): string {
  const configured = process.env.S3DFS_PUBLIC_API_URL;
  if (configured) {
    return configured.replace(/\/$/, '');
  }
  const addr = process.env.S3DFS_ADVERTISE_ADDR ?? `127.0.0.1:${process.env.S3DFS_API_PORT ?? 9000}`;
  return addr.startsWith('http') ? addr.replace(/\/$/, '') : `http://${addr}`;
}

@Injectable()
export class EngineService implements OnModuleInit, OnModuleDestroy {
  private kv!: IndexClient;
  private registry!: NodeRegistry;
  private cluster!: ObjectCluster;
  private timer: ReturnType<typeof setInterval> | undefined;
  private repairTimer: ReturnType<typeof setInterval> | undefined;
  private scaleTimer: ReturnType<typeof setInterval> | undefined;
  private repairing = false;
  private scaling = false;
  private inflight = 0;
  private putLatency: number[] = [];
  private apiLatency: number[] = [];
  private httpTotal = 0;
  private httpServerErrors = 0;
  private scaleMemory: ScaleMemory = emptyScaleMemory();
  private careState: CareState = emptyCareState();
  private readonly incidents = new Map<string, CareIncident>();
  private lastRepair: RepairReport | null = null;
  private patrolReport: PatrolReport = {
    findings: [],
    decisions: [],
    apply: [],
    changes: [],
    watch: [],
    brief: '',
    modelSummary: '',
    summary: '',
    truncated: false,
  };

  async onModuleInit(): Promise<void> {
    const urls = parseIndexUrls(process.env.S3DFS_INDEX_URLS ?? 'http://127.0.0.1:9800');
    if (urls.length === 0) {
      throw new ControlError('INDEX_UNAVAILABLE', 'S3DFS_INDEX_URLS is empty');
    }
    const seeds = parseBlockNodes(process.env.S3DFS_BLOCK_NODES ?? 'block1=127.0.0.1:9100');
    const dataReplicas = Math.max(1, Number(process.env.S3DFS_DATA_REPLICAS ?? 3) || 3);
    this.kv = new IndexClient(urls);
    this.registry = new NodeRegistry(this.kv, seeds);
    this.cluster = new ObjectCluster(this.kv, this.registry, dataReplicas);
    await this.registry.checkAll();
    const interval = Number(process.env.S3DFS_HEALTH_INTERVAL_MS ?? 5000);
    this.timer = setInterval(() => {
      void this.registry.checkAll();
    }, interval);
    this.timer.unref();
    const repairEvery = Number(process.env.S3DFS_REPAIR_INTERVAL_MS ?? 30_000);
    if (repairEvery > 0) {
      this.repairTimer = setInterval(() => {
        if (this.repairing) {
          return;
        }
        this.repairing = true;
        void this.repair()
          .then(async (report) => {
            await this.applyLifecycle();
            await this.reviewCare(report.lost);
          })
          .finally(() => {
            this.repairing = false;
          });
      }, repairEvery);
      this.repairTimer.unref();
    }
    const scaleEvery = Number(process.env.S3DFS_SCALE_INTERVAL_MS ?? 30_000);
    if (scaleEvery > 0 && (process.env.S3DFS_SCALE_UP_CMD || process.env.S3DFS_SCALE_DOWN_CMD)) {
      this.scaleTimer = setInterval(() => {
        void this.scaleOnce();
      }, scaleEvery);
      this.scaleTimer.unref();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    if (this.repairTimer) {
      clearInterval(this.repairTimer);
    }
    if (this.scaleTimer) {
      clearInterval(this.scaleTimer);
    }
  }

  beginRequest(): void {
    this.inflight += 1;
  }

  noteHttp(status: number): void {
    this.httpTotal += 1;
    if (status >= 500) {
      this.httpServerErrors += 1;
    }
  }

  finishRequest(method: string, ms: number): void {
    this.inflight = Math.max(0, this.inflight - 1);
    this.apiLatency.push(ms);
    if (method === 'PUT' || method === 'POST') {
      this.putLatency.push(ms);
    }
    if (this.apiLatency.length > 1024) {
      this.apiLatency.splice(0, this.apiLatency.length - 1024);
      this.putLatency.splice(0, Math.max(0, this.putLatency.length - 1024));
    }
  }

  index(): IndexClient {
    return this.kv;
  }

  objects(): ObjectCluster {
    return this.cluster;
  }

  layout() {
    return this.cluster.layout();
  }

  lostCount(): number {
    return this.cluster.lostCount();
  }

  incident(id: string): CareIncident | undefined {
    return this.incidents.get(id);
  }

  objectKey(bucket: string, key?: string): string {
    return this.cluster.objectKey(bucket, key);
  }

  async put(bucket: string, key: string, value: Buffer): Promise<void> {
    await this.cluster.put(bucket, key, value);
  }

  async get(bucket: string, key: string) {
    return this.cluster.get(bucket, key);
  }

  async head(bucket: string, key: string) {
    return this.cluster.head(bucket, key);
  }

  async delete(bucket: string, key: string): Promise<boolean> {
    return this.cluster.delete(bucket, key);
  }

  async createBucket(bucket: string): Promise<void> {
    await this.cluster.createBucket(bucket);
  }

  async deleteBucket(bucket: string): Promise<'ok' | 'missing' | 'notempty'> {
    return this.cluster.deleteBucket(bucket);
  }

  async bucketExists(bucket: string): Promise<boolean> {
    return this.cluster.bucketExists(bucket);
  }

  async listBuckets(): Promise<{ name: string; mtimeMs: number }[]> {
    return this.cluster.listBuckets();
  }

  async getRange(bucket: string, key: string, start: number, end: number) {
    return this.cluster.getRange(bucket, key, start, end);
  }

  async list(bucket: string, prefix = '', startAfter?: string, maxKeys = 1000, delimiter = '') {
    return this.cluster.list(bucket, prefix, startAfter, maxKeys, delimiter);
  }

  async compact(): Promise<void> {
    await this.cluster.compact();
  }

  async flush(): Promise<void> {
    await this.cluster.flush();
  }

  async stats(): Promise<ClusterStats> {
    return this.cluster.stats();
  }

  async repair(): Promise<RepairReport> {
    const report = await this.cluster.repair();
    this.lastRepair = report;
    return report;
  }

  decisions(): PatrolReport {
    return this.patrolReport;
  }

  notePatrolSummary(summary: string): PatrolReport {
    const modelSummary = summary.slice(0, 4000);
    const text = this.patrolReport.brief ? `${this.patrolReport.brief}\n\n模型结论：\n${modelSummary}` : modelSummary;
    this.patrolReport = { ...this.patrolReport, modelSummary, summary: text };
    return this.patrolReport;
  }

  async moduleSnapshot(): Promise<PatrolSnapshot> {
    const stats = await this.stats();
    const layout = this.layout();
    const config = loadScaleConfig();
    const memory = this.scaleMemory;
    const streak = Math.max(memory.streak.index, memory.streak.block, memory.streak.api);
    const lastActionMs = Math.max(memory.lastActionMs.index, memory.lastActionMs.block, memory.lastActionMs.api);
    const counts = await this.locatorCounts();
    let indexLatency = 0;
    const started = Date.now();
    try {
      await this.kv.put('$patrol/probe', Buffer.from(String(started)));
      indexLatency = Date.now() - started;
    } catch {
      indexLatency = config.highLatencyMs + 1;
    }
    const wants = streak >= config.highStreak ? 'up' : memory.draining ? 'down' : 'none';
    return compactSnapshot({
      now: Date.now(),
      index: {
        ok: await this.kv.ping(),
        keys: stats.objects,
        latencyP99Ms: indexLatency,
        copiesMatch: await this.indexCopiesMatch(),
      },
      block: {
        nodes: stats.blockNodes.map((node) => ({
          nodeId: node.nodeId,
          up: node.status === 'up',
          zone: node.zone,
          bytesOnDisk: node.stats?.bytesOnDisk ?? 0,
          deadBytes: node.stats?.deadBytes ?? 0,
          locators: counts === 'incomplete' ? 1 : (counts.get(node.nodeId) ?? 0),
          draining: Boolean(node.draining),
          unflushedBytes: node.stats?.unflushedBytes ?? 0,
        })),
      },
      layout: {
        ok: layout.ok,
        strict: layout.strict,
        dataReplicas: layout.dataReplicas,
        liveBlocks: layout.liveBlocks,
        failureDomains: layout.failureDomains,
      },
      repair: {
        lost: this.lostCount(),
        shortCopies: (this.lastRepair?.repaired ?? 0) + (this.lastRepair?.failed ?? 0),
      },
      api: {
        inflight: this.inflight,
        latencyP99Ms: percentile99(this.apiLatency),
        maxInflight: config.apiMaxInflight,
        requests: this.httpTotal,
        serverErrors: this.httpServerErrors,
      },
      scale: {
        wants,
        upConfigured: Boolean(process.env.S3DFS_SCALE_UP_CMD),
        streak,
        highStreak: config.highStreak,
        lastActionMs,
        cooldownMs: config.cooldownMs,
        draining: Boolean(memory.draining),
      },
      care: {
        open: Object.keys(this.careState.open).length,
        incidents: Object.values(this.careState.open).slice(0, 5).map((item) => ({
          id: item.incident.id,
          symptom: item.incident.symptom,
          next: item.incident.next[0] ?? '',
        })),
      },
      compactDeadRatio: Number(process.env.S3DFS_COMPACT_DEAD_RATIO ?? 0.2) || 0.2,
      highLatencyMs: config.highLatencyMs,
    });
  }

  async patrol(): Promise<PatrolReport> {
    const report = reviewPatrol(await this.moduleSnapshot(), this.patrolReport.findings);
    await executePatrol(report, {
      repair: () => this.repair().then(() => undefined),
      compact: () => this.compact(),
      flush: () => this.flush(),
      scaleUp: async () => {
        const cmd = process.env.S3DFS_SCALE_UP_CMD;
        if (!cmd) {
          return;
        }
        const role = (['index', 'block', 'api'] as const).reduce((best, item) =>
          this.scaleMemory.streak[item] > this.scaleMemory.streak[best] ? item : best,
        );
        await runScaleCommand(cmd, { S3DFS_SCALE_ROLE: role, S3DFS_SCALE_REASON: 'patrol' });
      },
    });
    this.patrolReport = report;
    return report;
  }

  async applyLifecycle(): Promise<void> {
    const configStore = new IndexConfigStore(this.kv);
    const uploads = new MultipartUploads(new IndexUploadStore(this.kv, this.cluster));
    const buckets = await this.cluster.listBuckets();
    const now = Date.now();
    for (const bucket of buckets) {
      const config = await configStore.get(bucket.name);
      if (!config.lifecycle || config.lifecycle.length === 0) {
        continue;
      }
      const listed = await this.cluster.list(bucket.name, '', undefined, 10_000, '');
      await applyLifecycle({
        objects: listed.objects.map((object) => ({ bucket: bucket.name, key: object.key, mtimeMs: object.mtimeMs })),
        rules: config.lifecycle,
        now,
        deleteObject: async (name, key) => {
          await this.cluster.delete(name, key);
        },
        uploads: (await uploads.store.list()).filter((upload) => upload.bucket === bucket.name),
        abortUpload: (name, key, id) => uploads.abort(name, key, id).then(() => undefined),
      });
    }
  }

  private async scaleOnce(): Promise<void> {
    if (this.scaling) {
      return;
    }
    this.scaling = true;
    try {
      const owner = `${hostname()}:${process.pid}`;
      const ttl = Number(process.env.S3DFS_SCALE_INTERVAL_MS ?? 30_000) * 2;
      if (!(await acquireScaleLease(this.kv, owner, Date.now(), ttl))) {
        return;
      }
      const config = loadScaleConfig();
      const started = Date.now();
      let indexLatency = config.highLatencyMs + 1;
      try {
        await this.kv.put('$scale/probe', Buffer.from(String(started)));
        indexLatency = Date.now() - started;
      } catch {
        indexLatency = config.highLatencyMs + 1;
      }
      const stats = await this.stats();
      const putLatency = this.putLatency.splice(0);
      const apiLatency = this.apiLatency.splice(0);
      const counts = await this.locatorCounts();
      const blocks = this.registry.list().map((node) => ({
        nodeId: node.nodeId,
        address: node.address,
        zone: node.zone,
        locators: counts === 'incomplete' ? 1 : (counts.get(node.nodeId) ?? 0),
      }));
      const quiet = { keys: 0, bytes: 0, inflight: 0, latencyP99Ms: 0, nodes: 1, streak: 0, lastActionMs: 0 };
      const memory = await readScaleMemory(this.kv);
      const indexNodes = this.kv.endpoints.length + memory.extraIndex;
      const next = await scaleTick({
        now: Date.now(),
        config,
        loads: {
          index: {
            ...quiet,
            keys: stats.objects,
            bytes: Number(process.env.S3DFS_INDEX_USED_BYTES ?? 0) || 0,
            latencyP99Ms: indexLatency,
            nodes: indexNodes,
          },
          block: { ...quiet, bytes: stats.bytesOnDisk, latencyP99Ms: percentile99(putLatency), nodes: blocks.length },
          api: { ...quiet, inflight: this.inflight, latencyP99Ms: percentile99(apiLatency), nodes: Number(process.env.S3DFS_API_NODES ?? 1) },
        },
        memory,
        upCmd: process.env.S3DFS_SCALE_UP_CMD,
        downCmd: process.env.S3DFS_SCALE_DOWN_CMD,
        hook: (cmd, env) => {
          console.log(JSON.stringify({ scale: true, cmd, ...env }));
          return runScaleCommand(cmd, env);
        },
        baseIndexNodes: this.kv.endpoints.length,
        baseApiNodes: Math.max(1, Number(process.env.S3DFS_API_NODES ?? 1) || 1),
        strict: strictLayoutEnabled(),
        writeQuorum: Math.floor(Math.max(1, indexNodes) / 2) + 1,
        blocks,
        indexReady: await this.indexCopiesMatch(),
        apiInflight: this.inflight,
        apiNodeId: owner,
        apiAddress: process.env.S3DFS_ADVERTISE_ADDR ?? `127.0.0.1:${process.env.S3DFS_API_PORT ?? 9000}`,
      });
      if (next.draining?.role === 'block') {
        this.registry.noteDraining(next.draining.nodeId, true);
      }
      this.scaleMemory = next;
      await writeScaleMemory(this.kv, next);
    } catch (err) {
      console.log(JSON.stringify({ scale: false, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      this.scaling = false;
    }
  }

  private async locatorCounts(): Promise<Map<string, number> | 'incomplete'> {
    const counts = new Map<string, number>();
    let startAfter: string | undefined;
    let scanned = 0;
    while (scanned < 20_000) {
      const page = await this.kv.scan({ prefix: '', startAfter, maxKeys: 500 });
      if (page.objects.length === 0) {
        return counts;
      }
      for (const obj of page.objects) {
        scanned += 1;
        startAfter = obj.key;
        if (obj.key.startsWith('$')) {
          continue;
        }
        const raw = await this.kv.get(obj.key);
        if (!raw) {
          continue;
        }
        try {
          const loc = JSON.parse(raw.value.toString('utf8')) as { v?: number; nodeId?: string };
          if (loc.v === 3 && loc.nodeId) {
            counts.set(loc.nodeId, (counts.get(loc.nodeId) ?? 0) + 1);
          }
        } catch {
          // Not a locator.
        }
      }
      if (!page.truncated) {
        return counts;
      }
    }
    return 'incomplete';
  }

  private async reviewCare(repairLost: number): Promise<void> {
    const layout = this.layout();
    const indexOk = await this.index().ping();
    const lost = Math.max(this.lostCount(), repairLost);
    const config = loadScaleConfig();
    const draining = this.scaleMemory.draining;
    const reviewed = reviewCare(this.careState, {
      now: Date.now(),
      indexOk,
      layoutOk: layout.ok,
      strict: layout.strict,
      lost,
      buckets: [],
      draining: draining ? { role: draining.role, nodeId: draining.nodeId } : null,
      cooldownMs: config.cooldownMs,
      contact: process.env.S3DFS_SUPPORT_CONTACT ?? '',
      publicBase: publicApiBase(),
      tried: ['已运行对象副本修复', '索引追平由 dleveldb 按较新的 mtime 完成', '扩缩容仍由评估器调用外部脚本'],
    });
    this.careState = reviewed.state;
    for (const incident of reviewed.pending) {
      this.incidents.set(incident.id, incident);
      const webhookUrls = await this.webhookUrls(incident.scope);
      const delivered = await deliverCare(incident, {
        alertUrl: process.env.S3DFS_ALERT_URL,
        webhookUrls,
        post: async (url, body) => {
          const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
          return res.ok;
        },
        log: (line) => {
          console.log(JSON.stringify({ care: true, delivered: false, text: line }));
        },
      });
      if (delivered && incident.severity === 'action_needed') {
        this.careState = markCareDelivered(this.careState, incident.id);
      }
    }
  }

  private async webhookUrls(scope: string): Promise<string[]> {
    if (!scope || scope === 'cluster' || scope.includes(':')) {
      return [];
    }
    const config = await new IndexConfigStore(this.kv).get(scope);
    return config.notifyUrl ? [config.notifyUrl] : [];
  }

  private async indexCopiesMatch(): Promise<boolean> {
    const urls = this.kv.endpoints;
    if (urls.length < 2) {
      return true;
    }
    try {
      const page = await this.kv.scan({ prefix: '', maxKeys: 20 });
      const keys = page.objects.map((obj) => obj.key).filter((key) => !key.startsWith('$')).slice(0, 20);
      for (const key of keys) {
        let first: string | undefined;
        for (const url of urls) {
          const res = await fetch(`${url}/_dleveldb/kv/get?key=${encodeURIComponent(key)}`);
          if (!res.ok) {
            return false;
          }
          const body = Buffer.from(await res.arrayBuffer()).toString('base64');
          if (first === undefined) {
            first = body;
          } else if (first !== body) {
            return false;
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  }
}
