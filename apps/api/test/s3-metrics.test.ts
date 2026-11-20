import { describe, expect, test } from 'bun:test';
import { RequestMetrics } from '../src/s3/metrics';

describe('request metrics', () => {
  test('counts responses by status', () => {
    const metrics = new RequestMetrics();
    metrics.record(200);
    metrics.record(200);
    metrics.record(404);
    expect(metrics.snapshot()).toMatchObject({ total: 3, byStatus: { 200: 2, 404: 1 } });
  });
});
