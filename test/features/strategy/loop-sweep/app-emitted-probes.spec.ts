import { describe, it, expect } from 'vitest';
// @ts-expect-error scripts/** live outside the tsconfig graph (see tsconfig.eslint.json's include
// list) — both sweep modules are stdlib-only .mjs with no declaration file. Same bridge the sibling
// loop-sweep specs use.
import * as sweepModule from '../../../../scripts/loop-sweep.mjs';
// @ts-expect-error same graph boundary as above.
import * as coreModule from '../../../../scripts/loop-sweep-core.mjs';

// The hourly collector daemon was retired 2026-07-29: it read host duty cycle with pmset/sysctl/
// uptime, the error picture with a `docker logs` tail, and the deployed commit from the working
// tree — all from outside a process that could have published every one of them itself. These cases
// pin the probes that replaced it, plus the bootId provenance guard the migration exposed.

interface Annotation {
  kind: string;
  probe?: string;
  detail: string;
}
interface SweepResult {
  alarms: { kind: string; detail: string }[];
  annotations: Annotation[];
}
interface Core {
  computeSweep: (input: { prev: unknown; cur: unknown }) => SweepResult;
  ALERT_LOOKBACK_MS: number;
  EXPECTED_SWEEP_INTERVAL_MS: number;
  VENUES: [string, string];
}
interface BuildProbe {
  ok: boolean;
  error?: string;
  value?: { gitSha: string | null };
}
interface LabelSeries {
  ok: boolean;
  error?: string;
  value?: { labels: Record<string, string> }[];
}
interface SweepModule {
  resolveBootId: (series: LabelSeries) => {
    bootId: string | null;
    error: string | null;
  };
  resolveBuildSha: (series: LabelSeries) => BuildProbe;
  formatRunningBuild: (probe: BuildProbe | undefined) => string;
}
const { resolveBootId, resolveBuildSha, formatRunningBuild } =
  sweepModule as unknown as SweepModule;
const { computeSweep, ALERT_LOOKBACK_MS, EXPECTED_SWEEP_INTERVAL_MS, VENUES } =
  coreModule as unknown as Core;

const WM_TIME = 10_000_000_000;
const NOW = WM_TIME + EXPECTED_SWEEP_INTERVAL_MS;

function baseApp(): Record<string, unknown> {
  const reconcile: Record<string, unknown> = {};
  for (const venue of VENUES) reconcile[venue] = { ok: true, value: { count: 200 } };
  return {
    bootId: 'boot-A',
    containerHealthy: true,
    restartCount: 3,
    startedAt: new Date(WM_TIME - 24 * 60 * 60 * 1000).toISOString(),
    probes: {
      decides: { ok: true, value: { count: 100, latestCreatedAtMs: WM_TIME } },
      realDecides: { ok: true, value: { count: 20, latestCreatedAtMs: WM_TIME } },
      consultGate: { ok: true, value: { total: 50 } },
      fills: { ok: true, value: { count: 10 } },
      reconcile,
      reconcileCleanStamp: { ok: true, value: { seconds: (NOW - 60_000) / 1000 } },
      killSwitch: { ok: true, value: { state: 'RUNNING' } },
      cost: { ok: true, value: { spendUsd: 0.1 } },
      wsRecreations: { ok: true, value: { count: 2 } },
      rss: { ok: true, value: { bytes: 1000 } },
      promAlerts: { ok: true, value: { ruleCount: 20, alertingCount: 20, firing: [] } },
      promAlertsSince: { ok: true, value: { resolved: [], lookbackMs: ALERT_LOOKBACK_MS } },
      promCoverage: { ok: true, value: { samples: 2880, expected: 2880, ratio: 1 } },
      suspends: { ok: true, value: { count: 0, maxSkewSeconds: 0, windowMs: ALERT_LOOKBACK_MS } },
      logEvents: {
        ok: true,
        value: {
          byLevelWindow: { warn: 0, error: 0, fatal: 0 },
          byLevelBoot: { warn: 0, error: 0, fatal: 0 },
          top: [],
          windowMs: ALERT_LOOKBACK_MS,
        },
      },
      build: { ok: true, value: { gitSha: 'af67acf' } },
    },
    ...{},
  };
}

function withProbe(name: string, probe: unknown): Record<string, unknown> {
  const app = baseApp();
  (app.probes as Record<string, unknown>)[name] = probe;
  return app;
}

function run(app: Record<string, unknown>): SweepResult {
  return computeSweep({ prev: null, cur: { sweptAtMs: NOW, app } });
}

describe('host duty cycle, observed from inside the process', () => {
  it('says nothing when the app was never frozen', () => {
    const out = run(baseApp());
    expect(out.annotations.map((a) => a.kind)).not.toContain('app_suspended');
  });

  it('annotates a suspend with its longest freeze, and never alarms on one', () => {
    const out = run(
      withProbe('suspends', {
        ok: true,
        value: { count: 2, maxSkewSeconds: 6 * 3600, windowMs: ALERT_LOOKBACK_MS },
      }),
    );
    const note = out.annotations.find((a) => a.kind === 'app_suspended');
    expect(note?.detail).toContain('2 time(s)');
    expect(note?.detail).toContain('longest 360min');
    // A sleeping laptop is this stack's documented duty cycle — surfacing it must never block a pass.
    expect(out.alarms).toEqual([]);
  });

  it('degrades to a named probe failure rather than reading absence as "never slept"', () => {
    const out = run(withProbe('suspends', { ok: false, error: 'promtool exited 1' }));
    const failed = out.annotations.find((a) => a.probe === 'suspends');
    expect(failed?.kind).toBe('probe_failed');
  });
});

describe('log-event counter (the durable half of the error scan)', () => {
  it('stays silent on a genuinely quiet window — materialized zeros are a real read, not a void', () => {
    const out = run(baseApp());
    expect(out.annotations.map((a) => a.kind)).not.toContain('log_errors_in_window');
  });

  // The two readings fail in opposite directions: increase() undercounts a label child born inside
  // the window, the since-boot cumulative is blind before the last restart. Taking the max can only
  // under-report, never invent.
  it('reports the larger of the windowed and since-boot readings, and shows both', () => {
    const out = run(
      withProbe('logEvents', {
        ok: true,
        value: {
          byLevelWindow: { warn: 3, error: 1, fatal: 0 },
          byLevelBoot: { warn: 7, error: 5, fatal: 1 },
          top: [
            { level: 'error', event: 'venue_request_failed', count: 5 },
            { level: 'warn', event: 'reconcile_pass_still_in_flight', count: 7 },
          ],
          windowMs: ALERT_LOOKBACK_MS,
        },
      }),
    );
    const note = out.annotations.find((a) => a.kind === 'log_errors_in_window');
    // max(window 1+0, boot 5+1) = 6
    expect(note?.detail).toContain('6 error/fatal log line(s)');
    expect(note?.detail).toContain('1 over the 12h window');
    expect(note?.detail).toContain('6 since this boot');
    expect(note?.detail).toContain('5x venue_request_failed');
    // warn-level entries never enter the error summary.
    expect(note?.detail).not.toContain('reconcile_pass_still_in_flight');
    expect(out.alarms).toEqual([]);
  });

  it('still reports when only the windowed reading saw the errors', () => {
    const out = run(
      withProbe('logEvents', {
        ok: true,
        value: {
          byLevelWindow: { warn: 0, error: 4, fatal: 0 },
          byLevelBoot: { warn: 0, error: 0, fatal: 0 },
          top: [],
          windowMs: ALERT_LOOKBACK_MS,
        },
      }),
    );
    expect(out.annotations.find((a) => a.kind === 'log_errors_in_window')?.detail).toContain(
      '4 error/fatal',
    );
  });
});

// The third recorded instance of one defect class: a value supplied only by its own writer as a
// constant is indistinguishable from a measurement at every query, forever (the reconciliations audit
// columns whose writer supplied a literal, Pass 46; prom-client's never-incremented labeled counter,
// Pass 44). Here 'unknown' is BOTH the Dockerfile ARG default and the zod default, so it is what every
// image built without a GIT_SHA prefix reports — and the probe used to print it as a reading.
describe('deploy provenance (build_info{git_sha})', () => {
  it('reads a real sha as a value and says nothing about it', () => {
    const out = run(baseApp());
    expect(out.annotations.map((a) => a.kind)).not.toContain('build_provenance_void');
    expect(out.alarms).toEqual([]);
  });

  // Third element is the DISCRIMINATING fragment: 'GIT_SHA' alone appears twice as fixed prose in
  // every branch of the detail, so asserting it proves only that the boilerplate rendered — the four
  // cases are four different readings and the assertions have to be able to tell them apart.
  const nonReadings: [string, string | null, string][] = [
    ['the ARG/zod default', 'unknown', 'git_sha="unknown"'],
    ['an empty label', '', 'git_sha=""'],
    ['a whitespace-only label', '  ', 'git_sha="  "'],
    ['a missing label', null, 'no git_sha label'],
  ];
  for (const [label, gitSha, fragment] of nonReadings) {
    it(`voids ${label}, and annotates rather than alarms`, () => {
      const out = run(withProbe('build', { ok: true, value: { gitSha } }));
      const note = out.annotations.find((a) => a.kind === 'build_provenance_void');
      // PRESENCE, not merely "no alarm fired": a no-alarm assertion alone would still pass with the
      // whole check deleted, which is the review finding the last pass caught.
      expect(note).toBeDefined();
      expect(note?.probe).toBe('build');
      expect(note?.detail).toContain(fragment);
      // A rendered `null`/`undefined` would be a label value that never existed, indistinguishable in
      // the committed digest from a label literally set to the string 'null'.
      if (gitSha === null) expect(note?.detail).not.toContain('null');
      expect(note?.detail).toContain('GIT_SHA');
      // Measurement/veto-only, fails OPEN: playbook §3 makes any named alarm block all improvement
      // work, and a broken provenance read must never block the deploy it measures.
      expect(out.alarms).toEqual([]);
    });
  }

  it('leaves an unreadable metric as the named probe failure, not a void verdict', () => {
    // Carries a stale value alongside the error on purpose, so the `ok === true` guard is what keeps
    // the void verdict away: a read that never happened must not yield an image-provenance verdict.
    const out = run(
      withProbe('build', {
        ok: false,
        error: 'empty instant vector (no build_info series)',
        value: { gitSha: 'unknown' },
      }),
    );
    expect(out.annotations.find((a) => a.probe === 'build')?.kind).toBe('probe_failed');
    expect(out.annotations.map((a) => a.kind)).not.toContain('build_provenance_void');
    expect(out.alarms).toEqual([]);
  });

  // The one shape the two renderers used to disagree on: the core stayed silent (its guard required
  // `build.value`) while the digest already printed VOID.
  it('voids an ok probe that carries no value, and the digest line agrees', () => {
    const out = run(withProbe('build', { ok: true }));
    expect(out.annotations.find((a) => a.kind === 'build_provenance_void')?.probe).toBe('build');
    expect(formatRunningBuild({ ok: true })).toContain('VOID');
    expect(out.alarms).toEqual([]);
  });

  // Mandatory-key, like promAlerts/promAlertsSince: the generic probe-failure loop only visits keys
  // that exist, and build_info is the loop's only between-pass memory of which image served.
  it('names an absent probe rather than reading a clean sweep', () => {
    const app = baseApp();
    delete (app.probes as Record<string, unknown>).build;
    const out = run(app);
    expect(out.annotations.find((a) => a.probe === 'build')?.kind).toBe('probe_failed');
    expect(out.alarms).toEqual([]);
  });
});

// The same post-redeploy window resolveBootId refuses, on the sibling metric: build_info is set beside
// boot_info in one onModuleInit and scraped by one target, so it serves two series for the minutes
// after a recreate — and a deploy is exactly when the sha changes, so [0] would read the OUTGOING
// image's commit for the one sweep whose provenance matters most (the playbook soaks inside it).
describe('resolveBuildSha', () => {
  // null means the series carries no git_sha label at all — a different fact from an empty one.
  const series = (...shas: (string | null)[]) => ({
    ok: true,
    value: shas.map((git_sha) => {
      const labels: Record<string, string> = { instance: 'app:3100' };
      if (git_sha !== null) labels.git_sha = git_sha;
      return { labels };
    }),
  });

  it('resolves the single-series case verbatim, without laundering', () => {
    expect(resolveBuildSha(series('c50db12'))).toEqual({ ok: true, value: { gitSha: 'c50db12' } });
    expect(resolveBuildSha(series('unknown'))).toEqual({ ok: true, value: { gitSha: 'unknown' } });
    expect(resolveBuildSha(series(null))).toEqual({ ok: true, value: { gitSha: null } });
  });

  it('collapses duplicate rows carrying the same sha', () => {
    expect(resolveBuildSha(series('c50db12', 'c50db12')).value).toEqual({ gitSha: 'c50db12' });
  });

  it('REFUSES to pick when a redeploy has two builds in the lookback', () => {
    const out = resolveBuildSha(series('c50db12', 'unknown'));
    expect(out.ok).toBe(false);
    expect(out.error).toContain('2 git shas');
    expect(out.error).toContain('unresolvable');
  });

  // A missing label is a distinct member, not one to filter out — otherwise "one labelled series
  // beside one unlabelled" collapses into a confident single reading.
  it('counts an absent label as its own series', () => {
    const out = resolveBuildSha(series('c50db12', null));
    expect(out.ok).toBe(false);
    expect(out.error).toContain('<no label>');
  });

  it('names an empty vector and passes an upstream failure through untouched', () => {
    expect(resolveBuildSha({ ok: true, value: [] })).toEqual({
      ok: false,
      error: 'empty instant vector (no build_info series)',
    });
    expect(resolveBuildSha({ ok: false, error: 'promtool exited 1' })).toEqual({
      ok: false,
      error: 'promtool exited 1',
    });
  });
});

// The digest cell, pinned for the reason resolveBootId was extracted: an untested render is how a
// non-reading gets printed as a reading again — `- running build: unknown` was the original defect.
describe('formatRunningBuild', () => {
  it('prints a real sha as the bare value', () => {
    expect(formatRunningBuild({ ok: true, value: { gitSha: 'c50db12' } })).toBe('c50db12');
  });

  it('never prints a non-reading as a value', () => {
    for (const gitSha of ['unknown', '', '  ', null] as (string | null)[]) {
      const line = formatRunningBuild({ ok: true, value: { gitSha } });
      expect(line).toContain('VOID');
      expect(line).toContain('provenance unrecorded');
      // The constant must not stand where the sha stands.
      expect(line.startsWith('unknown')).toBe(false);
    }
    expect(formatRunningBuild({ ok: true, value: { gitSha: null } })).toContain('no git_sha label');
    expect(formatRunningBuild({ ok: true, value: { gitSha: 'unknown' } })).toContain(
      'git_sha="unknown"',
    );
  });

  it('reports an unread probe as a named failure, void or not', () => {
    expect(formatRunningBuild({ ok: false, error: 'promtool exited 1' })).toBe(
      'probe_failed — promtool exited 1',
    );
    expect(formatRunningBuild(undefined)).toBe('probe_failed — no result');
  });
});

// The guard this migration exposed. For a few minutes after a redeploy Prometheus can serve the
// previous boot's boot_info alongside the new one; taking [0] made the sweep read the OLD id, which
// then MATCHED the watermark and let a cross-boot delta pass the core's boot_changed guard. Observed
// live 2026-07-29: two sweeps 90s apart, unchanged StartedAt, different bootIds, the first reporting
// decides:120 across a boot boundary.
describe('resolveBootId', () => {
  const series = (...ids: string[]) => ({
    ok: true,
    value: ids.map((boot_id) => ({ labels: { boot_id, instance: 'app:3100' } })),
  });

  it('resolves the single-series case', () => {
    expect(resolveBootId(series('boot-A'))).toEqual({ bootId: 'boot-A', error: null });
  });

  it('collapses duplicate rows carrying the same id', () => {
    expect(resolveBootId(series('boot-A', 'boot-A')).bootId).toBe('boot-A');
  });

  it('REFUSES to pick when two boots are served at once', () => {
    const out = resolveBootId(series('boot-old', 'boot-new'));
    expect(out.bootId).toBeNull();
    expect(out.error).toContain('2 boot ids');
    expect(out.error).toContain('deltas are suppressed');
  });

  it('reports no id and no error for an empty vector — the transport already failed loudly', () => {
    expect(resolveBootId({ ok: true, value: [] })).toEqual({ bootId: null, error: null });
    expect(resolveBootId({ ok: false })).toEqual({ bootId: null, error: null });
  });

  // An unresolved bootId must reach the digest as a named failure and take the deltas with it.
  it('suppresses deltas and names the failure when provenance is ambiguous', () => {
    const app = baseApp();
    app.bootId = null;
    const out = run(app);
    const failed = out.annotations.find((a) => a.probe === 'bootId');
    expect(failed?.kind).toBe('probe_failed');
  });
});
