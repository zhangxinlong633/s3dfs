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
        void this.cluster.repair().finally(() => {
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
}
