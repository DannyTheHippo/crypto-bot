// Pins the winsorized deflation-variance port (stats.ts winsorizedVariance) — RESEARCH TOOLING.
//
// The regression this file exists to prevent: feeding RAW cross-trial SR variance into
// expectedMaxSharpe lets a few thin-sample trials with degenerate |SR| set an unpassable deflation
// benchmark (the 2026-07-10 carry study measured SR0* = 140.41 from 10 of 178 cells with |SR| > 10).
// The winsorized estimator must bound that leverage while staying byte-identical to the raw
// variance whenever no trial exceeds the cap.
import { describe, it, expect } from 'vitest';
import { expectedMaxSharpe, winsorizedVariance } from './stats';
import { variance } from './trial-registry';

// 178 deterministic "trial Sharpes" shaped like the carry union: 168 unremarkable per-trade SRs
// cycling a fixed small-magnitude pattern, plus 10 thin-sample outliers up to |SR| ≈ 140.
const SMALL_PATTERN = [-1.2, -0.4, 0.1, 0.6, -0.8, 0.3, 1.1, -0.2, 0.9, -1.5, 0.4, -0.6];
const SMALL_TRIALS = Array.from(
  { length: 168 },
  (_, i) => SMALL_PATTERN[i % SMALL_PATTERN.length]!,
);
const OUTLIERS = [140.41, -25.3, 96.2, 18.7, -12.4, 33.9, 51.6, -76.8, 11.2, 22.5];
const CARRY_SHAPED_UNION = [...SMALL_TRIALS, ...OUTLIERS];

describe('winsorizedVariance (deflation input V)', () => {
  it('equals the raw trial-registry variance when no value exceeds the cap', () => {
    expect(winsorizedVariance(SMALL_TRIALS)).toBe(variance(SMALL_TRIALS));
    expect(winsorizedVariance([-3, 0, 3])).toBe(variance([-3, 0, 3])); // cap boundary is inclusive
  });

  it('bounds outlier leverage on the SR0* benchmark where the raw variance degenerates', () => {
    const N = CARRY_SHAPED_UNION.length;
    expect(N).toBe(178);
    const rawBenchmark = expectedMaxSharpe(variance(CARRY_SHAPED_UNION), N);
    const winsorizedBenchmark = expectedMaxSharpe(winsorizedVariance(CARRY_SHAPED_UNION), N);
    // Raw V is outlier-dominated: an SR0* no honest per-trade Sharpe can clear.
    expect(rawBenchmark).toBeGreaterThan(10);
    // Winsorized V keeps SR0* in the range an actual edge could beat (clipped |SR| ≤ 3 ⇒ V ≤ 9
    // ⇒ SR0* ≤ 3·E[max Z_178] ≈ 8.3; this small-magnitude-dominated set lands far lower).
    expect(winsorizedBenchmark).toBeLessThan(5);
    expect(winsorizedBenchmark).toBeGreaterThan(0);
  });

  it('respects the cap parameter', () => {
    // [0, 10] clipped at 3 → [0, 3]: mean 1.5, sample variance (1.5² + 1.5²)/1 = 4.5.
    expect(winsorizedVariance([0, 10], 3)).toBe(4.5);
    // Same input at cap 5 → [0, 5]: mean 2.5, sample variance (2.5² + 2.5²)/1 = 12.5.
    expect(winsorizedVariance([0, 10], 5)).toBe(12.5);
  });

  it('returns 0 below two samples, matching the raw variance convention', () => {
    expect(winsorizedVariance([])).toBe(0);
    expect(winsorizedVariance([42])).toBe(0);
  });
});
