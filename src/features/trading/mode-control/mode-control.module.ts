import { Global, Module, type Provider } from '@nestjs/common';
import { CLOCK, SystemClock } from '../../../ports/clock';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import {
  MODE_CONTROL,
  MODE_AUDIT,
  MODE_CONTROL_CONFIG,
  LIMITS_COMPLETE,
  MODE_AUDIT_OVERRIDE,
  type ModeAuditPort,
  type ModeControlConfig,
} from '../../../ports/mode-control';
import {
  PROMOTION_READINESS,
  PROMOTION_READINESS_CONFIG,
  type PromotionReadinessConfig,
} from '../../../ports/promotion';
import { ModeControlService } from './mode-control.service';
import { PromotionReadinessService } from './promotion-readiness.service';
import { ArmingController } from './arming.controller';
import { ArmingTransportGuard } from './arming-transport.guard';

const noopAudit: ModeAuditPort = { record: () => undefined };

// KEY_PROBE is NOT self-provided here: the real probe needs a credentialed ccxt client (an
// exchange-adapter concern this module must not import). The composition root binds KEY_PROBE
// globally — a forced-invalid probe in paper, the real KeyProbeService in testnet/live — and
// ModeControl consumes that single global. Same lift pattern as KILL_SWITCH / LIMITS_COMPLETE.
//
// §10b arm-hardening: ARM_PRECONDITIONS is likewise NOT self-provided here (as of the always-`
// {ok:true}` stub's retirement) — the real check reads CrashRecoveryService's hasUnresolvedOrders(),
// an ExecutionModule concern this module must not import (eslint-plugin-boundaries). The composition
// root (app.module.ts's ArmPreconditionsModule) binds the real, fail-closed implementation globally.

// MODE_CONTROL_CONFIG is derived from the validated AppConfig at boot: the config authority
// (configMode — forced paper under test/ci), the per-process bootId the arming interlock binds to,
// and the arming secret (undefined under test/ci ⇒ arming can never succeed). limitsComplete is the
// gate-(d) mirror; Risk's evaluate enforces the authoritative limits-completeness (§5), so this
// stays true here (full wiring to the risk-limits validation is a follow-up).
const configProvider: Provider = {
  provide: MODE_CONTROL_CONFIG,
  useFactory: (config: TypedConfigService, limitsComplete: boolean): ModeControlConfig => ({
    requested: config.mode.configMode,
    bootId: config.app.bootId,
    armingSecret: config.liveSecrets.armingSecret,
    limitsComplete,
  }),
  inject: [TypedConfigService, LIMITS_COMPLETE],
};

// Same derived-value-object pattern as MODE_CONTROL_CONFIG above: PromotionReadinessService takes a
// plain config object (unit tests stay ConfigService-free); prices/dust are validated decimal
// strings from the agentic schema block.
const readinessConfigProvider: Provider = {
  provide: PROMOTION_READINESS_CONFIG,
  useFactory: (config: TypedConfigService): PromotionReadinessConfig => {
    const agentic = config.agentic;
    // Evidence epoch (W4+W13, owner 2026-07-08): parse the ISO string once here so the service takes
    // a plain ms number. An unset (undefined) epoch stays undefined ⇒ all-time gate behavior.
    const evidenceEpochMs =
      agentic.promotionEvidenceEpoch === undefined
        ? undefined
        : Date.parse(agentic.promotionEvidenceEpoch);
    return {
      tokenPriceInputPerMtok: agentic.tokenPriceInputPerMtok,
      tokenPriceOutputPerMtok: agentic.tokenPriceOutputPerMtok,
      tokenPriceCacheReadPerMtok: agentic.tokenPriceCacheReadPerMtok,
      tokenPriceCacheWritePerMtok: agentic.tokenPriceCacheWritePerMtok,
      tokenPrices: agentic.tokenPrices,
      evidenceEpochMs,
      dustNotional: agentic.promotionDustNotional,
    };
  },
  inject: [TypedConfigService],
};

const providers: Provider[] = [
  { provide: CLOCK, useClass: SystemClock },
  {
    provide: MODE_AUDIT,
    useFactory: (override?: ModeAuditPort): ModeAuditPort => override ?? noopAudit,
    inject: [{ token: MODE_AUDIT_OVERRIDE, optional: true }],
  },
  configProvider,
  readinessConfigProvider,
  ArmingTransportGuard,
  ModeControlService,
  { provide: MODE_CONTROL, useExisting: ModeControlService },
  PromotionReadinessService,
  { provide: PROMOTION_READINESS, useExisting: PromotionReadinessService },
];

// @Global so the ExecutionGate (in ExecutionModule) resolves the SINGLE MODE_CONTROL instance — the
// same lift pattern as the kill switch. Mode resolution and the arming interlock are process-wide.
@Global()
@Module({
  controllers: [ArmingController],
  providers,
  // ModeControlService (concrete) is exported alongside the port so the composition-root trading
  // runtime can call refreshKeyProbe() at boot — not on ModeControlPort (a runtime-glue concern).
  // PROMOTION_READINESS is the earned-live evidence verdict (P2b) the boot interlock consumes (P2c).
  exports: [MODE_CONTROL, ModeControlService, PROMOTION_READINESS],
})
export class ModeControlModule {}
