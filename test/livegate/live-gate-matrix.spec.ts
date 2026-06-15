/**
 * SACRED LIVEGATE SUITE — the §9 LIVE-GATE TEST MATRIX (mandatory in every CI pass).
 *
 * Proves the four-gate wall (§10): effective mode is `live` ONLY when all four gates hold
 * (env flag + armed interlock + valid keys + complete limits); every other combination resolves
 * to paper. Plus the arming-interlock safety rows (challenge TTL, single-use/replay, HMAC and
 * bootId binding, 8h session expiry → kill switch, key-probe failure → downgrade).
 *
 * The CI-cannot-reach-live properties (real AppModule boots paper, no LiveExchangeAdapter instance,
 * a live-stamped order is refused, live secrets stripped) are asserted in
 * test/unit/execution/app-module.boot.spec.ts and test/livegate/config-override.spec.ts.
 *
 * Never skip or weaken these to make a suite pass.
 */
import { describe, it, expect } from 'vitest';
import { ModeControlService } from '../../src/modules/mode-control/mode-control.service';
import { computeArmingHmac } from '../../src/modules/mode-control/hmac';
import { KillSwitchService } from '../../src/modules/risk/kill-switch.service';
import { ARMED_SESSION_TTL_MS, CHALLENGE_TTL_MS } from '../../src/domain/mode/arming';
import type {
  ModeControlConfig,
  ModeAuditEvent,
  KeyProbeResult,
  ArmPreconditionResult,
} from '../../src/ports/mode-control';
import { epochMs } from '../../src/domain/types/ids';

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
  const killSwitch = new KillSwitchService();
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

// Drive a real arm: REQUEST → compute the genuine HMAC over the issued challenge → CONFIRM.
function arm(ctx: ReturnType<typeof build>): void {
  const req = ctx.svc.armLive({ step: 'REQUEST', bootId: BOOT });
  if (!req.ok || req.challengeId === undefined) throw new Error('REQUEST failed');
  const hmacHex = computeArmingHmac(req.challengeId, BOOT, SECRET);
  const res = ctx.svc.armLive({
    step: 'CONFIRM',
    challengeId: req.challengeId,
    hmacHex,
    bootId: BOOT,
  });
  if (!res.ok) throw new Error('CONFIRM failed: ' + res.reason);
}

describe('LIVE-GATE MATRIX — 2⁴ effective-mode truth table', () => {
  // Gate (a) IS the requested TRADING_MODE (design §581 — there is no env flag independent of the
  // requested mode), so the `env` axis sets cfg.requested: env=false ⇒ requested=paper ⇒ paper
  // outright. The independent ENV_FLAG-downgrade reason (requested=live but the flag absent) is a
  // pure-reducer concern asserted in test/unit/domain/mode/resolution.spec.ts. Only all-true → live.
  const axes = [false, true];
  for (const env of axes)
    for (const armed of axes)
      for (const keys of axes)
        for (const limits of axes) {
          const allTrue = env && armed && keys && limits;
          const expected = allTrue ? 'live' : 'paper';
          it(`env=${env} armed=${armed} keys=${keys} limits=${limits} → ${expected}`, async () => {
            const ctx = build({ requested: env ? 'live' : 'paper', limitsComplete: limits });
            if (keys) {
              ctx.setProbe(validProbe);
              await ctx.svc.refreshKeyProbe();
            }
            if (armed) arm(ctx);
            expect(ctx.svc.resolveMode().effective).toBe(expected);
          });
        }
});

describe('LIVE-GATE MATRIX — arming interlock safety rows', () => {
  it('S3 restart: a confirm bound to a different bootId is refused (captured-token defence)', () => {
    const ctx = build({ requested: 'live' });
    const req = ctx.svc.armLive({ step: 'REQUEST', bootId: BOOT });
    const proofForOtherBoot = computeArmingHmac(
      (req as { challengeId: string }).challengeId,
      'boot-2',
      SECRET,
    );
    const res = ctx.svc.armLive({
      step: 'CONFIRM',
      challengeId: (req as { challengeId: string }).challengeId,
      hmacHex: proofForOtherBoot,
      bootId: 'boot-2',
    });
    expect(res.ok).toBe(false);
    expect(ctx.svc.resolveMode().effective).toBe('paper'); // never armed
  });

  it('S4 challenge TTL: a confirm after the 60s window is refused', () => {
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

  it('S5 single-use: a replayed confirm after arming is refused', () => {
    const ctx = build({ requested: 'live' });
    arm(ctx);
    const res = ctx.svc.armLive({ step: 'CONFIRM', challengeId: 'x', hmacHex: 'ab', bootId: BOOT });
    expect(res).toEqual({ ok: false, reason: 'REPLAY' });
  });

  it('S6 HMAC mismatch: a bad proof is refused and never arms', () => {
    const ctx = build({ requested: 'live' });
    ctx.svc.armLive({ step: 'REQUEST', bootId: BOOT });
    const res = ctx.svc.armLive({
      step: 'CONFIRM',
      challengeId: 'x',
      hmacHex: 'deadbeef',
      bootId: BOOT,
    });
    expect(res).toEqual({ ok: false, reason: 'HMAC_MISMATCH' });
    expect(ctx.svc.resolveMode().effective).toBe('paper');
  });

  it('S7 8h armed-session TTL: expiry disarms AND engages the kill switch (operator notices)', () => {
    const ctx = build({ requested: 'live' });
    ctx.setProbe(validProbe);
    arm(ctx);
    ctx.setNow(T + ARMED_SESSION_TTL_MS + 1);
    ctx.svc.resolveMode(); // lazy tick detects the expiry
    expect(ctx.killSwitch.state()).toBe('HALTING');
    expect(ctx.events.some((e) => e.type === 'disarmed' && e.trigger === 'TTL')).toBe(true);
    expect(ctx.svc.resolveMode().effective).toBe('paper');
  });

  it('S9 key-probe failure mid-session: downgrades AND engages the kill switch', async () => {
    const ctx = build({ requested: 'live' });
    ctx.setProbe(validProbe);
    await ctx.svc.refreshKeyProbe();
    arm(ctx);
    expect(ctx.svc.resolveMode().effective).toBe('live'); // fully armed + valid keys
    ctx.setProbe(invalidProbe);
    await ctx.svc.refreshKeyProbe(); // restriction probe now fails (e.g. withdrawals enabled)
    expect(ctx.killSwitch.state()).toBe('HALTING');
    expect(ctx.svc.resolveMode().effective).toBe('paper');
  });

  it('arming requires the kill switch RUNNING (arm last) — a halted switch refuses confirm', () => {
    const ctx = build({ requested: 'live' });
    ctx.svc.armLive({ step: 'REQUEST', bootId: BOOT });
    ctx.killSwitch.engage('reconcile mismatch', false);
    const res = ctx.svc.armLive({ step: 'CONFIRM', challengeId: 'x', hmacHex: 'ab', bootId: BOOT });
    expect(res).toEqual({ ok: false, reason: 'PRECONDITION' });
  });
});
