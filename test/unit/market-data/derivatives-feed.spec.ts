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
});
