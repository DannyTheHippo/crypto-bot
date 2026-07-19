import { Global, Module } from '@nestjs/common';
import { KillSwitchService } from '../risk/kill-switch.service';
import { KILL_SWITCH } from '../../../ports/risk';

// W3 Part 4: pure code motion out of app.module.ts — see db-health-bridge.module.ts's own header
// comment on the boundaries 'app' zone widening this relies on.
//
// §5: ONE global kill switch. Risk engages it (monitors/reconcile/anomalies) and reads it in the
// pre-trade gate; Execution engages it too (fill-payload conflict, unknown-state timeout,
// reconciliation HALT). A single shared instance is load-bearing — two would let Execution halt a
// switch Risk never reads. RiskModule and ExecutionModule both consume this global, neither owns it.
@Global()
@Module({
  providers: [KillSwitchService, { provide: KILL_SWITCH, useExisting: KillSwitchService }],
  exports: [KillSwitchService, KILL_SWITCH],
})
export class KillSwitchModule {}
