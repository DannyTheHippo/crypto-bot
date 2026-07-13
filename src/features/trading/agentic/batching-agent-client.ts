import type {
  AgentClientPort,
  AgentDecisionInput,
  AgentProposal,
} from '../../../ports/agentic-strategy';
import type { DailyLlmBudget } from './agent-budget';
import type { AgentProposeBatchResult, LoggerLike } from './anthropic-agent-client';

const NOOP_LOGGER: LoggerLike = { warn: () => undefined };

// Push II Phase 5 DESIGN Task 2 defaults — see environment.config.ts's AGENTIC_PORTFOLIO_* schema
// entries for the deployed defaults (must match: 3000 / 5).
const DEFAULT_WINDOW_MS = 3000;
const DEFAULT_MAX_BATCH_SIZE = 5;
// Floor on the batch's own HTTP attempt timeout (see flush()'s window/timeout comment) — below this
// a multi-symbol request (more tokens, more to read/write than a single-symbol call) has too little
// wall-clock left to plausibly complete at all.
const HTTP_TIMEOUT_FLOOR_MS = 5000;

// The narrow surface BatchingAgentClient needs from its inner client — AnthropicAgentClient
// satisfies this structurally (see its own proposeBatch method); a fake in tests only needs to
// implement this, not the full AgentClientPort + private internals.
export interface BatchCapableAgentClient {
  proposeBatch(
    inputs: readonly AgentDecisionInput[],
    opts?: { readonly timeoutMsOverride?: number },
  ): Promise<AgentProposeBatchResult>;
}

export interface BatchingAgentClientConfig {
  // Coalescing window (ms): the first propose() call to arrive after an empty queue opens the
  // window; every propose() call arriving before it closes joins the SAME batch. Default 3000
  // (AGENTIC_PORTFOLIO_WINDOW_MS's schema default).
  readonly windowMs?: number;
  // Early-flush threshold: once this many callers have joined the current batch, it flushes
  // immediately without waiting for the rest of the window (matches the deployment's configured
  // symbol count — see agentic-strategy.module.ts's AGENTIC_PORTFOLIO_SYMBOL_COUNT overlay).
  // Default 5 (this deployment's P7 symbol count).
  readonly maxBatchSize?: number;
  // The SAME AGENTIC_TIMEOUT_MS value the host's own decide backstop is derived from
  // (`agentic.timeoutMs + 2_000` — see app.module.ts's StrategyHost factory). Used to compute this
  // batch's own HTTP attempt timeout (see flush()) so the batch's total wall time never threatens
  // that backstop.
  readonly agentTimeoutMs: number;
  // Threaded into DailyLlmBudget.recordUsage so per-model cache/token rates price the batched call
  // correctly (mirrors BudgetedAgentClient's own `model` ctor param).
  readonly model?: string;
}

interface PendingEntry {
  readonly symbol: string;
  readonly input: AgentDecisionInput;
  readonly resolve: (proposal: AgentProposal) => void;
  readonly reject: (err: unknown) => void;
}

// Decorator coalescing concurrent single-symbol propose() calls (one per agentic-N strategy
// instance, all firing within seconds of the same 15m bar close — see the P7 host's per-symbol
// mailboxes) into ONE Anthropic call via AnthropicAgentClient.proposeBatch's submit_portfolio tool.
// Flag-gated construction (AGENTIC_PORTFOLIO_CONSULT, see agentic-strategy.module.ts's
// selectAgentClient): flag-off never constructs this class, so the legacy
// BudgetedAgentClient(AnthropicAgentClient) chain is byte-identical by construction.
//
// Placement in the client chain: MetricsWrappingAgentClient (app.module.ts) wraps AGENT_CLIENT
// unchanged — each of the 5 strategies' own propose() call is independently metered by ITS OWN
// MetricsWrappingAgentClient.propose() invocation (latency = however long ITS OWN await took,
// tokens recorded only when its resolved AgentProposal carries `usage` — i.e. only for the batch's
// first-arrived symbol), so metrics stay PER-SYMBOL even though the batch underneath is shared. The
// daily budget, by contrast, is reserved/recorded exactly ONCE per batch (via `budget` below) rather
// than once per symbol: BudgetedAgentClient's own propose(input) signature accepts only one
// AgentDecisionInput per call, so it cannot itself front a multi-symbol batch — this class holds the
// SAME DailyLlmBudget instance directly (constructed once at the composition root, shared with every
// other consumer — see agentic-strategy.module.ts) and performs its own single tryReserveCall/
// recordUsage per batch instead of nesting the BudgetedAgentClient class. The net invariant
// (metrics-per-symbol, budget-per-batch) is identical either way; only the concrete class chain
// differs from a literal Metrics→Batching→Budgeted→Anthropic nesting.
export class BatchingAgentClient implements AgentClientPort {
  private readonly windowMs: number;
  private readonly maxBatchSize: number;
  private readonly agentTimeoutMs: number;
  private readonly model?: string;
  private readonly logger: LoggerLike;
  private pending: PendingEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastWarnedBudgetDayKey: string | null = null;

  constructor(
    private readonly inner: BatchCapableAgentClient,
    private readonly budget: DailyLlmBudget,
    cfg: BatchingAgentClientConfig,
    logger: LoggerLike = NOOP_LOGGER,
  ) {
    this.windowMs = cfg.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxBatchSize = cfg.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.agentTimeoutMs = cfg.agentTimeoutMs;
    this.model = cfg.model;
    this.logger = logger;
  }

  propose(input: AgentDecisionInput): Promise<AgentProposal> {
    return new Promise<AgentProposal>((resolve, reject) => {
      const symbol = String(input.trigger.event.symbol);
      this.pending.push({ symbol, input, resolve, reject });
      // First arrival opens the window.
      if (this.pending.length === 1) {
        this.flushTimer = setTimeout(() => this.flush(), this.windowMs);
      }
      // Early flush: every configured symbol has already checked in this bar — no reason to wait
      // out the rest of the window.
      if (this.pending.length >= this.maxBatchSize) {
        this.flush();
      }
    });
  }

  private flush(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const batch = this.pending;
    this.pending = [];
    if (batch.length === 0) return;
    void this.settleBatch(batch);
  }

  private async settleBatch(batch: readonly PendingEntry[]): Promise<void> {
    if (!this.budget.tryReserveCall()) {
      // Mirrors BudgetedAgentClient's own inert short-circuit exactly, ONE reservation attempt for
      // the whole batch rather than one per symbol.
      const { dayKey } = this.budget.snapshot();
      if (this.lastWarnedBudgetDayKey !== dayKey) {
        this.logger.warn(
          `agentic budget: daily LLM budget exhausted (day ${dayKey}) — returning no signals for the ${batch.length}-symbol portfolio batch without calling the agent client`,
        );
        this.lastWarnedBudgetDayKey = dayKey;
      }
      for (const entry of batch) entry.resolve({ signals: [] });
      return;
    }

    // Window/timeout math: this batch's first-arrival caller may have already waited up to
    // `windowMs` for co-arrivals before this HTTP attempt even starts. The host's own decide
    // backstop (StrategyHost's agentTimeoutMs = AGENTIC_TIMEOUT_MS + 2_000 — app.module.ts) times
    // out the WHOLE decide() call, window included, so the attempt's own timeout budget must be
    // AGENTIC_TIMEOUT_MS reduced by the window already spent — never below HTTP_TIMEOUT_FLOOR_MS
    // (a multi-symbol request needs a floor worth of wall-clock to plausibly complete at all).
    // Worst case (first-arrival waited the FULL window, then the attempt runs to its own timeout):
    // total wall time = windowMs + httpTimeoutMs. When agentTimeoutMs - windowMs >= the floor, that
    // total collapses to exactly agentTimeoutMs — inside the host's backstop with the full 2s margin
    // to spare. Only a windowMs configured close to (or above) agentTimeoutMs erodes that margin —
    // see the fake-timer test in portfolio-consult.spec.ts pinning the arithmetic for the deployed
    // defaults (windowMs=3000, agentTimeoutMs=30000).
    const httpTimeoutMs = Math.max(HTTP_TIMEOUT_FLOOR_MS, this.agentTimeoutMs - this.windowMs);

    let result: AgentProposeBatchResult;
    try {
      result = await this.inner.proposeBatch(
        batch.map((e) => e.input),
        { timeoutMsOverride: httpTimeoutMs },
      );
    } catch (err) {
      // Whole-call transport/schema failure: reject EVERY waiting caller with the SAME error, so
      // each strategy's own strike accounting takes exactly 1 strike from its own rejected promise —
      // identical to what 5 independently-failing single-symbol calls would do today.
      for (const entry of batch) entry.reject(err);
      return;
    }

    this.budget.recordUsage(result.usage, this.model);
    for (const entry of batch) {
      const proposal = result.proposals.get(entry.symbol);
      if (proposal === undefined) {
        // Defensive backstop only: AnthropicAgentClient.proposeBatch already guarantees full
        // coverage (with its own warn) for every symbol it was asked about.
        this.logger.warn(
          `agentic portfolio batch: symbol ${entry.symbol} absent from batch result — holding`,
        );
        entry.resolve({ signals: [] });
      } else {
        entry.resolve(proposal);
      }
    }
  }
}
