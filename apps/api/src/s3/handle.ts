import { createHash, randomBytes } from 'node:crypto';
import { parseByteRange, type ObjectValue } from '@s3dfs/control';
import { AwsChunkError, objectBytes } from './aws-chunked';
import { MultipartUploads, S3HttpError, parseCompleteParts } from './multipart';
import {
  actionFor,
  checkPolicy,
  isSealed,
  openObject,
  parseLifecycle,
  parseVersioningStatus,
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
  return body;
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
  return req.query.has('policy') || req.query.has('versioning') || req.query.has('lifecycle') || req.query.has('notification');
}

function etagHeaders(crc: number): Record<string, string> {
  return { ETag: etagFromCrc(crc), 'x-s3dfs-etag-algorithm': 'crc32' };
}

function stripEtag(value: string): string {
  return value.trim().replaceAll('"', '').toLowerCase();
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
  if (!match && !none) {
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
    if (key === undefined) {
      return await handleBucket(method, bucket, req, backend, uploads, options);
    }
    return await handleObject(method, bucket, key, req, backend, uploads, options);
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
      config.policy = (parsed.Statement ?? []).map((s) => ({
        effect: s.Effect,
        action: s.Action,
        resource: s.Resource,
      }));
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
  if (req.query.has('notification') && configStore) {
    if (method === 'PUT') {
      const parsed = JSON.parse(req.body.toString('utf8')) as { url?: string };
      const config = await configStore.get(bucket);
      config.notifyUrl = parsed.url;
      await configStore.put(bucket, config);
      return empty(200);
    }
  }
  if (req.query.has('lifecycle') && method === 'POST' && configStore) {
    const { applyLifecycle } = await import('./product');
    const config = await configStore.get(bucket);
    const listed = await backend.list(bucket, '', undefined, 10_000, '');
    const result = await applyLifecycle({
      objects: listed.objects.map((o) => ({ bucket, key: o.key, mtimeMs: o.mtimeMs })),
      rules: config.lifecycle ?? [],
      now: req.now ?? Date.now(),
      deleteObject: (b, k) => backend.delete(b, k).then(() => undefined),
      uploads: (await uploads.store.list()).filter((u) => u.bucket === bucket),
      abortUpload: (b, k, id) => uploads.abort(b, k, id).then(() => undefined),
    });
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(result)),
    };
  }
  if (req.query.has('delete') && method === 'POST') {
    const body = req.body.toString('utf8');
    const keys = [...body.matchAll(/<Key>\s*([^<]*?)\s*<\/Key>/gi)].map((match) => match[1] ?? '').filter((key) => key.length > 0);
    const quiet = /<Quiet>\s*true\s*<\/Quiet>/i.test(body);
    const rows: string[] = [];
    for (const objectKey of keys) {
      await backend.delete(bucket, objectKey);
      await options.meta?.remove(bucket, objectKey);
      if (!quiet) {
        rows.push(`<Deleted><Key>${objectKey.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</Key></Deleted>`);
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
  if (req.query.has('versions') && method === 'GET' && options.versions) {
    const versions = await options.versions.list(bucket, key);
    return xml(200, listVersionsXml(bucket, key, versions));
  }
  if (req.query.has('uploads') && method === 'POST') {
    await backend.createBucket(bucket);
    const id = await uploads.create(bucket, key);
    return xml(200, initiateMultipartXml(bucket, key, id));
  }
  if (uploadId && method === 'PUT') {
    const partNumber = Number(req.query.get('partNumber'));
    const body = payload(req);
    assertObjectSize(body, options.maxObjectBytes);
    const etag = await uploads.putPart(bucket, key, uploadId, partNumber, body);
    return empty(200, { ETag: etag });
  }
  if (uploadId && method === 'POST') {
    const body = await uploads.complete(bucket, key, uploadId, parseCompleteParts(payload(req).toString('utf8')));
    await backend.put(bucket, key, await maybeSeal(req, body, options));
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
      const src = await backend.get(decoded.slice(0, slash), decoded.slice(slash + 1));
      if (!src) {
        return xml(404, errorXml('NoSuchKey', 'The specified key does not exist', copySource));
      }
      await backend.createBucket(bucket);
      await backend.put(bucket, key, src.value);
      if (options.meta) {
        await options.meta.save(bucket, key, await options.meta.load(decoded.slice(0, slash), decoded.slice(slash + 1)));
      }
      const meta = await backend.head(bucket, key);
      const etag = meta ? etagFromCrc(meta.crc) : '"00000000"';
      await postEvent(config.notifyUrl, { event: 's3:ObjectCreated:Copy', bucket, key }, options.fetchImpl);
      return xml(200, copyObjectXml(etag, new Date(meta?.mtimeMs ?? Date.now()).toISOString()), etagHeaders(meta?.crc ?? 0));
    }
    await backend.createBucket(bucket);
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
    await postEvent(config.notifyUrl, { event: 's3:ObjectCreated:Put', bucket, key, size: plain.length }, options.fetchImpl);
    return empty(200, headers);
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
      return xml(404, errorXml('NoSuchKey', 'The specified key does not exist', `/${bucket}/${key}`));
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
    if (versioning) {
      const versionId = randomBytes(8).toString('hex');
      await versioning.put(bucket, key, { id: versionId, body: null, deleteMarker: true, mtimeMs: Date.now() });
      await backend.delete(bucket, key);
      await options.meta?.remove(bucket, key);
      await postEvent(config.notifyUrl, { event: 's3:ObjectRemoved:DeleteMarkerCreated', bucket, key }, options.fetchImpl);
      return empty(204, { 'x-amz-version-id': versionId, 'x-amz-delete-marker': 'true' });
    }
    await backend.delete(bucket, key);
    await options.meta?.remove(bucket, key);
    await postEvent(config.notifyUrl, { event: 's3:ObjectRemoved:Delete', bucket, key }, options.fetchImpl);
    return empty(204);
  }
  return xml(405, errorXml('MethodNotAllowed', 'Method not allowed', `/${bucket}/${key}`));
}
