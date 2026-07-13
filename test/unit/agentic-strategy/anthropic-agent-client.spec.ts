import { describe, it, expect, vi, afterEach } from 'vitest';
import Decimal from 'decimal.js';
import {
  AnthropicAgentClient,
  type AnthropicAgentClientConfig,
  type LoggerLike,
} from '../../../src/features/trading/agentic/anthropic-agent-client';
import {
  DECISION_TOOL,
  SHORTS_DECISION_TOOL,
  PLAN_TOOL,
  PLAN_SHORTS_TOOL,
} from '../../../src/features/trading/agentic/agent-prompt';
import {
  AgentProposeError,
  type AgentDecisionInput,
  type AgentMarketSnapshot,
  type AgentContext,
} from '../../../src/ports/agentic-strategy';
import type { DerivativesSnapshot } from '../../../src/ports/derivatives-feed';
import type { TradeFlowSnapshot } from '../../../src/ports/trade-flow-feed';
import type { PositioningSnapshot } from '../../../src/ports/positioning-feed';
import type { LiquidationSnapshot } from '../../../src/ports/liquidation-feed';
import type { CandleEvent, TickerEvent } from '../../../src/domain/types/market-events';
import { price, qty, moneyToString } from '../../../src/domain/types/money';
import { strategyId, venueId, symbolId, epochMs } from '../../../src/domain/types/ids';

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
  return { asOf: epochMs(T), barImbalance: 0.3, cvd: 55.5, lookbackBars: 20 };
}

function positioningSnapshot(): PositioningSnapshot {
  return { asOf: epochMs(T), longShortRatio: 0.9, longAccountPct: 47.4, shortAccountPct: 52.6 };
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
  opts: { ok?: boolean; status?: number; headers?: Record<string, string> } = {},
): Response {
  const headerMap = new Map(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function toolUseBody(
  toolInput: unknown,
  stopReason = 'tool_use',
  toolName = 'submit_decision',
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

  describe('happy-path mapping', () => {
    it('maps a long decision from a FLAT context into a single ENTER_LONG signal, refPrice/basedOnSeq from the ticker', async () => {
      const fetchFn = vi.fn();
      const cfg = buildCfg();
      const client = new AnthropicAgentClient(cfg, fetchFn);
      const tk = ticker('50000.5', 42n);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'long', confidence: 0.8, rationale: 'x' })),
      );
      const input = buildInput({ tickers: new Map([[SYM, tk]]), context: FLAT_CONTEXT });

      const { signals } = await client.propose(input);

      expect(signals).toHaveLength(1);
      const s = signals[0]!;
      expect(s.kind).toBe('ENTER_LONG');
      expect(moneyToString(s.refPrice)).toBe('50000.5');
      expect(s.basedOnSeq).toBe(42n);
      expect(s.strength).toBe(0.8);
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
      expect(s.dedupeKey).toBe(`${SID}:${SYM}:agentic:long:${anchorClose}`);
      expect(s.reason).toBe('x');
    });

    it('falls back to the last closed candle for refPrice/basedOnSeq when no ticker is present', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'long', confidence: 0.5, rationale: 'y' })),
      );
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
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'long', confidence: 0.6, rationale: 'r' })),
      );
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

    it('maps a flat decision from a LONG context into a single EXIT_LONG signal at full strength', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'flat', confidence: 0.9, rationale: 'z' })),
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
      { label: 'long while already LONG', action: 'long', context: LONG_CONTEXT },
      { label: 'flat while already FLAT', action: 'flat', context: FLAT_CONTEXT },
    ])('proposes nothing for a no-op decision ($label)', async ({ action, context }) => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action, confidence: 0.7, rationale: 'r' })),
      );
      const input = buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context });

      const { signals } = await client.propose(input);
      expect(signals).toEqual([]);
    });
  });

  describe('decision and usage telemetry', () => {
    it('always fills AgentProposal.decision from the validated tool payload', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'long', confidence: 0.73, rationale: 'trend intact' })),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.decision).toEqual({
        action: 'long',
        confidence: 0.73,
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
      expect(body.system[0]!.text).toContain('123');
      expect(body.system[0]!.text).toContain('456');
    });
  });

  describe('confidence clamp and rationale truncation', () => {
    it('clamps a confidence below the strength floor up to 0.1', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'long', confidence: 0.01, rationale: 'r' })),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const { signals } = await client.propose(input);

      expect(signals[0]!.strength).toBe(0.1);
    });

    it('truncates a rationale longer than 200 chars to exactly 200', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      const longRationale = 'r'.repeat(300);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'long', confidence: 0.5, rationale: longRationale })),
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
      'resolves to { signals: [] } and warns for $label failing schema validation',
      async ({ toolInput }) => {
        const fetchFn = vi.fn();
        const warn = vi.fn();
        const client = new AnthropicAgentClient(buildCfg(), fetchFn, {
          warn,
        });
        fetchFn.mockResolvedValue(apiResponse(toolUseBody(toolInput)));
        const input = buildInput({
          tickers: new Map([[SYM, ticker('100', 1n)]]),
          context: FLAT_CONTEXT,
        });

        await expect(client.propose(input)).resolves.toMatchObject({ signals: [] });
        expect(warn).toHaveBeenCalled();
      },
    );

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

      await expect(client.propose(input)).resolves.toEqual({ signals: [] });
      await expect(client.propose(input)).resolves.toEqual({ signals: [] });

      expect(fetchFn).toHaveBeenCalledTimes(1); // latched — no further HTTP calls
      expect(warn).toHaveBeenCalledTimes(1); // logged once, at latch time — not per short-circuit
      expect(String(warn.mock.calls[0]![0])).toContain('401');
      expect(String(warn.mock.calls[0]![0])).not.toContain(cfg.apiKey);
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
          text: expect.stringContaining('LONG') as string,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ]);
      expect(Array.isArray(body['messages'])).toBe(true);
      expect(body['tools']).toEqual([DECISION_TOOL]);
      expect(body['tool_choice']).toEqual({ type: 'tool', name: 'submit_decision' });
      expect(body).not.toHaveProperty('temperature');
      expect(body['thinking']).toEqual({ type: 'disabled' });
    });

    it('sends thinking:disabled alongside the forced tool_choice on every decide call', async () => {
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
      expect(body['thinking']).toEqual({ type: 'disabled' });
      expect(body['tool_choice']).toEqual({ type: 'tool', name: 'submit_decision' });
    });
  });

  describe('book-aware entry price hint', () => {
    function book(bidPrice: string, bidQty = '1'): AgentMarketSnapshot['books'] {
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
            bids: [{ price: price(bidPrice), qty: qty(bidQty) }],
            asks: [{ price: price('50100'), qty: qty('1') }],
          },
        ],
      ]);
    }

    function buildInputWithBook(books: AgentMarketSnapshot['books']): AgentDecisionInput {
      const base = buildInput({
        tickers: new Map([[SYM, ticker('50000', 1n)]]),
        context: FLAT_CONTEXT,
      });
      return { ...base, snapshot: { ...base.snapshot, books } };
    }

    it('sets limitPriceHint to the best bid when within 25bps below refPrice', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'long', confidence: 0.8, rationale: 'r' })),
      );
      // refPrice 50000, 25bps = 125 — a bid at 49900 (100 below) is inside the band.
      const input = buildInputWithBook(book('49900'));

      const { signals } = await client.propose(input);

      expect(signals).toHaveLength(1);
      expect(moneyToString(signals[0]!.limitPriceHint!)).toBe('49900');
    });

    it('omits limitPriceHint when the best bid is more than 25bps below refPrice', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'long', confidence: 0.8, rationale: 'r' })),
      );
      // refPrice 50000, 25bps = 125 — a bid at 49800 (200 below) is outside the band.
      const input = buildInputWithBook(book('49800'));

      const { signals } = await client.propose(input);

      expect(signals[0]!.limitPriceHint).toBeUndefined();
    });

    it('omits limitPriceHint when the context has no order book', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'long', confidence: 0.8, rationale: 'r' })),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('50000', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const { signals } = await client.propose(input);

      expect(signals[0]!.limitPriceHint).toBeUndefined();
    });
  });

  describe('plan mode: payoff-floor gate (stopLossPct floor + TP/SL ratio floor)', () => {
    // DEFAULT_TRADING_PROFILE (used when cfg.profile is absent) carries makerBps/takerBps '10' each,
    // so feeFraction = (10+10)/10000 = 0.002 — the same value PLAN_BOUNDS.stopLossPct.min was raised
    // to. A schema-valid (>= PLAN_BOUNDS.stopLossPct.min) stopLossPct can still land below the fee
    // floor for a higher-fee profile, which is what the stop-floor test below exercises.
    const HIGHER_FEE_PROFILE = {
      makerBps: '20',
      takerBps: '20', // feeFraction = 40/10000 = 0.004
      baseNotional: '50',
      maxOrderNotional: '200',
      constraints: {
        tickSize: price('0.01'),
        lotStep: qty('0.0001'),
        minNotional: price('10'),
      },
    };

    function plan(over: Partial<Record<string, number>> = {}): Record<string, number> {
      return {
        entryOffsetBps: 0,
        stopLossPct: 0.003,
        takeProfitPct: 0.0045,
        entryValidityBars: 4,
        maxHoldBars: 8,
        ...over,
      };
    }

    it('rejects a plan whose stopLossPct is below the round-trip fee fraction, journal-visible rationale, no signals', async () => {
      const fetchFn = vi.fn();
      const warn = vi.fn();
      const client = new AnthropicAgentClient(
        buildCfg({ planMode: true, profile: HIGHER_FEE_PROFILE }),
        fetchFn,
        { warn },
      );
      fetchFn.mockResolvedValue(
        apiResponse(
          toolUseBody(
            {
              action: 'long',
              confidence: 0.8,
              rationale: 'r',
              // stopLossPct 0.0025 clears PLAN_BOUNDS.stopLossPct.min (0.002) but sits below this
              // profile's 0.004 fee fraction; takeProfitPct 0.01 clears the edge floor (1.5 × 0.004).
              plan: plan({ stopLossPct: 0.0025, takeProfitPct: 0.01 }),
            },
            'tool_use',
            'submit_plan',
          ),
        ),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.signals).toEqual([]);
      expect(proposal.plan).toBeUndefined();
      expect(proposal.decision?.rationale).toBe('[plan rejected: stop below fee floor] r');
      expect(warn).toHaveBeenCalledWith(
        'plan rejected: stopLossPct 0.0025 below round-trip fee 0.004',
      );
    });

    it('rejects a plan whose takeProfitPct/stopLossPct ratio is below AGENTIC_MIN_RR, journal-visible rationale, no signals', async () => {
      const fetchFn = vi.fn();
      const warn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg({ planMode: true, minRr: '1.5' }), fetchFn, {
        warn,
      });
      fetchFn.mockResolvedValue(
        apiResponse(
          toolUseBody(
            {
              action: 'long',
              confidence: 0.8,
              rationale: 'r',
              plan: plan({ stopLossPct: 0.003, takeProfitPct: 0.004 }),
            },
            'tool_use',
            'submit_plan',
          ),
        ),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.signals).toEqual([]);
      expect(proposal.plan).toBeUndefined();
      expect(proposal.decision?.rationale).toBe('[plan rejected: RR below floor] r');
      const ratio = new Decimal('0.004').div('0.003').toFixed();
      expect(warn).toHaveBeenCalledWith(
        `plan rejected: takeProfitPct/stopLossPct ${ratio} below AGENTIC_MIN_RR 1.5`,
      );
    });

    it('accepts a plan at the exact boundary (stopLossPct === feeFraction, takeProfitPct/stopLossPct === minRr)', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg({ planMode: true, minRr: '1.5' }), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(
          toolUseBody(
            {
              action: 'long',
              confidence: 0.8,
              rationale: 'r',
              plan: plan({ stopLossPct: 0.002, takeProfitPct: 0.003 }),
            },
            'tool_use',
            'submit_plan',
          ),
        ),
      );
      // acceptedPlan is only populated when a lastCandle is available (its close prices the resting
      // entry) — see the client's entry-offset mapping.
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        candles: new Map([[SYM, [candle('100', 1n)]]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.signals).toHaveLength(1);
      expect(proposal.signals[0]!.kind).toBe('ENTER_LONG');
      expect(proposal.plan).toEqual({
        entryOffsetBps: 0,
        stopLossPct: '0.002',
        takeProfitPct: '0.003',
        entryValidityBars: 4,
        maxHoldBars: 8,
      });
    });

    it('ignores a spurious plan.direction on a shorts-OFF client — never emits ENTER_SHORT on a spot deployment (review finding)', async () => {
      // Strict tool use should make this unreachable (PLAN_TOOL declares no direction field), but
      // isShortEntry must still be gated on shortsEnabled: a direction value that somehow survives
      // must fall through to the legacy LONG mapping, byte-identical to pre-Phase-8 — a spot
      // deployment never passed the perp construction guard and cannot execute a short.
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg({ planMode: true }), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(
          toolUseBody(
            {
              action: 'long',
              confidence: 0.8,
              rationale: 'r',
              plan: { ...plan({ stopLossPct: 0.01, takeProfitPct: 0.02 }), direction: 'short' },
            },
            'tool_use',
            'submit_plan',
          ),
        ),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        candles: new Map([[SYM, [candle('100', 1n)]]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.signals).toHaveLength(1);
      expect(proposal.signals[0]!.kind).toBe('ENTER_LONG');
    });

    it('applies the 1.5 default RR floor when cfg.minRr is omitted', async () => {
      const fetchFn = vi.fn();
      const warn = vi.fn();
      // No minRr on cfg — same plan as the boundary-pass case above but with a ratio (1.4) just
      // below the 1.5 default, so the default (not an unset/no-op floor) is what rejects it.
      const client = new AnthropicAgentClient(buildCfg({ planMode: true }), fetchFn, { warn });
      fetchFn.mockResolvedValue(
        apiResponse(
          toolUseBody(
            {
              action: 'long',
              confidence: 0.8,
              rationale: 'r',
              plan: plan({ stopLossPct: 0.01, takeProfitPct: 0.014 }),
            },
            'tool_use',
            'submit_plan',
          ),
        ),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.signals).toEqual([]);
      expect(proposal.decision?.rationale).toBe('[plan rejected: RR below floor] r');
      expect(warn).toHaveBeenCalledWith(
        'plan rejected: takeProfitPct/stopLossPct 1.4 below AGENTIC_MIN_RR 1.5',
      );
    });
  });

  describe('plan mode: re-arm on an open position (restart self-heal)', () => {
    // The active plan is strategy-held in-memory and lost on restart; the model re-attaches
    // management by including a plan with its 'hold' (or a redundant 'long') while already LONG.
    // The client must pass that plan through — with the same viability floors as a fresh entry —
    // while emitting NO signal (no double entry, no exit).
    function plan(over: Partial<Record<string, number>> = {}): Record<string, number> {
      return {
        entryOffsetBps: 0,
        stopLossPct: 0.003,
        takeProfitPct: 0.0045,
        entryValidityBars: 4,
        maxHoldBars: 8,
        ...over,
      };
    }

    it("accepts a plan on 'hold' while LONG: no signals, proposal.plan populated", async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg({ planMode: true }), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(
          toolUseBody(
            { action: 'hold', confidence: 0.6, rationale: 'r', plan: plan() },
            'tool_use',
            'submit_plan',
          ),
        ),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: LONG_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.signals).toEqual([]);
      expect(proposal.decision?.action).toBe('hold');
      expect(proposal.plan).toEqual({
        entryOffsetBps: 0,
        stopLossPct: '0.003',
        takeProfitPct: '0.0045',
        entryValidityBars: 4,
        maxHoldBars: 8,
      });
    });

    it("accepts a plan on a redundant 'long' while already LONG: still no signals (no double entry)", async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg({ planMode: true }), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(
          toolUseBody(
            { action: 'long', confidence: 0.6, rationale: 'r', plan: plan() },
            'tool_use',
            'submit_plan',
          ),
        ),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: LONG_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.signals).toEqual([]);
      expect(proposal.plan).toBeDefined();
    });

    it('applies the same viability floors to a re-arm plan: RR-floor breach strips the plan, journal-visible rationale, no signals', async () => {
      const fetchFn = vi.fn();
      const warn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg({ planMode: true, minRr: '1.5' }), fetchFn, {
        warn,
      });
      fetchFn.mockResolvedValue(
        apiResponse(
          toolUseBody(
            {
              action: 'hold',
              confidence: 0.6,
              rationale: 'r',
              plan: plan({ stopLossPct: 0.003, takeProfitPct: 0.004 }),
            },
            'tool_use',
            'submit_plan',
          ),
        ),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: LONG_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.signals).toEqual([]);
      expect(proposal.plan).toBeUndefined();
      expect(proposal.decision?.action).toBe('hold');
      expect(proposal.decision?.rationale).toBe('[plan rejected: RR below floor] r');
    });

    it("never arms a plan on 'hold' while FLAT (no position, no resting entry — it would only expire)", async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg({ planMode: true }), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(
          toolUseBody(
            { action: 'hold', confidence: 0.6, rationale: 'r', plan: plan() },
            'tool_use',
            'submit_plan',
          ),
        ),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.signals).toEqual([]);
      expect(proposal.plan).toBeUndefined();
      // No rejection prefix either — the plan wasn't invalid, it was simply not applicable.
      expect(proposal.decision?.rationale).toBe('r');
    });
  });

  describe('plan mode: shorts (Push II Phase 8, shortsEnabled + planMode + perpCapableVenue)', () => {
    function plan(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
      return {
        direction: 'short',
        entryOffsetBps: 10,
        stopLossPct: 0.02,
        takeProfitPct: 0.04,
        entryValidityBars: 4,
        maxHoldBars: 20,
        ...over,
      };
    }
    function shortsCfg(over: Partial<AnthropicAgentClientConfig> = {}) {
      return buildCfg({ planMode: true, shortsEnabled: true, perpCapableVenue: true, ...over });
    }

    it('sends PLAN_SHORTS_TOOL (not PLAN_TOOL) as tools/tool_choice when shortsEnabled is true', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(shortsCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(
          toolUseBody(
            { action: 'hold', confidence: 0.5, rationale: 'r' },
            'tool_use',
            'submit_plan',
          ),
        ),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      await client.propose(input);

      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body['tools']).toEqual([PLAN_SHORTS_TOOL]);
    });

    it('shortsEnabled: false with planMode true is byte-identical to pre-Phase-8 — still sends PLAN_TOOL', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg({ planMode: true }), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(
          toolUseBody(
            { action: 'hold', confidence: 0.5, rationale: 'r' },
            'tool_use',
            'submit_plan',
          ),
        ),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      await client.propose(input);

      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body['tools']).toEqual([PLAN_TOOL]);
    });

    it("action 'long' from FLAT with plan.direction 'short' maps to a single ENTER_SHORT, offset priced ABOVE close (mirrored)", async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(shortsCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(
          toolUseBody(
            { action: 'long', confidence: 0.8, rationale: 'r', plan: plan() },
            'tool_use',
            'submit_plan',
          ),
        ),
      );
      const candles = new Map([[SYM, [candle('100', 1n)]]]);
      const input = buildInput({ candles, context: FLAT_CONTEXT });

      const proposal = await client.propose(input);

      expect(proposal.signals).toHaveLength(1);
      expect(proposal.signals[0]!.kind).toBe('ENTER_SHORT');
      // entryOffsetBps 10 (positive) rests a SHORT entry ABOVE close: 100 × (1 + 10/10000) = 100.1.
      expect(moneyToString(proposal.signals[0]!.limitPriceHint!)).toBe('100.1');
      expect(proposal.plan).toEqual({
        entryOffsetBps: 10,
        stopLossPct: '0.02',
        takeProfitPct: '0.04',
        entryValidityBars: 4,
        maxHoldBars: 20,
        direction: 'short',
      });
    });

    it("action 'flat' while SHORT maps to a single EXIT_SHORT and clears the plan", async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(shortsCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(
          toolUseBody(
            { action: 'flat', confidence: 0.9, rationale: 'r' },
            'tool_use',
            'submit_plan',
          ),
        ),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: SHORT_CONTEXT,
      });

      const { signals } = await client.propose(input);

      expect(signals).toHaveLength(1);
      expect(signals[0]!.kind).toBe('EXIT_SHORT');
      expect(signals[0]!.strength).toBe(1);
    });

    it("re-arms on 'hold' while SHORT: no signal, proposal.plan carries direction 'short' from the position's own side (never the model's plan.direction)", async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(shortsCfg(), fetchFn);
      fetchFn.mockResolvedValue(
        apiResponse(
          toolUseBody(
            // Model sends direction 'long' on a re-arm plan — must be IGNORED; the open position is
            // SHORT, and a re-arm can never flip direction mid-position.
            { action: 'hold', confidence: 0.6, rationale: 'r', plan: plan({ direction: 'long' }) },
            'tool_use',
            'submit_plan',
          ),
        ),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: SHORT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.signals).toEqual([]);
      expect(proposal.plan?.direction).toBe('short');
    });

    it('rejects a submit_plan payload missing plan.direction when shortsEnabled is true (schema-required)', async () => {
      const fetchFn = vi.fn();
      const warn = vi.fn();
      const client = new AnthropicAgentClient(shortsCfg(), fetchFn, { warn });
      const planWithoutDirection: Record<string, unknown> = { ...plan() };
      delete planWithoutDirection['direction'];
      fetchFn.mockResolvedValue(
        apiResponse(
          toolUseBody(
            { action: 'long', confidence: 0.8, rationale: 'r', plan: planWithoutDirection },
            'tool_use',
            'submit_plan',
          ),
        ),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.signals).toEqual([]);
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('shorts capability (B3, shortsEnabled gate)', () => {
    it('shortsEnabled without planMode never throws (legacy path, any venue)', () => {
      expect(() => new AnthropicAgentClient(buildCfg({ shortsEnabled: true }))).not.toThrow();
    });

    it('shortsEnabled with planMode on a non-perp (spot) venue throws — spot cannot short', () => {
      expect(
        () =>
          new AnthropicAgentClient(
            buildCfg({ shortsEnabled: true, planMode: true, perpCapableVenue: false }),
          ),
      ).toThrow(/requires a perp-capable venue/);
      // Absent perpCapableVenue is the same as false (spot deployments never set it).
      expect(
        () => new AnthropicAgentClient(buildCfg({ shortsEnabled: true, planMode: true })),
      ).toThrow(/requires a perp-capable venue/);
    });

    it('shortsEnabled with planMode on a perp-capable venue does not throw (Push II Phase 8)', () => {
      expect(
        () =>
          new AnthropicAgentClient(
            buildCfg({ shortsEnabled: true, planMode: true, perpCapableVenue: true }),
          ),
      ).not.toThrow();
    });

    it('sends SHORTS_DECISION_TOOL (not DECISION_TOOL) as tools/tool_choice when shortsEnabled is true', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg({ shortsEnabled: true }), fetchFn);
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
      // Regression: attemptOnce previously re-derived the tool from cfg.planMode alone, which would
      // have sent the narrow DECISION_TOOL even with shortsEnabled on, making 'short' unreachable.
      expect(body['tools']).toEqual([SHORTS_DECISION_TOOL]);
      expect(body['tool_choice']).toEqual({ type: 'tool', name: 'submit_decision' });
    });

    it('shortsEnabled: false is explicitly byte-identical to omitted — still sends DECISION_TOOL', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg({ shortsEnabled: false }), fetchFn);
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
      expect(body['tools']).toEqual([DECISION_TOOL]);
    });

    it("rejects action 'short' with signals: [] when shortsEnabled is off (schema still long/flat/hold only)", async () => {
      const fetchFn = vi.fn();
      const warn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg(), fetchFn, { warn });
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'short', confidence: 0.5, rationale: 'r' })),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(proposal.signals).toEqual([]);
      expect(warn).toHaveBeenCalled();
    });

    it("accepts action 'short' (no schema-validation warn) when shortsEnabled is on", async () => {
      const fetchFn = vi.fn();
      const warn = vi.fn();
      const client = new AnthropicAgentClient(buildCfg({ shortsEnabled: true }), fetchFn, { warn });
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'short', confidence: 0.6, rationale: 'r' })),
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });

      const proposal = await client.propose(input);

      expect(warn).not.toHaveBeenCalled();
      expect(proposal.decision?.action).toBe('short');
    });

    describe('mapping table (six arms)', () => {
      it("'short' action from FLAT maps to a single ENTER_SHORT signal", async () => {
        const fetchFn = vi.fn();
        const client = new AnthropicAgentClient(buildCfg({ shortsEnabled: true }), fetchFn);
        fetchFn.mockResolvedValue(
          apiResponse(toolUseBody({ action: 'short', confidence: 0.8, rationale: 'r' })),
        );
        const input = buildInput({
          tickers: new Map([[SYM, ticker('100', 1n)]]),
          context: FLAT_CONTEXT,
        });

        const { signals } = await client.propose(input);

        expect(signals).toHaveLength(1);
        expect(signals[0]!.kind).toBe('ENTER_SHORT');
        expect(signals[0]!.strength).toBe(0.8);
      });

      it("'flat' action from SHORT maps to a single EXIT_SHORT signal at full strength", async () => {
        const fetchFn = vi.fn();
        const client = new AnthropicAgentClient(buildCfg({ shortsEnabled: true }), fetchFn);
        fetchFn.mockResolvedValue(
          apiResponse(toolUseBody({ action: 'flat', confidence: 0.9, rationale: 'r' })),
        );
        const input = buildInput({
          tickers: new Map([[SYM, ticker('100', 1n)]]),
          context: SHORT_CONTEXT,
        });

        const { signals } = await client.propose(input);

        expect(signals).toHaveLength(1);
        expect(signals[0]!.kind).toBe('EXIT_SHORT');
        expect(signals[0]!.strength).toBe(1);
      });

      it("'long' action from SHORT maps to EXIT_SHORT only — never a same-bar flip to ENTER_LONG", async () => {
        const fetchFn = vi.fn();
        const client = new AnthropicAgentClient(buildCfg({ shortsEnabled: true }), fetchFn);
        fetchFn.mockResolvedValue(
          apiResponse(toolUseBody({ action: 'long', confidence: 0.8, rationale: 'r' })),
        );
        const input = buildInput({
          tickers: new Map([[SYM, ticker('100', 1n)]]),
          context: SHORT_CONTEXT,
        });

        const { signals } = await client.propose(input);

        expect(signals).toHaveLength(1);
        expect(signals[0]!.kind).toBe('EXIT_SHORT');
      });

      it("'short' action from LONG maps to EXIT_LONG only — never a same-bar flip to ENTER_SHORT", async () => {
        const fetchFn = vi.fn();
        const client = new AnthropicAgentClient(buildCfg({ shortsEnabled: true }), fetchFn);
        fetchFn.mockResolvedValue(
          apiResponse(toolUseBody({ action: 'short', confidence: 0.8, rationale: 'r' })),
        );
        const input = buildInput({
          tickers: new Map([[SYM, ticker('100', 1n)]]),
          context: LONG_CONTEXT,
        });

        const { signals } = await client.propose(input);

        expect(signals).toHaveLength(1);
        expect(signals[0]!.kind).toBe('EXIT_LONG');
      });

      it("'short' action while already SHORT is a no-op (hold-equivalent)", async () => {
        const fetchFn = vi.fn();
        const client = new AnthropicAgentClient(buildCfg({ shortsEnabled: true }), fetchFn);
        fetchFn.mockResolvedValue(
          apiResponse(toolUseBody({ action: 'short', confidence: 0.8, rationale: 'r' })),
        );
        const input = buildInput({
          tickers: new Map([[SYM, ticker('100', 1n)]]),
          context: SHORT_CONTEXT,
        });

        const { signals } = await client.propose(input);

        expect(signals).toEqual([]);
      });

      it('existing long/flat/hold arms stay byte-identical with shortsEnabled on', async () => {
        const fetchFn = vi.fn();
        const client = new AnthropicAgentClient(buildCfg({ shortsEnabled: true }), fetchFn);

        fetchFn.mockResolvedValueOnce(
          apiResponse(toolUseBody({ action: 'long', confidence: 0.7, rationale: 'r' })),
        );
        const enterLong = await client.propose(
          buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: FLAT_CONTEXT }),
        );
        expect(enterLong.signals).toHaveLength(1);
        expect(enterLong.signals[0]!.kind).toBe('ENTER_LONG');

        fetchFn.mockResolvedValueOnce(
          apiResponse(toolUseBody({ action: 'flat', confidence: 0.9, rationale: 'r' })),
        );
        const exitLong = await client.propose(
          buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: LONG_CONTEXT }),
        );
        expect(exitLong.signals).toHaveLength(1);
        expect(exitLong.signals[0]!.kind).toBe('EXIT_LONG');

        fetchFn.mockResolvedValueOnce(
          apiResponse(toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' })),
        );
        const hold = await client.propose(
          buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: FLAT_CONTEXT }),
        );
        expect(hold.signals).toEqual([]);
      });
    });
  });

  describe('playbook knobs (tighten-only parametric channel)', () => {
    // A valid 4-section playbook carrying the given knobs line under "## entry rules".
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

    it('downgrades a NEW long entry below minConfidence to a journal-visible hold', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(
        buildCfg(),
        fetchFn,
        undefined,
        providerWith('knobs: minConfidence=0.7'),
      );
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'long', confidence: 0.6, rationale: 'r' })),
      );

      const proposal = await client.propose(tickerInput(FLAT_CONTEXT));

      expect(proposal.signals).toEqual([]);
      expect(proposal.decision?.action).toBe('long');
      expect(proposal.decision?.rationale).toContain('[knob gate: confidence below playbook floor');
    });

    it('passes a NEW long entry at/above minConfidence through unchanged', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(
        buildCfg(),
        fetchFn,
        undefined,
        providerWith('knobs: minConfidence=0.7'),
      );
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'long', confidence: 0.7, rationale: 'r' })),
      );

      const proposal = await client.propose(tickerInput(FLAT_CONTEXT));

      expect(proposal.signals).toHaveLength(1);
      expect(proposal.signals[0]!.kind).toBe('ENTER_LONG');
    });

    it('NEVER gates an exit on minConfidence (a knob must not trap a position)', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(
        buildCfg(),
        fetchFn,
        undefined,
        providerWith('knobs: minConfidence=0.9'),
      );
      fetchFn.mockResolvedValue(
        apiResponse(toolUseBody({ action: 'flat', confidence: 0.1, rationale: 'r' })),
      );

      const proposal = await client.propose(tickerInput(LONG_CONTEXT));

      expect(proposal.signals).toHaveLength(1);
      expect(proposal.signals[0]!.kind).toBe('EXIT_LONG');
    });

    it('raises the plan RR floor for a FRESH entry (knob minRr rejects a plan the config floor allows)', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(
        buildCfg({ planMode: true, minRr: '1.5' }),
        fetchFn,
        undefined,
        providerWith('knobs: minRr=3'),
      );
      // RR = 0.02/0.01 = 2 — clears the config floor 1.5, fails the knob floor 3.
      fetchFn.mockResolvedValue(
        apiResponse(
          toolUseBody(
            {
              action: 'long',
              confidence: 0.9,
              rationale: 'r',
              plan: {
                entryOffsetBps: 10,
                stopLossPct: 0.01,
                takeProfitPct: 0.02,
                entryValidityBars: 2,
                maxHoldBars: 10,
              },
            },
            'tool_use',
            'submit_plan',
          ),
        ),
      );

      const proposal = await client.propose(
        buildInput({
          tickers: new Map([[SYM, ticker('100', 1n)]]),
          candles: new Map([[SYM, [candle('100', 1n)]]]),
          context: FLAT_CONTEXT,
        }),
      );

      expect(proposal.signals).toEqual([]);
      expect(proposal.plan).toBeUndefined();
      expect(proposal.decision?.rationale).toContain('[plan rejected: RR below floor]');
    });

    it('does NOT apply knob floors to a re-arm (an open position must always be re-manageable)', async () => {
      const fetchFn = vi.fn();
      const client = new AnthropicAgentClient(
        buildCfg({ planMode: true, minRr: '1.5' }),
        fetchFn,
        undefined,
        providerWith('knobs: minRr=3 minConfidence=0.9'),
      );
      // Same RR-2 plan, but arriving as a re-arm (hold while LONG): config floors bind, knob
      // floors and minConfidence deliberately do not — the plan re-attaches.
      fetchFn.mockResolvedValue(
        apiResponse(
          toolUseBody(
            {
              action: 'hold',
              confidence: 0.3,
              rationale: 'r',
              plan: {
                entryOffsetBps: 10,
                stopLossPct: 0.01,
                takeProfitPct: 0.02,
                entryValidityBars: 2,
                maxHoldBars: 10,
              },
            },
            'tool_use',
            'submit_plan',
          ),
        ),
      );

      const proposal = await client.propose(
        buildInput({
          tickers: new Map([[SYM, ticker('100', 1n)]]),
          candles: new Map([[SYM, [candle('100', 1n)]]]),
          context: LONG_CONTEXT,
        }),
      );

      expect(proposal.signals).toEqual([]);
      expect(proposal.plan).toBeDefined();
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

  describe('derivatives A/B (control arm, measurement start 2026-07-12)', () => {
    // Bucket math mirrors the client's own `abArm(floor(Date.now()/60_000), 'info-ctx-v1', pct)`
    // (ab-assignment.ts's keyed FNV-1a PRF, not derivable by inspection — these minutes are pinned
    // against the same golden values as ab-assignment.spec.ts). abArm === true fires the CONTROL arm
    // (infoContextControlArm withholds the info bundle); false leaves the treatment/full-info path.
    // m=100 -> abArm(100, 'info-ctx-v1', 30) === true -> CONTROL.
    const CONTROL_TIME_MS = 100 * 60_000;
    // m=70 -> abArm(70, 'info-ctx-v1', 30) === false -> TREATMENT.
    const TREATMENT_TIME_MS = 70 * 60_000;
    const AB_PCT = 30;

    function holdResponse(): unknown {
      return toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' });
    }

    it('derivativesAbPct absent or 0 is byte-identical to pre-A/B behavior — the control arm never fires regardless of the clock', async () => {
      const fetchFnAbsent = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnZero = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const clientAbsent = new AnthropicAgentClient(
        buildCfg({ derivativesFeedEnabled: true }),
        fetchFnAbsent,
      );
      const clientZero = new AnthropicAgentClient(
        buildCfg({ derivativesFeedEnabled: true, derivativesAbPct: 0 }),
        fetchFnZero,
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
        derivatives: derivativesSnapshot(),
      });

      const proposalAbsent = await clientAbsent.propose(input);
      const proposalZero = await clientZero.propose(input);

      expect(proposalAbsent.promptHash).toBe(proposalZero.promptHash);
      expect(proposalAbsent.inputPayload).toBe(proposalZero.inputPayload);
      const [, initAbsent] = fetchFnAbsent.mock.calls[0] as [string, RequestInit];
      const [, initZero] = fetchFnZero.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(initAbsent.body as string)).toEqual(JSON.parse(initZero.body as string));
      // Sanity: the block IS present on both — the equality above isn't vacuously true because the
      // feed was off.
      expect(JSON.parse(proposalAbsent.inputPayload!)).toHaveProperty('derivatives');
    });

    it('control arm: no derivatives sentence, no +d1 promptHash tag, no derivatives payload key', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(CONTROL_TIME_MS));
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnOff = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const client = new AnthropicAgentClient(
        buildCfg({ derivativesFeedEnabled: true, derivativesAbPct: AB_PCT }),
        fetchFn,
      );
      // Reference client: derivativesFeedEnabled false, no A/B — its promptHash is what a
      // successfully-withheld control-arm decide must match (the +d1 tag must be absent from both).
      const offClient = new AnthropicAgentClient(
        buildCfg({ derivativesFeedEnabled: false }),
        fetchFnOff,
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
        derivatives: derivativesSnapshot(),
      });

      const proposal = await client.propose(input);
      const offProposal = await offClient.propose(input);

      expect(proposal.promptHash).toBe(offProposal.promptHash);
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { system: { text: string }[] };
      expect(body.system[0]!.text).not.toContain('derivatives block');
      expect(JSON.parse(proposal.inputPayload!)).not.toHaveProperty('derivatives');
    });

    it('treatment arm: derivatives sentence, +d1 promptHash tag, and derivatives payload key all present', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(TREATMENT_TIME_MS));
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnOn = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const client = new AnthropicAgentClient(
        buildCfg({ derivativesFeedEnabled: true, derivativesAbPct: AB_PCT }),
        fetchFn,
      );
      // Reference client: derivativesFeedEnabled true, no A/B (pct 0) — the treatment arm's hash must
      // match this exactly (the +d1 tag present on both).
      const onClient = new AnthropicAgentClient(
        buildCfg({ derivativesFeedEnabled: true, derivativesAbPct: 0 }),
        fetchFnOn,
      );
      const derivatives = derivativesSnapshot();
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
        derivatives,
      });

      const proposal = await client.propose(input);
      const onProposal = await onClient.propose(input);

      expect(proposal.promptHash).toBe(onProposal.promptHash);
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { system: { text: string }[] };
      expect(body.system[0]!.text).toContain('derivatives block');
      const payload = JSON.parse(proposal.inputPayload!) as {
        derivatives: { fundingRate: number; openInterest: number; basisBps: number };
      };
      expect(payload.derivatives).toEqual({
        fundingRate: derivatives.fundingRate,
        fundingAnnualizedPct: derivatives.fundingAnnualizedPct,
        openInterest: derivatives.openInterest,
        basisBps: derivatives.basisBps,
      });
    });

    it('is deterministic within the same UTC-minute bucket, regardless of the exact millisecond', async () => {
      vi.useFakeTimers();
      const fetchFnEarly = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnLate = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const clientEarly = new AnthropicAgentClient(
        buildCfg({ derivativesFeedEnabled: true, derivativesAbPct: AB_PCT }),
        fetchFnEarly,
      );
      const clientLate = new AnthropicAgentClient(
        buildCfg({ derivativesFeedEnabled: true, derivativesAbPct: AB_PCT }),
        fetchFnLate,
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
        derivatives: derivativesSnapshot(),
      });

      vi.setSystemTime(new Date(CONTROL_TIME_MS));
      const early = await clientEarly.propose(input);
      // +45s: still floor(ms / 60_000) === 100, the same minute bucket.
      vi.setSystemTime(new Date(CONTROL_TIME_MS + 45_000));
      const late = await clientLate.propose(input);

      expect(early.promptHash).toBe(late.promptHash);
      expect(JSON.parse(early.inputPayload!)).not.toHaveProperty('derivatives');
      expect(JSON.parse(late.inputPayload!)).not.toHaveProperty('derivatives');
    });
  });

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

    it('the info-context control arm withholds d2 exactly like d1 — no derivatives block, no tag, regardless of derivativesV2Enabled', async () => {
      vi.useFakeTimers();
      const CONTROL_TIME_MS = 100 * 60_000; // abArm(100, 'info-ctx-v1', 30) === true -> CONTROL
      vi.setSystemTime(new Date(CONTROL_TIME_MS));
      const fetchFnControl = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnOff = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const clientControl = new AnthropicAgentClient(
        buildCfg({
          derivativesFeedEnabled: true,
          derivativesV2Enabled: true,
          derivativesAbPct: 30,
        }),
        fetchFnControl,
      );
      const clientOff = new AnthropicAgentClient(
        buildCfg({ derivativesFeedEnabled: false }),
        fetchFnOff,
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
        derivatives: v2Derivatives,
      });

      const proposalControl = await clientControl.propose(input);
      const proposalOff = await clientOff.propose(input);

      expect(proposalControl.promptHash).toBe(proposalOff.promptHash);
      expect(JSON.parse(proposalControl.inputPayload!)).not.toHaveProperty('derivatives');
    });
  });

  describe('cross-symbol block + information-context A/B (2026-07-12)', () => {
    // Same bucket math as the derivatives A/B suite above — the two share one control arm.
    const CONTROL_TIME_MS = 100 * 60_000; // abArm(100, 'info-ctx-v1', 30) === true -> CONTROL
    const TREATMENT_TIME_MS = 70 * 60_000; // abArm(70, 'info-ctx-v1', 30) === false -> TREATMENT
    const AB_PCT = 30;

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

    it('control arm withholds the WHOLE information bundle: neither derivatives, crossSymbol, tradeFlow, nor positioning survives, hash matches the all-feeds-off reference', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(CONTROL_TIME_MS));
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnOff = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const client = new AnthropicAgentClient(
        buildCfg({
          derivativesFeedEnabled: true,
          crossSymbolFeedEnabled: true,
          tradeFlowFeedEnabled: true,
          positioningFeedEnabled: true,
          derivativesAbPct: AB_PCT,
        }),
        fetchFn,
      );
      const offClient = new AnthropicAgentClient(buildCfg({}), fetchFnOff);
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: CROSS_CONTEXT,
        derivatives: derivativesSnapshot(),
        tradeFlow: tradeFlowSnapshot(),
        positioning: positioningSnapshot(),
      });

      const proposal = await client.propose(input);
      const offProposal = await offClient.propose(input);

      expect(proposal.promptHash).toBe(offProposal.promptHash);
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { system: { text: string }[] };
      expect(body.system[0]!.text).not.toContain('derivatives block');
      expect(body.system[0]!.text).not.toContain('crossSymbol block');
      expect(body.system[0]!.text).not.toContain('tradeFlow block');
      expect(body.system[0]!.text).not.toContain('positioning block');
      const payload = JSON.parse(proposal.inputPayload!) as Record<string, unknown>;
      expect(payload).not.toHaveProperty('derivatives');
      expect(payload).not.toHaveProperty('crossSymbol');
      expect(payload).not.toHaveProperty('tradeFlow');
      expect(payload).not.toHaveProperty('positioning');
    });

    it('treatment arm carries the whole bundle (derivatives+crossSymbol+tradeFlow+positioning) and matches the no-A/B all-feeds-on hash', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(TREATMENT_TIME_MS));
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const fetchFnOn = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const cfgOver = {
        derivativesFeedEnabled: true,
        crossSymbolFeedEnabled: true,
        tradeFlowFeedEnabled: true,
        positioningFeedEnabled: true,
      };
      const client = new AnthropicAgentClient(
        buildCfg({ ...cfgOver, derivativesAbPct: AB_PCT }),
        fetchFn,
      );
      const onClient = new AnthropicAgentClient(buildCfg(cfgOver), fetchFnOn);
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: CROSS_CONTEXT,
        derivatives: derivativesSnapshot(),
        tradeFlow: tradeFlowSnapshot(),
        positioning: positioningSnapshot(),
      });

      const proposal = await client.propose(input);
      const onProposal = await onClient.propose(input);

      expect(proposal.promptHash).toBe(onProposal.promptHash);
      const payload = JSON.parse(proposal.inputPayload!) as Record<string, unknown>;
      expect(payload).toHaveProperty('derivatives');
      expect(payload).toHaveProperty('crossSymbol', CROSS_SYMBOL);
      expect(payload).toHaveProperty('tradeFlow');
      expect(payload).toHaveProperty('positioning');
    });

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
      });
    });

    it('an info-context-A/B control-arm decide withholds tradeFlow+positioning even when derivatives/crossSymbol are both off (either new flag alone triggers the shared arm)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(100 * 60_000)); // abArm(100, 'info-ctx-v1', 30) === true -> CONTROL
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const client = new AnthropicAgentClient(
        buildCfg({
          tradeFlowFeedEnabled: true,
          positioningFeedEnabled: true,
          derivativesAbPct: 30,
        }),
        fetchFn,
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
        tradeFlow: tradeFlowSnapshot(),
        positioning: positioningSnapshot(),
      });

      const proposal = await client.propose(input);

      const payload = JSON.parse(proposal.inputPayload!) as Record<string, unknown>;
      expect(payload).not.toHaveProperty('tradeFlow');
      expect(payload).not.toHaveProperty('positioning');
    });
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
      expect(body.system[0]!.text.toLowerCase()).not.toContain('liquidation');
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

    it('an info-context-A/B control-arm decide withholds liquidation too (shares the same control arm as derivatives/tradeFlow/positioning)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(100 * 60_000)); // abArm(100, 'info-ctx-v1', 30) === true -> CONTROL
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const client = new AnthropicAgentClient(
        buildCfg({ liquidationsFeedEnabled: true, derivativesAbPct: 30 }),
        fetchFn,
      );
      const input = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
        liquidation: liquidationSnapshot(),
      });

      const proposal = await client.propose(input);

      const payload = JSON.parse(proposal.inputPayload!) as Record<string, unknown>;
      expect(payload).not.toHaveProperty('liquidation');
    });
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

    it('an info-context-A/B control-arm decide still renders bookStructure (no A/B interaction, unlike the feed blocks)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(100 * 60_000)); // abArm(100, 'info-ctx-v1', 30) === true -> CONTROL
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdResponse()));
      const client = new AnthropicAgentClient(
        buildCfg({
          bookStructureFeedEnabled: true,
          derivativesFeedEnabled: true,
          derivativesAbPct: 30,
        }),
        fetchFn,
      );
      const base = buildInput({
        tickers: new Map([[SYM, ticker('100', 1n)]]),
        context: FLAT_CONTEXT,
      });
      const input = { ...base, snapshot: { ...base.snapshot, books: bookSnapshot() } };

      const proposal = await client.propose(input);

      const payload = JSON.parse(proposal.inputPayload!) as Record<string, unknown>;
      expect(payload).not.toHaveProperty('derivatives'); // control arm withholds this
      expect(payload).toHaveProperty('bookStructure'); // but never this
    });
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

  describe('thinking A/B (#42, mechanism only)', () => {
    function holdBody(): unknown {
      return toolUseBody({ action: 'hold', confidence: 0.5, rationale: 'r' });
    }

    it('pct=0 (default): thinking stays explicitly disabled — byte-identical request to pre-#42', async () => {
      const fetchFn = vi.fn().mockResolvedValue(apiResponse(holdBody()));
      const client = new AnthropicAgentClient(buildCfg(), fetchFn);
      await client.propose(
        buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: FLAT_CONTEXT }),
      );
      const sent = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string) as {
        thinking: unknown;
      };
      expect(sent.thinking).toEqual({ type: 'disabled' });
    });

    it('treatment arm sends thinking adaptive and flips promptHash via the +th1 tag; the off-bucket minute keeps disabled and the untagged hash', async () => {
      vi.useFakeTimers();
      try {
        // abArm(0, 'th-v1', 50) === true ⇒ treatment arm (minute derived by scanning ab-assignment's
        // PRF for the desired outcome — see ab-assignment.spec.ts for the same golden value).
        vi.setSystemTime(new Date(0));
        const armFetch = vi.fn().mockResolvedValue(apiResponse(holdBody()));
        const armClient = new AnthropicAgentClient(buildCfg({ thinkingAbPct: 50 }), armFetch);
        const armProposal = await armClient.propose(
          buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: FLAT_CONTEXT }),
        );
        const armSent = JSON.parse((armFetch.mock.calls[0]![1] as RequestInit).body as string) as {
          thinking: unknown;
        };
        expect(armSent.thinking).toEqual({ type: 'adaptive' });

        // abArm(27, 'th-v1', 50) === false ⇒ off bucket, same config.
        vi.setSystemTime(new Date(27 * 60_000));
        const offFetch = vi.fn().mockResolvedValue(apiResponse(holdBody()));
        const offClient = new AnthropicAgentClient(buildCfg({ thinkingAbPct: 50 }), offFetch);
        const offProposal = await offClient.propose(
          buildInput({ tickers: new Map([[SYM, ticker('100', 1n)]]), context: FLAT_CONTEXT }),
        );
        const offSent = JSON.parse((offFetch.mock.calls[0]![1] as RequestInit).body as string) as {
          thinking: unknown;
        };
        expect(offSent.thinking).toEqual({ type: 'disabled' });

        // The +th1 tag makes the arm recoverable from promptHash — the two arms must never share
        // a hash for an otherwise-identical decision.
        expect(armProposal.promptHash).toBeDefined();
        expect(armProposal.promptHash).not.toBe(offProposal.promptHash);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
