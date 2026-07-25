import { describe, it, expect } from 'vitest';
import {
  reduceArming,
  INITIAL_ARMING,
  CHALLENGE_TTL_MS,
  ARMED_SESSION_TTL_MS,
  type ArmingState,
  type ArmingDeps,
} from '../../../../src/domain/trading/mode/arming';
import { epochMs } from '../../../../src/domain/common/types/ids';

// Fake verifyHmac: 'good' succeeds, anything else fails.
const deps: ArmingDeps = {
  armingSecret: 'test-secret',
  verifyHmac: (_cId, _bId, _secret, candidate) => candidate === 'good',
};

const T0 = epochMs(1_000_000);
const challengeId = 'chal-1';
const bootId = 'boot-1';

const challenged: ArmingState = {
  kind: 'CHALLENGE_ISSUED',
  challengeId,
  bootId,
  issuedAtMs: T0,
  expiresAtMs: epochMs(T0 + CHALLENGE_TTL_MS),
};

const armed: ArmingState = {
  kind: 'ARMED',
  armedAtMs: T0,
  expiresAtMs: epochMs(T0 + ARMED_SESSION_TTL_MS),
};

describe('reduceArming — REQUEST', () => {
  it('from DISARMED → CHALLENGE_ISSUED with correct TTL', () => {
    const r = reduceArming(
      INITIAL_ARMING,
      { type: 'REQUEST', challengeId, bootId, nowMs: T0 },
      deps,
    );
    expect(r.effect).toBe('NONE');
    expect(r.failure).toBeUndefined();
    expect(r.state).toEqual(challenged);
  });

  it('from CHALLENGE_ISSUED → replaces challenge (fresh mint allowed)', () => {
    const r = reduceArming(
      challenged,
      { type: 'REQUEST', challengeId: 'chal-2', bootId: 'boot-2', nowMs: T0 },
      deps,
    );
    expect(r.state).toEqual({
      kind: 'CHALLENGE_ISSUED',
      challengeId: 'chal-2',
      bootId: 'boot-2',
      issuedAtMs: T0,
      expiresAtMs: epochMs(T0 + CHALLENGE_TTL_MS),
    });
    expect(r.effect).toBe('NONE');
  });

  it('from ARMED → keeps existing armed session (safe: no silent drop)', () => {
    const r = reduceArming(
      armed,
      { type: 'REQUEST', challengeId: 'chal-new', bootId, nowMs: T0 },
      deps,
    );
    expect(r.state).toBe(armed);
    expect(r.effect).toBe('NONE');
    expect(r.failure).toBeUndefined();
  });
});

describe('reduceArming — CONFIRM', () => {
  it('DISARMED → NO_CHALLENGE failure, stays DISARMED', () => {
    const r = reduceArming(
      INITIAL_ARMING,
      { type: 'CONFIRM', hmacHex: 'good', bootId, nowMs: T0 },
      deps,
    );
    expect(r.failure).toBe('NO_CHALLENGE');
    expect(r.state.kind).toBe('DISARMED');
    expect(r.effect).toBe('NONE');
  });

  it('ARMED → REPLAY failure, stays ARMED', () => {
    const r = reduceArming(armed, { type: 'CONFIRM', hmacHex: 'good', bootId, nowMs: T0 }, deps);
    expect(r.failure).toBe('REPLAY');
    expect(r.state).toBe(armed);
    expect(r.effect).toBe('NONE');
  });

  it('CHALLENGE_ISSUED, TTL expired (nowMs > expiresAtMs) → TTL_EXPIRED, resets to DISARMED', () => {
    const nowExpired = epochMs(T0 + CHALLENGE_TTL_MS + 1);
    const r = reduceArming(
      challenged,
      { type: 'CONFIRM', hmacHex: 'good', bootId, nowMs: nowExpired },
      deps,
    );
    expect(r.failure).toBe('TTL_EXPIRED');
    expect(r.state.kind).toBe('DISARMED');
    expect(r.effect).toBe('NONE');
  });

  it('TTL boundary: nowMs === expiresAtMs is NOT expired', () => {
    const atBoundary = epochMs(T0 + CHALLENGE_TTL_MS);
    const r = reduceArming(
      challenged,
      { type: 'CONFIRM', hmacHex: 'good', bootId, nowMs: atBoundary },
      deps,
    );
    expect(r.failure).toBeUndefined();
    expect(r.state.kind).toBe('ARMED');
  });

  it('wrong bootId → BOOTID_MISMATCH, stays CHALLENGE_ISSUED', () => {
    const r = reduceArming(
      challenged,
      { type: 'CONFIRM', hmacHex: 'good', bootId: 'other-boot', nowMs: T0 },
      deps,
    );
    expect(r.failure).toBe('BOOTID_MISMATCH');
    expect(r.state).toBe(challenged);
    expect(r.effect).toBe('NONE');
  });

  it('bad hmac → HMAC_MISMATCH, stays CHALLENGE_ISSUED', () => {
    const r = reduceArming(
      challenged,
      { type: 'CONFIRM', hmacHex: 'bad', bootId, nowMs: T0 },
      deps,
    );
    expect(r.failure).toBe('HMAC_MISMATCH');
    expect(r.state).toBe(challenged);
    expect(r.effect).toBe('NONE');
  });

  it('valid CONFIRM → ARMED with correct 8h TTL', () => {
    const r = reduceArming(
      challenged,
      { type: 'CONFIRM', hmacHex: 'good', bootId, nowMs: T0 },
      deps,
    );
    expect(r.failure).toBeUndefined();
    expect(r.state).toEqual({
      kind: 'ARMED',
      armedAtMs: T0,
      expiresAtMs: epochMs(T0 + ARMED_SESSION_TTL_MS),
    });
    expect(r.effect).toBe('NONE');
  });
});

describe('reduceArming — TICK', () => {
  it('DISARMED TICK → unchanged, effect NONE', () => {
    const r = reduceArming(INITIAL_ARMING, { type: 'TICK', nowMs: epochMs(T0 + 1_000_000) }, deps);
    expect(r.state).toBe(INITIAL_ARMING);
    expect(r.effect).toBe('NONE');
  });

  it('CHALLENGE_ISSUED within TTL → unchanged', () => {
    const r = reduceArming(challenged, { type: 'TICK', nowMs: T0 }, deps);
    expect(r.state).toBe(challenged);
    expect(r.effect).toBe('NONE');
  });

  it('CHALLENGE_ISSUED past TTL (nowMs > expiresAtMs) → DISARMED, effect NONE', () => {
    const past = epochMs(T0 + CHALLENGE_TTL_MS + 1);
    const r = reduceArming(challenged, { type: 'TICK', nowMs: past }, deps);
    expect(r.state.kind).toBe('DISARMED');
    expect(r.effect).toBe('NONE');
  });

  it('ARMED within 8h → unchanged', () => {
    const r = reduceArming(armed, { type: 'TICK', nowMs: T0 }, deps);
    expect(r.state).toBe(armed);
    expect(r.effect).toBe('NONE');
  });

  it('ARMED past 8h → DISARMED with KILL_SWITCH_ENGAGE', () => {
    const past8h = epochMs(T0 + ARMED_SESSION_TTL_MS + 1);
    const r = reduceArming(armed, { type: 'TICK', nowMs: past8h }, deps);
    expect(r.state.kind).toBe('DISARMED');
    expect(r.effect).toBe('KILL_SWITCH_ENGAGE');
  });
});

describe('reduceArming — DISARM', () => {
  it('from DISARMED → still DISARMED (idempotent), effect NONE', () => {
    const r = reduceArming(INITIAL_ARMING, { type: 'DISARM', trigger: 'MANUAL' }, deps);
    expect(r.state.kind).toBe('DISARMED');
    expect(r.effect).toBe('NONE');
  });

  it('from CHALLENGE_ISSUED → DISARMED, effect NONE', () => {
    const r = reduceArming(challenged, { type: 'DISARM', trigger: 'KEY_PROBE_FAILURE' }, deps);
    expect(r.state.kind).toBe('DISARMED');
    expect(r.effect).toBe('NONE');
  });

  it('from ARMED → DISARMED, effect NONE', () => {
    const r = reduceArming(armed, { type: 'DISARM', trigger: 'KILL_SWITCH' }, deps);
    expect(r.state.kind).toBe('DISARMED');
    expect(r.effect).toBe('NONE');
  });

  it('all DisarmTrigger values are handled', () => {
    const triggers = [
      'MANUAL',
      'KILL_SWITCH',
      'KEY_PROBE_FAILURE',
      'RECONCILE_MISMATCH',
      'TTL',
    ] as const;
    for (const trigger of triggers) {
      const r = reduceArming(armed, { type: 'DISARM', trigger }, deps);
      expect(r.state.kind).toBe('DISARMED');
    }
  });
});
