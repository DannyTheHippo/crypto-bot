import { describe, it, expect } from 'vitest';
import { RoundTripEvidenceReader } from '../../../src/features/trading/agentic/round-trip-evidence.reader';
import type { PromotionFillRow, PromotionStatsPort } from '../../../src/ports/promotion';

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
});
