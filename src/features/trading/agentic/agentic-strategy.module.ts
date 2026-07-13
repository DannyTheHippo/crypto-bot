import { Logger, Module } from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  AGENT_CLIENT,
  AGENT_DECISION_JOURNAL,
  LLM_USAGE_SINK,
  PLAYBOOK_PROVIDER,
  type AgentClientPort,
  type AgentDecisionJournalPort,
  type AgentTradingProfile,
  type LlmUsageSink,
  type PlaybookProvider,
} from '../../../ports/agentic-strategy';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { KILL_SWITCH, type KillSwitchPort } from '../../../ports/risk';
import { REFLECTION_EVIDENCE, type RoundTripEvidencePort } from '../../../ports/promotion';
import { DEFAULT_FILTERS } from '../../../domain/risk/default-filters';
import { price, qty } from '../../../domain/types/money';
import { STRATEGY_REGISTRY, type StrategyRegistryPort } from '../../../ports/strategy';
import { StubAgentClient } from './agent-client.adapter';
import { AnthropicAgentClient } from './anthropic-agent-client';
import { BatchingAgentClient } from './batching-agent-client';
import { BudgetedAgentClient, DailyLlmBudget, type ModelTokenRates } from './agent-budget';
import {
  createReflectionService,
  type ReflectionMetricsRecorder,
  type ReflectionPlaybookStore,
} from './reflection.service';

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

// Local to this module (see G2b task brief) — health/metrics/reflection inject this token later to
// read DailyLlmBudget.snapshot() without depending on which AgentClientPort got selected.
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

// REFLECTION_SERVICE: the G4a trade-triggered reflection loop (see reflection.service.ts's own
// header comment). Exported so the composition root can inject it and wire
// AgenticStrategyDeps.onClosedTrade to it (strategy.ts cannot import this module — the boundary
// wall — so the wiring itself happens at app.module.ts).
export const REFLECTION_SERVICE = Symbol('REFLECTION_SERVICE');

// Same seam pattern as PLAYBOOK_PROVIDER_OVERRIDE/AGENT_TRADING_PROFILE_OVERRIDE above, for the
// composition root's real AgentMetricsRecorder (observability module) to reach ReflectionService's
// validator-rejection tripwire without this module importing features/common/observability (boundary wall).
// Consumed via reflection.service.ts's own LOCAL structural type (ReflectionMetricsRecorder);
// absent (module-isolation contexts) leaves the tripwire unrecorded — telemetry-only, never a
// safety gate.
export const REFLECTION_METRICS_RECORDER_OVERRIDE = Symbol('REFLECTION_METRICS_RECORDER_OVERRIDE');

// Builds the env-shaped record selectAgentClient/createAgentLlmBudget read. Sources the validated
// AGENTIC_* fields (G1c) off TypedConfigService rather than raw process.env when available, so the
// real wiring path and environment.config.ts can never drift; ANTHROPIC_API_KEY/SIGNAL_TTL_MS/
// NODE_ENV/CI stay off AppConfig (secret / not-yet-validated / test-seam) and are read straight off
// process.env either way. Falls back to plain process.env when TypedConfigService is absent
// (module-isolation tests), keeping selectAgentClient's own DEFAULT_* constants as the backstop.
export function agenticEnv(config?: TypedConfigService): Record<string, string | undefined> {
  if (!config) return process.env;
  const agentic = config.agentic;
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
    AGENTIC_SHORTS_ENABLED: String(agentic.shortsEnabled),
    // Push II Phase 8: perp-capability is derived from config.venues (never a separate env knob —
    // one source of truth for "is this boot's venue short-capable") so selectAgentClient can refuse
    // shortsEnabled+planMode construction on a spot-only deployment. Mirrors position-sizer.service.ts's
    // own local PERP_VENUE_ID convention (binanceusdm is the only perp venue this pass wires).
    AGENTIC_PERP_VENUE: String(config.venues.some((v) => v.id === 'binanceusdm')),
    AGENTIC_MIN_EDGE_MULTIPLE: agentic.minEdgeMultiple,
    AGENTIC_MIN_RR: agentic.minRr,
    AGENTIC_PLAN_EXIT_TTL_BARS: String(agentic.planExitTtlBars),
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
    // Derivatives-block A/B: sourced off the validated config field (never raw process.env) so the
    // schema's 0-50 bound can never be bypassed here — same convention as PROMOTION_EVIDENCE_EPOCH
    // above.
    AGENTIC_DERIVATIVES_AB_PCT: String(agentic.derivativesAbPct),
    AGENTIC_THINKING_AB_PCT: String(agentic.thinkingAbPct),
    AGENTIC_CROSS_SYMBOL_ENABLED: String(agentic.crossSymbolEnabled),
    AGENTIC_CROSS_SYMBOL_LOOKBACK_BARS: String(agentic.crossSymbolLookbackBars),
    // Portfolio-consult batching: sourced off the validated config fields (never raw process.env),
    // same convention as the A/B pct above. AGENTIC_PORTFOLIO_SYMBOL_COUNT is NOT a schema field —
    // it is derived here from the SAME config.strategy.symbols array TRADING_SYMBOLS resolves to
    // (app.module.ts registers one agentic-N instance per entry), so BatchingAgentClient's
    // early-flush threshold can never drift from the actual configured symbol count.
    AGENTIC_PORTFOLIO_CONSULT: String(agentic.portfolioConsultEnabled),
    AGENTIC_PORTFOLIO_WINDOW_MS: String(agentic.portfolioWindowMs),
    AGENTIC_PORTFOLIO_SYMBOL_COUNT: String(config.strategy.symbols.length),
    // Trade-flow/CVD + positioning blocks: off by default ⇒ byte-identical legacy prompt. Both ride
    // the SAME information-context A/B control arm as derivatives/crossSymbol above (see
    // anthropic-agent-client.ts's infoContextControlArm). Same convention as DERIVATIVES_FEED_ENABLED
    // above: sourced off the top-level feed config block, not the `agentic` sub-object.
    AGENTIC_TRADEFLOW_ENABLED: String(config.tradeFlowFeed.enabled),
    AGENTIC_POSITIONING_ENABLED: String(config.positioningFeed.enabled),
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

// Starter playbook (version 1): brief, conservative heuristics layered on top of the fixed
// system-prompt rules — trend/momentum confluence entries, exit on trend break, and the mistakes a
// first iteration is most prone to. Passes validatePlaybook (see playbook-validator.spec.ts and the
// assertion in agent-client-selection.spec.ts). Serves as the default PLAYBOOK_PROVIDER binding
// until a persisted store adapter (a later task) replaces it.
export const SEED_PLAYBOOK: { readonly version: number; readonly content: string } = {
  version: 1,
  content: [
    '## regime notes',
    'Favor acting when price is trending with confluence across timeframes: the base-interval EMA',
    'fast is above EMA slow and RSI14 is above 50, ideally agreeing with the 1h/4h EMA trend when',
    'available. Treat choppy, range-bound conditions (EMA fast and slow crossing repeatedly, RSI',
    'oscillating near 50) as low-edge and prefer holding.',
    '',
    '## entry rules',
    'Only enter long when trend and momentum agree: EMA fast above EMA slow, RSI14 above 50 but',
    'below 70 (avoid chasing an already-extended move), and the expected move clearly exceeds the',
    'stated round-trip trading cost. Wait for a fresh confirming close rather than reacting to a',
    'single wick.',
    '',
    '## exit rules',
    'Exit to flat when the trend that justified the entry breaks: EMA fast crosses back below EMA',
    'slow, RSI14 drops below 45, or unrealized PnL gives back a meaningful share of its peak gain.',
    'When unsure whether the break is real or noise, prefer flat over holding a position whose thesis',
    'no longer holds.',
    '',
    '## mistakes to avoid',
    'Do not overtrade small, noisy fluctuations — each round trip costs real fees. Do not chase price',
    'after a move already past typical overbought RSI levels. Do not act on a thin, low-confidence',
    'edge that fees would erase. Do not treat one outcome as proof of a regime change; wait for',
    'consistent confirmation.',
  ].join('\n'),
};

function seedPlaybookProvider(): PlaybookProvider {
  return { current: () => Promise.resolve(SEED_PLAYBOOK) };
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
  playbookProvider: PlaybookProvider = seedPlaybookProvider(),
  profile?: AgentTradingProfile,
): AgentClientPort {
  const apiKey = env['ANTHROPIC_API_KEY'];
  if (!apiKey || env['NODE_ENV'] === 'test' || env['CI']) {
    return new StubAgentClient();
  }
  const client = new AnthropicAgentClient(
    {
      apiKey,
      model: env['AGENTIC_MODEL'] ?? DEFAULT_MODEL,
      timeoutMs: intEnv(env['AGENTIC_TIMEOUT_MS'], DEFAULT_TIMEOUT_MS),
      maxTokens: intEnv(env['AGENTIC_MAX_TOKENS'], DEFAULT_MAX_TOKENS),
      signalTtlMs: intEnv(env['SIGNAL_TTL_MS'], DEFAULT_SIGNAL_TTL_MS),
      profile,
      constraintsFor: constraintsFromDefaultFilters,
      // W3.1 plan mode: submit_plan tool + deterministic plan executor (strategy side). Flag off ⇒
      // byte-identical legacy submit_decision behavior.
      planMode: env['AGENTIC_PLAN_MODE'] === 'true',
      // Push II Phase 8: plan-mode shorts. perpCapableVenue is what actually gates construction (see
      // the client's constructor guard) — AGENTIC_SHORTS_ENABLED alone on a spot-only deployment
      // throws rather than silently no-opping (spot cannot short).
      shortsEnabled: env['AGENTIC_SHORTS_ENABLED'] === 'true',
      perpCapableVenue: env['AGENTIC_PERP_VENUE'] === 'true',
      minEdgeMultiple: env['AGENTIC_MIN_EDGE_MULTIPLE'],
      minRr: env['AGENTIC_MIN_RR'],
      // C1: off by default ⇒ byte-identical legacy prompt (no derivatives sentence).
      derivativesFeedEnabled: env['DERIVATIVES_FEED_ENABLED'] === 'true',
      // Derivatives-block A/B: 0 by default ⇒ byte-identical (no control arm ever fires).
      derivativesAbPct: intEnv(env['AGENTIC_DERIVATIVES_AB_PCT'], 0),
      thinkingAbPct: intEnv(env['AGENTIC_THINKING_AB_PCT'], 0),
      // C4: off by default ⇒ byte-identical legacy prompt (no sentiment sentence).
      sentimentFeedEnabled: env['SENTIMENT_FEED_ENABLED'] === 'true',
      // Cross-symbol relative-strength block: off by default ⇒ byte-identical. Gated together with
      // the derivatives block under the info-context A/B (derivativesAbPct) inside the client.
      crossSymbolFeedEnabled: env['AGENTIC_CROSS_SYMBOL_ENABLED'] === 'true',
      // Trade-flow/CVD + positioning blocks: off by default ⇒ byte-identical. Gated together with the
      // derivatives block under the SAME info-context A/B (derivativesAbPct) inside the client.
      tradeFlowFeedEnabled: env['AGENTIC_TRADEFLOW_ENABLED'] === 'true',
      positioningFeedEnabled: env['AGENTIC_POSITIONING_ENABLED'] === 'true',
    },
    fetch,
    new Logger('AnthropicAgentClient'),
    playbookProvider,
  );
  const model = env['AGENTIC_MODEL'] ?? DEFAULT_MODEL;
  if (env['AGENTIC_PORTFOLIO_CONSULT'] === 'true') {
    // shorts+consult is a supported combination since backlog #41 — IN PLAN MODE: the batch path
    // selects PORTFOLIO_SHORTS_TOOL (plan.direction required per element, pf2 tag) inside
    // proposeBatch, and the constructor guard has already required a perp-capable venue. The
    // LEGACY (non-plan) shorts path has no batched short expression (PORTFOLIO_TOOL's action enum
    // has no 'short'), so that combination would silently run long-only — refuse it loudly at
    // boot, exactly the silent-degrade class the original #41-predecessor guard existed to stop
    // (reviewer S1).
    if (env['AGENTIC_SHORTS_ENABLED'] === 'true' && env['AGENTIC_PLAN_MODE'] !== 'true') {
      throw new Error(
        'AGENTIC_PORTFOLIO_CONSULT with AGENTIC_SHORTS_ENABLED requires AGENTIC_PLAN_MODE: the ' +
          'batched portfolio tool expresses shorts only via plan.direction — without plan mode ' +
          'every batched decide would silently run long-only. Enable AGENTIC_PLAN_MODE or ' +
          'disable one of the two flags.',
      );
    }
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
      },
      new Logger('BatchingAgentClient'),
    );
  }
  // model threaded through so recordUsage (agent-budget.ts) can resolve per-model cache/token
  // rates (W4+W13) — this client only ever calls the ONE model it was constructed with above.
  return new BudgetedAgentClient(client, budget, new Logger('AgentBudget'), model);
}

// Multi-symbol (P7): per-decide venue-constraint resolution for the shared client, sourced from the
// SAME DEFAULT_FILTERS table Risk/Execution enforce (domain/risk/default-filters) — the prompt's
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
      useFactory: (override?: PlaybookProvider): PlaybookProvider =>
        override ?? seedPlaybookProvider(),
      inject: [{ token: PLAYBOOK_PROVIDER_OVERRIDE, optional: true }],
    },
    {
      provide: AGENT_CLIENT,
      useFactory: (
        budget: DailyLlmBudget,
        playbookProvider: PlaybookProvider,
        config: TypedConfigService | undefined,
        profile: AgentTradingProfile | undefined,
      ) => selectAgentClient(agenticEnv(config), budget, playbookProvider, profile),
      inject: [
        AGENT_LLM_BUDGET,
        PLAYBOOK_PROVIDER,
        { token: TypedConfigService, optional: true },
        { token: AGENT_TRADING_PROFILE_OVERRIDE, optional: true },
      ],
    },
    {
      // G4a wiring. Every injected token besides AGENT_LLM_BUDGET is optional: PLAYBOOK_PROVIDER_OVERRIDE/
      // AGENT_DECISION_JOURNAL/REFLECTION_METRICS_RECORDER_OVERRIDE/LLM_USAGE_SINK are bound by
      // AgenticCompositionBridgeModule (app.module.ts), KILL_SWITCH by KillSwitchModule, STRATEGY_REGISTRY
      // by StrategyRegistryBridgeModule — all @Global, so they resolve here without this module importing
      // any of them, but resolve to undefined in an isolated AgenticStrategyModule-only test context
      // (ReflectionService then fails every precondition closed rather than guessing — see its own deps
      // comment; LLM_USAGE_SINK absent simply means reflection-path usage goes unpersisted).
      provide: REFLECTION_SERVICE,
      useFactory: (
        budget: DailyLlmBudget,
        config: TypedConfigService | undefined,
        playbookStore: ReflectionPlaybookStore | undefined,
        journal: AgentDecisionJournalPort | undefined,
        recorder: ReflectionMetricsRecorder | undefined,
        killSwitch: KillSwitchPort | undefined,
        registry: StrategyRegistryPort | undefined,
        usageSink: LlmUsageSink | undefined,
        evidence: RoundTripEvidencePort | undefined,
      ) =>
        createReflectionService(agenticEnv(config), {
          budget,
          playbookStore,
          journal,
          recorder,
          killSwitch,
          registry,
          usageSink,
          evidence,
          logger: new Logger('ReflectionService'),
        }),
      inject: [
        AGENT_LLM_BUDGET,
        { token: TypedConfigService, optional: true },
        { token: PLAYBOOK_PROVIDER_OVERRIDE, optional: true },
        { token: AGENT_DECISION_JOURNAL, optional: true },
        { token: REFLECTION_METRICS_RECORDER_OVERRIDE, optional: true },
        { token: KILL_SWITCH, optional: true },
        { token: STRATEGY_REGISTRY, optional: true },
        { token: LLM_USAGE_SINK, optional: true },
        { token: REFLECTION_EVIDENCE, optional: true },
      ],
    },
  ],
  exports: [AGENT_CLIENT, AGENT_LLM_BUDGET, PLAYBOOK_PROVIDER, REFLECTION_SERVICE],
})
export class AgenticStrategyModule {}
