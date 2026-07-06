import { describe, it, expect } from 'vitest';
import {
  evaluatePrescreen,
  type PrescreenThresholds,
  type PrescreenArgs,
} from '../../../src/features/trading/agentic/prescreen';

const THRESHOLDS: PrescreenThresholds = {
  volShortBars: 5,
  volLongBars: 20,
  volRatio: 2,
  breakoutLookbackBars: 10,
  breakoutPct: 0.005,
};

function flatCloses(length: number, value = 100): number[] {
  return Array.from({ length }, () => value);
}

function baseArgs(over: Partial<PrescreenArgs> = {}): PrescreenArgs {
  const closes = flatCloses(20);
  return {
    closes,
    highs: closes,
    lows: closes,
    positionOpen: false,
    thresholds: THRESHOLDS,
    ...over,
  };
}

describe('evaluatePrescreen — position_open short-circuit', () => {
  it('always consults when a position is open, even with too little data for every other check', () => {
    const result = evaluatePrescreen(
      baseArgs({ closes: [100], highs: [100], lows: [100], positionOpen: true }),
    );
    expect(result).toEqual({ consult: true, reason: 'position_open' });
  });

  it('takes priority over a would-be breakout_proximity or vol_expansion signal', () => {
    const closes = [...flatCloses(19), 200]; // huge move on the last bar — would otherwise trip
    const result = evaluatePrescreen(baseArgs({ closes, positionOpen: true }));
    expect(result.reason).toBe('position_open');
  });
});

describe('evaluatePrescreen — insufficient_data fail-open', () => {
  it('fails open when there are fewer closes than volLongBars', () => {
    const closes = flatCloses(19); // one short of volLongBars=20
    const result = evaluatePrescreen(baseArgs({ closes, highs: closes, lows: closes }));
    expect(result).toEqual({ consult: true, reason: 'insufficient_data' });
  });

  it('fails open when there are fewer highs/lows than breakoutLookbackBars', () => {
    const closes = flatCloses(20);
    const result = evaluatePrescreen(
      baseArgs({ closes, highs: closes.slice(0, 9), lows: closes.slice(0, 9) }),
    );
    expect(result).toEqual({ consult: true, reason: 'insufficient_data' });
  });

  it('fails open when a NaN sits inside the used closes window', () => {
    const closes = [...flatCloses(19), NaN];
    const result = evaluatePrescreen(
      baseArgs({ closes, highs: flatCloses(20), lows: flatCloses(20) }),
    );
    expect(result).toEqual({ consult: true, reason: 'insufficient_data' });
  });

  it('fails open when a non-finite value (Infinity) sits inside the used highs window', () => {
    const closes = flatCloses(20);
    const highs = [...flatCloses(19), Infinity];
    const result = evaluatePrescreen(baseArgs({ closes, highs, lows: closes }));
    expect(result).toEqual({ consult: true, reason: 'insufficient_data' });
  });

  it('fails open when a non-finite value sits inside the used lows window', () => {
    const closes = flatCloses(20);
    const lows = [...flatCloses(19), -Infinity];
    const result = evaluatePrescreen(baseArgs({ closes, highs: closes, lows }));
    expect(result).toEqual({ consult: true, reason: 'insufficient_data' });
  });
});

describe('evaluatePrescreen — vol_expansion', () => {
  it('consults when the short-window stdev exceeds volRatio times the long-window stdev', () => {
    // Long window: alternating small moves for bars 0..14, all flat afterward except the last 5
    // bars which swing hard — pushes short stdev well above ratio * long stdev.
    const longPart = flatCloses(15, 100);
    const shortPart = [100, 120, 90, 130, 80]; // large swings in the short window
    const closes = [...longPart, ...shortPart];
    const result = evaluatePrescreen(baseArgs({ closes, highs: closes, lows: closes }));
    expect(result).toEqual({ consult: true, reason: 'vol_expansion' });
  });

  it('does not fire vol_expansion when the ratio sits at exactly volRatio (strict >, not >=)', () => {
    // 15 flat closes (14 zero returns) followed by 5 closes with alternating +-1% returns. The short
    // window (last 5 closes -> 4 returns, all magnitude step, mean 0) has population stdev == step
    // exactly. The long window (19 returns: 14 zeros + those same 4 +-step returns, mean 0) has
    // population stdev == step * sqrt(4/19). So shortStdev/longStdev == sqrt(19/4) exactly,
    // independent of step — set volRatio to that same value to land precisely on the boundary.
    const step = 0.01;
    const closes = [
      ...flatCloses(15, 100),
      100,
      100 * (1 - step),
      100 * (1 - step) * (1 + step),
      100 * (1 - step) * (1 + step) * (1 - step),
      100 * (1 - step) * (1 + step) * (1 - step) * (1 + step),
    ];
    const volRatio = Math.sqrt(19 / 4);
    const result = evaluatePrescreen(
      baseArgs({ closes, highs: closes, lows: closes, thresholds: { ...THRESHOLDS, volRatio } }),
    );
    expect(result.reason).not.toBe('vol_expansion');
  });

  it('guards divide-by-zero: zero long-window stdev with nonzero short-window stdev is expansion', () => {
    const longFlat = flatCloses(15, 100);
    const shortMoving = [100, 105, 95, 110, 90]; // nonzero movement in the short window only
    const closes = [...longFlat, ...shortMoving];
    const result = evaluatePrescreen(baseArgs({ closes, highs: closes, lows: closes }));
    expect(result).toEqual({ consult: true, reason: 'vol_expansion' });
  });

  it('guards divide-by-zero: both windows flat (zero/zero) is not expansion', () => {
    const closes = flatCloses(20, 100);
    const result = evaluatePrescreen(baseArgs({ closes, highs: closes, lows: closes }));
    expect(result.reason).not.toBe('vol_expansion');
  });

  it('does not fire when the short/long stdev ratio is below volRatio', () => {
    // The same ±1% alternation across the WHOLE window -> short and long stdev match, ratio ~1,
    // below volRatio=2. (Confining the moves to the short window instead dilutes the long-window
    // stdev and pushes the ratio to sqrt(19/4) ≈ 2.18 — the boundary test above pins that case.)
    const closes = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 100 : 101));
    const result = evaluatePrescreen(baseArgs({ closes, highs: closes, lows: closes }));
    expect(result.reason).not.toBe('vol_expansion');
  });
});

describe('evaluatePrescreen — breakout_proximity', () => {
  it('consults when the last close sits within breakoutPct of the lookback-window high', () => {
    const closes = [...flatCloses(15, 100), 100, 100, 100, 100, 100.4]; // 0.4% below a 100.4 high (itself)
    const highs = closes;
    const lows = flatCloses(20, 99);
    const result = evaluatePrescreen(baseArgs({ closes, highs, lows }));
    expect(result).toEqual({ consult: true, reason: 'breakout_proximity' });
  });

  it('consults when the last close sits within breakoutPct of the lookback-window low', () => {
    const closes = [...flatCloses(15, 100), 100, 100, 100, 100, 99.6]; // 0.4% above a 99.6 low (itself)
    const lows = closes;
    const highs = flatCloses(20, 101);
    const result = evaluatePrescreen(baseArgs({ closes, highs, lows }));
    expect(result).toEqual({ consult: true, reason: 'breakout_proximity' });
  });

  it('fires at exactly breakoutPct distance from the high (inclusive <=)', () => {
    // Lookback high fixed at 100 via a separate high series; last close exactly 0.5% below it.
    const closes = [...flatCloses(15, 100), 100, 100, 100, 100, 99.5];
    const highs = flatCloses(20, 100); // rolling high = 100
    const lows = flatCloses(20, 90); // far away, won't trip the low side
    const result = evaluatePrescreen(baseArgs({ closes, highs, lows }));
    expect(result).toEqual({ consult: true, reason: 'breakout_proximity' });
  });

  it('does not fire just beyond breakoutPct distance from the high', () => {
    const closes = [...flatCloses(15, 100), 100, 100, 100, 100, 99.4]; // 0.6% below 100 -> beyond 0.5%
    const highs = flatCloses(20, 100);
    const lows = flatCloses(20, 90);
    const result = evaluatePrescreen(baseArgs({ closes, highs, lows }));
    expect(result.reason).not.toBe('breakout_proximity');
  });

  it('does not fire when the close sits comfortably inside the range on both sides', () => {
    const closes = [...flatCloses(15, 100), 100, 100, 100, 100, 100];
    const highs = flatCloses(20, 110);
    const lows = flatCloses(20, 90);
    const result = evaluatePrescreen(baseArgs({ closes, highs, lows }));
    expect(result.reason).not.toBe('breakout_proximity');
  });
});

describe('evaluatePrescreen — quiet', () => {
  it('reports quiet with consult=false when no trigger fires', () => {
    const closes = flatCloses(20, 100);
    const highs = flatCloses(20, 110);
    const lows = flatCloses(20, 90);
    const result = evaluatePrescreen(baseArgs({ closes, highs, lows }));
    expect(result).toEqual({ consult: false, reason: 'quiet' });
  });
});
