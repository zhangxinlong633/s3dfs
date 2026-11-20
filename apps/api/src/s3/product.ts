import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { UploadStore } from './multipart';
import { S3HttpError } from './multipart';

export interface PolicyStatement {
  effect: 'Allow' | 'Deny';
  action: string;
  resource: string;
}

export interface LifecycleRule {
  prefix: string;
  days?: number;
  abortDays?: number;
}

export interface BucketConfig {
  versioning?: 'Enabled' | 'Suspended';
  policy?: PolicyStatement[];
  lifecycle?: LifecycleRule[];
  notifyUrl?: string;
}

export interface ConfigStore {
  get(bucket: string): Promise<BucketConfig>;
  put(bucket: string, config: BucketConfig): Promise<void>;
}

export class MemoryConfigStore implements ConfigStore {
  readonly configs = new Map<string, BucketConfig>();

  async get(bucket: string): Promise<BucketConfig> {
    return this.configs.get(bucket) ?? {};
  }

  async put(bucket: string, config: BucketConfig): Promise<void> {
    this.configs.set(bucket, config);
  }
}

export interface ObjectVersion {
  id: string;
  body: Buffer | null;
  deleteMarker: boolean;
  mtimeMs: number;
}

export interface VersionStore {
  put(bucket: string, key: string, version: ObjectVersion): Promise<void>;
  get(bucket: string, key: string, versionId: string): Promise<ObjectVersion | null>;
  list(bucket: string, key: string): Promise<ObjectVersion[]>;
}

export class MemoryVersionStore implements VersionStore {
  readonly versions = new Map<string, ObjectVersion[]>();

  async put(bucket: string, key: string, version: ObjectVersion): Promise<void> {
    const id = `${bucket}/${key}`;
    const list = this.versions.get(id) ?? [];
    list.push(version);
    this.versions.set(id, list);
  }

  async get(bucket: string, key: string, versionId: string): Promise<ObjectVersion | null> {
    return (this.versions.get(`${bucket}/${key}`) ?? []).find((v) => v.id === versionId) ?? null;
  }

  async list(bucket: string, key: string): Promise<ObjectVersion[]> {
    return this.versions.get(`${bucket}/${key}`) ?? [];
  }
}

const SSE_MAGIC = Buffer.from('S3E1');

export function sseKeyFromSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function sealObject(key: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([SSE_MAGIC, iv, cipher.getAuthTag(), body]);
}

export function openObject(key: Buffer, stored: Buffer): Buffer {
  if (stored.length < SSE_MAGIC.length + 12 + 16 || !stored.subarray(0, 4).equals(SSE_MAGIC)) {
    return stored;
  }
  const iv = stored.subarray(4, 16);
  const tag = stored.subarray(16, 32);
  const body = stored.subarray(32);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function isSealed(stored: Buffer): boolean {
  return stored.length >= 4 && stored.subarray(0, 4).equals(SSE_MAGIC);
}

export function checkPolicy(statements: PolicyStatement[] | undefined, action: string, resource: string): void {
  if (!statements || statements.length === 0) {
    return;
  }
  let allowed = false;
  for (const statement of statements) {
    if (!actionMatches(statement.action, action) || !resourceMatches(statement.resource, resource)) {
      continue;
    }
    if (statement.effect === 'Deny') {
      throw new S3HttpError(403, 'AccessDenied', 'Denied by bucket policy');
    }
    allowed = true;
  }
  if (!allowed) {
    throw new S3HttpError(403, 'AccessDenied', 'Denied by bucket policy');
  }
}

function actionMatches(rule: string, action: string): boolean {
  if (rule === '*' || rule === 's3:*') {
    return true;
  }
  return rule === action;
}

function resourceMatches(rule: string, resource: string): boolean {
  const pattern = rule.replace(/^arn:aws:s3:::/, '');
  if (pattern === '*' || pattern === resource) {
    return true;
  }
  if (pattern.endsWith('*')) {
    return resource.startsWith(pattern.slice(0, -1));
  }
  return false;
}

export function actionFor(method: string, key: string | undefined, query: URLSearchParams): string {
  if (key === undefined) {
    if (method === 'PUT') return 's3:CreateBucket';
    if (method === 'DELETE') return 's3:DeleteBucket';
    return 's3:ListBucket';
  }
  if (query.has('uploads') || query.has('uploadId')) return 's3:PutObject';
  if (method === 'DELETE') return 's3:DeleteObject';
  if (method === 'PUT') return 's3:PutObject';
  return 's3:GetObject';
}

export async function applyLifecycle(opts: {
  objects: { bucket: string; key: string; mtimeMs: number }[];
  rules: LifecycleRule[];
  now: number;
  deleteObject: (bucket: string, key: string) => Promise<void>;
  uploads: { id: string; bucket: string; key: string; createdMs: number }[];
  abortUpload: (bucket: string, key: string, id: string) => Promise<void>;
}): Promise<{ expired: number; aborted: number }> {
  let expired = 0;
  let aborted = 0;
  for (const object of opts.objects) {
    for (const rule of opts.rules) {
      if (rule.days === undefined || !object.key.startsWith(rule.prefix)) {
        continue;
      }
      if (opts.now - object.mtimeMs >= rule.days * 86_400_000) {
        await opts.deleteObject(object.bucket, object.key);
        expired++;
        break;
      }
    }
  }
  for (const upload of opts.uploads) {
    for (const rule of opts.rules) {
      if (rule.abortDays === undefined || !upload.key.startsWith(rule.prefix)) {
        continue;
      }
      if (opts.now - upload.createdMs >= rule.abortDays * 86_400_000) {
        await opts.abortUpload(upload.bucket, upload.key, upload.id);
        aborted++;
        break;
      }
    }
  }
  return { expired, aborted };
}

export async function postEvent(
  url: string | undefined,
  event: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!url) {
    return;
  }
  await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
}

export function parseVersioningStatus(xml: string): 'Enabled' | 'Suspended' {
  const status = /<Status>\s*(Enabled|Suspended)\s*<\/Status>/i.exec(xml)?.[1];
  if (status !== 'Enabled' && status !== 'Suspended') {
    throw new S3HttpError(400, 'MalformedXML', 'Versioning status must be Enabled or Suspended');
  }
  return status;
}

export function parseLifecycle(body: string): LifecycleRule[] {
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as { rules?: LifecycleRule[] } | LifecycleRule[];
    const rules = Array.isArray(parsed) ? parsed : parsed.rules ?? [];
    return rules.map((rule) => ({ prefix: rule.prefix ?? '', days: rule.days, abortDays: rule.abortDays }));
  }
  const rules: LifecycleRule[] = [];
  for (const block of body.matchAll(/<Rule\b[^>]*>([\s\S]*?)<\/Rule>/gi)) {
    const xml = block[1] ?? '';
    const prefix = /<Prefix>\s*([^<]*)\s*<\/Prefix>/i.exec(xml)?.[1] ?? '';
    const days = /<Days>\s*(\d+)\s*<\/Days>/i.exec(xml)?.[1];
    const abort = /<AbortIncompleteMultipartUpload>[\s\S]*?<DaysAfterInitiation>\s*(\d+)/i.exec(xml)?.[1];
    rules.push({ prefix, days: days ? Number(days) : undefined, abortDays: abort ? Number(abort) : undefined });
  }
  return rules;
}

export type { UploadStore };
