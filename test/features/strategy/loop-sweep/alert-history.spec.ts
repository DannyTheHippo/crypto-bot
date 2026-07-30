import { describe, it, expect } from 'vitest';
// @ts-expect-error scripts/** live outside the tsconfig graph (see tsconfig.eslint.json's include
// list) — both sweep modules are stdlib-only .mjs with no declaration file. Same bridge alarms.spec.ts
// and prom-rules.spec.ts use.
import * as sweepModule from '../../../../scripts/loop-sweep.mjs';
// @ts-expect-error same graph boundary as above.
import * as coreModule from '../../../../scripts/loop-sweep-core.mjs';

// The sweep reads Prometheus' live rule state to answer "what is firing NOW". That is the wrong
// question for a consumer that samples 3x/day: an alert that fires and resolves inside the ~8h gap
// between passes is invisible to every pass. On 2026-07-28 a 49-minute demo-fapi outage fired
// ReconciliationSweepFailureSustained and ReconciliationMismatch and had resolved before the pass ran;
// that pass's sweep named it nowhere. These cases pin the backwards-looking companion probe and the
// two properties that make it safe: it never contradicts the live read, and it never becomes an alarm
// (playbook §3 blocks all improvement work while an alarm stands, and history can never clear).

interface ResolvedAlert {
  alertname: string;
  severity: string;
  samples: number;
}
type SinceProbe =
  | { ok: true; value: { resolved: ResolvedAlert[]; lookbackMs: number }; error?: undefined }
  | { ok: false; error: string; value?: undefined };
interface ScanValue {
  matched: number;
  scanned: number;
  lines: number;
  oldestMs: number | null;
  newestMs: number | null;
  named: { name: string; count: number }[];
  other: number;
  top: { prefix: string; count: number }[];
  consistencyError: string | null;
}
interface SweepModule {
  parseAlertsFiredWithin: (
    res: { ok: boolean; value?: string; error?: string },
    opts?: { currentlyFiringNames?: string[] },
  ) => SinceProbe;
  firingAlertNames: (probe: unknown) => string[];
  scanPinoLines: (text: string) => ScanValue;
  ERROR_LOG_TAIL: number;
}
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
  LOG_BOOT_REACH_MS: number;
  ALERT_COVERAGE_MIN_RATIO: number;
  VENUES: [string, string];
}
const { parseAlertsFiredWithin, firingAlertNames, scanPinoLines, ERROR_LOG_TAIL } =
  sweepModule as unknown as SweepModule;
const {
  computeSweep,
  ALERT_LOOKBACK_MS,
  EXPECTED_SWEEP_INTERVAL_MS,
  LOG_BOOT_REACH_MS,
  ALERT_COVERAGE_MIN_RATIO,
  VENUES,
} = coreModule as unknown as Core;

// One promtool `query instant` row, in the exact shape loop-transport's promQuery returns.
function row(labels: Record<string, string>, value: number): string {
  const inner = Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(', ');
  return `{${inner}} => ${value} @[1785258935.402]`;
}
function promOut(...rows: string[]): { ok: true; value: string } {
  return { ok: true, value: rows.join('\n') + '\n' };
}

const ALERTS = (name: string, severity: string, extra: Record<string, string> = {}) => ({
  alertname: name,
  alertstate: 'firing',
  severity,
  ...extra,
});
const TARGET = { instance: 'app:3100', job: 'crypto-bot' };

describe('parseAlertsFiredWithin', () => {
  it('reports an alert that fired in the window and is no longer firing', () => {
    const res = parseAlertsFiredWithin(
      promOut(row(ALERTS('ReconciliationSweepFailureSustained', 'warning', TARGET), 61)),
      { currentlyFiringNames: [] },
    );
    expect(res.ok).toBe(true);
    expect(res.value?.resolved).toEqual([
      { alertname: 'ReconciliationSweepFailureSustained', severity: 'warning', samples: 61 },
    ]);
    expect(res.value?.lookbackMs).toBe(ALERT_LOOKBACK_MS);
  });

  // The one error this probe must never make: announcing a live alert as resolved. The live read
  // already reports it, so a second "and it resolved" line would directly contradict the alarm above it.
  it('subtracts alerts that are still firing right now', () => {
    const res = parseAlertsFiredWithin(
      promOut(
        row(ALERTS('AgentClientFatalLatch', 'critical', TARGET), 391),
        row(ALERTS('ReconciliationMismatch', 'warning', TARGET), 51),
      ),
      { currentlyFiringNames: ['AgentClientFatalLatch'] },
    );
    expect(res.value?.resolved.map((a) => a.alertname)).toEqual(['ReconciliationMismatch']);
  });

  // Real capture from this stack: max_over_time returned AgentClientFatalLatch twice, once with
  // instance/job and once without, because the rule's expr drops target labels in one branch. Keying
  // on the label set would have made the label-less row a phantom "resolved" entry for a live alert.
  it('collapses the same alert name across differing label sets into one entry', () => {
    const res = parseAlertsFiredWithin(
      promOut(
        row(ALERTS('ReconciliationMismatch', 'warning', { ...TARGET, class: 'sweep_failure' }), 51),
        row(ALERTS('ReconciliationMismatch', 'warning'), 8),
      ),
      { currentlyFiringNames: [] },
    );
    expect(res.value?.resolved).toEqual([
      { alertname: 'ReconciliationMismatch', severity: 'warning', samples: 51 },
    ]);
  });

  it('reports the worst severity when one name fired at two severities', () => {
    const res = parseAlertsFiredWithin(
      promOut(
        row(ALERTS('SomeAlert', 'warning', TARGET), 4),
        row(ALERTS('SomeAlert', 'critical', { instance: 'app:3100' }), 2),
      ),
      { currentlyFiringNames: [] },
    );
    expect(res.value?.resolved[0]?.severity).toBe('critical');
  });

  // A genuinely quiet window. This is only EVIDENCE because the core cross-checks the live rules probe
  // in the same sweep (see the probe_voided case below) — on its own an empty ALERTS read is a §C.9 void.
  it('treats an empty instant vector as a clean window, not a probe failure', () => {
    const res = parseAlertsFiredWithin({ ok: true, value: '' }, { currentlyFiringNames: [] });
    expect(res.ok).toBe(true);
    expect(res.value?.resolved).toEqual([]);
  });

  it('passes a transport failure through as a probe failure', () => {
    const res = parseAlertsFiredWithin({ ok: false, error: 'docker exited 1: boom' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('boom');
  });
});

// The wiring between the two probes, which is the single most load-bearing line in the change: inline
// in gather() nothing pinned that the subtraction list is built from alert NAMES, so swapping the field
// or dropping the map left every other test green while re-introducing the false "resolved".
describe('firingAlertNames', () => {
  it('extracts alert names from a passing live rules probe', () => {
    expect(
      firingAlertNames({
        ok: true,
        value: {
          firing: [
            {
              alertname: 'AgentClientFatalLatch',
              severity: 'critical',
              scope: 'instance=app:3100',
            },
            { alertname: 'ReconcilerStalled', severity: 'warning', scope: '' },
          ],
        },
      }),
    ).toEqual(['AgentClientFatalLatch', 'ReconcilerStalled']);
  });

  // No names rather than a guessed default — the core refuses to interpret the window at all in this
  // case (probe_voided), which is the only safe reading of an unsubtractable history.
  it('yields no names when the live probe failed or is absent', () => {
    expect(firingAlertNames({ ok: false, error: 'unreachable' })).toEqual([]);
    expect(firingAlertNames(undefined)).toEqual([]);
  });
});

describe('scanPinoLines', () => {
  const line = (timeMs: number, level: number, msg: string) =>
    JSON.stringify({ time: timeMs, level, msg });

  // The span must be taken ABOVE the warn filter. Reading it from warn lines only would report the
  // window as short exactly when it was quietly healthy — manufacturing doubt about a real green.
  it('measures the span over every parsed line, not just warn+ ones', () => {
    const t0 = 1_700_000_000_000;
    const out = scanPinoLines(
      [
        line(t0, 30, 'info at the start'),
        line(t0 + 3_600_000, 30, 'info in the middle'),
        line(t0 + 7_200_000, 50, 'the only warn, at the very end'),
      ].join('\n'),
    );
    expect(out.oldestMs).toBe(t0);
    expect(out.newestMs).toBe(t0 + 7_200_000);
    expect(out.matched).toBe(1);
    expect(out.lines).toBe(3);
  });

  it('reports an unusable span rather than a fabricated one when no line carries a time', () => {
    const out = scanPinoLines('{"level":50,"msg":"no time field"}\nnot json at all\n');
    expect(out.oldestMs).toBeNull();
    expect(out.matched).toBe(1);
  });

  // The tail request exists to cover the alert lookback in TIME; if the two drift apart the sweep's
  // qualitative window silently stops reaching as far back as the window it reasons over.
  it('requests a tail sized for the alert lookback', () => {
    const linesPerHour = 1600; // measured on this stack, 2026-07-28
    expect(ERROR_LOG_TAIL / linesPerHour).toBeGreaterThanOrEqual(ALERT_LOOKBACK_MS / 3_600_000);
  });

  // Pass 50 (2026-07-30): scanPinoLines had no `other` field before this fix — this pins the guarantee
  // the derivation makes going forward: `other` is matched minus the named-category sum, BY
  // CONSTRUCTION, never a second independently-maintained tally that could disagree with `matched`.
  // Deleting the derivation (replacing it with any independently-computed `other`) fails this test.
  it('derives other as matched minus the named-category sum, never an independent tally', () => {
    const t0 = 1_700_000_000_000;
    const out = scanPinoLines(
      [
        line(t0, 50, 'venue timeout: BTC/USDT'),
        line(t0, 50, 'venue timeout: ETH/USDT'),
        line(t0, 50, 'venue timeout: SOL/USDT'),
      ].join('\n'),
    );
    expect(out.matched).toBe(3);
    expect(out.named).toEqual([]);
    expect(out.other).toBe(3);
    expect(out.consistencyError).toBeNull();
  });

  // The exact fragmentation defect this fix closes: per-symbol/per-channel identifiers embedded right
  // after a fixed lead-in ("market-stream ${symbol}|${channel} loop error (resubscribing): ...")
  // fragment a single incident into many distinctly-prefixed raw buckets, none individually large
  // enough to crack the top-5 list — so without a named category the whole incident reads as
  // undifferentiated `other`, and WITH one it reads as a single visible, countable bucket.
  it('collapses market-stream resubscribe lines across different symbol/channel pairs into one named bucket', () => {
    const t0 = 1_700_000_000_000;
    const out = scanPinoLines(
      [
        line(t0, 40, 'market-stream BTC/USDT|book loop error (resubscribing): Error: reset'),
        line(t0, 40, 'market-stream ETH/USDT|trade loop error (resubscribing): Error: reset'),
        line(t0, 40, 'market-stream SOL/USDT|candle:1m loop error (resubscribing): Error: reset'),
      ].join('\n'),
    );
    expect(out.matched).toBe(3);
    expect(out.named).toEqual([{ name: 'market-stream loop error (resubscribing)', count: 3 }]);
    expect(out.other).toBe(0);
    expect(out.top).toEqual([]); // fully absorbed into the named bucket, not fragmented across `top`
  });

  // Same fragmentation defect, the feed-poll sibling — derivatives/sentiment/positioning/trade-flow/
  // fear-greed feed services each embed their own marketId right after "feed poll failed".
  it('collapses feed-poll-timeout lines across different feeds/marketIds into one named bucket', () => {
    const t0 = 1_700_000_000_000;
    const out = scanPinoLines(
      [
        line(t0, 40, 'derivatives-feed poll failed for BTCUSDT: request timed out'),
        line(t0, 40, 'sentiment-feed poll failed: request timed out'),
      ].join('\n'),
    );
    expect(out.matched).toBe(2);
    expect(out.named).toEqual([{ name: 'feed poll failed (request timed out)', count: 2 }]);
    expect(out.other).toBe(0);
  });

  // A "feed poll failed" line for a DIFFERENT cause (not a timeout) must not fall into the timeout
  // bucket — the category is a substring test on the FULL message, not just the leading phrase.
  it('does not fold a non-timeout feed-poll failure into the timeout-named bucket', () => {
    const out = scanPinoLines(
      line(1_700_000_000_000, 40, 'sentiment-feed poll failed: 503 Service Unavailable'),
    );
    expect(out.named).toEqual([]);
    expect(out.other).toBe(1);
  });
});

// ── core consumption ─────────────────────────────────────────────────────────────────────────────

const WM_TIME = 10_000_000_000;
const NOW = WM_TIME + EXPECTED_SWEEP_INTERVAL_MS;

function baseApp(over: Record<string, unknown> = {}): Record<string, unknown> {
  const reconcile: Record<string, unknown> = {};
  for (const venue of VENUES) reconcile[venue] = { ok: true, value: { count: 200 } };
  // errorScan moved INTO probes (adversarial review, 2026-07-30): gather() now assigns
  // probes.errorScan rather than a sibling top-level field, so the generic probe_failed loop
  // (Object.entries(probes)) actually covers a scan failure — a sibling field was invisible to it,
  // silently losing log_window_short/log_window_unknown on exactly the failure they exist to catch.
  // `over.probes` is merged INTO the default probe set (never replaces it), so a call site can
  // override/add just `probes.errorScan` without re-supplying every other default probe.
  const { probes: probesOver, ...rest } = over;
  return {
    bootId: 'boot-A',
    containerHealthy: true,
    restartCount: 3,
    startedAt: new Date(WM_TIME - 24 * 60 * 60 * 1000).toISOString(),
    probes: {
      decides: { ok: true, value: { count: 100, latestCreatedAtMs: WM_TIME } },
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
      ...(probesOver as Record<string, unknown> | undefined),
    },
    ...rest,
  };
}

function run(app: Record<string, unknown>): SweepResult {
  return computeSweep({ prev: null, cur: { sweptAtMs: NOW, app } });
}

function withSince(resolved: ResolvedAlert[], promAlertsOk = true): Record<string, unknown> {
  const app = baseApp();
  const probes = app.probes as Record<string, unknown>;
  probes.promAlertsSince = { ok: true, value: { resolved, lookbackMs: ALERT_LOOKBACK_MS } };
  if (!promAlertsOk) probes.promAlerts = { ok: false, error: 'rules api: unreachable' };
  return app;
}

describe('loop-sweep-core alert history', () => {
  it('annotates a resolved warning and does NOT raise an alarm', () => {
    const out = run(
      withSince([{ alertname: 'ReconciliationMismatch', severity: 'warning', samples: 51 }]),
    );
    const note = out.annotations.find((a) => a.kind === 'prometheus_alert_resolved');
    expect(note?.detail).toContain('ReconciliationMismatch');
    expect(note?.detail).toContain('51 firing sample(s)');
    expect(out.alarms).toEqual([]);
  });

  // The load-bearing property. Playbook §3 makes ANY alarm block all improvement work until it clears,
  // and an incident that already ended can never clear — so a resolved critical must stay an
  // annotation, however loud, or the loop wedges for a full lookback window after every blip.
  it('keeps a resolved CRITICAL out of the alarm list, under its own annotation kind', () => {
    const out = run(
      withSince([{ alertname: 'AgenticLaneSilent', severity: 'critical', samples: 12 }]),
    );
    expect(out.alarms).toEqual([]);
    expect(out.annotations.map((a) => a.kind)).toContain('prometheus_alert_resolved_critical');
  });

  // No positive control, no evidence: an empty/partial ALERTS window is indistinguishable from a
  // Prometheus serving zero rules, and the controls that refuse that reading live in the live probe.
  it('voids the whole history read when the live rules probe failed', () => {
    const out = run(
      withSince([{ alertname: 'ReconciliationMismatch', severity: 'warning', samples: 51 }], false),
    );
    const voided = out.annotations.find((a) => a.probe === 'promAlertsSince');
    expect(voided?.kind).toBe('probe_voided');
    expect(out.annotations.map((a) => a.kind)).not.toContain('prometheus_alert_resolved');
  });

  it('says nothing when the window is genuinely quiet and fully scraped', () => {
    const out = run(withSince([]));
    const kinds = out.annotations.map((a) => a.kind);
    expect(kinds).not.toContain('prometheus_alert_resolved');
    expect(kinds).not.toContain('probe_voided');
    expect(kinds).not.toContain('alert_window_partial');
    expect(kinds).not.toContain('alert_window_unverified');
  });

  // The live probe proves rules are loaded NOW; it cannot prove Prometheus was recording for the last
  // 12h. The gap is reachable through this sweep's own advice — parsePromRules tells the operator to
  // recreate the prometheus container, and that recreate is itself a hole in the history it then reads.
  it('discloses a partly-scraped window so an empty history stops reading as clean', () => {
    const app = withSince([]);
    (app.probes as Record<string, unknown>).promCoverage = {
      ok: true,
      value: { samples: 1440, expected: 2880, ratio: 0.5 },
    };
    const note = run(app).annotations.find((a) => a.kind === 'alert_window_partial');
    expect(note?.detail).toContain('50%');
  });

  // Positive evidence survives a partial window: an alert present in it genuinely fired. Only the
  // NEGATIVE weakens, so the shortfall is reported ALONGSIDE the findings, never instead of them.
  it('still reports what a partly-scraped window did find', () => {
    const app = withSince([
      { alertname: 'ReconciliationMismatch', severity: 'warning', samples: 51 },
    ]);
    (app.probes as Record<string, unknown>).promCoverage = {
      ok: true,
      value: { samples: 100, expected: 2880, ratio: 0.035 },
    };
    const kinds = run(app).annotations.map((a) => a.kind);
    expect(kinds).toContain('alert_window_partial');
    expect(kinds).toContain('prometheus_alert_resolved');
  });

  it('flags an unreadable coverage control rather than assuming full coverage', () => {
    const app = withSince([]);
    (app.probes as Record<string, unknown>).promCoverage = { ok: false, error: 'promtool: boom' };
    expect(run(app).annotations.map((a) => a.kind)).toContain('alert_window_unverified');
  });

  it('accepts coverage at the configured minimum ratio', () => {
    const app = withSince([]);
    (app.probes as Record<string, unknown>).promCoverage = {
      ok: true,
      value: { samples: 1, expected: 1, ratio: ALERT_COVERAGE_MIN_RATIO },
    };
    expect(run(app).annotations.map((a) => a.kind)).not.toContain('alert_window_partial');
  });

  // The core's own stated rule for mandatory probes: the generic failure loop only visits keys that
  // EXIST, so an omitted probe would produce neither alarm nor annotation and the sweep would revert to
  // reading only the present tense — as a clean digest.
  it('names the history probe when it is absent from the bag entirely', () => {
    const app = baseApp();
    delete (app.probes as Record<string, unknown>).promAlertsSince;
    const note = run(app).annotations.find((a) => a.probe === 'promAlertsSince');
    expect(note?.kind).toBe('probe_failed');
  });

  it('voids the history when the live probe is missing, not merely failed', () => {
    const app = withSince([
      { alertname: 'ReconciliationMismatch', severity: 'warning', samples: 51 },
    ]);
    delete (app.probes as Record<string, unknown>).promAlerts;
    const kinds = run(app).annotations.map((a) => a.kind);
    expect(kinds).toContain('probe_voided');
    expect(kinds).not.toContain('prometheus_alert_resolved');
  });

  // The core is documented as never throwing — a throw aborts a scheduled ops pass and costs the whole
  // digest, alarms included. A malformed probe value is data, not an exception.
  it('does not throw on a malformed history probe value', () => {
    const app = baseApp();
    (app.probes as Record<string, unknown>).promAlertsSince = {
      ok: true,
      value: { lookbackMs: ALERT_LOOKBACK_MS },
    };
    expect(() => run(app)).not.toThrow();
  });
});

describe('loop-sweep-core log window disclosure', () => {
  const scan = (oldestMs: number) => ({
    ok: true,
    value: { matched: 5, scanned: 20000, lines: 16857, oldestMs, newestMs: NOW, top: [] },
  });

  it('discloses a warn window narrower than the alert lookback', () => {
    // Tail reaches 2h back; the container booted 24h ago, so 10h of warnings really are unread.
    const out = run(baseApp({ probes: { errorScan: scan(NOW - 2 * 60 * 60 * 1000) } }));
    const note = out.annotations.find((a) => a.kind === 'log_window_short');
    expect(note?.detail).toContain('2.0h');
    expect(note?.detail).toContain('UNREAD');
  });

  // A tail reaching the container's own start is COMPLETE however short it is — there are no older
  // lines to have missed. Without this the note would fire for 12h after every redeploy and claim
  // blindness that does not exist, which is the same overstatement the probe above exists to remove.
  it('stays silent when the tail reaches the container start, however short the span', () => {
    const startedAt = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();
    const app = baseApp({
      startedAt,
      probes: { errorScan: scan(Date.parse(startedAt) + LOG_BOOT_REACH_MS - 1) },
    });
    expect(run(app).annotations.map((a) => a.kind)).not.toContain('log_window_short');
  });

  // The boot-reach exemption is narrow: it excuses a short window only when the tail actually starts
  // at the boot. A long-lived container whose tail covers just the last 6h is still 14h blind.
  it('still discloses when the tail starts well after the container did', () => {
    const app = baseApp({
      startedAt: new Date(NOW - 20 * 60 * 60 * 1000).toISOString(),
      probes: { errorScan: scan(NOW - 6 * 60 * 60 * 1000) },
    });
    expect(run(app).annotations.map((a) => a.kind)).toContain('log_window_short');
  });

  // Docker does not truncate the json-file log when a container restarts IN PLACE, so a tail can reach
  // lines OLDER than StartedAt. A signed comparison treated every such tail as reaching boot and
  // suppressed the disclosure — worst exactly after a restart storm, when the unread window is largest
  // and most likely to hold the cause.
  it('discloses a short window whose tail predates the container start (in-place restart)', () => {
    const app = baseApp({
      startedAt: new Date(NOW - 30 * 60 * 1000).toISOString(),
      probes: { errorScan: scan(NOW - 40 * 60 * 1000) },
    });
    expect(run(app).annotations.map((a) => a.kind)).toContain('log_window_short');
  });

  // A warn count over a window of unknown depth is the negative-read void verbatim: staying silent
  // would let the digest print a confident `warn+ lines: 0` with nothing qualifying it.
  it('discloses an unknown window instead of skipping the check', () => {
    const app = baseApp({
      probes: {
        errorScan: {
          ok: true,
          value: { matched: 0, scanned: 20000, lines: 0, oldestMs: null, newestMs: null, top: [] },
        },
      },
    });
    expect(run(app).annotations.map((a) => a.kind)).toContain('log_window_unknown');
  });

  // Span measured on ONE clock. oldestMs/newestMs are the container's; nowMs is the host's, and this
  // host's Docker VM clock drifts across suspend/resume — mixing them let a lagging container clock
  // inflate the span and suppress a real disclosure.
  it('measures the span on the container clock alone, immune to host skew', () => {
    const app = baseApp({
      startedAt: new Date(NOW - 20 * 60 * 60 * 1000).toISOString(),
      probes: {
        errorScan: {
          ok: true,
          value: {
            matched: 5,
            scanned: 20000,
            lines: 900,
            // A ~1.5h tail read through an 11h container-clock lag.
            oldestMs: NOW - 12.5 * 60 * 60 * 1000,
            newestMs: NOW - 11 * 60 * 60 * 1000,
            top: [],
          },
        },
      },
    });
    const note = run(app).annotations.find((a) => a.kind === 'log_window_short');
    expect(note?.detail).toContain('1.5h');
  });
});
