import { describe, expect, it, vi } from 'vitest';
import { epochMs, symbolId, venueId } from '../../../../src/domain/common/types/ids';
import { price, qty } from '../../../../src/domain/common/types/money';
import { EdgeCohortPinState } from '../../../../src/features/strategy/agentic/edge-cohort-pin-state';
import {
  rankResidualCohort,
  ResidualVolbetaEdgePolicy,
  trailingReturn,
  type DailyCloseSeries,
} from '../../../../src/features/strategy/agentic/residual-volbeta-edge-policy';
import type { FeedHealthPort } from '../../../../src/ports/venue/market-data';
import type { CandleEvent } from '../../../../src/domain/venue/types/market-events';

const DAY = 86_400_000;
const START = Date.parse('2024-01-01T00:00:00.000Z');
const VENUE = venueId('binanceusdm');

function seriesFromCloses(closes: number[]): DailyCloseSeries {
  return {
    timestamps: closes.map((_, i) => START + i * DAY),
    closes,
  };
}

/** Geometric path so residual ranking tracks excess return vs BTC cleanly. */
function geo(n: number, start: number, dailyRet: number): number[] {
  const out: number[] = [start];
  for (let i = 1; i < n; i += 1) out.push(out[i - 1]! * (1 + dailyRet));
  return out;
}

function mkBars(dailyRet: number, symbol: string): CandleEvent[] {
  const closes = geo(100, 100, dailyRet);
  return closes.map((c, i) => {
    const t = epochMs(START + i * DAY);
    const px = price(String(c));
    return {
      kind: 'CANDLE',
      venue: VENUE,
      symbol: symbolId(symbol),
      eventTime: t,
      channel: 'candles',
      seq: BigInt(i),
      ingestTime: t,
      interval: '1d' as const,
      openTime: t,
      closeTime: epochMs(Number(t) + DAY - 1),
      open: px,
      high: px,
      low: px,
      close: px,
      volume: qty('1'),
      closed: true,
    } as unknown as CandleEvent;
  });
}

describe('residual ranking helpers', () => {
  it('computes trailing return over lookback', () => {
    const closes = [100, 110];
    const ret = trailingReturn(closes, 1, 1);
    expect(ret).not.toBeNull();
    expect(ret! > 0).toBe(true);
    expect(ret! < 0.2).toBe(true);
  });

  it('ranks residual cohort long top-2 / short bottom-2', () => {
    const n = 100;
    const bySymbol = new Map<string, DailyCloseSeries>([
      ['BTC/USDT:USDT', seriesFromCloses(geo(n, 100, 0.001))],
      ['HOT/USDT:USDT', seriesFromCloses(geo(n, 100, 0.01))],
      ['WARM/USDT:USDT', seriesFromCloses(geo(n, 100, 0.005))],
      ['COLD/USDT:USDT', seriesFromCloses(geo(n, 100, 0.0005))],
      ['FROZEN/USDT:USDT', seriesFromCloses(geo(n, 100, -0.005))],
    ]);
    const ranked = rankResidualCohort(bySymbol);
    expect(ranked).not.toBeNull();
    expect(ranked!.longs).toHaveLength(2);
    expect(ranked!.shorts).toHaveLength(2);
    expect(ranked!.members).toHaveLength(4);
    expect(new Set([...ranked!.longs, ...ranked!.shorts]).size).toBe(4);
    expect(ranked!.longs).toContain('HOT/USDT:USDT');
    expect(ranked!.shorts).toContain('FROZEN/USDT:USDT');
  });
});

describe('ResidualVolbetaEdgePolicy', () => {
  it('stays inactive until refresh succeeds', () => {
    const pin = new EdgeCohortPinState();
    const feed: FeedHealthPort = {
      health: () => 'LIVE',
      getRefPrice: () => undefined,
      updateRefPrice: () => undefined,
      fetchCandles: vi.fn(() => Promise.resolve([] as CandleEvent[])),
    };
    const policy = new ResidualVolbetaEdgePolicy({
      feedHealth: feed,
      symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
      now: () => epochMs(START),
      pinState: pin,
      logger: { warn: () => undefined },
    });
    const snap = policy.snapshot({
      symbol: symbolId('BTC/USDT:USDT'),
      eventTime: epochMs(START),
    });
    expect(snap.active).toBe(false);
  });

  it('activates after successful refresh with eligible series', async () => {
    const pin = new EdgeCohortPinState();
    const feed: FeedHealthPort = {
      health: () => 'LIVE',
      getRefPrice: () => undefined,
      updateRefPrice: () => undefined,
      fetchCandles: vi.fn((_v, sym) => {
        const s = String(sym);
        if (s.startsWith('BTC')) return Promise.resolve(mkBars(0.001, s));
        if (s.startsWith('ETH')) return Promise.resolve(mkBars(0.008, s));
        if (s.startsWith('SOL')) return Promise.resolve(mkBars(0.005, s));
        if (s.startsWith('XRP')) return Promise.resolve(mkBars(0.0004, s));
        return Promise.resolve(mkBars(-0.004, s));
      }),
    };

    const policy = new ResidualVolbetaEdgePolicy({
      feedHealth: feed,
      symbols: [
        'BTC/USDT:USDT',
        'ETH/USDT:USDT',
        'SOL/USDT:USDT',
        'XRP/USDT:USDT',
        'ZEC/USDT:USDT',
      ],
      now: () => epochMs(START + 100 * DAY),
      pinState: pin,
      logger: { warn: () => undefined, log: () => undefined },
    });
    await policy.refresh();
    const eth = policy.snapshot({
      symbol: symbolId('ETH/USDT:USDT'),
      eventTime: epochMs(START + 100 * DAY),
    });
    expect(eth.active).toBe(true);
    if (eth.active) {
      expect(eth.familyId).toBe('residual20-volbeta');
      expect(eth.maxSizeFraction).toBe('0.10');
      expect(eth.cohort.members.length).toBe(4);
      expect(pin.symbols().length).toBe(4);
    }
  });
});

// Scope-aware eligibility (Pass 72). The family ranks PERPS ONLY, so a spot symbol is never scored,
// yet snapshot() reported {long:false, short:false} for it — "never evaluated" encoded identically to
// "evaluated and excluded". These cases pin BOTH halves of the two-step: flag off must reproduce the
// old payload exactly (it is what makes "this ship touches no measurement window" a tested claim
// rather than an assertion), and flag on must spare a mid-pack PERP, which is the case that separates
// a correct fix from one that just keys on cohort membership.
describe('ResidualVolbetaEdgePolicy — scope-aware eligibility', () => {
  const SYMBOLS = [
    'BTC/USDT:USDT',
    'ETH/USDT:USDT',
    'SOL/USDT:USDT',
    'XRP/USDT:USDT',
    'ZEC/USDT:USDT',
    'PEPE/USDT', // spot — never fetched, never scored
  ];
  const AT = epochMs(START + 100 * DAY);

  function mkPolicy(scopeAware?: boolean): {
    policy: ResidualVolbetaEdgePolicy;
    pin: EdgeCohortPinState;
  } {
    const pin = new EdgeCohortPinState();
    const feed: FeedHealthPort = {
      health: () => 'LIVE',
      getRefPrice: () => undefined,
      updateRefPrice: () => undefined,
      fetchCandles: vi.fn((_v, sym) => {
        const s = String(sym);
        if (s.startsWith('BTC')) return Promise.resolve(mkBars(0.001, s));
        if (s.startsWith('ETH')) return Promise.resolve(mkBars(0.008, s));
        if (s.startsWith('SOL')) return Promise.resolve(mkBars(0.005, s));
        if (s.startsWith('XRP')) return Promise.resolve(mkBars(0.0004, s));
        return Promise.resolve(mkBars(-0.004, s));
      }),
    };
    return {
      pin,
      policy: new ResidualVolbetaEdgePolicy({
        feedHealth: feed,
        symbols: SYMBOLS,
        now: () => AT,
        pinState: pin,
        ...(scopeAware === undefined ? {} : { scopeAware }),
        logger: { warn: () => undefined, log: () => undefined },
      }),
    };
  }

  it('rankResidualCohort reports the evaluated universe, which is wider than the cohort', () => {
    const n = 100;
    const ranked = rankResidualCohort(
      new Map<string, DailyCloseSeries>([
        ['BTC/USDT:USDT', seriesFromCloses(geo(n, 100, 0.001))],
        ['HOT/USDT:USDT', seriesFromCloses(geo(n, 100, 0.01))],
        ['WARM/USDT:USDT', seriesFromCloses(geo(n, 100, 0.005))],
        ['COLD/USDT:USDT', seriesFromCloses(geo(n, 100, 0.0005))],
        ['FROZEN/USDT:USDT', seriesFromCloses(geo(n, 100, -0.005))],
      ]),
    );
    expect(ranked).not.toBeNull();
    // 5 scored, but only 4 in the cohort — the gap is exactly the mid-pack symbol whose
    // {false,false} is a real verdict and must survive scope-awareness.
    expect([...ranked!.evaluated].sort()).toEqual([
      'BTC/USDT:USDT',
      'COLD/USDT:USDT',
      'FROZEN/USDT:USDT',
      'HOT/USDT:USDT',
      'WARM/USDT:USDT',
    ]);
    expect(ranked!.members).toHaveLength(4);
  });

  it('flag OFF: spot and perp payloads are byte-identical to the pre-knob shape', async () => {
    const { policy } = mkPolicy(false);
    await policy.refresh();

    // The pre-knob payload for an unevaluated SPOT symbol: ACTIVE, with both sides false — the exact
    // shape this fix exists to stop emitting, pinned here so the flag-off half cannot drift. Key
    // ORDER is asserted too, since that is what JSON.stringify byte-identity actually turns on; the
    // cohort's float-derived scores are structural rather than literal (they come from the fixture's
    // geometric paths, so hardcoding them would test the fixture, not the payload).
    const spot = policy.snapshot({ symbol: symbolId('PEPE/USDT'), eventTime: AT });
    expect(Object.keys(spot)).toEqual([
      'active',
      'familyId',
      'cohort',
      'sideEligibility',
      'maxSizeFraction',
    ]);
    expect(spot.active).toBe(true);
    if (spot.active) {
      expect(spot.familyId).toBe('residual20-volbeta');
      expect(spot.sideEligibility).toEqual({ long: false, short: false });
      expect(spot.maxSizeFraction).toBe('0.10');
      expect(spot.cohort.members).toHaveLength(4);
    }
    // And for a cohort PERP, unchanged.
    const eth = policy.snapshot({ symbol: symbolId('ETH/USDT:USDT'), eventTime: AT });
    expect(eth.active).toBe(true);
    if (eth.active) expect(eth.sideEligibility).toEqual({ long: true, short: false });
  });

  it('flag ABSENT behaves exactly as flag OFF (failure direction is OFF)', async () => {
    const off = mkPolicy(false);
    const absent = mkPolicy(undefined);
    await off.policy.refresh();
    await absent.policy.refresh();
    expect(
      JSON.stringify(absent.policy.snapshot({ symbol: symbolId('PEPE/USDT'), eventTime: AT })),
    ).toBe(JSON.stringify(off.policy.snapshot({ symbol: symbolId('PEPE/USDT'), eventTime: AT })));
  });

  it('flag ON: an unevaluated spot symbol reports INACTIVE, so the block is omitted', async () => {
    const { policy } = mkPolicy(true);
    await policy.refresh();
    expect(policy.snapshot({ symbol: symbolId('PEPE/USDT'), eventTime: AT }).active).toBe(false);
  });

  it('flag ON: a scored mid-pack PERP stays ACTIVE with both sides false', async () => {
    const { policy } = mkPolicy(true);
    await policy.refresh();
    // 5 perps scored, cohort is top-2 + bottom-2, so exactly one perp is mid-pack. It was evaluated
    // and excluded — a real verdict, and it must NOT collapse into the inactive branch.
    const midPack = SYMBOLS.filter((s) => s.includes(':')).find((s) => {
      const snap = policy.snapshot({ symbol: symbolId(s), eventTime: AT });
      return snap.active && !snap.sideEligibility.long && !snap.sideEligibility.short;
    });
    expect(midPack).toBeDefined();
    const snap = policy.snapshot({ symbol: symbolId(midPack!), eventTime: AT });
    expect(snap.active).toBe(true);
    if (snap.active) expect(snap.sideEligibility).toEqual({ long: false, short: false });
  });

  it('flag ON: cohort perps keep their eligibility', async () => {
    const { policy } = mkPolicy(true);
    await policy.refresh();
    const eth = policy.snapshot({ symbol: symbolId('ETH/USDT:USDT'), eventTime: AT });
    expect(eth.active).toBe(true);
    if (eth.active) expect(eth.sideEligibility).toEqual({ long: true, short: false });
    const zec = policy.snapshot({ symbol: symbolId('ZEC/USDT:USDT'), eventTime: AT });
    expect(zec.active).toBe(true);
    if (zec.active) expect(zec.sideEligibility).toEqual({ long: false, short: true });
  });

  it('flag ON: a failed refresh clears the evaluated set rather than answering from stale state', async () => {
    const pin = new EdgeCohortPinState();
    let starve = false;
    const feed: FeedHealthPort = {
      health: () => 'LIVE',
      getRefPrice: () => undefined,
      updateRefPrice: () => undefined,
      fetchCandles: vi.fn((_v, sym) => {
        if (starve) return Promise.resolve([] as CandleEvent[]);
        const s = String(sym);
        if (s.startsWith('BTC')) return Promise.resolve(mkBars(0.001, s));
        if (s.startsWith('ETH')) return Promise.resolve(mkBars(0.008, s));
        if (s.startsWith('SOL')) return Promise.resolve(mkBars(0.005, s));
        if (s.startsWith('XRP')) return Promise.resolve(mkBars(0.0004, s));
        return Promise.resolve(mkBars(-0.004, s));
      }),
    };
    const policy = new ResidualVolbetaEdgePolicy({
      feedHealth: feed,
      symbols: SYMBOLS,
      now: () => AT,
      pinState: pin,
      scopeAware: true,
      logger: { warn: () => undefined, log: () => undefined },
    });
    await policy.refresh();
    expect(policy.snapshot({ symbol: symbolId('ETH/USDT:USDT'), eventTime: AT }).active).toBe(true);
    starve = true;
    await policy.refresh();
    expect(policy.snapshot({ symbol: symbolId('ETH/USDT:USDT'), eventTime: AT }).active).toBe(
      false,
    );
  });
});
