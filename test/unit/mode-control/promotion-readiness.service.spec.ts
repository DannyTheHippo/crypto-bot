import { describe, it, expect } from 'vitest';
import { PromotionReadinessService } from '../../../src/modules/mode-control/promotion-readiness.service';
import type {
  PromotionFillRow,
  PromotionReadinessConfig,
  PromotionStatsPort,
  LlmTokenTotals,
} from '../../../src/ports/promotion';

const CFG: PromotionReadinessConfig = {
  tokenPriceInputPerMtok: '3',
  tokenPriceOutputPerMtok: '15',
  dustNotional: '5',
};

const ZERO_TOKENS: LlmTokenTotals = {
  decideInputTokens: 0,
  decideOutputTokens: 0,
  reflectionInputTokens: 0,
  reflectionOutputTokens: 0,
};

function fill(overrides: Partial<PromotionFillRow>): PromotionFillRow {
  return {
    strategyId: 'agentic-1',
    symbol: 'BTC/USDT',
    side: 'BUY',
    qty: '0.001',
    price: '50000',
    fee: null,
    feeAsset: null,
    executedAt: 1_000,
    ...overrides,
  };
}

function statsOf(fills: readonly PromotionFillRow[], tokens: LlmTokenTotals = ZERO_TOKENS) {
  const calls: string[] = [];
  const port: PromotionStatsPort = {
    fillsForMode: (mode) => {
      calls.push(mode);
      return Promise.resolve(fills);
    },
    llmTokenTotals: () => Promise.resolve(tokens),
  };
  return { port, calls };
}

function service(fills: readonly PromotionFillRow[], tokens?: LlmTokenTotals) {
  return new PromotionReadinessService(statsOf(fills, tokens).port, CFG);
}

const DAY = 24 * 60 * 60 * 1000;

describe('PromotionReadinessService', () => {
  it('fail-closed NO_STATS_SOURCE when no stats port is bound', async () => {
    const svc = new PromotionReadinessService(undefined, CFG);
    const v = await svc.evaluate();
    expect(v.permitted).toBe(false);
    expect(v.evidence.reasons).toEqual(['NO_STATS_SOURCE']);
    expect(v.evidence.roundTrips).toBe(0);
    expect(v.evidence.netPnl).toBe('0');
    expect(v.evidence.firstClosedAt).toBeNull();
    expect(v.evidence.lastClosedAt).toBeNull();
  });

  it('queries fills for the demo (testnet) mode specifically', async () => {
    const { port, calls } = statsOf([]);
    await new PromotionReadinessService(port, CFG).evaluate();
    expect(calls).toEqual(['testnet']);
  });

  it('no fills → zero evidence, all three criteria reasons', async () => {
    const v = await service([]).evaluate();
    expect(v.permitted).toBe(false);
    expect(v.evidence.reasons).toEqual([
      'INSUFFICIENT_ROUND_TRIPS',
      'NON_POSITIVE_NET_PNL',
      'INSUFFICIENT_WINDOW',
    ]);
    expect(v.evidence.windowDays).toBe(0);
    expect(v.evidence.realizedPnl).toBe('0');
  });

  it('an open cycle (residual above dust) never closes', async () => {
    const v = await service([fill({ side: 'BUY', qty: '0.001', price: '50000' })]).evaluate();
    expect(v.evidence.roundTrips).toBe(0);
    expect(v.evidence.firstClosedAt).toBeNull();
  });

  it('dust-residual closure: sub-dustNotional remainder closes the cycle with exact PnL', async () => {
    // cost 50; proceeds 0.00099×60000 = 59.4; residual 0.00001×60000 = 0.6 < 5 → closed.
    const v = await service([
      fill({ executedAt: 1, side: 'BUY', qty: '0.001', price: '50000' }),
      fill({ executedAt: 2, side: 'SELL', qty: '0.00099', price: '60000' }),
    ]).evaluate();
    expect(v.evidence.roundTrips).toBe(1);
    expect(v.evidence.realizedPnl).toBe('9.4');
    expect(v.evidence.firstClosedAt).toBe(2);
    expect(v.evidence.lastClosedAt).toBe(2);
  });

  it('exact-flat closure with quote fees summed (exact strings)', async () => {
    const v = await service([
      fill({
        executedAt: 1,
        side: 'BUY',
        qty: '0.001',
        price: '50000',
        fee: '0.01',
        feeAsset: 'USDT',
      }),
      fill({
        executedAt: 2,
        side: 'SELL',
        qty: '0.001',
        price: '51000',
        fee: '0.01',
        feeAsset: 'USDT',
      }),
    ]).evaluate();
    expect(v.evidence.roundTrips).toBe(1);
    expect(v.evidence.realizedPnl).toBe('1');
    expect(v.evidence.fees).toBe('0.02');
    expect(v.evidence.netPnl).toBe('0.98');
  });

  it('base-asset fees convert at the fill price', async () => {
    const v = await service([
      fill({
        executedAt: 1,
        side: 'BUY',
        qty: '0.001',
        price: '50000',
        fee: '0.00001',
        feeAsset: 'BTC',
      }),
      fill({ executedAt: 2, side: 'SELL', qty: '0.001', price: '51000' }),
    ]).evaluate();
    // 0.00001 BTC × 50000 = 0.5
    expect(v.evidence.fees).toBe('0.5');
  });

  it('a fee in a third asset (BNB) marks UNCONVERTIBLE_FEE_ASSET, is excluded from the fee sum, and refuses', async () => {
    const v = await service([
      fill({
        executedAt: 1,
        side: 'BUY',
        qty: '0.001',
        price: '50000',
        fee: '0.001',
        feeAsset: 'BNB',
      }),
      fill({ executedAt: 2, side: 'SELL', qty: '0.001', price: '51000' }),
    ]).evaluate();
    expect(v.permitted).toBe(false);
    expect(v.evidence.reasons).toContain('UNCONVERTIBLE_FEE_ASSET');
    expect(v.evidence.fees).toBe('0');
  });

  it('rows with a null fee or null feeAsset contribute nothing to fees and no unconvertible flag', async () => {
    const v = await service([
      fill({ executedAt: 1, side: 'BUY', fee: null, feeAsset: 'USDT' }),
      fill({
        executedAt: 2,
        side: 'SELL',
        qty: '0.001',
        price: '51000',
        fee: '0.5',
        feeAsset: null,
      }),
    ]).evaluate();
    expect(v.evidence.fees).toBe('0');
    expect(v.evidence.reasons).not.toContain('UNCONVERTIBLE_FEE_ASSET');
  });

  it('a slashless symbol treats its quote as empty (fee in any other asset is unconvertible)', async () => {
    const v = await service([
      fill({ symbol: 'TESTSYM', side: 'BUY', qty: '1', price: '100', fee: '1', feeAsset: 'XXX' }),
    ]).evaluate();
    expect(v.evidence.reasons).toContain('UNCONVERTIBLE_FEE_ASSET');
  });

  it('null-join fills are excluded from the walk and add UNRESOLVED_FILL', async () => {
    const v = await service([
      fill({ executedAt: 1, side: 'BUY', qty: '0.001', price: '50000' }),
      fill({ executedAt: 2, side: 'SELL', qty: '0.001', price: '51000' }),
      fill({ executedAt: 3, strategyId: null, side: 'BUY' }),
      fill({ executedAt: 4, strategyId: 'agentic-1', side: null }),
    ]).evaluate();
    expect(v.evidence.roundTrips).toBe(1);
    expect(v.evidence.reasons).toContain('UNRESOLVED_FILL');
  });

  it('groups are independent: one symbol’s open position never folds into another’s cycle', async () => {
    const v = await service([
      fill({ executedAt: 1, symbol: 'BTC/USDT', side: 'BUY', qty: '0.001', price: '50000' }),
      fill({ executedAt: 2, symbol: 'ETH/USDT', side: 'BUY', qty: '0.02', price: '2500' }),
      fill({ executedAt: 3, symbol: 'ETH/USDT', side: 'SELL', qty: '0.02', price: '2600' }),
    ]).evaluate();
    // ETH closes exactly flat: pnl 52 − 50 = 2. A merged (non-grouped) walk would instead close
    // at residual 0.001 BTC (2.6 notional < dust) with the BTC cost folded in (pnl −48).
    expect(v.evidence.roundTrips).toBe(1);
    expect(v.evidence.realizedPnl).toBe('2');
  });

  it('permitted only when all criteria hold: 30 trips, >14d window, positive net of LLM cost', async () => {
    const fills: PromotionFillRow[] = [];
    for (let i = 0; i < 30; i++) {
      const closedAt = 1_000_000 + i * ((15 * DAY) / 29);
      fills.push(
        fill({ executedAt: closedAt - 1, side: 'BUY', qty: '0.001', price: '50000' }),
        fill({ executedAt: closedAt, side: 'SELL', qty: '0.001', price: '51000' }),
      );
    }
    // realized = 30 × 1 = 30; llm cost = 1M/1M×3 + 100k/1M×15 = 3 + 1.5 = 4.5; net = 25.5 > 0.
    const tokens: LlmTokenTotals = {
      decideInputTokens: 500_000,
      decideOutputTokens: 100_000,
      reflectionInputTokens: 500_000,
      reflectionOutputTokens: 0,
    };
    const v = await service(fills, tokens).evaluate();
    expect(v.evidence.roundTrips).toBe(30);
    expect(v.evidence.llmCostUsd).toBe('4.5');
    expect(v.evidence.netPnl).toBe('25.5');
    expect(v.evidence.windowDays).toBe(15);
    expect(v.evidence.reasons).toEqual([]);
    expect(v.permitted).toBe(true);
  });

  it('29 round trips → INSUFFICIENT_ROUND_TRIPS', async () => {
    const fills: PromotionFillRow[] = [];
    for (let i = 0; i < 29; i++) {
      const closedAt = 1_000_000 + i * DAY;
      fills.push(
        fill({ executedAt: closedAt - 1, side: 'BUY', qty: '0.001', price: '50000' }),
        fill({ executedAt: closedAt, side: 'SELL', qty: '0.001', price: '51000' }),
      );
    }
    const v = await service(fills).evaluate();
    expect(v.evidence.roundTrips).toBe(29);
    expect(v.evidence.reasons).toEqual(['INSUFFICIENT_ROUND_TRIPS']);
    expect(v.permitted).toBe(false);
  });

  it('a 13-day window → INSUFFICIENT_WINDOW even with 30 profitable trips', async () => {
    const fills: PromotionFillRow[] = [];
    for (let i = 0; i < 30; i++) {
      const closedAt = 1_000_000 + i * ((13 * DAY) / 29);
      fills.push(
        fill({ executedAt: closedAt - 1, side: 'BUY', qty: '0.001', price: '50000' }),
        fill({ executedAt: closedAt, side: 'SELL', qty: '0.001', price: '51000' }),
      );
    }
    const v = await service(fills).evaluate();
    expect(v.evidence.windowDays).toBe(13);
    expect(v.evidence.reasons).toEqual(['INSUFFICIENT_WINDOW']);
  });

  it('LLM cost flips a gross profit to NON_POSITIVE_NET_PNL (lte-zero refused)', async () => {
    const fills: PromotionFillRow[] = [];
    for (let i = 0; i < 30; i++) {
      const closedAt = 1_000_000 + i * ((15 * DAY) / 29);
      fills.push(
        fill({ executedAt: closedAt - 1, side: 'BUY', qty: '0.001', price: '50000' }),
        fill({ executedAt: closedAt, side: 'SELL', qty: '0.001', price: '51000' }),
      );
    }
    // realized 30; cost = 10M/1M×3 = 30 → net exactly 0 → refused (lte).
    const tokens: LlmTokenTotals = { ...ZERO_TOKENS, decideInputTokens: 10_000_000 };
    const v = await service(fills, tokens).evaluate();
    expect(v.evidence.llmCostUsd).toBe('30');
    expect(v.evidence.netPnl).toBe('0');
    expect(v.evidence.reasons).toEqual(['NON_POSITIVE_NET_PNL']);
    expect(v.permitted).toBe(false);
  });
});
