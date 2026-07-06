import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CLOCK, SystemClock } from '../../ports/clock';
import type { AppConfig } from '../../ports/app-config';
import {
  MODE_CONTROL,
  MODE_AUDIT,
  ARM_PRECONDITIONS,
  MODE_CONTROL_CONFIG,
  LIMITS_COMPLETE,
  MODE_AUDIT_OVERRIDE,
  type ModeAuditPort,
  type ArmPreconditionsPort,
  type ModeControlConfig,
} from '../../ports/mode-control';
import {
  PROMOTION_READINESS,
  PROMOTION_READINESS_CONFIG,
  type PromotionReadinessConfig,
} from '../../ports/promotion';
import { ModeControlService } from './mode-control.service';
import { PromotionReadinessService } from './promotion-readiness.service';
import { ArmingController } from './arming.controller';

const noopAudit: ModeAuditPort = { record: () => undefined };

// KEY_PROBE is NOT self-provided here: the real probe needs a credentialed ccxt client (an
// exchange-adapter concern this module must not import). The composition root binds KEY_PROBE
// globally — a forced-invalid probe in paper, the real KeyProbeService in testnet/live — and
// ModeControl consumes that single global. Same lift pattern as KILL_SWITCH / LIMITS_COMPLETE.

const defaultPreconditions: ArmPreconditionsPort = { check: () => ({ ok: true }) };

// MODE_CONTROL_CONFIG is derived from the validated AppConfig at boot: the config authority
// (configMode — forced paper under test/ci), the per-process bootId the arming interlock binds to,
// and the arming secret (undefined under test/ci ⇒ arming can never succeed). limitsComplete is the
// gate-(d) mirror; Risk's evaluate enforces the authoritative limits-completeness (§5), so this
// stays true here (full wiring to the risk-limits validation is a follow-up).
const configProvider: Provider = {
  provide: MODE_CONTROL_CONFIG,
  useFactory: (
    config: ConfigService<AppConfig, true>,
    limitsComplete: boolean,
  ): ModeControlConfig => ({
    requested: config.get('mode', { infer: true }).configMode,
    bootId: config.get('app', { infer: true }).bootId,
    armingSecret: config.get('armingSecret', { infer: true }),
    limitsComplete,
  }),
  inject: [ConfigService, LIMITS_COMPLETE],
};

// Same derived-value-object pattern as MODE_CONTROL_CONFIG above: PromotionReadinessService takes a
// plain config object (unit tests stay ConfigService-free); prices/dust are validated decimal
// strings from the agentic schema block.
const readinessConfigProvider: Provider = {
  provide: PROMOTION_READINESS_CONFIG,
  useFactory: (config: ConfigService<AppConfig, true>): PromotionReadinessConfig => {
    const agentic = config.get('agentic', { infer: true });
    return {
      tokenPriceInputPerMtok: agentic.tokenPriceInputPerMtok,
      tokenPriceOutputPerMtok: agentic.tokenPriceOutputPerMtok,
      dustNotional: agentic.promotionDustNotional,
    };
  },
  inject: [ConfigService],
};

const providers: Provider[] = [
  { provide: CLOCK, useClass: SystemClock },
  {
    provide: MODE_AUDIT,
    useFactory: (override?: ModeAuditPort): ModeAuditPort => override ?? noopAudit,
    inject: [{ token: MODE_AUDIT_OVERRIDE, optional: true }],
  },
  { provide: ARM_PRECONDITIONS, useValue: defaultPreconditions },
  configProvider,
  readinessConfigProvider,
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
