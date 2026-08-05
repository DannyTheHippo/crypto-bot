import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { price, qty, type Price } from '../../../domain/common/types/money';
import type { CandleEvent } from '../../../domain/venue/types/market-events';
import type { EpochMs, SymbolId, VenueId } from '../../../domain/common/types/ids';
import type { Signal } from '../../../domain/strategy/types/signal';
import { venueForSymbol, PERP_VENUE_ID } from '../../../domain/venue/types/venue-map';
import { roundTripFeeFraction, type VenueFeeSchedule } from '../../../domain/trading/fees';
import {
  AgentProposeError,
  type AgentBudgetBlock,
  type AgentCalendarEvent,
  type AgentClientPort,
  type AgentDecisionInput,
  type AgentDecisionMeta,
  type AgentDirectives,
  type AgentPortfolioBlock,
  type AgentProposal,
  type AgentTradingProfile,
  type AgentUsage,
  type PlaybookProvider,
  type RegimeTags,
  type SimilarSetupRow,
} from '../../../ports/strategy/agentic-strategy';
import { deriveRegimeTags, renderSimilarSetups } from './episodic-memory';
import {
  BOOK_STRUCTURE_TEMPLATE_VERSION,
  CROSS_SYMBOL_TEMPLATE_VERSION,
  DECISION_V2_BOUNDS,
  DERIVATIVES_TEMPLATE_VERSION,
  DERIVATIVES_V2_TEMPLATE_VERSION,
  FUNDING_HISTORY_TEMPLATE_VERSION,
  LIQUIDATION_TEMPLATE_VERSION,
  TRACK_RECORD_TEMPLATE_VERSION,
  EDGE_POLICY_TEMPLATE_VERSION,
  POSITIONING_TEMPLATE_VERSION,
  SENTIMENT_TEMPLATE_VERSION,
  FEAR_GREED_TEMPLATE_VERSION,
  TRADEFLOW_TEMPLATE_VERSION,
  THINKING_TEMPLATE_VERSION,
  MEMORY_TEMPLATE_VERSION,
  TRADE_TEMPLATE_VERSION,
  OUTPUT_EFFORT_TEMPLATE_PREFIX,
  MAX_TOKENS_TEMPLATE_PREFIX,
  PROMPT_HASH_BASELINE_MAX_TOKENS,
  type SymbolCapabilities,
  type BuildMarketPayloadExtras,
  buildMarketPayload,
  buildPlaybookBlock,
  buildSharedPayload,
  buildSystemPrompt,
  buildTradeTool,
  buildTradePortfolioTool,
  computePromptHash,
} from './agent-prompt';
import { validatePlaybook } from './playbook-validator';

// v3 consolidation spec §9: the legacy submit_decision/submit_plan zod schemas (decisionSchema,
// shortsDecisionSchema, planFieldSchema/planSchema/planShortsSchema, decisionElementSchema/
// shortsDecisionElementSchema/planElementSchema/planShortsElementSchema, portfolioDecisionsSchema)
// are DELETED — the client serves the unified submit_trade/submit_portfolio contract only.
// Lenient symbol-only extraction so a decisions[] element that otherwise fails full validation can
// still be attributed to (and thus warned/held against) the right requested symbol.
const elementSymbolSchema = z.object({ symbol: z.string().min(1) });

// S3 (rich decision contract, Design § New tool contract): v2 submit_trade/submit_portfolio zod
// schemas, mirroring DECISION_V2_BOUNDS (agent-prompt.ts — single source for the numeric ranges; see
// that const's own comment on why the strict-tool-use JSON schema can't carry them itself). Every
// wire field arrives as a plain JSON number (the tool's input_schema types them 'number'/'integer') —
// conversion to the money-safe Decimal-on-string AgentDirectives shape happens at the mapping
// boundary, not here. sizeFractionMax is injected as a plain number (this SYMBOL's own
// capabilities.maxSizeFraction, §4.1/§4.2) rather than hardcoded — the SAME per-call
// parameterization agent-prompt.ts's buildTradeTool/buildTradePortfolioTool use for the tool
// description (one cap, never two hand-maintained copies).
function tradeDirectiveFieldShape(sizeFractionMax: number) {
  return {
    sizeFraction: z
      .number()
      .min(DECISION_V2_BOUNDS.sizeFraction.min)
      .max(sizeFractionMax)
      .optional(),
    entry: z
      .object({
        style: z.enum(['maker', 'taker']),
        offsetBps: z
          .number()
          .int()
          .min(DECISION_V2_BOUNDS.entryOffsetBps.min)
          .max(DECISION_V2_BOUNDS.entryOffsetBps.max),
      })
      .optional(),
    entryValidityBars: z
      .number()
      .int()
      .min(DECISION_V2_BOUNDS.entryValidityBars.min)
      .max(DECISION_V2_BOUNDS.entryValidityBars.max)
      .optional(),
    stopLossPct: z
      .number()
      .min(DECISION_V2_BOUNDS.stopLossPct.min)
      .max(DECISION_V2_BOUNDS.stopLossPct.max)
      .optional(),
    takeProfitPct: z
      .number()
      .min(DECISION_V2_BOUNDS.takeProfitPct.min)
      .max(DECISION_V2_BOUNDS.takeProfitPct.max)
      .optional(),
    maxHoldBars: z
      .number()
      .int()
      .min(DECISION_V2_BOUNDS.maxHoldBars.min)
      .max(DECISION_V2_BOUNDS.maxHoldBars.max)
      .optional(),
    // 'adjust' only — see requireTradeDirectives' own gate below.
    partialCloseFraction: z
      .number()
      .min(DECISION_V2_BOUNDS.partialCloseFraction.min)
      .max(DECISION_V2_BOUNDS.partialCloseFraction.max)
      .optional(),
    // H5 (2026-07-27): 25/57 live schema rejections in the prior week were this field alone
    // overrunning its cap — a cosmetic free-text overrun that voided an otherwise-valid trade
    // directive. thesis is free text (never money/risk), and Signal.reason is ALREADY truncated to
    // MAX_REASON_LEN downstream (buildProposalFromTradeDecision below), so truncating here loses
    // nothing and eliminates the whole failure class (a raised fixed cap can always be exceeded
    // again; truncation cannot fail). No `.max()` — the transform makes the bound unconditional.
    thesis: z
      .string()
      .transform((s) => s.slice(0, DECISION_V2_BOUNDS.thesisMaxLen))
      .optional(),
  };
}

// Shared open/adjust gate, reused by every action-enum variant below (single-symbol spot/shorts,
// per-element spot/shorts) so it can never drift between them: the full directive set (sizeFraction/
// entry/entryValidityBars/stopLossPct/takeProfitPct/maxHoldBars) is REQUIRED on 'open_long'/
// 'open_short' — including a scale-in, per AgentDirectives' own comment — and
// partialCloseFraction is meaningless outside 'adjust' (Design table: "'adjust' only, optional").
function requireTradeDirectives(
  v: {
    readonly action: string;
    readonly sizeFraction?: number;
    readonly entry?: unknown;
    readonly entryValidityBars?: number;
    readonly stopLossPct?: number;
    readonly takeProfitPct?: number;
    readonly maxHoldBars?: number;
    readonly partialCloseFraction?: number;
  },
  ctx: z.RefinementCtx,
): void {
  if (v.action === 'open_long' || v.action === 'open_short') {
    const requiredFields = [
      'sizeFraction',
      'entry',
      'entryValidityBars',
      'stopLossPct',
      'takeProfitPct',
      'maxHoldBars',
    ] as const;
    for (const field of requiredFields) {
      if (v[field] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} is required when action is '${v.action}'`,
          path: [field],
        });
      }
    }
  }
  if (v.partialCloseFraction !== undefined && v.action !== 'adjust') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "partialCloseFraction is only meaningful with action 'adjust'",
      path: ['partialCloseFraction'],
    });
  }
}

// v3 consolidation spec §4.3: ONE schema — the action enum always includes 'open_short' (no more
// spot/perp schema variants); per-symbol shorts eligibility is enforced AFTER a structurally valid
// parse (propose()/proposeBatch() check the parsed action against that symbol's own
// capabilities.shorts and degrade a disallowed 'open_short' to a named capability-violation hold —
// see their own comments), never baked into the schema shape itself.
export function tradeDecisionSchema(sizeFractionMax: number) {
  return z
    .object({
      action: z.enum(['open_long', 'open_short', 'close', 'adjust', 'hold']),
      ...tradeDirectiveFieldShape(sizeFractionMax),
    })
    .superRefine(requireTradeDirectives);
}

// The v2 decision shape buildProposalFromTradeDecision maps.
type TradeDecisionV2 = z.infer<ReturnType<typeof tradeDecisionSchema>>;

// v3: portfolio-batch per-element schema — the SAME action/directive validation as the single-symbol
// schema above with a `symbol` field added. nextConsultBars is deliberately ABSENT from the element
// shape (portfolio-level only — see tradePortfolioSchema below); a stray one on an element is simply
// ignored (non-strict object), never rejected. sizeFractionMax is THIS element's own symbol's
// capabilities.maxSizeFraction (proposeBatch builds one schema per resolved element, since each
// symbol's own bound can differ — spot vs perp).
export function tradeElementSchema(sizeFractionMax: number) {
  return z
    .object({
      symbol: z.string().min(1),
      action: z.enum(['open_long', 'open_short', 'close', 'adjust', 'hold']),
      ...tradeDirectiveFieldShape(sizeFractionMax),
    })
    .superRefine(requireTradeDirectives);
}

// S3: whole-call shape for the v2 submit_portfolio payload — lenient per element (z.unknown()): a
// malformed INDIVIDUAL element must degrade only that symbol, validated separately via
// tradeElementSchema — but ALSO carries the portfolio-level nextConsultBars (Design table:
// "portfolio-level, one per batch response" — per-symbol scheduling would desync the basket).
export const tradePortfolioSchema = z.object({
  decisions: z.array(z.unknown()),
  nextConsultBars: z
    .number()
    .int()
    .min(DECISION_V2_BOUNDS.nextConsultBars.min)
    .max(DECISION_V2_BOUNDS.nextConsultBars.max),
});

// Pass 64: lets a whole-batch discard still recover the model's own nextConsultBars even though the
// REST of the payload failed tradePortfolioSchema (e.g. a stringified `decisions` that doesn't
// survive salvage) — same bound as the field above, deliberately re-declared rather than derived from
// tradePortfolioSchema.shape so this stays a truly independent, narrower extraction and can never
// accidentally re-widen the real schema.
const nextConsultBarsOnlySchema = z.object({
  nextConsultBars: z
    .number()
    .int()
    .min(DECISION_V2_BOUNDS.nextConsultBars.min)
    .max(DECISION_V2_BOUNDS.nextConsultBars.max),
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

// What payloadExtrasProvider answers. Named (rather than inlined twice on the config field) because
// the inline shape had drifted: it declared four keys while the composition root's closure
// (agentic-bridge.module.ts's PAYLOAD_EXTRAS_PROVIDER_OVERRIDE) already returned six —
// `execQuality` reached buildMarketPayload structurally untyped, so nothing checked that it even
// existed. portfolio/budget/calendar/execQuality are genuinely batch-wide and spread straight
// through; venueFreeCash and fundingAccrualBySymbol are consumed here instead, keyed per symbol
// (capabilitiesFor and the per-element extras respectively).
export interface AgentPayloadExtras {
  readonly portfolio?: AgentPortfolioBlock;
  readonly budget?: AgentBudgetBlock;
  readonly calendar?: readonly AgentCalendarEvent[];
  readonly execQuality?: string;
  // Cumulative funding accrual PER SYMBOL. Was a single batch-wide `fundingAccrualQuote` string
  // computed from one symbol (tradingSymbols[0], a spot symbol that accrues no funding) and rendered
  // in the shared block under a header promising the facts in it apply to every symbol. A symbol with
  // no entry renders no key at all — see buildFundingAccrualMap (agentic-bridge.module.ts).
  readonly fundingAccrualBySymbol?: ReadonlyMap<SymbolId, string>;
  readonly venueFreeCash?: ReadonlyMap<VenueId, string>;
}

export interface AnthropicAgentClientConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxTokens: number;
  // WATCH-V4-12 sanctioned fix (2026-08-03): threads output_config.effort into every decide/batch
  // request. The lane sends thinking:{type:'adaptive'} on every call (below) but no output_config, so
  // every call runs the API's default effort ('high') — measured to spend the ENTIRE maxTokens budget
  // on thinking before tool_use JSON starts (8 truncations this boot, output_tokens pinned at exactly
  // 4096, ~$0.61/day / ~11 symbol-decides lost/day, all fully paid for and discarded). Two more-direct
  // fixes are refuted: thinking.budget_tokens was REMOVED on claude-sonnet-5 (would 400 — see
  // attemptOnce), and raising AGENTIC_MAX_TOKENS is refuted by the $3/day USD breaker plus the 75s
  // batch HTTP abort budget a raised ceiling would project past (research/loop/watches.md §
  // WATCH-V4-12). FAILS OPEN toward today's behaviour: absent/unset ⇒ attemptOnce omits output_config
  // entirely (byte-identical request), never a blocked decide. Ships flag-off — a separate enable
  // commit flips the deploy knob after its own $0 offline-harness review (charter.md).
  readonly outputEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
  // The venue fee table the take-profit floor gate reads, keyed by the SYMBOL'S OWN venue
  // (venueForSymbol) rather than off the one static profile the system prompt renders. Absent ⇒
  // domain/trading/fees.ts's VENUE_FEE_SCHEDULES, which is what the composition root deliberately
  // relies on (one table, never a config-side second copy). The override exists so the pending
  // perp-schedule enable can be exercised end-to-end offline before it ships.
  readonly feeSchedules?: ReadonlyMap<VenueId, VenueFeeSchedule>;
  // C1: documents the optional derivatives block in the system prompt (agent-prompt.ts's
  // buildSystemPrompt derivativesFeedEnabled option). Absent/false ⇒ byte-identical legacy prompt.
  readonly derivativesFeedEnabled?: boolean;
  // d2 (Push 3 P6 Unit 1): when true ALONGSIDE derivativesFeedEnabled, switches the derivatives
  // block/sentence/tag from d1 to d2 (three extra fields: spot-perp basis, OI percent change,
  // funding trend — see agent-prompt.ts's DERIVATIVES_V2_TEMPLATE_VERSION comment). Inert on its own
  // (derivativesFeedEnabled false ⇒ no derivatives block at all, v2 or not). ENABLING MID-FACTORIAL
  // IS FORBIDDEN — never flip this while an A/B or offline sweep is comparing d1-tagged rows; see the
  // same constant's comment for why the two template versions are not cross-comparable.
  readonly derivativesV2Enabled?: boolean;
  // ADD-A (X2, perp basket widening): documents + renders the fundingHistory block (own tag, own
  // flag — same one-flag-per-block precedent as sentimentFeedEnabled/tradeFlowFeedEnabled below,
  // not a reuse of derivativesFeedEnabled: reusing it would retroactively change every existing
  // derivativesFeedEnabled=true fixture's byte-identical prompt/hash). Wired from the SAME
  // DERIVATIVES_FEED_ENABLED env var at the composition root (no new env knob) — see
  // agentic-strategy.module.ts. Inert without a fresh recentFundingRates snapshot regardless (see
  // buildFundingHistoryBlock). Absent/false ⇒ byte-identical legacy prompt.
  readonly fundingHistoryFeedEnabled?: boolean;
  // v3 consolidation spec §9: the information-context control arm (derivativesControlArm) and its
  // AGENTIC_DERIVATIVES_AB_PCT knob are DELETED outright (XA3 decision record: treatment drove 8.4%
  // vs 1.9% proposes — the control arm is retired at 0 permanently, so every info-context feed flag
  // below now applies unconditionally; there is no cfg field left to gate it).
  // S3: thinking-on-decide A/B (backlog #42) RETIRED — every decide/batch call now carries
  // thinking:{type:'adaptive'} unconditionally (Design § Deleted/replaced scaffolding). The knob and
  // its abArm('th-v1', ...) bucketing are deleted outright rather than defaulted-off, since the
  // field would otherwise silently do nothing for any caller still passing it.
  // C4: documents the optional sentiment block in the system prompt (agent-prompt.ts's
  // buildSystemPrompt sentimentFeedEnabled option). Absent/false ⇒ byte-identical legacy prompt.
  readonly sentimentFeedEnabled?: boolean;
  // X3a: documents the optional fearGreed block in the system prompt (agent-prompt.ts's
  // buildSystemPrompt fearGreedFeedEnabled option). Absent/false ⇒ byte-identical legacy prompt. Not
  // part of the information-context A/B control arm — same convention as sentimentFeedEnabled above
  // (lane-wide, no per-symbol data cost to withhold).
  readonly fearGreedFeedEnabled?: boolean;
  // 2026-07-12: documents + renders the cross-symbol relative-strength block. Gated together with the
  // derivatives block under the information-context A/B control arm (see propose()). Absent/false ⇒
  // byte-identical legacy prompt/payload.
  readonly crossSymbolFeedEnabled?: boolean;
  // 2026-07-13: documents + renders the tradeFlow (CVD) block. Gated together with the derivatives
  // block under the SAME information-context A/B control arm as crossSymbolFeedEnabled above.
  // Absent/false ⇒ byte-identical legacy prompt/payload.
  readonly tradeFlowFeedEnabled?: boolean;
  // 2026-07-13: documents + renders the positioning (global long/short ratio) block. Gated together
  // with the derivatives block under the same information-context A/B control arm. Absent/false ⇒
  // byte-identical legacy prompt/payload.
  readonly positioningFeedEnabled?: boolean;
  // Push 3 P6 Unit 2 (#43): documents + renders the liquidation (rolling notional + long/short
  // side-skew) block. Gated together with the derivatives block under the same information-context
  // A/B control arm. Absent/false ⇒ byte-identical legacy prompt/payload.
  readonly liquidationsFeedEnabled?: boolean;
  // Push 3 P6 Unit 3: documents + renders the bookStructure (microprice/depth-weighted imbalance/
  // depth notional) block, computed from the already-streaming order book. Does NOT ride the
  // information-context A/B control arm (no new external feed/cost — see agent-prompt.ts's
  // BOOK_STRUCTURE_TEMPLATE_VERSION comment). Absent/false ⇒ byte-identical legacy prompt/payload.
  readonly bookStructureFeedEnabled?: boolean;
  // Push 3 P6 Unit 4 (#17 residual): documents + renders the trackRecord (tripCount/winRate/
  // meanNetBpsPerTrip/trailingWindowTrips) block — a passthrough of AgentContext.trackRecord the
  // strategy attaches. Does NOT ride the information-context A/B control arm (decide-side read of
  // realized performance, no external feed/cost). Absent/false ⇒ byte-identical legacy prompt/payload.
  readonly trackRecordFeedEnabled?: boolean;
  // Phase 4 (Profitability Edge Program): documents + renders the edgePolicy block when the strategy
  // attaches an active snapshot. Does NOT ride the information-context A/B control arm. Absent/false
  // ⇒ byte-identical legacy prompt/payload.
  readonly edgePolicyFeedEnabled?: boolean;
  // v3 consolidation spec §4: shorts/leverage/sizeFraction-cap are no longer a deployment-wide lane
  // flag (shortsEnabled/perpCapableVenue/tradeContract/maxPositionFraction — ALL DELETED, §9) — every
  // v3 boot serves the unified submit_trade/submit_portfolio contract for every symbol, and per-symbol
  // eligibility rides in SymbolCapabilities, computed per decide from venueForSymbol + these two caps.
  // AGENTIC_MAX_POSITION_FRACTION_SPOT/PERP (money-adjacent strings, same convention as
  // SIZER_EQUITY_CAP) — absent ⇒ DEFAULT_MAX_POSITION_FRACTION_SPOT/PERP.
  readonly maxPositionFractionSpot?: string;
  readonly maxPositionFractionPerp?: string;
  // PERP_LEVERAGE_CAP (decimal string) — capabilities.leverage for every perp symbol; spot symbols
  // always report '1' (see capabilitiesFor). Absent ⇒ DEFAULT_PERP_LEVERAGE_CAP.
  readonly perpLeverageCap?: string;
  // v3 consolidation spec §4.3: fired exactly once per capability-violation degrade (an 'open_short'
  // parsed against a symbol whose capabilities.shorts is false) — the composition root wires this to
  // AgentMetricsRecorder.recordCapabilityViolation (a config-level callback seam, never a direct
  // import of the concrete recorder class, mirroring payloadExtrasProvider's own seam convention;
  // see AgentMetricsRecorder's own comment on why no recorder seam otherwise reaches this client).
  // Absent ⇒ the metric is simply not recorded (the degrade itself — hold + 'error' journal action —
  // still happens regardless; the counter is observability, never a gate).
  readonly recordCapabilityViolation?: (kind: string) => void;
  // 2026-07-22 schema-hardening: fired once per schema-rejection degrade — the four modes a propose/
  // proposeBatch call can post-200 reject a tool payload on (single-symbol parse failure, whole-batch
  // parse failure, a symbol missing from the batch's decisions array, and a per-element parse
  // failure). Same config-level callback seam as recordCapabilityViolation above (never a direct
  // import of the concrete recorder). Absent ⇒ the degrade itself (hold, self-describing
  // schema_rejected: rationale, see the four call sites below) still happens regardless — the counter
  // is observability, never a gate.
  // Pass 64: 'batch_stringified_recovered' is a FIFTH, distinct label — a whole-batch parse that
  // failed only because `decisions` arrived as a JSON string and was salvaged back into an array (see
  // proposeBatch's stringified-decisions coercion). Kept separate from 'batch' so the journal can
  // distinguish "recovered" from "discarded" batch failures instead of conflating them.
  readonly recordSchemaFailure?: (
    kind: 'single' | 'batch' | 'element' | 'missing_symbol' | 'batch_stringified_recovered',
  ) => void;
  // I1b (Design § Enriched model inputs): the composition root's batch-wide extras source
  // (agent-portfolio-block.ts's buildAgentPortfolioBlock, agent-budget.ts's DailyLlmBudget.
  // budgetBlock, macro-calendar.ts's loadMacroCalendar/filterUpcoming, and v3's per-venue free-cash
  // map for the capabilities block, §4.2) — invoked at most ONCE per propose() call and ONCE per
  // proposeBatch() call (never per symbol inside a batch: portfolio/budget/calendar/venueFreeCash are
  // batch-wide state, not per-symbol — see BuildMarketPayloadExtras' own comment), then merged into
  // every buildMarketPayload call the same decide/batch round makes (venueFreeCash is looked up
  // per-symbol off the one returned map, via capabilitiesFor). Absent ⇒ no provider invoked, no
  // portfolio/budget/calendar keys ever added and venueFreeCash reads as '0' — byte-identical to
  // pre-I1b (S1's own omit-when-absent tests already pin this) for the pre-v3 fields.
  readonly payloadExtrasProvider?: () => AgentPayloadExtras | Promise<AgentPayloadExtras>;
  // R2 (episodic memory): when true, documents the similarSetups block in the system prompt and adds
  // the '+mem1' promptHash tag. Absent/false ⇒ byte-identical prompt/hash — same convention as the
  // feed-enabled flags. Gated separately from similarSetupsProvider's own per-call presence (the
  // prompt sentence must stay byte-identical whether or not a given call retrieved any rows).
  readonly episodicMemoryEnabled?: boolean;
  // R2: the composition root's per-symbol journal-retrieval seam (agent-decision-journal.adapter.ts's
  // recentSimilarSetups) — given the CURRENT regime tags, returns up to N past setups (tag-matched,
  // newest-first, forward-move-joined, replay rows included and labeled synthetic). Invoked once per
  // decide()/per resolved batch element (retrieval is per-symbol, unlike the batch-wide
  // payloadExtrasProvider above — regime is per-symbol) and merged into that call's buildMarketPayload
  // similarSetups extra. One indexed journal read, NEVER an LLM/API call. Absent ⇒ the block is
  // omitted entirely (fail-open measurement — a missing retrieval never blocks or alters a decision).
  readonly similarSetupsProvider?: (
    tags: RegimeTags,
  ) => Promise<readonly SimilarSetupRow[]> | readonly SimilarSetupRow[];
  // AGENTIC_PLAN_AUTHORITATIVE_EXITS (2026-07-30): when true, a mid-trade 'close' is DROPPED for a
  // position whose declared directives are still being enforced — the plan the model itself declared
  // at entry (stopLossPct/takeProfitPct/maxHoldBars) owns the exit. Absent/false ⇒ byte-identical to
  // pre-feature (every 'close' maps to EXIT_LONG/EXIT_SHORT as before). See the close branch in
  // buildProposalFromTradeDecision for the gate, its measured basis, and its failure direction.
  readonly planAuthoritativeExits?: boolean;
  // Pass 64 MUST-FIX C: the lane's own forced-fallback cadence (AGENTIC_FALLBACK_CONSULT_BARS,
  // config.agentic.fallbackConsultBars — the SAME field agentic.strategy.ts's own fallback-bars
  // constructor param reads, threaded here so the two can never drift onto two different numbers).
  // Consumed ONLY by proposeBatch's whole-batch-discard recovery (see nextConsultBarsOnlySchema's
  // call site): a recovered nextConsultBars is clamped to at most this many bars, so a discard can
  // never adopt a scheduling gap wider than today's forced-fallback cadence out of a payload whose
  // `decisions` the schema just rejected. Absent ⇒ DEFAULT_FALLBACK_CONSULT_BARS (mirrors
  // AGENTIC_FALLBACK_CONSULT_BARS's own schema default, environment.config.ts).
  readonly fallbackConsultBars?: number;
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
// v3 consolidation spec §9: the legacy submit_decision/submit_plan mapping (buildProposalFromDecision)
// is DELETED — every entry now carries a fixed `strength: 1` (telemetry only, see
// buildProposalFromTradeDecision), conviction rides entirely on Signal.sizeFraction instead, so the
// MIN_STRENGTH/MAX_STRENGTH confidence-clamp constants that mapping used are gone with it.

// Fallbacks when cfg.maxPositionFractionSpot/Perp are absent — mirror
// AGENTIC_MAX_POSITION_FRACTION_SPOT/PERP's own schema defaults (environment.config.ts).
const DEFAULT_MAX_POSITION_FRACTION_SPOT = '0.15';
const DEFAULT_MAX_POSITION_FRACTION_PERP = '0.35';
// Mirrors PERP_LEVERAGE_CAP's own schema default.
const DEFAULT_PERP_LEVERAGE_CAP = '2';
// Mirrors AGENTIC_FALLBACK_CONSULT_BARS's own schema default (environment.config.ts) — read only
// when cfg.fallbackConsultBars is absent (a caller that never wired the real config value).
const DEFAULT_FALLBACK_CONSULT_BARS = 8;

// A1: taker-entry crossing buffer for the v2 client's OWN reference-price hint (mirrors
// position-sizer.service.ts's EXIT_CROSS_BUFFER_BPS default of 25bps — same magnitude, an
// independent constant: this file only computes a REFERENCE limitPriceHint on the marketable side of
// refPrice so PositionSizerService.entryType's own crossing check degrades LIMIT_MAKER→LIMIT
// naturally; the sizer's own knobs, not this one, govern the actual execution price/tick-rounding).
const TAKER_CROSS_BUFFER_BPS = 25;

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

// Pass 48 (2026-07-30): a SECOND classification, orthogonal to classifyHttpStatus above — that one
// decides whether to keep calling, this one decides WHY a FATAL call failed, so the latch it causes
// can be told apart from an owner-blocked-but-already-diagnosed condition (an unfunded LLM provider
// account) from one that is actually actionable (a bad/revoked key). Read from the provider's OWN
// error body only (attemptOnce's `detail`, embedded in AgentProposeError.message below) — never
// guessed from anything else.
//
// FAILURE DIRECTION, stated because this drives an alert-severity split (observability/
// alerts.rules.yml's AgentClientFatalLatch/AgentClientLatchedUnfundedAccount): this classifier fails
// CLOSED toward 'other'. 'other' keeps the critical alert armed; only a positive, specific match on
// the provider's own credit-exhaustion wording demotes it to the known-cause warning. An unrecognised
// FATAL error must never be quietly demoted — that is the whole safety property this function buys.
export type AgentClientLatchCause = 'insufficient_credit' | 'auth' | 'other';

export function classifyLatchCause(
  status: number | undefined,
  message: string,
): AgentClientLatchCause {
  if (status === 401 || status === 403) return 'auth';
  if (
    status === 400 &&
    message.includes('invalid_request_error') &&
    /credit balance/i.test(message)
  ) {
    return 'insufficient_credit';
  }
  return 'other';
}

// Every call SUPPRESSED after the one that latched carries no err object of its own — only the
// rationale latchRationale() embeds below, since that is the one thing that survives from the
// original FATAL failure to every later short-circuit. Failure direction mirrors classifyLatchCause
// exactly: an unparseable or missing tag reads 'other', never a guess toward the demoted cause.
//
// Anchored to the literal prefix latchRationale() emits, not a bare `cause=` scan: rationale is
// model-authored verbatim text (thesis ?? ''), and this tag now drives an alert-severity SUPPRESSION
// (observability/alerts.rules.yml's AgentClientFatalLatch), not just a noisy false-positive — an
// unanchored match lets any model thesis containing "cause=insufficient_credit" silently demote a
// real fault to the known-unfunded warning.
const LATCH_CAUSE_TAG =
  /^client_latched: agent client latched degraded by a FATAL api error \(cause=(insufficient_credit|auth|other)\)/;
export function parseLatchCauseFromClientLatchedRationale(
  rationale: string,
): AgentClientLatchCause {
  const match = LATCH_CAUSE_TAG.exec(rationale);
  return (match?.[1] as AgentClientLatchCause | undefined) ?? 'other';
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

// BatchingAgentClient's own batch-vs-caller contract: proposeBatch resolves (never rejects) for
// every response outcome that ALSO resolves in the single-symbol propose() path (soft holds:
// refusal, malformed element, missing symbol) — only a genuine whole-call transport/HTTP/schema
// failure throws, so BatchingAgentClient can reject every waiting caller with the SAME error class
// propose() would throw for the equivalent failure (see proposeBatch's own comments).
export interface AgentProposeBatchOptions {
  // Overrides cfg.timeoutMs for THIS call only — BatchingAgentClient folds its own coalescing window
  // into this so the total wall time a batch's first-arrival caller experiences (window + HTTP) never
  // exceeds the host's decide backstop (see batching-agent-client.ts's window/timeout comment).
  readonly timeoutMsOverride?: number;
}
export interface AgentProposeBatchResult {
  readonly proposals: ReadonlyMap<string, AgentProposal>;
  // Aggregate usage for the ONE HTTP call this batch spent, exposed separately from `proposals` (see
  // BatchingAgentClient) so the caller can record it against the shared daily budget exactly once
  // regardless of which symbols round-trip successfully — the SAME AgentUsage object also rides on
  // exactly the first resolved symbol's own AgentProposal.usage (absent-vs-zero convention preserved:
  // every OTHER symbol's proposal omits `usage` entirely, mirroring recordUsage's own semantics).
  readonly usage?: AgentUsage;
}

// Schema-rejection diagnostics: without the zod issue list and a payload echo, a live rejection
// of the model's tool output is undiagnosable from logs (soak 2026-07-18: perp's first v2 consult
// failed validation with no recorded cause). Trade parameters are not secrets — safe to echo.
const describeSchemaFailure = (error: z.ZodError, input: unknown): string => {
  const issues = error.issues
    .slice(0, 6)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  let payload: string;
  try {
    payload = (JSON.stringify(input) ?? String(input)).slice(0, 600);
  } catch {
    payload = '[unserializable]';
  }
  return `${issues} — payload: ${payload}`;
};

// 2026-07-22 schema-hardening: the self-describing rationale stamped on a schema-rejection degrade
// (see the four schema-fail branches below, and requireTradeDirectives'/tradeDecisionSchema's own
// comments on the failure mode this makes queryable: `WHERE rationale LIKE 'schema_rejected%'`).
// Carries only the FIRST issue (describeSchemaFailure above is the full warn-log diagnostic — this is
// the short, journal-persisted account), truncated to stay a short single-line rationale.
const DEGRADE_RATIONALE_MAX_LEN = 160;
const prefixedRationale = (prefix: string, summary: string): string => {
  const budget = DEGRADE_RATIONALE_MAX_LEN - prefix.length;
  return `${prefix}${summary.length > budget ? `${summary.slice(0, budget)}…` : summary}`;
};
const schemaRejectedRationale = (summary: string): string =>
  prefixedRationale('schema_rejected: ', summary);
// Pass 64: an EMPTY/absent tool-input payload (`{}`, `[]`, or undefined — isEmptyToolInput below
// checks Object.keys().length, which reads 0 for an empty array too) from a non-max_tokens stop is a
// DIFFERENT defect than a present-but-malformed payload (schema_rejected) or a max_tokens truncation
// (truncated_max_tokens) — the two live boot e423875b batches that motivated this pass shared one tag
// bucket despite having different root causes, and this was the one distinguishable purely from the
// payload shape (no stop_reason involved). Checked BEFORE schema_rejected in schemaFailureRationale
// below, mirroring the max_tokens check's own precedence.
const emptyToolInputRationale = (summary: string): string =>
  prefixedRationale('empty_tool_input: ', summary);
const isEmptyToolInput = (input: unknown): boolean =>
  input === undefined ||
  input === null ||
  (typeof input === 'object' && Object.keys(input).length === 0);
// XA4 addendum (2026-07-31): a `stop_reason: 'max_tokens'` reaching a schema-FAILURE branch (a
// tool_use block IS present, unlike the !toolBlock branch above) is the same truncation that branch
// already names — the output budget ran out before valid arguments landed, so `toolBlock.input` is
// empty/incomplete and zod's own issue ("expected array, received undefined") IS the truncation
// signature. Reuses the exact 'truncated_max_tokens: ' tag spelling from the !toolBlock branch so the
// two truncation shapes stay one queryable bucket instead of splitting into schema_rejected (10/37
// live schema_rejected rows over the trailing 14d journaled output_tokens pinned at exactly 4096).
// Fails OPEN to schema_rejected for any other/missing stop_reason — never a soft-hold/control-flow
// change (same decision shape, same recordSchemaFailure call either way). NOT diagnosability-only,
// though: trading-runtime.module.ts's outcomeForProposal maps 'truncated_max_tokens:' to
// AgentDecideOutcome 'truncated' while 'schema_rejected:' falls through to 'hold', so every re-tagged
// row also moves agent_decide_total from {outcome="hold"} to {outcome="truncated"}. Checked benign
// (both tags are in PROVES_CALL_COMPLETED_OUTCOMES, neither in LATCHED_DECIDE_OUTCOMES, both alert
// rules and the Grafana panel are label-agnostic — agent-metrics-recorder.service.ts:32-54) and pinned
// by test/features/trading/composition/agent-decide-outcome-tags.spec.ts's schema_rejected:→'hold' case.
//
// Pass 64: `toolInput` is the THIRD input, checked only after the max_tokens truncation branch above
// it — an empty/absent payload under a genuine max_tokens truncation stays 'truncated_max_tokens:'
// (that cause is already named and more specific), and only a non-max_tokens empty payload gets the
// new 'empty_tool_input:' tag. Anything present-but-malformed still falls to schema_rejected.
const schemaFailureRationale = (
  stopReason: string | undefined,
  summary: string,
  toolInput: unknown,
): string => {
  if (stopReason === 'max_tokens') return prefixedRationale('truncated_max_tokens: ', summary);
  if (isEmptyToolInput(toolInput)) return emptyToolInputRationale(summary);
  return schemaRejectedRationale(summary);
};
// AGENTIC_PLAN_AUTHORITATIVE_EXITS (2026-07-30): the self-describing rationale stamped when a
// mid-trade 'close' is dropped because the position is still under its own declared plan — queryable
// as `WHERE rationale LIKE 'plan_authoritative_close:%'`. The model's own thesis is preserved after
// the prefix so the journal still records WHY it wanted out, on the same truncation discipline as
// schemaRejectedRationale above.
//
// Deliberately NOT a DEGRADED_DECIDE_RATIONALE_TAGS member (domain/strategy/types/decide-rationale.
// ts): those tags mark a consult that reached the model and came back with nothing usable, and they
// feed WATCH-V4-8's "is the lane alive" signal. This consult came back with a perfectly valid
// decision that the SYSTEM overrode — counting it as a degrade would indict a healthy lane.
const PLAN_AUTHORITATIVE_CLOSE_RATIONALE_MAX_LEN = 160;
const planAuthoritativeCloseRationale = (thesis: string | undefined): string => {
  const prefix = 'plan_authoritative_close: ';
  const body = thesis ?? '';
  const budget = PLAN_AUTHORITATIVE_CLOSE_RATIONALE_MAX_LEN - prefix.length;
  return `${prefix}${body.length > budget ? `${body.slice(0, budget)}…` : body}`;
};
const firstIssueSummary = (error: z.ZodError): string => {
  const first = error.issues[0];
  return first
    ? `${first.path.map(String).join('.') || '(root)'}: ${first.message}`
    : 'unknown schema issue';
};

// How long a FATAL classification suppresses calls before ONE probe attempt is allowed through.
//
// FAILURE DIRECTION — this gate fails OPEN (toward re-probing), deliberately. It is an inference-
// availability gate, not a safety interlock: nothing it permits can move money on its own, because a
// re-probe can at most produce a proposal that Risk still sizes and vetoes, behind the unchanged kill
// switch and live gates. What a permanently-closed latch DOES do is stop the entire strategy while
// every health surface stays green — which is exactly what happened on 2026-07-27T21:16Z, when the
// Anthropic account's credit ran out, one 400 latched the client, and the lane made zero LLM calls
// for over three hours until a human noticed. Every FATAL status this client recognises (400/401/403/
// 404/422) is a condition an operator can fix WITHOUT touching the process — top up credit, restore a
// key, lift a permission — so "latched until the container is recreated" wrongly modelled all of them
// as permanent.
//
// 30 min keeps the original intent intact: the comment this replaces worried about hammering "at
// candle cadence", and the candle is STRATEGY_INTERVAL=15m, so a 30-minute floor is still strictly
// slower than the cadence it was written to suppress — and a 4xx bills nothing either way. In the
// deployed shape (AGENTIC_PORTFOLIO_CONSULT=true) the whole consulting menu is coalesced into one
// batched request, so that is ~2 failed requests/hour; with batching off it is one ordinary bar's
// worth of per-symbol calls twice an hour instead of every 15m, still a reduction. What the expiry
// buys is that this outage class is bounded at 30 minutes instead of unbounded.
const FATAL_LATCH_COOLDOWN_MS = 30 * 60 * 1000;

// Concrete AGENT_CLIENT adapter: calls the real Anthropic Messages API and maps its tool-use
// decision to a proposed AgentProposal. Stateless across decisions — the strategy owns the
// decision-history trail — but stateful across FAILURES: a FATAL classification latches this
// instance to degraded so a bad key/request can't be hammered at candle cadence. The latch expires
// after FATAL_LATCH_COOLDOWN_MS so a fixed-outside-the-process cause self-heals. Risk still
// sizes/vetoes whatever signal is returned.
export class AnthropicAgentClient implements AgentClientPort {
  // Wall-clock of the most recent FATAL failure, or null when no latch is in force. Every
  // propose()/proposeBatch() call within FATAL_LATCH_COOLDOWN_MS of it short-circuits with no HTTP
  // call; the first call after that window clears the latch and is allowed to probe.
  private latchedAtMs: number | null = null;
  // The classified cause of the failure that set latchedAtMs above — read only while latchedAtMs is
  // non-null (see latchRationale), and re-stamped alongside it on every fresh FATAL (handleFailure).
  // Default value is inert: never read until a first latch sets it for real.
  private latchedCause: AgentClientLatchCause = 'other';
  // Dedupes the "stored playbook failed validation" warn to once per distinct invalid content,
  // rather than once per candle-cadence propose() call while the same bad playbook sits stored.
  private lastInvalidPlaybookContent: string | null = null;

  constructor(
    private readonly cfg: AnthropicAgentClientConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly logger: LoggerLike = NOOP_LOGGER,
    private readonly playbookProvider?: PlaybookProvider,
  ) {}

  // v3 consolidation spec §4.2: this symbol's own capability facts — venue-derived (never a
  // deployment-wide lane flag), rendered into the payload's capabilities block and enforced by the
  // zod layer's post-parse capability check (see propose()/proposeBatch()). venueFreeCash is
  // display-grade only (never zod-enforced — the sizer's own venue-headroom clamp is the actual
  // enforcement, spec §6); absent map or missing venue entry ⇒ '0', never a throw (fail-open display
  // data, same convention as every other optional payload extra in this file).
  private capabilitiesFor(
    symbol: SymbolId,
    venueFreeCash: ReadonlyMap<VenueId, string> | undefined,
  ): SymbolCapabilities {
    const venue = venueForSymbol(symbol);
    const isPerp = venue === PERP_VENUE_ID;
    return {
      venue,
      shorts: isPerp,
      leverage: isPerp ? (this.cfg.perpLeverageCap ?? DEFAULT_PERP_LEVERAGE_CAP) : '1',
      maxSizeFraction: isPerp
        ? (this.cfg.maxPositionFractionPerp ?? DEFAULT_MAX_POSITION_FRACTION_PERP)
        : (this.cfg.maxPositionFractionSpot ?? DEFAULT_MAX_POSITION_FRACTION_SPOT),
      venueFreeCash: venueFreeCash?.get(venue) ?? '0',
    };
  }

  // The latch, asked once per call. Returns the short-circuit rationale while suppression is in
  // force, or null once the cooldown has expired. Expiry RELEASES suppression outright rather than
  // handing out a single probe token: `latchedAtMs` goes null, and only a fresh FATAL (handleFailure)
  // sets it again. So a recovered client resumes at full cadence immediately — no success path needs
  // to clear anything — and a still-broken one re-latches on its next attempt.
  // Reading has the side effect of clearing, deliberately: there is no separate timer to schedule,
  // wake, or leak, and a client nobody calls never probes.
  private latchRationale(nowMs: number): string | null {
    if (this.latchedAtMs === null) return null;
    const heldMs = nowMs - this.latchedAtMs;
    // A latch stamped in the future (clock step) is treated as expired rather than trusted, so a
    // clock jump can never extend suppression indefinitely.
    if (heldMs >= FATAL_LATCH_COOLDOWN_MS || heldMs < 0) {
      this.latchedAtMs = null;
      this.logger.warn(
        `anthropic api: fatal-error latch expired after ${Math.round(heldMs / 60_000)}min — resuming calls`,
      );
      return null;
    }
    // H4 tag discipline (see the envelope_malformed/capability_violation branches): a named rationale
    // rather than a decision-less proposal, so the journal row is queryable and trading-runtime's
    // outcomeForProposal can meter it as `client_latched` instead of an indistinguishable 'hold'. On
    // 2026-07-27, 30 such rows persisted as bare holds with an EMPTY rationale — visually identical to
    // a genuine model hold, and silently counted as one by every entry-rate measurement.
    //
    // Pass 48: the `cause=` tag is the ONLY way trading-runtime.module.ts's MetricsWrappingAgentClient
    // can learn WHY this call is suppressed — a suppressed call carries no err object of its own, so
    // the classification made once at latch time (handleFailure) has to survive as text here (see
    // parseLatchCauseFromClientLatchedRationale).
    return `client_latched: agent client latched degraded by a FATAL api error (cause=${this.latchedCause}) ${Math.round(heldMs / 1000)}s ago — no call made, retrying after ${FATAL_LATCH_COOLDOWN_MS / 60_000}min`;
  }

  // action 'error', not 'hold' — the same named-degrade discipline as capability_violation below: a
  // call that never happened must never read as a model that chose to hold.
  private static latchedDecision(rationale: string): AgentDecisionMeta {
    return { action: 'error', confidence: null, rationale };
  }

  // The two feed blocks that are lane-wide BY PORT CONTRACT — SentimentFeedPort.latest() and
  // FearGreedFeedPort.latest() both take no symbol argument — but which reach this client through
  // each element's own snapshot (agentic.strategy.ts merges them per instance), so a poll landing
  // mid-coalescing-window could in principle leave two elements holding different readings.
  //
  // Hoisting is therefore gated on the batch AGREEING: a key is promoted to the shared block only
  // when every element renders it byte-identically. FAILS OPEN — any disagreement, or a single
  // element missing the block, drops the key from the shared set entirely and each element renders
  // its own copy exactly as before. This is a token-deduplication optimisation, never a gate, so a
  // dissenting element must cost tokens rather than lose its reading.
  //
  // Only these two qualify. Checked against 86 recorded and 16 live multi-symbol waves and rejected:
  // `liquidation` (LiquidationFeedPort.latest(symbol) — per-symbol trailing window) and `trackRecord`
  // (round trips filtered by strategyId, one instance per symbol) are per-symbol by construction, and
  // hoisting either on today's incidental agreement would silently attribute one symbol's flow or
  // realized record to the whole batch the first time they diverged.
  private static laneWideFeedBlocks(
    inputs: readonly AgentDecisionInput[],
  ): Pick<BuildMarketPayloadExtras, 'sentiment' | 'fearGreed'> {
    const agreed = <K extends 'sentiment' | 'fearGreed'>(
      key: K,
    ): AgentDecisionInput['snapshot'][K] | undefined => {
      const first = inputs[0]?.snapshot[key];
      if (first === undefined) return undefined;
      const rendered = JSON.stringify(first);
      return inputs.every((i) => JSON.stringify(i.snapshot[key]) === rendered) ? first : undefined;
    };
    const sentiment = agreed('sentiment');
    const fearGreed = agreed('fearGreed');
    return {
      ...(sentiment !== undefined ? { sentiment } : {}),
      ...(fearGreed !== undefined ? { fearGreed } : {}),
    };
  }

  async propose(input: AgentDecisionInput): Promise<AgentProposal> {
    const latched = this.latchRationale(Date.now());
    if (latched !== null) {
      return { signals: [], decision: AnthropicAgentClient.latchedDecision(latched) };
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

    const ctx = await this.prepareDecideContext();
    const constraints = this.cfg.constraintsFor?.(String(symbol)) ?? ctx.baseProfile.constraints;

    // I1b: batch-wide extras (portfolio/budget/calendar/venueFreeCash) — ONE call for this
    // single-symbol decide, same provider seam proposeBatch uses once per batch. Absent provider ⇒
    // undefined ⇒ every spread below is a no-op (byte-identical).
    const payloadExtras = await this.cfg.payloadExtrasProvider?.();
    // v3 consolidation spec §4.2: this symbol's own capability facts — rendered into the payload
    // AND used to build the per-symbol submit_trade tool below.
    const caps = this.capabilitiesFor(symbol, payloadExtras?.venueFreeCash);
    // R2: per-symbol episodic-memory retrieval (one indexed journal read, never an API call) — the
    // rendered block, or undefined when unwired/untaggable/no match (then the key is omitted).
    const similarSetups = await this.resolveSimilarSetups(input);
    // inputPayload is the market JSON ALONE — buildMarketPayload's signature carries no
    // playbookContent parameter, so it structurally cannot echo playbook text (see its own comment).
    // W2.4 cache experiment: the playbook block (the only sizeable stable prefix) rides in its own
    // cache_control content block while the volatile market JSON follows uncached; block 2 carries
    // the '\n\n' separator, so the concatenated model-visible text stays byte-identical to
    // buildUserMessage's single-string form (see buildPlaybookBlock's comment).
    const inputPayload = buildMarketPayload(input, {
      constraints,
      derivativesV2Enabled: ctx.derivativesV2Enabled,
      bookStructureEnabled: this.cfg.bookStructureFeedEnabled ?? false,
      ...payloadExtras,
      capabilities: caps,
      // Per-symbol, keyed off the one batch-wide map (see AgentPayloadExtras). undefined for a symbol
      // with no accrual ⇒ buildMarketPayload omits the key, never renders a null.
      fundingAccrualQuote: payloadExtras?.fundingAccrualBySymbol?.get(symbol),
      similarSetups,
      // I1b: B3 (agentic.strategy.ts) already attaches these onto AgentPositionSummary
      // (input.context.position) — reflected here into buildMarketPayload's own top-level
      // currentThesis/directives/barsHeld/barsUntilForcedExit extras (the channel S1's system-prompt
      // sentences and payload snapshot tests describe), so the position summary's own values and the
      // rendered payload can never drift onto two different fields. undefined when unpositioned or no
      // directive set is active ⇒ every one of these keys is omitted, same as before I1b.
      currentThesis: input.context?.position.currentThesis,
      directives: input.context?.position.directives,
      barsHeld: input.context?.position.barsHeld,
      barsUntilForcedExit: input.context?.position.barsUntilForcedExit,
    });
    const activeTool = buildTradeTool();
    const userContent: string | AnthropicTextBlock[] = ctx.playbookContent
      ? [
          {
            type: 'text',
            text: buildPlaybookBlock(ctx.playbookContent),
            cache_control: EPHEMERAL_1H,
          },
          { type: 'text', text: `\n\n${inputPayload}` },
        ]
      : inputPayload;

    const promptHash = computePromptHash({
      templateVersion:
        ctx.feedTags.length > 0
          ? `${ctx.baseTemplateVersion}+${ctx.feedTags.join('+')}`
          : ctx.baseTemplateVersion,
      playbookContent: ctx.playbookContent ?? '',
      toolSchemaJson: JSON.stringify(activeTool),
      modelId: this.cfg.model,
    });

    const started = Date.now();
    const res = await this.attemptWithRetry(
      ctx.systemPrompt,
      userContent,
      activeTool,
      this.cfg.timeoutMs,
      ctx.thinkingArm ? { type: 'adaptive' } : { type: 'disabled' },
    );

    const latencyMs = Date.now() - started;
    const body: unknown = await res.json();
    const envelope = anthropicResponseSchema.safeParse(body);
    if (!envelope.success) {
      this.logger.warn('anthropic api: malformed response envelope');
      return {
        signals: [],
        // H4 (2026-07-27): an explicit decision, never a decision-less proposal — a decision-less
        // hold persists byte-identical to a genuine model hold (empty rationale, confidence 0),
        // undiagnosable from the journal alone (88 such rows/7d, live DB). See the schema_rejected/
        // capability_violation branches above for the same discipline; envelope_malformed carries no
        // zod issue (the envelope itself never parsed), so the rationale is a fixed description.
        decision: {
          action: 'hold',
          confidence: 0,
          rationale: 'envelope_malformed: anthropic response failed envelope validation',
        },
        latencyMs,
        playbookVersion: ctx.playbookVersion,
        promptHash,
        inputPayload,
        // A call WAS attempted (ctx resolved, request sent) — the arm truth is real even though the
        // response itself was unusable. See AgentProposal.infoArm/thinkingArm for the polarity note.
        infoArm: ctx.infoArm,
        thinkingArm: ctx.thinkingArm,
      };
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
      return {
        signals: [],
        // H4: named degrade — see the malformed-envelope branch above for why a decision-less hold
        // is a masked failure mode.
        decision: {
          action: 'hold',
          confidence: 0,
          rationale: 'model_refusal: model declined to decide (stop_reason=refusal)',
        },
        usage,
        latencyMs,
        playbookVersion: ctx.playbookVersion,
        promptHash,
        inputPayload,
        infoArm: ctx.infoArm,
        thinkingArm: ctx.thinkingArm,
      };
    }
    const toolName = activeTool.name;
    const toolBlock = envelope.data.content?.find(
      (b) => b.type === 'tool_use' && b.name === toolName,
    );
    if (!toolBlock) {
      // XA4 (A0, 2026-07-20): a `max_tokens` stop with no tool block is a TRUNCATED decision, not a
      // clean hold — the model ran out of output budget (thinking + tool JSON) before emitting the
      // call. A0 found spot rows with output_tokens pinned at exactly 1024 resolving to empty-
      // rationale holds, indistinguishable from a real hold. Name it loudly so it is diagnosable and
      // so raising AGENTIC_MAX_TOKENS is an evidence-backed decision. Still soft-holds (signals: []):
      // a truncation must never throw into decide(), only surface.
      // H4: same distinction stamped into the rationale as the log line above — 'truncated_max_tokens'
      // vs 'no_tool_use' — so the two causes stay separately queryable in the journal.
      let rationale: string;
      if (envelope.data.stop_reason === 'max_tokens') {
        this.logger.warn(
          `anthropic api: response truncated at max_tokens before a ${toolName} tool_use block ` +
            `(output_tokens=${usage?.outputTokens ?? 'unknown'}) — degraded to hold; raise AGENTIC_MAX_TOKENS if frequent`,
        );
        rationale = `truncated_max_tokens: response truncated at max_tokens before a ${toolName} tool_use block (output_tokens=${usage?.outputTokens ?? 'unknown'})`;
      } else {
        this.logger.warn(
          `anthropic api: no ${toolName} tool_use block in response (stop_reason=${envelope.data.stop_reason ?? 'unknown'})`,
        );
        rationale = `no_tool_use: no ${toolName} tool_use block in response (stop_reason=${envelope.data.stop_reason ?? 'unknown'})`;
      }
      return {
        signals: [],
        decision: { action: 'hold', confidence: 0, rationale },
        usage,
        latencyMs,
        playbookVersion: ctx.playbookVersion,
        promptHash,
        inputPayload,
        infoArm: ctx.infoArm,
        thinkingArm: ctx.thinkingArm,
      };
    }
    // sizeFractionMax is a zod numeric bound (a fraction, not a money computation) — caps.maxSizeFraction
    // is the SAME string buildTradeTool already baked into the tool description above, not a second
    // hand-computed value.
    // eslint-disable-next-line no-restricted-syntax -- Number() is the correct non-money coercion here.
    const maxSizeFractionNum = Number(caps.maxSizeFraction);
    const tradeSchema = tradeDecisionSchema(maxSizeFractionNum);
    const parsedTrade = tradeSchema.safeParse(toolBlock.input);
    if (!parsedTrade.success) {
      this.cfg.recordSchemaFailure?.('single');
      this.logger.warn(
        `anthropic api: ${toolName} payload failed schema validation — ${describeSchemaFailure(parsedTrade.error, toolBlock.input)}`,
      );
      return {
        signals: [],
        decision: {
          action: 'hold',
          confidence: 0,
          rationale: schemaFailureRationale(
            envelope.data.stop_reason,
            firstIssueSummary(parsedTrade.error),
            toolBlock.input,
          ),
        },
        usage,
        latencyMs,
        playbookVersion: ctx.playbookVersion,
        promptHash,
        inputPayload,
        infoArm: ctx.infoArm,
        thinkingArm: ctx.thinkingArm,
      };
    }
    // v3 consolidation spec §4.3: capability-violation degrade — 'open_short' structurally parses
    // (the wire schema always accepts it, §4.3), but this SYMBOL's own capabilities.shorts may be
    // false (spot). A named degrade, never a silent pass-through: signals stays [] (a hold),
    // decision.action is 'error' (not 'hold') so the journal can never confuse this with an ordinary
    // hold, the rationale carries the exact capability_violation: prefix, and the composition-root
    // metric fires — all three specified by the v3 tool contract (§4.3).
    if (parsedTrade.data.action === 'open_short' && !caps.shorts) {
      this.cfg.recordCapabilityViolation?.('open_short_on_spot');
      this.logger.warn(
        `agentic capability violation: open_short proposed for symbol ${symbol} whose capabilities.shorts is false — degraded to hold`,
      );
      return {
        signals: [],
        decision: {
          action: 'error',
          confidence: null,
          rationale: 'capability_violation:open_short_on_spot',
        },
        usage,
        latencyMs,
        playbookVersion: ctx.playbookVersion,
        promptHash,
        inputPayload,
        infoArm: ctx.infoArm,
        thinkingArm: ctx.thinkingArm,
      };
    }
    return this.buildProposalFromTradeDecision({
      input,
      symbol,
      venue,
      refPrice,
      basedOnSeq,
      eventTime,
      lastCandle,
      decision: parsedTrade.data,
      usage,
      latencyMs,
      playbookVersion: ctx.playbookVersion,
      promptHash,
      inputPayload,
      infoArm: ctx.infoArm,
      thinkingArm: ctx.thinkingArm,
    });
  }

  // Portfolio-consult batching (BatchingAgentClient, Push II Phase 5 DESIGN Task 2): ONE Anthropic
  // call answering every resolvable symbol in `inputs` via submit_portfolio instead of N separate
  // submit_trade calls. Shares prepareDecideContext/attemptWithRetry/buildProposalFromTradeDecision
  // with propose() so playbook/knob resolution and the per-symbol capability/floor validation are
  // IDENTICAL between the two paths — only the request shape (one call, many symbol blocks) and
  // response fan-out differ. Resolves (never rejects) for every outcome propose() would also resolve
  // for (soft holds: refusal, a malformed/missing element); only a genuine whole-call transport/HTTP/
  // schema failure throws, so the caller (BatchingAgentClient) can reject every waiting promise with
  // the SAME error class propose() would throw for the equivalent single-symbol failure.
  async proposeBatch(
    inputs: readonly AgentDecisionInput[],
    opts: AgentProposeBatchOptions = {},
  ): Promise<AgentProposeBatchResult> {
    if (inputs.length === 0) return { proposals: new Map() };
    const latched = this.latchRationale(Date.now());
    if (latched !== null) {
      return {
        proposals: new Map<string, AgentProposal>(
          inputs.map((i) => [
            String(i.trigger.event.symbol),
            { signals: [], decision: AnthropicAgentClient.latchedDecision(latched) },
          ]),
        ),
      };
    }

    const ctx = await this.prepareDecideContext();
    // I1b: ONE provider call for the WHOLE batch (Design § Enriched model inputs: "rendered once per
    // batch") — portfolio/budget/calendar/venueFreeCash are batch-wide book state, never per-symbol;
    // calling this per resolved element would render N identical copies of the same snapshot and
    // waste tokens.
    const payloadExtras = await this.cfg.payloadExtrasProvider?.();
    // ...which is exactly what happened anyway until 2026-07-30: the ONE extras object was spread
    // into EVERY symbol element below, so the batch paid for N copies of the same portfolio/budget/
    // calendar/execQuality/fundingAccrualQuote blocks. They now ride in a single shared block ahead
    // of the symbol blocks (see sharedExtras/sharedPayload below), and buildMarketPayload's
    // omitShared drops precisely them from each element.
    const sharedExtras: BuildMarketPayloadExtras = {
      ...payloadExtras,
      ...AnthropicAgentClient.laneWideFeedBlocks(inputs),
    };
    const sharedPayload = buildSharedPayload(sharedExtras);

    interface ResolvedInput {
      readonly symbolKey: string;
      readonly symbolId: SymbolId;
      readonly input: AgentDecisionInput;
      readonly venue: VenueId;
      readonly refPrice: Price;
      readonly basedOnSeq: bigint;
      readonly eventTime: EpochMs;
      readonly lastCandle: CandleEvent | undefined;
      // The FULL render — journalled on AgentProposal.inputPayload, never sent.
      readonly inputPayload: string;
      // The same render minus the shared block's keys — sent, never journalled.
      readonly wirePayload: string;
      // v3 consolidation spec §4.2: this element's own symbol capability facts — computed once here
      // (not re-derived per parse) so both the portfolio-tool builder and the per-element capability
      // check below read the SAME object.
      readonly caps: SymbolCapabilities;
    }
    const resolved: ResolvedInput[] = [];
    const proposals = new Map<string, AgentProposal>();
    for (const input of inputs) {
      const symbolId = input.trigger.event.symbol;
      const symbolKey = String(symbolId);
      const tickerEvt = input.snapshot.tickers.get(symbolId);
      const candles = input.snapshot.candles.get(symbolId) ?? [];
      const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
      let refPrice: Price;
      let basedOnSeq: bigint;
      if (tickerEvt) {
        refPrice = tickerEvt.last;
        basedOnSeq = tickerEvt.seq;
      } else if (lastCandle) {
        refPrice = lastCandle.close;
        basedOnSeq = lastCandle.seq;
      } else {
        // No usable ref price — mirrors propose()'s own early `{ signals: [] }` return; this symbol
        // never enters the HTTP request (nothing useful to ask the model about it).
        proposals.set(symbolKey, { signals: [] });
        continue;
      }
      const eventTime =
        input.trigger.kind === 'candle' ? input.trigger.event.closeTime : input.snapshot.eventTime;
      const constraints = this.cfg.constraintsFor?.(symbolKey) ?? ctx.baseProfile.constraints;
      const caps = this.capabilitiesFor(symbolId, payloadExtras?.venueFreeCash);
      // R2: retrieval is PER-SYMBOL (regime is per-symbol, unlike the batch-wide payloadExtras above)
      // — one indexed journal read per element, never an API call.
      const similarSetups = await this.resolveSimilarSetups(input);
      const elementExtras: BuildMarketPayloadExtras = {
        constraints,
        derivativesV2Enabled: ctx.derivativesV2Enabled,
        bookStructureEnabled: this.cfg.bookStructureFeedEnabled ?? false,
        // I1b: the ONE batch-wide payloadExtras computed above, stamped on every element the same
        // way consultId/nextConsultBars already are — plus THIS element's own position-summary
        // thesis/directives and capabilities (per-symbol, unlike portfolio/budget/calendar).
        ...sharedExtras,
        capabilities: caps,
        // Per-symbol (see AgentPayloadExtras.fundingAccrualBySymbol): it rode in the shared block
        // until 2026-08-03, which stated one symbol's accrual as a fact of every symbol in the batch.
        fundingAccrualQuote: payloadExtras?.fundingAccrualBySymbol?.get(symbolId),
        similarSetups,
        currentThesis: input.context?.position.currentThesis,
        directives: input.context?.position.directives,
        barsHeld: input.context?.position.barsHeld,
        barsUntilForcedExit: input.context?.position.barsUntilForcedExit,
      };
      // TWO pure string builds off the SAME extras — no I/O, no second provider call, nothing that
      // can observe a different world between them, so the wire copy and the journalled copy cannot
      // drift. The FULL render is what AgentProposal.inputPayload carries: the journal keeps every
      // block it carried before the shared-block split, so the frozen corpus stays self-comparable
      // and the replay harnesses (entry-rate-floor.ts, candidate-backtest.ts) keep seeing whole rows.
      const inputPayload = buildMarketPayload(input, elementExtras);
      const wirePayload = buildMarketPayload(input, elementExtras, { omitShared: true });
      resolved.push({
        symbolKey,
        symbolId,
        input,
        venue: input.trigger.event.venue,
        refPrice,
        basedOnSeq,
        eventTime,
        lastCandle,
        inputPayload,
        wirePayload,
        caps,
      });
    }

    if (resolved.length === 0) return { proposals };

    // One consultId per batched call, stamped on EVERY resulting proposal below (including
    // degraded-to-hold elements — the row still belongs to the batch) so offline cost/attribution
    // analytics can join the N per-symbol journal rows this one call produced. Minted here (not
    // earlier) — the symbols that never reached `resolved` (no ref price) never entered the batch's
    // HTTP request, so they carry no consultId, matching promptHash/latencyMs's own
    // absent-when-no-call convention.
    const consultId = randomUUID();

    // v3 consolidation spec §4.3: ONE portfolio tool, and (2026-07-30) one BYTE-IDENTICAL portfolio
    // tool — the batch composition no longer varies it at all. Each resolved symbol's own
    // capabilities (venue/shorts/leverage/maxSizeFraction/venueFreeCash) reach the model through its
    // own payload block instead, which is also the only copy the zod capability check enforces
    // against. No shorts/tradeContract lane branching, no separate portfolio-vs-single template tag:
    // toolSchemaJson (below) already distinguishes submit_trade from submit_portfolio structurally.
    const portfolioTool = buildTradePortfolioTool();

    const promptHash = computePromptHash({
      templateVersion:
        ctx.feedTags.length > 0
          ? `${ctx.baseTemplateVersion}+${ctx.feedTags.join('+')}`
          : ctx.baseTemplateVersion,
      playbookContent: ctx.playbookContent ?? '',
      toolSchemaJson: JSON.stringify(portfolioTool),
      modelId: this.cfg.model,
    });

    // Each resolved symbol's own market JSON rides as its own uncached text block (mirrors
    // propose()'s single uncached block); the playbook (when present) still rides in its own
    // cache_control block ahead of them, so the tools+system+playbook prefix stays identical to the
    // single-symbol path's cache shape — only the volatile per-symbol blocks multiply with the batch.
    const playbookBlock = ctx.playbookContent
      ? ({
          type: 'text',
          text: buildPlaybookBlock(ctx.playbookContent),
          cache_control: EPHEMERAL_1H,
        } satisfies AnthropicTextBlock)
      : undefined;
    // The batch-wide blocks, sent ONCE. Placed AFTER the playbook block deliberately: the playbook is
    // the cache_control prefix and every recorded eval row was generated with it first, so moving it
    // would replay the frozen corpus under a composition it was never produced under. Uncached like
    // the symbol blocks — portfolio/budget change every wave, so a cache breakpoint here would only
    // buy write cost.
    const sharedBlock: AnthropicTextBlock | undefined = sharedPayload
      ? {
          type: 'text',
          text: `${playbookBlock ? '\n\n' : ''}Batch-wide context — these facts apply to EVERY symbol below and are stated once instead of being repeated in each symbol block:\n${sharedPayload}`,
        }
      : undefined;
    const symbolBlocks: AnthropicTextBlock[] = resolved.map((r, i) => ({
      type: 'text',
      text: `${i === 0 && !playbookBlock && !sharedBlock ? '' : '\n\n'}Symbol ${i + 1} of ${resolved.length} (${r.symbolKey}):\n${r.wirePayload}`,
    }));
    // H5 (2026-07-27): 8/57 live schema rejections were `decisions` missing entirely, 11 more were a
    // resolved symbol absent from it — a per-call reminder, not just the tool's own (cached-adjacent,
    // stable) description text, closes both. Rides UNCACHED alongside the volatile symbolBlocks
    // (never cache_control) so it costs no prompt-cache invalidation; no cache_control field on this
    // block, same convention as symbolBlocks above.
    const completenessBlock: AnthropicTextBlock = {
      type: 'text',
      text: `\n\nThe decisions array must contain exactly one entry per symbol listed above (${resolved.map((r) => r.symbolKey).join(', ')}), matched by its exact symbol string — including an explicit "hold" entry for any symbol you are not acting on. Never omit a listed symbol.`,
    };
    const userContent: AnthropicTextBlock[] = [
      ...(playbookBlock ? [playbookBlock] : []),
      ...(sharedBlock ? [sharedBlock] : []),
      ...symbolBlocks,
      completenessBlock,
    ];

    const timeoutMs = opts.timeoutMsOverride ?? this.cfg.timeoutMs;
    const started = Date.now();
    const res = await this.attemptWithRetry(
      ctx.systemPrompt,
      userContent,
      portfolioTool,
      timeoutMs,
      ctx.thinkingArm ? { type: 'adaptive' } : { type: 'disabled' },
    );
    const latencyMs = Date.now() - started;

    const body: unknown = await res.json();
    const envelope = anthropicResponseSchema.safeParse(body);
    if (!envelope.success) {
      // Post-200 schema failure: SOFT-HOLD every symbol, never throw (enable-gate review must-fix).
      // The single-symbol path soft-holds these exact modes — throwing here would convert a bursty
      // API-overload 200 into a strike on EVERY strategy in the batch simultaneously and
      // auto-DRAIN the whole lane in correlation. Transport/HTTP failures still throw (true parity:
      // the single path throws those too, via attemptWithRetry above).
      this.logger.warn(
        'anthropic api: malformed response envelope (portfolio batch) — holding all',
      );
      return this.softHoldBatch(
        resolved,
        undefined,
        latencyMs,
        ctx.playbookVersion,
        promptHash,
        consultId,
        ctx.infoArm,
        ctx.thinkingArm,
        // H4: named degrade on every resolved symbol — see the single-symbol malformed-envelope
        // branch above for why a decision-less hold is a masked failure mode.
        {
          action: 'hold',
          confidence: 0,
          rationale:
            'envelope_malformed: anthropic response failed envelope validation (portfolio batch)',
        },
      );
    }
    const usage = envelope.data.usage
      ? {
          inputTokens: envelope.data.usage.input_tokens,
          outputTokens: envelope.data.usage.output_tokens,
          cacheCreationInputTokens: envelope.data.usage.cache_creation_input_tokens,
          cacheReadInputTokens: envelope.data.usage.cache_read_input_tokens,
        }
      : undefined;

    // A refusal is a well-formed response, just a decline — the same soft-hold shape propose() gives
    // a single symbol, generalized across the batch (usage still attaches to the FIRST resolved
    // symbol only, mirroring the per-symbol loop below).
    if (envelope.data.stop_reason === 'refusal') {
      this.logger.warn('anthropic api: model refused to decide (portfolio batch)');
      return this.softHoldBatch(
        resolved,
        usage,
        latencyMs,
        ctx.playbookVersion,
        promptHash,
        consultId,
        ctx.infoArm,
        ctx.thinkingArm,
        // WATCH-V4-8: this was the last soft-hold branch H4 left decision-less, and the omission was
        // load-bearing twice over — the row persisted byte-identical to a genuine model hold, and the
        // liveness predicate (which excludes degrades by their rationale tag) had nothing to read, so a
        // permanently refusing model would have kept the staleness gauge fresh. Same tag the
        // single-symbol path stamps.
        {
          action: 'hold',
          confidence: 0,
          rationale:
            'model_refusal: model declined to decide (stop_reason=refusal, portfolio batch)',
        },
      );
    }

    const toolBlock = envelope.data.content?.find(
      (b) => b.type === 'tool_use' && b.name === portfolioTool.name,
    );
    if (!toolBlock) {
      // 2026-07-31: batch is the DEPLOYED shape (AGENTIC_PORTFOLIO_CONSULT=true, see
      // prepareDecideContext) — the H4 comment this replaces claimed the batch path had no
      // truncated_max_tokens variant, which meant the MORE direct batch truncation (max_tokens with no
      // tool block at all) stayed invisible to `WHERE rationale LIKE 'truncated_max_tokens:%'` and
      // under-counted the very truncation rate this tag exists to measure. Mirrors the single-symbol
      // propose()'s own `!toolBlock` branch's stop_reason==='max_tokens' distinction exactly (same
      // XA4 discipline), fails OPEN to the prior no_tool_use: tag for any other/missing stop_reason.
      let rationale: string;
      if (envelope.data.stop_reason === 'max_tokens') {
        this.logger.warn(
          `anthropic api: response truncated at max_tokens before a ${portfolioTool.name} tool_use ` +
            `block (portfolio batch, output_tokens=${usage?.outputTokens ?? 'unknown'}) — holding all; raise AGENTIC_MAX_TOKENS if frequent`,
        );
        rationale = `truncated_max_tokens: response truncated at max_tokens before a ${portfolioTool.name} tool_use block (portfolio batch, output_tokens=${usage?.outputTokens ?? 'unknown'})`;
      } else {
        this.logger.warn(
          `anthropic api: no ${portfolioTool.name} tool_use block in response (portfolio batch) — holding all`,
        );
        rationale = `no_tool_use: no ${portfolioTool.name} tool_use block in response (portfolio batch)`;
      }
      return this.softHoldBatch(
        resolved,
        usage,
        latencyMs,
        ctx.playbookVersion,
        promptHash,
        consultId,
        ctx.infoArm,
        ctx.thinkingArm,
        { action: 'hold', confidence: 0, rationale },
      );
    }

    let tradePortfolioParsed = tradePortfolioSchema.safeParse(toolBlock.input);
    if (!tradePortfolioParsed.success) {
      // Pass 64: a top-level parse failure used to discard EVERY decision in the batch even though
      // tradePortfolioSchema declares `decisions: z.array(z.unknown())` precisely so a malformed
      // INDIVIDUAL element degrades only that symbol via the per-element loop below — a top-level
      // failure returned above that loop and never got the chance. One observed live failure mode:
      // the model emits `decisions` as a JSON-STRING instead of an array. Revive it and re-parse with
      // the SAME unchanged tradePortfolioSchema.
      //
      // FAILURE DIRECTION — CLOSED: an unparseable string, a non-array revival, or a still-failing
      // re-parse all fall straight through to the discard branch below unchanged. This can only ever
      // promote a hold-everything case into the normal per-element tradeElementSchema/open_short
      // validation path below — it can never let an element bypass either.
      const rawInput = toolBlock.input;
      if (
        rawInput !== null &&
        typeof rawInput === 'object' &&
        typeof (rawInput as Record<string, unknown>).decisions === 'string'
      ) {
        try {
          const revivedDecisions: unknown = JSON.parse(
            (rawInput as Record<string, unknown>).decisions as string,
          );
          if (Array.isArray(revivedDecisions)) {
            const recovered = tradePortfolioSchema.safeParse({
              ...(rawInput as Record<string, unknown>),
              decisions: revivedDecisions,
            });
            if (recovered.success) {
              this.cfg.recordSchemaFailure?.('batch_stringified_recovered');
              tradePortfolioParsed = recovered;
            }
          }
        } catch {
          // Unparseable JSON string (e.g. the model's own thesis text broke quoting mid-array) —
          // falls through to the discard branch below unchanged.
        }
      }
    }
    if (!tradePortfolioParsed.success) {
      // Soft-hold like the malformed-envelope path above, but a SCHEMA failure (not a missing tool
      // block): meter it and stamp an explicit schema_rejected (or, if stop_reason=max_tokens,
      // truncated_max_tokens — see schemaFailureRationale) hold decision so the degrade is queryable
      // in the journal — the malformed-envelope path above does neither.
      this.cfg.recordSchemaFailure?.('batch');
      this.logger.warn(
        `anthropic api: ${portfolioTool.name} payload failed schema validation (portfolio batch) — holding all — ${describeSchemaFailure(tradePortfolioParsed.error, toolBlock.input)}`,
      );
      // Pass 64: the whole-batch discard used to throw away the model's OWN nextConsultBars along
      // with everything else, resetting every symbol's schedule to the 8-bar forced_fallback cadence
      // (agentic.strategy.ts:981 reads `proposal.nextConsultBars ?? null`). Extract it alone with a
      // schema narrower than tradePortfolioSchema so it can survive even when `decisions` is what
      // actually failed. It is a scheduling knob only, already bounded by
      // DECISION_V2_BOUNDS.nextConsultBars — it cannot open, size, or close a position and never
      // reaches Risk.
      //
      // FAILURE DIRECTION — OPEN toward a SOONER consult only: a recovered schedule can never widen
      // the post-degrade blind window beyond AGENTIC_FALLBACK_CONSULT_BARS. The payload whose
      // `decisions` the schema just rejected is not one this client trusts to EXTEND the consult
      // gap, so the recovered value is clamped to at most cfg.fallbackConsultBars (Math.min below) —
      // it can only shrink today's forced-fallback cadence, when the model's own request asked to be
      // consulted sooner, never stretch it. Absent/invalid recovery still omits the field entirely —
      // today's exact fallback behaviour, unchanged.
      const recoveredNextConsultBars = nextConsultBarsOnlySchema.safeParse(toolBlock.input);
      const fallbackConsultBars = this.cfg.fallbackConsultBars ?? DEFAULT_FALLBACK_CONSULT_BARS;
      return this.softHoldBatch(
        resolved,
        usage,
        latencyMs,
        ctx.playbookVersion,
        promptHash,
        consultId,
        ctx.infoArm,
        ctx.thinkingArm,
        {
          action: 'hold',
          confidence: 0,
          rationale: schemaFailureRationale(
            envelope.data.stop_reason,
            firstIssueSummary(tradePortfolioParsed.error),
            toolBlock.input,
          ),
        },
        recoveredNextConsultBars.success
          ? Math.min(recoveredNextConsultBars.data.nextConsultBars, fallbackConsultBars)
          : undefined,
      );
    }
    const { nextConsultBars } = tradePortfolioParsed.data;
    const bySymbolTrade = new Map<string, unknown>();
    for (const raw of tradePortfolioParsed.data.decisions) {
      const symbolField = elementSymbolSchema.safeParse(raw);
      if (symbolField.success) bySymbolTrade.set(symbolField.data.symbol, raw);
    }

    resolved.forEach((r, i) => {
      const usageForThis = i === 0 ? usage : undefined;
      const raw = bySymbolTrade.get(r.symbolKey);
      if (raw === undefined) {
        this.cfg.recordSchemaFailure?.('missing_symbol');
        this.logger.warn(
          `anthropic api: symbol ${r.symbolKey} missing from ${portfolioTool.name} decisions — holding`,
        );
        proposals.set(r.symbolKey, {
          signals: [],
          decision: {
            action: 'hold',
            confidence: 0,
            rationale: schemaRejectedRationale(
              `symbol ${r.symbolKey} missing from ${portfolioTool.name} decisions`,
            ),
          },
          ...(usageForThis ? { usage: usageForThis } : {}),
          latencyMs,
          playbookVersion: ctx.playbookVersion,
          promptHash,
          inputPayload: r.inputPayload,
          consultId,
          nextConsultBars,
          infoArm: ctx.infoArm,
          thinkingArm: ctx.thinkingArm,
        });
        return;
      }
      // sizeFractionMax is THIS element's own symbol's capabilities.maxSizeFraction — spot/perp caps
      // can differ within the SAME batch, so the schema is built per element, never once per batch.
      // eslint-disable-next-line no-restricted-syntax -- Number() is the correct non-money coercion here.
      const maxSizeFractionNum = Number(r.caps.maxSizeFraction);
      const parsedElement = tradeElementSchema(maxSizeFractionNum).safeParse(raw);
      if (!parsedElement.success) {
        this.cfg.recordSchemaFailure?.('element');
        this.logger.warn(
          `anthropic api: ${portfolioTool.name} element for symbol ${r.symbolKey} failed schema validation — holding — ${describeSchemaFailure(parsedElement.error, raw)}`,
        );
        proposals.set(r.symbolKey, {
          signals: [],
          decision: {
            action: 'hold',
            confidence: 0,
            rationale: schemaRejectedRationale(firstIssueSummary(parsedElement.error)),
          },
          ...(usageForThis ? { usage: usageForThis } : {}),
          latencyMs,
          playbookVersion: ctx.playbookVersion,
          promptHash,
          inputPayload: r.inputPayload,
          consultId,
          nextConsultBars,
          infoArm: ctx.infoArm,
          thinkingArm: ctx.thinkingArm,
        });
        return;
      }
      // v3 consolidation spec §4.3: capability-violation degrade, per element — see propose()'s own
      // comment on this exact check for the full rationale (hold + 'error' journal action + the
      // capability_violation: rationale prefix + the composition-root metric).
      if (parsedElement.data.action === 'open_short' && !r.caps.shorts) {
        this.cfg.recordCapabilityViolation?.('open_short_on_spot');
        this.logger.warn(
          `agentic capability violation: open_short proposed for symbol ${r.symbolKey} whose capabilities.shorts is false — degraded to hold`,
        );
        proposals.set(r.symbolKey, {
          signals: [],
          decision: {
            action: 'error',
            confidence: null,
            rationale: 'capability_violation:open_short_on_spot',
          },
          ...(usageForThis ? { usage: usageForThis } : {}),
          latencyMs,
          playbookVersion: ctx.playbookVersion,
          promptHash,
          inputPayload: r.inputPayload,
          consultId,
          nextConsultBars,
          infoArm: ctx.infoArm,
          thinkingArm: ctx.thinkingArm,
        });
        return;
      }
      const proposal = this.buildProposalFromTradeDecision({
        input: r.input,
        symbol: r.symbolId,
        venue: r.venue,
        refPrice: r.refPrice,
        basedOnSeq: r.basedOnSeq,
        eventTime: r.eventTime,
        lastCandle: r.lastCandle,
        decision: parsedElement.data,
        usage: usageForThis,
        latencyMs,
        playbookVersion: ctx.playbookVersion,
        promptHash,
        inputPayload: r.inputPayload,
        consultId,
        infoArm: ctx.infoArm,
        thinkingArm: ctx.thinkingArm,
      });
      // Stamped on EVERY returned proposal (Design table: "portfolio-level, one per batch
      // response") — including a fee-floor-rejected element, whose own mapping already returns
      // without a nextConsultBars of its own.
      proposals.set(r.symbolKey, { ...proposal, nextConsultBars });
    });

    return { proposals, usage };
  }

  // Enable-gate review must-fix: the whole-batch POST-200 schema-failure paths (malformed
  // envelope, missing tool block, payload schema fail) SOFT-HOLD every symbol exactly like the
  // single-symbol path does for the same modes — a throw here would strike every strategy in the
  // batch simultaneously (strategy-host counts a rejected decide toward auto-DRAIN) and turn one
  // bursty API-overload 200 into a correlated lane-wide drain. Usage (when parseable) attaches to
  // the first resolved symbol only, preserving the absent-vs-zero convention.
  private softHoldBatch(
    resolved: ReadonlyArray<{ readonly symbolKey: string; readonly inputPayload: string }>,
    usage: AgentUsage | undefined,
    latencyMs: number,
    playbookVersion: number | undefined,
    promptHash: string,
    consultId: string,
    infoArm: boolean,
    thinkingArm: boolean,
    // 2026-07-22 schema-hardening: stamped on EVERY resolved symbol, since a whole-batch degrade
    // routes every symbol through this ONE soft-hold as a unit. Every caller now passes a tag (H4
    // named the malformed-envelope/missing-tool-block ones, WATCH-V4-8 the refusal) — the parameter
    // stays optional only so a future caller with no diagnosis to offer is not forced to invent one.
    decision?: AgentDecisionMeta,
    // Pass 64: the model's own portfolio-level nextConsultBars, when the caller could still extract
    // one from an otherwise-discarded payload — see the whole-batch schema-failure call site's own
    // comment. Absent ⇒ omitted from every proposal, unchanged from pre-Pass-64 behaviour (the
    // envelope-malformed/missing-tool-block/refusal callers have no parseable input to extract from
    // and never pass this).
    nextConsultBars?: number,
  ): AgentProposeBatchResult {
    const proposals = new Map<string, AgentProposal>();
    resolved.forEach((r, i) => {
      proposals.set(r.symbolKey, {
        signals: [],
        ...(decision ? { decision } : {}),
        ...(i === 0 && usage ? { usage } : {}),
        latencyMs,
        playbookVersion,
        promptHash,
        inputPayload: r.inputPayload,
        consultId,
        ...(nextConsultBars !== undefined ? { nextConsultBars } : {}),
        infoArm,
        thinkingArm,
      });
    });
    return { proposals, usage };
  }

  // Shared decide-time context: playbook resolution, the information-context A/B control-arm
  // bucket, the resulting system prompt/tool/template tags. IDENTICAL computation for propose() (one
  // symbol) and proposeBatch() (called ONCE per batch — the A/B arm and playbook read are hoisted to
  // the whole batch rather than re-resolved per symbol, per the batching design).
  private async prepareDecideContext(): Promise<{
    readonly playbookContent: string | undefined;
    readonly playbookVersion: number | undefined;
    readonly baseProfile: AgentTradingProfile;
    readonly systemPrompt: string;
    readonly baseTemplateVersion: string;
    readonly feedTags: readonly string[];
    readonly infoArm: boolean;
    readonly thinkingArm: boolean;
    readonly derivativesV2Enabled: boolean;
  }> {
    const { content: playbookContent, version: playbookVersion } = await this.resolvePlaybook();
    const baseProfile = this.cfg.profile ?? DEFAULT_TRADING_PROFILE;

    // v3 consolidation spec §9: the information-context control arm (derivativesControlArm) and its
    // AGENTIC_DERIVATIVES_AB_PCT knob are DELETED — XA3 retired the control arm at 0 permanently
    // (treatment drove 8.4% vs 1.9% proposes), so every info-context feed flag below now applies
    // UNCONDITIONALLY. infoArm is stamped `true` on every proposal (mirrors thinkingArm's own
    // always-true precedent right below) purely so AgentProposal.infoArm's shape survives for any
    // downstream reader — it is telemetry describing a retired experiment's polarity, never a live
    // A/B any more.
    const infoArm = true;
    // S3: thinking A/B (#42) retired — every decide/batch call now carries thinking:{type:'adaptive'}
    // unconditionally (Design § Deleted/replaced scaffolding: "Thinking enabled always on decide
    // (adaptive) ... thinking A/B arm retired"). thinkingArm stays a real field (no longer a coin
    // flip) purely so AgentProposal.thinkingArm/journal stamping and the '+th1' promptHash tag below
    // stay byte-identical in shape to pre-S3 — every caller of ctx.thinkingArm downstream is
    // unaffected by this simplification.
    const thinkingArm = true;
    const derivativesFeedEnabled = this.cfg.derivativesFeedEnabled ?? false;
    const derivativesV2Enabled = derivativesFeedEnabled && (this.cfg.derivativesV2Enabled ?? false);
    // v5: constraints no longer render into the system prompt (they ride the payload below), so the
    // cached tools+system prefix is byte-identical across all symbols this shared client serves —
    // and, for the batch path, across every symbol in the SAME batch too. v3: shorts/leverage are no
    // longer a system-prompt flag either (per-symbol capability now, always documented — see
    // buildSystemPrompt's own comment).
    const systemPrompt = buildSystemPrompt(baseProfile, {
      derivativesFeedEnabled,
      derivativesV2Enabled,
      fundingHistoryFeedEnabled: this.cfg.fundingHistoryFeedEnabled ?? false,
      sentimentFeedEnabled: this.cfg.sentimentFeedEnabled ?? false,
      fearGreedFeedEnabled: this.cfg.fearGreedFeedEnabled ?? false,
      crossSymbolFeedEnabled: this.cfg.crossSymbolFeedEnabled ?? false,
      tradeFlowFeedEnabled: this.cfg.tradeFlowFeedEnabled ?? false,
      positioningFeedEnabled: this.cfg.positioningFeedEnabled ?? false,
      liquidationsFeedEnabled: this.cfg.liquidationsFeedEnabled ?? false,
      bookStructureFeedEnabled: this.cfg.bookStructureFeedEnabled ?? false,
      trackRecordFeedEnabled: this.cfg.trackRecordFeedEnabled ?? false,
      edgePolicyFeedEnabled: this.cfg.edgePolicyFeedEnabled ?? false,
      episodicMemoryEnabled: this.cfg.episodicMemoryEnabled ?? false,
    });
    // v3 consolidation spec §4.4: ONE tag family (TRADE_TEMPLATE_VERSION = 'v3') — no more
    // tradeContract/planMode/shortsEnabled branching (see agent-prompt.ts's own comment on why the
    // lane-split tags collapsed).
    const baseTemplateVersion = TRADE_TEMPLATE_VERSION;
    // Flag-ON appends the corresponding system-prompt sentence, so it is a distinct template for
    // attribution purposes; flag-OFF hashes are byte-identical. All flags stack in a fixed order so a
    // multi-flag hash is deterministic regardless of which flag flipped first.
    const feedTags = [
      // d2: a SWITCH within the same slot (never `+d1+d2` stacked) — see DERIVATIVES_V2_TEMPLATE_
      // VERSION's own comment.
      ...(derivativesFeedEnabled
        ? [derivativesV2Enabled ? DERIVATIVES_V2_TEMPLATE_VERSION : DERIVATIVES_TEMPLATE_VERSION]
        : []),
      ...(this.cfg.fundingHistoryFeedEnabled ? [FUNDING_HISTORY_TEMPLATE_VERSION] : []),
      ...(this.cfg.sentimentFeedEnabled ? [SENTIMENT_TEMPLATE_VERSION] : []),
      ...(this.cfg.fearGreedFeedEnabled ? [FEAR_GREED_TEMPLATE_VERSION] : []),
      ...(this.cfg.crossSymbolFeedEnabled ? [CROSS_SYMBOL_TEMPLATE_VERSION] : []),
      ...(this.cfg.tradeFlowFeedEnabled ? [TRADEFLOW_TEMPLATE_VERSION] : []),
      ...(this.cfg.positioningFeedEnabled ? [POSITIONING_TEMPLATE_VERSION] : []),
      ...(this.cfg.liquidationsFeedEnabled ? [LIQUIDATION_TEMPLATE_VERSION] : []),
      ...(this.cfg.bookStructureFeedEnabled ? [BOOK_STRUCTURE_TEMPLATE_VERSION] : []),
      ...(this.cfg.trackRecordFeedEnabled ? [TRACK_RECORD_TEMPLATE_VERSION] : []),
      ...(this.cfg.edgePolicyFeedEnabled ? [EDGE_POLICY_TEMPLATE_VERSION] : []),
      // R2: a pure journal read (no external feed), so — like bs1/tr1 — it does NOT ride the
      // (now-retired) information-context control arm; tagged only by the episodicMemoryEnabled flag.
      ...(this.cfg.episodicMemoryEnabled ? [MEMORY_TEMPLATE_VERSION] : []),
      // #42: last slot by design — a REQUEST-param arm, not a prompt-content tag; see above.
      ...(thinkingArm ? [THINKING_TEMPLATE_VERSION] : []),
      // 2026-08-03: the other two REQUEST-param levers, stacking after th1 for the same reason it
      // sits last. Composed here (not at the two computePromptHash call sites) so the single-symbol
      // and batch hashes cannot disagree about what the request actually carried. Both are silent at
      // the shipped defaults — outputEffort unset and maxTokens at PROMPT_HASH_BASELINE_MAX_TOKENS
      // produce zero tags, so today's live hashes are byte-identical to pre-tag.
      ...(this.cfg.outputEffort
        ? [`${OUTPUT_EFFORT_TEMPLATE_PREFIX}${this.cfg.outputEffort}`]
        : []),
      ...(this.cfg.maxTokens !== PROMPT_HASH_BASELINE_MAX_TOKENS
        ? [`${MAX_TOKENS_TEMPLATE_PREFIX}${this.cfg.maxTokens}`]
        : []),
    ];

    return {
      playbookContent,
      playbookVersion,
      baseProfile,
      systemPrompt,
      baseTemplateVersion,
      feedTags,
      infoArm,
      thinkingArm,
      derivativesV2Enabled,
    };
  }

  // R2 episodic-memory retrieval for ONE symbol's payload: derive the current regime tags (pure) from
  // the decision input, query the journal seam for matching past setups, and render the token-bounded
  // block. Returns undefined (⇒ the similarSetups key is omitted) when retrieval is unwired, the regime
  // is untaggable (indicators under warmup), or nothing matched — a fail-open measurement that never
  // blocks or alters a decision, and never issues an LLM/API call. Regime is derived from the ORIGINAL
  // input (not the info-arm-stripped payload copy) so a setup's fingerprint reflects the true market
  // regime independent of the information-context A/B experiment, and matches the WRITE-side tag
  // agentic.strategy.ts stamps from the same input fields.
  private async resolveSimilarSetups(input: AgentDecisionInput): Promise<string | undefined> {
    if (!this.cfg.similarSetupsProvider) return undefined;
    const tags = deriveRegimeTags({
      indicators: input.context?.indicators ?? null,
      fundingRate: input.snapshot.derivatives?.fundingRate ?? null,
      eventTime: input.snapshot.eventTime,
    });
    if (tags === null) return undefined;
    const rows = await this.cfg.similarSetupsProvider(tags);
    return renderSimilarSetups(rows, tags) ?? undefined;
  }

  // v3 consolidation spec §9: the legacy submit_decision/submit_plan mapping (buildProposalFromDecision)
  // is DELETED — buildProposalFromTradeDecision below is the ONE per-symbol proposal-mapping tail,
  // shared by propose() (one symbol) and proposeBatch() (once per resolved decisions[] element).
  private buildProposalFromTradeDecision(params: {
    readonly input: AgentDecisionInput;
    readonly symbol: SymbolId;
    readonly venue: VenueId;
    readonly refPrice: Price;
    readonly basedOnSeq: bigint;
    readonly eventTime: EpochMs;
    readonly lastCandle: CandleEvent | undefined;
    readonly decision: TradeDecisionV2;
    readonly usage: AgentUsage | undefined;
    readonly latencyMs: number;
    readonly playbookVersion: number | undefined;
    readonly promptHash: string;
    readonly inputPayload: string;
    readonly consultId?: string;
    readonly infoArm: boolean;
    readonly thinkingArm: boolean;
  }): AgentProposal {
    const {
      input,
      symbol,
      venue,
      refPrice,
      basedOnSeq,
      eventTime,
      lastCandle,
      decision,
      usage,
      latencyMs,
      playbookVersion,
      promptHash,
      inputPayload,
      consultId,
      infoArm,
      thinkingArm,
    } = params;
    const { action, thesis } = decision;
    const side = input.context?.position.side ?? 'FLAT';

    const common = {
      strategyId: input.strategyId,
      venue,
      symbol,
      refPrice,
      basedOnSeq,
      eventTime,
      ttlMs: this.cfg.signalTtlMs,
      dedupeKey: `${input.strategyId}:${symbol}:agentic:${action}:${eventTime}`,
      // Same MAX_REASON_LEN truncation legacy Signal.reason uses — the ring-truncation convention
      // (see that const's own comment) applies identically to a v2 thesis.
      reason: (thesis ?? '').slice(0, MAX_REASON_LEN),
    };

    // Full directive set present ⇒ a viable AgentDirectives can be constructed; absent on 'hold' and
    // on an 'adjust' that supplies only partialCloseFraction (schema permits a bare partial-close
    // revision — see requireTradeDirectives' own comment). Required by schema (superRefine) on
    // 'open_long'/'open_short', so always present in the fresh-open/scale-in branch below.
    const directives: AgentDirectives | undefined =
      decision.sizeFraction !== undefined &&
      decision.entry !== undefined &&
      decision.entryValidityBars !== undefined &&
      decision.stopLossPct !== undefined &&
      decision.takeProfitPct !== undefined &&
      decision.maxHoldBars !== undefined
        ? {
            sizeFraction: String(decision.sizeFraction),
            stopLossPct: String(decision.stopLossPct),
            takeProfitPct: String(decision.takeProfitPct),
            entryOffsetBps: decision.entry.offsetBps,
            entryValidityBars: decision.entryValidityBars,
            maxHoldBars: decision.maxHoldBars,
            entryStyle: decision.entry.style,
            // W4 audit (2026-07-18, CRITICAL): direction must ride the directives — absent means
            // 'long' per the ports contract, which inverted every deterministic protection on a
            // perp short (stop seeded on the profit side, EXIT_LONG for a short). Opens pin it;
            // an 'adjust' inherits the prior plan's direction in the strategy's merge.
            ...(action === 'open_long' || action === 'open_short'
              ? { direction: action === 'open_short' ? ('short' as const) : ('long' as const) }
              : side === 'SHORT'
                ? { direction: 'short' as const }
                : side === 'LONG'
                  ? { direction: 'long' as const }
                  : {}),
            ...(decision.partialCloseFraction !== undefined
              ? { partialCloseFraction: String(decision.partialCloseFraction) }
              : {}),
            ...(thesis !== undefined ? { thesis } : {}),
          }
        : undefined;

    // The one surviving economic gate (Design § Deleted/replaced scaffolding): a takeProfitPct that
    // cannot clear the round-trip fee fraction guarantees a loss even on a winning-direction trade.
    // Binds whenever a directive set carrying takeProfitPct is about to be adopted — a fresh open, a
    // scale-in, AND an 'adjust' that revises takeProfitPct — never on a bare partial-close (no
    // directives ⇒ nothing to floor-check) or on a no-op hold.
    if (directives !== undefined) {
      // Keyed on THIS symbol's own venue, not on the one static profile the system prompt renders:
      // that profile is built from the FIRST configured symbol (agentic-bridge.module.ts), so a
      // single venue's schedule was floor-checking a book that is 85% the other venue. The table
      // currently carries the same schedule for both venues, so this is arithmetically identical to
      // the profile read it replaces — see domain/trading/fees.ts for why the measured perp schedule
      // is a separate enable.
      const feeFraction = roundTripFeeFraction(venueForSymbol(symbol), this.cfg.feeSchedules);
      if (new Decimal(directives.takeProfitPct).lt(feeFraction)) {
        this.logger.warn(
          `trade rejected: takeProfitPct ${directives.takeProfitPct} below round-trip fee ${feeFraction.toFixed()}`,
        );
        return {
          signals: [],
          decision: {
            action,
            confidence: null,
            rationale: `[rejected: tp below fee floor]${thesis ? ` ${thesis}` : ''}`,
          },
          usage,
          latencyMs,
          playbookVersion,
          promptHash,
          inputPayload,
          ...(consultId ? { consultId } : {}),
          infoArm,
          thinkingArm,
        };
      }
    }

    let signals: Signal[] = [];
    let plan: AgentDirectives | undefined;
    // What actually gets journalled / handed to the strategy's plan bookkeeping. Diverges from the
    // model's own `action` only on the plan-authoritative close below.
    let journalAction: typeof action = action;
    let journalRationale = thesis ?? '';

    // Fresh entry (FLAT) or a same-side scale-in (already positioned) — both emit an ENTER signal
    // with fresh directives; the strategy owns restarting the maxHold clock on a scale-in (Design
    // table: "Scale-in ... clock restarts").
    const isFreshOrScaleIn =
      (action === 'open_long' && (side === 'FLAT' || side === 'LONG')) ||
      (action === 'open_short' && (side === 'FLAT' || side === 'SHORT'));
    // Opposite-side open_* while positioned: never an accidental flip — journal-visible hold, no
    // signal, no plan (Design table: "no accidental flips").
    const isOppositeOpen =
      (action === 'open_long' && side === 'SHORT') || (action === 'open_short' && side === 'LONG');

    if (isFreshOrScaleIn) {
      plan = directives;
      const isLong = action === 'open_long';
      signals = [
        {
          ...common,
          kind: isLong ? 'ENTER_LONG' : 'ENTER_SHORT',
          strength: 1,
          ...(decision.sizeFraction !== undefined
            ? { sizeFraction: String(decision.sizeFraction) }
            : {}),
          ...(directives !== undefined ? { stopLossPct: directives.stopLossPct } : {}),
          ...(decision.entry
            ? {
                limitPriceHint: this.tradeEntryLimitHint(
                  decision.entry,
                  isLong,
                  lastCandle,
                  refPrice,
                ),
              }
            : {}),
        },
      ];
    } else if (isOppositeOpen) {
      // no-op — signals/plan stay at their defaults ([]/undefined).
    } else if (action === 'close') {
      // ── AGENTIC_PLAN_AUTHORITATIVE_EXITS: the declared plan outranks a mid-trade 'close' ───────
      //
      // NOT A NEW EXIT RULE, and it does NOT reopen the settled exit-rule sweep. "No exit rule
      // rescues these entries" (verdicts.md § NO EXIT RULE RESCUES THESE ENTRIES, Pass 41; harness
      // test/backtest/exit-attribution.spec.ts over exit-simulator.ts) tested 16 alternative
      // GEOMETRY cells and found every one negative. This changes no geometry and no default — it
      // removes the model's discretion to deviate from the geometry it already declared itself.
      //
      // Measured basis, same 23 recorded round trips, paired by construction: Arm 1 (what the lane
      // actually did, discretionary closes included) −108.1 bps/trip at 17.4% hit; Arm 2 (the model's
      // OWN declared stopLossPct/takeProfitPct/maxHoldBars run mechanically, its 'close' ignored
      // entirely) −78.4 bps at 22.7%. Arm 2 is what this branch reproduces: +29.7 bps/trip. Under the
      // owner's 2026-07-30 two-bar ruling that is a RESEARCH-bar FAIL (verdicts.md:272 — "real, but
      // under the pre-registered 30 bps bar and nowhere near profitability") and a DEPLOYMENT-bar win
      // over what runs today. 16 of 22 live closes were the model's own hand, so the surface is real.
      //
      // Arm 2 honoured NO model 'close' at all — simulateExit only ever exits on stop / take-profit /
      // max_hold — so this drops the close outright rather than permitting it in some direction. This
      // must reproduce a measurement, not improve on it.
      //
      // Journalled as 'hold' (not 'close') on purpose: agentic.strategy.ts's plan bookkeeping clears
      // the active plan on a directive-less 'close'/'flat', and a cleared plan is exactly the
      // unmanaged position this gate exists to prevent. A directive-less 'hold' leaves activePlan
      // untouched. The model's intent survives in the rationale tag above.
      //
      // FAILURE DIRECTION — fails toward EXITING. This gate suppresses an exit, and an exit that
      // fails to fire leaves a position open against its own declared invalidation, so it may only
      // fire on POSITIVE evidence that a deterministic executor is already enforcing that
      // invalidation: `directives` is present exactly when the strategy holds an activePlan while
      // positioned (AgentPositionSummary.directives). No context, no directives, or FLAT ⇒ the close
      // executes unchanged. That evidence is strong: agentic.strategy.ts runs evaluatePlan BEFORE the
      // consult gate every bar and lets its stop/take_profit/max_hold verdict own the bar outright, so
      // a suppressed close can only ever happen on a bar where the declared plan itself said hold —
      // and AGENTIC_VENUE_STOP/_TP keep the stop and take-profit resting at the venue meanwhile.
      const enforcedDirectives =
        this.cfg.planAuthoritativeExits === true && (side === 'LONG' || side === 'SHORT')
          ? input.context?.position.directives
          : undefined;
      if (enforcedDirectives !== undefined) {
        journalAction = 'hold';
        journalRationale = planAuthoritativeCloseRationale(thesis);
        // Loud, and low-volume by construction (16 model closes over the 6-day measurement window).
        // A model that re-issues 'close' on the same unchanged position still trips agentic.strategy.
        // ts's XA5 repeated-noop breaker exactly as a repeated 'close' does today — the streak label
        // changes, the breaker does not, and plan enforcement continues while consults are suppressed.
        this.logger.warn(
          `close suppressed by declared plan: ${String(symbol)} ${side} stop=${enforcedDirectives.stopLossPct} ` +
            `tp=${enforcedDirectives.takeProfitPct} maxHold=${enforcedDirectives.maxHoldBars}`,
        );
      } else if (side === 'LONG') {
        signals = [{ ...common, kind: 'EXIT_LONG', strength: 1 }];
      } else if (side === 'SHORT') {
        signals = [{ ...common, kind: 'EXIT_SHORT', strength: 1 }];
      }
      // side === 'FLAT': nothing to close — journal-visible hold, defaults stand.
    } else if (action === 'adjust' && side !== 'FLAT') {
      // Directives (if the model supplied the full set) ride forward for the strategy to apply in
      // place (Design table: "the proposal always carries the updated directives (plan field) for
      // the strategy to apply in place").
      plan = directives;
      if (decision.partialCloseFraction !== undefined) {
        // Reduce-only partial close: mirrors the full-EXIT cancel-first discipline (Defect B #49) —
        // a resting venue TP/stop on the exit side would otherwise lock the base this reduce-only
        // order needs. cancelOrdersForSide (signal-sink.service.ts) is idempotent when nothing
        // rests, so this is safe to set unconditionally rather than requiring the client to know
        // whether an order is actually resting.
        const cancelSide = side === 'LONG' ? 'SELL' : 'BUY';
        signals = [
          {
            ...common,
            kind: side === 'LONG' ? 'EXIT_LONG' : 'EXIT_SHORT',
            strength: 1,
            reduceFraction: String(decision.partialCloseFraction),
            cancelBeforeSubmit: { side: cancelSide },
          },
        ];
      }
      // No partialCloseFraction: a directives-only revision — no signal, plan carries the update.
    } else if (action === 'hold' && side !== 'FLAT' && directives !== undefined) {
      // Restart re-arm (6e95542; restored after the v2 rewrite silently dropped this branch):
      // hold + full directive set while already LONG/SHORT arms plan-executor with NO signal —
      // no double entry, no accidental exit. FLAT holds never arm (a plan with no position would
      // only tick down to plan_expired). Entry fields are ignored by the strategy on this path;
      // stop/TP anchor to avgEntry on the first managed bar.
      plan = directives;
    }
    // 'hold' without directives, 'adjust' while FLAT, 'close' while FLAT: defaults stand.

    return {
      signals,
      decision: { action: journalAction, confidence: null, rationale: journalRationale },
      ...(plan ? { plan } : {}),
      usage,
      latencyMs,
      playbookVersion,
      promptHash,
      inputPayload,
      ...(consultId ? { consultId } : {}),
      infoArm,
      thinkingArm,
    };
  }

  // A1: entry pricing hint for a v2 open_long/open_short — 'maker' reuses the legacy plan-mode
  // formula (offset from the last CLOSED candle's close; falls back to refPrice when no candle is
  // available) over the wider [-150, 150]bps v2 range; 'taker' prices on the CROSSING side of
  // refPrice (BUY above, SELL below) so PositionSizerService.entryType's own marketable-side check
  // degrades a configured LIMIT_MAKER to plain LIMIT naturally (see TAKER_CROSS_BUFFER_BPS's own
  // comment) — the sizer never has to special-case entryStyle itself.
  private tradeEntryLimitHint(
    entry: { readonly style: 'maker' | 'taker'; readonly offsetBps: number },
    isLong: boolean,
    lastCandle: CandleEvent | undefined,
    refPrice: Price,
  ): Price {
    if (entry.style === 'maker') {
      const basePrice = lastCandle ? lastCandle.close : refPrice;
      const offsetFraction = new Decimal(entry.offsetBps).div(10_000);
      const raw = new Decimal(basePrice.toFixed())
        .mul(isLong ? new Decimal(1).minus(offsetFraction) : new Decimal(1).plus(offsetFraction))
        .toDecimalPlaces(8);
      return price(raw.toFixed());
    }
    const buffer = new Decimal(TAKER_CROSS_BUFFER_BPS).div(10_000);
    const raw = new Decimal(refPrice.toFixed())
      .mul(isLong ? buffer.plus(1) : new Decimal(1).minus(buffer))
      .toDecimalPlaces(8);
    return price(raw.toFixed());
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
    // v3 consolidation spec §4: validator capabilities are fixed true — every v3 boot has
    // perp-capable symbols (AgenticBridgeModule's own fixed {shortsAllowed:true, leverageAllowed:true}
    // composition-root capability), never a per-deployment lane flag any more (cfg carries no
    // shortsEnabled field to read).
    const validation = validatePlaybook(stored.content, {
      shortsAllowed: true,
      leverageAllowed: true,
    });
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

  // On a FATAL classification, log once and latch this instance to degraded. The message now
  // carries the API error body (attemptOnce embeds it — the body states the invalid_request
  // cause and never credentials); the key itself never appears in any error path. Re-stamping on
  // every FATAL means a cause that is still unfixed extends the suppression a full cooldown from the
  // last probe, never from the first failure. Pass 48: classifyLatchCause runs off this SAME
  // err.status/err.message the log line already prints — the cause and the latch are stamped
  // together so they can never read as two different failures.
  private handleFailure(err: AgentProposeError): void {
    if (err.kind === 'FATAL') {
      this.latchedCause = classifyLatchCause(err.status, err.message);
      this.logger.warn(
        `anthropic api: fatal error (status ${err.status ?? 'n/a'}) — latching agent client to degraded for ${FATAL_LATCH_COOLDOWN_MS / 60_000}min, no calls until then — ${err.message}`,
      );
      this.latchedAtMs = Date.now();
    } else {
      // Transport-reason gap fix (soak-flagged): a RETRYABLE failure previously logged nothing at
      // all — err.message is this client's own sanitized diagnostic (never credentials/body), so
      // surfacing it here closes the "nothing logs" half without loosening the FATAL path above.
      this.logger.warn(`anthropic api: retryable error — ${err.message}`);
    }
  }

  // One attempt + one bounded retry, shared by propose()/proposeBatch(): builds the request via
  // attemptOnce, classifies any failure, and on a RETRYABLE failure with enough remaining budget
  // backs off once and retries with the SAME prompt strings (never re-derived, so a retry can't
  // silently diverge from the first attempt). `timeoutMs` is caller-supplied (not always
  // this.cfg.timeoutMs) so proposeBatch can fold its own coalescing window into the budget — see
  // AgentProposeBatchOptions.timeoutMsOverride.
  private async attemptWithRetry(
    systemPrompt: string,
    userContent: string | AnthropicTextBlock[],
    // v3 consolidation spec §4.3: the unified submit_trade (single-symbol) / submit_portfolio
    // (batch) tools — no more legacy/plan/shorts tool-shape variants.
    tool: ReturnType<typeof buildTradeTool> | ReturnType<typeof buildTradePortfolioTool>,
    timeoutMs: number,
    // #42: the caller's precomputed thinking arm — threaded explicitly (never re-derived here) so
    // a retry resends the IDENTICAL request, the same invariant the prompt strings follow.
    thinking: { type: 'adaptive' } | { type: 'disabled' } = { type: 'disabled' },
  ): Promise<Response> {
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      try {
        return await this.attemptOnce(systemPrompt, userContent, tool, controller.signal, thinking);
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
          return await this.attemptOnce(
            systemPrompt,
            userContent,
            tool,
            controller.signal,
            thinking,
          );
        } catch (secondErr) {
          const secondClassified = secondErr as AgentProposeError;
          this.handleFailure(secondClassified);
          throw secondClassified;
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // One HTTP attempt: builds the request, classifies any failure (transport or non-ok status) into
  // an AgentProposeError, and returns the ok Response otherwise. Never called once degraded. The
  // system/user prompt strings are built once by the caller (not per-attempt) so a retry resends
  // the identical prompt rather than silently re-deriving it.
  private async attemptOnce(
    systemPrompt: string,
    userContent: string | AnthropicTextBlock[],
    // v3 consolidation spec §4.3: the unified submit_trade (single-symbol) / submit_portfolio
    // (batch) tools — no more legacy/plan/shorts tool-shape variants.
    tool: ReturnType<typeof buildTradeTool> | ReturnType<typeof buildTradePortfolioTool>,
    signal: AbortSignal,
    thinking: { type: 'adaptive' } | { type: 'disabled' } = { type: 'disabled' },
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
          // `tool` is the caller's precomputed submit_trade/submit_portfolio tool (built per-symbol
          // or per-batch from that call's own SymbolCapabilities — see propose()/proposeBatch()).
          tools: [tool],
          tool_choice: { type: 'tool', name: tool.name },
          // Omitting `thinking` on claude-sonnet-5 silently runs (billed) adaptive thinking, so it
          // is always explicit here: 'disabled' by default (structured tool-use has no use for it),
          // or 'adaptive' when the caller's #42 thinking-A/B treatment arm fired. Reflection has
          // its own separate request builder (see reflection.service.ts) and is unaffected.
          thinking,
          // WATCH-V4-12 sanctioned fix — see AnthropicAgentClientConfig.outputEffort's own comment
          // for the measured truncation leak and the two refuted alternatives. Nested inside
          // output_config, not top-level, per the API contract. Key omitted entirely when unset
          // (the flag-off default) so the request stays byte-identical to pre-fix — this is the
          // property the flag-off spec's own test pins.
          ...(this.cfg.outputEffort ? { output_config: { effort: this.cfg.outputEffort } } : {}),
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
      // The API's error body carries the precise invalid_request cause and never credentials —
      // without it a latching 400 is undiagnosable from logs (live incident 2026-07-19 17:15Z:
      // spot latched degraded on a bare "http 400" with no recorded cause).
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 500);
      } catch {
        detail = '[unreadable body]';
      }
      throw new AgentProposeError(
        `anthropic api http ${res.status}${detail ? ` — ${detail}` : ''}`,
        classifyHttpStatus(res.status),
        res.status,
        retryAfterMs,
      );
    }
    return res;
  }
}
