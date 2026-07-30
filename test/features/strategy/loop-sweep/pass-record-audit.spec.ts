import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
// @ts-expect-error scripts/** live outside the tsconfig graph (see tsconfig.eslint.json's include
// list) — the pure sweep core is a stdlib-only .mjs with no declaration file. Same bridge
// alarms.spec.ts uses for computeSweep.
import * as coreModule from '../../../../scripts/loop-sweep-core.mjs';

// The pass-record audit is the loop's only check whose subject is the loop itself: it asks whether
// every sweep that ran left a pass entry in research/loop/LOG.md behind it. Its own topic file rather
// than an extension of alarms.spec.ts because it shares no fixture with computeSweep — its inputs are
// repo artifacts (a markdown log, a directory listing), not stack probes.
//
// It exists because Pass 48 (2026-07-30) found three 2026-07-29 sweeps with no LOG entry at all and
// recorded that the loop had no detector for the condition. What this spec is really pinning is the
// fail direction: the detector must never accuse a pass that IS recorded, and must never let a check
// it could not run read as a clean one.

interface PassEntry {
  heading: string;
  pass: number;
  date: string;
  window: string | null;
  startMs: number | null;
  endMs: number | null;
}
interface Annotation {
  kind: string;
  detail: string;
}
interface AuditResult {
  status: 'clean' | 'unrecorded' | 'undetermined';
  unrecorded: { name: string; sweptAtMs: number; sweptIso: string }[];
  evaluated: number;
  skippedBeforeFloor: number;
  pendingAfterLastEntry: number;
  unreadableNames: number;
  annotations: Annotation[];
}
interface Core {
  parseLogPassEntries: (logText: string | null) => PassEntry[];
  parseDigestStampMs: (name: unknown) => number | null;
  classifyUnrecordedSweeps: (input: {
    digestNames: string[] | null;
    logText: string | null;
  }) => AuditResult;
  COLLECTOR_DAEMON_RETIRED_AT_MS: number;
  PASS_WINDOW_END_TOLERANCE_MS: number;
}
const {
  parseLogPassEntries,
  parseDigestStampMs,
  classifyUnrecordedSweeps,
  COLLECTOR_DAEMON_RETIRED_AT_MS,
  PASS_WINDOW_END_TOLERANCE_MS,
} = coreModule as unknown as Core;

// The runner's own name mint (`sweep-${sweptIso.replace(/[:.]/g, '-')}.json`), restated here so a
// change to it breaks this suite instead of silently blinding the audit.
function digestName(iso: string): string {
  return `sweep-${new Date(Date.parse(iso)).toISOString().replace(/[:.]/g, '-')}.json`;
}

// Fixture dates sit well past COLLECTOR_DAEMON_RETIRED_AT_MS so the daemon floor never masks the
// behaviour under test — that floor gets its own case below. Three entries in the shapes LOG.md
// actually uses: bare `HH:MMZ` inheriting the heading date, the two-day overnight heading, and a
// fully qualified start.
const LOG_FIXTURE = [
  '# Daily profitability loop — pass log',
  '',
  '## 2026-08-10 — Pass 60 (a morning pass)',
  '',
  '**Window:** 08:00Z → 09:00Z. `date -u` first. Sweep at pass start: `Alarms (0)`.',
  '',
  '### Gates and deploy',
  '',
  'Some prose that mentions 23:59Z and must not be mistaken for a window.',
  '',
  '## 2026-08-10/11 — Pass 61 (an overnight pass)',
  '',
  '**Window:** 2026-08-10T20:00Z → 03:00Z (pass lease `7109445f81e18a20`, taken 20:00:14Z).',
  '',
  '## 2026-08-11 — Pass 62 (an afternoon pass)',
  '',
  '**Window:** 2026-08-11T12:00Z → 13:00Z. Lease `25798a2449a344ac`, tree uncontended.',
  '',
].join('\n');

const IN_WINDOW = '2026-08-10T08:30:00.000Z';
const IN_GAP = '2026-08-10T12:00:00.000Z';
const BEFORE_OLDEST_ENTRY = '2026-08-10T06:00:00.000Z';
const AFTER_NEWEST_ENTRY = '2026-08-11T18:00:00.000Z';

describe('parseLogPassEntries', () => {
  it('reads both date shapes and rolls an overnight end forward a day', () => {
    const entries = parseLogPassEntries(LOG_FIXTURE);
    expect(entries.map((e) => e.pass)).toEqual([60, 61, 62]);
    const p61 = entries.find((e) => e.pass === 61);
    expect(p61?.startMs).toBe(Date.parse('2026-08-10T20:00:00Z'));
    // 03:00Z is EARLIER than the 20:00Z start, which is the whole point of the `2026-08-10/11`
    // heading — read on the start's own date it would close the window seventeen hours before it
    // opened and orphan every sweep the pass actually ran.
    expect(p61?.endMs).toBe(Date.parse('2026-08-11T03:00:00Z'));
  });

  it('ignores `###` sub-headings and any time in the prose after the window', () => {
    const entries = parseLogPassEntries(LOG_FIXTURE);
    const p60 = entries.find((e) => e.pass === 60);
    expect(p60?.startMs).toBe(Date.parse('2026-08-10T08:00:00Z'));
    expect(p60?.endMs).toBe(Date.parse('2026-08-10T09:00:00Z'));
  });

  it('leaves both bounds null when the window end is prose, never a half-read span', () => {
    const entries = parseLogPassEntries(
      [
        '## 2026-08-10 — Pass 60 (in flight)',
        '',
        '**Window:** 2026-08-10T08:00Z → in progress.',
      ].join('\n'),
    );
    expect(entries).toHaveLength(1);
    const only = entries[0];
    expect(only?.startMs).toBeNull();
    expect(only?.endMs).toBeNull();
  });

  it('parses every retained entry of the REAL LOG.md — the conventions this detector reads are the file, not a guess', () => {
    // Resolved off the vitest root (the repo root) rather than the module URL: this repo's absolute
    // path contains spaces, so URL.pathname would percent-encode into a path readFileSync cannot open.
    const entries = parseLogPassEntries(
      readFileSync(join(process.cwd(), 'research', 'loop', 'LOG.md'), 'utf8'),
    );
    expect(entries.length).toBeGreaterThan(0);
    // Pins the parser against the live file: a pass writing its heading or window line in a shape this
    // cannot read would otherwise silently move the whole audit to `undetermined` forever.
    for (const entry of entries) {
      expect(Number.isFinite(entry.startMs)).toBe(true);
      expect(Number.isFinite(entry.endMs)).toBe(true);
      expect(entry.endMs ?? 0).toBeGreaterThan(entry.startMs ?? 0);
    }
  });
});

describe('parseDigestStampMs', () => {
  it('inverts the runner name mint', () => {
    expect(parseDigestStampMs('sweep-2026-07-29T16-07-26-407Z.json')).toBe(
      Date.parse('2026-07-29T16:07:26.407Z'),
    );
  });

  it('returns null for every non-digest entry the digests dir also holds', () => {
    for (const name of [
      '.watermark.json',
      '2026-07-29.jsonl',
      'collector.log',
      'sweep-nonsense.json',
      null,
    ]) {
      expect(parseDigestStampMs(name)).toBeNull();
    }
  });
});

describe('classifyUnrecordedSweeps', () => {
  it('stays silent for a sweep a pass entry covers', () => {
    const res = classifyUnrecordedSweeps({
      digestNames: [digestName(IN_WINDOW)],
      logText: LOG_FIXTURE,
    });
    expect(res.status).toBe('clean');
    expect(res.evaluated).toBe(1);
    expect(res.annotations).toEqual([]);
  });

  it('covers an overnight sweep with the rolled-forward end', () => {
    const res = classifyUnrecordedSweeps({
      digestNames: [digestName('2026-08-11T01:00:00.000Z')],
      logText: LOG_FIXTURE,
    });
    expect(res.status).toBe('clean');
    expect(res.evaluated).toBe(1);
  });

  it('warns on a sweep that fell in the gap between two recorded passes', () => {
    const res = classifyUnrecordedSweeps({
      digestNames: [digestName(IN_WINDOW), digestName(IN_GAP)],
      logText: LOG_FIXTURE,
    });
    expect(res.status).toBe('unrecorded');
    expect(res.unrecorded.map((u) => u.sweptIso)).toEqual([IN_GAP]);
    const warn = res.annotations.find((a) => a.kind === 'sweeps_unrecorded_in_log');
    expect(warn?.detail).toContain(IN_GAP);
  });

  it('does not accuse a pass whose last sweep landed just past its stated end', () => {
    // The window line is written before the pass's closing gate/deploy steps, so a sweep inside the
    // tolerance is the recording pass's own — accusing it would make the detector's loudest output a
    // false one.
    const res = classifyUnrecordedSweeps({
      digestNames: [
        digestName(
          new Date(
            Date.parse('2026-08-10T09:00:00Z') + PASS_WINDOW_END_TOLERANCE_MS - 60_000,
          ).toISOString(),
        ),
      ],
      logText: LOG_FIXTURE,
    });
    expect(res.status).toBe('clean');
  });

  it('does not warn on a digest older than the rotation boundary — its pass entry is in the archive', () => {
    // LOG.md keeps only the last five passes; older entries move VERBATIM to
    // research/loop/archive/LOG-through-pass-47.md, which this check does not read. An absence below
    // the oldest retained entry is therefore expected and says nothing.
    const res = classifyUnrecordedSweeps({
      digestNames: [digestName(BEFORE_OLDEST_ENTRY)],
      logText: LOG_FIXTURE,
    });
    expect(res.status).toBe('clean');
    expect(res.skippedBeforeFloor).toBe(1);
    expect(res.evaluated).toBe(0);
    expect(res.annotations).toEqual([]);
  });

  it('does not warn on the retired collector daemon’s hourly digests', () => {
    // The daemon drove runSweep() in-process every hour, so those digests never had a pass behind
    // them; judged as passes they would report ~14 unrecorded passes per pre-retirement day.
    const daemonEraLog = [
      '## 2026-07-28 — Pass 44 (before the daemon was retired)',
      '',
      '**Window:** 08:14Z → 09:10Z.',
      '',
      '## 2026-07-29 — Pass 47 (after)',
      '',
      '**Window:** 2026-07-29T09:15Z → 11:15Z.',
      '',
    ].join('\n');
    const res = classifyUnrecordedSweeps({
      digestNames: [digestName('2026-07-28T13:24:29.566Z')],
      logText: daemonEraLog,
    });
    expect(COLLECTOR_DAEMON_RETIRED_AT_MS).toBeGreaterThan(Date.parse('2026-07-28T13:24:29.566Z'));
    expect(res.status).toBe('clean');
    expect(res.skippedBeforeFloor).toBe(1);
  });

  it('holds a sweep newer than the last recorded pass as pending, not unrecorded', () => {
    // A pass writes its entry at the END of the pass, so the in-flight pass's own sweeps — this one
    // included — have no entry yet by construction. Judging them would fire on every single run.
    const res = classifyUnrecordedSweeps({
      digestNames: [digestName(AFTER_NEWEST_ENTRY)],
      logText: LOG_FIXTURE,
    });
    expect(res.status).toBe('clean');
    expect(res.pendingAfterLastEntry).toBe(1);
    expect(res.evaluated).toBe(0);
  });

  it('reports an unreadable LOG.md as undetermined — distinctly, never as a clean audit', () => {
    for (const logText of [null, '   ']) {
      const res = classifyUnrecordedSweeps({ digestNames: [digestName(IN_GAP)], logText });
      expect(res.status).toBe('undetermined');
      expect(res.unrecorded).toEqual([]);
      const note = res.annotations.find((a) => a.kind === 'pass_record_audit_undetermined');
      // The whole point of the distinct kind: a reader must not be able to score this as zero
      // unrecorded passes.
      expect(note?.detail).toContain('NOT a clean result');
      expect(res.annotations.some((a) => a.kind === 'sweeps_unrecorded_in_log')).toBe(false);
    }
  });

  it('reports an unlistable digests dir as undetermined', () => {
    const res = classifyUnrecordedSweeps({ digestNames: null, logText: LOG_FIXTURE });
    expect(res.status).toBe('undetermined');
    expect(res.annotations.map((a) => a.kind)).toEqual(['pass_record_audit_undetermined']);
  });

  it('reports a LOG.md with no recognisable pass headings as undetermined', () => {
    const res = classifyUnrecordedSweeps({
      digestNames: [digestName(IN_GAP)],
      logText: '# Daily profitability loop — pass log\n\nNothing here matches the convention.\n',
    });
    expect(res.status).toBe('undetermined');
    expect(res.unrecorded).toEqual([]);
  });

  it('blanks the whole verdict when any one entry’s window is unreadable', () => {
    // Every gap between the entries that DID parse could be the span of the one that did not, so no
    // gap is attributable — a warning here would send a pass hunting a record that exists.
    const res = classifyUnrecordedSweeps({
      digestNames: [digestName(IN_GAP)],
      logText: LOG_FIXTURE.replace('**Window:** 2026-08-11T12:00Z → 13:00Z.', '**Window:** TBD.'),
    });
    expect(res.status).toBe('undetermined');
    expect(res.unrecorded).toEqual([]);
    const note = res.annotations.find((a) => a.kind === 'pass_record_audit_undetermined');
    expect(note?.detail).toContain('Pass 62');
  });

  it('discloses unreadable digest names ALONGSIDE the verdict, not instead of it', () => {
    const res = classifyUnrecordedSweeps({
      digestNames: ['sweep-corrupt.json', digestName(IN_GAP)],
      logText: LOG_FIXTURE,
    });
    expect(res.status).toBe('unrecorded');
    expect(res.unreadableNames).toBe(1);
    expect(res.annotations.map((a) => a.kind)).toEqual([
      'pass_record_audit_undetermined',
      'sweeps_unrecorded_in_log',
    ]);
  });
});

describe('the real artifacts', () => {
  const logText = readFileSync(join(process.cwd(), 'research', 'loop', 'LOG.md'), 'utf8');
  const digestNames = readdirSync(join(process.cwd(), 'research', 'loop', 'digests'));

  it('audit cleanly against the committed LOG.md and digests dir', () => {
    // Not an assertion that the loop's record-keeping is perfect — only that the check RUNS on the
    // real pair. `undetermined` here would mean the artifacts drifted out of the shapes above.
    const res = classifyUnrecordedSweeps({ digestNames, logText });
    expect(res.status).not.toBe('undetermined');
    expect(res.unreadableNames).toBe(0);
  });

  it('warns on a synthetic orphan digest dropped into the real digests listing', () => {
    // The orphan's timestamp is derived from the real LOG.md rather than hardcoded, so LOG.md's
    // five-entry rotation cannot silently move this case below the audit floor and stop testing it.
    const entries = parseLogPassEntries(logText)
      .slice()
      .sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
    let widestGapMs = 0;
    let orphanAtMs = 0;
    for (let i = 1; i < entries.length; i += 1) {
      const prevEnd = entries[i - 1]?.endMs;
      const curStart = entries[i]?.startMs;
      if (!Number.isFinite(prevEnd) || !Number.isFinite(curStart)) continue;
      const gapMs = (curStart ?? 0) - (prevEnd ?? 0);
      if (gapMs > widestGapMs) {
        widestGapMs = gapMs;
        orphanAtMs = (prevEnd ?? 0) + Math.floor(gapMs / 2);
      }
    }
    // A 3x/day cadence always leaves hours between passes; if it ever does not, this case is testing
    // nothing and should say so loudly rather than pass vacuously.
    expect(widestGapMs).toBeGreaterThan(4 * PASS_WINDOW_END_TOLERANCE_MS);
    expect(orphanAtMs).toBeGreaterThan(COLLECTOR_DAEMON_RETIRED_AT_MS);

    const orphanIso = new Date(orphanAtMs).toISOString();
    const before = classifyUnrecordedSweeps({ digestNames, logText });
    expect(before.unrecorded.some((u) => u.sweptIso === orphanIso)).toBe(false);

    const after = classifyUnrecordedSweeps({
      digestNames: [...digestNames, digestName(orphanIso)],
      logText,
    });
    expect(after.status).toBe('unrecorded');
    expect(after.unrecorded.some((u) => u.sweptIso === orphanIso)).toBe(true);
    const warn = after.annotations.find((a) => a.kind === 'sweeps_unrecorded_in_log');
    expect(warn?.detail).toContain(orphanIso);
  });
});
