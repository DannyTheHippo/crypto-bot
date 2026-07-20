#!/usr/bin/env node
// Y2 deterministic health-sweep — PURE logic. No I/O, no clock, no process/env access: given a prior
// watermark and this pass's probe results, derive the counter deltas, the fired alarms, and the
// advisory annotations. Every §C defect-class check (loop-mechanism-learnings-2026-07.md) that a
// single pass can evaluate deterministically lives here so it is unit-testable off a fixture; the
// runner (loop-sweep.mjs) only gathers probes and renders the result.
//
// Contract:
//   computeSweep({ prev, cur }) -> { deltas, alarms, annotations }
//     prev : the prior watermark object, or null on the first-ever sweep.
//     cur  : this pass's gathered probes (see the shape notes on gatherLane in loop-sweep.mjs).
// Provenance-before-interpretation (§C.6, §D): counter deltas are computed ONLY when the current
// bootId matches the watermark's bootId — a restart resets process counters, so a cross-boot "delta"
// is meaningless and would fabricate negatives. A bootId mismatch yields the verbatim annotation
// 'boot changed — deltas reset' and null deltas, never a negative number.
// Measurement fails OPEN (§D): a failed probe (ok:false) becomes a named `probe_failed` annotation,
// never a pass and never a throw — a partial digest with failures named beats a confident blank.

// 3x-daily discrete-pass cadence (§A): the design inter-pass gap. A wider gap is the host-sleep
// window, the highest-risk edge (§D host-state), so it opens the digest as an annotation, not an alarm.
export const EXPECTED_SWEEP_INTERVAL_MS = 8 * 60 * 60 * 1000;
export const HOST_SLEEP_GAP_FACTOR = 2;

// Cost-breaker proximity (§C.8 attempt-level fail-open budget gate): warn at 80% of the per-lane
// daily USD stop so a runaway is flagged BEFORE the pool zeroes and starves the lane.
export const COST_PROXIMITY_RATIO = 0.8;

// Delta-starvation alarms (zero_decides, journal_silence) fire only when the inter-sweep window is
// long enough that silence is actually abnormal: two sweeps minutes apart legitimately share the
// same counters (observed 2026-07-20 — back-to-back acceptance runs tripped zero_decides on a
// 3-minute gap). 30 min = two 15m bars, the smallest window in which a healthy lane MUST have
// journaled something. An UNKNOWN elapsed (malformed watermark) does not suppress — conservative
// toward detection, matching the alarms' veto-only fail direction.
export const LIVENESS_MIN_ELAPSED_MS = 30 * 60 * 1000;

// Per-lane daily USD cost breaker — verified 2026-07-20 against AGENTIC_DAILY_COST_STOP_USD in
// .env.app (1.50, spot) and .env.app-perp (1.50, perp — raised 0.75->1.50 by X2 stage-1 the same
// day this tool first verified it; caught by the Y4 doc rewrite's three-ledger check). Re-verify
// against those keys before trusting
// this constant (§D verify-before-cite: the stale "$5/day breaker" is the cautionary precedent).
export const COST_BREAKER_USD = { spot: 1.5, perp: 1.5 };

// More than one restart between the watermark and now is a storm (§B R8-6 wedge-to-OOM: 36 recreations
// in ~35 min). A single restart is an ordinary redeploy, not an alarm.
export const RESTART_STORM_THRESHOLD = 1;

// DB-durable counters whose absolute zero, while a sibling counter proves the stack IS returning data,
// is a negative-read void (§C.9) — Prometheus gauges (rss) and rate-y counters are excluded.
const DURABLE_COUNTERS = new Set(['decides', 'fills', 'reconcile']);

export function costBreakerLimitFor(lane) {
  return COST_BREAKER_USD[lane] ?? COST_BREAKER_USD.spot;
}

// Pull the scalar counter values out of a lane's probe results, null wherever the probe failed — the
// runner uses this to persist the next watermark, and computeLane uses it to diff against the prior one.
export function extractCounters(laneCur) {
  const p = (laneCur && laneCur.probes) || {};
  const val = (probe, field) =>
    probe && probe.ok === true && probe.value && Number.isFinite(probe.value[field])
      ? probe.value[field]
      : null;
  return {
    decides: val(p.decides, 'count'),
    consultGate: val(p.consultGate, 'total'),
    fills: val(p.fills, 'count'),
    reconcile: val(p.reconcile, 'count'),
    wsRecreations: val(p.wsRecreations, 'count'),
    rssBytes: val(p.rss, 'bytes'),
  };
}

function diffCounters(prevCounters, curCounters) {
  const out = {};
  for (const key of Object.keys(curCounters)) {
    const a = prevCounters ? prevCounters[key] : null;
    const b = curCounters[key];
    out[key] = Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
  }
  return out;
}

function computeLane(lane, prev, cur, elapsedMs = null) {
  const alarms = [];
  const annotations = [];
  const probes = (cur && cur.probes) || {};

  // Named probe failures (fail OPEN — never a pass, never a crash).
  for (const [name, res] of Object.entries(probes)) {
    if (!res || res.ok !== true) {
      annotations.push({
        kind: 'probe_failed',
        lane,
        probe: name,
        detail: (res && res.error) || 'no result',
      });
    }
  }

  const curBoot = (cur && cur.bootId) || null;
  if (curBoot === null) {
    annotations.push({ kind: 'probe_failed', lane, probe: 'bootId', detail: 'bootId unresolved' });
  }

  // Provenance-before-interpretation: deltas only survive a matching bootId.
  const prevBoot = (prev && prev.bootId) || null;
  const bootMatches = prev !== null && curBoot !== null && prevBoot === curBoot;
  const curCounters = extractCounters(cur);
  let deltas = null;
  if (prev === null) {
    annotations.push({
      kind: 'no_watermark',
      lane,
      detail: 'no prior watermark for lane — deltas unavailable',
    });
  } else if (!bootMatches) {
    annotations.push({ kind: 'boot_changed', lane, detail: 'boot changed — deltas reset' });
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
        lane,
        detail: `${restarts} restarts since watermark (RestartCount ${prev.restartCount} -> ${cur.restartCount}; boot ${prevBoot} -> ${curBoot})`,
      });
    }
  }

  // State-based alarms — independent of the bootId match (a current-state read, not a window delta).
  const ks = probes.killSwitch;
  if (ks && ks.ok === true && ks.value && ks.value.state && ks.value.state !== 'RUNNING') {
    alarms.push({
      kind: 'kill_switch_engaged',
      lane,
      detail: `kill_switch_state=${ks.value.state}`,
    });
  }
  const rec = probes.reconcile;
  if (rec && rec.ok === true && rec.value && rec.value.latestResult === 'HALT') {
    alarms.push({ kind: 'reconcile_halt', lane, detail: 'latest reconciliation result=HALT' });
  }
  const cost = probes.cost;
  if (cost && cost.ok === true && cost.value && Number.isFinite(cost.value.spendUsd)) {
    const limit = costBreakerLimitFor(lane);
    // Epsilon guard: 0.8 * 1.5 === 1.2000000000000002 in IEEE754, which would silently swallow the
    // exact-80% boundary case a fixed-price breaker configuration lands on routinely.
    if (cost.value.spendUsd >= COST_PROXIMITY_RATIO * limit - 1e-9) {
      alarms.push({
        kind: 'cost_breaker_proximity',
        lane,
        detail: `spend $${cost.value.spendUsd} >= ${COST_PROXIMITY_RATIO * 100}% of $${limit} daily breaker`,
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
        lane,
        detail:
          'decide + consult-gate liveness counters unchanged since watermark while container healthy',
      });
    }
    if (deltas.reconcile === 0) {
      alarms.push({
        kind: 'journal_silence',
        lane,
        detail:
          'reconciliations journal produced no new rows since watermark while container healthy',
      });
    }
  } else if (deltas !== null && cur && cur.containerHealthy === true && intervalTooShort) {
    annotations.push({
      kind: 'short_interval',
      lane,
      detail: `sweep gap ${Math.round(elapsedMs / 1000)}s < ${LIVENESS_MIN_ELAPSED_MS / 60000}min liveness floor — delta-starvation alarms suppressed this sweep`,
    });
  }

  // Negative-read void (§C.9): a durable counter reads exactly 0 while a SIBLING counter returned data
  // (the positive control proving the stack answers), so the empty read is voided, not trusted as quiet.
  if (cur && cur.containerHealthy === true) {
    const readCounters = Object.entries(curCounters).filter(([, v]) => Number.isFinite(v));
    const anyPositive = readCounters.some(([, v]) => v > 0);
    if (anyPositive) {
      for (const [key, v] of readCounters) {
        if (v === 0 && DURABLE_COUNTERS.has(key)) {
          annotations.push({
            kind: 'negative_read_void',
            lane,
            probe: key,
            detail: `${key}=0 while sibling counters returned data and container healthy — empty read voided, not a pass`,
          });
        }
      }
    }
  }

  return { deltas, alarms, annotations };
}

export function computeSweep({ prev, cur }) {
  const deltas = {};
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
  const lanes = (cur && cur.lanes) || {};
  for (const [lane, laneCur] of Object.entries(lanes)) {
    const lanePrev = (prev && prev.lanes && prev.lanes[lane]) || null;
    const laneResult = computeLane(lane, lanePrev, laneCur, elapsedMs);
    deltas[lane] = laneResult.deltas;
    alarms.push(...laneResult.alarms);
    annotations.push(...laneResult.annotations);
  }

  return { deltas, alarms, annotations };
}
