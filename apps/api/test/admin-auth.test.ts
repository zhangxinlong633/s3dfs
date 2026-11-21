import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { adminWriteAllowed } from '../src/s3/admin-auth';
import { signRequest } from '../src/s3/sigv4';

const now = Date.parse('2026-11-20T12:00:30Z');

function signedFlush(env: { S3DFS_ACCESS_KEY: string; S3DFS_SECRET_KEY: string }): Record<string, string> {
  const amzDate = '20261120T120000Z';
  const scope = '20261120/us-east-1/s3/aws4_request';
  const body = Buffer.alloc(0);
  const headers: Record<string, string> = {
    host: '127.0.0.1:9000',
    'x-amz-date': amzDate,
    'x-amz-content-sha256': createHash('sha256').update(body).digest('hex'),
    authorization: `AWS4-HMAC-SHA256 Credential=${env.S3DFS_ACCESS_KEY}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=00`,
  };
  const signature = signRequest(env.S3DFS_SECRET_KEY, {
    method: 'POST',
    path: '/_s3dfs/flush',
    query: new URLSearchParams(),
    headers,
    body,
    now,
  }, amzDate, scope);
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${env.S3DFS_ACCESS_KEY}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`;
  return headers;
}

describe('admin writes', () => {
  test('allows an open dev port, a patrol token, or SigV4, and rejects a bare request once either is set', () => {
    expect(adminWriteAllowed({ headers: {}, env: {}, path: '/_s3dfs/flush' })).toBe(true);

    expect(adminWriteAllowed({
      headers: { 'x-s3dfs-patrol-token': 'patrol' },
      env: { S3DFS_PATROL_TOKEN: 'patrol' },
      path: '/_s3dfs/flush',
    })).toBe(true);
    expect(adminWriteAllowed({
      headers: {},
      env: { S3DFS_PATROL_TOKEN: 'patrol' },
      path: '/_s3dfs/flush',
    })).toBe(false);

    const env = { S3DFS_ACCESS_KEY: 'AKID', S3DFS_SECRET_KEY: 'secret' };
    expect(adminWriteAllowed({ headers: signedFlush(env), env, path: '/_s3dfs/flush', now })).toBe(true);
    expect(adminWriteAllowed({ headers: {}, env, path: '/_s3dfs/flush', now })).toBe(false);
  });
});
