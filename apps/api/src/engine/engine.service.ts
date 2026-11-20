import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ControlError,
  IndexClient,
  NodeRegistry,
  ObjectCluster,
  parseBlockNodes,
  parseIndexUrls,
  type ClusterStats,
  type RepairReport,
} from '@s3dfs/control';
import { IndexConfigStore, IndexUploadStore } from '../s3/index-store';
import { MultipartUploads } from '../s3/multipart';
import { applyLifecycle } from '../s3/product';

@Injectable()
export class EngineService implements OnModuleInit, OnModuleDestroy {
  private kv!: IndexClient;
  private registry!: NodeRegistry;
  private cluster!: ObjectCluster;
  private timer: ReturnType<typeof setInterval> | undefined;
  private repairTimer: ReturnType<typeof setInterval> | undefined;
  private repairing = false;

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
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    if (this.repairTimer) {
      clearInterval(this.repairTimer);
    }
  }

  index(): IndexClient {
    return this.kv;
  }

  objects(): ObjectCluster {
    return this.cluster;
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
    const uploads = new MultipartUploads(new IndexUploadStore(this.kv));
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
}
