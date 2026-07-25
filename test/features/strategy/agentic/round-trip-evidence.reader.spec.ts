import { describe, it, expect } from 'vitest';
import { RoundTripEvidenceReader } from '../../../../src/features/strategy/agentic/round-trip-evidence.reader';
import type { PromotionFillRow, PromotionStatsPort } from '../../../../src/ports/trading/promotion';

function fill(over: Partial<PromotionFillRow> = {}): PromotionFillRow {
  return {
    strategyId: 'agentic-1',
    symbol: 'BTC/USDT',
    side: 'BUY',
    qty: '1',
    price: '100',
    fee: null,
    feeAsset: null,
    executedAt: 1_000,
    refPrice: null,
    ...over,
  };
}

function statsOf(fills: PromotionFillRow[]): PromotionStatsPort {
  return {
    fillsForMode: () => Promise.resolve(fills),
    llmTokenTotals: () => Promise.reject(new Error('unused')),
  };
}

describe('RoundTripEvidenceReader', () => {
  it('maps closed cycles to decimal-string evidence rows (exact strings)', async () => {
    const reader = new RoundTripEvidenceReader(
      statsOf([
        fill({
          qty: '1',
          price: '100',
          fee: '0.1',
          feeAsset: 'USDT',
          refPrice: '99.5',
          executedAt: 1_000,
        }),
        fill({
          side: 'SELL',
          qty: '1',
          price: '110',
          fee: '0.11',
          feeAsset: 'USDT',
          refPrice: '110.2',
          executedAt: 61_000,
        }),
      ]),
      '5',
    );
    const rows = await reader.recentRoundTrips(10);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.symbol).toBe('BTC/USDT');
    expect(r.openedAt).toBe(1_000);
    expect(r.closedAt).toBe(61_000);
    expect(r.holdingMs).toBe(60_000);
    expect(r.entryVwap).toBe('100');
    expect(r.exitVwap).toBe('110');
    expect(r.boughtQty).toBe('1');
    expect(r.realizedPnl).toBe('10');
    expect(r.feesQuote).toBe('0.21');
    expect(r.netPnl).toBe('9.79');
    // BUY +50.25 bps adverse (100 vs 99.5), SELL +18.15 bps adverse (110 vs 110.2) → mean ≈ 34.20
    expect(r.meanSlippageBps).toBe('34.20');
  });

  it('returns only the most recent N cycles and preserves null VWAP/slippage fields', async () => {
    const fills: PromotionFillRow[] = [];
    for (let i = 0; i < 3; i += 1) {
      fills.push(
        fill({ qty: '1', price: '100', executedAt: i * 10 + 1 }),
        fill({ side: 'SELL', qty: '1', price: `${101 + i}`, executedAt: i * 10 + 2 }),
      );
    }
    const reader = new RoundTripEvidenceReader(statsOf(fills), '5');
    const rows = await reader.recentRoundTrips(2);
    expect(rows.map((r) => r.realizedPnl)).toEqual(['2', '3']); // the LAST two cycles
    expect(rows[0]!.meanSlippageBps).toBeNull();
  });

  it('reflectionSeed(strategyId) scopes the since-counts but keeps closedTradesTotal lane-wide', async () => {
    const fills: PromotionFillRow[] = [
      fill({ strategyId: 'agentic-1', qty: '1', price: '100', executedAt: 1 }),
      fill({ strategyId: 'agentic-1', side: 'SELL', qty: '1', price: '101', executedAt: 2 }),
      fill({ strategyId: 'agentic-2', symbol: 'ETH/USDT', qty: '1', price: '10', executedAt: 3 }),
      fill({
        strategyId: 'agentic-2',
        symbol: 'ETH/USDT',
        side: 'SELL',
        qty: '1',
        price: '11',
        executedAt: 4,
      }),
    ];
    const reader = new RoundTripEvidenceReader(statsOf(fills), '5');
    const laneWide = await reader.reflectionSeed();
    expect(laneWide.closedTradesTotal).toBe(2);
    expect(laneWide.closedSinceLastReflection).toBe(2);
    const scoped = await reader.reflectionSeed('agentic-2');
    expect(scoped.closedTradesTotal).toBe(2); // lane-wide by design (floors the global playbook gate)
    expect(scoped.closedSinceLastReflection).toBe(1);
    const trips = await reader.recentRoundTrips(10);
    expect(trips.map((t) => t.strategyId)).toEqual(['agentic-1', 'agentic-2']);
  });

  it('a non-positive limit yields no rows', async () => {
    const reader = new RoundTripEvidenceReader(
      statsOf([
        fill({ executedAt: 1 }),
        fill({ side: 'SELL', qty: '1', price: '101', executedAt: 2 }),
      ]),
      '5',
    );
    expect(await reader.recentRoundTrips(0)).toEqual([]);
  });

  it('threads the evidence epoch into every fills read (recentRoundTrips AND reflectionSeed)', async () => {
    const seen: Array<number | undefined> = [];
    const stats: PromotionStatsPort = {
      fillsForMode: (_mode, sinceMs) => {
        seen.push(sinceMs);
        return Promise.resolve([]);
      },
      llmTokenTotals: () => Promise.reject(new Error('unused')),
    };
    const reader = new RoundTripEvidenceReader(stats, '5', 1_752_182_760_000);
    await reader.recentRoundTrips(10);
    await reader.reflectionSeed('agentic-1');
    expect(seen).toEqual([1_752_182_760_000, 1_752_182_760_000]);
  });

  it('an epoch bound recovers cycles a straddle stray would otherwise freeze (2026-07-12 ETH class)', async () => {
    // A leading exit-only SELL (its entry predates the epoch/wipe) offsets signedQty by −0.025;
    // subsequent entry sizes drift, so the group never returns to dust and closes ZERO cycles.
    const stray = fill({ side: 'SELL', qty: '0.025', price: '1800', executedAt: 1_000 });
    const realTrips: PromotionFillRow[] = [
      fill({ qty: '0.0194', price: '1800', executedAt: 2_000 }),
      fill({ side: 'SELL', qty: '0.0194', price: '1810', executedAt: 3_000 }),
      fill({ qty: '0.0278', price: '1800', executedAt: 4_000 }),
      fill({ side: 'SELL', qty: '0.0278', price: '1810', executedAt: 5_000 }),
    ];
    const unbounded = new RoundTripEvidenceReader(statsOf([stray, ...realTrips]), '5');
    expect(await unbounded.recentRoundTrips(10)).toHaveLength(0); // frozen: the observed defect
    // The epoch-bounded read excludes the stray (the stats port applies sinceMs server-side; the
    // stub mimics that) and the same real fills close both cycles.
    const bounded = new RoundTripEvidenceReader(statsOf(realTrips), '5', 1_500);
    expect(await bounded.recentRoundTrips(10)).toHaveLength(2);
  });
});
