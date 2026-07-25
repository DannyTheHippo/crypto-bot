import { Module } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import type { TradingMode } from '../../../domain/trading/types/mode';
import { CLOCK, SystemClock } from '../../../ports/common/clock';
// RISK_SIGNING_KEY is NOT self-provided here: §4.2 requires a single process-lifetime key
// shared by exactly two consumers (this RiskEngine + Execution's verify). The composition root
// provides it globally; RiskModule consumes it. Booting RiskModule without that provider fails
// by design — the key has one owner.
//
// KillSwitchService is likewise NOT self-provided: §5 mandates ONE kill switch shared by Risk
// (engage + pre-trade read) and Execution (engage on conflict/unknown/reconcile). The composition
// root binds it globally; RiskEngine/SignalGateway resolve it by class from that single instance.
import { DEFAULT_FILTERS } from '../../../domain/trading/risk/default-filters';
import type { PartialRiskLimits } from '../../../domain/trading/risk/limits';
import { venueId, type VenueId } from '../../../domain/common/types/ids';
import { PERP_VENUE_ID, SPOT_VENUE_ID } from '../../../domain/venue/types/venue-map';
import {
  FEED_HEALTH,
  REAL_FEED_HEALTH,
  type FeedHealthPort,
} from '../../../ports/venue/market-data';
import {
  POSITION_SIZER,
  RISK_ENGINE,
  RISK_ENGINE_DEPS,
  RISK_JOURNAL,
  RISK_JOURNAL_OVERRIDE,
  RISK_LIMITS,
  RISK_SIGNING_KEY,
  SIGNAL_GATEWAY,
  SIZER_DEPS,
  type RiskEngineDeps,
  type RiskJournalPort,
  type SizerDeps,
} from '../../../ports/trading/risk';
import { CrossingRegistryService } from './crossing-registry.service';
import { PLANNED_STOP_SIZING_COUNTER, PositionSizerService } from './position-sizer.service';
import { RateBucketsService } from './rate-buckets.service';
import { RISK_REJECTIONS_COUNTER, RiskEngineService } from './risk-engine.service';
import { SignalGatewayService } from './signal-gateway.service';

const DEFAULT_LIMITS: PartialRiskLimits = {
  maxBandBps: 100,
  maxPassiveExitBandBps: 1200,
  maxStopTriggerBandBps: 2000,
  stopLimitBufferBps: 50,
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
  updateRefPrice: () => undefined,
  fetchCandles: () => Promise.resolve([]),
};
const noopJournal: RiskJournalPort = { record: () => undefined };

// §3 mode threading: intent.mode (sizer) and the engine's effectiveMode (G1) must equal the boot
// config authority so the ExecutionGate's per-submission `intent.mode === resolveMode().effective`
// check passes (testnet config + 'paper'-stamped intents = MODE_MISMATCH on every order).
// TypedConfigService is @Optional: the module-isolation boot specs import RiskModule without
// AppConfigModule, so they fall back to 'paper' (their stub ModeControl also resolves paper).
// baseNotional is config-tunable so a demo run can size below the demo account's quote balance.
function configMode(config: TypedConfigService | undefined): TradingMode {
  return config?.mode.configMode ?? 'paper';
}
// Falls back to the schema's own default ('100') so module-isolation unit boots (RiskModule imported
// without AppConfigModule) still size orders the same as a real, unconfigured deployment.
function baseNotionalFor(config: TypedConfigService | undefined): string {
  return config?.risk.baseNotional ?? '100';
}
// §exit-liquidity: falls back to the schema's own default (25) so module-isolation unit boots
// (RiskModule imported without AppConfigModule) still size a marketable exit correctly.
function exitCrossBufferBpsFor(config: TypedConfigService | undefined): number {
  return config?.risk.exitCrossBufferBps ?? 25;
}
// P5 compounding sizing: falls back to the schema's own default ('0', disabled) so module-isolation
// unit boots (RiskModule imported without AppConfigModule) still size orders the same as a real,
// unconfigured deployment (legacy baseNotional × strength path).
function equityFractionFor(config: TypedConfigService | undefined): string {
  return config?.risk.equityFraction ?? '0';
}
// Falls back to the schema's own default ('LIMIT', disabled) so module-isolation unit boots
// (RiskModule imported without AppConfigModule) still size entries the same as a real,
// unconfigured deployment.
function entryOrderTypeFor(config: TypedConfigService | undefined): 'LIMIT' | 'LIMIT_MAKER' {
  return config?.risk.entryOrderType ?? 'LIMIT';
}
// P7b: falls back to the schema's own default (50) so module-isolation unit boots (RiskModule
// imported without AppConfigModule) still build a RESTING_STOP spot limit leg the same way a real,
// unconfigured deployment would.
function stopLimitBufferBpsFor(config: TypedConfigService | undefined): number {
  return config?.risk.stopLimitBufferBps ?? 50;
}
// B2 perp entry-sizing caps: absent TypedConfigService (module-isolation boots) leaves SizerDeps.perp
// undefined, so the sizer's applyPerpCaps no-ops — byte-identical to a deployment with no perp config.
function perpDepsFor(config: TypedConfigService | undefined): SizerDeps['perp'] {
  if (!config) return undefined;
  return {
    leverageCap: config.perp.leverageCap,
    mmrFallback: config.perp.mmrFallback,
    liqBufferPct: config.perp.liqBufferPct,
  };
}
// v3 §6.1/§6.2/§10 (workstream #8 consumes the per-venue-class fields directly, retiring the
// transitional single-fraction read): spot symbols use AGENTIC_MAX_POSITION_FRACTION_SPOT, perp
// symbols use …_PERP, keyed by VenueId via the canonical venue-map (domain/venue/types/venue-map.ts) —
// SPOT_VENUE_ID/PERP_VENUE_ID are the only two venues this pass wires. Absent TypedConfigService
// (module-isolation boots) ⇒ undefined, falling through to PositionSizerService's own '0.15'
// fallback — byte-identical to pre-v3 behavior.
function maxAgentPositionFractionByVenueFor(
  config: TypedConfigService | undefined,
): ReadonlyMap<VenueId, string> | undefined {
  if (!config) return undefined;
  return new Map([
    [SPOT_VENUE_ID, config.agentic.maxPositionFractionSpot],
    [PERP_VENUE_ID, config.agentic.maxPositionFractionPerp],
  ]);
}
function equityCapFor(config: TypedConfigService | undefined): string | undefined {
  return config?.risk.equityCap;
}
function maxPlannedStopRiskFractionFor(config: TypedConfigService | undefined): string {
  return config?.risk.maxPlannedStopRiskFraction ?? '0';
}
// v3 §6.1: AppConfig.venueCapitalSplit (VENUE_CAPITAL_SPLIT, plain string keys) converted to a
// VenueId-keyed map for the sizer's applyVenueHeadroomClamp. Absent TypedConfigService
// (module-isolation boots) ⇒ undefined, so the clamp no-ops — byte-identical to pre-split sizing.
function venueCapitalShareFor(
  config: TypedConfigService | undefined,
): ReadonlyMap<VenueId, string> | undefined {
  if (!config) return undefined;
  return new Map(Object.entries(config.venueCapitalSplit).map(([v, share]) => [venueId(v), share]));
}
// Overlays the RISK_* env knobs onto DEFAULT_LIMITS (single source of truth for both RISK_LIMITS —
// consumed by RiskEngineService/ModeControl's LIMITS_COMPLETE gate — and RISK_ENGINE_DEPS). Absent
// TypedConfigService (module-isolation boots) falls straight through to DEFAULT_LIMITS, unchanged
// from before this knob existed. maxDriftBps has no env knob in this pass — always DEFAULT_LIMITS'.
function limitsFor(config: TypedConfigService | undefined): PartialRiskLimits {
  if (!config) return DEFAULT_LIMITS;
  const risk = config.risk;
  return {
    ...DEFAULT_LIMITS,
    maxOrderNotional: risk.maxOrderNotional,
    maxPositionPerSymbol: risk.maxPositionPerSymbol,
    maxGrossExposure: risk.maxGrossExposure,
    maxNetExposure: risk.maxNetExposure,
    maxDailyLoss: risk.maxDailyLoss,
    maxDrawdownPct: risk.maxDrawdownPct,
    maxBandBps: risk.maxBandBps,
    maxPassiveExitBandBps: risk.maxPassiveExitBandBps,
    maxStopTriggerBandBps: risk.maxStopTriggerBandBps,
    stopLimitBufferBps: risk.stopLimitBufferBps,
    staleMaxAgeMs: risk.staleMaxAgeMs,
  };
}
const REAL_FEED_HEALTH_OPTIONAL = { token: REAL_FEED_HEALTH, optional: true } as const;
const CONFIG_OPTIONAL = { token: TypedConfigService, optional: true } as const;

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
    {
      provide: RISK_LIMITS,
      useFactory: (config?: TypedConfigService): PartialRiskLimits => limitsFor(config),
      inject: [CONFIG_OPTIONAL],
    },
    {
      // No-op by default; the composition root binds a DB-backed RiskDecisionJournalAdapter via
      // RISK_JOURNAL_OVERRIDE when the persistence path is active (mirrors EXECUTION_STORE_OVERRIDE).
      provide: RISK_JOURNAL,
      useFactory: (override?: RiskJournalPort): RiskJournalPort => override ?? noopJournal,
      inject: [{ token: RISK_JOURNAL_OVERRIDE, optional: true }],
    },
    {
      provide: SIZER_DEPS,
      useFactory: (config?: TypedConfigService): SizerDeps => ({
        baseNotional: baseNotionalFor(config),
        mode: configMode(config),
        filters: DEFAULT_FILTERS,
        randomBytes,
        exitCrossBufferBps: exitCrossBufferBpsFor(config),
        equityFraction: equityFractionFor(config),
        entryOrderType: entryOrderTypeFor(config),
        stopLimitBufferBps: stopLimitBufferBpsFor(config),
        perp: perpDepsFor(config),
        maxAgentPositionFractionByVenue: maxAgentPositionFractionByVenueFor(config),
        equityCap: equityCapFor(config),
        maxPlannedStopRiskFraction: maxPlannedStopRiskFractionFor(config),
        venueCapitalShare: venueCapitalShareFor(config),
      }),
      inject: [CONFIG_OPTIONAL],
    },
    {
      // limits mirrors the RISK_LIMITS provider above (same limitsFor(config) overlay) — the engine
      // must enforce the SAME limits ModeControl's LIMITS_COMPLETE gate reads off RISK_LIMITS.
      provide: RISK_ENGINE_DEPS,
      useFactory: (key: Buffer, config?: TypedConfigService): RiskEngineDeps => ({
        key,
        limits: limitsFor(config),
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
    PLANNED_STOP_SIZING_COUNTER,
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
