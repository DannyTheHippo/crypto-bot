import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  computeHoldReturnFraction,
  computeEqualWeightBasketReturnFraction,
  computeAlphaBps,
  computeBasketBtcBeta,
  BTC_BENCHMARK_SYMBOL,
  type BenchmarkCandle,
} from '../../../src/features/trading/agentic/benchmark-alpha';

const T = 1_700_000_000_000;

function candle(index: number, close: string): BenchmarkCandle {
  return { eventTime: T + index * 3_600_000, close };
}

describe('computeHoldReturnFraction', () => {
  it('computes a buy-and-hold return fraction from the first to the last candle in the series', () => {
    const candles = [candle(0, '100'), candle(1, '105'), candle(2, '102')];
    const result = computeHoldReturnFraction(candles);
    expect(result).not.toBeNull();
    expect(result!.toFixed()).toBe('0.02'); // (102-100)/100
  });

  it('returns null with fewer than 2 candles', () => {
    expect(computeHoldReturnFraction([])).toBeNull();
    expect(computeHoldReturnFraction([candle(0, '100')])).toBeNull();
  });

  it('returns null when the first close is zero (division floor)', () => {
    expect(computeHoldReturnFraction([candle(0, '0'), candle(1, '10')])).toBeNull();
  });
});

describe('computeEqualWeightBasketReturnFraction', () => {
  it("averages each symbol's own hold-return fraction", () => {
    const perSymbol = new Map<string, readonly BenchmarkCandle[]>([
      ['BTC/USDT', [candle(0, '100'), candle(1, '110')]], // +10%
      ['ETH/USDT', [candle(0, '100'), candle(1, '90')]], // -10%
    ]);
    const result = computeEqualWeightBasketReturnFraction(perSymbol);
    expect(result!.toFixed()).toBe('0'); // (+0.1 + -0.1) / 2
  });

  it('excludes symbols with too few candles rather than zeroing them', () => {
    const perSymbol = new Map<string, readonly BenchmarkCandle[]>([
      ['BTC/USDT', [candle(0, '100'), candle(1, '120')]], // +20%
      ['ETH/USDT', [candle(0, '100')]], // insufficient — excluded, not treated as 0
    ]);
    const result = computeEqualWeightBasketReturnFraction(perSymbol);
    expect(result!.toFixed()).toBe('0.2');
  });

  it('returns null when no symbol has a defined return', () => {
    const perSymbol = new Map<string, readonly BenchmarkCandle[]>([['BTC/USDT', []]]);
    expect(computeEqualWeightBasketReturnFraction(perSymbol)).toBeNull();
  });
});

describe('computeBasketBtcBeta', () => {
  // BTC per-bar returns: +10%, -10%, +20% (c0=100, c1=110, c2=99, c3=118.8 — each transition exact).
  const btc: BenchmarkCandle[] = [
    candle(0, '100'),
    candle(1, '110'), // +0.10
    candle(2, '99'), // -0.10 (110 * 0.9)
    candle(3, '118.8'), // +0.20 (99 * 1.2)
  ];

  it('is exactly 2 when the basket return is exactly 2x BTC every bar (cov/var algebraic identity)', () => {
    const basket: BenchmarkCandle[] = [
      candle(0, '100'),
      candle(1, '120'), // +0.20 (2x btc's +0.10)
      candle(2, '96'), // -0.20 (2x btc's -0.10; 120 * 0.8)
      candle(3, '134.4'), // +0.40 (2x btc's +0.20; 96 * 1.4)
    ];
    const perSymbol = new Map<string, readonly BenchmarkCandle[]>([['ALT/USDT', basket]]);
    expect(computeBasketBtcBeta(perSymbol, btc)).toBe(2);
  });

  it('is exactly -1 when the basket moves inversely to BTC 1:1', () => {
    const basket: BenchmarkCandle[] = [
      candle(0, '100'),
      candle(1, '90'), // -0.10
      candle(2, '99'), // +0.10 (90 * 1.1)
      candle(3, '79.2'), // -0.20 (99 * 0.8)
    ];
    const perSymbol = new Map<string, readonly BenchmarkCandle[]>([['ALT/USDT', basket]]);
    expect(computeBasketBtcBeta(perSymbol, btc)).toBe(-1);
  });

  it('averages two symbols equal-weight before computing beta against BTC', () => {
    // ALT1 tracks BTC 1:1 (beta 1 alone); ALT2 tracks BTC at 3x (beta 3 alone). Equal-weight basket
    // return per bar is the mean of the two, so basket = 2x BTC every bar ⇒ beta 2, same as the
    // single-symbol 2x fixture above (linear combination sanity check).
    const alt1 = btc; // 1x
    const alt2: BenchmarkCandle[] = [
      candle(0, '100'),
      candle(1, '130'), // +0.30 (3x btc's +0.10)
      candle(2, '91'), // -0.30 (3x btc's -0.10; 130 * 0.7)
      candle(3, '145.6'), // +0.60 (3x btc's +0.20; 91 * 1.6)
    ];
    const perSymbol = new Map<string, readonly BenchmarkCandle[]>([
      ['ALT1/USDT', alt1],
      ['ALT2/USDT', alt2],
    ]);
    expect(computeBasketBtcBeta(perSymbol, btc)).toBe(2);
  });

  it("excludes a bar from the basket mean when a symbol's series lacks it, rather than imputing", () => {
    // ALT only has bars 0-2 (misses bar 3) — its contribution to bar 3's basket mean is simply absent,
    // not zeroed. With a single ALT symbol tracking BTC 1:1 on the bars it DOES have, beta is still 1
    // (bar 3 drops out of both series' pairing entirely once ALT has no return there).
    const alt: BenchmarkCandle[] = [candle(0, '100'), candle(1, '110'), candle(2, '99')]; // 1x, no bar 3
    const perSymbol = new Map<string, readonly BenchmarkCandle[]>([['ALT/USDT', alt]]);
    expect(computeBasketBtcBeta(perSymbol, btc)).toBe(1);
  });

  it('returns null when fewer than 2 BTC bars are available', () => {
    const perSymbol = new Map<string, readonly BenchmarkCandle[]>([
      ['ALT/USDT', [candle(0, '100'), candle(1, '110')]],
    ]);
    expect(computeBasketBtcBeta(perSymbol, [candle(0, '100')])).toBeNull();
  });

  it('returns null when no basket symbol has any paired bar with BTC', () => {
    const perSymbol = new Map<string, readonly BenchmarkCandle[]>([
      ['ALT/USDT', [candle(0, '100')]], // single candle — no return at all
    ]);
    expect(computeBasketBtcBeta(perSymbol, btc)).toBeNull();
  });

  it("BTC_BENCHMARK_SYMBOL is 'BTC/USDT' (shared by agentic.strategy.ts's own netVsBtcHoldBps wiring)", () => {
    expect(BTC_BENCHMARK_SYMBOL).toBe('BTC/USDT');
  });

  it('excludes a gap-spanning transition (array-adjacent but not time-adjacent) from BOTH sides, rather than mislabeling it as a single-bar return', () => {
    // BTC stays regular across 6 bars (t0..t5) — never gapped.
    const btcExtended: BenchmarkCandle[] = [
      candle(0, '100'),
      candle(1, '110'), // +0.10
      candle(2, '99'), // -0.10 (110 * 0.9)
      candle(3, '118.8'), // +0.20 (99 * 1.2)
      candle(4, '106.92'), // -0.10 (118.8 * 0.9)
      candle(5, '133.65'), // +0.25 (106.92 * 1.25)
    ];
    // ALT tracks BTC exactly 2x on bars 1-3, then its stored series skips bar 4 entirely (a
    // cross-call gap, e.g. universe churn) and resumes at bar 5 with a close that would NOT
    // continue the 2x pattern if mislabeled as bar 5's single-bar return.
    const altWithGap: BenchmarkCandle[] = [
      candle(0, '100'),
      candle(1, '120'), // +0.20 (2x btc's +0.10)
      candle(2, '96'), // -0.20 (2x btc's -0.10; 120 * 0.8)
      candle(3, '134.4'), // +0.40 (2x btc's +0.20; 96 * 1.4)
      // bar 4 (t4) missing entirely — cross-call gap
      candle(5, '200'), // resumed post-gap; (200-134.4)/134.4 ≈ +0.488, NOT 2x btc's +0.25 (+0.50)
    ];
    const perSymbol = new Map<string, readonly BenchmarkCandle[]>([['ALT/USDT', altWithGap]]);
    // With the t3->t5 transition excluded (gap-spanning), only bars 1-3 pair (ALT exactly 2x BTC
    // on each) — same algebraic identity as the "is exactly 2" fixture above, exact value 2.
    expect(computeBasketBtcBeta(perSymbol, btcExtended)).toBe(2);
  });
});

describe('computeAlphaBps', () => {
  it('BTC hold +2%, lane net +1% ⇒ negative alpha, exact bps (acceptance fixture)', () => {
    const btcHold = computeHoldReturnFraction([candle(0, '100'), candle(1, '102')])!;
    expect(btcHold.toFixed()).toBe('0.02');
    // Lane's cumulative net-of-cost return over the same window: +1% = +100 bps.
    const alpha = computeAlphaBps(100, btcHold);
    expect(alpha).toBe(-100); // 100 - (0.02 * 10000) = 100 - 200 = -100
  });

  it('lane beats the benchmark ⇒ positive alpha, exact bps', () => {
    const benchmarkReturn = new Decimal('0.01'); // +1% = +100 bps
    const alpha = computeAlphaBps(300, benchmarkReturn); // lane +3% = +300 bps
    expect(alpha).toBe(200);
  });

  it('rounds to a whole bps', () => {
    const benchmarkReturn = new Decimal('0.010005'); // +100.05 bps
    const alpha = computeAlphaBps(0, benchmarkReturn);
    expect(alpha).toBe(-100); // 0 - 100.05, rounded to nearest whole bps
  });
});
