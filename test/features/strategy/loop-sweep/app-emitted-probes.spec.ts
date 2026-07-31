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
interface CauseProbe {
  ok: boolean;
  error?: string;
  value?: { cause: string | null };
}
interface ConsultGateProbe {
  ok: boolean;
  error?: string;
  value?: { total: number; byOutcome: Record<string, number> };
}
interface RenderInput {
  sweptIso: string;
  host: { powerSource?: string; bootTime?: string; uptime?: string; errors?: string[] };
  git: string | null;
  app: Record<string, unknown> | null;
  result: { alarms: unknown[]; annotations: unknown[] };
}
interface SweepModule {
  resolveBootId: (series: LabelSeries) => {
    bootId: string | null;
    error: string | null;
  };
  resolveBuildSha: (series: LabelSeries) => BuildProbe;
  formatRunningBuild: (probe: BuildProbe | undefined) => string;
  promActiveCause: (res: { ok: boolean; value?: string; error?: string }) => CauseProbe;
  promConsultGateTotal: (res: { ok: boolean; value?: string; error?: string }) => ConsultGateProbe;
  renderMarkdown: (input: RenderInput) => string;
}
const {
  resolveBootId,
  resolveBuildSha,
  formatRunningBuild,
  promActiveCause,
  promConsultGateTotal,
  renderMarkdown,
} = sweepModule as unknown as SweepModule;
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
      latchCause: { ok: true, value: { cause: null } },
      // Healthy venue acceptance (binanceusdm's measured 0/20 on 2026-07-31). Mandatory in the base
      // bag: the reject-rate check fails CLOSED, so an absent probe is an ALARM, not a quiet stack —
      // see venue-reject-rate.spec.ts, which pins that direction deliberately.
      orderRejects: {
        ok: true,
        value: {
          byVenue: Object.fromEntries(VENUES.map((v) => [v, { submits: 20, rejects: 0 }])),
          errors: [],
        },
      },
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

// Pass 48 (2026-07-30): the owner's own words — "lack of trading is because of the anthropic api
// account being unfunded ... make it clear in state or log so that later loop passes do not
// investigate it". These pin the probe that reads WHICH closed-set cause is active, its mandatory-
// probe treatment in the core, and the digest banner that makes the condition unmissable.

// One promtool `query instant` row, in the exact shape loop-transport's promQuery returns — same
// helper shape as alert-history.spec.ts's own `row`/`promOut`.
function causeRow(cause: string, value: number): string {
  return `agent_client_latch_cause{cause="${cause}"} => ${value} @[1785258935.402]`;
}
function promOut(...rows: string[]): { ok: true; value: string } {
  return { ok: true, value: rows.join('\n') + '\n' };
}

describe('promActiveCause (agent_client_latch_cause probe)', () => {
  it('reports the one cause child reading 1', () => {
    const res = promOut(
      causeRow('insufficient_credit', 1),
      causeRow('auth', 0),
      causeRow('other', 0),
    );
    expect(promActiveCause(res)).toEqual({ ok: true, value: { cause: 'insufficient_credit' } });
  });

  it('reports cause: null when every child reads 0 — not latched', () => {
    const res = promOut(
      causeRow('insufficient_credit', 0),
      causeRow('auth', 0),
      causeRow('other', 0),
    );
    expect(promActiveCause(res)).toEqual({ ok: true, value: { cause: null } });
  });

  // The Pass 47/48 zero-seed convention (metrics.service.ts) means a real boot NEVER returns an empty
  // vector — an empty read here means the metric was never registered at all (an old binary, a
  // renamed/dropped metric), which is a probe FAILURE, never a quiet "not latched". Same not-a-zero
  // contract promScalar already applies to a plain scalar gauge, one label deeper.
  it('fails the probe on an EMPTY vector rather than reading it as "not latched"', () => {
    const out = promActiveCause({ ok: true, value: '' });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('empty instant vector');
    expect(out.error).toContain('never seeded');
  });

  it('passes an upstream transport failure through untouched', () => {
    expect(promActiveCause({ ok: false, error: 'promtool exited 1' })).toEqual({
      ok: false,
      error: 'promtool exited 1',
    });
  });
});

// One promtool `query instant` row for agentic_consult_gate_total{outcome}, same shape convention as
// causeRow above.
function gateRow(outcome: string, value: number): string {
  return `agentic_consult_gate_total{outcome="${outcome}"} => ${value} @[1785258935.402]`;
}

describe('promConsultGateTotal (agentic_consult_gate_total probe)', () => {
  it('sums every outcome child and keeps the by-outcome breakdown', () => {
    const res = promOut(gateRow('consulted', 12), gateRow('skipped_scheduled', 3));
    expect(promConsultGateTotal(res)).toEqual({
      ok: true,
      value: { total: 15, byOutcome: { consulted: 12, skipped_scheduled: 3 } },
    });
  });

  // Pass 50 (2026-07-30): before this fix, an empty instant vector summed to `total: 0` via a plain
  // reduce over zero series and reported `ok: true` — indistinguishable from a genuinely quiet
  // consult-gate window. Same not-a-zero contract promScalar/promActiveCause already apply; the
  // constructor zero-seed (agent-metrics-recorder.service.ts) means a real boot never hits this path,
  // but a binary predating the seed (or a renamed/dropped metric) still must not read as a measured 0.
  it('fails the probe on an EMPTY vector rather than reading it as a measured total of 0', () => {
    const out = promConsultGateTotal({ ok: true, value: '' });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('empty instant vector');
    expect(out.error).toContain('never seeded');
  });

  it('passes an upstream transport failure through untouched', () => {
    expect(promConsultGateTotal({ ok: false, error: 'promtool exited 1' })).toEqual({
      ok: false,
      error: 'promtool exited 1',
    });
  });
});

// Deleting the promConsultGateTotal fix and reverting to the pre-Pass-50 plain-reduce probe would
// make this pass — the generic probe_failed loop only fires when the probe genuinely returns
// ok:false, so this is the end-to-end proof the runner's empty-vector fix reaches the core's alarm
// surface rather than being swallowed at the probe boundary.
describe('agentic_consult_gate_total — an empty-vector probe failure reaches the core', () => {
  it('names a probe_failed[consultGate] annotation, never a silent {} reading', () => {
    const out = run(
      withProbe('consultGate', {
        ok: false,
        error: 'empty instant vector (no series) — agentic_consult_gate_total was never seeded',
      }),
    );
    expect(out.annotations.find((a) => a.probe === 'consultGate')?.kind).toBe('probe_failed');
    expect(out.alarms).toEqual([]);
  });
});

describe('agent_client_latch_cause — mandatory probe in the core', () => {
  // Mandatory-key, like realDecides/promAlerts/build: the generic probe-failure loop only visits
  // keys that EXIST, and an absent latchCause probe must not read as a silent pass.
  it('names an absent probe rather than reading a clean sweep', () => {
    const app = baseApp();
    delete (app.probes as Record<string, unknown>).latchCause;
    const out = run(app);
    expect(out.annotations.find((a) => a.probe === 'latchCause')?.kind).toBe('probe_failed');
    expect(out.alarms).toEqual([]);
  });

  it('names a failed probe with the SAME kind, via the generic loop', () => {
    const out = run(
      withProbe('latchCause', { ok: false, error: 'empty instant vector (no series)' }),
    );
    expect(out.annotations.find((a) => a.probe === 'latchCause')?.kind).toBe('probe_failed');
  });

  it('says nothing extra when the cause reads null (not latched)', () => {
    const out = run(baseApp());
    expect(out.annotations.find((a) => a.probe === 'latchCause')).toBeUndefined();
    expect(out.alarms).toEqual([]);
  });
});

describe('renderMarkdown — LLM provider unfunded banner', () => {
  // renderMarkdown's App section reads app.probes.errorScan (moved INTO probes by the adversarial-
  // review fix, 2026-07-30 — see gather()'s own comment) — baseApp() above only feeds computeSweep
  // and has no errorScan probe of its own, so the render fixture adds it alongside the existing probes.
  function withErrorScan(app: Record<string, unknown>): Record<string, unknown> {
    return {
      ...app,
      probes: {
        ...(app.probes as Record<string, unknown>),
        errorScan: {
          ok: true,
          value: {
            matched: 0,
            scanned: 20000,
            lines: 0,
            oldestMs: null,
            newestMs: null,
            named: [],
            other: 0,
            top: [],
          },
        },
      },
    };
  }
  function render(app: Record<string, unknown> | null): string {
    return renderMarkdown({
      sweptIso: '2026-07-30T12:00:00.000Z',
      host: {},
      git: 'af67acf',
      app: app ? withErrorScan(app) : null,
      result: { alarms: [], annotations: [] },
    });
  }

  it('prints the banner, BEFORE the Alarms section, when the active cause is insufficient_credit', () => {
    const app = withProbe('latchCause', { ok: true, value: { cause: 'insufficient_credit' } });
    const md = render(app);
    expect(md).toContain('## LLM PROVIDER ACCOUNT UNFUNDED');
    expect(md).toContain('not a defect');
    expect(md).toContain('do NOT open a defect investigation');
    expect(md).toContain('owner adding credit');
    expect(md).toContain('self-heals within 30');
    // BEFORE the alarms section, not merely present somewhere in the digest.
    expect(md.indexOf('## LLM PROVIDER ACCOUNT UNFUNDED')).toBeLessThan(md.indexOf('## Alarms'));
  });

  it('includes the last real model decide timestamp from the existing realDecides probe', () => {
    const app = withProbe('latchCause', { ok: true, value: { cause: 'insufficient_credit' } });
    (app.probes as Record<string, unknown>).realDecides = {
      ok: true,
      value: { count: 5, latestCreatedAtMs: 1_785_183_331_000 },
    };
    const md = render(app);
    expect(md).toContain('2026-07-27T20:15:31.000Z');
  });

  it.each(['other', 'auth'])('does not print the banner when the active cause is %s', (cause) => {
    const app = withProbe('latchCause', { ok: true, value: { cause } });
    expect(render(app)).not.toContain('LLM PROVIDER ACCOUNT UNFUNDED');
  });

  it('does not print the banner when nothing is latched (cause: null)', () => {
    const app = withProbe('latchCause', { ok: true, value: { cause: null } });
    expect(render(app)).not.toContain('LLM PROVIDER ACCOUNT UNFUNDED');
  });

  // Fails toward NO banner, never toward guessing insufficient_credit off a broken read — a probe
  // failure is a named annotation elsewhere in the digest, never a silent stand-in for the banner.
  it('does not print the banner when the latchCause probe itself failed', () => {
    const app = withProbe('latchCause', { ok: false, error: 'promtool exited 1' });
    expect(render(app)).not.toContain('LLM PROVIDER ACCOUNT UNFUNDED');
  });

  it('does not print the banner when there is no app at all', () => {
    expect(render(null)).not.toContain('LLM PROVIDER ACCOUNT UNFUNDED');
  });
});
