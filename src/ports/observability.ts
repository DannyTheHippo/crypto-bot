import type { KillSwitchState } from '../domain/risk/kill-switch';

// Backlog #52 (W12 operational event logging): the OpsEvent union + OPS_EVENTS token live in ports/
// (not features/common/observability) so execution/risk feature services can depend on the port
// without a cross-feature import — eslint-plugin-boundaries forbids features/trading/execution or
// features/trading/risk from importing features/common/observability directly (same wall
// AgentMetricsRecorder's own REFLECTION_METRICS_RECORDER_OVERRIDE indirection works around). The
// composition root (features/trading/composition/ops-events.module.ts) binds the real OpsEventLogger
// to this token.
export const OPS_EVENTS = Symbol('OPS_EVENTS');

// Execution-lane diagnostic events only — distinct from the mode/arm/disarm/downgrade lifecycle,
// which already has a durable, tamper-evident audit trail (ModeAuditEvent → audit_log,
// ports/mode-control.ts). These mirror data already exposed as Prometheus counters/gauges; the
// point of this port is a structured, queryable log surface, not a second source of truth.
export type OpsEvent =
  | {
      readonly event: 'reconcile.pass';
      readonly result: 'clean' | 'mismatch' | 'halt' | 'error';
      readonly mismatchClasses: readonly string[];
      readonly venue: string;
    }
  | {
      readonly event: 'killswitch.transition';
      readonly from: KillSwitchState;
      readonly to: KillSwitchState;
      readonly reason: string;
    }
  | { readonly event: 'halt.engage'; readonly reason: string }
  // Emitted when the HALTING cancel-drain window ends — which transitions into HALTED, FLATTENING, or
  // HALTED_DEGRADED, NOT back to RUNNING (a genuine resume→RUNNING is operator-initiated and not
  // driven here). Named for what it is (cancels drained) and carries the resulting `to` state so an
  // operator never misreads it as "recovered"; `durationMs` is the drain duration, not halt duration.
  | {
      readonly event: 'halt.cancels_drained';
      readonly durationMs: number;
      readonly to: KillSwitchState;
    }
  | {
      readonly event: 'boot.ready';
      readonly bootId: string;
      readonly mode: string;
      readonly strategies: readonly string[];
    };

// Fail-OPEN by contract: this is a measurement/diagnostic side-channel, never a control-flow input —
// implementations MUST swallow their own errors internally (see OpsEventLogger) so a throw here can
// never propagate into the execution/risk path that called emit().
export interface OpsEventPort {
  emit(event: OpsEvent): void;
}
