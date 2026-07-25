import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  PromotionEvaluator,
  createPromotionEvaluator,
  probabilityOfSuperiority,
  pairedComparison,
  type EvaluatorPlaybookStore,
  type PromotionEvaluatorDeps,
} from '../../../../src/features/strategy/agentic/promotion-evaluator';
import type { PromotionFillRow, PromotionStatsPort } from '../../../../src/ports/trading/promotion';
import type {
  AgentDecisionRow,
  AgentDecisionJournalPort,
} from '../../../../src/ports/strategy/agentic-strategy';
import type { KillSwitchPort } from '../../../../src/ports/trading/risk';
import { strategyId, epochMs } from '../../../../src/domain/common/types/ids';

const SID = 'agentic-1';
// backlog #48: two shared symbols so the happy-path fixtures clear MIN_SHARED_SYMBOLS (2) while
// exercising the paired (per-symbol) comparison rather than a single-symbol pool.
const SYM_A = 'BTC/USDT';
const SYM_B = 'ETH/USDT';
const SYM = SYM_A; // legacy single-symbol alias for tests that only care about journal plumbing.

// A closed round trip = a BUY then a SELL of equal qty at the given prices; realized = (sell−buy)×qty.
// qty 1 (notional ~100 ≫ the 5 dust threshold) so a single fill never dust-closes on its own — the
// cycle closes only when the buy+sell net to flat, i.e. one cycle per pair.
function tripFills(
  symbol: string,
  buyPrice: string,
  sellPrice: string,
  at: number,
): PromotionFillRow[] {
  return [
    {
      strategyId: SID,
      symbol,
      side: 'BUY',
      qty: '1',
      price: buyPrice,
      fee: null,
      feeAsset: null,
      executedAt: at,
    },
    {
      strategyId: SID,
      symbol,
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
function decisionRow(symbol: string, version: number, at: number): AgentDecisionRow {
  return {
    id: `d-${version}-${symbol}-${at}`,
    createdAt: epochMs(at),
    strategyId: strategyId(SID),
    symbol: symbol as unknown as AgentDecisionRow['symbol'],
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

describe('PromotionEvaluator (W5 attributed auto-promotion, paired per backlog #48)', () => {
  // Champion v1 with `championTrips` losing trips per symbol on SYM_A + SYM_B (symmetric floor
  // needs champion n ≥ floor too), candidate v2 with `candidateTrips` winning trips split evenly
  // across the SAME two symbols — candidate wins every pairwise comparison on each shared symbol
  // (PoS = 1.0). Both symbols always clear MIN_PAIRED_TRIPS (3) at the trip counts these tests use.
  function championAndCandidate(candidateTrips: number, championTripsPerSymbol = 5) {
    const decisions = [
      decisionRow(SYM_A, 1, 1_000),
      decisionRow(SYM_B, 1, 1_000),
      decisionRow(SYM_A, 2, 100_000),
      decisionRow(SYM_B, 2, 100_000),
    ];
    const fills: PromotionFillRow[] = [];
    for (const sym of [SYM_A, SYM_B]) {
      for (let i = 0; i < championTripsPerSymbol; i++) {
        fills.push(...tripFills(sym, '100', '99', 2_000 + i * 10));
      }
    }
    const perSymbol = [Math.ceil(candidateTrips / 2), Math.floor(candidateTrips / 2)];
    [SYM_A, SYM_B].forEach((sym, idx) => {
      for (let i = 0; i < perSymbol[idx]!; i++) {
        fills.push(...tripFills(sym, '100', '110', 200_000 + i * 10));
      }
    });
    return { decisions, fills };
  }

  const CFG = { minAttributedTrades: 10, minPos: 0.7, dustNotional: '5' };

  it('promotes the candidate when it clears the paired floors AND beats the champion (mean + PoS) on the shared basket', async () => {
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

  it('does NOT promote below the paired attributed-trip floor even with a qualifying shared basket', async () => {
    const { decisions, fills } = championAndCandidate(9); // 9 < floor 10, split 5+4 across SYM_A/SYM_B
    const h = harness({ fills, decisions, championVersion: 1 });
    const evalr = new PromotionEvaluator(CFG, h.deps);
    evalr.onClosedTrade(strategyId(SID), 19);
    await flush();
    expect(h.appended).toHaveLength(0);
    expect(h.outcomes).toEqual([]);
  });

  it('does NOT promote a candidate whose paired mean does not beat the champion on the shared basket', async () => {
    // champion v1 WINS on both shared symbols (buy 100 sell 110), candidate v2 loses on both
    // (buy 100 sell 99).
    const decisions = [
      decisionRow(SYM_A, 1, 1_000),
      decisionRow(SYM_B, 1, 1_000),
      decisionRow(SYM_A, 2, 100_000),
      decisionRow(SYM_B, 2, 100_000),
    ];
    const fills: PromotionFillRow[] = [];
    for (const sym of [SYM_A, SYM_B]) {
      for (let i = 0; i < 5; i++) fills.push(...tripFills(sym, '100', '110', 2_000 + i * 10));
      for (let i = 0; i < 5; i++) fills.push(...tripFills(sym, '100', '99', 200_000 + i * 10));
    }
    const h = harness({ fills, decisions, championVersion: 1 });
    const evalr = new PromotionEvaluator(CFG, h.deps);
    evalr.onClosedTrade(strategyId(SID), 20);
    await flush();
    expect(h.appended).toHaveLength(0);
  });

  it('symmetric floor: does NOT promote while both versions share ≥2 symbols but the paired trip total stays below the floor', async () => {
    // Champion and candidate share SYM_A + SYM_B (each leg clears the per-symbol MIN_PAIRED_TRIPS
    // floor of 3) but only 3 trips/symbol ⇒ 6 paired trips total, below the 10 floor — the
    // pre-#48 evaluator's symmetric floor concept, now measured over the paired pool instead of
    // the whole-basket pool.
    const decisions = [
      decisionRow(SYM_A, 1, 1_000),
      decisionRow(SYM_B, 1, 1_000),
      decisionRow(SYM_A, 2, 100_000),
      decisionRow(SYM_B, 2, 100_000),
    ];
    const fills: PromotionFillRow[] = [];
    for (const sym of [SYM_A, SYM_B]) {
      for (let i = 0; i < 3; i++) fills.push(...tripFills(sym, '100', '99', 2_000 + i * 10));
      for (let i = 0; i < 3; i++) fills.push(...tripFills(sym, '100', '110', 200_000 + i * 10));
    }
    const h = harness({ fills, decisions, championVersion: 1 });
    const evalr = new PromotionEvaluator(CFG, h.deps);
    evalr.onClosedTrade(strategyId(SID), 12);
    await flush();
    expect(h.appended).toHaveLength(0);
    expect(h.outcomes).toEqual([]);
  });

  it('backlog #48 confound: a candidate that only looks better because it traded a wholly different (easier) basket does NOT promote', async () => {
    // Champion trades ONLY SYM_A (10 losing trips); candidate trades ONLY SYM_B (10 winning
    // trips) — zero shared symbols. The pre-#48 pooled comparison would have promoted this
    // (candidate mean/PoS both look perfect); the paired comparison correctly refuses because
    // there is no overlapping basket to attribute the "edge" to.
    const decisions = [decisionRow(SYM_A, 1, 1_000), decisionRow(SYM_B, 2, 100_000)];
    const fills: PromotionFillRow[] = [];
    for (let i = 0; i < 10; i++) fills.push(...tripFills(SYM_A, '100', '99', 2_000 + i * 10));
    for (let i = 0; i < 10; i++) fills.push(...tripFills(SYM_B, '100', '110', 200_000 + i * 10));
    const h = harness({ fills, decisions, championVersion: 1 });
    const evalr = new PromotionEvaluator(CFG, h.deps);
    evalr.onClosedTrade(strategyId(SID), 20);
    await flush();
    expect(h.appended).toHaveLength(0);
    expect(h.outcomes).toEqual([]);
  });

  it('below-MIN_SHARED_SYMBOLS fails closed: exactly one shared symbol is not enough even though it favors the candidate', async () => {
    // Champion trades SYM_A (losing) + a unique SYM_C (losing); candidate trades SYM_A (winning)
    // + a unique SYM_D (winning). SYM_A alone is shared (1 < MIN_SHARED_SYMBOLS 2) — fails closed,
    // never falls back to a single-symbol comparison.
    const SYM_C = 'SOL/USDT';
    const SYM_D = 'XRP/USDT';
    const decisions = [
      decisionRow(SYM_A, 1, 1_000),
      decisionRow(SYM_C, 1, 1_000),
      decisionRow(SYM_A, 2, 100_000),
      decisionRow(SYM_D, 2, 100_000),
    ];
    const fills: PromotionFillRow[] = [];
    for (let i = 0; i < 10; i++) fills.push(...tripFills(SYM_A, '100', '99', 2_000 + i * 10));
    for (let i = 0; i < 10; i++) fills.push(...tripFills(SYM_C, '100', '99', 2_500 + i * 10));
    for (let i = 0; i < 10; i++) fills.push(...tripFills(SYM_A, '100', '110', 200_000 + i * 10));
    for (let i = 0; i < 10; i++) fills.push(...tripFills(SYM_D, '100', '110', 200_500 + i * 10));
    const h = harness({ fills, decisions, championVersion: 1 });
    const evalr = new PromotionEvaluator(CFG, h.deps);
    evalr.onClosedTrade(strategyId(SID), 40);
    await flush();
    expect(h.appended).toHaveLength(0);
  });

  it('PoS floor: does NOT promote a paired mean carried by one outlier trip that loses most pairwise comparisons on its own symbol', async () => {
    // SYM_A: champion 5 losing trips (net −1 each); candidate 4 trips at net −2 + 1 outlier at
    // net +100. SYM_B: champion 5 losing trips (net −1 each); candidate 5 trips at net −2.
    // Paired PoS = 5 wins / 50 pairs = 0.10 (the outlier only ever beats SYM_A's champion trips);
    // paired mean = 8.2 for the candidate vs −1.0 for champion — mean would promote, PoS holds it.
    const decisions = [
      decisionRow(SYM_A, 1, 1_000),
      decisionRow(SYM_B, 1, 1_000),
      decisionRow(SYM_A, 2, 100_000),
      decisionRow(SYM_B, 2, 100_000),
    ];
    const fills: PromotionFillRow[] = [];
    for (const sym of [SYM_A, SYM_B]) {
      for (let i = 0; i < 5; i++) fills.push(...tripFills(sym, '100', '99', 2_000 + i * 10));
    }
    for (let i = 0; i < 4; i++) fills.push(...tripFills(SYM_A, '100', '98', 200_000 + i * 10));
    fills.push(...tripFills(SYM_A, '100', '200', 200_100));
    for (let i = 0; i < 5; i++) fills.push(...tripFills(SYM_B, '100', '98', 200_200 + i * 10));
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
    const decisions = [decisionRow(SYM, 2, 100_000)];
    const fills: PromotionFillRow[] = [];
    for (let i = 0; i < 10; i++) fills.push(...tripFills(SYM, '100', '110', 200_000 + i * 10));
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

  describe('pairedComparison (backlog #48)', () => {
    const dec = (vals: string[]) => vals.map((v) => new Decimal(v));

    it('returns null (fail closed) below MIN_SHARED_SYMBOLS even with ample per-symbol trips', () => {
      const candidate = { bySymbol: new Map([[SYM_A, dec(['1', '1', '1'])]]) };
      const champion = { bySymbol: new Map([[SYM_A, dec(['-1', '-1', '-1'])]]) };
      expect(pairedComparison(candidate, champion)).toBeNull();
    });

    it('excludes a shared symbol below MIN_PAIRED_TRIPS from the shared-symbol count', () => {
      const candidate = {
        bySymbol: new Map([
          [SYM_A, dec(['1', '1'])], // 2 < MIN_PAIRED_TRIPS (3) — excluded
          [SYM_B, dec(['1', '1', '1'])],
        ]),
      };
      const champion = {
        bySymbol: new Map([
          [SYM_A, dec(['-1', '-1', '-1'])],
          [SYM_B, dec(['-1', '-1', '-1'])],
        ]),
      };
      // Only SYM_B clears the per-symbol floor ⇒ 1 shared symbol < MIN_SHARED_SYMBOLS (2).
      expect(pairedComparison(candidate, champion)).toBeNull();
    });

    it('aggregates wins/pairs across qualifying shared symbols only', () => {
      const candidate = {
        bySymbol: new Map([
          [SYM_A, dec(['1', '1', '1'])],
          [SYM_B, dec(['1', '1', '1'])],
          ['UNSHARED/USDT', dec(['999', '999', '999'])], // not in champion — never counted
        ]),
      };
      const champion = {
        bySymbol: new Map([
          [SYM_A, dec(['-1', '-1', '-1'])],
          [SYM_B, dec(['-1', '-1', '-1'])],
        ]),
      };
      const verdict = pairedComparison(candidate, champion);
      expect(verdict).not.toBeNull();
      expect([...verdict!.sharedSymbols].sort()).toEqual([SYM_A, SYM_B].sort());
      expect(verdict!.candidateTrips).toBe(6);
      expect(verdict!.championTrips).toBe(6);
      expect(verdict!.pos.toFixed(1)).toBe('1.0'); // candidate wins every same-symbol pair
      expect(verdict!.candidateMean.toFixed(1)).toBe('1.0');
      expect(verdict!.championMean.toFixed(1)).toBe('-1.0');
    });
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
