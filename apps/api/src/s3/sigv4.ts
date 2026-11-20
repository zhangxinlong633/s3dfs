import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { S3HttpError } from './multipart';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface SigV4Identity {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SignedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  now?: number;
}

function header(headers: SignedRequest['headers'], name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return raw;
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function canonicalUri(path: string): string {
  if (!path || path === '/') {
    return '/';
  }
  const parts = path.split('/').map((part) => {
    try {
      return encodeRfc3986(decodeURIComponent(part));
    } catch {
      return encodeRfc3986(part);
    }
  });
  return parts.join('/');
}

export function canonicalQuery(query: URLSearchParams): string {
  const pairs: [string, string][] = [];
  for (const [key, value] of query.entries()) {
    if (key.toLowerCase() === 'x-amz-signature') {
      continue;
    }
    pairs.push([encodeRfc3986(key), encodeRfc3986(value)]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function canonicalHeaders(headers: SignedRequest['headers'], signed: string[]): string {
  const lines = signed.map((name) => {
    const value = (header(headers, name) ?? '').trim().replace(/\s+/g, ' ');
    return `${name}:${value}\n`;
  });
  return lines.join('');
}

export function payloadHash(req: SignedRequest): string {
  const declared = header(req.headers, 'x-amz-content-sha256');
  if (declared && declared.length > 0) {
    return declared;
  }
  if (req.query.get('X-Amz-Algorithm') || req.query.get('X-Amz-Signature')) {
    return 'UNSIGNED-PAYLOAD';
  }
  return sha256Hex(req.body);
}

export function stringToSign(req: SignedRequest, amzDate: string, scope: string): string {
  const signed = (header(req.headers, 'authorization') ? signedHeaderNames(req) : querySignedHeaders(req)).split(';');
  const canonical = [
    req.method.toUpperCase(),
    canonicalUri(req.path),
    canonicalQuery(req.query),
    canonicalHeaders(req.headers, signed),
    signed.join(';'),
    payloadHash(req),
  ].join('\n');
  return `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(canonical)}`;
}

function signedHeaderNames(req: SignedRequest): string {
  const auth = header(req.headers, 'authorization') ?? '';
  const match = /SignedHeaders=([^,\s]+)/.exec(auth);
  if (!match?.[1]) {
    throw new S3HttpError(400, 'AuthorizationHeaderMalformed', 'SignedHeaders is missing');
  }
  return match[1];
}

function querySignedHeaders(req: SignedRequest): string {
  return req.query.get('X-Amz-SignedHeaders') ?? req.query.get('x-amz-signedheaders') ?? '';
}

function parseAmzDate(value: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) {
    throw new S3HttpError(403, 'AccessDenied', 'X-Amz-Date is not a valid ISO8601 timestamp');
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
}

function credentialParts(credential: string): { accessKeyId: string; date: string; region: string; service: string } {
  const parts = credential.split('/');
  if (parts.length !== 5 || parts[4] !== 'aws4_request' || !parts[0] || !parts[1] || !parts[2] || !parts[3]) {
    throw new S3HttpError(400, 'AuthorizationHeaderMalformed', 'Credential scope is malformed');
  }
  if (parts[3] !== 's3') {
    throw new S3HttpError(403, 'AccessDenied', 'Credential service must be s3');
  }
  return { accessKeyId: parts[0], date: parts[1], region: parts[2], service: parts[3] };
}

export function signRequest(secret: string, req: SignedRequest, amzDate: string, scope: string): string {
  const [, date, region, service] = scope.split('/');
  if (!date || !region || !service) {
    throw new S3HttpError(400, 'AuthorizationHeaderMalformed', 'Credential scope is malformed');
  }
  return hmac(signingKey(secret, date, region, service), stringToSign(req, amzDate, scope)).toString('hex');
}

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a.toLowerCase());
  const right = Buffer.from(b.toLowerCase());
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Verify header or query-string SigV4. Streaming chunk signatures are checked separately. */
export function verifySigV4(req: SignedRequest, identity: SigV4Identity): { amzDate: string; scope: string; signature: string } {
  const now = req.now ?? Date.now();
  const auth = header(req.headers, 'authorization');
  let credential = '';
  let signature = '';
  let amzDate = header(req.headers, 'x-amz-date') ?? '';
  if (auth) {
    if (!auth.startsWith('AWS4-HMAC-SHA256 ')) {
      throw new S3HttpError(400, 'AuthorizationHeaderMalformed', 'Only AWS4-HMAC-SHA256 is supported');
    }
    const cred = /Credential=([^,\s]+)/.exec(auth);
    const sig = /Signature=([0-9a-fA-F]+)/.exec(auth);
    if (!cred?.[1] || !sig?.[1]) {
      throw new S3HttpError(400, 'AuthorizationHeaderMalformed', 'Credential or Signature is missing');
    }
    credential = cred[1];
    signature = sig[1];
    if (!amzDate) {
      const date = header(req.headers, 'date');
      if (!date) {
        throw new S3HttpError(403, 'AccessDenied', 'Missing X-Amz-Date');
      }
      amzDate = new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    }
  } else if (req.query.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256') {
    credential = req.query.get('X-Amz-Credential') ?? '';
    signature = req.query.get('X-Amz-Signature') ?? '';
    amzDate = req.query.get('X-Amz-Date') ?? '';
    if (!credential || !signature || !amzDate) {
      throw new S3HttpError(403, 'AccessDenied', 'Presigned request is missing credential fields');
    }
  } else {
    throw new S3HttpError(403, 'AccessDenied', 'Missing Authentication Token');
  }

  const parsed = credentialParts(credential);
  if (parsed.accessKeyId !== identity.accessKeyId) {
    throw new S3HttpError(403, 'InvalidAccessKeyId', 'The access key id does not match');
  }
  if (!amzDate.startsWith(parsed.date)) {
    throw new S3HttpError(403, 'AccessDenied', 'X-Amz-Date does not match the credential date');
  }
  const signedAt = parseAmzDate(amzDate);
  const expires = Number(req.query.get('X-Amz-Expires') ?? '');
  if (req.query.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256') {
    if (!Number.isInteger(expires) || expires < 1 || expires > 604800) {
      throw new S3HttpError(403, 'AccessDenied', 'X-Amz-Expires is invalid');
    }
    if (now > signedAt + expires * 1000) {
      throw new S3HttpError(403, 'AccessDenied', 'Request has expired');
    }
  } else if (Math.abs(now - signedAt) > 15 * 60 * 1000) {
    throw new S3HttpError(403, 'RequestTimeTooSkewed', 'The difference between the request time and the server time is too large');
  }

  const scope = `${parsed.date}/${parsed.region}/${parsed.service}/aws4_request`;
  const expected = signRequest(identity.secretAccessKey, req, amzDate, scope);
  if (!sameHex(expected, signature)) {
    throw new S3HttpError(403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided');
  }
  return { amzDate, scope, signature };
}

const EMPTY_HASH = EMPTY_SHA256;

/** Previous signature for the first chunk is the seed signature from Authorization. */
export function chunkSignature(secret: string, scope: string, amzDate: string, previous: string, chunk: Buffer): string {
  const [, date, region, service] = scope.split('/');
  const stringToSign = [
    'AWS4-HMAC-SHA256-PAYLOAD',
    amzDate,
    scope,
    previous,
    EMPTY_HASH,
    sha256Hex(chunk),
  ].join('\n');
  return hmac(signingKey(secret, date!, region!, service!), stringToSign).toString('hex');
}

export function verifyChunkSignatures(
  body: Buffer,
  secret: string,
  scope: string,
  amzDate: string,
  seed: string,
): void {
  let previous = seed;
  let offset = 0;
  while (offset < body.length) {
    const nl = body.indexOf('\n', offset);
    if (nl < 0) {
      throw new S3HttpError(400, 'InvalidRequest', 'aws-chunked body is truncated');
    }
    const line = body.subarray(offset, nl).toString('utf8').replace(/\r$/, '');
    const semi = line.indexOf(';');
    const sizeHex = (semi >= 0 ? line.slice(0, semi) : line).trim();
    const size = Number.parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size < 0) {
      throw new S3HttpError(400, 'InvalidRequest', 'aws-chunked size is invalid');
    }
    const sig = /chunk-signature=([0-9a-fA-F]{64})/.exec(line)?.[1];
    const dataStart = nl + 1;
    const dataEnd = dataStart + size;
    if (dataEnd + 2 > body.length) {
      throw new S3HttpError(400, 'InvalidRequest', 'aws-chunked body is truncated');
    }
    const chunk = body.subarray(dataStart, dataEnd);
    if (sig) {
      const expected = chunkSignature(secret, scope, amzDate, previous, chunk);
      if (!sameHex(expected, sig)) {
        throw new S3HttpError(403, 'SignatureDoesNotMatch', 'Chunk signature does not match');
      }
      previous = sig.toLowerCase();
    }
    offset = dataEnd + 2;
    if (size === 0) {
      return;
    }
  }
}
