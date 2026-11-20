import { parseByteRange, type ObjectValue } from '@s3dfs/control';
import { AwsChunkError, objectBytes } from './aws-chunked';
import { MultipartUploads, S3HttpError, parseCompleteParts } from './multipart';
import {
  completeMultipartXml,
  errorXml,
  etagFromCrc,
  initiateMultipartXml,
  listBucketsXml,
  listObjectsXml,
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
  return objectBytes({
    encoding: header(req.headers, 'content-encoding'),
    contentSha: header(req.headers, 'x-amz-content-sha256'),
    decodedLength: header(req.headers, 'x-amz-decoded-content-length'),
    body: req.body,
  });
}

export async function handleS3(req: S3Request, backend: S3Backend, uploads: MultipartUploads): Promise<S3Response> {
  try {
    const { bucket, key } = parsePath(req.path);
    const method = req.method.toUpperCase();
    if (!bucket) {
      if (method === 'GET') {
        return xml(200, listBucketsXml(await backend.listBuckets()));
      }
      return xml(405, errorXml('MethodNotAllowed', 'Method not allowed'));
    }
    if (key === undefined) {
      return await handleBucket(method, bucket, req, backend);
    }
    return await handleObject(method, bucket, key, req, backend, uploads);
  } catch (err) {
    if (err instanceof S3HttpError) {
      return xml(err.status, errorXml(err.code, err.message));
    }
    if (err instanceof AwsChunkError) {
      return xml(400, errorXml('InvalidRequest', err.message));
    }
    throw err;
  }
}

async function handleBucket(method: string, bucket: string, req: S3Request, backend: S3Backend): Promise<S3Response> {
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

async function handleObject(
  method: string,
  bucket: string,
  key: string,
  req: S3Request,
  backend: S3Backend,
  uploads: MultipartUploads,
): Promise<S3Response> {
  const uploadId = req.query.get('uploadId');
  if (req.query.has('uploads') && method === 'POST') {
    await backend.createBucket(bucket);
    const id = uploads.create(bucket, key);
    return xml(200, initiateMultipartXml(bucket, key, id));
  }
  if (uploadId && method === 'PUT') {
    const partNumber = Number(req.query.get('partNumber'));
    const etag = uploads.putPart(bucket, key, uploadId, partNumber, payload(req));
    return empty(200, { ETag: etag });
  }
  if (uploadId && method === 'POST') {
    const body = uploads.complete(bucket, key, uploadId, parseCompleteParts(payload(req).toString('utf8')));
    await backend.put(bucket, key, body);
    uploads.finish(uploadId);
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
  if (uploadId && method === 'DELETE') {
    if (!uploads.abort(bucket, key, uploadId)) {
      return xml(404, errorXml('NoSuchUpload', 'The specified multipart upload does not exist', `/${bucket}/${key}`));
    }
    return empty(204);
  }

  if (method === 'PUT') {
    await backend.createBucket(bucket);
    const body = payload(req);
    await backend.put(bucket, key, body);
    const meta = await backend.head(bucket, key);
    const headers: Record<string, string> = {};
    if (meta) {
      headers.ETag = etagFromCrc(meta.crc);
    }
    return empty(200, headers);
  }
  if (method === 'GET' || method === 'HEAD') {
    const meta = await backend.head(bucket, key);
    if (!meta) {
      return xml(404, errorXml('NoSuchKey', 'The specified key does not exist', `/${bucket}/${key}`));
    }
    const range = parseByteRange(header(req.headers, 'range'), meta.size);
    const headers: Record<string, string> = {
      'Accept-Ranges': 'bytes',
      ETag: etagFromCrc(meta.crc),
      'Last-Modified': new Date(meta.mtimeMs).toUTCString(),
      'Content-Type': 'application/octet-stream',
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
    return { status: partial ? 206 : 200, headers, body: obj.value };
  }
  if (method === 'DELETE') {
    await backend.delete(bucket, key);
    return empty(204);
  }
  return xml(405, errorXml('MethodNotAllowed', 'Method not allowed', `/${bucket}/${key}`));
}
