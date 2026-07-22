import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  reduceKillSwitch,
  INITIAL_KILL_SWITCH,
  type KillSwitch,
  type KillSwitchState,
  type KillSwitchEvent,
} from '../../../domain/risk/kill-switch';
import type { KillSwitchPort } from '../../../ports/risk';
import { OPS_EVENTS, type OpsEventPort } from '../../../ports/observability';

// Stateful wrapper over the pure kill-switch reducer. Engage comes from monitors,
// reconciliation, OMS anomalies, rate runaway, or the admin API. Cancel/flatten
// progression (CANCELS_CONFIRMED / ALL_FLAT / timeout) is driven by Execution (Phase 5/6)
// via dispatch(); disengage (resume()) is precondition-gated by its sole caller,
// RecoveryCoordinatorService (owner-authorized auto-resume, 2026-07-22) — there is no other
// in-process resume path; the pre-feature "manual resume" was an operator restarting the process.
@Injectable()
export class KillSwitchService implements KillSwitchPort {
  private ks: KillSwitch = INITIAL_KILL_SWITCH;
  private lastReason = '';
  private readonly log = new Logger(KillSwitchService.name);

  // Backlog #52: diagnostic side-channel, never a control-flow input — @Optional so every
  // pre-existing direct-construction unit test (`new KillSwitchService()`) keeps constructing
  // without it (OpsEventsModule binds the real one at the composition root).
  constructor(
    @Optional()
    @Inject(OPS_EVENTS)
    private readonly opsEvents?: OpsEventPort,
  ) {}

  state(): KillSwitchState {
    return this.ks.state;
  }

  reason(): string {
    return this.lastReason;
  }

  // 2026-07-19: a day of spot-lane FILL_FOR_UNKNOWN_ORDER halts went unnoticed with zero log
  // signal at the source — engage() logs level-50 (error) unconditionally, every call, so a HALT
  // is never silent at the one place it always passes through, regardless of which caller (monitor,
  // reconciliation, OMS anomaly, admin) engaged it.
  engage(reason: string, flatten: boolean): void {
    this.lastReason = reason;
    this.log.error(
      `kill switch engaged: ${reason} (flatten=${flatten}, prior state=${this.ks.state})`,
    );
    this.dispatch({ type: 'ENGAGE', flatten });
  }

  // Lifecycle progressions Execution drives (HALTING→…→HALTED).
  confirmCancels(): void {
    this.dispatch({ type: 'CANCELS_CONFIRMED' });
  }

  cancelTimeout(): void {
    this.dispatch({ type: 'CANCEL_TIMEOUT' });
  }

  allFlat(): void {
    this.dispatch({ type: 'ALL_FLAT' });
  }

  // Owner-authorized 2026-07-22: disengage HALTED/HALTED_DEGRADED → RUNNING. This method itself is
  // precondition-free (mirrors engage()) — RecoveryCoordinatorService is the SOLE caller and is
  // solely responsible for confirming it is safe to call this (see ports/risk.ts's
  // KillSwitchPort.resume() and RecoveryCoordinatorService's own header comment). No other resume
  // path exists in-process today.
  resume(): void {
    this.dispatch({ type: 'RESUME' });
  }

  dispatch(event: KillSwitchEvent): void {
    const prior = this.ks.state;
    this.ks = reduceKillSwitch(this.ks, event);
    // Backlog #52: the reducer returns the SAME state unchanged for an event it ignores in the
    // current state (e.g. RESUME while RUNNING) — only a genuine transition is ops-event-worthy.
    if (this.ks.state !== prior) {
      this.opsEvents?.emit({
        event: 'killswitch.transition',
        from: prior,
        to: this.ks.state,
        reason: this.lastReason,
      });
    }
  }
}
