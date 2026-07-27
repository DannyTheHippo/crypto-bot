import Decimal from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import type { SymbolFilters } from '../../../../src/domain/trading/risk/evaluate';
import type { PartialRiskLimits } from '../../../../src/domain/trading/risk/limits';
import { verifyApproval } from '../../../../src/domain/trading/risk/proof';
import type { ExecReport } from '../../../../src/domain/trading/types/exec-report';
import {
  clientOrderId,
  epochMs,
  strategyId,
  symbolId,
  venueId,
} from '../../../../src/domain/common/types/ids';
import type { CandleEvent, MarketEvent } from '../../../../src/domain/venue/types/market-events';
import { price, qty } from '../../../../src/domain/common/types/money';
import type {
  PortfolioSnapshot,
  Position,
  StrategyPortfolioView,
} from '../../../../src/domain/trading/types/portfolio';
import type { RiskApprovedIntent } from '../../../../src/domain/trading/types/risk-decision';
import type { Signal } from '../../../../src/domain/strategy/types/signal';
import { StubAgentClient } from '../../../../src/features/strategy/agentic/agent-client.adapter';
import { assertAgenticLaneNotLive } from '../../../../src/features/strategy/agentic/agentic-live-interlock';
import { AgenticStrategy } from '../../../../src/features/strategy/agentic/agentic.strategy';
import {
  StrategyHost,
  type AgenticHostOptions,
} from '../../../../src/features/strategy/agentic/strategy-host';
import { StrategyRegistry } from '../../../../src/features/strategy/agentic/strategy-registry';
import { SignalSinkService } from '../../../../src/features/trading/execution/signal-sink.service';
import { CrossingRegistryService } from '../../../../src/features/trading/risk/crossing-registry.service';
import { KillSwitchService } from '../../../../src/features/trading/risk/kill-switch.service';
import { PositionSizerService } from '../../../../src/features/trading/risk/position-sizer.service';
import { RateBucketsService } from '../../../../src/features/trading/risk/rate-buckets.service';
import { RiskEngineService } from '../../../../src/features/trading/risk/risk-engine.service';
import { SignalGatewayService } from '../../../../src/features/trading/risk/signal-gateway.service';
import type {
  AgentClientPort,
  AgentDecisionInput,
  AgentMarketSnapshot,
  AgentProposal,
} from '../../../../src/ports/strategy/agentic-strategy';
import type { ClockPort } from '../../../../src/ports/common/clock';
import type {
  ExecutionGatePort,
  PortfolioViewPort,
  SubmitAck,
} from '../../../../src/ports/trading/execution';
import type { FeedHealthPort, MarketStreamPort } from '../../../../src/ports/venue/market-data';
import type { PromotionReadiness } from '../../../../src/ports/trading/promotion';
import type {
  RiskEngineDeps,
  RiskJournalPort,
  SizerDeps,
} from '../../../../src/ports/trading/risk';
import type { SignalJournalPort, SignalSinkPort } from '../../../../src/ports/strategy/strategy';

// ── Shared fixtures (mirror test/unit/risk/signal-gateway.service.spec.ts so the real Risk stack
// approves a standard ENTER_LONG) ────────────────────────────────────────────────────────────────
const T = 1_700_000_000_000;
const clock: ClockPort = { now: () => epochMs(T) };
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');
const SID = strategyId('agentic-1');
const KEY = Buffer.alloc(32, 1);
const FILTERS: SymbolFilters = {
  tickSize: '0.01',
  stepSize: '0.001',
  minQty: '0.001',
  minNotional: '5',
};
const LIMITS: PartialRiskLimits = {
  maxBandBps: 100,
  maxPassiveExitBandBps: 1200,
  maxStopTriggerBandBps: 2000,
  stopLimitBufferBps: 50,
  maxOrderNotional: '1000000',
  maxDriftBps: 100,
  maxPositionPerSymbol: '1000',
  maxGrossExposure: '1000000',
  maxNetExposure: '1000000',
  maxDailyLoss: '5000',
  maxDrawdownPct: '0.5',
  staleMaxAgeMs: 5000,
};
const sizerDeps: SizerDeps = {
  baseNotional: '1000',
  mode: 'paper',
  filters: new Map([[String(SYM), FILTERS]]),
  randomBytes: (n) => new Uint8Array(n).fill(3),
};
const engineDeps: RiskEngineDeps = {
  key: KEY,
  limits: LIMITS,
  limitsVersion: 'v1',
  mode: 'paper',
  filters: new Map([[String(SYM), FILTERS]]),
  randomBytes: (n) => new Uint8Array(n).fill(3),
};
const feed: FeedHealthPort = {
  getRefPrice: () => ({ mid: price('100'), at: epochMs(T) }),
  updateRefPrice: () => undefined,
  health: () => 'LIVE',
  fetchCandles: () => Promise.resolve([]),
};

function agentSignal(over: Partial<Signal> = {}): Signal {
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
    dedupeKey: 'agentic-k1',
    reason: 'agent conviction',
    ...over,
  };
}

function snapshot(): PortfolioSnapshot {
  return {
    positions: new Map<string, Position>(),
    balances: new Map(),
    openOrders: [],
    inFlightIntents: [],
    equity: new Decimal(10_000),
    unrealized: new Decimal(0),
    startingCash: new Decimal(10_000),
    peakEquity: new Decimal(10_000),
    sodEquityUtc: new Decimal(10_000),
    reconcileStatus: 'CLEAN',
    snapshotSeq: 1n,
  };
}

// Programmable agent client: deterministic stand-in for the out-of-process LLM. Records calls/inputs
// and returns whatever `impl` produces (resolve / reject / never-resolve), so each host branch is
// reproducible even though the production lane is non-deterministic.
class ProgrammableAgentClient implements AgentClientPort {
  calls = 0;
  readonly inputs: AgentDecisionInput[] = [];
  constructor(private readonly impl: (input: AgentDecisionInput) => Promise<Signal[]>) {}
  propose(input: AgentDecisionInput): Promise<AgentProposal> {
    this.calls += 1;
    this.inputs.push(input);
    return this.impl(input).then((signals) => ({ signals }));
  }
}

const minimalInput = (): AgentDecisionInput => ({
  strategyId: SID,
  trigger: { kind: 'candle', event: candle(T) },
  snapshot: {
    eventTime: epochMs(T),
    candles: new Map(),
    tickers: new Map(),
    books: new Map(),
    execReports: [],
    portfolio: { strategyId: SID, positions: new Map(), openOrders: [] } as StrategyPortfolioView,
  } satisfies AgentMarketSnapshot,
});

// Real chokepoint: SignalSinkService over the REAL gateway → sizer → engine, with a capturing gate.
function realChokepoint() {
  const kill = new KillSwitchService();
  const journalCalls: Array<[string, string | undefined]> = [];
  const journal: SignalJournalPort = {
    record: (_s, outcome, intentId) => void journalCalls.push([outcome, intentId]),
  };
  const engine = new RiskEngineService(
    clock,
    engineDeps,
    feed,
    kill,
    new RateBucketsService(clock),
    new CrossingRegistryService(),
    { record: () => undefined } satisfies RiskJournalPort,
  );
  const sizer = new PositionSizerService(clock, sizerDeps);
  const gateway = new SignalGatewayService(clock, kill, sizer, engine);
  const submitted: RiskApprovedIntent[] = [];
  const gate: ExecutionGatePort = {
    submit: (a) => {
      submitted.push(a);
      return Promise.resolve({
        clientOrderId: a.intent.clientOrderId,
        outcome: 'SUBMITTED',
      } as SubmitAck);
    },
    cancel: () => Promise.resolve(),
    cancelAllFor: () => Promise.resolve(),
    flattenAll: () => Promise.resolve(),
  };
  const portfolio: PortfolioViewPort = {
    snapshot: () => snapshot(),
    forStrategy: () => ({}) as StrategyPortfolioView,
  };
  const sink = new SignalSinkService(gateway, portfolio, gate, journal);
  return { sink, submitted, journalCalls };
}

// ── Host harness (mirror of strategy-host.spec.ts) ─────────────────────────────────────────────
function candle(t: number): CandleEvent {
  return {
    kind: 'CANDLE',
    venue: V,
    symbol: SYM,
    channel: 'candle:1m',
    seq: BigInt(t),
    eventTime: epochMs(t),
    ingestTime: epochMs(t + 1),
    interval: '1m',
    openTime: epochMs(t),
    closeTime: epochMs(t + 1),
    open: price('100'),
    high: price('100'),
    low: price('100'),
    close: price('100'),
    volume: qty('1'),
    closed: true,
  };
}

function ticker(t: number): MarketEvent {
  return {
    kind: 'TICKER',
    venue: V,
    symbol: SYM,
    channel: 'ticker',
    seq: BigInt(t),
    eventTime: epochMs(t),
    ingestTime: epochMs(t + 1),
    bid: price('99'),
    ask: price('101'),
    last: price('100'),
  };
}

function book(t: number): MarketEvent {
  return {
    kind: 'ORDER_BOOK_SNAPSHOT',
    venue: V,
    symbol: SYM,
    channel: 'book',
    seq: BigInt(t),
    eventTime: epochMs(t),
    ingestTime: epochMs(t + 1),
    bids: [{ price: price('99'), qty: qty('1') }],
    asks: [{ price: price('101'), qty: qty('1') }],
  };
}

function execReport(t: number): ExecReport {
  return {
    reportId: `r${t}`,
    clientOrderId: clientOrderId('cbp0000000000000007000800000000000000'),
    venue: V,
    symbol: SYM,
    eventTime: epochMs(t),
    ingestTime: epochMs(t),
    kind: 'ACK',
    venueOrderId: 'v',
  };
}

function pushStream() {
  const queue: MarketEvent[] = [];
  let resolve: ((r: IteratorResult<MarketEvent>) => void) | null = null;
  let closed = false;
  const iterable: AsyncIterable<MarketEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<MarketEvent>> => {
        if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
        if (closed)
          return Promise.resolve({ value: undefined as unknown as MarketEvent, done: true });
        return new Promise((r) => (resolve = r));
      },
    }),
  };
  return {
    iterable,
    push(v: MarketEvent) {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: v, done: false });
      } else queue.push(v);
    },
    close() {
      closed = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined, done: true });
      }
    },
  };
}

const feedHealth = (): FeedHealthPort => ({
  health: () => 'LIVE',
  getRefPrice: () => undefined,
  updateRefPrice: () => undefined,
  fetchCandles: () => Promise.resolve([]),
});

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeAgenticHost(client: AgentClientPort, sink: SignalSinkPort, opts?: AgenticHostOptions) {
  const strategy = new AgenticStrategy(
    SID,
    // I1b (Design § Deleted scaffolding — B2 consult scheduler): a fresh, FLAT, non-exec-triggered
    // strategy now waits for evaluateConsultSchedule's fallback cadence before its very FIRST
    // consult (fallbackConsultBars, default 16) — every fixture in this file predates B2 and expects
    // its own single-or-few decide() calls to reach the client, so fallbackConsultBars=1 keeps every
    // bar due on schedule without touching production scheduler semantics.
    { symbol: SYM, venue: V, interval: '1m', warmupBars: 2, fallbackConsultBars: 1 },
    client,
  );
  const registry = new StrategyRegistry();
  registry.register('agentic', () => strategy);
  registry.enable(SID, 'agentic', {});
  const stream = pushStream();
  const marketStream: MarketStreamPort = { subscribe: () => stream.iterable };
  const host = new StrategyHost(marketStream, feedHealth(), sink, registry, opts);
  return { host, registry, stream, strategy };
}

describe('agentic strategy routing (cannot bypass Risk)', () => {
  it('routes an agent decision through the Risk chokepoint (host → recordSignal)', async () => {
    const recorded: Signal[] = [];
    const sink: SignalSinkPort = { recordSignal: (s) => void recorded.push(s) };
    const { host, registry, stream } = makeAgenticHost(
      new ProgrammableAgentClient(() => Promise.resolve([agentSignal()])),
      sink,
    );

    await host.start(); // agentic warmup: history only, no decide()
    expect(registry.getLifecycle(SID)).toBe('ACTIVE');

    stream.push(candle(T)); // drives a non-blocking decide()
    await tick();
    stream.close();

    expect(recorded).toHaveLength(1);
    const emitted = recorded[0]!;
    expect(emitted.kind).toBe('ENTER_LONG');
    expect(emitted.strategyId).toBe(SID);
  });

  it('mints an HMAC-proofed RiskApprovedIntent and submits it (gateway → sizer → engine → gate)', async () => {
    const { sink, submitted, journalCalls } = realChokepoint();
    const strategy = new AgenticStrategy(
      SID,
      // I1b (Design § Deleted scaffolding — B2 consult scheduler): a fresh, FLAT, non-exec-triggered
      // strategy now waits for evaluateConsultSchedule's fallback cadence before its very FIRST
      // consult (fallbackConsultBars, default 16) — every fixture in this file predates B2 and expects
      // its own single-or-few decide() calls to reach the client, so fallbackConsultBars=1 keeps every
      // bar due on schedule without touching production scheduler semantics.
      { symbol: SYM, venue: V, interval: '1m', warmupBars: 2, fallbackConsultBars: 1 },
      new ProgrammableAgentClient(() => Promise.resolve([agentSignal()])),
    );

    const proposed = (await strategy.decide(minimalInput()))[0]!;
    await sink.recordSignal(proposed);

    expect(submitted).toHaveLength(1);
    const approved = submitted[0]!;
    // RiskEngine minted a forgery-proof approval — it verifies under the same signing key.
    expect(verifyApproval(approved, KEY, epochMs(T), false)).toBe('OK');
    expect(journalCalls).toContainEqual(['APPROVED', approved.intent.intentId]);
  });

  it('rejects a stale agent signal as EXPIRED (call latency is a fail-safe, not a bypass)', async () => {
    const { sink, submitted, journalCalls } = realChokepoint();
    // A decision that resolved long after its snapshot: eventTime + ttlMs is already behind the clock.
    const stale = agentSignal({
      eventTime: epochMs(T - 10_000),
      ttlMs: 1000,
      dedupeKey: 'stale-k',
    });

    await sink.recordSignal(stale);

    expect(submitted).toHaveLength(0);
    expect(journalCalls).toContainEqual(['GATEWAY_REJECTED:EXPIRED', undefined]);
  });
});

describe('agentic host lifecycle (fire-and-forget, conflate, drain)', () => {
  it('conflates triggers while a decide() is in flight (one call at a time)', async () => {
    const resolvers: Array<(s: Signal[]) => void> = [];
    const client = new ProgrammableAgentClient(
      () => new Promise<Signal[]>((r) => resolvers.push(r)),
    );
    const { host, stream } = makeAgenticHost(client, { recordSignal: () => undefined });
    await host.start();

    stream.push(candle(T)); // decide 1 starts → busy
    await tick();
    stream.push(candle(T + 1)); // conflated while busy
    await tick();
    expect(client.calls).toBe(1);

    resolvers[0]?.([]); // free the lane
    await tick();
    stream.push(candle(T + 2)); // a fresh decide may now start
    await tick();
    expect(client.calls).toBe(2);

    resolvers[1]?.([]);
    await tick();
    stream.close();
  });

  it('drains after consecutive decide() timeouts (wall-clock fail-safe bounds a hung agent)', async () => {
    vi.useFakeTimers();
    try {
      // A decide() that never resolves: only the host's wall-clock timeout can free the lane.
      const client = new ProgrammableAgentClient(() => new Promise<Signal[]>(() => undefined));
      const { host, registry, stream } = makeAgenticHost(
        client,
        { recordSignal: () => undefined },
        { agentTimeoutMs: 50 },
      );
      await host.start();

      for (let i = 0; i < 3; i++) {
        stream.push(candle(T + i));
        // Flush the consume-loop microtasks (so the decide is dispatched), then fire the timeout.
        await vi.advanceTimersByTimeAsync(50);
      }
      stream.close();

      expect(client.calls).toBe(3); // each timeout freed the lane for the next trigger
      expect(registry.getLifecycle(SID)).toBe('DRAINING');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains after consecutive decide() rejections (fail-safe)', async () => {
    const client = new ProgrammableAgentClient(() => Promise.reject(new Error('agent down')));
    const { host, registry, stream } = makeAgenticHost(client, { recordSignal: () => undefined });
    await host.start();

    for (let i = 0; i < 3; i++) {
      stream.push(candle(T + i));
      await tick();
    }
    stream.close();

    expect(client.calls).toBe(3);
    expect(registry.getLifecycle(SID)).toBe('DRAINING');
  });

  it('folds an exec report forward and delivers it to the triggering decide snapshot', async () => {
    const client = new ProgrammableAgentClient(() => Promise.resolve([]));
    const { host, stream } = makeAgenticHost(client, { recordSignal: () => undefined });
    await host.start();

    host.enqueueExecReport(SID, execReport(T)); // queued; drained on the next stream event
    stream.push(candle(T)); // exec (priority 3) drains first → triggers a decide carrying it
    await tick();
    stream.close();

    expect(client.inputs[0]?.trigger.kind).toBe('exec');
    expect(client.inputs[0]?.snapshot.execReports).toHaveLength(1);
  });

  it('folds ticker/book state without triggering a decide, surfaced on the next candle trigger, then stops cleanly', async () => {
    const client = new ProgrammableAgentClient(() => Promise.resolve([]));
    const { host, registry, stream } = makeAgenticHost(client, { recordSignal: () => undefined });
    await host.start();

    stream.push(ticker(T));
    await tick();
    stream.push(book(T + 1));
    await tick();
    expect(client.calls).toBe(0); // ticker/book fold state only — never a trigger

    stream.push(candle(T + 2)); // candle-triggered decide sees the folded ticker/book state
    await tick();
    stream.close();

    expect(client.calls).toBe(1);
    expect(client.inputs[0]?.trigger.kind).toBe('candle');
    expect(client.inputs[0]?.snapshot.tickers.size).toBe(1);
    expect(client.inputs[0]?.snapshot.books.size).toBe(1);

    await host.stop();
    expect(registry.getLifecycle(SID)).toBe('HALTED');
  });
});

describe('live interlock (earned-live gate: a live-configured agentic boot needs a permitted verdict)', () => {
  const permittedVerdict: PromotionReadiness = {
    permitted: true,
    evidence: {
      roundTrips: 42,
      winRate: 0.55,
      realizedPnl: '120',
      fees: '4',
      llmCostUsd: '20',
      fundingNet: '0',
      netPnl: '96',
      windowDays: 21,
      firstClosedAt: 1,
      lastClosedAt: 2,
      fundingDataMissing: false,
      passivePnlQuote: null,
      reasons: [],
    },
  };

  it('throws when ACTIVE_STRATEGY=agentic and configMode=live with NO verdict (fail-closed default)', () => {
    // Gates on configMode, NOT resolveMode().effective: at boot the bot is unarmed, so effective is
    // always 'paper' there — a later runtime arm would otherwise let agentic intents reach the live venue.
    expect(() => assertAgenticLaneNotLive('agentic', 'live')).toThrow(
      /refused at configMode=live.*no readiness verdict/,
    );
  });

  it('throws on a not-permitted verdict, surfacing the unmet criteria', () => {
    const refused = {
      permitted: false,
      evidence: { ...permittedVerdict.evidence, reasons: ['INSUFFICIENT_ROUND_TRIPS'] },
    };
    expect(() => assertAgenticLaneNotLive('agentic', 'live', refused)).toThrow(
      /unmet criteria: INSUFFICIENT_ROUND_TRIPS/,
    );
  });

  it('passes on an explicitly permitted verdict — and ONLY then (arming still gates orders downstream)', () => {
    expect(() => assertAgenticLaneNotLive('agentic', 'live', permittedVerdict)).not.toThrow();
  });

  it('allows the agentic lane on paper and testnet without any verdict (its evidence-accruing home)', () => {
    expect(() => assertAgenticLaneNotLive('agentic', 'paper')).not.toThrow();
    expect(() => assertAgenticLaneNotLive('agentic', 'testnet')).not.toThrow();
  });

  it('is param-scoped: a non-agentic first argument never blocks, including in live (composition always calls this with the "agentic" literal — see app.module.ts — never with ACTIVE_STRATEGY\'s raw value)', () => {
    expect(() => assertAgenticLaneNotLive('anything-else', 'live')).not.toThrow();
  });
});

describe('StubAgentClient (inert default)', () => {
  it('proposes nothing — a deployed-but-unwired agentic lane is a no-op', async () => {
    const client = new StubAgentClient();
    await expect(client.propose(minimalInput())).resolves.toEqual({ signals: [] });
  });
});
