import { Global, Module } from '@nestjs/common';
import { ExecutionModule } from '../execution/execution.module';
import { CrashRecoveryService } from '../execution/crash-recovery.service';
import { KILL_SWITCH, type KillSwitchPort } from '../../../ports/risk';
import {
  ARM_PRECONDITIONS,
  type ArmPreconditionsPort,
  type ArmPreconditionResult,
} from '../../../ports/mode-control';

// v3 spec §1.3: moved out of app.module.ts verbatim — logic unchanged. §10b arm-hardening: real
// ARM_PRECONDITIONS check, replacing the always-`{ok:true}` stub (mode-control.module.ts no longer
// self-provides this token — ModeControl's feature boundary cannot import ExecutionModule directly,
// eslint-plugin-boundaries's features→own-feature-only wall). Fail-closed by construction: any
// unreadable source refuses arming rather than assuming it healthy. Reconciliation has no cheap
// synchronous read of its own (ReconciliationService.reconcile() is async/network-bound); a bad
// reconciliation pass already lands here for free — reconcile.ts's HALT path engages the SAME
// KILL_SWITCH (never auto-flattens), so checking kill-switch RUNNING transitively covers it without
// inventing a second, redundant state read. The unresolved-orders read spans both venues' orders
// because CrashRecoveryService's store is venue-keyed (§1.3).
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
export class ArmPreconditionsModule {}
