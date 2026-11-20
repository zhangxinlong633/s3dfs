import { describe, expect, test } from 'bun:test';
import { assertProductionAuth } from '../src/s3/auth-gate';

describe('production auth', () => {
  test('strict layout refuses to serve when either key is missing', () => {
    expect(() => assertProductionAuth({ S3DFS_STRICT_LAYOUT: '1' })).toThrow(/S3DFS_ACCESS_KEY/);
    expect(() => assertProductionAuth({ S3DFS_ACCESS_KEY: 'ak', S3DFS_SECRET_KEY: 'sk' })).not.toThrow();
    expect(() => assertProductionAuth({ S3DFS_STRICT_LAYOUT: '0' })).not.toThrow();
  });
});
