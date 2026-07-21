// R1 historical-replay PRACTICE HARNESS — the v2-decision-contract replay engine (`pnpm
// replay:agentic`). RESEARCH TOOLING (test/backtest/, off the production test gate — same location and
// gating discipline as agentic-replay.ts, this program's sibling), but UNLIKE agentic-replay.ts it
// journals its synthetic decisions into the SHARED agent_decisions journal so reflection can learn
// from replayed experience. Every synthetic row is written under a `replay-<runId>` strategyId (see
// REPLAY_STRATEGY_ID_PREFIX) so it never touches promotion evidence or cost accounting — see the
// exclusion map in this file's runAgenticReplayR1 header.
//
// ORCHESTRATION SPLIT with agentic-replay.ts: that module is the LEGACY plan-mode (submit_plan)
// OHLCV-only walk-forward scorecard backtest; THIS module drives the LIVE v2 rich decision contract
// (submit_trade) over historical candles, reusing production's OWN replay seams rather than
// re-deriving them —
//   • DECIDE: entry-rate-floor.ts's replayPlanRow (R8-8 lesson: the decide model is pinned via
//     cfg.model, the exact field the live decide path threads AGENTIC_MODEL through — so a replay can
//     never silently bill a different model than the one under study).
//   • FILL: candidate-backtest.ts's simulateRoundTrip (plan-executor.ts's evaluatePlan walked over the
//     forward closes, net of a round-trip fee) — reused verbatim rather than inventing a second fill
//     model.
//   • BUDGET: agent-budget.ts's AttemptScopedBudget (XA2) — the per-run USD cap aborts BEFORE the
//     breaching decide via a pre-call tryReserveCall() reservation, never after the spend has already
//     landed.
//
// TRAINING-CUTOFF FLOOR: mirrors agentic-replay.ts's EARLIEST_ALLOWED_MS (2026-02-01) — the same
// memorization-confound guard; runAgenticReplayR1 refuses if the first supplied bar predates it.
import Decimal from 'decimal.js';
import { setupDecimal, toIndicatorNumber, price, qty } from '../../src/domain/types/money';
import {
  emaFromNumbers,
  rsiFromNumbers,
  atrFromNumbers,
  pctChange,
} from '../../src/domain/indicators/indicators';
import { aggregateCandles } from '../../src/domain/indicators/candle-aggregate';
import { epochMs, symbolId, venueId, strategyId, type SymbolId } from '../../src/domain/types/ids';
import type { CandleEvent, CandleInterval } from '../../src/domain/types/market-events';
import type {
  AgentDecisionInput,
  AgentDecisionJournalPort,
  AgentDirectives,
  AgentIndicators,
  AgentHtfIndicators,
  AgentPositionSummary,
  AgentTradingProfile,
} from '../../src/ports/agentic-strategy';
import { REPLAY_STRATEGY_ID_PREFIX } from '../../src/ports/agentic-strategy';
import {
  buildSystemPrompt,
  buildMarketPayload,
  buildPlaybookBlock,
} from '../../src/features/trading/agentic/agent-prompt';
import {
  replayPlanRow,
  DEFAULT_FLOOR_PROFILE,
} from '../../src/features/trading/agentic/entry-rate-floor';
import { simulateRoundTrip } from '../../src/features/trading/agentic/candidate-backtest';
import {
  AttemptScopedBudget,
  DailyLlmBudget,
} from '../../src/features/trading/agentic/agent-budget';
import type { Bar } from './harness';

setupDecimal(); // production Decimal config (precision 40, ROUND_HALF_EVEN) — mirrors agentic-replay.ts

export const EARLIEST_ALLOWED_ISO = '2026-02-01T00:00:00.000Z';
export const EARLIEST_ALLOWED_MS = Date.parse(EARLIEST_ALLOWED_ISO);

// $/MTok — Sonnet-5 rates (input 3, output 15, cache read 0.3, cache write 6); used to PRICE the
// per-run budget so the USD cap actually meters spend (an unpriced DailyLlmBudget would leave costUsd
// at 0 and never trip the cap). Matches agentic-replay.ts's RATES_USD_PER_MTOK.
const RATE_INPUT = 3;
const RATE_OUTPUT = 15;
const RATE_CACHE_READ = 0.3;
const RATE_CACHE_WRITE = 6;

// Mirrors agentic.strategy.ts / agentic-replay.ts local constants so indicators/htf are computed
// identically to production — re-check on any drift there.
const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};
const HTF_TARGET_MS: Record<'h1' | 'h4', number> = { h1: 3_600_000, h4: 14_400_000 };
const INDICATOR_WARMUP_CLOSES = 21;

const FLAT_POSITION_SUMMARY: AgentPositionSummary = {
  side: 'FLAT',
  qty: '0',
  avgEntry: null,
  realizedPnl: '0',
  unrealizedPnlPct: null,
  openOrders: 0,
};

export interface AgenticReplayR1Opts {
  // Distinguishes this run's synthetic rows in the shared journal — the strategyId becomes
  // `replay-<runId>` (see REPLAY_STRATEGY_ID_PREFIX). Caller supplies a collision-free token.
  readonly runId: string;
  readonly symbol: string;
  readonly venue?: string; // default 'binance' — cosmetic CandleEvent envelope field
  readonly interval: CandleInterval;
  // Already sliced to the caller's window; runAgenticReplayR1 refuses if bars[0] predates the floor.
  readonly bars: readonly Bar[];
  readonly playbookContent: string;
  // The DECIDE model — threaded into replayPlanRow's cfg.model, the exact field the live decide path
  // pins AGENTIC_MODEL through (R8-8). Defaults to AGENTIC_MODEL at the CLI, never here.
  readonly model: string;
  readonly apiKey: string;
  // Hard per-run USD budget — REQUIRED, enforced by the AttemptScopedBudget pre-call reservation.
  readonly maxUsd: string;
  // Coarse call-count safety ceiling on top of the USD cap (default 100_000). The USD cap is the real
  // limiter; this just bounds a pathological zero-cost fetch stub in a test.
  readonly maxCalls?: number;
  readonly shortsEnabled?: boolean; // perp lane — selects the shorts-capable v2 tool/schema
  readonly sizeFractionMax?: string; // default '0.5' — the v2 lane cap (AGENTIC_MAX_POSITION_FRACTION)
  readonly timeoutMs?: number; // default 30_000 — per-decide transport timeout
  // The synthetic-experience sink: every replayed decision is journaled here under `replay-<runId>`.
  // In-memory for the CI-safe dry run; the DB adapter for a real (paid) run.
  readonly journal: AgentDecisionJournalPort;
  // Injectable — the dry-run/fixture path supplies a scripted stub so this module never needs a real
  // network call or API key (mirrors replayPlanRow's own fetchFn param).
  readonly fetchFn?: typeof fetch;
}

export interface AgenticReplayR1Report {
  readonly runId: string;
  readonly strategyId: string; // `replay-<runId>`
  readonly symbol: string;
  readonly interval: CandleInterval;
  readonly model: string;
  readonly barsSupplied: number;
  readonly barsUsed: number; // bars walked before completion/abort
  readonly decisionsRequested: number; // decide calls actually made
  readonly decisionsJournaled: number; // rows written to the synthetic journal
  readonly entries: number; // open_long/open_short decisions
  readonly simulatedRoundTrips: number; // entries with enough forward closes to price (RUN REPORT only)
  readonly unsimulatableEntries: number;
  readonly meanNetBps: number; // 0 when simulatedRoundTrips is 0 (never NaN)
  readonly spendUsd: string;
  readonly maxUsd: string;
  readonly aborted: boolean;
  readonly abortReason: 'ABORTED_BUDGET' | null;
}

function computeIndicators(
  closes: readonly number[],
  highs: readonly number[],
  lows: readonly number[],
): AgentIndicators | null {
  if (closes.length < INDICATOR_WARMUP_CLOSES) return null;
  return {
    lastClose: closes[closes.length - 1]!,
    emaFast: emaFromNumbers(closes, 9),
    emaSlow: emaFromNumbers(closes, 21),
    rsi14: rsiFromNumbers(closes, 14),
    atr14: atrFromNumbers(highs, lows, closes, 14),
    ret1: pctChange(closes, 1),
    ret5: pctChange(closes, 5),
    ret20: pctChange(closes, 20),
  };
}

function buildHtfIndicators(
  candles: readonly CandleEvent[],
  targetMs: number,
  baseIntervalMs: number,
): AgentHtfIndicators | null {
  const factor = targetMs / baseIntervalMs;
  if (!Number.isInteger(factor) || factor < 2) return null;
  const htfCandles = aggregateCandles(candles, factor, baseIntervalMs).filter((c) => c.closed);
  if (htfCandles.length < INDICATOR_WARMUP_CLOSES) return null;
  const closes = htfCandles.map((c) => toIndicatorNumber(c.close));
  return {
    emaFast: emaFromNumbers(closes, 9),
    emaSlow: emaFromNumbers(closes, 21),
    rsi14: rsiFromNumbers(closes, 14),
  };
}

function toCandleEvent(
  bar: Bar,
  index: number,
  symbol: SymbolId,
  venue: ReturnType<typeof venueId>,
  interval: CandleInterval,
  intervalMs: number,
): CandleEvent {
  const openTime = epochMs(bar[0]!);
  return {
    kind: 'CANDLE',
    venue,
    symbol,
    channel: `candle:${interval}`,
    seq: BigInt(index + 1),
    eventTime: openTime,
    ingestTime: openTime,
    interval,
    openTime,
    closeTime: epochMs(bar[0]! + intervalMs),
    open: price(new Decimal(bar[1]!)),
    high: price(new Decimal(bar[2]!)),
    low: price(new Decimal(bar[3]!)),
    close: price(new Decimal(bar[4]!)),
    volume: qty(new Decimal(bar[5] ?? 0)),
    closed: true,
  };
}

// The illustrative fee/constraint profile the v2 replay's system prompt renders — the same structural
// question entry-rate-floor.ts's DEFAULT_FLOOR_PROFILE asks ("does this playbook enter here"), reused
// so the replay's prompt is byte-identical to the floor's own.
const REPLAY_PROFILE: AgentTradingProfile = DEFAULT_FLOOR_PROFILE;

// ── Main entry point ──────────────────────────────────────────────────────────
//
// EXCLUSION MAP (why a replay run never poisons promotion evidence or cost accounting):
//   • promotion stats / round-trip evidence / version-pnl digest — BY CONSTRUCTION: this engine
//     writes NO fills and NO llm_usage rows; those readers walk fills (+ reflection llm_usage) only.
//   • exec-quality windows — BY CONSTRUCTION: fed exclusively by the host's recordEntryAttempt seam,
//     never touched here.
//   • llmTokenTotals(epoch) + the lane-wide mint-floor recent() read — BY FILTER on the
//     `replay-<runId>` strategyId prefix (PromotionStatsRepository.llmTokenTotals /
//     AgentDecisionRepository.selectRecent — see REPLAY_STRATEGY_ID_PREFIX).
//   • the per-strategy reflection digest read (recent(realStrategyId)) — BY CONSTRUCTION: a real
//     strategyId never carries the prefix.
// The ONLY read that surfaces these rows is journal.recentSynthetic(), and reflection consults it
// only under an explicit opt-in (default OFF).
export async function runAgenticReplayR1(
  opts: AgenticReplayR1Opts,
): Promise<AgenticReplayR1Report> {
  const bars = opts.bars;
  if (bars.length === 0) throw new Error('runAgenticReplayR1: no bars supplied');
  const firstBarTs = bars[0]?.[0];
  if (firstBarTs === undefined) throw new Error('runAgenticReplayR1: first bar has no timestamp');
  if (firstBarTs < EARLIEST_ALLOWED_MS) {
    throw new Error(
      `runAgenticReplayR1: first bar (${new Date(firstBarTs).toISOString()}) precedes the ` +
        `training-cutoff floor ${EARLIEST_ALLOWED_ISO} — refusing (memorization confound)`,
    );
  }

  const runStrategyId = `${REPLAY_STRATEGY_ID_PREFIX}${opts.runId}`;
  const venue = venueId(opts.venue ?? 'binance');
  const symbol = symbolId(opts.symbol);
  const sId = strategyId(runStrategyId);
  const intervalMs = INTERVAL_MS[opts.interval];
  const fetchFn = opts.fetchFn ?? fetch;
  const sizeFractionMax = opts.sizeFractionMax ?? '0.5';
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxCalls = opts.maxCalls ?? 100_000;

  // Per-run budget: a priced DailyLlmBudget (so costUsd meters real spend) wrapped by an
  // AttemptScopedBudget whose USD cap IS the run cap. tryReserveCall() below is the PRE-CALL
  // reservation — it returns false once recorded spend has reached the cap, aborting before the next
  // decide fires (never after).
  const maxUsdNum = new Decimal(opts.maxUsd).toNumber();
  const dailyBudget = new DailyLlmBudget({
    maxCallsPerDay: Number.MAX_SAFE_INTEGER,
    maxTokensPerDay: Number.MAX_SAFE_INTEGER,
    maxCostUsdPerDay: maxUsdNum,
    priceInputPerMtok: RATE_INPUT,
    priceOutputPerMtok: RATE_OUTPUT,
    priceCacheReadPerMtok: RATE_CACHE_READ,
    priceCacheWritePerMtok: RATE_CACHE_WRITE,
  });
  const budget = new AttemptScopedBudget(dailyBudget, maxCalls, maxUsdNum);

  // v3 consolidation spec §4.4: buildSystemPrompt always builds the rich-decision-contract prompt —
  // shorts documented unconditionally, no more tradeContract/shortsEnabled options.
  const systemPrompt = buildSystemPrompt(REPLAY_PROFILE);
  const playbookBlock = buildPlaybookBlock(opts.playbookContent);
  const constraints = REPLAY_PROFILE.constraints;

  const candles: CandleEvent[] = [];
  let decisionsRequested = 0;
  let decisionsJournaled = 0;
  let entries = 0;
  let simulatedRoundTrips = 0;
  let unsimulatableEntries = 0;
  let totalNetBps = 0;
  let aborted = false;

  // Closes for the fill-model forward walk (candidate-backtest.simulateRoundTrip). Precomputed once —
  // every bar's forward path is a tail slice of this array.
  const allCloses = bars.map((b) => new Decimal(b[4]!).toFixed());

  let i = 0;
  for (; i < bars.length; i++) {
    // PRE-CALL reservation: abort BEFORE spending the next decide once the run cap is reached.
    if (!budget.tryReserveCall()) {
      aborted = true;
      break;
    }

    const bar = bars[i]!;
    const candle = toCandleEvent(bar, i, symbol, venue, opts.interval, intervalMs);
    candles.push(candle);

    const closesNum = candles.map((c) => toIndicatorNumber(c.close));
    const highsNum = candles.map((c) => toIndicatorNumber(c.high));
    const lowsNum = candles.map((c) => toIndicatorNumber(c.low));
    const indicators = computeIndicators(closesNum, highsNum, lowsNum);
    const htf = {
      h1: buildHtfIndicators(candles, HTF_TARGET_MS.h1, intervalMs),
      h4: buildHtfIndicators(candles, HTF_TARGET_MS.h4, intervalMs),
    };

    const input: AgentDecisionInput = {
      strategyId: sId,
      trigger: { kind: 'candle', event: candle },
      snapshot: {
        eventTime: candle.eventTime,
        candles: new Map([[symbol, candles]]),
        // Fair-proxy configuration — no ticker/book/derivatives attached (mirrors agentic-replay.ts).
        tickers: new Map(),
        books: new Map(),
        execReports: [],
        portfolio: { strategyId: sId, positions: new Map(), openOrders: [] },
      },
      context: {
        indicators,
        position: FLAT_POSITION_SUMMARY,
        recentDecisions: [],
        htf,
      },
    };
    const rowPayload = buildMarketPayload(input, { constraints });

    decisionsRequested += 1;
    const result = await replayPlanRow(
      {
        apiKey: opts.apiKey,
        model: opts.model,
        timeoutMs,
        sizeFractionMax,
        shortsEnabled: opts.shortsEnabled,
      },
      systemPrompt,
      playbookBlock,
      rowPayload,
      fetchFn,
    );
    budget.recordUsage(result.usage, opts.model);

    const action = result.ok ? result.action : undefined;
    const closeStr = candle.close.toFixed();
    // Journal the synthetic decision (strategyId = replay-<runId>, playbookVersion = null so it never
    // enters versioned/attribution reads). A failed/unusable decide is journaled as an 'error' row —
    // the same honesty convention the live decide path applies (no usable action ⇒ still recorded).
    // plan: result.plan is AgentDirectives; the entry's plan field accepts it (same assignment the
    // live decide path makes at agentic.strategy.ts's own journal build).
    const plan: AgentDirectives | null = result.ok ? (result.plan ?? null) : null;
    opts.journal.record({
      strategyId: sId,
      symbol,
      venue,
      triggerKind: 'candle',
      basedOnSeq: candle.seq,
      eventTime: candle.eventTime,
      model: opts.model,
      action: action ?? 'error',
      confidence: null,
      rationale: result.ok ? 'r1-replay synthetic decide' : 'r1-replay decide failed',
      refPrice: null,
      close: closeStr,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      cacheReadInputTokens: result.usage?.cacheReadInputTokens ?? null,
      cacheCreationInputTokens: result.usage?.cacheCreationInputTokens ?? null,
      latencyMs: null,
      // playbookVersion NULL: keeps synthetic rows out of every versioned/attribution read by
      // construction (selectRecentVersioned/countVersionEntryStats filter on a non-null version).
      playbookVersion: null,
      promptHash: 'r1-replay',
      inputPayload: rowPayload,
      plan,
    });
    decisionsJournaled += 1;

    // RUN-REPORT expectancy only (never a fill, never promotion evidence): price open_* entries
    // through candidate-backtest.simulateRoundTrip over this bar's forward closes.
    if (result.ok && (action === 'open_long' || action === 'open_short') && result.plan) {
      entries += 1;
      const forwardCloses = allCloses.slice(i + 1);
      const side = action === 'open_short' ? 'SHORT' : 'LONG';
      const sim = simulateRoundTrip(closeStr, result.plan, forwardCloses, side);
      if (sim === null) {
        unsimulatableEntries += 1;
      } else {
        simulatedRoundTrips += 1;
        totalNetBps += sim.netBps;
      }
    }
  }
  const barsUsed = i;

  return {
    runId: opts.runId,
    strategyId: runStrategyId,
    symbol: opts.symbol,
    interval: opts.interval,
    model: opts.model,
    barsSupplied: bars.length,
    barsUsed,
    decisionsRequested,
    decisionsJournaled,
    entries,
    simulatedRoundTrips,
    unsimulatableEntries,
    meanNetBps: simulatedRoundTrips > 0 ? totalNetBps / simulatedRoundTrips : 0,
    spendUsd: new Decimal(budget.snapshot().costUsd).toFixed(6),
    maxUsd: new Decimal(opts.maxUsd).toFixed(6),
    aborted,
    abortReason: aborted ? 'ABORTED_BUDGET' : null,
  };
}
