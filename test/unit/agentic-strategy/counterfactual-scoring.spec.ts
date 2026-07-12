import { describe, it, expect } from 'vitest';
import {
  scoreRows,
  combineScorecards,
  compare,
  summarizeCalibration,
  summarizeRegimeSplit,
  type ScoringRow,
  type Scorecard,
} from '../../../src/features/trading/agentic/counterfactual-scoring';
import { epochMs } from '../../../src/domain/types/ids';

const T = 1_700_000_000_000;

function row(index: number, over: Partial<ScoringRow> = {}): ScoringRow {
  return {
    eventTime: epochMs(T + index * 60_000),
    action: 'hold',
    confidence: null,
    refPrice: null,
    close: null,
    playbookVersion: 1,
    promptHash: 'hash-a',
    model: 'test-model',
    symbol: 'BTC/USDT',
    ...over,
  };
}

function horizonStats(scorecard: Scorecard, horizon: 1 | 4 | 24) {
  return scorecard.horizonStats.find((s) => s.horizon === horizon)!;
}

describe('scoreRows — grouping', () => {
  it("splits a version spanning multiple promptHashes into one scorecard per hash, preserving each group's own chronological order", () => {
    // Interleaved: A0, B0, A1, B1 — each group's own forward return must use its own neighbor
    // (A0 -> A1), never the other group's row (A0 -> B0).
    const rows: ScoringRow[] = [
      row(0, { action: 'long', close: '100', promptHash: 'h1' }),
      row(1, { action: 'long', close: '200', promptHash: 'h2' }),
      row(2, { action: 'hold', close: '110', promptHash: 'h1' }),
      row(3, { action: 'hold', close: '190', promptHash: 'h2' }),
    ];

    const scorecards = scoreRows(rows);
    expect(scorecards).toHaveLength(2);

    const h1 = scorecards.find((s) => s.promptHash === 'h1')!;
    const h2 = scorecards.find((s) => s.promptHash === 'h2')!;
    expect(h1.rowCount).toBe(2);
    expect(h2.rowCount).toBe(2);

    // h1: (110-100)/100 = 0.1 > 0 -> long hit.
    expect(horizonStats(h1, 1).sampleCount).toBe(1);
    expect(horizonStats(h1, 1).hitCount).toBe(1);
    // h2: (190-200)/200 = -0.05, not > 0 -> long miss.
    expect(horizonStats(h2, 1).sampleCount).toBe(1);
    expect(horizonStats(h2, 1).hitCount).toBe(0);
  });

  it('groups rows with a null playbookVersion together when their promptHash matches', () => {
    const rows: ScoringRow[] = [
      row(0, { playbookVersion: null, promptHash: 'h' }),
      row(1, { playbookVersion: null, promptHash: 'h' }),
    ];
    const scorecards = scoreRows(rows);
    expect(scorecards).toHaveLength(1);
    expect(scorecards[0]!.playbookVersion).toBeNull();
    expect(scorecards[0]!.rowCount).toBe(2);
  });

  it('splits interleaved symbols into per-symbol groups — forward returns never cross instruments (2026-07-12 defect pin)', () => {
    // The live defect: one (version, hash) group interleaving BTC (~64k closes) and LINK (~8)
    // scored the BTC→LINK close transition as a −99.99% forward return. Per-symbol grouping must
    // keep each instrument on its own price path.
    const rows: ScoringRow[] = [
      row(0, { action: 'long', close: '64000', symbol: 'BTC/USDT' }),
      row(1, { action: 'long', close: '8', symbol: 'LINK/USDT' }),
      row(2, { action: 'hold', close: '64640', symbol: 'BTC/USDT' }),
      row(3, { action: 'hold', close: '8.08', symbol: 'LINK/USDT' }),
    ];

    const scorecards = scoreRows(rows);
    expect(scorecards).toHaveLength(2);

    const btc = scorecards.find((s) => s.symbol === 'BTC/USDT')!;
    const link = scorecards.find((s) => s.symbol === 'LINK/USDT')!;
    // Both symbols rose +1% along their own path — a LONG hit each. Under the old single-group
    // walk, BTC's "forward close" was LINK's 8 (a −99.99% miss).
    expect(horizonStats(btc, 1).sampleCount).toBe(1);
    expect(horizonStats(btc, 1).hitCount).toBe(1);
    expect(horizonStats(link, 1).sampleCount).toBe(1);
    expect(horizonStats(link, 1).hitCount).toBe(1);
  });
});

describe('combineScorecards', () => {
  it("aggregates one variant's per-symbol cards: counts sum, hit rate recomputes, toy equity multiplies", () => {
    const rows: ScoringRow[] = [
      // BTC sleeve: long@100, next refPrice 110 fills the entry; flat@110 exits at 105 — one trip.
      row(0, { action: 'long', close: '100', refPrice: '100', symbol: 'BTC/USDT' }),
      row(2, { action: 'flat', close: '110', refPrice: '110', symbol: 'BTC/USDT' }),
      row(4, { action: 'hold', close: '105', refPrice: '105', symbol: 'BTC/USDT' }),
      // LINK sleeve: long@8 fills at 8.08; never exits — open at end, zero trips.
      row(1, { action: 'long', close: '8', refPrice: '8', symbol: 'LINK/USDT' }),
      row(3, { action: 'hold', close: '8.08', refPrice: '8.08', symbol: 'LINK/USDT' }),
    ];
    const cards = scoreRows(rows);
    expect(cards).toHaveLength(2);

    const combined = combineScorecards(cards);
    expect(combined.symbol).toBe('BTC/USDT+LINK/USDT');
    expect(combined.rowCount).toBe(5);
    // Horizon-1 samples: BTC contributes 2 (i0, i1 of its own subsequence), LINK contributes 1.
    const btcH1 = horizonStats(cards.find((c) => c.symbol === 'BTC/USDT')!, 1);
    const linkH1 = horizonStats(cards.find((c) => c.symbol === 'LINK/USDT')!, 1);
    const combinedH1 = horizonStats(combined, 1);
    expect(combinedH1.sampleCount).toBe(btcH1.sampleCount + linkH1.sampleCount);
    expect(combinedH1.hitCount).toBe(btcH1.hitCount + linkH1.hitCount);
    // Toy equity: product of the sleeves; trips sum; any open sleeve marks the combined card open.
    const btcEquity = cards.find((c) => c.symbol === 'BTC/USDT')!.toyEquity;
    const linkEquity = cards.find((c) => c.symbol === 'LINK/USDT')!.toyEquity;
    // Exact: reduce((p,c)=>p*c, 1) over two cards is literally 1*btc*link, and 1*x === x in
    // IEEE-754 — same operands, same operation, bit-identical result (toy floats, not money).
    expect(combined.toyEquity.finalEquity).toBe(btcEquity.finalEquity * linkEquity.finalEquity);
    expect(combined.toyEquity.roundTrips).toBe(btcEquity.roundTrips + linkEquity.roundTrips);
    expect(combined.toyEquity.openAtEnd).toBe(true);
  });

  it('refuses to combine cards from different (playbookVersion, promptHash) variants', () => {
    const cards = scoreRows([
      row(0, { promptHash: 'h1', symbol: 'BTC/USDT' }),
      row(1, { promptHash: 'h2', symbol: 'BTC/USDT' }),
    ]);
    expect(cards).toHaveLength(2);
    expect(() => combineScorecards(cards)).toThrow(/refuses to combine/);
    expect(() => combineScorecards([])).toThrow(/no scorecards/);
  });
});

describe('forward returns / hit rate', () => {
  it('computes sampleCount/hitCount/hitRate per horizon, excluding rows without a future close', () => {
    const rows: ScoringRow[] = [
      row(0, { action: 'long', close: '100' }),
      row(1, { action: 'hold', close: '110' }),
      row(2, { action: 'flat', close: '105' }),
      row(3, { action: 'hold', close: '120' }),
      row(4, { action: 'hold', close: '90' }),
    ];
    const [scorecard] = scoreRows(rows);

    // Resulting exposure: i0 long→LONG, i1 hold→LONG (maintains the position), i2 flat→FLAT,
    // i3 hold→FLAT (maintains flat).
    // horizon 1: i0 LONG (110-100)/100=+0.1 hit; i1 LONG (105-110)/110=-0.045 miss (not >0);
    // i2 FLAT (120-105)/105=+0.143 miss (>0); i3 FLAT (90-120)/120=-0.25 hit (<=0); i4 has no i+1.
    const h1 = horizonStats(scorecard!, 1);
    expect(h1.sampleCount).toBe(4);
    expect(h1.hitCount).toBe(2);
    expect(h1.hitRate).toBe(0.5);

    // horizon 4: only i0 has an i+4 (index 4); (90-100)/100=-0.1, LONG exposure, not a hit.
    const h4 = horizonStats(scorecard!, 4);
    expect(h4.sampleCount).toBe(1);
    expect(h4.hitCount).toBe(0);
    expect(h4.hitRate).toBe(0);

    // horizon 24: no row has an i+24 in a 5-row group.
    const h24 = horizonStats(scorecard!, 24);
    expect(h24.sampleCount).toBe(0);
    expect(h24.hitCount).toBe(0);
    expect(h24.hitRate).toBeNull();
  });

  it("excludes rows within `horizon` bars of the group end from that horizon's denominator", () => {
    // 26 strictly-increasing hold rows: only index 0 and 1 have an i+24 within a 26-row group.
    const rows: ScoringRow[] = Array.from({ length: 26 }, (_, i) =>
      row(i, { action: 'hold', close: String(100 + i) }),
    );
    const [scorecard] = scoreRows(rows);
    const h24 = horizonStats(scorecard!, 24);
    // Both forward returns are strictly positive (closes only rise) -> hold hit rule (fwd<=0) misses both.
    expect(h24.sampleCount).toBe(2);
    expect(h24.hitCount).toBe(0);
    expect(h24.hitRate).toBe(0);
  });

  it('scores a zero forward return as a miss for "long" and a hit for "hold"', () => {
    const longRows: ScoringRow[] = [
      row(0, { action: 'long', close: '100' }),
      row(1, { action: 'hold', close: '100' }),
    ];
    const [longScorecard] = scoreRows(longRows);
    expect(horizonStats(longScorecard!, 1).hitRate).toBe(0);

    const holdRows: ScoringRow[] = [
      row(0, { action: 'hold', close: '100' }),
      row(1, { action: 'hold', close: '100' }),
    ];
    const [holdScorecard] = scoreRows(holdRows);
    expect(horizonStats(holdScorecard!, 1).hitRate).toBe(1);
  });

  it('scores a hold that MAINTAINS a long as LONG exposure — a hold riding a rise is a hit (F2)', () => {
    // Under the retired action-based convention i1 (a hold) was scored as flat and this rise made
    // it a MISS; exposure-based scoring correctly credits the LONG position the hold maintained.
    const rows: ScoringRow[] = [
      row(0, { action: 'long', close: '100' }), // FLAT→LONG
      row(1, { action: 'hold', close: '110' }), // maintains LONG; (120-110)/110>0 → hit
      row(2, { action: 'hold', close: '120' }), // maintains LONG; no i+1 in a 3-row group
    ];
    const [scorecard] = scoreRows(rows);
    const h1 = horizonStats(scorecard!, 1);
    expect(h1.sampleCount).toBe(2);
    expect(h1.hitCount).toBe(2);
    expect(h1.hitRate).toBe(1);
  });

  it('scores a hold that MAINTAINS flat as FLAT exposure — a hold that missed a rise is a miss', () => {
    const rows: ScoringRow[] = [
      row(0, { action: 'hold', close: '100' }), // maintains FLAT; (110-100)/100>0 → miss
      row(1, { action: 'hold', close: '110' }), // maintains FLAT; no i+1
    ];
    const [scorecard] = scoreRows(rows);
    const h1 = horizonStats(scorecard!, 1);
    expect(h1.sampleCount).toBe(1);
    expect(h1.hitCount).toBe(0);
    expect(h1.hitRate).toBe(0);
  });

  it('excludes "error" rows as decisions but still uses their close as a forward-return target', () => {
    const rows: ScoringRow[] = [
      row(0, { action: 'long', close: '100' }),
      row(1, { action: 'error', close: '150' }),
    ];
    const [scorecard] = scoreRows(rows);
    const h1 = horizonStats(scorecard!, 1);
    // Only row 0 is scored (row 1 is an 'error' row, never a decision); (150-100)/100=+0.5 -> hit.
    expect(h1.sampleCount).toBe(1);
    expect(h1.hitCount).toBe(1);
    expect(h1.hitRate).toBe(1);
  });
});

describe('confidence calibration', () => {
  it('buckets "long" rows into deciles by confidence, meaning mean forward return at t+1, excluding "error" and null-confidence rows', () => {
    const rows: ScoringRow[] = [
      row(0, { action: 'long', confidence: 0.05, close: '100' }),
      row(1, { action: 'long', confidence: 0.95, close: '102' }),
      row(2, { action: 'hold', confidence: null, close: '95' }),
    ];
    const [scorecard] = scoreRows(rows);

    const bucket0 = scorecard!.calibration.find((b) => b.bucketIndex === 0)!;
    expect(bucket0.lowerBound).toBe(0);
    expect(bucket0.upperBound).toBe(0.1);
    expect(bucket0.sampleCount).toBe(1);
    expect(bucket0.meanForwardReturn).toBe((102 - 100) / 100);

    const bucket9 = scorecard!.calibration.find((b) => b.bucketIndex === 9)!;
    expect(bucket9.lowerBound).toBe(0.9);
    expect(bucket9.upperBound).toBe(1);
    expect(bucket9.sampleCount).toBe(1);
    expect(bucket9.meanForwardReturn).toBe((95 - 102) / 102);

    // Every other bucket is empty.
    for (const bucket of scorecard!.calibration) {
      if (bucket.bucketIndex === 0 || bucket.bucketIndex === 9) continue;
      expect(bucket.sampleCount).toBe(0);
      expect(bucket.meanForwardReturn).toBeNull();
    }
  });

  it('negates the forward return for "flat"/"hold" rows (directional edge), unlike "long" rows', () => {
    const rows: ScoringRow[] = [
      row(0, { action: 'hold', confidence: 0.25, close: '100' }),
      row(1, { action: 'hold', close: '90' }),
    ];
    const [scorecard] = scoreRows(rows);

    // fwd = (90-100)/100 = -0.1; 'hold' negates it -> a decline "avoided" reads as +0.1.
    const bucket = scorecard!.calibration.find((b) => b.bucketIndex === 2)!;
    expect(bucket.sampleCount).toBe(1);
    expect(bucket.meanForwardReturn).toBe(0.1);
  });

  it('uses the LONG directional edge (+fwd) for a hold that maintains a long position', () => {
    const rows: ScoringRow[] = [
      row(0, { action: 'long', confidence: 0.9, close: '100' }), // FLAT→LONG
      row(1, { action: 'hold', confidence: 0.7, close: '110' }), // maintains LONG; bucket 7
      row(2, { action: 'hold', close: '105' }),
    ];
    const [scorecard] = scoreRows(rows);
    // i1 resulting LONG, conf 0.7 → bucket 7, fwd (105-110)/110; LONG edge is +fwd (unlike a
    // resulting-flat row, which would negate it).
    const bucket7 = scorecard!.calibration.find((b) => b.bucketIndex === 7)!;
    expect(bucket7.sampleCount).toBe(1);
    expect(bucket7.meanForwardReturn).toBe((105 - 110) / 110);
  });

  it('excludes a calibration-eligible row from every bucket when it has no forward return at t+1', () => {
    // Only row in its group -> no i+1 -> forwardReturn is null despite valid action/confidence.
    const rows: ScoringRow[] = [row(0, { action: 'long', confidence: 0.5, close: '100' })];
    const [scorecard] = scoreRows(rows);
    for (const bucket of scorecard!.calibration) {
      expect(bucket.sampleCount).toBe(0);
    }
  });

  it('clamps out-of-contract confidence values into [0, 1] before bucketing', () => {
    const rows: ScoringRow[] = [
      row(0, { action: 'long', confidence: -0.5, close: '100' }),
      row(1, { action: 'long', confidence: 1.5, close: '101' }),
      row(2, { action: 'hold', close: '102' }),
    ];
    const [scorecard] = scoreRows(rows);

    expect(scorecard!.calibration.find((b) => b.bucketIndex === 0)!.sampleCount).toBe(1);
    expect(scorecard!.calibration.find((b) => b.bucketIndex === 9)!.sampleCount).toBe(1);
  });

  it('maps confidence exactly 1 into the top decile bucket (9), not an 11th bucket', () => {
    const rows: ScoringRow[] = [
      row(0, { action: 'long', confidence: 1, close: '100' }),
      row(1, { action: 'hold', close: '105' }),
    ];
    const [scorecard] = scoreRows(rows);
    expect(scorecard!.calibration).toHaveLength(10);
    expect(scorecard!.calibration.find((b) => b.bucketIndex === 9)!.sampleCount).toBe(1);
  });
});

describe('toy equity', () => {
  it('nets a closed long/flat round trip against the fixed fee + adverse-haircut assumptions', () => {
    // Entry fills at 1999, exit fills at 2001 — chosen so the ±5bps haircut cancels exactly
    // (1999*2001 == 2001*1999), isolating the fee drag: gross multiplier is exactly 1, so
    // finalEquity is exactly (1 - 10bps)^2 = 0.999^2 = 0.998001.
    const rows: ScoringRow[] = [
      row(0, { action: 'long' }),
      row(1, { action: 'hold', refPrice: '1999' }),
      row(2, { action: 'flat' }),
      row(3, { action: 'hold', refPrice: '2001' }),
    ];
    const [scorecard] = scoreRows(rows);
    expect(scorecard!.toyEquity.roundTrips).toBe(1);
    expect(scorecard!.toyEquity.openAtEnd).toBe(false);
    expect(scorecard!.toyEquity.finalEquity).toBe(0.998001);
  });

  it('treats an "error" row identically to "hold" in the position state machine (can still supply a fill)', () => {
    const rows: ScoringRow[] = [
      row(0, { action: 'long' }),
      row(1, { action: 'error', refPrice: '1999' }),
      row(2, { action: 'flat' }),
      row(3, { action: 'hold', refPrice: '2001' }),
    ];
    const [scorecard] = scoreRows(rows);
    expect(scorecard!.toyEquity.finalEquity).toBe(0.998001);
  });

  it('leaves an unclosed LONG position out of finalEquity entirely (openAtEnd, unrealized)', () => {
    const rows: ScoringRow[] = [
      row(0, { action: 'long' }),
      row(1, { action: 'hold', refPrice: '1999' }),
    ];
    const [scorecard] = scoreRows(rows);
    expect(scorecard!.toyEquity.finalEquity).toBe(1);
    expect(scorecard!.toyEquity.roundTrips).toBe(0);
    expect(scorecard!.toyEquity.openAtEnd).toBe(true);
  });

  it('drops a "long" decision with no next row to fill it (last row in the group)', () => {
    const rows: ScoringRow[] = [row(0, { action: 'hold' }), row(1, { action: 'long' })];
    const [scorecard] = scoreRows(rows);
    expect(scorecard!.toyEquity.finalEquity).toBe(1);
    expect(scorecard!.toyEquity.roundTrips).toBe(0);
    expect(scorecard!.toyEquity.openAtEnd).toBe(false);
  });

  it('drops a decision whose next row has no refPrice recorded', () => {
    const rows: ScoringRow[] = [
      row(0, { action: 'long' }),
      row(1, { action: 'hold', refPrice: null, close: '1999' }),
    ];
    const [scorecard] = scoreRows(rows);
    expect(scorecard!.toyEquity.finalEquity).toBe(1);
    expect(scorecard!.toyEquity.openAtEnd).toBe(false);
  });

  it('treats a repeated "long" while already LONG, and "flat" while already FLAT, as no-ops', () => {
    const rows: ScoringRow[] = [
      // FLAT while already FLAT: a fill IS available (row1's refPrice) but must still be a no-op.
      row(0, { action: 'flat' }),
      row(1, { action: 'long', refPrice: '2000' }),
      row(2, { action: 'hold', refPrice: '1999' }), // fills row1's entry
      row(3, { action: 'long' }), // LONG while already LONG: no-op, entry price unchanged
      row(4, { action: 'hold' }),
    ];
    const [scorecard] = scoreRows(rows);
    expect(scorecard!.toyEquity.roundTrips).toBe(0);
    expect(scorecard!.toyEquity.openAtEnd).toBe(true);
    expect(scorecard!.toyEquity.finalEquity).toBe(1);
  });
});

describe('compare()', () => {
  function buildScorecard(secondClose: string, promptHash: string): Scorecard {
    const rows: ScoringRow[] = [
      row(0, { action: 'long', close: '100', promptHash }),
      row(1, { action: 'hold', close: secondClose, promptHash }),
    ];
    return scoreRows(rows)[0]!;
  }

  it('refuses without assertSameTemplate: true', () => {
    const champion = buildScorecard('110', 'champion-hash');
    const candidate = buildScorecard('90', 'candidate-hash');

    expect(() => compare(champion, candidate)).toThrow(/assertSameTemplate/);
    expect(() => compare(champion, candidate, {})).toThrow(/assertSameTemplate/);
    expect(() => compare(champion, candidate, { assertSameTemplate: false })).toThrow(
      /assertSameTemplate/,
    );
  });

  it('computes hit-rate deltas and a finalEquity delta once asserted', () => {
    const champion = buildScorecard('110', 'champion-hash'); // (110-100)/100=+0.1 -> long hit
    const candidate = buildScorecard('90', 'candidate-hash'); // (90-100)/100=-0.1 -> long miss

    const result = compare(champion, candidate, { assertSameTemplate: true });

    const h1Delta = result.hitRateDeltas.find((d) => d.horizon === 1)!;
    expect(h1Delta.championHitRate).toBe(1);
    expect(h1Delta.candidateHitRate).toBe(0);
    expect(h1Delta.delta).toBe(-1);

    const h4Delta = result.hitRateDeltas.find((d) => d.horizon === 4)!;
    expect(h4Delta.championHitRate).toBeNull();
    expect(h4Delta.candidateHitRate).toBeNull();
    expect(h4Delta.delta).toBeNull();

    // Neither fixture closes a round trip (no 'flat' row) -> both stay at the initial equity of 1.
    expect(result.finalEquityDelta).toBe(0);
  });
});

describe('summarizeCalibration (W14)', () => {
  it('buckets rows by action x stated-confidence bucket and reports mean t+1 forward return in bps for buckets with n>=3', () => {
    const rows: ScoringRow[] = [
      row(0, { action: 'long', confidence: 0.65, close: '100' }),
      row(1, { action: 'long', confidence: 0.65, close: '102' }),
      row(2, { action: 'long', confidence: 0.65, close: '101' }),
      row(3, { action: 'long', confidence: 0.65, close: '103' }), // last row: no t+1, not counted
    ];
    const digest = summarizeCalibration(rows);
    // Same summation order as the source (i=0,1,2 in sequence) so the float division matches exactly.
    const expectedMean =
      (((102 - 100) / 100) * 10000 + ((101 - 102) / 102) * 10000 + ((103 - 101) / 101) * 10000) / 3;
    expect(digest).toEqual([
      {
        action: 'long',
        confidenceLowerBound: 3 * 0.2, // 0.6000000000000001 — same idx*width float as the source
        confidenceUpperBound: 0.8,
        count: 3,
        meanForwardReturnBps: expectedMean,
      },
    ]);
  });

  it('omits buckets with fewer than 3 samples', () => {
    // Only 2 rows have a defined t+1 forward return (row2 is last, no next close).
    const rows: ScoringRow[] = [
      row(0, { action: 'long', confidence: 0.5, close: '100' }),
      row(1, { action: 'long', confidence: 0.5, close: '110' }),
      row(2, { action: 'long', confidence: 0.5, close: '90' }),
    ];
    expect(summarizeCalibration(rows)).toEqual([]);
  });

  it('excludes "error" rows and null-confidence rows from bucketing', () => {
    const rows: ScoringRow[] = [
      row(0, { action: 'error', confidence: 0.5, close: '100' }),
      row(1, { action: 'long', confidence: null, close: '110' }),
      row(2, { action: 'hold', confidence: 0.5, close: '90' }),
    ];
    expect(summarizeCalibration(rows)).toEqual([]);
  });
});

describe('summarizeRegimeSplit (W14)', () => {
  it("splits per-action t+1 forward-return stats at the median trailing 10-close stdev into 'quiet' and 'active'", () => {
    // Indices 0-49: constant close (100) -> every fully-inside trailing-10 window has stdev 0
    // ("quiet"). Indices 50-79: alternates 100/300 by parity -> once the trailing window is fully
    // inside this zone (i >= 59), every window holds exactly five 100s and five 300s (window width
    // 10 matches the alternation's period 2), giving a constant nonzero stdev ("active"). Zero-stdev
    // rows (i=9..50, 42 of them) outnumber the 28 nonzero ones (i=51..78) among the 70 defined
    // stdevs, so the median is exactly 0 — any nonzero row is unambiguously above it.
    const rows: ScoringRow[] = [];
    for (let i = 0; i < 50; i++) {
      rows.push(row(i, { action: i === 9 ? 'long' : 'error', close: '100' }));
    }
    for (let i = 50; i < 80; i++) {
      const k = i - 50;
      rows.push(
        row(i, { action: i === 65 ? 'flat' : 'error', close: k % 2 === 0 ? '100' : '300' }),
      );
    }

    const digest = summarizeRegimeSplit(rows);

    // i=9: window [0..9] is all 100 -> stdev 0 -> quiet. fwd = (close10-close9)/close9 = 0.
    expect(digest.quiet).toEqual([{ action: 'long', count: 1, meanForwardReturnBps: 0 }]);
    // i=65 (k=15, odd -> 300; i=66, k=16, even -> 100): window [56..65] is fully inside the
    // alternating zone -> stdev > 0 -> active. fwd = (100-300)/300.
    expect(digest.active).toEqual([
      { action: 'flat', count: 1, meanForwardReturnBps: ((100 - 300) / 300) * 10000 },
    ]);
  });

  it('returns empty quiet/active arrays when no row has a full trailing-window stdev', () => {
    // Fewer than 10 rows -> trailingStdev is null for every index.
    const rows: ScoringRow[] = [
      row(0, { action: 'long', close: '100' }),
      row(1, { action: 'flat', close: '110' }),
    ];
    expect(summarizeRegimeSplit(rows)).toEqual({ quiet: [], active: [] });
  });
});
