#!/usr/bin/env node
// Y2 deterministic health-sweep — PURE logic. No I/O, no clock, no process/env access: given a prior
// watermark and this pass's probe results, derive the counter deltas, the fired alarms, and the
// advisory annotations. Every §C defect-class check (loop-mechanism-learnings-2026-07.md) that a
// single pass can evaluate deterministically lives here so it is unit-testable off a fixture; the
// runner (loop-sweep.mjs) only gathers probes and renders the result.
//
// v3 single stack (2026-07-20 consolidation, spec §9): ONE process now serves both venues (spot
// binance + perp binanceusdm) against ONE db and ONE Prometheus — the v2 per-lane split (separate
// container/db/Prometheus per lane) is gone. Account-level facts (bootId, RestartCount, decides,
// consult-gate, fills, kill switch, cost, rss) are singular. `reconciliations` is the one exception
// still split — the DB table stays venue-scoped (venue NOT NULL, one row per venue-pass per tick,
// trading.schema.ts) and Prometheus's `reconciliation_runs_total` carries a `venue` label (v3
// consolidation spec §8) — a HALT/silent venue must not be masked by its sibling venue's clean rows,
// so reconcile-derived checks stay per-venue via the venue label on this SAME db.
//
// Contract:
//   computeSweep({ prev, cur }) -> { deltas, alarms, annotations }
//     prev : the prior watermark object ({ sweptAtMs, app }), or null on the first-ever sweep.
//     cur  : this pass's gathered probes ({ sweptAtMs, app }) — see gather() in loop-sweep.mjs.
//   classifyUnrecordedSweeps({ digestNames, logText }) -> { status, unrecorded, ..., annotations }
//     the loop's self-audit: which sweeps ran without leaving a pass entry behind (see its own
//     section at the foot of this file). Kept OUT of computeSweep because its inputs are repo
//     artifacts, not stack probes, and must not land in the digest's `cur`.
// Provenance-before-interpretation (§C.6, §D): counter deltas are computed ONLY when the current
// bootId matches the watermark's bootId — a restart resets process counters, so a cross-boot "delta"
// is meaningless and would fabricate negatives. A bootId mismatch yields the verbatim annotation
// 'boot changed — deltas reset' and null deltas, never a negative number.
// Measurement fails OPEN (§D): a failed probe (ok:false) becomes a named `probe_failed` annotation,
// never a pass and never a throw — a partial digest with failures named beats a confident blank.

// The venue ids this sweep reads reconciliations for — mirrors domain/venue/types/venue-map.ts's
// SPOT_VENUE/PERP_VENUE (a node script outside the tsconfig graph cannot import that .ts directly;
// re-verify against it before trusting this list).
export const VENUES = ['binance', 'binanceusdm'];

// 3x-daily discrete-pass cadence (§A): the design inter-pass gap. A wider gap is the host-sleep
// window, the highest-risk edge (§D host-state), so it opens the digest as an annotation, not an alarm.
export const EXPECTED_SWEEP_INTERVAL_MS = 8 * 60 * 60 * 1000;
export const HOST_SLEEP_GAP_FACTOR = 2;

// Cost-breaker proximity (§C.8 attempt-level fail-open budget gate): warn at 80% of the daily USD stop
// so a runaway is flagged BEFORE the pool zeroes and starves the process.
export const COST_PROXIMITY_RATIO = 0.8;

// How far back a pass asks Prometheus "did anything fire while nobody was looking", and the window
// every other TSDB-backed retrospective probe uses (log events, suspends). Sized off the design
// inter-pass gap above with margin. 1.5x8h covers a slipped pass without reaching so far back that a
// pass re-reads week-old history.
//
// It was deliberately NOT sized off the watermark while the hourly collector daemon existed, because
// that daemon advanced the watermark every tick and a watermark-sized window would have been ~1h.
// The daemon was retired 2026-07-29 (the app emits these facts itself now), so the watermark and the
// inter-pass gap coincide again — but this stays fixed and independent of the watermark, because a
// pass that runs a second ad-hoc sweep must not silently shrink its own retrospective window.
export const ALERT_LOOKBACK_MS = 1.5 * EXPECTED_SWEEP_INTERVAL_MS;

// How close a log tail's oldest line must sit to the container's StartedAt to count as reaching boot.
// The question this answers is "does the tail reach boot", where a false YES suppresses a real
// disclosure of blindness — so the margin is deliberately SMALL against a 12h window, wide enough only
// for the framework/Nest chatter that can precede the app's own pino stream by seconds.
export const LOG_BOOT_REACH_MS = 60 * 1000;

// Minimum fraction of the alert window Prometheus must actually have scraped before an EMPTY alert
// history counts as evidence of a quiet window. Below it the window has holes (Prometheus down,
// restarted, or host-slept) and alerts that fired inside a hole left no ALERTS samples at all. 0.9
// tolerates a container recreate and ordinary scrape jitter without tolerating an outage.
export const ALERT_COVERAGE_MIN_RATIO = 0.9;

// Delta-starvation alarms (zero_decides, journal_silence) fire only when the inter-sweep window is
// long enough that silence is actually abnormal: two sweeps minutes apart legitimately share the
// same counters (observed 2026-07-20 — back-to-back acceptance runs tripped zero_decides on a
// 3-minute gap). 30 min = two 15m bars, the smallest window in which a healthy process MUST have
// journaled something. An UNKNOWN elapsed (malformed watermark) does not suppress — conservative
// toward detection, matching the alarms' veto-only fail direction.
export const LIVENESS_MIN_ELAPSED_MS = 30 * 60 * 1000;

// ONE unified daily USD cost breaker (v3 §8: "ONE unified budget" — the v2 per-lane $1.50+$1.50 split
// is retired). Verified 2026-07-20 against AGENTIC_DAILY_COST_STOP_USD in .env.app (3). Re-verify
// against that key before trusting this constant (§D verify-before-cite: the stale "$5/day breaker"
// is the cautionary precedent).
export const AGENTIC_DAILY_COST_BREAKER_USD = 3;

// More than one restart between the watermark and now is a storm (§B R8-6 wedge-to-OOM: 36 recreations
// in ~35 min). A single restart is an ordinary redeploy, not an alarm.
export const RESTART_STORM_THRESHOLD = 1;

// Age bound on `reconciliation_last_success_timestamp_seconds` — the gauge is literally
// ReconciliationService's `lastCleanAt`, stamped only when a pass ends actionable-clean AND
// unhalted, and read by RecoveryCoordinatorService (180s freshness) as the precondition for
// kill-switch auto-resume. A frozen gauge therefore means recovery is disarmed for the whole book,
// which is the fact worth alarming on.
//
// Deliberately NOT the reconciliations table's `result='CLEAN'` age: that column is written off the
// RAW mismatch total, so the shared demo wallet's benign steady state (a foreign resting order ⇒
// `foreign_open_order` every pass) reads MISMATCH while the stamp is refreshing normally. The repo
// already rejected a clean-row age for exactly this reason — see ReconcilerStalled's comment in
// observability/alerts.rules.yml ("a clean-pass age would fire forever on a working reconciler").
//
// 30 min: the gauge refreshes on any actionable-clean pass (~30-60s cadence), so 30 min is far past
// transient. Tighter on purpose than the Prometheus twin ReconciliationNeverCleanSustained
// (>7200s, for: 30m) — that one pages an operator, this one is read by a loop pass that runs 3x/day
// and must not let a half-day of disarmed recovery pass as quiet health.
//
// NOT a claim that recovery is armed below the bound: RecoveryCoordinatorService's own gate is
// RECONCILE_FRESHNESS_MS = 180s, so auto-resume is genuinely disarmed anywhere past 3 min. This
// alarm is the 3x/day pass's backstop against a SUSTAINED disarm, not a live readiness probe —
// silence under 30 min means "not sustained", never "armed".
//
// A wake-edge fire after host sleep is EXPECTED and intended, not a false positive: the container is
// suspended rather than restarted, so the gauge holds its pre-sleep value and the catch-up sweep
// legitimately reads an hours-old stamp (the next pass re-stamps within ~60s). It is left firing on
// purpose — suppressing it on a sleep-shaped gap would also blind the alarm to a reconciler that
// wedged DURING the sleep, which is the exact 45h shape it exists to catch, for up to a full 8h
// sweep interval.
export const RECONCILE_CLEAN_STAMP_STALE_MS = 30 * 60 * 1000;

// `agentic_budget_remaining_usd` is only `set()` when the lane actually evaluates its budget, so on a
// fresh boot it sits at prom-client's default 0 until the first decide. The sweep derives
// spend = breaker − remaining, which turns that uninitialised 0 into "spend = the entire breaker" and
// fires cost_breaker_proximity on a boot that has spent nothing. Found live 2026-07-28 on a boot whose
// own log line read `daily LLM budget seeded … $0.0000 of $3 already spent today` while the sweep
// reported `spend $3 >= 80% of $3`.
//
// A false alarm here is not cosmetic: playbook §3 makes any alarm block the next pass's improvement
// work, so a deploy-shaped fiction would consume a pass. observability/alerts.rules.yml's
// AgenticBudgetExhausted already guards the identical gauge with `for: 5m` and says why ("so a fresh
// boot's transient 0 never pages before the gauge is populated"); this is the same 5 minutes, aged off
// the container's StartedAt because a sweep has no rule-evaluation history to lean on.
//
// Fails OPEN toward NOT alarming, and ONLY for the ambiguous reading: a 0 past the grace window is a
// real exhaustion and still alarms, and any non-zero remaining is unambiguous and unaffected. A
// genuinely exhausted breaker on a young boot is annotated rather than alarmed for 5 minutes — the
// honest verdict, since remaining=0 on a young boot cannot distinguish the two.
export const BUDGET_GAUGE_INIT_GRACE_MS = 5 * 60 * 1000;

// The values `build_info{git_sha}` can carry that are NOT a reading: 'unknown' is both the Dockerfile
// ARG default and the zod default, so it is what every image built without the GIT_SHA build arg
// reports, and an absent or empty label is no reading either. Exported so the runner's digest line and
// this core render the same verdict — the runner used to launder a missing label into the string
// 'unknown', which is what made a non-reading indistinguishable from a reading.
export function isBuildProvenanceVoid(gitSha) {
  if (gitSha === null || gitSha === undefined) return true;
  const s = String(gitSha).trim();
  return s === '' || s === 'unknown';
}

// DB-durable scalar counters whose absolute zero, while a sibling counter proves the stack IS
// returning data, is a negative-read void (§C.9) — Prometheus gauges (rss) and rate-y counters are
// excluded. `reconcile` is durable too but is checked per-venue separately (it is no longer a scalar).
const DURABLE_COUNTERS = new Set(['decides', 'fills']);

// Pull the scalar counter values (+ the per-venue reconcile map) out of the app's probe results, null
// wherever the probe failed — the runner uses this to persist the next watermark, and computeApp uses
// it to diff against the prior one.
export function extractCounters(appCur) {
  const p = (appCur && appCur.probes) || {};
  const val = (probe, field) =>
    probe && probe.ok === true && probe.value && Number.isFinite(probe.value[field])
      ? probe.value[field]
      : null;
  const reconcileByVenue = {};
  for (const venue of VENUES) {
    reconcileByVenue[venue] = val(p.reconcile && p.reconcile[venue], 'count');
  }
  return {
    decides: val(p.decides, 'count'),
    // Deliberately NOT in DURABLE_COUNTERS below: unlike `decides`/`fills`, a real 0 here is the
    // CURRENT true state (both LLM provider accounts unfunded since 2026-07-27T21:16Z) rather than a
    // suspicious empty read alongside live siblings — voiding it would misreport the very condition
    // this counter exists to surface.
    realDecides: val(p.realDecides, 'count'),
    consultGate: val(p.consultGate, 'total'),
    fills: val(p.fills, 'count'),
    reconcileByVenue,
    wsRecreations: val(p.wsRecreations, 'count'),
    rssBytes: val(p.rss, 'bytes'),
  };
}

const SCALAR_COUNTER_KEYS = [
  'decides',
  'realDecides',
  'consultGate',
  'fills',
  'wsRecreations',
  'rssBytes',
];

function diffCounters(prevCounters, curCounters) {
  const out = {};
  for (const key of SCALAR_COUNTER_KEYS) {
    const a = prevCounters ? prevCounters[key] : null;
    const b = curCounters[key];
    out[key] = Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
  }
  out.reconcileByVenue = {};
  for (const venue of VENUES) {
    const a =
      prevCounters && prevCounters.reconcileByVenue ? prevCounters.reconcileByVenue[venue] : null;
    const b = curCounters.reconcileByVenue[venue];
    out.reconcileByVenue[venue] = Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
  }
  return out;
}

// nowMs: the sweep's own wall-clock (cur.sweptAtMs), passed in rather than read — this module stays
// pure/clock-free so every age check is reproducible off a fixture.
function computeApp(prev, cur, elapsedMs = null, nowMs = null) {
  const alarms = [];
  const annotations = [];
  const probes = (cur && cur.probes) || {};

  // Named probe failures (fail OPEN — never a pass, never a crash). `reconcile` is a per-venue map,
  // not a single {ok,...} probe, so it is excluded here and walked separately below.
  for (const [name, res] of Object.entries(probes)) {
    if (name === 'reconcile') continue;
    if (!res || res.ok !== true) {
      annotations.push({
        kind: 'probe_failed',
        probe: name,
        detail: (res && res.error) || 'no result',
      });
    }
  }
  for (const venue of VENUES) {
    const res = probes.reconcile && probes.reconcile[venue];
    if (!res || res.ok !== true) {
      annotations.push({
        kind: 'probe_failed',
        venue,
        probe: 'reconcile',
        detail: (res && res.error) || 'no result',
      });
    }
  }

  const curBoot = (cur && cur.bootId) || null;
  if (curBoot === null) {
    annotations.push({ kind: 'probe_failed', probe: 'bootId', detail: 'bootId unresolved' });
  }
  // realDecides is MANDATORY, like bootId above and promAlerts/build below: the generic probe-failure
  // loop only visits keys that EXIST, so an omitted probe would yield neither an alarm nor an
  // annotation and a dead LLM lane would go back to being visible only through the unfiltered
  // `decides` row count — the exact ambiguity this probe exists to remove.
  if (!probes.realDecides) {
    annotations.push({
      kind: 'probe_failed',
      probe: 'realDecides',
      detail: 'no result — genuine model-decide liveness was never read this sweep',
    });
  }
  // promAlerts is MANDATORY, like bootId above: the generic loop only visits keys that EXIST, so an
  // absent probe would yield neither an alarm nor an annotation and the sweep would silently revert to
  // its pre-2026-07-28 blindness — reading as `Alarms (0)` for the one condition that must never read
  // that way. Latent while gather() always assigns it; stated so a second probe-bag producer (a
  // replayed digest, a refactor) cannot reintroduce the incident class by omission.
  if (!probes.promAlerts) {
    annotations.push({
      kind: 'probe_failed',
      probe: 'promAlerts',
      detail: 'no result — prometheus alert state was never read this sweep',
    });
  }
  // latchCause is MANDATORY, like realDecides/promAlerts/build: the generic probe-failure loop only
  // visits keys that EXIST, so an absent probe would silently read as "no known cause, no banner"
  // rather than the classifier crash it actually was — the exact silent-pass shape this pass exists
  // to prevent for its OWN metric (renderMarkdown's '## LLM PROVIDER ACCOUNT UNFUNDED' banner).
  if (!probes.latchCause) {
    annotations.push({
      kind: 'probe_failed',
      probe: 'latchCause',
      detail: 'no result — the agent_client_latch_cause classification was never read this sweep',
    });
  }

  // Provenance-before-interpretation: deltas only survive a matching bootId.
  const prevBoot = (prev && prev.bootId) || null;
  const bootMatches = prev !== null && curBoot !== null && prevBoot === curBoot;
  const curCounters = extractCounters(cur);
  let deltas = null;
  if (prev === null) {
    annotations.push({ kind: 'no_watermark', detail: 'no prior watermark — deltas unavailable' });
  } else if (!bootMatches) {
    annotations.push({ kind: 'boot_changed', detail: 'boot changed — deltas reset' });
  } else {
    deltas = diffCounters(prev.counters, curCounters);
  }

  // Restart storm — from docker RestartCount, never negative (§C.6 provenance).
  if (
    prev !== null &&
    Number.isFinite(cur && cur.restartCount) &&
    Number.isFinite(prev.restartCount)
  ) {
    const restarts = cur.restartCount - prev.restartCount;
    if (restarts > RESTART_STORM_THRESHOLD) {
      alarms.push({
        kind: 'restart_storm',
        detail: `${restarts} restarts since watermark (RestartCount ${prev.restartCount} -> ${cur.restartCount}; boot ${prevBoot} -> ${curBoot})`,
      });
    }
  }

  // State-based alarms — independent of the bootId match (a current-state read, not a window delta).
  const ks = probes.killSwitch;
  if (ks && ks.ok === true && ks.value && ks.value.state && ks.value.state !== 'RUNNING') {
    alarms.push({ kind: 'kill_switch_engaged', detail: `kill_switch_state=${ks.value.state}` });
  }
  // Per-venue: a HALT on either venue's latest reconciliation pass matters on its own — a global
  // "latest row" read would let one venue's fresh CLEAN pass mask the other venue's HALT.
  for (const venue of VENUES) {
    const rec = probes.reconcile && probes.reconcile[venue];
    if (rec && rec.ok === true && rec.value && rec.value.latestResult === 'HALT') {
      alarms.push({
        kind: 'reconcile_halt',
        venue,
        detail: `latest reconciliation result=HALT (${venue})`,
      });
    }
  }
  // Process-wide (the stamp is process-wide by construction — see the constant's comment): has a
  // pass ended actionable-clean recently enough that auto-resume is still armed? A gauge of 0 is the
  // uninitialised default — no pass has stamped since boot — so it is aged from the container's
  // StartedAt rather than paged instantly, giving a fresh boot time to land its first clean pass.
  // Fail OPEN as measurement must: an unreadable gauge or an unparseable StartedAt is a named probe
  // failure, never a silent pass (§C.9 — an unknown stamp age is not "clean").
  const stamp = probes.reconcileCleanStamp;
  if (stamp && stamp.ok === true && stamp.value && Number.isFinite(stamp.value.seconds)) {
    const stampedMs = stamp.value.seconds * 1000;
    const startedMs = Date.parse((cur && cur.startedAt) || '');
    const sinceMs =
      stampedMs > 0
        ? Number.isFinite(nowMs)
          ? nowMs - stampedMs
          : null
        : Number.isFinite(nowMs) && Number.isFinite(startedMs)
          ? nowMs - startedMs
          : null;
    if (sinceMs === null) {
      annotations.push({
        kind: 'probe_failed',
        probe: 'reconcileCleanStamp',
        detail:
          stampedMs > 0
            ? 'sweep wall-clock unavailable — clean-stamp age undetermined, not clean'
            : 'clean stamp never set this boot and container StartedAt unparseable — age undetermined, not clean',
      });
    } else if (sinceMs < 0) {
      // The stamp is written by the CONTAINER's clock and read against the HOST's. Docker Desktop's
      // VM clock drifts across suspend/resume on this host, so a future-dated stamp is reachable —
      // and it would otherwise slip through as healthy (neither null nor over the bound). An
      // incoherent age is undetermined, never clean (§C.9).
      annotations.push({
        kind: 'probe_failed',
        probe: 'reconcileCleanStamp',
        detail: `clean stamp is ${Math.round(-sinceMs / 1000)}s in the FUTURE vs the sweep clock — container/host clock skew, age undetermined, not clean`,
      });
    } else if (sinceMs >= RECONCILE_CLEAN_STAMP_STALE_MS) {
      alarms.push({
        kind: 'reconcile_clean_stamp_stale',
        detail:
          `no actionable-clean reconciliation pass in ${Math.round(sinceMs / 60000)}min ` +
          `(${stampedMs > 0 ? 'last stamp ' + new Date(stampedMs).toISOString() : 'never stamped this boot'}) — ` +
          `kill-switch auto-resume is disarmed while this holds`,
      });
    }
  }
  // Prometheus' own firing alerts. This stack has NO Alertmanager (deliberately) — the loop pass is
  // the alert consumer, so a rule that fires is seen only if the sweep reads it. Every other alarm in
  // this core re-derives ONE condition the core was taught; this one inherits the whole rules file,
  // including rules written after this code.
  //
  // 2026-07-28: AgentClientFatalLatch fired critical at 21:16Z and the collector reported `alarms:[]`
  // for three consecutive hourly digests while the agentic lane made zero LLM calls — the sweep's
  // liveness deltas kept moving because the latched client still journals a decision row per symbol.
  //
  // SEVERITY SPLIT, and why it is not "trust the rule and promote everything". An alarm is not a
  // notification here: playbook §3 makes ANY alarm force a defect investigation and blocks all
  // improvement work until it clears. Measured against this stack's own history at the time of
  // writing, ≥1 rule was firing 58.4% of the last 7 days and 59.2% of the last 24h — dominated by
  // warning-severity rules the program has knowingly been running through for weeks
  // (ReconciliationMismatch 1135 of 1440 min; AgenticReflectionNeverMinted 4084 min/7d, sticky by a
  // 24h max_over_time). Promoting those would have wedged the loop on roughly six passes in ten,
  // burying the one critical signal this change exists to surface. `info` is worse than useless as an
  // alarm: EffectiveModeLive is severity info and fires permanently once live trading is armed, by
  // design. So critical BLOCKS and everything else ANNOTATES — still in the digest, still read by the
  // pass, just not a gate. Raising a warning to blocking is a one-line severity edit in
  // observability/alerts.rules.yml, which is where that judgement belongs.
  //
  // Fails OPEN as measurement must: an unreadable, stale, unhealthy or non-evaluating rules API is
  // the generic `probe_failed` annotation above (never a silent pass) — see parsePromRules.
  const promAlerts = probes.promAlerts;
  if (promAlerts && promAlerts.ok === true && promAlerts.value) {
    for (const a of promAlerts.value.firing || []) {
      const detail =
        `${a.alertname}${a.scope ? `{${a.scope}}` : ''} (${a.severity}) ` +
        `firing since ${a.activeAt ?? 'unknown'}` +
        `${a.summary ? ` — ${a.summary}` : ''}`;
      if (a.severity === 'critical') {
        alarms.push({ kind: 'prometheus_alert_firing', detail });
      } else {
        annotations.push({ kind: 'prometheus_alert_firing_nonblocking', detail });
      }
    }
  }

  // ...and the same rules file read BACKWARDS, over ALERT_LOOKBACK_MS. The probe above answers "what
  // is firing right now", which is the wrong question for a consumer that samples 3x/day: an alert
  // that fires and resolves inside the ~8h gap between passes is invisible to every pass, forever.
  //
  // Measured, not hypothetical (2026-07-28, the pass that added this): a 49-minute demo-fapi outage
  // (09:22-10:11Z, 502s from the venue's own nginx) broke 293 perp fill polls and 47 trade-axis
  // reconcile sweeps and fired both ReconciliationSweepFailureSustained and ReconciliationMismatch.
  // By the 16:07Z pass both had resolved, and that pass's sweep named the outage NOWHERE — one alarm,
  // for an unrelated latch. The warn-log tail could not cover it either (see log_window_short below).
  //
  // ANNOTATION-ONLY, and that is a design decision rather than timidity. A fixed lookback makes any
  // derived alarm STICKY for the whole window, while playbook §3 makes an alarm block all improvement
  // work until it CLEARS — and an incident that is already over can never clear. Promoting these would
  // wedge the loop for 12h after every blip, which is the same failure mode the severity split above
  // exists to avoid. The live read stays the only alarm gate; this one exists to make history visible,
  // not to gate on it. Resolved CRITICALs get their own annotation kind so a pass cannot skim past one.
  //
  // Trusted ONLY when the live rules probe passed in the SAME sweep: an empty ALERTS window is
  // indistinguishable from a Prometheus serving zero rules (§C.9 negative-read void), and the three
  // positive controls that refuse that reading live in parsePromRules. No control, no evidence.
  //
  // Mandatory like promAlerts above, and for the same reason: the generic probe-failure loop only
  // visits keys that EXIST, so an absent probe would produce neither an alarm nor an annotation and the
  // sweep would silently revert to reading only the present tense — the exact blindness this block was
  // added to remove, reading as a clean digest.
  const alertsSince = probes.promAlertsSince;
  if (!alertsSince) {
    annotations.push({
      kind: 'probe_failed',
      probe: 'promAlertsSince',
      detail: 'no result — prometheus alert HISTORY was never read this sweep',
    });
  }
  if (alertsSince && alertsSince.ok === true && alertsSince.value) {
    // The live rules probe proves rules are loaded, healthy and evaluating NOW. That is a present-tense
    // control on a retrospective claim, so it is necessary but NOT sufficient: if Prometheus itself was
    // down, restarted, or host-slept inside the window it wrote no ALERTS samples for that stretch, and
    // "nothing fired" would be a void read wearing a passing control. Reachable through this sweep's own
    // prescribed remediation — parsePromRules tells the operator to RECREATE the prometheus container on
    // a stale rules file, and the recreate that fixes the live probe is itself a hole in the history.
    // So scrape coverage is checked as a second, retrospective control (see promCoverage in the runner).
    //
    // A coverage shortfall does NOT discard the alerts found: anything present in the window genuinely
    // fired, and positive evidence survives a partial window. It is the NEGATIVE that weakens, so the
    // shortfall is annotated alongside whatever was found and an empty list stops reading as clean.
    const coverage = probes.promCoverage;
    if (!(promAlerts && promAlerts.ok === true)) {
      annotations.push({
        kind: 'probe_voided',
        probe: 'promAlertsSince',
        detail:
          'alert history read is VOID this sweep — the live rules probe failed, so an empty or ' +
          'partial window carries no positive control (an unloaded rules file reads identically)',
      });
    } else {
      if (!coverage || coverage.ok !== true || !coverage.value) {
        annotations.push({
          kind: 'alert_window_unverified',
          probe: 'promCoverage',
          detail:
            `scrape coverage over the ${ALERT_LOOKBACK_MS / 3_600_000}h alert window could not be ` +
            'read, so an empty history is NOT evidence of a quiet window — only what it DID find is',
        });
      } else if (coverage.value.ratio < ALERT_COVERAGE_MIN_RATIO) {
        annotations.push({
          kind: 'alert_window_partial',
          probe: 'promCoverage',
          detail:
            `prometheus scraped only ${(coverage.value.ratio * 100).toFixed(0)}% of the ` +
            `${ALERT_LOOKBACK_MS / 3_600_000}h alert window (${coverage.value.samples} of ~` +
            `${coverage.value.expected} samples) — it was down, restarted or host-slept for the rest, ` +
            'so alerts that fired in the gap left no ALERTS samples and cannot appear below',
        });
      }
      for (const a of alertsSince.value.resolved || []) {
        const detail =
          `${a.alertname} (${a.severity}) fired and RESOLVED within the last ` +
          `${ALERT_LOOKBACK_MS / 3_600_000}h — ${a.samples} firing sample(s); it is not firing now, ` +
          `so nothing above will show it`;
        annotations.push({
          kind:
            a.severity === 'critical'
              ? 'prometheus_alert_resolved_critical'
              : 'prometheus_alert_resolved',
          detail,
        });
      }
    }
  }

  // ── what the retired collector daemon used to scrape from outside, now emitted by the app ────────
  // Host duty cycle. The daemon read `pmset -g ps` / `sysctl kern.boottime` / `uptime` — host facts,
  // from a process that was never the one suspended, and unavailable to anything running in a Linux
  // container. app_suspend_events_total is the same question asked from inside: wall-clock advance
  // minus monotonic advance across one 5s tick, which across a Docker-VM freeze IS the freeze.
  // Annotation, never an alarm: a sleeping laptop is this stack's documented duty cycle, and the
  // reason to surface it is to stop a pass blaming counters for a gap the host caused (§D host-state).
  const suspends = probes.suspends;
  if (suspends && suspends.ok === true && suspends.value && suspends.value.count > 0) {
    const skew = suspends.value.maxSkewSeconds;
    annotations.push({
      kind: 'app_suspended',
      probe: 'suspends',
      detail:
        `the app process was frozen ${Math.round(suspends.value.count)} time(s) in the last ` +
        `${ALERT_LOOKBACK_MS / 3_600_000}h` +
        `${Number.isFinite(skew) ? `, longest ${(skew / 60).toFixed(0)}min` : ''} — ` +
        'counter gaps across that window are host duty cycle, not necessarily a defect',
    });
  }

  // Error/warn volume, from the counter rather than the log tail. This is the DURABLE half: it covers
  // the full lookback and survives the container recreate that deletes the json-file log outright,
  // which is what let a 49-minute venue outage reach a pass with no trace at all (2026-07-29). Zero is
  // a real, trustworthy read here — log-event-metrics.ts materialises the warn/error/fatal children at
  // 0, so a quiet app exports actual zeros instead of the empty vector that would be a §C.9 void.
  //
  // The probe carries two readings that fail in opposite directions (see its own comment in the
  // runner): the windowed one undercounts a message class first seen inside the window, the
  // since-boot one is exact but blind before the last restart. Taking the MAX is the only
  // non-guessing reduction — whichever is larger is a count that genuinely occurred, so the
  // annotation can never over-report, and it can only under-report the case where both readings are
  // individually blind to different halves of the window.
  const logEvents = probes.logEvents;
  if (logEvents && logEvents.ok === true && logEvents.value) {
    const errorsIn = (m) => ((m || {}).error || 0) + ((m || {}).fatal || 0);
    const windowErrors = errorsIn(logEvents.value.byLevelWindow);
    const bootErrors = errorsIn(logEvents.value.byLevelBoot);
    const errors = Math.max(windowErrors, bootErrors);
    if (errors > 0) {
      const top = (logEvents.value.top || [])
        .filter((t) => t.level === 'error' || t.level === 'fatal')
        .slice(0, 3)
        .map((t) => `${Math.round(t.count)}x ${t.event}`)
        .join(', ');
      annotations.push({
        kind: 'log_errors_in_window',
        probe: 'logEvents',
        detail:
          `${Math.round(errors)} error/fatal log line(s) ` +
          `(${Math.round(windowErrors)} over the ${ALERT_LOOKBACK_MS / 3_600_000}h window, ` +
          `${Math.round(bootErrors)} since this boot)${top ? ` — ${top}` : ''}`,
      });
    }
  }

  // Deploy provenance — which commit the RUNNING image was built from, the third thing the retired
  // daemon stamped (it read the working tree, which is not what is deployed). Same defect class as the
  // reconciliations audit columns whose only writer supplied a literal, and prom-client's
  // never-incremented labeled counter: a constant supplied by the sole writer is indistinguishable from
  // a measurement at every query, forever. So 'unknown', empty and absent are all VOID (§C.9), never a
  // value.
  //
  // Annotation, never an alarm, and that is the failure direction on purpose: playbook §3 makes any
  // named alarm block all improvement work until it clears, and this is a measurement/veto-only gate —
  // a broken measurement must never block the thing it measures, which here is the deploy itself.
  //
  // Mandatory like promAlerts and promAlertsSince above, and for the same reason: the generic
  // probe-failure loop only visits keys that EXIST, so an absent probe would yield neither an alarm
  // nor an annotation — and since the collector daemon was retired, build_info is the loop's ONLY
  // between-pass memory of which image served the window.
  const build = probes.build;
  if (!build) {
    annotations.push({
      kind: 'probe_failed',
      probe: 'build',
      detail: 'no result — deploy provenance was never read this sweep',
    });
  }
  // An `ok:true` probe carrying no value at all is a non-reading by the same definition, and takes
  // the same VOID path the runner's digest cell gives it — the two used to disagree on exactly that
  // shape, which is what exporting one predicate was for.
  const raw = build && build.value ? build.value.gitSha : null;
  if (build && build.ok === true && isBuildProvenanceVoid(raw)) {
    annotations.push({
      kind: 'build_provenance_void',
      probe: 'build',
      detail:
        `build_info carries ${raw === null || raw === undefined ? 'no git_sha label' : `git_sha="${raw}"`} — ` +
        'the image was built without the GIT_SHA build arg, so which commit served this window is ' +
        'UNRECORDED, not read-as-unknown. Redeploy with ' +
        'GIT_SHA=$(git rev-parse --short HEAD) docker compose up -d --build app',
    });
  }

  // The warn-log scan is a fixed LINE tail, so the time it covers is whatever the log rate makes it —
  // at this stack's rate 3000 lines was under 2h, far short of the inter-pass gap. That is not a bug in
  // the tail so much as a fact a pass must be told, because a short window turns "no warnings" into a
  // §C.9 negative-read void rather than evidence. Disclosed whenever the window is narrower than the
  // alert lookback the pass reasons over. errorScan lives under probes (adversarial review,
  // 2026-07-30 — see gather()'s own comment): reading it there means a scan FAILURE also flows
  // through the generic probe_failed loop above, rather than being a sibling field invisible to it.
  const scan = probes.errorScan;
  if (scan && scan.ok === true && scan.value) {
    if (!Number.isFinite(scan.value.oldestMs)) {
      // No parseable timestamp in the whole tail — reachable via NOOP_LOGGER, a non-pino log format, or
      // an empty tail after rotation. A warn count over a window of UNKNOWN depth is the §C.9 negative
      // read verbatim, and staying silent here would be strictly worse than the short window below:
      // the digest would print a confident `warn+ lines: 0` with nothing to qualify it.
      annotations.push({
        kind: 'log_window_unknown',
        detail:
          `warn scan returned ${scan.value.lines ?? 0} parseable line(s) and no usable timestamp, so ` +
          'the window it covers is unknown — its warn count is not evidence about any span',
      });
    } else {
      // Span on ONE clock. oldestMs/newestMs are the CONTAINER's pino clock while nowMs is the host's,
      // and this host's Docker VM clock drifts across suspend/resume (see the reconcile-stamp skew guard
      // above). Mixing them let a lagging container clock inflate the span and SUPPRESS the disclosure —
      // fail-closed on a host with a documented sleep duty cycle. Tail staleness is a separate fact and
      // is reported separately rather than folded into the span.
      const spanMs = scan.value.newestMs - scan.value.oldestMs;
      // A tail that reaches the container's own start is COMPLETE, however few hours that spans — there
      // are no older lines to have missed. Without this the annotation would fire on every sweep for the
      // first 12h after any redeploy and say "warnings are UNREAD" when the window is in fact total,
      // which is the same overstatement-of-blindness this whole change exists to remove.
      //
      // ABSOLUTE distance, not signed: docker does not truncate the json-file log when a container
      // restarts in place, so a tail can reach lines OLDER than StartedAt. A signed `<=` treated every
      // such tail as reaching boot and silently suppressed the disclosure — worst exactly after a restart
      // storm, when the unread window is both largest and most likely to hold the cause.
      const startedMs = Date.parse(cur.startedAt || '');
      const reachesBoot =
        Number.isFinite(startedMs) &&
        Math.abs(scan.value.oldestMs - startedMs) <= LOG_BOOT_REACH_MS;
      if (Number.isFinite(spanMs) && spanMs < ALERT_LOOKBACK_MS && !reachesBoot) {
        annotations.push({
          kind: 'log_window_short',
          detail:
            `warn scan covers only ${(spanMs / 3_600_000).toFixed(1)}h ` +
            `(${scan.value.lines} lines parsed from a ${scan.value.scanned}-line tail request) vs the ` +
            `${ALERT_LOOKBACK_MS / 3_600_000}h alert lookback — warnings older than that are UNREAD, ` +
            'not absent',
        });
      }
    }
  }

  const cost = probes.cost;
  if (cost && cost.ok === true && cost.value && Number.isFinite(cost.value.spendUsd)) {
    // Epsilon guard: 0.8 * 3 has an IEEE754 remainder that would silently swallow the exact-80%
    // boundary case a fixed-price breaker configuration lands on routinely.
    const overProximity =
      cost.value.spendUsd >= COST_PROXIMITY_RATIO * AGENTIC_DAILY_COST_BREAKER_USD - 1e-9;
    // The uninitialised-gauge reading (see BUDGET_GAUGE_INIT_GRACE_MS): remaining exactly 0 on a
    // container too young to have evaluated its budget yet.
    const startedMsForBudget = Date.parse((cur && cur.startedAt) || '');
    const bootAgeMs =
      Number.isFinite(nowMs) && Number.isFinite(startedMsForBudget)
        ? nowMs - startedMsForBudget
        : null;
    const gaugeLooksUninitialised =
      cost.value.remainingUsd === 0 &&
      bootAgeMs !== null &&
      bootAgeMs >= 0 &&
      bootAgeMs < BUDGET_GAUGE_INIT_GRACE_MS;
    if (overProximity && gaugeLooksUninitialised) {
      annotations.push({
        kind: 'budget_gauge_uninitialised',
        probe: 'cost',
        detail:
          `agentic_budget_remaining_usd reads 0 on a container ${Math.round(bootAgeMs / 1000)}s old ` +
          `(under the ${BUDGET_GAUGE_INIT_GRACE_MS / 60000}min init grace) — the gauge is only set once the lane ` +
          `evaluates its budget, so this is not evidence of spend; re-read after the first decide`,
      });
    } else if (overProximity) {
      alarms.push({
        kind: 'cost_breaker_proximity',
        detail: `spend $${cost.value.spendUsd} >= ${COST_PROXIMITY_RATIO * 100}% of $${AGENTIC_DAILY_COST_BREAKER_USD} daily breaker`,
      });
    }
  }

  // Delta-based alarms — only meaningful with a matching boot AND a proven-healthy container (the
  // positive control: §C.1 zero-delta-while-green demands independent liveness deltas, not a green
  // enum) AND an inter-sweep window long enough for silence to be abnormal (LIVENESS_MIN_ELAPSED_MS;
  // unknown elapsed does not suppress — see the constant's comment).
  const intervalTooShort = Number.isFinite(elapsedMs) && elapsedMs < LIVENESS_MIN_ELAPSED_MS;
  if (deltas !== null && cur && cur.containerHealthy === true && !intervalTooShort) {
    if (deltas.decides === 0 && (deltas.consultGate === 0 || deltas.consultGate === null)) {
      alarms.push({
        kind: 'zero_decides',
        detail:
          'decide + consult-gate liveness counters unchanged since watermark while container healthy',
      });
    }
    // ANNOTATION, deliberately never an alarm — the exact shape `decides` above cannot see: the
    // scheduler keeps ticking (deltas.decides may be well above 0, e.g. the observed 160/hour of
    // scheduled-skip rows) while the model has answered zero times this window. Not promoted for the
    // reason argued at length beside AGENTIC_DAILY_COST_BREAKER_USD and prometheus_alert_firing above:
    // playbook §3 makes ANY alarm block all improvement work until it clears, this account has been
    // unfunded since 2026-07-27T21:16Z with no owner-set recovery date, and the condition is already
    // paged twice over — AgentClientFatalLatch (critical, Prometheus) and
    // AgenticNoSuccessfulDecideSustained (warning, backed by the same agent_last_success_timestamp_
    // seconds gauge lastSuccessfulDecideAt seeds). A third, sweep-native alarm on the same dead
    // account would only add a second permanent wedge, never new information — so this fails toward
    // disclosure (visible every pass, for exactly as long as it is true) rather than toward blocking
    // the improvement work it measures.
    if (Number.isFinite(deltas.realDecides) && deltas.realDecides === 0) {
      annotations.push({
        kind: 'no_real_decides_in_window',
        probe: 'realDecides',
        detail:
          `0 accepted decides (prompt_hash+latency_ms set, non-replay, no post-200 degrade tag) since ` +
          `watermark while the raw agent_decisions row count moved by Δ${deltas.decides ?? 'n/a'} — ` +
          'scheduled-skip and error rows advance that counter with no model call at all, and a ' +
          'schema-rejected row makes a call that yields nothing, so neither is evidence of a live LLM lane',
      });
    }
    for (const venue of VENUES) {
      if (deltas.reconcileByVenue[venue] === 0) {
        alarms.push({
          kind: 'journal_silence',
          venue,
          detail: `reconciliations journal produced no new rows for ${venue} since watermark while container healthy`,
        });
      }
    }
  } else if (deltas !== null && cur && cur.containerHealthy === true && intervalTooShort) {
    annotations.push({
      kind: 'short_interval',
      detail: `sweep gap ${Math.round(elapsedMs / 1000)}s < ${LIVENESS_MIN_ELAPSED_MS / 60000}min liveness floor — delta-starvation alarms suppressed this sweep`,
    });
  }

  // Negative-read void (§C.9): a durable counter reads exactly 0 while a SIBLING counter returned data
  // (the positive control proving the stack answers), so the empty read is voided, not trusted as quiet.
  if (cur && cur.containerHealthy === true) {
    const scalarReads = ['decides', 'fills']
      .map((k) => [k, curCounters[k]])
      .filter(([, v]) => Number.isFinite(v));
    const reconcileReads = VENUES.map((venue) => [
      venue,
      curCounters.reconcileByVenue[venue],
    ]).filter(([, v]) => Number.isFinite(v));
    const anyPositive = scalarReads.some(([, v]) => v > 0) || reconcileReads.some(([, v]) => v > 0);
    if (anyPositive) {
      for (const [key, v] of scalarReads) {
        if (v === 0 && DURABLE_COUNTERS.has(key)) {
          annotations.push({
            kind: 'negative_read_void',
            probe: key,
            detail: `${key}=0 while sibling counters returned data and container healthy — empty read voided, not a pass`,
          });
        }
      }
      for (const [venue, v] of reconcileReads) {
        if (v === 0) {
          annotations.push({
            kind: 'negative_read_void',
            venue,
            probe: 'reconcile',
            detail: `reconcile=0 for ${venue} while sibling counters returned data and container healthy — empty read voided, not a pass`,
          });
        }
      }
    }
  }

  return { deltas, alarms, annotations };
}

export function computeSweep({ prev, cur }) {
  const alarms = [];
  const annotations = [];

  // Host-state gap opens the digest (§D): a sweep gap wider than 2x the design cadence is the
  // sleep/wake window, quantified as an annotation before any counter is blamed — never an alarm.
  if (prev && Number.isFinite(prev.sweptAtMs) && cur && Number.isFinite(cur.sweptAtMs)) {
    const gapMs = cur.sweptAtMs - prev.sweptAtMs;
    if (gapMs > HOST_SLEEP_GAP_FACTOR * EXPECTED_SWEEP_INTERVAL_MS) {
      annotations.push({
        kind: 'host_sleep_suspected',
        detail: `sweep gap ${(gapMs / 3_600_000).toFixed(1)}h > ${HOST_SLEEP_GAP_FACTOR}x expected ${EXPECTED_SWEEP_INTERVAL_MS / 3_600_000}h — check host duty cycle before blaming counters`,
      });
    }
  } else if (!prev) {
    annotations.push({ kind: 'no_watermark', detail: 'first sweep — deltas unavailable' });
  }

  const elapsedMs =
    prev && Number.isFinite(prev.sweptAtMs) && cur && Number.isFinite(cur.sweptAtMs)
      ? cur.sweptAtMs - prev.sweptAtMs
      : null;

  // No `no_app` annotation here when cur.app is absent — the runner (loop-sweep.mjs) owns that
  // annotation because only it can say WHY (docker ps failure vs. container genuinely not running).
  const app = (cur && cur.app) || null;
  let deltas = null;
  if (app) {
    const prevApp = (prev && prev.app) || null;
    const result = computeApp(prevApp, app, elapsedMs, cur && cur.sweptAtMs);
    deltas = result.deltas;
    alarms.push(...result.alarms);
    annotations.push(...result.annotations);
  }

  return { deltas, alarms, annotations };
}

// ── pass-record audit: did every sweep that ran leave a pass entry behind? ────────────────────────
// Written for the Pass 48 finding (2026-07-30), which recorded the defect and explicitly did not fix
// it: three sweeps on 2026-07-29 (16:07Z scheduled, 19:33Z, 19:46Z) left NO entry in
// research/loop/LOG.md at all, and nothing noticed — "the loop has no detector for its own unrecorded
// passes". A sweep that ran with no pass entry is indistinguishable from a pass that never ran, so
// the loop cannot audit its own cadence from its own artifacts, which is the one thing the artifacts
// exist for.
//
// FAIL DIRECTION — fails OPEN, and never into a false clean. This is a measurement/reporting probe:
// an unreadable LOG.md, an unlistable digests dir, or a name this parser cannot read must never throw
// and must never become an ALARM (playbook §3 makes any named alarm block the pass's improvement
// work, and a broken measurement must not block the thing it measures). The other half is the trap
// this repo keeps re-hitting — a fail-open that reads as "clean" because it emits nothing, and an
// absence a reader scores as zero. So every cannot-determine path emits `pass_record_audit_
// undetermined` verbatim, exactly the split `log_window_unknown` / `log_window_short` already draw
// between "no reading" and "a reading of zero". Silence from this check means CLEAN and only clean,
// because each way it can fail to run is loud.

// The hourly collector daemon drove runSweep() IN-PROCESS, so every digest it left is a daemon tick
// with no pass behind it — visible as the :24:29 hourly cadence across ~200 files, ending at
// sweep-2026-07-29T08-24-29-554Z.json. Judging those as passes would report ~14 "unrecorded passes"
// per pre-retirement day, forever, which is the cry-wolf that makes a detector get ignored. The
// daemon was retired 2026-07-29 (see ALERT_LOOKBACK_MS's comment); this floor is inert the moment
// LOG.md's rotation window advances past it, since the audit floor is the LATER of the two.
export const COLLECTOR_DAEMON_RETIRED_AT_MS = Date.parse('2026-07-29T09:00:00Z');

// A pass writes its `**Window:**` line before its closing gate/deploy/soak steps, so the pass's own
// last sweep can land minutes after the end it claimed. Without slack the detector's loudest false
// positive would be accusing the very pass that recorded itself. 30 min covers a gate+deploy tail and
// stays far short of the 4.9h gap that made this check necessary.
export const PASS_WINDOW_END_TOLERANCE_MS = 30 * 60 * 1000;

const DIGEST_NAME_RE = /^sweep-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/;

// The runner mints the digest name as `sweep-${sweptIso.replace(/[:.]/g, '-')}.json`; this inverts
// exactly that transform. Reading the stamp off the NAME rather than opening ~200 JSON files is not
// an optimisation only — a digest whose body is truncated or mid-write still has a readable name, and
// the name is what the writer guarantees.
export function parseDigestStampMs(name) {
  const m = DIGEST_NAME_RE.exec(String(name ?? ''));
  if (!m) return null;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`);
  return Number.isFinite(ms) ? ms : null;
}

// LOG.md's own conventions, read off the file rather than assumed: one `## <date> — Pass <n> (title)`
// heading per pass, where <date> is `2026-07-29` or the two-day `2026-07-28/29`, and the first
// `**Window:**` line under it carries the span. Sub-headings are `###` and never match.
const PASS_HEADING_RE = /^##\s+(\d{4}-\d{2}-\d{2})(?:\/\d{1,2})?\s+—\s+Pass\s+(\d+)\b/;
const WINDOW_LINE_RE = /^\*\*Window:\*\*\s*(.+)$/;
// Both stamp shapes the retained entries actually use — fully qualified, or bare `HH:MMZ` inheriting
// the date to its left. ANCHORED on purpose: an unanchored match would happily lift a time out of the
// prose that trails the window on the same line and call it the pass boundary.
const WINDOW_ABS_STAMP_RE = /^\s*(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})Z/;
const WINDOW_TIME_ONLY_RE = /^\s*(\d{2}):(\d{2})Z/;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseWindowSide(text, defaultDate) {
  const abs = WINDOW_ABS_STAMP_RE.exec(text);
  if (abs) {
    const ms = Date.parse(`${abs[1]}T${abs[2]}:${abs[3]}:00Z`);
    return Number.isFinite(ms) ? ms : null;
  }
  const rel = WINDOW_TIME_ONLY_RE.exec(text);
  if (!rel) return null;
  const ms = Date.parse(`${defaultDate}T${rel[1]}:${rel[2]}:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

// Either both bounds parse or the entry counts as UNPARSED — a half-read window would silently shrink
// a pass's coverage and manufacture the exact false accusation this detector must not make. Ends that
// are prose ('→ in progress', archived Pass 43) take that path by construction.
function parsePassWindow(raw, headingDate) {
  const sides = String(raw).split('→');
  if (sides.length < 2) return { startMs: null, endMs: null };
  const startMs = parseWindowSide(sides[0], headingDate);
  if (!Number.isFinite(startMs)) return { startMs: null, endMs: null };
  const startDate = new Date(startMs).toISOString().slice(0, 10);
  let endMs = parseWindowSide(sides[1], startDate);
  if (!Number.isFinite(endMs)) return { startMs: null, endMs: null };
  // A bare end time earlier than the start is the next calendar day — the overnight pass the
  // `## 2026-07-28/29 — Pass 45` heading shape exists for (16:07Z → 07:00Z).
  if (endMs < startMs) endMs += DAY_MS;
  return { startMs, endMs };
}

export function parseLogPassEntries(logText) {
  if (typeof logText !== 'string') return [];
  const entries = [];
  let cur = null;
  for (const line of logText.split('\n')) {
    const heading = PASS_HEADING_RE.exec(line);
    if (heading) {
      cur = {
        heading: line.trim(),
        pass: Number(heading[2]),
        date: heading[1],
        window: null,
        startMs: null,
        endMs: null,
      };
      entries.push(cur);
      continue;
    }
    if (!cur || cur.window !== null) continue;
    const window = WINDOW_LINE_RE.exec(line);
    if (!window) continue;
    cur.window = window[1].trim();
    const span = parsePassWindow(window[1], cur.date);
    cur.startMs = span.startMs;
    cur.endMs = span.endMs;
  }
  return entries;
}

// Every count is zero here on purpose: an undetermined audit evaluated nothing, and reporting a
// partial tally next to a verdict that does not exist is the same "absence reads as a reading" defect
// the annotation is written to prevent.
function undeterminedResult(reasons) {
  return {
    status: 'undetermined',
    unrecorded: [],
    evaluated: 0,
    skippedBeforeFloor: 0,
    pendingAfterLastEntry: 0,
    unreadableNames: 0,
    annotations: [
      {
        kind: 'pass_record_audit_undetermined',
        detail:
          `sweeps could not be audited against LOG.md pass entries: ${reasons.join('; ')} — this is ` +
          'NOT a clean result, it is no reading at all',
      },
    ],
  };
}

// digestNames: the bare filenames under research/loop/digests/ (the runner readdir's them; this stays
// I/O-free). logText: the LOG.md contents, or null when the read failed.
export function classifyUnrecordedSweeps({ digestNames, logText }) {
  if (typeof logText !== 'string' || logText.trim() === '') {
    return undeterminedResult(['research/loop/LOG.md was unreadable or empty']);
  }
  if (!Array.isArray(digestNames)) {
    return undeterminedResult(['the research/loop/digests/ directory could not be listed']);
  }

  const entries = parseLogPassEntries(logText);
  if (entries.length === 0) {
    return undeterminedResult([
      'no `## <date> — Pass <n>` entries parsed out of LOG.md (heading convention changed?)',
    ]);
  }
  // One unparseable window blanks the WHOLE verdict rather than just its own entry: every gap between
  // the entries that did parse could be the span this one covers, so no gap is attributable while it
  // is unknown. Suppressing the verdict here is the fail-open direction — a false "unrecorded pass"
  // sends a pass hunting a record that exists.
  const unparsed = entries.filter((e) => !Number.isFinite(e.startMs) || !Number.isFinite(e.endMs));
  if (unparsed.length > 0) {
    return undeterminedResult([
      `${unparsed.length} of ${entries.length} retained pass entr${unparsed.length === 1 ? 'y has' : 'ies have'} ` +
        `an unreadable **Window:** line (${unparsed.map((e) => `Pass ${e.pass}`).join(', ')}), so no ` +
        'gap between the others can be attributed',
    ]);
  }

  // Floor: below it a digest is not this check's business — either it predates the retained LOG window
  // (its pass entry rotated VERBATIM into research/loop/archive/, which this check does not read, so
  // an absence there is expected and means nothing) or it predates the collector daemon's retirement.
  const oldestEntryStartMs = Math.min(...entries.map((e) => e.startMs));
  const floorMs = Math.max(oldestEntryStartMs, COLLECTOR_DAEMON_RETIRED_AT_MS);
  // Ceiling: a pass writes its entry at the END of the pass, so every sweep after the newest recorded
  // entry may belong to the pass running right now — including this very sweep. Judging them would
  // accuse the in-flight pass on every single run. Deriving the ceiling from the data rather than from
  // a fixed grace period is what lets the check stay quiet during a 15h pass (Pass 45) and still name
  // a gap the moment a LATER pass records itself.
  const newestEntryEndMs = Math.max(...entries.map((e) => e.endMs)) + PASS_WINDOW_END_TOLERANCE_MS;

  const unrecorded = [];
  let evaluated = 0;
  let skippedBeforeFloor = 0;
  let pendingAfterLastEntry = 0;
  let unreadableNames = 0;
  for (const name of digestNames) {
    // The digests dir is not exclusively sweep digests — it also holds the watermark, the retired
    // daemon's per-day .jsonl/.md rollups and its log. Those are not this check's input at all, so
    // they are passed over silently; only a name that CLAIMS to be a sweep digest and still will not
    // parse is a hole worth disclosing.
    if (!String(name).startsWith('sweep-')) continue;
    const ms = parseDigestStampMs(name);
    if (ms === null) {
      unreadableNames += 1;
      continue;
    }
    if (ms < floorMs) {
      skippedBeforeFloor += 1;
      continue;
    }
    if (ms > newestEntryEndMs) {
      pendingAfterLastEntry += 1;
      continue;
    }
    evaluated += 1;
    const covered = entries.some(
      (e) => ms >= e.startMs && ms <= e.endMs + PASS_WINDOW_END_TOLERANCE_MS,
    );
    if (!covered) unrecorded.push({ name, sweptAtMs: ms, sweptIso: new Date(ms).toISOString() });
  }
  unrecorded.sort((a, b) => a.sweptAtMs - b.sweptAtMs);

  const annotations = [];
  // A name this parser cannot read is a hole in the audit's INPUT, not a verdict — it is disclosed
  // alongside whatever verdict the readable names support, never instead of it.
  if (unreadableNames > 0) {
    annotations.push({
      kind: 'pass_record_audit_undetermined',
      detail:
        `${unreadableNames} file(s) under research/loop/digests/ do not carry a readable sweep ` +
        'stamp in their name and were not audited — the verdict below covers the rest only',
    });
  }
  if (unrecorded.length > 0) {
    const shown = unrecorded.slice(0, 8).map((u) => u.sweptIso);
    const more = unrecorded.length - shown.length;
    annotations.push({
      kind: 'sweeps_unrecorded_in_log',
      detail:
        `${unrecorded.length} sweep(s) ran with no LOG.md pass entry covering them: ` +
        `${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''} — a sweep that left no pass entry ` +
        'is indistinguishable from a pass that never ran, so the cadence cannot be audited until ' +
        'each is written up or explained (Pass 48 finding, 2026-07-30)',
    });
  }

  return {
    status: unrecorded.length > 0 ? 'unrecorded' : 'clean',
    unrecorded,
    evaluated,
    skippedBeforeFloor,
    pendingAfterLastEntry,
    unreadableNames,
    annotations,
  };
}
