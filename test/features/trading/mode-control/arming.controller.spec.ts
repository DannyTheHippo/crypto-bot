import { describe, it, expect } from 'vitest';
import { ArmingController } from '../../../../src/features/trading/mode-control/arming.controller';
import type { ModeControlPort, ArmRequest } from '../../../../src/ports/trading/mode-control';

// The controller is pure delegation (transport binding + auth are deferred runtime glue). These
// tests pin that each endpoint forwards the right ArmRequest shape and nothing else.
// refreshCalls tracks confirm()'s v3 §7.2 "fresh probe at CONFIRM" call — refreshKeyProbe is
// optional on ModeControlPort (real fakes elsewhere never touch arming), so fakeService here always
// provides it to pin the real ArmingController's call-before-armLive ordering.
function fakeService() {
  const calls: ArmRequest[] = [];
  const disarms: string[] = [];
  const refreshCalls: string[] = [];
  const svc: ModeControlPort = {
    resolveMode: () => ({ effective: 'paper', requested: 'paper', downgrades: [] }),
    armLive: (req) => {
      calls.push(req);
      return req.step === 'REQUEST' ? { ok: true, challengeId: 'c1' } : { ok: true };
    },
    disarm: (t) => {
      disarms.push(t);
    },
    assertCanTrade: () => undefined,
    refreshKeyProbe: () => {
      refreshCalls.push('refreshed');
      return Promise.resolve();
    },
  };
  return { svc, calls, disarms, refreshCalls };
}

describe('ArmingController', () => {
  it('POST arm/request → armLive REQUEST with the posted bootId', () => {
    const { svc, calls } = fakeService();
    const res = new ArmingController(svc).request({ bootId: 'boot-1' });
    expect(calls).toEqual([{ step: 'REQUEST', bootId: 'boot-1' }]);
    expect(res).toEqual({ ok: true, challengeId: 'c1' });
  });

  it('POST arm/confirm → refreshes the key probe THEN calls armLive CONFIRM with challengeId/hmac/bootId', async () => {
    const { svc, calls, refreshCalls } = fakeService();
    const res = await new ArmingController(svc).confirm({
      challengeId: 'c1',
      hmacHex: 'ab',
      bootId: 'boot-1',
    });
    expect(refreshCalls).toEqual(['refreshed']);
    expect(calls).toEqual([
      { step: 'CONFIRM', challengeId: 'c1', hmacHex: 'ab', bootId: 'boot-1' },
    ]);
    expect(res).toEqual({ ok: true });
  });

  it('POST arm/confirm tolerates a ModeControlPort without refreshKeyProbe (optional-chained)', async () => {
    const { svc, calls } = fakeService();
    const withoutRefresh = { ...svc };
    delete withoutRefresh.refreshKeyProbe;
    const res = await new ArmingController(withoutRefresh).confirm({
      challengeId: 'c1',
      hmacHex: 'ab',
      bootId: 'boot-1',
    });
    expect(calls.length).toBe(1);
    expect(res).toEqual({ ok: true });
  });

  it('POST disarm → disarm(MANUAL)', () => {
    const { svc, disarms } = fakeService();
    new ArmingController(svc).disarm();
    expect(disarms).toEqual(['MANUAL']);
  });
});
