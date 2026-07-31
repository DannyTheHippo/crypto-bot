import { describe, it, expect } from 'vitest';
// @ts-expect-error scripts/** live outside the tsconfig graph (see tsconfig.eslint.json's include
// list) — the pure core is a stdlib-only .mjs with no declaration file. Same bridge
// pass-record-audit.spec.ts uses for classifyUnrecordedSweeps.
import * as coreModule from '../../../../scripts/loop-forward-return-core.mjs';

// The realised entry forward-return measurement (WATCH-PLAYBOOK-V10-1). What this spec is really
// pinning is the FAIL DIRECTION and the void-read discipline: the thing measures live behaviour
// against an offline replay prediction, and every way it could quietly report a number it has no
// right to report is a defect worth a regression test.
//
// Three of these tests exist because the loop has already been burned by the exact failure:
//   * the mixed-symbol test reproduces defect #37, which interleaved symbols in one series and scored
//     BTC->LINK transitions as -99.99% (-9999 bps). The fixture is built so that a symbol-agnostic
//     lookup produces EXACTLY that number, and the test asserts it does not appear.
//   * the cluster test pins that n>=12 alone never powers a cell — 20 entries on 3 symbols is 3
//     effective observations for a bootstrap that resamples symbols.
//   * the void tests pin that no failure path may return a clean zero. An absence that reads as a
//     reading is the defect class this loop keeps rediscovering.

interface Cell {
  n: number;
  clusters: number;
  mean: number | null;
  ciLo: number | null;
  ciHi: number | null;
  powered: boolean;
}
interface Counts {
  ok: number;
  gap: number;
  pending: number;
  noSeries: number;
  badPrice: number;
  noEntryBar: number;
}
interface Horizon {
  h: number;
  status: 'measured' | 'undetermined';
  reason: string | null;
  counts: Counts;
  gapShare: number | null;
  cell: Cell | null;
  divergence: {
    predicted: number;
    delta: number | null;
    flagged: boolean;
    reason: string | null;
  } | null;
  summary: string;
}
interface Panel {
  playbookVersion: number | null;
  arm: string | null;
  population: 'all' | 'flat_only';
  entries: number;
  scaleIns: number;
  hasReference: boolean;
  horizons: Horizon[];
}
interface Annotation {
  kind: string;
  detail: string;
}
interface Result {
  status: 'measured' | 'undetermined';
  panels: Panel[];
  annotations: Annotation[];
}
interface EntryRow {
  eventTime: number;
  venue: string;
  symbol: string;
  action: string;
  playbookVersion: number | null;
  isFlat: boolean;
}
interface GridRow {
  eventTime: number;
  venue: string;
  symbol: string;
  close: number;
}
interface Core {
  BAR_MS: number;
  HORIZONS: number[];
  MIN_ENTRIES: number;
  MIN_CLUSTERS: number;
  MAX_GAP_SHARE: number;
  REPLAY_REFERENCE: Record<string, { arm: string; predicted: Record<string, number> }>;
  computeForwardReturn: (input: {
    entryRows: EntryRow[] | null;
    gridRows: GridRow[] | null;
    reference: unknown;
  }) => Result;
  sweepAnnotations: (r: Result) => Annotation[];
  renderForwardReturn: (r: Result) => string;
}
const {
  BAR_MS,
  MIN_ENTRIES,
  MIN_CLUSTERS,
  MAX_GAP_SHARE,
  REPLAY_REFERENCE,
  computeForwardReturn,
  sweepAnnotations,
  renderForwardReturn,
} = coreModule as unknown as Core;

// A real on-grid bar open taken from the live journal, so the fixtures exercise the same modulo
// arithmetic production does.
const T0 = 1785448800000;
const REF = REPLAY_REFERENCE;

function entry(over: Partial<EntryRow> = {}): EntryRow {
  return {
    eventTime: T0,
    venue: 'binance',
    symbol: 'BTC/USDT',
    action: 'open_long',
    playbookVersion: 10,
    isFlat: true,
    ...over,
  };
}

/** Bars at t0 + i*BAR_MS for each close given; `undefined` entries leave a HOLE in the series. */
function bars(
  venue: string,
  symbol: string,
  t0: number,
  closes: (number | undefined)[],
): GridRow[] {
  const out: GridRow[] = [];
  closes.forEach((c, i) => {
    if (c === undefined) return;
    out.push({ eventTime: t0 + i * BAR_MS, venue, symbol, close: c });
  });
  return out;
}

/** A flat, hole-free series long enough for every horizon (h=24 is the deepest). */
function fullSeries(
  venue: string,
  symbol: string,
  t0: number,
  price: number,
  drift = 0,
): GridRow[] {
  return bars(
    venue,
    symbol,
    t0,
    Array.from({ length: 40 }, (_, i) => price + drift * i),
  );
}

const h1 = (r: Result, population: 'all' | 'flat_only' = 'all'): Horizon => {
  const p = r.panels.find((x) => x.population === population);
  if (!p) throw new Error(`no ${population} panel`);
  const h = p.horizons.find((x) => x.h === 1);
  if (!h) throw new Error('no h=1');
  return h;
};

describe('realised entry forward return — cross-symbol and cross-venue isolation', () => {
  it('yields NO observation when only a DIFFERENT symbol has a bar at the forward timestamp (defect #37)', () => {
    // BTC has its entry bar and a bar three bars later — nothing at the h=1 target. LINK does have a
    // bar exactly at the target, priced so that a symbol-agnostic lookup returns exactly -9999 bps.
    const gridRows = [
      ...bars('binance', 'BTC/USDT', T0, [100, undefined, undefined, 100]),
      ...bars('binance', 'LINK/USDT', T0, [0.01, 0.01, 0.01, 0.01]),
    ];
    const r = computeForwardReturn({ entryRows: [entry()], gridRows, reference: REF });
    const h = h1(r);

    expect(h.counts.ok).toBe(0);
    expect(h.counts.gap).toBe(1);
    // The lone entry gapped, so the gap share is 100% and the horizon voids rather than reporting
    // anything at all — no cell is minted to hold a borrowed price in the first place.
    expect(h.status).toBe('undetermined');
    expect(h.reason).toBe('gap_share_exceeded');
    expect(h.cell).toBeNull();
    // The explicit assertion the defect demands: the catastrophic cross-symbol number never appears.
    expect(JSON.stringify(r)).not.toContain('-9999');
    expect(JSON.stringify(r)).not.toContain('-99.99');
  });

  it('yields NO read across venues for the same symbol string', () => {
    // Same symbol on two venues: two different books. binance BTC skips the h=1 target; binanceusdm
    // BTC has it. Keying on (venue, symbol) makes borrowing that price structurally impossible.
    const gridRows = [
      ...bars('binance', 'BTC/USDT', T0, [100, undefined, undefined, 100]),
      ...bars('binanceusdm', 'BTC/USDT', T0, [500, 900, 900, 900]),
    ];
    const r = computeForwardReturn({
      entryRows: [entry({ venue: 'binance' })],
      gridRows,
      reference: REF,
    });
    const h = h1(r);

    expect(h.counts.ok).toBe(0);
    expect(h.counts.gap).toBe(1);
    expect(h.status).toBe('undetermined');
    expect(h.cell).toBeNull();
    // The perp book's +80% move must not have leaked into the spot entry's score.
    expect(JSON.stringify(r)).not.toContain('8000');
  });
});

describe('realised entry forward return — gap vs pending horizon', () => {
  it('counts a not-yet-elapsed horizon as PENDING and a hole in the series as a GAP, separately', () => {
    // AAA: series stops at the entry bar, so the forward bar simply has not happened yet.
    // BBB: series runs well past the target but skips it — a hole.
    const gridRows = [
      ...bars('binance', 'AAA/USDT', T0, [100]),
      ...bars('binance', 'BBB/USDT', T0, [100, undefined, undefined, 100]),
    ];
    const r = computeForwardReturn({
      entryRows: [entry({ symbol: 'AAA/USDT' }), entry({ symbol: 'BBB/USDT' })],
      gridRows,
      reference: REF,
    });
    const h = h1(r);

    expect(h.counts.pending).toBe(1);
    expect(h.counts.gap).toBe(1);
    expect(h.counts.ok).toBe(0);
    // Pending is benign and must NOT inflate the gap share, or every fresh deployment would read
    // UNDETERMINED on its newest entries.
    expect(h.gapShare).toBe(1);
  });

  it('reads a horizon UNDETERMINED — not as a biased subsample — once gaps exceed the share bar', () => {
    // Four symbols: one clean, three holed. 3/4 = 75% > MAX_GAP_SHARE.
    const gridRows = [
      ...fullSeries('binance', 'AAA/USDT', T0, 100),
      ...bars('binance', 'BBB/USDT', T0, [100, undefined, undefined, 100]),
      ...bars('binance', 'CCC/USDT', T0, [100, undefined, undefined, 100]),
      ...bars('binance', 'DDD/USDT', T0, [100, undefined, undefined, 100]),
    ];
    const r = computeForwardReturn({
      entryRows: ['AAA', 'BBB', 'CCC', 'DDD'].map((s) => entry({ symbol: `${s}/USDT` })),
      gridRows,
      reference: REF,
    });
    const h = h1(r);

    expect(h.gapShare).toBeGreaterThan(MAX_GAP_SHARE);
    expect(h.status).toBe('undetermined');
    expect(h.reason).toBe('gap_share_exceeded');
    expect(h.cell).toBeNull();
    expect(r.annotations.map((a) => a.kind)).toContain('forward_return_horizon_gap_undetermined');
  });
});

describe('realised entry forward return — power gating', () => {
  it('is UNDERPOWERED on the CLUSTER clause with 20 entries on 3 symbols, despite n >= 12', () => {
    const symbols = ['AAA/USDT', 'BBB/USDT', 'CCC/USDT'];
    const gridRows = symbols.flatMap((s) => fullSeries('binance', s, T0, 100, 0.1));
    const entryRows = Array.from({ length: 20 }, (_, i) =>
      entry({ symbol: symbols[i % 3], eventTime: T0 + i * BAR_MS }),
    );
    const r = computeForwardReturn({ entryRows, gridRows, reference: REF });
    const h = h1(r);

    expect(h.cell?.n).toBe(20);
    expect(h.cell?.n).toBeGreaterThanOrEqual(MIN_ENTRIES);
    expect(h.cell?.clusters).toBe(3);
    expect(h.cell?.powered).toBe(false);
    // No interval is minted below the cluster floor — a 3-cluster CI is a lattice artifact.
    expect(h.cell?.ciLo).toBeNull();
    expect(h.cell?.ciHi).toBeNull();
    // The failing clause is named accurately: n passed, clusters did not.
    expect(h.summary).toContain('UNDERPOWERED');
    expect(h.summary).toContain(`clusters=3<${MIN_CLUSTERS}`);
    expect(h.summary).not.toContain(`n=20<${MIN_ENTRIES}`);
  });

  it('never prints a point estimate in a string separated from its power label', () => {
    const gridRows = fullSeries('binance', 'AAA/USDT', T0, 100, 0.5);
    const r = computeForwardReturn({
      entryRows: [entry({ symbol: 'AAA/USDT' })],
      gridRows,
      reference: REF,
    });
    const h = h1(r);
    expect(h.cell?.powered).toBe(false);
    // The mean exists and is reported — but every rendered string carrying it also carries the label.
    expect(h.cell?.mean).not.toBeNull();
    expect(h.summary).toContain('UNDERPOWERED');
    for (const a of r.annotations.filter((x) => x.kind === 'forward_return_underpowered')) {
      expect(a.detail).toContain('UNDERPOWERED');
    }
    // The compacted sweep view carries no estimates at all rather than risk detaching one.
    const rollup = sweepAnnotations(r).find((a) => a.kind === 'forward_return_underpowered_rollup');
    expect(rollup).toBeDefined();
    expect(rollup?.detail).toContain('UNDERPOWERED');
    expect(rollup?.detail).not.toMatch(/mean=/);
  });

  it('raises NO divergence flag while underpowered, however far the point estimates are apart', () => {
    // A ~+5000 bps live move against a replay prediction of -0.8 bps at h=1. Enormous, and still not
    // evidence: one entry on one symbol.
    const gridRows = bars(
      'binance',
      'AAA/USDT',
      T0,
      Array.from({ length: 40 }, (_, i) => (i === 0 ? 100 : 150)),
    );
    const r = computeForwardReturn({
      entryRows: [entry({ symbol: 'AAA/USDT' })],
      gridRows,
      reference: REF,
    });
    const h = h1(r);

    expect(h.cell?.powered).toBe(false);
    expect(h.cell?.mean).toBeGreaterThan(4000);
    // Also pins the frozen WATCH figure itself (watches.md:228, `inverted` h=1).
    const predictedH1 = REF[10]?.predicted?.[1];
    expect(predictedH1).toBe(-0.8);
    expect(h.divergence?.predicted).toBe(predictedH1);
    expect(h.divergence?.flagged).toBe(false);
    expect(h.divergence?.reason).toBe('underpowered');
    expect(h.divergence?.delta).toBeNull();
    expect(r.annotations.map((a) => a.kind)).not.toContain('forward_return_replay_divergence');
  });
});

describe('realised entry forward return — void reads are named, never clean zeros', () => {
  const gridRows = fullSeries('binance', 'BTC/USDT', T0, 100);

  it('names a failed ENTRY probe and returns no panels', () => {
    const r = computeForwardReturn({ entryRows: null, gridRows, reference: REF });
    expect(r.status).toBe('undetermined');
    expect(r.panels).toEqual([]);
    expect(r.annotations.map((a) => a.kind)).toContain('forward_return_entry_probe_failed');
  });

  it('names a failed GRID probe and returns no panels', () => {
    const r = computeForwardReturn({ entryRows: [entry()], gridRows: null, reference: REF });
    expect(r.status).toBe('undetermined');
    expect(r.panels).toEqual([]);
    expect(r.annotations.map((a) => a.kind)).toContain('forward_return_grid_probe_failed');
  });

  it('names an unreadable replay reference and evaluates NO divergence', () => {
    const r = computeForwardReturn({ entryRows: [entry()], gridRows, reference: null });
    expect(r.annotations.map((a) => a.kind)).toContain('forward_return_reference_unreadable');
    // Live returns are still measured — the reference only gates the COMPARISON.
    expect(r.panels.length).toBeGreaterThan(0);
    for (const p of r.panels) {
      expect(p.hasReference).toBe(false);
      for (const h of p.horizons) expect(h.divergence).toBeNull();
    }
  });

  it('reads flat_only as UNDETERMINED — not n=0 — when the FLAT marker matches zero rows', () => {
    const r = computeForwardReturn({
      entryRows: [entry({ isFlat: false }), entry({ isFlat: false, symbol: 'BTC/USDT' })],
      gridRows,
      reference: REF,
    });
    expect(r.annotations.map((a) => a.kind)).toContain('forward_return_flat_marker_absent');

    const flat = r.panels.find((p) => p.population === 'flat_only');
    expect(flat).toBeDefined();
    for (const h of flat!.horizons) {
      expect(h.status).toBe('undetermined');
      expect(h.reason).toBe('flat_marker_absent');
      // The thing that must NOT happen: a cell reporting n=0 as though the lane took no FLAT entries.
      expect(h.cell).toBeNull();
      expect(h.summary).toContain('not n=0');
    }
  });

  it('distinguishes a determinate ZERO-entry reading from a failed probe', () => {
    const r = computeForwardReturn({ entryRows: [], gridRows, reference: REF });
    const kinds = r.annotations.map((a) => a.kind);
    expect(kinds).toContain('forward_return_no_entries');
    expect(kinds).not.toContain('forward_return_entry_probe_failed');
  });

  it('counts and discloses same-side SCALE-INS instead of silently dropping them', () => {
    const r = computeForwardReturn({
      entryRows: [entry({ isFlat: true }), entry({ isFlat: false })],
      gridRows,
      reference: REF,
    });
    const all = r.panels.find((p) => p.population === 'all');
    const flat = r.panels.find((p) => p.population === 'flat_only');
    expect(all?.entries).toBe(2);
    expect(all?.scaleIns).toBe(1);
    expect(flat?.entries).toBe(1);
    expect(r.annotations.map((a) => a.kind)).toContain('forward_return_scale_ins_present');
  });

  it('refuses an entry whose event_time is off the bar grid (an exec-triggered fill time)', () => {
    const r = computeForwardReturn({
      entryRows: [entry({ eventTime: T0 + 12345 })],
      gridRows,
      reference: REF,
    });
    expect(r.annotations.map((a) => a.kind)).toContain('forward_return_entries_off_bar');
  });
});

describe('realised entry forward return — determinism and fail-open shape', () => {
  // A powered cell, so a bootstrap actually runs and there are intervals to compare.
  const symbols = ['AAA/USDT', 'BBB/USDT', 'CCC/USDT', 'DDD/USDT', 'EEE/USDT'];
  const gridRows = symbols.flatMap((s, k) => fullSeries('binance', s, T0, 100 + k, 0.1 * (k + 1)));
  const entryRows = Array.from({ length: 15 }, (_, i) =>
    entry({ symbol: symbols[i % 5], eventTime: T0 + i * BAR_MS }),
  );

  it('produces a POWERED cell on 15 entries across 5 symbols', () => {
    const h = h1(computeForwardReturn({ entryRows, gridRows, reference: REF }));
    expect(h.cell?.powered).toBe(true);
    expect(h.cell?.clusters).toBe(5);
    expect(h.cell?.ciLo).not.toBeNull();
    expect(h.cell?.ciHi).not.toBeNull();
  });

  it('produces byte-identical intervals on two runs over identical input', () => {
    const a = computeForwardReturn({ entryRows, gridRows, reference: REF });
    const b = computeForwardReturn({ entryRows, gridRows, reference: REF });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(renderForwardReturn(a)).toBe(renderForwardReturn(b));
  });

  it('produces byte-identical intervals when the SAME rows arrive in a different order', () => {
    // The frozen seed only buys determinism because the cluster list is sorted before resampling —
    // a psql row order is not a contract, and identical data must not move the interval.
    const rot = <T>(xs: T[], k: number): T[] => [...xs.slice(k), ...xs.slice(0, k)];
    const a = computeForwardReturn({ entryRows, gridRows, reference: REF });
    const b = computeForwardReturn({
      entryRows: rot(entryRows, 7),
      gridRows: rot(gridRows, 53),
      reference: REF,
    });
    expect(JSON.stringify(a.panels)).toBe(JSON.stringify(b.panels));
  });

  it('carries NO alarms key — a divergence is a finding, never an alarm', () => {
    const r = computeForwardReturn({ entryRows, gridRows, reference: REF });
    expect('alarms' in r).toBe(false);
    expect(Object.keys(r).sort()).toEqual(['annotations', 'panels', 'status']);
    // The sweep-merged view is annotations only, so it cannot contribute an alarm either.
    for (const a of sweepAnnotations(r)) {
      expect(Object.keys(a).sort()).toEqual(['detail', 'kind']);
    }
  });

  it('never throws on malformed input — a measurement fails open', () => {
    for (const bad of [undefined, {}, { entryRows: 'nope', gridRows: 5 }, { entryRows: [null] }]) {
      expect(() =>
        computeForwardReturn(bad as unknown as Parameters<typeof computeForwardReturn>[0]),
      ).not.toThrow();
    }
  });
});
