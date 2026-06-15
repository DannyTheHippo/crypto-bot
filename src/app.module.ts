import {
  Global,
  Module,
  Inject,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
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
import { EmaCrossStrategy, type EmaCrossParams } from './domain/strategy/ema-cross.strategy';
import type { CandleInterval } from './domain/types/market-events';
import Decimal from 'decimal.js';
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
        const apiKey = isLive ? config.get('liveApiKey', { infer: true }) ?? '' : sandbox.apiKey;
        const secret = isLive ? config.get('liveApiSecret', { infer: true }) ?? '' : sandbox.secret;
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
  fees: { makerBps: '1', takerBps: '10', feeCurrency: 'quote' },
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

// Trading composition (Strategy→Risk→Execution→Paper). SignalSinkService bridges the gateway to
// the execution gate; the StrategyHost is pointed at it when MarketData drives the host live
// (final integration, runtime — FEED_HEALTH is the no-op default until then).
@Module({
  imports: [
    AppConfigModule,
    DbHealthBridgeModule,
    DrizzlePersistenceGlobalModule,
    PortfolioViewBridgeModule,
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
  ],
  // SignalSinkService and HaltCoordinatorService live at the composition root because they bridge
  // Risk and Execution: each injects ports RiskModule exports (SIGNAL_GATEWAY / RISK_ENGINE +
  // POSITION_SIZER) alongside Execution's exports — wiring only the app scope can see. The StrategyHost
  // is composed here too: it binds SIGNAL_SINK to the real SignalSinkService (StrategyModule's no-op is
  // for isolation) and consumes the teeing MARKET_STREAM + shared FEED_HEALTH from MarketFeedModule.
  // TradingRuntimeService fires the whole loop at boot (non-test). A factory builds the host so its
  // optional hrtimeFn ctor param is not a DI dependency.
  providers: [
    SignalSinkService,
    SIGNAL_REJECTIONS_COUNTER,
    HaltCoordinatorService,
    StrategyRegistry,
    { provide: STRATEGY_REGISTRY, useExisting: StrategyRegistry },
    { provide: SIGNAL_SINK, useExisting: SignalSinkService },
    {
      provide: STRATEGY_HOST,
      useFactory: (
        ms: MarketStreamPort,
        fh: FeedHealthPort,
        sink: SignalSinkService,
        reg: StrategyRegistry,
      ) => new StrategyHost(ms, fh, sink, reg),
      inject: [MARKET_STREAM, FEED_HEALTH, SIGNAL_SINK, StrategyRegistry],
    },
  ],
})
export class AppModule implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('TradingRuntime');
  private readonly driverTimers: ReturnType<typeof setInterval>[] = [];
  private tradingSymbols: SymbolId[] = [];

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
  ) {}

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
    const params = this.strategyParams();
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

    this.registry.register('ema-cross', (id, p) => new EmaCrossStrategy(id, p as EmaCrossParams));
    this.registry.enable(strategyId('ema-1'), 'ema-cross', params);
    this.log.log(
      `strategy ema-cross: ${params.symbol} ${params.interval} fast=${params.fast} slow=${params.slow} baseNotional=${process.env['BASE_NOTIONAL'] ?? '1000'}`,
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

  private strategyParams(): EmaCrossParams {
    const venue = this.config.get('venues', { infer: true })[0]?.id ?? 'binance';
    const intEnv = (name: string, def: string): number =>
      new Decimal(process.env[name] ?? def).toNumber();
    return {
      symbol: symbolId(process.env['TRADING_SYMBOL'] ?? 'BTC/USDT'),
      venue: venueId(venue),
      fast: intEnv('EMA_FAST', '9'),
      slow: intEnv('EMA_SLOW', '21'),
      ttlMs: intEnv('SIGNAL_TTL_MS', '120000'),
      interval: (process.env['STRATEGY_INTERVAL'] ?? '1m') as CandleInterval,
    };
  }
}
