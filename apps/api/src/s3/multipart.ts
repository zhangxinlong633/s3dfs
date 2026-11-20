import { randomBytes } from 'node:crypto';
import { crc32 } from '@s3dfs/control';

export class S3HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'S3HttpError';
  }
}

export function etagOf(body: Buffer): string {
  return `"${crc32(body).toString(16).padStart(8, '0')}"`;
}

export interface StoredPart {
  body: Buffer;
  etag: string;
  mtimeMs: number;
}

export interface StoredUpload {
  bucket: string;
  key: string;
  createdMs: number;
  parts: Map<number, StoredPart>;
}

/** Manifest and part bytes. A process restart keeps the upload when the store does. */
export interface UploadStore {
  create(id: string, bucket: string, key: string, createdMs: number): Promise<void>;
  putPart(id: string, partNumber: number, part: StoredPart): Promise<void>;
  get(id: string): Promise<StoredUpload | null>;
  remove(id: string): Promise<void>;
  list(): Promise<{ id: string; bucket: string; key: string; createdMs: number }[]>;
}

export class MemoryUploadStore implements UploadStore {
  readonly uploads = new Map<string, StoredUpload>();

  async create(id: string, bucket: string, key: string, createdMs: number): Promise<void> {
    this.uploads.set(id, { bucket, key, createdMs, parts: new Map() });
  }

  async putPart(id: string, partNumber: number, part: StoredPart): Promise<void> {
    const upload = this.uploads.get(id);
    if (!upload) {
      return;
    }
    upload.parts.set(partNumber, { body: Buffer.from(part.body), etag: part.etag, mtimeMs: part.mtimeMs });
  }

  async get(id: string): Promise<StoredUpload | null> {
    return this.uploads.get(id) ?? null;
  }

  async remove(id: string): Promise<void> {
    this.uploads.delete(id);
  }

  async list(): Promise<{ id: string; bucket: string; key: string; createdMs: number }[]> {
    return [...this.uploads.entries()].map(([id, upload]) => ({
      id,
      bucket: upload.bucket,
      key: upload.key,
      createdMs: upload.createdMs,
    }));
  }
}

export interface CompletePart {
  partNumber: number;
  etag: string;
}

export class MultipartUploads {
  constructor(readonly store: UploadStore = new MemoryUploadStore()) {}

  async create(bucket: string, key: string): Promise<string> {
    const id = randomBytes(16).toString('hex');
    await this.store.create(id, bucket, key, Date.now());
    return id;
  }

  async putPart(bucket: string, key: string, uploadId: string, partNumber: number, body: Buffer): Promise<string> {
    const upload = await this.require(bucket, key, uploadId);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
      throw new S3HttpError(400, 'InvalidArgument', 'Part number must be between 1 and 10000');
    }
    const etag = etagOf(body);
    await this.store.putPart(uploadId, partNumber, { body, etag, mtimeMs: Date.now() });
    upload.parts.set(partNumber, { body, etag, mtimeMs: Date.now() });
    return etag;
  }

  async listParts(bucket: string, key: string, uploadId: string): Promise<{ partNumber: number; etag: string; size: number }[]> {
    const upload = await this.require(bucket, key, uploadId);
    return [...upload.parts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([partNumber, part]) => ({ partNumber, etag: part.etag, size: part.body.length }));
  }

  /** Concatenate the declared parts. The session stays until `finish`, so a failed Put can be retried. */
  async complete(bucket: string, key: string, uploadId: string, declared: CompletePart[]): Promise<Buffer> {
    const upload = await this.require(bucket, key, uploadId);
    if (declared.length === 0) {
      throw new S3HttpError(400, 'MalformedXML', 'CompleteMultipartUpload has no parts');
    }
    for (let i = 1; i < declared.length; i++) {
      if (declared[i]!.partNumber <= declared[i - 1]!.partNumber) {
        throw new S3HttpError(400, 'InvalidPartOrder', 'Part numbers must be in ascending order');
      }
    }
    const bufs: Buffer[] = [];
    for (const part of declared) {
      const got = upload.parts.get(part.partNumber);
      if (!got || stripEtag(got.etag) !== stripEtag(part.etag)) {
        throw new S3HttpError(400, 'InvalidPart', `Part ${part.partNumber} is missing or the ETag does not match`);
      }
      bufs.push(got.body);
    }
    return Buffer.concat(bufs);
  }

  async finish(uploadId: string): Promise<void> {
    await this.store.remove(uploadId);
  }

  async abort(bucket: string, key: string, uploadId: string): Promise<boolean> {
    const upload = await this.store.get(uploadId);
    if (!upload || upload.bucket !== bucket || upload.key !== key) {
      return false;
    }
    await this.store.remove(uploadId);
    return true;
  }

  private async require(bucket: string, key: string, uploadId: string): Promise<StoredUpload> {
    const upload = await this.store.get(uploadId);
    if (!upload || upload.bucket !== bucket || upload.key !== key) {
      throw new S3HttpError(404, 'NoSuchUpload', 'The specified multipart upload does not exist');
    }
    return upload;
  }
}

function stripEtag(etag: string): string {
  return etag.trim().replaceAll('"', '').toLowerCase();
}

export function parseCompleteParts(xml: string): CompletePart[] {
  const parts: CompletePart[] = [];
  for (const block of xml.matchAll(/<Part\b[^>]*>([\s\S]*?)<\/Part>/gi)) {
    const body = block[1] ?? '';
    const num = /<PartNumber>\s*(\d+)\s*<\/PartNumber>/i.exec(body);
    const etag = /<ETag>\s*([^<]+)\s*<\/ETag>/i.exec(body);
    if (!num?.[1] || !etag?.[1]) {
      throw new S3HttpError(400, 'MalformedXML', 'Each Part needs PartNumber and ETag');
    }
    parts.push({ partNumber: Number(num[1]), etag: etag[1].trim() });
  }
  if (parts.length === 0) {
    throw new S3HttpError(400, 'MalformedXML', 'CompleteMultipartUpload has no parts');
  }
  return parts;
}
