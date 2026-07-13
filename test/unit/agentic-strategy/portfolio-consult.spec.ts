import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  BatchingAgentClient,
  type BatchCapableAgentClient,
} from '../../../src/features/trading/agentic/batching-agent-client';
import {
  AnthropicAgentClient,
  type AnthropicAgentClientConfig,
} from '../../../src/features/trading/agentic/anthropic-agent-client';
import { DailyLlmBudget } from '../../../src/features/trading/agentic/agent-budget';
import type {
  AgentDecisionInput,
  AgentMarketSnapshot,
  AgentContext,
} from '../../../src/ports/agentic-strategy';
import type { TickerEvent } from '../../../src/domain/types/market-events';
import { price } from '../../../src/domain/types/money';
import { strategyId, venueId, symbolId, epochMs } from '../../../src/domain/types/ids';

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

  it('window/timeout math: the HTTP timeout never drops below the 5s floor even with a large window', async () => {
    const proposeBatch = vi
      .fn()
      .mockResolvedValue({ proposals: new Map([['BTC/USDT', { signals: [] }]]) });
    const inner: BatchCapableAgentClient = { proposeBatch };
    const client = new BatchingAgentClient(inner, makeBudget(), {
      windowMs: 28000,
      maxBatchSize: 5,
      agentTimeoutMs: 30000,
    });

    const pending = client.propose(buildInput('BTC/USDT', 'agentic-1'));
    await vi.advanceTimersByTimeAsync(28000);
    await pending;

    expect(proposeBatch).toHaveBeenCalledWith(expect.any(Array), { timeoutMsOverride: 5000 });
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

  function portfolioBody(decisions: unknown[], stopReason = 'tool_use'): unknown {
    return {
      stop_reason: stopReason,
      content: [{ type: 'tool_use', name: 'submit_portfolio', input: { decisions } }],
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
          { symbol: 'BTC/USDT', action: 'long', confidence: 0.8, rationale: 'r1' },
          { symbol: 'ETH/USDT', action: 'hold', confidence: 0.2, rationale: 'r2' },
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

  it('a malformed element degrades ONLY that symbol to an empty proposal + warn, other symbols unaffected', async () => {
    const fetchFn = vi.fn();
    const warn = vi.fn();
    const client = new AnthropicAgentClient(buildCfg(), fetchFn, { warn });
    fetchFn.mockResolvedValue(
      apiResponse(
        portfolioBody([
          { symbol: 'BTC/USDT', action: 'long', confidence: 0.8, rationale: 'r' },
          // 'moon' is not a valid action — fails decisionElementSchema for this one element only.
          { symbol: 'ETH/USDT', action: 'moon', confidence: 0.5, rationale: 'r' },
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
        portfolioBody([{ symbol: 'BTC/USDT', action: 'long', confidence: 0.8, rationale: 'r' }]),
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

  it('a malformed response envelope throws an AgentProposeError — whole batch rejects, never a per-symbol hold', async () => {
    const fetchFn = vi.fn();
    const client = new AnthropicAgentClient(buildCfg(), fetchFn);
    fetchFn.mockResolvedValue(apiResponse('not-an-object'));

    await expect(
      client.proposeBatch([
        buildInput('BTC/USDT', 'agentic-1'),
        buildInput('ETH/USDT', 'agentic-2'),
      ]),
    ).rejects.toMatchObject({ name: 'AgentProposeError', kind: 'RETRYABLE' });
  });

  it('no submit_portfolio tool_use block throws an AgentProposeError', async () => {
    const fetchFn = vi.fn();
    const client = new AnthropicAgentClient(buildCfg(), fetchFn);
    fetchFn.mockResolvedValue(
      apiResponse({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'nope' }] }),
    );

    await expect(client.proposeBatch([buildInput('BTC/USDT', 'agentic-1')])).rejects.toMatchObject({
      name: 'AgentProposeError',
      kind: 'RETRYABLE',
    });
  });

  it('a top-level decisions field missing from the tool payload throws an AgentProposeError', async () => {
    const fetchFn = vi.fn();
    const client = new AnthropicAgentClient(buildCfg(), fetchFn);
    fetchFn.mockResolvedValue(
      apiResponse({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'submit_portfolio', input: { oops: [] } }],
      }),
    );

    await expect(client.proposeBatch([buildInput('BTC/USDT', 'agentic-1')])).rejects.toMatchObject({
      name: 'AgentProposeError',
      kind: 'RETRYABLE',
    });
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
});
