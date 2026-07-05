import {
  Global,
  Module,
  Inject,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import type { Exchange } from 'ccxt';
import { AppConfigModule } from './modules/config/config.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { PersistenceModule } from './modules/persistence/persistence.module';
import { DbHealthIndicator } from './modules/persistence/db-health.indicator';
import { DrizzleExecutionStore } from './modules/persistence/repositories/drizzle-execution-store';
import { DrizzleExecOutbox } from './modules/persistence/repositories/drizzle-exec-outbox';
import { PgAdvisoryInstanceLock } from './modules/persistence/repositories/pg-advisory-instance-lock';
import { DrizzleModeAudit } from './modules/persistence/repositories/drizzle-mode-audit';
import { RiskDecisionJournalAdapter } from './modules/persistence/repositories/risk-decision-journal.adapter';
import { SignalJournalAdapter } from './modules/persistence/repositories/signal-journal.adapter';
import { DATABASE_POOL, DRIZZLE_DB } from './modules/persistence/persistence.tokens';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import type * as schema from './modules/persistence/schema';
import { DB_HEALTH } from './ports/db-health';
import { RiskModule } from './modules/risk/risk.module';
import { KillSwitchService } from './modules/risk/kill-switch.service';
import { ExecutionModule } from './modules/execution/execution.module';
import {
  SignalSinkService,
  SIGNAL_REJECTIONS_COUNTER,
} from './modules/execution/signal-sink.service';
import { HaltCoordinatorService } from './modules/execution/halt-coordinator.service';
import { UnknownResolverService } from './modules/execution/unknown-resolver.service';
import { ReconciliationService } from './modules/execution/reconciliation.service';
import { EquitySamplerService } from './modules/execution/equity-sampler.service';
import { PortfolioStateService } from './modules/execution/portfolio-state.service';
import { BootRecoveryService } from './modules/execution/boot-recovery.service';
import {
  PaperExchangeAdapter,
  PAPER_CONFIG,
  type PaperConfig,
} from './modules/exchange-adapter/paper-exchange.adapter';
import { LiveExchangeAdapter } from './modules/exchange-adapter/live-exchange.adapter';
import { CcxtExchangeAdapter } from './modules/exchange-adapter/ccxt-exchange.adapter';
import { RealCcxtOrderClient } from './modules/exchange-adapter/ccxt-order-client';
import { KeyProbeService } from './modules/exchange-adapter/key-probe.service';
import {
  buildCcxtExchange,
  CcxtExchangeStreamAdapter,
  RealWatchSource,
  WATCH_SOURCE,
  type ChannelStateTracker,
  type WatchSource,
} from './modules/market-data/ccxt-stream.adapter';
import {
  FeedHealthServiceWithBackfill,
  type OhlcvSource,
} from './modules/market-data/feed-health.service';
import { MarketDataService } from './modules/market-data/market-data.service';
import { StrategyRegistry } from './modules/strategy/strategy-registry';
import { StrategyHost } from './modules/strategy/strategy-host';
import {
  TeeingMarketStream,
  type RefPriceSink,
  type PaperFeedSink,
} from './modules/trading/teeing-market-stream';
import { DemoFillPollerService } from './modules/execution/demo-fill-poller.service';
import { ModeControlService } from './modules/mode-control/mode-control.service';
import {
  AgenticStrategyModule,
  AGENT_LLM_BUDGET,
  PLAYBOOK_PROVIDER_OVERRIDE,
  AGENT_TRADING_PROFILE_OVERRIDE,
  REFLECTION_SERVICE,
  REFLECTION_METRICS_RECORDER_OVERRIDE,
  SEED_PLAYBOOK,
} from './modules/agentic-strategy/agentic-strategy.module';
import type { DailyLlmBudget } from './modules/agentic-strategy/agent-budget';
import { ReflectionService } from './modules/agentic-strategy/reflection.service';
import {
  AgenticStrategy,
  type AgenticStrategyParams,
  type AgenticStrategyDeps,
} from './modules/agentic-strategy/agentic.strategy';
import { assertAgenticLaneNotLive } from './modules/agentic-strategy/agentic-live-interlock';
import { validatePlaybook } from './modules/agentic-strategy/playbook-validator';
import {
  AGENT_CLIENT,
  AGENT_DECISION_JOURNAL,
  PLAYBOOK_PROVIDER,
  AgentProposeError,
  type AgentClientPort,
  type AgentDecisionInput,
  type AgentDecisionJournalPort,
  type AgentProposal,
  type AgentTradingProfile,
  type PlaybookProvider,
  type SymbolConstraints,
} from './ports/agentic-strategy';
import {
  AgentMetricsRecorder,
  type AgentDecideOutcome,
} from './modules/observability/agent-metrics-recorder.service';
import { AgentDecisionJournalAdapter } from './modules/persistence/repositories/agent-decision-journal.adapter';
import { InMemoryAgentDecisionJournal } from './modules/persistence/repositories/in-memory-agent-decision-journal';
import {
  PlaybookStoreAdapter,
  type PlaybookVersionEntry,
} from './modules/persistence/repositories/playbook-store.adapter';
import { InMemoryPlaybookStore } from './modules/persistence/repositories/in-memory-playbook-store';
import { price, qty } from './domain/types/money';
import type { SymbolFilters } from './domain/risk/evaluate';
import { DEFAULT_FILTERS } from './domain/risk/default-filters';
import type { CandleInterval } from './domain/types/market-events';
import type { VenueConfig, VenueEnvironment } from './ports/app-config';
import { ModeControlModule } from './modules/mode-control/mode-control.module';
import {
  LIVE_ADAPTER_CAP,
  LIMITS_COMPLETE,
  KEY_PROBE,
  MODE_AUDIT_OVERRIDE,
  type KeyProbePort,
  type ModeAuditPort,
} from './ports/mode-control';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from './ports/app-config';
import { CLOCK, SystemClock, type ClockPort } from './ports/clock';
import {
  RISK_SIGNING_KEY,
  KILL_SWITCH,
  RISK_LIMITS,
  RISK_JOURNAL_OVERRIDE,
  type RiskJournalPort,
  type KillSwitchPort,
} from './ports/risk';
import { validateLimits, type PartialRiskLimits } from './domain/risk/limits';
import { EXCHANGE_PORT, type ExchangePort } from './ports/exchange';
import {
  EXEC_OUTBOX,
  EXEC_REPORT_NOTIFY,
  PORTFOLIO_VIEW,
  EXEC_OUTBOX_OVERRIDE,
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
function dbRunContext(config: ConfigService<AppConfig, true>): ExecRunContext {
  const bootId = config.get('app', { infer: true }).bootId;
  return { mode: config.get('mode', { infer: true }).configMode, runId: `run-${bootId}`, bootId };
}
@Global()
@Module({
  imports: [PersistenceModule],
  providers: [
    {
      provide: EXEC_OUTBOX_OVERRIDE,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: ConfigService<AppConfig, true>,
      ): ExecOutboxPort | undefined =>
        isTestEnv() || db === null ? undefined : new DrizzleExecOutbox(db, dbRunContext(config)),
      inject: [DRIZZLE_DB, ConfigService],
    },
    {
      provide: EXECUTION_STORE_OVERRIDE,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: ConfigService<AppConfig, true>,
      ): ExecutionStorePort | undefined =>
        isTestEnv() || db === null
          ? undefined
          : new DrizzleExecutionStore(db, dbRunContext(config)),
      inject: [DRIZZLE_DB, ConfigService],
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
        config: ConfigService<AppConfig, true>,
      ): ModeAuditPort | undefined =>
        isTestEnv() || db === null
          ? undefined
          : new DrizzleModeAudit(db, config.get('app', { infer: true }).bootId),
      inject: [DRIZZLE_DB, ConfigService],
    },
    {
      // DB-backed RISK_JOURNAL: persists every risk verdict to risk_decisions for offline analysis.
      provide: RISK_JOURNAL_OVERRIDE,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: ConfigService<AppConfig, true>,
      ): RiskJournalPort | undefined =>
        isTestEnv() || db === null
          ? undefined
          : new RiskDecisionJournalAdapter(db, dbRunContext(config)),
      inject: [DRIZZLE_DB, ConfigService],
    },
    {
      // DB-backed SIGNAL_JOURNAL: persists every routed signal + its outcome to the signals table.
      // SignalSink injects this @Optional, so undefined (paper/no-DB/test) simply skips journaling.
      provide: SIGNAL_JOURNAL,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: ConfigService<AppConfig, true>,
      ): SignalJournalPort | undefined =>
        isTestEnv() || db === null ? undefined : new SignalJournalAdapter(db, dbRunContext(config)),
      inject: [DRIZZLE_DB, ConfigService],
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
      useFactory: (config: ConfigService<AppConfig, true>): KeyProbePort => {
        const mode = config.get('mode', { infer: true }).configMode;
        if (mode === 'paper') return INVALID_KEY_PROBE;
        const isLive = mode === 'live';
        // Live keys from AppConfig (stripped under test/ci); sandbox keys + environment (testnet|demo)
        // from SANDBOX_ENV via resolveSandbox — keeping demo/testnet keys non-interchangeable.
        const sandbox = resolveSandbox(config);
        const apiKey = isLive ? (config.get('liveApiKey', { infer: true }) ?? '') : sandbox.apiKey;
        const secret = isLive
          ? (config.get('liveApiSecret', { infer: true }) ?? '')
          : sandbox.secret;
        const client = buildOrderClient(
          primaryVenue(config),
          isLive ? 'live' : sandbox.environment,
          apiKey,
          secret,
        );
        const keyFingerprint = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
        return new KeyProbeService(client, { keyFingerprint, requireRestrictions: isLive });
      },
      inject: [ConfigService],
    },
  ],
  exports: [KEY_PROBE],
})
class KeyProbeModule {}

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
  exchange.apiKey = apiKey;
  exchange.secret = secret;
  return new RealCcxtOrderClient(exchange);
}

// The non-paper venue is configurable (VENUES env): the CcxtExchangeAdapter is venue-agnostic, so
// the venue is selected purely by config — first configured venue, default binance.
function primaryVenue(config: ConfigService<AppConfig, true>): string {
  return config.get('venues', { infer: true })[0]?.id ?? 'binance';
}

// §3.5: in testnet mode the sandbox FLAVOR (SANDBOX_ENV) picks the environment and its own
// non-interchangeable keys — 'demo' (enableDemoTrading; live-mirroring data, real-account keys, the
// pre-live dress rehearsal) or 'testnet' (setSandboxMode; the purpose-built integration sandbox).
// Keys come straight from process.env (BINANCE_DEMO_*/BINANCE_TESTNET_*), never AppConfig, so they
// are never hashed or logged. Reached only on a non-paper boot — under test/ci configMode is paper.
function resolveSandbox(config: ConfigService<AppConfig, true>): {
  environment: VenueEnvironment;
  apiKey: string;
  secret: string;
} {
  if (config.get('mode', { infer: true }).sandboxEnv === 'demo') {
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
        config: ConfigService<AppConfig, true>,
      ): ExchangePort => {
        const mode = config.get('mode', { infer: true }).configMode;
        const venue = primaryVenue(config); // binance, configured via VENUES
        if (mode === 'live') {
          // Live: real ccxt client behind the capability-token-guarded wrapper. liveApiKey/Secret are
          // present on AppConfig only outside test/ci (the schema strips them otherwise).
          const client = buildOrderClient(
            venue,
            'live',
            config.get('liveApiKey', { infer: true }) ?? '',
            config.get('liveApiSecret', { infer: true }) ?? '',
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
      inject: [CLOCK, EXEC_OUTBOX, EXEC_REPORT_NOTIFY, PAPER_CONFIG, ConfigService],
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
function isTestEnv(): boolean {
  return (
    process.env['NODE_ENV'] === 'test' ||
    process.env['NODE_ENV'] === 'ci' ||
    Boolean(process.env['CI'])
  );
}
function feedVenueConfig(config: ConfigService<AppConfig, true>): VenueConfig {
  const id = config.get('venues', { infer: true })[0]?.id ?? 'binance';
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
      useFactory: (config: ConfigService<AppConfig, true>): Exchange | undefined =>
        isTestEnv() ? undefined : buildCcxtExchange(feedVenueConfig(config)), // public — no apiKey/secret
      inject: [ConfigService],
    },
    {
      provide: REAL_FEED_HEALTH,
      useFactory: (
        clock: ClockPort,
        config: ConfigService<AppConfig, true>,
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
      inject: [CLOCK, ConfigService, MD_EXCHANGE],
    },
    {
      provide: EXCHANGE_STREAM,
      useFactory: (
        clock: ClockPort,
        watchSource: WatchSource,
        feedHealth: FeedHealthPort,
        config: ConfigService<AppConfig, true>,
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
      inject: [CLOCK, WATCH_SOURCE, REAL_FEED_HEALTH, ConfigService, MD_EXCHANGE],
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
  ],
  exports: [MARKET_STREAM, FEED_HEALTH, REAL_FEED_HEALTH, EXCHANGE_STREAM],
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

// Composition-root tripwire wrapping the resolved playbook store's READ side only: the playbook is
// untrusted, previously-model-authored content (see playbook-validator.ts's header comment).
// AnthropicAgentClient re-validates on every call regardless (defense in depth); this wrapper
// additionally surfaces a rejection to Prometheus (recordValidatorRejection) and guarantees the LLM
// always receives SOME playbook (SEED_PLAYBOOK) rather than the client's own tripwire, which silently
// composes no playbook at all. append/listVersions pass through unvalidated — validation only gates
// what reaches the LLM prompt, never the store's write side (reflection/promotion write raw content).
class ValidatingPlaybookProvider implements PlaybookStorePort {
  constructor(
    private readonly inner: PlaybookStorePort,
    private readonly recorder: AgentMetricsRecorder,
  ) {}

  async current(): Promise<{
    version: number;
    content: string;
    source?: 'pin' | 'promotion' | 'seed';
  }> {
    const stored = await this.inner.current();
    const validation = validatePlaybook(stored.content);
    if (!validation.ok) {
      this.recorder.recordValidatorRejection(validation.bannedTokenHit ?? false);
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
// DEFAULT_LIMITS, exported for exactly this single-source-of-truth read — see LimitsCompleteModule
// above); baseNotional mirrors risk.module.ts's (unexported) baseNotionalFor — same BASE_NOTIONAL env
// var, same '1000' default; maker/takerBps mirror DEFAULT_PAPER_CONFIG.fees below (§1.5) — the actual
// fee schedule the paper adapter charges, not the retired pure-lane prompt's hardcoded ~20bps taker
// guess (no such shared constant exists elsewhere in the codebase).
function agentTradingProfileFor(symbol: string, limits: PartialRiskLimits): AgentTradingProfile {
  return {
    makerBps: DEFAULT_PAPER_CONFIG.fees.makerBps,
    takerBps: DEFAULT_PAPER_CONFIG.fees.takerBps,
    baseNotional: process.env['BASE_NOTIONAL'] ?? '1000',
    maxOrderNotional: limits.maxOrderNotional ?? '100000',
    constraints: symbolConstraintsFor(symbol) ?? {
      tickSize: price('0.01'),
      lotStep: qty('0.0001'),
      minNotional: price('10'),
    },
  };
}

// Composition-root decorator recording agentic-lane decide() telemetry (G3b's AgentMetricsRecorder)
// around whichever AgentClientPort AgenticStrategyModule resolved (stub / budgeted-Anthropic) — kept
// OUTSIDE that module so it can depend on ObservabilityModule (the boundary wall runs the other way).
// Wrapped in AppModule's constructor body rather than re-provided under the AGENT_CLIENT token: Nest
// has no way to inject "the imported AGENT_CLIENT specifically" from a scope that ALSO re-provides
// that exact token locally (the local provider would shadow — and thus self-reference — the import
// it's trying to wrap), so this wraps at the point of consumption instead of via a second DI binding.
class MetricsWrappingAgentClient implements AgentClientPort {
  constructor(
    private readonly inner: AgentClientPort,
    private readonly recorder: AgentMetricsRecorder,
    private readonly budget: DailyLlmBudget,
  ) {}

  async propose(input: AgentDecisionInput): Promise<AgentProposal> {
    const started = Date.now();
    try {
      const proposal = await this.inner.propose(input);
      this.recorder.observeDecideLatency((Date.now() - started) / 1000);
      if (proposal.usage) {
        this.recorder.recordTokens(proposal.usage.inputTokens, proposal.usage.outputTokens);
      }
      this.recorder.recordDecide(this.outcomeForProposal(proposal));
      return proposal;
    } catch (err) {
      this.recorder.observeDecideLatency((Date.now() - started) / 1000);
      this.recorder.recordDecide(this.outcomeForError(err));
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
    return proposal.decision.action === 'hold' ? 'hold' : 'proposed';
  }
}

// §7 (agentic lane), same test/ci-forces-in-memory backstop as DrizzlePersistenceGlobalModule above,
// scoped to the agentic decision journal + playbook store + trading profile rather than
// execution/mode-control — kept as its own bridge (not folded into DrizzlePersistenceGlobalModule)
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
      // Bound under its own token (not directly to PLAYBOOK_PROVIDER, which AgenticStrategyModule owns)
      // so the write side (append/listVersions) stays reachable for reflection/promotion (G4a/G4b)
      // alongside the validated read side AgenticStrategyModule's PLAYBOOK_PROVIDER factory consumes
      // via PLAYBOOK_PROVIDER_OVERRIDE (see that token's own comment).
      provide: PLAYBOOK_PROVIDER_OVERRIDE,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: ConfigService<AppConfig, true>,
        recorder: AgentMetricsRecorder,
      ): PlaybookStorePort => {
        const pin = config.get('agentic', { infer: true }).playbookPin;
        const store =
          isTestEnv() || db === null
            ? new InMemoryPlaybookStore(SEED_PLAYBOOK, pin)
            : new PlaybookStoreAdapter(db, SEED_PLAYBOOK, pin);
        return new ValidatingPlaybookProvider(store, recorder);
      },
      inject: [DRIZZLE_DB, ConfigService, AgentMetricsRecorder],
    },
    {
      provide: AGENT_TRADING_PROFILE_OVERRIDE,
      useFactory: (limits: PartialRiskLimits): AgentTradingProfile =>
        agentTradingProfileFor(process.env['TRADING_SYMBOL'] ?? 'BTC/USDT', limits),
      inject: [RISK_LIMITS],
    },
    // G4a: lets ReflectionService (modules/agentic-strategy, which cannot import modules/observability
    // — the boundary wall) record validator-rejection tripwires through its own LOCAL structural type
    // rather than the concrete class. Same useExisting pattern the DB_HEALTH/PORTFOLIO_VIEW bridges use.
    { provide: REFLECTION_METRICS_RECORDER_OVERRIDE, useExisting: AgentMetricsRecorder },
  ],
  exports: [
    AGENT_DECISION_JOURNAL,
    PLAYBOOK_PROVIDER_OVERRIDE,
    AGENT_TRADING_PROFILE_OVERRIDE,
    REFLECTION_METRICS_RECORDER_OVERRIDE,
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
    SignalSinkService,
    SIGNAL_REJECTIONS_COUNTER,
    HaltCoordinatorService,
    { provide: SIGNAL_SINK, useExisting: SignalSinkService },
    {
      provide: STRATEGY_HOST,
      useFactory: (
        ms: MarketStreamPort,
        fh: FeedHealthPort,
        sink: SignalSinkService,
        reg: StrategyRegistry,
        pv: PortfolioViewPort,
        config: ConfigService<AppConfig, true>,
        killSwitch: KillSwitchPort,
      ) => {
        const agentic = config.get('agentic', { infer: true });
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
        ConfigService,
        KILL_SWITCH,
      ],
    },
  ],
})
export class AppModule implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
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

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly coordinator: HaltCoordinatorService,
    private readonly resolver: UnknownResolverService,
    private readonly reconciliation: ReconciliationService,
    private readonly sampler: EquitySamplerService,
    private readonly config: ConfigService<AppConfig, true>,
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
    @Inject(REFLECTION_SERVICE) private readonly reflectionService: ReflectionService,
  ) {
    this.agentClient = new MetricsWrappingAgentClient(
      rawAgentClient,
      this.agentMetrics,
      agentBudget,
    );
    this.agentClientKind = rawAgentClient.constructor.name;
  }

  // Resolves the active playbook version once at boot and surfaces it to Prometheus
  // (agentic_playbook_info) and the boot log (§G4b activation journaling — which of pin/promotion/
  // seed won) — independent of onApplicationBootstrap's test/ci skip below: this is boot-time
  // observability trivia, not a periodic trading driver, so it runs unconditionally (the in-memory
  // store resolves synchronously; the DB-backed store is never reached under test/ci —
  // AgenticCompositionBridgeModule's own isTestEnv() gate). A resolution failure is logged, never
  // thrown — it must not block boot.
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
      const { version, source } = await this.playbookProvider.current();
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
    const mode = this.config.get('mode', { infer: true }).configMode;
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
    // Reconciliation compares the in-memory portfolio against the venue. In paper the in-memory
    // PaperExchangeAdapter IS the venue, so they match exactly. The demo/testnet account is DEDICATED
    // to the bot, so the holdings/balances axis is meaningful there too — run it and HALT on drift
    // (never auto-flatten). Caveat: FeeLedgerService (third-asset fees, e.g. BNB) is not persisted and
    // resets on restart, so the balances axis could HALT on BNB drift after a restart — pay demo fees
    // in quote/base, or tolerate BNB; this does not affect quote-denominated P/L. The trades axis is
    // inert on Binance (clientOrderId-less myTrades). Reconciliation logic itself is untouched.
    if (mode === 'paper' || mode === 'testnet') {
      this.driverTimers.push(
        setInterval(() => {
          void Promise.resolve(this.reconciliation.reconcile()).catch(() => undefined);
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
    const params = this.agenticParams();
    this.tradingSymbols = [params.symbol];

    if (mode !== 'paper') {
      await this.refreshKeyProbe();
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

    // Strategy selection. ACTIVE_STRATEGY picks which registered strategy the host runs; it DEFAULTS to
    // 'agentic', the only registered lane. An unrecognized value fails loud at registry.enable
    // (unknown strategy type) rather than silently falling back.
    const active = process.env['ACTIVE_STRATEGY'] ?? 'agentic';
    // onClosedTrade is built per-registered-instance (using the factory's own `id`, not a fixed
    // literal) so a future second agentic registration would each wire the reflection loop's
    // lifecycle check against ITS OWN strategy id (see ReflectionService.runReflection).
    this.registry.register('agentic', (id, p) => {
      const deps: AgenticStrategyDeps = {
        journal: this.agentJournal,
        onClosedTrade: (count) => this.reflectionService.onClosedTrade(id, count),
      };
      return new AgenticStrategy(id, p as AgenticStrategyParams, this.agentClient, deps);
    });
    // SAFETY INTERLOCK (hard, fail-loud at boot). The agentic lane is permanently EXPERIMENT-ONLY and
    // must NEVER run in a live-configured process. Gate on the LITERAL enabled below ('agentic'), NOT
    // on `active` — ACTIVE_STRATEGY only selects among registered types (an unrecognized value fails
    // loud at registry.enable's "unknown strategy type" throw just below); it must never be able to
    // pick its way around this interlock while the enable call still composes the agentic lane. Gate
    // on the STATIC `mode` (= configMode, the boundary that binds the live adapter), NOT
    // resolveMode().effective — which is always 'paper' here pre-arming and so would never fire. See
    // assertAgenticLaneNotLive for the full rationale.
    assertAgenticLaneNotLive('agentic', mode);

    this.registry.enable(strategyId('agentic-1'), active, params);
    this.log.warn(
      `ACTIVE_STRATEGY=agentic — UNVALIDATED, NON-DETERMINISTIC EXPERIMENT (live in-process agent; ` +
        `step-D-uncertifiable, never promote to live). ${params.symbol} ${params.interval} ` +
        `warmupBars=${params.warmupBars} agentClient=${this.agentClientKind}`,
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

  private agenticParams(): AgenticStrategyParams {
    const venue = this.config.get('venues', { infer: true })[0]?.id ?? 'binance';
    const agentic = this.config.get('agentic', { infer: true });
    return {
      symbol: symbolId(process.env['TRADING_SYMBOL'] ?? 'BTC/USDT'),
      venue: venueId(venue),
      interval: (process.env['STRATEGY_INTERVAL'] ?? '1m') as CandleInterval,
      warmupBars: agentic.warmupBars,
      model: agentic.model,
    };
  }
}
