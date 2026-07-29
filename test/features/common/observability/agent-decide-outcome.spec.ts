import { describe, it, expect } from 'vitest';
import { MetricsWrappingAgentClient } from '../../../../src/features/trading/composition/trading-runtime.module';
import { DailyLlmBudget } from '../../../../src/features/strategy/agentic/agent-budget';
import type { AgentMetricsRecorder } from '../../../../src/features/common/observability/agent-metrics-recorder.service';
import type { AgentDecideOutcome } from '../../../../src/features/common/observability/agent-metrics-recorder.service';
import type {
  AgentClientPort,
  AgentDecisionInput,
  AgentMarketSnapshot,
  AgentProposal,
} from '../../../../src/ports/strategy/agentic-strategy';
import type { Signal } from '../../../../src/domain/strategy/types/signal';
import { price } from '../../../../src/domain/common/types/money';
import { strategyId, venueId, symbolId, epochMs } from '../../../../src/domain/common/types/ids';
import type { StrategyPortfolioView } from '../../../../src/domain/trading/types/portfolio';

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

// WATCH-V4-8: liveness is stamped from the proposal's own evidence — round-trip proof (promptHash +
// latencyMs, assigned together and only after a response body was parsed) AND the absence of a
// post-200 degrade tag — never from the decide outcome. The suppressed cases below are the ones that
// would otherwise keep the gauge fresh through the very outage it exists to expose: a latched
// suppression and an off-menu short circuit make no call at all; a decision-less `{ signals: [] }`
// early return (no usable ref price, stub client) classifies as a plain 'hold' — 47 such rows sit in
// the live journal; and the degrade cases DO carry hash+latency, which is why they need their own
// exclusion (85 of the 660 hash+latency rows in the live journal are schema_rejected holds, and a
// lane rejecting 100% of its consults reaches Risk with nothing while looking permanently alive).
describe('MetricsWrappingAgentClient liveness stamp (agent_last_success_timestamp_seconds)', () => {
  function stampsFor(proposal: AgentProposal): Promise<number> {
    const inner: AgentClientPort = { propose: () => Promise.resolve(proposal) };
    let stamps = 0;
    const recorder = {
      observeDecideLatency: () => undefined,
      recordTokens: () => undefined,
      recordDecide: () => undefined,
      recordModelRoundTrip: () => {
        stamps += 1;
      },
    } as unknown as AgentMetricsRecorder;
    const budget = new DailyLlmBudget({ maxCallsPerDay: 1, maxTokensPerDay: 1 });
    const client = new MetricsWrappingAgentClient(inner, recorder, budget, DECIDE_MODEL);
    return client.propose(minimalInput()).then(() => stamps);
  }

  it('stamps once when the proposal carries a completed round trip', async () => {
    expect(
      await stampsFor({
        signals: [],
        decision: { action: 'hold', confidence: 0.5, rationale: 'no edge' },
        promptHash: 'abc123',
        latencyMs: 1200,
      }),
    ).toBe(1);
  });

  it.each([
    [
      'a latched suppression (no call made)',
      {
        signals: [],
        decision: { action: 'error', confidence: null, rationale: 'client_latched: no call made' },
      },
    ],
    [
      'an off-menu short circuit (never reaches the client)',
      {
        signals: [],
        decision: { action: 'hold', confidence: 0, rationale: 'off_menu: not in the active menu' },
      },
    ],
    ['a decision-less early return that classifies as hold', { signals: [] }],
    // The post-200 degrades: the model answered, the answer was unusable, nothing reached Risk. Each
    // carries the SAME promptHash/latencyMs an accepted decision carries, so only the rationale tag
    // separates them — that is what these four pin.
    [
      'a schema-rejected payload (answered, but nothing reached Risk)',
      {
        signals: [],
        decision: {
          action: 'hold',
          confidence: 0,
          rationale: 'schema_rejected: decisions: Required',
        },
        promptHash: 'abc123',
        latencyMs: 1200,
      },
    ],
    [
      'a capability violation (journalled action=error, still hash+latency)',
      {
        signals: [],
        decision: {
          action: 'error',
          confidence: null,
          rationale: 'capability_violation:open_short_on_spot',
        },
        promptHash: 'abc123',
        latencyMs: 1200,
      },
    ],
    [
      'a malformed response envelope',
      {
        signals: [],
        decision: {
          action: 'hold',
          confidence: 0,
          rationale: 'envelope_malformed: anthropic response failed envelope validation',
        },
        promptHash: 'abc123',
        latencyMs: 1200,
      },
    ],
    [
      'a model refusal',
      {
        signals: [],
        decision: {
          action: 'hold',
          confidence: 0,
          rationale: 'model_refusal: model declined to decide (stop_reason=refusal)',
        },
        promptHash: 'abc123',
        latencyMs: 1200,
      },
    ],
    [
      'a max_tokens truncation',
      {
        signals: [],
        decision: {
          action: 'hold',
          confidence: 0,
          rationale: 'truncated_max_tokens: response truncated at max_tokens',
        },
        promptHash: 'abc123',
        latencyMs: 1200,
      },
    ],
    [
      'a response with no tool_use block',
      {
        signals: [],
        decision: {
          action: 'hold',
          confidence: 0,
          rationale: 'no_tool_use: no submit_trade tool_use block in response',
        },
        promptHash: 'abc123',
        latencyMs: 1200,
      },
    ],
  ] as [string, AgentProposal][])('does not stamp on %s', async (_label, proposal) => {
    expect(await stampsFor(proposal)).toBe(0);
  });

  // The fee-floor rejection is NOT a degrade: the model produced a valid decision and the local edge
  // floor declined to act on it, which is the lane working. Pinned so a future tightening of the
  // exclusion list cannot quietly swallow a healthy no-trade and make a live lane read as dead.
  it('stamps on a fee-floor-rejected decision — a local veto is not a failed round trip', async () => {
    expect(
      await stampsFor({
        signals: [],
        decision: {
          action: 'hold',
          confidence: 0.6,
          rationale: '[rejected: tp below fee floor] breakout continuation',
        },
        promptHash: 'abc123',
        latencyMs: 1200,
      }),
    ).toBe(1);
  });

  it('does not stamp when a decide throws — a 429 from a suspended account is not liveness', async () => {
    const inner: AgentClientPort = {
      propose: () => Promise.reject(new Error('anthropic api http 429')),
    };
    let stamps = 0;
    const recorder = {
      observeDecideLatency: () => undefined,
      recordTokens: () => undefined,
      recordDecide: () => undefined,
      recordModelRoundTrip: () => {
        stamps += 1;
      },
    } as unknown as AgentMetricsRecorder;
    const budget = new DailyLlmBudget({ maxCallsPerDay: 1, maxTokensPerDay: 1 });
    const client = new MetricsWrappingAgentClient(inner, recorder, budget, DECIDE_MODEL);
    await expect(client.propose(minimalInput())).rejects.toThrow('429');
    expect(stamps).toBe(0);
  });
});
