// Sanity gate (iii): shuffled-signal — ACCEPTANCE for the backtest rebuild.
//
// A round trip whose entry TIMING and SIDE are randomized (uncorrelated with any real signal) should
// net to roughly breakeven — this is the harness's null-hypothesis check: if a bug artificially
// inflated or deflated returns (e.g. a haircut applied in the wrong direction for shorts, or a
// lookahead fill), the mean would drift measurably off the theoretical center.
//
// Direction is 50/50 LONG/SHORT so the underlying series' real price drift cancels in expectation
// across trials — a LONG round trip over a random window and a SHORT round trip over the SAME random
// window are equal-and-opposite on the raw (pre-cost) price return, so only entry TIMING randomness
// plus the round trip's fixed cost drag survive averaging.
//
// STATISTICAL — the bound is explicit: theoretical center = 1 − round-trip cost drag (both legs' taker
// fee + adverse haircut, defaults 10bps + 5bps ⇒ ~2×(10+5)bps ≈ 0.997). Tolerance |mean − center| < 0.02
// at TRIALS=300, chosen to comfortably absorb Monte Carlo noise on BTC/USDT hourly data while still
// catching a directional sign-flip bug (which would show up as an offset an order of magnitude larger).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBacktest, type Bar } from '../harness';
import type { BarStrategy, BarContext, BacktestAction } from '../strategy';

const ALL_BARS = JSON.parse(
  readFileSync(join(__dirname, '../data/BTCUSDT-1h.json'), 'utf8'),
) as Bar[];
const BARS = ALL_BARS.slice(0, 2000);

const HOLD_BARS = 10;
const TRIALS = 300;

// Deterministic PRNG (mulberry32) — reproducible across runs without a shuffle-library dependency.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class SingleRoundTripStrategy implements BarStrategy {
  constructor(
    private readonly entryBar: number,
    private readonly side: 'LONG' | 'SHORT',
  ) {}

  decide(ctx: BarContext): BacktestAction {
    if (ctx.barIndex === this.entryBar && ctx.position.signedQty.isZero()) {
      return { type: 'enter', side: this.side };
    }
    if (ctx.barIndex === this.entryBar + HOLD_BARS && !ctx.position.signedQty.isZero()) {
      return { type: 'exit', reason: 'shuffled_signal_hold_expired' };
    }
    return { type: 'hold' };
  }
}

describe('sanity: shuffled-signal strategy nets ~breakeven', () => {
  it('mean net-of-cost equity ratio over randomized entry timing/side ≈ theoretical cost-drag center', () => {
    const rand = mulberry32(20260710);
    const ratios: number[] = [];
    for (let i = 0; i < TRIALS; i++) {
      const entryBar = Math.floor(rand() * (BARS.length - HOLD_BARS - 2));
      const side: 'LONG' | 'SHORT' = rand() < 0.5 ? 'LONG' : 'SHORT';
      const result = runBacktest(BARS, () => new SingleRoundTripStrategy(entryBar, side), {
        startingCash: '1000',
        baseNotional: '1000',
      });
      ratios.push(Number(result.finalEquity) / 1000);
    }

    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const expectedCenter = 1 - 2 * ((10 + 5) / 10_000);
    expect(Math.abs(mean - expectedCenter)).toBeLessThan(0.02);
  });
});
