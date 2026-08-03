import { describe, it, expect } from 'vitest';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { FundingEventsRepository } from '../../../../src/database/repositories/trading/funding-events.repository';
import { InMemoryFundingSink } from '../../../../src/features/venue/exchange/in-memory-funding-sink';
import { buildFundingSink } from '../../../../src/features/trading/composition/exchange-adapters.module';
import * as schema from '../../../../src/database/schemas/trading';
import { PersistenceNotConfiguredError } from '../../../../src/database/repositories/common/persistence-guard';

// Same minimal insert()-chain fake as config-snapshot-repository-upsert.spec.ts (repositories are
// otherwise exercised only by the env-gated test/db Postgres suite): captures the values handed to
// drizzle without touching a real database.
function fakeDb() {
  const calls: { table: unknown; values: Record<string, unknown> }[] = [];
  const db = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        calls.push({ table, values });
        return Promise.resolve();
      },
    }),
  };
  return { db: db as unknown as NodePgDatabase<typeof schema>, calls };
}

const ROW = {
  mode: 'paper',
  strategyId: 'agentic',
  venue: 'binanceusdm',
  symbol: 'BTC/USDT:USDT',
  // 18-dp money strings: a float round trip would round every one of these.
  fundingRate: '0.000123456789012345',
  markPrice: '61234.123456789012345678',
  signedQty: '-0.001234567890123456',
  paymentQuote: '-0.000000009321654321',
  fundingTime: 1_752_000_000_000,
} as const;

describe('FundingEventsRepository.record (the writer funding_events never had)', () => {
  it('inserts into funding_events with every money column passed through as its EXACT string', async () => {
    const { db, calls } = fakeDb();
    await new FundingEventsRepository(db).record(ROW);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.table).toBe(schema.fundingEvents);
    expect(calls[0]!.values).toEqual({
      strategyId: 'agentic',
      venue: 'binanceusdm',
      symbol: 'BTC/USDT:USDT',
      fundingRate: '0.000123456789012345',
      markPrice: '61234.123456789012345678',
      signedQty: '-0.001234567890123456',
      paymentQuote: '-0.000000009321654321',
      fundingTime: new Date(1_752_000_000_000),
      mode: 'paper',
    });
  });

  it('exposes no update/delete surface — funding_events is append-only (hard rule 6)', () => {
    const repo = new FundingEventsRepository(fakeDb().db) as unknown as Record<string, unknown>;
    for (const forbidden of ['update', 'delete', 'upsert']) {
      expect(repo[forbidden]).toBeUndefined();
    }
  });

  it('throws rather than silently dropping the row when no database is configured', async () => {
    await expect(new FundingEventsRepository(null).record(ROW)).rejects.toBeInstanceOf(
      PersistenceNotConfiguredError,
    );
  });
});

describe('buildFundingSink (FUNDING_SINK binding selection)', () => {
  it('binds the DB-backed writer when a database handle is present', () => {
    // isTestEnv() reads NODE_ENV/CI at call time; the suite runs under NODE_ENV=test, so the
    // production branch is reached by clearing both for the duration of this assertion.
    const nodeEnv = process.env['NODE_ENV'];
    const ci = process.env['CI'];
    delete process.env['NODE_ENV'];
    delete process.env['CI'];
    try {
      expect(buildFundingSink(fakeDb().db)).toBeInstanceOf(FundingEventsRepository);
    } finally {
      if (nodeEnv !== undefined) process.env['NODE_ENV'] = nodeEnv;
      if (ci !== undefined) process.env['CI'] = ci;
    }
  });

  it('keeps the in-memory sink for the no-DB substrate and under test/ci', () => {
    expect(buildFundingSink(null)).toBeInstanceOf(InMemoryFundingSink);
    expect(buildFundingSink(fakeDb().db)).toBeInstanceOf(InMemoryFundingSink);
  });
});
