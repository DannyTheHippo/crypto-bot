import { epochMs, type EpochMs } from '../types/ids';

// Domain constants: not env-tunable in v1. The challenge window is short (phishing
// mitigation); the armed session is an 8-hour trading day before forced re-auth.
export const CHALLENGE_TTL_MS = 60_000;
export const ARMED_SESSION_TTL_MS = 28_800_000;

export type DisarmTrigger =
  | 'MANUAL'
  | 'KILL_SWITCH'
  | 'KEY_PROBE_FAILURE'
  | 'RECONCILE_MISMATCH'
  | 'TTL';

export type ArmingState =
  | { kind: 'DISARMED' }
  | {
      kind: 'CHALLENGE_ISSUED';
      challengeId: string;
      bootId: string;
      issuedAtMs: EpochMs;
      expiresAtMs: EpochMs;
    }
  | { kind: 'ARMED'; armedAtMs: EpochMs; expiresAtMs: EpochMs };

export type ArmingEvent =
  | { type: 'REQUEST'; challengeId: string; bootId: string; nowMs: EpochMs }
  | { type: 'CONFIRM'; hmacHex: string; bootId: string; nowMs: EpochMs }
  | { type: 'TICK'; nowMs: EpochMs }
  | { type: 'DISARM'; trigger: DisarmTrigger };

export type ArmingEffect = 'NONE' | 'KILL_SWITCH_ENGAGE';

export interface ArmingDeps {
  readonly armingSecret: string;
  // Constant-time comparison injected so the domain never imports node:crypto.
  readonly verifyHmac: (
    challengeId: string,
    bootId: string,
    secret: string,
    candidateHex: string,
  ) => boolean;
}

export type ArmFailure =
  | 'TTL_EXPIRED'
  | 'REPLAY'
  | 'HMAC_MISMATCH'
  | 'BOOTID_MISMATCH'
  | 'NO_CHALLENGE';

export interface ArmingResult {
  readonly state: ArmingState;
  readonly effect: ArmingEffect;
  readonly failure?: ArmFailure;
}

export const INITIAL_ARMING: ArmingState = { kind: 'DISARMED' };

// Pure, total state machine.
export function reduceArming(s: ArmingState, e: ArmingEvent, deps: ArmingDeps): ArmingResult {
  switch (e.type) {
    case 'REQUEST': {
      // REQUEST while already ARMED: keep the live session; minting would silently drop it.
      if (s.kind === 'ARMED') return { state: s, effect: 'NONE' };
      // DISARMED or CHALLENGE_ISSUED (replacing an expired/pending challenge is always safe).
      return {
        state: {
          kind: 'CHALLENGE_ISSUED',
          challengeId: e.challengeId,
          bootId: e.bootId,
          issuedAtMs: e.nowMs,
          expiresAtMs: epochMs(e.nowMs + CHALLENGE_TTL_MS),
        },
        effect: 'NONE',
      };
    }

    case 'CONFIRM': {
      if (s.kind === 'ARMED') {
        // Challenge was already consumed; single-use.
        return { state: s, effect: 'NONE', failure: 'REPLAY' };
      }
      if (s.kind === 'DISARMED') {
        return { state: s, effect: 'NONE', failure: 'NO_CHALLENGE' };
      }
      // s.kind === 'CHALLENGE_ISSUED'
      if (e.nowMs > s.expiresAtMs) {
        // TTL expired: challenge is dead; reset to DISARMED.
        return { state: { kind: 'DISARMED' }, effect: 'NONE', failure: 'TTL_EXPIRED' };
      }
      if (e.bootId !== s.bootId) {
        // Token captured from a prior boot.
        return { state: s, effect: 'NONE', failure: 'BOOTID_MISMATCH' };
      }
      if (!deps.verifyHmac(s.challengeId, e.bootId, deps.armingSecret, e.hmacHex)) {
        return { state: s, effect: 'NONE', failure: 'HMAC_MISMATCH' };
      }
      return {
        state: {
          kind: 'ARMED',
          armedAtMs: e.nowMs,
          expiresAtMs: epochMs(e.nowMs + ARMED_SESSION_TTL_MS),
        },
        effect: 'NONE',
      };
    }

    case 'TICK': {
      if (s.kind === 'CHALLENGE_ISSUED' && e.nowMs > s.expiresAtMs) {
        return { state: { kind: 'DISARMED' }, effect: 'NONE' };
      }
      if (s.kind === 'ARMED' && e.nowMs > s.expiresAtMs) {
        // 8-hour session expired: engage kill switch to prevent further live orders.
        return { state: { kind: 'DISARMED' }, effect: 'KILL_SWITCH_ENGAGE' };
      }
      return { state: s, effect: 'NONE' };
    }

    case 'DISARM': {
      // Idempotent from any state; trigger is for audit trail only (consumed by caller).
      return { state: { kind: 'DISARMED' }, effect: 'NONE' };
    }
  }
}
