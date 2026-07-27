import Decimal from 'decimal.js';
import type {
  AgentBudgetBlock,
  AgentClientPort,
  AgentDecisionInput,
  AgentProposal,
  AgentUsage,
} from '../../../ports/strategy/agentic-strategy';
import type { LoggerLike } from './anthropic-agent-client';

const NOOP_LOGGER: LoggerLike = { warn: () => undefined };

const MTOK = 1_000_000;

function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// Per-model USD/1M-token rates (W4+W13 true-spend accounting) — mirrors AppConfig.agentic.tokenPrices'
// shape, but as parsed numbers (this class's whole cost surface predates decimal-string knobs and
// every existing caller/spec asserts costUsd as a plain number; see recordUsage's own comment for why
// the PER-CALL arithmetic still routes through Decimal).
export interface ModelTokenRates {
  readonly inputPerMtok: number;
  readonly outputPerMtok: number;
  readonly cacheReadPerMtok: number;
  readonly cacheWritePerMtok: number;
}

export interface DailyLlmBudgetCaps {
  readonly maxCallsPerDay: number;
  readonly maxTokensPerDay: number;
  // Daily USD cost circuit breaker, priced off recordUsage's token counts (see priceInputPerMtok/
  // priceOutputPerMtok below). Absent/0 (default) disables it — matches the maxCallsPerDay/
  // maxTokensPerDay callers that predate this knob and never set it.
  readonly maxCostUsdPerDay?: number;
  // USD per 1M tokens; only meaningful when maxCostUsdPerDay > 0. Also the DEFAULT-model rates used
  // whenever pricesByModel is absent, or recordUsage's model is absent/unspecified.
  readonly priceInputPerMtok?: number;
  readonly priceOutputPerMtok?: number;
  // W4+W13 cache-token rates (reads price cheap, 1h-TTL writes price dear) — priced $0 before this,
  // undercounting true spend. Same default-rate semantics as priceInputPerMtok/priceOutputPerMtok.
  readonly priceCacheReadPerMtok?: number;
  readonly priceCacheWritePerMtok?: number;
  // Optional per-model override map (e.g. sonnet decides + opus reflects at different rates). A
  // model recordUsage is given that is ABSENT from this map (when the map itself IS configured)
  // fails CLOSED to the most expensive rate configured anywhere (default rates + every mapped
  // model, compared component-wise) rather than silently under-pricing an unrecognized model.
  readonly pricesByModel?: Readonly<Record<string, ModelTokenRates>>;
}

export interface DailyLlmBudgetSnapshot {
  readonly dayKey: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly maxCallsPerDay: number;
  readonly maxTokensPerDay: number;
  readonly maxCostUsdPerDay: number;
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
  private costUsd = 0;
  private seeded = false;

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
    this.costUsd = 0;
  }

  // The shared gate every caller (decide path, reflection mint gates) must pass BEFORE spending
  // calls: false when the pool cannot absorb the whole batch under call/token/current-cost caps.
  // Reserves (increments calls by count) on success — calls are "paid for" regardless of what the
  // caller does next (including failed/rejected inner calls). count=0 is a no-op success; invalid
  // count throws.
  tryReserveCalls(count: number): boolean {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(`tryReserveCalls: count must be a nonnegative integer, got ${count}`);
    }
    if (count === 0) return true;
    this.rollIfNeeded();
    if (this.calls + count > this.caps.maxCallsPerDay) return false;
    if (this.inputTokens + this.outputTokens >= this.caps.maxTokensPerDay) return false;
    const costCap = this.caps.maxCostUsdPerDay ?? 0;
    if (costCap > 0 && this.costUsd >= costCap) return false;
    this.calls += count;
    return true;
  }

  // Single-call sugar — delegates to tryReserveCalls(1).
  tryReserveCall(): boolean {
    return this.tryReserveCalls(1);
  }

  // XA2 (A0 activation bundle): pre-flight headroom check for a MULTI-CALL attempt (weekly
  // reflection, playbook mint + its mint-floor replay, candidate backtest, future replay runs).
  // Returns true only when today's pool could absorb an attempt of ~estimatedUsd on TOP of what is
  // already spent — it reserves NOTHING (per-call reservation still happens inside the attempt via
  // tryReserveCall). Fails CLOSED as a permission gate on the attempt START: an attempt that cannot
  // plausibly finish inside the pool must not start and strand the consult budget (the 2026-07-20
  // Opus reflection runaway spent $2.48 against a $1.50 stop and blacked out consults for hours).
  // Mid-attempt calls keep their existing fail-OPEN posture — this gate never interrupts a running
  // attempt.
  tryReserveAttempt(estimatedUsd: number): boolean {
    this.rollIfNeeded();
    if (this.calls >= this.caps.maxCallsPerDay) return false;
    if (this.inputTokens + this.outputTokens >= this.caps.maxTokensPerDay) return false;
    const costCap = this.caps.maxCostUsdPerDay ?? 0;
    if (costCap > 0 && new Decimal(this.costUsd).plus(estimatedUsd).gt(costCap)) return false;
    return true;
  }

  // Seed today's counters from durable spend already on record. The breaker is an in-memory
  // per-UTC-day meter, so before this existed EVERY redeploy handed the lane a fresh full budget:
  // on a day with three deploys the "$3/day" cap authorised $12 (observed 2026-07-27 — the gauge
  // read a full $3.00 immediately after a redeploy that followed ~$0.31 of spend). The durable
  // ledgers were never wrong; only this meter was, so evidence walks were unaffected and this is a
  // cost-control repair, not a measurement one.
  //
  // Idempotent per instance: seeding twice would double-count, so it happens at most once, and never
  // after the meter has already recorded a live call (a seed landing mid-day behind real spend would
  // re-add history already counted). Rows are priced through recordUsage, so per-model rates, cache
  // tokens and the fail-closed unknown-model rate all behave exactly as they do for live calls.
  //
  // NOTE what is NOT restored: the per-day CALL count. The durable ledgers store token totals per
  // model, not the number of calls, so maxCallsPerDay still resets across a redeploy. The USD
  // breaker is the binding constraint and it is now durable; the call cap remains best-effort.
  seedDaySpend(rows: readonly { model?: string; usage: AgentUsage }[]): void {
    if (this.seeded || this.calls > 0 || this.costUsd > 0) return;
    this.seeded = true;
    this.rollIfNeeded();
    for (const row of rows) this.recordUsage(row.usage, row.model);
  }

  // model: the id the call was actually priced against (e.g. the decide model vs a pricier
  // reflection model) — see resolveRates for the default/per-model/fail-closed resolution order.
  // Cache tokens (W4+W13) are NOT folded into inputTokens/outputTokens: those two counters back
  // maxTokensPerDay, which predates cache accounting and must keep counting the same tokens it
  // always has — only costUsd (a separate cap) grows with cache-token spend.
  // XA2: returns the priced cost of THIS call (0 when no usage) so attempt-scoped wrappers can
  // meter their own session spend without re-implementing rate resolution; existing void-callers
  // are unaffected.
  recordUsage(usage?: AgentUsage, model?: string): number {
    this.rollIfNeeded();
    if (!usage) return 0;
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    const rates = this.resolveRates(model);
    // Per-call cost via Decimal (money math, never native-float accumulation) even though the
    // rates/costUsd stay plain numbers at the class boundary — every existing caller/spec asserts
    // costUsd with toBe() against plain numbers computed off round inputs, so the external type is
    // preserved; only the arithmetic route changes.
    const callCost = new Decimal(usage.inputTokens)
      .div(MTOK)
      .mul(rates.input)
      .plus(new Decimal(usage.outputTokens).div(MTOK).mul(rates.output))
      .plus(new Decimal(usage.cacheReadInputTokens ?? 0).div(MTOK).mul(rates.cacheRead))
      .plus(new Decimal(usage.cacheCreationInputTokens ?? 0).div(MTOK).mul(rates.cacheWrite));
    this.costUsd = new Decimal(this.costUsd).plus(callCost).toNumber();
    return callCost.toNumber();
  }

  private resolveRates(model: string | undefined): {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  } {
    const defaultRates = {
      input: this.caps.priceInputPerMtok ?? 0,
      output: this.caps.priceOutputPerMtok ?? 0,
      cacheRead: this.caps.priceCacheReadPerMtok ?? 0,
      cacheWrite: this.caps.priceCacheWritePerMtok ?? 0,
    };
    const byModel = this.caps.pricesByModel;
    if (!byModel || model === undefined) return defaultRates;
    const entry = byModel[model];
    if (entry) {
      return {
        input: entry.inputPerMtok,
        output: entry.outputPerMtok,
        cacheRead: entry.cacheReadPerMtok,
        cacheWrite: entry.cacheWritePerMtok,
      };
    }
    // Unknown model with a map configured: fail-closed to the most expensive rate PER COMPONENT
    // across every configured rate set (default + every mapped model) — never silently undercounts
    // an unrecognized model's true spend.
    const pools = [
      defaultRates,
      ...Object.values(byModel).map((e) => ({
        input: e.inputPerMtok,
        output: e.outputPerMtok,
        cacheRead: e.cacheReadPerMtok,
        cacheWrite: e.cacheWritePerMtok,
      })),
    ];
    return {
      input: Math.max(...pools.map((p) => p.input)),
      output: Math.max(...pools.map((p) => p.output)),
      cacheRead: Math.max(...pools.map((p) => p.cacheRead)),
      cacheWrite: Math.max(...pools.map((p) => p.cacheWrite)),
    };
  }

  // I1 (Design § Enriched model inputs): the payload's budget line — remaining calls/tokens/USD
  // against today's caps, plus an approximate cost per future consult. approxCostPerConsultUsd is
  // today's own OBSERVED average (costUsd / calls so far) — the only cost basis this class can
  // ground without guessing a token count for a call that hasn't happened yet; '0' before the first
  // call of the day. Exact decimal strings (money-adjacent path) via Decimal, never native float.
  budgetBlock(): AgentBudgetBlock {
    this.rollIfNeeded();
    const remainingCallsToday = Math.max(0, this.caps.maxCallsPerDay - this.calls);
    const remainingTokensToday = Math.max(
      0,
      this.caps.maxTokensPerDay - (this.inputTokens + this.outputTokens),
    );
    const costCap = this.caps.maxCostUsdPerDay ?? 0;
    const remainingUsdToday =
      costCap > 0
        ? Decimal.max(0, new Decimal(costCap).minus(this.costUsd)).toFixed()
        : new Decimal(0).toFixed();
    const approxCostPerConsultUsd = (
      this.calls > 0 ? new Decimal(this.costUsd).div(this.calls) : new Decimal(0)
    ).toFixed();
    return {
      remainingCallsToday,
      remainingTokensToday,
      remainingUsdToday,
      approxCostPerConsultUsd,
    };
  }

  snapshot(): DailyLlmBudgetSnapshot {
    this.rollIfNeeded();
    const costCap = this.caps.maxCostUsdPerDay ?? 0;
    const exhausted =
      this.calls >= this.caps.maxCallsPerDay ||
      this.inputTokens + this.outputTokens >= this.caps.maxTokensPerDay ||
      (costCap > 0 && this.costUsd >= costCap);
    return {
      dayKey: this.dayKey,
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
      maxCallsPerDay: this.caps.maxCallsPerDay,
      maxTokensPerDay: this.caps.maxTokensPerDay,
      maxCostUsdPerDay: costCap,
      exhausted,
    };
  }
}

// XA2 (A0 activation bundle): attempt-scoped spend gate for multi-call attempts. Wraps the SHARED
// DailyLlmBudget (the daily meter stays the single source of truth for total spend) and ADDS two
// session-local hard caps — max calls and max USD per attempt — bounding the runaway shape the W6
// soak caught live (78-133 Opus calls / $2.25-2.93 per reflection session where 2 calls / ~$0.10
// did the same job on 2026-07-11). When a session cap trips, tryReserveCall returns false and the
// attempt's own existing degrade paths take over (mint-floor replay proceeds on partial evidence —
// fail-open mid-attempt); the daily pool is never stranded. One instance per attempt, never reused.
export class AttemptScopedBudget {
  private calls = 0;
  private costUsd = new Decimal(0);

  constructor(
    private readonly inner: DailyLlmBudget,
    private readonly maxCallsPerAttempt: number,
    private readonly maxCostUsdPerAttempt: number,
  ) {}

  tryReserveCalls(count: number): boolean {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(`tryReserveCalls: count must be a nonnegative integer, got ${count}`);
    }
    if (count === 0) return true;
    if (this.calls + count > this.maxCallsPerAttempt) return false;
    if (this.costUsd.gte(this.maxCostUsdPerAttempt)) return false;
    if (!this.inner.tryReserveCalls(count)) return false;
    this.calls += count;
    return true;
  }

  tryReserveCall(): boolean {
    return this.tryReserveCalls(1);
  }

  recordUsage(usage?: AgentUsage, model?: string): number {
    const callCost = this.inner.recordUsage(usage, model);
    this.costUsd = this.costUsd.plus(callCost);
    return callCost;
  }

  snapshot(): { calls: number; costUsd: number } {
    return { calls: this.calls, costUsd: this.costUsd.toNumber() };
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
    // The model this client's inner AgentClientPort actually calls (e.g. AGENTIC_MODEL) — threaded
    // into recordUsage so per-model cache/token rates (W4+W13) price the decide path correctly.
    // Absent (default) preserves pre-W4 behavior: recordUsage falls back to the flat default rates.
    private readonly model?: string,
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
      // H4 (2026-07-27): an explicit decision, never a decision-less proposal — a decision-less hold
      // persists byte-identical to a genuine model hold (empty rationale, confidence 0),
      // undiagnosable from the journal alone. See anthropic-agent-client.ts's own soft-hold branches
      // for the same discipline.
      return {
        signals: [],
        decision: {
          action: 'hold',
          confidence: 0,
          rationale: `budget_exhausted: daily LLM budget exhausted (day ${dayKey})`,
        },
      };
    }
    const proposal = await this.inner.propose(input);
    this.budget.recordUsage(proposal.usage, this.model);
    return proposal;
  }
}
