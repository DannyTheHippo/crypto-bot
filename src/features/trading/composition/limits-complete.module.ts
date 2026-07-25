import { Global, Module } from '@nestjs/common';
import { RiskModule } from '../risk/risk.module';
import { RISK_LIMITS } from '../../../ports/trading/risk';
import { LIMITS_COMPLETE } from '../../../ports/trading/mode-control';
import { validateLimits, type PartialRiskLimits } from '../../../domain/trading/risk/limits';

// W3 Part 4: pure code motion out of app.module.ts — see db-health-bridge.module.ts's own header
// comment on the boundaries 'app' zone widening this relies on.
//
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
export class LimitsCompleteModule {}
