import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
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
  noncurrentDays?: number;
  /** 0 removes a lone delete marker immediately. A positive number waits that many days. */
  deleteMarkerDays?: number;
  tag?: { key: string; value: string };
}

export interface InventoryConfig {
  id: string;
  prefix: string;
  format: 'CSV';
}

export interface CorsRule {
  origins: string[];
  methods: string[];
  headers: string[];
  expose: string[];
  maxAge?: number;
}

export interface BucketConfig {
  versioning?: 'Enabled' | 'Suspended';
  policy?: PolicyStatement[];
  lifecycle?: LifecycleRule[];
  notifyUrl?: string;
  notifyEvents?: string[];
  notify?: { url: string; events?: string[] }[];
  queue?: { events?: string[] };
  objectLock?: { enabled: true; mode?: 'GOVERNANCE' | 'COMPLIANCE'; days?: number };
  encryption?: { algorithm: 'AES256' };
  replication?: { enabled: true };
  blockPublicPolicy?: boolean;
  tags?: Record<string, string>;
  cors?: CorsRule[];
  website?: { index: string; error?: string; redirects?: { prefix: string; replace: string; code?: number }[] };
  location?: string;
  inventories?: InventoryConfig[];
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
  /** Body is already in the block store at `$ver/<key>/<id>`. */
  external?: boolean;
  deleteMarker: boolean;
  mtimeMs: number;
}

export interface VersionStore {
  put(bucket: string, key: string, version: ObjectVersion): Promise<void>;
  get(bucket: string, key: string, versionId: string): Promise<ObjectVersion | null>;
  list(bucket: string, key: string): Promise<ObjectVersion[]>;
  listBucket(bucket: string): Promise<{ key: string; id: string; mtimeMs: number; deleteMarker: boolean }[]>;
  remove(bucket: string, key: string, versionId: string): Promise<void>;
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

  async listBucket(bucket: string): Promise<{ key: string; id: string; mtimeMs: number; deleteMarker: boolean }[]> {
    const prefix = `${bucket}/`;
    const out: { key: string; id: string; mtimeMs: number; deleteMarker: boolean }[] = [];
    for (const [id, versions] of this.versions) {
      if (!id.startsWith(prefix)) {
        continue;
      }
      const key = id.slice(prefix.length);
      for (const version of versions) {
        out.push({ bucket, key, id: version.id, mtimeMs: version.mtimeMs, deleteMarker: version.deleteMarker });
      }
    }
    return out;
  }

  async remove(bucket: string, key: string, versionId: string): Promise<void> {
    const id = `${bucket}/${key}`;
    const list = (this.versions.get(id) ?? []).filter((version) => version.id !== versionId);
    this.versions.set(id, list);
  }
}

const SSE_MAGIC = Buffer.from('S3E1');
const SSE_KEYED = Buffer.from('S3K1');
const SSE_FRAMES = Buffer.from('S3ES');

export function sseKeyId(secret: string): string {
  return createHash('sha256').update(secret).digest().subarray(0, 8).toString('hex');
}

export function sealObjectKeyed(secret: string, plain: Buffer): Buffer {
  const id = Buffer.from(sseKeyId(secret));
  const sealed = sealObject(sseKeyFromSecret(secret), plain);
  const head = Buffer.alloc(5);
  SSE_KEYED.copy(head, 0);
  head[4] = id.length;
  return Buffer.concat([head, id, sealed]);
}

export function openSealed(stored: Buffer, secrets: string[]): Buffer {
  if (stored.length >= 4 && stored.subarray(0, 4).equals(SSE_FRAMES)) {
    const parts: Buffer[] = [];
    let offset = 4;
    while (offset + 4 <= stored.length) {
      const len = stored.readUInt32BE(offset);
      offset += 4;
      parts.push(openSealed(stored.subarray(offset, offset + len), secrets));
      offset += len;
    }
    return Buffer.concat(parts);
  }
  if (stored.length >= 5 && stored.subarray(0, 4).equals(SSE_KEYED)) {
    const len = stored[4] ?? 0;
    const id = stored.subarray(5, 5 + len).toString('utf8');
    const body = stored.subarray(5 + len);
    const secret = secrets.find((item) => sseKeyId(item) === id) ?? secrets[0];
    if (!secret) {
      return stored;
    }
    return openObject(sseKeyFromSecret(secret), body);
  }
  if (isSealed(stored)) {
    let last: unknown;
    for (const secret of secrets) {
      try {
        return openObject(sseKeyFromSecret(secret), stored);
      } catch (err) {
        last = err;
      }
    }
    if (last) {
      throw last;
    }
  }
  return stored;
}

export async function* sealFrames(chunks: AsyncIterable<Buffer>, secret: string): AsyncIterable<Buffer> {
  yield SSE_FRAMES;
  let pending = Buffer.alloc(0);
  const emit = function* (block: Buffer): Generator<Buffer> {
    const sealed = sealObjectKeyed(secret, block);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(sealed.length);
    yield len;
    yield sealed;
  };
  for await (const chunk of chunks) {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= 1024 * 1024) {
      yield* emit(pending.subarray(0, 1024 * 1024));
      pending = pending.subarray(1024 * 1024);
    }
  }
  if (pending.length > 0) {
    yield* emit(pending);
  }
}

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
  objects: { bucket: string; key: string; mtimeMs: number; tags?: Record<string, string> }[];
  rules: LifecycleRule[];
  now: number;
  deleteObject: (bucket: string, key: string) => Promise<void>;
  uploads: { id: string; bucket: string; key: string; createdMs: number }[];
  abortUpload: (bucket: string, key: string, id: string) => Promise<void>;
  versions?: { bucket: string; key: string; id: string; mtimeMs: number; deleteMarker?: boolean }[];
  dropVersion?: (bucket: string, key: string, id: string) => Promise<void>;
}): Promise<{ expired: number; aborted: number; noncurrent: number; deleteMarkers: number }> {
  let expired = 0;
  let aborted = 0;
  let noncurrent = 0;
  let deleteMarkers = 0;
  for (const object of opts.objects) {
    for (const rule of opts.rules) {
      if (rule.days === undefined || !object.key.startsWith(rule.prefix)) {
        continue;
      }
      if (rule.tag && object.tags?.[rule.tag.key] !== rule.tag.value) {
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
  const groups = new Map<string, { bucket: string; key: string; id: string; mtimeMs: number; deleteMarker?: boolean }[]>();
  for (const version of opts.versions ?? []) {
    const id = `${version.bucket}\0${version.key}`;
    const list = groups.get(id) ?? [];
    list.push(version);
    groups.set(id, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const version of list.slice(1)) {
      for (const rule of opts.rules) {
        if (rule.noncurrentDays === undefined || !version.key.startsWith(rule.prefix)) {
          continue;
        }
        if (opts.now - version.mtimeMs >= rule.noncurrentDays * 86_400_000) {
          await opts.dropVersion?.(version.bucket, version.key, version.id);
          noncurrent++;
          break;
        }
      }
    }
    const only = list.length === 1 ? list[0] : undefined;
    if (!only?.deleteMarker) {
      continue;
    }
    for (const rule of opts.rules) {
      if (rule.deleteMarkerDays === undefined || !only.key.startsWith(rule.prefix)) {
        continue;
      }
      if (opts.now - only.mtimeMs >= rule.deleteMarkerDays * 86_400_000) {
        await opts.dropVersion?.(only.bucket, only.key, only.id);
        deleteMarkers++;
        break;
      }
    }
  }
  return { expired, aborted, noncurrent, deleteMarkers };
}

export function eventSelected(filters: string[] | undefined, name: string): boolean {
  if (!filters || filters.length === 0) {
    return true;
  }
  return filters.some((filter) => (filter.endsWith('*') ? name.startsWith(filter.slice(0, -1)) : filter === name));
}

export function policyIsPublic(statements: PolicyStatement[]): boolean {
  return statements.some((statement) => {
    if (statement.effect !== 'Allow') {
      return false;
    }
    const resource = statement.resource.replace(/^arn:aws:s3:::/, '');
    return resource === '*' || resource.endsWith('/*');
  });
}

export function parsePublicAccessBlock(body: string): boolean {
  return /<BlockPublicPolicy>\s*true\s*<\/BlockPublicPolicy>/i.test(body);
}

export function notifyTargets(config: { notifyUrl?: string; notifyEvents?: string[]; notify?: { url: string; events?: string[] }[] }): { url: string; events?: string[] }[] {
  if (config.notify && config.notify.length > 0) {
    return config.notify.filter((target) => target.url.length > 0);
  }
  return config.notifyUrl ? [{ url: config.notifyUrl, events: config.notifyEvents }] : [];
}

export interface ObjectLockConfig {
  enabled: true;
  mode?: 'GOVERNANCE' | 'COMPLIANCE';
  days?: number;
}

export function parseObjectLock(body: string): ObjectLockConfig {
  if (!/<ObjectLockEnabled>\s*Enabled\s*<\/ObjectLockEnabled>/i.test(body)) {
    throw new S3HttpError(400, 'MalformedXML', 'Object lock must be Enabled');
  }
  const mode = /<Mode>\s*(GOVERNANCE|COMPLIANCE)\s*<\/Mode>/i.exec(body)?.[1]?.toUpperCase();
  const days = Number(/<Days>\s*(\d+)\s*<\/Days>/i.exec(body)?.[1] ?? '');
  const lock: ObjectLockConfig = { enabled: true };
  if (mode === 'GOVERNANCE' || mode === 'COMPLIANCE') {
    lock.mode = mode;
  }
  if (Number.isInteger(days) && days > 0) {
    lock.days = days;
  }
  return lock;
}

export function parseDefaultEncryption(body: string): { algorithm: 'AES256' } {
  if (!/<SSEAlgorithm>\s*AES256\s*<\/SSEAlgorithm>/i.test(body)) {
    throw new S3HttpError(400, 'MalformedXML', 'Default encryption must be AES256');
  }
  return { algorithm: 'AES256' };
}

export function parseReplication(body: string): { enabled: true } {
  if (!/<Status>\s*Enabled\s*<\/Status>/i.test(body)) {
    throw new S3HttpError(400, 'MalformedXML', 'Replication rule must be Enabled');
  }
  return { enabled: true };
}

export interface AccessAccount {
  accessKeyId: string;
  secretAccessKey: string;
  buckets: '*' | string[];
  expiresAtMs?: number;
}

export function accountExpired(account: AccessAccount, now: number): boolean {
  return account.expiresAtMs != null && now >= account.expiresAtMs;
}

export function accountAllowsBucket(account: AccessAccount, bucket: string): boolean {
  return account.buckets === '*' || account.buckets.includes(bucket);
}

const SSE_C_MAGIC = Buffer.from('S3EC');

export function sealCustomer(key: Buffer, plain: Buffer): Buffer {
  const sealed = sealObject(key, plain);
  SSE_C_MAGIC.copy(sealed, 0);
  return sealed;
}

export function isCustomerSealed(stored: Buffer): boolean {
  return stored.length >= 4 && stored.subarray(0, 4).equals(SSE_C_MAGIC);
}

export function openCustomer(key: Buffer, stored: Buffer): Buffer {
  const copy = Buffer.from(stored);
  SSE_MAGIC.copy(copy, 0);
  return openObject(key, copy);
}

export async function postEvent(
  config: { notifyUrl?: string; notifyEvents?: string[]; notify?: { url: string; events?: string[] }[]; queue?: { events?: string[] } },
  event: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  queue?: { push(event: Record<string, unknown>): void },
): Promise<void> {
  const name = String(event.event ?? '');
  if (queue && config.queue && eventSelected(config.queue.events, name)) {
    queue.push(event);
  }
  await Promise.all(
    notifyTargets(config)
      .filter((target) => eventSelected(target.events, name))
      .map((target) =>
        fetchImpl(target.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(event),
        }),
      ),
  );
}

export function parseVersioningStatus(xml: string): 'Enabled' | 'Suspended' {
  const status = /<Status>\s*(Enabled|Suspended)\s*<\/Status>/i.exec(xml)?.[1];
  if (status !== 'Enabled' && status !== 'Suspended') {
    throw new S3HttpError(400, 'MalformedXML', 'Versioning status must be Enabled or Suspended');
  }
  return status;
}

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function parseTags(body: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const block of body.matchAll(/<Tag\b[^>]*>([\s\S]*?)<\/Tag>/gi)) {
    const xml = block[1] ?? '';
    const key = /<Key>\s*([^<]*?)\s*<\/Key>/i.exec(xml)?.[1] ?? '';
    const value = /<Value>\s*([^<]*?)\s*<\/Value>/i.exec(xml)?.[1] ?? '';
    if (!key || key.length > 128 || value.length > 256) {
      throw new S3HttpError(400, 'InvalidTag', 'A tag key is required and must fit the S3 size limits');
    }
    tags[key] = value;
  }
  if (Object.keys(tags).length > 10) {
    throw new S3HttpError(400, 'InvalidTag', 'A bucket or object can have at most 10 tags');
  }
  return tags;
}

export function tagsXml(tags: Record<string, string>): string {
  const rows = Object.entries(tags).map(
    ([key, value]) => `<Tag><Key>${xmlText(key)}</Key><Value>${xmlText(value)}</Value></Tag>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?><Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet>${rows.join('')}</TagSet></Tagging>`;
}

export function parseCors(body: string): CorsRule[] {
  const rules: CorsRule[] = [];
  for (const block of body.matchAll(/<CORSRule\b[^>]*>([\s\S]*?)<\/CORSRule>/gi)) {
    const xml = block[1] ?? '';
    const take = (name: string) => [...xml.matchAll(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'gi'))].map((m) => m[1] ?? '');
    const maxAge = /<MaxAgeSeconds>\s*(\d+)\s*<\/MaxAgeSeconds>/i.exec(xml)?.[1];
    rules.push({
      origins: take('AllowedOrigin'),
      methods: take('AllowedMethod').map((method) => method.toUpperCase()),
      headers: take('AllowedHeader'),
      expose: take('ExposeHeader'),
      maxAge: maxAge ? Number(maxAge) : undefined,
    });
  }
  if (rules.length === 0) {
    throw new S3HttpError(400, 'MalformedXML', 'CORS configuration needs at least one rule');
  }
  return rules;
}

export function matchCors(
  rules: CorsRule[] | undefined,
  method: string,
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> | null {
  const read = (name: string): string => {
    const raw = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  };
  const origin = read('origin');
  if (!origin || !rules || rules.length === 0) {
    return null;
  }
  const asked = method.toUpperCase() === 'OPTIONS' ? read('access-control-request-method').toUpperCase() : method.toUpperCase();
  for (const rule of rules) {
    const originOk = rule.origins.includes('*') || rule.origins.includes(origin);
    if (!originOk || (asked && !rule.methods.includes(asked) && !rule.methods.includes('*'))) {
      continue;
    }
    const out: Record<string, string> = {
      'Access-Control-Allow-Origin': rule.origins.includes('*') ? '*' : origin,
      'Access-Control-Allow-Methods': rule.methods.join(','),
      Vary: 'Origin',
    };
    if (rule.headers.length > 0) {
      out['Access-Control-Allow-Headers'] = rule.headers.join(',');
    }
    if (rule.expose.length > 0) {
      out['Access-Control-Expose-Headers'] = rule.expose.join(',');
    }
    if (rule.maxAge !== undefined) {
      out['Access-Control-Max-Age'] = String(rule.maxAge);
    }
    return out;
  }
  return null;
}

export function parseLifecycle(body: string): LifecycleRule[] {
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as { rules?: LifecycleRule[] } | LifecycleRule[];
    const rules = Array.isArray(parsed) ? parsed : parsed.rules ?? [];
    return rules.map((rule) => ({
      prefix: rule.prefix ?? '',
      days: rule.days,
      abortDays: rule.abortDays,
      noncurrentDays: rule.noncurrentDays,
      deleteMarkerDays: rule.deleteMarkerDays,
      tag: rule.tag,
    }));
  }
  const rules: LifecycleRule[] = [];
  for (const block of body.matchAll(/<Rule\b[^>]*>([\s\S]*?)<\/Rule>/gi)) {
    const xml = block[1] ?? '';
    const prefix = /<Prefix>\s*([^<]*)\s*<\/Prefix>/i.exec(xml)?.[1] ?? '';
    const days = /<Days>\s*(\d+)\s*<\/Days>/i.exec(xml)?.[1];
    const abort = /<AbortIncompleteMultipartUpload>[\s\S]*?<DaysAfterInitiation>\s*(\d+)/i.exec(xml)?.[1];
    const noncurrent = /<NoncurrentVersionExpiration>[\s\S]*?<NoncurrentDays>\s*(\d+)/i.exec(xml)?.[1];
    const markerDays = /<DelMarkerExpiration>[\s\S]*?<Days>\s*(\d+)/i.exec(xml)?.[1];
    const markerNow = /<ExpiredObjectDeleteMarker>\s*true\s*<\/ExpiredObjectDeleteMarker>/i.test(xml);
    const tagKey = /<Tag>\s*<Key>\s*([^<]*?)\s*<\/Key>/i.exec(xml)?.[1];
    const tagValue = /<Tag>[\s\S]*?<Value>\s*([^<]*?)\s*<\/Value>/i.exec(xml)?.[1];
    rules.push({
      prefix,
      days: days ? Number(days) : undefined,
      abortDays: abort ? Number(abort) : undefined,
      noncurrentDays: noncurrent ? Number(noncurrent) : undefined,
      deleteMarkerDays: markerDays ? Number(markerDays) : markerNow ? 0 : undefined,
      tag: tagKey ? { key: tagKey, value: tagValue ?? '' } : undefined,
    });
  }
  return rules;
}

export function parseInventory(body: string, fallbackId: string | null): InventoryConfig {
  const id = /<Id>\s*([^<]+?)\s*<\/Id>/i.exec(body)?.[1] ?? fallbackId ?? '';
  const prefix = /<Prefix>\s*([^<]*)\s*<\/Prefix>/i.exec(body)?.[1] ?? '';
  if (!id) {
    throw new S3HttpError(400, 'MalformedXML', 'Inventory configuration needs an Id');
  }
  return { id, prefix, format: 'CSV' };
}

export interface ObjectUserMeta {
  save(bucket: string, key: string, meta: Record<string, string>): Promise<void>;
  load(bucket: string, key: string): Promise<Record<string, string>>;
  remove(bucket: string, key: string): Promise<void>;
  saveTags(bucket: string, key: string, tags: Record<string, string>): Promise<void>;
  loadTags(bucket: string, key: string): Promise<Record<string, string>>;
  removeTags(bucket: string, key: string): Promise<void>;
  saveRetention(bucket: string, key: string, retention: ObjectRetention | null): Promise<void>;
  loadRetention(bucket: string, key: string): Promise<ObjectRetention | null>;
  saveLegalHold(bucket: string, key: string, status: 'ON' | 'OFF'): Promise<void>;
  loadLegalHold(bucket: string, key: string): Promise<'ON' | 'OFF' | null>;
}

export function parseLegalHold(body: string): 'ON' | 'OFF' {
  const status = /<Status>\s*(ON|OFF)\s*<\/Status>/i.exec(body)?.[1]?.toUpperCase();
  if (status !== 'ON' && status !== 'OFF') {
    throw new S3HttpError(400, 'MalformedXML', 'Legal hold status must be ON or OFF');
  }
  return status;
}

export function parseWebsite(body: string): { index: string; error?: string; redirects?: { prefix: string; replace: string; code?: number }[] } {
  const index = /<Suffix>\s*([^<]+?)\s*<\/Suffix>/i.exec(body)?.[1];
  if (!index) {
    throw new S3HttpError(400, 'MalformedXML', 'Website configuration needs an index suffix');
  }
  const error = /<ErrorDocument>[\s\S]*?<Key>\s*([^<]+?)\s*<\/Key>/i.exec(body)?.[1];
  const redirects: { prefix: string; replace: string; code?: number }[] = [];
  for (const block of body.matchAll(/<RoutingRule\b[^>]*>([\s\S]*?)<\/RoutingRule>/gi)) {
    const xml = block[1] ?? '';
    const prefix = /<KeyPrefixEquals>\s*([^<]*?)\s*<\/KeyPrefixEquals>/i.exec(xml)?.[1] ?? '';
    const replace = /<ReplaceKeyPrefixWith>\s*([^<]*?)\s*<\/ReplaceKeyPrefixWith>/i.exec(xml)?.[1] ?? '';
    const code = /<HttpRedirectCode>\s*(\d+)\s*<\/HttpRedirectCode>/i.exec(xml)?.[1];
    if (prefix) {
      redirects.push({ prefix, replace, code: code ? Number(code) : undefined });
    }
  }
  return { index, error, redirects: redirects.length > 0 ? redirects : undefined };
}

export function websiteRedirect(website: { redirects?: { prefix: string; replace: string; code?: number }[] } | undefined, key: string): { key: string; code: number } | null {
  for (const rule of website?.redirects ?? []) {
    if (rule.prefix && key.startsWith(rule.prefix)) {
      return { key: `${rule.replace}${key.slice(rule.prefix.length)}`, code: rule.code ?? 301 };
    }
  }
  return null;
}

export function parseLocation(body: string): string {
  const location = /<LocationConstraint>\s*([^<]+?)\s*<\/LocationConstraint>/i.exec(body)?.[1];
  if (!location) {
    throw new S3HttpError(400, 'MalformedXML', 'Location constraint is required');
  }
  return location;
}

export interface ObjectRetention {
  mode: 'GOVERNANCE' | 'COMPLIANCE';
  untilMs: number;
}

export function parseRetention(body: string): ObjectRetention {
  const mode = /<Mode>\s*(GOVERNANCE|COMPLIANCE)\s*<\/Mode>/i.exec(body)?.[1]?.toUpperCase();
  const until = /<RetainUntilDate>\s*([^<]+)\s*<\/RetainUntilDate>/i.exec(body)?.[1];
  const untilMs = until ? Date.parse(until) : Number.NaN;
  if ((mode !== 'GOVERNANCE' && mode !== 'COMPLIANCE') || Number.isNaN(untilMs)) {
    throw new S3HttpError(400, 'MalformedXML', 'Retention needs GOVERNANCE or COMPLIANCE and a RetainUntilDate');
  }
  return { mode, untilMs };
}

export function retentionXml(retention: ObjectRetention): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Retention xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Mode>${retention.mode}</Mode><RetainUntilDate>${new Date(retention.untilMs).toISOString()}</RetainUntilDate></Retention>`;
}

export function retentionBlocks(retention: ObjectRetention | null, now: number, bypassGovernance: boolean): boolean {
  if (!retention || retention.untilMs <= now) {
    return false;
  }
  return retention.mode === 'COMPLIANCE' || !bypassGovernance;
}

export class MemoryObjectMeta implements ObjectUserMeta {
  readonly rows = new Map<string, Record<string, string>>();
  readonly tagRows = new Map<string, Record<string, string>>();

  async save(bucket: string, key: string, meta: Record<string, string>): Promise<void> {
    this.rows.set(`${bucket}/${key}`, { ...meta });
  }

  async load(bucket: string, key: string): Promise<Record<string, string>> {
    return { ...(this.rows.get(`${bucket}/${key}`) ?? {}) };
  }

  readonly retentionRows = new Map<string, ObjectRetention>();

  async remove(bucket: string, key: string): Promise<void> {
    this.rows.delete(`${bucket}/${key}`);
    this.tagRows.delete(`${bucket}/${key}`);
    this.retentionRows.delete(`${bucket}/${key}`);
    this.legalHoldRows.delete(`${bucket}/${key}`);
  }

  async saveTags(bucket: string, key: string, tags: Record<string, string>): Promise<void> {
    this.tagRows.set(`${bucket}/${key}`, { ...tags });
  }

  async loadTags(bucket: string, key: string): Promise<Record<string, string>> {
    return { ...(this.tagRows.get(`${bucket}/${key}`) ?? {}) };
  }

  async removeTags(bucket: string, key: string): Promise<void> {
    this.tagRows.delete(`${bucket}/${key}`);
  }

  async saveRetention(bucket: string, key: string, retention: ObjectRetention | null): Promise<void> {
    if (!retention) {
      this.retentionRows.delete(`${bucket}/${key}`);
      return;
    }
    this.retentionRows.set(`${bucket}/${key}`, retention);
  }

  async loadRetention(bucket: string, key: string): Promise<ObjectRetention | null> {
    return this.retentionRows.get(`${bucket}/${key}`) ?? null;
  }

  readonly legalHoldRows = new Map<string, 'ON' | 'OFF'>();

  async saveLegalHold(bucket: string, key: string, status: 'ON' | 'OFF'): Promise<void> {
    if (status === 'OFF') {
      this.legalHoldRows.delete(`${bucket}/${key}`);
      return;
    }
    this.legalHoldRows.set(`${bucket}/${key}`, status);
  }

  async loadLegalHold(bucket: string, key: string): Promise<'ON' | 'OFF' | null> {
    return this.legalHoldRows.get(`${bucket}/${key}`) ?? null;
  }
}
