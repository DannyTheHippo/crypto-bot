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
  PLAN_BOUNDS,
  PLAN_TOOL,
  PLAN_TEMPLATE_VERSION,
  PROMPT_TEMPLATE_VERSION,
  buildMarketPayload,
  buildPlaybookBlock,
  buildSystemPrompt,
  computePromptHash,
} from './agent-prompt';
import { validatePlaybook } from './playbook-validator';

const decisionSchema = z.object({
  action: z.enum(['long', 'flat', 'hold']),
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
  ) {}

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
    const baseProfile = this.cfg.profile ?? DEFAULT_TRADING_PROFILE;
    const constraints = this.cfg.constraintsFor?.(String(symbol)) ?? baseProfile.constraints;
    const systemPrompt = buildSystemPrompt(
      { ...baseProfile, constraints },
      {
        ...(this.cfg.planMode
          ? {
              planMode: true,
              minEdgeMultiple: this.cfg.minEdgeMultiple ?? '1.5',
              minRr: this.cfg.minRr ?? '1.5',
            }
          : {}),
        derivativesFeedEnabled: this.cfg.derivativesFeedEnabled ?? false,
      },
    );
    // inputPayload is the market JSON ALONE — buildMarketPayload's signature carries no
    // playbookContent parameter, so it structurally cannot echo playbook text (see its own comment).
    // W2.4 cache experiment: the playbook block (the only sizeable stable prefix) rides in its own
    // cache_control content block while the volatile market JSON follows uncached; block 2 carries
    // the '\n\n' separator, so the concatenated model-visible text stays byte-identical to
    // buildUserMessage's single-string form (see buildPlaybookBlock's comment). Falsifiable:
    // Sonnet-5's minimum cacheable prefix is unpublished — if usage.cache_read_input_tokens stays 0
    // in production the blocks revert (config-free, cheap to remove).
    const inputPayload = buildMarketPayload(input);
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
    const activeTool = this.cfg.planMode ? PLAN_TOOL : DECISION_TOOL;
    const baseTemplateVersion = this.cfg.planMode ? PLAN_TEMPLATE_VERSION : PROMPT_TEMPLATE_VERSION;
    const promptHash = computePromptHash({
      // Flag-ON appends the derivatives system-prompt sentence, so it is a distinct template for
      // attribution purposes (mirrors plan mode's own tag); flag-OFF hashes are byte-identical.
      templateVersion: this.cfg.derivativesFeedEnabled
        ? `${baseTemplateVersion}+${DERIVATIVES_TEMPLATE_VERSION}`
        : baseTemplateVersion,
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
        res = await this.attemptOnce(systemPrompt, userContent, controller.signal);
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
          res = await this.attemptOnce(systemPrompt, userContent, controller.signal);
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
    const toolName = this.cfg.planMode ? PLAN_TOOL.name : DECISION_TOOL.name;
    const toolBlock = envelope.data.content?.find(
      (b) => b.type === 'tool_use' && b.name === toolName,
    );
    if (!toolBlock) {
      this.logger.warn(`anthropic api: no ${toolName} tool_use block in response`);
      return { signals: [], usage, latencyMs, playbookVersion, promptHash, inputPayload };
    }
    const parsedDecision = this.cfg.planMode
      ? planSchema.safeParse(toolBlock.input)
      : decisionSchema.safeParse(toolBlock.input);
    if (!parsedDecision.success) {
      this.logger.warn(`anthropic api: ${toolName} payload failed schema validation`);
      return { signals: [], usage, latencyMs, playbookVersion, promptHash, inputPayload };
    }

    const side = input.context?.position.side ?? 'FLAT';
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
    if (this.cfg.planMode && action === 'long' && side === 'FLAT' && rawPlan) {
      const feeFraction = new Decimal(baseProfile.makerBps).plus(baseProfile.takerBps).div(10_000);
      const edgeFloor = new Decimal(this.cfg.minEdgeMultiple ?? '1.5').mul(feeFraction);
      const minRr = new Decimal(this.cfg.minRr ?? '1.5');
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
            action,
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
    } else {
      // 'hold', or 'long' while already LONG, or 'flat' while already FLAT — shorts deliberately
      // unmapped (spot long/flat v1).
      signals = [];
    }

    return {
      signals,
      decision: { action, confidence, rationale },
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
          tools: [this.cfg.planMode ? PLAN_TOOL : DECISION_TOOL],
          tool_choice: {
            type: 'tool',
            name: this.cfg.planMode ? PLAN_TOOL.name : DECISION_TOOL.name,
          },
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
