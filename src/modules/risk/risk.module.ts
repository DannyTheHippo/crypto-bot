import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { CLOCK, SystemClock } from '../../ports/clock';
import type { AppConfig } from '../../ports/app-config';
import type { TradingMode } from '../../domain/types/mode';
// RISK_SIGNING_KEY is NOT self-provided here: §4.2 requires a single process-lifetime key
// shared by exactly two consumers (this RiskEngine + Execution's verify). The composition root
// provides it globally; RiskModule consumes it. Booting RiskModule without that provider fails
// by design — the key has one owner.
//
// KillSwitchService is likewise NOT self-provided: §5 mandates ONE kill switch shared by Risk
// (engage + pre-trade read) and Execution (engage on conflict/unknown/reconcile). The composition
// root binds it globally; RiskEngine/SignalGateway resolve it by class from that single instance.
import { FEED_HEALTH, REAL_FEED_HEALTH, type FeedHealthPort } from '../../ports/market-data';
import {
  RISK_SIGNING_KEY,
  RISK_ENGINE_DEPS,
  SIZER_DEPS,
  RISK_JOURNAL,
  RISK_JOURNAL_OVERRIDE,
  RISK_ENGINE,
  POSITION_SIZER,
  SIGNAL_GATEWAY,
  RISK_LIMITS,
  type RiskEngineDeps,
  type SizerDeps,
  type RiskJournalPort,
} from '../../ports/risk';
import type { PartialRiskLimits } from '../../domain/risk/limits';
import type { SymbolFilters } from '../../domain/risk/evaluate';
import { RateBucketsService } from './rate-buckets.service';
import { CrossingRegistryService } from './crossing-registry.service';
import { PositionSizerService } from './position-sizer.service';
import { RiskEngineService, RISK_REJECTIONS_COUNTER } from './risk-engine.service';
import { SignalGatewayService } from './signal-gateway.service';

// Per-symbol exchange constraints for the paper/demo trading universe (Binance spot filters,
// ccxt 4.5.58). Without a non-empty entry the sizer fast-fails NO_REF_PRICE and the engine rejects
// LIMITS_INCOMPLETE, so every order dies — this map is the venue-capability wiring the composition
// root would otherwise inject. Values are the live Binance PRICE_FILTER/LOT_SIZE/NOTIONAL filters;
// the demo environment mirrors them. Both SIZER_DEPS and RISK_ENGINE_DEPS read this ONE constant so
// the sizer's stepping and the engine's F1 re-validation can never disagree.
const DEFAULT_FILTERS = new Map<string, SymbolFilters>([
  ['BTC/USDT', { tickSize: '0.01', stepSize: '0.00001', minQty: '0.00001', minNotional: '5' }],
  ['ETH/USDT', { tickSize: '0.01', stepSize: '0.0001', minQty: '0.0001', minNotional: '5' }],
]);
const DEFAULT_LIMITS: PartialRiskLimits = {
  maxBandBps: 100,
  maxOrderNotional: '100000',
  maxDriftBps: 100,
  maxPositionPerSymbol: '1000',
  maxGrossExposure: '1000000',
  maxNetExposure: '1000000',
  maxDailyLoss: '5000',
  maxDrawdownPct: '0.2',
  staleMaxAgeMs: 5000,
};
const noopFeedHealth: FeedHealthPort = {
  health: () => 'GAP',
  getRefPrice: () => undefined,
  fetchCandles: () => Promise.resolve([]),
};
const noopJournal: RiskJournalPort = { record: () => undefined };

// §3 mode threading: intent.mode (sizer) and the engine's effectiveMode (G1) must equal the boot
// config authority so the ExecutionGate's per-submission `intent.mode === resolveMode().effective`
// check passes (testnet config + 'paper'-stamped intents = MODE_MISMATCH on every order). ConfigService
// is @Optional: the module-isolation boot specs import RiskModule without AppConfigModule, so they
// fall back to 'paper' (their stub ModeControl also resolves paper). baseNotional is env-tunable so a
// demo run can size below the demo account's quote balance.
function configMode(config: ConfigService<AppConfig, true> | undefined): TradingMode {
  return config?.get('mode', { infer: true }).configMode ?? 'paper';
}
function baseNotionalFor(config: ConfigService<AppConfig, true> | undefined): string {
  void config;
  return process.env['BASE_NOTIONAL'] ?? '1000';
}
const REAL_FEED_HEALTH_OPTIONAL = { token: REAL_FEED_HEALTH, optional: true } as const;
const CONFIG_OPTIONAL = { token: ConfigService, optional: true } as const;

@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    {
      // Prefer the composition root's live FeedHealth (REAL_FEED_HEALTH) when present so the engine's
      // mark/staleness read the running feed; fall back to noop for module-isolation boot tests.
      provide: FEED_HEALTH,
      useFactory: (real?: FeedHealthPort): FeedHealthPort => real ?? noopFeedHealth,
      inject: [REAL_FEED_HEALTH_OPTIONAL],
    },
    { provide: RISK_LIMITS, useValue: DEFAULT_LIMITS },
    {
      // No-op by default; the composition root binds a DB-backed RiskDecisionJournalAdapter via
      // RISK_JOURNAL_OVERRIDE when the persistence path is active (mirrors EXECUTION_STORE_OVERRIDE).
      provide: RISK_JOURNAL,
      useFactory: (override?: RiskJournalPort): RiskJournalPort => override ?? noopJournal,
      inject: [{ token: RISK_JOURNAL_OVERRIDE, optional: true }],
    },
    {
      provide: SIZER_DEPS,
      useFactory: (config?: ConfigService<AppConfig, true>): SizerDeps => ({
        baseNotional: baseNotionalFor(config),
        mode: configMode(config),
        filters: DEFAULT_FILTERS,
        randomBytes,
      }),
      inject: [CONFIG_OPTIONAL],
    },
    {
      provide: RISK_ENGINE_DEPS,
      useFactory: (key: Buffer, config?: ConfigService<AppConfig, true>): RiskEngineDeps => ({
        key,
        limits: DEFAULT_LIMITS,
        limitsVersion: 'v1',
        mode: configMode(config),
        filters: DEFAULT_FILTERS,
        randomBytes,
      }),
      inject: [RISK_SIGNING_KEY, CONFIG_OPTIONAL],
    },
    RateBucketsService,
    CrossingRegistryService,
    PositionSizerService,
    RiskEngineService,
    RISK_REJECTIONS_COUNTER,
    SignalGatewayService,
    { provide: POSITION_SIZER, useExisting: PositionSizerService },
    { provide: RISK_ENGINE, useExisting: RiskEngineService },
    { provide: SIGNAL_GATEWAY, useExisting: SignalGatewayService },
  ],
  // RISK_LIMITS is exported so the composition root can derive ModeControl's gate-(d)
  // LIMITS_COMPLETE from the SAME limits the engine enforces (single source of truth).
  exports: [RISK_ENGINE, POSITION_SIZER, SIGNAL_GATEWAY, RISK_LIMITS],
})
export class RiskModule {}
