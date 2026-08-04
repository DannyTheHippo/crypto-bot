import { describe, it, expect } from 'vitest';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PassiveBenchmarkRepository } from '../../../../src/database/repositories/trading/passive-benchmark.repository';
import * as schema from '../../../../src/database/schemas/trading';

// Same minimal chain fake as funding-events-repository.spec.ts / config-snapshot-repository-
// upsert.spec.ts (repositories are otherwise exercised only by the env-gated test/db Postgres
// suite): a select()-chain object whose from/where/orderBy/leftJoin all return itself and which is
// thenable, resolving the next canned row-array off a FIFO queue. select() is called exactly once
// per query (closeAtOrAfter, closeAtOrBefore, then fillsThrough for the single-symbol universe this
// suite uses), so the queue order is [entry rows, exit rows, fills rows].
function fakeDb(rowSets: readonly unknown[][]) {
  let cursor = 0;
  const select = () => {
    const rows = rowSets[cursor] ?? [];
    cursor++;
    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      leftJoin: () => chain,
      then: (resolve: (v: unknown) => void) => resolve(rows),
    };
    return chain;
  };
  const db = { select };
  return db as unknown as NodePgDatabase<typeof schema>;
}

const FROM_MS = 1_000_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TO_MS = FROM_MS + 11 * DAY_MS;
const MAX_ENDPOINT_STALENESS_MS = 2 * 60 * 60 * 1000;

// A constant $100 gross exposure across the whole window: one BUY fill strictly before fromMs opens
// the position, nothing closes it before toMs — timeWeightedAvgGrossExposure then folds to exactly
// 100 for the entire [fromMs, toMs] span (domain/trading/risk/gross-exposure.ts).
const HEALTHY_FILLS = [
  { symbol: 'BTC/USDT', side: 'BUY', qty: '1', price: '100', executedAt: FROM_MS - 1_000 },
];

describe('PassiveBenchmarkRepository — endpoint staleness bound (defect 141)', () => {
  it('still computes when both endpoints are inside the staleness bound — the fix is a no-op on a healthy grid', async () => {
    const repo = new PassiveBenchmarkRepository(
      fakeDb([
        [{ close: '100', eventTime: FROM_MS + 15 * 60 * 1000 }], // entry: 15 min stale
        [{ close: '110', eventTime: TO_MS - 60 * 1000 }], // exit: 1 min stale
        HEALTHY_FILLS,
      ]),
      ['BTC/USDT'],
    );
    // basketReturn = (110-100)/100 = 0.1; avgGrossExposureUsd = 100 ⇒ quote = 100 × 0.1 = 10.
    await expect(repo.passivePnlQuote(FROM_MS, TO_MS)).resolves.toBe('10');
  });

  it('refuses rather than anchoring to a far-away bar when the ENTRY endpoint falls MAX_ENDPOINT_STALENESS_MS+1 ms past fromMs', async () => {
    // HEALTHY_FILLS as the third rowset: without it, select() #3 (fillsThrough) starves to []
    // (fakeDb's rowSets[cursor] ?? []), timeWeightedAvgGrossExposure([], ...) folds to Decimal(0),
    // and the SAME 'Infinity' comes back via the unrelated zero-exposure branch — the assertion
    // would pass whether or not the staleness guard below exists at all.
    const repo = new PassiveBenchmarkRepository(
      fakeDb([
        [{ close: '100', eventTime: FROM_MS + MAX_ENDPOINT_STALENESS_MS + 1 }],
        [{ close: '110', eventTime: TO_MS - 60 * 1000 }],
        HEALTHY_FILLS,
      ]),
      ['BTC/USDT'],
    );
    await expect(repo.passivePnlQuote(FROM_MS, TO_MS)).resolves.toBe('Infinity');
  });

  it('refuses rather than anchoring to a far-away bar when the EXIT endpoint falls MAX_ENDPOINT_STALENESS_MS+1 ms before toMs', async () => {
    // See the entry-stale case above for why HEALTHY_FILLS must be supplied here too.
    const repo = new PassiveBenchmarkRepository(
      fakeDb([
        [{ close: '100', eventTime: FROM_MS + 15 * 60 * 1000 }],
        [{ close: '110', eventTime: TO_MS - MAX_ENDPOINT_STALENESS_MS - 1 }],
        HEALTHY_FILLS,
      ]),
      ['BTC/USDT'],
    );
    await expect(repo.passivePnlQuote(FROM_MS, TO_MS)).resolves.toBe('Infinity');
  });

  it('refuses on the real deployed 46.75h hole (2026-07-25T10:45Z -> 2026-07-27T09:30Z) — the literal reproduction of the defect', async () => {
    // Real shape from the live journal (verified by direct SQL 2026-08-04): every one of the 40
    // configured symbols carries a >=43h hole ending 2026-07-27T09:30:00Z, and a real testnet fill
    // (fill_id 137) sits inside it. Anchoring the entry lookup at the hole's own start and letting
    // the nearest bar land 46.75h later is the exact mechanism this bound exists to refuse.
    const holeStartMs = Date.parse('2026-07-25T10:45:00.000Z');
    const holeEndMs = Date.parse('2026-07-27T09:30:00.000Z');
    const toMs = holeStartMs + 11 * DAY_MS;
    const repo = new PassiveBenchmarkRepository(
      fakeDb([
        [{ close: '100', eventTime: holeEndMs }], // entry: 46.75h after holeStartMs
        [{ close: '110', eventTime: toMs - 60 * 1000 }],
        HEALTHY_FILLS,
      ]),
      ['BTC/USDT'],
    );
    await expect(repo.passivePnlQuote(holeStartMs, toMs)).resolves.toBe('Infinity');
  });

  it('accepts a bar exactly AT the bound (strictly-greater-than, not >=)', async () => {
    const repo = new PassiveBenchmarkRepository(
      fakeDb([
        [{ close: '100', eventTime: FROM_MS + MAX_ENDPOINT_STALENESS_MS }],
        [{ close: '110', eventTime: TO_MS - 60 * 1000 }],
        HEALTHY_FILLS,
      ]),
      ['BTC/USDT'],
    );
    await expect(repo.passivePnlQuote(FROM_MS, TO_MS)).resolves.toBe('10');
  });
});
