// Global kill-switch state machine (§5):
//   RUNNING → HALTING → HALTED → (FLATTENING →) HALTED, plus HALTED_DEGRADED.
// Pure reducer: (state, event) → state. Stateful wiring lives in the module.
export type KillSwitchState = 'RUNNING' | 'HALTING' | 'HALTED' | 'FLATTENING' | 'HALTED_DEGRADED';

export type KillSwitchEvent =
  | { type: 'ENGAGE'; flatten: boolean } // monitors / reconcile / OMS anomaly / admin
  | { type: 'CANCELS_CONFIRMED' } // HALTING: all open orders cancelled
  | { type: 'CANCEL_TIMEOUT' } // HALTING: cancels not confirmed in 10s
  | { type: 'ALL_FLAT' } // FLATTENING: every |position| < exchange min
  // Disengage: preconditions are checked externally by the caller, never by this reducer.
  // Owner-authorized 2026-07-22: RecoveryCoordinatorService (KillSwitchPort.resume()) is the sole
  // programmatic dispatcher of this event — there was no prior in-process resume path at all (the
  // historical "manual resume" was an operator restarting the process, which re-seeds
  // INITIAL_KILL_SWITCH rather than dispatching this event).
  | { type: 'RESUME' };

export interface KillSwitch {
  readonly state: KillSwitchState;
  readonly flattenRequested: boolean; // carried so CANCELS_CONFIRMED knows whether to FLATTEN
}

export const INITIAL_KILL_SWITCH: KillSwitch = { state: 'RUNNING', flattenRequested: false };

export function reduceKillSwitch(ks: KillSwitch, event: KillSwitchEvent): KillSwitch {
  switch (ks.state) {
    case 'RUNNING':
      // Engage from any source → HALTING (cancel-all issued by the module).
      if (event.type === 'ENGAGE') return { state: 'HALTING', flattenRequested: event.flatten };
      return ks;
    case 'HALTING':
      if (event.type === 'CANCELS_CONFIRMED') {
        return ks.flattenRequested
          ? { state: 'FLATTENING', flattenRequested: true }
          : { state: 'HALTED', flattenRequested: false };
      }
      if (event.type === 'CANCEL_TIMEOUT') {
        // Orders may still be live — page; reconciliation keeps polling.
        return { state: 'HALTED_DEGRADED', flattenRequested: ks.flattenRequested };
      }
      return ks;
    case 'FLATTENING':
      if (event.type === 'ALL_FLAT') return { state: 'HALTED', flattenRequested: false };
      return ks;
    case 'HALTED':
    case 'HALTED_DEGRADED':
      // Disengage is manual only; preconditions (clean reconcile, fresh data, re-arm)
      // are enforced by the caller before issuing RESUME.
      if (event.type === 'RESUME') return INITIAL_KILL_SWITCH;
      return ks;
  }
}
