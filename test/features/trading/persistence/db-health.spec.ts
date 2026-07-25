import { describe, it, expect, vi, type Mock } from 'vitest';
import { DbHealthIndicator } from '../../../../src/database/db-health.indicator';
import type { Pool, PoolClient } from 'pg';

function makeMockPool(queryBehavior: 'ok' | 'throw'): { pool: Pool; release: Mock } {
  const release = vi.fn();
  const client = {
    query:
      queryBehavior === 'ok'
        ? vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] })
        : vi.fn().mockRejectedValue(new Error('connection refused')),
    release,
  } as unknown as PoolClient;

  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;

  return { pool, release };
}

describe('DbHealthIndicator', () => {
  it('returns status up with detail not_configured when pool is null', async () => {
    const indicator = new DbHealthIndicator(null);
    const result = await indicator.check('database');
    expect(result['database']?.status).toBe('up');
    expect(result['database']?.detail).toBe('not_configured');
  });

  it('returns status up when SELECT 1 succeeds', async () => {
    const { pool } = makeMockPool('ok');
    const indicator = new DbHealthIndicator(pool);
    const result = await indicator.check('database');
    expect(result['database']?.status).toBe('up');
    expect(result['database']?.detail).toBeUndefined();
  });

  it('returns status down with message when query throws', async () => {
    const { pool } = makeMockPool('throw');
    const indicator = new DbHealthIndicator(pool);
    const result = await indicator.check('database');
    expect(result['database']?.status).toBe('down');
    expect(typeof result['database']?.message).toBe('string');
    expect(result['database']?.message).toMatch(/connection refused/i);
  });

  it('uses the provided key as the result property name', async () => {
    const indicator = new DbHealthIndicator(null);
    const result = await indicator.check('my-db');
    expect(result['my-db']).toBeDefined();
    expect(result['my-db']?.status).toBe('up');
  });

  it('releases the pool client after a successful query', async () => {
    const { pool, release } = makeMockPool('ok');
    const indicator = new DbHealthIndicator(pool);
    await indicator.check('database');
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases the pool client even when query throws', async () => {
    const { pool, release } = makeMockPool('throw');
    const indicator = new DbHealthIndicator(pool);
    await indicator.check('database');
    expect(release).toHaveBeenCalledOnce();
  });
});
