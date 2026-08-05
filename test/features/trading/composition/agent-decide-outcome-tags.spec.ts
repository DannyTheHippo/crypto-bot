import { describe, it, expect } from 'vitest';
import { MetricsWrappingAgentClient } from '../../../../src/features/trading/composition/trading-runtime.module';
import { DailyLlmBudget } from '../../../../src/features/strategy/agentic/agent-budget';
import type { AgentMetricsRecorder } from '../../../../src/features/common/observability/agent-metrics-recorder.service';
import type { AgentDecideOutcome } from '../../../../src/features/common/observability/agent-metrics-recorder.service';
import { isDegradedDecideRationale } from '../../../../src/domain/strategy/types/decide-rationale';
import {
  AgentProposeError,
  type AgentClientPort,
  type AgentDecisionInput,
  type AgentMarketSnapshot,
  type AgentProposal,
} from '../../../../src/ports/strategy/agentic-strategy';
import { strategyId, venueId, symbolId, epochMs } from '../../../../src/domain/common/types/ids';
import type { StrategyPortfolioView } from '../../../../src/domain/trading/types/portfolio';

// H4 (2026-07-27): outcomeForProposal now branches on the decision.rationale prefix each of the
// seven soft-hold call sites stamps (anthropic-agent-client.ts/agent-budget.ts/
// batching-agent-client.ts) BEFORE the pre-existing hold/noop/proposed fallthrough — see
// agent-decide-outcome.spec.ts (test/features/common/observability) for that fallthrough's own
// coverage, which this file leaves untouched.

const T = 1_700_000_000_000;
const SID = strategyId('agentic-1');
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');
const DECIDE_MODEL = 'claude-sonnet-5';

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

describe('MetricsWrappingAgentClient outcome classification — H4 rationale tags', () => {
  it('envelope_malformed: rationale -> envelope_malformed', async () => {
    const outcome = await outcomeFor({
      signals: [],
      decision: {
        action: 'hold',
        confidence: 0,
        rationale: 'envelope_malformed: anthropic response failed envelope validation',
      },
    });
    expect(outcome).toBe('envelope_malformed');
  });

  it('model_refusal: rationale -> model_refusal', async () => {
    const outcome = await outcomeFor({
      signals: [],
      decision: {
        action: 'hold',
        confidence: 0,
        rationale: 'model_refusal: model declined to decide (stop_reason=refusal)',
      },
    });
    expect(outcome).toBe('model_refusal');
  });

  it('truncated_max_tokens: rationale -> truncated', async () => {
    const outcome = await outcomeFor({
      signals: [],
      decision: {
        action: 'hold',
        confidence: 0,
        rationale: 'truncated_max_tokens: response truncated at max_tokens',
      },
    });
    expect(outcome).toBe('truncated');
  });

  it('no_tool_use: rationale ALSO -> truncated (one metric label covers both truncation tags)', async () => {
    const outcome = await outcomeFor({
      signals: [],
      decision: {
        action: 'hold',
        confidence: 0,
        rationale: 'no_tool_use: no submit_trade tool_use block in response',
      },
    });
    expect(outcome).toBe('truncated');
  });

  // 2026-07-31 (schemaFailureRationale, anthropic-agent-client.ts): pins the boundary the
  // truncated_max_tokens: case above sits right next to — a genuine schema_rejected: (no max_tokens
  // truncation involved) falls through every named branch and lands on the pre-existing
  // action==='hold' fallthrough, NOT 'truncated'. Re-tagging a truncation-caused failure from
  // schema_rejected: to truncated_max_tokens: therefore moves it from {outcome="hold"} to
  // {outcome="truncated"} on agent_decide_total — checked benign (both labels are in
  // PROVES_CALL_COMPLETED_OUTCOMES, neither in LATCHED_DECIDE_OUTCOMES) but a real bucket move, pinned
  // here so a future change to either tag's classification fails this test instead of silently
  // reshaping the metric.
  it("schema_rejected: rationale -> hold (falls through every named branch, NOT 'truncated')", async () => {
    const outcome = await outcomeFor({
      signals: [],
      decision: {
        action: 'hold',
        confidence: 0,
        rationale: 'schema_rejected: action: Invalid option',
      },
    });
    expect(outcome).toBe('hold');
  });

  // Pass 64: empty_tool_input: is a schema_rejected sibling — split out because an empty/absent
  // tool-input payload is a DIFFERENT defect than a present-but-malformed one (see decide-rationale.
  // ts's DEGRADED_DECIDE_RATIONALE_TAGS). Explicit branch, same 'hold' outcome as schema_rejected:.
  it('empty_tool_input: rationale -> hold, and stays a degrade tag excluded from the WATCH-V4-8 liveness stamp', async () => {
    const rationale = 'empty_tool_input: decisions: expected array, received undefined';
    const outcome = await outcomeFor({
      signals: [],
      decision: { action: 'hold', confidence: 0, rationale },
    });
    expect(outcome).toBe('hold');
    expect(isDegradedDecideRationale(rationale)).toBe(true);
  });

  it('budget_exhausted: rationale -> budget_blocked (reuses the pre-existing label)', async () => {
    const outcome = await outcomeFor({
      signals: [],
      decision: {
        action: 'hold',
        confidence: 0,
        rationale: 'budget_exhausted: daily LLM budget exhausted (day 2026-07-27)',
      },
    });
    expect(outcome).toBe('budget_blocked');
  });

  it('off_menu: rationale -> off_menu', async () => {
    const outcome = await outcomeFor({
      signals: [],
      decision: {
        action: 'hold',
        confidence: 0,
        rationale: 'off_menu: symbol BTC/USDT is not in the active trading menu',
      },
    });
    expect(outcome).toBe('off_menu');
  });

  it('a decision-less proposal still falls back to the pre-existing budget-snapshot heuristic (fallback, not the primary path)', async () => {
    const outcome = await outcomeFor({ signals: [] });
    // No rationale to read, and DailyLlmBudget above was never actually exhausted by THIS
    // proposal's own call — the fallback degrades to 'hold', matching pre-H4 behavior for a
    // caller that never adopted the new tags.
    expect(outcome).toBe('hold');
  });
});

// Pass 48 (2026-07-30): the ONE place a latch cause can be forwarded from is this wrapper — the
// success path parses it out of the client_latched rationale (anthropic-agent-client.ts embeds it),
// the catch path classifies it straight off the AgentProposeError. Both call recordDecide's third
// argument; nothing else in this codebase may set it.
describe('MetricsWrappingAgentClient — latch-cause forwarding (recordDecide 3rd argument)', () => {
  function captureRecordDecideArgs(inner: AgentClientPort): Promise<unknown[]> {
    const captured: unknown[][] = [];
    const recorder = {
      observeDecideLatency: () => undefined,
      recordTokens: () => undefined,
      recordDecide: (...args: unknown[]) => captured.push(args),
    } as unknown as AgentMetricsRecorder;
    const budget = new DailyLlmBudget({ maxCallsPerDay: 1, maxTokensPerDay: 1 });
    const client = new MetricsWrappingAgentClient(inner, recorder, budget, DECIDE_MODEL);
    return client
      .propose(minimalInput())
      .catch(() => undefined)
      .then(() => captured[0]!);
  }
  function argsForProposal(proposal: AgentProposal): Promise<unknown[]> {
    return captureRecordDecideArgs({ propose: () => Promise.resolve(proposal) });
  }
  function argsForError(err: AgentProposeError): Promise<unknown[]> {
    return captureRecordDecideArgs({ propose: () => Promise.reject(err) });
  }

  it('a client_latched rationale forwards the embedded cause', async () => {
    const args = await argsForProposal({
      signals: [],
      decision: {
        action: 'error',
        confidence: null,
        rationale:
          'client_latched: agent client latched degraded by a FATAL api error (cause=insufficient_credit) 5s ago',
      },
    });
    expect(args).toEqual(['client_latched', DECIDE_MODEL, 'insufficient_credit']);
  });

  it('an error_fatal AgentProposeError forwards the classified cause from status+message', async () => {
    const args = await argsForError(new AgentProposeError('anthropic api http 401', 'FATAL', 401));
    expect(args).toEqual(['error_fatal', DECIDE_MODEL, 'auth']);
  });

  it('a RETRYABLE rejection forwards no cause (undefined) — nothing to classify off a non-fatal failure', async () => {
    const args = await argsForError(
      new AgentProposeError('anthropic api transport error: timeout', 'RETRYABLE'),
    );
    expect(args).toEqual(['error_retryable', DECIDE_MODEL, undefined]);
  });

  it('a proposed (non-latched) outcome forwards no cause', async () => {
    const args = await argsForProposal({
      signals: [],
      decision: { action: 'hold', confidence: 0.5, rationale: 'no edge' },
    });
    expect(args).toEqual(['hold', DECIDE_MODEL, undefined]);
  });
});
