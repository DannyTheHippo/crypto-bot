import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import {
  AgenticStrategy,
  type AgenticStrategyParams,
  type AgenticStrategyDeps,
} from '../../../../src/features/strategy/agentic/agentic.strategy';
import { PriceHistoryStore } from '../../../../src/features/strategy/agentic/price-history-store';
import {
  AgentProposeError,
  type AgentClientPort,
  type AgentDecisionEntry,
  type AgentDecisionInput,
  type AgentDecisionJournalPort,
  type AgentDecisionRow,
  type AgentMarketSnapshot,
  type AgentProposal,
} from '../../../../src/ports/strategy/agentic-strategy';
import type { Signal } from '../../../../src/domain/strategy/types/signal';
import type { CandleEvent, CandleInterval } from '../../../../src/domain/venue/types/market-events';
import type {
  Position,
  StrategyPortfolioView,
} from '../../../../src/domain/trading/types/portfolio';
import type {
  RoundTripEvidence,
  RoundTripEvidencePort,
} from '../../../../src/ports/trading/promotion';
import { price, qty } from '../../../../src/domain/common/types/money';
import {
  strategyId,
  venueId,
  symbolId,
  epochMs,
  clientOrderId,
} from '../../../../src/domain/common/types/ids';

const T = 1_700_000_000_000;
const SID = strategyId('agentic-1');
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');

function candle(closeStr: string, index = 0): CandleEvent {
  const t = T + index * 60_000;
  return {
    kind: 'CANDLE',
    venue: V,
    symbol: SYM,
    channel: 'candle:1m',
    seq: BigInt(index + 1),
    eventTime: epochMs(t),
    ingestTime: epochMs(t + 1),
    interval: '1m',
    openTime: epochMs(t),
    closeTime: epochMs(t + 60_000),
    open: price(closeStr),
    high: price(closeStr),
    low: price(closeStr),
    close: price(closeStr),
    volume: qty('1'),
    closed: true,
  };
}

function candleWithInterval(
  closeStr: string,
  index: number,
  interval: CandleInterval,
  stepMs: number,
): CandleEvent {
  const t = T + index * stepMs;
  return {
    kind: 'CANDLE',
    venue: V,
    symbol: SYM,
    channel: `candle:${interval}`,
    seq: BigInt(index + 1),
    eventTime: epochMs(t),
    ingestTime: epochMs(t + 1),
    interval,
    openTime: epochMs(t),
    closeTime: epochMs(t + stepMs),
    open: price(closeStr),
    high: price(closeStr),
    low: price(closeStr),
    close: price(closeStr),
    volume: qty('1'),
    closed: true,
  };
}

function emptyPortfolio(): StrategyPortfolioView {
  return { strategyId: SID, positions: new Map(), openOrders: [] };
}

function longPortfolio(
  over: { avgEntry?: string; realizedPnl?: string; qty?: string } = {},
): StrategyPortfolioView {
  const position: Position = {
    strategyId: SID,
    venue: V,
    symbol: SYM,
    signedQty: new Decimal(over.qty ?? '2.5'),
    avgEntry: price(over.avgEntry ?? '100'),
    realizedPnl: new Decimal(over.realizedPnl ?? '12.34'),
  };
  return {
    strategyId: SID,
    positions: new Map([['p1', position]]),
    openOrders: [
      {
        clientOrderId: clientOrderId('cbp0000000000000007000800000000000000'),
        symbol: SYM,
        side: 'BUY',
        qty: qty('1'),
      },
    ],
  };
}

function buildInput(
  opts: { candles?: CandleEvent[]; portfolio?: StrategyPortfolioView; eventTime?: number } = {},
): AgentDecisionInput {
  const et = opts.eventTime ?? T;
  const snapshot: AgentMarketSnapshot = {
    eventTime: epochMs(et),
    candles: opts.candles ? new Map([[SYM, opts.candles]]) : new Map(),
    tickers: new Map(),
    books: new Map(),
    execReports: [],
    portfolio: opts.portfolio ?? emptyPortfolio(),
  };
  return {
    strategyId: SID,
    trigger: { kind: 'candle', event: candle('100') },
    snapshot,
  };
}

// Deterministic stand-in for the out-of-process agent: records every input it was called with and
// resolves with whatever the script for that call index produces.
class CapturingAgentClient implements AgentClientPort {
  readonly inputs: AgentDecisionInput[] = [];
  constructor(private readonly script: (call: number) => Signal[] = () => []) {}

  propose(input: AgentDecisionInput): Promise<AgentProposal> {
    const call = this.inputs.length;
    this.inputs.push(input);
    return Promise.resolve({ signals: this.script(call) });
  }
}

// Always resolves with a fixed, fully-populated AgentProposal — for asserting the journal maps
// every telemetry field through untouched.
class FixedProposalAgentClient implements AgentClientPort {
  constructor(private readonly proposal: AgentProposal) {}
  propose(): Promise<AgentProposal> {
    return Promise.resolve(this.proposal);
  }
}

class ThrowingAgentClient implements AgentClientPort {
  constructor(private readonly err: Error) {}
  propose(): Promise<AgentProposal> {
    return Promise.reject(this.err);
  }
}

class RecordingJournal implements AgentDecisionJournalPort {
  readonly entries: AgentDecisionEntry[] = [];
  record(entry: AgentDecisionEntry): void {
    this.entries.push(entry);
  }
  recent(limit: number): Promise<readonly AgentDecisionRow[]> {
    void limit;
    return Promise.resolve([]);
  }
}

// P4b: a fixed set of closed round trips for computeTrackRecordContext's evidence port dep — the
// reflection/promotion lane's own real reader (round-trip-evidence.reader.ts) replays fills through
// a DB round trip; this fake just returns the fixture verbatim, mirroring RecordingJournal's
// "capture, don't replay" convention above.
class FixedEvidencePort implements RoundTripEvidencePort {
  constructor(private readonly trips: readonly RoundTripEvidence[]) {}
  recentRoundTrips(limit: number): Promise<readonly RoundTripEvidence[]> {
    return Promise.resolve(this.trips.slice(-limit));
  }
  reflectionSeed(): Promise<{
    closedTradesTotal: number;
    closedSinceLastReflection: number;
    lastReflectionAt: number | null;
  }> {
    return Promise.resolve({
      closedTradesTotal: 0,
      closedSinceLastReflection: 0,
      lastReflectionAt: null,
    });
  }
}

// Eight CLOSED round trips (TRACK_RECORD_MIN_TRIPS) spanning [T, T + 450_000] — the first trip opens
// at the window start, the last closes at the window end. Only the LAST trip carries a non-zero
// netPnl (100 bps on a $100 notional): cumulative net-of-cost bps over the window is exactly 100,
// matching this file's fixture BTC-hold candles (see the trackRecord describe block below).
function fixedRoundTrips(): RoundTripEvidence[] {
  return Array.from({ length: 8 }, (_, i) => ({
    strategyId: 'agentic-1',
    symbol: 'BTC/USDT',
    openedAt: T + i * 60_000,
    closedAt: T + i * 60_000 + 30_000,
    holdingMs: 30_000,
    entryVwap: '100',
    exitVwap: i === 7 ? '101' : '100',
    boughtQty: '1',
    realizedPnl: i === 7 ? '1' : '0',
    feesQuote: '0',
    netPnl: i === 7 ? '1' : '0',
    meanSlippageBps: null,
  }));
}

function enterLongSignal(): Signal {
  return {
    strategyId: SID,
    venue: V,
    symbol: SYM,
    kind: 'ENTER_LONG',
    strength: 1,
    refPrice: price('100'),
    basedOnSeq: 1n,
    eventTime: epochMs(T),
    ttlMs: 5000,
    dedupeKey: 'k',
    reason: 'r',
  };
}

function exitLongSignal(): Signal {
  return { ...enterLongSignal(), kind: 'EXIT_LONG' };
}

function makeStrategy(
  client: AgentClientPort,
  opts: {
    interval?: CandleInterval;
    deps?: AgenticStrategyDeps;
    trackRecordEnabled?: boolean;
  } = {},
): AgenticStrategy {
  const params: AgenticStrategyParams = {
    symbol: SYM,
    venue: V,
    interval: opts.interval ?? '1m',
    warmupBars: 2,
    model: 'test-model',
    // I1b (Design § Deleted scaffolding — B2 consult scheduler): a fresh, FLAT, non-exec-triggered
    // strategy now waits for evaluateConsultSchedule's fallback cadence before its very FIRST
    // consult (fallbackConsultBars, default 16) — every fixture in this file predates B2 and expects
    // each decide() call to reach the client (CapturingAgentClient's script is indexed by call
    // count), so fallbackConsultBars=1 keeps every bar due on schedule (forced_fallback, since none
    // of these fixtures ever set a real nextConsultBars) without touching production scheduler
    // semantics.
    fallbackConsultBars: 1,
    trackRecordEnabled: opts.trackRecordEnabled,
  };
  return new AgenticStrategy(SID, params, client, opts.deps);
}

describe('AgenticStrategy context building', () => {
  it('reports null indicators while the closed-candle history is under 21 bars', async () => {
    const client = new CapturingAgentClient();
    const strategy = makeStrategy(client);
    const candles = Array.from({ length: 5 }, (_, i) => candle('100', i));

    await strategy.decide(buildInput({ candles }));

    expect(client.inputs[0]!.context!.indicators).toBeNull();
  });

  it('computes exact indicator values over a constant-price series once 21+ closes are available', async () => {
    const client = new CapturingAgentClient();
    const strategy = makeStrategy(client);
    const candles = Array.from({ length: 21 }, (_, i) => candle('100', i));

    await strategy.decide(buildInput({ candles }));

    const indicators = client.inputs[0]!.context!.indicators!;
    expect(indicators).not.toBeNull();
    expect(indicators.lastClose).toBe(100);
    expect(indicators.emaFast).toBe(100);
    expect(indicators.emaSlow).toBe(100);
  });

  it('summarizes a held LONG position with exact decimal strings and open-order count', async () => {
    const client = new CapturingAgentClient();
    const strategy = makeStrategy(client);

    await strategy.decide(buildInput({ portfolio: longPortfolio() }));

    const position = client.inputs[0]!.context!.position;
    expect(position.side).toBe('LONG');
    expect(position.qty).toBe('2.5');
    expect(position.avgEntry).toBe('100');
    expect(position.realizedPnl).toBe('12.34');
    expect(position.openOrders).toBe(1);
  });

  it('summarizes an empty portfolio as an unconditional FLAT with zeroed fields', async () => {
    const client = new CapturingAgentClient();
    const strategy = makeStrategy(client);

    await strategy.decide(buildInput({ portfolio: emptyPortfolio() }));

    expect(client.inputs[0]!.context!.position).toEqual({
      side: 'FLAT',
      qty: '0',
      avgEntry: null,
      realizedPnl: '0',
      unrealizedPnlPct: null,
      openOrders: 0,
    });
  });

  it('reclassifies a sub-minNotional dust LONG as FLAT once onInit has provided the venue minimum', async () => {
    const client = new CapturingAgentClient();
    const strategy = makeStrategy(client);
    strategy.onInit({
      params: {},
      warmupCandles: new Map(),
      symbolConstraints: new Map([
        [SYM, { tickSize: price('0.01'), lotStep: qty('0.0001'), minNotional: price('5') }],
      ]),
    });

    // qty 0.01 @ avgEntry 100 = $1 notional, below the $5 minimum → un-exitable dust → shown FLAT so
    // the agent stops proposing exits that the sizer rejects BELOW_MINIMUM.
    await strategy.decide(
      buildInput({ portfolio: longPortfolio({ qty: '0.01', avgEntry: '100' }) }),
    );

    expect(client.inputs[0]!.context!.position.side).toBe('FLAT');
    expect(client.inputs[0]!.context!.position.qty).toBe('0');
  });

  it('still reports a LONG when the held notional is at or above the venue minimum', async () => {
    const client = new CapturingAgentClient();
    const strategy = makeStrategy(client);
    strategy.onInit({
      params: {},
      warmupCandles: new Map(),
      symbolConstraints: new Map([
        [SYM, { tickSize: price('0.01'), lotStep: qty('0.0001'), minNotional: price('5') }],
      ]),
    });

    // qty 0.1 @ avgEntry 100 = $10 notional, above the $5 minimum → a real, exitable LONG.
    await strategy.decide(
      buildInput({ portfolio: longPortfolio({ qty: '0.1', avgEntry: '100' }) }),
    );

    expect(client.inputs[0]!.context!.position.side).toBe('LONG');
    expect(client.inputs[0]!.context!.position.qty).toBe('0.1');
  });

  it('does not reclassify dust when onInit never supplied a minimum (fail-safe to the prior LONG behavior)', async () => {
    const client = new CapturingAgentClient();
    const strategy = makeStrategy(client); // onInit not called → minNotional stays null

    await strategy.decide(
      buildInput({ portfolio: longPortfolio({ qty: '0.01', avgEntry: '100' }) }),
    );

    expect(client.inputs[0]!.context!.position.side).toBe('LONG');
  });

  it('keeps a newest-last ring of at most 12 past decisions, dropping the oldest once it overflows', async () => {
    // Mirrors agentic.strategy.ts's (private, unexported) MAX_DECISION_HISTORY, narrowed 30 -> 12 on
    // 2026-07-30 alongside the write-site filter below — see that constant's own comment. RING_SIZE +
    // 1 scripted decisions feed the ring the (RING_SIZE + 2)th decide's context is captured from, so
    // the very first one is provably evicted.
    const RING_SIZE = 12;
    const cycle = ['long', 'flat', 'hold'] as const;
    const actionsForCalls = Array.from(
      { length: RING_SIZE + 1 },
      (_, i) => cycle[i % cycle.length]!,
    );
    const client = new CapturingAgentClient((call) => {
      if (call >= actionsForCalls.length) return [];
      const action = actionsForCalls[call];
      if (action === 'long') return [enterLongSignal()];
      if (action === 'flat') return [exitLongSignal()];
      return [];
    });
    const strategy = makeStrategy(client);

    const totalCalls = RING_SIZE + 2;
    for (let i = 0; i < totalCalls; i++) {
      await strategy.decide(buildInput({ eventTime: T + i * 60_000 }));
    }

    const recentDecisions = client.inputs[totalCalls - 1]!.context!.recentDecisions;
    const expectedActions = actionsForCalls.slice(1); // decision #1 (call 0) was shifted out
    expect(recentDecisions).toHaveLength(RING_SIZE);
    expect(recentDecisions.map((d) => d.action)).toEqual(expectedActions);
  });

  it('truncates a long model rationale to MAX_REASON_LEN before it re-enters recentDecisions on a later call', async () => {
    const longRationale = 'x'.repeat(500);
    const inputs: AgentDecisionInput[] = [];
    const client: AgentClientPort = {
      propose: (input) => {
        inputs.push(input);
        return Promise.resolve({
          signals: [],
          decision: { action: 'hold', confidence: 0.5, rationale: longRationale },
        });
      },
    };
    const strategy = makeStrategy(client);

    await strategy.decide(buildInput({ eventTime: T }));
    await strategy.decide(buildInput({ eventTime: T + 60_000 }));

    const stored = inputs[1]!.context!.recentDecisions[0]!;
    expect(stored.reason).toHaveLength(200);
    expect(stored.reason).toBe(longRationale.slice(0, 200));
  });

  // 2026-07-30 (A): 382 of 405 live ring lines were records of calls that never happened or came
  // back unusable — non-decisions re-fed to the model every consult, for every symbol, under a system
  // prompt that describes the block as "the action/close/reason YOU gave on a prior call". Each case
  // below is one such write site's own decision shape, scripted verbatim.
  describe('only model-authored decisions enter the ring', () => {
    async function ringAfter(decision: {
      action: 'hold' | 'error';
      rationale: string;
    }): Promise<AgentDecisionInput[]> {
      const inputs: AgentDecisionInput[] = [];
      const client: AgentClientPort = {
        propose: (input) => {
          inputs.push(input);
          return Promise.resolve({
            signals: [],
            decision: { ...decision, confidence: null },
          });
        },
      };
      const strategy = makeStrategy(client);
      await strategy.decide(buildInput({ eventTime: T }));
      await strategy.decide(buildInput({ eventTime: T + 60_000 }));
      return inputs;
    }

    it.each([
      // AnthropicAgentClient.latchedDecision — a FATAL-latched call that never left the process.
      [
        'client_latched',
        { action: 'error' as const, rationale: 'client_latched: cause=fatal_400' },
      ],
      // The four post-200 degrades (DEGRADED_DECIDE_RATIONALE_TAGS) — reached the model, unusable.
      [
        'schema_rejected',
        { action: 'hold' as const, rationale: 'schema_rejected: (root): required' },
      ],
      ['no_tool_use', { action: 'hold' as const, rationale: 'no_tool_use: text-only response' }],
      [
        'capability_violation',
        { action: 'hold' as const, rationale: 'capability_violation:open_short_on_spot' },
      ],
      // BatchingAgentClient / BudgetedAgentClient pre-call short-circuits — no call was made.
      ['off_menu', { action: 'hold' as const, rationale: 'off_menu: symbol not in active menu' }],
      [
        'budget_exhausted',
        { action: 'hold' as const, rationale: 'budget_exhausted: daily LLM budget exhausted' },
      ],
    ])('a %s row never enters the ring', async (_label, decision) => {
      const inputs = await ringAfter(decision);
      expect(inputs[1]!.context!.recentDecisions).toEqual([]);
    });

    // The counter-case that makes the filter a filter and not a blanket. AGENTIC_PLAN_AUTHORITATIVE_
    // EXITS stamps this tag on a consult that reached the model and returned a perfectly valid
    // decision the SYSTEM then overrode — deliberately NOT a DEGRADED_DECIDE_RATIONALE_TAGS member
    // (see anthropic-agent-client.ts's planAuthoritativeCloseRationale), and a real model decision
    // the next consult must still see.
    it('a plan_authoritative_close row DOES enter the ring', async () => {
      const inputs = await ringAfter({
        action: 'hold',
        rationale: 'plan_authoritative_close: losing patience with this one',
      });
      const ring = inputs[1]!.context!.recentDecisions;
      expect(ring).toHaveLength(1);
      expect(ring[0]!.reason).toBe('plan_authoritative_close: losing patience with this one');
    });

    it('an ordinary model hold with a plain rationale still enters the ring', async () => {
      const inputs = await ringAfter({ action: 'hold', rationale: 'chop, no edge' });
      expect(inputs[1]!.context!.recentDecisions.map((d) => d.reason)).toEqual(['chop, no edge']);
    });
  });

  it('clears the decision history on stop, so the next decide sees an empty ring', async () => {
    const client = new CapturingAgentClient(() => [enterLongSignal()]);
    const strategy = makeStrategy(client);

    await strategy.decide(buildInput());
    strategy.onStop();
    await strategy.decide(buildInput());

    expect(client.inputs[1]!.context!.recentDecisions).toEqual([]);
  });

  it('falls back to a signal-inferred action with confidence 0 and empty rationale when the client omits a decision', async () => {
    const journal = new RecordingJournal();
    const client = new CapturingAgentClient(() => [enterLongSignal()]);
    const strategy = makeStrategy(client, { deps: { journal } });

    await strategy.decide(buildInput());

    expect(journal.entries).toHaveLength(1);
    // v3 (consolidation spec §2/§9): the journal-write boundary maps inferStubDecision's legacy
    // 'long' onto the narrowed AgentDecisionEntry.action vocabulary ('open_long') — see
    // AgenticStrategy.toJournalAction's own comment; the fresh v3 agent_decisions column never
    // carries the legacy literal.
    expect(journal.entries[0]!.action).toBe('open_long');
    expect(journal.entries[0]!.confidence).toBe(0);
    expect(journal.entries[0]!.rationale).toBe('');
  });
});

// P4b (Design § Enriched model inputs — Track record + benchmark alpha): computeTrackRecordContext
// wires netVsBtcHoldBps from THIS instance's own siloed candle buffer, only when this.symbol IS the
// benchmark symbol (agentic.strategy.ts's BTC_BENCHMARK_SYMBOL comment) and only when that buffer
// genuinely covers the trips' evidence window (first trip's openedAt to last trip's closedAt).
describe('AgenticStrategy track-record benchmark alpha (P4b)', () => {
  it('carries exactly -100 netVsBtcHoldBps when BTC held +2% and the lane netted +1% over the same window', async () => {
    const client = new CapturingAgentClient();
    const evidence = new FixedEvidencePort(fixedRoundTrips());
    const strategy = makeStrategy(client, { trackRecordEnabled: true, deps: { evidence } });
    const btcCandles = [
      candleWithInterval('100', 0, '1m', 450_000), // eventTime = T (window start)
      candleWithInterval('102', 1, '1m', 450_000), // eventTime = T + 450_000 (window end): +2% hold
    ];

    await strategy.decide(buildInput({ candles: btcCandles }));

    const trackRecord = client.inputs[0]!.context!.trackRecord!;
    expect(trackRecord.tripCount).toBe(8);
    // lane cumulative net bps (100, i.e. +1%) minus BTC-hold return in bps (0.02 * 10_000 = 200).
    expect(trackRecord.netVsBtcHoldBps).toBe(-100);
  });

  it('omits both benchmark-alpha fields when the candle buffer does not cover the trips window', async () => {
    const client = new CapturingAgentClient();
    const evidence = new FixedEvidencePort(fixedRoundTrips());
    const strategy = makeStrategy(client, { trackRecordEnabled: true, deps: { evidence } });

    // No candles supplied at all — the coverage guard must omit rather than compare a truncated span.
    await strategy.decide(buildInput());

    const trackRecord = client.inputs[0]!.context!.trackRecord!;
    expect(trackRecord.tripCount).toBe(8);
    expect(trackRecord.netVsBtcHoldBps).toBeUndefined();
    expect(trackRecord.netVsEqualWeightBasketBps).toBeUndefined();
  });

  // W3 Part 2: netVsEqualWeightBasketBps off the shared PriceHistoryStore — independent of
  // netVsBtcHoldBps (this instance's own siloed candle buffer stays empty in this fixture, so
  // netVsBtcHoldBps is omitted while the basket field still populates).
  it('carries exact netVsEqualWeightBasketBps off the shared PriceHistoryStore', async () => {
    const client = new CapturingAgentClient();
    const evidence = new FixedEvidencePort(fixedRoundTrips());
    const priceHistory = new PriceHistoryStore();
    priceHistory.recordWindow(SYM, [
      candleWithInterval('100', 0, '1m', 450_000), // eventTime = T (window start)
      candleWithInterval('105', 1, '1m', 450_000), // eventTime = T + 450_000 (window end): +5% hold
    ]);
    const strategy = makeStrategy(client, {
      trackRecordEnabled: true,
      deps: { evidence, priceHistory },
    });

    await strategy.decide(buildInput()); // no candles on the instance's OWN snapshot buffer

    const trackRecord = client.inputs[0]!.context!.trackRecord!;
    expect(trackRecord.tripCount).toBe(8);
    expect(trackRecord.netVsBtcHoldBps).toBeUndefined(); // this instance's own buffer is empty
    // lane cumulative net bps (100) minus the basket's hold return in bps (0.05 * 10_000 = 500).
    expect(trackRecord.netVsEqualWeightBasketBps).toBe(-400);
  });

  it('omits netVsEqualWeightBasketBps when no symbol in the store covers the trips window', async () => {
    const client = new CapturingAgentClient();
    const evidence = new FixedEvidencePort(fixedRoundTrips());
    const priceHistory = new PriceHistoryStore();
    // Only one candle recorded — computeHoldReturnFraction needs at least 2.
    priceHistory.recordWindow(SYM, [candleWithInterval('100', 0, '1m', 450_000)]);
    const strategy = makeStrategy(client, {
      trackRecordEnabled: true,
      deps: { evidence, priceHistory },
    });

    await strategy.decide(buildInput());

    const trackRecord = client.inputs[0]!.context!.trackRecord!;
    expect(trackRecord.netVsEqualWeightBasketBps).toBeUndefined();
  });
});

describe('AgenticStrategy retro outcome annotation', () => {
  it('fills the previous decision outcome (priceMovePct + exact positionPnlDelta + heldDuring) once it becomes visible on the call after next', async () => {
    const client = new CapturingAgentClient();
    const strategy = makeStrategy(client);

    // Call 1: FLAT, close 100 — no prior decision to annotate; combinedPnl(FLAT) = realizedPnl = 0.
    await strategy.decide(buildInput({ candles: [candle('100', 0)], portfolio: emptyPortfolio() }));
    // Call 2: LONG qty=1 avgEntry=100 realizedPnl=0, close 110 — combinedPnl = 0 + (110-100)*1 = 10.
    // This annotates call 1's record with priceMovePct=(110-100)/100*100=10, positionPnlDelta='10'.
    // heldDuring reflects the side as of call 1 (FLAT), not call 2 (LONG).
    await strategy.decide(
      buildInput({
        candles: [candle('110', 1)],
        portfolio: longPortfolio({ avgEntry: '100', realizedPnl: '0', qty: '1' }),
      }),
    );
    // Call 3: only here does call 1's now-annotated record surface in recentDecisions.
    await strategy.decide(buildInput({ candles: [candle('110', 2)], portfolio: emptyPortfolio() }));

    const recentDecisions = client.inputs[2]!.context!.recentDecisions;
    expect(recentDecisions[0]!.outcome).toEqual({
      priceMovePct: 10,
      positionPnlDelta: '10',
      heldDuring: 'FLAT',
    });
  });

  it('records heldDuring LONG when the prior decision was made while a position was held', async () => {
    const client = new CapturingAgentClient();
    const strategy = makeStrategy(client);

    // Call 1: LONG — the decision being annotated later was made while held.
    await strategy.decide(
      buildInput({
        candles: [candle('100', 0)],
        portfolio: longPortfolio({ avgEntry: '100', realizedPnl: '0', qty: '1' }),
      }),
    );
    // Call 2: still LONG, close moves to 110.
    await strategy.decide(
      buildInput({
        candles: [candle('110', 1)],
        portfolio: longPortfolio({ avgEntry: '100', realizedPnl: '0', qty: '1' }),
      }),
    );
    // Call 3: surfaces call 1's annotated outcome.
    await strategy.decide(
      buildInput({
        candles: [candle('110', 2)],
        portfolio: longPortfolio({ avgEntry: '100', realizedPnl: '0', qty: '1' }),
      }),
    );

    const recentDecisions = client.inputs[2]!.context!.recentDecisions;
    expect(recentDecisions[0]!.outcome!.heldDuring).toBe('LONG');
  });

  it('never populates outcome on the most recently pushed decision (it is annotated on the call after next)', async () => {
    const client = new CapturingAgentClient();
    const strategy = makeStrategy(client);

    await strategy.decide(buildInput({ candles: [candle('100', 0)] }));
    await strategy.decide(buildInput({ candles: [candle('110', 1)] }));

    const recentDecisions = client.inputs[1]!.context!.recentDecisions;
    expect(recentDecisions[0]!.outcome).toBeUndefined();
  });

  it('leaves priceMovePct null (never NaN) when the annotated call had no candle to derive a close from', async () => {
    const client = new CapturingAgentClient();
    const strategy = makeStrategy(client);

    // Call 1: no candles at all — close seeds as NaN.
    await strategy.decide(buildInput({ candles: [], portfolio: emptyPortfolio() }));
    // Call 2: a real candle arrives; annotates call 1's now-poisoned close.
    await strategy.decide(buildInput({ candles: [candle('110', 1)], portfolio: emptyPortfolio() }));
    // Call 3: surfaces call 1's annotated outcome.
    await strategy.decide(buildInput({ candles: [candle('110', 2)], portfolio: emptyPortfolio() }));

    const recentDecisions = client.inputs[2]!.context!.recentDecisions;
    expect(recentDecisions[0]!.outcome!.priceMovePct).toBeNull();
    expect(recentDecisions[0]!.outcome!.positionPnlDelta).toBe('0');
  });

  // A prev.close <= 0 is unreachable through the public API here — Price (money.ts price()) throws
  // NON_POSITIVE for any value <= 0, and AgentDecisionRecord.close is always either a Price-derived
  // toIndicatorNumber() (> 0) or NaN (the no-candle seed, covered above). The prev.close > 0 branch
  // of the guard is defensive-only against that invariant; see agent-prompt.spec.ts for the
  // rendering-level null→"n/a" coverage that IS reachable with a plain-literal AgentDecisionRecord.
});

describe('AgenticStrategy HTF context', () => {
  it('computes non-null 1h HTF indicators once enough aggregated closed bars exist, leaving 4h null', async () => {
    const client = new CapturingAgentClient();
    const strategy = makeStrategy(client, { interval: '15m' });
    const candles = Array.from({ length: 100 }, (_, i) =>
      candleWithInterval(String(100 + i * 0.1), i, '15m', 900_000),
    );

    await strategy.decide(buildInput({ candles }));

    const htf = client.inputs[0]!.context!.htf!;
    expect(htf.h1).not.toBeNull();
    expect(typeof htf.h1!.emaFast).toBe('number');
    expect(typeof htf.h1!.emaSlow).toBe('number');
    expect(typeof htf.h1!.rsi14).toBe('number');
    expect(htf.h4).toBeNull();
  });

  it('leaves both HTF halves null when there are too few candles to aggregate a full warmup window', async () => {
    const client = new CapturingAgentClient();
    const strategy = makeStrategy(client, { interval: '15m' });
    const candles = Array.from({ length: 5 }, (_, i) =>
      candleWithInterval('100', i, '15m', 900_000),
    );

    await strategy.decide(buildInput({ candles }));

    const htf = client.inputs[0]!.context!.htf!;
    expect(htf.h1).toBeNull();
    expect(htf.h4).toBeNull();
  });

  it("omits the 1h half (factor 1, not a real HTF) when the strategy's own interval is already 1h", async () => {
    const client = new CapturingAgentClient();
    const strategy = makeStrategy(client, { interval: '1h' });
    const candles = Array.from({ length: 100 }, (_, i) =>
      candleWithInterval(String(100 + i * 0.1), i, '1h', 3_600_000),
    );

    await strategy.decide(buildInput({ candles }));

    const htf = client.inputs[0]!.context!.htf!;
    expect(htf.h1).toBeNull();
    expect(htf.h4).not.toBeNull();
  });
});

describe('AgenticStrategy closed-trade detection', () => {
  it('fires onClosedTrade exactly once per LONG→FLAT transition observed in the portfolio, with the running count', async () => {
    const client = new CapturingAgentClient();
    const onClosedTrade = vi.fn();
    const strategy = makeStrategy(client, { deps: { onClosedTrade } });

    await strategy.decide(buildInput({ portfolio: emptyPortfolio() })); // null -> FLAT: no transition
    await strategy.decide(buildInput({ portfolio: longPortfolio() })); // FLAT -> LONG: no transition
    await strategy.decide(buildInput({ portfolio: emptyPortfolio() })); // LONG -> FLAT: closed trade #1
    await strategy.decide(buildInput({ portfolio: longPortfolio() })); // FLAT -> LONG: no transition
    await strategy.decide(buildInput({ portfolio: emptyPortfolio() })); // LONG -> FLAT: closed trade #2

    expect(onClosedTrade).toHaveBeenCalledTimes(2);
    expect(onClosedTrade).toHaveBeenNthCalledWith(1, 1);
    expect(onClosedTrade).toHaveBeenNthCalledWith(2, 2);
  });

  it('never fires when no injected hook is provided', async () => {
    const client = new CapturingAgentClient();
    const strategy = makeStrategy(client);

    await expect(
      (async () => {
        await strategy.decide(buildInput({ portfolio: longPortfolio() }));
        await strategy.decide(buildInput({ portfolio: emptyPortfolio() }));
      })(),
    ).resolves.not.toThrow();
  });
});

describe('AgenticStrategy decision journal', () => {
  it('records a full journal entry (client decision + telemetry) mapped straight through, including the hold action', async () => {
    const journal = new RecordingJournal();
    const proposal: AgentProposal = {
      signals: [],
      decision: { action: 'hold', confidence: 0.62, rationale: 'waiting for confirmation' },
      usage: { inputTokens: 111, outputTokens: 22 },
      latencyMs: 345,
      playbookVersion: 4,
      promptHash: 'deadbeef',
    };
    const client = new FixedProposalAgentClient(proposal);
    const strategy = makeStrategy(client, { deps: { journal } });

    await strategy.decide(buildInput({ candles: [candle('100', 0)], portfolio: longPortfolio() }));

    expect(journal.entries).toHaveLength(1);
    const entry = journal.entries[0]!;
    expect(entry.strategyId).toBe(SID);
    expect(entry.symbol).toBe(SYM);
    expect(entry.venue).toBe(V);
    expect(entry.triggerKind).toBe('candle');
    expect(entry.model).toBe('test-model');
    expect(entry.action).toBe('hold');
    expect(entry.confidence).toBe(0.62);
    expect(entry.rationale).toBe('waiting for confirmation');
    expect(entry.close).toBe('100');
    expect(entry.refPrice).toBe('100');
    expect(entry.inputTokens).toBe(111);
    expect(entry.outputTokens).toBe(22);
    expect(entry.latencyMs).toBe(345);
    expect(entry.playbookVersion).toBe(4);
    expect(entry.promptHash).toBe('deadbeef');
  });

  it('never invokes the journal when none is injected', async () => {
    const client = new CapturingAgentClient(() => [enterLongSignal()]);
    const strategy = makeStrategy(client);

    await expect(strategy.decide(buildInput())).resolves.not.toThrow();
  });

  it('swallows a journal failure without affecting the returned signals', async () => {
    const journal: AgentDecisionJournalPort = {
      record: () => {
        throw new Error('journal down');
      },
      recent: () => Promise.resolve([]),
    };
    const client = new CapturingAgentClient(() => [enterLongSignal()]);
    const strategy = makeStrategy(client, { deps: { journal } });

    const signals = await strategy.decide(buildInput());

    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe('ENTER_LONG');
  });

  it('records an error journal entry with kind/status and the sanitized AgentProposeError detail, then rethrows the original error', async () => {
    const journal = new RecordingJournal();
    const err = new AgentProposeError('anthropic api http 401', 'FATAL', 401);
    const client = new ThrowingAgentClient(err);
    const strategy = makeStrategy(client, { deps: { journal } });

    await expect(strategy.decide(buildInput())).rejects.toBe(err);

    expect(journal.entries).toHaveLength(1);
    const entry = journal.entries[0]!;
    expect(entry.action).toBe('error');
    expect(entry.confidence).toBeNull();
    expect(entry.rationale).toBe('FATAL (status 401): anthropic api http 401');
    expect(entry.playbookVersion).toBeNull();
    expect(entry.promptHash).toBe('');
    expect(entry.inputTokens).toBeNull();
    expect(entry.outputTokens).toBeNull();
    expect(entry.latencyMs).toBeNull();
  });

  it('never touches the error message (kind/status only) for a non-AgentProposeError rejection', async () => {
    const journal = new RecordingJournal();
    const client = new ThrowingAgentClient(new Error('some other failure with sensitive detail'));
    const strategy = makeStrategy(client, { deps: { journal } });

    await expect(strategy.decide(buildInput())).rejects.toThrow('some other failure');

    expect(journal.entries[0]!.rationale).toBe('RETRYABLE');
    expect(journal.entries[0]!.rationale).not.toContain('sensitive detail');
  });

  it('journals the sanitized transport reason for a status-less RETRYABLE AgentProposeError', async () => {
    const journal = new RecordingJournal();
    const err = new AgentProposeError('anthropic api transport error: socket hang up', 'RETRYABLE');
    const client = new ThrowingAgentClient(err);
    const strategy = makeStrategy(client, { deps: { journal } });

    await expect(strategy.decide(buildInput())).rejects.toBe(err);

    expect(journal.entries[0]!.rationale).toBe(
      'RETRYABLE: anthropic api transport error: socket hang up',
    );
    expect(journal.entries[0]!.rationale).toContain('socket hang up');
  });

  // R2 (episodic memory): regimeTagsFor must read the STRATEGY-BUILT AgentContext (buildContext's own
  // indicators), never `input.context` — AgentDecisionInput.context is host-supplied-only and never
  // set on this lane (see its own comment), so reading it here would silently stamp every row null
  // forever. Threaded through every journal-write call site (decide/quiet/error/plan-executor).
  it('stamps a non-null regimeTags fingerprint on the journal row once indicators are warm', async () => {
    const journal = new RecordingJournal();
    const proposal: AgentProposal = {
      signals: [],
      decision: { action: 'hold', confidence: 0.5, rationale: 'flat chop' },
    };
    const client = new FixedProposalAgentClient(proposal);
    const strategy = makeStrategy(client, { deps: { journal } });
    const candles = Array.from({ length: 21 }, (_, i) => candle('100', i));

    await strategy.decide(buildInput({ candles }));

    expect(journal.entries).toHaveLength(1);
    // T (1_700_000_000_000ms) = 2023-11-14T22:13:20Z → UTC hour 22 → 'us' session; a constant-price
    // series gives a zero EMA spread (flat trend) and a zero ATR (low vol); no derivatives feed is
    // wired in this fixture, so funding is omitted entirely (the spot-lane shape).
    expect(journal.entries[0]!.regimeTags).toEqual({ trend: 'flat', vol: 'low', session: 'us' });
  });

  it('still writes a journal row (with a null regimeTags) while indicators are under warmup', async () => {
    const journal = new RecordingJournal();
    const client = new CapturingAgentClient();
    const strategy = makeStrategy(client, { deps: { journal } });
    const candles = Array.from({ length: 5 }, (_, i) => candle('100', i)); // < 21 warmup closes

    await strategy.decide(buildInput({ candles }));

    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]!.regimeTags).toBeNull();
  });
});
