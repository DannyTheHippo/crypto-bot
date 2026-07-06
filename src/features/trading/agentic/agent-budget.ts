import type {
  AgentClientPort,
  AgentDecisionInput,
  AgentProposal,
  AgentUsage,
} from '../../../ports/agentic-strategy';
import type { LoggerLike } from './anthropic-agent-client';

const NOOP_LOGGER: LoggerLike = { warn: () => undefined };

function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export interface DailyLlmBudgetCaps {
  readonly maxCallsPerDay: number;
  readonly maxTokensPerDay: number;
}

export interface DailyLlmBudgetSnapshot {
  readonly dayKey: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly maxCallsPerDay: number;
  readonly maxTokensPerDay: number;
  readonly exhausted: boolean;
}

// Shared daily spend cap for the agentic lane — one instance serves both the decide path
// (BudgetedAgentClient below) and any future reflection path, so a single UTC-day window is never
// split across two independent counters. Rolls over automatically on read (no timer): every method
// re-derives "today" from nowFn() before touching state.
export class DailyLlmBudget {
  private dayKey: string;
  private calls = 0;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(
    private readonly caps: DailyLlmBudgetCaps,
    private readonly nowFn: () => number = Date.now,
  ) {
    this.dayKey = utcDayKey(this.nowFn());
  }

  private rollIfNeeded(): void {
    const today = utcDayKey(this.nowFn());
    if (today === this.dayKey) return;
    this.dayKey = today;
    this.calls = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
  }

  // The shared gate every caller (decide path, future reflection path) must pass BEFORE spending a
  // call: false when the call cap is already reached, or the token cap was already crossed by prior
  // usage. Reserves (increments calls) on success — the call is "paid for" regardless of what its
  // caller does with it next (including a failed/rejected inner call).
  tryReserveCall(): boolean {
    this.rollIfNeeded();
    if (this.calls >= this.caps.maxCallsPerDay) return false;
    if (this.inputTokens + this.outputTokens >= this.caps.maxTokensPerDay) return false;
    this.calls += 1;
    return true;
  }

  recordUsage(usage?: AgentUsage): void {
    this.rollIfNeeded();
    if (!usage) return;
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
  }

  snapshot(): DailyLlmBudgetSnapshot {
    this.rollIfNeeded();
    const exhausted =
      this.calls >= this.caps.maxCallsPerDay ||
      this.inputTokens + this.outputTokens >= this.caps.maxTokensPerDay;
    return {
      dayKey: this.dayKey,
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      maxCallsPerDay: this.caps.maxCallsPerDay,
      maxTokensPerDay: this.caps.maxTokensPerDay,
      exhausted,
    };
  }
}

// Decorator wrapping the REAL AgentClientPort with the shared daily budget: exceeded → an inert
// `{ signals: [] }` without ever calling the inner client (mirrors the StubAgentClient fail-safe
// shape); otherwise delegates and records the inner call's usage. `inner`/`budget` are exposed
// read-only for later observability/reflection wiring.
export class BudgetedAgentClient implements AgentClientPort {
  private lastWarnedDayKey: string | null = null;

  constructor(
    readonly inner: AgentClientPort,
    readonly budget: DailyLlmBudget,
    private readonly logger: LoggerLike = NOOP_LOGGER,
  ) {}

  async propose(input: AgentDecisionInput): Promise<AgentProposal> {
    if (!this.budget.tryReserveCall()) {
      const { dayKey } = this.budget.snapshot();
      if (this.lastWarnedDayKey !== dayKey) {
        this.logger.warn(
          `agentic budget: daily LLM budget exhausted (day ${dayKey}) — returning no signals without calling the agent client`,
        );
        this.lastWarnedDayKey = dayKey;
      }
      return { signals: [] };
    }
    const proposal = await this.inner.propose(input);
    this.budget.recordUsage(proposal.usage);
    return proposal;
  }
}
