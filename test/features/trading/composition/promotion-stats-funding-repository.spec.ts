import { describe, it, expect } from 'vitest';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PromotionStatsRepository } from '../../../../src/database/repositories/trading/promotion-stats.repository';
import * as schema from '../../../../src/database/schemas/trading';

// Same minimal select()-chain fake as passive-benchmark-staleness.spec.ts / funding-events-
// repository.spec.ts: proves the TS-side shape (netQuote/hasRows/ingestedThroughMs derivation) the
// asOfMs cap depends on. NOTE (defect 143, scope): this lane's declared paths do not include
// test/db/persistence.spec.ts, so the SQL-predicate-level proof that `created_at <= asOfMs` actually
// narrows the row set on a real Postgres instance is NOT covered here — that is the correction's
// "Test 1" and is a follow-up for whichever lane/owner covers test/db.
function fakeDb(row: { net: string | null; ingestedThrough: Date | null }) {
  const chain = {
    from: () => chain,
    where: () => chain,
    then: (resolve: (v: unknown) => void) => resolve([row]),
  };
  const db = { select: () => chain };
  return db as unknown as NodePgDatabase<typeof schema>;
}

describe('PromotionStatsRepository.fundingNetForMode — asOfMs watermark (defect 143)', () => {
  it('returns the exact netQuote and the watermark from a populated row', async () => {
    const repo = new PromotionStatsRepository(
      fakeDb({ net: '-0.78038125000000000000', ingestedThrough: new Date(1_700_000_000_000) }),
    );
    const result = await repo.fundingNetForMode('testnet', 9_000_000);
    expect(result.netQuote).toBe('-0.78038125000000000000');
    expect(result.hasRows).toBe(true);
    expect(result.ingestedThroughMs).toBe(1_700_000_000_000);
  });

  it('a SQL NULL aggregate (no matching rows) returns the zero/false/null triple, never a thrown error', async () => {
    const repo = new PromotionStatsRepository(fakeDb({ net: null, ingestedThrough: null }));
    const result = await repo.fundingNetForMode('testnet', 9_000_000);
    expect(result.netQuote).toBe('0');
    expect(result.hasRows).toBe(false);
    expect(result.ingestedThroughMs).toBeNull();
  });

  it('accepts an asOfMs third argument and still derives the row shape correctly (SQL-predicate narrowing is proved against real Postgres in test/db, out of this lane)', async () => {
    const repo = new PromotionStatsRepository(
      fakeDb({ net: '0.00558693000000000000', ingestedThrough: new Date(1_700_000_100_000) }),
    );
    const result = await repo.fundingNetForMode('testnet', 9_000_000, 1_700_000_050_000);
    expect(result.netQuote).toBe('0.00558693000000000000');
    expect(result.hasRows).toBe(true);
    expect(result.ingestedThroughMs).toBe(1_700_000_100_000);
  });
});
