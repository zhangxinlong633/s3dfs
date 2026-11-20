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
  private scaleMemory: ScaleMemory = emptyScaleMemory();

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
        void this.cluster
          .repair()
          .then(() => this.applyLifecycle())
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
    return this.cluster.repair();
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

  private async indexCopiesMatch(): Promise<boolean> {
    const urls = this.kv.endpoints;
    if (urls.length < 2) {
      return false;
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
