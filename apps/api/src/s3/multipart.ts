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

interface Upload {
  bucket: string;
  key: string;
  parts: Map<number, { body: Buffer; etag: string }>;
}

export interface CompletePart {
  partNumber: number;
  etag: string;
}

/** In-process multipart sessions. Parts live until complete or abort; an API restart drops them. */
export class MultipartUploads {
  private readonly uploads = new Map<string, Upload>();

  create(bucket: string, key: string): string {
    const id = randomBytes(16).toString('hex');
    this.uploads.set(id, { bucket, key, parts: new Map() });
    return id;
  }

  putPart(bucket: string, key: string, uploadId: string, partNumber: number, body: Buffer): string {
    const upload = this.require(bucket, key, uploadId);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
      throw new S3HttpError(400, 'InvalidArgument', 'Part number must be between 1 and 10000');
    }
    const etag = etagOf(body);
    upload.parts.set(partNumber, { body: Buffer.from(body), etag });
    return etag;
  }

  /** Concatenate the declared parts. The session stays until `finish`, so a failed Put can be retried. */
  complete(bucket: string, key: string, uploadId: string, declared: CompletePart[]): Buffer {
    const upload = this.require(bucket, key, uploadId);
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

  finish(uploadId: string): void {
    this.uploads.delete(uploadId);
  }

  abort(bucket: string, key: string, uploadId: string): boolean {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.bucket !== bucket || upload.key !== key) {
      return false;
    }
    this.uploads.delete(uploadId);
    return true;
  }

  private require(bucket: string, key: string, uploadId: string): Upload {
    const upload = this.uploads.get(uploadId);
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
