import { Injectable, Logger } from '@nestjs/common';
import {
  reduceKillSwitch,
  INITIAL_KILL_SWITCH,
  type KillSwitch,
  type KillSwitchState,
  type KillSwitchEvent,
} from '../../../domain/risk/kill-switch';
import type { KillSwitchPort } from '../../../ports/risk';

// Stateful wrapper over the pure kill-switch reducer. Engage comes from monitors,
// reconciliation, OMS anomalies, rate runaway, or the admin API. Cancel/flatten
// progression (CANCELS_CONFIRMED / ALL_FLAT / timeout) is driven by Execution (Phase 5/6)
// via dispatch(); disengage (RESUME) is manual and precondition-gated by the caller.
@Injectable()
export class KillSwitchService implements KillSwitchPort {
  private ks: KillSwitch = INITIAL_KILL_SWITCH;
  private lastReason = '';
  private readonly log = new Logger(KillSwitchService.name);

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

  // Lifecycle progressions Execution drives (HALTING→…→HALTED). RESUME is intentionally NOT here —
  // disengage is operator-only via a separate admin path (§5).
  confirmCancels(): void {
    this.dispatch({ type: 'CANCELS_CONFIRMED' });
  }

  cancelTimeout(): void {
    this.dispatch({ type: 'CANCEL_TIMEOUT' });
  }

  allFlat(): void {
    this.dispatch({ type: 'ALL_FLAT' });
  }

  dispatch(event: KillSwitchEvent): void {
    this.ks = reduceKillSwitch(this.ks, event);
  }
}
