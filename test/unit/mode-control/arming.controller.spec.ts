import { describe, it, expect } from 'vitest';
import { ArmingController } from '../../../src/features/trading/mode-control/arming.controller';
import type { ModeControlPort, ArmRequest } from '../../../src/ports/mode-control';

// The controller is pure delegation (transport binding + auth are deferred runtime glue). These
// tests pin that each endpoint forwards the right ArmRequest shape and nothing else.
function fakeService() {
  const calls: ArmRequest[] = [];
  const disarms: string[] = [];
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
  };
  return { svc, calls, disarms };
}

describe('ArmingController', () => {
  it('POST arm/request → armLive REQUEST with the posted bootId', () => {
    const { svc, calls } = fakeService();
    const res = new ArmingController(svc).request({ bootId: 'boot-1' });
    expect(calls).toEqual([{ step: 'REQUEST', bootId: 'boot-1' }]);
    expect(res).toEqual({ ok: true, challengeId: 'c1' });
  });

  it('POST arm/confirm → armLive CONFIRM with challengeId/hmac/bootId', () => {
    const { svc, calls } = fakeService();
    const res = new ArmingController(svc).confirm({
      challengeId: 'c1',
      hmacHex: 'ab',
      bootId: 'boot-1',
    });
    expect(calls).toEqual([
      { step: 'CONFIRM', challengeId: 'c1', hmacHex: 'ab', bootId: 'boot-1' },
    ]);
    expect(res).toEqual({ ok: true });
  });

  it('POST disarm → disarm(MANUAL)', () => {
    const { svc, disarms } = fakeService();
    new ArmingController(svc).disarm();
    expect(disarms).toEqual(['MANUAL']);
  });
});
