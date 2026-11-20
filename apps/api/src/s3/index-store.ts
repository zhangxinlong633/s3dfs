import type { IndexClient } from '@s3dfs/control';
import type { BucketConfig, ConfigStore, ObjectUserMeta, ObjectVersion, VersionStore } from './product';
import type { StoredPart, StoredUpload, UploadStore } from './multipart';

/** Multipart manifest and part bytes live in the index, so an API restart keeps the upload. */
export class IndexUploadStore implements UploadStore {
  constructor(private readonly kv: IndexClient) {}

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
    await this.kv.put(`$upload/${id}/b/${partNumber}`, part.body);
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
      const body = await this.kv.get(`$upload/${id}/b/${num}`);
      if (!body) {
        continue;
      }
      parts.set(Number(num), { body: body.value, etag: part.etag, mtimeMs: part.mtimeMs });
    }
    return { bucket: meta.bucket, key: meta.key, createdMs: meta.createdMs, parts };
  }

  async remove(id: string): Promise<void> {
    const current = await this.get(id);
    if (current) {
      for (const num of current.parts.keys()) {
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
  constructor(private readonly kv: IndexClient) {}

  async put(bucket: string, key: string, version: ObjectVersion): Promise<void> {
    const base = `$ver/${bucket}/${encodeURIComponent(key)}`;
    const raw = await this.kv.get(`${base}/list`);
    const ids = raw ? (JSON.parse(raw.value.toString('utf8')) as string[]) : [];
    ids.push(version.id);
    await this.kv.put(`${base}/list`, Buffer.from(JSON.stringify(ids)));
    await this.kv.put(
      `${base}/${version.id}`,
      Buffer.from(JSON.stringify({ deleteMarker: version.deleteMarker, mtimeMs: version.mtimeMs, hasBody: version.body !== null })),
    );
    if (version.body) {
      await this.kv.put(`${base}/${version.id}/body`, version.body);
    }
  }

  async get(bucket: string, key: string, versionId: string): Promise<ObjectVersion | null> {
    const base = `$ver/${bucket}/${encodeURIComponent(key)}/${versionId}`;
    const raw = await this.kv.get(base);
    if (!raw) {
      return null;
    }
    const meta = JSON.parse(raw.value.toString('utf8')) as { deleteMarker: boolean; mtimeMs: number; hasBody: boolean };
    const body = meta.hasBody ? ((await this.kv.get(`${base}/body`))?.value ?? null) : null;
    return { id: versionId, body, deleteMarker: meta.deleteMarker, mtimeMs: meta.mtimeMs };
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
}

export class IndexObjectMeta implements ObjectUserMeta {
  constructor(private readonly kv: IndexClient) {}

  private key(bucket: string, objectKey: string): string {
    return `$umeta/${bucket}/${encodeURIComponent(objectKey)}`;
  }

  async save(bucket: string, key: string, meta: Record<string, string>): Promise<void> {
    if (Object.keys(meta).length === 0) {
      await this.remove(bucket, key);
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
  }
}
