import { Injectable } from '@nestjs/common';
import {
  reduceKillSwitch,
  INITIAL_KILL_SWITCH,
  type KillSwitch,
  type KillSwitchState,
  type KillSwitchEvent,
} from '../../domain/risk/kill-switch';
import type { KillSwitchPort } from '../../ports/risk';

// Stateful wrapper over the pure kill-switch reducer. Engage comes from monitors,
// reconciliation, OMS anomalies, rate runaway, or the admin API. Cancel/flatten
// progression (CANCELS_CONFIRMED / ALL_FLAT / timeout) is driven by Execution (Phase 5/6)
// via dispatch(); disengage (RESUME) is manual and precondition-gated by the caller.
@Injectable()
export class KillSwitchService implements KillSwitchPort {
  private ks: KillSwitch = INITIAL_KILL_SWITCH;
  private lastReason = '';

  state(): KillSwitchState {
    return this.ks.state;
  }

  reason(): string {
    return this.lastReason;
  }

  engage(reason: string, flatten: boolean): void {
    this.lastReason = reason;
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
