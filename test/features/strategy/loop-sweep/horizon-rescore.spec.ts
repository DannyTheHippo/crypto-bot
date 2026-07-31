import { describe, it, expect } from 'vitest';
// @ts-expect-error scripts/** live outside the tsconfig graph (see tsconfig.eslint.json's include
// list) — the pure core is a stdlib-only .mjs with no declaration file. Same bridge
// forward-return.spec.ts uses for the sibling module this one reuses.
import * as coreModule from '../../../../scripts/loop-horizon-rescore-core.mjs';

// The hold-matched horizon re-score. What is NEW here, and what these tests exist to pin, is only the
// horizon set {1,4,8,16,24,54}, the control-reproduction self-check against CONTROL_REFERENCE, the
// gap-share regression flag, and the ordering-flip detector — the price-grid and bootstrap primitives
// are reused verbatim from loop-forward-return-core.mjs and are already pinned by forward-return.spec.ts.
//
// The genuine "REPRODUCED" control-check path (an exact match against CONTROL_REFERENCE's bootstrap
// CI) cannot be reconstructed from a synthetic fixture — it depends on the real cluster bootstrap over
// real market data, which is exactly why the brief requires validating it against the live tool
// (`pnpm loop:horizon-rescore`, checked 2026-07-31: reproduced both v1 and v2's h=1 figures exactly),
// not a unit test. What IS unit-testable, and tested below, is that a MISMATCH is caught and named.

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
  summary: string;
}
interface ControlCheck {
  version: number;
  reference: { mean: number; ciLo: number; ciHi: number; n: number; clusters: number };
  actual: {
    mean: number | null;
    ciLo: number | null;
    ciHi: number | null;
    n: number;
    clusters: number;
  };
  reproduced: boolean;
  mismatches: string[];
}
interface Panel {
  playbookVersion: number | null;
  population: 'all' | 'flat_only';
  entries: number;
  scaleIns: number;
  horizons: Horizon[];
  controlCheck: ControlCheck | null;
}
interface OrderingFlip {
  population: 'all' | 'flat_only';
  a: number | null;
  b: number | null;
  comparedHorizon: number;
  atReference: string;
  atCompared: string;
}
interface Annotation {
  kind: string;
  detail: string;
}
interface Result {
  status: 'measured' | 'undetermined';
  panels: Panel[];
  orderingFlips: OrderingFlip[];
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
  CONTROL_HORIZONS: number[];
  NEW_HORIZONS: number[];
  ORDERING_REFERENCE_HORIZON: number;
  GAP_REGRESSION_MARGIN: number;
  CONTROL_REFERENCE: Record<
    number,
    { mean: number; ciLo: number; ciHi: number; n: number; clusters: number }
  >;
  MIN_ENTRIES: number;
  MIN_CLUSTERS: number;
  MAX_GAP_SHARE: number;
  computeOrderingFlips: (panels: Panel[]) => OrderingFlip[];
  computeHorizonRescore: (input: {
    entryRows: EntryRow[] | null;
    gridRows: GridRow[] | null;
  }) => Result;
  renderHorizonRescore: (r: Result) => string;
}
const {
  BAR_MS,
  HORIZONS,
  CONTROL_HORIZONS,
  NEW_HORIZONS,
  ORDERING_REFERENCE_HORIZON,
  GAP_REGRESSION_MARGIN,
  CONTROL_REFERENCE,
  MIN_ENTRIES,
  MIN_CLUSTERS,
  MAX_GAP_SHARE,
  computeOrderingFlips,
  computeHorizonRescore,
} = coreModule as unknown as Core;

// A real on-grid bar open, same constant forward-return.spec.ts uses.
const T0 = 1785448800000;

function entry(over: Partial<EntryRow> = {}): EntryRow {
  return {
    eventTime: T0,
    venue: 'binance',
    symbol: 'BTC/USDT',
    action: 'open_long',
    playbookVersion: 1,
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

describe('hold-matched horizon re-score — horizon set', () => {
  it('adds {16,54} to the declared {1,4,8,24} grid without altering the control horizons', () => {
    expect(CONTROL_HORIZONS).toEqual([1, 4, 8, 24]);
    expect(NEW_HORIZONS).toEqual([16, 54]);
    expect(HORIZONS).toEqual([1, 4, 8, 24, 16, 54]);
    expect(ORDERING_REFERENCE_HORIZON).toBe(24);
  });

  it('pins CONTROL_REFERENCE to exactly the two live-powered playbook versions', () => {
    expect(Object.keys(CONTROL_REFERENCE).sort()).toEqual(['1', '2']);
    expect(CONTROL_REFERENCE[1]).toEqual({
      mean: -16.9,
      ciLo: -28.5,
      ciHi: -4.9,
      n: 28,
      clusters: 13,
    });
    expect(CONTROL_REFERENCE[2]).toEqual({
      mean: -15.9,
      ciLo: -25.1,
      ciHi: -5.5,
      n: 18,
      clusters: 11,
    });
  });
});

describe('computeOrderingFlips — pairwise ranking, POWERED cells only', () => {
  function panel(
    version: number,
    population: 'all',
    means: Record<number, number>,
    powered = true,
  ): Panel {
    return {
      playbookVersion: version,
      population,
      entries: 0,
      scaleIns: 0,
      controlCheck: null,
      horizons: Object.entries(means).map(([h, mean]) => ({
        h: Number(h),
        status: 'measured',
        reason: null,
        counts: { ok: 0, gap: 0, pending: 0, noSeries: 0, badPrice: 0, noEntryBar: 0 },
        gapShare: 0,
        cell: { n: MIN_ENTRIES, clusters: MIN_CLUSTERS, mean, ciLo: mean, ciHi: mean, powered },
        summary: '',
      })),
    };
  }

  it('flags a FLIP when two versions swap relative order between h=24 and a NEW horizon', () => {
    const panels = [panel(101, 'all', { 24: -10, 16: 10 }), panel(102, 'all', { 24: 10, 16: -10 })];
    const flips = computeOrderingFlips(panels);
    expect(flips).toHaveLength(1);
    expect(flips[0]).toMatchObject({
      population: 'all',
      a: 101,
      b: 102,
      comparedHorizon: 16,
      atReference: 'v102>v101',
      atCompared: 'v101>v102',
    });
  });

  it('raises NO flip when the relative order agrees at every horizon', () => {
    const panels = [
      panel(201, 'all', { 24: 50, 16: 40, 54: 60 }),
      panel(202, 'all', { 24: 10, 16: 5, 54: 15 }),
    ];
    expect(computeOrderingFlips(panels)).toEqual([]);
  });

  it('never builds a flip from a cell that is not POWERED on both sides', () => {
    // v302's h=24 cell is UNDERPOWERED — an enormous point-estimate gap must still yield NO flip,
    // because an order built from an unattributable estimate is a coin flip dressed as a ranking.
    const panels = [
      panel(301, 'all', { 24: -1000, 16: 1000 }),
      panel(302, 'all', { 24: 1000, 16: -1000 }, false),
    ];
    expect(computeOrderingFlips(panels)).toEqual([]);
  });
});

describe('hold-matched horizon re-score — control reproduction self-check', () => {
  it('names a FAILED reproduction when a live version 1/2 panel does not match CONTROL_REFERENCE', () => {
    // POWERED (n=15, clusters=5 — CONTROL_REFERENCE only ever pins a POWERED figure) but on a flat
    // price series, so mean/CI land at 0 — nowhere near CONTROL_REFERENCE[1]'s (n=28, clusters=13,
    // mean=-16.9). This fixture exists purely to exercise the mismatch path, not to model a
    // realistic corpus.
    const symbols = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'];
    const gridRows = symbols.flatMap((s) =>
      bars(
        'binance',
        `${s}/USDT`,
        T0,
        Array.from({ length: 60 }, () => 100),
      ),
    );
    const entryRows = symbols.flatMap((s) =>
      Array.from({ length: 3 }, () => entry({ symbol: `${s}/USDT`, playbookVersion: 1 })),
    );
    const r = computeHorizonRescore({ entryRows, gridRows });
    const panel = r.panels.find((p) => p.playbookVersion === 1 && p.population === 'all');
    expect(panel?.controlCheck?.reproduced).toBe(false);
    expect(panel?.controlCheck?.mismatches).toContain('n');
    expect(r.annotations.map((a) => a.kind)).toContain(
      'horizon_rescore_control_reproduction_failed',
    );
  });

  it('runs no control check at all for a playbook version outside CONTROL_REFERENCE', () => {
    const gridRows = bars(
      'binance',
      'AAA/USDT',
      T0,
      Array.from({ length: 60 }, () => 100),
    );
    const r = computeHorizonRescore({
      entryRows: [entry({ symbol: 'AAA/USDT', playbookVersion: 3 })],
      gridRows,
    });
    const panel = r.panels.find((p) => p.playbookVersion === 3 && p.population === 'all');
    expect(panel?.controlCheck).toBeNull();
    expect(r.annotations.map((a) => a.kind)).not.toContain(
      'horizon_rescore_control_reproduction_failed',
    );
  });
});

describe('hold-matched horizon re-score — gap-share regression flag', () => {
  it('flags h=54 as a materially worse gap share than the h=24 control, and reads it UNDETERMINED', () => {
    // Two symbols carry a bar all the way through h=54; three have a genuine HOLE at the h=54 target
    // (two consecutive missing bars, so the lookup lands more than one bar past target — a real gap,
    // not the pending-horizon case). All five carry the h=24 bar cleanly, so the control horizon
    // itself reads a clean 0% gap share.
    const okSymbols = ['AAA', 'BBB'];
    const gapSymbols = ['CCC', 'DDD', 'EEE'];
    const flat = Array.from({ length: 54 }, () => 100); // indices 0..53, present
    const gridRows = [
      ...okSymbols.flatMap(
        (s) => bars('binance', `${s}/USDT`, T0, [...flat, 100, 100]), // indices 0..55 all present
      ),
      ...gapSymbols.flatMap((s) =>
        bars(
          'binance',
          `${s}/USDT`,
          T0,
          [...flat, undefined, undefined, undefined, undefined, undefined, undefined, 100], // 54,55 holed, resumes at 60
        ),
      ),
    ];
    const entryRows = [...okSymbols, ...gapSymbols].map((s) =>
      entry({ symbol: `${s}/USDT`, playbookVersion: 301 }),
    );
    const r = computeHorizonRescore({ entryRows, gridRows });
    const panel = r.panels.find((p) => p.playbookVersion === 301 && p.population === 'all');
    const h24 = panel?.horizons.find((h) => h.h === 24);
    const h54 = panel?.horizons.find((h) => h.h === 54);

    expect(h24?.status).toBe('measured');
    expect(h24?.gapShare).toBe(0);
    expect(h54?.status).toBe('undetermined');
    expect(h54?.reason).toBe('gap_share_exceeded');
    expect(h54?.gapShare).toBeGreaterThan(MAX_GAP_SHARE);
    expect((h54?.gapShare ?? 0) - (h24?.gapShare ?? 0)).toBeGreaterThan(GAP_REGRESSION_MARGIN);
    expect(r.annotations.map((a) => a.kind)).toContain('horizon_rescore_gap_regression');
    expect(r.annotations.map((a) => a.kind)).toContain('horizon_rescore_horizon_gap_undetermined');
  });

  it('raises NO gap-regression flag when the new horizon is no worse than the control', () => {
    const gridRows = bars(
      'binance',
      'AAA/USDT',
      T0,
      Array.from({ length: 60 }, () => 100),
    );
    const r = computeHorizonRescore({
      entryRows: [entry({ symbol: 'AAA/USDT', playbookVersion: 401 })],
      gridRows,
    });
    expect(r.annotations.map((a) => a.kind)).not.toContain('horizon_rescore_gap_regression');
  });
});

describe('hold-matched horizon re-score — end-to-end ordering flip and horizon traversal', () => {
  // A price path that rises to +5000bps by h=16 and then reverses to -5000bps by h=24, holding there
  // through h=54 — engineered so a LONG arm and a SHORT arm on the identical series swap relative
  // order between h=16 and h=24, and agree again at h=54 (same sign as h=24).
  function humpBars(venue: string, symbol: string, t0: number): GridRow[] {
    const closes = Array.from({ length: 55 }, (_, i) => {
      if (i < 16) return 100;
      if (i < 24) return 150 - (i - 16) * 12.5;
      return 50;
    });
    return bars(venue, symbol, t0, closes);
  }

  const symbols = ['AAA/USDT', 'BBB/USDT', 'CCC/USDT', 'DDD/USDT', 'EEE/USDT'];
  const gridRows = symbols.flatMap((s) => humpBars('binance', s, T0));
  // 3 duplicate entries per symbol (15 total, 5 clusters) — enough to power both arms; duplicating
  // the same (symbol, t0) is a valid input shape (the core never dedupes entry rows) and keeps the
  // fixture's price path simple rather than needing it to repeat at every staggered entry time.
  const longEntries = symbols.flatMap((s) =>
    Array.from({ length: 3 }, () =>
      entry({ symbol: s, action: 'open_long', playbookVersion: 501 }),
    ),
  );
  const shortEntries = symbols.flatMap((s) =>
    Array.from({ length: 3 }, () =>
      entry({ symbol: s, action: 'open_short', playbookVersion: 502 }),
    ),
  );
  const entryRows = [...longEntries, ...shortEntries];

  it('walks every horizon in HORIZONS for a powered panel, control set and new set alike', () => {
    const r = computeHorizonRescore({ entryRows, gridRows });
    const panel = r.panels.find((p) => p.playbookVersion === 501 && p.population === 'all');
    expect(panel?.horizons.map((h) => h.h)).toEqual(HORIZONS);
    const h16 = panel?.horizons.find((h) => h.h === 16);
    const h24 = panel?.horizons.find((h) => h.h === 24);
    expect(h16?.cell?.powered).toBe(true);
    expect(h24?.cell?.powered).toBe(true);
    // Exact, not approximate: every one of the 15 duplicate entries lands on the identical
    // (150-100)/100 and (50-100)/100 ratios, so the mean carries no floating-point summation
    // slop — toBeCloseTo would mask a real regression here, not just rounding noise.
    expect(h16?.cell?.mean).toBe(5000);
    expect(h24?.cell?.mean).toBe(-5000);
  });

  it('surfaces the ordering flip end-to-end as a named annotation', () => {
    const r = computeHorizonRescore({ entryRows, gridRows });
    const flip = r.orderingFlips.find(
      (f) => f.population === 'all' && f.a === 501 && f.b === 502 && f.comparedHorizon === 16,
    );
    expect(flip).toBeDefined();
    expect(flip?.atReference).toBe('v502>v501');
    expect(flip?.atCompared).toBe('v501>v502');
    // h=54 shares h=24's sign, so it must NOT also report a flip.
    expect(
      r.orderingFlips.some((f) => f.a === 501 && f.b === 502 && f.comparedHorizon === 54),
    ).toBe(false);
    expect(r.annotations.map((a) => a.kind)).toContain('horizon_rescore_ordering_flip');
  });
});

describe('hold-matched horizon re-score — void reads are named, never clean zeros', () => {
  const gridRows = bars(
    'binance',
    'BTC/USDT',
    T0,
    Array.from({ length: 60 }, () => 100),
  );

  it('names a failed ENTRY probe and returns no panels', () => {
    const r = computeHorizonRescore({ entryRows: null, gridRows });
    expect(r.status).toBe('undetermined');
    expect(r.panels).toEqual([]);
    expect(r.orderingFlips).toEqual([]);
    expect(r.annotations.map((a) => a.kind)).toContain('horizon_rescore_entry_probe_failed');
  });

  it('names a failed GRID probe and returns no panels', () => {
    const r = computeHorizonRescore({ entryRows: [entry()], gridRows: null });
    expect(r.status).toBe('undetermined');
    expect(r.panels).toEqual([]);
    expect(r.annotations.map((a) => a.kind)).toContain('horizon_rescore_grid_probe_failed');
  });

  it('never throws on malformed input — a measurement fails open', () => {
    for (const bad of [undefined, {}, { entryRows: 'nope', gridRows: 5 }, { entryRows: [null] }]) {
      expect(() =>
        computeHorizonRescore(bad as unknown as Parameters<typeof computeHorizonRescore>[0]),
      ).not.toThrow();
    }
  });

  it('carries NO alarms key — a re-score is a finding, never an alarm', () => {
    const r = computeHorizonRescore({ entryRows: [entry({ playbookVersion: 3 })], gridRows });
    expect('alarms' in r).toBe(false);
    expect(Object.keys(r).sort()).toEqual(['annotations', 'orderingFlips', 'panels', 'status']);
  });
});
