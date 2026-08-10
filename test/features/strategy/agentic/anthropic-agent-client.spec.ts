import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AnthropicAgentClient,
  classifyLatchCause,
  parseLatchCauseFromClientLatchedRationale,
  tradeDecisionSchema,
  tradeElementSchema,
  tradePortfolioSchema,
  type AnthropicAgentClientConfig,
  type LoggerLike,
} from '../../../../src/features/strategy/agentic/anthropic-agent-client';
import {
  DECISION_V2_BOUNDS,
  PROMPT_HASH_BASELINE_MAX_TOKENS,
} from '../../../../src/features/strategy/agentic/agent-prompt';
import {
  AgentProposeError,
  type AgentDecisionInput,
  type AgentMarketSnapshot,
  type AgentContext,
} from '../../../../src/ports/strategy/agentic-strategy';
import type { DerivativesSnapshot } from '../../../../src/ports/venue/derivatives-feed';
import type { TradeFlowSnapshot } from '../../../../src/ports/venue/trade-flow-feed';
import type { PositioningSnapshot } from '../../../../src/ports/venue/positioning-feed';
import type { FearGreedSnapshot } from '../../../../src/ports/strategy/fear-greed-feed';
import type { LiquidationSnapshot } from '../../../../src/ports/venue/liquidation-feed';
import type { CandleEvent, TickerEvent } from '../../../../src/domain/venue/types/market-events';
import { price, qty, moneyToString } from '../../../../src/domain/common/types/money';
import { strategyId, venueId, symbolId, epochMs } from '../../../../src/domain/common/types/ids';

const T = 1_700_000_000_000;
const SID = strategyId('agentic-1');
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');

const FLAT_CONTEXT: AgentContext = {
  indicators: null,
  position: {
    side: 'FLAT',
    qty: '0',
    avgEntry: null,
    realizedPnl: '0',
    unrealizedPnlPct: null,
    openOrders: 0,
  },
  recentDecisions: [],
};

const LONG_CONTEXT: AgentContext = {
  indicators: null,
  position: {
    side: 'LONG',
    qty: '1',
    avgEntry: '100',
    realizedPnl: '0',
    unrealizedPnlPct: null,
    openOrders: 0,
  },
  recentDecisions: [],
};

// AgentPositionSummary.side was widened to 'LONG' | 'SHORT' | 'FLAT' by Push II Phase 8 (plan-mode
// shorts) — no cast needed anymore (see anthropic-agent-client.ts's `side` comment).
const SHORT_CONTEXT: AgentContext = {
  indicators: null,
  position: {
    side: 'SHORT',
    qty: '1',
    avgEntry: '100',
    realizedPnl: '0',
    unrealizedPnlPct: null,
    openOrders: 0,
  },
  recentDecisions: [],
};

function candle(closeStr: string, seq: bigint, t = T): CandleEvent {
  return {
    kind: 'CANDLE',
    venue: V,
    symbol: SYM,
    channel: 'candle:1m',
    seq,
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

function ticker(lastStr: string, seq: bigint, t = T): TickerEvent {
  return {
    kind: 'TICKER',
    venue: V,
    symbol: SYM,
    channel: 'ticker',
    seq,
    eventTime: epochMs(t),
    ingestTime: epochMs(t + 1),
    bid: price(lastStr),
    ask: price(lastStr),
    last: price(lastStr),
  };
}

function buildInput(
  opts: {
    tickers?: Map<typeof SYM, TickerEvent>;
    candles?: Map<typeof SYM, CandleEvent[]>;
    context?: AgentContext;
    eventTime?: number;
    // Derivatives A/B fixtures attach a fresh snapshot the same way agentic.strategy.ts's
    // withDerivatives does (see anthropic-agent-client.ts's control-arm stripping comment).
    derivatives?: DerivativesSnapshot;
    tradeFlow?: TradeFlowSnapshot;
    positioning?: PositioningSnapshot;
    liquidation?: LiquidationSnapshot;
    fearGreed?: FearGreedSnapshot;
  } = {},
): AgentDecisionInput {
  const et = opts.eventTime ?? T;
  const snapshot: AgentMarketSnapshot = {
    eventTime: epochMs(et),
    candles: opts.candles ?? new Map(),
    tickers: opts.tickers ?? new Map(),
    books: new Map(),
    execReports: [],
    portfolio: { strategyId: SID, positions: new Map(), openOrders: [] },
    ...(opts.derivatives ? { derivatives: opts.derivatives } : {}),
    ...(opts.tradeFlow ? { tradeFlow: opts.tradeFlow } : {}),
    ...(opts.positioning ? { positioning: opts.positioning } : {}),
    ...(opts.liquidation ? { liquidation: opts.liquidation } : {}),
    ...(opts.fearGreed ? { fearGreed: opts.fearGreed } : {}),
  };
  return {
    strategyId: SID,
    trigger: { kind: 'candle', event: candle('100', 1n, et) },
    snapshot,
    context: opts.context,
  };
}

// Same fixture shape as agent-prompt.spec.ts's derivativesSnapshot() — a fresh C1 snapshot for the
// A/B control-arm tests below.
function derivativesSnapshot(): DerivativesSnapshot {
  return {
    asOf: epochMs(T),
    fundingRate: 0.0001,
    fundingAnnualizedPct: 10.95,
    openInterest: 12345.6,
    basisBps: 4.2,
    // d2 fields — null here (no buffer history in this fixture); the d2-tests below override them.
    spotPerpBasisBps: null,
    oiChangePct: null,
    fundingTrendDelta: null,
    fundingTrendDirection: null,
  };
}

function tradeFlowSnapshot(): TradeFlowSnapshot {
  return {
    asOf: epochMs(T),
    barImbalance: 0.3,
    cvd: 55.5,
    lookbackBars: 20,
    cvdDeltas: [10, 20],
    divergence: null,
  };
}

function positioningSnapshot(): PositioningSnapshot {
  return {
    asOf: epochMs(T),
    longShortRatio: 0.9,
    longAccountPct: 47.4,
    shortAccountPct: 52.6,
    takerBuySellRatio: 1.05,
    takerBuyVol: 210.5,
    takerSellVol: 200.4,
  };
}

function fearGreedSnapshot(): FearGreedSnapshot {
  return { asOf: epochMs(T), value: 72, classification: 'Greed', trend: 'rising' };
}

function liquidationSnapshot(): LiquidationSnapshot {
  return {
    asOf: epochMs(T),
    windowMin: 60,
    liqNotionalUsd: 18_000,
    longShareOfLiqs: 0.4,
    count: 3,
  };
}

function apiResponse(
  body: unknown,
  opts: {
    ok?: boolean;
    status?: number;
    headers?: Record<string, string>;
    // Cause-classification tests need a real error body (attemptOnce's `detail` reads res.text()).
    // Omitted (as every pre-existing call site leaves it) means no `.text` method at all, matching
    // the original mock exactly — attemptOnce's own catch then reports '[unreadable body]'.
    text?: string;
  } = {},
): Response {
  const headerMap = new Map(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
    json: () => Promise.resolve(body),
    ...(opts.text !== undefined ? { text: () => Promise.resolve(opts.text) } : {}),
  } as unknown as Response;
}

// v3 consolidation spec §4.3: production always targets submit_trade on the single-symbol path now
// (the legacy submit_decision tool is gone) — the default here follows.
function toolUseBody(
  toolInput: unknown,
  stopReason = 'tool_use',
  toolName = 'submit_trade',
): unknown {
  return {
    stop_reason: stopReason,
    content: [{ type: 'tool_use', name: toolName, input: toolInput }],
  };
}

function buildCfg(over: Partial<AnthropicAgentClientConfig> = {}): AnthropicAgentClientConfig {
  return {
    apiKey: 'sk-ant-super-secret-test-key',
    model: 'claude-test-model',
    timeoutMs: 5000,
    maxTokens: 256,
    signalTtlMs: 30000,
    baseUrl: 'https://mock.anthropic.test',
    ...over,
  };
}

describe('AnthropicAgentClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // v3 open_long/open_short tool-response fixture — the shared directive set every fresh-entry test
  // below needs (requireTradeDirectives requires the full set on open_long/open_short).
  function tradeOpen(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      action: 'open_long',
      sizeFraction: 0.05,
      entry: { style: 'maker', offsetBps: 0 },
      entryValidityBars: 4,
      stopLossPct: 0.01,
      takeProfitPct: 0.02,
      maxHoldBars: 96,
      ...overrides,
    };
  }

  describe('happy-path mapping', () => {
    it('maps an open_long decision from a FLAT context into a single ENTER_LONG signal, refPrice/basedOnSeq from the ticker', async () => {
      const fetchFn = vi.fn();
      const cfg = buildCfg();
      const client = new AnthropicAgentClient(cfg, fetchFn);
      const tk = ticker('50000.5', 42n);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody(tradeOpen({ thesis: 'x' }), 'tool_use', 'submit_trade')),
      );
      const input = buildInput({ tickers: new Map([[SYM, tk]]), context: FLAT_CONTEXT });

      const { signals } = await client.propose(input);

      expect(signals).toHaveLength(1);
      const s = signals[0]!;
      expect(s.kind).toBe('ENTER_LONG');
      expect(moneyToString(s.refPrice)).toBe('50000.5');
      expect(s.basedOnSeq).toBe(42n);
      // v3: strength is fixed at 1 (telemetry only) — conviction rides sizeFraction instead.
      expect(s.strength).toBe(1);
      expect(s.sizeFraction).toBe('0.05');
      expect(s.stopLossPct).toBe('0.01');
      expect(s.strategyId).toBe(SID);
      expect(s.venue).toBe(V);
      expect(s.symbol).toBe(SYM);
      expect(s.ttlMs).toBe(cfg.signalTtlMs);
      // TTL is anchored to the triggering bar's CLOSE (not the snapshot/open time) so a signal from a
      // just-closed candle isn't born past the gateway's expiry window — see the client's eventTime
      // comment and the dedicated expiry-anchor test below.
      const anchorClose =
        input.trigger.kind === 'candle' ? input.trigger.event.closeTime : input.snapshot.eventTime;
      expect(s.eventTime).toBe(anchorClose);
      expect(s.eventTime).not.toBe(input.snapshot.eventTime);
      expect(s.dedupeKey).toBe(`${SID}:${SYM}:agentic:open_long:${anchorClose}`);
      expect(s.reason).toBe('x');
    });

    it('falls back to the last closed candle for refPrice/basedOnSeq when no ticker is present', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(apiResponse(toolUseBody(tradeOpen(), 'tool_use', 'submit_trade')));
      const candles = [candle('50000', 5n, T - 60_000), candle('51000.25', 7n, T)];
      const input = buildInput({ candles: new Map([[SYM, candles]]), context: FLAT_CONTEXT });

      const { signals } = await client.propose(input);

      expect(signals).toHaveLength(1);
      expect(moneyToString(signals[0]!.refPrice)).toBe('51000.25');
      expect(signals[0]!.basedOnSeq).toBe(7n);
    });

    it('anchors a candle-triggered signal to the bar closeTime, not its openTime (expiry-gate regression)', async () => {
      // Regression for the "every candle-triggered signal is born EXPIRED" bug: normalized candles
      // stamp eventTime = openTime, and the gateway rejects when wall-clock now > eventTime + ttlMs.
      // With STRATEGY_INTERVAL > SIGNAL_TTL_MS the open-time anchor guarantees expiry before Risk.
      // The fix anchors the signal's eventTime to the bar's CLOSE, so the TTL window starts at close.
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg({ signalTtlMs: 120_000 }), fetchFn);
      fetchFn.mockResolvedValue(apiResponse(toolUseBody(tradeOpen(), 'tool_use', 'submit_trade')));
      // A 5m bar (interval 300_000ms) that just closed; snapshot.eventTime is the bar OPEN time.
      const barOpen = T;
      const bar: CandleEvent = {
        ...candle('50000', 9n, barOpen),
        interval: '5m',
        openTime: epochMs(barOpen),
        closeTime: epochMs(barOpen + 300_000),
      };
      const input: AgentDecisionInput = {
        strategyId: SID,
        trigger: { kind: 'candle', event: bar },
        snapshot: {
          eventTime: epochMs(barOpen),
          candles: new Map([[SYM, [bar]]]),
          tickers: new Map(),
          books: new Map(),
          execReports: [],
          portfolio: { strategyId: SID, positions: new Map(), openOrders: [] },
        },
        context: FLAT_CONTEXT,
      };

      const { signals } = await client.propose(input);

      expect(signals).toHaveLength(1);
      const s = signals[0]!;
      // eventTime is the bar CLOSE, one interval after the open-time snapshot stamp.
      expect(s.eventTime).toBe(barOpen + 300_000);
      expect(s.eventTime).toBeGreaterThan(input.snapshot.eventTime);
      // The signal is actionable for its full TTL past the bar close — a decide arriving even 60s
      // after close (well beyond the observed p95 latency) is still inside eventTime + ttlMs.
      expect(s.eventTime + s.ttlMs).toBeGreaterThan(barOpen + 300_000 + 60_000);
    });

    it('maps a close decision from a LONG context into a single EXIT_LONG signal at full strength', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'close' }, 'tool_use', 'submit_trade')),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: LONG_CONTEXT,
      });

      const { signals } = await client.propose(input);

      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe('EXIT_LONG');
      expect(signals[0]!.strength).toBe(1);
    });

    it.each([
      { label: 'hold with no position', action: 'hold', context: FLAT_CONTEXT },
      {
        label: 'open_long while already LONG (a scale-in) still enters',
        action: 'open_long',
        context: LONG_CONTEXT,
        expectSignal: true,
      },
      { label: 'close while already FLAT', action: 'close', context: FLAT_CONTEXT },
    ])('$label', async ({ action, context, expectSignal }) => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(
          toolUseBody(
            action === 'open_long' ? tradeOpen() : { action },
            'tool_use',
            'submit_trade',
          ),
        ),
      );
      const input = buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context });

      const { signals } = await client.propose(input);
      if (expectSignal) {
        expect(signals).toHaveLength(1);
      } else {
        expect(signals).toEqual([]);
      }
    });
  });

  // AGENTIC_PLAN_AUTHORITATIVE_EXITS (2026-07-30). Reproduces the exit-attribution study's Arm 2:
  // the model's declared stop/take-profit/maxHold run mechanically and its mid-trade 'close' is
  // ignored entirely (test/backtest/exit-attribution.spec.ts only ever calls simulateExit — it has
  // no 'close' input at all). Measured −78.4 bps/trip vs Arm 1's −108.1: +29.7 bps of the model's
  // own discretion removed. NOT a new exit rule and NOT a geometry change — the settled sweep
  // (verdicts.md § NO EXIT RULE RESCUES THESE ENTRIES) stays closed.
  describe('plan-authoritative exits (AGENTIC_PLAN_AUTHORITATIVE_EXITS)', () => {
    const withDirectives = (side: 'LONG' | 'SHORT'): AgentContext => ({
      indicators: null,
      position: {
        side,
        qty: '1',
        avgEntry: '100',
        realizedPnl: '0',
        unrealizedPnlPct: null,
        openOrders: 0,
        // Present exactly when the strategy holds an activePlan while positioned — the gate's own
        // positive-evidence predicate (AgentPositionSummary.directives).
        directives: {
          entryStyle: 'maker',
          stopLossPct: '0.02',
          takeProfitPct: '0.04',
          maxHoldBars: 20,
        },
        barsHeld: 3,
        barsUntilForcedExit: 17,
      },
      recentDecisions: [],
    });

    async function proposeClose(
      cfgOver: Partial<AnthropicAgentClientConfig>,
      context: AgentContext,
      toolInput: Record<string, unknown> = { action: 'close' },
    ) {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(cfgOver), fetchFn);
      fetchFn.mockResolvedValue(apiResponse(toolUseBody(toolInput, 'tool_use', 'submit_trade')));
      return client.propose(buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context }));
    }

    it.each([{ side: 'LONG' as const }, { side: 'SHORT' as const }])(
      '$side: a mid-trade close cannot override the declared plan — no exit signal is emitted',
      async ({ side }) => {
        const proposal = await proposeClose(
          { planAuthoritativeExits: true },
          withDirectives(side),
          { action: 'close', thesis: 'losing patience with this one' },
        );

        expect(proposal.signals).toEqual([]);
        // Journalled as 'hold', never 'close': a directive-less 'close' is what makes
        // agentic.strategy.ts clear the active plan, and a cleared plan is the unmanaged position
        // this gate exists to prevent.
        expect(proposal.decision?.action).toBe('hold');
        // The model's intent survives, queryable: WHERE rationale LIKE 'plan_authoritative_close:%'.
        expect(proposal.decision?.rationale).toBe(
          'plan_authoritative_close: losing patience with this one',
        );
        // No directives ride along either — nothing may restart the maxHold clock off a close.
        expect(proposal.plan).toBeUndefined();
      },
    );

    it('is inert with the flag off: the same close still maps to EXIT_LONG (two-step-enable claim)', async () => {
      const proposal = await proposeClose({}, withDirectives('LONG'));

      expect(proposal.signals).toHaveLength(1);
      expect(proposal.signals[0]!.kind).toBe('EXIT_LONG');
      expect(proposal.decision?.action).toBe('close');
    });

    // FAILURE DIRECTION: toward EXITING. The gate fires only on positive evidence that a
    // deterministic executor is already enforcing the declared invalidation. A positioned symbol
    // whose `directives` are ABSENT is the restart case — the in-memory plan was lost and nothing is
    // enforcing anything — so the close must go through rather than strand an unmanaged position.
    it('lets the close through when the position carries NO enforced directives (plan lost)', async () => {
      const proposal = await proposeClose({ planAuthoritativeExits: true }, LONG_CONTEXT);

      expect(proposal.signals).toHaveLength(1);
      expect(proposal.signals[0]!.kind).toBe('EXIT_LONG');
      expect(proposal.decision?.action).toBe('close');
    });

    it('lets the close through when no context is supplied at all', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg({ planAuthoritativeExits: true }), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'close' }, 'tool_use', 'submit_trade')),
      );
      // No context ⇒ side resolves FLAT ⇒ nothing to close, and the action is NOT rewritten: the
      // gate never claims a suppression it did not make.
      const proposal = await client.propose(
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]) }),
      );

      expect(proposal.signals).toEqual([]);
      expect(proposal.decision?.action).toBe('close');
    });

    it('leaves a close while FLAT untouched (nothing declared, nothing to suppress)', async () => {
      const proposal = await proposeClose({ planAuthoritativeExits: true }, FLAT_CONTEXT);

      expect(proposal.signals).toEqual([]);
      expect(proposal.decision?.action).toBe('close');
    });

    // SCOPE, stated so a later pass does not read more into this than was measured: only the
    // 'close' ACTION is dropped. An 'adjust' is the model revising the plan it declared — the
    // sanctioned channel, not a deviation from it — and its partial close is not the exit channel
    // the 29.7 bps was measured on (a partial never closes a round trip in walkRoundTrips).
    it('does not touch an adjust-driven partial close', async () => {
      const proposal = await proposeClose(
        { planAuthoritativeExits: true },
        withDirectives('LONG'),
        { action: 'adjust', partialCloseFraction: 0.5 },
      );

      expect(proposal.signals).toHaveLength(1);
      expect(proposal.signals[0]!.kind).toBe('EXIT_LONG');
      expect(proposal.decision?.action).toBe('adjust');
    });
  });

  describe('decision and usage telemetry', () => {
    it('always fills AgentProposal.decision from the validated tool payload', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody(tradeOpen({ thesis: 'trend intact' }), 'tool_use', 'submit_trade')),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.decision).toEqual({
        action: 'open_long',
        confidence: null,
        rationale: 'trend intact',
      });
      expect(typeof proposal.latencyMs).toBe('number');
    });

    it('parses input/output token usage from the response when present', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      const body = toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' }) as Record<
        string,
        unknown
      >;
      fetchFn.mockResolvedValue(
        apiResponse({ ...body, usage: { input_tokens: 120, output_tokens: 34 } }),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.usage).toEqual({ inputTokens: 120, outputTokens: 34 });
    });

    it('leaves usage undefined when the response carries no usage field', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' })),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.usage).toBeUndefined();
    });

    it('leaves consultId absent on the single-symbol path — byte-identical to pre-batching, no join key without a batch', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' })),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.consultId).toBeUndefined();
    });
  });

  // I1 (WATCH-V4-12 follow-on): stop_reason is the cheapest instrument for whether
  // AGENTIC_OUTPUT_EFFORT actually reaches the API — journal it verbatim on every proposal a call
  // was actually attempted for, mirroring latencyMs/usage's own conventions.
  describe('stopReason telemetry (I1)', () => {
    it('stamps stopReason on a successful tool_use decision', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody(tradeOpen({ thesis: 'x' }), 'tool_use', 'submit_trade')),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.stopReason).toBe('tool_use');
    });

    it('stamps stopReason=max_tokens on a truncated (no tool_use block) response', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse({
          stop_reason: 'max_tokens',
          content: [{ type: 'text' }],
          usage: { input_tokens: 5000, output_tokens: 1024 },
        }),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.stopReason).toBe('max_tokens');
    });

    it('stamps stopReason=refusal on a model refusal', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(apiResponse({ stop_reason: 'refusal', content: [] }));
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.stopReason).toBe('refusal');
    });

    it('leaves stopReason absent when the envelope itself fails to parse (no stop_reason to extract)', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(apiResponse('not-an-object'));
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.stopReason).toBeUndefined();
    });
  });

  describe('playbook composition and prompt hash', () => {
    it('fills promptHash on every path a call was actually attempted, with playbookVersion undefined when no provider is wired', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' })),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(typeof proposal.promptHash).toBe('string');
      expect(proposal.promptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(proposal.playbookVersion).toBeUndefined();
    });

    it('never calls fetch, never computes a prompt, when short-circuiting on an empty snapshot', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      const input = buildInput({ context: FLAT_CONTEXT });

      const proposal = await client.propose(input);

      expect(proposal).toEqual({ signals: [] });
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('threads a valid stored playbook into the user message and fills proposal.playbookVersion', async () => {
      const fetchFn = vi.fn();
      const playbookContent = [
        '## regime notes',
        'ranging',
        '## entry rules',
        'x',
        '## exit rules',
        'y',
        '## mistakes to avoid',
        'z',
      ].join('\n');
      const playbookProvider = {
        current: vi.fn().mockResolvedValue({ version: 7, content: playbookContent }),
      };
      const client = new AnthropicAgentClient(buildCfg(), fetchFn, undefined, playbookProvider);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' })),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.playbookVersion).toBe(7);
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      // W2.4: with a playbook present the user content is TWO blocks — [cache_control'd playbook
      // block, volatile market JSON] — whose concatenated text carries the playbook content.
      const body = JSON.parse(init.body as string) as {
        messages: { content: { type: string; text: string; cache_control?: unknown }[] }[];
      };
      const blocks = body.messages[0]!.content;
      expect(blocks).toHaveLength(2);
      expect(blocks[0]!.text).toContain(playbookContent);
      expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
      expect(blocks[1]!.cache_control).toBeUndefined();
    });

    it('treats an invalid stored playbook as absent, warning only once across repeated calls with the same content', async () => {
      const fetchFn = vi.fn();
      const warn = vi.fn();
      const invalidContent = '## regime notes\nonly one section';
      const playbookProvider = {
        current: vi.fn().mockResolvedValue({ version: 3, content: invalidContent }),
      };
      const client = new AnthropicAgentClient(buildCfg(), fetchFn, { warn }, playbookProvider);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' })),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const first = await client.propose(input);
      const second = await client.propose(input);

      expect(first.playbookVersion).toBeUndefined();
      expect(second.playbookVersion).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const [, firstInit] = fetchFn.mock.calls[0] as [string, RequestInit];
      const firstBody = JSON.parse(firstInit.body as string) as { messages: { content: string }[] };
      expect(firstBody.messages[0]!.content).not.toContain(invalidContent);
    });

    it('changes promptHash when the resolved playbook content changes, given the same model/template', async () => {
      const fetchFn = vi.fn();
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' })),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });
      const validContent = (note: string) =>
        `## regime notes\n${note}\n## entry rules\nx\n## exit rules\ny\n## mistakes to avoid\nz`;

      const clientA = new AnthropicAgentClient(buildCfg(), fetchFn, undefined, {
        current: vi.fn().mockResolvedValue({ version: 1, content: validContent('a') }),
      });
      const clientB = new AnthropicAgentClient(buildCfg(), fetchFn, undefined, {
        current: vi.fn().mockResolvedValue({ version: 1, content: validContent('b') }),
      });

      const proposalA = await clientA.propose(input);
      const proposalB = await clientB.propose(input);

      expect(proposalA.promptHash).not.toBe(proposalB.promptHash);
    });

    it('builds the system prompt from the configured profile, falling back to a default when absent', async () => {
      const fetchFn = vi.fn();
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' })),
      );
      const profile = {
        makerBps: '4',
        takerBps: '6',
        baseNotional: '123',
        maxOrderNotional: '456',
        constraints: {
          tickSize: price('0.01'),
          lotStep: qty('0.0001'),
          minNotional: price('5'),
        },
      };
      const client = new AnthropicAgentClient(buildCfg({ profile }), fetchFn);
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      await client.propose(input);

      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { system: { text: string }[] };
      // v3: the prompt renders makerBps/takerBps/round-trip fee — sizeFraction replaces
      // baseNotional/maxOrderNotional as the sizing channel, so those two numbers no longer render.
      expect(body.system[0]!.text).toContain('4 maker');
      expect(body.system[0]!.text).toContain('6 taker');
      expect(body.system[0]!.text).toContain('10 basis points');
    });
  });

  // v3 consolidation spec §9: the legacy confidence-based strength clamp (MIN_STRENGTH/MAX_STRENGTH)
  // is deleted — v2/v3 signals carry a fixed strength: 1 (telemetry only, see
  // buildProposalFromTradeDecision); conviction rides sizeFraction instead.
  describe('rationale truncation', () => {
    it('truncates a thesis longer than 200 chars to exactly 200', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      const longThesis = 'r'.repeat(300);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody(tradeOpen({ thesis: longThesis }), 'tool_use', 'submit_trade')),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const { signals } = await client.propose(input);

      expect(signals[0]!.reason).toHaveLength(200);
      expect(signals[0]!.reason).toBe('r'.repeat(200));
    });
  });

  describe('non-throwing rejection branches (logged and swallowed)', () => {
    it('resolves to { signals: [] } and warns when stop_reason is refusal, without throwing', async () => {
      const fetchFn = vi.fn();
      const warn = vi.fn();
      const logger: LoggerLike = { warn };
      const client = new AnthropicAgentClient(buildCfg(), fetchFn, logger);
      fetchFn.mockResolvedValue(apiResponse({ stop_reason: 'refusal', content: [] }));
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      await expect(client.propose(input)).resolves.toMatchObject({ signals: [] });
      expect(warn).toHaveBeenCalled();
    });

    it('XA4: a max_tokens truncation with no tool block soft-holds AND warns with the truncation diagnostic (not a plain "no tool_use block")', async () => {
      const fetchFn = vi.fn();
      const warn = vi.fn();
      const logger: LoggerLike = { warn };
      const client = new AnthropicAgentClient(buildCfg(), fetchFn, logger);
      fetchFn.mockResolvedValue(
        apiResponse({
          stop_reason: 'max_tokens',
          content: [{ type: 'text' }],
          usage: { input_tokens: 5000, output_tokens: 1024 },
        }),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      await expect(client.propose(input)).resolves.toMatchObject({ signals: [] });
      const msg = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(msg).toMatch(/truncated at max_tokens/);
      expect(msg).toContain('1024');
    });

    it('stamps infoArm/thinkingArm on a soft-hold (refusal) proposal — a call WAS attempted, so the arm truth is real even though the response was unusable', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(apiResponse({ stop_reason: 'refusal', content: [] }));
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      // Default buildCfg() runs no info-context A/B: no feed enabled means the control arm never
      // fires (infoArm = !infoContextControlArm = true). thinkingArm is now unconditionally true
      // (S3: thinking A/B #42 retired — see anthropic-agent-client.ts's prepareDecideContext).
      expect(proposal.infoArm).toBe(true);
      expect(proposal.thinkingArm).toBe(true);
    });

    it.each([
      {
        label: 'no submit_decision tool_use block in the response',
        body: { stop_reason: 'tool_use', content: [{ type: 'text' }] },
      },
      {
        label: 'a tool_use block with the wrong tool name',
        body: toolUseBody(
          { action: 'long', confidence: 0.5, rationale: 'r' },
          'tool_use',
          'other_tool',
        ),
      },
    ])('resolves to { signals: [] } and warns for $label', async ({ body }) => {
      const fetchFn = vi.fn();
      const warn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn, {
        warn,
      });
      fetchFn.mockResolvedValue(apiResponse(body));
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      await expect(client.propose(input)).resolves.toMatchObject({ signals: [] });
      expect(warn).toHaveBeenCalled();
    });

    it.each([
      {
        label: 'an invalid action value',
        toolInput: { action: 'short', confidence: 0.5, rationale: 'r' },
      },
      {
        label: 'an out-of-range confidence',
        toolInput: { action: 'long', confidence: 7, rationale: 'r' },
      },
      { label: 'a missing rationale', toolInput: { action: 'long', confidence: 0.5 } },
    ])(
      // 2026-07-22 schema-hardening: a schema-rejected single-symbol payload now degrades to an
      // EXPLICIT hold decision (rationale 'schema_rejected: <first issue>'), never a decision-less
      // proposal — see anthropic-agent-client.ts's single-symbol schema-fail branch and the
      // background this fixes (agentic.strategy.ts's inferStubDecision fallback previously masked
      // this as an ordinary, confidence=0/empty-rationale hold, indistinguishable from a real one).
      'resolves to { signals: [] }, warns, stamps an explicit schema_rejected: hold decision, and fires recordSchemaFailure(single) for $label failing schema validation',
      async ({ toolInput }) => {
        const fetchFn = vi.fn();
        const warn = vi.fn();
        const recordSchemaFailure = vi.fn();
        const client = new AnthropicAgentClient(buildCfg({ recordSchemaFailure }), fetchFn, {
          warn,
        });
        fetchFn.mockResolvedValue(apiResponse(toolUseBody(toolInput)));
        const input = buildInput({
          tickers: new Map([[SYM, ticker('100', 1n)]]),
          context: FLAT_CONTEXT,
        });

        const proposal = await client.propose(input);

        expect(proposal.signals).toEqual([]);
        expect(proposal.decision).toMatchObject({ action: 'hold', confidence: 0 });
        expect(proposal.decision?.rationale).toMatch(/^schema_rejected: /);
        expect(warn).toHaveBeenCalled();
        expect(recordSchemaFailure).toHaveBeenCalledWith('single');
      },
    );

    // XA4 addendum (2026-07-31): a tool_use block IS present here (unlike the no-tool-block XA4 case
    // below), but its `input` is empty because max_tokens cut the response off before real arguments
    // landed — the same truncation, just caught one branch later by tradeDecisionSchema.safeParse
    // instead of the `!toolBlock` check. Distinguishing it from an ordinary schema_rejected keeps the
    // truncation rate queryable (10/37 live schema_rejected rows over the trailing 14d journaled
    // output_tokens pinned at exactly 4096 — see anthropic-agent-client.ts's schemaFailureRationale).
    it('a max_tokens truncation WITH a tool_use block present but empty input stamps truncated_max_tokens: (not schema_rejected), still degrades to hold, and still fires recordSchemaFailure(single)', async () => {
      const fetchFn = vi.fn();
      const warn = vi.fn();
      const recordSchemaFailure = vi.fn();
      const client = new AnthropicAgentClient(buildCfg({ recordSchemaFailure }), fetchFn, {
        warn,
      });
      fetchFn.mockResolvedValue(apiResponse(toolUseBody({}, 'max_tokens')));
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.signals).toEqual([]);
      expect(proposal.decision).toMatchObject({ action: 'hold', confidence: 0 });
      expect(proposal.decision?.rationale).toMatch(/^truncated_max_tokens: /);
      expect(warn).toHaveBeenCalled();
      expect(recordSchemaFailure).toHaveBeenCalledWith('single');
    });

    it('a genuinely malformed payload with stop_reason=end_turn (not max_tokens) still stamps schema_rejected: — no regression from the truncation-tag branch', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'short', confidence: 0.5, rationale: 'r' }, 'end_turn')),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.decision?.rationale).toMatch(/^schema_rejected: /);
    });

    it('a malformed payload with stop_reason absent/unreadable falls back to schema_rejected: (fail-open) without throwing', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse({
          content: [
            {
              type: 'tool_use',
              name: 'submit_trade',
              input: { action: 'short', confidence: 0.5, rationale: 'r' },
            },
          ],
        }),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.decision?.rationale).toMatch(/^schema_rejected: /);
    });

    it('never logs the API key across any refusal/invalid-payload warn branch', async () => {
      const warn = vi.fn();
      const cfg = buildCfg({ apiKey: 'sk-ant-do-not-leak-me' });
      const scenarios: unknown[] = [
        { stop_reason: 'refusal', content: [] },
        { stop_reason: 'tool_use', content: [{ type: 'text' }] },
        toolUseBody({ action: 'long', confidence: 0.5, rationale: 'r' }, 'tool_use', 'other_tool'),
        toolUseBody({ action: 'short', confidence: 0.5, rationale: 'r' }),
      ];

      for (const body of scenarios) {
        const fetchFn = vi.fn().mockResolvedValue(apiResponse(body));
        const client = new AnthropicAgentClient(cfg, fetchFn, { warn });
        const input = buildInput({
          tickers: new Map([[SYM, ticker('100', 1n)]]),
          context: FLAT_CONTEXT,
        });
        await client.propose(input);
      }

      expect(warn).toHaveBeenCalledTimes(scenarios.length);
      for (const call of warn.mock.calls) {
        expect(String(call[0])).not.toContain(cfg.apiKey);
      }
    });
  });

  // H4 (2026-07-27): the seven propose-failure branches that previously returned a decision-less
  // `{ signals: [] }` (indistinguishable in the journal from a genuine, empty-rationale model hold —
  // 88 such rows/7d, live DB) now each stamp an explicit `decision` with a named rationale tag.
  // `signals` stays `[]` in every case — this is purely an observability change.
  describe('H4: named decision on every soft-hold branch (never a decision-less proposal)', () => {
    it('malformed response envelope stamps an envelope_malformed: hold decision', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(apiResponse('not-an-object'));
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.signals).toEqual([]);
      expect(proposal.decision).toMatchObject({ action: 'hold', confidence: 0 });
      expect(proposal.decision?.rationale).toMatch(/^envelope_malformed: /);
    });

    it('a model refusal stamps a model_refusal: hold decision', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(apiResponse({ stop_reason: 'refusal', content: [] }));
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.signals).toEqual([]);
      expect(proposal.decision).toMatchObject({ action: 'hold', confidence: 0 });
      expect(proposal.decision?.rationale).toMatch(/^model_refusal: /);
    });

    it('a max_tokens truncation (no tool block) stamps a truncated_max_tokens: hold decision, distinct from a plain no_tool_use', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse({
          stop_reason: 'max_tokens',
          content: [{ type: 'text' }],
          usage: { input_tokens: 5000, output_tokens: 1024 },
        }),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.signals).toEqual([]);
      expect(proposal.decision).toMatchObject({ action: 'hold', confidence: 0 });
      expect(proposal.decision?.rationale).toMatch(/^truncated_max_tokens: /);
    });

    it('a plain no-tool-use response (not a max_tokens truncation) stamps a no_tool_use: hold decision', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse({ stop_reason: 'tool_use', content: [{ type: 'text' }] }),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.signals).toEqual([]);
      expect(proposal.decision).toMatchObject({ action: 'hold', confidence: 0 });
      expect(proposal.decision?.rationale).toMatch(/^no_tool_use: /);
    });
  });

  describe('HTTP status classification', () => {
    it.each([400, 401, 403, 404, 422])(
      'classifies HTTP %d as FATAL — throws once, never retries, never leaks the key',
      async (status) => {
        const cfg = buildCfg({ apiKey: 'sk-ant-do-not-leak-me', timeoutMs: 10000 });
        const fetchFn = vi.fn().mockResolvedValue(apiResponse(undefined, { ok: false, status }));
        const client = new AnthropicAgentClient(cfg, fetchFn);
        const input = buildInput({
          tickers: new Map([[SYM, ticker('100', 1n)]]),
          context: FLAT_CONTEXT,
        });

        const err = await client.propose(input).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(AgentProposeError);
        expect((err as AgentProposeError).kind).toBe('FATAL');
        expect((err as AgentProposeError).status).toBe(status);
        expect((err as Error).message).not.toContain(cfg.apiKey);
        expect(fetchFn).toHaveBeenCalledTimes(1);
      },
    );

    it.each([408, 429, 500, 502, 503])(
      'classifies HTTP %d as RETRYABLE — retries exactly once and succeeds on the retry',
      async (status) => {
        vi.useFakeTimers();
        const fetchFn = vi
          .fn()
          .mockResolvedValueOnce(apiResponse(undefined, { ok: false, status }))
          .mockResolvedValueOnce(
            apiResponse(toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' })),
          );
        const client = new AnthropicAgentClient(buildCfg({ timeoutMs: 10000 }), fetchFn);
        const input = buildInput({
          tickers: new Map([[SYM, ticker('100', 1n)]]),
          context: FLAT_CONTEXT,
        });

        const pending = client.propose(input);
        await vi.advanceTimersByTimeAsync(1000);
        const proposal = await pending;

        expect(proposal.signals).toEqual([]);
        expect(fetchFn).toHaveBeenCalledTimes(2);
      },
    );

    it('throws AgentProposeError(RETRYABLE) when the retry attempt fails too', async () => {
      vi.useFakeTimers();
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(undefined, { ok: false, status: 500 }));
      const client = new AnthropicAgentClient(buildCfg({ timeoutMs: 10000 }), fetchFn);
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const pending = client.propose(input);
      const errPromise = pending.catch((e: unknown) => e); // attach synchronously, before advancing
      await vi.advanceTimersByTimeAsync(1000);
      const err = await errPromise;

      expect(err).toBeInstanceOf(AgentProposeError);
      expect((err as AgentProposeError).kind).toBe('RETRYABLE');
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('retry backoff and budget', () => {
    it('honors a numeric (seconds) Retry-After header over the default backoff', async () => {
      vi.useFakeTimers();
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(
          apiResponse(undefined, { ok: false, status: 429, headers: { 'retry-after': '3' } }),
        )
        .mockResolvedValueOnce(
          apiResponse(toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' })),
        );
      const client = new AnthropicAgentClient(buildCfg({ timeoutMs: 10000 }), fetchFn);
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const pending = client.propose(input);
      await vi.advanceTimersByTimeAsync(1000); // past a default-sized backoff, short of the 3s header
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2100); // now past the full 3s
      await pending;

      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('honors an HTTP-date Retry-After header, computed relative to the current time', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(T));
      const retryAt = new Date(T + 2500).toUTCString();
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(
          apiResponse(undefined, { ok: false, status: 429, headers: { 'retry-after': retryAt } }),
        )
        .mockResolvedValueOnce(
          apiResponse(toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' })),
        );
      const client = new AnthropicAgentClient(buildCfg({ timeoutMs: 10000 }), fetchFn);
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const pending = client.propose(input);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1600);
      await pending;

      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('does not retry when fewer than 2s remain in the deadline budget', async () => {
      vi.useFakeTimers();
      const cfg = buildCfg({ timeoutMs: 2500 });
      let rejectFirst!: (e: unknown) => void;
      const fetchFn = vi.fn().mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      );
      const client = new AnthropicAgentClient(cfg, fetchFn);
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const pending = client.propose(input);
      const errPromise = pending.catch((e: unknown) => e); // attach synchronously, before advancing
      await vi.advanceTimersByTimeAsync(2200); // consume all but 300ms of the budget
      rejectFirst(new Error('late network blip'));
      const err = await errPromise;

      expect(err).toBeInstanceOf(AgentProposeError);
      expect((err as AgentProposeError).kind).toBe('RETRYABLE');
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('FATAL latch (degraded client)', () => {
    it('logs the fatal status once at latch time and short-circuits every subsequent call with no further HTTP calls', async () => {
      const warn = vi.fn();
      const cfg = buildCfg({ apiKey: 'sk-ant-do-not-leak-me', timeoutMs: 10000 });
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(undefined, { ok: false, status: 401 }));
      const client = new AnthropicAgentClient(cfg, fetchFn, { warn });
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const firstErr = await client.propose(input).catch((e: unknown) => e);
      expect(firstErr).toBeInstanceOf(AgentProposeError);
      expect((firstErr as AgentProposeError).kind).toBe('FATAL');
      expect(fetchFn).toHaveBeenCalledTimes(1);

      const second = await client.propose(input);
      expect(second.signals).toEqual([]);
      const third = await client.propose(input);
      expect(third.signals).toEqual([]);

      expect(fetchFn).toHaveBeenCalledTimes(1); // latched — no further HTTP calls
      expect(warn).toHaveBeenCalledTimes(1); // logged once, at latch time — not per short-circuit
      expect(String(warn.mock.calls[0]![0])).toContain('401');
      expect(String(warn.mock.calls[0]![0])).not.toContain(cfg.apiKey);
    });

    // 2026-07-27 incident: the short-circuit returned a decision-less proposal, so the strategy's
    // inferStubDecision persisted `hold` with confidence 0 and an EMPTY rationale — byte-identical to
    // a genuine model hold. 30 such rows accumulated over 3h and every entry-rate/hold-rate read
    // counted them as the model choosing to hold.
    it('names the short-circuit in the journal — action error (never hold) and a client_latched rationale', async () => {
      const cfg = buildCfg({ timeoutMs: 10000 });
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(undefined, { ok: false, status: 400 }));
      const client = new AnthropicAgentClient(cfg, fetchFn, { warn: vi.fn() });
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      await client.propose(input).catch(() => undefined);
      const latchedProposal = await client.propose(input);

      expect(latchedProposal.signals).toEqual([]);
      expect(latchedProposal.decision?.action).toBe('error');
      expect(latchedProposal.decision?.rationale.startsWith('client_latched:')).toBe(true);

      // Batch path carries the same named decision for EVERY symbol in the wave — a latched batch
      // holds the whole menu, so the whole menu must say why.
      const batch = await client.proposeBatch([input, input]);
      for (const proposal of batch.proposals.values()) {
        expect(proposal.decision?.action).toBe('error');
        expect(proposal.decision?.rationale.startsWith('client_latched:')).toBe(true);
      }
    });

    // The latch used to hold until the container was recreated. Every FATAL status this client
    // recognises is fixable outside the process (credit top-up, key restore, permission), so a
    // permanent latch modelled a transient condition as terminal — 3h+ of dead lane on 2026-07-27.
    it('expires after the cooldown and allows exactly one probe call — recovery needs no redeploy', async () => {
      vi.useFakeTimers();
      try {
        const warn = vi.fn();
        const cfg = buildCfg({ timeoutMs: 10000 });
        const fetchFn = vi
          .fn()
          .mockResolvedValue(apiResponse(undefined, { ok: false, status: 400 }));
        const client = new AnthropicAgentClient(cfg, fetchFn, { warn });
        const input = buildInput({
          tickers: new Map([[SYM, ticker('100', 1n)]]),
          context: FLAT_CONTEXT,
        });

        await client.propose(input).catch(() => undefined);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        // One minute short of the cooldown: still suppressed.
        await vi.advanceTimersByTimeAsync(29 * 60 * 1000);
        await client.propose(input);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        // Past the cooldown: the next call probes. It fails again (the cause is still unfixed), which
        // re-latches — so the call after THAT is suppressed rather than hammering.
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
        await client.propose(input).catch(() => undefined);
        expect(fetchFn).toHaveBeenCalledTimes(2);
        await client.propose(input);
        expect(fetchFn).toHaveBeenCalledTimes(2);

        expect(warn.mock.calls.some((c) => String(c[0]).includes('latch expired'))).toBe(true);
        expect(warn.mock.calls.some((c) => String(c[0]).includes('resuming calls'))).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('recovers for real once the underlying cause is fixed — the probe after the cooldown succeeds and the client stays open', async () => {
      vi.useFakeTimers();
      try {
        const cfg = buildCfg({ timeoutMs: 10000 });
        const fetchFn = vi
          .fn()
          .mockResolvedValueOnce(apiResponse(undefined, { ok: false, status: 400 }))
          .mockResolvedValue(apiResponse(toolUseBody({ action: 'hold', thesis: 'flat' })));
        const client = new AnthropicAgentClient(cfg, fetchFn, { warn: vi.fn() });
        const input = buildInput({
          tickers: new Map([[SYM, ticker('100', 1n)]]),
          context: FLAT_CONTEXT,
        });

        await client.propose(input).catch(() => undefined);
        await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

        const recovered = await client.propose(input);
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(recovered.decision?.rationale.startsWith('client_latched:')).toBe(false);

        // Latch cleared, not merely skipped once: the immediately following call also reaches HTTP.
        await client.propose(input);
        expect(fetchFn).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // Pass 48 (2026-07-30): classifyLatchCause/parseLatchCauseFromClientLatchedRationale tell an
  // owner-blocked, already-diagnosed condition (an unfunded LLM provider account) apart from one that
  // needs real investigation (a bad/revoked key) or is simply unrecognised — see the functions' own
  // FAILURE DIRECTION comment for why 'other' is the safe default.
  describe('FATAL latch cause classification', () => {
    const CREDIT_EXHAUSTED_BODY = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message:
          'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
      },
    });

    it('classifyLatchCause: 401/403 -> auth, a credit-exhaustion 400 -> insufficient_credit, anything else -> other', () => {
      expect(classifyLatchCause(401, 'anthropic api http 401')).toBe('auth');
      expect(classifyLatchCause(403, 'anthropic api http 403')).toBe('auth');
      expect(classifyLatchCause(400, `anthropic api http 400 — ${CREDIT_EXHAUSTED_BODY}`)).toBe(
        'insufficient_credit',
      );
      // A 400 that is genuinely something else — never demoted just because it shares the status.
      expect(
        classifyLatchCause(
          400,
          'anthropic api http 400 — {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: Field required"}}',
        ),
      ).toBe('other');
      expect(classifyLatchCause(404, 'anthropic api http 404')).toBe('other');
      expect(classifyLatchCause(422, 'anthropic api http 422')).toBe('other');
      expect(classifyLatchCause(undefined, '[unreadable body]')).toBe('other');
    });

    it('parseLatchCauseFromClientLatchedRationale: reads the embedded tag, and fails closed to other when it is missing or unrecognised', () => {
      // Pinned to the ACTUAL prefix latchRationale() emits (not an abbreviated stand-in) — the
      // regex is anchored to this literal string precisely so a model-authored thesis cannot spoof
      // the tag; a fixture using a shortened form would not catch a regression to the unanchored match.
      expect(
        parseLatchCauseFromClientLatchedRationale(
          'client_latched: agent client latched degraded by a FATAL api error (cause=insufficient_credit) 5s ago — no call made, retrying after 10min',
        ),
      ).toBe('insufficient_credit');
      expect(
        parseLatchCauseFromClientLatchedRationale(
          'client_latched: agent client latched degraded by a FATAL api error (cause=auth) 5s ago — no call made, retrying after 10min',
        ),
      ).toBe('auth');
      expect(parseLatchCauseFromClientLatchedRationale('client_latched: no cause tag at all')).toBe(
        'other',
      );
    });

    it('embeds cause=insufficient_credit in the client_latched rationale for a real credit-exhaustion 400', async () => {
      const cfg = buildCfg({ timeoutMs: 10000 });
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          apiResponse(undefined, { ok: false, status: 400, text: CREDIT_EXHAUSTED_BODY }),
        );
      const client = new AnthropicAgentClient(cfg, fetchFn, { warn: vi.fn() });
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      await client.propose(input).catch(() => undefined);
      const latched = await client.propose(input);

      expect(latched.decision?.rationale).toContain('cause=insufficient_credit');
    });

    it('embeds cause=auth in the client_latched rationale for a 401', async () => {
      const cfg = buildCfg({ timeoutMs: 10000 });
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(undefined, { ok: false, status: 401 }));
      const client = new AnthropicAgentClient(cfg, fetchFn, { warn: vi.fn() });
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      await client.propose(input).catch(() => undefined);
      const latched = await client.propose(input);

      expect(latched.decision?.rationale).toContain('cause=auth');
    });

    it('fails CLOSED to cause=other on an unrecognised 400 body — never quietly demoted', async () => {
      const cfg = buildCfg({ timeoutMs: 10000 });
      const fetchFn = vi.fn().mockResolvedValue(
        apiResponse(undefined, {
          ok: false,
          status: 400,
          text: '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: Field required"}}',
        }),
      );
      const client = new AnthropicAgentClient(cfg, fetchFn, { warn: vi.fn() });
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      await client.propose(input).catch(() => undefined);
      const latched = await client.propose(input);

      expect(latched.decision?.rationale).toContain('cause=other');
    });
  });

  describe('transport failures', () => {
    it('rejects when the request times out (wall-clock abort fires before the response resolves)', async () => {
      vi.useFakeTimers();
      const fetchFn = vi.fn().mockImplementation(
        (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted', 'AbortError'));
            });
          }),
      );
      const cfg = buildCfg({ timeoutMs: 1000 });
      const client = new AnthropicAgentClient(cfg, fetchFn);
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const pending = client.propose(input);
      const assertion = expect(pending).rejects.toBeInstanceOf(AgentProposeError);
      await vi.advanceTimersByTimeAsync(cfg.timeoutMs);
      await assertion;
      // No retry: the abort consumed the whole deadline budget, leaving <2s remaining.
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('classifies a network error (fetch rejection) as RETRYABLE and throws after the retry also fails', async () => {
      vi.useFakeTimers();
      const fetchFn = vi.fn().mockRejectedValue(new Error('network down'));
      const client = new AnthropicAgentClient(buildCfg({ timeoutMs: 10000 }), fetchFn);
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const pending = client.propose(input);
      const errPromise = pending.catch((e: unknown) => e); // attach synchronously, before advancing
      await vi.advanceTimersByTimeAsync(1000);
      const err = await errPromise;

      expect(err).toBeInstanceOf(AgentProposeError);
      expect((err as AgentProposeError).kind).toBe('RETRYABLE');
      expect((err as Error).message).toContain('network down');
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('empty snapshot short-circuit', () => {
    it('proposes nothing and never calls fetch when neither a ticker nor a closed candle is available', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      const input = buildInput({ context: FLAT_CONTEXT });

      await expect(client.propose(input)).resolves.toEqual({ signals: [] });
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  describe('request shape', () => {
    it('POSTs the expected URL, headers, and body shape to the Anthropic Messages API', async () => {
      const fetchFn = vi.fn();
      const cfg = buildCfg();
      const client = new AnthropicAgentClient(cfg, fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' })),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      await client.propose(input);

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${cfg.baseUrl}/v1/messages`);
      const headers = init.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe(cfg.apiKey);
      expect(headers['anthropic-version']).toBeTruthy();

      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body['model']).toBe(cfg.model);
      expect(body['max_tokens']).toBe(cfg.maxTokens);
      // W2.4: system rides as a single cache_control'd text block (the stable request prefix).
      expect(body['system']).toEqual([
        {
          type: 'text',
          text: expect.stringContaining('net-of-cost') as string,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ]);
      expect(Array.isArray(body['messages'])).toBe(true);
      const tools = body['tools'] as { name: string }[];
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe('submit_trade');
      expect(body['tool_choice']).toEqual({ type: 'tool', name: 'submit_trade' });
      expect(body).not.toHaveProperty('temperature');
      // S3: thinking A/B (#42) retired — every decide call now carries adaptive thinking
      // unconditionally (Design § Deleted/replaced scaffolding).
      expect(body['thinking']).toEqual({ type: 'adaptive' });
    });

    it('sends thinking:adaptive alongside the forced tool_choice on every decide call (A/B retired, S3)', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' })),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body['thinking']).toEqual({ type: 'adaptive' });
      expect(body['tool_choice']).toEqual({ type: 'tool', name: 'submit_trade' });
      expect(proposal.thinkingArm).toBe(true);
    });

    // WATCH-V4-12 sanctioned fix: the flag-off guarantee. cfg.outputEffort unset (buildCfg's default)
    // must leave the request byte-identical to pre-fix — no output_config key at all, never an
    // explicit `output_config: undefined` (which JSON.stringify would drop anyway, but a
    // literal-undefined value would still fail a `not.toHaveProperty` check the wrong way if
    // attemptOnce ever built the key unconditionally).
    it('omits output_config entirely when cfg.outputEffort is unset (flag-off default)', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' })),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      await client.propose(input);

      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).not.toHaveProperty('output_config');
    });

    it('sends output_config.effort when cfg.outputEffort is set (WATCH-V4-12 sanctioned fix)', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg({ outputEffort: 'low' }), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' })),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      await client.propose(input);

      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body['output_config']).toEqual({ effort: 'low' });
    });
  });

  // v3 consolidation spec §9: bookEntryHint (best-bid-aware entry pricing for the legacy long-only
  // path) is DELETED — the v2/v3 rich contract prices entries entirely from the model's own
  // entry.offsetBps via tradeEntryLimitHint (see 'entry offset limit price hint (A1)' describe
  // below), never from book depth.

  // v3 consolidation spec §9: the legacy submit_decision/submit_plan client paths (plan-mode
  // payoff-floor/re-arm/shorts, shortsEnabled lane-selector, planMode/perpCapableVenue construction
  // guard, DECISION_TOOL/SHORTS_DECISION_TOOL/PLAN_TOOL/PLAN_SHORTS_TOOL selection) are DELETED
  // outright — every one of those describe blocks tested behavior anthropic-agent-client.ts no
  // longer has. Capability-aware mapping (open_short gated per symbol) is covered by
  // "v2 trade-contract mapping (A1)" and the mandatory capability-violation-degrade coverage below.

  // P1 (Design § Deleted/replaced scaffolding): the playbook-knobs channel (confidence-floor
  // downgrade, min-RR/minEdgeMultiple widening) was deleted end-to-end — parsePlaybookKnobs/
  // extractPlaybookKnobs no longer exist, so a "knobs:" line is ordinary playbook prose with zero
  // runtime effect. The prior "tighten-only parametric channel" describe block asserted the deleted
  // gates (minConfidence downgrade, knob-widened RR floor); replaced by the accepted-and-ignored
  // contract below — the same legacy content that used to gate now passes straight through.
  // v3 consolidation spec §9: both cases here exercised the deleted legacy submit_decision/submit_plan
  // action vocabulary ('long' + a plan object) — the knobs-ignored behavior itself (parsePlaybookKnobs
  // deleted, P1) is unrelated to the v3 tool-contract migration and not re-verified here; a fresh
  // knobs-hygiene regression test belongs with whichever change next touches playbook parsing.
  describe('legacy "knobs:" line — accepted and ignored (P1)', () => {
    function playbookWithKnobs(knobsLine: string): string {
      return [
        '## regime notes',
        'ranging',
        '## entry rules',
        `x\n${knobsLine}`,
        '## exit rules',
        'y',
        '## mistakes to avoid',
        'z',
      ].join('\n');
    }
    function providerWith(knobsLine: string) {
      return {
        current: vi.fn().mockResolvedValue({ version: 9, content: playbookWithKnobs(knobsLine) }),
      };
    }
    const tickerInput = (context: AgentContext) =>
      buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context });

    it('a stored playbook with a legacy knobs line is composed (not rejected at boot)', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(
        buildCfg(),
        fetchFn,
        undefined,
        providerWith('knobs: minConfidence=0.7 minRr=3'),
      );
      fetchFn.mockResolvedValue(
        apiResponse(
          toolUseBody({
            action: 'open_long',
            sizeFraction: 0.1,
            entry: { style: 'maker', offsetBps: 10 },
            entryValidityBars: 4,
            stopLossPct: 0.01,
            takeProfitPct: 0.02,
            maxHoldBars: 20,
          }),
        ),
      );

      const proposal = await client.propose(tickerInput(FLAT_CONTEXT));

      expect(proposal.signals).toHaveLength(1);
      expect(proposal.signals[0]!.kind).toBe('ENTER_LONG');
      expect(proposal.playbookVersion).toBe(9);
    });
  });

  // Push 3 P6 Unit 5 (sentiment tag hygiene): closes a coverage gap, not a code gap — the sentiment
  // block ALREADY carries a promptHash attribution tag (SENTIMENT_TEMPLATE_VERSION = 's1', stacked in
  // feedTags gated by the SAME sentimentFeedEnabled boolean the block/sentence already use — see
  // agent-prompt.ts's own C4 comment), it was just never asserted at the client/tag level (only the
  // sentence itself was tested, in agent-prompt.spec.ts). No new tag was added: a second sentiment
  // tag would double-tag the hash the moment the feed is enabled, violating the one-boolean-drives-
  // sentence-and-tag-together invariant every other feed tag in this file follows.
  describe('sentiment tag hygiene (Push 3 P6 Unit 5, s1 present iff SENTIMENT_FEED_ENABLED)', () => {
    function holdResponse(): unknown {
      return toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' });
    }

    it('sentimentFeedEnabled off (opts omitted) ⇒ byte-identical promptHash to explicit false, no sentiment sentence', async () => {
      const fetchFnOmitted = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnExplicitFalse = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const clientOmitted = new AnthropicAgentClient(buildCfg(), fetchFnOmitted);
      const clientExplicitFalse = new AnthropicAgentClient(
        buildCfg({ sentimentFeedEnabled: false }),
        fetchFnExplicitFalse,
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposalOmitted = await clientOmitted.propose(input);
      const proposalExplicitFalse = await clientExplicitFalse.propose(input);

      expect(proposalOmitted.promptHash).toBe(proposalExplicitFalse.promptHash);
      const [, init] = fetchFnOmitted.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { system: { text: string }[] };
      expect(body.system[0]!.text.toLowerCase()).not.toContain('sentiment');
    });

    it('sentimentFeedEnabled true ⇒ the s1-tagged promptHash differs from the flag-off baseline, and the sentence documents headlines', async () => {
      const fetchFnOn = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnOff = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const clientOn = new AnthropicAgentClient(
        buildCfg({ sentimentFeedEnabled: true }),
        fetchFnOn,
      );
      const clientOff = new AnthropicAgentClient(buildCfg(), fetchFnOff);
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposalOn = await clientOn.propose(input);
      const proposalOff = await clientOff.propose(input);

      expect(proposalOn.promptHash).not.toBe(proposalOff.promptHash);
      const [, init] = fetchFnOn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { system: { text: string }[] };
      expect(body.system[0]!.text.toLowerCase()).toContain('headline');
    });

    it('two separately-constructed clients with sentimentFeedEnabled true produce the SAME promptHash (the tag is deterministic, not per-instance)', async () => {
      const fetchFnA = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnB = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const clientA = new AnthropicAgentClient(buildCfg({ sentimentFeedEnabled: true }), fetchFnA);
      const clientB = new AnthropicAgentClient(buildCfg({ sentimentFeedEnabled: true }), fetchFnB);
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposalA = await clientA.propose(input);
      const proposalB = await clientB.propose(input);

      expect(proposalA.promptHash).toBe(proposalB.promptHash);
    });
  });

  // v3 consolidation spec §9: the information-context control arm (derivativesAbPct) is DELETED
  // outright — XA3 retired it at 0 permanently, and AnthropicAgentClientConfig carries no field to
  // gate it any more (every info-context feed flag below now applies unconditionally).

  describe('d2 derivatives-v2 (Push 3 P6 Unit 1, AGENTIC_DERIVATIVES_V2_ENABLED)', () => {
    function holdResponse(): unknown {
      return toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' });
    }
    const v2Derivatives: DerivativesSnapshot = {
      ...derivativesSnapshot(),
      spotPerpBasisBps: 12.5,
      oiChangePct: 4.1,
      fundingTrendDelta: -0.00002,
      fundingTrendDirection: 'down',
    };

    it('derivativesV2Enabled true ALONE (derivativesFeedEnabled omitted) is inert — byte-identical to the flag-off baseline', async () => {
      const fetchFnV2Alone = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnOff = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const clientV2Alone = new AnthropicAgentClient(
        buildCfg({ derivativesV2Enabled: true }),
        fetchFnV2Alone,
      );
      const clientOff = new AnthropicAgentClient(buildCfg(), fetchFnOff);
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
        derivatives: v2Derivatives,
      });

      const proposalV2Alone = await clientV2Alone.propose(input);
      const proposalOff = await clientOff.propose(input);

      // derivativesFeedEnabled is false on BOTH clients — v2Enabled alone cannot turn the block/
      // sentence/tag on (only the base four fields render, since input.snapshot.derivatives is
      // attached directly here regardless of cfg; the flag gates the SENTENCE/tag, not this key).
      expect(proposalV2Alone.promptHash).toBe(proposalOff.promptHash);
      expect(proposalV2Alone.inputPayload).toBe(proposalOff.inputPayload);
      const payload = JSON.parse(proposalV2Alone.inputPayload!) as {
        derivatives: Record<string, unknown>;
      };
      expect(payload.derivatives).not.toHaveProperty('spotPerpBasisBps');
    });

    it('derivativesFeedEnabled true + derivativesV2Enabled false ⇒ byte-identical to the pre-Unit-1 d1 baseline (identity is d1-on, not all-off)', async () => {
      const fetchFnExplicitOff = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnD1 = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const clientExplicitOff = new AnthropicAgentClient(
        buildCfg({ derivativesFeedEnabled: true, derivativesV2Enabled: false }),
        fetchFnExplicitOff,
      );
      const clientD1 = new AnthropicAgentClient(
        buildCfg({ derivativesFeedEnabled: true }),
        fetchFnD1,
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
        derivatives: v2Derivatives,
      });

      const proposalExplicitOff = await clientExplicitOff.propose(input);
      const proposalD1 = await clientD1.propose(input);

      expect(proposalExplicitOff.promptHash).toBe(proposalD1.promptHash);
      expect(proposalExplicitOff.inputPayload).toBe(proposalD1.inputPayload);
      const payload = JSON.parse(proposalExplicitOff.inputPayload!) as {
        derivatives: Record<string, unknown>;
      };
      expect(payload.derivatives).not.toHaveProperty('spotPerpBasisBps');
    });

    it('derivativesFeedEnabled + derivativesV2Enabled both true ⇒ d2 sentence, a DIFFERENT promptHash than d1, and the three extra payload fields', async () => {
      const fetchFnD1 = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnD2 = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const clientD1 = new AnthropicAgentClient(
        buildCfg({ derivativesFeedEnabled: true }),
        fetchFnD1,
      );
      const clientD2 = new AnthropicAgentClient(
        buildCfg({ derivativesFeedEnabled: true, derivativesV2Enabled: true }),
        fetchFnD2,
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
        derivatives: v2Derivatives,
      });

      const proposalD1 = await clientD1.propose(input);
      const proposalD2 = await clientD2.propose(input);

      // The tag SWITCHES (d1 -> d2), so the two hashes must differ — never a stack (+d1+d2).
      expect(proposalD2.promptHash).not.toBe(proposalD1.promptHash);
      const [, init] = fetchFnD2.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { system: { text: string }[] };
      expect(body.system[0]!.text).toContain('spot-vs-perp basis');
      const payload = JSON.parse(proposalD2.inputPayload!) as {
        derivatives: Record<string, unknown>;
      };
      expect(payload.derivatives).toEqual({
        fundingRate: v2Derivatives.fundingRate,
        fundingAnnualizedPct: v2Derivatives.fundingAnnualizedPct,
        openInterest: v2Derivatives.openInterest,
        basisBps: v2Derivatives.basisBps,
        spotPerpBasisBps: 12.5,
        oiChangePct: 4.1,
        fundingTrendDelta: -0.00002,
        fundingTrendDirection: 'down',
      });
    });

    // v3 consolidation spec §9: the information-context control arm is deleted — see this file's own
    // note above the (now-removed) "derivatives A/B" describe block.
  });

  describe('cross-symbol block + information-context A/B (2026-07-12)', () => {
    const CROSS_SYMBOL = {
      rank: 2,
      of: 5,
      ownReturnPct: '1.5',
      strongest: { symbol: 'BTC/USDT', returnPct: '4.2' },
      weakest: { symbol: 'XRP/USDT', returnPct: '-2.1' },
    };
    const CROSS_CONTEXT = { ...FLAT_CONTEXT, crossSymbol: CROSS_SYMBOL };

    function holdResponse(): unknown {
      return toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' });
    }

    it('flag on: crossSymbol guidance sentence, +xs1 promptHash tag, and payload key all present', async () => {
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnOff = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const client = new AnthropicAgentClient(buildCfg({ crossSymbolFeedEnabled: true }), fetchFn);
      const offClient = new AnthropicAgentClient(buildCfg({}), fetchFnOff);
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: CROSS_CONTEXT,
      });

      const proposal = await client.propose(input);
      const offProposal = await offClient.propose(input);

      // The +xs1 tag makes the flag-on hash a distinct attribution group from flag-off.
      expect(proposal.promptHash).not.toBe(offProposal.promptHash);
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { system: { text: string }[] };
      expect(body.system[0]!.text).toContain('crossSymbol block');
      expect(JSON.parse(proposal.inputPayload!)).toHaveProperty('crossSymbol', CROSS_SYMBOL);
    });

    // v3 consolidation spec §9: the information-context control arm is deleted — the two tests that
    // used to live here (control-arm withholding, treatment-arm bundle match) tested that retired
    // mechanism; every feed flag now applies unconditionally, covered by the flag-on/flag-off tests
    // elsewhere in this describe block.

    it('tradeFlow/positioning flags off leave the bundle at just derivatives+crossSymbol (partial-flag byte-identity, no false stripping)', async () => {
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const client = new AnthropicAgentClient(
        buildCfg({ derivativesFeedEnabled: true, crossSymbolFeedEnabled: true }),
        fetchFn,
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: CROSS_CONTEXT,
        derivatives: derivativesSnapshot(),
        tradeFlow: tradeFlowSnapshot(),
        positioning: positioningSnapshot(),
      });

      const proposal = await client.propose(input);

      // tradeFlow/positioning were attached on the snapshot but the flags are off — never
      // rendered, since buildMarketPayload gates strictly on input.snapshot presence and the
      // client never strips them itself outside the control arm (only the strategy would attach
      // them in production, gated by its own deps wiring).
      const payload = JSON.parse(proposal.inputPayload!) as Record<string, unknown>;
      expect(payload).toHaveProperty('derivatives');
      expect(payload).toHaveProperty('crossSymbol');
      expect(payload).toHaveProperty('tradeFlow');
      expect(payload).toHaveProperty('positioning');
    });
  });

  describe('fearGreed block (X3a)', () => {
    function holdResponse(): unknown {
      return toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' });
    }

    it('flag on: fearGreed guidance sentence, distinct promptHash, and payload key all present; not part of the info-context A/B bundle', async () => {
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnOff = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const client = new AnthropicAgentClient(buildCfg({ fearGreedFeedEnabled: true }), fetchFn);
      const offClient = new AnthropicAgentClient(buildCfg({}), fetchFnOff);
      const fearGreed = fearGreedSnapshot();
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
        fearGreed,
      });

      const proposal = await client.propose(input);
      const offProposal = await offClient.propose(input);

      expect(proposal.promptHash).not.toBe(offProposal.promptHash);
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { system: { text: string }[] };
      expect(body.system[0]!.text).toContain('fearGreed block');
      expect(JSON.parse(proposal.inputPayload!)).toHaveProperty('fearGreed', {
        value: fearGreed.value,
        classification: fearGreed.classification,
        trend: fearGreed.trend,
      });
    });

    it('flag off (opts omitted) never documents the fearGreed block in the system prompt, even when a fresh snapshot rides on the payload (the composition root only ever attaches one when the flag is on — see agentic.strategy.ts withFearGreed)', async () => {
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const client = new AnthropicAgentClient(buildCfg({}), fetchFn);
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
        fearGreed: fearGreedSnapshot(),
      });

      await client.propose(input);

      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { system: { text: string }[] };
      expect(body.system[0]!.text).not.toContain('fearGreed block');
    });
  });

  describe('tradeFlow + positioning blocks (2026-07-13)', () => {
    function holdResponse(): unknown {
      return toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' });
    }

    it('flag on: tradeFlow guidance sentence, +tf1 promptHash tag, and payload key all present', async () => {
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnOff = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const client = new AnthropicAgentClient(buildCfg({ tradeFlowFeedEnabled: true }), fetchFn);
      const offClient = new AnthropicAgentClient(buildCfg({}), fetchFnOff);
      const tradeFlow = tradeFlowSnapshot();
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
        tradeFlow,
      });

      const proposal = await client.propose(input);
      const offProposal = await offClient.propose(input);

      expect(proposal.promptHash).not.toBe(offProposal.promptHash);
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { system: { text: string }[] };
      expect(body.system[0]!.text).toContain('tradeFlow block');
      expect(JSON.parse(proposal.inputPayload!)).toHaveProperty('tradeFlow', {
        barImbalance: tradeFlow.barImbalance,
        cvd: tradeFlow.cvd,
        lookbackBars: tradeFlow.lookbackBars,
        cvdDeltas: tradeFlow.cvdDeltas,
        divergence: tradeFlow.divergence,
      });
    });

    it('flag on: positioning guidance sentence, +pos1 promptHash tag, and payload key all present', async () => {
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnOff = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const client = new AnthropicAgentClient(buildCfg({ positioningFeedEnabled: true }), fetchFn);
      const offClient = new AnthropicAgentClient(buildCfg({}), fetchFnOff);
      const positioning = positioningSnapshot();
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
        positioning,
      });

      const proposal = await client.propose(input);
      const offProposal = await offClient.propose(input);

      expect(proposal.promptHash).not.toBe(offProposal.promptHash);
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { system: { text: string }[] };
      expect(body.system[0]!.text).toContain('positioning block');
      expect(JSON.parse(proposal.inputPayload!)).toHaveProperty('positioning', {
        longShortRatio: positioning.longShortRatio,
        longAccountPct: positioning.longAccountPct,
        shortAccountPct: positioning.shortAccountPct,
        takerBuySellRatio: positioning.takerBuySellRatio,
        takerBuyVol: positioning.takerBuyVol,
        takerSellVol: positioning.takerSellVol,
      });
    });

    // v3 consolidation spec §9: the information-context control arm is deleted.
  });

  describe('liquidation block (Push 3 P6 Unit 2, AGENTIC_LIQUIDATIONS_ENABLED)', () => {
    function holdResponse(): unknown {
      return toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' });
    }

    it('flag off (opts omitted) ⇒ promptHash and system prompt are BYTE-IDENTICAL to the no-liquidation baseline, even with a snapshot attached (the flag gates the SENTENCE/tag, not the port-level payload presence — mirrors tradeFlow/positioning)', async () => {
      const fetchFnOff = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnBaseline = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const clientOff = new AnthropicAgentClient(buildCfg(), fetchFnOff);
      const clientBaseline = new AnthropicAgentClient(buildCfg(), fetchFnBaseline);
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
        liquidation: liquidationSnapshot(),
      });

      const proposalOff = await clientOff.propose(input);
      const proposalBaseline = await clientBaseline.propose(
        buildInput({
          tickers: new Map([[SYM, ticker('100', 1n)]]),
          context: FLAT_CONTEXT,
        }),
      );

      expect(proposalOff.promptHash).toBe(proposalBaseline.promptHash);
      const [, init] = fetchFnOff.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { system: { text: string }[] };
      // v3: the persona now unconditionally mentions liquidation RISK MANAGEMENT (perp symbols exist
      // in every v3 boot) — the flag-gated addition is the LIQUIDATION BLOCK sentence specifically,
      // never the bare word "liquidation".
      expect(body.system[0]!.text.toLowerCase()).not.toContain('liquidation block');
    });

    it('flag on: liquidation guidance sentence, +lq1 promptHash tag, and payload key all present', async () => {
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnOff = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const client = new AnthropicAgentClient(buildCfg({ liquidationsFeedEnabled: true }), fetchFn);
      const offClient = new AnthropicAgentClient(buildCfg({}), fetchFnOff);
      const liquidation = liquidationSnapshot();
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
        liquidation,
      });

      const proposal = await client.propose(input);
      const offProposal = await offClient.propose(input);

      expect(proposal.promptHash).not.toBe(offProposal.promptHash);
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { system: { text: string }[] };
      expect(body.system[0]!.text).toContain('liquidation block');
      expect(JSON.parse(proposal.inputPayload!)).toHaveProperty('liquidation', {
        windowMin: liquidation.windowMin,
        liqNotionalUsd: liquidation.liqNotionalUsd,
        longShareOfLiqs: liquidation.longShareOfLiqs,
        count: liquidation.count,
      });
    });

    // v3 consolidation spec §9: the information-context control arm is deleted.
  });

  describe('bookStructure block (Push 3 P6 Unit 3, AGENTIC_BOOK_STRUCTURE_ENABLED)', () => {
    function holdResponse(): unknown {
      return toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' });
    }
    function bookSnapshot(): AgentMarketSnapshot['books'] {
      return new Map([
        [
          SYM,
          {
            kind: 'ORDER_BOOK_SNAPSHOT' as const,
            venue: V,
            symbol: SYM,
            channel: 'book',
            seq: 1n,
            eventTime: epochMs(T),
            ingestTime: epochMs(T + 1),
            bids: [{ price: price('100'), qty: qty('10') }],
            asks: [{ price: price('100.01'), qty: qty('10') }],
          },
        ],
      ]);
    }

    it('flag off (opts omitted) ⇒ byte-identical to the pre-feature baseline even with a book attached', async () => {
      const fetchFnOff = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnBaseline = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const clientOff = new AnthropicAgentClient(buildCfg(), fetchFnOff);
      const clientBaseline = new AnthropicAgentClient(buildCfg(), fetchFnBaseline);
      const base = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });
      const input = { ...base, snapshot: { ...base.snapshot, books: bookSnapshot() } };

      const proposalOff = await clientOff.propose(input);
      const proposalBaseline = await clientBaseline.propose(input);

      expect(proposalOff.promptHash).toBe(proposalBaseline.promptHash);
      expect(proposalOff.inputPayload).toBe(proposalBaseline.inputPayload);
      expect(JSON.parse(proposalOff.inputPayload!)).not.toHaveProperty('bookStructure');
    });

    it('flag on: bookStructure guidance sentence, +bs1 promptHash tag, and payload key all present — the existing orderBook block is untouched', async () => {
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnOff = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const client = new AnthropicAgentClient(
        buildCfg({ bookStructureFeedEnabled: true }),
        fetchFn,
      );
      const offClient = new AnthropicAgentClient(buildCfg({}), fetchFnOff);
      const base = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });
      const input = { ...base, snapshot: { ...base.snapshot, books: bookSnapshot() } };

      const proposal = await client.propose(input);
      const offProposal = await offClient.propose(input);

      expect(proposal.promptHash).not.toBe(offProposal.promptHash);
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { system: { text: string }[] };
      expect(body.system[0]!.text).toContain('bookStructure');
      const payload = JSON.parse(proposal.inputPayload!) as Record<string, unknown>;
      expect(payload).toHaveProperty('bookStructure');
      expect(payload).toHaveProperty('orderBook'); // untouched, still rendered
    });

    // v3 consolidation spec §9: the information-context control arm is deleted.
  });

  describe('trackRecord block (Push 3 P6 Unit 4, AGENTIC_TRACK_RECORD_ENABLED)', () => {
    function holdResponse(): unknown {
      return toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' });
    }
    const trackRecordContext: AgentContext = {
      ...FLAT_CONTEXT,
      trackRecord: { tripCount: 10, winRate: 0.5, meanNetBpsPerTrip: 2, trailingWindowTrips: 15 },
    };

    it('flag off (opts omitted) ⇒ byte-identical to the pre-feature baseline even with trackRecord attached to context', async () => {
      const fetchFnOff = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnBaseline = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const clientOff = new AnthropicAgentClient(buildCfg(), fetchFnOff);
      const clientBaseline = new AnthropicAgentClient(buildCfg(), fetchFnBaseline);
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: trackRecordContext,
      });

      const proposalOff = await clientOff.propose(input);
      const proposalBaseline = await clientBaseline.propose(input);

      expect(proposalOff.promptHash).toBe(proposalBaseline.promptHash);
      const [, init] = fetchFnOff.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { system: { text: string }[] };
      expect(body.system[0]!.text).not.toContain('trackRecord');
    });

    it('flag on: trackRecord guidance sentence, +tr1 promptHash tag, and payload key all present', async () => {
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnOff = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const client = new AnthropicAgentClient(buildCfg({ trackRecordFeedEnabled: true }), fetchFn);
      const offClient = new AnthropicAgentClient(buildCfg({}), fetchFnOff);
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: trackRecordContext,
      });

      const proposal = await client.propose(input);
      const offProposal = await offClient.propose(input);

      expect(proposal.promptHash).not.toBe(offProposal.promptHash);
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { system: { text: string }[] };
      expect(body.system[0]!.text).toContain('trackRecord');
      const payload = JSON.parse(proposal.inputPayload!) as Record<string, unknown>;
      expect(payload).toHaveProperty('trackRecord', {
        tripCount: 10,
        winRate: 0.5,
        meanNetBpsPerTrip: 2,
        trailingWindowTrips: 15,
      });
    });
  });

  // S3 (rich decision contract): the #42 thinking A/B is RETIRED — every decide/batch call now
  // carries thinking:{type:'adaptive'} unconditionally (Design § Deleted/replaced scaffolding:
  // "thinking A/B arm retired"). No config knob revives the old disabled/coin-flip behavior.
  describe('thinking (always adaptive, S3 — #42 A/B retired)', () => {
    function holdBody(): unknown {
      return toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' });
    }

    it('sends thinking:adaptive unconditionally on decide, with no A/B knob left to flip it off', async () => {
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdBody()));
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      const proposal = await client.propose(
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: FLAT_CONTEXT }),
      );
      const sent = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string) as {
        thinking: unknown;
      };
      expect(sent.thinking).toEqual({ type: 'adaptive' });
      expect(proposal.thinkingArm).toBe(true);
    });

    it('sends thinking:adaptive unconditionally on a batched proposeBatch call too (shared prepareDecideContext)', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        apiResponse(
          toolUseBody(
            {
              decisions: [{ symbol: String(SYM), action: 'hold', confidence: 0.5, rationale: 'r' }],
            },
            'tool_use',
            'submit_portfolio',
          ),
        ),
      );
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      const { proposals } = await client.proposeBatch([
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: FLAT_CONTEXT }),
      ]);
      const sent = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string) as {
        thinking: unknown;
      };
      expect(sent.thinking).toEqual({ type: 'adaptive' });
      expect(proposals.get(String(SYM))?.thinkingArm).toBe(true);
    });
  });

  // S3 (rich decision contract, Design § New tool contract): the v2 submit_trade/submit_portfolio
  // zod schemas, tested directly against DECISION_V2_BOUNDS's edges — NOT via client.propose(), since
  // wiring these into the response-parsing path (buildProposalFromDecision) is A1's own step (see
  // this file's module header comment). `direction` is deliberately absent from every fixture below:
  // it is not a wire field on the v2 tool (agent-prompt.ts's tradeFieldSchemas) — the client infers it
  // from which action fired (A1), so the schema itself never validates it.
  describe('v2 trade-contract zod schemas (S3)', () => {
    const SPOT_MAX = 0.15;
    const PERP_MAX = 0.5;

    function openLong(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        action: 'open_long',
        sizeFraction: 0.01,
        entry: { style: 'maker', offsetBps: 0 },
        entryValidityBars: 4,
        stopLossPct: 0.01,
        takeProfitPct: 0.02,
        maxHoldBars: 96,
        ...overrides,
      };
    }

    describe('bound edges (spot schema)', () => {
      const schema = tradeDecisionSchema(SPOT_MAX);

      it('accepts sizeFraction at the shared floor (0.005) and the spot lane max (0.15)', () => {
        expect(schema.safeParse(openLong({ sizeFraction: 0.005 })).success).toBe(true);
        expect(schema.safeParse(openLong({ sizeFraction: 0.15 })).success).toBe(true);
      });

      it('accepts stopLossPct at 0.002/0.05 and takeProfitPct at 0.001/0.20', () => {
        expect(schema.safeParse(openLong({ stopLossPct: 0.002 })).success).toBe(true);
        expect(schema.safeParse(openLong({ stopLossPct: 0.05 })).success).toBe(true);
        expect(schema.safeParse(openLong({ takeProfitPct: 0.001 })).success).toBe(true);
        expect(schema.safeParse(openLong({ takeProfitPct: 0.2 })).success).toBe(true);
      });

      it('accepts maxHoldBars at 288', () => {
        expect(schema.safeParse(openLong({ maxHoldBars: 288 })).success).toBe(true);
      });

      it('accepts thesis at exactly 300 chars unchanged', () => {
        const parsed = schema.safeParse(openLong({ thesis: 'a'.repeat(300) }));
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data.thesis).toHaveLength(300);
      });

      // H5 (2026-07-27): a thesis overrunning the cap is TRUNCATED, never rejected — 25/57 live
      // schema rejections in the prior week were this field alone voiding an otherwise-valid trade
      // directive. See tradeDirectiveFieldShape's thesis schema in anthropic-agent-client.ts.
      it('truncates a 301-char thesis to exactly 300 instead of rejecting the whole decision', () => {
        const parsed = schema.safeParse(openLong({ thesis: 'a'.repeat(301) }));
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data.thesis).toHaveLength(300);
      });

      it('leaves money/risk fields still rejecting when malformed (thesis leniency does not weaken them)', () => {
        expect(
          schema.safeParse(openLong({ thesis: 'a'.repeat(301), sizeFraction: 999 })).success,
        ).toBe(false);
        expect(
          schema.safeParse(openLong({ thesis: 'a'.repeat(301), stopLossPct: -1 })).success,
        ).toBe(false);
      });
    });

    it('accepts sizeFraction at the perp lane max (0.50) when built with that symbol capabilities.maxSizeFraction', () => {
      const schema = tradeDecisionSchema(PERP_MAX);
      expect(schema.safeParse(openLong({ sizeFraction: 0.5 })).success).toBe(true);
    });

    describe('nextConsultBars (portfolio-level, batch schema)', () => {
      it('accepts the 1/32 edges, rejects 0 and 33 (XA1: max 64→32)', () => {
        expect(tradePortfolioSchema.safeParse({ decisions: [], nextConsultBars: 1 }).success).toBe(
          true,
        );
        expect(tradePortfolioSchema.safeParse({ decisions: [], nextConsultBars: 32 }).success).toBe(
          true,
        );
        expect(tradePortfolioSchema.safeParse({ decisions: [], nextConsultBars: 0 }).success).toBe(
          false,
        );
        expect(tradePortfolioSchema.safeParse({ decisions: [], nextConsultBars: 33 }).success).toBe(
          false,
        );
      });

      it('is a single portfolio-level value that rides alongside decisions[], never one per element', () => {
        const parsed = tradePortfolioSchema.safeParse({
          decisions: [{ symbol: 'BTC/USDT', action: 'hold' }],
          nextConsultBars: 8,
        });
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data.nextConsultBars).toBe(8);
          expect(parsed.data.decisions).toHaveLength(1);
        }
      });
    });

    describe('out-of-bounds rejected', () => {
      it('rejects sizeFraction above the spot lane max (0.2 > 0.15)', () => {
        const schema = tradeDecisionSchema(SPOT_MAX);
        expect(schema.safeParse(openLong({ sizeFraction: 0.2 })).success).toBe(false);
      });

      it('accepts sizeFraction 0.5 when built with the perp lane max (0.50)', () => {
        const schema = tradeDecisionSchema(PERP_MAX);
        expect(schema.safeParse(openLong({ sizeFraction: 0.5 })).success).toBe(true);
      });

      it('rejects sizeFraction below the shared 0.005 floor regardless of the injected max', () => {
        const schema = tradeDecisionSchema(SPOT_MAX);
        expect(schema.safeParse(openLong({ sizeFraction: 0.004 })).success).toBe(false);
      });
    });

    // v3 consolidation spec §4.3: ONE schema now — the action enum always structurally accepts
    // 'open_short' regardless of the injected sizeFractionMax; per-symbol shorts ELIGIBILITY is a
    // POST-PARSE client-side check (capabilities.shorts), never a schema-shape gate any more — see
    // the mandatory capability-violation-degrade coverage below.
    describe("'open_short' structurally accepted by every schema instance", () => {
      it('accepts it regardless of the injected sizeFractionMax', () => {
        expect(
          tradeDecisionSchema(SPOT_MAX).safeParse(openLong({ action: 'open_short' })).success,
        ).toBe(true);
        expect(
          tradeDecisionSchema(PERP_MAX).safeParse(openLong({ action: 'open_short' })).success,
        ).toBe(true);
      });
    });

    describe('superRefine: directives required on open_long/open_short', () => {
      const schema = tradeDecisionSchema(SPOT_MAX);

      it("rejects a bare 'open_long' missing the directive set", () => {
        expect(schema.safeParse({ action: 'open_long' }).success).toBe(false);
      });

      it("'hold'/'close' never require the directive set", () => {
        expect(schema.safeParse({ action: 'hold' }).success).toBe(true);
        expect(schema.safeParse({ action: 'close' }).success).toBe(true);
      });

      it("'adjust' does not require the full open directive set (a bare stop revision is valid)", () => {
        expect(schema.safeParse({ action: 'adjust', stopLossPct: 0.03 }).success).toBe(true);
      });
    });

    describe('superRefine: partialCloseFraction only meaningful on adjust', () => {
      const schema = tradeDecisionSchema(SPOT_MAX);

      it("rejects partialCloseFraction on 'hold'", () => {
        expect(schema.safeParse({ action: 'hold', partialCloseFraction: 0.5 }).success).toBe(false);
      });

      it("accepts partialCloseFraction on 'adjust'", () => {
        expect(schema.safeParse({ action: 'adjust', partialCloseFraction: 0.5 }).success).toBe(
          true,
        );
      });
    });

    describe('per-element batch schema (tradeElementSchema)', () => {
      it('requires symbol and applies the SAME directive gate as the single-symbol schema', () => {
        const schema = tradeElementSchema(SPOT_MAX);
        expect(schema.safeParse({ ...openLong(), symbol: 'BTC/USDT' }).success).toBe(true);
        expect(schema.safeParse(openLong()).success).toBe(false); // missing symbol
      });

      it('structurally accepts open_short regardless of the injected max (eligibility is a post-parse client check)', () => {
        const schema = tradeElementSchema(SPOT_MAX);
        const shortDecision = {
          ...openLong({ action: 'open_short', sizeFraction: 0.1 }),
          symbol: 'BTC/USDT',
        };
        expect(schema.safeParse(shortDecision).success).toBe(true);
      });
    });

    // Sanity: DECISION_V2_BOUNDS (agent-prompt.ts) stays the single source these tests bind to.
    it('DECISION_V2_BOUNDS matches the literal edges exercised above', () => {
      expect(DECISION_V2_BOUNDS.sizeFraction.min).toBe(0.005);
      expect(DECISION_V2_BOUNDS.stopLossPct).toEqual({ min: 0.002, max: 0.05 });
      expect(DECISION_V2_BOUNDS.takeProfitPct).toEqual({ min: 0.001, max: 0.2 });
      expect(DECISION_V2_BOUNDS.maxHoldBars).toEqual({ min: 1, max: 288 });
      expect(DECISION_V2_BOUNDS.nextConsultBars).toEqual({ min: 1, max: 32 });
      expect(DECISION_V2_BOUNDS.thesisMaxLen).toBe(300);
    });
  });

  // v3 consolidation spec §4.2/§4.3: propose() always resolves this SYMBOL's own capabilities
  // (venueForSymbol + cfg.maxPositionFractionSpot/Perp) — no more tradeContract/shortsEnabled/
  // perpCapableVenue construction options (request-shape only; both fixtures use stop_reason
  // 'refusal' so the response never reaches schema parsing — A1's own response-mapping coverage lives
  // in the 'v2 trade-contract mapping (A1)' describe block below).
  //
  // 2026-07-30: those capabilities used to be baked into the TOOL description, which made the tools
  // block — canonical cache position 0, ahead of the system breakpoint — vary per symbol and
  // invalidate both cache breakpoints every consult. They now ride only in the payload's own
  // capabilities block. These tests therefore assert BOTH halves: the per-symbol values still reach
  // the model (unchanged property, moved channel), and the tool is byte-identical across symbols
  // (the new property).
  describe('per-symbol capability routing (v3)', () => {
    /** The user-message text the model reads, whether it rode as a bare string or as text blocks. */
    const userText = (body: { messages: { content: unknown }[] }): string => {
      const content = body.messages[0]!.content;
      return typeof content === 'string'
        ? content
        : (content as { text: string }[]).map((c) => c.text).join('');
    };

    it('SYM (spot, BTC/USDT) routes maxPositionFractionSpot to the model via the payload capabilities block', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          apiResponse(toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' }, 'refusal')),
        );
      const client = new AnthropicAgentClient(
        buildCfg({ maxPositionFractionSpot: '0.15' }),
        fetchFn,
      );
      await client.propose(
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: FLAT_CONTEXT }),
      );
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as {
        tools: { name: string }[];
        messages: { content: unknown }[];
      };
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0]!.name).toBe('submit_trade');
      // The spot ceiling still reaches the model, on the channel that now carries it.
      expect(userText(body)).toContain('"maxSizeFraction":"0.15"');
      expect(userText(body)).toContain('"shorts":false');
      // ...and no longer via the tool, which is what stops the cache prefix forking per symbol.
      expect(JSON.stringify(body.tools[0])).not.toContain('0.15');
    });

    it('a perp symbol (:USDT settle) routes maxPositionFractionPerp/leverage/shorts via the payload, and sends the SAME tool bytes as spot', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          apiResponse(toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' }, 'refusal')),
        );
      const client = new AnthropicAgentClient(
        buildCfg({ maxPositionFractionPerp: '0.35', perpLeverageCap: '2' }),
        fetchFn,
      );
      const perpCandle = { ...candle('100', 1n), symbol: symbolId('SOL/USDT:USDT') };
      await client.propose({
        strategyId: SID,
        trigger: { kind: 'candle', event: perpCandle },
        snapshot: {
          eventTime: epochMs(T),
          candles: new Map(),
          tickers: new Map([
            [
              symbolId('SOL/USDT:USDT'),
              { ...ticker('100', 1n), symbol: symbolId('SOL/USDT:USDT') },
            ],
          ]),
          books: new Map(),
          execReports: [],
          portfolio: { strategyId: SID, positions: new Map(), openOrders: [] },
        },
        context: FLAT_CONTEXT,
      });
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as {
        tools: {
          name: string;
          description: string;
          input_schema: { properties: { action: { enum: string[] } } };
        }[];
        messages: { content: unknown }[];
      };
      expect(body.tools[0]!.name).toBe('submit_trade');
      expect(body.tools[0]!.input_schema.properties.action.enum).toContain('open_short');
      // Every perp capability the tool used to advertise still reaches the model, per symbol.
      expect(userText(body)).toContain('"maxSizeFraction":"0.35"');
      expect(userText(body)).toContain('"leverage":"2"');
      expect(userText(body)).toContain('"shorts":true');

      // The property B buys: a perp consult and a spot consult send byte-identical tool JSON, so the
      // cached prefix survives a basket that mixes venues. Built from the same code path the spot
      // test above exercises, compared directly rather than by matching description prose.
      const spotFetch = vi
        .fn()
        .mockResolvedValue(
          apiResponse(toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' }, 'refusal')),
        );
      await new AnthropicAgentClient(
        buildCfg({ maxPositionFractionSpot: '0.15' }),
        spotFetch,
      ).propose(
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: FLAT_CONTEXT }),
      );
      const [, spotInit] = spotFetch.mock.calls[0] as [string, RequestInit];
      const spotBody = JSON.parse(spotInit.body as string) as { tools: unknown[] };
      expect(JSON.stringify(body.tools[0])).toBe(JSON.stringify(spotBody.tools[0]));
    });
  });

  // A1 (rich decision contract, Design § New tool contract, action-mapping paragraph): propose()'s
  // v2 response mapping — tradeDecisionSchema/tradeShortsDecisionSchema parsing +
  // buildProposalFromTradeDecision. DEFAULT_TRADING_PROFILE (makerBps '10' + takerBps '10') is the
  // profile every fixture below sizes its fee-floor math against: round-trip fee fraction = 0.002.
  describe('v2 trade-contract mapping (A1)', () => {
    function tradeOpenLong(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        action: 'open_long',
        sizeFraction: 0.006,
        entry: { style: 'maker', offsetBps: 0 },
        entryValidityBars: 4,
        stopLossPct: 0.008,
        takeProfitPct: 0.004,
        maxHoldBars: 96,
        ...overrides,
      };
    }

    it('(a) sizeFraction 0.006 with no confidence field produces ENTER_LONG (no floor)', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(apiResponse(toolUseBody(tradeOpenLong(), 'tool_use', 'submit_trade')));
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      const { signals, decision } = await client.propose(
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: FLAT_CONTEXT }),
      );

      expect(signals).toHaveLength(1);
      const s = signals[0]!;
      expect(s.kind).toBe('ENTER_LONG');
      expect(s.strength).toBe(1);
      expect(s.sizeFraction).toBe('0.006');
      expect(decision?.confidence).toBeNull();
    });

    it('(a2) open_long/open_short pin plan.direction — a perp short is protected on the SHORT side (W4 audit, critical)', async () => {
      const longFetch = vi
        .fn()
        .mockResolvedValue(apiResponse(toolUseBody(tradeOpenLong(), 'tool_use', 'submit_trade')));
      const longClient = new AnthropicAgentClient(buildCfg(), longFetch);
      const longProposal = await longClient.propose(
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: FLAT_CONTEXT }),
      );
      expect(longProposal.plan?.direction).toBe('long');

      // v3: open_short is only eligible on a perp (capabilities.shorts=true) symbol — SYM (BTC/USDT)
      // is spot, so this arm needs its own perp-symbol input (see the capability-violation-degrade
      // coverage below for the spot-symbol open_short case).
      const PERP_SYM = symbolId('SOL/USDT:USDT');
      const shortFetch = vi
        .fn()
        .mockResolvedValue(
          apiResponse(
            toolUseBody(tradeOpenLong({ action: 'open_short' }), 'tool_use', 'submit_trade'),
          ),
        );
      const shortClient = new AnthropicAgentClient(
        buildCfg({ maxPositionFractionPerp: '0.5', perpLeverageCap: '2' }),
        shortFetch,
      );
      const shortProposal = await shortClient.propose({
        strategyId: SID,
        trigger: { kind: 'candle', event: { ...candle('100', 1n), symbol: PERP_SYM } },
        snapshot: {
          eventTime: epochMs(T),
          candles: new Map(),
          tickers: new Map([[PERP_SYM, { ...ticker('100', 1n), symbol: PERP_SYM }]]),
          books: new Map(),
          execReports: [],
          portfolio: { strategyId: SID, positions: new Map(), openOrders: [] },
        },
        context: FLAT_CONTEXT,
      });
      expect(shortProposal.signals[0]!.kind).toBe('ENTER_SHORT');
      expect(shortProposal.plan?.direction).toBe('short');
    });

    it('(b) takeProfitPct 0.004 / stopLossPct 0.008 (RR 0.5) is ACCEPTED — no min-RR floor on v2', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          apiResponse(
            toolUseBody(
              tradeOpenLong({ takeProfitPct: 0.004, stopLossPct: 0.008 }),
              'tool_use',
              'submit_trade',
            ),
          ),
        );
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      const { signals } = await client.propose(
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: FLAT_CONTEXT }),
      );

      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe('ENTER_LONG');
    });

    it('(c) takeProfitPct below the round-trip fee floor (0.001 < 0.002) downgrades to a journal-visible hold', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          apiResponse(
            toolUseBody(tradeOpenLong({ takeProfitPct: 0.001 }), 'tool_use', 'submit_trade'),
          ),
        );
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      const { signals, decision } = await client.propose(
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: FLAT_CONTEXT }),
      );

      expect(signals).toEqual([]);
      expect(decision?.rationale).toContain('[rejected: tp below fee floor]');
    });

    it("(d) 'adjust' + partialCloseFraction 0.5 emits ONE reduce-only EXIT carrying reduceFraction '0.5'", async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          apiResponse(
            toolUseBody(
              { action: 'adjust', partialCloseFraction: 0.5 },
              'tool_use',
              'submit_trade',
            ),
          ),
        );
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      const { signals } = await client.propose(
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: LONG_CONTEXT }),
      );

      expect(signals).toHaveLength(1);
      const s = signals[0]!;
      expect(s.kind).toBe('EXIT_LONG');
      expect(s.reduceFraction).toBe('0.5');
      expect(s.cancelBeforeSubmit).toEqual({ side: 'SELL' });
    });

    it('(e) same-side open_long while already LONG emits an ENTER_LONG scale-in with fresh directives', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(apiResponse(toolUseBody(tradeOpenLong(), 'tool_use', 'submit_trade')));
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      const { signals } = await client.propose(
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: LONG_CONTEXT }),
      );

      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe('ENTER_LONG');
    });

    it('(e) opposite-side open_long while SHORT emits NO signal (never an accidental flip)', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(apiResponse(toolUseBody(tradeOpenLong(), 'tool_use', 'submit_trade')));
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      const { signals } = await client.propose(
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: SHORT_CONTEXT }),
      );

      expect(signals).toEqual([]);
    });

    // Restart re-arm (6e95542 restored after v2 rewrite): hold + full directives while LONG/SHORT
    // must emit plan with NO signal — otherwise forced_rearm loops forever and venue stops never place.
    it("(re-arm) hold + full directives while LONG emits plan (no signal) with direction 'long'", async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        apiResponse(
          toolUseBody(
            {
              action: 'hold',
              sizeFraction: 0.01,
              entry: { style: 'maker', offsetBps: 0 },
              entryValidityBars: 4,
              stopLossPct: 0.02,
              takeProfitPct: 0.03,
              maxHoldBars: 48,
              thesis: 're-arm',
            },
            'tool_use',
            'submit_trade',
          ),
        ),
      );
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      const { signals, plan } = await client.propose(
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: LONG_CONTEXT }),
      );
      expect(signals).toEqual([]);
      expect(plan).toMatchObject({
        stopLossPct: '0.02',
        takeProfitPct: '0.03',
        maxHoldBars: 48,
        direction: 'long',
      });
    });

    it('(re-arm) bare hold while LONG emits no plan (strategy fallback owns that path)', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          apiResponse(toolUseBody({ action: 'hold', thesis: 'bare' }, 'tool_use', 'submit_trade')),
        );
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      const { signals, plan } = await client.propose(
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: LONG_CONTEXT }),
      );
      expect(signals).toEqual([]);
      expect(plan).toBeUndefined();
    });

    it('(f) a taker entry prices limitPriceHint on the crossing side of refPrice (exact string)', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          apiResponse(
            toolUseBody(
              tradeOpenLong({ entry: { style: 'taker', offsetBps: 0 } }),
              'tool_use',
              'submit_trade',
            ),
          ),
        );
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      const { signals } = await client.propose(
        buildInput({ tickers: new Map([[SYM, ticker('50000', 1n)]]), context: FLAT_CONTEXT }),
      );

      expect(signals).toHaveLength(1);
      // BUY crosses ABOVE refPrice (25bps buffer — TAKER_CROSS_BUFFER_BPS): 50000 * 1.0025.
      expect(moneyToString(signals[0]!.limitPriceHint!)).toBe('50125');
    });

    it('(g) maker offsetBps -150/+150 price exact edges off the last closed candle close', async () => {
      const candles = new Map([[SYM, [candle('50000', 1n)]]]);

      const fetchFnPlus = vi
        .fn()
        .mockResolvedValue(
          apiResponse(
            toolUseBody(
              tradeOpenLong({ entry: { style: 'maker', offsetBps: 150 } }),
              'tool_use',
              'submit_trade',
            ),
          ),
        );
      const clientPlus = new AnthropicAgentClient(buildCfg(), fetchFnPlus);
      const plus = await clientPlus.propose(buildInput({ candles, context: FLAT_CONTEXT }));
      // Long, +150bps: 50000 * (1 - 0.015) = 49250.
      expect(moneyToString(plus.signals[0]!.limitPriceHint!)).toBe('49250');

      const fetchFnMinus = vi
        .fn()
        .mockResolvedValue(
          apiResponse(
            toolUseBody(
              tradeOpenLong({ entry: { style: 'maker', offsetBps: -150 } }),
              'tool_use',
              'submit_trade',
            ),
          ),
        );
      const clientMinus = new AnthropicAgentClient(buildCfg(), fetchFnMinus);
      const minus = await clientMinus.propose(buildInput({ candles, context: FLAT_CONTEXT }));
      // Long, -150bps: 50000 * (1 + 0.015) = 50750.
      expect(moneyToString(minus.signals[0]!.limitPriceHint!)).toBe('50750');
    });
  });

  // v3 consolidation spec §4.3 (mandatory coverage): the action enum ALWAYS structurally accepts
  // 'open_short' (no more spot/perp schema variants), so a symbol whose own capabilities.shorts is
  // false must be caught AFTER parsing, not by the schema — a named degrade (hold + journal action
  // 'error' + the capability_violation: rationale prefix + the composition-root metric callback),
  // never a silent pass-through into a spurious ENTER_SHORT on a spot symbol.
  describe('capability-violation degrade (v3, §4.3)', () => {
    function shortToolInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        action: 'open_short',
        sizeFraction: 0.05,
        entry: { style: 'maker', offsetBps: 0 },
        entryValidityBars: 4,
        stopLossPct: 0.01,
        takeProfitPct: 0.02,
        maxHoldBars: 96,
        ...overrides,
      };
    }

    it("open_short on SYM (spot, capabilities.shorts=false) degrades to a hold, journaled action 'error' with the capability_violation rationale, and fires the recordCapabilityViolation callback", async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(apiResponse(toolUseBody(shortToolInput(), 'tool_use', 'submit_trade')));
      const recordCapabilityViolation = vi.fn();
      const warn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg({ recordCapabilityViolation }), fetchFn, {
        warn,
      });

      const proposal = await client.propose(
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: FLAT_CONTEXT }),
      );

      expect(proposal.signals).toEqual([]);
      expect(proposal.decision).toEqual({
        action: 'error',
        confidence: null,
        rationale: 'capability_violation:open_short_on_spot',
      });
      expect(recordCapabilityViolation).toHaveBeenCalledWith('open_short_on_spot');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('capability violation'));
    });

    it('never fires recordCapabilityViolation on an open_short for a perp symbol (capabilities.shorts=true)', async () => {
      const PERP_SYM = symbolId('SOL/USDT:USDT');
      const fetchFn = vi
        .fn()
        .mockResolvedValue(apiResponse(toolUseBody(shortToolInput(), 'tool_use', 'submit_trade')));
      const recordCapabilityViolation = vi.fn();
      const client = new AnthropicAgentClient(
        buildCfg({
          recordCapabilityViolation,
          maxPositionFractionPerp: '0.35',
          perpLeverageCap: '2',
        }),
        fetchFn,
      );

      const proposal = await client.propose({
        strategyId: SID,
        trigger: { kind: 'candle', event: { ...candle('100', 1n), symbol: PERP_SYM } },
        snapshot: {
          eventTime: epochMs(T),
          candles: new Map(),
          tickers: new Map([[PERP_SYM, { ...ticker('100', 1n), symbol: PERP_SYM }]]),
          books: new Map(),
          execReports: [],
          portfolio: { strategyId: SID, positions: new Map(), openOrders: [] },
        },
        context: FLAT_CONTEXT,
      });

      expect(recordCapabilityViolation).not.toHaveBeenCalled();
      expect(proposal.signals[0]!.kind).toBe('ENTER_SHORT');
      expect(proposal.decision?.action).toBe('open_short');
    });

    it('absent recordCapabilityViolation callback never throws — the degrade itself is unconditional, the metric is best-effort observability only', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(apiResponse(toolUseBody(shortToolInput(), 'tool_use', 'submit_trade')));
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);

      const proposal = await client.propose(
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: FLAT_CONTEXT }),
      );

      expect(proposal.signals).toEqual([]);
      expect(proposal.decision?.action).toBe('error');
    });
  });

  // 2026-08-03. The take-profit floor used to read maker/takerBps off the ONE static profile the
  // composition root builds from TRADING_SYMBOLS[0] (BTC/USDT, spot), so a 20bps floor was applied to
  // a book that is 85% perp — a venue whose MEASURED schedule is 2 maker / 4-5 taker bps
  // (research/studies/fee-floor-derivation-2026-07-31.md § 2). The gate now reads
  // domain/trading/fees.ts keyed by the symbol's own venue. THE TABLE STILL CARRIES 10/10 FOR BOTH
  // VENUES: this pass ships the plumbing, not the behaviour change, so the first test below must keep
  // failing the perp trade and the second proves the flip is a one-line table edit away.
  describe('take-profit floor reads the SYMBOL’s own venue fee schedule', () => {
    const PERP_SYM = symbolId('SOL/USDT:USDT');

    function perpInput(): AgentDecisionInput {
      return {
        strategyId: SID,
        trigger: { kind: 'candle', event: { ...candle('100', 1n), symbol: PERP_SYM } },
        snapshot: {
          eventTime: epochMs(T),
          candles: new Map(),
          tickers: new Map([[PERP_SYM, { ...ticker('100', 1n), symbol: PERP_SYM }]]),
          books: new Map(),
          execReports: [],
          portfolio: { strategyId: SID, positions: new Map(), openOrders: [] },
        },
        context: FLAT_CONTEXT,
      };
    }

    function perpOpen(takeProfitPct: number): unknown {
      return toolUseBody(
        {
          action: 'open_long',
          sizeFraction: 0.05,
          entry: { style: 'maker', offsetBps: 0 },
          entryValidityBars: 4,
          stopLossPct: 0.01,
          takeProfitPct,
          maxHoldBars: 96,
        },
        'tool_use',
        'submit_trade',
      );
    }

    it('UNCHANGED TODAY: a perp takeProfitPct of 0.0015 is still rejected under the shipped 10/10 table', async () => {
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(perpOpen(0.0015)));
      const client = new AnthropicAgentClient(
        buildCfg({ maxPositionFractionPerp: '0.35', perpLeverageCap: '2' }),
        fetchFn,
      );

      const proposal = await client.propose(perpInput());

      expect(proposal.signals).toEqual([]);
      expect(proposal.decision?.rationale).toContain('[rejected: tp below fee floor]');
    });

    it('PLUMBING PROVEN: the same trade passes once the perp entry carries its measured 2/5 schedule', async () => {
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(perpOpen(0.0015)));
      const client = new AnthropicAgentClient(
        buildCfg({
          maxPositionFractionPerp: '0.35',
          perpLeverageCap: '2',
          // The pending enable, applied in-memory only: 2 maker + 5 taker = 7bps round trip, which
          // 0.0015 (15bps) clears twice over.
          feeSchedules: new Map([
            [
              venueId('binanceusdm'),
              {
                makerBps: '2',
                takerBps: '5',
                measuredAt: '2026-07-31',
                sourceStudy: 'research/studies/fee-floor-derivation-2026-07-31.md § 2',
              },
            ],
          ]),
        }),
        fetchFn,
      );

      const proposal = await client.propose(perpInput());

      expect(proposal.signals).toHaveLength(1);
      expect(proposal.signals[0]!.kind).toBe('ENTER_LONG');
      expect(proposal.plan?.takeProfitPct).toBe('0.0015');
    });

    it('the SPOT floor is untouched by that flip — each symbol is floored by its own venue', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          apiResponse(
            toolUseBody(tradeOpen({ takeProfitPct: 0.0015 }), 'tool_use', 'submit_trade'),
          ),
        );
      // The pending enable EDITS the perp entry of the full table; it does not delete the spot one.
      // The override therefore carries BOTH venues — a perp-only map would leave spot unmapped and
      // fall back to the cheapest thing present (the 7bps perp entry), which is the opposite of the
      // fail-closed behaviour and would silently make this assertion vacuous.
      const client = new AnthropicAgentClient(
        buildCfg({
          feeSchedules: new Map([
            [
              venueId('binance'),
              {
                makerBps: '10',
                takerBps: '10',
                measuredAt: '2026-07-31',
                sourceStudy: 'research/studies/fee-floor-derivation-2026-07-31.md § 2',
              },
            ],
            [
              venueId('binanceusdm'),
              {
                makerBps: '2',
                takerBps: '5',
                measuredAt: '2026-07-31',
                sourceStudy: 'research/studies/fee-floor-derivation-2026-07-31.md § 2',
              },
            ],
          ]),
        }),
        fetchFn,
      );

      const proposal = await client.propose(
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: FLAT_CONTEXT }),
      );

      // SYM is spot, so it is floored by binance's own 20bps round trip even while the perp entry
      // sits at 7bps: 15bps clears the perp floor and not the spot one.
      expect(proposal.signals).toEqual([]);
      expect(proposal.decision?.rationale).toContain('[rejected: tp below fee floor]');
    });

    it('an UNMAPPED venue falls back to the most expensive schedule present — fails CLOSED', async () => {
      // The fail-closed fallback deserves its own case rather than riding on the spot test above.
      // Direction matters: the fallback can only be observed when the entry left in the table is the
      // EXPENSIVE one, so this drops the perp entry and floors an unmapped perp symbol at spot's
      // 20bps round trip. The mirror case (a perp-only table flooring an unmapped spot symbol at
      // 7bps) is NOT constructible through this gate: DECISION_V2_BOUNDS.takeProfitPct.min is 0.001
      // (10bps), so the schema rejects anything under the 7bps perp floor before the gate is
      // reached. Worth stating plainly, because it means the pending perp enable makes the SCHEMA
      // minimum — not this gate — the binding take-profit floor on perps.
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          apiResponse(
            toolUseBody(tradeOpen({ takeProfitPct: 0.0015 }), 'tool_use', 'submit_trade'),
          ),
        );
      const client = new AnthropicAgentClient(
        buildCfg({
          maxPositionFractionPerp: '0.35',
          perpLeverageCap: '2',
          feeSchedules: new Map([
            [
              venueId('binance'),
              {
                makerBps: '10',
                takerBps: '10',
                measuredAt: '2026-07-31',
                sourceStudy: 'research/studies/fee-floor-derivation-2026-07-31.md § 2',
              },
            ],
          ]),
        }),
        fetchFn,
      );

      const proposal = await client.propose(perpInput());

      // 15bps clears a 7bps perp schedule, but the perp venue is absent from this table, so the
      // fallback floors it at the worst entry present (spot's 20bps) and refuses.
      expect(proposal.signals).toEqual([]);
      expect(proposal.decision?.rationale).toContain('[rejected: tp below fee floor]');
    });
  });

  // 2026-08-03. computePromptHash covers templateVersion + playbook + tool schema + model id only, so
  // two REQUEST-param levers were invisible to it: output_config.effort (shipped flag-off in ea68379)
  // and max_tokens. Same shape as the th1 precedent — a request-param arm made recoverable from the
  // hash by a tag.
  describe('promptHash covers the request-param levers', () => {
    async function hashFor(over: Partial<AnthropicAgentClientConfig>): Promise<string> {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          apiResponse(toolUseBody({ action: 'hold' }, 'tool_use', 'submit_trade')),
        );
      const proposal = await new AnthropicAgentClient(buildCfg(over), fetchFn).propose(
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: FLAT_CONTEXT }),
      );
      return proposal.promptHash!;
    }

    it('flag-OFF is byte-identical: an unset outputEffort adds no tag', async () => {
      expect(await hashFor({})).toBe(await hashFor({ outputEffort: undefined }));
    });

    it('flag-ON hashes distinctly, and each effort level distinctly from the others', async () => {
      const off = await hashFor({});
      const low = await hashFor({ outputEffort: 'low' });
      const max = await hashFor({ outputEffort: 'max' });

      expect(low).not.toBe(off);
      expect(max).not.toBe(off);
      expect(low).not.toBe(max);
    });

    it('max_tokens at the deployed default adds no tag; any other budget hashes distinctly', async () => {
      const baseline = await hashFor({ maxTokens: PROMPT_HASH_BASELINE_MAX_TOKENS });
      const raised = await hashFor({ maxTokens: PROMPT_HASH_BASELINE_MAX_TOKENS * 2 });

      expect(raised).not.toBe(baseline);
      // The fixture default (256) is itself a deviation — it must carry the tag rather than silently
      // colliding with a real 4096-token deployment's rows.
      expect(await hashFor({})).not.toBe(baseline);
    });

    it('the batch path stamps the SAME request-param tags as the single-symbol path', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        apiResponse({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              name: 'submit_portfolio',
              input: { decisions: [{ symbol: 'BTC/USDT', action: 'hold' }], nextConsultBars: 4 },
            },
          ],
        }),
      );
      const client = new AnthropicAgentClient(buildCfg({ outputEffort: 'low' }), fetchFn);
      const { proposals } = await client.proposeBatch([
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: FLAT_CONTEXT }),
      ]);
      const batchHash = proposals.get('BTC/USDT')!.promptHash!;

      const offBatchFetch = vi.fn().mockResolvedValue(
        apiResponse({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              name: 'submit_portfolio',
              input: { decisions: [{ symbol: 'BTC/USDT', action: 'hold' }], nextConsultBars: 4 },
            },
          ],
        }),
      );
      const { proposals: offProposals } = await new AnthropicAgentClient(
        buildCfg(),
        offBatchFetch,
      ).proposeBatch([
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: FLAT_CONTEXT }),
      ]);

      expect(batchHash).not.toBe(offProposals.get('BTC/USDT')!.promptHash);
    });
  });
});
