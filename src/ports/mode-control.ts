import type { TradingMode } from '../domain/types/mode';
import type { ModeResolution, EffectiveMode, DowngradeReason } from '../domain/mode/resolution';
import type { DisarmTrigger } from '../domain/mode/arming';
// Re-export so callers who import from the port don't need to know the domain path.
export type { ModeResolution, EffectiveMode, DowngradeReason, DisarmTrigger };

// ── Tokens ────────────────────────────────────────────────────────────────────

export const MODE_CONTROL = Symbol('MODE_CONTROL');
export const MODE_AUDIT = Symbol('MODE_AUDIT');
export const KEY_PROBE = Symbol('KEY_PROBE');
export const LIVE_ADAPTER_CAP = Symbol('LIVE_ADAPTER_CAP');
export const MODE_CONTROL_CONFIG = Symbol('MODE_CONTROL_CONFIG');
export const ARM_PRECONDITIONS = Symbol('ARM_PRECONDITIONS');
// Gate (d): a boolean derived at the composition root from the risk-limits completeness verdict
// (validateLimits ≠ null). Global so ModeControl resolves it without importing RiskModule. Wiring
// this — instead of the prior hardcoded true — is the §10(d) defense-in-depth behind Risk's own
// in-engine completeness rule, and the prerequisite for ever enabling a real KEY_PROBE.
export const LIMITS_COMPLETE = Symbol('LIMITS_COMPLETE');

// ── Errors ────────────────────────────────────────────────────────────────────

export type ModeViolationCode = 'NOT_LIVE_AUTHORITY' | 'MODE_MISMATCH' | 'NOT_ARMED';

export class ModeViolationError extends Error {
  readonly code: ModeViolationCode;

  constructor(code: ModeViolationCode, message: string) {
    super(message);
    this.name = 'ModeViolationError';
    this.code = code;
  }
}

// ── ModeControlPort ───────────────────────────────────────────────────────────

// ArmRequest: two-step TOTP-like flow.
// step 1: REQUEST — operator posts their bootId, service issues a challengeId.
// step 2: CONFIRM — operator posts the HMAC proof (challengeId + bootId signed with
//         the arming secret) to complete the transition to ARMED.
export type ArmRequest =
  | { step: 'REQUEST'; bootId: string }
  | { step: 'CONFIRM'; challengeId: string; hmacHex: string; bootId: string };

export type ArmFailureReason = 'TTL_EXPIRED' | 'REPLAY' | 'HMAC_MISMATCH' | 'PRECONDITION';

// challengeId is present on the REQUEST step so the operator can pass it back on CONFIRM.
export type ArmResult =
  | { ok: true; challengeId?: string }
  | { ok: false; reason: ArmFailureReason };

// Boot-time authority, supplied by the composition root. Under test/ci armingSecret is
// undefined — arming can never succeed, preserving the paper-default invariant.
export interface ModeControlConfig {
  readonly requested: TradingMode;
  readonly bootId: string;
  readonly armingSecret: string | undefined;
  readonly limitsComplete: boolean;
}

export interface ArmPreconditionResult {
  readonly ok: boolean;
  readonly reason?: string;
}

// "arm last": kill switch RUNNING, reconciliation clean, no *_UNKNOWN/RECONCILE_REQUIRED
// orders. The real impl (app root) queries reconcile/OMS state; the module default returns ok
// (paper boot never trades live anyway).
export interface ArmPreconditionsPort {
  check(): ArmPreconditionResult;
}

export interface ModeControlPort {
  // Re-evaluated on every call — callers MUST NOT cache the result.
  resolveMode(): ModeResolution;
  armLive(req: ArmRequest): ArmResult;
  // Idempotent; trigger is recorded in the audit log.
  disarm(trigger: DisarmTrigger): void;
  // Throws ModeViolationError when a live-stamped intent reaches a process never authorised for
  // live (boot config ≠ live). intentId, when supplied, is recorded on the refusal audit row (§595).
  assertCanTrade(intentMode: TradingMode, intentId?: string): void;
}

// ── KeyProbePort ──────────────────────────────────────────────────────────────

export interface KeyProbeResult {
  readonly keysValid: boolean;
  readonly withdrawalsEnabled: boolean; // must be false for live trading
  readonly spotEnabled: boolean;
  readonly marginOrFutures: boolean;
  readonly keyFingerprint: string; // hex digest only — never raw key material in logs
  readonly urlCrossCheckOk: boolean; // venue URL matches the configured endpoint
}

export interface KeyProbePort {
  probe(): Promise<KeyProbeResult>;
}

// ── ModeAuditPort ─────────────────────────────────────────────────────────────

// Fire-and-forget audit sink. Callers never await; failures must not propagate.
// booleans only — never log key material.
export type ModeAuditEvent =
  | {
      type: 'boot_resolution';
      requested: TradingMode;
      effective: EffectiveMode;
      downgrades: readonly DowngradeReason[];
      bootId: string;
    }
  | { type: 'arm_requested'; bootId: string; challengeId: string }
  | { type: 'arm_confirmed'; bootId: string }
  | { type: 'arm_failed'; reason: ArmFailureReason }
  | { type: 'disarmed'; trigger: DisarmTrigger }
  | { type: 'downgrade'; failedPrecondition: DowngradeReason }
  | { type: 'live_order_refused'; intentId: string; code: ModeViolationCode }
  | {
      type: 'key_check';
      withdrawalsEnabled: boolean;
      spotEnabled: boolean;
      marginOrFutures: boolean;
      urlCrossCheckOk: boolean;
    };

export interface ModeAuditPort {
  record(event: ModeAuditEvent): void;
}

// Optional override token: composition root injects a Drizzle-backed audit when DATABASE_URL is
// present and NODE_ENV ∉ {test,ci} and !CI. Mode-control.module's MODE_AUDIT factory falls back
// to noopAudit when absent. Defined here (ports layer) to avoid a boundary violation.
export const MODE_AUDIT_OVERRIDE = Symbol('MODE_AUDIT_OVERRIDE');
