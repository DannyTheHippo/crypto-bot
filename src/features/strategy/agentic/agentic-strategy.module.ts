import { Logger, Module } from '@nestjs/common';
import Decimal from 'decimal.js';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { DEFAULT_FILTERS } from '../../../domain/trading/risk/default-filters';
import { price, qty } from '../../../domain/common/types/money';
import {
  AGENT_CLIENT,
  AGENT_DECISION_JOURNAL,
  PLAYBOOK_PROVIDER,
  EDGE_POLICY,
  type AgentClientPort,
  type AgentDecisionJournalPort,
  type AgentTradingProfile,
  type EdgePolicyPort,
  type PlaybookProvider,
} from '../../../ports/strategy/agentic-strategy';
import { BudgetedAgentClient, DailyLlmBudget, type ModelTokenRates } from './agent-budget';
import { StubAgentClient } from './agent-client.adapter';
import { AnthropicAgentClient, type AnthropicAgentClientConfig } from './anthropic-agent-client';
import { BatchingAgentClient, type ActiveMenuGate } from './batching-agent-client';
import { createEdgePolicyPort, EDGE_POLICY_OVERRIDE } from './disabled-edge-policy';
import { MAX_SIMILAR_SETUPS } from './episodic-memory';

// Matches AGENTIC_MODEL's schema default and the AGENTIC_TOKEN_PRICE_* defaults (Sonnet-5 at 3/15)
// — see environment.config.ts's AGENTIC_MODEL comment for the cost-honesty rationale.
const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_SIGNAL_TTL_MS = 120000;
const DEFAULT_MAX_CALLS_PER_DAY = 500;
const DEFAULT_MAX_TOKENS_PER_DAY = 2_000_000;
// Matches environment.config.ts's AGENTIC_DAILY_COST_STOP_USD/AGENTIC_TOKEN_PRICE_*PER_MTOK defaults.
const DEFAULT_DAILY_COST_STOP_USD = 3;
const DEFAULT_TOKEN_PRICE_INPUT_PER_MTOK = 3;
const DEFAULT_TOKEN_PRICE_OUTPUT_PER_MTOK = 15;
// W4+W13: matches environment.config.ts's AGENTIC_TOKEN_PRICE_CACHE_*_PER_MTOK defaults.
const DEFAULT_TOKEN_PRICE_CACHE_READ_PER_MTOK = 0.3;
const DEFAULT_TOKEN_PRICE_CACHE_WRITE_PER_MTOK = 6;

function intEnv(raw: string | undefined, fallback: number): number {
  return new Decimal(raw ?? fallback).toNumber();
}

// Converts AppConfig.agentic.tokenPrices' decimal-string per-model map into DailyLlmBudgetCaps'
// number-rated ModelTokenRates map (same Decimal(...).toNumber() convention as intEnv above) — the
// composition root's only reachable source for the map (see createAgentLlmBudget's own comment on
// why it isn't re-parsed from AGENTIC_TOKEN_PRICES_JSON here).
function toModelTokenRates(
  tokenPrices:
    | Readonly<
        Record<
          string,
          {
            readonly inputPerMtok: string;
            readonly outputPerMtok: string;
            readonly cacheReadPerMtok: string;
            readonly cacheWritePerMtok: string;
          }
        >
      >
    | undefined,
): Readonly<Record<string, ModelTokenRates>> | undefined {
  if (!tokenPrices) return undefined;
  const out: Record<string, ModelTokenRates> = {};
  for (const [model, rates] of Object.entries(tokenPrices)) {
    out[model] = {
      inputPerMtok: new Decimal(rates.inputPerMtok).toNumber(),
      outputPerMtok: new Decimal(rates.outputPerMtok).toNumber(),
      cacheReadPerMtok: new Decimal(rates.cacheReadPerMtok).toNumber(),
      cacheWritePerMtok: new Decimal(rates.cacheWritePerMtok).toNumber(),
    };
  }
  return out;
}

// Local to this module (see G2b task brief) — health/metrics inject this token to read
// DailyLlmBudget.snapshot() without depending on which AgentClientPort got selected.
export const AGENT_LLM_BUDGET = Symbol('AGENT_LLM_BUDGET');

// Local seam (same pattern as AGENT_LLM_BUDGET above) for the composition root's real playbook store
// (persisted or in-memory — see G3a) to reach AGENT_CLIENT's factory without this module importing
// persistence (feature zones may not cross-import — eslint-plugin-boundaries). Mirrors the app.module
// §7 *_OVERRIDE convention: absent (module-isolation contexts, or no override bound) falls through to
// seedPlaybookProvider() below.
export const PLAYBOOK_PROVIDER_OVERRIDE = Symbol('PLAYBOOK_PROVIDER_OVERRIDE');

// Same seam, for the strategy's AgentTradingProfile (fee bps / sizing / venue constraints folded into
// the system prompt — see AnthropicAgentClientConfig.profile). Built at the composition root from the
// SAME sources Risk/paper fees use (RISK_LIMITS, DEFAULT_FILTERS, DEFAULT_PAPER_CONFIG.fees), never
// duplicated here; absent falls through to AnthropicAgentClient's own illustrative DEFAULT_TRADING_PROFILE.
export const AGENT_TRADING_PROFILE_OVERRIDE = Symbol('AGENT_TRADING_PROFILE_OVERRIDE');

// I1b (Design § Enriched model inputs): same seam pattern as the two overrides above, for the
// composition root's real payload-extras source (portfolio/budget/calendar snapshot) to reach
// AnthropicAgentClientConfig.payloadExtrasProvider without this module importing PORTFOLIO_VIEW/
// AGENT_LLM_BUDGET's snapshot-callers directly. Absent (module-isolation contexts, or no provider
// bound) leaves payloadExtrasProvider undefined — byte-identical to pre-I1b (no portfolio/budget/
// calendar keys ever rendered).
export const PAYLOAD_EXTRAS_PROVIDER_OVERRIDE = Symbol('PAYLOAD_EXTRAS_PROVIDER_OVERRIDE');

// I1 (Design § Universe: scanner-gated active menu): same seam pattern as the two overrides above,
// for the composition root's real UniverseScannerService to reach the batching client's
// ActiveMenuGate (batching-agent-client.ts) without this module importing the scanner directly.
// Absent (module-isolation contexts, or no scanner bound) leaves BatchingAgentClient's gate
// undefined — byte-identical to pre-U1 (every symbol proposes).
export const ACTIVE_MENU_GATE_OVERRIDE = Symbol('ACTIVE_MENU_GATE_OVERRIDE');

// Same seam pattern as PLAYBOOK_PROVIDER_OVERRIDE/AGENT_TRADING_PROFILE_OVERRIDE above, for the
// composition root's real AgentMetricsRecorder (observability module) to reach the AGENT_CLIENT
// factory below without this module importing features/common/observability (boundary wall).
// Consumed via the LOCAL structural type below; absent (module-isolation contexts) leaves the two
// client-side degrade paths unrecorded — telemetry-only, never a safety gate. The name is
// historical: this token was introduced for ReflectionService's validator-rejection tripwire, and
// the reflection loop was deleted 2026-07-30 (research/studies/entry-rate-rederivation-2026-07-30.md)
// while the AGENT_CLIENT consumer stayed.
export const REFLECTION_METRICS_RECORDER_OVERRIDE = Symbol('REFLECTION_METRICS_RECORDER_OVERRIDE');

// The trimmed shape of that recorder the AGENT_CLIENT factory actually needs. Both methods optional:
// see the token's own comment on the module-isolation case.
interface AgentClientMetricsRecorder {
  recordCapabilityViolation?(kind: string): void;
  recordSchemaFailure?(kind: string): void;
}

// Builds the env-shaped record selectAgentClient/createAgentLlmBudget read. Sources the validated
// AGENTIC_* fields (G1c) off TypedConfigService rather than raw process.env when available, so the
// real wiring path and environment.config.ts can never drift; ANTHROPIC_API_KEY/SIGNAL_TTL_MS/
// NODE_ENV/CI stay off AppConfig (secret / not-yet-validated / test-seam) and are read straight off
// process.env either way. Falls back to plain process.env when TypedConfigService is absent
// (module-isolation tests), keeping selectAgentClient's own DEFAULT_* constants as the backstop.
export function agenticEnv(config?: TypedConfigService): Record<string, string | undefined> {
  if (!config) return process.env;
  const agentic = config.agentic;
  // v3 spec §9/§10 work item 3: venue-derived directly off config.venues — the single source of
  // truth for "is this boot's venue short-capable" (never agentic.shortsEnabled, a v3-transitional
  // AppConfig field that derives this SAME boolean only so this module and reflection.service.ts
  // didn't have to be touched at the same time §7 config landed — see environment.config.ts's own
  // comment on that field). Mirrors position-sizer.service.ts's own local PERP_VENUE_ID convention
  // (binanceusdm is the only perp venue this pass wires).
  const perpVenueConfigured = config.venues.some((v) => v.id === 'binanceusdm');
  return {
    ...process.env,
    AGENTIC_MODEL: agentic.model,
    AGENTIC_REFLECTION_MODEL: agentic.reflectionModel,
    AGENTIC_TIMEOUT_MS: String(agentic.timeoutMs),
    AGENTIC_REFLECTION_TIMEOUT_MS: String(agentic.reflectionTimeoutMs),
    AGENTIC_MAX_TOKENS: String(agentic.maxTokens),
    AGENTIC_MAX_CALLS_PER_DAY: String(agentic.maxCallsPerDay),
    AGENTIC_MAX_TOKENS_PER_DAY: String(agentic.maxTokensPerDay),
    AGENTIC_DAILY_COST_STOP_USD: String(agentic.dailyCostStopUsd),
    AGENTIC_TOKEN_PRICE_INPUT_PER_MTOK: agentic.tokenPriceInputPerMtok,
    AGENTIC_TOKEN_PRICE_OUTPUT_PER_MTOK: agentic.tokenPriceOutputPerMtok,
    AGENTIC_REFLECTION_EVERY_N_TRADES: String(agentic.reflectionEveryNTrades),
    AGENTIC_REFLECTION_COOLDOWN_MS: String(agentic.reflectionCooldownMs),
    AGENTIC_AUTO_PROMOTE_MIN_TRADES: String(agentic.autoPromoteMinTrades),
    AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES: String(agentic.autoPromoteMinAttributedTrades),
    AGENTIC_PLAN_MODE: String(agentic.planMode),
    AGENTIC_SHORTS_ENABLED: String(perpVenueConfigured),
    AGENTIC_PERP_VENUE: String(perpVenueConfigured),
    // D1 retired AGENTIC_MIN_EDGE_MULTIPLE/AGENTIC_MIN_RR off AppConfig.agentic (the fee-floor-only
    // gate replaces both — Design § Deleted/replaced scaffolding); AnthropicAgentClientConfig's
    // minEdgeMultiple/minRr fields stay only for the legacy (non-tradeContract) plan-mode path and
    // fall back to their own '1.5' defaults when this env key is absent, same as before.
    AGENTIC_PLAN_EXIT_TTL_BARS: String(agentic.planExitTtlBars),
    // Plan-authoritative exits: sourced off the validated config field (never raw process.env), same
    // no-drift convention as every other schema-backed AGENTIC_* key in this map.
    AGENTIC_PLAN_AUTHORITATIVE_EXITS: String(agentic.planAuthoritativeExits),
    AGENTIC_QUIET_PAYLOAD_SAMPLE_BARS: String(agentic.quietPayloadSampleBars),
    AGENTIC_TOKEN_PRICE_CACHE_READ_PER_MTOK: agentic.tokenPriceCacheReadPerMtok,
    AGENTIC_TOKEN_PRICE_CACHE_WRITE_PER_MTOK: agentic.tokenPriceCacheWritePerMtok,
    // The promotion evaluator's fill walk shares the earned-live gate's evidence epoch — sourced
    // from the validated config field so the two reads can never drift (raw process.env would
    // bypass the schema's ISO refine).
    PROMOTION_EVIDENCE_EPOCH: agentic.promotionEvidenceEpoch,
    // C1: documents the optional derivatives block in the system prompt — off by default, so an
    // unconfigured deployment's prompt stays byte-identical.
    DERIVATIVES_FEED_ENABLED: String(config.derivativesFeed.enabled),
    // AGENTIC_DERIVATIVES_AB_PCT read-site deleted (v3 spec §9/§10 work item 3): the env var itself
    // is gone from the schema (environment.config.ts's own DELETED comment) and no consumer in this
    // module or anthropic-agent-client.ts reads the key anymore (XA3 retired the control arm at 0
    // permanently) — agentic.derivativesAbPct stays a config-only hardcoded-0 field until the
    // orchestrator's follow-up commit removes it from AppConfig entirely.
    // d2: off by default ⇒ byte-identical d1 prompt/payload/tag (see AnthropicAgentClientConfig's
    // derivativesV2Enabled comment).
    AGENTIC_DERIVATIVES_V2_ENABLED: String(agentic.derivativesV2Enabled),
    // D1 retired AGENTIC_THINKING_AB_PCT (thinking A/B #42) — every decide now carries adaptive
    // thinking unconditionally (see AnthropicAgentClientConfig's own S3 comment on the field's
    // removal); nothing downstream reads this key anymore.
    AGENTIC_CROSS_SYMBOL_ENABLED: String(agentic.crossSymbolEnabled),
    AGENTIC_CROSS_SYMBOL_LOOKBACK_BARS: String(agentic.crossSymbolLookbackBars),
    // Book-structure block: off by default ⇒ byte-identical. No A/B interaction.
    AGENTIC_BOOK_STRUCTURE_ENABLED: String(agentic.bookStructureFeedEnabled),
    // Track-record block: off by default ⇒ byte-identical. No A/B interaction.
    AGENTIC_TRACK_RECORD_ENABLED: String(agentic.trackRecordEnabled),
    // Phase 4 edge policy: off by default ⇒ byte-identical (DisabledEdgePolicy).
    AGENTIC_EDGE_POLICY_ENABLED: String(agentic.edgePolicyEnabled),
    AGENTIC_EDGE_POLICY_FAMILY: agentic.edgePolicyFamily,
    // Portfolio-consult batching: sourced off the validated config fields (never raw process.env),
    // same convention as the A/B pct above. AGENTIC_PORTFOLIO_SYMBOL_COUNT is NOT a schema field —
    // it is derived here as the early-flush threshold for BatchingAgentClient. XA1 (A0 activation
    // bundle): capped at the ACTIVE MENU size, not the full symbol count — only menu symbols ever
    // join a batch (off-menu symbols skip at the strategy gate), so a threshold of symbols.length
    // (24) could never trigger early-flush on a menu-12 wave and every wave waited out (and then
    // fragmented past) the window: the 2026-07-20 01:00Z fallback wave split into SIX API calls.
    AGENTIC_PORTFOLIO_CONSULT: String(agentic.portfolioConsultEnabled),
    AGENTIC_PORTFOLIO_WINDOW_MS: String(agentic.portfolioWindowMs),
    AGENTIC_PORTFOLIO_SYMBOL_COUNT: String(
      Math.min(config.strategy.symbols.length, agentic.activeMenuSize),
    ),
    // Trade-flow/CVD + positioning blocks: off by default ⇒ byte-identical legacy prompt. Both ride
    // the SAME information-context A/B control arm as derivatives/crossSymbol above (see
    // anthropic-agent-client.ts's infoContextControlArm). Same convention as DERIVATIVES_FEED_ENABLED
    // above: sourced off the top-level feed config block, not the `agentic` sub-object.
    AGENTIC_TRADEFLOW_ENABLED: String(config.tradeFlowFeed.enabled),
    AGENTIC_POSITIONING_ENABLED: String(config.positioningFeed.enabled),
    // #43: off by default ⇒ byte-identical legacy prompt. Same convention/A/B arm as above.
    AGENTIC_LIQUIDATIONS_ENABLED: String(config.liquidationFeed.enabled),
    // I1: the v2 tool contract's lane-cap (spot 0.15 / perp 0.50), threaded into both the trade-tool
    // description and the client's zod schema (S3) — see selectAgentClient's tradeContract wiring
    // below, which is unconditional (Design: no staged flag for the v2 contract).
    AGENTIC_MAX_POSITION_FRACTION: agentic.maxPositionFraction,
    // v3 spec §9/§10 work item 3 (casing fix): selectAgentClient reads
    // AGENTIC_MAX_POSITION_FRACTION_SPOT/_PERP/PERP_LEVERAGE_CAP off `env` (below), but this function
    // never overrode them with the validated config values — they fell through the `...process.env`
    // spread above instead, unlike every other AGENTIC_* key in this map (this function's own header
    // comment: sourcing off TypedConfigService "so the real wiring path and environment.config.ts can
    // never drift"). config.agentic.maxPositionFractionSpot/maxPositionFractionPerp and
    // config.perp.leverageCap are the real (defaulted, cross-field-validated) AppConfig fields —
    // sourcing off raw process.env here would silently diverge from them on any deployment that
    // doesn't ALSO set the raw env var identically.
    AGENTIC_MAX_POSITION_FRACTION_SPOT: agentic.maxPositionFractionSpot,
    AGENTIC_MAX_POSITION_FRACTION_PERP: agentic.maxPositionFractionPerp,
    PERP_LEVERAGE_CAP: config.perp.leverageCap,
  };
}

// pricesByModel: NOT sourced from env (AGENTIC_TOKEN_PRICES_JSON is parsed/validated once at boot
// by environment.config.ts's parseTokenPrices — reparsing raw JSON here would duplicate that
// fail-loud validation and could silently disagree with it). The composition root (app.module.ts)
// threads AppConfig.agentic.tokenPrices straight through instead, converting each decimal-string
// rate to a number via Decimal(...).toNumber() (same convention as intEnv above).
export function createAgentLlmBudget(
  env: Record<string, string | undefined>,
  pricesByModel?: Readonly<Record<string, ModelTokenRates>>,
): DailyLlmBudget {
  return new DailyLlmBudget({
    maxCallsPerDay: intEnv(env['AGENTIC_MAX_CALLS_PER_DAY'], DEFAULT_MAX_CALLS_PER_DAY),
    maxTokensPerDay: intEnv(env['AGENTIC_MAX_TOKENS_PER_DAY'], DEFAULT_MAX_TOKENS_PER_DAY),
    maxCostUsdPerDay: intEnv(env['AGENTIC_DAILY_COST_STOP_USD'], DEFAULT_DAILY_COST_STOP_USD),
    priceInputPerMtok: intEnv(
      env['AGENTIC_TOKEN_PRICE_INPUT_PER_MTOK'],
      DEFAULT_TOKEN_PRICE_INPUT_PER_MTOK,
    ),
    priceOutputPerMtok: intEnv(
      env['AGENTIC_TOKEN_PRICE_OUTPUT_PER_MTOK'],
      DEFAULT_TOKEN_PRICE_OUTPUT_PER_MTOK,
    ),
    priceCacheReadPerMtok: intEnv(
      env['AGENTIC_TOKEN_PRICE_CACHE_READ_PER_MTOK'],
      DEFAULT_TOKEN_PRICE_CACHE_READ_PER_MTOK,
    ),
    priceCacheWritePerMtok: intEnv(
      env['AGENTIC_TOKEN_PRICE_CACHE_WRITE_PER_MTOK'],
      DEFAULT_TOKEN_PRICE_CACHE_WRITE_PER_MTOK,
    ),
    pricesByModel,
  });
}

// v2-era expert seed playbooks (P2, Design § Learning & measurement stack), RETAINED (not deleted)
// only because app.module.ts (workstream #5, out of this pass's scope) still imports both by name
// for its own PLAYBOOK_PROVIDER_OVERRIDE/ValidatingPlaybookProvider construction, which has not yet
// migrated off the two-lane shortsEnabled selection. v3 §9/§10 work item 3 folds their prose into
// ONE lineage below (SEED_PLAYBOOK_V3) — every NEW consumer in this module (seedPlaybookProvider,
// selectAgentClient's default, the PLAYBOOK_PROVIDER factory) reads SEED_PLAYBOOK_V3 unconditionally;
// these two consts are dead code from this module's own perspective and should be deleted once #5's
// app.module.ts final-assembly pass switches its own seed pick to SEED_PLAYBOOK_V3 (integration item —
// see this dispatch's final report).
// XA3 (A0 activation bundle, 2026-07-20): version 4 — above every existing DB row (v1 seed,
// v2/v3 reflection mints on both lanes), so the revised mandate actually goes ACTIVE at next boot.
// Found during XA3: the P2 expert seeds NEVER went live — both const versions said 2, ensureSeed()
// found the pre-existing v2 REFLECTION row and served it, so the lanes ran an old reflection
// lineage through the whole v2 era. The mandate revisions below implement A0's entry-activation
// findings (0 entries in 19 v2 consults): disagreement modulates size instead of vetoing,
// continuation entries are valid at RSI 55-75, the fee floor is quantified, weekend/Asia gates
// reduce size instead of skipping, and the evidence-pace expectation is explicit.
export const SEED_PLAYBOOK: { readonly version: number; readonly content: string } = {
  version: 4,
  content: [
    '## regime notes',
    'Swing horizon: hold hours to days on 15m bars, not scalps. Momentum continuation and',
    'breakout-retest are the two highest-edge patterns — enter strength once a consolidation range',
    'breaks with confirmation and (ideally) a retest that holds, not into fresh chop. Session/',
    'time-of-day matters: the US session drives the cleanest directional follow-through; Asia hours',
    'tend to mean-revert inside a range; weekend and Asia liquidity is thinner — reduce sizeFraction',
    'on those entries rather than skipping a clean setup outright. BTC-beta regime: alts are',
    'BTC-direction bets first — cut alt exposure when BTC is trending down even if an individual alt',
    'chart looks fine; concentrate into alts when BTC is trending up AND the alt shows genuine',
    'relative strength via the cross-symbol rank, not merely "also up."',
    '',
    '## entry rules',
    'Two valid entry patterns, not one: (1) breakout-retest — a level breaks with confirming',
    'momentum, price retests it (or a nearby EMA) without giving back the move, and closes back in',
    'the break direction; (2) trend continuation — an established uptrend pulls back to support or a',
    'rising EMA and holds it. Continuation entries are valid at RSI 55-75; a trend does not need an',
    'oversold reset first, and "it already moved" is not by itself a reason to skip. Disagreement',
    'discipline: when ONE input disagrees (a lagging cross-symbol rank, soft order flow, a mixed',
    'higher timeframe) while structure supports the trade, HALVE sizeFraction instead of holding —',
    'reserve outright holds for genuinely conflicting structure, and let multiple independent',
    'bearish signals (not one) veto. Fee arithmetic, quantified: a round trip costs ~20bps; your',
    'typical TP targets (1-8%) clear that 5-40x — fees justify skipping only targets under ~60bps,',
    'never a normal swing entry. Concentrate conviction on a $1k book: hold 2-4 best ideas at 8-15%',
    'sizeFraction each rather than spreading thin across the scanner menu; a sizeFraction below 0.05',
    'is not worth the drag — take the half-size entry over the token one. Do not open a fresh alt',
    'long while BTC itself is trending down; wait for BTC to stabilize or size materially smaller.',
    '',
    '## exit rules',
    'Stops sit beyond the structure that invalidated the thesis (below the breakout level or swing',
    'low), never at a round number. Once a position works, raise the stop as new structure forms',
    '(adjust) rather than leaving the initial stop static — let a genuine trend run. Cut fast when',
    'the thesis breaks: the level that justified entry is reclaimed against you, or BTC flips against',
    'the alt direction — exit on the confirming close rather than waiting for a deeper give-back.',
    'maxHoldBars is a real deadline: if a position has not developed by the stated horizon, close it',
    'and free the capital rather than letting a stale swing trade drift.',
    '',
    '## mistakes to avoid',
    'Do not chase the first breakout bar without a retest — the retest-confirmation pattern has a',
    'meaningfully better hit rate at swing horizon. Do not stack veto conditions: requiring every',
    'input to agree before entering means never entering — the evidence gate this lane must pass',
    'needs roughly 2 closed round trips per day, and a flat week is a failure mode, not discipline.',
    'Do not spread thin across many weak setups on a $1k book — concentrated conviction in the best',
    '2-4 ideas beats a dozen half-sized entries that each pay full round-trip fees. Do not ignore',
    'BTC when sizing an alt — a position fighting BTC direction is lower-probability even on a clean',
    'individual chart. Do not schedule the next consult too tight when positioned with a wide stop',
    '(wastes budget against a roughly $1/day target) or too loose near invalidation (misses the',
    'exit) — set nextConsultBars deliberately rather than defaulting to the shortest interval every',
    'time.',
  ].join('\n'),
};

// Perp lane counterpart to SEED_PLAYBOOK above — two-sided (shorts as readily as longs),
// funding-flip and liquidation-cascade patterns, and leverage discipline for the 5x cap. Requires
// {shortsAllowed: true, leverageAllowed: true} to pass validatePlaybook; never served to a spot lane.
// X2 (perp basket widening, 2026-07-20): version 5 — adds the menu-breadth passage to ## entry
// rules (below) so a multi-symbol scanner menu (8-symbol basket, active menu 4) does not read as a
// diversification quota — mirrors the spot seed's own "concentrate conviction" guidance (see
// SEED_PLAYBOOK above), which this lane never had. Bumped ONLY this lane's own version const (never
// SEED_PLAYBOOK's) — the two seeds resolve against SEPARATE per-lane playbook-store rows (app.module.
// ts's ensureSeed keyed off each seed's own `.version`; see PlaybookStoreAdapter.ensureSeed), so a
// spot-lane version bump is neither required nor correct here (mirrors XA3's per-lane bump, which
// bumped both ONLY because that revision touched both seeds' content — this revision touches only
// this one). Trimmed ~180 chars of existing prose to make room under the 4000-char validator cap.
export const SEED_PLAYBOOK_PERP: { readonly version: number; readonly content: string } = {
  version: 5,
  content: [
    '## regime notes',
    'BTC-only, swing horizon, hours-to-days holds on 15m bars, genuinely two-sided: short a',
    'breakdown as readily as you long a breakout — there is no long-only bias on this lane.',
    'If you call the trend down and stay flat, your rationale must say why no short. Example:',
    'support breaks on rising open interest with fading positive funding — open_short',
    'sizeFraction 0.20-0.35, stop just above the broken level, take profit at the next liquidity',
    'shelf (2.5-4%). A perp round trip costs ~6-10bps — fees rarely justify skipping. One',
    'soft input HALVES sizeFraction rather than forcing a hold; the evidence gate needs ~2 closed',
    'round trips/day — a flat week is a failure mode, not discipline.',
    'Funding-flip signals: rich positive funding paired with stalling upside price favors a short',
    'bias once price stalls. Deeply negative funding while price holds support is capitulation',
    'exhaustion — favors a long bias once selling pressure fades. Liquidation-cascade mean',
    'reversion: a violent wick through a level, especially one lining up with a visible',
    'liquidation cluster, usually reflects forced flow exhausting itself rather than a genuine new',
    'trend — fade the wick with a tight stop past its extreme rather than chasing the cascade',
    'direction. Basis/open-interest divergence: rising open interest with falling price means',
    'fresh short positions are building — real momentum, respect it. Falling open interest with',
    'falling price means existing longs are closing out, not fresh shorts piling in — a move',
    'nearing exhaustion, not the start of a fresh leg down.',
    '',
    '## entry rules',
    'Enter short into a genuine breakdown the same way a long enters a breakout: structure breaks,',
    'momentum confirms, and ideally a retest of the broken level fails to reclaim it. Use funding as',
    'a timing signal, not a standalone trigger — a crowded, expensive funding rate confirms a short',
    'thesis that already has price/structure support; do not short purely because funding is rich',
    'while price still makes higher highs. Fade liquidation-cascade wicks with a tight stop just past',
    'the extreme, sized smaller than a trend-following entry since this is mean reversion against',
    'recent momentum. The 5x leverage cap exists so conviction can be expressed, not so every entry',
    'defaults to it — reserve the full multiple for the highest-conviction setups (structure plus',
    'funding plus open interest all agreeing); a merely-decent setup earns a smaller multiple.',
    'Menu breadth is opportunity set, not a diversification quota: concentrate in the 1-2 best',
    'setups at real size. Perp majors move together, so several small positions across them is',
    'often one levered bet, not diversification.',
    '',
    '## exit rules',
    'Stops sit beyond the structure that invalidated the thesis, and liquidation distance must stay',
    'more than 3x the stop distance — if a stop that wide puts liquidation uncomfortably close,',
    'reduce size or the leverage multiple rather than tightening the stop into noise. Funding',
    'accrues every 8 hours while positioned — it is real carry cost (or income), not a rounding',
    'error; a position paying away funding for days needs a stronger thesis to justify holding',
    'through it. Raise (long) or lower (short) the stop as new structure forms in your favor; let a',
    'genuine trend run rather than capping it early. Cut a liquidation-cascade fade fast if the',
    'wick extreme is reclaimed against you — that setup is invalidated the moment the exhaustion',
    'read is wrong — no "give it more room" on this trade type.',
    '',
    '## mistakes to avoid',
    'Do not treat the 5x leverage cap as a default — under- or over-sizing conviction relative to',
    'setup quality both waste it. Do not ignore funding cost on a position held for days — a thesis',
    'that only works while funding stays cheap is fragile. Do not chase a liquidation-cascade wick',
    'in its own direction; the edge is fading the exhaustion, not riding the panic. Do not let',
    'liquidation distance shrink below 3x the stop distance to squeeze out extra size — a',
    'stopped-out loss is recoverable, a liquidation is not.',
  ].join('\n'),
};

// v3 spec §9/§10 work item 3: one lineage for the combined book (both venues, one scanner basket,
// one playbook_versions sequence — schema §2 dropped the per-lane column). Folds SEED_PLAYBOOK's
// expert spot prose (momentum continuation/breakout-retest, session effects, BTC-beta) and
// SEED_PLAYBOOK_PERP's expert perp prose (two-sided, funding-flip, liquidation-cascade mean
// reversion, basis/OI divergence) into ONE two-sided seed — validated with capabilities always
// {shortsAllowed: true, leverageAllowed: true} (every v3 boot is perp-capable; §1.3's
// AgenticBridgeModule fixes the SAME two flags for the SAME reason).
// version 6 (2026-07-24): trim ~250 chars below the 4000-char validator ceiling so reflection
// revisions have headroom; bump ABOVE XA3 expert seeds (v4/v5) and historical reflection mints
// (v2/v3) so ensureSeed inserts a new row. version 1→2 repeated the XA3 collision: ensureSeed
// returns ANY row at seed.version without checking source, so a pre-existing reflection v2 would
// be served as "seed" and the trimmed prose never went ACTIVE. Content-only edits of an existing
// version are a live no-op.
// version 7→8 (F1b, perp leverage cap 2x→5x): the live DB already carries a reflection-minted row
// at version 7 (append()'s maxVersion()+1 advanced past 6 during the v6 era) — bumping to 7 would
// repeat the exact v1→2 collision above (ensureSeed serving the reflection row instead of this
// content). 8 is the smallest version confirmed clear at the time of this change; because
// append() keeps advancing maxVersion()+1 while the reflection loop runs, this is best-effort, not
// a guarantee — confirm the live max version immediately before deploy and bump again if the loop
// has since reached 8.
// INTEGRATION ITEM (flagged, not resolved here): this folds the SEED CONSTS only, not either lane's
// live ACTIVE reflection-minted text — reading the v2 DBs' current ACTIVE row is a cutover-time step
// (the task brief explicitly defers it: "the cutover task owns the DB read"), so a future commit may
// still need to re-fold real ACTIVE prose in before the v3 demo cutover flips PROMOTION_EVIDENCE_EPOCH.
export const SEED_PLAYBOOK_V3: { readonly version: number; readonly content: string } = {
  version: 8,
  content: [
    '## regime notes',
    'One book, two venues (spot + perp), one scanner menu. Swing horizon: hold hours to days on 15m',
    'bars, not scalps. Momentum continuation and breakout-retest are the highest-edge patterns.',
    'US session drives the cleanest follow-through; Asia mean-reverts; weekend/Asia liquidity is',
    'thinner — reduce sizeFraction, do not skip a clean setup. BTC-beta: alts are BTC-direction bets',
    'first — cut alt exposure when BTC trends down even on a fine-looking alt chart; concentrate into',
    'alts when BTC trends up AND the alt shows relative strength via the cross-symbol rank. Perp is',
    'two-sided: short a breakdown as readily as you long a breakout; if you call a perp trend down',
    'and stay flat, your rationale must say why no short. Funding-flip: rich positive funding with',
    'stalling upside favors a short once price stalls; deep negative funding while price holds',
    'support favors a long once selling fades. Liquidation-cascade: a violent wick through a level',
    'lining up with a liquidation cluster usually reflects forced flow exhausting; fade it with a',
    'tight stop past the extreme. Basis/OI: rising OI with falling price means fresh shorts (respect',
    'it); falling OI with falling price means longs closing (exhaustion).',
    '',
    '## entry rules',
    'Two valid long-side patterns: (1) breakout-retest — a level breaks with confirming momentum,',
    'retests without giving back the move, closes back in the break direction; (2) trend continuation',
    '— an uptrend pulls back to support or a rising EMA and holds (valid at RSI 55-75, no oversold',
    'reset required). Enter a perp short the mirror way: structure breaks down, momentum confirms,',
    'ideally a failed retest. Use funding as a timing signal, never a standalone trigger. Fade',
    'liquidation-cascade wicks with a tight stop past the extreme, sized smaller than a trend-follow',
    'entry. The perp 5x leverage cap exists so conviction can be expressed, not so every entry',
    'defaults to it — reserve the full multiple for structure plus funding plus OI all agreeing.',
    'Disagreement discipline: when ONE input disagrees (lagging cross-symbol rank, soft order flow,',
    'mixed HTF) while structure supports the trade, HALVE sizeFraction rather than hold — reserve',
    'outright holds for genuinely conflicting structure; let several independent bearish signals, not',
    'one, veto. Fee arithmetic: spot ~20bps round trip, perp ~6-10bps; typical TP targets (1-8%) clear',
    'either many times over. Concentrate conviction — a handful of best ideas beats spreading thin.',
    '',
    '## exit rules',
    'Stops sit beyond the structure that invalidated the thesis, never a round number. On a perp',
    'position, liquidation distance must stay more than 3x the stop distance — reduce size or',
    'leverage rather than tighten the stop into noise. Perp funding accrues every 8 hours while',
    'positioned — real carry cost or income; weigh it as a headwind or a tailwind that can justify',
    'holding longer. Once a position works, raise (long) or lower (short) the stop as new structure',
    'forms rather than leaving it static. Cut fast when the thesis breaks or BTC flips against an',
    'alt direction; cut a liquidation-cascade fade fast if the wick extreme reclaims against you.',
    'maxHoldBars is a real deadline — close a stale position rather than let it drift.',
    '',
    '## mistakes to avoid',
    'Do not stack veto conditions: requiring every input to agree means never entering — the',
    'combined book needs roughly two closed round trips per day, and a flat week is a failure mode,',
    'not discipline. Do not spread thin across weak setups when concentrated conviction beats a dozen',
    'half-sized entries paying full fees. Do not ignore BTC when sizing an alt, long or short. Do not',
    'treat the perp 5x cap as a default, and do not ignore funding cost on a position held for days.',
    'Do not chase a liquidation-cascade wick in its own direction. Do not let liquidation distance',
    'shrink below 3x the stop distance.',
  ].join('\n'),
};

function seedPlaybookProvider(): PlaybookProvider {
  return { current: () => Promise.resolve(SEED_PLAYBOOK_V3) };
}

// Matches AGENTIC_PORTFOLIO_WINDOW_MS's schema default and BatchingAgentClient's own
// DEFAULT_MAX_BATCH_SIZE fallback (this deployment's P7 symbol count).
const DEFAULT_PORTFOLIO_WINDOW_MS = 3000;
const DEFAULT_PORTFOLIO_SYMBOL_COUNT = 5;

// Pure selection so it's unit-testable without touching global env. Falls back to the inert
// StubAgentClient whenever there is no API key, or under test/CI (never call a real LLM from a
// test run) — unbudgeted and playbook-free, since it never calls out. Otherwise wires the concrete
// Anthropic adapter behind the shared BudgetedAgentClient, with a playbookProvider (defaulting to
// the seed playbook when the caller supplies none). AGENTIC_PORTFOLIO_CONSULT ('true') swaps
// BudgetedAgentClient for BatchingAgentClient instead — flag-off never constructs the batcher, so
// the legacy chain (and its promptHash) stays byte-identical by construction (see
// portfolio-consult.spec.ts's flag-off identity test).
export function selectAgentClient(
  env: Record<string, string | undefined>,
  budget: DailyLlmBudget = createAgentLlmBudget(env),
  // v3 §9/§10: ONE lineage now (SEED_PLAYBOOK_V3, two-sided) — no lane-aware selection left. Only
  // matters when the caller supplies no explicit playbookProvider (the composition root always
  // does, via PLAYBOOK_PROVIDER_OVERRIDE).
  playbookProvider: PlaybookProvider = seedPlaybookProvider(),
  profile?: AgentTradingProfile,
  // I1 (Design § Universe): the scanner's active-menu gate, threaded ONLY into the batching path
  // below (ActiveMenuGate is meaningless to the single-symbol BudgetedAgentClient chain). Absent ⇒
  // BatchingAgentClient gets no gate — byte-identical to pre-U1 (every symbol proposes).
  activeMenuGate?: ActiveMenuGate,
  // I1b (Design § Enriched model inputs): threaded straight through to
  // AnthropicAgentClientConfig.payloadExtrasProvider — see that field's own comment. Absent ⇒ the
  // client never renders portfolio/budget/calendar, byte-identical to pre-I1b.
  payloadExtrasProvider?: AnthropicAgentClientConfig['payloadExtrasProvider'],
  // R2 (episodic memory): the per-symbol journal-retrieval seam — threaded straight through to
  // AnthropicAgentClientConfig.similarSetupsProvider, but only when AGENTIC_EPISODIC_MEMORY_ENABLED is
  // on (below), so a flag-off deployment renders neither the prompt sentence nor the payload block
  // (byte-identical to pre-R2). Absent ⇒ retrieval unwired regardless.
  similarSetupsProvider?: AnthropicAgentClientConfig['similarSetupsProvider'],
  // v3 spec §4.3/§9/§10 work item 1: threaded straight through to
  // AnthropicAgentClientConfig.recordCapabilityViolation — see that field's own comment. Absent ⇒
  // the capability-violation degrade still happens (hold + journaled 'error'), just unrecorded.
  recordCapabilityViolation?: AnthropicAgentClientConfig['recordCapabilityViolation'],
  // 2026-07-22 schema-hardening: threaded straight through to
  // AnthropicAgentClientConfig.recordSchemaFailure — see that field's own comment. Absent ⇒ the
  // schema-rejection degrade still happens (hold + schema_rejected: rationale), just unrecorded.
  recordSchemaFailure?: AnthropicAgentClientConfig['recordSchemaFailure'],
): AgentClientPort {
  const apiKey = env['ANTHROPIC_API_KEY'];
  if (!apiKey || env['NODE_ENV'] === 'test' || env['CI']) {
    return new StubAgentClient();
  }
  // R2: off by default ⇒ byte-identical (no similarSetups sentence/block/tag). The provider is gated
  // by the SAME flag so the block can never render without its describing system-prompt sentence.
  const episodicMemoryEnabled = env['AGENTIC_EPISODIC_MEMORY_ENABLED'] === 'true';
  const client = new AnthropicAgentClient(
    {
      apiKey,
      model: env['AGENTIC_MODEL'] ?? DEFAULT_MODEL,
      timeoutMs: intEnv(env['AGENTIC_TIMEOUT_MS'], DEFAULT_TIMEOUT_MS),
      maxTokens: intEnv(env['AGENTIC_MAX_TOKENS'], DEFAULT_MAX_TOKENS),
      signalTtlMs: intEnv(env['SIGNAL_TTL_MS'], DEFAULT_SIGNAL_TTL_MS),
      profile,
      constraintsFor: constraintsFromDefaultFilters,
      // C1: off by default ⇒ byte-identical legacy prompt (no derivatives sentence).
      derivativesFeedEnabled: env['DERIVATIVES_FEED_ENABLED'] === 'true',
      // d2: off by default ⇒ byte-identical d1 prompt/payload/tag.
      derivativesV2Enabled: env['AGENTIC_DERIVATIVES_V2_ENABLED'] === 'true',
      // ADD-A (X2, perp basket widening): wired from the SAME DERIVATIVES_FEED_ENABLED env var as
      // derivativesFeedEnabled above (no new env knob — task ask was "gated behind the existing
      // derivatives feed flag") — a distinct opts field only so the fundingHistory attribution
      // surface (sentence/tag) is independently gated, per this file's one-flag-per-block precedent.
      fundingHistoryFeedEnabled: env['DERIVATIVES_FEED_ENABLED'] === 'true',
      // v3 consolidation spec §9: the information-context control arm (derivativesAbPct) and thinking
      // A/B (#42) are both retired outright — no cfg fields left to wire them into.
      // v3 consolidation spec §4: shorts/leverage/sizeFraction-cap are per-symbol capabilities now
      // (venueForSymbol + these two caps), never a deployment-wide lane flag — see
      // AnthropicAgentClientConfig's own comment.
      maxPositionFractionSpot: env['AGENTIC_MAX_POSITION_FRACTION_SPOT'],
      maxPositionFractionPerp: env['AGENTIC_MAX_POSITION_FRACTION_PERP'],
      perpLeverageCap: env['PERP_LEVERAGE_CAP'],
      // C4: off by default ⇒ byte-identical legacy prompt (no sentiment sentence).
      sentimentFeedEnabled: env['SENTIMENT_FEED_ENABLED'] === 'true',
      // X3a: off by default ⇒ byte-identical legacy prompt (no fearGreed sentence).
      fearGreedFeedEnabled: env['FEAR_GREED_FEED_ENABLED'] === 'true',
      // Cross-symbol relative-strength block: off by default ⇒ byte-identical. Gated together with
      // the derivatives block under the info-context A/B (derivativesAbPct) inside the client.
      crossSymbolFeedEnabled: env['AGENTIC_CROSS_SYMBOL_ENABLED'] === 'true',
      // Trade-flow/CVD + positioning blocks: off by default ⇒ byte-identical. Gated together with the
      // derivatives block under the SAME info-context A/B (derivativesAbPct) inside the client.
      tradeFlowFeedEnabled: env['AGENTIC_TRADEFLOW_ENABLED'] === 'true',
      positioningFeedEnabled: env['AGENTIC_POSITIONING_ENABLED'] === 'true',
      // #43: off by default ⇒ byte-identical. Gated together under the SAME info-context A/B.
      liquidationsFeedEnabled: env['AGENTIC_LIQUIDATIONS_ENABLED'] === 'true',
      // Book-structure block: off by default ⇒ byte-identical. No info-context A/B interaction.
      bookStructureFeedEnabled: env['AGENTIC_BOOK_STRUCTURE_ENABLED'] === 'true',
      // Track-record block: off by default ⇒ byte-identical. No info-context A/B interaction.
      trackRecordFeedEnabled: env['AGENTIC_TRACK_RECORD_ENABLED'] === 'true',
      edgePolicyFeedEnabled: env['AGENTIC_EDGE_POLICY_ENABLED'] === 'true',
      // I1b: absent ⇒ byte-identical (see the field's own comment).
      payloadExtrasProvider,
      // R2: gated by the flag so the payload block and its describing system-prompt sentence stay in
      // lockstep — absent when off ⇒ byte-identical.
      episodicMemoryEnabled,
      similarSetupsProvider: episodicMemoryEnabled ? similarSetupsProvider : undefined,
      // v3 spec §4.3/§9/§10 work item 1: absent ⇒ metric unrecorded (see the param's own comment).
      recordCapabilityViolation,
      // 2026-07-22 schema-hardening: absent ⇒ metric unrecorded (see the param's own comment).
      recordSchemaFailure,
      // 2026-07-30 plan-authoritative exits: off by default ⇒ byte-identical (every model 'close'
      // still maps to an exit signal). See the close branch in anthropic-agent-client.ts's
      // buildProposalFromTradeDecision for the measured basis and failure direction.
      planAuthoritativeExits: env['AGENTIC_PLAN_AUTHORITATIVE_EXITS'] === 'true',
    },
    fetch,
    new Logger('AnthropicAgentClient'),
    playbookProvider,
  );
  const model = env['AGENTIC_MODEL'] ?? DEFAULT_MODEL;
  if (env['AGENTIC_PORTFOLIO_CONSULT'] === 'true') {
    // v3 consolidation spec §9: the shorts+consult plan-mode guard is DELETED — the unified
    // submit_portfolio tool always expresses 'open_short' per element (§4.3), so there is no more
    // silent-long-only combination to refuse at boot.
    // Batching wraps AnthropicAgentClient DIRECTLY (not BudgetedAgentClient — see
    // batching-agent-client.ts's own header comment on why): it holds the SAME budget instance and
    // performs its own single tryReserveCall/recordUsage per BATCH rather than per symbol.
    return new BatchingAgentClient(
      client,
      budget,
      {
        windowMs: intEnv(env['AGENTIC_PORTFOLIO_WINDOW_MS'], DEFAULT_PORTFOLIO_WINDOW_MS),
        maxBatchSize: intEnv(env['AGENTIC_PORTFOLIO_SYMBOL_COUNT'], DEFAULT_PORTFOLIO_SYMBOL_COUNT),
        agentTimeoutMs: intEnv(env['AGENTIC_TIMEOUT_MS'], DEFAULT_TIMEOUT_MS),
        model,
        activeMenuGate,
      },
      new Logger('BatchingAgentClient'),
    );
  }
  // model threaded through so recordUsage (agent-budget.ts) can resolve per-model cache/token
  // rates (W4+W13) — this client only ever calls the ONE model it was constructed with above.
  return new BudgetedAgentClient(client, budget, new Logger('AgentBudget'), model);
}

// Multi-symbol (P7): per-decide venue-constraint resolution for the shared client, sourced from the
// SAME DEFAULT_FILTERS table Risk/Execution enforce (domain/trading/risk/default-filters) — the prompt's
// tick/lot/minNotional can never drift from what the sizer actually rounds to. Returns undefined
// for an unfiltered symbol, which falls back to the static profile's constraints in the client.
function constraintsFromDefaultFilters(
  symbol: string,
): AgentTradingProfile['constraints'] | undefined {
  const filters = DEFAULT_FILTERS.get(symbol);
  if (!filters) return undefined;
  return {
    tickSize: price(filters.tickSize),
    lotStep: qty(filters.stepSize),
    minNotional: price(filters.minNotional),
  };
}

// Wires the out-of-process agent client. Binds AGENT_CLIENT to the concrete AnthropicAgentClient
// (budget-wrapped, seed-playbook-provided) when ANTHROPIC_API_KEY is configured outside test/CI;
// otherwise the inert StubAgentClient keeps the lane a no-op. AGENT_LLM_BUDGET is bound
// unconditionally (harmless when the stub path is selected — simpler than a nullable provider for
// downstream health/metrics/reflection consumers). PLAYBOOK_PROVIDER defaults to SEED_PLAYBOOK unless
// the composition root binds a real store to PLAYBOOK_PROVIDER_OVERRIDE (G3a persistence adapters) —
// see that token's own comment. The strategy factory itself is registered by the composition root
// (app.module) beside the other strategies.
@Module({
  providers: [
    {
      provide: AGENT_LLM_BUDGET,
      useFactory: (config?: TypedConfigService) =>
        createAgentLlmBudget(agenticEnv(config), toModelTokenRates(config?.agentic.tokenPrices)),
      inject: [{ token: TypedConfigService, optional: true }],
    },
    {
      provide: PLAYBOOK_PROVIDER,
      // v3 §9/§10: same ONE-lineage fallback as selectAgentClient's default param above — only
      // reachable in an isolated AgenticStrategyModule test context (the real app.module.ts boot
      // always binds PLAYBOOK_PROVIDER_OVERRIDE).
      useFactory: (override: PlaybookProvider | undefined): PlaybookProvider =>
        override ?? seedPlaybookProvider(),
      inject: [{ token: PLAYBOOK_PROVIDER_OVERRIDE, optional: true }],
    },
    {
      provide: EDGE_POLICY,
      useFactory: (config: TypedConfigService | undefined, override: EdgePolicyPort | undefined) =>
        createEdgePolicyPort({
          enabled: config?.agentic.edgePolicyEnabled ?? false,
          family: config?.agentic.edgePolicyFamily ?? 'none',
          implementation: override,
        }),
      inject: [
        { token: TypedConfigService, optional: true },
        { token: EDGE_POLICY_OVERRIDE, optional: true },
      ],
    },
    {
      provide: AGENT_CLIENT,
      useFactory: (
        budget: DailyLlmBudget,
        playbookProvider: PlaybookProvider,
        config: TypedConfigService | undefined,
        profile: AgentTradingProfile | undefined,
        activeMenuGate: ActiveMenuGate | undefined,
        payloadExtrasProvider: AnthropicAgentClientConfig['payloadExtrasProvider'] | undefined,
        journal: AgentDecisionJournalPort | undefined,
        metricsRecorder: AgentClientMetricsRecorder | undefined,
      ) =>
        selectAgentClient(
          agenticEnv(config),
          budget,
          playbookProvider,
          profile,
          activeMenuGate,
          payloadExtrasProvider,
          // R2: the per-symbol retrieval closure — one indexed journal read per decide/element, never
          // an API call. Absent journal or a journal without recentSimilarSetups ⇒ no provider ⇒ the
          // block is omitted (fail-open). selectAgentClient additionally gates it by the flag.
          journal?.recentSimilarSetups
            ? (tags) => journal.recentSimilarSetups!(tags, MAX_SIMILAR_SETUPS)
            : undefined,
          metricsRecorder?.recordCapabilityViolation
            ? (kind) => metricsRecorder.recordCapabilityViolation!(kind)
            : undefined,
          metricsRecorder?.recordSchemaFailure
            ? (kind) => metricsRecorder.recordSchemaFailure!(kind)
            : undefined,
        ),
      inject: [
        AGENT_LLM_BUDGET,
        PLAYBOOK_PROVIDER,
        { token: TypedConfigService, optional: true },
        { token: AGENT_TRADING_PROFILE_OVERRIDE, optional: true },
        { token: ACTIVE_MENU_GATE_OVERRIDE, optional: true },
        { token: PAYLOAD_EXTRAS_PROVIDER_OVERRIDE, optional: true },
        { token: AGENT_DECISION_JOURNAL, optional: true },
        { token: REFLECTION_METRICS_RECORDER_OVERRIDE, optional: true },
      ],
    },
  ],
  exports: [AGENT_CLIENT, AGENT_LLM_BUDGET, PLAYBOOK_PROVIDER, EDGE_POLICY],
})
export class AgenticStrategyModule {}
