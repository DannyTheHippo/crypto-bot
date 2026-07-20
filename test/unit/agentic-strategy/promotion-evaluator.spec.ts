import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  PromotionEvaluator,
  createPromotionEvaluator,
  probabilityOfSuperiority,
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
    action: 'open_long',
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
  // Champion v1 with 10 losing trips (symmetric floor needs champion n ≥ floor too), candidate v2
  // with `candidateTrips` winning trips — candidate wins every pairwise comparison (PoS = 1.0).
  function championAndCandidate(candidateTrips: number) {
    const decisions = [decisionRow(1, 1_000), decisionRow(2, 100_000)];
    const fills: PromotionFillRow[] = [];
    // champion v1: 10 trips opened just after the v1 decision, each losing (buy 100 sell 99).
    for (let i = 0; i < 10; i++) fills.push(...tripFills('100', '99', 2_000 + i * 10));
    // candidate v2: `candidateTrips` trips opened after the v2 decision, each winning (buy 100 sell 110).
    for (let i = 0; i < candidateTrips; i++)
      fills.push(...tripFills('100', '110', 200_000 + i * 10));
    return { decisions, fills };
  }

  const CFG = { minAttributedTrades: 10, minPos: 0.7, dustNotional: '5' };

  it('promotes the candidate when it clears the floors AND beats the champion (mean + PoS)', async () => {
    const { decisions, fills } = championAndCandidate(10);
    const h = harness({ fills, decisions, championVersion: 1 });
    const evalr = new PromotionEvaluator(CFG, h.deps);
    evalr.onClosedTrade(strategyId(SID), 20);
    await flush();
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]!.source).toBe('promotion');
    expect(h.appended[0]!.parentVersion).toBe(2);
    expect(h.outcomes).toEqual(['auto_promoted']);
  });

  it('does NOT promote below the attributed-trip floor', async () => {
    const { decisions, fills } = championAndCandidate(9); // 9 < floor 10
    const h = harness({ fills, decisions, championVersion: 1 });
    const evalr = new PromotionEvaluator(CFG, h.deps);
    evalr.onClosedTrade(strategyId(SID), 19);
    await flush();
    expect(h.appended).toHaveLength(0);
    expect(h.outcomes).toEqual([]);
  });

  it('does NOT promote a candidate whose mean does not beat the champion', async () => {
    // champion v1 WINS (buy 100 sell 110), candidate v2 loses (buy 100 sell 99).
    const decisions = [decisionRow(1, 1_000), decisionRow(2, 100_000)];
    const fills: PromotionFillRow[] = [];
    for (let i = 0; i < 10; i++) fills.push(...tripFills('100', '110', 2_000 + i * 10));
    for (let i = 0; i < 10; i++) fills.push(...tripFills('100', '99', 200_000 + i * 10));
    const h = harness({ fills, decisions, championVersion: 1 });
    const evalr = new PromotionEvaluator(CFG, h.deps);
    evalr.onClosedTrade(strategyId(SID), 20);
    await flush();
    expect(h.appended).toHaveLength(0);
  });

  it('symmetric floor: does NOT promote while the champion has fewer in-window trips than the floor', async () => {
    // Champion v1 has only 3 trips (< 10); candidate v2 has 10 clean wins. The pre-2026-07-12
    // evaluator promoted here (champion floor was trips > 0) — the symmetric floor holds instead.
    const decisions = [decisionRow(1, 1_000), decisionRow(2, 100_000)];
    const fills: PromotionFillRow[] = [];
    for (let i = 0; i < 3; i++) fills.push(...tripFills('100', '99', 2_000 + i * 10));
    for (let i = 0; i < 10; i++) fills.push(...tripFills('100', '110', 200_000 + i * 10));
    const h = harness({ fills, decisions, championVersion: 1 });
    const evalr = new PromotionEvaluator(CFG, h.deps);
    evalr.onClosedTrade(strategyId(SID), 13);
    await flush();
    expect(h.appended).toHaveLength(0);
    expect(h.outcomes).toEqual([]);
  });

  it('PoS floor: does NOT promote a mean carried by one outlier trip that loses most pairwise comparisons', async () => {
    // Candidate: 9 trips at −2 and one at +100 ⇒ mean +8.2 beats champion mean −1, but PoS is
    // 10/100 = 0.10 — the bare mean comparison would have promoted this; the rank floor holds.
    const decisions = [decisionRow(1, 1_000), decisionRow(2, 100_000)];
    const fills: PromotionFillRow[] = [];
    for (let i = 0; i < 10; i++) fills.push(...tripFills('100', '99', 2_000 + i * 10));
    for (let i = 0; i < 9; i++) fills.push(...tripFills('100', '98', 200_000 + i * 10));
    fills.push(...tripFills('100', '200', 201_000));
    const h = harness({ fills, decisions, championVersion: 1 });
    const evalr = new PromotionEvaluator(CFG, h.deps);
    evalr.onClosedTrade(strategyId(SID), 20);
    await flush();
    expect(h.appended).toHaveLength(0);
  });

  it('reads the champion identity via the unrouted active() when the store provides it', async () => {
    // current() lies (serves the A/B candidate v2, the routed read); active() tells the truth (v1).
    // A current()-based champion identity would self-exclude v2 (version <= champion) and no-op.
    const { decisions, fills } = championAndCandidate(10);
    const h = harness({ fills, decisions, championVersion: 1 });
    const store = h.deps.playbookStore!;
    h.deps = {
      ...h.deps,
      playbookStore: {
        ...store,
        current: () => Promise.resolve({ version: 2, content: 'candidate content' }),
        active: () => Promise.resolve({ version: 1, content: 'champion content' }),
      },
    };
    const evalr = new PromotionEvaluator(CFG, h.deps);
    evalr.onClosedTrade(strategyId(SID), 20);
    await flush();
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]!.parentVersion).toBe(2);
  });

  it('is inert when minAttributedTrades is 0', async () => {
    const { decisions, fills } = championAndCandidate(10);
    const h = harness({ fills, decisions, championVersion: 1 });
    const evalr = new PromotionEvaluator({ ...CFG, minAttributedTrades: 0 }, h.deps);
    evalr.onClosedTrade(strategyId(SID), 20);
    await flush();
    expect(h.appended).toHaveLength(0);
  });

  it('aborts when the kill switch is not RUNNING', async () => {
    const { decisions, fills } = championAndCandidate(10);
    const h = harness({ fills, decisions, championVersion: 1, killState: 'HALTED' });
    const evalr = new PromotionEvaluator(CFG, h.deps);
    evalr.onClosedTrade(strategyId(SID), 20);
    await flush();
    expect(h.appended).toHaveLength(0);
  });

  it('records promote_failed and never throws when the append fails', async () => {
    const { decisions, fills } = championAndCandidate(10);
    const h = harness({ fills, decisions, championVersion: 1, appendThrows: true });
    const evalr = new PromotionEvaluator(CFG, h.deps);
    expect(() => evalr.onClosedTrade(strategyId(SID), 20)).not.toThrow();
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
    const evalr = new PromotionEvaluator(CFG, h.deps);
    evalr.onClosedTrade(strategyId(SID), 10);
    await flush();
    expect(h.appended).toHaveLength(0);
  });

  it('prefers the versioned attribution read when the journal provides it (a NULL-row flood must not starve attribution)', async () => {
    // Regression pin (2026-07-18): the shared recent(2000) window shrank to ~3 days once quiet
    // NULL-version rows dominated the journal — versioned entry decides scrolled out and every
    // trip attributed 'unknown', making the symmetric floors unreachable. recent() returning
    // NOTHING here proves attribution came from recentVersioned alone.
    const { decisions, fills } = championAndCandidate(10);
    const calls: Array<{ limit: number; sinceMs: number | undefined }> = [];
    const h = harness({ fills, decisions: [], championVersion: 1 });
    h.deps = {
      ...h.deps,
      journal: {
        record: () => undefined,
        recent: () => Promise.resolve([]),
        recentVersioned: (limit, sinceMs) => {
          calls.push({ limit, sinceMs });
          return Promise.resolve(decisions);
        },
      },
    };
    const evalr = new PromotionEvaluator({ ...CFG, evidenceEpochMs: 200_000_000 }, h.deps);
    evalr.onClosedTrade(strategyId(SID), 20);
    await flush();
    expect(h.appended).toHaveLength(1);
    // Cap + epoch-margin contract: versioned cap 20k, sinceMs = epoch − 24h decide margin.
    expect(calls).toEqual([{ limit: 20_000, sinceMs: 200_000_000 - 24 * 60 * 60 * 1000 }]);
  });

  it('recentVersioned gets an unbounded sinceMs when no evidence epoch is configured', async () => {
    const { decisions, fills } = championAndCandidate(10);
    const calls: Array<{ limit: number; sinceMs: number | undefined }> = [];
    const h = harness({ fills, decisions: [], championVersion: 1 });
    h.deps = {
      ...h.deps,
      journal: {
        record: () => undefined,
        recent: () => Promise.resolve([]),
        recentVersioned: (limit, sinceMs) => {
          calls.push({ limit, sinceMs });
          return Promise.resolve(decisions);
        },
      },
    };
    const evalr = new PromotionEvaluator(CFG, h.deps);
    evalr.onClosedTrade(strategyId(SID), 20);
    await flush();
    expect(h.appended).toHaveLength(1);
    expect(calls).toEqual([{ limit: 20_000, sinceMs: undefined }]);
  });

  it('probabilityOfSuperiority: pairwise wins with ties counted half', () => {
    const dec = (vals: string[]) => vals.map((v) => new Decimal(v));
    // (1v1 tie .5) + (1v0 win) + (2v1 win) + (2v0 win) = 3.5 of 4 pairs.
    expect(probabilityOfSuperiority(dec(['1', '2']), dec(['1', '0'])).toFixed(4)).toBe('0.8750');
    expect(probabilityOfSuperiority(dec(['5']), dec(['5'])).toFixed(1)).toBe('0.5');
    expect(probabilityOfSuperiority(dec(['-1']), dec(['1'])).toFixed(1)).toBe('0.0');
  });

  it('createPromotionEvaluator parses AGENTIC_PROMOTE_MIN_POS and clamps it to [0.5, 1]', async () => {
    // A permissive 0.05 clamps to 0.5; championAndCandidate(10) has PoS 1.0 so it promotes either
    // way — the observable is that a malformed/low value never crashes construction or evaluation.
    const { decisions, fills } = championAndCandidate(10);
    for (const raw of ['0.05', 'garbage', undefined]) {
      const h = harness({ fills, decisions, championVersion: 1 });
      const env: Record<string, string | undefined> = {
        AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES: '10',
        ...(raw !== undefined ? { AGENTIC_PROMOTE_MIN_POS: raw } : {}),
      };
      createPromotionEvaluator(env, h.deps).onClosedTrade(strategyId(SID), 20);
      await flush();
      expect(h.appended).toHaveLength(1);
    }
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
    const evalr = new PromotionEvaluator({ ...CFG, evidenceEpochMs: 1_752_182_760_000 }, h.deps);
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
