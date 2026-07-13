import { describe, it, expect } from 'vitest';
import {
  DerivativesFeedService,
  type DerivativesRestSource,
} from '../../../src/features/trading/market-data/derivatives-feed.service';
import type { ClockPort } from '../../../src/ports/clock';
import { symbolId, epochMs } from '../../../src/domain/types/ids';

const SYM = symbolId('BTC/USDT');

// Derivatives snapshot values are display-grade floats (like order-book levels), not money — but
// the blanket toBeCloseTo ban is syntactic, so this reproduces its tolerance semantics locally
// (same pattern as test/backtest/indicators.spec.ts).
function expectCloseTo(actual: number, expected: number, precision: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(Math.pow(10, -precision) / 2);
}

function mutableClock(start = 1_000_000): { clock: ClockPort; set: (t: number) => void } {
  let t = start;
  return { clock: { now: () => epochMs(t) }, set: (n) => (t = n) };
}

// A fixture double implementing the minimal ccxt REST surface the service needs — no network,
// mirrors OhlcvSource fakes in feed-health.spec.ts. Records every symbol it was called with so
// tests can assert the spot->perp symbol translation (perpSymbolFor).
function fixtureSource(
  overrides: {
    fundingRate?: string | number;
    markPrice?: string | number;
    indexPrice?: string | number;
    interval?: string;
    openInterestAmount?: string | number;
    failFunding?: boolean;
    failOi?: boolean;
    // d2: absent by default (mirrors a pre-v2 fixture/double) — supplying it opts a test into the
    // spot-perp basis path; failTicker exercises the "spot fetch failure fails the whole poll" path.
    spotLast?: string | number;
    failTicker?: boolean;
  } = {},
): DerivativesRestSource & { calledSymbols: string[] } {
  const calledSymbols: string[] = [];
  return {
    calledSymbols,
    fetchFundingRate: (symbol: string) => {
      calledSymbols.push(symbol);
      if (overrides.failFunding) return Promise.reject(new Error('funding rate fetch failed'));
      // Defaults are STRINGS: under `number: String` (production construction) ccxt returns every
      // parsed numeric as a string — the fixture must reproduce that shape, not the .d.ts's.
      return Promise.resolve({
        fundingRate: overrides.fundingRate ?? '0.0001',
        markPrice: overrides.markPrice ?? '100.5',
        indexPrice: overrides.indexPrice ?? '100',
        interval: overrides.interval,
      });
    },
    fetchOpenInterest: (symbol: string) => {
      calledSymbols.push(symbol);
      if (overrides.failOi) return Promise.reject(new Error('open interest fetch failed'));
      return Promise.resolve({ openInterestAmount: overrides.openInterestAmount ?? '12345' });
    },
    ...(overrides.spotLast !== undefined || overrides.failTicker
      ? {
          fetchTicker: (symbol: string) => {
            calledSymbols.push(symbol);
            if (overrides.failTicker) return Promise.reject(new Error('ticker fetch failed'));
            return Promise.resolve({ last: overrides.spotLast });
          },
        }
      : {}),
  };
}

describe('DerivativesFeedService', () => {
  it('parses a fixture funding+open-interest payload into a snapshot with computed basis and annualized funding', async () => {
    const { clock } = mutableClock();
    const source = fixtureSource({
      fundingRate: '0.0001',
      markPrice: '100.5',
      indexPrice: '100',
      interval: '8h',
      openInterestAmount: '5000',
    });
    const svc = new DerivativesFeedService(source, {
      symbols: [SYM],
      pollIntervalMs: 60_000,
      clock,
    });

    await svc.pollAll();
    const snap = svc.latest(SYM);

    expect(snap).not.toBeNull();
    expect(snap!.fundingRate).toBe(0.0001);
    // 8h interval -> 3 periods/day * 365 = 1095 periods/year
    expectCloseTo(snap!.fundingAnnualizedPct, 0.0001 * 1095 * 100, 10);
    expect(snap!.openInterest).toBe(5000);
    // (100.5 - 100) / 100 * 10000 = 50 bps
    expectCloseTo(snap!.basisBps, 50, 10);
    expect(snap!.asOf).toBe(1_000_000);
    // d2 fields: null on the very first poll (no ring-buffer history yet, no fetchTicker supplied by
    // this fixture) — accumulation always runs, but a single sample can never yield a trend.
    expect(snap!.spotPerpBasisBps).toBeNull();
    expect(snap!.oiChangePct).toBeNull();
    expect(snap!.fundingTrendDelta).toBeNull();
    expect(snap!.fundingTrendDirection).toBeNull();
  });

  it('translates a spot symbol (BASE/QUOTE) to the ccxt linear-swap perp form (BASE/QUOTE:QUOTE) before polling', async () => {
    const { clock } = mutableClock();
    const source = fixtureSource();
    const svc = new DerivativesFeedService(source, {
      symbols: [SYM],
      pollIntervalMs: 60_000,
      clock,
    });

    await svc.pollAll();

    expect(source.calledSymbols).toContain('BTC/USDT:USDT');
    expect(source.calledSymbols).not.toContain('BTC/USDT');
  });

  it('answers null for a symbol that has never been polled', () => {
    const { clock } = mutableClock();
    const svc = new DerivativesFeedService(fixtureSource(), {
      symbols: [SYM],
      pollIntervalMs: 60_000,
      clock,
    });

    expect(svc.latest(SYM)).toBeNull();
  });

  it('treats a snapshot older than 2x the poll interval as stale (null), never serving outdated data', async () => {
    const { clock, set } = mutableClock(1_000_000);
    const svc = new DerivativesFeedService(fixtureSource(), {
      symbols: [SYM],
      pollIntervalMs: 60_000,
      clock,
    });

    await svc.pollAll();
    expect(svc.latest(SYM)).not.toBeNull();

    set(1_000_000 + 60_000 * 2); // exactly at the threshold — still fresh
    expect(svc.latest(SYM)).not.toBeNull();

    set(1_000_000 + 60_000 * 2 + 1); // just past the threshold — now stale
    expect(svc.latest(SYM)).toBeNull();
  });

  it('a poll failure logs and continues (never throws), incrementing the error counter and leaving latest() null', async () => {
    const { clock } = mutableClock();
    const warnings: string[] = [];
    const svc = new DerivativesFeedService(fixtureSource({ failFunding: true }), {
      symbols: [SYM],
      pollIntervalMs: 60_000,
      clock,
      logger: { warn: (m) => warnings.push(m) },
    });

    await expect(svc.pollAll()).resolves.toBeUndefined();
    expect(svc.latest(SYM)).toBeNull();
    expect(svc.pollErrorCount()).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(svc.lastSuccessfulPollAt()).toBeNull();
  });

  it('a subsequent successful poll after a failure clears the outage (latest() populated, lastSuccessfulPollAt set)', async () => {
    const { clock } = mutableClock(1_000_000);
    let fail = true;
    const source: DerivativesRestSource = {
      fetchFundingRate: () =>
        fail
          ? Promise.reject(new Error('down'))
          : Promise.resolve({ fundingRate: 0.0002, markPrice: 101, indexPrice: 100 }),
      fetchOpenInterest: () => Promise.resolve({ openInterestAmount: 1 }),
    };
    const svc = new DerivativesFeedService(source, {
      symbols: [SYM],
      pollIntervalMs: 60_000,
      clock,
    });

    await svc.pollAll();
    expect(svc.latest(SYM)).toBeNull();
    expect(svc.pollErrorCount()).toBe(1);

    fail = false;
    await svc.pollAll();
    expect(svc.latest(SYM)).not.toBeNull();
    expect(svc.lastSuccessfulPollAt()).toBe(1_000_000);
    expect(svc.pollErrorCount()).toBe(1); // unchanged — no new failure
  });

  it('discards a response missing fundingRate rather than caching a partial/garbage snapshot', async () => {
    const { clock } = mutableClock();
    const source: DerivativesRestSource = {
      fetchFundingRate: () => Promise.resolve({}),
      fetchOpenInterest: () => Promise.resolve({ openInterestAmount: 1 }),
    };
    const svc = new DerivativesFeedService(source, {
      symbols: [SYM],
      pollIntervalMs: 60_000,
      clock,
    });

    await svc.pollAll();

    expect(svc.latest(SYM)).toBeNull();
  });

  // d2 (AGENTIC_DERIVATIVES_V2_ENABLED): the service ALWAYS accumulates the OI/funding ring buffers
  // and computes spotPerpBasisBps whenever the feed itself polls — the flag only gates whether
  // agent-prompt.ts's buildDerivativesBlock renders these fields, tested separately in
  // agent-prompt.spec.ts. This suite covers the field math itself.
  describe('d2 fields (spot-perp basis, OI-change ring buffer, funding trend)', () => {
    it('computes true spot-perp basis ((mark - spotLast) / spotLast in bps) when the source supplies fetchTicker', async () => {
      const { clock } = mutableClock();
      const source = fixtureSource({ markPrice: '101', spotLast: '100' });
      const svc = new DerivativesFeedService(source, {
        symbols: [SYM],
        pollIntervalMs: 60_000,
        clock,
      });

      await svc.pollAll();

      // (101 - 100) / 100 * 10000 = 100 bps
      expectCloseTo(svc.latest(SYM)!.spotPerpBasisBps!, 100, 10);
      expect(source.calledSymbols).toContain('BTC/USDT'); // spot form, not the perp form
    });

    it('spotPerpBasisBps is null when the source has no fetchTicker at all (pre-v2 fixture/double)', async () => {
      const { clock } = mutableClock();
      const svc = new DerivativesFeedService(fixtureSource(), {
        symbols: [SYM],
        pollIntervalMs: 60_000,
        clock,
      });

      await svc.pollAll();

      expect(svc.latest(SYM)!.spotPerpBasisBps).toBeNull();
    });

    it('a fetchTicker failure fails the whole poll (never a silently partial v2-less snapshot)', async () => {
      const { clock } = mutableClock();
      const source = fixtureSource({ spotLast: '100', failTicker: true });
      const svc = new DerivativesFeedService(source, {
        symbols: [SYM],
        pollIntervalMs: 60_000,
        clock,
      });

      await svc.pollAll();

      expect(svc.latest(SYM)).toBeNull();
      expect(svc.pollErrorCount()).toBe(1);
    });

    it('oiChangePct is null until a second sample lands, then reflects the percent change since the oldest retained sample', async () => {
      const { clock, set } = mutableClock(1_000_000);
      let oi = '1000';
      const source: DerivativesRestSource = {
        fetchFundingRate: () =>
          Promise.resolve({ fundingRate: 0.0001, markPrice: 100, indexPrice: 100 }),
        fetchOpenInterest: () => Promise.resolve({ openInterestAmount: oi }),
      };
      const svc = new DerivativesFeedService(source, {
        symbols: [SYM],
        pollIntervalMs: 60_000,
        clock,
      });

      await svc.pollAll();
      expect(svc.latest(SYM)!.oiChangePct).toBeNull();

      set(1_000_000 + 60_000);
      oi = '1100';
      await svc.pollAll();

      // (1100 - 1000) / 1000 * 100 = 10%
      expectCloseTo(svc.latest(SYM)!.oiChangePct!, 10, 10);
    });

    it('the OI ring buffer prunes samples older than the 1h lookback, so the reference point slides forward', async () => {
      const { clock, set } = mutableClock(0);
      let oi = '1000';
      const source: DerivativesRestSource = {
        fetchFundingRate: () =>
          Promise.resolve({ fundingRate: 0.0001, markPrice: 100, indexPrice: 100 }),
        fetchOpenInterest: () => Promise.resolve({ openInterestAmount: oi }),
      };
      const svc = new DerivativesFeedService(source, {
        symbols: [SYM],
        pollIntervalMs: 60_000,
        clock,
      });

      await svc.pollAll(); // t=0, oi=1000 (first sample, becomes the initial reference)

      set(30 * 60_000); // t=30m
      oi = '1200';
      await svc.pollAll(); // reference is still t=0 (within the 1h window)
      expectCloseTo(svc.latest(SYM)!.oiChangePct!, 20, 10); // (1200-1000)/1000*100

      set(90 * 60_000); // t=90m — the t=0 sample is now older than the 1h lookback and gets pruned
      oi = '1260';
      await svc.pollAll(); // new reference is the t=30m sample (oi=1200)
      expectCloseTo(svc.latest(SYM)!.oiChangePct!, 5, 10); // (1260-1200)/1200*100
    });

    it('fundingTrendDelta/Direction are null until a second sample, then report the raw delta and sign', async () => {
      const { clock, set } = mutableClock(1_000_000);
      let funding: number = 0.0001;
      const source: DerivativesRestSource = {
        fetchFundingRate: () =>
          Promise.resolve({ fundingRate: funding, markPrice: 100, indexPrice: 100 }),
        fetchOpenInterest: () => Promise.resolve({ openInterestAmount: 1 }),
      };
      const svc = new DerivativesFeedService(source, {
        symbols: [SYM],
        pollIntervalMs: 60_000,
        clock,
      });

      await svc.pollAll();
      expect(svc.latest(SYM)!.fundingTrendDelta).toBeNull();
      expect(svc.latest(SYM)!.fundingTrendDirection).toBeNull();

      set(1_000_000 + 60_000);
      funding = 0.00005;
      await svc.pollAll();

      expectCloseTo(svc.latest(SYM)!.fundingTrendDelta!, -0.00005, 10);
      expect(svc.latest(SYM)!.fundingTrendDirection).toBe('down');
    });
  });
});
