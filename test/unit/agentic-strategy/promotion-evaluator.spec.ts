import { describe, it, expect } from 'vitest';
import {
  PromotionEvaluator,
  createPromotionEvaluator,
  type EvaluatorPlaybookStore,
  type PromotionEvaluatorDeps,
} from '../../../src/features/trading/agentic/promotion-evaluator';
import type { PromotionFillRow, PromotionStatsPort } from '../../../src/ports/promotion';
import type {
  AgentDecisionRow,
  AgentDecisionJournalPort,
} from '../../../src/ports/agentic-strategy';
import type { KillSwitchPort } from '../../../src/ports/risk';
import { strategyId, epochMs } from '../../../src/domain/types/ids';

const SID = 'agentic-1';
const SYM = 'BTC/USDT';

// A closed round trip = a BUY then a SELL of equal qty at the given prices; realized = (sell−buy)×qty.
// qty 1 (notional ~100 ≫ the 5 dust threshold) so a single fill never dust-closes on its own — the
// cycle closes only when the buy+sell net to flat, i.e. one cycle per pair.
function tripFills(buyPrice: string, sellPrice: string, at: number): PromotionFillRow[] {
  return [
    {
      strategyId: SID,
      symbol: SYM,
      side: 'BUY',
      qty: '1',
      price: buyPrice,
      fee: null,
      feeAsset: null,
      executedAt: at,
    },
    {
      strategyId: SID,
      symbol: SYM,
      side: 'SELL',
      qty: '1',
      price: sellPrice,
      fee: null,
      feeAsset: null,
      executedAt: at + 1,
    },
  ];
}

// A journal row placing (strategyId, symbol) under `version` at eventTime `at` — attribution keys the
// cycle whose entry is at-or-after this row to `version`.
function decisionRow(version: number, at: number): AgentDecisionRow {
  return {
    id: `d-${version}-${at}`,
    createdAt: epochMs(at),
    strategyId: strategyId(SID),
    symbol: SYM as unknown as AgentDecisionRow['symbol'],
    venue: 'binance' as unknown as AgentDecisionRow['venue'],
    triggerKind: 'candle',
    basedOnSeq: 0n,
    eventTime: epochMs(at),
    model: 'm',
    action: 'long',
    confidence: 0.6,
    rationale: 'r',
    refPrice: null,
    close: null,
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
    playbookVersion: version,
    promptHash: 'h',
    inputPayload: null,
  };
}

interface Harness {
  deps: PromotionEvaluatorDeps;
  appended: Array<{ content: string; source: string; parentVersion: number }>;
  outcomes: string[];
}

function harness(opts: {
  fills: readonly PromotionFillRow[];
  decisions: readonly AgentDecisionRow[];
  championVersion: number;
  killState?: 'RUNNING' | 'HALTED';
  appendThrows?: boolean;
}): Harness {
  const appended: Array<{ content: string; source: string; parentVersion: number }> = [];
  const outcomes: string[] = [];
  const store: EvaluatorPlaybookStore = {
    current: () =>
      Promise.resolve({ version: opts.championVersion, content: '## regime notes\nx' }),
    append: (content, source, parentVersion) => {
      if (opts.appendThrows) return Promise.reject(new Error('once-per-day promotion cap'));
      appended.push({ content, source, parentVersion });
      return Promise.resolve({ version: parentVersion + 1 });
    },
  };
  const stats: PromotionStatsPort = {
    fillsForMode: () => Promise.resolve(opts.fills),
    llmTokenTotals: () => Promise.resolve({ perModel: [] }),
  };
  const journal: AgentDecisionJournalPort = {
    record: () => undefined,
    recent: () => Promise.resolve(opts.decisions),
  };
  const killSwitch: KillSwitchPort = {
    state: () => opts.killState ?? 'RUNNING',
  } as unknown as KillSwitchPort;
  return {
    deps: {
      stats,
      journal,
      playbookStore: store,
      recorder: { recordReflectionOutcome: (o) => void outcomes.push(o) },
      killSwitch,
    },
    appended,
    outcomes,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PromotionEvaluator (W5 attributed auto-promotion)', () => {
  // Champion v1 with 3 losing trips (mean −0.1×qty), candidate v2 with 10 winning trips.
  function championAndCandidate(candidateTrips: number) {
    const decisions = [decisionRow(1, 1_000), decisionRow(2, 100_000)];
    const fills: PromotionFillRow[] = [];
    // champion v1: 3 trips opened just after the v1 decision, each losing (buy 100 sell 99).
    for (let i = 0; i < 3; i++) fills.push(...tripFills('100', '99', 2_000 + i * 10));
    // candidate v2: `candidateTrips` trips opened after the v2 decision, each winning (buy 100 sell 110).
    for (let i = 0; i < candidateTrips; i++)
      fills.push(...tripFills('100', '110', 200_000 + i * 10));
    return { decisions, fills };
  }

  it('promotes the candidate when it clears the attributed-trip floor AND beats the champion mean', async () => {
    const { decisions, fills } = championAndCandidate(10);
    const h = harness({ fills, decisions, championVersion: 1 });
    const evalr = new PromotionEvaluator({ minAttributedTrades: 10, dustNotional: '5' }, h.deps);
    evalr.onClosedTrade(strategyId(SID), 13);
    await flush();
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]!.source).toBe('promotion');
    expect(h.appended[0]!.parentVersion).toBe(2);
    expect(h.outcomes).toEqual(['auto_promoted']);
  });

  it('does NOT promote below the attributed-trip floor', async () => {
    const { decisions, fills } = championAndCandidate(9); // 9 < floor 10
    const h = harness({ fills, decisions, championVersion: 1 });
    const evalr = new PromotionEvaluator({ minAttributedTrades: 10, dustNotional: '5' }, h.deps);
    evalr.onClosedTrade(strategyId(SID), 12);
    await flush();
    expect(h.appended).toHaveLength(0);
    expect(h.outcomes).toEqual([]);
  });

  it('does NOT promote a candidate whose mean does not beat the champion', async () => {
    // champion v1 WINS (buy 100 sell 110), candidate v2 loses (buy 100 sell 99).
    const decisions = [decisionRow(1, 1_000), decisionRow(2, 100_000)];
    const fills: PromotionFillRow[] = [];
    for (let i = 0; i < 3; i++) fills.push(...tripFills('100', '110', 2_000 + i * 10));
    for (let i = 0; i < 10; i++) fills.push(...tripFills('100', '99', 200_000 + i * 10));
    const h = harness({ fills, decisions, championVersion: 1 });
    const evalr = new PromotionEvaluator({ minAttributedTrades: 10, dustNotional: '5' }, h.deps);
    evalr.onClosedTrade(strategyId(SID), 13);
    await flush();
    expect(h.appended).toHaveLength(0);
  });

  it('is inert when minAttributedTrades is 0', async () => {
    const { decisions, fills } = championAndCandidate(10);
    const h = harness({ fills, decisions, championVersion: 1 });
    const evalr = new PromotionEvaluator({ minAttributedTrades: 0, dustNotional: '5' }, h.deps);
    evalr.onClosedTrade(strategyId(SID), 13);
    await flush();
    expect(h.appended).toHaveLength(0);
  });

  it('aborts when the kill switch is not RUNNING', async () => {
    const { decisions, fills } = championAndCandidate(10);
    const h = harness({ fills, decisions, championVersion: 1, killState: 'HALTED' });
    const evalr = new PromotionEvaluator({ minAttributedTrades: 10, dustNotional: '5' }, h.deps);
    evalr.onClosedTrade(strategyId(SID), 13);
    await flush();
    expect(h.appended).toHaveLength(0);
  });

  it('records promote_failed and never throws when the append fails', async () => {
    const { decisions, fills } = championAndCandidate(10);
    const h = harness({ fills, decisions, championVersion: 1, appendThrows: true });
    const evalr = new PromotionEvaluator({ minAttributedTrades: 10, dustNotional: '5' }, h.deps);
    expect(() => evalr.onClosedTrade(strategyId(SID), 13)).not.toThrow();
    await flush();
    expect(h.appended).toHaveLength(0);
    expect(h.outcomes).toEqual(['promote_failed']);
  });

  it('holds off when the champion has no attributed evidence in the window', async () => {
    // Only a v2 candidate attributes; champion v1 has no in-window trips → no comparison basis.
    const decisions = [decisionRow(2, 100_000)];
    const fills: PromotionFillRow[] = [];
    for (let i = 0; i < 10; i++) fills.push(...tripFills('100', '110', 200_000 + i * 10));
    const h = harness({ fills, decisions, championVersion: 1 });
    const evalr = new PromotionEvaluator({ minAttributedTrades: 10, dustNotional: '5' }, h.deps);
    evalr.onClosedTrade(strategyId(SID), 10);
    await flush();
    expect(h.appended).toHaveLength(0);
  });

  it('threads evidenceEpochMs into the fills read (the gate and the evaluator share one window)', async () => {
    const h = harness({ fills: [], decisions: [], championVersion: 1 });
    const seen: Array<number | undefined> = [];
    h.deps = {
      ...h.deps,
      stats: {
        fillsForMode: (_mode, sinceMs) => {
          seen.push(sinceMs);
          return Promise.resolve([]);
        },
        llmTokenTotals: () => Promise.resolve({ perModel: [] }),
      },
    };
    const evalr = new PromotionEvaluator(
      { minAttributedTrades: 10, dustNotional: '5', evidenceEpochMs: 1_752_182_760_000 },
      h.deps,
    );
    evalr.onClosedTrade(strategyId(SID), 1);
    await flush();
    expect(seen).toEqual([1_752_182_760_000]);
  });

  it('createPromotionEvaluator parses PROMOTION_EVIDENCE_EPOCH like the gate (absent ⇒ all-time)', async () => {
    const capture = () => {
      const seen: Array<number | undefined> = [];
      const h = harness({ fills: [], decisions: [], championVersion: 1 });
      const deps: PromotionEvaluatorDeps = {
        ...h.deps,
        stats: {
          fillsForMode: (_mode, sinceMs) => {
            seen.push(sinceMs);
            return Promise.resolve([]);
          },
          llmTokenTotals: () => Promise.resolve({ perModel: [] }),
        },
      };
      return { seen, deps };
    };
    const withEpoch = capture();
    createPromotionEvaluator(
      {
        AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES: '10',
        PROMOTION_EVIDENCE_EPOCH: '2026-07-10T20:26:00Z',
      },
      withEpoch.deps,
    ).onClosedTrade(strategyId(SID), 1);
    const without = capture();
    createPromotionEvaluator(
      { AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES: '10' },
      without.deps,
    ).onClosedTrade(strategyId(SID), 1);
    await flush();
    expect(withEpoch.seen).toEqual([Date.parse('2026-07-10T20:26:00Z')]);
    expect(without.seen).toEqual([undefined]);
  });
});
