import { describe, it, expect } from 'vitest';
// @ts-expect-error scripts/** live outside the tsconfig graph (see tsconfig.eslint.json's include
// list) — the pure cores are stdlib-only .mjs with no declaration file. Same bridge
// forward-return.spec.ts uses for computeForwardReturn.
import * as frCore from '../../../../scripts/loop-forward-return-core.mjs';
// @ts-expect-error same reason as above.
import * as oosCore from '../../../../scripts/loop-oos-arm-core.mjs';

// Pre-registered in research/studies/oos-session-arm-2026-08-03.md. This spec covers two things:
//   1. The four additions this arm needed from the ALREADY-SHIPPED loop-forward-return-core.mjs
//      (eligibleHorizons, includeObservations, the exported baseAsset/summarise/fmtBps, and the new
//      pairedClusterBootstrapDelta) — kept here rather than in forward-return.spec.ts because that
//      file is existing coverage this task's scope does not touch.
//   2. The new scorer itself (loop-oos-arm-core.mjs), which is annotations-only and fails OPEN: every
//      test below is really pinning that an absent/void/underpowered read is reported as such and
//      never silently upgraded into a clean or scoreable one.

interface GridRow {
  eventTime: number;
  venue: string;
  symbol: string;
  close: number;
}
interface EntryRow {
  eventTime: number;
  venue: string;
  symbol: string;
  action: string;
  playbookVersion: number | null;
  isFlat: boolean;
}

const {
  BAR_MS,
  HORIZONS,
  MIN_ENTRIES,
  MIN_CLUSTERS,
  N_BOOT,
  BOOTSTRAP_SEED,
  makeRand,
  baseAsset,
  computeForwardReturn,
  pairedClusterBootstrapDelta,
  summarise,
  fmtBps,
} = frCore as {
  BAR_MS: number;
  HORIZONS: number[];
  MIN_ENTRIES: number;
  MIN_CLUSTERS: number;
  N_BOOT: number;
  BOOTSTRAP_SEED: number;
  makeRand: (seed: number) => () => number;
  baseAsset: (symbol: string) => string;
  computeForwardReturn: (input: {
    entryRows: EntryRow[] | null;
    gridRows: GridRow[] | null;
    reference: unknown;
    eligibleHorizons?: number[];
    includeObservations?: boolean;
  }) => {
    status: string;
    panels: {
      horizons: {
        h: number;
        status: string;
        cell: { n: number; clusters: number; powered: boolean } | null;
        obs?: { symbol: string; venue: string; t0: number; bps: number }[];
      }[];
    }[];
    annotations: { kind: string; detail: string }[];
  };
  pairedClusterBootstrapDelta: (
    obsA: { symbol: string; bps: number }[],
    obsB: { symbol: string; bps: number }[],
    rand: () => number,
  ) => { bases: number; draws: number[]; degenerate: number };
  summarise: (cell: {
    n: number;
    clusters: number;
    mean: number | null;
    ciLo: number | null;
    ciHi: number | null;
    powered: boolean;
  }) => string;
  fmtBps: (v: number | null) => string;
};

const {
  MAX_FAMILY_READS,
  Z_ALPHA,
  ENTRY_RATE_RATIO_MAX,
  ENTRY_RATE_RATIO_MIN,
  MAX_ENTRY_RATE_ABS,
  PRIMARY_REQUIRED_ROWS,
  SECONDARY_HORIZONS,
  computeOosArm,
  parseDecisionLine,
  renderOosArm,
  oosArmAnnotations,
} = oosCore as {
  MAX_FAMILY_READS: number;
  Z_ALPHA: number;
  ENTRY_RATE_RATIO_MAX: number;
  ENTRY_RATE_RATIO_MIN: number;
  MAX_ENTRY_RATE_ABS: number;
  PRIMARY_REQUIRED_ROWS: { d: number; n: number }[];
  SECONDARY_HORIZONS: number[];
  computeOosArm: (input: {
    decisionLines: string[] | null;
    seals: { createdAtMs: number; metrics: unknown }[] | null;
    liveEntryRows: EntryRow[] | null;
    gridRows: GridRow[] | null;
    promptBlobAtCommit?: Record<string, string | null> | null;
  }) => {
    status: string;
    reads: {
      readIndex: number;
      windowStart: number | null;
      windowEnd: number | null;
      void: boolean;
      voidReasons: string[];
      primary: { summary: string; flagged: boolean } | null;
      secondary: {
        arm: { summary: string };
        live: { summary: string };
        delta: { summary: string; degenerateDraws: number };
      } | null;
      companions: {
        schemaCompliance: number | null;
        holdAgreement: number | null;
        actionChange: number | null;
        directionMix: { long: number; short: number };
      } | null;
    }[];
    familySpent: boolean;
    annotations: { kind: string; detail: string }[];
  };
  parseDecisionLine: (line: string) => Record<string, unknown> | null;
  renderOosArm: (result: unknown) => string;
  oosArmAnnotations: (result: unknown) => { kind: string; detail: string }[];
};

const T0 = 1785448800000; // a real on-grid bar open, matching forward-return.spec.ts's own fixture

function fullSeries(venue: string, symbol: string, t0: number, price: number): GridRow[] {
  return Array.from({ length: 40 }, (_, i) => ({
    eventTime: t0 + i * BAR_MS,
    venue,
    symbol,
    close: price,
  }));
}

describe('loop-forward-return-core additions — eligibleHorizons', () => {
  const symbols = ['AAA/USDT', 'BBB/USDT', 'CCC/USDT', 'DDD/USDT', 'EEE/USDT'];
  const gridRows = symbols.flatMap((s, k) => fullSeries('binance', s, T0, 100 + k));
  const entryRows: EntryRow[] = Array.from({ length: 15 }, (_, i) => ({
    eventTime: T0 + i * BAR_MS,
    venue: 'binance',
    symbol: symbols[i % 5]!,
    action: 'open_long',
    playbookVersion: null,
    isFlat: true,
  }));

  it('scores ONLY the passed horizons and names every excluded one — never silently', () => {
    const r = computeForwardReturn({
      entryRows,
      gridRows,
      reference: {},
      eligibleHorizons: [24],
    });
    const hSet = new Set(r.panels.flatMap((p) => p.horizons.map((h) => h.h)));
    expect(hSet.has(24)).toBe(true);
    expect(hSet.has(1)).toBe(false);
    expect(hSet.has(4)).toBe(false);
    expect(hSet.has(8)).toBe(false);
    const excl = r.annotations.find((a) => a.kind === 'forward_return_horizon_not_blind');
    expect(excl).toBeDefined();
    expect(excl!.detail).toContain('h=1,4,8');
  });

  it('scores every HORIZONS member and names NOTHING when eligibleHorizons is omitted', () => {
    const r = computeForwardReturn({ entryRows, gridRows, reference: {} });
    const hSet = new Set(r.panels.flatMap((p) => p.horizons.map((h) => h.h)));
    for (const h of HORIZONS) expect(hSet.has(h)).toBe(true);
    expect(r.annotations.map((a) => a.kind)).not.toContain('forward_return_horizon_not_blind');
  });
});

describe('loop-forward-return-core additions — includeObservations', () => {
  const gridRows = fullSeries('binance', 'AAA/USDT', T0, 100);
  const entryRows: EntryRow[] = [
    {
      eventTime: T0,
      venue: 'binance',
      symbol: 'AAA/USDT',
      action: 'open_long',
      playbookVersion: null,
      isFlat: true,
    },
  ];

  it('carries NO obs key by default — output shape unchanged from before this parameter existed', () => {
    const r = computeForwardReturn({ entryRows, gridRows, reference: {} });
    const h1 = r.panels[0]!.horizons.find((h) => h.h === 1)!;
    expect(Object.hasOwn(h1, 'obs')).toBe(false);
  });

  it('carries the raw per-entry observations when requested', () => {
    const r = computeForwardReturn({
      entryRows,
      gridRows,
      reference: {},
      includeObservations: true,
    });
    const h1 = r.panels[0]!.horizons.find((h) => h.h === 1)!;
    expect(h1.obs).toHaveLength(1);
    expect(h1.obs![0]!.symbol).toBe('AAA/USDT');
    expect(h1.obs![0]!.bps).toBe(0); // flat price series
  });
});

describe('loop-forward-return-core additions — exported baseAsset/summarise/fmtBps', () => {
  it('baseAsset collapses spot and perp symbols to the same base', () => {
    expect(baseAsset('BTC/USDT')).toBe('BTC');
    expect(baseAsset('BTC/USDT:USDT')).toBe('BTC');
  });

  it('fmtBps formats a signed figure and n/a for a non-finite value', () => {
    expect(fmtBps(12.34)).toBe('+12.3 bps');
    expect(fmtBps(-5)).toBe('-5.0 bps');
    expect(fmtBps(null)).toBe('n/a');
  });

  it('summarise never separates the mean from its power label', () => {
    const underpowered = { n: 3, clusters: 1, mean: 50, ciLo: null, ciHi: null, powered: false };
    expect(summarise(underpowered)).toContain('UNDERPOWERED');
    const powered = { n: 20, clusters: 5, mean: 10, ciLo: -5, ciHi: 25, powered: true };
    expect(summarise(powered)).toContain('POWERED');
  });
});

describe('loop-forward-return-core additions — pairedClusterBootstrapDelta', () => {
  it('is deterministic given the same seed, and every draw is 0 when both arms are identical', () => {
    const obs = [
      { symbol: 'AAA/USDT', bps: 10 },
      { symbol: 'AAA/USDT', bps: 20 },
      { symbol: 'BBB/USDT', bps: -5 },
      { symbol: 'CCC/USDT', bps: 30 },
      { symbol: 'DDD/USDT', bps: 0 },
      { symbol: 'EEE/USDT', bps: 15 },
    ];
    const a = pairedClusterBootstrapDelta(obs, obs, makeRand(BOOTSTRAP_SEED));
    expect(a.bases).toBe(5);
    expect(a.degenerate).toBe(0);
    expect(a.draws).toHaveLength(N_BOOT);
    expect(a.draws.every((d) => d === 0)).toBe(true);

    const b = pairedClusterBootstrapDelta(obs, obs, makeRand(BOOTSTRAP_SEED));
    expect(a.draws).toEqual(b.draws);
  });

  it('counts a degenerate draw rather than silently dropping it', () => {
    // obsA has ONLY 'AAA'; obsB has ONLY 'BBB'. A resample landing entirely on 'AAA' (possible with
    // 2 bases and 2 picks per draw) carries zero observations for obsB — degenerate, not droppable.
    const obsA = [{ symbol: 'AAA/USDT', bps: 10 }];
    const obsB = [{ symbol: 'BBB/USDT', bps: 20 }];
    const r = pairedClusterBootstrapDelta(obsA, obsB, makeRand(BOOTSTRAP_SEED));
    expect(r.bases).toBe(2);
    expect(r.degenerate).toBeGreaterThan(0);
    // Every attempted draw is accounted for: it either produced a delta or was counted degenerate.
    expect(r.draws.length + r.degenerate).toBe(N_BOOT);
  });
});

describe('parseDecisionLine', () => {
  const valid = JSON.stringify({
    rowId: 'r1',
    eventTime: T0,
    venue: 'binance',
    symbol: 'BTC/USDT',
    base: 'BTC',
    playbookVersion: 3,
    hashes: {},
    agentPromptCommitSha: 'deadbeef',
    capsSource: 'recorded',
    schemaValid: true,
    action: 'hold',
    directives: null,
  });

  it('parses a well-shaped line', () => {
    const row = parseDecisionLine(valid);
    expect(row).not.toBeNull();
    expect(row!.rowId).toBe('r1');
  });

  it('returns null on unparseable JSON rather than throwing', () => {
    expect(parseDecisionLine('not json')).toBeNull();
    expect(parseDecisionLine('')).toBeNull();
  });

  it('returns null when rowId/eventTime/venue/symbol is missing or malformed', () => {
    expect(
      parseDecisionLine(JSON.stringify({ eventTime: T0, venue: 'binance', symbol: 'BTC/USDT' })),
    ).toBeNull();
    expect(
      parseDecisionLine(
        JSON.stringify({ rowId: 'r1', eventTime: 'nope', venue: 'binance', symbol: 'BTC/USDT' }),
      ),
    ).toBeNull();
  });
});

describe('computeOosArm — unstarted and undetermined states, never a silent clean read', () => {
  it('reads UNSTARTED with no seals and no decision lines, and says so by name', () => {
    const r = computeOosArm({ decisionLines: [], seals: [], liveEntryRows: [], gridRows: [] });
    expect(r.status).toBe('unstarted');
    expect(r.reads).toEqual([]);
    expect(r.annotations.map((a) => a.kind)).toContain('oos_arm_unstarted');
  });

  it('names a failed seal probe distinctly from "zero seals"', () => {
    const r = computeOosArm({
      decisionLines: [],
      seals: null,
      liveEntryRows: null,
      gridRows: null,
    });
    expect(r.status).toBe('unstarted');
    expect(r.annotations.map((a) => a.kind)).toContain('oos_arm_seal_probe_failed');
    expect(r.annotations.map((a) => a.kind)).toContain('oos_arm_unstarted');
  });

  it('names an absent/unreadable decision record distinctly from an empty one', () => {
    const r = computeOosArm({
      decisionLines: null,
      seals: [],
      liveEntryRows: null,
      gridRows: null,
    });
    expect(r.annotations.map((a) => a.kind)).toContain('oos_arm_decision_record_absent');
    expect(r.status).toBe('unstarted'); // zero seals still wins — no read may be scored either way
  });

  it('reads UNDETERMINED (not unstarted) when a seal exists but the decision record cannot be read', () => {
    const seals = [
      { createdAtMs: 1, metrics: { windowStart: T0, windowEnd: T0 + 1000, rowIds: ['r1'] } },
    ];
    const r = computeOosArm({ decisionLines: null, seals, liveEntryRows: null, gridRows: null });
    expect(r.status).toBe('undetermined');
    expect(r.reads).toEqual([]);
  });
});

describe('computeOosArm — VOID conditions', () => {
  function record(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      rowId: 'r1',
      eventTime: T0,
      venue: 'binance',
      symbol: 'BTC/USDT',
      base: 'BTC',
      playbookVersion: 1,
      hashes: {},
      agentPromptCommitSha: '',
      capsSource: 'recorded',
      schemaValid: true,
      action: 'hold',
      directives: null,
      ...over,
    };
  }
  function sealFor(rowIds: string[]): { createdAtMs: number; metrics: unknown } {
    return {
      createdAtMs: 1,
      metrics: {
        windowStart: T0,
        windowEnd: T0 + rowIds.length * BAR_MS,
        rowIds,
        payloadSha256: 'x',
      },
    };
  }

  it('VOIDs on a single non-recorded capsSource row (condition 1)', () => {
    const rows = [
      record({ rowId: 'r1' }),
      record({ rowId: 'r2', eventTime: T0 + BAR_MS, capsSource: 'config' }),
    ];
    const decisionLines = rows.map((r) => JSON.stringify(r));
    const liveEntryRows: EntryRow[] = rows.map((r) => ({
      eventTime: r.eventTime as number,
      venue: r.venue as string,
      symbol: r.symbol as string,
      action: 'hold',
      playbookVersion: null,
      isFlat: true,
    }));
    const seals = [sealFor(['r1', 'r2'])];
    const r = computeOosArm({ decisionLines, seals, liveEntryRows, gridRows: [] });
    expect(r.status).toBe('measured');
    expect(r.reads).toHaveLength(1);
    expect(r.reads[0]!.void).toBe(true);
    expect(r.reads[0]!.voidReasons).toContain('caps_source');
    expect(r.reads[0]!.primary).toBeNull();
    expect(r.annotations.map((a) => a.kind)).toContain('oos_arm_void_caps_source');
  });

  it('VOIDs on an arm entry rate above the 65% absolute ceiling (condition 3(b))', () => {
    // 10 rows, ALL entries — 100% > 65%.
    const rows = Array.from({ length: 10 }, (_, i) =>
      record({ rowId: `r${i}`, eventTime: T0 + i * BAR_MS, action: 'open_long' }),
    );
    const decisionLines = rows.map((r) => JSON.stringify(r));
    const liveEntryRows: EntryRow[] = rows.map((r) => ({
      eventTime: r.eventTime as number,
      venue: r.venue as string,
      symbol: r.symbol as string,
      action: 'open_long',
      playbookVersion: null,
      isFlat: true,
    }));
    const seals = [sealFor(rows.map((r) => r.rowId as string))];
    const r = computeOosArm({ decisionLines, seals, liveEntryRows, gridRows: [] });
    expect(r.reads[0]!.void).toBe(true);
    expect(r.reads[0]!.voidReasons).toContain('entry_rate_ceiling');
  });

  it('does NOT void when the session reproduces the incumbent v10 rate below the RETIRED 4% floor (defect #140)', () => {
    // 2 entries of 64 rows = 0.03125 exactly — below the retired [4%, 40%] floor and adjacent to the
    // incumbent lane's own v10 rate (21/543 = 3.8674%). The live lane enters the SAME 2 rows, so the
    // ratio is exactly 1.0. This is the arm's most informative outcome; the retired absolute floor
    // discarded it while still spending the window.
    // 64 rows across 5 base assets so the primary is POWERED (n >= MIN_ENTRIES, clusters >= MIN_CLUSTERS).
    // Exact equality, not approximate: 2/64 is an exact IEEE754 double. `toBeCloseTo` is banned repo-wide.
    const bases = ['AAA/USDT', 'BBB/USDT', 'CCC/USDT', 'DDD/USDT', 'EEE/USDT'];
    const rows = Array.from({ length: 64 }, (_, i) =>
      record({
        rowId: `r${i}`,
        eventTime: T0 + i * BAR_MS,
        symbol: bases[i % 5]!,
        action: i < 2 ? 'open_long' : 'hold',
      }),
    );
    const decisionLines = rows.map((r) => JSON.stringify(r));
    const liveEntryRows: EntryRow[] = rows.map((r, i) => ({
      eventTime: r.eventTime as number,
      venue: r.venue as string,
      symbol: r.symbol as string,
      action: i < 2 ? 'open_long' : 'hold',
      playbookVersion: null,
      isFlat: true,
    }));
    const seals = [sealFor(rows.map((r) => r.rowId as string))];
    const r = computeOosArm({ decisionLines, seals, liveEntryRows, gridRows: [] });
    const read = r.reads[0]!;
    expect(read.void).toBe(false);
    expect(read.voidReasons).toEqual([]);
    expect(r.annotations.map((a) => a.kind)).not.toContain('oos_arm_void_entry_rate');
    expect(read.primary).not.toBeNull();
    expect(read.primary!.summary).toContain('arm entry-rate=3.1%');
    expect(read.primary!.flagged).toBe(false);
  });

  it('VOIDs when the arm/live entry-rate ratio exceeds 6.0 — condition 3(a) (defect #140)', () => {
    // Arm 32/64 = 0.5, live 2/64 = 0.03125 -> ratio 16.0x > the 6.0 payload-integrity ceiling.
    const bases = ['AAA/USDT', 'BBB/USDT', 'CCC/USDT', 'DDD/USDT', 'EEE/USDT'];
    const rows = Array.from({ length: 64 }, (_, i) =>
      record({
        rowId: `r${i}`,
        eventTime: T0 + i * BAR_MS,
        symbol: bases[i % 5]!,
        action: i < 32 ? 'open_long' : 'hold',
      }),
    );
    const decisionLines = rows.map((r) => JSON.stringify(r));
    const liveEntryRows: EntryRow[] = rows.map((r, i) => ({
      eventTime: r.eventTime as number,
      venue: r.venue as string,
      symbol: r.symbol as string,
      action: i < 2 ? 'open_long' : 'hold',
      playbookVersion: null,
      isFlat: true,
    }));
    const seals = [sealFor(rows.map((r) => r.rowId as string))];
    const r = computeOosArm({ decisionLines, seals, liveEntryRows, gridRows: [] });
    const read = r.reads[0]!;
    expect(read.void).toBe(true);
    expect(read.voidReasons).toContain('entry_rate_ratio');
    const detail = r.annotations.find((a) => a.kind === 'oos_arm_void_entry_rate')!.detail;
    expect(detail).toContain('16.00x');
  });

  it('the ratio arm of condition 3 is INAPPLICABLE (not a VOID) when the live rate is exactly 0', () => {
    // Arm 2/64, live 0/64 -> S/L is undefined; only the 65% absolute ceiling can apply, and it does not.
    const bases = ['AAA/USDT', 'BBB/USDT', 'CCC/USDT', 'DDD/USDT', 'EEE/USDT'];
    const rows = Array.from({ length: 64 }, (_, i) =>
      record({
        rowId: `r${i}`,
        eventTime: T0 + i * BAR_MS,
        symbol: bases[i % 5]!,
        action: i < 2 ? 'open_long' : 'hold',
      }),
    );
    const decisionLines = rows.map((r) => JSON.stringify(r));
    const liveEntryRows: EntryRow[] = rows.map((r) => ({
      eventTime: r.eventTime as number,
      venue: r.venue as string,
      symbol: r.symbol as string,
      action: 'hold',
      playbookVersion: null,
      isFlat: true,
    }));
    const seals = [sealFor(rows.map((r) => r.rowId as string))];
    const r = computeOosArm({ decisionLines, seals, liveEntryRows, gridRows: [] });
    const read = r.reads[0]!;
    expect(read.void).toBe(false);
    expect(r.annotations.map((a) => a.kind)).toContain('oos_arm_entry_rate_ratio_inapplicable');
  });

  it('never voids an empty-decided batch on the entry-rate clause', () => {
    // schemaValid FALSE on every row -> zero decided rows -> armEntryRate is null, never void.
    const rows = [record({ rowId: 'r1', schemaValid: false })];
    const decisionLines = rows.map((r) => JSON.stringify(r));
    const liveEntryRows: EntryRow[] = [
      {
        eventTime: T0,
        venue: 'binance',
        symbol: 'BTC/USDT',
        action: 'hold',
        playbookVersion: null,
        isFlat: true,
      },
    ];
    const seals = [sealFor(['r1'])];
    const r = computeOosArm({ decisionLines, seals, liveEntryRows, gridRows: [] });
    expect(r.reads[0]!.voidReasons).not.toContain('entry_rate_ceiling');
    expect(r.reads[0]!.voidReasons).not.toContain('entry_rate_ratio');
  });

  it('always names VOID condition 2 as unchecked, on every read, void or not', () => {
    const rows = [record({ rowId: 'r1' })];
    const decisionLines = rows.map((r) => JSON.stringify(r));
    const liveEntryRows: EntryRow[] = [
      {
        eventTime: T0,
        venue: 'binance',
        symbol: 'BTC/USDT',
        action: 'hold',
        playbookVersion: null,
        isFlat: true,
      },
    ];
    const seals = [sealFor(['r1'])];
    const r = computeOosArm({ decisionLines, seals, liveEntryRows, gridRows: [] });
    expect(r.annotations.map((a) => a.kind)).toContain('oos_arm_prompt_fidelity_unchecked');
  });

  it('VERIFIES (never voids) when the resolved blob matches the recorded one', () => {
    const rows = [
      record({
        rowId: 'r1',
        agentPromptCommitSha: 'sha1',
        hashes: { agentPromptBlobSha: 'blobA' },
        // schemaValid:false keeps armEntryRate null (no decided rows) so this fixture never trips
        // VOID condition 3 on its own — the point of these tests is condition 2 alone.
        schemaValid: false,
      }),
    ];
    const decisionLines = rows.map((r) => JSON.stringify(r));
    const liveEntryRows: EntryRow[] = [
      {
        eventTime: T0,
        venue: 'binance',
        symbol: 'BTC/USDT',
        action: 'hold',
        playbookVersion: null,
        isFlat: true,
      },
    ];
    const seals = [sealFor(['r1'])];
    const r = computeOosArm({
      decisionLines,
      seals,
      liveEntryRows,
      gridRows: [],
      promptBlobAtCommit: { sha1: 'blobA' },
    });
    expect(r.reads[0]!.void).toBe(false);
    expect(r.annotations.map((a) => a.kind)).toContain('oos_arm_prompt_fidelity_verified');
    expect(r.annotations.map((a) => a.kind)).not.toContain('oos_arm_prompt_fidelity_unchecked');
    expect(r.annotations.map((a) => a.kind)).not.toContain('oos_arm_void_prompt_fidelity');
  });

  it('VOIDs the whole read when a resolved blob mismatches the recorded one (condition 2)', () => {
    const rows = [
      record({
        rowId: 'r1',
        agentPromptCommitSha: 'sha1',
        hashes: { agentPromptBlobSha: 'blobA' },
        // schemaValid:false keeps armEntryRate null (no decided rows) so this fixture never trips
        // VOID condition 3 on its own — the point of these tests is condition 2 alone.
        schemaValid: false,
      }),
    ];
    const decisionLines = rows.map((r) => JSON.stringify(r));
    const liveEntryRows: EntryRow[] = [
      {
        eventTime: T0,
        venue: 'binance',
        symbol: 'BTC/USDT',
        action: 'hold',
        playbookVersion: null,
        isFlat: true,
      },
    ];
    const seals = [sealFor(['r1'])];
    const r = computeOosArm({
      decisionLines,
      seals,
      liveEntryRows,
      gridRows: [],
      promptBlobAtCommit: { sha1: 'blobB' }, // the committed blob differs from what the row recorded
    });
    expect(r.reads[0]!.void).toBe(true);
    expect(r.reads[0]!.voidReasons).toContain('prompt_fidelity');
    expect(r.reads[0]!.primary).toBeNull();
    expect(r.annotations.map((a) => a.kind)).toContain('oos_arm_void_prompt_fidelity');
  });

  it('names an unresolvable commit as UNVERIFIABLE — never silently passed or silently voided', () => {
    const rows = [
      record({
        rowId: 'r1',
        agentPromptCommitSha: 'sha-unknown',
        hashes: { agentPromptBlobSha: 'blobA' },
        schemaValid: false,
      }),
    ];
    const decisionLines = rows.map((r) => JSON.stringify(r));
    const liveEntryRows: EntryRow[] = [
      {
        eventTime: T0,
        venue: 'binance',
        symbol: 'BTC/USDT',
        action: 'hold',
        playbookVersion: null,
        isFlat: true,
      },
    ];
    const seals = [sealFor(['r1'])];
    const r = computeOosArm({
      decisionLines,
      seals,
      liveEntryRows,
      gridRows: [],
      promptBlobAtCommit: {}, // supplied, but carries no entry for 'sha-unknown'
    });
    expect(r.reads[0]!.void).toBe(false);
    expect(r.annotations.map((a) => a.kind)).toContain('oos_arm_prompt_fidelity_unverifiable');
    expect(r.annotations.map((a) => a.kind)).not.toContain('oos_arm_prompt_fidelity_verified');
    expect(r.annotations.map((a) => a.kind)).not.toContain('oos_arm_void_prompt_fidelity');
  });
});

// Regression for the 2026-08-04 adversarial review finding: armEntryRate is computed over
// schemaValidRows.length (armTrials), but the Fisher table and pooled z used n = paired.length —
// a different, larger denominator whenever any sealed row is schema-invalid. A 2x true rate
// difference (arm 12.5% vs live 6.25%) printed fisher p=1.0000 because the buggy table
// [armEntryCount, n-armEntryCount, liveEntryCount, n-liveEntryCount] = [4,60,4,60] is EXACTLY
// symmetric whenever armEntryCount === liveEntryCount — a symmetric 2x2 table is always its own
// mode under the hypergeometric null, so two-sided Fisher is 1.0000 by construction regardless of
// the true rate gap the arm and live entry counts came from.
describe('computeOosArm — primary denominator (armTrials vs n, 2026-08-04 review finding)', () => {
  function makeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      rowId: 'r',
      eventTime: T0,
      venue: 'binance',
      symbol: 'BTC/USDT',
      base: 'BTC',
      playbookVersion: 1,
      hashes: {},
      agentPromptCommitSha: '',
      capsSource: 'recorded',
      schemaValid: true,
      action: 'hold',
      directives: null,
      ...over,
    };
  }
  function sealFor(rowIds: string[]): { createdAtMs: number; metrics: unknown } {
    return {
      createdAtMs: 1,
      metrics: {
        windowStart: T0,
        windowEnd: T0 + rowIds.length * BAR_MS,
        rowIds,
        payloadSha256: 'x',
      },
    };
  }

  it('scores the primary against armTrials (schema-valid rows), not n (all paired rows) — a 2x rate gap must not print fisher p=1.0000', () => {
    // 64 paired rows, 32 schema-invalid. Among the 32 schema-valid rows, 4 are arm entries
    // (armTrials=32, armEntryRate=12.5%). The live comparator enters 4 of all 64 rows
    // (liveEntryRate=6.25%) — a true 2x rate difference the primary must be able to see.
    const bases = ['AAA/USDT', 'BBB/USDT', 'CCC/USDT', 'DDD/USDT', 'EEE/USDT'];
    const rows = Array.from({ length: 64 }, (_, i) => {
      const schemaValid = i < 32;
      const action = schemaValid && i < 4 ? 'open_long' : 'hold';
      return makeRow({
        rowId: `r${i}`,
        eventTime: T0 + i * BAR_MS,
        symbol: bases[i % 5]!,
        schemaValid,
        action,
      });
    });
    const decisionLines = rows.map((r) => JSON.stringify(r));
    const liveEntryRows: EntryRow[] = rows.map((r, i) => ({
      eventTime: r.eventTime as number,
      venue: r.venue as string,
      symbol: r.symbol as string,
      action: i >= 60 ? 'open_long' : 'hold', // 4 of 64 paired rows -> 6.25%
      playbookVersion: null,
      isFlat: true,
    }));
    const seals = [sealFor(rows.map((r) => r.rowId as string))];
    const r = computeOosArm({ decisionLines, seals, liveEntryRows, gridRows: [] });
    const read = r.reads[0]!;
    expect(read.void).toBe(false);
    expect(read.primary).not.toBeNull();
    expect(read.primary!.summary).toContain('POWERED');
    expect(read.primary!.summary).toContain('arm entry-rate=12.5%');
    expect(read.primary!.summary).toContain('n=64');
    expect(read.primary!.summary).toContain('armTrials=32');
    // The failure signature this test pins: a true 2x rate gap must never print p=1.0000, which is
    // only reachable by silently substituting n for armTrials in the arm's own row.
    expect(read.primary!.summary).not.toContain('fisher p=1.0000');
  });
});

describe('computeOosArm — a clean, fully powered read', () => {
  const BASES = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'];
  const rows: {
    rowId: string;
    eventTime: number;
    venue: string;
    symbol: string;
    action: string;
  }[] = [];
  for (const base of BASES) {
    const symbol = `${base}/USDT`;
    // 3 entries + 5 holds per base = 8 rows/base * 5 bases = 40 rows; 15 entries/40 = 37.5% (in-band).
    for (let j = 0; j < 3; j += 1) {
      rows.push({
        rowId: `${base}-e${j}`,
        eventTime: T0 + j * BAR_MS,
        venue: 'binance',
        symbol,
        action: 'open_long',
      });
    }
    for (let j = 3; j < 8; j += 1) {
      rows.push({
        rowId: `${base}-h${j}`,
        eventTime: T0 + j * BAR_MS,
        venue: 'binance',
        symbol,
        action: 'hold',
      });
    }
  }
  const decisionLines = rows.map((r) =>
    JSON.stringify({
      rowId: r.rowId,
      eventTime: r.eventTime,
      venue: r.venue,
      symbol: r.symbol,
      base: baseAsset(r.symbol),
      playbookVersion: 1,
      hashes: {},
      agentPromptCommitSha: '',
      capsSource: 'recorded',
      schemaValid: true,
      action: r.action,
      directives: null,
    }),
  );
  // The live lane agrees with the arm on every row — a clean, non-diverging read.
  const liveEntryRows: EntryRow[] = rows.map((r) => ({
    eventTime: r.eventTime,
    venue: r.venue,
    symbol: r.symbol,
    action: r.action,
    playbookVersion: null,
    isFlat: true,
  }));
  const gridRows = BASES.flatMap((base) => fullSeries('binance', `${base}/USDT`, T0, 100));
  const seals = [
    {
      createdAtMs: 12345,
      metrics: {
        windowStart: T0,
        windowEnd: T0 + 8 * BAR_MS,
        rowIds: rows.map((r) => r.rowId),
        payloadSha256: 'x',
      },
    },
  ];

  it('powers the PRIMARY (n=40, clusters=5) with z=0 (arm and live agree exactly)', () => {
    const r = computeOosArm({ decisionLines, seals, liveEntryRows, gridRows });
    expect(r.status).toBe('measured');
    const read = r.reads[0]!;
    expect(read.void).toBe(false);
    expect(read.primary!.summary).toContain('POWERED');
    expect(read.primary!.summary).toContain('arm entry-rate=37.5%');
    expect(read.primary!.summary).toContain('live entry-rate=37.5%');
    expect(read.primary!.flagged).toBe(false);
  });

  it('powers the SECONDARY h=24 bound and reports a paired delta of exactly zero (identical arms)', () => {
    const r = computeOosArm({ decisionLines, seals, liveEntryRows, gridRows });
    const read = r.reads[0]!;
    expect(read.secondary).not.toBeNull();
    expect(read.secondary!.arm.summary).toContain('POWERED');
    expect(read.secondary!.live.summary).toContain('POWERED');
    expect(read.secondary!.delta.summary).toContain('POWERED');
    expect(read.secondary!.delta.summary).toContain('mean=+0.0 bps');
    expect(read.secondary!.delta.degenerateDraws).toBe(0);
  });

  it('reports descriptive companions that are never scored', () => {
    const r = computeOosArm({ decisionLines, seals, liveEntryRows, gridRows });
    const read = r.reads[0]!;
    expect(read.companions!.schemaCompliance).toBe(1);
    // 25/40 = 0.625 is an exact binary fraction, so equality is exact here — and `toBeCloseTo` is
    // banned repo-wide by the money rule regardless of whether a given value is money.
    expect(read.companions!.holdAgreement).toBe(0.625);
    expect(read.companions!.actionChange).toBe(0);
    expect(read.companions!.directionMix).toEqual({ long: 15, short: 0 });
  });

  it('never evaluates a divergence for a SECONDARY reference — reference is {} by design', () => {
    const r = computeOosArm({ decisionLines, seals, liveEntryRows, gridRows });
    expect(r.annotations.map((a) => a.kind)).not.toContain(
      'oos_arm_secondary_arm_forward_return_replay_divergence',
    );
    expect(r.annotations.map((a) => a.kind)).not.toContain(
      'oos_arm_secondary_live_forward_return_replay_divergence',
    );
  });

  it('restricts the secondary bound to h=24 only, per SECONDARY_HORIZONS', () => {
    expect(SECONDARY_HORIZONS).toEqual([24]);
    const r = computeOosArm({ decisionLines, seals, liveEntryRows, gridRows });
    const excl = r.annotations.find(
      (a) => a.kind === 'oos_arm_secondary_arm_forward_return_horizon_not_blind',
    );
    expect(excl).toBeDefined();
    expect(excl!.detail).toContain('h=1,4,8');
  });
});

describe('computeOosArm — the family spends after six reads', () => {
  it('scores only the first six seals and names the family SPENT past that', () => {
    const seals = Array.from({ length: 7 }, (_, i) => ({
      createdAtMs: i + 1,
      metrics: { windowStart: T0, windowEnd: T0 + BAR_MS, rowIds: [] },
    }));
    const r = computeOosArm({ decisionLines: [], seals, liveEntryRows: [], gridRows: [] });
    expect(r.familySpent).toBe(true);
    expect(r.reads).toHaveLength(MAX_FAMILY_READS);
    expect(r.annotations.map((a) => a.kind)).toContain('oos_arm_family_spent');
  });
});

describe('renderOosArm / oosArmAnnotations — fail-open shape', () => {
  it('renders an UNSTARTED result without throwing', () => {
    const r = computeOosArm({ decisionLines: [], seals: [], liveEntryRows: [], gridRows: [] });
    expect(() => renderOosArm(r)).not.toThrow();
    expect(renderOosArm(r)).toContain('unstarted');
  });

  it('renders null/undefined without throwing', () => {
    expect(() => renderOosArm(null)).not.toThrow();
    expect(() => renderOosArm(undefined)).not.toThrow();
  });

  it('oosArmAnnotations passes annotations through, and names a malformed result rather than crashing', () => {
    const r = computeOosArm({ decisionLines: [], seals: [], liveEntryRows: [], gridRows: [] });
    expect(oosArmAnnotations(r)).toEqual(r.annotations);
    expect(oosArmAnnotations(null).map((a) => a.kind)).toEqual(['oos_arm_tool_failed']);
    expect(oosArmAnnotations({}).map((a) => a.kind)).toEqual(['oos_arm_tool_failed']);
  });

  it('carries no alarms key anywhere in the result', () => {
    const r = computeOosArm({ decisionLines: [], seals: [], liveEntryRows: [], gridRows: [] });
    expect('alarms' in r).toBe(false);
  });
});

describe('frozen constants — transcribed, not re-derived', () => {
  it('pins Z_ALPHA and the entry-rate VOID band against the 2026-08-04 amendment text', () => {
    expect(Z_ALPHA).toBe(2.639);
    expect(ENTRY_RATE_RATIO_MAX).toBe(6);
    expect(ENTRY_RATE_RATIO_MIN).toBe(1 / 6);
    expect(MAX_ENTRY_RATE_ABS).toBe(0.65);
    expect(PRIMARY_REQUIRED_ROWS).toEqual([
      { d: 0.1, n: 202 },
      { d: 0.05, n: 604 },
      { d: 0.03, n: 1441 },
    ]);
  });

  it('reuses MIN_ENTRIES/MIN_CLUSTERS from the imported core rather than redefining them', () => {
    expect(MIN_ENTRIES).toBe(12);
    expect(MIN_CLUSTERS).toBe(5);
  });
});
