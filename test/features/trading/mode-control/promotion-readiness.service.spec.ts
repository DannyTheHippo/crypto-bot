import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { PromotionReadinessService } from '../../../../src/features/trading/mode-control/promotion-readiness.service';
import type {
  LlmTokenTotals,
  PromotionFillRow,
  PromotionReadinessConfig,
  PromotionStatsPort,
} from '../../../../src/ports/trading/promotion';
import type { PassiveBenchmarkPort } from '../../../../src/ports/trading/promotion';

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
    expect(v.evidence.winRate).toBe(0);
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
    expect(v.evidence.winRate).toBe(1);
  });

  it('winRate is wins/trips over per-trip net (realized − feesQuote), 0 with no trips', async () => {
    const empty = await service([]).evaluate();
    expect(empty.evidence.winRate).toBe(0);

    // Win: +1 realized, 0.02 fees → net 0.98 > 0.
    // Loss: −1 realized, 0.02 fees → net −1.02 ≤ 0.
    const mixed = await service([
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
      fill({
        executedAt: DAY + 1,
        side: 'BUY',
        qty: '0.001',
        price: '51000',
        fee: '0.01',
        feeAsset: 'USDT',
      }),
      fill({
        executedAt: DAY + 2,
        side: 'SELL',
        qty: '0.001',
        price: '50000',
        fee: '0.01',
        feeAsset: 'USDT',
      }),
    ]).evaluate();
    expect(mixed.evidence.roundTrips).toBe(2);
    expect(mixed.evidence.winRate).toBe(0.5);
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

  // G5 (research/studies/success-exit-2026-07-31.md §9, 2026-08-01): typed `reasons` from `string[]`
  // to the closed `PromotionBlockedReason` union (ports/trading/promotion.ts) to back the new
  // agentic_promotion_blocked gauge's zero-seed — a type-only change. This pins the exact reasons
  // array for every non-NO_STATS_SOURCE clause firing at once (that early-return branch is covered
  // separately above), proving the retype changed nothing at runtime: order and membership are
  // byte-identical to evaluate()'s own reasons.push sequence.
  it('all seven non-NO_STATS_SOURCE reasons can fire simultaneously — verdict pinned exactly (G5 regression)', async () => {
    const fills: PromotionFillRow[] = [
      // Unconvertible fee (BNB) on the opening leg; closes at a loss (100 → 90).
      fill({ executedAt: 0, side: 'BUY', qty: '1', price: '100', fee: '0.001', feeAsset: 'BNB' }),
      fill({ executedAt: 1_000, side: 'SELL', qty: '1', price: '90' }),
      // Unjoined fill: strategyId null → UNRESOLVED_FILL, excluded from the walk.
      fill({ executedAt: 2_000, strategyId: null, side: 'BUY' }),
    ];
    const cfg: PromotionReadinessConfig = { ...CFG, fundingDataExpected: true };
    const base = statsOf(fills);
    const port: PromotionStatsPort = {
      ...base.port,
      fundingNetForMode: () => Promise.resolve({ netQuote: '0', hasRows: false }),
    };
    const benchmark: PassiveBenchmarkPort = { passivePnlQuote: () => Promise.resolve('1000') };

    const v = await new PromotionReadinessService(port, cfg, benchmark).evaluate();

    expect(v.evidence.roundTrips).toBe(1);
    expect(v.evidence.netPnl).toBe('-10');
    expect(v.evidence.windowDays).toBe(0);
    expect(v.evidence.reasons).toEqual([
      'UNRESOLVED_FILL',
      'UNCONVERTIBLE_FEE_ASSET',
      'INSUFFICIENT_ROUND_TRIPS',
      'NON_POSITIVE_NET_PNL',
      'INSUFFICIENT_WINDOW',
      'FUNDING_DATA_MISSING',
      'BELOW_PASSIVE_BENCHMARK',
    ]);
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
        'claude-opus-5': {
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
            model: 'claude-opus-5',
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

    // Defect 142 (2026-08-04): the fail-closed fallback above previously left no trace of which
    // model triggered it — a config drift (e.g. the claude-opus-4-8 → claude-opus-5 rename that left
    // 58 historical DB rows unpriced) was invisible outside a manual evidence read. This does not
    // weaken the fail-closed-rate assertion above (llmCostUsd still prices at the max-of-configured
    // rate) — it only pins that the warning names the model.
    it('an UNKNOWN model logs a warning naming the model id (observability, defect 142)', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const tokens: LlmTokenTotals = {
          perModel: [
            {
              model: 'claude-opus-4-8',
              inputTokens: 1_000_000,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
          ],
        };
        const svc = new PromotionReadinessService(statsOf([], tokens).port, PRICED);
        await svc.evaluate();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('claude-opus-4-8'));
      } finally {
        // A failed expect above must still restore Logger.prototype.warn — vitest.config.ts sets no
        // restoreMocks, so an unrestored spy here would leak into every later test in this file and
        // turn one real failure into a cascade of misleading ones.
        warnSpy.mockRestore();
      }
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

    // hasTokens (`||` chain, llmCostUsd) short-circuits on the FIRST truthy operand — every test
    // above puts a positive inputTokens first, so operands 2-4 are never even reached. Three rows,
    // each zeroing every operand before the one under test, force each later operand to be the one
    // that decides (and, for cacheCreationTokens, the one reached last with nothing left to check).
    it('each hasTokens operand (output/cacheRead/cacheCreation) is independently reached, not just input (branch coverage)', async () => {
      const tokens: LlmTokenTotals = {
        perModel: [
          // operand 2 decides: output only.
          {
            model: 'claude-sonnet-5',
            inputTokens: 0,
            outputTokens: 1_000_000,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
          // operand 3 decides: cacheRead only.
          {
            model: 'claude-sonnet-5',
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 1_000_000,
            cacheCreationTokens: 0,
          },
          // operand 4 decides: cacheCreation only.
          {
            model: 'claude-sonnet-5',
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 1_000_000,
          },
        ],
      };
      const svc = new PromotionReadinessService(statsOf([], tokens).port, PRICED);
      const v = await svc.evaluate();
      // sonnet rates (PRICED): output 15, cacheRead 0.3, cacheWrite 6 → 15 + 0.3 + 6 = 21.3.
      expect(v.evidence.llmCostUsd).toBe('21.3');
    });

    // Defect 142's own warn (line ~249) is `if (hasTokens && !this.warnedModels.has(model))` — the
    // suite above only ever takes the TRUE path. These pin both ways it goes FALSE, since they are
    // different facts: no tokens at all (the real 'prescreen'/'plan-executor' case) vs. a real model
    // already latched from an earlier evaluate() on the same instance. Nested here (not a sibling
    // describe) to reuse PRICED — an unpriced-model warn is unreachable under CFG, whose tokenPrices
    // map is absent (ratesFor returns the flat defaults before ever reaching the warn branch).
    describe('unpriced-model warn — both FALSE paths (branch coverage)', () => {
      it('an unpriced ALL-ZERO-token row (internal journal tag) never warns — hasTokens=false skips the branch entirely', async () => {
        const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        try {
          const tokens: LlmTokenTotals = {
            perModel: [
              {
                model: 'prescreen',
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
              },
            ],
          };
          const svc = new PromotionReadinessService(statsOf([], tokens).port, PRICED);
          await svc.evaluate();
          expect(warnSpy).not.toHaveBeenCalled();
        } finally {
          // Same leak hazard as the defect-142 test above: vitest.config.ts sets no restoreMocks.
          warnSpy.mockRestore();
        }
      });

      it('the same unpriced model warns exactly once across two evaluate() calls on one instance (per-process latch)', async () => {
        const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        try {
          const tokens: LlmTokenTotals = {
            perModel: [
              {
                model: 'claude-opus-9',
                inputTokens: 1_000_000,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
              },
            ],
          };
          const svc = new PromotionReadinessService(statsOf([], tokens).port, PRICED);
          await svc.evaluate();
          await svc.evaluate();
          expect(warnSpy).toHaveBeenCalledTimes(1);
        } finally {
          warnSpy.mockRestore();
        }
      });
    });
  });

  describe('funding inclusion (P5b)', () => {
    // 30 profitable trips, no LLM cost: realized 30, net 30 before funding — isolates the funding
    // delta cleanly against the base case already proven above ('permitted only when...').
    function profitableFills(): PromotionFillRow[] {
      const fills: PromotionFillRow[] = [];
      for (let i = 0; i < 30; i++) {
        const closedAt = 1_000_000 + i * ((15 * DAY) / 29);
        fills.push(
          fill({ executedAt: closedAt - 1, side: 'BUY', qty: '0.001', price: '50000' }),
          fill({ executedAt: closedAt, side: 'SELL', qty: '0.001', price: '51000' }),
        );
      }
      return fills;
    }

    function statsWithFunding(netQuote: string, hasRows: boolean) {
      const base = statsOf(profitableFills());
      const port: PromotionStatsPort = {
        ...base.port,
        fundingNetForMode: () => Promise.resolve({ netQuote, hasRows }),
      };
      return port;
    }

    it('a RECEIVED (positive) funding net ADDS to netPnl exactly', async () => {
      const svc = new PromotionReadinessService(statsWithFunding('4.5', true), CFG);
      const v = await svc.evaluate();
      expect(v.evidence.fundingNet).toBe('4.5');
      expect(v.evidence.netPnl).toBe('34.5'); // 30 + 4.5
      expect(v.evidence.fundingDataMissing).toBe(false);
    });

    it('a PAID (negative) funding net SUBTRACTS from netPnl exactly (opposite sign, same magnitude)', async () => {
      const svc = new PromotionReadinessService(statsWithFunding('-4.5', true), CFG);
      const v = await svc.evaluate();
      expect(v.evidence.fundingNet).toBe('-4.5');
      expect(v.evidence.netPnl).toBe('25.5'); // 30 + (-4.5)
    });

    it('fundingDataExpected + zero rows raises fundingDataMissing AND blocks via FUNDING_DATA_MISSING (fail-closed)', async () => {
      const cfg: PromotionReadinessConfig = { ...CFG, fundingDataExpected: true };
      const svc = new PromotionReadinessService(statsWithFunding('0', false), cfg);
      const v = await svc.evaluate();
      expect(v.evidence.fundingDataMissing).toBe(true);
      expect(v.evidence.reasons).toEqual(['FUNDING_DATA_MISSING']);
      expect(v.permitted).toBe(false);
    });

    it('fundingDataExpected false never raises the flag even with zero rows', async () => {
      const svc = new PromotionReadinessService(statsWithFunding('0', false), CFG);
      const v = await svc.evaluate();
      expect(v.evidence.fundingDataMissing).toBe(false);
      expect(v.evidence.reasons).not.toContain('FUNDING_DATA_MISSING');
      expect(v.permitted).toBe(true);
    });

    it('rows present (hasRows true) never raises the flag even when netQuote is zero', async () => {
      const cfg: PromotionReadinessConfig = { ...CFG, fundingDataExpected: true };
      const svc = new PromotionReadinessService(statsWithFunding('0', true), cfg);
      const v = await svc.evaluate();
      expect(v.evidence.fundingDataMissing).toBe(false);
      expect(v.evidence.reasons).not.toContain('FUNDING_DATA_MISSING');
      expect(v.permitted).toBe(true);
    });

    it('a stats port that never implemented fundingNetForMode degrades to zero funding, no throw', async () => {
      // The shared statsOf() fake (used by every other test in this file) has no fundingNetForMode —
      // confirms the optional-method contract never breaks an older/simpler implementation.
      const v = await service(profitableFills()).evaluate();
      expect(v.evidence.fundingNet).toBe('0');
      expect(v.evidence.fundingDataMissing).toBe(false);
      expect(v.evidence.netPnl).toBe('30');
    });

    // Defect 143 (2026-08-04): fundingNetForMode gained an optional third `asOfMs` parameter so
    // AUDIT/re-derivation callers (test/backtest/book-truth.spec.ts) can pin a past funding read to
    // its ingest watermark. This book PAYS funding net, so narrowing the window on a live evaluation
    // would FLATTER netPnl — the exact defect the asOfMs cap exists to enable only for audits, never
    // for the live gate. This test is the only thing standing between the codebase and a future
    // editor "helpfully" passing Date.now() as a third argument here.
    it('the live gate calls fundingNetForMode with NO as-of cap — a narrowed funding window flatters a book that pays funding (defect 143)', async () => {
      const calls: unknown[][] = [];
      const base = statsOf(profitableFills());
      const port: PromotionStatsPort = {
        ...base.port,
        fundingNetForMode: (...args: unknown[]) => {
          calls.push(args);
          return Promise.resolve({
            netQuote: '-4.5',
            hasRows: true,
            ingestedThroughMs: 1_700_000_000_000,
          });
        },
      };
      const v = await new PromotionReadinessService(port, CFG).evaluate();
      // Exactly two arguments: mode + evidence epoch. A third would silently narrow the window.
      expect(calls[0]).toEqual(['testnet', undefined]);
      expect(calls[0]!.length).toBe(2);
      // Verdict is unchanged by the fix — same exact string as the funding-inclusion test above.
      expect(v.evidence.netPnl).toBe('25.5');
      expect(v.evidence.fundingIngestedThroughMs).toBe(1_700_000_000_000);
    });

    // mode-control is a 100%-branch coverage glob (vitest.config.ts) — the new
    // `funding.ingestedThroughMs ?? null` needs both arms covered; the fakes above (which return a
    // numeric watermark or omit the field entirely, i.e. undefined) already cover the
    // truthy/undefined arms — this exercises the explicit `null` arm a port CAN return (e.g. no
    // funding rows ingested yet), which `?? null` must also fold to null.
    it('a stats port returning a null funding watermark records a null evidence watermark', async () => {
      const base = statsOf(profitableFills());
      const port: PromotionStatsPort = {
        ...base.port,
        fundingNetForMode: () =>
          Promise.resolve({ netQuote: '-4.5', hasRows: true, ingestedThroughMs: null }),
      };
      const v = await new PromotionReadinessService(port, CFG).evaluate();
      expect(v.evidence.fundingIngestedThroughMs).toBeNull();
      expect(v.evidence.netPnl).toBe('25.5');
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

  describe('passive benchmark clause (2026-07-27)', () => {
    // Two closed trips 15 days apart so the window/round-trip clauses are not what is under test;
    // only BELOW_PASSIVE_BENCHMARK's own presence or absence is asserted here.
    const CLOSE_A = 1_000;
    const CLOSE_B = CLOSE_A + 15 * DAY;
    const profitableFills: PromotionFillRow[] = [
      fill({ executedAt: CLOSE_A - 1, side: 'BUY', qty: '1', price: '100' }),
      fill({ executedAt: CLOSE_A, side: 'SELL', qty: '1', price: '150' }),
      fill({ executedAt: CLOSE_B - 1, side: 'BUY', qty: '1', price: '100' }),
      fill({ executedAt: CLOSE_B, side: 'SELL', qty: '1', price: '150' }),
    ];
    const benchmarkOf = (value: string | null): PassiveBenchmarkPort => ({
      passivePnlQuote: () => Promise.resolve(value),
    });

    it('no port bound ⇒ the clause never fires and the verdict is unchanged', async () => {
      const v = await new PromotionReadinessService(statsOf(profitableFills).port, CFG).evaluate();
      expect(v.evidence.passivePnlQuote).toBeNull();
      expect(v.evidence.reasons).not.toContain('BELOW_PASSIVE_BENCHMARK');
    });

    it('port returns null (measurement gap) ⇒ clause dropped, never guessed', async () => {
      const v = await new PromotionReadinessService(
        statsOf(profitableFills).port,
        CFG,
        benchmarkOf(null),
      ).evaluate();
      expect(v.evidence.passivePnlQuote).toBeNull();
      expect(v.evidence.reasons).not.toContain('BELOW_PASSIVE_BENCHMARK');
    });

    it('beating zero but LOSING to the basket is blocked — the whole point of the clause', async () => {
      // netPnl is +100 (two trips of +50). Passive would have earned 250 on the same capital.
      const v = await new PromotionReadinessService(
        statsOf(profitableFills).port,
        CFG,
        benchmarkOf('250'),
      ).evaluate();
      expect(v.evidence.netPnl).toBe('100');
      expect(v.evidence.passivePnlQuote).toBe('250');
      expect(v.evidence.reasons).toContain('BELOW_PASSIVE_BENCHMARK');
      expect(v.permitted).toBe(false);
    });

    it('exactly matching the basket is NOT beating it (<= blocks, so a tie fails)', async () => {
      const v = await new PromotionReadinessService(
        statsOf(profitableFills).port,
        CFG,
        benchmarkOf('100'),
      ).evaluate();
      expect(v.evidence.reasons).toContain('BELOW_PASSIVE_BENCHMARK');
    });

    it('beating the basket clears the clause', async () => {
      const v = await new PromotionReadinessService(
        statsOf(profitableFills).port,
        CFG,
        benchmarkOf('99'),
      ).evaluate();
      expect(v.evidence.passivePnlQuote).toBe('99');
      expect(v.evidence.reasons).not.toContain('BELOW_PASSIVE_BENCHMARK');
    });

    it('no closed trips ⇒ no window ⇒ the port is never consulted', async () => {
      let calls = 0;
      const spy: PassiveBenchmarkPort = {
        passivePnlQuote: () => {
          calls += 1;
          return Promise.resolve('250');
        },
      };
      const v = await new PromotionReadinessService(statsOf([]).port, CFG, spy).evaluate();
      expect(calls).toBe(0);
      expect(v.evidence.passivePnlQuote).toBeNull();
    });
  });

  // G4 (2026-08-01, research/studies/success-exit-2026-07-31.md § 6): PassiveBenchmarkRepository
  // (database/repositories/trading/passive-benchmark.repository.ts) is bound as PASSIVE_BENCHMARK
  // at the composition root (AgenticBridgeModule) — this suite exercises the SERVICE side of that
  // binding only (the repository itself is DB-coupled and untested outside test:db, same convention
  // PromotionStatsRepository already follows). Two things are pinned here that the 2026-07-27 suite
  // above does not cover:
  //   1. the adapter's own fail-closed sentinel ('Infinity' — see the repository's CANNOT_COMPUTE
  //      comment) actually forces a block once it reaches the real comparison, not just in isolation;
  //   2. binding the benchmark can only ever ADD a reason, never remove one or flip a verdict from
  //      not-permitted to permitted — the gate-override grant (2026-07-22) authorises this change
  //      ONLY because it can make the gate stricter, never looser.
  describe('passive benchmark clause — fail-closed adapter integration + verdict-unchanged proof (2026-08-01)', () => {
    const benchmarkOf = (value: string | null): PassiveBenchmarkPort => ({
      passivePnlQuote: () => Promise.resolve(value),
    });

    // 30 profitable trips, no LLM cost: realized 30, net 30 — a baseline the gate ALREADY permits
    // with no benchmark bound (same shape as the funding-inclusion block's own profitableFills()).
    function permittedBaselineFills(): PromotionFillRow[] {
      const fills: PromotionFillRow[] = [];
      for (let i = 0; i < 30; i++) {
        const closedAt = 1_000_000 + i * ((15 * DAY) / 29);
        fills.push(
          fill({ executedAt: closedAt - 1, side: 'BUY', qty: '0.001', price: '50000' }),
          fill({ executedAt: closedAt, side: 'SELL', qty: '0.001', price: '51000' }),
        );
      }
      return fills;
    }

    it('the baseline is permitted with no benchmark bound (sanity check for the two tests below)', async () => {
      const v = await new PromotionReadinessService(
        statsOf(permittedBaselineFills()).port,
        CFG,
      ).evaluate();
      expect(v.evidence.netPnl).toBe('30');
      expect(v.permitted).toBe(true);
      expect(v.evidence.reasons).toEqual([]);
    });

    it('binding a benchmark the baseline beats leaves it permitted — reasons stay empty (never flips true → true differently)', async () => {
      const v = await new PromotionReadinessService(
        statsOf(permittedBaselineFills()).port,
        CFG,
        benchmarkOf('1'), // netPnl 30 > 1
      ).evaluate();
      expect(v.permitted).toBe(true);
      expect(v.evidence.reasons).toEqual([]);
    });

    it("the adapter's fail-closed sentinel (Infinity) flips a permitted baseline to blocked, adding exactly one reason", async () => {
      const v = await new PromotionReadinessService(
        statsOf(permittedBaselineFills()).port,
        CFG,
        benchmarkOf('Infinity'),
      ).evaluate();
      expect(v.evidence.netPnl).toBe('30');
      expect(v.evidence.passivePnlQuote).toBe('Infinity');
      expect(v.evidence.reasons).toEqual(['BELOW_PASSIVE_BENCHMARK']);
      expect(v.permitted).toBe(false);
    });

    it('binding the benchmark can never rescue a verdict already blocked by another reason — never flips false → true', async () => {
      // 29 round trips (same fixture as the standalone INSUFFICIENT_ROUND_TRIPS test above) blocks
      // regardless of the benchmark, even one the strategy trivially beats.
      const fills: PromotionFillRow[] = [];
      for (let i = 0; i < 29; i++) {
        const closedAt = 1_000_000 + i * DAY;
        fills.push(
          fill({ executedAt: closedAt - 1, side: 'BUY', qty: '0.001', price: '50000' }),
          fill({ executedAt: closedAt, side: 'SELL', qty: '0.001', price: '51000' }),
        );
      }
      const v = await new PromotionReadinessService(
        statsOf(fills).port,
        CFG,
        benchmarkOf('-999999'), // trivially beaten
      ).evaluate();
      expect(v.permitted).toBe(false);
      expect(v.evidence.reasons).toEqual(['INSUFFICIENT_ROUND_TRIPS']);
    });
  });
});
