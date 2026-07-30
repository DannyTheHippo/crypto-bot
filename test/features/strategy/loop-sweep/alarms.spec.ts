import { describe, it, expect } from 'vitest';
// @ts-expect-error scripts/** live outside the tsconfig graph (see tsconfig.eslint.json's include
// list) — the pure sweep core is a stdlib-only .mjs with no declaration file. vitest/swc resolves it
// at runtime; this directive is the only bridge across the graph boundary the four-file deliverable
// allows (no 5th .d.ts, no tsconfig edit).
import * as coreModule from '../../../../scripts/loop-sweep-core.mjs';

// loop-sweep-core.mjs is the PURE decision layer of the Y2 health sweep: given a prior watermark and
// this pass's probe results it derives {deltas, alarms, annotations} with no I/O. This spec pins the
// §C defect-class checks (loop-mechanism-learnings-2026-07.md) the core encodes — each alarm fires on
// its own signature and stays silent otherwise, probe failures degrade to named notes (never a crash,
// never a false pass), and a boot change resets deltas instead of fabricating negatives.
//
// v3 single stack (2026-07-20 consolidation): ONE app process serves both venues (binance spot +
// binanceusdm perp) — the v2 per-lane fixtures (separate `spot`/`perp` lane objects) collapse to one
// `app` object. `reconciliations` stays the one per-venue exception (venue-scoped table), so
// reconcile-derived alarms (reconcile_halt, journal_silence, its negative_read_void) carry a `venue`
// field and the fixtures below key `probes.reconcile` by venue id.

interface Alarm {
  kind: string;
  venue?: string;
  detail: string;
}
interface Annotation {
  kind: string;
  venue?: string;
  probe?: string;
  detail: string;
}
interface SweepResult {
  deltas: Record<string, unknown> | null;
  alarms: Alarm[];
  annotations: Annotation[];
}
interface Core {
  computeSweep: (input: { prev: unknown; cur: unknown }) => SweepResult;
  EXPECTED_SWEEP_INTERVAL_MS: number;
  LIVENESS_MIN_ELAPSED_MS: number;
  VENUES: [string, string];
  AGENTIC_DAILY_COST_BREAKER_USD: number;
  RECONCILE_CLEAN_STAMP_STALE_MS: number;
  BUDGET_GAUGE_INIT_GRACE_MS: number;
}
const core = coreModule as unknown as Core;
const {
  computeSweep,
  EXPECTED_SWEEP_INTERVAL_MS,
  LIVENESS_MIN_ELAPSED_MS,
  VENUES,
  AGENTIC_DAILY_COST_BREAKER_USD,
  RECONCILE_CLEAN_STAMP_STALE_MS,
  BUDGET_GAUGE_INIT_GRACE_MS,
} = core;
const [SPOT, PERP] = VENUES;

const WM_TIME = 10_000_000_000;

interface ReconcileProbe {
  ok: boolean;
  value: { count: number; latestResult: string };
}

// Fixed-shape probe bag (not Record<string,...>) so noUncheckedIndexedAccess doesn't force every
// mutation site below through an `undefined` check — each field is a known, always-present key.
interface FiringAlert {
  alertname: string;
  severity: string;
  activeAt: string | null;
  summary: string;
  scope?: string;
}
interface Probes {
  decides: { ok: boolean; value: { count: number; latestCreatedAtMs: number } };
  realDecides: { ok: boolean; value: { count: number; latestCreatedAtMs: number } };
  consultGate: { ok: boolean; value: { total: number } };
  fills: { ok: boolean; value: { count: number } };
  reconcile: Record<string, ReconcileProbe>;
  reconcileCleanStamp: { ok: boolean; value: { seconds: number } };
  killSwitch: { ok: boolean; value: { state: string } };
  cost: { ok: boolean; value: { spendUsd: number; remainingUsd?: number } };
  wsRecreations: { ok: boolean; value: { count: number } };
  rss: { ok: boolean; value: { bytes: number } };
  promAlerts:
    | {
        ok: true;
        error?: undefined;
        value: { ruleCount: number; alertingCount: number; firing: FiringAlert[] };
      }
    | { ok: false; error: string; value?: undefined };
  promAlertsSince: {
    ok: boolean;
    value: {
      resolved: { alertname: string; severity: string; samples: number }[];
      lookbackMs: number;
    };
  };
  promCoverage: { ok: boolean; value: { samples: number; expected: number; ratio: number } };
}
interface App {
  bootId: string;
  containerHealthy: boolean;
  restartCount: number;
  startedAt: string;
  probes: Probes;
}

function baseReconcileByVenue(
  count: number,
  latestResult = 'CLEAN',
): Record<string, ReconcileProbe> {
  const out: Record<string, ReconcileProbe> = {};
  for (const venue of VENUES) out[venue] = { ok: true, value: { count, latestResult } };
  return out;
}

function baseProbes(): Probes {
  return {
    decides: { ok: true, value: { count: 100, latestCreatedAtMs: WM_TIME } },
    // Matches the watermark's `realDecides: 20` below by default — a test perturbs it explicitly to
    // exercise the dead-lane annotation, exactly like every other counter in this fixture.
    realDecides: { ok: true, value: { count: 20, latestCreatedAtMs: WM_TIME } },
    consultGate: { ok: true, value: { total: 50 } },
    fills: { ok: true, value: { count: 10 } },
    reconcile: baseReconcileByVenue(200),
    // Stamped 1 min before the sweep reads it — comfortably fresh.
    reconcileCleanStamp: {
      ok: true,
      value: { seconds: (WM_TIME + EXPECTED_SWEEP_INTERVAL_MS - 60_000) / 1000 },
    },
    killSwitch: { ok: true, value: { state: 'RUNNING' } },
    cost: { ok: true, value: { spendUsd: 0.1 } },
    wsRecreations: { ok: true, value: { count: 2 } },
    rss: { ok: true, value: { bytes: 1000 } },
    // Rules demonstrably loaded and nothing firing — the only shape that legitimately reads as quiet.
    promAlerts: { ok: true, value: { ruleCount: 20, alertingCount: 20, firing: [] } },
    // Both alert-HISTORY probes are mandatory in the core (an absent one annotates), so the base bag
    // carries their quiet shape: a fully-scraped window in which nothing fired and resolved. Their own
    // behaviour is pinned in alert-history.spec.ts; here they only need to stay silent.
    promAlertsSince: { ok: true, value: { resolved: [], lookbackMs: 12 * 60 * 60 * 1000 } },
    promCoverage: { ok: true, value: { samples: 2880, expected: 2880, ratio: 1 } },
  };
}

function baseApp(): App {
  return {
    bootId: 'boot-A',
    containerHealthy: true,
    restartCount: 3,
    // Docker's StartedAt shape — the fallback age source when the clean stamp reads 0.
    startedAt: new Date(WM_TIME - 24 * 60 * 60 * 1000).toISOString(),
    probes: baseProbes(),
  };
}

// The sweep's own wall-clock inside these fixtures (see curWith) — every age assertion is relative
// to this, never to the watermark instant.
const NOW = WM_TIME + EXPECTED_SWEEP_INTERVAL_MS;

// Watermark counters that MATCH baseProbes exactly — a test perturbs only the counter it exercises so
// deltas are zero everywhere else (isolating the one alarm under test).
function baseWatermark(): Record<string, unknown> {
  const reconcileByVenue: Record<string, number> = {};
  for (const venue of VENUES) reconcileByVenue[venue] = 200;
  return {
    sweptAtMs: WM_TIME,
    app: {
      bootId: 'boot-A',
      restartCount: 3,
      counters: {
        decides: 100,
        realDecides: 20,
        consultGate: 50,
        fills: 10,
        reconcileByVenue,
        wsRecreations: 2,
        rssBytes: 1000,
      },
    },
  };
}

// A `cur` one design-interval after the watermark (well under the 2x host-sleep gap).
function curWith(app: App): Record<string, unknown> {
  return { sweptAtMs: WM_TIME + EXPECTED_SWEEP_INTERVAL_MS, app };
}

function kinds(items: { kind: string }[]): string[] {
  return items.map((i) => i.kind);
}

describe('loop-sweep-core alarms', () => {
  it('is silent when the app is healthy and every counter advanced (both venues)', () => {
    const app = baseApp();
    app.probes.decides.value.count = 130;
    app.probes.consultGate.value.total = 70;
    app.probes.reconcile = baseReconcileByVenue(220);
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    expect(alarms).toEqual([]);
  });

  it('zero_decides fires when the container is healthy but liveness counters are unchanged since watermark', () => {
    const app = baseApp();
    // decides + consult-gate frozen; reconcile advances on both venues so journal_silence stays silent.
    app.probes.reconcile = baseReconcileByVenue(220);
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    expect(kinds(alarms)).toContain('zero_decides');
    expect(kinds(alarms)).not.toContain('journal_silence');
  });

  it('delta-starvation alarms are suppressed (annotated) under the liveness elapsed floor — back-to-back sweeps are not the R8-7 signature', () => {
    const app = baseApp(); // every counter frozen: both starvation alarms would fire on a full window
    const cur = { sweptAtMs: WM_TIME + LIVENESS_MIN_ELAPSED_MS - 1, app };
    const { alarms, annotations } = computeSweep({ prev: baseWatermark(), cur });
    expect(kinds(alarms)).not.toContain('zero_decides');
    expect(kinds(alarms)).not.toContain('journal_silence');
    expect(kinds(annotations)).toContain('short_interval');
  });

  it('an UNKNOWN elapsed (watermark without sweptAtMs) does not suppress starvation alarms — conservative toward detection', () => {
    const app = baseApp();
    const wm = baseWatermark();
    delete wm['sweptAtMs'];
    const cur = { sweptAtMs: WM_TIME + EXPECTED_SWEEP_INTERVAL_MS, app };
    const { alarms } = computeSweep({ prev: wm, cur });
    expect(kinds(alarms)).toContain('zero_decides');
  });

  it('does not fire zero_decides while the container is unhealthy (no green positive control)', () => {
    const app = baseApp();
    app.containerHealthy = false;
    app.probes.reconcile = baseReconcileByVenue(220);
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    expect(kinds(alarms)).not.toContain('zero_decides');
  });

  // The defect this pass fixes: `decides` is an UNFILTERED agent_decisions row count, so a scheduled
  // skip (no model call at all) advances it identically to a real decide. Live proof, 2026-07-29: 160
  // rows/hour for 12 straight hours while both LLM provider accounts sat unfunded and the lane made
  // ZERO real model calls — `zero_decides` above is structurally incapable of firing on that shape,
  // because `deltas.decides` never reads 0. These cases pin the SEPARATE `realDecides` instrument that
  // makes the dead lane visible without touching `zero_decides`'s own job (detecting the scheduler
  // itself stalling, which DOES freeze the raw row count).
  describe('real vs total decide liveness (the dead-LLM-lane class)', () => {
    it('reports the total and the real counter as genuinely independent deltas', () => {
      const app = baseApp();
      app.probes.decides.value.count = 260; // total climbs by 160 (the observed scheduled-skip rate)
      // realDecides left at its baseApp default (20 === watermark 20) — zero real decides this window.
      const { deltas } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
      expect(deltas?.decides).toBe(160);
      expect(deltas?.realDecides).toBe(0);
      // The two must never collapse into one number — that collapse IS the defect being fixed.
      expect(deltas?.decides).not.toBe(deltas?.realDecides);
    });

    it('the dead-lane shape (total climbing, real decides flat) is annotated — and does NOT alarm', () => {
      const app = baseApp();
      app.probes.decides.value.count = 260; // scheduler alive: total row count climbs
      app.probes.consultGate.value.total = 86; // consult-gate climbs too (skipped_scheduled outcomes)
      app.probes.reconcile = baseReconcileByVenue(220); // journal_silence stays silent
      // realDecides unchanged from baseApp (20) — zero genuine model round trips this window.
      const { alarms, annotations } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
      // The exact prior blindness: zero_decides cannot see this, because deltas.decides is 160, not 0.
      expect(kinds(alarms)).not.toContain('zero_decides');
      const note = annotations.find((a) => a.kind === 'no_real_decides_in_window');
      expect(note).toBeDefined();
      expect(note?.probe).toBe('realDecides');
      expect(note?.detail).toContain('160');
      // Never promoted to a blocking alarm (playbook §3 would wedge every future pass on an unfunded
      // account with no clear date) — this MUST stay an annotation regardless of how the total moves.
      expect(kinds(alarms)).not.toContain('no_real_decides_in_window');
    });

    it('stays silent when the lane is genuinely alive — a real decide in the window clears the annotation', () => {
      const app = baseApp();
      app.probes.decides.value.count = 260;
      app.probes.consultGate.value.total = 86;
      app.probes.reconcile = baseReconcileByVenue(220);
      app.probes.realDecides.value.count = 21; // one genuine model round trip this window
      const { annotations } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
      expect(kinds(annotations)).not.toContain('no_real_decides_in_window');
    });

    it('an absent realDecides probe is a named failure, never a silently clean digest', () => {
      const app = baseApp();
      const probes = app.probes as unknown as Record<string, unknown>;
      delete probes.realDecides;
      const { annotations } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
      const failed = annotations.find(
        (a) => a.kind === 'probe_failed' && a.probe === 'realDecides',
      );
      expect(failed).toBeDefined();
    });
  });

  it("journal_silence fires per venue when that venue's reconciliations journal produced no new rows while healthy", () => {
    const app = baseApp();
    // reconcile frozen on both venues; decides advances so zero_decides stays silent.
    app.probes.decides.value.count = 140;
    app.probes.consultGate.value.total = 80;
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    expect(kinds(alarms)).not.toContain('zero_decides');
    const silences = alarms.filter((a) => a.kind === 'journal_silence');
    expect(silences.map((a) => a.venue).sort()).toEqual([...VENUES].sort());
  });

  it('journal_silence fires ONLY for the venue that went silent — the sibling venue advancing does not mask it', () => {
    const app = baseApp();
    app.probes.decides.value.count = 140;
    app.probes.consultGate.value.total = 80;
    app.probes.reconcile[PERP] = { ok: true, value: { count: 260, latestResult: 'CLEAN' } }; // perp advances
    // spot (VENUES[0]) stays frozen at 200 (== watermark) -> journal_silence[spot] only.
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    const silences = alarms.filter((a) => a.kind === 'journal_silence');
    expect(silences.map((a) => a.venue)).toEqual([SPOT]);
  });

  it('kill_switch_engaged fires on any non-RUNNING state (account-level, no venue)', () => {
    const app = baseApp();
    app.probes.killSwitch.value.state = 'HALTED_DEGRADED';
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    const ks = alarms.find((a) => a.kind === 'kill_switch_engaged');
    expect(ks).toBeDefined();
    expect(ks?.detail).toContain('HALTED_DEGRADED');
    expect(ks?.venue).toBeUndefined();
  });

  it('reconcile_halt fires when the latest reconciliation verdict is HALT for a venue', () => {
    const app = baseApp();
    app.probes.reconcile[PERP] = { ok: true, value: { count: 200, latestResult: 'HALT' } };
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    const halt = alarms.find((a) => a.kind === 'reconcile_halt');
    expect(halt).toBeDefined();
    expect(halt?.venue).toBe(PERP);
  });

  it("reconcile_halt on one venue is not masked by the sibling venue's CLEAN latest row", () => {
    const app = baseApp();
    app.probes.reconcile[SPOT] = { ok: true, value: { count: 200, latestResult: 'HALT' } };
    app.probes.reconcile[PERP] = { ok: true, value: { count: 205, latestResult: 'CLEAN' } };
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    const halts = alarms.filter((a) => a.kind === 'reconcile_halt');
    expect(halts).toHaveLength(1);
    expect(halts[0]?.venue).toBe(SPOT);
  });

  // 2026-07-27 incident: perp reported MISMATCH on EVERY pass (adopt_non_adoptable on an order
  // stranded non-terminal) and the sweep raised ZERO alarms, because latestResult was never 'HALT'.
  // The fact that mattered was invisible: no pass was stamping actionable-clean, so kill-switch
  // auto-resume was disarmed for the whole book.
  it('reconcile_clean_stamp_stale fires when no pass has stamped actionable-clean past the bound, even with no HALT anywhere', () => {
    const app = baseApp();
    app.probes.reconcileCleanStamp.value.seconds =
      (NOW - (RECONCILE_CLEAN_STAMP_STALE_MS + 60_000)) / 1000;
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    expect(kinds(alarms)).not.toContain('reconcile_halt');
    const stale = alarms.filter((a) => a.kind === 'reconcile_clean_stamp_stale');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.detail).toContain('auto-resume is disarmed');
  });

  // 2026-07-28 incident: AgentClientFatalLatch fired critical at 21:16Z (the Anthropic account's
  // credit ran out; the client latched and made zero LLM calls for ~3h) and three consecutive
  // collector digests still reported `alarms:[]`. Every liveness delta kept moving — the latched
  // client journals a decision row per symbol — so nothing in this core could see it. The sweep now
  // inherits Prometheus' own verdict instead of only re-deriving conditions it was taught.
  it('prometheus_alert_firing promotes every firing rule to an alarm, one per firing instance', () => {
    const app = baseApp();
    app.probes.promAlerts = {
      ok: true,
      value: {
        ruleCount: 20,
        alertingCount: 20,
        firing: [
          {
            alertname: 'AgentClientFatalLatch',
            severity: 'critical',
            activeAt: '2026-07-27T21:16:25Z',
            summary: 'Agent client hit a FATAL API error',
          },
          {
            alertname: 'ReconciliationHalt',
            severity: 'critical',
            activeAt: '2026-07-27T22:00:00Z',
            summary: 'book halted',
          },
        ],
      },
    };
    app.probes.decides.value.count = 130;
    app.probes.consultGate.value.total = 70;
    app.probes.reconcile = baseReconcileByVenue(220);
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    const fired = alarms.filter((a) => a.kind === 'prometheus_alert_firing');
    expect(fired).toHaveLength(2);
    expect(fired[0]?.detail).toContain('AgentClientFatalLatch');
    expect(fired[0]?.detail).toContain('critical');
    expect(fired[0]?.detail).toContain('2026-07-27T21:16:25Z');
    expect(fired[1]?.detail).toContain('ReconciliationHalt');
  });

  // Only `critical` blocks. Measured on this stack when the promotion was written: ≥1 rule was firing
  // 58.4% of the last 7 days, dominated by warning-severity rules the program knowingly runs through
  // (ReconciliationMismatch 1135 of 1440 min; AgenticReflectionNeverMinted 4084 min/7d — that rule was
  // deleted 2026-07-30 with the in-process reflection loop, but the measurement it produced is what
  // set this policy, so it is quoted as history rather than restated against a live rule). Since playbook
  // §3 makes ANY alarm block all improvement work, promoting warnings would have wedged the loop on
  // roughly six passes in ten — and `info` (EffectiveModeLive) fires permanently once live is armed.
  it('promotes only critical alerts to alarms — warning and info annotate instead, so the incident gate is not wedged by rules the program runs through', () => {
    const app = baseApp();
    app.probes.promAlerts = {
      ok: true,
      value: {
        ruleCount: 20,
        alertingCount: 20,
        firing: [
          {
            alertname: 'ReconciliationMismatch',
            severity: 'warning',
            activeAt: '2026-07-27T04:00:00Z',
            summary: 'benign shared-wallet noise',
          },
          {
            alertname: 'EffectiveModeLive',
            severity: 'info',
            activeAt: '2026-07-27T04:00:00Z',
            summary: 'live is legitimate when armed',
          },
          {
            alertname: 'AgentClientFatalLatch',
            severity: 'critical',
            activeAt: '2026-07-27T21:16:25Z',
            summary: 'lane latched',
          },
        ],
      },
    };
    app.probes.decides.value.count = 130;
    app.probes.consultGate.value.total = 70;
    app.probes.reconcile = baseReconcileByVenue(220);
    const { alarms, annotations } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    const fired = alarms.filter((a) => a.kind === 'prometheus_alert_firing');
    expect(fired).toHaveLength(1);
    expect(fired[0]?.detail).toContain('AgentClientFatalLatch');
    const nonBlocking = annotations.filter((n) => n.kind === 'prometheus_alert_firing_nonblocking');
    expect(nonBlocking).toHaveLength(2);
    expect(nonBlocking.map((n) => n.detail).join(' ')).toContain('ReconciliationMismatch');
    expect(nonBlocking.map((n) => n.detail).join(' ')).toContain('EffectiveModeLive');
  });

  // An ABSENT probe key, not a failed one: the generic probe-failure loop only visits keys that exist,
  // so omission would produce zero alarms AND zero annotations — reading as `Alarms (0)` for the one
  // condition that must never read that way.
  it('an absent promAlerts probe is a named failure — the sweep can never silently stop reading alert state', () => {
    const app = baseApp();
    const probes = app.probes as unknown as Record<string, unknown>;
    delete probes.promAlerts;
    app.probes.decides.value.count = 130;
    app.probes.consultGate.value.total = 70;
    app.probes.reconcile = baseReconcileByVenue(220);
    const { annotations } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    const failed = annotations.find((n) => n.kind === 'probe_failed' && n.probe === 'promAlerts');
    expect(failed?.detail).toContain('never read');
  });

  it('reconcile_clean_stamp_stale does NOT fire while the stamp is fresh — benign per-pass mismatches keep refreshing it', () => {
    const app = baseApp();
    // Both venues read MISMATCH (the shared-wallet foreign-order steady state), yet the stamp is
    // current: the raw `result` column is not the quantity auto-resume depends on.
    app.probes.reconcile = baseReconcileByVenue(200, 'MISMATCH');
    app.probes.reconcileCleanStamp.value.seconds =
      (NOW - (RECONCILE_CLEAN_STAMP_STALE_MS - 60_000)) / 1000;
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    expect(kinds(alarms)).not.toContain('reconcile_clean_stamp_stale');
  });

  it('a never-stamped gauge (0, the uninitialised-at-boot default) is aged off StartedAt — a fresh boot is not paged before its first pass can land', () => {
    const app = baseApp();
    app.probes.reconcileCleanStamp.value.seconds = 0;
    app.startedAt = new Date(NOW - 60_000).toISOString();
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    expect(kinds(alarms)).not.toContain('reconcile_clean_stamp_stale');
  });

  it('a never-stamped gauge on a long-running container DOES fire, naming that it never stamped this boot', () => {
    const app = baseApp();
    app.probes.reconcileCleanStamp.value.seconds = 0;
    app.startedAt = new Date(NOW - (RECONCILE_CLEAN_STAMP_STALE_MS + 60_000)).toISOString();
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    const stale = alarms.find((a) => a.kind === 'reconcile_clean_stamp_stale');
    expect(stale?.detail).toContain('never stamped this boot');
  });

  it('a never-stamped gauge with an unparseable StartedAt is a named probe failure, never a silent pass (§C.9)', () => {
    const app = baseApp();
    app.probes.reconcileCleanStamp.value.seconds = 0;
    app.startedAt = 'not-a-timestamp';
    const { alarms, annotations } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    expect(kinds(alarms)).not.toContain('reconcile_clean_stamp_stale');
    const failed = annotations.find(
      (a) => a.kind === 'probe_failed' && a.probe === 'reconcileCleanStamp',
    );
    expect(failed?.detail).toContain('age undetermined, not clean');
  });

  it(`cost_breaker_proximity fires at >=80% of the $${AGENTIC_DAILY_COST_BREAKER_USD} unified daily breaker`, () => {
    const app = baseApp();
    app.probes.cost.value.spendUsd = 0.8 * AGENTIC_DAILY_COST_BREAKER_USD;
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    expect(kinds(alarms)).toContain('cost_breaker_proximity');
  });

  // Found live 2026-07-28: agentic_budget_remaining_usd is only set once the lane evaluates its
  // budget, so a fresh boot reads prom-client's default 0 and spend = breaker − remaining renders the
  // whole breaker as spent. The boot's own log said `$0.0000 of $3 already spent today` while the sweep
  // said `spend $3 >= 80%`. Playbook §3 makes any alarm block improvement work, so a deploy-shaped
  // fiction would consume a pass.
  it('cost_breaker_proximity does NOT fire on an uninitialised budget gauge inside the boot grace — it annotates', () => {
    const app = baseApp();
    app.probes.cost.value = { spendUsd: AGENTIC_DAILY_COST_BREAKER_USD, remainingUsd: 0 };
    app.startedAt = new Date(NOW - 20_000).toISOString(); // 20s old
    const { alarms, annotations } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    expect(kinds(alarms)).not.toContain('cost_breaker_proximity');
    const note = annotations.find((n) => n.kind === 'budget_gauge_uninitialised');
    expect(note?.detail).toContain('not evidence of spend');
  });

  it('cost_breaker_proximity DOES fire on a remaining-0 gauge past the boot grace — a real exhaustion is not suppressed', () => {
    const app = baseApp();
    app.probes.cost.value = { spendUsd: AGENTIC_DAILY_COST_BREAKER_USD, remainingUsd: 0 };
    app.startedAt = new Date(NOW - (BUDGET_GAUGE_INIT_GRACE_MS + 60_000)).toISOString();
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    expect(kinds(alarms)).toContain('cost_breaker_proximity');
  });

  it('a NON-zero remaining is unambiguous and alarms even on a brand-new boot', () => {
    const app = baseApp();
    app.probes.cost.value = { spendUsd: 0.8 * AGENTIC_DAILY_COST_BREAKER_USD, remainingUsd: 0.6 };
    app.startedAt = new Date(NOW - 20_000).toISOString();
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    expect(kinds(alarms)).toContain('cost_breaker_proximity');
  });

  it('restart_storm fires when RestartCount climbed more than once since the watermark', () => {
    const app = baseApp();
    app.restartCount = 5; // watermark was 3 => +2 restarts
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    expect(kinds(alarms)).toContain('restart_storm');
  });

  it('does not fire restart_storm on a single ordinary redeploy', () => {
    const app = baseApp();
    app.restartCount = 4; // +1
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    expect(kinds(alarms)).not.toContain('restart_storm');
  });

  it('a failed probe becomes a named probe_failed note — never a pass, never a throw', () => {
    const app = baseApp();
    (app as { probes: unknown }).probes = {
      ...app.probes,
      decides: { ok: false, error: 'psql exited 2: connection refused' },
    };
    let result!: SweepResult;
    expect(() => {
      result = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    }).not.toThrow();
    const failed = result.annotations.find(
      (n) => n.kind === 'probe_failed' && n.probe === 'decides',
    );
    expect(failed).toBeDefined();
    // The frozen-counter alarm must NOT fire off an unreadable probe (delta is null, not zero).
    expect(kinds(result.alarms)).not.toContain('zero_decides');
    const deltas = result.deltas as { decides: number | null } | null;
    expect(deltas?.decides).toBeNull();
  });

  it('a failed reconcile probe for one venue becomes a venue-tagged probe_failed note', () => {
    const app = baseApp();
    app.probes.reconcile[PERP] = { ok: false, error: 'psql exited 2: connection refused' } as never;
    const result = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    const failed = result.annotations.find(
      (n) => n.kind === 'probe_failed' && n.probe === 'reconcile' && n.venue === PERP,
    );
    expect(failed).toBeDefined();
  });

  it('a sweep gap beyond 2x the expected interval is a host-sleep ANNOTATION, not an alarm', () => {
    const app = baseApp();
    app.probes.reconcile = baseReconcileByVenue(220);
    app.probes.decides.value.count = 140;
    app.probes.consultGate.value.total = 80;
    const cur = {
      sweptAtMs: WM_TIME + 3 * EXPECTED_SWEEP_INTERVAL_MS, // > 2x gap
      app,
    };
    const { alarms, annotations } = computeSweep({ prev: baseWatermark(), cur });
    expect(kinds(annotations)).toContain('host_sleep_suspected');
    expect(kinds(alarms)).not.toContain('host_sleep_suspected');
  });

  it('bootId mismatch resets deltas verbatim and never yields a negative delta', () => {
    const app = baseApp();
    app.bootId = 'boot-B'; // watermark was boot-A
    // Counters LOWER than the watermark — a cross-boot subtraction would go negative.
    app.probes.decides.value.count = 5;
    app.probes.consultGate.value.total = 1;
    app.probes.reconcile = baseReconcileByVenue(3);
    const { deltas, annotations, alarms } = computeSweep({
      prev: baseWatermark(),
      cur: curWith(app),
    });
    const reset = annotations.find((n) => n.kind === 'boot_changed');
    expect(reset?.detail).toBe('boot changed — deltas reset');
    expect(deltas).toBeNull();
    // No delta-derived alarm may fire off a reset boot.
    expect(kinds(alarms)).not.toContain('zero_decides');
    expect(kinds(alarms)).not.toContain('journal_silence');
  });

  it('negative_read_void notes a zero durable counter while a sibling counter proves the stack answers', () => {
    const app = baseApp();
    app.probes.decides.value.count = 0; // empty read
    app.probes.fills.value.count = 10; // positive control: the DB IS returning data
    const { annotations } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    const void_ = annotations.find((n) => n.kind === 'negative_read_void' && n.probe === 'decides');
    expect(void_).toBeDefined();
  });

  it('negative_read_void notes a zero reconcile count for ONE venue, tagged with that venue', () => {
    const app = baseApp();
    app.probes.reconcile[PERP] = { ok: true, value: { count: 0, latestResult: 'NONE' } };
    const { annotations } = computeSweep({ prev: baseWatermark(), cur: curWith(app) });
    const void_ = annotations.find(
      (n) => n.kind === 'negative_read_void' && n.probe === 'reconcile' && n.venue === PERP,
    );
    expect(void_).toBeDefined();
  });

  it('the first sweep (no watermark) reports no deltas and does not crash', () => {
    const app = baseApp();
    const result = computeSweep({ prev: null, cur: curWith(app) });
    expect(kinds(result.annotations)).toContain('no_watermark');
    expect(result.deltas).toBeNull();
  });
});
