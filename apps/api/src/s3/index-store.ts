import type { IndexClient } from '@s3dfs/control';
import type { BucketConfig, ConfigStore, ObjectUserMeta, ObjectVersion, VersionStore } from './product';
import type { StoredPart, StoredUpload, UploadStore } from './multipart';

export interface PartObjects {
  put(bucket: string, key: string, value: Buffer): Promise<void>;
  get(bucket: string, key: string): Promise<{ value: Buffer } | null>;
  delete(bucket: string, key: string): Promise<unknown>;
}

function partKey(id: string, partNumber: number): string {
  return `$upload/${id}/${partNumber}`;
}

/** Manifest stays in the index. Part bytes go to the block store under a hidden key. */
export class IndexUploadStore implements UploadStore {
  constructor(
    private readonly kv: IndexClient,
    private readonly objects: PartObjects,
  ) {}

  async create(id: string, bucket: string, key: string, createdMs: number): Promise<void> {
    await this.kv.put(`$upload/${id}`, Buffer.from(JSON.stringify({ bucket, key, createdMs, parts: {} })));
  }

  async putPart(id: string, partNumber: number, part: StoredPart): Promise<void> {
    const raw = await this.kv.get(`$upload/${id}`);
    if (!raw) {
      return;
    }
    const meta = JSON.parse(raw.value.toString('utf8')) as {
      bucket: string;
      key: string;
      createdMs: number;
      parts: Record<string, { etag: string; size: number; mtimeMs: number }>;
    };
    meta.parts[String(partNumber)] = { etag: part.etag, size: part.body.length, mtimeMs: part.mtimeMs };
    await this.objects.put(meta.bucket, partKey(id, partNumber), part.body);
    try {
      await this.kv.put(`$upload/${id}`, Buffer.from(JSON.stringify(meta)));
    } catch (err) {
      await this.objects.delete(meta.bucket, partKey(id, partNumber));
      throw err;
    }
  }

  async notePart(id: string, partNumber: number, part: { etag: string; size: number; mtimeMs: number }): Promise<void> {
    const raw = await this.kv.get(`$upload/${id}`);
    if (!raw) {
      return;
    }
    const meta = JSON.parse(raw.value.toString('utf8')) as {
      bucket: string;
      key: string;
      createdMs: number;
      parts: Record<string, { etag: string; size: number; mtimeMs: number }>;
    };
    meta.parts[String(partNumber)] = part;
    await this.kv.put(`$upload/${id}`, Buffer.from(JSON.stringify(meta)));
  }

  async get(id: string): Promise<StoredUpload | null> {
    const raw = await this.kv.get(`$upload/${id}`);
    if (!raw) {
      return null;
    }
    const meta = JSON.parse(raw.value.toString('utf8')) as {
      bucket: string;
      key: string;
      createdMs: number;
      parts: Record<string, { etag: string; size: number; mtimeMs: number }>;
    };
    const parts = new Map<number, StoredPart>();
    for (const [num, part] of Object.entries(meta.parts)) {
      const body = await this.objects.get(meta.bucket, partKey(id, Number(num)));
      if (!body) {
        continue;
      }
      parts.set(Number(num), { body: body.value, etag: part.etag, mtimeMs: part.mtimeMs });
    }
    return { bucket: meta.bucket, key: meta.key, createdMs: meta.createdMs, parts };
  }

  async remove(id: string): Promise<void> {
    const raw = await this.kv.get(`$upload/${id}`);
    if (raw) {
      const meta = JSON.parse(raw.value.toString('utf8')) as { bucket: string; parts: Record<string, unknown> };
      for (const num of Object.keys(meta.parts)) {
        await this.objects.delete(meta.bucket, partKey(id, Number(num)));
        await this.kv.delete(`$upload/${id}/b/${num}`);
      }
    }
    await this.kv.delete(`$upload/${id}`);
  }

  async list(): Promise<{ id: string; bucket: string; key: string; createdMs: number }[]> {
    const scanned = await this.kv.scan({ prefix: '$upload/', maxKeys: 10_000 });
    const out: { id: string; bucket: string; key: string; createdMs: number }[] = [];
    for (const obj of scanned.objects) {
      if (obj.key.includes('/b/')) {
        continue;
      }
      const raw = await this.kv.get(obj.key);
      if (!raw) {
        continue;
      }
      const meta = JSON.parse(raw.value.toString('utf8')) as { bucket: string; key: string; createdMs: number };
      out.push({ id: obj.key.slice('$upload/'.length), bucket: meta.bucket, key: meta.key, createdMs: meta.createdMs });
    }
    return out;
  }
}

export class IndexConfigStore implements ConfigStore {
  constructor(private readonly kv: IndexClient) {}

  async get(bucket: string): Promise<BucketConfig> {
    const raw = await this.kv.get(`$cfg/${bucket}`);
    if (!raw) {
      return {};
    }
    return JSON.parse(raw.value.toString('utf8')) as BucketConfig;
  }

  async put(bucket: string, config: BucketConfig): Promise<void> {
    await this.kv.put(`$cfg/${bucket}`, Buffer.from(JSON.stringify(config)));
  }
}

export class IndexVersionStore implements VersionStore {
  constructor(
    private readonly kv: IndexClient,
    private readonly objects: PartObjects,
  ) {}

  private bodyKey(key: string, id: string): string {
    return `$ver/${encodeURIComponent(key)}/${id}`;
  }

  async put(bucket: string, key: string, version: ObjectVersion): Promise<void> {
    const base = `$ver/${bucket}/${encodeURIComponent(key)}`;
    const raw = await this.kv.get(`${base}/list`);
    const ids = raw ? (JSON.parse(raw.value.toString('utf8')) as string[]) : [];
    ids.push(version.id);
    await this.kv.put(`${base}/list`, Buffer.from(JSON.stringify(ids)));
    const hasBody = version.body !== null || version.external === true;
    if (version.body) {
      await this.objects.put(bucket, this.bodyKey(key, version.id), version.body);
    }
    await this.kv.put(
      `${base}/${version.id}`,
      Buffer.from(JSON.stringify({ deleteMarker: version.deleteMarker, mtimeMs: version.mtimeMs, hasBody })),
    );
  }

  async get(bucket: string, key: string, versionId: string): Promise<ObjectVersion | null> {
    const base = `$ver/${bucket}/${encodeURIComponent(key)}/${versionId}`;
    const raw = await this.kv.get(base);
    if (!raw) {
      return null;
    }
    const meta = JSON.parse(raw.value.toString('utf8')) as { deleteMarker: boolean; mtimeMs: number; hasBody: boolean };
    const stored = meta.hasBody ? await this.objects.get(bucket, this.bodyKey(key, versionId)) : null;
    return { id: versionId, body: stored?.value ?? null, deleteMarker: meta.deleteMarker, mtimeMs: meta.mtimeMs };
  }

  async list(bucket: string, key: string): Promise<ObjectVersion[]> {
    const base = `$ver/${bucket}/${encodeURIComponent(key)}`;
    const raw = await this.kv.get(`${base}/list`);
    if (!raw) {
      return [];
    }
    const ids = JSON.parse(raw.value.toString('utf8')) as string[];
    const out: ObjectVersion[] = [];
    for (const id of ids) {
      const version = await this.get(bucket, key, id);
      if (version) {
        out.push(version);
      }
    }
    return out;
  }

  async listBucket(bucket: string): Promise<{ key: string; id: string; mtimeMs: number; deleteMarker: boolean }[]> {
    const prefix = `$ver/${bucket}/`;
    const scanned = await this.kv.scan({ prefix, maxKeys: 10_000 });
    const out: { key: string; id: string; mtimeMs: number; deleteMarker: boolean }[] = [];
    for (const obj of scanned.objects) {
      if (obj.key.endsWith('/list')) {
        continue;
      }
      const rest = obj.key.slice(prefix.length);
      const slash = rest.lastIndexOf('/');
      if (slash <= 0) {
        continue;
      }
      const raw = await this.kv.get(obj.key);
      if (!raw) {
        continue;
      }
      const meta = JSON.parse(raw.value.toString('utf8')) as { mtimeMs: number; deleteMarker?: boolean };
      out.push({
        bucket,
        key: decodeURIComponent(rest.slice(0, slash)),
        id: rest.slice(slash + 1),
        mtimeMs: meta.mtimeMs,
        deleteMarker: meta.deleteMarker === true,
      });
    }
    return out;
  }

  async remove(bucket: string, key: string, versionId: string): Promise<void> {
    const base = `$ver/${bucket}/${encodeURIComponent(key)}`;
    const raw = await this.kv.get(`${base}/list`);
    const ids = raw ? (JSON.parse(raw.value.toString('utf8')) as string[]).filter((id) => id !== versionId) : [];
    await this.kv.put(`${base}/list`, Buffer.from(JSON.stringify(ids)));
    await this.kv.delete(`${base}/${versionId}`);
    await this.objects.delete(bucket, this.bodyKey(key, versionId));
  }
}

export class IndexObjectMeta implements ObjectUserMeta {
  constructor(private readonly kv: IndexClient) {}

  private key(bucket: string, objectKey: string): string {
    return `$umeta/${bucket}/${encodeURIComponent(objectKey)}`;
  }

  async save(bucket: string, key: string, meta: Record<string, string>): Promise<void> {
    if (Object.keys(meta).length === 0) {
      try {
        await this.kv.delete(this.key(bucket, key));
      } catch {
        // Clearing metadata that was never stored must not fail the object put.
      }
      return;
    }
    await this.kv.put(this.key(bucket, key), Buffer.from(JSON.stringify(meta)));
  }

  async load(bucket: string, key: string): Promise<Record<string, string>> {
    const raw = await this.kv.get(this.key(bucket, key));
    if (!raw) {
      return {};
    }
    return JSON.parse(raw.value.toString('utf8')) as Record<string, string>;
  }

  async remove(bucket: string, key: string): Promise<void> {
    await this.kv.delete(this.key(bucket, key));
    await this.removeTags(bucket, key);
    await this.saveRetention(bucket, key, null);
    await this.saveLegalHold(bucket, key, 'OFF');
  }

  private tagKey(bucket: string, objectKey: string): string {
    return `$tags/${bucket}/${encodeURIComponent(objectKey)}`;
  }

  async saveTags(bucket: string, key: string, tags: Record<string, string>): Promise<void> {
    if (Object.keys(tags).length === 0) {
      await this.removeTags(bucket, key);
      return;
    }
    await this.kv.put(this.tagKey(bucket, key), Buffer.from(JSON.stringify(tags)));
  }

  async loadTags(bucket: string, key: string): Promise<Record<string, string>> {
    const raw = await this.kv.get(this.tagKey(bucket, key));
    if (!raw) {
      return {};
    }
    return JSON.parse(raw.value.toString('utf8')) as Record<string, string>;
  }

  async removeTags(bucket: string, key: string): Promise<void> {
    await this.kv.delete(this.tagKey(bucket, key));
  }

  private lockKey(bucket: string, objectKey: string): string {
    return `$lock/${bucket}/${encodeURIComponent(objectKey)}`;
  }

  async saveRetention(bucket: string, key: string, retention: { mode: 'GOVERNANCE' | 'COMPLIANCE'; untilMs: number } | null): Promise<void> {
    if (!retention) {
      await this.kv.delete(this.lockKey(bucket, key));
      return;
    }
    await this.kv.put(this.lockKey(bucket, key), Buffer.from(JSON.stringify(retention)));
  }

  async loadRetention(bucket: string, key: string): Promise<{ mode: 'GOVERNANCE' | 'COMPLIANCE'; untilMs: number } | null> {
    const raw = await this.kv.get(this.lockKey(bucket, key));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw.value.toString('utf8')) as { mode: 'GOVERNANCE' | 'COMPLIANCE'; untilMs: number };
  }

  private holdKey(bucket: string, objectKey: string): string {
    return `$hold/${bucket}/${encodeURIComponent(objectKey)}`;
  }

  async saveLegalHold(bucket: string, key: string, status: 'ON' | 'OFF'): Promise<void> {
    if (status === 'OFF') {
      await this.kv.delete(this.holdKey(bucket, key));
      return;
    }
    await this.kv.put(this.holdKey(bucket, key), Buffer.from(status));
  }

  async loadLegalHold(bucket: string, key: string): Promise<'ON' | 'OFF' | null> {
    const raw = await this.kv.get(this.holdKey(bucket, key));
    if (!raw) {
      return null;
    }
    return raw.value.toString('utf8') === 'ON' ? 'ON' : 'OFF';
  }
}
