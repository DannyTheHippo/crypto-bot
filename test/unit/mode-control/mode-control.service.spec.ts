import { describe, it, expect } from 'vitest';
import { ModeControlService } from '../../../src/modules/mode-control/mode-control.service';
import { computeArmingHmac } from '../../../src/modules/mode-control/hmac';
import { KillSwitchService } from '../../../src/modules/risk/kill-switch.service';
import { ARMED_SESSION_TTL_MS, CHALLENGE_TTL_MS } from '../../../src/domain/mode/arming';
import { ModeViolationError } from '../../../src/ports/mode-control';
import type {
  ModeControlConfig,
  ModeAuditEvent,
  KeyProbeResult,
  ArmPreconditionResult,
} from '../../../src/ports/mode-control';
import { epochMs } from '../../../src/domain/types/ids';

const T = 1_700_000_000_000;
const SECRET = 'arming-secret';
const BOOT = 'boot-1';

const validProbe: KeyProbeResult = {
  keysValid: true,
  withdrawalsEnabled: false,
  spotEnabled: true,
  marginOrFutures: false,
  keyFingerprint: 'fp',
  urlCrossCheckOk: true,
};
const invalidProbe: KeyProbeResult = {
  keysValid: false,
  withdrawalsEnabled: true,
  spotEnabled: false,
  marginOrFutures: false,
  keyFingerprint: 'none',
  urlCrossCheckOk: false,
};

function build(over: Partial<ModeControlConfig> = {}) {
  let t = T;
  const clock = { now: () => epochMs(t) };
  const events: ModeAuditEvent[] = [];
  const audit = {
    record: (e: ModeAuditEvent) => {
      events.push(e);
    },
  };
  let probe: KeyProbeResult = invalidProbe;
  const keyProbe = { probe: () => Promise.resolve(probe) };
  const killSwitch = new KillSwitchService(); // real instance: starts RUNNING
  let precond: ArmPreconditionResult = { ok: true };
  const preconditions = { check: () => precond };
  const cfg: ModeControlConfig = {
    requested: 'paper',
    bootId: BOOT,
    armingSecret: SECRET,
    limitsComplete: true,
    ...over,
  };
  const svc = new ModeControlService(clock, keyProbe, killSwitch, audit, preconditions, cfg);
  return {
    svc,
    events,
    killSwitch,
    cfg,
    setNow: (n: number) => {
      t = n;
    },
    setProbe: (p: KeyProbeResult) => {
      probe = p;
    },
    setPrecond: (p: ArmPreconditionResult) => {
      precond = p;
    },
  };
}

// Drive a successful arm: REQUEST → compute the real HMAC over the issued challenge → CONFIRM.
function arm(ctx: ReturnType<typeof build>): void {
  const req = ctx.svc.armLive({ step: 'REQUEST', bootId: BOOT });
  if (!req.ok || req.challengeId === undefined) throw new Error('request failed');
  const hmacHex = computeArmingHmac(req.challengeId, BOOT, SECRET);
  const res = ctx.svc.armLive({
    step: 'CONFIRM',
    challengeId: req.challengeId,
    hmacHex,
    bootId: BOOT,
  });
  if (!res.ok) throw new Error('confirm failed: ' + res.reason);
}

describe('ModeControlService', () => {
  it('resolves paper by default (no probe, not armed)', () => {
    const ctx = build();
    expect(ctx.svc.resolveMode().effective).toBe('paper');
  });

  it('a full arm + valid keys + live request + complete limits resolves to live', async () => {
    const ctx = build({ requested: 'live' });
    ctx.setProbe(validProbe);
    await ctx.svc.refreshKeyProbe();
    arm(ctx);
    expect(ctx.svc.resolveMode().effective).toBe('live');
  });

  it('arm REQUEST returns a challengeId and audits arm_requested', () => {
    const ctx = build();
    const res = ctx.svc.armLive({ step: 'REQUEST', bootId: BOOT });
    expect(res.ok).toBe(true);
    expect(res.ok && res.challengeId).toBeTruthy();
    expect(ctx.events.some((e) => e.type === 'arm_requested')).toBe(true);
  });

  it('CONFIRM with a valid HMAC arms and audits arm_confirmed', () => {
    const ctx = build({ requested: 'live' });
    arm(ctx);
    expect(ctx.events.some((e) => e.type === 'arm_confirmed')).toBe(true);
  });

  it('CONFIRM fails PRECONDITION when the precondition gate is not ok', () => {
    const ctx = build();
    const req = ctx.svc.armLive({ step: 'REQUEST', bootId: BOOT });
    ctx.setPrecond({ ok: false, reason: 'reconcile dirty' });
    const hmacHex = computeArmingHmac((req as { challengeId: string }).challengeId, BOOT, SECRET);
    const res = ctx.svc.armLive({ step: 'CONFIRM', challengeId: 'x', hmacHex, bootId: BOOT });
    expect(res).toEqual({ ok: false, reason: 'PRECONDITION' });
    expect(ctx.events.at(-1)).toEqual({ type: 'arm_failed', reason: 'PRECONDITION' });
  });

  it('CONFIRM fails PRECONDITION when the kill switch is not RUNNING', () => {
    const ctx = build();
    ctx.svc.armLive({ step: 'REQUEST', bootId: BOOT });
    ctx.killSwitch.engage('x', false); // → HALTING
    const res = ctx.svc.armLive({ step: 'CONFIRM', challengeId: 'x', hmacHex: 'ab', bootId: BOOT });
    expect(res).toEqual({ ok: false, reason: 'PRECONDITION' });
  });

  it('CONFIRM fails PRECONDITION when no arming secret is configured (test/ci boot)', () => {
    const ctx = build({ armingSecret: undefined });
    ctx.svc.armLive({ step: 'REQUEST', bootId: BOOT });
    const res = ctx.svc.armLive({ step: 'CONFIRM', challengeId: 'x', hmacHex: 'ab', bootId: BOOT });
    expect(res).toEqual({ ok: false, reason: 'PRECONDITION' });
  });

  it('CONFIRM fails HMAC_MISMATCH on a bad proof', () => {
    const ctx = build({ requested: 'live' });
    ctx.svc.armLive({ step: 'REQUEST', bootId: BOOT });
    const res = ctx.svc.armLive({
      step: 'CONFIRM',
      challengeId: 'x',
      hmacHex: 'deadbeef',
      bootId: BOOT,
    });
    expect(res).toEqual({ ok: false, reason: 'HMAC_MISMATCH' });
    expect(ctx.svc.resolveMode().effective).toBe('paper'); // not armed
  });

  it('CONFIRM fails TTL_EXPIRED when the challenge window lapsed', () => {
    const ctx = build({ requested: 'live' });
    const req = ctx.svc.armLive({ step: 'REQUEST', bootId: BOOT });
    const hmacHex = computeArmingHmac((req as { challengeId: string }).challengeId, BOOT, SECRET);
    ctx.setNow(T + CHALLENGE_TTL_MS + 1);
    const res = ctx.svc.armLive({
      step: 'CONFIRM',
      challengeId: (req as { challengeId: string }).challengeId,
      hmacHex,
      bootId: BOOT,
    });
    expect(res).toEqual({ ok: false, reason: 'TTL_EXPIRED' });
  });

  it('CONFIRM fails REPLAY when confirming an already-armed session', () => {
    const ctx = build({ requested: 'live' });
    arm(ctx);
    const res = ctx.svc.armLive({ step: 'CONFIRM', challengeId: 'x', hmacHex: 'ab', bootId: BOOT });
    expect(res).toEqual({ ok: false, reason: 'REPLAY' });
  });

  it('CONFIRM maps BOOTID_MISMATCH onto HMAC_MISMATCH (no oracle on which half failed)', () => {
    const ctx = build({ requested: 'live' });
    const req = ctx.svc.armLive({ step: 'REQUEST', bootId: BOOT });
    const hmacHex = computeArmingHmac(
      (req as { challengeId: string }).challengeId,
      'other-boot',
      SECRET,
    );
    const res = ctx.svc.armLive({
      step: 'CONFIRM',
      challengeId: (req as { challengeId: string }).challengeId,
      hmacHex,
      bootId: 'other-boot',
    });
    expect(res).toEqual({ ok: false, reason: 'HMAC_MISMATCH' });
  });

  it('CONFIRM with no outstanding challenge maps NO_CHALLENGE onto PRECONDITION', () => {
    const ctx = build({ requested: 'live' });
    // No REQUEST issued; state is DISARMED ⇒ reducer returns NO_CHALLENGE.
    const res = ctx.svc.armLive({ step: 'CONFIRM', challengeId: 'x', hmacHex: 'ab', bootId: BOOT });
    expect(res).toEqual({ ok: false, reason: 'PRECONDITION' });
  });

  it('the 8h armed-session TTL lazily disarms and engages the kill switch on the next call', () => {
    const ctx = build({ requested: 'live' });
    arm(ctx);
    ctx.setNow(T + ARMED_SESSION_TTL_MS + 1);
    ctx.svc.resolveMode(); // tick() detects expiry
    expect(ctx.killSwitch.state()).toBe('HALTING'); // kill switch engaged
    expect(ctx.events.some((e) => e.type === 'disarmed' && e.trigger === 'TTL')).toBe(true);
  });

  it('disarm is idempotent and audited', () => {
    const ctx = build();
    ctx.svc.disarm('MANUAL');
    expect(ctx.events.at(-1)).toEqual({ type: 'disarmed', trigger: 'MANUAL' });
  });

  it('assertCanTrade throws + audits when a live intent hits a paper-authority boot', () => {
    const ctx = build({ requested: 'paper' });
    expect(() => ctx.svc.assertCanTrade('live')).toThrow(ModeViolationError);
    expect(ctx.events.at(-1)).toMatchObject({
      type: 'live_order_refused',
      code: 'NOT_LIVE_AUTHORITY',
    });
  });

  it('assertCanTrade allows a live intent under live authority and any paper intent', () => {
    const live = build({ requested: 'live' });
    expect(() => live.svc.assertCanTrade('live')).not.toThrow();
    const paper = build({ requested: 'paper' });
    expect(() => paper.svc.assertCanTrade('paper')).not.toThrow();
  });

  it('refreshKeyProbe caches a valid verdict and audits key_check (booleans only)', async () => {
    const ctx = build({ requested: 'live' });
    ctx.setProbe(validProbe);
    await ctx.svc.refreshKeyProbe();
    const ev = ctx.events.at(-1);
    expect(ev).toEqual({
      type: 'key_check',
      withdrawalsEnabled: false,
      spotEnabled: true,
      marginOrFutures: false,
      urlCrossCheckOk: true,
    });
  });

  // §10c / auditor S5: ModeControl recomputes keysValid from the restriction snapshot and does NOT
  // trust the probe's own verdict. Each restriction failure independently blocks live.
  it.each([
    [
      'probe LIES keysValid:true while withdrawals are enabled',
      { ...validProbe, keysValid: true, withdrawalsEnabled: true },
    ],
    ['spot trading disabled', { ...validProbe, spotEnabled: false }],
    ['margin/futures enabled', { ...validProbe, marginOrFutures: true }],
    ['venue URL cross-check fails', { ...validProbe, urlCrossCheckOk: false }],
  ])('recompute blocks live when %s (probe verdict ignored)', async (_label, probe) => {
    const ctx = build({ requested: 'live' });
    ctx.setProbe(probe);
    await ctx.svc.refreshKeyProbe();
    arm(ctx); // fully armed + live authority + complete limits — only the recomputed keysValid can block
    expect(ctx.svc.resolveMode().effective).toBe('paper');
  });

  it('a failing probe while ARMED disarms and engages the kill switch', async () => {
    const ctx = build({ requested: 'live' });
    ctx.setProbe(validProbe);
    await ctx.svc.refreshKeyProbe();
    arm(ctx);
    ctx.setProbe(invalidProbe);
    await ctx.svc.refreshKeyProbe();
    expect(ctx.killSwitch.state()).toBe('HALTING');
    expect(ctx.svc.resolveMode().effective).toBe('paper'); // disarmed ⇒ downgraded
  });

  it('a failing probe while NOT armed does not engage the kill switch', async () => {
    const ctx = build({ requested: 'live' });
    ctx.setProbe(invalidProbe);
    await ctx.svc.refreshKeyProbe();
    expect(ctx.killSwitch.state()).toBe('RUNNING');
  });
});
