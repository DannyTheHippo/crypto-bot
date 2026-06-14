import { describe, it, expect } from 'vitest';
import { RateBucketsService } from '../../../src/modules/risk/rate-buckets.service';
import type { ClockPort } from '../../../src/ports/clock';
import { epochMs } from '../../../src/domain/types/ids';

function frozenClock(t = 1000): ClockPort {
  return { now: () => epochMs(t) };
}

describe('RateBucketsService (§5 R1)', () => {
  it('uses the reserved flatten bucket independently and never reports runaway for flatten', () => {
    const svc = new RateBucketsService(frozenClock());
    let last = svc.check('BTC/USDT', 's', true);
    for (let i = 0; i < 4; i++) last = svc.check('BTC/USDT', 's', true);
    expect(last.allowed).toBe(true); // within flatten capacity (5)
    const denied = svc.check('BTC/USDT', 's', true); // 6th → empty
    expect(denied.allowed).toBe(false);
    expect(denied.runaway).toBe(false);
  });

  it('requires global+symbol+strategy capacity; the per-symbol cap (2) binds first', () => {
    const svc = new RateBucketsService(frozenClock());
    expect(svc.check('BTC/USDT', 's', false).allowed).toBe(true);
    expect(svc.check('BTC/USDT', 's', false).allowed).toBe(true);
    expect(svc.check('BTC/USDT', 's', false).allowed).toBe(false); // symbol bucket empty
  });

  it('escalates to runaway after ≥25 rejects in the window', () => {
    const svc = new RateBucketsService(frozenClock());
    svc.check('BTC/USDT', 's', false); // 2 allowed exhaust the symbol bucket
    svc.check('BTC/USDT', 's', false);
    let runaway = false;
    for (let i = 0; i < 25; i++) runaway = svc.check('BTC/USDT', 's', false).runaway;
    expect(runaway).toBe(true); // 25th reject trips the escalation
  });

  it('drops rejects outside the 5s window so transient bursts do not escalate', () => {
    let t = 1000;
    const svc = new RateBucketsService({ now: () => epochMs(t) });
    svc.check('BTC/USDT', 's', false);
    svc.check('BTC/USDT', 's', false);
    for (let i = 0; i < 20; i++) svc.check('BTC/USDT', 's', false); // 20 rejects at t=1000
    t = 10_000; // far past the 5s window
    const r = svc.check('ETH/USDT', 'x', false); // new symbol allowed; old rejects expired
    expect(r.runaway).toBe(false);
  });
});
