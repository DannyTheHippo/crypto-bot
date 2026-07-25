import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  main,
  partitionRows,
  assertApplySetSafe,
  resolveRow,
  MAX_APPLY_ROWS,
} from '../../../scripts/resolve-stale-orders.mjs';

// resolve-stale-orders.mjs mutates the production orders table (backlog #25) — this spec pins the
// safety rails offline: dry-run writes nothing, testnet rows are untouchable, the blast-radius
// clamp refuses unexpected apply sets, and an applied row produces exactly one idempotent audit
// INSERT plus one guarded UPDATE inside a transaction. Same standalone-.mjs pattern as
// arm-ceremony.spec.mjs (scripts/** live outside the tsconfig graph).

const FIXTURE_ROWS = [
  { intent_id: 'oo-tat-open', client_order_id: 'cbp-live-1', mode: 'live', state: 'ACKED' },
  { intent_id: 'intent-oe-1', client_order_id: 'cbp-paper-1', mode: 'paper', state: 'NEW' },
];

function fakePool(rows) {
  const queries = [];
  const clientQueries = [];
  const client = {
    query: (text, params) => {
      clientQueries.push([text, params]);
      return Promise.resolve({ rows: [] });
    },
    release: vi.fn(),
  };
  const pool = {
    query: (text, params) => {
      queries.push([text, params]);
      if (text.includes('terminal_at IS NULL AND mode')) {
        return Promise.resolve({ rows: [{ unresolved: 0 }] });
      }
      return Promise.resolve({ rows });
    },
    connect: () => Promise.resolve(client),
    end: vi.fn(),
  };
  return { pool, queries, clientQueries, client };
}

describe('resolve-stale-orders partitioning + clamp', () => {
  it('partitions testnet rows away from the live/paper apply set', () => {
    const rows = [...FIXTURE_ROWS, { intent_id: 't1', mode: 'testnet', state: 'ACKED' }];
    const { testnetRows, applyRows } = partitionRows(rows);
    expect(testnetRows.map((r) => r.intent_id)).toEqual(['t1']);
    expect(applyRows.map((r) => r.intent_id)).toEqual(['oo-tat-open', 'intent-oe-1']);
  });

  it('accepts the expected two-fixture apply set', () => {
    expect(() => assertApplySetSafe(FIXTURE_ROWS)).not.toThrow();
  });

  it(`refuses an apply set larger than ${MAX_APPLY_ROWS} rows (blast-radius clamp)`, () => {
    const three = [
      ...FIXTURE_ROWS,
      { intent_id: 'x', client_order_id: 'c', mode: 'paper', state: 'NEW' },
    ];
    expect(() => assertApplySetSafe(three)).toThrow(/expected at most 2/);
  });

  it('refuses a state outside the fixture profile — a genuinely open order is never terminalized', () => {
    expect(() =>
      assertApplySetSafe([
        { intent_id: 'p1', client_order_id: 'c', mode: 'paper', state: 'PARTIALLY_FILLED' },
      ]),
    ).toThrow(/unexpected state 'PARTIALLY_FILLED'/);
  });
});

describe('resolve-stale-orders main', () => {
  const originalUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  it('fails closed without DATABASE_URL', async () => {
    delete process.env.DATABASE_URL;
    expect(await main([])).toBe(1);
  });

  it('dry-run (default) SELECTs but never connects a write client', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    const { pool, queries, clientQueries } = fakePool(FIXTURE_ROWS);
    const code = await main([], () => pool);
    expect(code).toBe(0);
    expect(queries).toHaveLength(1); // the SELECT only — no post-check, no writes
    expect(queries[0][0]).toContain('SELECT');
    expect(clientQueries).toHaveLength(0);
    expect(pool.end).toHaveBeenCalled();
  });

  it('--apply resolves each live/paper row and runs the post-check; testnet rows never reach the client', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    const rows = [
      ...FIXTURE_ROWS,
      { intent_id: 't1', client_order_id: 'c', mode: 'testnet', state: 'ACKED' },
    ];
    const { pool, clientQueries } = fakePool(rows);
    const code = await main(['--apply'], () => pool);
    expect(code).toBe(0);
    // Per applied row: BEGIN, audit INSERT, orders UPDATE, COMMIT — 2 rows ⇒ 8 client queries.
    expect(clientQueries).toHaveLength(8);
    const texts = clientQueries.map(([text]) => text);
    expect(texts.filter((t) => t === 'BEGIN')).toHaveLength(2);
    expect(texts.filter((t) => t === 'COMMIT')).toHaveLength(2);
    const inserts = clientQueries.filter(([text]) =>
      text.includes('INSERT INTO public.order_events'),
    );
    const updates = clientQueries.filter(([text]) => text.includes('UPDATE public.orders'));
    expect(inserts).toHaveLength(2);
    expect(updates).toHaveLength(2);
    // Idempotency rails: conflict-safe audit insert, terminal_at-guarded update, no testnet id.
    expect(inserts[0][0]).toContain('ON CONFLICT (order_id, dedupe_key) DO NOTHING');
    expect(updates[0][0]).toContain('terminal_at IS NULL');
    expect(JSON.stringify(clientQueries)).not.toContain('"t1"');
    // The audit payload records the prior state; seq rides as a decimal string (pg bigint).
    expect(inserts[0][1][3]).toContain('"priorState":"ACKED"');
    expect(inserts[0][1][4]).toMatch(/^\d+$/);
  });

  it('--apply aborts on a clamp violation before any write', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    const three = [
      ...FIXTURE_ROWS,
      { intent_id: 'x', client_order_id: 'c', mode: 'paper', state: 'NEW' },
    ];
    const { pool, clientQueries } = fakePool(three);
    await expect(main(['--apply'], () => pool)).rejects.toThrow(/expected at most 2/);
    expect(clientQueries).toHaveLength(0);
    expect(pool.end).toHaveBeenCalled();
  });

  it('resolveRow rolls the transaction back when a write fails', async () => {
    const calls = [];
    const client = {
      query: (text, params) => {
        calls.push([text, params]);
        if (text.includes('UPDATE public.orders')) return Promise.reject(new Error('db down'));
        return Promise.resolve({ rows: [] });
      },
    };
    await expect(resolveRow(client, FIXTURE_ROWS[0], 123)).rejects.toThrow('db down');
    expect(calls.map(([text]) => text)).toContain('ROLLBACK');
    expect(calls.map(([text]) => text)).not.toContain('COMMIT');
  });
});
