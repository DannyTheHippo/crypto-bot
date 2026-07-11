import { describe, it, expect } from 'vitest';
import { MetricsWrappingAgentClient } from '../../../src/app.module';
import { DailyLlmBudget } from '../../../src/features/trading/agentic/agent-budget';
import type { AgentMetricsRecorder } from '../../../src/features/common/observability/agent-metrics-recorder.service';
import type { AgentDecideOutcome } from '../../../src/features/common/observability/agent-metrics-recorder.service';
import type {
  AgentClientPort,
  AgentDecisionInput,
  AgentMarketSnapshot,
  AgentProposal,
} from '../../../src/ports/agentic-strategy';
import type { Signal } from '../../../src/domain/types/signal';
import { price } from '../../../src/domain/types/money';
import { strategyId, venueId, symbolId, epochMs } from '../../../src/domain/types/ids';
import type { StrategyPortfolioView } from '../../../src/domain/types/portfolio';

// Regression coverage for outcomeForProposal's classification (private, exercised via propose()) —
// the honest-metric fix: a non-hold action mapped to zero signals (already-FLAT 'flat', already-LONG
// 'long' — see anthropic-agent-client.ts's mapping comment) must not count as 'proposed'.

const T = 1_700_000_000_000;
const SID = strategyId('agentic-1');
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');

const minimalInput = (): AgentDecisionInput => ({
  strategyId: SID,
  trigger: { kind: 'ticker', event: { kind: 'TICKER', venue: V, symbol: SYM } as never },
  snapshot: {
    eventTime: epochMs(T),
    candles: new Map(),
    tickers: new Map(),
    books: new Map(),
    execReports: [],
    portfolio: { strategyId: SID, positions: new Map(), openOrders: [] } as StrategyPortfolioView,
  } satisfies AgentMarketSnapshot,
});

const signal = (): Signal => ({
  strategyId: SID,
  venue: V,
  symbol: SYM,
  kind: 'ENTER_LONG',
  strength: 1,
  refPrice: price('100'),
  basedOnSeq: 1n,
  eventTime: epochMs(T),
  ttlMs: 5000,
  dedupeKey: 'k1',
  reason: 'agent conviction',
});

function outcomeFor(proposal: AgentProposal): Promise<AgentDecideOutcome> {
  const inner: AgentClientPort = { propose: () => Promise.resolve(proposal) };
  const captured: AgentDecideOutcome[] = [];
  const recorder = {
    observeDecideLatency: () => undefined,
    recordTokens: () => undefined,
    recordDecide: (outcome: AgentDecideOutcome) => captured.push(outcome),
  } as unknown as AgentMetricsRecorder;
  const budget = new DailyLlmBudget({ maxCallsPerDay: 1, maxTokensPerDay: 1 });
  const client = new MetricsWrappingAgentClient(inner, recorder, budget, DECIDE_MODEL);
  return client.propose(minimalInput()).then(() => captured[0]!);
}

const DECIDE_MODEL = 'claude-sonnet-5';

describe('MetricsWrappingAgentClient outcome classification (agent_decide_total{outcome})', () => {
  it('hold action -> hold', async () => {
    const outcome = await outcomeFor({
      signals: [],
      decision: { action: 'hold', confidence: 0.5, rationale: 'no edge' },
    });
    expect(outcome).toBe('hold');
  });

  it('non-hold action with zero emitted signals -> noop (nothing reached Risk)', async () => {
    const outcome = await outcomeFor({
      signals: [],
      decision: { action: 'flat', confidence: 0.5, rationale: 'already flat' },
    });
    expect(outcome).toBe('noop');
  });

  it('non-hold action with an emitted signal -> proposed', async () => {
    const outcome = await outcomeFor({
      signals: [signal()],
      decision: { action: 'long', confidence: 0.8, rationale: 'breakout' },
    });
    expect(outcome).toBe('proposed');
  });
});

describe('MetricsWrappingAgentClient token forwarding (agent_tokens_total)', () => {
  function tokensFor(usage: AgentProposal['usage']): Promise<unknown[]> {
    const inner: AgentClientPort = {
      propose: () =>
        Promise.resolve({
          signals: [],
          decision: { action: 'hold', confidence: 0.5, rationale: 'no edge' },
          usage,
        } satisfies AgentProposal),
    };
    const captured: unknown[][] = [];
    const recorder = {
      observeDecideLatency: () => undefined,
      recordTokens: (...args: unknown[]) => {
        captured.push(args);
      },
      recordDecide: () => undefined,
    } as unknown as AgentMetricsRecorder;
    const budget = new DailyLlmBudget({ maxCallsPerDay: 1, maxTokensPerDay: 1 });
    const client = new MetricsWrappingAgentClient(inner, recorder, budget, DECIDE_MODEL);
    return client.propose(minimalInput()).then(() => captured[0]!);
  }

  it('forwards cache usage fields when the response carried them (W2.4 verification path)', async () => {
    const args = await tokensFor({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 1500,
      cacheCreationInputTokens: 30,
    });
    expect(args).toEqual([100, 20, 1500, 30, DECIDE_MODEL]);
  });

  it('forwards undefined (not 0) when cache fields are absent — absent must stay distinguishable', async () => {
    const args = await tokensFor({ inputTokens: 100, outputTokens: 20 });
    expect(args).toEqual([100, 20, undefined, undefined, DECIDE_MODEL]);
  });
});
