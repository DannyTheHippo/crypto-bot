import { describe, it, expect } from 'vitest';
// @ts-expect-error scripts/** live outside the tsconfig graph (see tsconfig.eslint.json's include list)
// — the pure collector core is a stdlib-only .mjs with no declaration file. vitest/swc resolves it at
// runtime; this directive mirrors alarms.spec.ts's bridge across the graph boundary (no 5th .d.ts).
import * as coreModule from '../../../scripts/loop-collect-core.mjs';

// loop-collect-core.mjs is the PURE decision layer of the Y3 standing collector: cadence classification
// (heartbeat/gap/seq), the line shapes, the rotation set, and the since-filter — no timers, no docker,
// no fs. This spec pins the §D liveness-contract logic (loop-mechanism-learnings-2026-07.md) off
// passed-in clock values and fixture filenames so it needs no fake timers.

interface Cadence {
  gapDetected: boolean;
  gapMs: number | null;
  missedTicks: number;
  driftMs: number;
}
interface Line {
  v: number;
  seq: number;
  type: string;
  plannedAt?: string;
  actualAt: string;
  driftMs?: number;
  alarms?: { kind: string; venue: string | null }[];
  alarmCount?: number;
  annotationCount?: number;
  sweepError?: string | null;
  app?: { bootId: string | null; containerHealthy: boolean } | null;
  gapMs?: number;
  missedTicks?: number;
  detail?: string;
  nonce?: string;
  pid?: number;
}
interface Core {
  GAP_FACTOR: number;
  MAX_AGE_DAYS: number;
  SCHEMA_VERSION: number;
  utcDateString: (ms: number) => string;
  classifyCadence: (input: {
    prevActualAtMs: number | null;
    plannedAtMs: number;
    actualAtMs: number;
    intervalMs: number;
  }) => Cadence;
  summarizeSweep: (digest: unknown) => {
    git: string | null;
    alarms: { kind: string; venue: string | null }[];
    annotationCount: number;
    app: unknown;
  };
  buildDigestLine: (input: {
    seq: number;
    plannedAtMs: number;
    actualAtMs: number;
    sweep: unknown;
    sweepError: string | null;
  }) => Line;
  buildGapLine: (input: {
    seq: number;
    plannedAtMs: number;
    actualAtMs: number;
    gapMs: number;
    missedTicks: number;
    intervalMs: number;
  }) => Line;
  buildSentinelLine: (input: {
    seq: number;
    actualAtMs: number;
    pid: number;
    nonce: string;
  }) => Line;
  dateOfDigestFile: (name: string) => string | null;
  rotationTargets: (names: string[], refDateStr: string, maxAgeDays?: number) => string[];
  filterSince: (lines: Line[], sinceIso: string) => Line[];
  renderMdSection: (line: Line) => string;
}
const core = coreModule as unknown as Core;
const {
  GAP_FACTOR,
  classifyCadence,
  buildDigestLine,
  buildGapLine,
  buildSentinelLine,
  utcDateString,
  dateOfDigestFile,
  rotationTargets,
  filterSince,
  renderMdSection,
} = core;

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 6, 20, 0, 0, 0); // 2026-07-20T00:00:00Z

describe('classifyCadence — heartbeat/gap/seq cadence', () => {
  it('the first tick (no prior) is never a gap and reports drift only', () => {
    const c = classifyCadence({
      prevActualAtMs: null,
      plannedAtMs: T0,
      actualAtMs: T0 + 40,
      intervalMs: HOUR,
    });
    expect(c.gapDetected).toBe(false);
    expect(c.gapMs).toBeNull();
    expect(c.missedTicks).toBe(0);
    expect(c.driftMs).toBe(40);
  });

  it('an on-time tick within 1.5x the interval is not a gap', () => {
    const c = classifyCadence({
      prevActualAtMs: T0,
      plannedAtMs: T0 + HOUR,
      actualAtMs: T0 + HOUR + 500, // ~1.0x interval elapsed
      intervalMs: HOUR,
    });
    expect(c.gapDetected).toBe(false);
    expect(c.missedTicks).toBe(0);
  });

  it('elapsed just beyond 1.5x the interval is flagged as a host-sleep gap', () => {
    const elapsed = GAP_FACTOR * HOUR + 1000;
    const c = classifyCadence({
      prevActualAtMs: T0,
      plannedAtMs: T0 + HOUR,
      actualAtMs: T0 + elapsed,
      intervalMs: HOUR,
    });
    expect(c.gapDetected).toBe(true);
    expect(c.gapMs).toBe(elapsed);
  });

  it('counts the swallowed ticks: a 4.2h sleep at a 1h interval reports ~3 missed', () => {
    const elapsed = Math.round(4.2 * HOUR);
    const c = classifyCadence({
      prevActualAtMs: T0,
      plannedAtMs: T0 + HOUR,
      actualAtMs: T0 + elapsed,
      intervalMs: HOUR,
    });
    expect(c.gapDetected).toBe(true);
    expect(c.missedTicks).toBe(3); // floor(4.2) - 1 = 3
  });

  it('exactly 1.5x is not yet a gap (strict >)', () => {
    const c = classifyCadence({
      prevActualAtMs: T0,
      plannedAtMs: T0 + HOUR,
      actualAtMs: T0 + GAP_FACTOR * HOUR,
      intervalMs: HOUR,
    });
    expect(c.gapDetected).toBe(false);
  });
});

describe('line builders — the durable line shapes', () => {
  // v3 single stack: one `app`, not a lane map; reconcile-derived alarms carry `venue`.
  const sweep = {
    digest: {
      git: 'abc1234',
      app: { bootId: 'boot-A-uuid-long', containerHealthy: true, restartCount: 2 },
      result: {
        alarms: [{ kind: 'zero_decides' }],
        annotations: [{ kind: 'no_watermark' }, { kind: 'probe_failed', probe: 'decides' }],
        deltas: { decides: 0 },
      },
    },
  };

  it('the heartbeat line carries seq, planned/actual, drift, and a compact sweep summary', () => {
    const line = buildDigestLine({
      seq: 5,
      plannedAtMs: T0,
      actualAtMs: T0 + 120,
      sweep,
      sweepError: null,
    });
    expect(line.type).toBe('digest');
    expect(line.seq).toBe(5);
    expect(line.driftMs).toBe(120);
    expect(line.alarmCount).toBe(1);
    expect(line.alarms?.[0]).toEqual({ kind: 'zero_decides', venue: null });
    expect(line.annotationCount).toBe(2);
    expect(line.app?.bootId).toBe('boot-A-uuid-long');
    expect(line.sweepError).toBeNull();
  });

  it('a heartbeat still lands when the sweep threw — sweepError set, distinguishable from a clean tick', () => {
    const line = buildDigestLine({
      seq: 6,
      plannedAtMs: T0,
      actualAtMs: T0 + 10,
      sweep: null,
      sweepError: 'boom',
    });
    expect(line.type).toBe('digest');
    expect(line.sweepError).toBe('boom');
    expect(line.alarmCount).toBe(0);
    expect(line.app).toBeNull();
  });

  it('the gap line records the missed window without fabricating rows', () => {
    const line = buildGapLine({
      seq: 7,
      plannedAtMs: T0,
      actualAtMs: T0 + 3 * HOUR,
      gapMs: 3 * HOUR,
      missedTicks: 2,
      intervalMs: HOUR,
    });
    expect(line.type).toBe('gap');
    expect(line.missedTicks).toBe(2);
    expect(line.detail).toContain('no rows fabricated');
  });

  it('the sentinel line carries the read-back nonce', () => {
    const line = buildSentinelLine({ seq: 1, actualAtMs: T0, pid: 4242, nonce: 'nonce-xyz' });
    expect(line.type).toBe('sentinel');
    expect(line.nonce).toBe('nonce-xyz');
    expect(line.pid).toBe(4242);
  });

  it('utcDateString buckets by the UTC calendar day', () => {
    expect(utcDateString(Date.UTC(2026, 6, 20, 23, 59, 59))).toBe('2026-07-20');
    expect(utcDateString(Date.UTC(2026, 6, 21, 0, 0, 0))).toBe('2026-07-21');
  });
});

describe('rotationTargets — rotation set by parsed filename date', () => {
  const ref = '2026-07-20';
  const names = [
    '2026-07-05.jsonl', // 15 days old -> archive
    '2026-07-05.md', // 15 days old -> archive
    '2026-07-06.jsonl', // 14 days old -> keep (boundary)
    '2026-07-20.jsonl', // today -> keep
    'sweep-2026-07-01T10-38-48-892Z.json', // 19 days old -> archive
    'sweep-2026-07-20T10-38-48-892Z.json', // today -> keep
    '.watermark.json', // non-dated -> never touched
    'w6-digests.txt', // non-dated -> never touched
    'archive', // the archive dir itself -> never touched
  ];

  it('archives dated files strictly older than 14 days, keeps the 14-day boundary and newer', () => {
    const targets = rotationTargets(names, ref);
    expect(targets).toContain('2026-07-05.jsonl');
    expect(targets).toContain('2026-07-05.md');
    expect(targets).toContain('sweep-2026-07-01T10-38-48-892Z.json');
    expect(targets).not.toContain('2026-07-06.jsonl'); // exactly 14 days -> kept
    expect(targets).not.toContain('2026-07-20.jsonl');
    expect(targets).not.toContain('sweep-2026-07-20T10-38-48-892Z.json');
  });

  it('never targets non-dated files (watermark, legacy txt, the archive dir)', () => {
    const targets = rotationTargets(names, ref);
    expect(targets).not.toContain('.watermark.json');
    expect(targets).not.toContain('w6-digests.txt');
    expect(targets).not.toContain('archive');
  });

  it('dateOfDigestFile parses both the daily and sweep filename shapes', () => {
    expect(dateOfDigestFile('2026-07-05.jsonl')).toBe('2026-07-05');
    expect(dateOfDigestFile('2026-07-05.md')).toBe('2026-07-05');
    expect(dateOfDigestFile('sweep-2026-07-01T10-38-48-892Z.json')).toBe('2026-07-01');
    expect(dateOfDigestFile('.watermark.json')).toBeNull();
    expect(dateOfDigestFile('w6-digests.txt')).toBeNull();
  });
});

describe('filterSince — pass-rehydration reader logic', () => {
  const lineA: Line = { v: 1, seq: 1, type: 'digest', actualAt: '2026-07-19T12:00:00.000Z' };
  const lineB: Line = { v: 1, seq: 2, type: 'digest', actualAt: '2026-07-20T08:00:00.000Z' };
  const lineC: Line = { v: 1, seq: 3, type: 'digest', actualAt: '2026-07-20T09:00:00.000Z' };
  const lineD: Line = { v: 1, seq: 4, type: 'digest', actualAt: 'not-a-date' }; // malformed -> dropped
  const lines: Line[] = [lineA, lineB, lineC, lineD];

  it('keeps lines at or after the since timestamp, dropping older ones', () => {
    const kept = filterSince(lines, '2026-07-20T00:00:00.000Z');
    expect(kept.map((l) => l.seq)).toEqual([2, 3]);
  });

  it('sorts newest LAST (ascending by actualAt)', () => {
    const shuffled = [lineC, lineA, lineB];
    const kept = filterSince(shuffled, '2026-07-01T00:00:00.000Z');
    expect(kept.map((l) => l.seq)).toEqual([1, 2, 3]);
  });

  it('drops rows with an unparseable actualAt rather than surfacing them as events', () => {
    const kept = filterSince(lines, '2026-07-01T00:00:00.000Z');
    expect(kept.map((l) => l.seq)).not.toContain(4);
  });

  it('the boundary timestamp itself is included (>=, not >)', () => {
    const kept = filterSince(lines, '2026-07-20T08:00:00.000Z');
    expect(kept.map((l) => l.seq)).toContain(2);
  });
});

describe('renderMdSection — markdownlint-clean companion sections', () => {
  it('renders a tick section with a heading, blank line, and a tight list', () => {
    const line = buildDigestLine({
      seq: 3,
      plannedAtMs: T0,
      actualAtMs: T0 + 5,
      sweep: {
        digest: { git: 'g', app: null, result: { alarms: [], annotations: [], deltas: null } },
      },
      sweepError: null,
    });
    const md = renderMdSection(line);
    expect(md).toMatch(/^## Tick 3 — /);
    expect(md).toContain('\n\n- ');
    expect(md.endsWith('\n')).toBe(true);
    expect(md).not.toContain('\n\n\n');
  });

  it('renders a gap section flagged as host-sleep', () => {
    const line = buildGapLine({
      seq: 4,
      plannedAtMs: T0,
      actualAtMs: T0 + 3 * HOUR,
      gapMs: 3 * HOUR,
      missedTicks: 2,
      intervalMs: HOUR,
    });
    const md = renderMdSection(line);
    expect(md).toContain('## Gap before tick 4');
    expect(md).toContain('host-sleep suspected');
  });
});
