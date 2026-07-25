import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppConfigModule } from './config/config.module';
import { PersistenceModule } from './database/database.module';
import { ObservabilityModule } from './features/common/observability/observability.module';
import { GlobalExceptionFilter } from './shared/filters/global-exception.filter';
import { CorrelationMiddleware } from './shared/correlation/correlation.middleware';
import { RiskModule } from './features/trading/risk/risk.module';
import { ExecutionModule } from './features/trading/execution/execution.module';
import { ModeControlModule } from './features/trading/mode-control/mode-control.module';
import { AgenticStrategyModule } from './features/strategy/agentic/agentic-strategy.module';
import { DbHealthBridgeModule } from './features/trading/composition/db-health-bridge.module';
import { PersistenceOverridesModule } from './features/trading/composition/persistence-overrides.module';
import { PortfolioViewBridgeModule } from './features/trading/composition/portfolio-view-bridge.module';
import { StrategyRegistryBridgeModule } from './features/trading/composition/strategy-registry-bridge.module';
import { SigningKeyModule } from './features/trading/composition/signing-key.module';
import { KillSwitchModule } from './features/trading/composition/kill-switch.module';
import { OpsEventsModule } from './features/trading/composition/ops-events.module';
import { LimitsCompleteModule } from './features/trading/composition/limits-complete.module';
import { VenueRegistryModule } from './features/trading/composition/venue-registry.module';
import { KeyProbeModule } from './features/trading/composition/key-probe.module';
import { ArmPreconditionsModule } from './features/trading/composition/arm-preconditions.module';
import { ExchangeAdaptersModule } from './features/trading/composition/exchange-adapters.module';
import { MarketStreamsModule } from './features/trading/composition/market-streams.module';
import { ContextFeedsModule } from './features/trading/composition/context-feeds.module';
import { AgenticBridgeModule } from './features/trading/composition/agentic-bridge.module';
import { TradingRuntimeModule } from './features/trading/composition/trading-runtime.module';

// v3 spec §1.3: thin composition root. Every provider that used to live inline here — six @Global
// modules, the root provider block (SignalSinkService…STRATEGY_HOST), and the AppModule class body
// (lifecycle hooks, driver timers, startTrading) — the original 2,427-line file — now lives in its
// own composition-module file under features/trading/composition/**: VenueRegistryModule/
// ExchangeAdaptersModule/MarketStreamsModule/ContextFeedsModule/KeyProbeModule/
// ArmPreconditionsModule/AgenticBridgeModule/TradingRuntimeModule (new for v3, replacing
// PaperExchangeModule/MarketFeedModule/AgenticCompositionBridgeModule/the root provider block +
// class body) alongside the six W3 Part 4 bridge modules that landed earlier (db-health/
// portfolio-view/strategy-registry bridges, signing-key, kill-switch, limits-complete). This file's
// only remaining job is the import list, the global exception filter, and the correlation-id
// middleware — no providers of its own besides APP_FILTER.
@Module({
  imports: [
    AppConfigModule,
    PersistenceModule,
    ObservabilityModule,
    DbHealthBridgeModule,
    PersistenceOverridesModule,
    PortfolioViewBridgeModule,
    StrategyRegistryBridgeModule,
    SigningKeyModule,
    KillSwitchModule,
    OpsEventsModule,
    LimitsCompleteModule,
    VenueRegistryModule,
    KeyProbeModule,
    ArmPreconditionsModule,
    ExchangeAdaptersModule,
    MarketStreamsModule,
    ContextFeedsModule,
    AgenticBridgeModule,
    RiskModule,
    ExecutionModule,
    ModeControlModule,
    AgenticStrategyModule,
    TradingRuntimeModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: GlobalExceptionFilter }],
})
export class AppModule implements NestModule {
  // Correlation-ALS (P4 residue): every HTTP request (health, metrics, arming) runs inside a
  // correlation scope; the pino mixin (logger.config.ts) stamps the id on each line logged within.
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('{*path}');
  }
}
