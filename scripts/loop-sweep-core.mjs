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
    consultGate: val(p.consultGate, 'total'),
    fills: val(p.fills, 'count'),
    reconcileByVenue,
    wsRecreations: val(p.wsRecreations, 'count'),
    rssBytes: val(p.rss, 'bytes'),
  };
}

const SCALAR_COUNTER_KEYS = ['decides', 'consultGate', 'fills', 'wsRecreations', 'rssBytes'];

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

  const cost = probes.cost;
  if (cost && cost.ok === true && cost.value && Number.isFinite(cost.value.spendUsd)) {
    // Epsilon guard: 0.8 * 3 has an IEEE754 remainder that would silently swallow the exact-80%
    // boundary case a fixed-price breaker configuration lands on routinely.
    if (cost.value.spendUsd >= COST_PROXIMITY_RATIO * AGENTIC_DAILY_COST_BREAKER_USD - 1e-9) {
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
