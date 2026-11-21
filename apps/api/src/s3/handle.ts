import { createHash, randomBytes } from 'node:crypto';
import { crc32, parseByteRange, type ObjectValue } from '@s3dfs/control';
import { AwsChunkError, objectBytes } from './aws-chunked';
import { MultipartUploads, S3HttpError, parseCompleteParts } from './multipart';
import {
  actionFor,
  checkPolicy,
  isSealed,
  openObject,
  matchCors,
  parseCors,
  parsePublicAccessBlock,
  policyIsPublic,
  parseInventory,
  parseLocation,
  parseLegalHold,
  parseLifecycle,
  parseWebsite,
  websiteRedirect,
  parseRetention,
  parseTags,
  parseVersioningStatus,
  retentionBlocks,
  retentionXml,
  tagsXml,
  postEvent,
  sealObject,
  sseKeyFromSecret,
  type ConfigStore,
  type ObjectUserMeta,
  type VersionStore,
} from './product';
import { verifyChunkSignatures, verifySigV4, type SigV4Identity } from './sigv4';
import {
  completeMultipartXml,
  copyObjectXml,
  errorXml,
  etagFromCrc,
  initiateMultipartXml,
  listBucketsXml,
  listObjectsXml,
  listPartsXml,
  listVersionsXml,
} from './s3.xml';

export interface ListedObject {
  key: string;
  size: number;
  crc: number;
  mtimeMs: number;
}

export interface S3Backend {
  createBucket(bucket: string): Promise<void>;
  bucketExists(bucket: string): Promise<boolean>;
  deleteBucket(bucket: string): Promise<'ok' | 'missing' | 'notempty'>;
  listBuckets(): Promise<{ name: string; mtimeMs: number }[]>;
  list(
    bucket: string,
    prefix: string,
    startAfter: string | undefined,
    maxKeys: number,
    delimiter: string,
  ): Promise<{ truncated: boolean; objects: ListedObject[]; prefixes: string[]; nextToken?: string }>;
  put(bucket: string, key: string, value: Buffer): Promise<void>;
  putStream?(bucket: string, key: string, chunks: AsyncIterable<Buffer>, extraKey?: string): Promise<{ size: number; crc: number }>;
  shareCopy?(srcBucket: string, srcKey: string, dstBucket: string, dstKey: string): Promise<boolean>;
  head(bucket: string, key: string): Promise<Omit<ObjectValue, 'value'> | null>;
  get(bucket: string, key: string): Promise<ObjectValue | null>;
  getRange(
    bucket: string,
    key: string,
    start: number,
    end: number,
  ): Promise<(ObjectValue & { totalSize: number }) | null>;
  delete(bucket: string, key: string): Promise<boolean>;
}

export interface S3Request {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  bodyStream?: AsyncIterable<Buffer>;
  host?: string;
  now?: number;
}

export interface S3Options {
  credentials?: SigV4Identity;
  /** Virtual-hosted buckets are `{bucket}.{domain}`. */
  domain?: string;
  sseSecret?: string;
  config?: ConfigStore;
  versions?: VersionStore;
  meta?: ObjectUserMeta;
  /** Reject a single Put or part larger than this. Unset means no limit. */
  maxObjectBytes?: number;
  fetchImpl?: typeof fetch;
}

export interface S3Response {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function header(headers: S3Request['headers'], name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return raw;
}

function xml(status: number, text: string, extra: Record<string, string> = {}): S3Response {
  return {
    status,
    headers: { 'Content-Type': 'application/xml', ...extra },
    body: Buffer.from(text),
  };
}

function empty(status: number, headers: Record<string, string> = {}): S3Response {
  return { status, headers, body: Buffer.alloc(0) };
}

function parsePath(urlPath: string): { bucket?: string; key?: string } {
  const trailingSlash = urlPath.endsWith('/') && urlPath !== '/';
  const parts = urlPath.split('/').filter(Boolean);
  if (parts.length === 0 || parts[0] === '_s3dfs') {
    return {};
  }
  const bucket = parts[0];
  if (parts.length === 1) {
    return { bucket };
  }
  const key = parts.slice(1).join('/') + (trailingSlash ? '/' : '');
  return { bucket, key };
}

function payload(req: S3Request): Buffer {
  const body = objectBytes({
    encoding: header(req.headers, 'content-encoding'),
    contentSha: header(req.headers, 'x-amz-content-sha256'),
    decodedLength: header(req.headers, 'x-amz-decoded-content-length'),
    body: req.body,
  });
  const md5 = header(req.headers, 'content-md5');
  if (md5 && createHash('md5').update(body).digest('base64') !== md5.trim()) {
    throw new S3HttpError(400, 'BadDigest', 'Content-MD5 does not match the body');
  }
  assertChecksum(body, req.headers);
  return body;
}

function assertChecksum(body: Buffer, headers: S3Request['headers']): void {
  const crcHeader = header(headers, 'x-amz-checksum-crc32');
  if (crcHeader) {
    const got = Buffer.from(crcHeader.trim(), 'base64');
    const expect = Buffer.alloc(4);
    expect.writeUInt32BE(crc32(body));
    if (got.length !== 4 || !got.equals(expect)) {
      throw new S3HttpError(400, 'BadDigest', 'x-amz-checksum-crc32 does not match the body');
    }
  }
  const sha = header(headers, 'x-amz-checksum-sha256');
  if (sha && createHash('sha256').update(body).digest('base64') !== sha.trim()) {
    throw new S3HttpError(400, 'BadDigest', 'x-amz-checksum-sha256 does not match the body');
  }
}

function checksumHeaders(crc: number, headers: S3Request['headers']): Record<string, string> {
  if ((header(headers, 'x-amz-checksum-mode') ?? '').toUpperCase() !== 'ENABLED') {
    return {};
  }
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(crc >>> 0);
  return { 'x-amz-checksum-crc32': bytes.toString('base64') };
}

async function* matchMd5(source: AsyncIterable<Buffer>, md5: string): AsyncIterable<Buffer> {
  const hash = createHash('md5');
  for await (const chunk of source) {
    hash.update(chunk);
    yield chunk;
  }
  if (hash.digest('base64') !== md5.trim()) {
    throw new S3HttpError(400, 'BadDigest', 'Content-MD5 does not match the body');
  }
}

function resolveTarget(req: S3Request, domain: string | undefined): { bucket?: string; key?: string } {
  const host = (req.host ?? '').split(':')[0] ?? '';
  if (domain && host.endsWith(`.${domain}`) && host.length > domain.length + 1) {
    const bucket = host.slice(0, -(domain.length + 1));
    if (bucket && !bucket.includes('.')) {
      const rest = req.path.replace(/^\/+/, '');
      if (!rest) {
        return { bucket };
      }
      return { bucket, key: rest };
    }
  }
  return parsePath(req.path);
}

function isBucketAdmin(req: S3Request): boolean {
  return (
    req.query.has('policy') ||
    req.query.has('versioning') ||
    req.query.has('lifecycle') ||
    req.query.has('notification') ||
    req.query.has('tagging') ||
    req.query.has('cors') ||
    req.query.has('usage') ||
    req.query.has('website') ||
    req.query.has('inventory') ||
    req.query.has('publicAccessBlock') ||
    req.query.has('location')
  );
}

function etagHeaders(crc: number): Record<string, string> {
  return { ETag: etagFromCrc(crc), 'x-s3dfs-etag-algorithm': 'crc32' };
}

function stripEtag(value: string): string {
  return value.trim().replaceAll('"', '').toLowerCase();
}

function parseAmzTagging(raw: string | undefined): Record<string, string> {
  const tags: Record<string, string> = {};
  if (!raw) {
    return tags;
  }
  for (const part of raw.split('&')) {
    if (!part) {
      continue;
    }
    const eq = part.indexOf('=');
    const key = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
    const value = decodeURIComponent(eq < 0 ? '' : part.slice(eq + 1));
    if (key) {
      tags[key] = value;
    }
  }
  return tags;
}

function userMeta(headers: S3Request['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!key.startsWith('x-amz-meta-') || raw === undefined) {
      continue;
    }
    out[key] = Array.isArray(raw) ? (raw[0] ?? '') : raw;
  }
  return out;
}

function assertObjectSize(body: Buffer, max: number | undefined): void {
  if (max !== undefined && max > 0 && body.length > max) {
    throw new S3HttpError(400, 'EntityTooLarge', `Object is larger than ${max} bytes`);
  }
}

async function assertPreconditions(
  backend: S3Backend,
  bucket: string,
  key: string,
  headers: S3Request['headers'],
  method: string,
): Promise<S3Response | null> {
  const match = header(headers, 'if-match');
  const none = header(headers, 'if-none-match');
  const modifiedSince = header(headers, 'if-modified-since');
  const unmodifiedSince = header(headers, 'if-unmodified-since');
  if (!match && !none && !modifiedSince && !unmodifiedSince) {
    return null;
  }
  const meta = await backend.head(bucket, key);
  const etag = meta ? stripEtag(etagFromCrc(meta.crc)) : '';
  if (match && match.trim() !== '*' && (!meta || stripEtag(match) !== etag)) {
    return xml(412, errorXml('PreconditionFailed', 'If-Match failed', `/${bucket}/${key}`));
  }
  if (match && match.trim() === '*' && !meta) {
    return xml(412, errorXml('PreconditionFailed', 'If-Match failed', `/${bucket}/${key}`));
  }
  if (none && method === 'PUT' && none.trim() === '*' && meta) {
    return xml(412, errorXml('PreconditionFailed', 'If-None-Match failed', `/${bucket}/${key}`));
  }
  if (none && method !== 'PUT' && meta && (none.trim() === '*' || stripEtag(none) === etag)) {
    return empty(304, etagHeaders(meta.crc));
  }
  if (method !== 'PUT' && modifiedSince && meta) {
    const since = Date.parse(modifiedSince);
    if (!Number.isNaN(since) && meta.mtimeMs <= since) {
      return empty(304, etagHeaders(meta.crc));
    }
  }
  if (unmodifiedSince && meta) {
    const since = Date.parse(unmodifiedSince);
    if (!Number.isNaN(since) && meta.mtimeMs > since) {
      return xml(412, errorXml('PreconditionFailed', 'If-Unmodified-Since failed', `/${bucket}/${key}`));
    }
  }
  return null;
}

function copySourcePrecondition(
  meta: { crc: number; mtimeMs: number },
  headers: S3Request['headers'],
  resource: string,
): S3Response | null {
  const match = header(headers, 'x-amz-copy-source-if-match');
  const none = header(headers, 'x-amz-copy-source-if-none-match');
  const modifiedSince = header(headers, 'x-amz-copy-source-if-modified-since');
  const unmodifiedSince = header(headers, 'x-amz-copy-source-if-unmodified-since');
  const etag = stripEtag(etagFromCrc(meta.crc));
  if (match && match.trim() !== '*' && stripEtag(match) !== etag) {
    return xml(412, errorXml('PreconditionFailed', 'Copy source If-Match failed', resource));
  }
  if (none && (none.trim() === '*' || stripEtag(none) === etag)) {
    return xml(412, errorXml('PreconditionFailed', 'Copy source If-None-Match failed', resource));
  }
  if (modifiedSince) {
    const since = Date.parse(modifiedSince);
    if (!Number.isNaN(since) && meta.mtimeMs <= since) {
      return xml(412, errorXml('PreconditionFailed', 'Copy source If-Modified-Since failed', resource));
    }
  }
  if (unmodifiedSince) {
    const since = Date.parse(unmodifiedSince);
    if (!Number.isNaN(since) && meta.mtimeMs > since) {
      return xml(412, errorXml('PreconditionFailed', 'Copy source If-Unmodified-Since failed', resource));
    }
  }
  return null;
}

export async function handleS3(
  req: S3Request,
  backend: S3Backend,
  uploads: MultipartUploads,
  options: S3Options = {},
): Promise<S3Response> {
  try {
    if (options.credentials) {
      const signed = verifySigV4({ ...req, now: req.now }, options.credentials);
      const sha = header(req.headers, 'x-amz-content-sha256') ?? '';
      if (sha.startsWith('STREAMING-AWS4-HMAC-SHA256-PAYLOAD')) {
        verifyChunkSignatures(req.body, options.credentials.secretAccessKey, signed.scope, signed.amzDate, signed.signature);
      }
    }
    const { bucket, key } = resolveTarget(req, options.domain);
    const method = req.method.toUpperCase();
    if (bucket && !isBucketAdmin(req)) {
      const config = options.config ? await options.config.get(bucket) : {};
      checkPolicy(config.policy, actionFor(method, key, req.query), key ? `${bucket}/${key}` : bucket);
    }
    if (!bucket) {
      if (method === 'GET') {
        return xml(200, listBucketsXml(await backend.listBuckets()));
      }
      return xml(405, errorXml('MethodNotAllowed', 'Method not allowed'));
    }
    if (method === 'OPTIONS' && options.config) {
      const cors = matchCors((await options.config.get(bucket)).cors, method, req.headers);
      if (!cors) {
        return xml(403, errorXml('AccessForbidden', 'CORS rule does not allow this origin', bucket));
      }
      return empty(200, cors);
    }
    const response =
      key === undefined
        ? await handleBucket(method, bucket, req, backend, uploads, options)
        : await handleObject(method, bucket, key, req, backend, uploads, options);
    if (!options.config) {
      return response;
    }
    const cors = matchCors((await options.config.get(bucket)).cors, method, req.headers);
    return cors ? { ...response, headers: { ...response.headers, ...cors } } : response;
  } catch (err) {
    if (err instanceof S3HttpError) {
      return xml(err.status, errorXml(err.code, err.message));
    }
    if (err instanceof AwsChunkError) {
      return xml(400, errorXml('InvalidRequest', err.message));
    }
    if (err instanceof SyntaxError) {
      return xml(400, errorXml('MalformedXML', err.message));
    }
    throw err;
  }
}

async function handleBucket(
  method: string,
  bucket: string,
  req: S3Request,
  backend: S3Backend,
  uploads: MultipartUploads,
  options: S3Options,
): Promise<S3Response> {
  const configStore = options.config;
  if (req.query.has('tagging') && configStore) {
    if (method === 'GET') {
      const config = await configStore.get(bucket);
      return xml(200, tagsXml(config.tags ?? {}));
    }
    if (method === 'PUT') {
      const config = await configStore.get(bucket);
      config.tags = parseTags(req.body.toString('utf8'));
      await configStore.put(bucket, config);
      return empty(200);
    }
    if (method === 'DELETE') {
      const config = await configStore.get(bucket);
      delete config.tags;
      await configStore.put(bucket, config);
      return empty(204);
    }
  }
  if (req.query.has('cors') && configStore) {
    if (method === 'GET') {
      const config = await configStore.get(bucket);
      const rules = config.cors ?? [];
      const body = rules
        .map((rule) => {
          const origins = rule.origins.map((origin) => `<AllowedOrigin>${origin}</AllowedOrigin>`).join('');
          const methods = rule.methods.map((item) => `<AllowedMethod>${item}</AllowedMethod>`).join('');
          const allowed = rule.headers.map((item) => `<AllowedHeader>${item}</AllowedHeader>`).join('');
          const expose = rule.expose.map((item) => `<ExposeHeader>${item}</ExposeHeader>`).join('');
          const age = rule.maxAge === undefined ? '' : `<MaxAgeSeconds>${rule.maxAge}</MaxAgeSeconds>`;
          return `<CORSRule>${origins}${methods}${allowed}${expose}${age}</CORSRule>`;
        })
        .join('');
      return xml(200, `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration>${body}</CORSConfiguration>`);
    }
    if (method === 'PUT') {
      const config = await configStore.get(bucket);
      config.cors = parseCors(req.body.toString('utf8'));
      await configStore.put(bucket, config);
      return empty(200);
    }
    if (method === 'DELETE') {
      const config = await configStore.get(bucket);
      delete config.cors;
      await configStore.put(bucket, config);
      return empty(204);
    }
  }
  if (req.query.has('website') && configStore) {
    if (method === 'GET') {
      const config = await configStore.get(bucket);
      const suffix = config.website?.index ?? '';
      const error = config.website?.error ? `<ErrorDocument><Key>${config.website.error}</Key></ErrorDocument>` : '';
      const rules = (config.website?.redirects ?? [])
        .map(
          (rule) =>
            `<RoutingRule><Condition><KeyPrefixEquals>${rule.prefix}</KeyPrefixEquals></Condition><Redirect><ReplaceKeyPrefixWith>${rule.replace}</ReplaceKeyPrefixWith>${rule.code ? `<HttpRedirectCode>${rule.code}</HttpRedirectCode>` : ''}</Redirect></RoutingRule>`,
        )
        .join('');
      const body = suffix
        ? `<?xml version="1.0" encoding="UTF-8"?><WebsiteConfiguration><IndexDocument><Suffix>${suffix}</Suffix></IndexDocument>${error}${rules ? `<RoutingRules>${rules}</RoutingRules>` : ''}</WebsiteConfiguration>`
        : `<?xml version="1.0" encoding="UTF-8"?><WebsiteConfiguration/>`;
      return xml(200, body);
    }
    if (method === 'PUT') {
      const config = await configStore.get(bucket);
      config.website = parseWebsite(req.body.toString('utf8'));
      await configStore.put(bucket, config);
      return empty(200);
    }
    if (method === 'DELETE') {
      const config = await configStore.get(bucket);
      delete config.website;
      await configStore.put(bucket, config);
      return empty(204);
    }
  }
  if (req.query.has('location') && configStore) {
    if (method === 'GET') {
      const config = await configStore.get(bucket);
      const location = config.location ?? '';
      const body = location
        ? `<?xml version="1.0" encoding="UTF-8"?><LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${location}</LocationConstraint>`
        : `<?xml version="1.0" encoding="UTF-8"?><LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>`;
      return xml(200, body);
    }
    if (method === 'PUT') {
      const config = await configStore.get(bucket);
      config.location = parseLocation(req.body.toString('utf8'));
      await configStore.put(bucket, config);
      return empty(200);
    }
  }
  if (req.query.has('versioning') && configStore) {
    if (method === 'GET') {
      const config = await configStore.get(bucket);
      const status = config.versioning ?? '';
      const body = status
        ? `<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${status}</Status></VersioningConfiguration>`
        : `<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>`;
      return xml(200, body);
    }
    if (method === 'PUT') {
      const config = await configStore.get(bucket);
      config.versioning = parseVersioningStatus(req.body.toString('utf8'));
      await configStore.put(bucket, config);
      return empty(200);
    }
  }
  if (req.query.has('policy') && configStore) {
    if (method === 'GET') {
      const config = await configStore.get(bucket);
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ Statement: config.policy ?? [] })),
      };
    }
    if (method === 'PUT') {
      const parsed = JSON.parse(req.body.toString('utf8')) as { Statement?: { Effect: 'Allow' | 'Deny'; Action: string; Resource: string }[] };
      const config = await configStore.get(bucket);
      const statements = (parsed.Statement ?? []).map((s) => ({
        effect: s.Effect,
        action: s.Action,
        resource: s.Resource,
      }));
      if (config.blockPublicPolicy && policyIsPublic(statements)) {
        return xml(403, errorXml('AccessDenied', 'Public bucket policies are blocked', bucket));
      }
      config.policy = statements;
      await configStore.put(bucket, config);
      return empty(204);
    }
    if (method === 'DELETE') {
      const config = await configStore.get(bucket);
      delete config.policy;
      await configStore.put(bucket, config);
      return empty(204);
    }
  }
  if (req.query.has('lifecycle') && configStore) {
    if (method === 'PUT') {
      const config = await configStore.get(bucket);
      config.lifecycle = parseLifecycle(req.body.toString('utf8'));
      await configStore.put(bucket, config);
      return empty(200);
    }
    if (method === 'GET') {
      const config = await configStore.get(bucket);
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ rules: config.lifecycle ?? [] })),
      };
    }
  }
  if (req.query.has('publicAccessBlock') && configStore) {
    if (method === 'PUT') {
      const config = await configStore.get(bucket);
      config.blockPublicPolicy = parsePublicAccessBlock(req.body.toString('utf8'));
      await configStore.put(bucket, config);
      return empty(200);
    }
    if (method === 'GET') {
      const config = await configStore.get(bucket);
      const value = config.blockPublicPolicy ? 'true' : 'false';
      return xml(200, `<?xml version="1.0" encoding="UTF-8"?><PublicAccessBlockConfiguration><BlockPublicPolicy>${value}</BlockPublicPolicy></PublicAccessBlockConfiguration>`);
    }
    if (method === 'DELETE') {
      const config = await configStore.get(bucket);
      delete config.blockPublicPolicy;
      await configStore.put(bucket, config);
      return empty(204);
    }
  }
  if (req.query.has('notification') && configStore) {
    if (method === 'PUT') {
      const parsed = JSON.parse(req.body.toString('utf8')) as { url?: string; events?: string[] };
      const config = await configStore.get(bucket);
      config.notifyUrl = parsed.url;
      config.notifyEvents = parsed.events;
      await configStore.put(bucket, config);
      return empty(200);
    }
  }
  if (req.query.has('lifecycle') && method === 'POST' && configStore) {
    const { applyLifecycle } = await import('./product');
    const config = await configStore.get(bucket);
    const listed = await backend.list(bucket, '', undefined, 10_000, '');
    const objects = [];
    for (const object of listed.objects) {
      const tags = options.meta ? await options.meta.loadTags(bucket, object.key) : {};
      objects.push({ bucket, key: object.key, mtimeMs: object.mtimeMs, tags });
    }
    const result = await applyLifecycle({
      objects,
      rules: config.lifecycle ?? [],
      now: req.now ?? Date.now(),
      deleteObject: (b, k) => backend.delete(b, k).then(() => undefined),
      uploads: (await uploads.store.list()).filter((u) => u.bucket === bucket),
      abortUpload: (b, k, id) => uploads.abort(b, k, id).then(() => undefined),
      versions: options.versions ? await options.versions.listBucket(bucket) : [],
      dropVersion: (b, k, id) => options.versions?.remove(b, k, id) ?? Promise.resolve(),
    });
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(result)),
    };
  }
  if (req.query.has('inventory') && configStore) {
    const id = req.query.get('id') ?? '';
    if (method === 'PUT') {
      const next = parseInventory(req.body.toString('utf8'), id);
      const config = await configStore.get(bucket);
      config.inventories = [...(config.inventories ?? []).filter((item) => item.id !== next.id), next];
      await configStore.put(bucket, config);
      return empty(200);
    }
    if (method === 'POST') {
      const config = await configStore.get(bucket);
      const inventory = (config.inventories ?? []).find((item) => item.id === id);
      if (!inventory) {
        return xml(404, errorXml('NoSuchConfiguration', 'The inventory configuration does not exist', bucket));
      }
      const listed = await backend.list(bucket, '', undefined, 10_000, '');
      const lines = ['key,size'];
      for (const object of listed.objects) {
        if (object.key.startsWith(inventory.prefix)) {
          continue;
        }
        lines.push(`${object.key},${object.size}`);
      }
      const key = `${inventory.prefix}${inventory.id}.csv`;
      await backend.put(bucket, key, Buffer.from(`${lines.join('\n')}\n`));
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ key, objects: lines.length - 1 })),
      };
    }
  }
  if (req.query.has('delete') && method === 'POST') {
    const body = req.body.toString('utf8');
    const keys = [...body.matchAll(/<Key>\s*([^<]*?)\s*<\/Key>/gi)].map((match) => match[1] ?? '').filter((key) => key.length > 0);
    const quiet = /<Quiet>\s*true\s*<\/Quiet>/i.test(body);
    const rows: string[] = [];
    const bypass = (header(req.headers, 'x-amz-bypass-governance-retention') ?? '').toLowerCase() === 'true';
    for (const objectKey of keys) {
      const shown = objectKey.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
      if (options.meta) {
        const retention = await options.meta.loadRetention(bucket, objectKey);
        const held = retentionBlocks(retention, req.now ?? Date.now(), bypass) || (await options.meta.loadLegalHold(bucket, objectKey)) === 'ON';
        if (held) {
          rows.push(`<Error><Key>${shown}</Key><Code>AccessDenied</Code><Message>Object is retained or under a legal hold</Message></Error>`);
          continue;
        }
      }
      await backend.delete(bucket, objectKey);
      await options.meta?.remove(bucket, objectKey);
      if (!quiet) {
        rows.push(`<Deleted><Key>${shown}</Key></Deleted>`);
      }
    }
    return xml(200, `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${rows.join('')}</DeleteResult>`);
  }
  if (method === 'PUT') {
    await backend.createBucket(bucket);
    return empty(200);
  }
  if (method === 'DELETE') {
    const result = await backend.deleteBucket(bucket);
    if (result === 'missing') {
      return xml(404, errorXml('NoSuchBucket', 'The specified bucket does not exist', bucket));
    }
    if (result === 'notempty') {
      return xml(409, errorXml('BucketNotEmpty', 'The bucket you tried to delete is not empty', bucket));
    }
    return empty(204);
  }
  if (req.query.has('uploads') && method === 'GET') {
    const prefix = req.query.get('prefix') ?? '';
    const rows = (await uploads.store.list())
      .filter((upload) => upload.bucket === bucket && upload.key.startsWith(prefix))
      .map((upload) => {
        const key = upload.key.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
        return `<Upload><Key>${key}</Key><UploadId>${upload.id}</UploadId><Initiated>${new Date(upload.createdMs).toISOString()}</Initiated></Upload>`;
      });
    return xml(200, `<?xml version="1.0" encoding="UTF-8"?><ListMultipartUploadsResult><Bucket>${bucket}</Bucket>${rows.join('')}</ListMultipartUploadsResult>`);
  }
  if (method === 'GET' && req.path.endsWith('/') && configStore) {
    const website = (await configStore.get(bucket)).website;
    if (website) {
      const page = await backend.get(bucket, website.index);
      if (!page) {
        return xml(404, errorXml('NoSuchKey', 'The website index does not exist', `/${bucket}/${website.index}`));
      }
      return {
        status: 200,
        headers: { 'Content-Type': 'text/html', 'Content-Length': String(page.value.length) },
        body: page.value,
      };
    }
  }
  if (req.query.has('usage') && method === 'GET') {
    const listed = await backend.list(bucket, '', undefined, 10_000, '');
    const bytes = listed.objects.reduce((sum, object) => sum + object.size, 0);
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify({ objects: listed.objects.length, bytes })),
    };
  }
  if (method === 'GET' || method === 'HEAD') {
    if (!(await backend.bucketExists(bucket))) {
      return xml(404, errorXml('NoSuchBucket', 'The specified bucket does not exist', bucket));
    }
    if (method === 'HEAD') {
      return empty(200);
    }
    const prefix = req.query.get('prefix') ?? '';
    const startAfter = req.query.get('start-after') ?? req.query.get('continuation-token') ?? undefined;
    const maxKeys = Number(req.query.get('max-keys') ?? 1000);
    const delimiter = req.query.get('delimiter') ?? '';
    const listed = await backend.list(bucket, prefix, startAfter, maxKeys, delimiter);
    return xml(
      200,
      listObjectsXml({
        bucket,
        prefix,
        maxKeys,
        truncated: listed.truncated,
        objects: listed.objects,
        delimiter,
        prefixes: listed.prefixes,
        nextToken: listed.nextToken,
      }),
    );
  }
  return xml(405, errorXml('MethodNotAllowed', 'Method not allowed', bucket));
}

async function missingObject(backend: S3Backend, bucket: string, key: string, config: { website?: { error?: string } }): Promise<S3Response> {
  const errorKey = config.website?.error;
  if (errorKey && errorKey !== key) {
    const page = await backend.get(bucket, errorKey);
    if (page) {
      return {
        status: 404,
        headers: { 'Content-Type': 'text/html', 'Content-Length': String(page.value.length) },
        body: page.value,
      };
    }
  }
  return xml(404, errorXml('NoSuchKey', 'The specified key does not exist', `/${bucket}/${key}`));
}

async function maybeSeal(req: S3Request, body: Buffer, options: S3Options): Promise<Buffer> {
  const want = (header(req.headers, 'x-amz-server-side-encryption') ?? '').toUpperCase();
  if (!want) {
    return body;
  }
  if (want !== 'AES256') {
    throw new S3HttpError(400, 'InvalidArgument', 'Only AES256 server-side encryption is supported');
  }
  if (!options.sseSecret) {
    throw new S3HttpError(400, 'InvalidArgument', 'S3DFS_SSE_KEY is not configured');
  }
  return sealObject(sseKeyFromSecret(options.sseSecret), body);
}

async function presentObject(stored: Buffer, options: S3Options): Promise<Buffer> {
  if (options.sseSecret && isSealed(stored)) {
    return openObject(sseKeyFromSecret(options.sseSecret), stored);
  }
  return stored;
}

async function handleObject(
  method: string,
  bucket: string,
  key: string,
  req: S3Request,
  backend: S3Backend,
  uploads: MultipartUploads,
  options: S3Options,
): Promise<S3Response> {
  const config = options.config ? await options.config.get(bucket) : {};
  const versioning = config.versioning === 'Enabled' ? options.versions : undefined;
  const uploadId = req.query.get('uploadId');
  if (req.query.has('tagging') && options.meta) {
    if (method === 'GET') {
      return xml(200, tagsXml(await options.meta.loadTags(bucket, key)));
    }
    if (method === 'PUT') {
      await options.meta.saveTags(bucket, key, parseTags(req.body.toString('utf8')));
      return empty(200);
    }
    if (method === 'DELETE') {
      await options.meta.removeTags(bucket, key);
      return empty(204);
    }
  }
  if (req.query.has('retention') && options.meta) {
    if (method === 'GET') {
      const retention = await options.meta.loadRetention(bucket, key);
      if (!retention) {
        return xml(404, errorXml('NoSuchObjectLockConfiguration', 'The object has no retention', `/${bucket}/${key}`));
      }
      return xml(200, retentionXml(retention));
    }
    if (method === 'PUT') {
      await options.meta.saveRetention(bucket, key, parseRetention(req.body.toString('utf8')));
      return empty(200);
    }
  }
  if (req.query.has('legal-hold') && options.meta) {
    if (method === 'GET') {
      const status = (await options.meta.loadLegalHold(bucket, key)) ?? 'OFF';
      return xml(200, `<?xml version="1.0" encoding="UTF-8"?><LegalHold><Status>${status}</Status></LegalHold>`);
    }
    if (method === 'PUT') {
      await options.meta.saveLegalHold(bucket, key, parseLegalHold(req.body.toString('utf8')));
      return empty(200);
    }
  }
  if (req.query.has('versions') && method === 'GET' && options.versions) {
    const versions = await options.versions.list(bucket, key);
    return xml(200, listVersionsXml(bucket, key, versions));
  }
  if (req.query.has('uploads') && method === 'POST') {
    await backend.createBucket(bucket);
    const id = await uploads.create(bucket, key);
    return xml(200, initiateMultipartXml(bucket, key, id));
  }
  if (uploadId && method === 'PUT' && req.bodyStream && backend.putStream) {
    const partNumber = Number(req.query.get('partNumber'));
    const partKey = `$upload/${uploadId}/${partNumber}`;
    const stored = await backend.putStream(bucket, partKey, req.bodyStream);
    const etag = etagFromCrc(stored.crc);
    await uploads.notePart(bucket, key, uploadId, partNumber, { etag, size: stored.size, mtimeMs: Date.now() });
    return empty(200, { ETag: etag });
  }
  if (uploadId && method === 'PUT' && header(req.headers, 'x-amz-copy-source')) {
    const partNumber = Number(req.query.get('partNumber'));
    const decoded = decodeURIComponent((header(req.headers, 'x-amz-copy-source') ?? '').replace(/^\//, ''));
    const slash = decoded.indexOf('/');
    if (slash <= 0) {
      return xml(400, errorXml('InvalidArgument', 'x-amz-copy-source must be bucket/key'));
    }
    const src = await backend.get(decoded.slice(0, slash), decoded.slice(slash + 1));
    if (!src) {
      return xml(404, errorXml('NoSuchKey', 'The specified key does not exist', decoded));
    }
    const failed = copySourcePrecondition(src, req.headers, decoded);
    if (failed) {
      return failed;
    }
    const range = parseByteRange(header(req.headers, 'x-amz-copy-source-range'), src.value.length);
    if (range.kind === 'unsatisfiable') {
      return empty(416);
    }
    const value = range.kind === 'partial' ? Buffer.from(src.value.subarray(range.start, range.end + 1)) : src.value;
    const etag = await uploads.putPart(bucket, key, uploadId, partNumber, value);
    return xml(
      200,
      `<?xml version="1.0" encoding="UTF-8"?><CopyPartResult><LastModified>${new Date(src.mtimeMs).toISOString()}</LastModified><ETag>${etag}</ETag></CopyPartResult>`,
    );
  }
  if (uploadId && method === 'PUT') {
    const partNumber = Number(req.query.get('partNumber'));
    const body = payload(req);
    assertObjectSize(body, options.maxObjectBytes);
    const etag = await uploads.putPart(bucket, key, uploadId, partNumber, body);
    return empty(200, { ETag: etag });
  }
  if (uploadId && method === 'POST') {
    const declared = parseCompleteParts(payload(req).toString('utf8'));
    if (backend.putStream && !header(req.headers, 'x-amz-server-side-encryption')) {
      await backend.putStream(bucket, key, uploads.eachPart(bucket, key, uploadId, declared));
    } else {
      const body = await uploads.complete(bucket, key, uploadId, declared);
      await backend.put(bucket, key, await maybeSeal(req, body, options));
    }
    await uploads.finish(uploadId);
    const meta = await backend.head(bucket, key);
    const etag = meta ? etagFromCrc(meta.crc) : `"00000000"`;
    const host = req.host && req.host.length > 0 ? req.host : 'localhost';
    return xml(
      200,
      completeMultipartXml({
        location: `http://${host}/${bucket}/${encodeURI(key)}`,
        bucket,
        key,
        etag,
      }),
      { ETag: etag },
    );
  }
  if (uploadId && method === 'GET') {
    const parts = await uploads.listParts(bucket, key, uploadId);
    return xml(200, listPartsXml(bucket, key, uploadId, parts));
  }
  if (uploadId && method === 'DELETE') {
    if (!(await uploads.abort(bucket, key, uploadId))) {
      return xml(404, errorXml('NoSuchUpload', 'The specified multipart upload does not exist', `/${bucket}/${key}`));
    }
    return empty(204);
  }

  if (method === 'PUT') {
    const copySource = header(req.headers, 'x-amz-copy-source');
    if (copySource) {
      const decoded = decodeURIComponent(copySource.replace(/^\//, ''));
      const slash = decoded.indexOf('/');
      if (slash <= 0) {
        return xml(400, errorXml('InvalidArgument', 'x-amz-copy-source must be bucket/key'));
      }
      const srcBucket = decoded.slice(0, slash);
      const srcKey = decoded.slice(slash + 1);
      const srcMeta = await backend.head(srcBucket, srcKey);
      if (!srcMeta) {
        return xml(404, errorXml('NoSuchKey', 'The specified key does not exist', copySource));
      }
      const sourceFailed = copySourcePrecondition(srcMeta, req.headers, copySource);
      if (sourceFailed) {
        return sourceFailed;
      }
      const metaDirective = (header(req.headers, 'x-amz-metadata-directive') ?? 'COPY').toUpperCase();
      const tagDirective = (header(req.headers, 'x-amz-tagging-directive') ?? 'COPY').toUpperCase();
      if (metaDirective !== 'COPY' && metaDirective !== 'REPLACE') {
        return xml(400, errorXml('InvalidArgument', 'x-amz-metadata-directive must be COPY or REPLACE'));
      }
      if (tagDirective !== 'COPY' && tagDirective !== 'REPLACE') {
        return xml(400, errorXml('InvalidArgument', 'x-amz-tagging-directive must be COPY or REPLACE'));
      }
      await backend.createBucket(bucket);
      const rangeHeader = header(req.headers, 'x-amz-copy-source-range');
      const shared = !rangeHeader && backend.shareCopy ? await backend.shareCopy(srcBucket, srcKey, bucket, key) : false;
      if (!shared) {
        const src = await backend.get(srcBucket, srcKey);
        if (!src) {
          return xml(404, errorXml('NoSuchKey', 'The specified key does not exist', copySource));
        }
        const range = parseByteRange(rangeHeader, src.value.length);
        if (range.kind === 'unsatisfiable') {
          return empty(416);
        }
        const value = range.kind === 'partial' ? Buffer.from(src.value.subarray(range.start, range.end + 1)) : src.value;
        await backend.put(bucket, key, value);
      }
      if (options.meta) {
        const savedMeta = metaDirective === 'REPLACE' ? userMeta(req.headers) : await options.meta.load(srcBucket, srcKey);
        const savedTags = tagDirective === 'REPLACE' ? parseAmzTagging(header(req.headers, 'x-amz-tagging')) : await options.meta.loadTags(srcBucket, srcKey);
        await options.meta.save(bucket, key, savedMeta);
        await options.meta.saveTags(bucket, key, savedTags);
      }
      const meta = await backend.head(bucket, key);
      const etag = meta ? etagFromCrc(meta.crc) : '"00000000"';
      await postEvent(config, { event: 's3:ObjectCreated:Copy', bucket, key }, options.fetchImpl);
      return xml(200, copyObjectXml(etag, new Date(meta?.mtimeMs ?? Date.now()).toISOString()), etagHeaders(meta?.crc ?? 0));
    }
    await backend.createBucket(bucket);
    if (req.bodyStream && header(req.headers, 'x-amz-server-side-encryption')) {
      return xml(400, errorXml('InvalidRequest', 'Server-side encryption is limited to the 1 MiB upload buffer'));
    }
    if (req.bodyStream && backend.putStream) {
      const failed = await assertPreconditions(backend, bucket, key, req.headers, 'PUT');
      if (failed) {
        return failed;
      }
      const versionId = versioning ? randomBytes(8).toString('hex') : undefined;
      const extra = versionId ? `$ver/${encodeURIComponent(key)}/${versionId}` : undefined;
      const md5 = header(req.headers, 'content-md5');
      const stream = md5 ? matchMd5(req.bodyStream, md5) : req.bodyStream;
      const stored = await backend.putStream(bucket, key, stream, extra);
      if (versioning && versionId) {
        await versioning.put(bucket, key, { id: versionId, body: null, external: true, deleteMarker: false, mtimeMs: Date.now() });
      }
      const headers: Record<string, string> = etagHeaders(stored.crc);
      if (versionId) {
        headers['x-amz-version-id'] = versionId;
      }
      if (options.meta) {
        await options.meta.save(bucket, key, userMeta(req.headers));
      }
      await postEvent(config, { event: 's3:ObjectCreated:Put', bucket, key, size: stored.size }, options.fetchImpl);
      return empty(200, headers);
    }
    const plain = payload(req);
    assertObjectSize(plain, options.maxObjectBytes);
    const failed = await assertPreconditions(backend, bucket, key, req.headers, 'PUT');
    if (failed) {
      return failed;
    }
    const stored = await maybeSeal(req, plain, options);
    await backend.put(bucket, key, stored);
    let versionId: string | undefined;
    if (versioning) {
      versionId = randomBytes(8).toString('hex');
      await versioning.put(bucket, key, { id: versionId, body: stored, deleteMarker: false, mtimeMs: Date.now() });
    }
    const meta = await backend.head(bucket, key);
    const headers: Record<string, string> = meta ? etagHeaders(meta.crc) : {};
    if (header(req.headers, 'x-amz-server-side-encryption')) {
      headers['x-amz-server-side-encryption'] = 'AES256';
    }
    if (versionId) {
      headers['x-amz-version-id'] = versionId;
    }
    if (options.meta) {
      await options.meta.save(bucket, key, userMeta(req.headers));
    }
    await postEvent(config, { event: 's3:ObjectCreated:Put', bucket, key, size: plain.length }, options.fetchImpl);
    return empty(200, headers);
  }
  if (method === 'GET' || method === 'HEAD') {
    const redirect = websiteRedirect(config.website, key);
    if (redirect) {
      return empty(redirect.code, { Location: `/${bucket}/${redirect.key}` });
    }
  }
  if ((method === 'GET' || method === 'HEAD') && key.endsWith('/') && config.website) {
    const page = await backend.get(bucket, `${key}${config.website.index}`);
    if (!page) {
      return xml(404, errorXml('NoSuchKey', 'The website index does not exist', `/${bucket}/${key}${config.website.index}`));
    }
    return {
      status: 200,
      headers: { 'Content-Type': 'text/html', 'Content-Length': String(page.value.length) },
      body: method === 'HEAD' ? Buffer.alloc(0) : page.value,
    };
  }
  if (method === 'GET' || method === 'HEAD') {
    const versionId = req.query.get('versionId');
    if (versionId && options.versions) {
      const version = await options.versions.get(bucket, key, versionId);
      if (!version || version.deleteMarker || !version.body) {
        return xml(404, errorXml('NoSuchKey', 'The specified key does not exist', `/${bucket}/${key}`));
      }
      const body = method === 'HEAD' ? Buffer.alloc(0) : await presentObject(version.body, options);
      return {
        status: 200,
        headers: {
          ...etagHeaders(0),
          'x-amz-version-id': versionId,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(version.body.length),
        },
        body,
      };
    }
    const meta = await backend.head(bucket, key);
    if (!meta) {
      return missingObject(backend, bucket, key, config);
    }
    const failed = await assertPreconditions(backend, bucket, key, req.headers, method);
    if (failed) {
      return failed;
    }
    const saved = options.meta ? await options.meta.load(bucket, key) : {};
    const range = parseByteRange(header(req.headers, 'range'), meta.size);
    const headers: Record<string, string> = {
      'Accept-Ranges': 'bytes',
      ...etagHeaders(meta.crc),
      ...checksumHeaders(meta.crc, req.headers),
      'Last-Modified': new Date(meta.mtimeMs).toUTCString(),
      'Content-Type': 'application/octet-stream',
      ...saved,
    };
    if (range.kind === 'unsatisfiable') {
      headers['Content-Range'] = `bytes */${meta.size}`;
      return empty(416, headers);
    }
    const partial = range.kind === 'partial';
    const start = partial ? range.start : 0;
    const end = partial ? range.end : Math.max(0, meta.size - 1);
    const length = meta.size === 0 ? 0 : end - start + 1;
    if (partial) {
      headers['Content-Range'] = `bytes ${start}-${end}/${meta.size}`;
    }
    headers['Content-Length'] = String(length);
    if (method === 'HEAD') {
      return empty(partial ? 206 : 200, headers);
    }
    const obj = partial ? await backend.getRange(bucket, key, start, end) : await backend.get(bucket, key);
    if (!obj) {
      return xml(404, errorXml('NoSuchKey', 'The specified key does not exist', `/${bucket}/${key}`));
    }
    const body = partial ? obj.value : await presentObject(obj.value, options);
    if (!partial && body.length !== obj.value.length) {
      headers['Content-Length'] = String(body.length);
    }
    return { status: partial ? 206 : 200, headers, body };
  }
  if (method === 'DELETE') {
    const failed = await assertPreconditions(backend, bucket, key, req.headers, 'DELETE');
    if (failed) {
      return failed;
    }
    if (options.meta) {
      const retention = await options.meta.loadRetention(bucket, key);
      const bypass = (header(req.headers, 'x-amz-bypass-governance-retention') ?? '').toLowerCase() === 'true';
      if (retentionBlocks(retention, req.now ?? Date.now(), bypass)) {
        return xml(403, errorXml('AccessDenied', 'Object is retained until the configured date', `/${bucket}/${key}`));
      }
      if ((await options.meta.loadLegalHold(bucket, key)) === 'ON') {
        return xml(403, errorXml('AccessDenied', 'Object is under a legal hold', `/${bucket}/${key}`));
      }
    }
    if (versioning) {
      const versionId = randomBytes(8).toString('hex');
      await versioning.put(bucket, key, { id: versionId, body: null, deleteMarker: true, mtimeMs: Date.now() });
      await backend.delete(bucket, key);
      await options.meta?.remove(bucket, key);
      await postEvent(config, { event: 's3:ObjectRemoved:DeleteMarkerCreated', bucket, key }, options.fetchImpl);
      return empty(204, { 'x-amz-version-id': versionId, 'x-amz-delete-marker': 'true' });
    }
    await backend.delete(bucket, key);
    await options.meta?.remove(bucket, key);
    await postEvent(config, { event: 's3:ObjectRemoved:Delete', bucket, key }, options.fetchImpl);
    return empty(204);
  }
  return xml(405, errorXml('MethodNotAllowed', 'Method not allowed', `/${bucket}/${key}`));
}
