import { describe, it, expect } from 'vitest';
import {
  DailyLlmBudget,
  BudgetedAgentClient,
  AttemptScopedBudget,
} from '../../../src/features/trading/agentic/agent-budget';
import type {
  AgentClientPort,
  AgentDecisionInput,
  AgentMarketSnapshot,
  AgentProposal,
} from '../../../src/ports/agentic-strategy';
import { strategyId, venueId, symbolId, epochMs } from '../../../src/domain/types/ids';
import { price } from '../../../src/domain/types/money';

const T = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z (UTC)
const SID = strategyId('agentic-1');
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');

function snapshot(t = T): AgentMarketSnapshot {
  return {
    eventTime: epochMs(t),
    candles: new Map(),
    tickers: new Map(),
    books: new Map(),
    execReports: [],
    portfolio: { strategyId: SID, positions: new Map(), openOrders: [] },
  };
}

function decisionInput(t = T): AgentDecisionInput {
  return {
    strategyId: SID,
    trigger: {
      kind: 'ticker',
      event: {
        kind: 'TICKER',
        venue: V,
        symbol: SYM,
        channel: 'ticker',
        seq: 1n,
        eventTime: epochMs(t),
        ingestTime: epochMs(t + 1),
        bid: price('99'),
        ask: price('101'),
        last: price('100'),
      },
    },
    snapshot: snapshot(t),
  };
}

// Fake inner client fully caller-controlled — resolve/reject/track calls — so BudgetedAgentClient's
// gating behavior is reproducible without depending on the concrete Anthropic adapter.
class FakeInnerClient implements AgentClientPort {
  calls = 0;
  constructor(private readonly impl: () => Promise<AgentProposal>) {}
  propose(input: AgentDecisionInput): Promise<AgentProposal> {
    void input;
    this.calls += 1;
    return this.impl();
  }
}

function warnLogger(): { warn: (msg: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (msg: string) => void messages.push(msg), messages };
}

describe('DailyLlmBudget', () => {
  it('tryReserveCall blocks once the call cap is reached', () => {
    const budget = new DailyLlmBudget({ maxCallsPerDay: 2, maxTokensPerDay: 1_000_000 }, () => T);

    expect(budget.tryReserveCall()).toBe(true);
    expect(budget.tryReserveCall()).toBe(true);
    expect(budget.tryReserveCall()).toBe(false);
    expect(budget.snapshot().calls).toBe(2);
  });

  it('tryReserveCall blocks once cumulative usage crosses the token cap', () => {
    const budget = new DailyLlmBudget({ maxCallsPerDay: 100, maxTokensPerDay: 1000 }, () => T);

    expect(budget.tryReserveCall()).toBe(true);
    budget.recordUsage({ inputTokens: 600, outputTokens: 500 }); // 1100 ≥ 1000
    expect(budget.tryReserveCall()).toBe(false);
  });

  it('rolls over on a UTC day change (nowFn seam, no fake timers)', () => {
    let clock = T;
    const nowFn = () => clock;
    const budget = new DailyLlmBudget({ maxCallsPerDay: 1, maxTokensPerDay: 1_000_000 }, nowFn);

    expect(budget.tryReserveCall()).toBe(true);
    budget.recordUsage({ inputTokens: 10, outputTokens: 10 });
    expect(budget.tryReserveCall()).toBe(false); // cap reached for today

    clock = T + 24 * 60 * 60 * 1000; // next UTC day
    expect(budget.tryReserveCall()).toBe(true); // rolled over: fresh cap
    const snap = budget.snapshot();
    expect(snap.calls).toBe(1);
    expect(snap.inputTokens).toBe(0);
    expect(snap.outputTokens).toBe(0);
  });

  it('snapshot reports dayKey/calls/tokens/caps/exhausted', () => {
    const budget = new DailyLlmBudget({ maxCallsPerDay: 5, maxTokensPerDay: 500 }, () => T);
    budget.tryReserveCall();
    budget.recordUsage({ inputTokens: 100, outputTokens: 50 });

    expect(budget.snapshot()).toEqual({
      dayKey: '2023-11-14',
      calls: 1,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0,
      maxCallsPerDay: 5,
      maxTokensPerDay: 500,
      maxCostUsdPerDay: 0,
      exhausted: false,
    });
  });

  it('0 maxCostUsdPerDay disables the cost circuit breaker entirely', () => {
    const budget = new DailyLlmBudget(
      {
        maxCallsPerDay: 100,
        maxTokensPerDay: 1_000_000_000,
        maxCostUsdPerDay: 0,
        priceInputPerMtok: 1_000,
        priceOutputPerMtok: 1_000,
      },
      () => T,
    );

    // Cost accrues to ~$200k — would trip any cap > 0 — while staying under the token cap, so
    // only the disabled breaker is exercised.
    budget.recordUsage({ inputTokens: 100_000_000, outputTokens: 100_000_000 });
    expect(budget.snapshot().costUsd).toBeGreaterThan(0);
    expect(budget.snapshot().exhausted).toBe(false);
    expect(budget.tryReserveCall()).toBe(true);
  });

  it('under the cost cap allows further calls', () => {
    const budget = new DailyLlmBudget(
      {
        maxCallsPerDay: 100,
        maxTokensPerDay: 1_000_000_000,
        maxCostUsdPerDay: 10,
        priceInputPerMtok: 3,
        priceOutputPerMtok: 15,
      },
      () => T,
    );

    budget.recordUsage({ inputTokens: 1_000_000, outputTokens: 100_000 }); // 3 + 1.5 = 4.5 < 10
    expect(budget.snapshot().costUsd).toBe(4.5);
    expect(budget.snapshot().exhausted).toBe(false);
    expect(budget.tryReserveCall()).toBe(true);
  });

  it('crossing the cost cap exhausts the budget', () => {
    const budget = new DailyLlmBudget(
      {
        maxCallsPerDay: 100,
        maxTokensPerDay: 1_000_000_000,
        maxCostUsdPerDay: 10,
        priceInputPerMtok: 3,
        priceOutputPerMtok: 15,
      },
      () => T,
    );

    budget.recordUsage({ inputTokens: 3_000_000, outputTokens: 200_000 }); // 9 + 3 = 12 > 10
    expect(budget.snapshot().exhausted).toBe(true);
    expect(budget.tryReserveCall()).toBe(false);
  });

  it('exactly at the cost cap exhausts the budget', () => {
    const budget = new DailyLlmBudget(
      {
        maxCallsPerDay: 100,
        maxTokensPerDay: 1_000_000_000,
        maxCostUsdPerDay: 10,
        priceInputPerMtok: 5,
        priceOutputPerMtok: 5,
      },
      () => T,
    );

    budget.recordUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }); // 5 + 5 = 10 === 10
    expect(budget.snapshot().costUsd).toBe(10);
    expect(budget.snapshot().exhausted).toBe(true);
    expect(budget.tryReserveCall()).toBe(false);
  });

  it('prices cache tokens at the default cache rates (W4+W13)', () => {
    const budget = new DailyLlmBudget(
      {
        maxCallsPerDay: 100,
        maxTokensPerDay: 1_000_000_000,
        maxCostUsdPerDay: 100,
        priceInputPerMtok: 3,
        priceOutputPerMtok: 15,
        priceCacheReadPerMtok: 0.3,
        priceCacheWritePerMtok: 6,
      },
      () => T,
    );
    // 1M in ×3 + 1M out ×15 + 1M cacheRead ×0.3 + 1M cacheWrite ×6 = 3 + 15 + 0.3 + 6 = 24.3
    budget.recordUsage({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
    });
    expect(budget.snapshot().costUsd).toBe(24.3);
  });

  it('prices a mixed-model day at each model’s own rates', () => {
    const budget = new DailyLlmBudget(
      {
        maxCallsPerDay: 100,
        maxTokensPerDay: 1_000_000_000,
        maxCostUsdPerDay: 100,
        priceInputPerMtok: 3,
        priceOutputPerMtok: 15,
        pricesByModel: {
          'claude-sonnet-5': {
            inputPerMtok: 3,
            outputPerMtok: 15,
            cacheReadPerMtok: 0.3,
            cacheWritePerMtok: 6,
          },
          'claude-opus-4-8': {
            inputPerMtok: 5,
            outputPerMtok: 25,
            cacheReadPerMtok: 0.5,
            cacheWritePerMtok: 10,
          },
        },
      },
      () => T,
    );
    budget.recordUsage({ inputTokens: 1_000_000, outputTokens: 0 }, 'claude-sonnet-5'); // 3
    budget.recordUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'claude-opus-4-8'); // 5 + 25 = 30
    expect(budget.snapshot().costUsd).toBe(33);
  });

  it('an unknown model prices at the most-expensive configured rates (fail-closed)', () => {
    const budget = new DailyLlmBudget(
      {
        maxCallsPerDay: 100,
        maxTokensPerDay: 1_000_000_000,
        maxCostUsdPerDay: 100,
        priceInputPerMtok: 3,
        priceOutputPerMtok: 15,
        pricesByModel: {
          'claude-opus-4-8': {
            inputPerMtok: 5,
            outputPerMtok: 25,
            cacheReadPerMtok: 0.5,
            cacheWritePerMtok: 10,
          },
        },
      },
      () => T,
    );
    // Unknown model → max(default 3, opus 5) input = 5. 1M ×5 = 5.
    budget.recordUsage({ inputTokens: 1_000_000, outputTokens: 0 }, 'some-unpriced-model');
    expect(budget.snapshot().costUsd).toBe(5);
  });

  it('rolls the cost cap over on a UTC day change alongside calls/tokens', () => {
    let clock = T;
    const nowFn = () => clock;
    const budget = new DailyLlmBudget(
      {
        maxCallsPerDay: 100,
        maxTokensPerDay: 1_000_000_000,
        maxCostUsdPerDay: 10,
        priceInputPerMtok: 5,
        priceOutputPerMtok: 5,
      },
      nowFn,
    );

    budget.recordUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }); // exhausts (=10)
    expect(budget.tryReserveCall()).toBe(false);

    clock = T + 24 * 60 * 60 * 1000; // next UTC day
    expect(budget.tryReserveCall()).toBe(true); // rolled over: fresh cost budget
    expect(budget.snapshot().costUsd).toBe(0);
  });

  it('existing call/token cap behavior is unchanged when no cost cap is configured', () => {
    const budget = new DailyLlmBudget({ maxCallsPerDay: 1, maxTokensPerDay: 1000 }, () => T);

    expect(budget.tryReserveCall()).toBe(true);
    budget.recordUsage({ inputTokens: 600, outputTokens: 500 }); // 1100 ≥ 1000 token cap
    expect(budget.tryReserveCall()).toBe(false);
    expect(budget.snapshot().maxCostUsdPerDay).toBe(0);
  });
});

describe('BudgetedAgentClient', () => {
  it('blocks with an inert empty proposal once the call cap is reached, never invoking the inner client', async () => {
    const budget = new DailyLlmBudget({ maxCallsPerDay: 1, maxTokensPerDay: 1_000_000 }, () => T);
    const inner = new FakeInnerClient(() => Promise.resolve({ signals: [] }));
    const client = new BudgetedAgentClient(inner, budget);

    await client.propose(decisionInput());
    expect(inner.calls).toBe(1);

    const proposal = await client.propose(decisionInput());
    expect(proposal).toEqual({ signals: [] });
    expect(inner.calls).toBe(1); // second call never reached the inner client
  });

  it('warns once per day-key when the budget is exhausted, not once per blocked call', async () => {
    const budget = new DailyLlmBudget({ maxCallsPerDay: 0, maxTokensPerDay: 1_000_000 }, () => T);
    const inner = new FakeInnerClient(() => Promise.resolve({ signals: [] }));
    const logger = warnLogger();
    const client = new BudgetedAgentClient(inner, budget, logger);

    await client.propose(decisionInput());
    await client.propose(decisionInput());

    expect(logger.messages).toHaveLength(1);
  });

  it('delegates and records usage from the proposal when budget is available', async () => {
    const budget = new DailyLlmBudget({ maxCallsPerDay: 10, maxTokensPerDay: 1_000_000 }, () => T);
    const inner = new FakeInnerClient(() =>
      Promise.resolve({ signals: [], usage: { inputTokens: 123, outputTokens: 45 } }),
    );
    const client = new BudgetedAgentClient(inner, budget);

    const proposal = await client.propose(decisionInput());

    expect(inner.calls).toBe(1);
    expect(proposal.usage).toEqual({ inputTokens: 123, outputTokens: 45 });
    expect(budget.snapshot().inputTokens).toBe(123);
    expect(budget.snapshot().outputTokens).toBe(45);
  });

  it('still counts the call against the cap when the inner client rejects', async () => {
    const budget = new DailyLlmBudget({ maxCallsPerDay: 1, maxTokensPerDay: 1_000_000 }, () => T);
    const inner = new FakeInnerClient(() => Promise.reject(new Error('agent down')));
    const client = new BudgetedAgentClient(inner, budget);

    await expect(client.propose(decisionInput())).rejects.toThrow('agent down');
    expect(budget.snapshot().calls).toBe(1); // the call was paid for even though it failed

    const proposal = await client.propose(decisionInput()); // second call now blocked by the cap
    expect(proposal).toEqual({ signals: [] });
    expect(inner.calls).toBe(1);
  });
});

// XA2 (A0 activation bundle): attempt-level pre-flight + session-scoped caps.
describe('XA2: tryReserveAttempt + AttemptScopedBudget', () => {
  const CAPS = {
    maxCallsPerDay: 100,
    maxTokensPerDay: 1_000_000,
    maxCostUsdPerDay: 1.5,
    priceInputPerMtok: 1_000_000, // $1 per token — makes cost arithmetic trivial in fixtures
  };

  it('tryReserveAttempt defers when spent + estimate exceeds the daily cost stop, reserves nothing', () => {
    const budget = new DailyLlmBudget(CAPS, () => T);
    // Spend $1.00 of the $1.50 pool.
    expect(budget.tryReserveCall()).toBe(true);
    budget.recordUsage({ inputTokens: 1, outputTokens: 0 });
    expect(budget.snapshot().costUsd).toBe(1);

    expect(budget.tryReserveAttempt(0.75)).toBe(false); // 1.00 + 0.75 > 1.50 — defer
    expect(budget.tryReserveAttempt(0.5)).toBe(true); // exactly at the cap — allowed
    expect(budget.snapshot().calls).toBe(1); // pre-flight reserved nothing
  });

  it('tryReserveAttempt honors call and token caps too', () => {
    const calls = new DailyLlmBudget({ maxCallsPerDay: 0, maxTokensPerDay: 10 }, () => T);
    expect(calls.tryReserveAttempt(0.1)).toBe(false);
    const tokens = new DailyLlmBudget({ maxCallsPerDay: 5, maxTokensPerDay: 1 }, () => T);
    expect(tokens.tryReserveCall()).toBe(true);
    tokens.recordUsage({ inputTokens: 2, outputTokens: 0 });
    expect(tokens.tryReserveAttempt(0.1)).toBe(false);
  });

  it('AttemptScopedBudget caps calls per attempt while the shared pool stays the meter', () => {
    const budget = new DailyLlmBudget({ maxCallsPerDay: 100, maxTokensPerDay: 1_000_000 }, () => T);
    const attempt = new AttemptScopedBudget(budget, 3, 10);
    expect(attempt.tryReserveCall()).toBe(true);
    expect(attempt.tryReserveCall()).toBe(true);
    expect(attempt.tryReserveCall()).toBe(true);
    expect(attempt.tryReserveCall()).toBe(false); // session call cap — daily pool untouched by the refusal
    expect(budget.snapshot().calls).toBe(3);
    expect(budget.tryReserveCall()).toBe(true); // the shared pool itself still has room
  });

  it('AttemptScopedBudget caps session cost and forwards usage to the shared meter', () => {
    const budget = new DailyLlmBudget(CAPS, () => T);
    const attempt = new AttemptScopedBudget(budget, 100, 0.75);
    expect(attempt.tryReserveCall()).toBe(true);
    expect(attempt.recordUsage({ inputTokens: 1, outputTokens: 0 })).toBe(1); // $1 > 0.75 session cap
    expect(attempt.tryReserveCall()).toBe(false); // session cost cap tripped
    expect(budget.snapshot().costUsd).toBe(1); // shared meter recorded the true spend
  });
});
