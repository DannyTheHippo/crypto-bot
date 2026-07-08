import { describe, it, expect } from 'vitest';
import { PromotionReadinessService } from '../../../src/features/trading/mode-control/promotion-readiness.service';
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

const ZERO_TOKENS: LlmTokenTotals = { perModel: [] };

// One default-model per-model row (the CFG above has no per-model map, so any model prices at the
// flat 3/15 defaults with cache at 0 — preserving every legacy cost assertion below).
function decideTokens(input: number, output: number): LlmTokenTotals {
  return {
    perModel: [
      {
        model: 'claude-sonnet-5',
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    ],
  };
}

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
  const sinceArgs: Array<number | undefined> = [];
  const port: PromotionStatsPort = {
    fillsForMode: (mode, sinceMs) => {
      calls.push(mode);
      sinceArgs.push(sinceMs);
      // Epoch filtering is the repository's job; the fake honors it so the service's window-anchor
      // and cost-window branches are exercised end-to-end against a realistic filtered set.
      const filtered = sinceMs === undefined ? fills : fills.filter((f) => f.executedAt >= sinceMs);
      return Promise.resolve(filtered);
    },
    llmTokenTotals: (sinceMs) => {
      sinceArgs.push(sinceMs);
      return Promise.resolve(tokens);
    },
  };
  return { port, calls, sinceArgs };
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
    const tokens = decideTokens(1_000_000, 100_000);
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
    const tokens = decideTokens(10_000_000, 0);
    const v = await service(fills, tokens).evaluate();
    expect(v.evidence.llmCostUsd).toBe('30');
    expect(v.evidence.netPnl).toBe('0');
    expect(v.evidence.reasons).toEqual(['NON_POSITIVE_NET_PNL']);
    expect(v.permitted).toBe(false);
  });

  describe('per-model cost (W4+W13)', () => {
    const PRICED: PromotionReadinessConfig = {
      tokenPriceInputPerMtok: '3',
      tokenPriceOutputPerMtok: '15',
      tokenPriceCacheReadPerMtok: '0.3',
      tokenPriceCacheWritePerMtok: '6',
      dustNotional: '5',
      tokenPrices: {
        'claude-sonnet-5': {
          inputPerMtok: '3',
          outputPerMtok: '15',
          cacheReadPerMtok: '0.3',
          cacheWritePerMtok: '6',
        },
        'claude-opus-4-8': {
          inputPerMtok: '5',
          outputPerMtok: '25',
          cacheReadPerMtok: '0.5',
          cacheWritePerMtok: '10',
        },
      },
    };

    it('sums each model at its own rates, cache tokens included', async () => {
      // sonnet: 1M in ×3 + 0 out + 1M cacheRead ×0.3 + 1M cacheWrite ×6 = 3 + 0.3 + 6 = 9.3
      // opus:   1M in ×5 + 1M out ×25 = 5 + 25 = 30 → total 39.3
      const tokens: LlmTokenTotals = {
        perModel: [
          {
            model: 'claude-sonnet-5',
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadTokens: 1_000_000,
            cacheCreationTokens: 1_000_000,
          },
          {
            model: 'claude-opus-4-8',
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        ],
      };
      const svc = new PromotionReadinessService(statsOf([], tokens).port, PRICED);
      const v = await svc.evaluate();
      expect(v.evidence.llmCostUsd).toBe('39.3');
    });

    it('an UNKNOWN model (map configured, model unlisted) prices at the most-expensive rates per component (fail-closed)', async () => {
      // most-expensive across {defaults 3/15/0.3/6, sonnet 3/15/0.3/6, opus 5/25/0.5/10} =
      // 5/25/0.5/10. 1M in ×5 = 5. → 5.
      const tokens: LlmTokenTotals = {
        perModel: [
          {
            model: 'some-unpriced-model',
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        ],
      };
      const svc = new PromotionReadinessService(statsOf([], tokens).port, PRICED);
      const v = await svc.evaluate();
      expect(v.evidence.llmCostUsd).toBe('5');
    });

    it('with no tokenPrices map, cache rates fall back to the flat cache knobs (or 0 when absent)', async () => {
      // CFG has no cache knobs → cache priced at 0; only input/output count.
      const tokens: LlmTokenTotals = {
        perModel: [
          {
            model: 'claude-sonnet-5',
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadTokens: 5_000_000,
            cacheCreationTokens: 5_000_000,
          },
        ],
      };
      const v = await service([], tokens).evaluate();
      expect(v.evidence.llmCostUsd).toBe('3');
    });
  });

  describe('evidence epoch (W4+W13)', () => {
    it('threads evidenceEpochMs into BOTH stats reads', async () => {
      const cfg: PromotionReadinessConfig = { ...CFG, evidenceEpochMs: 5_000 };
      const { port, sinceArgs } = statsOf([]);
      await new PromotionReadinessService(port, cfg).evaluate();
      expect(sinceArgs).toEqual([5_000, 5_000]);
    });

    it('an unset epoch passes undefined to the stats reads (all-time)', async () => {
      const { port, sinceArgs } = statsOf([]);
      await new PromotionReadinessService(port, CFG).evaluate();
      expect(sinceArgs).toEqual([undefined, undefined]);
    });

    it('anchors the window start at max(firstClosedAt, epoch): a pre-epoch trade cannot widen it', async () => {
      // Two closed trips: one closes at t=1000 (pre-epoch), one at t=1000+15d. Epoch sits at the
      // first close, so the fake filters the pre-epoch fills out AND the anchor clamps — window is
      // measured from the epoch-forward trip only.
      const closeA = 1_000;
      const closeB = closeA + 15 * DAY;
      const fills: PromotionFillRow[] = [
        fill({ executedAt: closeA - 1, side: 'BUY', qty: '0.001', price: '50000' }),
        fill({ executedAt: closeA, side: 'SELL', qty: '0.001', price: '51000' }),
        fill({ executedAt: closeB - 1, side: 'BUY', qty: '0.001', price: '50000' }),
        fill({ executedAt: closeB, side: 'SELL', qty: '0.001', price: '51000' }),
      ];
      const cfg: PromotionReadinessConfig = { ...CFG, evidenceEpochMs: closeB - 1 };
      const svc = new PromotionReadinessService(statsOf(fills).port, cfg);
      const v = await svc.evaluate();
      // Only the epoch-forward trip survives the filter → 1 round trip, window 0 days.
      expect(v.evidence.roundTrips).toBe(1);
      expect(v.evidence.windowDays).toBe(0);
    });
  });
});
