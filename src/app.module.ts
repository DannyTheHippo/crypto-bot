import {
  Global,
  Module,
  Inject,
  Optional,
  Logger,
  type MiddlewareConsumer,
  type NestModule,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import type { Exchange } from 'ccxt';
import {
  binanceusdm as BinanceUsdmExchange,
  binance as BinanceSpotExchange,
  pro as ccxtPro,
} from 'ccxt';
import Decimal from 'decimal.js';
import { AppConfigModule } from './config/config.module';
import { TypedConfigService } from './config/environment/typed-config.service';
import { ObservabilityModule } from './features/common/observability/observability.module';
import { PersistenceModule } from './database/database.module';
import { GlobalExceptionFilter } from './shared/filters/global-exception.filter';
import { CorrelationMiddleware } from './shared/correlation/correlation.middleware';
import { DbHealthIndicator } from './database/db-health.indicator';
import { DrizzleExecutionStore } from './database/repositories/drizzle-execution-store';
import { DrizzleExecOutbox } from './database/repositories/drizzle-exec-outbox';
import { PgAdvisoryInstanceLock } from './database/repositories/pg-advisory-instance-lock';
import { DrizzleModeAudit } from './database/repositories/drizzle-mode-audit';
import { RiskDecisionJournalAdapter } from './database/repositories/risk-decision-journal.adapter';
import { SignalJournalAdapter } from './database/repositories/signal-journal.adapter';
import { DATABASE_POOL, DRIZZLE_DB } from './database/database.tokens';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import type * as schema from './database/schemas/trading';
import { DB_HEALTH } from './ports/db-health';
import { RiskModule } from './features/trading/risk/risk.module';
import { KillSwitchService } from './features/trading/risk/kill-switch.service';
import { ExecutionModule } from './features/trading/execution/execution.module';
import {
  SignalSinkService,
  SIGNAL_REJECTIONS_COUNTER,
} from './features/trading/execution/signal-sink.service';
import { HaltCoordinatorService } from './features/trading/execution/halt-coordinator.service';
import {
  ProtectiveExitService,
  PROTECTIVE_EXITS_COUNTER,
} from './features/trading/risk/protective-exit.service';
import { PlanStopRegistryService } from './features/trading/risk/plan-stop-registry.service';
import { UnknownResolverService } from './features/trading/execution/unknown-resolver.service';
import { ReconciliationService } from './features/trading/execution/reconciliation.service';
import { EquitySamplerService } from './features/trading/execution/equity-sampler.service';
import { PortfolioStateService } from './features/trading/execution/portfolio-state.service';
import { BootRecoveryService } from './features/trading/execution/boot-recovery.service';
import {
  PaperExchangeAdapter,
  PAPER_CONFIG,
  type PaperConfig,
} from './features/trading/exchange/paper-exchange.adapter';
import { LiveExchangeAdapter } from './features/trading/exchange/live-exchange.adapter';
import { CcxtExchangeAdapter } from './features/trading/exchange/ccxt-exchange.adapter';
import { RealCcxtOrderClient } from './features/trading/exchange/ccxt-order-client';
import { KeyProbeService } from './features/trading/exchange/key-probe.service';
import {
  buildCcxtExchange,
  CcxtExchangeStreamAdapter,
  RealWatchSource,
  WATCH_SOURCE,
  type ChannelStateTracker,
  type WatchSource,
} from './features/trading/market-data/ccxt-stream.adapter';
import {
  DerivativesFeedService,
  type DerivativesRestSource,
} from './features/trading/market-data/derivatives-feed.service';
import {
  SentimentFeedService,
  type SentimentHttpSource,
} from './features/trading/market-data/sentiment-feed.service';
import {
  TradeFlowFeedService,
  type TradeFlowRestSource,
} from './features/trading/market-data/trade-flow-feed.service';
import {
  PositioningFeedService,
  type PositioningRestSource,
} from './features/trading/market-data/positioning-feed.service';
import {
  LiquidationFeedService,
  type LiquidationWatchSource,
} from './features/trading/market-data/liquidation-feed.service';
import {
  FeedHealthServiceWithBackfill,
  type OhlcvSource,
} from './features/trading/market-data/feed-health.service';
import { MarketDataService } from './features/trading/market-data/market-data.service';
import { StrategyRegistry } from './features/trading/agentic/strategy-registry';
import { StrategyHost } from './features/trading/agentic/strategy-host';
import {
  TeeingMarketStream,
  type RefPriceSink,
  type PaperFeedSink,
} from './features/trading/market-data/teeing-market-stream';
import { DemoFillPollerService } from './features/trading/execution/demo-fill-poller.service';
import { ModeControlService } from './features/trading/mode-control/mode-control.service';
import {
  AgenticStrategyModule,
  AGENT_LLM_BUDGET,
  PLAYBOOK_PROVIDER_OVERRIDE,
  AGENT_TRADING_PROFILE_OVERRIDE,
  REFLECTION_SERVICE,
  REFLECTION_METRICS_RECORDER_OVERRIDE,
  SEED_PLAYBOOK,
  agenticEnv,
} from './features/trading/agentic/agentic-strategy.module';
import type { DailyLlmBudget } from './features/trading/agentic/agent-budget';
import {
  createPromotionEvaluator,
  PromotionEvaluator,
  type EvaluatorPlaybookStore,
} from './features/trading/agentic/promotion-evaluator';
import { ReflectionService } from './features/trading/agentic/reflection.service';
import {
  AgenticStrategy,
  type AgenticStrategyParams,
  type AgenticStrategyDeps,
} from './features/trading/agentic/agentic.strategy';
import { CrossSymbolContextService } from './features/trading/agentic/cross-symbol-context';
import { assertAgenticLaneNotLive } from './features/trading/agentic/agentic-live-interlock';
import { validatePlaybook } from './features/trading/agentic/playbook-validator';
import {
  AGENT_CLIENT,
  AGENT_DECISION_JOURNAL,
  LLM_USAGE_SINK,
  PLAYBOOK_PROVIDER,
  AgentProposeError,
  type AgentClientPort,
  type AgentDecisionInput,
  type AgentDecisionJournalPort,
  type AgentProposal,
  type AgentTradingProfile,
  type LlmUsageSink,
  type PlaybookProvider,
  type SymbolConstraints,
} from './ports/agentic-strategy';
import {
  AgentMetricsRecorder,
  type AgentDecideOutcome,
} from './features/common/observability/agent-metrics-recorder.service';
import { AgentDecisionJournalAdapter } from './database/repositories/agent-decision-journal.adapter';
import { InMemoryAgentDecisionJournal } from './database/repositories/in-memory-agent-decision-journal';
import { LlmUsageSinkAdapter } from './database/repositories/llm-usage-sink.adapter';
import { InMemoryLlmUsageSink } from './database/repositories/in-memory-llm-usage-sink';
import { PromotionStatsRepository } from './database/repositories/promotion-stats.repository';
import {
  PROMOTION_STATS,
  PROMOTION_READINESS,
  REFLECTION_EVIDENCE,
  type PromotionStatsPort,
  type PromotionReadinessPort,
  type PromotionReadiness,
  type RoundTripEvidencePort,
} from './ports/promotion';
import { RoundTripEvidenceReader } from './features/trading/agentic/round-trip-evidence.reader';
import {
  PlaybookStoreAdapter,
  type PlaybookVersionEntry,
} from './database/repositories/playbook-store.adapter';
import { InMemoryPlaybookStore } from './database/repositories/in-memory-playbook-store';
import { price, qty } from './domain/types/money';
import type { SymbolFilters } from './domain/risk/evaluate';
import { DEFAULT_FILTERS } from './domain/risk/default-filters';
import type { CandleInterval } from './domain/types/market-events';
import type { VenueConfig, VenueEnvironment } from './ports/app-config';
import { assertSwapPrivateUrlSafe } from './shared/venue-safety/swap-url-guard';
import { ModeControlModule } from './features/trading/mode-control/mode-control.module';
import {
  LIVE_ADAPTER_CAP,
  LIMITS_COMPLETE,
  KEY_PROBE,
  MODE_AUDIT_OVERRIDE,
  ARM_PRECONDITIONS,
  type KeyProbePort,
  type ModeAuditPort,
  type ArmPreconditionsPort,
  type ArmPreconditionResult,
} from './ports/mode-control';
import { CrashRecoveryService } from './features/trading/execution/crash-recovery.service';
import { CLOCK, SystemClock, type ClockPort } from './ports/clock';
import {
  RISK_SIGNING_KEY,
  KILL_SWITCH,
  RISK_LIMITS,
  RISK_JOURNAL_OVERRIDE,
  PROTECTIVE_EXIT_CONFIG,
  PLAN_STOP_REGISTRY,
  type RiskJournalPort,
  type KillSwitchPort,
  type ProtectiveExitConfig,
  type PlanStopRegistryPort,
} from './ports/risk';
import { validateLimits, type PartialRiskLimits } from './domain/risk/limits';
import { EXCHANGE_PORT, type ExchangePort } from './ports/exchange';
import {
  EXEC_OUTBOX,
  EXEC_REPORT_NOTIFY,
  PORTFOLIO_VIEW,
  EXEC_OUTBOX_OVERRIDE,
  EXECUTION_STORE,
  EXECUTION_STORE_OVERRIDE,
  INSTANCE_LOCK_OVERRIDE,
  type ExecOutboxPort,
  type ExecReportNotify,
  type PortfolioViewPort,
  type ExecutionStorePort,
  type InstanceLockPort,
  type ExecRunContext,
} from './ports/execution';
import {
  MARKET_STREAM,
  FEED_HEALTH,
  REAL_FEED_HEALTH,
  type FeedHealthPort,
  type MarketStreamPort,
} from './ports/market-data';
import { DERIVATIVES_FEED, type DerivativesFeedPort } from './ports/derivatives-feed';
import { SENTIMENT_FEED, type SentimentFeedPort } from './ports/sentiment-feed';
import { TRADE_FLOW_FEED, type TradeFlowFeedPort } from './ports/trade-flow-feed';
import { POSITIONING_FEED, type PositioningFeedPort } from './ports/positioning-feed';
import { LIQUIDATION_FEED, type LiquidationFeedPort } from './ports/liquidation-feed';
import {
  EXCHANGE_STREAM,
  type ExchangeStreamPort,
  type RawVenueEvent,
  type RawUserEvent,
} from './ports/exchange-stream';
import {
  STRATEGY_HOST,
  STRATEGY_REGISTRY,
  SIGNAL_SINK,
  SIGNAL_JOURNAL,
  type StrategyHostPort,
  type StrategyRegistryPort,
  type SignalJournalPort,
} from './ports/strategy';
import { venueId, symbolId, strategyId, type SymbolId } from './domain/types/ids';

// Lifts only DB_HEALTH from PersistenceModule into the global DI scope so ObservabilityModule's
// HealthController resolves it via @Optional() @Inject(DB_HEALTH) without importing persistence.
@Global()
@Module({
  imports: [PersistenceModule],
  providers: [{ provide: DB_HEALTH, useExisting: DbHealthIndicator }],
  exports: [DB_HEALTH],
})
class DbHealthBridgeModule {}

// Lifts PORTFOLIO_VIEW (ExecutionModule's canonical snapshot) into the global scope so
// ObservabilityModule's MetricsService can @Optional() @Inject(PORTFOLIO_VIEW) and emit the §8
// trading gauges (equity/PnL/position) WITHOUT a modules→modules import (observability must not
// import execution — the boundary wall). Same bridge pattern as DbHealthBridgeModule.
@Global()
@Module({
  imports: [ExecutionModule],
  providers: [{ provide: PORTFOLIO_VIEW, useExisting: PortfolioStateService }],
  exports: [PORTFOLIO_VIEW],
})
class PortfolioViewBridgeModule {}

// Lifts STRATEGY_REGISTRY into the global DI scope so ObservabilityModule's MetricsService (per-strategy
// strategy_lifecycle sampling) and HealthController (ready() strategies detail) resolve it via
// @Optional() @Inject(STRATEGY_REGISTRY) without an observability→app-root import (the boundary wall
// runs the other way — modules must not import the composition root). Unlike DbHealthBridgeModule/
// PortfolioViewBridgeModule, StrategyRegistry has no owning sub-module to re-export from: it is the
// composition root's own service, so this bridge provides (not just re-exports) it — AppModule imports
// this module instead of declaring StrategyRegistry as a local provider, keeping exactly one instance.
@Global()
@Module({
  providers: [StrategyRegistry, { provide: STRATEGY_REGISTRY, useExisting: StrategyRegistry }],
  exports: [StrategyRegistry, STRATEGY_REGISTRY],
})
class StrategyRegistryBridgeModule {}

// §7: persistence runtime overrides. When DATABASE_URL is configured AND not under test/ci, the
// execution/mode-control ports are backed by the Drizzle repositories — durable order/fill journal,
// hash-chained audit_log, mode_transitions, and a pg_advisory single-writer lock. Each factory
// returns undefined when the DB path is inactive (no pool, or test/ci), so the consuming module
// factories fall back to their in-memory/noop defaults — keeping the hermetic suite + app-module.boot
// byte-identical to the no-DB path (mirrors the §10 config hard-override: test/ci force in-memory
// regardless of DATABASE_URL). The composition root is the only place allowed to wire these
// concretions to the execution/mode-control ports. The run context stamped on persisted rows matches
// ExecutionModule's EXEC_RUN_CONTEXT (same bootId/runId/mode derivation).
function dbRunContext(config: TypedConfigService): ExecRunContext {
  const bootId = config.app.bootId;
  return { mode: config.mode.configMode, runId: `run-${bootId}`, bootId };
}
@Global()
@Module({
  imports: [PersistenceModule],
  providers: [
    {
      provide: EXEC_OUTBOX_OVERRIDE,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: TypedConfigService,
      ): ExecOutboxPort | undefined =>
        isTestEnv() || db === null ? undefined : new DrizzleExecOutbox(db, dbRunContext(config)),
      inject: [DRIZZLE_DB, TypedConfigService],
    },
    {
      provide: EXECUTION_STORE_OVERRIDE,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: TypedConfigService,
      ): ExecutionStorePort | undefined =>
        isTestEnv() || db === null
          ? undefined
          : new DrizzleExecutionStore(db, dbRunContext(config)),
      inject: [DRIZZLE_DB, TypedConfigService],
    },
    {
      provide: INSTANCE_LOCK_OVERRIDE,
      useFactory: (pool: Pool | null): InstanceLockPort | undefined =>
        isTestEnv() || pool === null ? undefined : new PgAdvisoryInstanceLock(pool),
      inject: [DATABASE_POOL],
    },
    {
      provide: MODE_AUDIT_OVERRIDE,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: TypedConfigService,
      ): ModeAuditPort | undefined =>
        isTestEnv() || db === null ? undefined : new DrizzleModeAudit(db, config.app.bootId),
      inject: [DRIZZLE_DB, TypedConfigService],
    },
    {
      // DB-backed RISK_JOURNAL: persists every risk verdict to risk_decisions for offline analysis.
      provide: RISK_JOURNAL_OVERRIDE,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: TypedConfigService,
      ): RiskJournalPort | undefined =>
        isTestEnv() || db === null
          ? undefined
          : new RiskDecisionJournalAdapter(db, dbRunContext(config)),
      inject: [DRIZZLE_DB, TypedConfigService],
    },
    {
      // DB-backed SIGNAL_JOURNAL: persists every routed signal + its outcome to the signals table.
      // SignalSink injects this @Optional, so undefined (paper/no-DB/test) simply skips journaling.
      provide: SIGNAL_JOURNAL,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: TypedConfigService,
      ): SignalJournalPort | undefined =>
        isTestEnv() || db === null ? undefined : new SignalJournalAdapter(db, dbRunContext(config)),
      inject: [DRIZZLE_DB, TypedConfigService],
    },
  ],
  exports: [
    EXEC_OUTBOX_OVERRIDE,
    EXECUTION_STORE_OVERRIDE,
    INSTANCE_LOCK_OVERRIDE,
    MODE_AUDIT_OVERRIDE,
    RISK_JOURNAL_OVERRIDE,
    SIGNAL_JOURNAL,
  ],
})
class DrizzlePersistenceGlobalModule {}

// §4.2: ONE process-lifetime signing key, generated at the composition root and shared by exactly
// the RiskEngine (mint) and Execution (verify). Global so both modules resolve the same instance;
// never persisted, never in env.
@Global()
@Module({
  providers: [{ provide: RISK_SIGNING_KEY, useFactory: () => randomBytes(32) }],
  exports: [RISK_SIGNING_KEY],
})
class SigningKeyModule {}

// §5: ONE global kill switch. Risk engages it (monitors/reconcile/anomalies) and reads it in the
// pre-trade gate; Execution engages it too (fill-payload conflict, unknown-state timeout,
// reconciliation HALT). A single shared instance is load-bearing — two would let Execution halt a
// switch Risk never reads. RiskModule and ExecutionModule both consume this global, neither owns it.
@Global()
@Module({
  providers: [KillSwitchService, { provide: KILL_SWITCH, useExisting: KillSwitchService }],
  exports: [KillSwitchService, KILL_SWITCH],
})
class KillSwitchModule {}

// §10(d): ModeControl's gate-(d) input, derived ONCE at boot from the SAME RISK_LIMITS the engine
// enforces (RiskModule exports it). Global so ModeControl resolves it without a modules→modules
// import. Replaces the prior hardcoded `true` — the prerequisite for enabling a real key probe.
@Global()
@Module({
  imports: [RiskModule],
  providers: [
    {
      provide: LIMITS_COMPLETE,
      useFactory: (limits: PartialRiskLimits) => validateLimits(limits) !== null,
      inject: [RISK_LIMITS],
    },
  ],
  exports: [LIMITS_COMPLETE],
})
class LimitsCompleteModule {}

// §10c: gate-(c) KEY_PROBE, bound globally by the composition root (ModeControl consumes it). Paper
// uses a forced-invalid probe (paper never trades live, so keysValid stays false ⇒ live unreachable).
// testnet/live build the real KeyProbeService over a credentialed ccxt client; requireRestrictions is
// true for live (an unprobeable restriction set ⇒ refuse). Under test/ci configMode is forced paper,
// so no real client/probe is constructed in CI. keyFingerprint is a hex digest — never the raw key.
const INVALID_KEY_PROBE: KeyProbePort = {
  probe: () =>
    Promise.resolve({
      keysValid: false,
      withdrawalsEnabled: true,
      spotEnabled: false,
      marginOrFutures: false,
      keyFingerprint: 'none',
      urlCrossCheckOk: false,
    }),
};
@Global()
@Module({
  providers: [
    {
      provide: KEY_PROBE,
      useFactory: (config: TypedConfigService): KeyProbePort => {
        const mode = config.mode.configMode;
        if (mode === 'paper') return INVALID_KEY_PROBE;
        const isLive = mode === 'live';
        // Live keys from AppConfig (stripped under test/ci); sandbox keys + environment (testnet|demo)
        // from SANDBOX_ENV via resolveSandbox — keeping demo/testnet keys non-interchangeable.
        const sandbox = resolveSandbox(config);
        const apiKey = isLive ? (config.liveSecrets.liveApiKey ?? '') : sandbox.apiKey;
        const secret = isLive ? (config.liveSecrets.liveApiSecret ?? '') : sandbox.secret;
        const client = buildOrderClient(
          primaryVenue(config),
          isLive ? 'live' : sandbox.environment,
          apiKey,
          secret,
        );
        const keyFingerprint = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
        return new KeyProbeService(client, { keyFingerprint, requireRestrictions: isLive });
      },
      inject: [TypedConfigService],
    },
  ],
  exports: [KEY_PROBE],
})
class KeyProbeModule {}

// §10b arm-hardening: real ARM_PRECONDITIONS check, replacing the always-`{ok:true}` stub
// (mode-control.module.ts no longer self-provides this token — same "not self-provided" pattern as
// KEY_PROBE above — because ModeControl's feature boundary cannot import ExecutionModule directly,
// eslint-plugin-boundaries's features→own-feature-only wall). Fail-closed by construction: any
// unreadable source refuses arming rather than assuming it healthy. Reconciliation has no cheap
// synchronous read of its own (ReconciliationService.reconcile() is async/network-bound); a bad
// reconciliation pass already lands here for free — reconcile.ts's HALT path engages the SAME
// KILL_SWITCH (never auto-flattens), so checking kill-switch RUNNING transitively covers it without
// inventing a second, redundant state read. Exported (like ValidatingPlaybookProvider/
// PlaybookAbRoutingProvider above) so its own unit spec can exercise it directly against fakes,
// without booting CrashRecoveryService's own EXECUTION_STORE/OrderBookService dependencies.
export interface UnresolvedOrdersReader {
  hasUnresolvedOrders(): boolean;
}
export function createArmPreconditions(
  killSwitch: KillSwitchPort,
  unresolvedOrders: UnresolvedOrdersReader,
): ArmPreconditionsPort {
  return {
    check: (): ArmPreconditionResult => {
      let state: ReturnType<KillSwitchPort['state']>;
      try {
        state = killSwitch.state();
      } catch {
        return { ok: false, reason: 'kill switch state unavailable' };
      }
      if (state !== 'RUNNING') {
        return { ok: false, reason: `kill switch not RUNNING (state=${state})` };
      }
      let unresolved: boolean;
      try {
        unresolved = unresolvedOrders.hasUnresolvedOrders();
      } catch {
        return { ok: false, reason: 'unresolved-orders check unavailable' };
      }
      if (unresolved) {
        return { ok: false, reason: 'unresolved orders present (*_UNKNOWN/RECONCILE_REQUIRED)' };
      }
      return { ok: true };
    },
  };
}
@Global()
@Module({
  imports: [ExecutionModule],
  providers: [
    {
      provide: ARM_PRECONDITIONS,
      useFactory: createArmPreconditions,
      inject: [KILL_SWITCH, CrashRecoveryService],
    },
  ],
  exports: [ARM_PRECONDITIONS],
})
class ArmPreconditionsModule {}

// §1.5: only the composition root binds a concrete adapter to EXCHANGE_PORT. Paper mode uses the
// PaperExchangeAdapter fed by ExecutionModule's outbox/notify; non-paper modes swap in the
// CcxtExchangeAdapter here (Phase 7). Global so ExecutionModule's gate resolves EXCHANGE_PORT.
const DEFAULT_PAPER_CONFIG: PaperConfig = {
  seed: 1,
  takerBuffer: '0.05',
  fees: { makerBps: '10', takerBps: '10', feeCurrency: 'quote' },
  latency: { submitMs: [0, 0], eventMs: [0, 0] },
  insufficientDepthPolicy: 'partial_then_reject_rest',
  startingBalances: { USDT: '100000' },
};

// binanceusdm (USDⓈ-M perp): the only perp-capable venue this pass wires — mirrors
// position-sizer.service.ts's own local PERP_VENUE_ID convention (that constant is not exported;
// this string literal is the composition root's independent copy of the same fact).
const PERP_VENUE_ID = 'binanceusdm';

// Push II Phase 8: the futures-demo venue's private base URL, read off the ccxt instance AFTER
// enableDemoTrading/setSandboxMode has mutated it (buildCcxtExchange already applied the flavor).
// Verified empirically against pinned ccxt 4.5.58: enableDemoTrading(true) on binanceusdm sets
// urls.api.fapiPrivate to "https://demo-fapi.binance.com/fapi/v1" — the host swap-url-guard already
// allowlists. ccxt's own Exchange type does not narrow `urls.api` to a known key set, hence the cast.
function swapPrivateUrl(exchange: ReturnType<typeof buildCcxtExchange>): string {
  return (exchange as unknown as { urls: { api: { fapiPrivate: string } } }).urls.api.fapiPrivate;
}

// Build a credentialed ccxt order client for a real venue (testnet/live). Reached only on a non-paper
// boot — under test/ci configMode is forced paper, so this never runs in CI (no network, no keys).
// The real order path is verified at the out-of-session testnet RUN; here it is typecheck-verified.
function buildOrderClient(
  venue: string,
  environment: VenueEnvironment,
  apiKey: string,
  secret: string,
): RealCcxtOrderClient {
  const venueConfig: VenueConfig = { id: venue, environment };
  const exchange = buildCcxtExchange(venueConfig);
  // Push II Phase 8: fail-closed boot guard for the futures-demo venue — refuses to construct a
  // non-live binanceusdm client whose private base URL does not resolve to a known non-live host
  // (mirrors paper-perp.adapter.ts's own use of the same guard). `environment` IS a SwapBootMode
  // ('paper' | 'testnet' | 'demo' | 'live' — the same four-value union), so no mapping is needed.
  if (venue === PERP_VENUE_ID) {
    assertSwapPrivateUrlSafe(swapPrivateUrl(exchange), environment);
  }
  exchange.apiKey = apiKey;
  exchange.secret = secret;
  return new RealCcxtOrderClient(exchange);
}

// The non-paper venue is configurable (VENUES env): the CcxtExchangeAdapter is venue-agnostic, so
// the venue is selected purely by config — first configured venue, default binance.
function primaryVenue(config: TypedConfigService): string {
  return config.venues[0]?.id ?? 'binance';
}

// §3.5: in testnet mode the sandbox FLAVOR (SANDBOX_ENV) picks the environment and its own
// non-interchangeable keys — 'demo' (enableDemoTrading; live-mirroring data, real-account keys, the
// pre-live dress rehearsal) or 'testnet' (setSandboxMode; the purpose-built integration sandbox).
// Keys come straight from process.env (BINANCE_DEMO_*/BINANCE_TESTNET_*), never AppConfig, so they
// are never hashed or logged. Reached only on a non-paper boot — under test/ci configMode is paper.
function resolveSandbox(config: TypedConfigService): {
  environment: VenueEnvironment;
  apiKey: string;
  secret: string;
} {
  if (config.mode.sandboxEnv === 'demo') {
    return {
      environment: 'demo',
      apiKey: process.env['BINANCE_DEMO_API_KEY'] ?? '',
      secret: process.env['BINANCE_DEMO_API_SECRET'] ?? '',
    };
  }
  return {
    environment: 'testnet',
    apiKey: process.env['BINANCE_TESTNET_API_KEY'] ?? '',
    secret: process.env['BINANCE_TESTNET_API_SECRET'] ?? '',
  };
}
@Global()
@Module({
  imports: [ExecutionModule],
  providers: [
    { provide: PAPER_CONFIG, useValue: DEFAULT_PAPER_CONFIG },
    {
      // §1.5/§10: the EXCHANGE_PORT concretion is chosen by the BOOT config authority. Under test/ci
      // configMode is forced paper, so the live branch is never taken and no LiveExchangeAdapter
      // instance enters the object graph (the live-gate matrix asserts exactly this). A real live boot
      // (Phase 7) constructs the live adapter behind a capability token mintable only by ModeControl;
      // its constructor also throws unconditionally under test/ci as a second backstop.
      provide: EXCHANGE_PORT,
      useFactory: (
        clock: ClockPort,
        outbox: ExecOutboxPort,
        notify: ExecReportNotify,
        cfg: PaperConfig,
        config: TypedConfigService,
      ): ExchangePort => {
        const mode = config.mode.configMode;
        const venue = primaryVenue(config); // binance, configured via VENUES
        if (mode === 'live') {
          // Live: real ccxt client behind the capability-token-guarded wrapper. liveApiKey/Secret are
          // present on AppConfig only outside test/ci (the schema strips them otherwise).
          const client = buildOrderClient(
            venue,
            'live',
            config.liveSecrets.liveApiKey ?? '',
            config.liveSecrets.liveApiSecret ?? '',
          );
          return new LiveExchangeAdapter(
            LIVE_ADAPTER_CAP,
            new CcxtExchangeAdapter(client, venueId(venue), false),
          );
        }
        if (mode === 'testnet') {
          // Sandbox: no capability token, no wrapper — a sandbox is not live. SANDBOX_ENV picks the
          // flavor (testnet via setSandboxMode, or demo via enableDemoTrading) and its own keys
          // (BINANCE_TESTNET_*/BINANCE_DEMO_*, separate from live keys; never reached under test/ci).
          const sandbox = resolveSandbox(config);
          const client = buildOrderClient(
            venue,
            sandbox.environment,
            sandbox.apiKey,
            sandbox.secret,
          );
          return new CcxtExchangeAdapter(client, venueId(venue), true);
        }
        return new PaperExchangeAdapter(clock, outbox, notify, cfg, venueId(venue));
      },
      inject: [CLOCK, EXEC_OUTBOX, EXEC_REPORT_NOTIFY, PAPER_CONFIG, TypedConfigService],
    },
  ],
  exports: [EXCHANGE_PORT],
})
class PaperExchangeModule {}

// §3.5/§2: the public market-data feed that drives the StrategyHost and the Risk mark. The ccxt
// client is built WITHOUT credentials (public streams only) — order placement is the credentialed
// EXCHANGE_PORT, a separate concern, so reading market data never crosses the paper→live gate. ONE
// FeedHealth instance is shared three ways: the stream's channel-state tracker, the warmup OHLCV
// backfill source, and (as REAL_FEED_HEALTH) the live mark Risk/Execution read. MARKET_STREAM tees
// that stream — augmenting the strategy's spec with ticker/book and populating the ref price before
// each event reaches the host. Under test/ci nothing is constructed (no socket); the trading runtime
// that consumes this is itself test-gated.
const NOOP_STREAM: ExchangeStreamPort = {
  marketRaw: (): AsyncIterable<RawVenueEvent> => ({
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ value: undefined as never, done: true }),
    }),
  }),
  userEvents: (): AsyncIterable<RawUserEvent> => ({
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ value: undefined as never, done: true }),
    }),
  }),
};
const NOOP_FEED_HEALTH: FeedHealthPort = {
  health: () => 'GAP',
  getRefPrice: () => undefined,
  fetchCandles: () => Promise.resolve([]),
};
// C1: bound whenever DERIVATIVES_FEED_ENABLED is off (default) or under test/ci — no poll ever
// starts, latest() always answers null, so the agentic prompt's derivatives block never renders.
const NOOP_DERIVATIVES_FEED: DerivativesFeedPort = {
  latest: () => null,
  lastSuccessfulPollAt: () => null,
  pollErrorCount: () => 0,
};
// C4: bound whenever SENTIMENT_FEED_ENABLED is off (default), under test/ci, or the API key is
// absent — no poll ever starts, latest() always answers null, so the agentic prompt's sentiment
// block never renders.
const NOOP_SENTIMENT_FEED: SentimentFeedPort = {
  latest: () => null,
  lastSuccessfulPollAt: () => null,
  pollErrorCount: () => 0,
};
// Bound whenever AGENTIC_TRADEFLOW_ENABLED is off (default) or under test/ci — no poll ever starts,
// latest() always answers null, so the agentic prompt's tradeFlow block never renders.
const NOOP_TRADE_FLOW_FEED: TradeFlowFeedPort = {
  latest: () => null,
  lastSuccessfulPollAt: () => null,
  pollErrorCount: () => 0,
};
// Bound whenever AGENTIC_POSITIONING_ENABLED is off (default) or under test/ci — no poll ever
// starts, latest() always answers null, so the agentic prompt's positioning block never renders.
const NOOP_POSITIONING_FEED: PositioningFeedPort = {
  latest: () => null,
  lastSuccessfulPollAt: () => null,
  pollErrorCount: () => 0,
};
// Bound whenever AGENTIC_LIQUIDATIONS_ENABLED is off (default) or under test/ci — the WS loop never
// starts, latest() always answers null, streamHealthy() stays false, so the agentic prompt's
// liquidation block never renders (mirrors NOOP_POSITIONING_FEED's own contract).
const NOOP_LIQUIDATION_FEED: LiquidationFeedPort = {
  latest: () => null,
  streamHealthy: () => false,
  reconnectCount: () => 0,
};
// Free-tier CryptoPanic REST client (public headlines endpoint; no ccxt involved — this is a news
// feed, not an exchange). apiKey is read directly off process.env (never through TypedConfigService/
// AppConfig — see environment.config.ts's SENTIMENT_FEED_API_KEY comment), so it is never logged or
// folded into configHash. Fixed currencies filter (BTC,ETH) matches this deployment's trading symbols.
function buildSentimentHttpSource(apiKey: string): SentimentHttpSource {
  return {
    fetchPosts: async () => {
      const res = await fetch(
        `https://cryptopanic.com/api/v1/posts/?auth_token=${apiKey}&currencies=BTC,ETH`,
      );
      if (!res.ok) throw new Error(`cryptopanic fetch failed: ${res.status}`);
      return await res.json();
    },
  };
}
// Public-only REST client for the USDT-margined perp market (funding rate / open interest have no
// spot-market equivalent) — mirrors buildCcxtExchange's no-credentials construction (same file
// header comment) but plain REST (ccxt.binanceusdm), not ccxt.pro: fetchFundingRate/fetchOpenInterest
// are REST-only unified methods, never streamed. Never wired through venue-urls.ts (that module's
// VenueUrlOverride shape has no swap-market entry yet — see DerivativesFeedService's own header
// comment on the C1 plan's venue-urls deferral).
// d2 (Push 3 P6 Unit 1) true spot-perp basis needs the SPOT market's last price alongside the perp
// client's funding/OI — mirrors buildTradeFlowRestSource's own spot-client precedent below. A plain
// object (not a bare ccxt instance) so fetchTicker binds to the spot exchange while
// fetchFundingRate/fetchOpenInterest keep binding to the perp exchange.
function buildDerivativesRestSource(): DerivativesRestSource {
  const perp = new BinanceUsdmExchange({ number: String, enableRateLimit: true });
  const spot = new BinanceSpotExchange({ number: String, enableRateLimit: true });
  return {
    fetchFundingRate: (symbol) => perp.fetchFundingRate(symbol),
    fetchOpenInterest: (symbol) => perp.fetchOpenInterest(symbol),
    fetchTicker: (symbol) => spot.fetchTicker(symbol),
  };
}
// Public-only REST client for the SPOT market's raw (unparsed) klines endpoint — the CVD feed calls
// ccxt's implicit `publicGetKlines` method directly (bypassing the unified fetchOHLCV/parseOHLCV,
// which unconditionally drops the taker-buy-base-volume field; see trade-flow-feed.ts's header
// comment) rather than the derivatives feed's futures client above, since the strategy trades spot
// symbols and this reads the SAME market it trades.
function buildTradeFlowRestSource(): TradeFlowRestSource {
  const exchange = new BinanceSpotExchange({ number: String, enableRateLimit: true });
  return {
    fetchRawKlines: (symbol, interval, limit) =>
      (
        exchange as unknown as {
          publicGetKlines: (params: Record<string, unknown>) => Promise<unknown[][]>;
        }
      ).publicGetKlines({ symbol, interval, limit }),
  };
}
// Public-only REST client for market-wide futures positioning (global long/short account ratio) —
// mirrors buildDerivativesRestSource's no-credentials construction. Calls the RAW (unparsed)
// `fapiDataGetGlobalLongShortAccountRatio` implicit method directly rather than ccxt's unified
// fetchLongShortRatioHistory wrapper — that wrapper's parseLongShortRatio keeps only longShortRatio,
// dropping longAccount/shortAccount from its parsed structure (see positioning-feed.service.ts's
// header comment) — a public endpoint, no API key required.
function buildPositioningRestSource(): PositioningRestSource {
  const exchange = new BinanceUsdmExchange({ number: String, enableRateLimit: true });
  return {
    fetchRawLongShortRatio: (symbol, period, limit) =>
      (
        exchange as unknown as {
          fapiDataGetGlobalLongShortAccountRatio: (
            params: Record<string, unknown>,
          ) => Promise<unknown[]>;
        }
      ).fapiDataGetGlobalLongShortAccountRatio({ symbol, period, limit }) as Promise<
        Array<{
          readonly longAccount?: string | number;
          readonly shortAccount?: string | number;
          readonly longShortRatio?: string | number;
          readonly timestamp?: number;
        }>
      >,
  };
}
// Public-only ccxt PRO client for the perp forceOrder (liquidation) stream — a WS subscription, not a
// REST poll (distinct from every other builder above), constructed with no credentials (the stream is
// public). Mirrors buildCcxtExchange's own no-credentials construction (ccxt-stream.adapter.ts) but
// against a dedicated instance rather than the shared market-data one, since this stream is only ever
// subscribed once at feed-construction time, never per-symbol like the ticker/book/candle channels.
function buildLiquidationWatchSource(): LiquidationWatchSource {
  const exchange = new ccxtPro.binanceusdm({ number: String, enableRateLimit: true });
  return {
    watchLiquidationsForSymbols: (symbols) =>
      (
        exchange as unknown as {
          watchLiquidationsForSymbols: (symbols: readonly string[]) => Promise<unknown[]>;
        }
      ).watchLiquidationsForSymbols(symbols) as Promise<
        readonly {
          readonly symbol: string;
          readonly side: string;
          readonly quoteValue?: number;
          readonly contracts?: number;
          readonly price?: number;
          readonly timestamp?: number;
        }[]
      >,
  };
}
function isTestEnv(): boolean {
  return (
    process.env['NODE_ENV'] === 'test' ||
    process.env['NODE_ENV'] === 'ci' ||
    Boolean(process.env['CI'])
  );
}
function feedVenueConfig(config: TypedConfigService): VenueConfig {
  const id = config.venues[0]?.id ?? 'binance';
  // Market data is public; default to live streams (realistic depth) regardless of trading mode.
  const environment = (process.env['FEED_ENV'] as VenueEnvironment | undefined) ?? 'live';
  return { id, environment };
}
function hasIngest(port: ExchangePort): port is ExchangePort & PaperFeedSink {
  return typeof (port as unknown as { ingestBook?: unknown }).ingestBook === 'function';
}
const MD_EXCHANGE = Symbol('MD_EXCHANGE');
@Global()
@Module({
  imports: [PaperExchangeModule],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: WATCH_SOURCE, useClass: RealWatchSource },
    {
      provide: MD_EXCHANGE,
      useFactory: (config: TypedConfigService): Exchange | undefined =>
        isTestEnv() ? undefined : buildCcxtExchange(feedVenueConfig(config)), // public — no apiKey/secret
      inject: [TypedConfigService],
    },
    {
      provide: REAL_FEED_HEALTH,
      useFactory: (
        clock: ClockPort,
        config: TypedConfigService,
        exchange?: Exchange,
      ): FeedHealthPort =>
        exchange
          ? new FeedHealthServiceWithBackfill(
              clock,
              NOOP_STREAM,
              exchange satisfies OhlcvSource,
              feedVenueConfig(config),
            )
          : NOOP_FEED_HEALTH,
      inject: [CLOCK, TypedConfigService, MD_EXCHANGE],
    },
    {
      provide: EXCHANGE_STREAM,
      useFactory: (
        clock: ClockPort,
        watchSource: WatchSource,
        feedHealth: FeedHealthPort,
        config: TypedConfigService,
        exchange?: Exchange,
      ): ExchangeStreamPort =>
        exchange
          ? new CcxtExchangeStreamAdapter(
              clock,
              watchSource,
              exchange,
              venueId(feedVenueConfig(config).id),
              feedHealth as unknown as ChannelStateTracker,
            )
          : NOOP_STREAM,
      inject: [CLOCK, WATCH_SOURCE, REAL_FEED_HEALTH, TypedConfigService, MD_EXCHANGE],
    },
    {
      provide: MARKET_STREAM,
      useFactory: (
        exchangeStream: ExchangeStreamPort,
        clock: ClockPort,
        feedHealth: FeedHealthPort,
        exchangePort: ExchangePort,
      ): MarketStreamPort => {
        const inner = new MarketDataService(exchangeStream, clock);
        // Paper sim needs book/trade ingestion to fill; the live/demo venue fills its own orders, so
        // paperFeed is present only when EXCHANGE_PORT is the PaperExchangeAdapter (structural check).
        const paperFeed = hasIngest(exchangePort) ? exchangePort : undefined;
        return new TeeingMarketStream(
          inner,
          feedHealth as unknown as RefPriceSink,
          { ticker: true, book: true, trades: true },
          paperFeed,
        );
      },
      inject: [EXCHANGE_STREAM, CLOCK, REAL_FEED_HEALTH, EXCHANGE_PORT],
    },
    { provide: FEED_HEALTH, useExisting: REAL_FEED_HEALTH },
    {
      provide: DERIVATIVES_FEED,
      useFactory: (config: TypedConfigService, clock: ClockPort): DerivativesFeedPort => {
        const { enabled, pollIntervalMs } = config.derivativesFeed;
        // Same test/ci short-circuit as MD_EXCHANGE above (no network client under test), plus the
        // feature flag itself — off by default, so an unconfigured deployment never polls.
        if (isTestEnv() || !enabled) return NOOP_DERIVATIVES_FEED;
        const source = buildDerivativesRestSource();
        const service = new DerivativesFeedService(source, {
          symbols: config.strategy.symbols.map((s) => symbolId(s)),
          pollIntervalMs,
          clock,
          logger: new Logger('DerivativesFeedService'),
        });
        // Explicit start (never relies on Nest's factory-provider lifecycle-hook wiring): idempotent
        // (start() no-ops if already running), mirrors StrategyHost's own explicit host.start() below.
        service.start();
        return service;
      },
      inject: [TypedConfigService, CLOCK],
    },
    {
      provide: SENTIMENT_FEED,
      useFactory: (config: TypedConfigService, clock: ClockPort): SentimentFeedPort => {
        const { enabled, pollIntervalMs } = config.sentimentFeed;
        const apiKey = process.env['SENTIMENT_FEED_API_KEY'];
        // Same test/ci short-circuit as DERIVATIVES_FEED above, plus the feature flag and the API
        // key itself — CryptoPanic's free tier requires auth_token, so a keyless deployment must
        // stay inert rather than poll an endpoint it can never authenticate against.
        if (isTestEnv() || !enabled || !apiKey) return NOOP_SENTIMENT_FEED;
        const source = buildSentimentHttpSource(apiKey);
        const service = new SentimentFeedService(source, {
          pollIntervalMs,
          clock,
          logger: new Logger('SentimentFeedService'),
        });
        service.start();
        return service;
      },
      inject: [TypedConfigService, CLOCK],
    },
    {
      provide: TRADE_FLOW_FEED,
      useFactory: (config: TypedConfigService, clock: ClockPort): TradeFlowFeedPort => {
        const { enabled, pollIntervalMs } = config.tradeFlowFeed;
        // Same test/ci short-circuit as DERIVATIVES_FEED above, plus the feature flag itself.
        if (isTestEnv() || !enabled) return NOOP_TRADE_FLOW_FEED;
        const source = buildTradeFlowRestSource();
        const service = new TradeFlowFeedService(source, {
          symbols: config.strategy.symbols.map((s) => symbolId(s)),
          interval: config.strategy.interval,
          lookbackBars: 20,
          pollIntervalMs,
          clock,
          logger: new Logger('TradeFlowFeedService'),
        });
        service.start();
        return service;
      },
      inject: [TypedConfigService, CLOCK],
    },
    {
      provide: POSITIONING_FEED,
      useFactory: (config: TypedConfigService, clock: ClockPort): PositioningFeedPort => {
        const { enabled, pollIntervalMs } = config.positioningFeed;
        // Same test/ci short-circuit as DERIVATIVES_FEED above, plus the feature flag itself.
        if (isTestEnv() || !enabled) return NOOP_POSITIONING_FEED;
        const source = buildPositioningRestSource();
        const service = new PositioningFeedService(source, {
          symbols: config.strategy.symbols.map((s) => symbolId(s)),
          ratioPeriod: '15m',
          pollIntervalMs,
          clock,
          logger: new Logger('PositioningFeedService'),
        });
        service.start();
        return service;
      },
      inject: [TypedConfigService, CLOCK],
    },
    {
      provide: LIQUIDATION_FEED,
      useFactory: (config: TypedConfigService, clock: ClockPort): LiquidationFeedPort => {
        const { enabled } = config.liquidationFeed;
        // Same test/ci short-circuit as DERIVATIVES_FEED above, plus the feature flag itself.
        if (isTestEnv() || !enabled) return NOOP_LIQUIDATION_FEED;
        const source = buildLiquidationWatchSource();
        const service = new LiquidationFeedService(source, {
          symbols: config.strategy.symbols.map((s) => symbolId(s)),
          clock,
          logger: new Logger('LiquidationFeedService'),
        });
        service.start();
        return service;
      },
      inject: [TypedConfigService, CLOCK],
    },
  ],
  exports: [
    MARKET_STREAM,
    FEED_HEALTH,
    REAL_FEED_HEALTH,
    EXCHANGE_STREAM,
    DERIVATIVES_FEED,
    SENTIMENT_FEED,
    TRADE_FLOW_FEED,
    POSITIONING_FEED,
    LIQUIDATION_FEED,
  ],
})
class MarketFeedModule {}

// Composition-root shape for the write side of the playbook store (append/listVersions) — neither
// PlaybookStoreAdapter nor InMemoryPlaybookStore share a formal port for it yet (reflection/promotion,
// G4a/G4b, will need one); both classes already satisfy this shape structurally, so this is just the
// type PLAYBOOK_PROVIDER_OVERRIDE's binding below is typed against, without a premature port addition
// to ports/agentic-strategy.ts.
interface PlaybookStorePort extends PlaybookProvider {
  append(
    content: string,
    source: 'reflection' | 'promotion',
    parentVersion: number,
  ): Promise<{ version: number }>;
  listVersions(limit: number): Promise<readonly PlaybookVersionEntry[]>;
}

// W4.1 live champion/candidate A/B: when a newer INACTIVE reflection-minted candidate exists, route a
// deterministic percentage of current() calls to its content instead of the resolved ACTIVE version,
// so per-version PnL attribution (agent_decisions.playbookVersion / agentic_version_net_pnl_usd{version})
// accrues candidate evidence BEFORE promotion. Playbook content is inert advisory prose — no state
// crosses versions — and whatever this returns still passes through ValidatingPlaybookProvider (the
// outer wrap below) exactly as ACTIVE does, so routing is safe by construction.
//
// Determinism: PlaybookProvider.current() (ports/agentic-strategy.ts) takes no per-call argument — no
// strategyId/basedOnSeq reaches this layer, and threading either through AGENT_CLIENT/agent-prompt just
// to key routing would be new plumbing this task deliberately avoids. Routing is therefore keyed off
// wall-clock: a UTC-minute bucket (`floor(Date.now() / 60_000) % 100`) compared against `pct`. Every
// current() call within the same UTC minute makes the same routing decision (no flip-flopping between
// two consecutive decides moments apart), while the bucket cycles through all 100 values over ~100
// minutes, approximating the requested percentage over any window longer than that. Not cached across
// calls (unlike PlaybookStoreAdapter/InMemoryPlaybookStore's own resolved-active cache) — each call
// re-derives its bucket off the live clock and re-reads listVersions, so a freshly minted candidate or
// a promotion is picked up on the very next call, never stale.
//
// Exported (like the sibling ValidatingPlaybookProvider) so its own unit spec can import and
// exercise it directly against a fake PlaybookStorePort — same precedent as MetricsWrappingAgentClient
// below, which agent-decide-outcome.spec.ts imports from this module the same way.
//
// N2: 'loop-candidate' rows (scripts/playbook-candidate.mjs — the loop-side injection path) route
// exactly like 'reflection' rows here — same INACTIVE-until-promoted shape, same "newest wins above
// active" precedence, same local structural gate below. promotion/seed never route (they ARE, or
// resolve to, the active version already).
const CANDIDATE_SOURCES = new Set<PlaybookVersionEntry['source']>(['reflection', 'loop-candidate']);

export class PlaybookAbRoutingProvider implements PlaybookStorePort {
  private static readonly BUCKET_MS = 60_000;

  constructor(
    private readonly inner: PlaybookStorePort,
    private readonly pct: number,
  ) {}

  async current(): Promise<{
    version: number;
    content: string;
    source?: 'pin' | 'promotion' | 'seed';
  }> {
    const active = await this.inner.current();
    if (this.pct <= 0) return active; // default/disabled — skip the listVersions round trip entirely

    const bucket = Math.floor(Date.now() / PlaybookAbRoutingProvider.BUCKET_MS) % 100;
    if (bucket >= this.pct) return active;

    const candidate = await this.latestCandidate(active.version);
    if (!candidate) return active;

    // Local structural gate: an invalid candidate falls back to ACTIVE rather than ever being
    // surfaced (and journaled) as the served version — ValidatingPlaybookProvider still re-validates
    // ACTIVE and candidate content identically regardless; this pre-check just keeps a rejected
    // candidate from being the thing that lands in agent_decisions.playbook_version.
    const validation = validatePlaybook(candidate.content);
    if (!validation.ok) return active;

    // `source` intentionally omitted (not undefined) — this resolution outcome is neither
    // pin/promotion/seed; PlaybookProvider.current()'s own doc calls that "omitted by providers that
    // don't track it".
    return { version: candidate.version, content: candidate.content };
  }

  // The unrouted read (PlaybookProvider.active): the inner store has no routing layer, so its own
  // current() IS the pin/promotion/seed resolution.
  active(): Promise<{
    version: number;
    content: string;
    source?: 'pin' | 'promotion' | 'seed';
  }> {
    return this.inner.current();
  }

  // Newest INACTIVE row (source in CANDIDATE_SOURCES) with version > the resolved active version —
  // mirrors PlaybookStoreAdapter.resolve()'s own "newest wins" convention for other sources. A cap of
  // 50 rows matches InMemoryPlaybookStore.MAX_VERSIONS, so both backings are scanned in full.
  private async latestCandidate(activeVersion: number): Promise<PlaybookVersionEntry | undefined> {
    const versions = await this.inner.listVersions(50);
    let latest: PlaybookVersionEntry | undefined;
    for (const row of versions) {
      if (
        CANDIDATE_SOURCES.has(row.source) &&
        row.version > activeVersion &&
        (latest === undefined || row.version > latest.version)
      ) {
        latest = row;
      }
    }
    return latest;
  }

  append(
    content: string,
    source: 'reflection' | 'promotion',
    parentVersion: number,
  ): Promise<{ version: number }> {
    return this.inner.append(content, source, parentVersion);
  }

  listVersions(limit: number): Promise<readonly PlaybookVersionEntry[]> {
    return this.inner.listVersions(limit);
  }
}

// Composition-root tripwire wrapping the resolved playbook store's READ side only: the playbook is
// untrusted, previously-model-authored content (see playbook-validator.ts's header comment).
// AnthropicAgentClient re-validates on every call regardless (defense in depth); this wrapper
// additionally surfaces a rejection to Prometheus (recordValidatorRejection) and guarantees the LLM
// always receives SOME playbook (SEED_PLAYBOOK) rather than the client's own tripwire, which silently
// composes no playbook at all. append/listVersions pass through unvalidated — validation only gates
// what reaches the LLM prompt, never the store's write side (reflection/promotion write raw content).
export class ValidatingPlaybookProvider implements PlaybookStorePort {
  constructor(
    private readonly inner: PlaybookStorePort,
    private readonly recorder: AgentMetricsRecorder,
  ) {}

  async current(): Promise<{
    version: number;
    content: string;
    source?: 'pin' | 'promotion' | 'seed';
  }> {
    return this.validated(this.inner.current());
  }

  // Forwards the unrouted active read through the SAME validation as current() — the boot info
  // stamp must never surface unvalidated content either. Falls back to inner.current() when the
  // inner chain has no routing layer (active absent ⇒ current already is the active read).
  async active(): Promise<{
    version: number;
    content: string;
    source?: 'pin' | 'promotion' | 'seed';
  }> {
    return this.validated(this.inner.active?.() ?? this.inner.current());
  }

  private async validated(
    read: Promise<{ version: number; content: string; source?: 'pin' | 'promotion' | 'seed' }>,
  ): Promise<{ version: number; content: string; source?: 'pin' | 'promotion' | 'seed' }> {
    const stored = await read;
    const validation = validatePlaybook(stored.content);
    if (!validation.ok) {
      this.recorder.recordValidatorRejection(
        validation.bannedTokenHit ?? false,
        validation.bannedToken,
      );
      return { ...SEED_PLAYBOOK, source: 'seed' };
    }
    return stored;
  }

  append(
    content: string,
    source: 'reflection' | 'promotion',
    parentVersion: number,
  ): Promise<{ version: number }> {
    return this.inner.append(content, source, parentVersion);
  }

  listVersions(limit: number): Promise<readonly PlaybookVersionEntry[]> {
    return this.inner.listVersions(limit);
  }
}

// SymbolFilters (venue rounding rules Risk/Execution enforce, see domain/risk/default-filters.ts) →
// SymbolConstraints (the agentic port's own name for the identical shape — ports/agentic-strategy.ts).
function symbolConstraintsFor(symbol: string): SymbolConstraints | undefined {
  const filters: SymbolFilters | undefined = DEFAULT_FILTERS.get(symbol);
  if (!filters) return undefined;
  return {
    tickSize: price(filters.tickSize),
    lotStep: qty(filters.stepSize),
    minNotional: price(filters.minNotional),
  };
}

// The agentic lane's own commercial profile (folded into its system prompt — see
// AnthropicAgentClientConfig.profile), built from the SAME sources Risk/paper fees use rather than a
// second, independently-tunable copy: maxOrderNotional is read live off RISK_LIMITS (RiskModule's
// config-overlaid DEFAULT_LIMITS, exported for exactly this single-source-of-truth read — see
// LimitsCompleteModule above); baseNotional is the SAME validated AppConfig.risk.baseNotional
// risk.module.ts's sizer reads (passed in by the factory below, so prompt and sizer can never
// drift); maker/takerBps mirror DEFAULT_PAPER_CONFIG.fees below (§1.5) — the actual fee schedule
// the paper adapter charges, not the retired pure-lane prompt's hardcoded ~20bps taker guess (no
// such shared constant exists elsewhere in the codebase). equityFraction is the SAME validated
// AppConfig.risk.equityFraction risk.module.ts's sizer reads (P5 compounding sizing) — set on the
// profile only when > 0 so the prompt sentence and the sizer's active path can never disagree.
function agentTradingProfileFor(
  symbol: string,
  limits: PartialRiskLimits,
  baseNotional: string,
  equityFraction: string,
  protectStopLossPct: string,
  protectTrailingPct: string,
): AgentTradingProfile {
  return {
    makerBps: DEFAULT_PAPER_CONFIG.fees.makerBps,
    takerBps: DEFAULT_PAPER_CONFIG.fees.takerBps,
    baseNotional,
    maxOrderNotional: limits.maxOrderNotional ?? '100000',
    constraints: symbolConstraintsFor(symbol) ?? {
      tickSize: price('0.01'),
      lotStep: qty('0.0001'),
      minNotional: price('10'),
    },
    // Only set when compounding sizing is actually active — an always-present '0' would flip the
    // prompt's sizing sentence for every unconfigured deployment (the disabled-path prompt must stay
    // byte-identical to pre-P5).
    ...(new Decimal(equityFraction).gt(0) ? { equityFraction } : {}),
    // §S3: same latitude as equityFraction above — only set when the corresponding knob is active, so
    // the disabled-path prompt stays byte-identical to pre-S3.
    ...(new Decimal(protectStopLossPct).gt(0) ? { protectStopLossPct } : {}),
    ...(new Decimal(protectTrailingPct).gt(0) ? { protectTrailingPct } : {}),
  };
}

// Composition-root decorator recording agentic-lane decide() telemetry (G3b's AgentMetricsRecorder)
// around whichever AgentClientPort AgenticStrategyModule resolved (stub / budgeted-Anthropic) — kept
// OUTSIDE that module so it can depend on ObservabilityModule (the boundary wall runs the other way).
// Wrapped in AppModule's constructor body rather than re-provided under the AGENT_CLIENT token: Nest
// has no way to inject "the imported AGENT_CLIENT specifically" from a scope that ALSO re-provides
// that exact token locally (the local provider would shadow — and thus self-reference — the import
// it's trying to wrap), so this wraps at the point of consumption instead of via a second DI binding.
export class MetricsWrappingAgentClient implements AgentClientPort {
  // `model` is the configured decide model (config.agentic.model), not read off the proposal —
  // AgentUsage carries no model field, and every call this wrapper sees is a decide call (#28:
  // reflection tags its own tokens with cfg.model in reflection.service.ts).
  constructor(
    private readonly inner: AgentClientPort,
    private readonly recorder: AgentMetricsRecorder,
    private readonly budget: DailyLlmBudget,
    private readonly model: string,
  ) {}

  async propose(input: AgentDecisionInput): Promise<AgentProposal> {
    const started = Date.now();
    try {
      const proposal = await this.inner.propose(input);
      this.recorder.observeDecideLatency((Date.now() - started) / 1000);
      if (proposal.usage) {
        this.recorder.recordTokens(
          proposal.usage.inputTokens,
          proposal.usage.outputTokens,
          proposal.usage.cacheReadInputTokens,
          proposal.usage.cacheCreationInputTokens,
          this.model,
        );
      }
      this.recorder.recordDecide(this.outcomeForProposal(proposal), this.model);
      return proposal;
    } catch (err) {
      this.recorder.observeDecideLatency((Date.now() - started) / 1000);
      this.recorder.recordDecide(this.outcomeForError(err), this.model);
      throw err;
    }
  }

  // AgentProposeError carries only RETRYABLE|FATAL (ports/agentic-strategy.ts) — no distinct TIMEOUT
  // kind, and string-matching the message to detect an aborted call would violate the very reason
  // AgentProposeError exists (branch on kind, never on message text). 'timeout' is therefore never
  // emitted here; a timed-out call surfaces as error_retryable like any other transient failure.
  private outcomeForError(err: unknown): AgentDecideOutcome {
    if (err instanceof AgentProposeError) {
      return err.kind === 'FATAL' ? 'error_fatal' : 'error_retryable';
    }
    return 'error_retryable';
  }

  // A proposal with no client-supplied decision and no signals is either a genuine soft no-op (stub
  // client, malformed response, refusal — see anthropic-agent-client.ts) or the budget gate's inert
  // `{ signals: [] }` short-circuit (agent-budget.ts) — the two are indistinguishable from the
  // proposal shape alone, so the budget snapshot (read AFTER propose() resolves, reflecting whether
  // THIS call's reservation attempt was the one that failed) breaks the tie.
  private outcomeForProposal(proposal: AgentProposal): AgentDecideOutcome {
    if (!proposal.decision) {
      let exhausted = false;
      try {
        exhausted = this.budget.snapshot().exhausted;
      } catch {
        /* metrics must never throw into a trading path */
      }
      return proposal.signals.length === 0 && exhausted ? 'budget_blocked' : 'hold';
    }
    if (proposal.decision.action === 'hold') return 'hold';
    // A non-hold action can still map to zero signals (e.g. 'flat' while already FLAT, 'long' while
    // already LONG — see the mapping comment in anthropic-agent-client.ts) — nothing reached Risk.
    return proposal.signals.length === 0 ? 'noop' : 'proposed';
  }
}

// §7 (agentic lane), same test/ci-forces-in-memory backstop as DrizzlePersistenceGlobalModule above,
// scoped to the agentic decision journal + playbook store + trading profile + LLM usage sink rather
// than execution/mode-control — kept as its own bridge (not folded into DrizzlePersistenceGlobalModule)
// because these bindings also need ObservabilityModule (AgentMetricsRecorder, for the playbook
// validator tripwire) and RiskModule (RISK_LIMITS, for the trading profile), dependencies the
// execution/mode-control overrides don't share. RiskModule is already imported by AppModule's own
// imports below; Nest resolves a statically-imported module class once and shares the instance across
// every importer (same precedent as LimitsCompleteModule's own `imports: [RiskModule]` above).
@Global()
@Module({
  imports: [PersistenceModule, ObservabilityModule, RiskModule],
  providers: [
    {
      provide: AGENT_DECISION_JOURNAL,
      useFactory: (db: NodePgDatabase<typeof schema> | null): AgentDecisionJournalPort =>
        isTestEnv() || db === null
          ? new InMemoryAgentDecisionJournal()
          : new AgentDecisionJournalAdapter(db),
      inject: [DRIZZLE_DB],
    },
    {
      // DB-backed LLM_USAGE_SINK: persists reflection-path token usage to llm_usage for offline cost
      // analysis (P2a) — ReflectionService injects this @Optional, so undefined (paper/no-DB/test)
      // simply skips recording. In-memory (array-backed, not a bare no-op — see its own comment)
      // under test/ci or no-DB, mirroring AGENT_DECISION_JOURNAL's own fallback convention above.
      provide: LLM_USAGE_SINK,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: TypedConfigService,
      ): LlmUsageSink =>
        isTestEnv() || db === null
          ? new InMemoryLlmUsageSink()
          : new LlmUsageSinkAdapter(db, config.mode.configMode),
      inject: [DRIZZLE_DB, TypedConfigService],
    },
    {
      // Bound under its own token (not directly to PLAYBOOK_PROVIDER, which AgenticStrategyModule owns)
      // so the write side (append/listVersions) stays reachable for reflection/promotion (G4a/G4b)
      // alongside the validated read side AgenticStrategyModule's PLAYBOOK_PROVIDER factory consumes
      // via PLAYBOOK_PROVIDER_OVERRIDE (see that token's own comment).
      provide: PLAYBOOK_PROVIDER_OVERRIDE,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: TypedConfigService,
        recorder: AgentMetricsRecorder,
      ): PlaybookStorePort => {
        const pin = config.agentic.playbookPin;
        const store =
          isTestEnv() || db === null
            ? new InMemoryPlaybookStore(SEED_PLAYBOOK, pin)
            : new PlaybookStoreAdapter(db, SEED_PLAYBOOK, pin);
        // W4.1: A/B router sits INSIDE the validating wrap, so candidate content faces the exact
        // same read-side validation as ACTIVE. pct=0 (default) short-circuits to the plain store.
        const routed = new PlaybookAbRoutingProvider(store, config.agentic.playbookAbPct);
        return new ValidatingPlaybookProvider(routed, recorder);
      },
      inject: [DRIZZLE_DB, TypedConfigService, AgentMetricsRecorder],
    },
    {
      // The shared client's STATIC profile: fees/sizing/backstop are symbol-independent; the
      // constraints here are only the fallback — the client resolves per-symbol constraints per
      // decide (constraintsFor, agentic-strategy.module.ts), so the first configured symbol is
      // just the fallback anchor.
      provide: AGENT_TRADING_PROFILE_OVERRIDE,
      useFactory: (limits: PartialRiskLimits, config: TypedConfigService): AgentTradingProfile =>
        agentTradingProfileFor(
          config.strategy.symbols[0]!,
          limits,
          config.risk.baseNotional,
          config.risk.equityFraction,
          config.risk.protectStopLossPct,
          config.risk.protectTrailingPct,
        ),
      inject: [RISK_LIMITS, TypedConfigService],
    },
    // G4a: lets ReflectionService (features/trading/agentic, which cannot import
    // features/common/observability — the boundary wall) record validator-rejection tripwires
    // through its own LOCAL structural type
    // rather than the concrete class. Same useExisting pattern the DB_HEALTH/PORTFOLIO_VIEW bridges use.
    { provide: REFLECTION_METRICS_RECORDER_OVERRIDE, useExisting: AgentMetricsRecorder },
    {
      // PROMOTION_STATS (earned-live evidence source): DB-backed only — there is deliberately NO
      // in-memory fallback, because PromotionReadinessService treats an absent stats source as the
      // fail-closed NO_STATS_SOURCE verdict (a bot without durable fills has no promotion evidence
      // by definition). undefined under test/ci/no-DB, mirroring the *_OVERRIDE convention.
      provide: PROMOTION_STATS,
      useFactory: (db: NodePgDatabase<typeof schema> | null): PromotionStatsPort | undefined =>
        isTestEnv() || db === null ? undefined : new PromotionStatsRepository(db),
      inject: [DRIZZLE_DB],
    },
    {
      // Realized round-trip evidence + durable trigger seed for ReflectionService — a pure reader
      // over the same PROMOTION_STATS binding (one fills-walk closure rule for the promotion
      // verdict AND the learning loop). DB-only like PROMOTION_STATS itself: undefined under
      // test/ci/no-DB, where reflection degrades to journal proxies and in-memory triggers.
      provide: REFLECTION_EVIDENCE,
      useFactory: (
        stats: PromotionStatsPort | undefined,
        config: TypedConfigService,
      ): RoundTripEvidencePort | undefined =>
        stats === undefined
          ? undefined
          : new RoundTripEvidenceReader(
              stats,
              config.agentic.promotionDustNotional,
              // Same PROMOTION_EVIDENCE_EPOCH parse as mode-control's readinessConfigProvider — the
              // reflection evidence walk must share the gate's fill window or straddle strays
              // freeze it (see RoundTripEvidenceReader's ctor comment).
              config.agentic.promotionEvidenceEpoch === undefined
                ? undefined
                : Date.parse(config.agentic.promotionEvidenceEpoch),
            ),
      inject: [PROMOTION_STATS, TypedConfigService],
    },
  ],
  exports: [
    AGENT_DECISION_JOURNAL,
    PLAYBOOK_PROVIDER_OVERRIDE,
    AGENT_TRADING_PROFILE_OVERRIDE,
    REFLECTION_METRICS_RECORDER_OVERRIDE,
    LLM_USAGE_SINK,
    PROMOTION_STATS,
    REFLECTION_EVIDENCE,
  ],
})
class AgenticCompositionBridgeModule {}

// Trading composition (Strategy→Risk→Execution→Paper). SignalSinkService bridges the gateway to
// the execution gate; the StrategyHost is pointed at it when MarketData drives the host live
// (final integration, runtime — FEED_HEALTH is the no-op default until then).
@Module({
  imports: [
    AppConfigModule,
    DbHealthBridgeModule,
    DrizzlePersistenceGlobalModule,
    PortfolioViewBridgeModule,
    StrategyRegistryBridgeModule,
    AgenticCompositionBridgeModule,
    ObservabilityModule,
    SigningKeyModule,
    KillSwitchModule,
    LimitsCompleteModule,
    KeyProbeModule,
    ArmPreconditionsModule,
    ModeControlModule,
    RiskModule,
    ExecutionModule,
    PaperExchangeModule,
    MarketFeedModule,
    AgenticStrategyModule,
  ],
  // SignalSinkService and HaltCoordinatorService live at the composition root because they bridge
  // Risk and Execution: each injects ports RiskModule exports (SIGNAL_GATEWAY / RISK_ENGINE +
  // POSITION_SIZER) alongside Execution's exports — wiring only the app scope can see. The StrategyHost
  // is composed here too: it binds SIGNAL_SINK to the real SignalSinkService (StrategyModule's no-op is
  // for isolation) and consumes the teeing MARKET_STREAM + shared FEED_HEALTH from MarketFeedModule.
  // TradingRuntimeService fires the whole loop at boot (non-test). A factory builds the host so its
  // optional hrtimeFn ctor param is not a DI dependency. StrategyRegistry itself now lives in
  // StrategyRegistryBridgeModule (global, see its own comment) rather than as a local provider here.
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    SignalSinkService,
    SIGNAL_REJECTIONS_COUNTER,
    HaltCoordinatorService,
    {
      // §S3: ProtectiveExitConfig rides the SAME validated config + DEFAULT_FILTERS the risk lane
      // uses (never a second, independently-tunable copy). cooldownMs is a fixed constant (not yet
      // config-tunable) — a per-symbol re-fire floor, not a safety gate.
      provide: PROTECTIVE_EXIT_CONFIG,
      useFactory: (config: TypedConfigService): ProtectiveExitConfig => ({
        stopLossPct: config.risk.protectStopLossPct,
        trailingPct: config.risk.protectTrailingPct,
        cooldownMs: 30_000,
        filters: DEFAULT_FILTERS,
        planStopWatchEnabled: config.risk.planStopWatchEnabled,
        planStopForceBps: config.risk.planStopForceBps,
      }),
      inject: [TypedConfigService],
    },
    // Push 3 P2: single shared instance — ProtectiveExitService resolves it via this token, and the
    // agentic strategy factory below resolves the SAME instance through the AppModule constructor
    // injection just below (mirrors PROTECTIVE_EXIT_CONFIG's single-source-of-truth convention).
    { provide: PLAN_STOP_REGISTRY, useClass: PlanStopRegistryService },
    ProtectiveExitService,
    PROTECTIVE_EXITS_COUNTER,
    { provide: SIGNAL_SINK, useExisting: SignalSinkService },
    {
      provide: STRATEGY_HOST,
      useFactory: (
        ms: MarketStreamPort,
        fh: FeedHealthPort,
        sink: SignalSinkService,
        reg: StrategyRegistry,
        pv: PortfolioViewPort,
        config: TypedConfigService,
        killSwitch: KillSwitchPort,
      ) => {
        const agentic = config.agentic;
        return new StrategyHost(ms, fh, sink, reg, {
          agentTimeoutMs: agentic.timeoutMs + 2_000, // backstop: client aborts first
          minDecisionIntervalMs: agentic.minDecisionIntervalMs,
          portfolioFor: (id) => pv.forStrategy(id),
          tradingHalted: () => killSwitch.state() !== 'RUNNING',
          constraintsFor: symbolConstraintsFor,
          drainCooldownBaseMs: agentic.drainCooldownBaseMs,
          drainCooldownMaxMs: agentic.drainCooldownMaxMs,
          maxEntriesPerDay: agentic.maxEntriesPerDay,
        });
      },
      inject: [
        MARKET_STREAM,
        FEED_HEALTH,
        SIGNAL_SINK,
        StrategyRegistry,
        PORTFOLIO_VIEW,
        TypedConfigService,
        KILL_SWITCH,
      ],
    },
  ],
})
export class AppModule
  implements NestModule, OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly log = new Logger('TradingRuntime');
  private readonly driverTimers: ReturnType<typeof setInterval>[] = [];
  private tradingSymbols: SymbolId[] = [];
  // Wraps the raw AGENT_CLIENT with G3b metrics telemetry — see MetricsWrappingAgentClient's own
  // comment for why this happens here rather than via a second DI binding under the same token.
  private readonly agentClient: AgentClientPort;
  // The raw (unwrapped) client's own class name, kept for the startup log line below — the wrapper's
  // own constructor.name would otherwise mask which concrete client (stub/budgeted-Anthropic) got
  // selected.
  private readonly agentClientKind: string;
  private readonly promotionEvaluator: PromotionEvaluator;
  // One shared cross-symbol relative-strength context for the whole agentic lane (2026-07-12). Each
  // agentic-N instance records its symbol's trailing return into it and reads the basket ranking.
  private readonly crossSymbolContext = new CrossSymbolContextService();

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly coordinator: HaltCoordinatorService,
    private readonly protectiveExit: ProtectiveExitService,
    // Push 3 P2: the SAME instance ProtectiveExitService resolved via PLAN_STOP_REGISTRY (both bind
    // to the one provider above) — threaded into the agentic strategy factory's deps below.
    @Inject(PLAN_STOP_REGISTRY) private readonly planStopRegistry: PlanStopRegistryPort,
    private readonly resolver: UnknownResolverService,
    private readonly reconciliation: ReconciliationService,
    private readonly sampler: EquitySamplerService,
    private readonly config: TypedConfigService,
    @Inject(STRATEGY_HOST) private readonly host: StrategyHostPort,
    @Inject(STRATEGY_REGISTRY) private readonly registry: StrategyRegistryPort,
    @Inject(PORTFOLIO_VIEW) private readonly portfolio: PortfolioViewPort,
    private readonly modeControl: ModeControlService,
    private readonly fillPoller: DemoFillPollerService,
    private readonly bootRecovery: BootRecoveryService,
    @Inject(AGENT_CLIENT) rawAgentClient: AgentClientPort,
    private readonly agentMetrics: AgentMetricsRecorder,
    @Inject(AGENT_LLM_BUDGET) agentBudget: DailyLlmBudget,
    @Inject(AGENT_DECISION_JOURNAL) private readonly agentJournal: AgentDecisionJournalPort,
    @Inject(PLAYBOOK_PROVIDER) private readonly playbookProvider: PlaybookProvider,
    // C1: always bound (MarketFeedModule's DERIVATIVES_FEED factory returns NOOP_DERIVATIVES_FEED
    // when DERIVATIVES_FEED_ENABLED is off/test-ci) — never @Optional.
    @Inject(DERIVATIVES_FEED) private readonly derivativesFeed: DerivativesFeedPort,
    // C4: always bound (MarketFeedModule's SENTIMENT_FEED factory returns NOOP_SENTIMENT_FEED when
    // SENTIMENT_FEED_ENABLED/key is off/absent/test-ci) — never @Optional, mirrors derivativesFeed.
    @Inject(SENTIMENT_FEED) private readonly sentimentFeed: SentimentFeedPort,
    // Always bound (MarketFeedModule's TRADE_FLOW_FEED factory returns NOOP_TRADE_FLOW_FEED when
    // AGENTIC_TRADEFLOW_ENABLED is off/test-ci) — never @Optional, mirrors derivativesFeed.
    @Inject(TRADE_FLOW_FEED) private readonly tradeFlowFeed: TradeFlowFeedPort,
    // Always bound (MarketFeedModule's POSITIONING_FEED factory returns NOOP_POSITIONING_FEED when
    // AGENTIC_POSITIONING_ENABLED is off/test-ci) — never @Optional, mirrors derivativesFeed.
    @Inject(POSITIONING_FEED) private readonly positioningFeed: PositioningFeedPort,
    // Always bound (MarketFeedModule's LIQUIDATION_FEED factory returns NOOP_LIQUIDATION_FEED when
    // AGENTIC_LIQUIDATIONS_ENABLED is off/test-ci) — never @Optional, mirrors derivativesFeed.
    @Inject(LIQUIDATION_FEED) private readonly liquidationFeed: LiquidationFeedPort,
    @Inject(REFLECTION_SERVICE) private readonly reflectionService: ReflectionService,
    @Inject(PROMOTION_READINESS) private readonly promotionReadiness: PromotionReadinessPort,
    // Backlog #51: the adapter behind EXCHANGE_PORT, for the perp deploy pin in startTrading —
    // only perp-capable adapters implement pinPerpVenueDefaults, everything else no-ops via `?.`.
    @Inject(EXCHANGE_PORT) private readonly exchangePort: ExchangePort,
    // W5 attributed auto-promotion: the evaluator promotes a reflection candidate to ACTIVE on its
    // own A/B-attributed evidence beating the champion (see promotion-evaluator.ts). Built here from
    // the same store the reflection loop writes and the DB-backed stats/journal, and wired as a
    // second onClosedTrade observer alongside reflection below. All deps @Optional: absent under
    // test/ci/no-DB leaves the evaluator inert (createPromotionEvaluator's own inert guard).
    // W4.2 expectancy ladder's realized-evidence feed — @Optional like the token's other consumers:
    // absent under test/ci/no-DB, which leaves the ladder inert regardless of its flag.
    @Optional()
    @Inject(REFLECTION_EVIDENCE)
    private readonly roundTripEvidence?: RoundTripEvidencePort,
    @Optional() @Inject(PROMOTION_STATS) promotionStats?: PromotionStatsPort,
    @Optional() @Inject(PLAYBOOK_PROVIDER_OVERRIDE) playbookStore?: EvaluatorPlaybookStore,
    @Optional() @Inject(KILL_SWITCH) killSwitch?: KillSwitchPort,
    // Push 3 P7c: resting-order role resolution (vtp/vsl), threaded into AgenticStrategyDeps.
    // intentStore below. @Optional like the other DB-backed deps: absent under test/ci/no-DB
    // leaves every role lookup 'unknown' (warn-once, leave-alone — never a blind cancel).
    @Optional() @Inject(EXECUTION_STORE) private readonly executionStore?: ExecutionStorePort,
  ) {
    this.agentClient = new MetricsWrappingAgentClient(
      rawAgentClient,
      this.agentMetrics,
      agentBudget,
      this.config.agentic.model,
    );
    this.agentClientKind = rawAgentClient.constructor.name;
    this.promotionEvaluator = createPromotionEvaluator(agenticEnv(this.config), {
      stats: promotionStats,
      journal: this.agentJournal,
      playbookStore,
      recorder: this.agentMetrics,
      killSwitch,
      registry: this.registry,
      logger: { warn: (m) => this.log.warn(m) },
    });
  }

  // Resolves the active playbook version once at boot and surfaces it to Prometheus
  // (agentic_playbook_info) and the boot log (§G4b activation journaling — which of pin/promotion/
  // seed won) — independent of onApplicationBootstrap's test/ci skip below: this is boot-time
  // observability trivia, not a periodic trading driver, so it runs unconditionally (the in-memory
  // store resolves synchronously; the DB-backed store is never reached under test/ci —
  // AgenticCompositionBridgeModule's own isTestEnv() gate). A resolution failure is logged, never
  // thrown — it must not block boot.
  // Correlation-ALS (P4 residue): every HTTP request (health, metrics, arming) runs inside a
  // correlation scope; the pino mixin (logger.config.ts) stamps the id on each line logged within.
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('{*path}');
  }

  async onModuleInit(): Promise<void> {
    // (E) Surface which agent client bound at boot so live-vs-inert is unambiguous in Grafana and the
    // log, not buried in one startup line. StubAgentClient (no ANTHROPIC_API_KEY, or test/ci) is inert
    // — it proposes nothing, so the demo will never trade until a key is set; anything else is a live
    // deciding client. constructor.name is the only distinguisher (the Anthropic path is wrapped in
    // BudgetedAgentClient, so it is never literally 'AnthropicAgentClient').
    const clientKind = this.agentClientKind === 'StubAgentClient' ? 'stub' : 'anthropic';
    this.agentMetrics.setClientInfo(clientKind);
    if (clientKind === 'stub') {
      this.log.warn(
        'agentic lane INERT: no ANTHROPIC_API_KEY — proposing nothing; demo will not trade until a key is set',
      );
    }

    try {
      // active() (never current()): with a live A/B candidate, current() serves the candidate in
      // routed minute-buckets — a boot landing there would stamp agentic_playbook_info with the
      // INACTIVE candidate's version (observed live 2026-07-11 boot e7d94350, gauge read v2 while
      // active was v1). The gauge and this log line are the "was it promoted?" read — active only.
      const { version, source } = await (this.playbookProvider.active?.() ??
        this.playbookProvider.current());
      this.agentMetrics.setPlaybookInfo(version);
      this.log.log(`active playbook resolved: version=${version} source=${source ?? 'unknown'}`);
    } catch (err) {
      this.log.warn(
        `playbook resolution failed at boot: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // §6/§8 periodic drivers — the runtime FIRING of logic unit-tested in isolation: the halt
  // coordinator and unknown-order resolver tick each second, equity samples every 5s, reconciliation
  // sweeps every 30s. Wired at the composition root (it injects an app-root provider + Execution
  // exports). SKIPPED under test/ci so timers never fire inside the suite — the tick/reconcile/sample
  // logic is verified directly in the unit/paper tests; only the firing was deferred. Each fire is
  // fire-and-forget with its rejection swallowed (the services engage the kill switch on real faults).
  async onApplicationBootstrap(): Promise<void> {
    const env = process.env['NODE_ENV'];
    if (env === 'test' || env === 'ci' || process.env['CI']) return;
    const mode = this.config.mode.configMode;
    // Restore P/L state (cash/equity/peak/sod + open positions) and seed+degrade open orders from
    // Postgres BEFORE any trading or sampling, so equity/drawdown continue across restarts and the
    // first reconcile sees recovered truth. No-op in paper/no-DB (in-memory store returns empty). A
    // corrupt persisted order state throws here — failing the boot loudly rather than trading on it.
    await this.bootRecovery.recoverOnBoot(mode);
    this.driverTimers.push(
      setInterval(() => {
        const now = this.clock.now();
        void Promise.resolve(this.coordinator.tick(now)).catch(() => undefined);
        void Promise.resolve(this.resolver.tick(now)).catch(() => undefined);
      }, 1_000),
      setInterval(() => {
        void Promise.resolve(this.sampler.sample()).catch(() => undefined);
      }, 5_000),
    );
    // §S3 protective backstop: ticks alongside the halt coordinator/resolver, but its rejection is
    // LOGGED (not silently swallowed) — a tick failure here means the bot-side stop-loss/trailing
    // stop is not being enforced, which is worth a warn line even though the tick itself never engages
    // the kill switch on its own faults.
    this.driverTimers.push(
      setInterval(() => {
        void Promise.resolve(this.protectiveExit.tick(this.clock.now())).catch((err: unknown) => {
          this.log.warn(
            `protective-exit tick failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }, 1_000),
    );
    // Reconciliation compares the in-memory portfolio against the venue. In paper the in-memory
    // PaperExchangeAdapter IS the venue, so they match exactly. On the Binance Demo flavor the
    // account is a SHARED multi-asset wallet (not dedicated to the bot), so ReconConfig disables the
    // balances axis there (a BALANCE_DRIFT HALT on holdings the bot never touched would be wrong);
    // order/trade axes run everywhere. A failed pass is logged AND lands in reconciliation_runs_total
    // {result="error"} + the reconciliations row — a silent .catch here once hid a per-pass throw for
    // weeks (reconTs=0, zero rows) while the safety sweep never actually confirmed venue truth.
    if (mode === 'paper' || mode === 'testnet') {
      this.driverTimers.push(
        setInterval(() => {
          void Promise.resolve(this.reconciliation.reconcile()).catch((err: unknown) => {
            this.log.warn(
              `reconcile pass failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }, 30_000),
      );
    }
    void this.startTrading(mode);
  }

  onModuleDestroy(): void {
    for (const timer of this.driverTimers) clearInterval(timer);
    void this.host.stop();
  }

  // The deferred runtime glue that turns the statically-wired Strategy→Risk→Execution→Adapter graph
  // into a running bot. Non-paper modes trade with credentials, so the key MUST be probed first:
  // resolveMode() yields testnetKeysValid from the probe, and without it testnet downgrades to paper
  // (lastProbe undefined) → the gate rejects every order MODE_MISMATCH. Then the strategy is
  // registered + enabled, the host starts (warmup + live consume), and — because the venue fills its
  // own orders with no WS user stream yet — the fill poller sweeps fetchMyTrades. Portfolio is logged
  // on a cadence so a run is observable. The only hard human gate stays paper→live.
  private async startTrading(mode: 'paper' | 'testnet' | 'live'): Promise<void> {
    // Multi-symbol (P7): one agentic strategy instance per configured symbol. Every symbol MUST
    // have a DEFAULT_FILTERS row — the sizer/risk/prompt all read it, and a missing entry would
    // otherwise surface as a per-order NO_REF_PRICE/LIMITS_INCOMPLETE drizzle of rejections
    // instead of one loud boot failure here.
    const symbols = this.config.strategy.symbols;
    const unfiltered = symbols.filter((s) => !DEFAULT_FILTERS.has(s));
    if (unfiltered.length > 0) {
      throw new Error(
        `TRADING_SYMBOLS entries without a DEFAULT_FILTERS row: ${unfiltered.join(', ')} — add venue filters (domain/risk/default-filters.ts) before trading them`,
      );
    }
    this.tradingSymbols = symbols.map((s) => symbolId(s));

    if (mode !== 'paper') {
      await this.refreshKeyProbe();
      // Backlog #51 (Phase-8 perp deploy checklist): pin venue-side isolated margin + leverage
      // BEFORE the first order — account defaults are never trusted. Today's spot deployment
      // no-ops (CcxtExchangeAdapter gates by venue; the paper adapter and the live wrapper lack
      // the method entirely). On the future perp-demo deployment this runs fail-closed: a pin
      // failure throws here and the boot dies — including a FRACTIONAL PERP_LEVERAGE_CAP, passed
      // through UNfloored so the client's integer guard refuses it (silently truncating a cap the
      // sizer still reads as a decimal would diverge venue leverage from sizing math — reviewer
      // S2). NB LiveExchangeAdapter does not delegate the hook — a live perp deployment (far
      // future, own ceremony) must wire that deliberately.
      await this.exchangePort.pinPerpVenueDefaults?.(
        this.tradingSymbols,
        // Decimal round-trip (not Number()): leverage is a multiplier, not money, but the money
        // lint rule is deliberately blanket; toNumber() is exact for any sane integer cap.
        new Decimal(this.config.perp.leverageCap).toNumber(),
      );
      this.driverTimers.push(
        setInterval(() => {
          void this.refreshKeyProbe();
        }, 60_000),
      );
    }
    const resolved = this.modeControl.resolveMode();
    this.log.log(
      `effective mode=${resolved.effective} (requested=${resolved.requested}) downgrades=[${resolved.downgrades.join(',')}]`,
    );

    // Strategy selection. ACTIVE_STRATEGY picks which registered strategy the host runs; the schema
    // constrains it to 'agentic', the only registered lane — an invalid value fails loud at config
    // validation (boot) rather than at registry.enable.
    const active = this.config.strategy.active;
    // onClosedTrade is built per-registered-instance (using the factory's own `id`, not a fixed
    // literal) so a future second agentic registration would each wire the reflection loop's
    // lifecycle check against ITS OWN strategy id (see ReflectionService.runReflection).
    this.registry.register('agentic', (id, p) => {
      const deps: AgenticStrategyDeps = {
        journal: this.agentJournal,
        onClosedTrade: (count) => {
          this.reflectionService.onClosedTrade(id, count);
          // W5: the attributed evaluator observes the same closed-trade seam; inert unless
          // AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES > 0 and the DB-backed deps are bound.
          this.promotionEvaluator.onClosedTrade(id, count);
        },
        onPrescreen: (outcome, reason) => this.agentMetrics.recordPrescreen(outcome, reason),
        onVenueTp: (event) => this.agentMetrics.recordVenueTp(event),
        onVenueStop: (event) => this.agentMetrics.recordVenueStop(event),
        evidence: this.roundTripEvidence,
        derivativesFeed: this.derivativesFeed,
        sentimentFeed: this.sentimentFeed,
        tradeFlowFeed: this.tradeFlowFeed,
        positioningFeed: this.positioningFeed,
        liquidationFeed: this.liquidationFeed,
        // Cross-symbol relative-strength context: ONE service shared across every agentic-N instance
        // (this closure runs once per registration but `deps` is captured by the factory), so each
        // instance records its own symbol's trailing return and reads the whole basket's ranking.
        crossSymbolContext: this.crossSymbolContext,
        // Push 3 P2: the SAME instance ProtectiveExitService reads each 1s tick (PLAN_STOP_REGISTRY,
        // provided once above) — this strategy instance populates it on plan entry-fill/clear.
        planStopRegistry: this.planStopRegistry,
        // Push 3 P7c: resting-order role resolution (vtp/vsl) — see AgenticStrategyDeps.intentStore.
        intentStore: this.executionStore,
        // Push 3 P7d: the swap algo-rail round-trip, narrowed off the SAME EXCHANGE_PORT instance
        // the perp deploy pin (startTrading) already holds — see AgenticStrategyDeps.algoOrders'
        // own comment. Structurally satisfies the narrowed Pick<ExchangePort, ...> even when the
        // bound adapter is spot/paper (both methods stay `undefined` there; every call site guards
        // with `?.`).
        algoOrders: this.exchangePort,
      };
      return new AgenticStrategy(id, p as AgenticStrategyParams, this.agentClient, deps);
    });
    // W5: make an "enabled but silently no-op" expectancy ladder visible at boot. The ladder is
    // reduction-only and inert unless BOTH the flag is on AND a realized-evidence port is wired
    // (agentic.strategy.ts's applyExpectancyLadder no-ops without deps.evidence) — a config that
    // flips the flag on a no-DB boot would otherwise look active while doing nothing.
    if (this.config.agentic.expectancyLadderEnabled) {
      if (this.roundTripEvidence !== undefined) {
        this.log.log('expectancy ladder ACTIVE (flag on, realized-evidence port wired)');
      } else {
        this.log.warn(
          'expectancy ladder flag is ON but no realized-evidence port is wired — ladder is INERT (no-DB/test boot)',
        );
      }
    }
    // SAFETY INTERLOCK (hard, fail-loud at boot). A live-configured agentic boot is refused unless
    // the earned-live promotion gate passes: an explicit permitted PromotionReadiness verdict
    // computed fresh from durable demo evidence (>=30 round trips, positive net-of-cost PnL, >=14d
    // — see PromotionReadinessService). The verdict is evaluated ONLY for a live boot (paper/testnet
    // boots skip the DB query and stay byte-identical); any evaluation error collapses to undefined
    // = fail-closed refusal. Gate on the LITERAL enabled below ('agentic'), NOT on `active` —
    // ACTIVE_STRATEGY only selects among registered types (an unrecognized value fails loud at
    // registry.enable's "unknown strategy type" throw just below); it must never be able to pick its
    // way around this interlock while the enable call still composes the agentic lane. Gate on the
    // STATIC `mode` (= configMode, the boundary that binds the live adapter), NOT
    // resolveMode().effective — which is always 'paper' here pre-arming and so would never fire. See
    // assertAgenticLaneNotLive for the full rationale; a permitted verdict still leaves the four-gate
    // arming ceremony fully in force.
    let readiness: PromotionReadiness | undefined;
    if (mode === 'live') {
      try {
        readiness = await this.promotionReadiness.evaluate();
      } catch (err) {
        this.log.error(`promotion-readiness evaluation failed (fail-closed): ${String(err)}`);
        readiness = undefined;
      }
    }
    assertAgenticLaneNotLive('agentic', mode, readiness);

    // One instance per symbol: agentic-1, agentic-2, … — ids stay stable for a given TRADING_SYMBOLS
    // ordering (positions/journals key off the id, so reordering the CSV re-attributes state; the
    // runbook documents append-only symbol management). Each instance gets its own params (symbol,
    // entry caps run per-strategy in the host) while AGENT_LLM_BUDGET stays ONE shared lane-wide
    // spend cap across all instances.
    symbols.forEach((symbol, i) => {
      this.registry.enable(strategyId(`agentic-${i + 1}`), active, this.agenticParams(symbol));
    });
    const first = this.agenticParams(symbols[0]!);
    this.log.warn(
      `ACTIVE_STRATEGY=agentic — UNVALIDATED, NON-DETERMINISTIC EXPERIMENT (live in-process agent; ` +
        `step-D-uncertifiable, live access is earned). symbols=[${symbols.join(', ')}] ${first.interval} ` +
        `warmupBars=${first.warmupBars} agentClient=${this.agentClientKind}`,
    );

    await this.host.start();
    this.log.log('strategy host started — consuming market data');

    if (mode !== 'paper') {
      this.fillPoller.init();
      this.driverTimers.push(
        setInterval(() => {
          void this.runFillPoll();
        }, 10_000),
      );
    }
    this.driverTimers.push(
      setInterval(() => {
        this.logPortfolio();
      }, 15_000),
    );
  }

  private async refreshKeyProbe(): Promise<void> {
    try {
      await this.modeControl.refreshKeyProbe();
    } catch (err) {
      this.log.warn(`key probe failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async runFillPoll(): Promise<void> {
    try {
      const { ingested, skippedUnknown } = await this.fillPoller.poll(this.tradingSymbols);
      if (ingested > 0 || skippedUnknown > 0)
        this.log.log(`fill poll: ingested=${ingested} skippedUnknown=${skippedUnknown}`);
    } catch (err) {
      this.log.warn(`fill poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private logPortfolio(): void {
    const snap = this.portfolio.snapshot();
    const positions = [...snap.positions.values()].map(
      (p) => `${p.symbol}:${p.signedQty.toFixed()}@${p.avgEntry.toFixed()}`,
    );
    this.log.log(
      `portfolio: equity=${snap.equity.toFixed()} cash=${snap.balances.get('USDT')?.free.toFixed() ?? '?'} ` +
        `positions=[${positions.join(',')}] openOrders=${snap.openOrders.length} inFlight=${snap.inFlightIntents.length}`,
    );
  }

  private agenticParams(symbol: string): AgenticStrategyParams {
    const venue = this.config.venues[0]?.id ?? 'binance';
    const agentic = this.config.agentic;
    const strategy = this.config.strategy;
    return {
      symbol: symbolId(symbol),
      venue: venueId(venue),
      // The schema constrains STRATEGY_INTERVAL to the CandleInterval values; the cast narrows the
      // AppConfig string field back to the domain union.
      interval: strategy.interval as CandleInterval,
      warmupBars: agentic.warmupBars,
      model: agentic.model,
      entryTtlBars: agentic.entryTtlBars,
      prescreenEnabled: agentic.prescreenEnabled,
      prescreenThresholds: {
        volShortBars: agentic.prescreenVolShortBars,
        volLongBars: agentic.prescreenVolLongBars,
        volRatio: agentic.prescreenVolRatio,
        breakoutLookbackBars: agentic.prescreenBreakoutLookbackBars,
        breakoutPct: agentic.prescreenBreakoutPct,
      },
      expectancyLadderEnabled: agentic.expectancyLadderEnabled,
      // Push 3 P6 Unit 4 (#17 residual): off by default ⇒ byte-identical (see agentic.strategy.ts's
      // computeTrackRecordContext).
      trackRecordEnabled: agentic.trackRecordEnabled,
      planMode: agentic.planMode,
      planMaxQuietBars: agentic.planMaxQuietBars,
      planExitTtlBars: agentic.planExitTtlBars,
      quietPayloadSampleBars: agentic.quietPayloadSampleBars,
      crossSymbolEnabled: agentic.crossSymbolEnabled,
      crossSymbolLookbackBars: agentic.crossSymbolLookbackBars,
      venueTpEnabled: agentic.venueTpEnabled,
      venueTpReplaceDriftBps: agentic.venueTpReplaceDriftBps,
      // The venue tick the sizer will round the TP hint to — lets manageVenueTp compare the resting
      // price against the tick-rounded expectation instead of the raw hint (review finding: the
      // [0, tick) rounding bias reads as permanent drift on coarse-tick symbols). Boot asserts every
      // traded symbol has a DEFAULT_FILTERS row, so this is present for all live instances.
      venueTpTickSize: DEFAULT_FILTERS.get(symbol)?.tickSize,
      venueStopEnabled: agentic.venueStopEnabled,
      venueStopReplaceDriftBps: agentic.venueStopReplaceDriftBps,
      // Same DEFAULT_FILTERS tick — mirrors venueTpTickSize above (manageVenueStop's own drift
      // reconciliation, both rails).
      venueStopTickSize: DEFAULT_FILTERS.get(symbol)?.tickSize,
      // The SAME buffer PositionSizerService applies past the trigger for a spot STOP_LOSS_LIMIT's
      // limit leg (SIZER_DEPS.stopLimitBufferBps) — manageVenueStopSpot's drift check must compare
      // against this exact value or it reads the buffer itself as permanent drift.
      stopLimitBufferBps: this.config.risk.stopLimitBufferBps,
      // ProtectiveExitService's OWN force-band threshold (ports/risk.ts's planStopForceBps) — the
      // strategy's bar-close 'stop' branch applies the SAME band on its own coarser cadence (see
      // AgenticStrategyParams.planStopForceBps's own comment on why this is independent of
      // PLAN_STOP_WATCH_ENABLED).
      planStopForceBps: this.config.risk.planStopForceBps,
    };
  }
}
