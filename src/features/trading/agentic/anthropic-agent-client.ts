import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { price, qty, type Price } from '../../../domain/types/money';
import type { CandleEvent, OrderBookSnapshotEvent } from '../../../domain/types/market-events';
import type { EpochMs, SymbolId, VenueId } from '../../../domain/types/ids';
import type { Signal } from '../../../domain/types/signal';
import {
  AgentProposeError,
  type AgentBudgetBlock,
  type AgentCalendarEvent,
  type AgentClientPort,
  type AgentDecisionInput,
  type AgentDirectives,
  type AgentPortfolioBlock,
  type AgentProposal,
  type AgentTradingProfile,
  type AgentUsage,
  type PlaybookProvider,
} from '../../../ports/agentic-strategy';
import {
  BOOK_STRUCTURE_TEMPLATE_VERSION,
  CROSS_SYMBOL_TEMPLATE_VERSION,
  DECISION_TOOL,
  DECISION_V2_BOUNDS,
  DERIVATIVES_TEMPLATE_VERSION,
  DERIVATIVES_V2_TEMPLATE_VERSION,
  LIQUIDATION_TEMPLATE_VERSION,
  TRACK_RECORD_TEMPLATE_VERSION,
  PORTFOLIO_TEMPLATE_VERSION,
  PORTFOLIO_TOOL,
  PORTFOLIO_SHORTS_TEMPLATE_VERSION,
  PORTFOLIO_SHORTS_TOOL,
  POSITIONING_TEMPLATE_VERSION,
  SENTIMENT_TEMPLATE_VERSION,
  SHORTS_DECISION_TOOL,
  SHORTS_TEMPLATE_VERSION,
  TRADEFLOW_TEMPLATE_VERSION,
  THINKING_TEMPLATE_VERSION,
  PLAN_BOUNDS,
  PLAN_TOOL,
  PLAN_SHORTS_TOOL,
  PLAN_TEMPLATE_VERSION,
  PLAN_SHORTS_TEMPLATE_VERSION,
  PROMPT_TEMPLATE_VERSION,
  TRADE_TEMPLATE_VERSION,
  TRADE_SHORTS_TEMPLATE_VERSION,
  TRADE_PORTFOLIO_TEMPLATE_VERSION,
  TRADE_PORTFOLIO_SHORTS_TEMPLATE_VERSION,
  buildMarketPayload,
  buildPlaybookBlock,
  buildSystemPrompt,
  buildTradeTool,
  buildTradeShortsTool,
  buildTradePortfolioTool,
  buildTradePortfolioShortsTool,
  computePromptHash,
} from './agent-prompt';
import { validatePlaybook } from './playbook-validator';
import { abArm } from './ab-assignment';

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

// W3.1 submit_plan payload's `plan` sub-schema, factored out of planSchema below so
// proposeBatch's per-element planElementSchema can reuse the SAME bounds/shape rather than a second
// hand-maintained copy (see PLAN_BOUNDS's own comment on why the wire tool schema can't carry these
// bounds itself — this zod schema is the real gate).
const planFieldSchema = z
  .object({
    entryOffsetBps: z
      .number()
      .int()
      .min(PLAN_BOUNDS.entryOffsetBps.min)
      .max(PLAN_BOUNDS.entryOffsetBps.max),
    stopLossPct: z.number().min(PLAN_BOUNDS.stopLossPct.min).max(PLAN_BOUNDS.stopLossPct.max),
    takeProfitPct: z.number().min(PLAN_BOUNDS.takeProfitPct.min).max(PLAN_BOUNDS.takeProfitPct.max),
    entryValidityBars: z
      .number()
      .int()
      .min(PLAN_BOUNDS.entryValidityBars.min)
      .max(PLAN_BOUNDS.entryValidityBars.max),
    maxHoldBars: z.number().int().min(PLAN_BOUNDS.maxHoldBars.min).max(PLAN_BOUNDS.maxHoldBars.max),
    // Push II Phase 8 (plan-mode shorts): optional on the base schema so its presence/absence never
    // changes parsing for a shortsEnabled=false deployment (byte-identical) — planShortsSchema below
    // is the schema that actually REQUIRES it (superRefine), selected only when cfg.shortsEnabled.
    direction: z.enum(['long', 'short']).optional(),
  })
  .optional();

// REQUIRED when opening a long (schema-enforced — a plan-less 'long' is malformed, not a bare
// entry). Pct fields arrive as JSON numbers (fractions, bounded well inside double precision) and
// are converted to strings at the mapping boundary so all downstream math stays Decimal-on-strings.
const planSchema = decisionSchema.extend({ plan: planFieldSchema }).superRefine((v, ctx) => {
  if (v.action === 'long' && v.plan === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "plan is required when action is 'long'",
    });
  }
});

// Push II Phase 8: parameterized sibling of planSchema, selected in place of it only when
// cfg.shortsEnabled is true (mirrors shortsDecisionSchema's relationship to decisionSchema above) —
// planSchema itself stays untouched so a shortsEnabled=false deployment's plan-mode validation is
// byte-identical. Additionally requires plan.direction whenever a plan is present (a plan-mode
// shorts deployment needs to know which side a fresh entry opens; a re-arm plan on an existing
// position still carries it structurally but the strategy ignores it — the position's own side
// wins, see anthropic-agent-client.ts's buildProposalFromDecision).
const planShortsSchema = decisionSchema.extend({ plan: planFieldSchema }).superRefine((v, ctx) => {
  if (v.action === 'long' && v.plan === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "plan is required when action is 'long'",
    });
  }
  if (v.plan !== undefined && v.plan.direction === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'plan.direction is required when shorts are enabled',
    });
  }
});

// Portfolio-batch per-element schemas (BatchingAgentClient, Push II Phase 5 DESIGN Task 2): the SAME
// decision/shorts/plan schemas above, each with a `symbol` field added so a decisions[] element can
// be matched back to the resolved input it answers — reusing rather than re-deriving the
// action/confidence/rationale/plan validation the single-symbol path already enforces.
const decisionElementSchema = decisionSchema.extend({ symbol: z.string().min(1) });
const shortsDecisionElementSchema = shortsDecisionSchema.extend({ symbol: z.string().min(1) });
const planElementSchema = decisionSchema
  .extend({ symbol: z.string().min(1), plan: planFieldSchema })
  .superRefine((v, ctx) => {
    if (v.action === 'long' && v.plan === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "plan is required when action is 'long'",
      });
    }
  });
// Push II Phase 8: plan-shorts sibling of planElementSchema, mirroring planShortsSchema's own
// relationship to planSchema above.
const planShortsElementSchema = decisionSchema
  .extend({ symbol: z.string().min(1), plan: planFieldSchema })
  .superRefine((v, ctx) => {
    if (v.action === 'long' && v.plan === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "plan is required when action is 'long'",
      });
    }
    if (v.plan !== undefined && v.plan.direction === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'plan.direction is required when shorts are enabled',
      });
    }
  });
// Whole-call shape check for submit_portfolio's top-level payload — deliberately lenient
// (`z.unknown()` per element): a malformed INDIVIDUAL element must degrade only that symbol (see
// proposeBatch), so per-element validation happens separately via decisionElementSchema/
// shortsDecisionElementSchema/planElementSchema, never here.
const portfolioDecisionsSchema = z.object({ decisions: z.array(z.unknown()) });
// Lenient symbol-only extraction so a decisions[] element that otherwise fails full validation can
// still be attributed to (and thus warned/held against) the right requested symbol.
const elementSymbolSchema = z.object({ symbol: z.string().min(1) });

// S3 (rich decision contract, Design § New tool contract): v2 submit_trade/submit_portfolio zod
// schemas, mirroring DECISION_V2_BOUNDS (agent-prompt.ts — single source for the numeric ranges; see
// that const's own comment on why the strict-tool-use JSON schema can't carry them itself). ADDITIVE
// alongside the legacy decisionSchema/planSchema family above — A1 owns wiring these into
// buildProposalFromDecision/propose/proposeBatch and deleting the legacy schemas/clamps they replace
// (WORK item 5: no deletion here). Every wire field arrives as a plain JSON number (the tool's
// input_schema types them 'number'/'integer', same as planFieldSchema above) — conversion to the
// money-safe Decimal-on-string AgentDirectives shape happens at A1's mapping boundary, not here.
// sizeFractionMax is injected as a plain number (the lane cap, AGENTIC_MAX_POSITION_FRACTION — 0.15
// spot / 0.50 perp) rather than hardcoded — the SAME per-call parameterization agent-prompt.ts's
// buildTradeTool family uses for the tool description (one cap, never two hand-maintained copies).
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
    thesis: z.string().max(DECISION_V2_BOUNDS.thesisMaxLen).optional(),
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

// S3: single-symbol spot v2 schema — action enum mirrors buildTradeTool's (excludes 'open_short';
// spot cannot short).
export function tradeDecisionSchema(sizeFractionMax: number) {
  return z
    .object({
      action: z.enum(['open_long', 'close', 'adjust', 'hold']),
      ...tradeDirectiveFieldShape(sizeFractionMax),
    })
    .superRefine(requireTradeDirectives);
}

// S3: perp sibling — action enum mirrors buildTradeShortsTool's widened enum. Selected in place of
// tradeDecisionSchema only when cfg.shortsEnabled is also true (same relationship shortsDecisionSchema
// has to decisionSchema above).
export function tradeShortsDecisionSchema(sizeFractionMax: number) {
  return z
    .object({
      action: z.enum(['open_long', 'open_short', 'close', 'adjust', 'hold']),
      ...tradeDirectiveFieldShape(sizeFractionMax),
    })
    .superRefine(requireTradeDirectives);
}

// A1: the v2 decision shape buildProposalFromTradeDecision maps — inferred off
// tradeShortsDecisionSchema (the widened action enum) rather than tradeDecisionSchema, so ONE type
// covers whatever either single-symbol schema parsed (tradeDecisionSchema's inferred action union is
// a strict subset of this one — assignable without a cast at every propose() call site below).
type TradeDecisionV2 = z.infer<ReturnType<typeof tradeShortsDecisionSchema>>;

// S3: portfolio-batch per-element schemas — the SAME action/directive validation as the single-symbol
// schemas above with a `symbol` field added, mirroring decisionElementSchema/planElementSchema's own
// relationship to decisionSchema/planSchema. nextConsultBars is deliberately ABSENT from the element
// shape (portfolio-level only — see tradePortfolioSchema below); a stray one on an element is simply
// ignored (non-strict object), never rejected.
export function tradeElementSchema(sizeFractionMax: number) {
  return z
    .object({
      symbol: z.string().min(1),
      action: z.enum(['open_long', 'close', 'adjust', 'hold']),
      ...tradeDirectiveFieldShape(sizeFractionMax),
    })
    .superRefine(requireTradeDirectives);
}

export function tradeShortsElementSchema(sizeFractionMax: number) {
  return z
    .object({
      symbol: z.string().min(1),
      action: z.enum(['open_long', 'open_short', 'close', 'adjust', 'hold']),
      ...tradeDirectiveFieldShape(sizeFractionMax),
    })
    .superRefine(requireTradeDirectives);
}

// S3: whole-call shape for the v2 submit_portfolio payload — lenient per element (z.unknown()), same
// discipline as portfolioDecisionsSchema above (a malformed INDIVIDUAL element must degrade only that
// symbol, validated separately via tradeElementSchema/tradeShortsElementSchema), but ALSO carries the
// portfolio-level nextConsultBars the legacy submit_portfolio never had (Design table:
// "portfolio-level, one per batch response" — per-symbol scheduling would desync the basket).
export const tradePortfolioSchema = z.object({
  decisions: z.array(z.unknown()),
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
  // d2 (Push 3 P6 Unit 1): when true ALONGSIDE derivativesFeedEnabled, switches the derivatives
  // block/sentence/tag from d1 to d2 (three extra fields: spot-perp basis, OI percent change,
  // funding trend — see agent-prompt.ts's DERIVATIVES_V2_TEMPLATE_VERSION comment). Inert on its own
  // (derivativesFeedEnabled false ⇒ no derivatives block at all, v2 or not). ENABLING MID-FACTORIAL
  // IS FORBIDDEN — never flip this while an A/B or offline sweep is comparing d1-tagged rows; see the
  // same constant's comment for why the two template versions are not cross-comparable.
  readonly derivativesV2Enabled?: boolean;
  // Derivatives-block A/B (measurement start 2026-07-12): percent (0-50) of decides deterministically
  // routed to a CONTROL arm that withholds the derivatives block entirely — system sentence,
  // promptHash's `+d1` tag, and the payload's derivatives key all withheld TOGETHER (see propose()'s
  // derivativesControlArm). Absent/0, or derivativesFeedEnabled false, ⇒ byte-identical to no A/B
  // (nothing to withhold when the feed is already off).
  readonly derivativesAbPct?: number;
  // S3: thinking-on-decide A/B (backlog #42) RETIRED — every decide/batch call now carries
  // thinking:{type:'adaptive'} unconditionally (Design § Deleted/replaced scaffolding). The knob and
  // its abArm('th-v1', ...) bucketing are deleted outright rather than defaulted-off, since the
  // field would otherwise silently do nothing for any caller still passing it.
  // C4: documents the optional sentiment block in the system prompt (agent-prompt.ts's
  // buildSystemPrompt sentimentFeedEnabled option). Absent/false ⇒ byte-identical legacy prompt.
  readonly sentimentFeedEnabled?: boolean;
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
  // B3 shorts capability, widened by Push II Phase 8 to ALSO cover plan mode: with planMode false
  // this widens the legacy decision tool/schema to accept 'short' and maps it to ENTER_SHORT/
  // EXIT_SHORT (see propose()'s mapping table) — unchanged from B3. With planMode true, it instead
  // selects PLAN_SHORTS_TOOL/planShortsSchema (submit_plan gains a required plan.direction field)
  // and the mapping table's plan-mode arms branch on rawPlan.direction. Either combination requires
  // perpCapableVenue — spot cannot short (see the constructor guard). Absent/false ⇒ byte-identical
  // legacy behavior in both modes.
  readonly shortsEnabled?: boolean;
  // Push II Phase 8: true only when the configured venue is perp-capable (binanceusdm/demo — see
  // agentic-strategy.module.ts's AGENTIC_PERP_VENUE derivation off config.venues). Gates
  // shortsEnabled + planMode together at construction: shorts in plan mode on a non-perp (spot)
  // venue throws rather than silently no-opping. Irrelevant to the legacy (non-plan) shorts path,
  // which this pass leaves exactly as B3 shipped it.
  readonly perpCapableVenue?: boolean;
  // S3 (rich decision contract, Design § New tool contract): selects the v2 submit_trade tool/schema
  // family (buildTradeTool/buildTradeShortsTool, t1/t1s template tags, buildTradeContractSystemPrompt)
  // in place of the legacy/plan-mode path — checked BEFORE planMode below (mirrors
  // buildSystemPrompt's own tradeContract-first precedence), so a deployment can never have both
  // active at once. shortsEnabled doubles as the perp-lane selector here too, same convention as the
  // v2 system prompt. Absent/false ⇒ byte-identical legacy/plan-mode behavior — this flag and its
  // module wiring (env knob, tool selection into propose()'s response mapping) land in later steps
  // (I1); S3 only wires tool/template SELECTION, not response parsing (A1 owns that).
  readonly tradeContract?: boolean;
  // S3: the lane's sizeFraction upper bound (AGENTIC_MAX_POSITION_FRACTION — money-adjacent string,
  // same convention as SIZER_EQUITY_CAP), injected into BOTH the v2 tool description (buildTradeTool
  // family, string form) and the zod schema's numeric .max() (tradeDecisionSchema family, number
  // form) at construction — never hardcoded in either place. Absent ⇒ DEFAULT_MAX_POSITION_FRACTION
  // (only reached by a tradeContract deployment that hasn't wired the real per-lane knob yet).
  readonly maxPositionFraction?: string;
  // I1b (Design § Enriched model inputs): the composition root's batch-wide extras source
  // (agent-portfolio-block.ts's buildAgentPortfolioBlock, agent-budget.ts's DailyLlmBudget.
  // budgetBlock, macro-calendar.ts's loadMacroCalendar/filterUpcoming) — invoked at most ONCE per
  // propose() call and ONCE per proposeBatch() call (never per symbol inside a batch: portfolio/
  // budget/calendar are batch-wide state, not per-symbol — see BuildMarketPayloadExtras' own
  // comment), then merged into every buildMarketPayload call the same decide/batch round makes.
  // Absent ⇒ no provider invoked, no portfolio/budget/calendar keys ever added — byte-identical to
  // pre-I1b (S1's own omit-when-absent tests already pin this).
  readonly payloadExtrasProvider?: () =>
    | {
        readonly portfolio?: AgentPortfolioBlock;
        readonly budget?: AgentBudgetBlock;
        readonly calendar?: readonly AgentCalendarEvent[];
      }
    | Promise<{
        readonly portfolio?: AgentPortfolioBlock;
        readonly budget?: AgentBudgetBlock;
        readonly calendar?: readonly AgentCalendarEvent[];
      }>;
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
// LEGACY-ONLY (confidence→strength clamp): still bound by every non-tradeContract propose()/
// proposeBatch() call through buildProposalFromDecision below — proposeBatch's legacy path is not
// migrated until A2, so these stay live rather than deleted. buildProposalFromTradeDecision (A1's v2
// mapping) never references either constant: v2 entries carry a fixed `strength: 1` (telemetry only —
// see Design § New tool contract's action-mapping paragraph), conviction rides entirely on
// Signal.sizeFraction instead.
const MIN_STRENGTH = 0.1;
const MAX_STRENGTH = 1;

// S3: fallback when cfg.maxPositionFraction is absent — mirrors AGENTIC_MAX_POSITION_FRACTION's spot
// default (a later module-wiring step threads the real per-lane value, 0.15 spot / 0.50 perp, from
// config). Only reached by a tradeContract deployment that hasn't wired the knob yet.
const DEFAULT_MAX_POSITION_FRACTION = '0.15';

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

// Concrete AGENT_CLIENT adapter: calls the real Anthropic Messages API and maps its tool-use
// decision to a proposed AgentProposal. Stateless across decisions — the strategy owns the
// decision-history trail — but stateful across FAILURES: a FATAL classification latches this
// instance to degraded so a bad key/request can't be hammered at candle cadence. Risk still
// sizes/vetoes whatever signal is returned.
export class AnthropicAgentClient implements AgentClientPort {
  // Set once by a FATAL failure; every propose()/proposeBatch() call after that short-circuits with
  // no HTTP call.
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
    // Push II Phase 8: fail fast at construction rather than silently picking a flag combination at
    // decide() time. shortsEnabled + planMode together is now a supported capability (PLAN_SHORTS_TOOL/
    // planShortsSchema, direction-aware plan-executor arms) — but ONLY on a perp-capable venue: spot
    // has no short-selling mechanism, so shorts + planMode on a spot deployment still throws (this was
    // an unconditional throw pre-Phase-8; it is now conditional on perpCapableVenue). The LEGACY
    // (non-plan) shorts path is unaffected by perpCapableVenue — it never throws regardless.
    if (cfg.shortsEnabled && cfg.planMode && !cfg.perpCapableVenue) {
      throw new Error(
        'AnthropicAgentClient: shortsEnabled with planMode requires a perp-capable venue (spot cannot short)',
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

    const ctx = await this.prepareDecideContext();
    const constraints = this.cfg.constraintsFor?.(String(symbol)) ?? ctx.baseProfile.constraints;

    // Control arm: strip the derivatives/tradeFlow/positioning snapshots (agentic.strategy.ts's
    // withDerivatives/withTradeFlow/withPositioning) and the cross-symbol ranking (context.crossSymbol)
    // the strategy attached, before building the payload — buildMarketPayload's own omit-when-absent
    // gates then leave all four blocks out, the same path a feed-off/stale-poll deployment already
    // takes, reused rather than duplicated. Every other use of `input` in this method (signals,
    // eventTime, refPrice, ...) stays on the ORIGINAL input — only payload construction sees the
    // stripped copy.
    const payloadInput = ctx.infoContextControlArm
      ? {
          ...input,
          snapshot: {
            ...input.snapshot,
            derivatives: undefined,
            tradeFlow: undefined,
            positioning: undefined,
            liquidation: undefined,
          },
          ...(input.context ? { context: { ...input.context, crossSymbol: undefined } } : {}),
        }
      : input;
    // I1b: batch-wide extras (portfolio/budget/calendar) — ONE call for this single-symbol decide,
    // same provider seam proposeBatch uses once per batch. Absent provider ⇒ undefined ⇒ every
    // spread below is a no-op (byte-identical).
    const payloadExtras = await this.cfg.payloadExtrasProvider?.();
    // inputPayload is the market JSON ALONE — buildMarketPayload's signature carries no
    // playbookContent parameter, so it structurally cannot echo playbook text (see its own comment).
    // W2.4 cache experiment: the playbook block (the only sizeable stable prefix) rides in its own
    // cache_control content block while the volatile market JSON follows uncached; block 2 carries
    // the '\n\n' separator, so the concatenated model-visible text stays byte-identical to
    // buildUserMessage's single-string form (see buildPlaybookBlock's comment).
    const inputPayload = buildMarketPayload(payloadInput, {
      constraints,
      derivativesV2Enabled: ctx.derivativesV2Enabled,
      bookStructureEnabled: this.cfg.bookStructureFeedEnabled ?? false,
      ...payloadExtras,
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
      toolSchemaJson: JSON.stringify(ctx.activeTool),
      modelId: this.cfg.model,
    });

    const started = Date.now();
    const res = await this.attemptWithRetry(
      ctx.systemPrompt,
      userContent,
      ctx.activeTool,
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
        latencyMs,
        playbookVersion: ctx.playbookVersion,
        promptHash,
        inputPayload,
        // A call WAS attempted (ctx resolved, request sent) — the arm truth is real even though the
        // response itself was unusable. See AgentProposal.infoArm/thinkingArm for the polarity note.
        infoArm: !ctx.infoContextControlArm,
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
        usage,
        latencyMs,
        playbookVersion: ctx.playbookVersion,
        promptHash,
        inputPayload,
        infoArm: !ctx.infoContextControlArm,
        thinkingArm: ctx.thinkingArm,
      };
    }
    const toolName = ctx.activeTool.name;
    const toolBlock = envelope.data.content?.find(
      (b) => b.type === 'tool_use' && b.name === toolName,
    );
    if (!toolBlock) {
      this.logger.warn(`anthropic api: no ${toolName} tool_use block in response`);
      return {
        signals: [],
        usage,
        latencyMs,
        playbookVersion: ctx.playbookVersion,
        promptHash,
        inputPayload,
        infoArm: !ctx.infoContextControlArm,
        thinkingArm: ctx.thinkingArm,
      };
    }
    // A1 (rich decision contract, Design § New tool contract): tradeContract is a SEPARATE early
    // branch, not a third arm folded into the legacy ternary below — the v2 zod schemas
    // (tradeDecisionSchema/tradeShortsDecisionSchema) are parameterized by the numeric lane cap
    // (unlike the legacy schemas, which are plain module-level consts), and buildProposalFromDecision
    // below is keyed to the legacy action vocabulary ('long'/'short'/'flat'/'hold') — folding a
    // fourth, structurally different decision shape into it would force every legacy arm to guard
    // against v2 fields it never has. buildProposalFromTradeDecision is the v2 sibling instead;
    // legacy propose() control flow below this branch is untouched.
    if (this.cfg.tradeContract) {
      // sizeFractionMax is a zod numeric bound (a fraction, not a money computation) — same
      // convention as tradeDecisionSchema's own numeric parameter (S3); ctx.maxPositionFraction is
      // the SAME string buildTradeTool already baked into the tool description above, not a second
      // hand-computed value.
      // eslint-disable-next-line no-restricted-syntax -- Number() is the correct non-money coercion here.
      const maxPositionFractionNum = Number(ctx.maxPositionFraction);
      const tradeSchema = this.cfg.shortsEnabled
        ? tradeShortsDecisionSchema(maxPositionFractionNum)
        : tradeDecisionSchema(maxPositionFractionNum);
      const parsedTrade = tradeSchema.safeParse(toolBlock.input);
      if (!parsedTrade.success) {
        this.logger.warn(
          `anthropic api: ${toolName} payload failed schema validation — ${describeSchemaFailure(parsedTrade.error, toolBlock.input)}`,
        );
        return {
          signals: [],
          usage,
          latencyMs,
          playbookVersion: ctx.playbookVersion,
          promptHash,
          inputPayload,
          infoArm: !ctx.infoContextControlArm,
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
        baseProfile: ctx.baseProfile,
        usage,
        latencyMs,
        playbookVersion: ctx.playbookVersion,
        promptHash,
        inputPayload,
        infoArm: !ctx.infoContextControlArm,
        thinkingArm: ctx.thinkingArm,
      });
    }

    const parsedDecision = this.cfg.planMode
      ? this.cfg.shortsEnabled
        ? planShortsSchema.safeParse(toolBlock.input)
        : planSchema.safeParse(toolBlock.input)
      : this.cfg.shortsEnabled
        ? shortsDecisionSchema.safeParse(toolBlock.input)
        : decisionSchema.safeParse(toolBlock.input);
    if (!parsedDecision.success) {
      this.logger.warn(
        `anthropic api: ${toolName} payload failed schema validation — ${describeSchemaFailure(parsedDecision.error, toolBlock.input)}`,
      );
      return {
        signals: [],
        usage,
        latencyMs,
        playbookVersion: ctx.playbookVersion,
        promptHash,
        inputPayload,
        infoArm: !ctx.infoContextControlArm,
        thinkingArm: ctx.thinkingArm,
      };
    }

    // Explicitly re-typed: the decision/plan schema union erases `plan` under `in`-narrowing.
    const rawPlan: z.infer<typeof planFieldSchema> = this.cfg.planMode
      ? (parsedDecision.data as z.infer<typeof planSchema>).plan
      : undefined;

    return this.buildProposalFromDecision({
      input,
      symbol,
      venue,
      refPrice,
      basedOnSeq,
      eventTime,
      lastCandle,
      decision: parsedDecision.data,
      rawPlan,
      baseProfile: ctx.baseProfile,
      usage,
      latencyMs,
      playbookVersion: ctx.playbookVersion,
      promptHash,
      inputPayload,
      infoArm: !ctx.infoContextControlArm,
      thinkingArm: ctx.thinkingArm,
    });
  }

  // Portfolio-consult batching (BatchingAgentClient, Push II Phase 5 DESIGN Task 2): ONE Anthropic
  // call answering every resolvable symbol in `inputs` via submit_portfolio instead of N separate
  // submit_decision calls. Shares prepareDecideContext/attemptWithRetry/buildProposalFromDecision
  // with propose() so playbook/knob/A/B-arm resolution and the per-symbol plan/knob/floor validation
  // are IDENTICAL between the two paths — only the request shape (one call, many symbol blocks) and
  // response fan-out differ. Resolves (never rejects) for every outcome propose() would also resolve
  // for (soft holds: refusal, a malformed/missing element); only a genuine whole-call transport/HTTP/
  // schema failure throws, so the caller (BatchingAgentClient) can reject every waiting promise with
  // the SAME error class propose() would throw for the equivalent single-symbol failure.
  async proposeBatch(
    inputs: readonly AgentDecisionInput[],
    opts: AgentProposeBatchOptions = {},
  ): Promise<AgentProposeBatchResult> {
    if (inputs.length === 0) return { proposals: new Map() };
    if (this.degraded) {
      return {
        proposals: new Map<string, AgentProposal>(
          inputs.map((i) => [String(i.trigger.event.symbol), { signals: [] }]),
        ),
      };
    }

    const ctx = await this.prepareDecideContext();
    // I1b: ONE provider call for the WHOLE batch (Design § Enriched model inputs: "rendered once per
    // batch") — portfolio/budget/calendar are batch-wide book state, never per-symbol; calling this
    // per resolved element would render N identical copies of the same snapshot and waste tokens.
    const payloadExtras = await this.cfg.payloadExtrasProvider?.();

    interface ResolvedInput {
      readonly symbolKey: string;
      readonly symbolId: SymbolId;
      readonly input: AgentDecisionInput;
      readonly venue: VenueId;
      readonly refPrice: Price;
      readonly basedOnSeq: bigint;
      readonly eventTime: EpochMs;
      readonly lastCandle: CandleEvent | undefined;
      readonly inputPayload: string;
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
      const payloadInput = ctx.infoContextControlArm
        ? {
            ...input,
            snapshot: {
              ...input.snapshot,
              derivatives: undefined,
              tradeFlow: undefined,
              positioning: undefined,
              liquidation: undefined,
            },
            ...(input.context ? { context: { ...input.context, crossSymbol: undefined } } : {}),
          }
        : input;
      const inputPayload = buildMarketPayload(payloadInput, {
        constraints,
        derivativesV2Enabled: ctx.derivativesV2Enabled,
        bookStructureEnabled: this.cfg.bookStructureFeedEnabled ?? false,
        // I1b: the ONE batch-wide payloadExtras computed above, stamped on every element the same
        // way consultId/nextConsultBars already are — plus THIS element's own position-summary
        // thesis/directives (per-symbol, unlike portfolio/budget/calendar).
        ...payloadExtras,
        currentThesis: input.context?.position.currentThesis,
        directives: input.context?.position.directives,
        barsHeld: input.context?.position.barsHeld,
        barsUntilForcedExit: input.context?.position.barsUntilForcedExit,
      });
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

    // #41: a shorts-capable batch rides PORTFOLIO_SHORTS_TOOL (plan.direction required per
    // element) under the pf2 tag — the strict pf1 tool cannot express a short entry, which is what
    // used to force the shorts+consult boot refusal. Shorts-off batches stay byte-identical pf1.
    // A2: tradeContract is checked FIRST (mirrors prepareDecideContext's activeTool precedence —
    // tradeContract and planMode are mutually exclusive by construction), selecting the v2
    // submit_portfolio tool/tpf1/tpf2 tag with the SAME lane cap (ctx.maxPositionFraction) the
    // single-symbol path already bakes into buildTradeTool/buildTradeShortsTool.
    const portfolioTool = this.cfg.tradeContract
      ? this.cfg.shortsEnabled
        ? buildTradePortfolioShortsTool(ctx.maxPositionFraction)
        : buildTradePortfolioTool(ctx.maxPositionFraction)
      : this.cfg.planMode && this.cfg.shortsEnabled
        ? PORTFOLIO_SHORTS_TOOL
        : PORTFOLIO_TOOL;
    const portfolioTag = this.cfg.tradeContract
      ? this.cfg.shortsEnabled
        ? TRADE_PORTFOLIO_SHORTS_TEMPLATE_VERSION
        : TRADE_PORTFOLIO_TEMPLATE_VERSION
      : this.cfg.planMode && this.cfg.shortsEnabled
        ? PORTFOLIO_SHORTS_TEMPLATE_VERSION
        : PORTFOLIO_TEMPLATE_VERSION;

    const promptHash = computePromptHash({
      templateVersion: `${
        ctx.feedTags.length > 0
          ? `${ctx.baseTemplateVersion}+${ctx.feedTags.join('+')}`
          : ctx.baseTemplateVersion
      }+${portfolioTag}`,
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
    const symbolBlocks: AnthropicTextBlock[] = resolved.map((r, i) => ({
      type: 'text',
      text: `${i === 0 && !playbookBlock ? '' : '\n\n'}Symbol ${i + 1} of ${resolved.length} (${r.symbolKey}):\n${r.inputPayload}`,
    }));
    const userContent: AnthropicTextBlock[] = playbookBlock
      ? [playbookBlock, ...symbolBlocks]
      : symbolBlocks;

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
        !ctx.infoContextControlArm,
        ctx.thinkingArm,
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
      resolved.forEach((r, i) => {
        proposals.set(r.symbolKey, {
          signals: [],
          ...(i === 0 && usage ? { usage } : {}),
          latencyMs,
          playbookVersion: ctx.playbookVersion,
          promptHash,
          inputPayload: r.inputPayload,
          consultId,
          infoArm: !ctx.infoContextControlArm,
          thinkingArm: ctx.thinkingArm,
        });
      });
      return { proposals, usage };
    }

    // A2: repoints the hardcoded PORTFOLIO_TOOL.name lookup to the SELECTED portfolio tool's name —
    // legacy/plan-mode's own tools are also literally named 'submit_portfolio' so this is
    // byte-identical there; only a tradeContract batch (still 'submit_portfolio' today, but no
    // longer coupled to the legacy const) actually depends on this repoint.
    const toolBlock = envelope.data.content?.find(
      (b) => b.type === 'tool_use' && b.name === portfolioTool.name,
    );
    if (!toolBlock) {
      // Soft-hold, same rationale as the malformed-envelope path above (enable-gate must-fix).
      this.logger.warn(
        `anthropic api: no ${portfolioTool.name} tool_use block in response (portfolio batch) — holding all`,
      );
      return this.softHoldBatch(
        resolved,
        usage,
        latencyMs,
        ctx.playbookVersion,
        promptHash,
        consultId,
        !ctx.infoContextControlArm,
        ctx.thinkingArm,
      );
    }

    // A2 (rich decision contract, Design § New tool contract): tradeContract batches parse via
    // tradePortfolioSchema (per-element tradeElementSchema/tradeShortsElementSchema) and map through
    // buildProposalFromTradeDecision — a SEPARATE branch from the legacy fan-out below, mirroring
    // propose()'s own tradeContract-first branch (buildProposalFromTradeDecision is keyed to the v2
    // action vocabulary, structurally incompatible with the legacy decision shape). Soft-hold
    // semantics (malformed top-level payload, missing symbol, malformed element) stay byte-identical
    // to the legacy path — only the parsed shape and per-symbol mapping differ.
    if (this.cfg.tradeContract) {
      const tradePortfolioParsed = tradePortfolioSchema.safeParse(toolBlock.input);
      if (!tradePortfolioParsed.success) {
        // Soft-hold, same rationale as the malformed-envelope path above (enable-gate must-fix).
        this.logger.warn(
          `anthropic api: ${portfolioTool.name} payload failed schema validation (portfolio batch) — holding all — ${describeSchemaFailure(tradePortfolioParsed.error, toolBlock.input)}`,
        );
        return this.softHoldBatch(
          resolved,
          usage,
          latencyMs,
          ctx.playbookVersion,
          promptHash,
          consultId,
          !ctx.infoContextControlArm,
          ctx.thinkingArm,
        );
      }
      const { nextConsultBars } = tradePortfolioParsed.data;
      const bySymbolTrade = new Map<string, unknown>();
      for (const raw of tradePortfolioParsed.data.decisions) {
        const symbolField = elementSymbolSchema.safeParse(raw);
        if (symbolField.success) bySymbolTrade.set(symbolField.data.symbol, raw);
      }
      // sizeFractionMax is a zod numeric bound (a fraction, not a money computation) — same
      // convention as propose()'s own tradeContract branch (S3/A1).
      // eslint-disable-next-line no-restricted-syntax -- Number() is the correct non-money coercion here.
      const maxPositionFractionNum = Number(ctx.maxPositionFraction);
      const tradeElemSchema = this.cfg.shortsEnabled
        ? tradeShortsElementSchema(maxPositionFractionNum)
        : tradeElementSchema(maxPositionFractionNum);

      resolved.forEach((r, i) => {
        const usageForThis = i === 0 ? usage : undefined;
        const raw = bySymbolTrade.get(r.symbolKey);
        if (raw === undefined) {
          this.logger.warn(
            `anthropic api: symbol ${r.symbolKey} missing from ${portfolioTool.name} decisions — holding`,
          );
          proposals.set(r.symbolKey, {
            signals: [],
            ...(usageForThis ? { usage: usageForThis } : {}),
            latencyMs,
            playbookVersion: ctx.playbookVersion,
            promptHash,
            inputPayload: r.inputPayload,
            consultId,
            nextConsultBars,
            infoArm: !ctx.infoContextControlArm,
            thinkingArm: ctx.thinkingArm,
          });
          return;
        }
        const parsedElement = tradeElemSchema.safeParse(raw);
        if (!parsedElement.success) {
          this.logger.warn(
            `anthropic api: ${portfolioTool.name} element for symbol ${r.symbolKey} failed schema validation — holding`,
          );
          proposals.set(r.symbolKey, {
            signals: [],
            ...(usageForThis ? { usage: usageForThis } : {}),
            latencyMs,
            playbookVersion: ctx.playbookVersion,
            promptHash,
            inputPayload: r.inputPayload,
            consultId,
            nextConsultBars,
            infoArm: !ctx.infoContextControlArm,
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
          baseProfile: ctx.baseProfile,
          usage: usageForThis,
          latencyMs,
          playbookVersion: ctx.playbookVersion,
          promptHash,
          inputPayload: r.inputPayload,
          consultId,
          infoArm: !ctx.infoContextControlArm,
          thinkingArm: ctx.thinkingArm,
        });
        // A2: stamped on EVERY returned proposal (Design table: "portfolio-level, one per batch
        // response") — including a fee-floor-rejected element, whose own mapping already returns
        // without a nextConsultBars of its own.
        proposals.set(r.symbolKey, { ...proposal, nextConsultBars });
      });

      return { proposals, usage };
    }

    const portfolioParsed = portfolioDecisionsSchema.safeParse(toolBlock.input);
    if (!portfolioParsed.success) {
      // Soft-hold, same rationale as the malformed-envelope path above (enable-gate must-fix).
      this.logger.warn(
        `anthropic api: ${portfolioTool.name} payload failed schema validation (portfolio batch) — holding all — ${describeSchemaFailure(portfolioParsed.error, toolBlock.input)}`,
      );
      return this.softHoldBatch(
        resolved,
        usage,
        latencyMs,
        ctx.playbookVersion,
        promptHash,
        consultId,
        !ctx.infoContextControlArm,
        ctx.thinkingArm,
      );
    }

    // Element-level: a decisions[] entry that fails full validation (or a requested symbol absent
    // from decisions[] entirely) degrades ONLY that symbol to a hold — never the whole batch.
    const bySymbol = new Map<string, unknown>();
    for (const raw of portfolioParsed.data.decisions) {
      const symbolField = elementSymbolSchema.safeParse(raw);
      if (symbolField.success) bySymbol.set(symbolField.data.symbol, raw);
    }
    const elementSchema = this.cfg.planMode
      ? this.cfg.shortsEnabled
        ? planShortsElementSchema
        : planElementSchema
      : this.cfg.shortsEnabled
        ? shortsDecisionElementSchema
        : decisionElementSchema;

    resolved.forEach((r, i) => {
      const usageForThis = i === 0 ? usage : undefined;
      const raw = bySymbol.get(r.symbolKey);
      if (raw === undefined) {
        this.logger.warn(
          `anthropic api: symbol ${r.symbolKey} missing from submit_portfolio decisions — holding`,
        );
        proposals.set(r.symbolKey, {
          signals: [],
          ...(usageForThis ? { usage: usageForThis } : {}),
          latencyMs,
          playbookVersion: ctx.playbookVersion,
          promptHash,
          inputPayload: r.inputPayload,
          consultId,
          infoArm: !ctx.infoContextControlArm,
          thinkingArm: ctx.thinkingArm,
        });
        return;
      }
      const parsedElement = elementSchema.safeParse(raw);
      if (!parsedElement.success) {
        this.logger.warn(
          `anthropic api: submit_portfolio element for symbol ${r.symbolKey} failed schema validation — holding`,
        );
        proposals.set(r.symbolKey, {
          signals: [],
          ...(usageForThis ? { usage: usageForThis } : {}),
          latencyMs,
          playbookVersion: ctx.playbookVersion,
          promptHash,
          inputPayload: r.inputPayload,
          consultId,
          infoArm: !ctx.infoContextControlArm,
          thinkingArm: ctx.thinkingArm,
        });
        return;
      }
      const { action, confidence, rationale } = parsedElement.data;
      const rawPlan: z.infer<typeof planFieldSchema> = this.cfg.planMode
        ? (parsedElement.data as z.infer<typeof planElementSchema>).plan
        : undefined;
      proposals.set(
        r.symbolKey,
        this.buildProposalFromDecision({
          input: r.input,
          symbol: r.symbolId,
          venue: r.venue,
          refPrice: r.refPrice,
          basedOnSeq: r.basedOnSeq,
          eventTime: r.eventTime,
          lastCandle: r.lastCandle,
          decision: { action, confidence, rationale },
          rawPlan,
          baseProfile: ctx.baseProfile,
          usage: usageForThis,
          latencyMs,
          playbookVersion: ctx.playbookVersion,
          promptHash,
          inputPayload: r.inputPayload,
          consultId,
          infoArm: !ctx.infoContextControlArm,
          thinkingArm: ctx.thinkingArm,
        }),
      );
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
  ): AgentProposeBatchResult {
    const proposals = new Map<string, AgentProposal>();
    resolved.forEach((r, i) => {
      proposals.set(r.symbolKey, {
        signals: [],
        ...(i === 0 && usage ? { usage } : {}),
        latencyMs,
        playbookVersion,
        promptHash,
        inputPayload: r.inputPayload,
        consultId,
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
    readonly activeTool:
      | typeof DECISION_TOOL
      | typeof SHORTS_DECISION_TOOL
      | typeof PLAN_TOOL
      | typeof PLAN_SHORTS_TOOL
      | ReturnType<typeof buildTradeTool>
      | ReturnType<typeof buildTradeShortsTool>;
    readonly baseTemplateVersion: string;
    readonly feedTags: readonly string[];
    readonly infoContextControlArm: boolean;
    readonly thinkingArm: boolean;
    readonly derivativesV2Enabled: boolean;
    // A1: the lane cap string, re-exposed so propose()'s v2 branch can derive the SAME value's
    // numeric form for tradeDecisionSchema/tradeShortsDecisionSchema's zod bound — one source
    // (cfg.maxPositionFraction via this local), never a second hand-computed fallback.
    readonly maxPositionFraction: string;
  }> {
    const { content: playbookContent, version: playbookVersion } = await this.resolvePlaybook();
    const baseProfile = this.cfg.profile ?? DEFAULT_TRADING_PROFILE;

    // Information-context A/B (2026-07-12; widened 2026-07-13 to also cover tradeFlow/positioning):
    // one control arm gates the whole EXTRA-INFORMATION bundle — derivatives, cross-symbol relative
    // strength, trade-flow/CVD, and positioning all move together, so the two live arms stay a clean
    // "baseline (price only) vs baseline + extra information" contrast rather than an N-way split
    // that would fragment the already-thin per-variant trade count. Fires when the A/B pct > 0 AND at
    // least one info feed is on (nothing to withhold otherwise). Bucketed by abArm (ab-assignment.ts)
    // — an independent keyed PRF over `'info-ctx-v1':minute` — so this arm's assignment is unrelated
    // to any other arm's (a shared minute counter with per-arm offsets, the prior scheme, is a phase
    // shift of one signal and stays mathematically dependent across arms). Reuses the deployed
    // AGENTIC_DERIVATIVES_AB_PCT knob (unrenamed: it is the one shared info-context A/B percentage,
    // not derivatives-specific).
    const infoContextAbPct = this.cfg.derivativesAbPct ?? 0;
    const anyInfoFeed =
      (this.cfg.derivativesFeedEnabled ?? false) ||
      (this.cfg.crossSymbolFeedEnabled ?? false) ||
      (this.cfg.tradeFlowFeedEnabled ?? false) ||
      (this.cfg.positioningFeedEnabled ?? false) ||
      (this.cfg.liquidationsFeedEnabled ?? false);
    const infoContextControlArm =
      anyInfoFeed &&
      infoContextAbPct > 0 &&
      abArm(Math.floor(Date.now() / 60_000), 'info-ctx-v1', infoContextAbPct);
    // The invariant this whole mechanism exists to hold: for each block, its system sentence, its
    // promptHash tag, and its payload key all move TOGETHER per arm — a single boolean gates all
    // four rather than independently-computed conditions that could drift apart.
    const effectiveDerivativesEnabled =
      (this.cfg.derivativesFeedEnabled ?? false) && !infoContextControlArm;
    // d2: inert whenever the derivatives block itself is withheld (control arm, or the feed off) —
    // gated INSIDE effectiveDerivativesEnabled so a control-arm decide can never tag d2.
    const effectiveDerivativesV2Enabled =
      effectiveDerivativesEnabled && (this.cfg.derivativesV2Enabled ?? false);
    const effectiveCrossSymbolEnabled =
      (this.cfg.crossSymbolFeedEnabled ?? false) && !infoContextControlArm;
    const effectiveTradeFlowEnabled =
      (this.cfg.tradeFlowFeedEnabled ?? false) && !infoContextControlArm;
    const effectivePositioningEnabled =
      (this.cfg.positioningFeedEnabled ?? false) && !infoContextControlArm;
    const effectiveLiquidationsEnabled =
      (this.cfg.liquidationsFeedEnabled ?? false) && !infoContextControlArm;
    if (infoContextControlArm) {
      // No recorder seam reaches this client (MetricsWrappingAgentClient wraps AgentClientPort at the
      // composition root, outside AnthropicAgentClientConfig) — one structured log line per
      // control-arm decide (or, when batched, per control-arm BATCH) is the observability surface
      // until/unless that seam is threaded through.
      this.logger.warn(
        `agentic info-context ab: control arm (derivatives+crossSymbol+tradeFlow+positioning+liquidation withheld) — pct=${infoContextAbPct}`,
      );
    }
    // S3: thinking A/B (#42) retired — every decide/batch call now carries thinking:{type:'adaptive'}
    // unconditionally (Design § Deleted/replaced scaffolding: "Thinking enabled always on decide
    // (adaptive) ... thinking A/B arm retired"). thinkingArm stays a real field (no longer a coin
    // flip) purely so AgentProposal.thinkingArm/journal stamping and the '+th1' promptHash tag below
    // stay byte-identical in shape to pre-S3 — every caller of ctx.thinkingArm downstream is
    // unaffected by this simplification.
    const thinkingArm = true;
    // S3: the lane cap injected into the v2 tool description at construction (buildTradeTool/
    // buildTradeShortsTool below take the string form for their description text; A1's mapping step
    // parses the SAME cfg.maxPositionFraction into the numeric zod bound when it wires
    // tradeDecisionSchema/tradeShortsDecisionSchema into the response-parsing path).
    const maxPositionFraction = this.cfg.maxPositionFraction ?? DEFAULT_MAX_POSITION_FRACTION;
    // v5: constraints no longer render into the system prompt (they ride the payload below), so the
    // cached tools+system prefix is byte-identical across all symbols this shared client serves —
    // and, for the batch path, across every symbol in the SAME batch too.
    const systemPrompt = buildSystemPrompt(baseProfile, {
      ...(this.cfg.tradeContract
        ? { tradeContract: true }
        : this.cfg.planMode
          ? {
              planMode: true,
              minEdgeMultiple: this.cfg.minEdgeMultiple ?? '1.5',
              minRr: this.cfg.minRr ?? '1.5',
            }
          : {}),
      derivativesFeedEnabled: effectiveDerivativesEnabled,
      derivativesV2Enabled: effectiveDerivativesV2Enabled,
      sentimentFeedEnabled: this.cfg.sentimentFeedEnabled ?? false,
      shortsEnabled: this.cfg.shortsEnabled ?? false,
      crossSymbolFeedEnabled: effectiveCrossSymbolEnabled,
      tradeFlowFeedEnabled: effectiveTradeFlowEnabled,
      positioningFeedEnabled: effectivePositioningEnabled,
      liquidationsFeedEnabled: effectiveLiquidationsEnabled,
      bookStructureFeedEnabled: this.cfg.bookStructureFeedEnabled ?? false,
      trackRecordFeedEnabled: this.cfg.trackRecordFeedEnabled ?? false,
    });
    // S3: tradeContract selects the v2 submit_trade tool, checked BEFORE planMode (mirrors
    // buildSystemPrompt's own tradeContract-first precedence — the two modes are mutually exclusive
    // by construction, never stacked). B3: shortsEnabled selects SHORTS_DECISION_TOOL in place of
    // DECISION_TOOL on the legacy path. Push II Phase 8: shortsEnabled + planMode selects
    // PLAN_SHORTS_TOOL in place of PLAN_TOOL instead (construction already refused this combination
    // on a non-perp venue — see the constructor guard). This is the tool actually SENT to the API for
    // the single-symbol path (proposeBatch always sends PORTFOLIO_TOOL instead — see its own body;
    // A2 owns wiring its v2/tpf1/tpf2 sibling).
    const activeTool = this.cfg.tradeContract
      ? this.cfg.shortsEnabled
        ? buildTradeShortsTool(maxPositionFraction)
        : buildTradeTool(maxPositionFraction)
      : this.cfg.planMode
        ? this.cfg.shortsEnabled
          ? PLAN_SHORTS_TOOL
          : PLAN_TOOL
        : this.cfg.shortsEnabled
          ? SHORTS_DECISION_TOOL
          : DECISION_TOOL;
    // p3→p4: the plan-mode template tag bumps ONLY when shortsEnabled is also on (a distinct
    // constant, not a mutation of PLAN_TEMPLATE_VERSION — see agent-prompt.ts's own comment) so a
    // shortsEnabled=false deployment's plan-mode hash stays byte-identically 'p3'. Same convention for
    // t1→t1s on the tradeContract path.
    const baseTemplateVersion = this.cfg.tradeContract
      ? this.cfg.shortsEnabled
        ? TRADE_SHORTS_TEMPLATE_VERSION
        : TRADE_TEMPLATE_VERSION
      : this.cfg.planMode
        ? this.cfg.shortsEnabled
          ? PLAN_SHORTS_TEMPLATE_VERSION
          : PLAN_TEMPLATE_VERSION
        : PROMPT_TEMPLATE_VERSION;
    // Flag-ON appends the corresponding system-prompt sentence, so it is a distinct template for
    // attribution purposes (mirrors plan mode's own tag); flag-OFF hashes are byte-identical. All
    // flags stack in a fixed order (`+d1+s1+x1+xs1+tf1+pos1`, `+pf1` appended by proposeBatch's own
    // caller when this batch was served via submit_portfolio) so a multi-flag hash is deterministic
    // regardless of which flag flipped first.
    const feedTags = [
      // d2: a SWITCH within the same slot (never `+d1+d2` stacked) — see DERIVATIVES_V2_TEMPLATE_
      // VERSION's own comment.
      ...(effectiveDerivativesEnabled
        ? [
            effectiveDerivativesV2Enabled
              ? DERIVATIVES_V2_TEMPLATE_VERSION
              : DERIVATIVES_TEMPLATE_VERSION,
          ]
        : []),
      ...(this.cfg.sentimentFeedEnabled ? [SENTIMENT_TEMPLATE_VERSION] : []),
      // x1 marks the LEGACY (non-plan) shorts prompt shape only — the plan-shorts combination is
      // already fully identified by the p4 base tag, so stacking x1 onto p4 would contradict the
      // documented design (review nice-to-have: code now matches SHORTS_TEMPLATE_VERSION's comment).
      ...(this.cfg.shortsEnabled && !this.cfg.planMode ? [SHORTS_TEMPLATE_VERSION] : []),
      ...(effectiveCrossSymbolEnabled ? [CROSS_SYMBOL_TEMPLATE_VERSION] : []),
      ...(effectiveTradeFlowEnabled ? [TRADEFLOW_TEMPLATE_VERSION] : []),
      ...(effectivePositioningEnabled ? [POSITIONING_TEMPLATE_VERSION] : []),
      ...(effectiveLiquidationsEnabled ? [LIQUIDATION_TEMPLATE_VERSION] : []),
      ...(this.cfg.bookStructureFeedEnabled ? [BOOK_STRUCTURE_TEMPLATE_VERSION] : []),
      ...(this.cfg.trackRecordFeedEnabled ? [TRACK_RECORD_TEMPLATE_VERSION] : []),
      // #42: last slot by design — a REQUEST-param arm, not a prompt-content tag; see above.
      ...(thinkingArm ? [THINKING_TEMPLATE_VERSION] : []),
    ];

    return {
      playbookContent,
      playbookVersion,
      baseProfile,
      systemPrompt,
      activeTool,
      baseTemplateVersion,
      feedTags,
      infoContextControlArm,
      thinkingArm,
      derivativesV2Enabled: effectiveDerivativesV2Enabled,
      maxPositionFraction,
    };
  }

  // The per-symbol proposal-mapping tail SHARED by propose() (one symbol) and proposeBatch() (once
  // per resolved decisions[] element) — the plan/knob/floor validation and Signal-kind mapping table
  // are byte-identical between the two callers by construction (one method, not two copies).
  private buildProposalFromDecision(params: {
    readonly input: AgentDecisionInput;
    readonly symbol: SymbolId;
    readonly venue: VenueId;
    readonly refPrice: Price;
    readonly basedOnSeq: bigint;
    readonly eventTime: EpochMs;
    readonly lastCandle: CandleEvent | undefined;
    readonly decision: {
      readonly action: 'long' | 'short' | 'flat' | 'hold';
      readonly confidence: number;
      readonly rationale: string;
    };
    readonly rawPlan: z.infer<typeof planFieldSchema>;
    readonly baseProfile: AgentTradingProfile;
    readonly usage: AgentUsage | undefined;
    readonly latencyMs: number;
    readonly playbookVersion: number | undefined;
    readonly promptHash: string;
    readonly inputPayload: string;
    // Batch-attribution join key (Push II Phase 5 follow-on) — see AgentProposal.consultId.
    // Absent on the single-symbol propose() path; proposeBatch passes its one per-batch id.
    readonly consultId?: string;
    // Push 3 P8a-prep — see AgentProposal.infoArm/thinkingArm. Both callers (propose/proposeBatch)
    // always pass these once ctx has resolved; never absent here.
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
      rawPlan,
      baseProfile,
      usage,
      latencyMs,
      playbookVersion,
      promptHash,
      inputPayload,
      consultId,
      infoArm,
      thinkingArm,
    } = params;
    const { action, confidence, rationale } = params.decision;

    // AgentPositionSummary.side is 'LONG' | 'SHORT' | 'FLAT' at the port level (widened by Push II
    // Phase 8 — see its own comment); no `as` upcast needed here anymore. A shorts-disabled
    // deployment's side can never actually be 'SHORT' (agentic.strategy.ts's buildContext never
    // populates it without a strategy that emits ENTER_SHORT), so every SHORT-side arm below stays
    // unreachable dead code there — reachable now via plan-mode shorts (this client's own
    // shortsEnabled + planMode combination) and via the legacy non-plan shortsEnabled path.
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
    // Push II Phase 8: renamed from opensNewLong/rearmsOpenLong — in plan mode, action 'long' opens
    // a NEW plan-managed position of EITHER direction (rawPlan.direction picks it; see the mapping
    // table below), and a re-arm now also applies while the open position is SHORT.
    const opensNewPosition = action === 'long' && side === 'FLAT';
    const rearmsOpenPosition =
      (side === 'LONG' || side === 'SHORT') && (action === 'hold' || action === 'long');

    if (this.cfg.planMode && rawPlan && (opensNewPosition || rearmsOpenPosition)) {
      const feeFraction = new Decimal(baseProfile.makerBps).plus(baseProfile.takerBps).div(10_000);
      // P1: the playbook-knob widening of these floors (max(configured, knob)) was deleted along
      // with the rest of the knob channel — these are the plain configured floors now, on both a
      // fresh entry and a re-arm (byte-identical to a knob-absent decide pre-P1).
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
            // action can never actually be 'short' on the plan-mode path (planSchema/planShortsSchema
            // both keep the enum 'long' | 'flat' | 'hold' — direction rides on rawPlan.direction
            // instead, see the mapping table below); see the cast comment on the final return below
            // for why a cast (not a port widening) is used regardless.
            action: action as 'long' | 'flat' | 'hold',
            confidence,
            rationale: `[plan rejected: ${rejectionTag}] ${rationale}`,
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

    let signals: Signal[];
    // A1 (S2-widening migration, per ports/agentic-strategy.ts's AgentProposal.plan comment: "A1:
    // anthropic-agent-client.ts's acceptedPlan"): retyped AgentPlan → AgentDirectives so this legacy
    // plan-mode construction satisfies the same AgentProposal.plan field the v2 path now carries.
    // entryStyle is a substantively correct 'maker' (legacy plan-mode ALWAYS rests a passive
    // entryOffsetBps-priced limit order — see the limitPriceHint computation just below — never a
    // crossing/taker price). sizeFraction has no legacy equivalent (legacy sizing runs entirely
    // through Signal.strength × baseNotional/equityFraction, never through a plan-carried fraction) —
    // '0' is an inert sentinel; plan-executor.ts (B1) and agentic.strategy.ts (B3) enforcement never
    // read AgentDirectives.sizeFraction (a sizing-only field), only the v2 client path does.
    let acceptedPlan: AgentDirectives | undefined;
    if (action === 'long' && side === 'FLAT') {
      // Push II Phase 8: in plan mode, action 'long' means "open a new plan-managed position" —
      // rawPlan.direction (schema-required whenever shortsEnabled) picks the actual side; absent
      // (shortsEnabled off, or the legacy non-plan path) ⇒ long, byte-identical to pre-Phase-8.
      // shortsEnabled is a REQUIRED conjunct (review finding): without it a spurious direction
      // field surviving strict tool use would emit ENTER_SHORT on a shorts-off spot deployment
      // that never passed the perp construction guard — fail closed, ignore the field instead.
      const isShortEntry =
        this.cfg.shortsEnabled === true && this.cfg.planMode && rawPlan?.direction === 'short';
      // Plan mode: the plan's own entry offset prices the resting entry (positive bps = below the
      // last close for a long, ABOVE close for a short — mirrored, each side's own cheaper resting
      // price) and supersedes the book-touch hint; legacy mode keeps the bestBid hint.
      let limitPriceHint: Price | undefined;
      if (this.cfg.planMode && rawPlan && lastCandle) {
        const offsetFraction = new Decimal(rawPlan.entryOffsetBps).div(10_000);
        const offsetHint = new Decimal(lastCandle.close.toFixed())
          .mul(
            isShortEntry
              ? new Decimal(1).plus(offsetFraction)
              : new Decimal(1).minus(offsetFraction),
          )
          .toDecimalPlaces(8);
        limitPriceHint = price(offsetHint.toFixed());
        acceptedPlan = {
          sizeFraction: '0',
          entryStyle: 'maker',
          entryOffsetBps: rawPlan.entryOffsetBps,
          stopLossPct: String(rawPlan.stopLossPct),
          takeProfitPct: String(rawPlan.takeProfitPct),
          entryValidityBars: rawPlan.entryValidityBars,
          maxHoldBars: rawPlan.maxHoldBars,
          ...(rawPlan.direction ? { direction: rawPlan.direction } : {}),
        };
      } else if (!isShortEntry) {
        limitPriceHint = this.bookEntryHint(input.snapshot.books.get(symbol), refPrice);
      }
      signals = [
        {
          ...common,
          kind: isShortEntry ? 'ENTER_SHORT' : 'ENTER_LONG',
          strength: Math.min(MAX_STRENGTH, Math.max(MIN_STRENGTH, confidence)),
          // Omitted entirely (no key) rather than undefined when no book/no near-touch bid — see
          // bookEntryHint's own comment.
          ...(limitPriceHint ? { limitPriceHint } : {}),
        },
      ];
    } else if (action === 'flat' && side === 'LONG') {
      signals = [{ ...common, kind: 'EXIT_LONG', strength: MAX_STRENGTH }];
    } else if (this.cfg.shortsEnabled && action === 'flat' && side === 'SHORT') {
      // Direction-agnostic: 'flat' always closes whatever is open. Reachable from BOTH the legacy
      // (non-plan) shorts path and plan-mode shorts (a SHORT position can only exist if one of the
      // two opened it) — the exit itself is identical either way, so no cfg.planMode branch needed.
      signals = [{ ...common, kind: 'EXIT_SHORT', strength: MAX_STRENGTH }];
    } else if (
      !this.cfg.planMode &&
      this.cfg.shortsEnabled &&
      action === 'short' &&
      side === 'FLAT'
    ) {
      // Legacy decision path ONLY — action 'short' can never arrive in plan mode (planSchema/
      // planShortsSchema both keep the action enum long/flat/hold; direction rides on
      // rawPlan.direction instead, handled by the entry branch above). No book-aware limitPriceHint
      // here: bookEntryHint (below) is long-specific — a resting BID near refPrice is a cheaper LONG
      // entry, but the equivalent cheaper SHORT entry would be a resting ASK, the opposite side of
      // the book. Reusing bookEntryHint would price a short entry on the wrong side, so a short
      // entry always uses the plain refPrice-based sizing path.
      signals = [
        {
          ...common,
          kind: 'ENTER_SHORT',
          strength: Math.min(MAX_STRENGTH, Math.max(MIN_STRENGTH, confidence)),
        },
      ];
    } else if (
      !this.cfg.planMode &&
      this.cfg.shortsEnabled &&
      action === 'long' &&
      side === 'SHORT'
    ) {
      // Legacy decision path ONLY (guarded by !planMode): close the short first — never a same-bar
      // flip straight to ENTER_LONG. The model re-decides next bar once flat, the same
      // close-then-reenter discipline as every other direction change. In PLAN mode this exact
      // (action, side) pair means something different — re-arming the open SHORT position — see the
      // final else branch below; the !planMode guard keeps the two from colliding.
      signals = [{ ...common, kind: 'EXIT_SHORT', strength: MAX_STRENGTH }];
    } else if (
      !this.cfg.planMode &&
      this.cfg.shortsEnabled &&
      action === 'short' &&
      side === 'LONG'
    ) {
      // Symmetric to the arm above: close the long first, never a same-bar flip to ENTER_SHORT.
      // action 'short' can never arrive in plan mode, so no planMode guard is needed here (unlike
      // the arm above, there is no plan-mode meaning of this pair to collide with).
      signals = [{ ...common, kind: 'EXIT_LONG', strength: MAX_STRENGTH }];
    } else {
      // 'hold'; 'long'/'hold' while already LONG or SHORT (plan mode: a re-arm, see below); 'flat'
      // while already FLAT; 'short' while already SHORT (legacy only) — all no-ops. A flag-off
      // 'short' action can't even reach here: decisionSchema/DECISION_TOOL never accept 'short' as a
      // valid action in the first place.
      signals = [];
      // W3.1 re-arm, widened by Push II Phase 8 to also cover an open SHORT: a floors-passing plan
      // on hold/long while LONG or SHORT emits no signal — it only re-attaches deterministic
      // management to the existing position (restart self-heal; the strategy arms it and the first
      // managed bar anchors stop/TP to the real avgEntry). FLAT holds never arm: a plan with no
      // position and no resting entry would only tick down to plan_expired noise. rawPlan.direction
      // is NEVER used here — the position's OWN side is what the executor manages; a re-arm cannot
      // flip direction mid-position (see AgentPlan.direction's own comment).
      if (this.cfg.planMode && rawPlan && rearmsOpenPosition) {
        acceptedPlan = {
          sizeFraction: '0',
          entryStyle: 'maker',
          entryOffsetBps: rawPlan.entryOffsetBps,
          stopLossPct: String(rawPlan.stopLossPct),
          takeProfitPct: String(rawPlan.takeProfitPct),
          entryValidityBars: rawPlan.entryValidityBars,
          maxHoldBars: rawPlan.maxHoldBars,
          ...(side === 'SHORT' ? { direction: 'short' as const } : {}),
        };
      }
    }

    return {
      signals,
      // AgentDecisionMeta.action stays 'long' | 'flat' | 'hold' at the port level (see its own
      // comment) — widening it ripples into agentic.strategy.ts's decision-history ring, the
      // persisted agent_decisions journal, counterfactual-scoring.ts's calibration module, AND the
      // abstention-lapse entry counts (AgentDecisionJournalPort.versionEntryStats — both
      // implementations count action='long' as the only entry kind, so a shorts-only candidate
      // would read entries=0 and be falsely lapsed until that widening lands),
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
      ...(consultId ? { consultId } : {}),
      infoArm,
      thinkingArm,
    };
  }

  // A1 (rich decision contract, Design § New tool contract, action-mapping paragraph): the v2
  // sibling of buildProposalFromDecision above — maps a tradeDecisionSchema/tradeShortsDecisionSchema
  // parse into signals + AgentDirectives. Deliberately a SEPARATE method (see propose()'s own
  // tradeContract branch comment) rather than a fourth arm folded into the legacy mapping: the v2
  // action vocabulary ('open_long'/'open_short'/'close'/'adjust'/'hold') and directive shape share no
  // structure with the legacy plan/confidence fields, so a shared function would force every legacy
  // arm to guard against fields it never has. None of the deleted v2-path gates (MIN_STRENGTH/
  // MAX_STRENGTH confidence clamp, playbook confidence-floor downgrade, min-RR floor, stop-vs-fee
  // check, minEdgeMultiple scaling) are referenced here at all — the ONLY economic gate surviving on
  // this path is the takeProfitPct-vs-round-trip-fee floor below (Design § Deleted/replaced
  // scaffolding: "One gate survives").
  private buildProposalFromTradeDecision(params: {
    readonly input: AgentDecisionInput;
    readonly symbol: SymbolId;
    readonly venue: VenueId;
    readonly refPrice: Price;
    readonly basedOnSeq: bigint;
    readonly eventTime: EpochMs;
    readonly lastCandle: CandleEvent | undefined;
    readonly decision: TradeDecisionV2;
    readonly baseProfile: AgentTradingProfile;
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
      baseProfile,
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
      const feeFraction = new Decimal(baseProfile.makerBps).plus(baseProfile.takerBps).div(10_000);
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
      if (side === 'LONG') {
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
    }
    // 'hold', 'adjust' while FLAT, 'close' while FLAT: signals/plan stay at their defaults.

    return {
      signals,
      decision: { action, confidence: null, rationale: thesis ?? '' },
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
    // P1: capability-aware denylist. This config never carries a separate perp/leverage marker —
    // cfg.shortsEnabled ALREADY doubles as the perp-lane selector by the same convention the v2
    // system prompt and maxPositionFraction lane cap use (see shortsEnabled's own comment above);
    // a spot deployment (shortsEnabled false) keeps both pattern families enforced.
    const validation = validatePlaybook(stored.content, {
      shortsAllowed: this.cfg.shortsEnabled ?? false,
      leverageAllowed: this.cfg.shortsEnabled ?? false,
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
  // cause and never credentials); the key itself never appears in any error path.
  private handleFailure(err: AgentProposeError): void {
    if (err.kind === 'FATAL') {
      this.logger.warn(
        `anthropic api: fatal error (status ${err.status ?? 'n/a'}) — latching agent client to degraded, no further calls will be made — ${err.message}`,
      );
      this.degraded = true;
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
    tool:
      | typeof DECISION_TOOL
      | typeof SHORTS_DECISION_TOOL
      | typeof PLAN_TOOL
      | typeof PLAN_SHORTS_TOOL
      | typeof PORTFOLIO_TOOL
      | typeof PORTFOLIO_SHORTS_TOOL
      // S3: prepareDecideContext's activeTool can now also be a v2 submit_trade tool.
      | ReturnType<typeof buildTradeTool>
      | ReturnType<typeof buildTradeShortsTool>
      // A2: proposeBatch's portfolioTool can now also be a v2 submit_portfolio tool.
      | ReturnType<typeof buildTradePortfolioTool>
      | ReturnType<typeof buildTradePortfolioShortsTool>,
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
    tool:
      | typeof DECISION_TOOL
      | typeof SHORTS_DECISION_TOOL
      | typeof PLAN_TOOL
      | typeof PLAN_SHORTS_TOOL
      | typeof PORTFOLIO_TOOL
      | typeof PORTFOLIO_SHORTS_TOOL
      // S3: prepareDecideContext's activeTool can now also be a v2 submit_trade tool.
      | ReturnType<typeof buildTradeTool>
      | ReturnType<typeof buildTradeShortsTool>
      // A2: proposeBatch's portfolioTool can now also be a v2 submit_portfolio tool.
      | ReturnType<typeof buildTradePortfolioTool>
      | ReturnType<typeof buildTradePortfolioShortsTool>,
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
          // B3: `tool` is the caller's precomputed `activeTool`/PORTFOLIO_TOOL — previously
          // re-derived here from cfg.planMode alone, which would have sent the narrow DECISION_TOOL
          // even when shortsEnabled was on, making 'short' unreachable.
          tools: [tool],
          tool_choice: { type: 'tool', name: tool.name },
          // Omitting `thinking` on claude-sonnet-5 silently runs (billed) adaptive thinking, so it
          // is always explicit here: 'disabled' by default (structured tool-use has no use for it),
          // or 'adaptive' when the caller's #42 thinking-A/B treatment arm fired. Reflection has
          // its own separate request builder (see reflection.service.ts) and is unaffected.
          thinking,
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
