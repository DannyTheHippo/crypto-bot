import { z } from 'zod';
import { price, qty, type Price } from '../../../domain/types/money';
import type { OrderBookSnapshotEvent } from '../../../domain/types/market-events';
import type { Signal } from '../../../domain/types/signal';
import {
  AgentProposeError,
  type AgentClientPort,
  type AgentDecisionInput,
  type AgentProposal,
  type AgentTradingProfile,
  type PlaybookProvider,
} from '../../../ports/agentic-strategy';
import {
  DECISION_TOOL,
  PROMPT_TEMPLATE_VERSION,
  buildSystemPrompt,
  buildUserMessage,
  computePromptHash,
} from './agent-prompt';
import { validatePlaybook } from './playbook-validator';

const decisionSchema = z.object({
  action: z.enum(['long', 'flat', 'hold']),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(2000),
});

// Only the envelope fields this client reads — not a full Messages-API response model.
const anthropicResponseSchema = z.object({
  stop_reason: z.string().optional(),
  content: z
    .array(
      z.object({ type: z.string(), name: z.string().optional(), input: z.unknown().optional() }),
    )
    .optional(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
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
    const systemPrompt = buildSystemPrompt({ ...baseProfile, constraints });
    const userMessage = buildUserMessage(input, playbookContent ? { playbookContent } : {});
    const promptHash = computePromptHash({
      templateVersion: PROMPT_TEMPLATE_VERSION,
      playbookContent: playbookContent ?? '',
      toolSchemaJson: JSON.stringify(DECISION_TOOL),
      modelId: this.cfg.model,
    });

    const deadline = Date.now() + this.cfg.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    const started = Date.now();
    let res: Response;
    try {
      try {
        res = await this.attemptOnce(systemPrompt, userMessage, controller.signal);
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
          res = await this.attemptOnce(systemPrompt, userMessage, controller.signal);
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
      return { signals: [], latencyMs, playbookVersion, promptHash };
    }
    const usage = envelope.data.usage
      ? {
          inputTokens: envelope.data.usage.input_tokens,
          outputTokens: envelope.data.usage.output_tokens,
        }
      : undefined;

    if (envelope.data.stop_reason === 'refusal') {
      this.logger.warn('anthropic api: model refused to decide');
      return { signals: [], usage, latencyMs, playbookVersion, promptHash };
    }
    const toolBlock = envelope.data.content?.find(
      (b) => b.type === 'tool_use' && b.name === 'submit_decision',
    );
    if (!toolBlock) {
      this.logger.warn('anthropic api: no submit_decision tool_use block in response');
      return { signals: [], usage, latencyMs, playbookVersion, promptHash };
    }
    const parsedDecision = decisionSchema.safeParse(toolBlock.input);
    if (!parsedDecision.success) {
      this.logger.warn('anthropic api: submit_decision payload failed schema validation');
      return { signals: [], usage, latencyMs, playbookVersion, promptHash };
    }

    const side = input.context?.position.side ?? 'FLAT';
    const { action, confidence, rationale } = parsedDecision.data;
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

    let signals: Signal[];
    if (action === 'long' && side === 'FLAT') {
      const limitPriceHint = this.bookEntryHint(input.snapshot.books.get(symbol), refPrice);
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
      usage,
      latencyMs,
      playbookVersion,
      promptHash,
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
    userMessage: string,
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
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
          tools: [DECISION_TOOL],
          tool_choice: { type: 'tool', name: 'submit_decision' },
          // Omitting `thinking` on claude-sonnet-5 silently runs (billed) adaptive thinking; the
          // decide call has no use for it (structured tool-use, not open-ended reasoning), so it's
          // explicitly disabled here. Reflection has its own separate request builder (see
          // reflection.service.ts) and is unaffected by this.
          thinking: { type: 'disabled' },
          // Deliberately no cache_control: below the ~4096-token cacheable minimum on opus this is a
          // silent no-op — revisit once the prompt (playbook + candle history) grows past it.
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
