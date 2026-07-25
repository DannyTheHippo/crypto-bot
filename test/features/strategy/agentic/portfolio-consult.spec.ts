import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  BatchingAgentClient,
  type BatchCapableAgentClient,
} from '../../../../src/features/strategy/agentic/batching-agent-client';
import {
  AnthropicAgentClient,
  type AnthropicAgentClientConfig,
} from '../../../../src/features/strategy/agentic/anthropic-agent-client';
import { DailyLlmBudget } from '../../../../src/features/strategy/agentic/agent-budget';
import type {
  AgentDecisionInput,
  AgentMarketSnapshot,
  AgentContext,
} from '../../../../src/ports/strategy/agentic-strategy';
import type { TickerEvent } from '../../../../src/domain/venue/types/market-events';
import { price } from '../../../../src/domain/common/types/money';
import { strategyId, venueId, symbolId, epochMs } from '../../../../src/domain/common/types/ids';

const T = 1_700_000_000_000;
const V = venueId('binance');

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

function ticker(symbolStr: string, lastStr: string, seq: bigint): TickerEvent {
  return {
    kind: 'TICKER',
    venue: V,
    symbol: symbolId(symbolStr),
    channel: 'ticker',
    seq,
    eventTime: epochMs(T),
    ingestTime: epochMs(T + 1),
    bid: price(lastStr),
    ask: price(lastStr),
    last: price(lastStr),
  };
}

// One strategy instance per symbol (P7 multi-symbol convention) — mirrors how the 5 agentic-N
// instances each call the SAME shared AgentClientPort with their own strategyId/symbol.
function buildInput(symbolStr: string, strategyIdStr: string): AgentDecisionInput {
  const symbol = symbolId(symbolStr);
  const tickerEvt = ticker(symbolStr, '100', 1n);
  const snapshot: AgentMarketSnapshot = {
    eventTime: epochMs(T),
    candles: new Map(),
    tickers: new Map([[symbol, tickerEvt]]),
    books: new Map(),
    execReports: [],
    portfolio: { strategyId: strategyId(strategyIdStr), positions: new Map(), openOrders: [] },
  };
  return {
    strategyId: strategyId(strategyIdStr),
    trigger: { kind: 'ticker', event: tickerEvt },
    snapshot,
    context: FLAT_CONTEXT,
  };
}

function makeBudget(overrides: { maxCallsPerDay?: number } = {}): DailyLlmBudget {
  return new DailyLlmBudget({
    maxCallsPerDay: overrides.maxCallsPerDay ?? 500,
    maxTokensPerDay: 2_000_000,
  });
}

describe('BatchingAgentClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces 3 arrivals within the window into exactly ONE proposeBatch call', async () => {
    const proposeBatch = vi.fn().mockResolvedValue({
      proposals: new Map([
        ['BTC/USDT', { signals: [] }],
        ['ETH/USDT', { signals: [] }],
        ['SOL/USDT', { signals: [] }],
      ]),
    });
    const inner: BatchCapableAgentClient = { proposeBatch };
    const client = new BatchingAgentClient(inner, makeBudget(), {
      windowMs: 3000,
      maxBatchSize: 5,
      agentTimeoutMs: 30000,
    });

    const proposals = [
      client.propose(buildInput('BTC/USDT', 'agentic-1')),
      client.propose(buildInput('ETH/USDT', 'agentic-2')),
      client.propose(buildInput('SOL/USDT', 'agentic-3')),
    ];
    expect(proposeBatch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all(proposals);

    expect(proposeBatch).toHaveBeenCalledTimes(1);
    expect(proposeBatch.mock.calls[0]![0]).toHaveLength(3);
  });

  it('early-flushes once maxBatchSize arrivals have checked in, without waiting out the rest of the window', async () => {
    const proposeBatch = vi.fn().mockResolvedValue({
      proposals: new Map([
        ['BTC/USDT', { signals: [] }],
        ['ETH/USDT', { signals: [] }],
      ]),
    });
    const inner: BatchCapableAgentClient = { proposeBatch };
    const client = new BatchingAgentClient(inner, makeBudget(), {
      windowMs: 3000,
      maxBatchSize: 2,
      agentTimeoutMs: 30000,
    });

    const proposals = [
      client.propose(buildInput('BTC/USDT', 'agentic-1')),
      client.propose(buildInput('ETH/USDT', 'agentic-2')),
    ];
    // Flush fires synchronously on the 2nd (== maxBatchSize) arrival — no timer advance needed.
    await Promise.all(proposals);

    expect(proposeBatch).toHaveBeenCalledTimes(1);
  });

  it('fans results back so each caller resolves with ITS OWN symbol proposal', async () => {
    const btcProposal = { signals: [{ kind: 'ENTER_LONG' }] };
    const ethProposal = { signals: [] };
    const proposeBatch = vi.fn().mockResolvedValue({
      proposals: new Map([
        ['BTC/USDT', btcProposal],
        ['ETH/USDT', ethProposal],
      ]),
    });
    const inner: BatchCapableAgentClient = { proposeBatch };
    const client = new BatchingAgentClient(inner, makeBudget(), {
      windowMs: 3000,
      maxBatchSize: 5,
      agentTimeoutMs: 30000,
    });

    const p1 = client.propose(buildInput('BTC/USDT', 'agentic-1'));
    const p2 = client.propose(buildInput('ETH/USDT', 'agentic-2'));
    await vi.advanceTimersByTimeAsync(3000);

    await expect(p1).resolves.toBe(btcProposal);
    await expect(p2).resolves.toBe(ethProposal);
  });

  it('a symbol absent from the batch result (defensive backstop) holds only that caller, with a warn', async () => {
    const proposeBatch = vi
      .fn()
      .mockResolvedValue({ proposals: new Map([['BTC/USDT', { signals: [] }]]) });
    const inner: BatchCapableAgentClient = { proposeBatch };
    const warn = vi.fn();
    const client = new BatchingAgentClient(
      inner,
      makeBudget(),
      { windowMs: 3000, maxBatchSize: 5, agentTimeoutMs: 30000 },
      { warn },
    );

    const p1 = client.propose(buildInput('BTC/USDT', 'agentic-1'));
    const p2 = client.propose(buildInput('ETH/USDT', 'agentic-2'));
    await vi.advanceTimersByTimeAsync(3000);

    await expect(p1).resolves.toEqual({ signals: [] });
    await expect(p2).resolves.toEqual({ signals: [] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ETH/USDT'));
  });

  it('a whole-call failure rejects EVERY waiting caller with the SAME error — 1 strike per strategy', async () => {
    const err = new Error('transport blew up');
    const proposeBatch = vi.fn().mockRejectedValue(err);
    const inner: BatchCapableAgentClient = { proposeBatch };
    const client = new BatchingAgentClient(inner, makeBudget(), {
      windowMs: 3000,
      maxBatchSize: 5,
      agentTimeoutMs: 30000,
    });

    const p1 = client.propose(buildInput('BTC/USDT', 'agentic-1'));
    const p2 = client.propose(buildInput('ETH/USDT', 'agentic-2'));
    const p1Rejection = expect(p1).rejects.toBe(err);
    const p2Rejection = expect(p2).rejects.toBe(err);
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([p1Rejection, p2Rejection]);
  });

  it('reserves the daily budget exactly ONCE per batch, not once per symbol', async () => {
    const proposeBatch = vi.fn().mockResolvedValue({
      proposals: new Map([
        ['BTC/USDT', { signals: [] }],
        ['ETH/USDT', { signals: [] }],
        ['SOL/USDT', { signals: [] }],
      ]),
    });
    const inner: BatchCapableAgentClient = { proposeBatch };
    const budget = makeBudget();
    const reserveSpy = vi.spyOn(budget, 'tryReserveCall');
    const client = new BatchingAgentClient(inner, budget, {
      windowMs: 3000,
      maxBatchSize: 5,
      agentTimeoutMs: 30000,
    });

    const proposals = [
      client.propose(buildInput('BTC/USDT', 'agentic-1')),
      client.propose(buildInput('ETH/USDT', 'agentic-2')),
      client.propose(buildInput('SOL/USDT', 'agentic-3')),
    ];
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all(proposals);

    expect(reserveSpy).toHaveBeenCalledTimes(1);
    expect(budget.snapshot().calls).toBe(1);
  });

  it('when the daily budget is exhausted, holds every waiting caller WITHOUT calling the inner client', async () => {
    const proposeBatch = vi.fn();
    const inner: BatchCapableAgentClient = { proposeBatch };
    const budget = makeBudget({ maxCallsPerDay: 0 });
    const client = new BatchingAgentClient(inner, budget, {
      windowMs: 3000,
      maxBatchSize: 5,
      agentTimeoutMs: 30000,
    });

    const p1 = client.propose(buildInput('BTC/USDT', 'agentic-1'));
    const p2 = client.propose(buildInput('ETH/USDT', 'agentic-2'));
    await vi.advanceTimersByTimeAsync(3000);

    await expect(p1).resolves.toEqual({ signals: [] });
    await expect(p2).resolves.toEqual({ signals: [] });
    expect(proposeBatch).not.toHaveBeenCalled();
  });

  it('records usage on the shared budget exactly ONCE per batch (the aggregate call usage, not per-symbol)', async () => {
    const usage = { inputTokens: 1000, outputTokens: 200 };
    const proposeBatch = vi.fn().mockResolvedValue({
      proposals: new Map([
        ['BTC/USDT', { signals: [], usage }],
        ['ETH/USDT', { signals: [] }],
      ]),
      usage,
    });
    const inner: BatchCapableAgentClient = { proposeBatch };
    const budget = makeBudget();
    const recordSpy = vi.spyOn(budget, 'recordUsage');
    const client = new BatchingAgentClient(inner, budget, {
      windowMs: 3000,
      maxBatchSize: 5,
      agentTimeoutMs: 30000,
      model: 'claude-x',
    });

    const proposals = [
      client.propose(buildInput('BTC/USDT', 'agentic-1')),
      client.propose(buildInput('ETH/USDT', 'agentic-2')),
    ];
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all(proposals);

    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(usage, 'claude-x');
  });

  it('window/timeout math: the HTTP attempt timeout is agentTimeoutMs minus the window — first-arrival wait + attempt never exceeds the host backstop (agentTimeoutMs + 2s)', async () => {
    const proposeBatch = vi
      .fn()
      .mockResolvedValue({ proposals: new Map([['BTC/USDT', { signals: [] }]]) });
    const inner: BatchCapableAgentClient = { proposeBatch };
    const client = new BatchingAgentClient(inner, makeBudget(), {
      windowMs: 3000,
      maxBatchSize: 5,
      agentTimeoutMs: 30000,
    });

    const pending = client.propose(buildInput('BTC/USDT', 'agentic-1'));
    await vi.advanceTimersByTimeAsync(3000);
    await pending;

    expect(proposeBatch).toHaveBeenCalledWith(expect.any(Array), { timeoutMsOverride: 27000 });
    // Worst case: first-arrival waited the FULL window, then the attempt runs to its own timeout —
    // total wall time = windowMs + httpTimeoutMs = 30000 = agentTimeoutMs, i.e. 2000ms INSIDE the
    // host's own backstop (agentTimeoutMs + 2000, see app.module.ts's StrategyHost factory).
    const HOST_BACKSTOP_MS = 30000 + 2000;
    expect(3000 + 27000).toBeLessThanOrEqual(HOST_BACKSTOP_MS);
  });

  it('window/timeout math: the 5s HTTP floor engages on a valid config (window 3000, timeout 7000 ⇒ attempt 5000, worst case 8000 ≤ 9000 backstop)', async () => {
    const proposeBatch = vi
      .fn()
      .mockResolvedValue({ proposals: new Map([['BTC/USDT', { signals: [] }]]) });
    const inner: BatchCapableAgentClient = { proposeBatch };
    const client = new BatchingAgentClient(inner, makeBudget(), {
      windowMs: 3000,
      maxBatchSize: 5,
      agentTimeoutMs: 7000,
    });

    const pending = client.propose(buildInput('BTC/USDT', 'agentic-1'));
    await vi.advanceTimersByTimeAsync(3000);
    await pending;

    expect(proposeBatch).toHaveBeenCalledWith(expect.any(Array), { timeoutMsOverride: 5000 });
  });

  it('refuses at construction any window/timeout config whose floor-inclusive worst case exceeds the host backstop (enable-gate review should-fix)', () => {
    // window 28000 + max(5000, 30000−28000) = 33000 > 32000 backstop — the exact config that would
    // otherwise spurious-strike the first-arrival strategy every bar.
    expect(
      () =>
        new BatchingAgentClient({ proposeBatch: vi.fn() }, makeBudget(), {
          windowMs: 28000,
          maxBatchSize: 5,
          agentTimeoutMs: 30000,
        }),
    ).toThrow(/exceeds the strategy-host backstop/);
  });

  // U1 (Design § Universe: active-menu gate) — see batching-agent-client.ts's own ActiveMenuGate
  // comment: absent by default (pre-U1 behavior, byte-identical), consumable by I1 once wired.
  it('U1: with no activeMenuGate configured, every symbol batches exactly as before this step', async () => {
    const proposeBatch = vi.fn().mockResolvedValue({
      proposals: new Map([
        ['BTC/USDT', { signals: [] }],
        ['ETH/USDT', { signals: [] }],
      ]),
    });
    const inner: BatchCapableAgentClient = { proposeBatch };
    const client = new BatchingAgentClient(inner, makeBudget(), {
      windowMs: 3000,
      maxBatchSize: 5,
      agentTimeoutMs: 30000,
    });

    const proposals = [
      client.propose(buildInput('BTC/USDT', 'agentic-1')),
      client.propose(buildInput('ETH/USDT', 'agentic-2')),
    ];
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all(proposals);

    expect(proposeBatch).toHaveBeenCalledTimes(1);
    expect(proposeBatch.mock.calls[0]![0]).toHaveLength(2);
  });

  it('U1: a non-active-menu symbol resolves an inert hold WITHOUT joining the batch or reaching the inner client', async () => {
    const proposeBatch = vi
      .fn()
      .mockResolvedValue({ proposals: new Map([['BTC/USDT', { signals: [] }]]) });
    const inner: BatchCapableAgentClient = { proposeBatch };
    const client = new BatchingAgentClient(inner, makeBudget(), {
      windowMs: 3000,
      maxBatchSize: 5,
      agentTimeoutMs: 30000,
      activeMenuGate: { isActive: (symbol) => symbol === 'BTC/USDT' },
    });

    const activeProposal = client.propose(buildInput('BTC/USDT', 'agentic-1'));
    const inertProposal = client.propose(buildInput('ETH/USDT', 'agentic-2'));

    // The gated-out symbol resolves immediately — no timer advance needed.
    await expect(inertProposal).resolves.toEqual({ signals: [] });

    await vi.advanceTimersByTimeAsync(3000);
    await activeProposal;

    expect(proposeBatch).toHaveBeenCalledTimes(1);
    // Only the active symbol ever reached the inner client.
    expect(proposeBatch.mock.calls[0]![0]).toHaveLength(1);
  });
});

describe('AnthropicAgentClient.proposeBatch', () => {
  function apiResponse(body: unknown, opts: { ok?: boolean; status?: number } = {}): Response {
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      headers: { get: () => null },
      json: () => Promise.resolve(body),
    } as unknown as Response;
  }

  // v3 consolidation spec §4.3: the unified submit_portfolio payload always carries the
  // portfolio-level nextConsultBars (tradePortfolioSchema requires it) — defaulted here so every
  // existing call site in this describe block stays a minimal `portfolioBody(decisions)` call.
  function portfolioBody(
    decisions: unknown[],
    stopReason = 'tool_use',
    nextConsultBars = 8,
  ): unknown {
    return {
      stop_reason: stopReason,
      content: [
        { type: 'tool_use', name: 'submit_portfolio', input: { decisions, nextConsultBars } },
      ],
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

  it('fan-out mapping: each resolved symbol maps through the SAME per-symbol decision mapping the single-symbol path uses', async () => {
    const fetchFn = vi.fn();
    const client = new AnthropicAgentClient(buildCfg(), fetchFn);
    fetchFn.mockResolvedValue(
      apiResponse(
        portfolioBody([
          {
            symbol: 'BTC/USDT',
            action: 'open_long',
            sizeFraction: 0.05,
            entry: { style: 'maker', offsetBps: 0 },
            entryValidityBars: 4,
            stopLossPct: 0.01,
            takeProfitPct: 0.02,
            maxHoldBars: 96,
          },
          { symbol: 'ETH/USDT', action: 'hold' },
        ]),
      ),
    );

    const result = await client.proposeBatch([
      buildInput('BTC/USDT', 'agentic-1'),
      buildInput('ETH/USDT', 'agentic-2'),
    ]);

    expect(result.proposals.get('BTC/USDT')?.signals).toHaveLength(1);
    expect(result.proposals.get('BTC/USDT')?.signals[0]).toMatchObject({
      kind: 'ENTER_LONG',
      symbol: 'BTC/USDT',
      strategyId: 'agentic-1',
    });
    expect(result.proposals.get('ETH/USDT')?.signals).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('usage attaches to the FIRST resolved symbol only, absent on every other symbol', async () => {
    const fetchFn = vi.fn();
    const client = new AnthropicAgentClient(buildCfg(), fetchFn);
    fetchFn.mockResolvedValue(
      apiResponse({
        ...(portfolioBody([
          { symbol: 'BTC/USDT', action: 'hold', confidence: 0.5, rationale: 'r' },
          { symbol: 'ETH/USDT', action: 'hold', confidence: 0.5, rationale: 'r' },
        ]) as Record<string, unknown>),
        usage: { input_tokens: 500, output_tokens: 50 },
      }),
    );

    const result = await client.proposeBatch([
      buildInput('BTC/USDT', 'agentic-1'),
      buildInput('ETH/USDT', 'agentic-2'),
    ]);

    expect(result.proposals.get('BTC/USDT')?.usage).toEqual({
      inputTokens: 500,
      outputTokens: 50,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
    });
    expect(result.proposals.get('ETH/USDT')?.usage).toBeUndefined();
    expect(result.usage).toEqual({
      inputTokens: 500,
      outputTokens: 50,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
    });
  });

  it('stamps ONE identical consultId on every proposal of a batch — including a degraded (malformed) element and a symbol missing from decisions[] entirely', async () => {
    const fetchFn = vi.fn();
    const client = new AnthropicAgentClient(buildCfg(), fetchFn);
    fetchFn.mockResolvedValue(
      apiResponse(
        portfolioBody([
          { symbol: 'BTC/USDT', action: 'long', confidence: 0.8, rationale: 'r' },
          // 'moon' is not a valid action — fails decisionElementSchema for this element only.
          { symbol: 'ETH/USDT', action: 'moon', confidence: 0.5, rationale: 'r' },
          // SOL/USDT deliberately absent from decisions[] — the missing-symbol hold path.
        ]),
      ),
    );

    const result = await client.proposeBatch([
      buildInput('BTC/USDT', 'agentic-1'),
      buildInput('ETH/USDT', 'agentic-2'),
      buildInput('SOL/USDT', 'agentic-3'),
    ]);

    const btcId = result.proposals.get('BTC/USDT')?.consultId;
    const ethId = result.proposals.get('ETH/USDT')?.consultId;
    const solId = result.proposals.get('SOL/USDT')?.consultId;
    expect(btcId).toEqual(expect.any(String));
    expect(ethId).toBe(btcId);
    expect(solId).toBe(btcId);
  });

  it('stamps infoArm/thinkingArm (treatment truth, migration 0012) on every batch proposal — resolved, degraded, and missing-symbol alike', async () => {
    const fetchFn = vi.fn();
    const client = new AnthropicAgentClient(buildCfg(), fetchFn);
    fetchFn.mockResolvedValue(
      apiResponse(
        portfolioBody([
          { symbol: 'BTC/USDT', action: 'long', confidence: 0.8, rationale: 'r' },
          { symbol: 'ETH/USDT', action: 'moon', confidence: 0.5, rationale: 'r' },
        ]),
      ),
    );

    const result = await client.proposeBatch([
      buildInput('BTC/USDT', 'agentic-1'),
      buildInput('ETH/USDT', 'agentic-2'),
      buildInput('SOL/USDT', 'agentic-3'),
    ]);

    for (const symbol of ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']) {
      const p = result.proposals.get(symbol);
      // infoArm: derivativesAbPct defaults 0 in buildCfg ⇒ info treatment (bundle present: control
      // arm never assigned). thinkingArm: S3 retired the thinking A/B (Design § Deleted/replaced
      // scaffolding — "thinking A/B arm retired") — every decide/batch call now carries adaptive
      // thinking unconditionally, so this is always true regardless of cfg. Both stamps must still be
      // concrete booleans, never undefined.
      expect(p?.infoArm, `${symbol} infoArm`).toBe(true);
      expect(p?.thinkingArm, `${symbol} thinkingArm`).toBe(true);
    }
  });

  it('a malformed element degrades ONLY that symbol to an empty proposal + warn, other symbols unaffected', async () => {
    const fetchFn = vi.fn();
    const warn = vi.fn();
    const client = new AnthropicAgentClient(buildCfg(), fetchFn, { warn });
    fetchFn.mockResolvedValue(
      apiResponse(
        portfolioBody([
          {
            symbol: 'BTC/USDT',
            action: 'open_long',
            sizeFraction: 0.05,
            entry: { style: 'maker', offsetBps: 0 },
            entryValidityBars: 4,
            stopLossPct: 0.01,
            takeProfitPct: 0.02,
            maxHoldBars: 96,
          },
          // 'moon' is not a valid action — fails tradeElementSchema for this one element only.
          { symbol: 'ETH/USDT', action: 'moon' },
        ]),
      ),
    );

    const result = await client.proposeBatch([
      buildInput('BTC/USDT', 'agentic-1'),
      buildInput('ETH/USDT', 'agentic-2'),
    ]);

    expect(result.proposals.get('BTC/USDT')?.signals).toHaveLength(1);
    expect(result.proposals.get('ETH/USDT')?.signals).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ETH/USDT'));
  });

  it('a symbol missing from decisions[] entirely holds just that symbol + warn', async () => {
    const fetchFn = vi.fn();
    const warn = vi.fn();
    const client = new AnthropicAgentClient(buildCfg(), fetchFn, { warn });
    fetchFn.mockResolvedValue(
      apiResponse(
        portfolioBody([
          {
            symbol: 'BTC/USDT',
            action: 'open_long',
            sizeFraction: 0.05,
            entry: { style: 'maker', offsetBps: 0 },
            entryValidityBars: 4,
            stopLossPct: 0.01,
            takeProfitPct: 0.02,
            maxHoldBars: 96,
          },
        ]),
      ),
    );

    const result = await client.proposeBatch([
      buildInput('BTC/USDT', 'agentic-1'),
      buildInput('ETH/USDT', 'agentic-2'),
    ]);

    expect(result.proposals.get('BTC/USDT')?.signals).toHaveLength(1);
    expect(result.proposals.get('ETH/USDT')?.signals).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing from submit_portfolio'));
  });

  // Enable-gate review must-fix: the three post-200 schema-failure modes SOFT-HOLD every symbol
  // (the single-symbol path soft-holds these exact modes — a rejection would strike every strategy
  // in the batch simultaneously and auto-DRAIN the lane in correlation). Only transport/HTTP
  // failures reject (true single-path parity, pinned separately below).
  it('a malformed response envelope soft-holds EVERY symbol — never a batch-wide rejection', async () => {
    const fetchFn = vi.fn();
    const client = new AnthropicAgentClient(buildCfg(), fetchFn);
    fetchFn.mockResolvedValue(apiResponse('not-an-object'));

    const result = await client.proposeBatch([
      buildInput('BTC/USDT', 'agentic-1'),
      buildInput('ETH/USDT', 'agentic-2'),
    ]);

    expect(result.proposals.get('BTC/USDT')?.signals).toEqual([]);
    expect(result.proposals.get('ETH/USDT')?.signals).toEqual([]);
    expect(result.proposals.get('BTC/USDT')?.consultId).toBeDefined();
    expect(result.proposals.get('BTC/USDT')?.consultId).toBe(
      result.proposals.get('ETH/USDT')?.consultId,
    );
  });

  it('no submit_portfolio tool_use block soft-holds every symbol (usage still recorded on the first)', async () => {
    const fetchFn = vi.fn();
    const client = new AnthropicAgentClient(buildCfg(), fetchFn);
    fetchFn.mockResolvedValue(
      apiResponse({
        stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'nope' }],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    );

    const result = await client.proposeBatch([
      buildInput('BTC/USDT', 'agentic-1'),
      buildInput('ETH/USDT', 'agentic-2'),
    ]);

    expect(result.proposals.get('BTC/USDT')?.signals).toEqual([]);
    expect(result.proposals.get('BTC/USDT')?.usage).toBeDefined();
    expect(result.proposals.get('ETH/USDT')?.usage).toBeUndefined();
  });

  it('a top-level decisions field missing from the tool payload soft-holds every symbol', async () => {
    const fetchFn = vi.fn();
    const client = new AnthropicAgentClient(buildCfg(), fetchFn);
    fetchFn.mockResolvedValue(
      apiResponse({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'submit_portfolio', input: { oops: [] } }],
      }),
    );

    const result = await client.proposeBatch([buildInput('BTC/USDT', 'agentic-1')]);
    expect(result.proposals.get('BTC/USDT')?.signals).toEqual([]);
  });

  it('a transport failure throws an AgentProposeError (RETRYABLE), same error class the single-symbol path throws', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down'));
    const client = new AnthropicAgentClient(buildCfg(), fetchFn);

    await expect(client.proposeBatch([buildInput('BTC/USDT', 'agentic-1')])).rejects.toMatchObject({
      name: 'AgentProposeError',
      kind: 'RETRYABLE',
    });
  });

  it('a refusal holds every symbol softly (never a rejection), usage on the first symbol only', async () => {
    const fetchFn = vi.fn();
    const client = new AnthropicAgentClient(buildCfg(), fetchFn);
    fetchFn.mockResolvedValue(
      apiResponse({ stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 2 } }),
    );

    const result = await client.proposeBatch([
      buildInput('BTC/USDT', 'agentic-1'),
      buildInput('ETH/USDT', 'agentic-2'),
    ]);

    expect(result.proposals.get('BTC/USDT')?.signals).toEqual([]);
    expect(result.proposals.get('BTC/USDT')?.usage).toBeDefined();
    expect(result.proposals.get('ETH/USDT')?.signals).toEqual([]);
    expect(result.proposals.get('ETH/USDT')?.usage).toBeUndefined();
    // Review nice-to-have: the refusal fan-out stamps the shared batch consultId too.
    expect(result.proposals.get('BTC/USDT')?.consultId).toBeDefined();
    expect(result.proposals.get('BTC/USDT')?.consultId).toBe(
      result.proposals.get('ETH/USDT')?.consultId,
    );
  });

  it('the promptHash carries the pf1 tag — a batched decide can never collide with the single-symbol hash for an otherwise-identical decision', async () => {
    const batchFetch = vi.fn();
    const batchClient = new AnthropicAgentClient(buildCfg(), batchFetch);
    batchFetch.mockResolvedValue(
      apiResponse(
        portfolioBody([{ symbol: 'BTC/USDT', action: 'hold', confidence: 0.5, rationale: 'r' }]),
      ),
    );
    const batchResult = await batchClient.proposeBatch([buildInput('BTC/USDT', 'agentic-1')]);

    const singleFetch = vi.fn();
    const singleClient = new AnthropicAgentClient(buildCfg(), singleFetch);
    singleFetch.mockResolvedValue(
      apiResponse({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            name: 'submit_decision',
            input: { action: 'hold', confidence: 0.5, rationale: 'r' },
          },
        ],
      }),
    );
    const singleResult = await singleClient.propose(buildInput('BTC/USDT', 'agentic-1'));

    expect(batchResult.proposals.get('BTC/USDT')?.promptHash).not.toBe(singleResult.promptHash);
  });

  it('the batched system prompt is BYTE-IDENTICAL to the single-symbol path — the multi-symbol instruction lives in the tool/user message, never the (cached) system prompt', async () => {
    const batchFetch = vi.fn();
    const batchClient = new AnthropicAgentClient(buildCfg(), batchFetch);
    batchFetch.mockResolvedValue(
      apiResponse(
        portfolioBody([{ symbol: 'BTC/USDT', action: 'hold', confidence: 0.5, rationale: 'r' }]),
      ),
    );
    await batchClient.proposeBatch([buildInput('BTC/USDT', 'agentic-1')]);

    const singleFetch = vi.fn();
    const singleClient = new AnthropicAgentClient(buildCfg(), singleFetch);
    singleFetch.mockResolvedValue(
      apiResponse({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            name: 'submit_decision',
            input: { action: 'hold', confidence: 0.5, rationale: 'r' },
          },
        ],
      }),
    );
    await singleClient.propose(buildInput('BTC/USDT', 'agentic-1'));

    const batchBody = JSON.parse((batchFetch.mock.calls[0]![1] as RequestInit).body as string) as {
      system: unknown;
    };
    const singleBody = JSON.parse(
      (singleFetch.mock.calls[0]![1] as RequestInit).body as string,
    ) as { system: unknown };
    expect(batchBody.system).toEqual(singleBody.system);
  });

  it('one tryReserveCall-equivalent HTTP request answers ALL resolvable symbols — never one fetch per symbol', async () => {
    const fetchFn = vi.fn();
    const client = new AnthropicAgentClient(buildCfg(), fetchFn);
    fetchFn.mockResolvedValue(
      apiResponse(
        portfolioBody([
          { symbol: 'BTC/USDT', action: 'hold', confidence: 0.5, rationale: 'r' },
          { symbol: 'ETH/USDT', action: 'hold', confidence: 0.5, rationale: 'r' },
          { symbol: 'SOL/USDT', action: 'hold', confidence: 0.5, rationale: 'r' },
        ]),
      ),
    );

    await client.proposeBatch([
      buildInput('BTC/USDT', 'agentic-1'),
      buildInput('ETH/USDT', 'agentic-2'),
      buildInput('SOL/USDT', 'agentic-3'),
    ]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('respects opts.timeoutMsOverride for the HTTP attempt instead of cfg.timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      // Mirrors real fetch's abort contract (unlike the other tests' fire-and-forget mocks): rejects
      // when the caller's AbortSignal fires, so the override timer actually drives this test rather
      // than hanging forever on an unaborted promise.
      const impl: typeof fetch = (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
        });
      const fetchFn = vi.fn(impl);
      const client = new AnthropicAgentClient(buildCfg({ timeoutMs: 60000 }), fetchFn);
      const result = client.proposeBatch([buildInput('BTC/USDT', 'agentic-1')], {
        timeoutMsOverride: 1000,
      });
      const expectation = expect(result).rejects.toMatchObject({ kind: 'RETRYABLE' });
      // The override's own remaining-budget floor (RETRY_BUDGET_FLOOR_MS=2000) exceeds its 1000ms
      // total, so the first abort fails fast with no retry — well short of cfg.timeoutMs (60000ms),
      // proving the override (not cfg.timeoutMs) governs this attempt's abort.
      await vi.advanceTimersByTimeAsync(1000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  // v3 consolidation spec §9: the legacy plan-mode-shorts batch path (shortsCfg, PORTFOLIO_TOOL/
  // PORTFOLIO_SHORTS_TOOL lane selection, plan.direction wire shape) is DELETED — the unified
  // submit_portfolio tool always expresses open_short per element (§4.3); per-symbol eligibility is
  // covered by the mandatory capability-violation-degrade coverage in anthropic-agent-client.spec.ts.
});

// A2 (rich decision contract, Design § New tool contract): proposeBatch's v2 (tradeContract) path —
// buildTradePortfolioTool/buildTradePortfolioShortsTool selection, tradePortfolioSchema/
// tradeElementSchema/tradeShortsElementSchema parsing, mapping through buildProposalFromTradeDecision
// (reused byte-identically from A1's single-symbol mapping), and the portfolio-level nextConsultBars
// stamp. Soft-hold semantics (missing symbol, malformed element) mirror the legacy describe block
// above exactly — only the wire shape and per-symbol mapping differ.
describe('AnthropicAgentClient.proposeBatch — v2 trade contract (A2)', () => {
  function apiResponse(body: unknown, opts: { ok?: boolean; status?: number } = {}): Response {
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      headers: { get: () => null },
      json: () => Promise.resolve(body),
    } as unknown as Response;
  }

  function tradePortfolioBody(
    decisions: unknown[],
    nextConsultBars: number,
    stopReason = 'tool_use',
  ): unknown {
    return {
      stop_reason: stopReason,
      content: [
        { type: 'tool_use', name: 'submit_portfolio', input: { decisions, nextConsultBars } },
      ],
    };
  }

  function tradeCfg(over: Partial<AnthropicAgentClientConfig> = {}): AnthropicAgentClientConfig {
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

  // Mirrors buildInput above, only widened with a caller-supplied context (needed for 'adjust', which
  // only emits a signal while positioned) — buildInput itself stays untouched (every existing legacy
  // test keeps its FLAT_CONTEXT default).
  function buildInputWithContext(
    symbolStr: string,
    strategyIdStr: string,
    context: AgentContext,
  ): AgentDecisionInput {
    const symbol = symbolId(symbolStr);
    const tickerEvt = ticker(symbolStr, '100', 1n);
    const snapshot: AgentMarketSnapshot = {
      eventTime: epochMs(T),
      candles: new Map(),
      tickers: new Map([[symbol, tickerEvt]]),
      books: new Map(),
      execReports: [],
      portfolio: { strategyId: strategyId(strategyIdStr), positions: new Map(), openOrders: [] },
    };
    return {
      strategyId: strategyId(strategyIdStr),
      trigger: { kind: 'ticker', event: tickerEvt },
      snapshot,
      context,
    };
  }

  function openLongElement(
    symbol: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      symbol,
      action: 'open_long',
      sizeFraction: 0.01,
      entry: { style: 'maker', offsetBps: 0 },
      entryValidityBars: 4,
      stopLossPct: 0.02,
      takeProfitPct: 0.03,
      maxHoldBars: 96,
      ...overrides,
    };
  }

  it('(a) one batched call fans out mixed v2 actions (open_long + adjust-with-partialClose + hold) to the right symbols with correct signals', async () => {
    const fetchFn = vi.fn();
    const client = new AnthropicAgentClient(tradeCfg(), fetchFn);
    fetchFn.mockResolvedValue(
      apiResponse(
        tradePortfolioBody(
          [
            openLongElement('BTC/USDT'),
            { symbol: 'ETH/USDT', action: 'adjust', partialCloseFraction: 0.5 },
            { symbol: 'SOL/USDT', action: 'hold' },
          ],
          8,
        ),
      ),
    );

    const result = await client.proposeBatch([
      buildInput('BTC/USDT', 'agentic-1'),
      buildInputWithContext('ETH/USDT', 'agentic-2', LONG_CONTEXT),
      buildInput('SOL/USDT', 'agentic-3'),
    ]);

    const btc = result.proposals.get('BTC/USDT');
    expect(btc?.signals).toHaveLength(1);
    expect(btc?.signals[0]).toMatchObject({ kind: 'ENTER_LONG', symbol: 'BTC/USDT' });

    const eth = result.proposals.get('ETH/USDT');
    expect(eth?.signals).toHaveLength(1);
    expect(eth?.signals[0]).toMatchObject({ kind: 'EXIT_LONG', reduceFraction: '0.5' });

    const sol = result.proposals.get('SOL/USDT');
    expect(sol?.signals).toEqual([]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('(b) a symbol missing from decisions[] entirely soft-holds just that symbol while others process, with an explicit schema_rejected: hold decision and recordSchemaFailure(missing_symbol)', async () => {
    const fetchFn = vi.fn();
    const warn = vi.fn();
    const recordSchemaFailure = vi.fn();
    const client = new AnthropicAgentClient(tradeCfg({ recordSchemaFailure }), fetchFn, { warn });
    fetchFn.mockResolvedValue(apiResponse(tradePortfolioBody([openLongElement('BTC/USDT')], 8)));

    const result = await client.proposeBatch([
      buildInput('BTC/USDT', 'agentic-1'),
      buildInput('ETH/USDT', 'agentic-2'),
    ]);

    expect(result.proposals.get('BTC/USDT')?.signals).toHaveLength(1);
    const eth = result.proposals.get('ETH/USDT');
    expect(eth?.signals).toEqual([]);
    expect(eth?.decision).toMatchObject({ action: 'hold', confidence: 0 });
    expect(eth?.decision?.rationale).toMatch(/^schema_rejected: /);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ETH/USDT'));
    expect(recordSchemaFailure).toHaveBeenCalledWith('missing_symbol');
  });

  // 2026-07-22 schema-hardening: the observed live failure — a fully-formed decisions array
  // serialized as a quoted JSON string instead of an actual array — rejects tradePortfolioSchema at
  // the TOP level (z.array(z.unknown()) never accepts a string), soft-holding the whole batch.
  it('a whole-batch schema rejection (decisions serialized as a string, not an array) soft-holds every symbol with an explicit schema_rejected: hold decision and fires recordSchemaFailure(batch)', async () => {
    const fetchFn = vi.fn();
    const warn = vi.fn();
    const recordSchemaFailure = vi.fn();
    const client = new AnthropicAgentClient(tradeCfg({ recordSchemaFailure }), fetchFn, { warn });
    fetchFn.mockResolvedValue(
      apiResponse({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            name: 'submit_portfolio',
            input: {
              decisions: JSON.stringify([openLongElement('BTC/USDT')]),
              nextConsultBars: 8,
            },
          },
        ],
      }),
    );

    const result = await client.proposeBatch([
      buildInput('BTC/USDT', 'agentic-1'),
      buildInput('ETH/USDT', 'agentic-2'),
    ]);

    for (const symbol of ['BTC/USDT', 'ETH/USDT']) {
      const proposal = result.proposals.get(symbol);
      expect(proposal?.signals, symbol).toEqual([]);
      expect(proposal?.decision, symbol).toMatchObject({ action: 'hold', confidence: 0 });
      expect(proposal?.decision?.rationale, symbol).toMatch(/^schema_rejected: /);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('holding all'));
    expect(recordSchemaFailure).toHaveBeenCalledWith('batch');
  });

  it('(c) the single portfolio-level nextConsultBars is stamped on EVERY proposal — resolved, malformed-element, and missing-symbol alike', async () => {
    const fetchFn = vi.fn();
    const client = new AnthropicAgentClient(tradeCfg(), fetchFn);
    fetchFn.mockResolvedValue(
      apiResponse(
        tradePortfolioBody(
          [
            openLongElement('BTC/USDT'),
            // Not a valid action — malformed element for ETH/USDT only.
            { symbol: 'ETH/USDT', action: 'moon' },
            // SOL/USDT deliberately absent from decisions[] — the missing-symbol hold path.
          ],
          12,
        ),
      ),
    );

    const result = await client.proposeBatch([
      buildInput('BTC/USDT', 'agentic-1'),
      buildInput('ETH/USDT', 'agentic-2'),
      buildInput('SOL/USDT', 'agentic-3'),
    ]);

    for (const symbol of ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']) {
      expect(result.proposals.get(symbol)?.nextConsultBars, symbol).toBe(12);
    }
  });

  it('(d) one HTTP request answers every resolvable symbol in a v2 batch — never one fetch per symbol (budget reserved once per batch upstream)', async () => {
    const fetchFn = vi.fn();
    const client = new AnthropicAgentClient(tradeCfg(), fetchFn);
    fetchFn.mockResolvedValue(
      apiResponse(
        tradePortfolioBody(
          [
            { symbol: 'BTC/USDT', action: 'hold' },
            { symbol: 'ETH/USDT', action: 'hold' },
            { symbol: 'SOL/USDT', action: 'hold' },
          ],
          16,
        ),
      ),
    );

    await client.proposeBatch([
      buildInput('BTC/USDT', 'agentic-1'),
      buildInput('ETH/USDT', 'agentic-2'),
      buildInput('SOL/USDT', 'agentic-3'),
    ]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('(e) a malformed element (missing a required open_long directive) degrades ONLY that symbol to an explicit schema_rejected: hold + warn, fires recordSchemaFailure(element), other symbols unaffected', async () => {
    const fetchFn = vi.fn();
    const warn = vi.fn();
    const recordSchemaFailure = vi.fn();
    const client = new AnthropicAgentClient(tradeCfg({ recordSchemaFailure }), fetchFn, { warn });
    fetchFn.mockResolvedValue(
      apiResponse(
        tradePortfolioBody(
          [
            openLongElement('BTC/USDT'),
            // Missing entry/entryValidityBars/stopLossPct/takeProfitPct/maxHoldBars — required on
            // 'open_long' by requireTradeDirectives; malformed for ETH/USDT only.
            { symbol: 'ETH/USDT', action: 'open_long', sizeFraction: 0.01 },
          ],
          8,
        ),
      ),
    );

    const result = await client.proposeBatch([
      buildInput('BTC/USDT', 'agentic-1'),
      buildInput('ETH/USDT', 'agentic-2'),
    ]);

    expect(result.proposals.get('BTC/USDT')?.signals).toHaveLength(1);
    const eth = result.proposals.get('ETH/USDT');
    expect(eth?.signals).toEqual([]);
    expect(eth?.decision).toMatchObject({ action: 'hold', confidence: 0 });
    expect(eth?.decision?.rationale).toMatch(/^schema_rejected: /);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ETH/USDT'));
    expect(recordSchemaFailure).toHaveBeenCalledWith('element');
  });

  it('(f) a perp symbol (capabilities.shorts) accepts an open_short element and maps it to ENTER_SHORT', async () => {
    const fetchFn = vi.fn();
    const client = new AnthropicAgentClient(
      tradeCfg({ maxPositionFractionPerp: '0.5', perpLeverageCap: '2' }),
      fetchFn,
    );
    fetchFn.mockResolvedValue(
      apiResponse(
        tradePortfolioBody(
          [openLongElement('SOL/USDT:USDT', { action: 'open_short', sizeFraction: 0.3 })],
          8,
        ),
      ),
    );

    const result = await client.proposeBatch([buildInput('SOL/USDT:USDT', 'agentic-1')]);

    const sentBody = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string) as {
      tools: {
        input_schema: {
          properties: { decisions: { items: { properties: { action: { enum: string[] } } } } };
        };
      }[];
    };
    expect(
      sentBody.tools[0]!.input_schema.properties.decisions.items.properties.action.enum,
    ).toContain('open_short');
    expect(result.proposals.get('SOL/USDT:USDT')?.signals[0]).toMatchObject({
      kind: 'ENTER_SHORT',
    });
  });

  // v3 consolidation spec §4.3: capability-violation degrade (mandatory coverage) — a spot symbol's
  // own capabilities.shorts is false, so an open_short element degrades to a hold, journaled as
  // action 'error' with rationale 'capability_violation:open_short_on_spot', never a silent pass.
  it('(f) a spot symbol (capabilities.shorts=false) degrades an open_short element to a hold, journaled as a named capability violation', async () => {
    const fetchFn = vi.fn();
    const warn = vi.fn();
    const client = new AnthropicAgentClient(tradeCfg(), fetchFn, { warn });
    fetchFn.mockResolvedValue(
      apiResponse(tradePortfolioBody([openLongElement('BTC/USDT', { action: 'open_short' })], 8)),
    );

    const result = await client.proposeBatch([buildInput('BTC/USDT', 'agentic-1')]);

    const proposal = result.proposals.get('BTC/USDT');
    expect(proposal?.signals).toEqual([]);
    expect(proposal?.decision).toEqual({
      action: 'error',
      confidence: null,
      rationale: 'capability_violation:open_short_on_spot',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('BTC/USDT'));
  });

  // v3 spec §1/§9/§10 work item 4 (scheduler verification): one batched consult can span symbols of
  // BOTH venues — proposeBatch never partitions by venue, so a spot and a perp symbol resolve their
  // OWN independent capsBySymbol entry (venue/shorts/leverage/maxSizeFraction) within the SAME single
  // HTTP request, and each maps to the correct signal.
  it('(g) one batched call spans BOTH venues — a spot and a perp symbol resolve independent per-symbol capabilities (capsBySymbol) within the SAME HTTP request', async () => {
    const fetchFn = vi.fn();
    const client = new AnthropicAgentClient(
      tradeCfg({
        maxPositionFractionSpot: '0.15',
        maxPositionFractionPerp: '0.5',
        perpLeverageCap: '2',
      }),
      fetchFn,
    );
    fetchFn.mockResolvedValue(
      apiResponse(
        tradePortfolioBody(
          [
            openLongElement('BTC/USDT'),
            openLongElement('SOL/USDT:USDT', { action: 'open_short', sizeFraction: 0.3 }),
          ],
          8,
        ),
      ),
    );

    const result = await client.proposeBatch([
      buildInput('BTC/USDT', 'agentic-1'),
      buildInput('SOL/USDT:USDT', 'agentic-2'),
    ]);

    // ONE HTTP request answers both venues — the scheduler-level invariant: no per-venue split.
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const sentBody = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string) as {
      messages: { content: { text?: string }[] }[];
    };
    const blocks = sentBody.messages[0]!.content.map((b) => b.text ?? '');
    const btcBlock = blocks.find((t) => t.includes('BTC/USDT'))!;
    const solBlock = blocks.find((t) => t.includes('SOL/USDT:USDT'))!;
    expect(btcBlock).toContain('"venue":"binance"');
    expect(btcBlock).toContain('"shorts":false');
    expect(solBlock).toContain('"venue":"binanceusdm"');
    expect(solBlock).toContain('"shorts":true');
    expect(solBlock).toContain('"leverage":"2"');

    expect(result.proposals.get('BTC/USDT')?.signals[0]).toMatchObject({ kind: 'ENTER_LONG' });
    expect(result.proposals.get('SOL/USDT:USDT')?.signals[0]).toMatchObject({
      kind: 'ENTER_SHORT',
    });
  });
});
