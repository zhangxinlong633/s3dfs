import { describe, expect, test } from 'bun:test';
import { handleS3, type S3Backend } from '../src/s3/handle';
import { IamDirectory, type IamKv } from '../src/s3/iam';
import { signRequest } from '../src/s3/sigv4';

class MemKv implements IamKv {
  readonly map = new Map<string, Buffer>();
  async put(key: string, value: Buffer): Promise<void> {
    this.map.set(key, Buffer.from(value));
  }
  async get(key: string) {
    const value = this.map.get(key);
    return value ? { value } : null;
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
  async scan(prefix: string) {
    return [...this.map.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

class MemBackend implements S3Backend {
  objects = new Map<string, Buffer>();
  async createBucket(): Promise<void> {}
  async bucketExists(): Promise<boolean> {
    return true;
  }
  async deleteBucket(): Promise<'ok'> {
    return 'ok';
  }
  async listBuckets() {
    return [];
  }
  async list() {
    return { objects: [], truncated: false };
  }
  async put(): Promise<void> {}
  async head() {
    return { size: 1, crc: 1, mtimeMs: 1 };
  }
  async get() {
    return null;
  }
  async delete(): Promise<boolean> {
    return true;
  }
}

function signedPut(path: string, body: Buffer, account: { accessKeyId: string; secretAccessKey: string }, now: number) {
  const amzDate = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const scope = `${amzDate.slice(0, 8)}/us-east-1/s3/aws4_request`;
  const headers: Record<string, string> = {
    host: '127.0.0.1:9000',
    'x-amz-date': amzDate,
    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
    authorization: `AWS4-HMAC-SHA256 Credential=${account.accessKeyId}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=00`,
  };
  const signature = signRequest(account.secretAccessKey, { method: 'PUT', path, query: new URLSearchParams(), headers, body, now }, amzDate, scope);
  headers.authorization = headers.authorization.replace('Signature=00', `Signature=${signature}`);
  return { method: 'PUT', path, query: new URLSearchParams(), headers, body, host: '127.0.0.1:9000', now };
}

const allowLogs = [{ effect: 'Allow' as const, action: 's3:PutObject', resource: 'logs/*' }];
const allowOther = [{ effect: 'Allow' as const, action: 's3:PutObject', resource: 'other/*' }];

describe('iam ledger', () => {
  test('a user policy allows one bucket and rejects another', async () => {
    const iam = new IamDirectory(new MemKv());
    await iam.apply({ op: 'putPolicy', name: 'logs-write', statements: allowLogs });
    await iam.apply({ op: 'putUser', accessKeyId: 'ALICE', secretAccessKey: 'alice-secret', status: 'enabled', groups: [], policies: ['logs-write'] });
    const backend = new MemBackend();
    const now = Date.UTC(2026, 10, 21, 8, 0, 0);
    const ok = await handleS3(signedPut('/logs/a.txt', Buffer.from('a'), { accessKeyId: 'ALICE', secretAccessKey: 'alice-secret' }, now), backend, undefined as never, { iam, now });
    const denied = await handleS3(signedPut('/other/a.txt', Buffer.from('a'), { accessKeyId: 'ALICE', secretAccessKey: 'alice-secret' }, now), backend, undefined as never, { iam, now });
    expect(ok.status).toBe(200);
    expect(denied.status).toBe(403);
  });

  test('a group policy allows a user who has no policy of their own', async () => {
    const iam = new IamDirectory(new MemKv());
    await iam.apply({ op: 'putPolicy', name: 'logs-write', statements: allowLogs });
    await iam.apply({ op: 'putUser', accessKeyId: 'ALICE', secretAccessKey: 'alice-secret', status: 'enabled', groups: [], policies: [] });
    await iam.apply({ op: 'putGroup', name: 'writers', members: ['ALICE'], policies: ['logs-write'] });
    const backend = new MemBackend();
    const now = Date.UTC(2026, 10, 21, 8, 0, 0);
    const ok = await handleS3(signedPut('/logs/a.txt', Buffer.from('a'), { accessKeyId: 'ALICE', secretAccessKey: 'alice-secret' }, now), backend, undefined as never, { iam, now });
    expect(ok.status).toBe(200);
  });

  test('a deny wins over a group allow', async () => {
    const iam = new IamDirectory(new MemKv());
    await iam.apply({ op: 'putPolicy', name: 'logs-write', statements: allowLogs });
    await iam.apply({ op: 'putPolicy', name: 'logs-deny', statements: [{ effect: 'Deny', action: 's3:PutObject', resource: 'logs/*' }] });
    await iam.apply({ op: 'putUser', accessKeyId: 'ALICE', secretAccessKey: 'alice-secret', status: 'enabled', groups: [], policies: ['logs-deny'] });
    await iam.apply({ op: 'putGroup', name: 'writers', members: ['ALICE'], policies: ['logs-write'] });
    const backend = new MemBackend();
    const now = Date.UTC(2026, 10, 21, 8, 0, 0);
    const denied = await handleS3(signedPut('/logs/a.txt', Buffer.from('a'), { accessKeyId: 'ALICE', secretAccessKey: 'alice-secret' }, now), backend, undefined as never, { iam, now });
    expect(denied.status).toBe(403);
  });

  test('a disabled user is rejected', async () => {
    const iam = new IamDirectory(new MemKv());
    await iam.apply({ op: 'putPolicy', name: 'logs-write', statements: allowLogs });
    await iam.apply({ op: 'putUser', accessKeyId: 'ALICE', secretAccessKey: 'alice-secret', status: 'enabled', groups: [], policies: ['logs-write'] });
    const backend = new MemBackend();
    const now = Date.UTC(2026, 10, 21, 8, 0, 0);
    const before = await handleS3(signedPut('/logs/a.txt', Buffer.from('a'), { accessKeyId: 'ALICE', secretAccessKey: 'alice-secret' }, now), backend, undefined as never, { iam, now });
    expect(before.status).toBe(200);
    await iam.apply({ op: 'setUserStatus', accessKeyId: 'ALICE', status: 'disabled' });
    const after = await handleS3(signedPut('/logs/b.txt', Buffer.from('b'), { accessKeyId: 'ALICE', secretAccessKey: 'alice-secret' }, now), backend, undefined as never, { iam, now });
    expect(after.status).toBe(403);
  });

  test('a service account cannot exceed its parent', async () => {
    const iam = new IamDirectory(new MemKv());
    await iam.apply({ op: 'putPolicy', name: 'logs-write', statements: allowLogs });
    await iam.apply({ op: 'putPolicy', name: 'other-write', statements: allowOther });
    await iam.apply({ op: 'putUser', accessKeyId: 'ALICE', secretAccessKey: 'alice-secret', status: 'enabled', groups: [], policies: ['logs-write', 'other-write'] });
    const created = await iam.apply({ op: 'createServiceAccount', parent: 'ALICE', policies: ['other-write'] });
    const backend = new MemBackend();
    const now = Date.UTC(2026, 10, 21, 8, 0, 0);
    const parent = await handleS3(signedPut('/logs/a.txt', Buffer.from('a'), { accessKeyId: 'ALICE', secretAccessKey: 'alice-secret' }, now), backend, undefined as never, { iam, now });
    const child = await handleS3(signedPut('/logs/b.txt', Buffer.from('b'), created, now), backend, undefined as never, { iam, now });
    expect(parent.status).toBe(200);
    expect(child.status).toBe(403);
  });

  test('assumeRole works until the token expires', async () => {
    const iam = new IamDirectory(new MemKv());
    await iam.apply({ op: 'putPolicy', name: 'logs-write', statements: allowLogs });
    await iam.apply({ op: 'putUser', accessKeyId: 'ALICE', secretAccessKey: 'alice-secret', status: 'enabled', groups: [], policies: ['logs-write'] });
    const now = Date.UTC(2026, 10, 21, 8, 0, 0);
    const token = await iam.apply({ op: 'assumeRole', parent: 'ALICE', durationSeconds: 60, now });
    const backend = new MemBackend();
    const ok = await handleS3(signedPut('/logs/a.txt', Buffer.from('a'), token, now + 1000), backend, undefined as never, { iam, now: now + 1000 });
    const expired = await handleS3(signedPut('/logs/b.txt', Buffer.from('b'), token, now + 61_000), backend, undefined as never, { iam, now: now + 61_000 });
    expect(ok.status).toBe(200);
    expect(expired.status).toBe(403);
  });

  test('the root key ignores the ledger', async () => {
    const iam = new IamDirectory(new MemKv());
    const backend = new MemBackend();
    const now = Date.UTC(2026, 10, 21, 8, 0, 0);
    const root = { accessKeyId: 'ROOT', secretAccessKey: 'root-secret' };
    const response = await handleS3(signedPut('/logs/a.txt', Buffer.from('a'), root, now), backend, undefined as never, { iam, credentials: root, now });
    expect(response.status).toBe(200);
  });
});
