import { z } from 'zod';
import Decimal from 'decimal.js';
import { price, qty, type Price } from '../../../domain/types/money';
import type { OrderBookSnapshotEvent } from '../../../domain/types/market-events';
import type { Signal } from '../../../domain/types/signal';
import {
  AgentProposeError,
  type AgentClientPort,
  type AgentDecisionInput,
  type AgentPlan,
  type AgentProposal,
  type AgentTradingProfile,
  type PlaybookProvider,
} from '../../../ports/agentic-strategy';
import {
  DECISION_TOOL,
  DERIVATIVES_TEMPLATE_VERSION,
  SENTIMENT_TEMPLATE_VERSION,
  SHORTS_DECISION_TOOL,
  SHORTS_TEMPLATE_VERSION,
  PLAN_BOUNDS,
  PLAN_TOOL,
  PLAN_TEMPLATE_VERSION,
  PROMPT_TEMPLATE_VERSION,
  buildMarketPayload,
  buildPlaybookBlock,
  buildSystemPrompt,
  computePromptHash,
} from './agent-prompt';
import { extractPlaybookKnobs, validatePlaybook, type PlaybookKnobs } from './playbook-validator';

const decisionSchema = z.object({
  action: z.enum(['long', 'flat', 'hold']),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(2000),
});

// B3 shorts capability: a parameterized sibling of decisionSchema (widened action enum only),
// selected in place of decisionSchema only when cfg.shortsEnabled is true — decisionSchema itself
// stays untouched (never a global widening) so flag-off validation is byte-identical to pre-B3.
const shortsDecisionSchema = z.object({
  action: z.enum(['long', 'short', 'flat', 'hold']),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(2000),
});

// W3.1 submit_plan payload: the decision fields plus a managed trade plan, REQUIRED when opening a
// long (schema-enforced — a plan-less 'long' is malformed, not a bare entry). Pct fields arrive as
// JSON numbers (fractions, bounded well inside double precision) and are converted to strings at
// the mapping boundary so all downstream math stays Decimal-on-strings. This zod schema is the
// REAL bounds gate: the wire tool schema cannot carry minimum/maximum (strict tool use 400s on
// them), so PLAN_TOOL states the ranges in prose and both sides render from PLAN_BOUNDS.
const planSchema = decisionSchema
  .extend({
    plan: z
      .object({
        entryOffsetBps: z
          .number()
          .int()
          .min(PLAN_BOUNDS.entryOffsetBps.min)
          .max(PLAN_BOUNDS.entryOffsetBps.max),
        stopLossPct: z.number().min(PLAN_BOUNDS.stopLossPct.min).max(PLAN_BOUNDS.stopLossPct.max),
        takeProfitPct: z
          .number()
          .min(PLAN_BOUNDS.takeProfitPct.min)
          .max(PLAN_BOUNDS.takeProfitPct.max),
        entryValidityBars: z
          .number()
          .int()
          .min(PLAN_BOUNDS.entryValidityBars.min)
          .max(PLAN_BOUNDS.entryValidityBars.max),
        maxHoldBars: z
          .number()
          .int()
          .min(PLAN_BOUNDS.maxHoldBars.min)
          .max(PLAN_BOUNDS.maxHoldBars.max),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === 'long' && v.plan === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "plan is required when action is 'long'",
      });
    }
  });

// Only the envelope fields this client reads — not a full Messages-API response model.
const anthropicResponseSchema = z.object({
  stop_reason: z.string().optional(),
  content: z
    .array(
      z.object({ type: z.string(), name: z.string().optional(), input: z.unknown().optional() }),
    )
    .optional(),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      // W2.4 cache experiment observability — absent on models/routes without caching.
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
    })
    .optional(),
});

export interface LoggerLike {
  warn(msg: string): void;
}

const NOOP_LOGGER: LoggerLike = { warn: () => undefined };

export interface AnthropicAgentClientConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxTokens: number;
  readonly signalTtlMs: number;
  readonly baseUrl?: string;
  // Venue/sizing facts folded into the system prompt (fees, sizing rule, venue minimums).
  // Optional so existing wiring that hasn't supplied one yet still compiles; falls back to
  // DEFAULT_TRADING_PROFILE below until the module-wiring task threads the strategy's real profile.
  readonly profile?: AgentTradingProfile;
  // Multi-symbol (P7): the venue constraints are the ONLY per-symbol profile field, so ONE shared
  // client resolves them per decide from the input's symbol; everything else on `profile`
  // (fees, sizing, backstop) is symbol-independent. Absent (or returning undefined for a symbol)
  // ⇒ the static profile's constraints — the exact pre-P7 behavior.
  readonly constraintsFor?: (symbol: string) => AgentTradingProfile['constraints'] | undefined;
  // W3.1 plan mode: send submit_plan (managed trade plans) instead of submit_decision. Absent/false
  // ⇒ byte-identical legacy behavior.
  readonly planMode?: boolean;
  // Fee-aware plan viability floor (decimal string; default '1.5') — see the mapping's edge check.
  readonly minEdgeMultiple?: string;
  // W3 payoff-floor multiple (decimal string; default '1.5') — see the mapping's stop-floor/RR check.
  readonly minRr?: string;
  // C1: documents the optional derivatives block in the system prompt (agent-prompt.ts's
  // buildSystemPrompt derivativesFeedEnabled option). Absent/false ⇒ byte-identical legacy prompt.
  readonly derivativesFeedEnabled?: boolean;
  // Derivatives-block A/B (measurement start 2026-07-12): percent (0-50) of decides deterministically
  // routed to a CONTROL arm that withholds the derivatives block entirely — system sentence,
  // promptHash's `+d1` tag, and the payload's derivatives key all withheld TOGETHER (see propose()'s
  // derivativesControlArm). Absent/0, or derivativesFeedEnabled false, ⇒ byte-identical to no A/B
  // (nothing to withhold when the feed is already off).
  readonly derivativesAbPct?: number;
  // C4: documents the optional sentiment block in the system prompt (agent-prompt.ts's
  // buildSystemPrompt sentimentFeedEnabled option). Absent/false ⇒ byte-identical legacy prompt.
  readonly sentimentFeedEnabled?: boolean;
  // B3 shorts capability: widens the decision tool/schema to accept 'short' and maps it to
  // ENTER_SHORT/EXIT_SHORT (see propose()'s mapping table). LEGACY decision path ONLY — mutually
  // exclusive with planMode (the plan schema is long-oriented; shorts-in-plan-mode belongs to the
  // carry sub-plan). Absent/false ⇒ byte-identical legacy behavior; combining both flags throws at
  // construction.
  readonly shortsEnabled?: boolean;
}

// Placeholder profile used only when no real AgentTradingProfile has been wired yet — keeps the
// system prompt's fee/sizing/minimums prose non-fictional-looking-but-clearly-illustrative rather
// than absent. A later task (module wiring) supplies the strategy's actual profile via cfg.profile.
const DEFAULT_TRADING_PROFILE: AgentTradingProfile = {
  makerBps: '10',
  takerBps: '10',
  baseNotional: '50',
  maxOrderNotional: '200',
  constraints: {
    tickSize: price('0.01'),
    lotStep: qty('0.0001'),
    minNotional: price('10'),
  },
};

// Exported so agentic.strategy.ts's decision-history ring truncates the model's own prior
// free-text rationale to the same bound before it re-enters a later prompt (see agent-prompt.ts's
// data-framing of recentDecisions) — one literal, never a second copy that could drift from it.
export const MAX_REASON_LEN = 200;

// W2.4 prompt-cache experiment: 1h TTL keeps the prefix warm across the 15m decide cadence (a 5m
// default TTL would expire between bars). Applied to the system prompt and the playbook block only
// — never the volatile market JSON.
const EPHEMERAL_1H = { type: 'ephemeral', ttl: '1h' } as const;
interface AnthropicTextBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cache_control?: typeof EPHEMERAL_1H;
}
const MIN_STRENGTH = 0.1;
const MAX_STRENGTH = 1;

// HTTP statuses that mean the request/credential itself is bad — retrying changes nothing.
const FATAL_STATUSES = new Set([400, 401, 403, 404, 422]);
// Explicitly transient statuses beyond the general 5xx range.
const RETRYABLE_STATUSES = new Set([408, 429]);

// A single in-call retry budget floor: below this much remaining wall-clock time in the caller's
// overall timeout, a retry can't plausibly complete, so we fail fast instead of guaranteeing a
// second abort.
const RETRY_BUDGET_FLOOR_MS = 2000;
const DEFAULT_RETRY_BACKOFF_MS = 500;

function classifyHttpStatus(status: number): 'RETRYABLE' | 'FATAL' {
  if (RETRYABLE_STATUSES.has(status) || status >= 500) return 'RETRYABLE';
  if (FATAL_STATUSES.has(status)) return 'FATAL';
  // Unmapped status: err toward caution rather than hammering an endpoint behaving unexpectedly.
  return 'FATAL';
}

// Retry-After per RFC 9110: either a delay in seconds, or an HTTP-date to wait until.
function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  // Retry-After is a wall-clock delay in seconds, not a money value.
  // eslint-disable-next-line no-restricted-syntax -- Number() is the correct non-money coercion here.
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Concrete AGENT_CLIENT adapter: calls the real Anthropic Messages API and maps its tool-use
// decision to a proposed AgentProposal. Stateless across decisions — the strategy owns the
// decision-history trail — but stateful across FAILURES: a FATAL classification latches this
// instance to degraded so a bad key/request can't be hammered at candle cadence. Risk still
// sizes/vetoes whatever signal is returned.
export class AnthropicAgentClient implements AgentClientPort {
  // Set once by a FATAL failure; every propose() call after that short-circuits with no HTTP call.
  private degraded = false;
  // Dedupes the "stored playbook failed validation" warn to once per distinct invalid content,
  // rather than once per candle-cadence propose() call while the same bad playbook sits stored.
  private lastInvalidPlaybookContent: string | null = null;

  constructor(
    private readonly cfg: AnthropicAgentClientConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly logger: LoggerLike = NOOP_LOGGER,
    private readonly playbookProvider?: PlaybookProvider,
  ) {
    // B3: fail fast at construction rather than silently picking one flag at decide() time — the
    // plan schema is long-oriented (entry offset/stop/TP all sized off a long fill) and
    // shorts-in-plan-mode is out of scope here (carry sub-plan's own design).
    if (cfg.shortsEnabled && cfg.planMode) {
      throw new Error(
        'AnthropicAgentClient: shortsEnabled and planMode are mutually exclusive (plan schema is long-oriented; shorts-in-plan-mode is out of scope)',
      );
    }
  }

  async propose(input: AgentDecisionInput): Promise<AgentProposal> {
    if (this.degraded) {
      return { signals: [] };
    }

    const symbol = input.trigger.event.symbol;
    const venue = input.trigger.event.venue;
    const ticker = input.snapshot.tickers.get(symbol);
    const candles = input.snapshot.candles.get(symbol) ?? [];
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;

    // basedOnSeq rides on whichever market-data point supplied refPrice, mirroring the pure
    // strategies' convention (their triggering candle supplied both). An 'exec' trigger carries no
    // seq of its own — ExecReport isn't part of the market-data envelope — so it falls back here too.
    let refPrice: Price;
    let basedOnSeq: bigint;
    if (ticker) {
      refPrice = ticker.last;
      basedOnSeq = ticker.seq;
    } else if (lastCandle) {
      refPrice = lastCandle.close;
      basedOnSeq = lastCandle.seq;
    } else {
      return { signals: [] };
    }

    // TTL anchor: a signal is actionable from the moment its basis bar CLOSED, not from the bar's
    // open. Normalized candles stamp eventTime = openTime (market-data/normalize.ts), while the signal
    // gateway rejects when wall-clock now > signal.eventTime + signalTtlMs (signal-gateway.service.ts).
    // With STRATEGY_INTERVAL > SIGNAL_TTL_MS (e.g. a 5m bar, 2m TTL) an open-time anchor makes every
    // candle-triggered signal born ~(interval − decide latency) past expiry, so it is rejected as
    // EXPIRED before it can reach Risk. Anchor to the triggering bar's closeTime (a deterministic
    // openTime + interval − 1) so the window starts at close; the intent's own expiresAt is already
    // wall-clock-based (position-sizer.service.ts), so both expiry checks then agree.
    const eventTime =
      input.trigger.kind === 'candle' ? input.trigger.event.closeTime : input.snapshot.eventTime;

    const { content: playbookContent, version: playbookVersion } = await this.resolvePlaybook();
    // Playbook knobs (tighten-only parametric channel — see playbook-validator.ts). Extracted from
    // the ALREADY-VALIDATED playbook content, so an out-of-bounds line can never reach here.
    const knobs: PlaybookKnobs | undefined = playbookContent
      ? extractPlaybookKnobs(playbookContent)
      : undefined;
    const baseProfile = this.cfg.profile ?? DEFAULT_TRADING_PROFILE;
    const constraints = this.cfg.constraintsFor?.(String(symbol)) ?? baseProfile.constraints;
    // Derivatives A/B control arm: a deterministic UTC-minute bucket, same shape as
    // PlaybookAbRoutingProvider's own routing (app.module.ts) — `floor(Date.now()/60_000) % 100 <
    // pct` — but offset by +37 before the modulo so this bucket's minute-boundary transitions never
    // land on the same minute as the playbook router's (the two A/B mechanisms stay decorrelated).
    // Only ever fires when the feed is actually on: with the feed off there is nothing to withhold,
    // so derivativesAbPct is a no-op and the pct=0 default stays byte-identical to pre-A/B behavior.
    const derivativesAbPct = this.cfg.derivativesAbPct ?? 0;
    const derivativesControlArm =
      (this.cfg.derivativesFeedEnabled ?? false) &&
      derivativesAbPct > 0 &&
      Math.floor(Date.now() / 60_000 + 37) % 100 < derivativesAbPct;
    // The invariant this whole mechanism exists to hold: system sentence, promptHash's `+d1` tag, and
    // the payload's derivatives key all move TOGETHER per arm — a single boolean gates all three below
    // rather than three independently-computed conditions that could drift apart.
    const effectiveDerivativesEnabled =
      (this.cfg.derivativesFeedEnabled ?? false) && !derivativesControlArm;
    if (derivativesControlArm) {
      // No recorder seam reaches this client (MetricsWrappingAgentClient wraps AgentClientPort at the
      // composition root, outside AnthropicAgentClientConfig) — one structured log line per
      // control-arm decide is the observability surface until/unless that seam is threaded through.
      this.logger.warn(
        `agentic derivatives ab: control arm — symbol=${symbol} pct=${derivativesAbPct}`,
      );
    }
    // v5: constraints no longer render into the system prompt (they ride the payload below), so the
    // cached tools+system prefix is byte-identical across all symbols this shared client serves.
    const systemPrompt = buildSystemPrompt(baseProfile, {
      ...(this.cfg.planMode
        ? {
            planMode: true,
            minEdgeMultiple: this.cfg.minEdgeMultiple ?? '1.5',
            minRr: this.cfg.minRr ?? '1.5',
          }
        : {}),
      derivativesFeedEnabled: effectiveDerivativesEnabled,
      sentimentFeedEnabled: this.cfg.sentimentFeedEnabled ?? false,
      shortsEnabled: this.cfg.shortsEnabled ?? false,
    });
    // Control arm: strip any derivatives snapshot the strategy attached (agentic.strategy.ts's
    // withDerivatives) before building the payload, so buildMarketPayload's own
    // input.snapshot.derivatives gate (agent-prompt.ts) omits the block — the same
    // "input.snapshot-derived derivatives absent ⇒ no key" path a feed-off/stale-poll deployment
    // already takes, reused rather than duplicated. Every other use of `input` in this method
    // (signals, eventTime, refPrice, ...) stays on the ORIGINAL input — only payload construction
    // sees the stripped copy.
    const payloadInput = derivativesControlArm
      ? { ...input, snapshot: { ...input.snapshot, derivatives: undefined } }
      : input;
    // inputPayload is the market JSON ALONE — buildMarketPayload's signature carries no
    // playbookContent parameter, so it structurally cannot echo playbook text (see its own comment).
    // W2.4 cache experiment: the playbook block (the only sizeable stable prefix) rides in its own
    // cache_control content block while the volatile market JSON follows uncached; block 2 carries
    // the '\n\n' separator, so the concatenated model-visible text stays byte-identical to
    // buildUserMessage's single-string form (see buildPlaybookBlock's comment). Falsifiable:
    // Sonnet-5's minimum cacheable prefix is unpublished — if usage.cache_read_input_tokens stays 0
    // in production the blocks revert (config-free, cheap to remove).
    const inputPayload = buildMarketPayload(payloadInput, { constraints });
    const userContent: string | AnthropicTextBlock[] = playbookContent
      ? [
          {
            type: 'text',
            text: buildPlaybookBlock(playbookContent),
            cache_control: EPHEMERAL_1H,
          },
          { type: 'text', text: `\n\n${inputPayload}` },
        ]
      : inputPayload;
    // B3: shortsEnabled selects SHORTS_DECISION_TOOL in place of DECISION_TOOL (never alongside
    // planMode — enforced at construction). This is the tool actually SENT to the API (see
    // attemptOnce below, which now takes `activeTool` rather than re-deriving it) — a client that
    // computed the hash/schema from the wide tool but sent the narrow one would silently make the
    // capability unreachable.
    const activeTool = this.cfg.planMode
      ? PLAN_TOOL
      : this.cfg.shortsEnabled
        ? SHORTS_DECISION_TOOL
        : DECISION_TOOL;
    const baseTemplateVersion = this.cfg.planMode ? PLAN_TEMPLATE_VERSION : PROMPT_TEMPLATE_VERSION;
    // Flag-ON appends the corresponding system-prompt sentence, so it is a distinct template for
    // attribution purposes (mirrors plan mode's own tag); flag-OFF hashes are byte-identical. All
    // flags stack in a fixed order (`+d1+s1+x1`) so a multi-flag hash is deterministic regardless of
    // which flag flipped first.
    const feedTags = [
      ...(effectiveDerivativesEnabled ? [DERIVATIVES_TEMPLATE_VERSION] : []),
      ...(this.cfg.sentimentFeedEnabled ? [SENTIMENT_TEMPLATE_VERSION] : []),
      ...(this.cfg.shortsEnabled ? [SHORTS_TEMPLATE_VERSION] : []),
    ];
    const promptHash = computePromptHash({
      templateVersion:
        feedTags.length > 0 ? `${baseTemplateVersion}+${feedTags.join('+')}` : baseTemplateVersion,
      playbookContent: playbookContent ?? '',
      toolSchemaJson: JSON.stringify(activeTool),
      modelId: this.cfg.model,
    });

    const deadline = Date.now() + this.cfg.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    const started = Date.now();
    let res: Response;
    try {
      try {
        res = await this.attemptOnce(systemPrompt, userContent, activeTool, controller.signal);
      } catch (firstErr) {
        const classified = firstErr as AgentProposeError;
        const remainingMs = deadline - Date.now();
        if (classified.kind === 'FATAL' || remainingMs < RETRY_BUDGET_FLOOR_MS) {
          this.handleFailure(classified);
          throw classified;
        }
        const backoffMs = Math.min(
          classified.retryAfterMs ?? DEFAULT_RETRY_BACKOFF_MS,
          remainingMs,
        );
        await delay(backoffMs);
        try {
          res = await this.attemptOnce(systemPrompt, userContent, activeTool, controller.signal);
        } catch (secondErr) {
          const secondClassified = secondErr as AgentProposeError;
          this.handleFailure(secondClassified);
          throw secondClassified;
        }
      }
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - started;
    const body: unknown = await res.json();
    const envelope = anthropicResponseSchema.safeParse(body);
    if (!envelope.success) {
      this.logger.warn('anthropic api: malformed response envelope');
      return { signals: [], latencyMs, playbookVersion, promptHash, inputPayload };
    }
    const usage = envelope.data.usage
      ? {
          inputTokens: envelope.data.usage.input_tokens,
          outputTokens: envelope.data.usage.output_tokens,
          cacheCreationInputTokens: envelope.data.usage.cache_creation_input_tokens,
          cacheReadInputTokens: envelope.data.usage.cache_read_input_tokens,
        }
      : undefined;

    if (envelope.data.stop_reason === 'refusal') {
      this.logger.warn('anthropic api: model refused to decide');
      return { signals: [], usage, latencyMs, playbookVersion, promptHash, inputPayload };
    }
    const toolName = activeTool.name;
    const toolBlock = envelope.data.content?.find(
      (b) => b.type === 'tool_use' && b.name === toolName,
    );
    if (!toolBlock) {
      this.logger.warn(`anthropic api: no ${toolName} tool_use block in response`);
      return { signals: [], usage, latencyMs, playbookVersion, promptHash, inputPayload };
    }
    const parsedDecision = this.cfg.planMode
      ? planSchema.safeParse(toolBlock.input)
      : this.cfg.shortsEnabled
        ? shortsDecisionSchema.safeParse(toolBlock.input)
        : decisionSchema.safeParse(toolBlock.input);
    if (!parsedDecision.success) {
      this.logger.warn(`anthropic api: ${toolName} payload failed schema validation`);
      return { signals: [], usage, latencyMs, playbookVersion, promptHash, inputPayload };
    }

    // B3: widened to 'LONG' | 'SHORT' | 'FLAT' locally via `as` (a type-level upcast only — the
    // runtime value is still ever only 'LONG'/'FLAT') so the mapping table below can compare against
    // 'SHORT'. A type ANNOTATION here (`const side: 'LONG'|'SHORT'|'FLAT' = ...`) does NOT achieve
    // this: TS's control-flow narrowing tracks the initializer expression's own inferred type
    // ('LONG'|'FLAT') for subsequent `===` comparisons regardless of the wider declared annotation,
    // so every `side === 'SHORT'` check below would still 2367 as a no-overlap comparison — only an
    // explicit `as` cast on the initializer resets the flow-narrowed type to the wider union.
    // AgentPositionSummary.side itself stays 'LONG' | 'FLAT' at the port level (see agent-prompt.ts's
    // buildMarketPayload comment for why); no strategy instance can populate 'SHORT' today, so every
    // SHORT-side arm below is presently unreachable dead code, kept only for forward compatibility
    // and gated by shortsEnabled.
    const side = (input.context?.position.side ?? 'FLAT') as 'LONG' | 'SHORT' | 'FLAT';
    const { action, confidence, rationale } = parsedDecision.data;
    // Explicitly re-typed: the decision/plan schema union erases `plan` under `in`-narrowing.
    const rawPlan: z.infer<typeof planSchema>['plan'] = this.cfg.planMode
      ? (parsedDecision.data as z.infer<typeof planSchema>).plan
      : undefined;
    const common = {
      strategyId: input.strategyId,
      venue,
      symbol,
      refPrice,
      basedOnSeq,
      eventTime,
      ttlMs: this.cfg.signalTtlMs,
      dedupeKey: `${input.strategyId}:${symbol}:agentic:${action}:${eventTime}`,
      reason: rationale.slice(0, MAX_REASON_LEN),
    };

    // W3.1 fee-aware plan viability floor: a plan whose take-profit cannot clear
    // minEdgeMultiple × the round-trip fee fraction is rejected outright — journal-visible via the
    // prefixed rationale, no signals, no plan (the strategy treats it as a hold).
    // W3 payoff-floor gates (same rejection shape): a stop below the round-trip fee fraction
    // guarantees a loss on the stop-out alone, and a takeProfitPct/stopLossPct ratio below
    // AGENTIC_MIN_RR lets a plan lose money even at a winning-trade rate above 50% — both are
    // rejected before the plan ever reaches the market.
    // The same floors bind a RE-ARM plan (hold/long while already LONG — accepted in the final
    // mapping arm below): a plan that would be rejected as a fresh entry must not reach the
    // executor by arriving on a 'hold' instead.
    const opensNewLong = action === 'long' && side === 'FLAT';
    const rearmsOpenLong = side === 'LONG' && (action === 'hold' || action === 'long');

    // Playbook-knob confidence floor (tighten-only channel): a NEW entry whose stated confidence
    // sits below the playbook's minConfidence knob is downgraded to a journal-visible hold — the
    // same rejection shape as the plan gate below. Scope is deliberately NEW ENTRIES ONLY: exits
    // are never blocked (never trap a position behind a knob) and re-arms are never blocked (a
    // knob must not strand an open position bare — the Pass-20 restart class).
    const entersNewPosition = side === 'FLAT' && (action === 'long' || action === 'short');
    if (knobs?.minConfidence !== undefined && entersNewPosition) {
      const confidenceFloor = new Decimal(knobs.minConfidence);
      if (new Decimal(String(confidence)).lt(confidenceFloor)) {
        this.logger.warn(
          `knob gate: entry confidence ${confidence} below playbook minConfidence ${knobs.minConfidence} — downgrading to hold`,
        );
        return {
          signals: [],
          decision: {
            action: action as 'long' | 'flat' | 'hold',
            confidence,
            rationale: `[knob gate: confidence below playbook floor ${knobs.minConfidence}] ${rationale}`,
          },
          usage,
          latencyMs,
          playbookVersion,
          promptHash,
          inputPayload,
        };
      }
    }

    if (this.cfg.planMode && rawPlan && (opensNewLong || rearmsOpenLong)) {
      const feeFraction = new Decimal(baseProfile.makerBps).plus(baseProfile.takerBps).div(10_000);
      // Knob floors raise (never lower) the configured floors, and bind on FRESH entries only —
      // a re-arm keeps the config floors so re-attaching management to an existing position never
      // gets harder mid-flight (see the confidence-gate comment above for the rationale).
      const configMinEdgeMultiple = new Decimal(this.cfg.minEdgeMultiple ?? '1.5');
      const configMinRr = new Decimal(this.cfg.minRr ?? '1.5');
      const knobMinEdgeMultiple =
        opensNewLong && knobs?.minEdgeMultiple !== undefined
          ? new Decimal(knobs.minEdgeMultiple)
          : undefined;
      const knobMinRr =
        opensNewLong && knobs?.minRr !== undefined ? new Decimal(knobs.minRr) : undefined;
      const effectiveMinEdgeMultiple =
        knobMinEdgeMultiple !== undefined && knobMinEdgeMultiple.gt(configMinEdgeMultiple)
          ? knobMinEdgeMultiple
          : configMinEdgeMultiple;
      const edgeFloor = effectiveMinEdgeMultiple.mul(feeFraction);
      const minRr = knobMinRr !== undefined && knobMinRr.gt(configMinRr) ? knobMinRr : configMinRr;
      const stopLossPct = new Decimal(String(rawPlan.stopLossPct));
      const takeProfitPct = new Decimal(String(rawPlan.takeProfitPct));
      let rejectionWarn: string | undefined;
      let rejectionTag: string | undefined;
      if (takeProfitPct.lt(edgeFloor)) {
        rejectionWarn = `plan rejected: takeProfitPct ${rawPlan.takeProfitPct} below edge floor ${edgeFloor.toFixed()}`;
        rejectionTag = 'edge below floor';
      } else if (stopLossPct.lt(feeFraction)) {
        rejectionWarn = `plan rejected: stopLossPct ${rawPlan.stopLossPct} below round-trip fee ${feeFraction.toFixed()}`;
        rejectionTag = 'stop below fee floor';
      } else if (takeProfitPct.div(stopLossPct).lt(minRr)) {
        rejectionWarn = `plan rejected: takeProfitPct/stopLossPct ${takeProfitPct.div(stopLossPct).toFixed()} below AGENTIC_MIN_RR ${minRr.toFixed()}`;
        rejectionTag = 'RR below floor';
      }
      if (rejectionWarn && rejectionTag) {
        this.logger.warn(rejectionWarn);
        return {
          signals: [],
          decision: {
            // planMode and shortsEnabled are mutually exclusive (constructor guard) — action can
            // never actually be 'short' on this path, but see the cast comment on the final return
            // below for why a cast (not a port widening) is used regardless.
            action: action as 'long' | 'flat' | 'hold',
            confidence,
            rationale: `[plan rejected: ${rejectionTag}] ${rationale}`,
          },
          usage,
          latencyMs,
          playbookVersion,
          promptHash,
          inputPayload,
        };
      }
    }

    let signals: Signal[];
    let acceptedPlan: AgentPlan | undefined;
    if (action === 'long' && side === 'FLAT') {
      // Plan mode: the plan's own entry offset prices the resting entry (positive bps = below the
      // last close) and supersedes the book-touch hint; legacy mode keeps the bestBid hint.
      let limitPriceHint: Price | undefined;
      if (this.cfg.planMode && rawPlan && lastCandle) {
        const offsetHint = new Decimal(lastCandle.close.toFixed())
          .mul(new Decimal(1).minus(new Decimal(rawPlan.entryOffsetBps).div(10_000)))
          .toDecimalPlaces(8);
        limitPriceHint = price(offsetHint.toFixed());
        acceptedPlan = {
          entryOffsetBps: rawPlan.entryOffsetBps,
          stopLossPct: String(rawPlan.stopLossPct),
          takeProfitPct: String(rawPlan.takeProfitPct),
          entryValidityBars: rawPlan.entryValidityBars,
          maxHoldBars: rawPlan.maxHoldBars,
        };
      } else {
        limitPriceHint = this.bookEntryHint(input.snapshot.books.get(symbol), refPrice);
      }
      signals = [
        {
          ...common,
          kind: 'ENTER_LONG',
          strength: Math.min(MAX_STRENGTH, Math.max(MIN_STRENGTH, confidence)),
          // Omitted entirely (no key) rather than undefined when no book/no near-touch bid — see
          // bookEntryHint's own comment.
          ...(limitPriceHint ? { limitPriceHint } : {}),
        },
      ];
    } else if (action === 'flat' && side === 'LONG') {
      signals = [{ ...common, kind: 'EXIT_LONG', strength: MAX_STRENGTH }];
    } else if (this.cfg.shortsEnabled && action === 'short' && side === 'FLAT') {
      // No book-aware limitPriceHint here: bookEntryHint (below) is long-specific — a resting BID
      // near refPrice is a cheaper LONG entry, but the equivalent cheaper SHORT entry would be a
      // resting ASK, the opposite side of the book. Reusing bookEntryHint would price a short entry
      // on the wrong side, so a short entry always uses the plain refPrice-based sizing path.
      signals = [
        {
          ...common,
          kind: 'ENTER_SHORT',
          strength: Math.min(MAX_STRENGTH, Math.max(MIN_STRENGTH, confidence)),
        },
      ];
    } else if (this.cfg.shortsEnabled && action === 'flat' && side === 'SHORT') {
      signals = [{ ...common, kind: 'EXIT_SHORT', strength: MAX_STRENGTH }];
    } else if (this.cfg.shortsEnabled && action === 'long' && side === 'SHORT') {
      // Close the short first — never a same-bar flip straight to ENTER_LONG. The model re-decides
      // next bar once flat, the same close-then-reenter discipline as every other direction change.
      signals = [{ ...common, kind: 'EXIT_SHORT', strength: MAX_STRENGTH }];
    } else if (this.cfg.shortsEnabled && action === 'short' && side === 'LONG') {
      // Symmetric to the arm above: close the long first, never a same-bar flip to ENTER_SHORT.
      signals = [{ ...common, kind: 'EXIT_LONG', strength: MAX_STRENGTH }];
    } else {
      // 'hold'; 'long' while already LONG; 'flat' while already FLAT; 'short' while already SHORT
      // (shortsEnabled only — side can never actually be 'SHORT' today, see the `side` comment
      // above) — all no-ops. A flag-off 'short' action can't even reach here: decisionSchema/
      // DECISION_TOOL never accept 'short' as a valid action in the first place.
      signals = [];
      // W3.1 re-arm: a floors-passing plan on hold/long while LONG emits no signal — it only
      // re-attaches deterministic management to the existing position (restart self-heal; the
      // strategy arms it and the first managed bar anchors stop/TP to the real avgEntry). FLAT
      // holds never arm: a plan with no position and no resting entry would only tick down to
      // plan_expired noise.
      if (this.cfg.planMode && rawPlan && rearmsOpenLong) {
        acceptedPlan = {
          entryOffsetBps: rawPlan.entryOffsetBps,
          stopLossPct: String(rawPlan.stopLossPct),
          takeProfitPct: String(rawPlan.takeProfitPct),
          entryValidityBars: rawPlan.entryValidityBars,
          maxHoldBars: rawPlan.maxHoldBars,
        };
      }
    }

    return {
      signals,
      // AgentDecisionMeta.action stays 'long' | 'flat' | 'hold' at the port level (see its own
      // comment) — widening it ripples into agentic.strategy.ts's decision-history ring, the
      // persisted agent_decisions journal, and counterfactual-scoring.ts's calibration module,
      // none of which is this flag-gated, presently-unconsumed capability's call to make. `action`'s
      // real runtime value IS 'short' when shortsEnabled fires (asserted directly in tests); this
      // cast only narrows the TYPE at the port boundary. Removing this cast is the breadcrumb for
      // whichever future change (the carry sub-plan) wires shortsEnabled live and must then decide
      // those three widenings deliberately — and add a fail-loud runtime guard at the persistence
      // boundary until they land (INT-B3 reviewer + security-auditor requirement).
      decision: { action: action as 'long' | 'flat' | 'hold', confidence, rationale },
      ...(acceptedPlan ? { plan: acceptedPlan } : {}),
      usage,
      latencyMs,
      playbookVersion,
      promptHash,
      inputPayload,
    };
  }

  // Best-bid entry hint: a resting bid within 25bps below refPrice is a cheaper (maker) entry than
  // crossing at refPrice, close enough that waiting for it is unlikely to miss the move. A bid AT or
  // ABOVE refPrice, one further than 25bps below it, or no book at all all resolve to undefined —
  // Risk/PositionSizer then fall back to their existing refPrice-based behavior unchanged.
  private bookEntryHint(
    book: OrderBookSnapshotEvent | undefined,
    refPrice: Price,
  ): Price | undefined {
    const bestBid = book?.bids[0]?.price;
    if (!bestBid || bestBid.gt(refPrice)) return undefined;
    const maxDiscount = refPrice.mul('0.0025');
    return refPrice.sub(bestBid).lte(maxDiscount) ? bestBid : undefined;
  }

  // Fetches the current playbook (if a provider is wired) and structurally validates it — an
  // invalid stored playbook is treated as absent (never composed into the prompt) rather than
  // failing the decide() call outright; the tripwire warn is deduped per distinct invalid content.
  private async resolvePlaybook(): Promise<{
    readonly content: string | undefined;
    readonly version: number | undefined;
  }> {
    if (!this.playbookProvider) {
      return { content: undefined, version: undefined };
    }
    const stored = await this.playbookProvider.current();
    const validation = validatePlaybook(stored.content);
    if (!validation.ok) {
      if (this.lastInvalidPlaybookContent !== stored.content) {
        this.logger.warn(
          `agentic playbook: stored playbook (version ${stored.version}) failed validation (${validation.reason}) — treating as absent`,
        );
        this.lastInvalidPlaybookContent = stored.content;
      }
      return { content: undefined, version: undefined };
    }
    return { content: stored.content, version: stored.version };
  }

  // On a FATAL classification, log once (status code only — never the key, never the response
  // body) and latch this instance to degraded. RETRYABLE failures never latch.
  private handleFailure(err: AgentProposeError): void {
    if (err.kind === 'FATAL') {
      this.logger.warn(
        `anthropic api: fatal error (status ${err.status ?? 'n/a'}) — latching agent client to degraded, no further calls will be made`,
      );
      this.degraded = true;
    }
  }

  // One HTTP attempt: builds the request, classifies any failure (transport or non-ok status) into
  // an AgentProposeError, and returns the ok Response otherwise. Never called once degraded. The
  // system/user prompt strings are built once by the caller (not per-attempt) so a retry resends
  // the identical prompt rather than silently re-deriving it.
  private async attemptOnce(
    systemPrompt: string,
    userContent: string | AnthropicTextBlock[],
    tool: typeof DECISION_TOOL | typeof SHORTS_DECISION_TOOL | typeof PLAN_TOOL,
    signal: AbortSignal,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.cfg.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': this.cfg.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.cfg.model,
          max_tokens: this.cfg.maxTokens,
          // W2.4: system as a cache_control block — with the tool schema it forms the stable
          // request prefix; the playbook block (when present) extends it via userContent's own
          // cache_control block. Cache reads are observed via usage.cache_read_input_tokens.
          system: [{ type: 'text', text: systemPrompt, cache_control: EPHEMERAL_1H }],
          messages: [{ role: 'user', content: userContent }],
          // B3: `tool` is the caller's precomputed `activeTool` (DECISION_TOOL / SHORTS_DECISION_TOOL
          // / PLAN_TOOL) — previously re-derived here from cfg.planMode alone, which would have sent
          // the narrow DECISION_TOOL even when shortsEnabled was on, making 'short' unreachable.
          tools: [tool],
          tool_choice: { type: 'tool', name: tool.name },
          // Omitting `thinking` on claude-sonnet-5 silently runs (billed) adaptive thinking; the
          // decide call has no use for it (structured tool-use, not open-ended reasoning), so it's
          // explicitly disabled here. Reflection has its own separate request builder (see
          // reflection.service.ts) and is unaffected by this.
          thinking: { type: 'disabled' },
        }),
        signal,
      });
    } catch (err) {
      // Fetch rejection (network error) or AbortError (wall-clock timeout) — both transport-level
      // and both transient.
      throw new AgentProposeError(
        `anthropic api transport error: ${err instanceof Error ? err.message : String(err)}`,
        'RETRYABLE',
      );
    }

    if (!res.ok) {
      const retryAfterMs = parseRetryAfterMs(res.headers?.get?.('retry-after'));
      throw new AgentProposeError(
        `anthropic api http ${res.status}`,
        classifyHttpStatus(res.status),
        res.status,
        retryAfterMs,
      );
    }
    return res;
  }
}
