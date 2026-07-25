import { describe, it, expect } from 'vitest';
import {
  ExecQualityService,
  type ExecQualityEntryAttempt,
  type ExecQualityPriceLookup,
} from '../../../../src/features/strategy/agentic/exec-quality.service';

const SYMBOL = 'BTC/USDT';

// resolutionBars=1 / barIntervalMs=1000 throughout: resolveAt = terminalAt + 1000, a small, exact
// offset that keeps every fixture's arithmetic readable without exercising the (documented, defaults-
// only) 15m production constants — those are covered by construction, not by these fixtures.
function makeService(prices: Record<number, string>, now: { current: number }): ExecQualityService {
  const lookup: ExecQualityPriceLookup = (_symbol, atOrAfterMs) => prices[atOrAfterMs];
  return new ExecQualityService({
    priceLookup: lookup,
    nowFn: () => now.current,
    resolutionBars: 1,
    barIntervalMs: 1000,
  });
}

function baseAttempt(overrides: Partial<ExecQualityEntryAttempt> = {}): ExecQualityEntryAttempt {
  return {
    symbol: SYMBOL,
    side: 'long',
    style: 'maker',
    limitPrice: '100',
    outcome: 'filled',
    fillPrice: '100',
    terminalAt: 0,
    ...overrides,
  };
}

// A filler whose resolveAt (terminalAt + 1000 = 1_000_001_000) is never reached by any `now` value
// these specs set — it counts toward the window (n, fill rate) but never resolves into the
// missed-move/adverse-drift averages, isolating each exactness assertion to the one attempt under
// test.
function unresolvedFiller(): ExecQualityEntryAttempt {
  return baseAttempt({ terminalAt: 1_000_000_000 });
}

describe('ExecQualityService.digest', () => {
  it('stays undefined below MIN_ATTEMPTS_FOR_DIGEST, then renders once the threshold is reached', () => {
    const now = { current: 0 };
    const svc = makeService({}, now);
    for (let i = 0; i < 4; i++) svc.recordEntryAttempt(unresolvedFiller());
    expect(svc.digest()).toBeUndefined();
    svc.recordEntryAttempt(unresolvedFiller());
    expect(svc.digest()).toBeDefined();
  });

  it('computes exact fill rate, missed-move bps, and adverse-drift bps over a mixed window (digest string snapshot)', () => {
    const now = { current: 0 };
    const prices: Record<number, string> = {
      1000: '100', // the 4 filled fillers resolve here: fillPrice 100 vs later 100 -> 0 drift each
      2000: '101', // the expired attempt's resolution price: limit 100 -> 101 -> +100bps missed
    };
    const svc = makeService(prices, now);
    for (let i = 0; i < 4; i++) svc.recordEntryAttempt(baseAttempt({ terminalAt: 0 }));
    svc.recordEntryAttempt(
      baseAttempt({ terminalAt: 1000, outcome: 'expired', fillPrice: undefined }),
    );

    now.current = 3000; // past both attempts' resolveAt
    expect(svc.digest()).toBe(
      'execQuality: fillRate=80.0% missedMoveBps=100.0 adverseDriftBps=0.0 n=5',
    );
  });

  it('scores an expired unfilled entry against a favorable forward run with exact missed-move bps', () => {
    const now = { current: 0 };
    const svc = makeService({ 2000: '103' }, now);
    for (let i = 0; i < 4; i++) svc.recordEntryAttempt(unresolvedFiller());
    svc.recordEntryAttempt(
      baseAttempt({ terminalAt: 1000, outcome: 'expired', fillPrice: undefined }),
    );

    now.current = 3000;
    // long limit 100, price ran to 103 (1 resolution bar later) while unfilled -> +300bps missed;
    // adverseDriftBps stays n/a — no filled attempt ever resolves in this fixture.
    expect(svc.digest()).toBe(
      'execQuality: fillRate=80.0% missedMoveBps=300.0 adverseDriftBps=n/a n=5',
    );
  });

  it('computes post-fill adverse drift exactly for a single resolved fill', () => {
    const now = { current: 0 };
    const svc = makeService({ 2000: '98' }, now);
    for (let i = 0; i < 4; i++) svc.recordEntryAttempt(unresolvedFiller());
    svc.recordEntryAttempt(baseAttempt({ terminalAt: 1000 })); // fillPrice '100', resolves at 2000

    now.current = 3000;
    // long fill at 100, price dropped to 98 one resolution bar later -> -200bps raw move, negated to
    // +200bps adverse (a loss against the long side taken).
    expect(svc.digest()).toBe(
      'execQuality: fillRate=100.0% missedMoveBps=n/a adverseDriftBps=200.0 n=5',
    );
  });

  it('scores a favorable post-fill move as clean (negative adverse-drift bps)', () => {
    const now = { current: 0 };
    const svc = makeService({ 2000: '102' }, now);
    for (let i = 0; i < 4; i++) svc.recordEntryAttempt(unresolvedFiller());
    svc.recordEntryAttempt(baseAttempt({ terminalAt: 1000 }));

    now.current = 3000;
    // long fill at 100, price ran to 102 -> +200bps raw favorable move, negated to -200bps adverse
    // (i.e. clean — the fill was followed by a gain, not a drawdown).
    expect(svc.digest()).toBe(
      'execQuality: fillRate=100.0% missedMoveBps=n/a adverseDriftBps=-200.0 n=5',
    );
  });

  it('leaves a due-but-unavailable resolution pending (excluded from bps stats, still counted in n)', () => {
    const now = { current: 0 };
    const svc = makeService({}, now); // priceLookup never has a price configured
    for (let i = 0; i < 4; i++) svc.recordEntryAttempt(baseAttempt({ terminalAt: 0 }));
    svc.recordEntryAttempt(
      baseAttempt({ terminalAt: 1000, outcome: 'expired', fillPrice: undefined }),
    );

    now.current = 5000; // well past every resolveAt, but no forward price is available for any of them
    expect(svc.digest()).toBe(
      'execQuality: fillRate=80.0% missedMoveBps=n/a adverseDriftBps=n/a n=5',
    );
  });

  it('scopes fill rate to maker attempts only (a taker attempt always resolves as filled)', () => {
    const now = { current: 0 };
    const svc = makeService({}, now);
    // 4 maker attempts, 1 filled + 3 expired -> maker fill rate 25% if taker were excluded correctly.
    svc.recordEntryAttempt(baseAttempt({ terminalAt: 1_000_000_000 }));
    for (let i = 0; i < 3; i++) {
      svc.recordEntryAttempt(
        baseAttempt({ terminalAt: 1_000_000_000, outcome: 'expired', fillPrice: undefined }),
      );
    }
    // A taker attempt (always filled) that would inflate the rate to 40% (2/5) if wrongly counted.
    svc.recordEntryAttempt(baseAttempt({ terminalAt: 1_000_000_000, style: 'taker' }));

    expect(svc.digest()).toBe(
      'execQuality: fillRate=25.0% missedMoveBps=n/a adverseDriftBps=n/a n=5',
    );
  });
});
