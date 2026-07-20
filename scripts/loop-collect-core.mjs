#!/usr/bin/env node
// Y3 standing collector — PURE logic. No I/O, no clock, no process/env access: given clock values and
// filenames passed in, derive the cadence classification (heartbeat/gap/seq), the digest/gap/sentinel
// line shapes, the rotation set, and the since-filter. The runner (loop-collect.mjs) owns the timers,
// file appends, sentinel read-back, and SIGTERM; every branch a fixture can exercise deterministically
// lives here so it is unit-testable off passed-in values (mirrors loop-sweep-core.mjs's discipline).
//
// Design amendments this encodes (loop-mechanism-learnings-2026-07.md §D "Y3"):
//   - A heartbeat line EVERY interval so "no output" (process dead) is distinguishable from "nothing
//     happened" (a clean digest line landed): buildDigestLine emits unconditionally, sweepError and all.
//   - Host-sleep tolerance: a tick whose elapsed exceeds GAP_FACTOR x interval is an annotated gap line,
//     never a fabricated row for the missed window (classifyCadence + buildGapLine).
//   - Self-monitored cadence: every line carries seq + plannedAt + actualAt so a seq gap or a large
//     drift is visible directly in the data (the missing 04:15/05:15 checks that nothing remarked on).
//   - Rotation by DATE parsed from the filename, never name ordering (the alphabetical `ls|tail` miss).

export const SCHEMA_VERSION = 1;

// A tick whose elapsed since the prior tick exceeds this multiple of the interval is treated as a
// host-sleep gap (memory crypto-bot-host-sleep-duty-cycle): the sleep/wake edge stretches wall-clock
// far past the scheduled cadence. 1.5x tolerates ordinary spawnSync jitter without crying wolf.
export const GAP_FACTOR = 1.5;

// Digest files older than this (by the DATE in their name) move to digests/archive/ on startup and
// daily rollover — the blind-window justification is measured in hours, so a fortnight of hot history
// is ample working set; older rows stay readable via loop-digests-since across the archive.
export const MAX_AGE_DAYS = 14;

const MS_PER_DAY = 86_400_000;

function toIso(ms) {
  return new Date(ms).toISOString();
}

// The UTC calendar-day bucket (YYYY-MM-DD) a timestamp falls in — the jsonl/md filename stem and the
// daily-rollover key. UTC everywhere: a local-time leak would desync rollover from the filenames.
export function utcDateString(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Cadence classification for one tick. prevActualAtMs is the prior tick's real fire time (null on the
// first tick of a process); plannedAtMs is when this tick was scheduled to fire; actualAtMs is now.
// gapDetected fires only with a known prior tick — the first tick can never be a "gap".
export function classifyCadence({ prevActualAtMs, plannedAtMs, actualAtMs, intervalMs }) {
  const driftMs = actualAtMs - plannedAtMs;
  if (!Number.isFinite(prevActualAtMs)) {
    return { gapDetected: false, gapMs: null, missedTicks: 0, driftMs };
  }
  const gapMs = actualAtMs - prevActualAtMs;
  const gapDetected = gapMs > GAP_FACTOR * intervalMs;
  // How many scheduled ticks the gap swallowed — floor(elapsed/interval) - 1 (the tick that DID fire).
  const missedTicks = gapDetected ? Math.max(0, Math.floor(gapMs / intervalMs) - 1) : 0;
  return { gapDetected, gapMs, missedTicks, driftMs };
}

// Compact per-lane + alarm summary pulled from a runSweep() digest — the durable rehydration payload,
// small enough to carry on every heartbeat line.
export function summarizeSweep(digest) {
  const result = (digest && digest.result) || {};
  const alarms = Array.isArray(result.alarms)
    ? result.alarms.map((a) => ({ kind: a.kind, lane: a.lane ?? null }))
    : [];
  const annotationCount = Array.isArray(result.annotations) ? result.annotations.length : 0;
  const lanes = {};
  const laneMap = (digest && digest.lanes) || {};
  const deltaMap = result.deltas || {};
  for (const [laneKey, lane] of Object.entries(laneMap)) {
    lanes[laneKey] = {
      bootId: lane.bootId ?? null,
      containerHealthy: lane.containerHealthy === true,
      restartCount: Number.isFinite(lane.restartCount) ? lane.restartCount : null,
      deltas: deltaMap[laneKey] ?? null,
    };
  }
  return { git: (digest && digest.git) ?? null, alarms, annotationCount, lanes };
}

// The heartbeat line — emitted EVERY interval, whether the sweep found alarms, found nothing, or threw
// (sweepError set). Its presence proves the collector is alive; its absence for an interval means the
// process itself is down, which no in-band line could ever report.
export function buildDigestLine({ seq, plannedAtMs, actualAtMs, sweep, sweepError }) {
  const line = {
    v: SCHEMA_VERSION,
    seq,
    type: 'digest',
    plannedAt: toIso(plannedAtMs),
    actualAt: toIso(actualAtMs),
    driftMs: actualAtMs - plannedAtMs,
  };
  if (sweepError) {
    line.sweepError = String(sweepError);
    line.git = null;
    line.alarms = [];
    line.alarmCount = 0;
    line.annotationCount = 0;
    line.lanes = {};
  } else {
    const s = summarizeSweep(sweep && sweep.digest ? sweep.digest : sweep);
    line.sweepError = null;
    line.git = s.git;
    line.alarms = s.alarms;
    line.alarmCount = s.alarms.length;
    line.annotationCount = s.annotationCount;
    line.lanes = s.lanes;
  }
  return line;
}

// The annotated gap line — the missed window recorded as data, with NO fabricated counter rows for the
// ticks that never fired.
export function buildGapLine({ seq, plannedAtMs, actualAtMs, gapMs, missedTicks, intervalMs }) {
  return {
    v: SCHEMA_VERSION,
    seq,
    type: 'gap',
    plannedAt: toIso(plannedAtMs),
    actualAt: toIso(actualAtMs),
    gapMs,
    missedTicks,
    detail: `elapsed ${(gapMs / 60_000).toFixed(1)}min > ${GAP_FACTOR}x interval (${intervalMs}ms) — ~${missedTicks} tick(s) missed (host-sleep suspected); no rows fabricated for the gap`,
  };
}

// The startup sentinel — written then read back before the loop starts (loud exit 1 on read-back
// mismatch). It doubles as the first durable proof the write path works this boot.
export function buildSentinelLine({ seq, actualAtMs, pid, nonce }) {
  return {
    v: SCHEMA_VERSION,
    seq,
    type: 'sentinel',
    actualAt: toIso(actualAtMs),
    pid,
    nonce,
    note: 'startup self-verification write',
  };
}

// The UTC date encoded in a digest filename, or null for non-dated files (.watermark.json, w6-digests
// .txt, the archive dir itself). Two shapes: `YYYY-MM-DD.{jsonl,md}` and `sweep-YYYY-MM-DDT...json`.
export function dateOfDigestFile(name) {
  const daily = name.match(/^(\d{4}-\d{2}-\d{2})\.(jsonl|md)$/);
  if (daily) return daily[1];
  const sweep = name.match(/^sweep-(\d{4}-\d{2}-\d{2})T.*\.json$/);
  if (sweep) return sweep[1];
  return null;
}

function daysBetween(fromDateStr, toDateStr) {
  const [fy, fm, fd] = fromDateStr.split('-').map(Number);
  const [ty, tm, td] = toDateStr.split('-').map(Number);
  return (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / MS_PER_DAY;
}

// The rotation set: dated digest files strictly OLDER than MAX_AGE_DAYS relative to refDateStr. 14 days
// old is kept; 15 is archived. Non-dated files are never touched.
export function rotationTargets(names, refDateStr, maxAgeDays = MAX_AGE_DAYS) {
  const targets = [];
  for (const name of names) {
    const fileDate = dateOfDigestFile(name);
    if (fileDate === null) continue;
    if (daysBetween(fileDate, refDateStr) > maxAgeDays) targets.push(name);
  }
  return targets;
}

// The "digests since <ts>" reader logic: keep lines whose actualAt >= sinceIso, sorted newest LAST
// (ascending). Lines without a parseable actualAt are dropped — a rehydration read must not surface
// malformed rows as if they were events.
export function filterSince(lines, sinceIso) {
  const sinceMs = Date.parse(sinceIso);
  const kept = [];
  for (const line of lines) {
    if (!line || typeof line.actualAt !== 'string') continue;
    const ms = Date.parse(line.actualAt);
    if (!Number.isFinite(ms)) continue;
    if (ms >= sinceMs) kept.push({ ms, line });
  }
  kept.sort((a, b) => a.ms - b.ms);
  return kept.map((k) => k.line);
}

// The markdown companion section for one line — compact, and markdownlint-clean (heading + blank line +
// tight list, single trailing newline). The runner joins these with a leading blank-line separator.
export function renderMdSection(line) {
  const L = [];
  if (line.type === 'gap') {
    L.push(`## Gap before tick ${line.seq} — ${line.actualAt}`);
    L.push('');
    L.push(`- host-sleep suspected: elapsed ${(line.gapMs / 60_000).toFixed(1)}min`);
    L.push(`- ~${line.missedTicks} tick(s) missed — no rows fabricated`);
  } else if (line.type === 'sentinel') {
    L.push(`## Sentinel — ${line.actualAt}`);
    L.push('');
    L.push(`- startup self-verification write (pid ${line.pid})`);
  } else {
    L.push(`## Tick ${line.seq} — ${line.actualAt}`);
    L.push('');
    L.push(`- drift: ${line.driftMs}ms`);
    if (line.sweepError) {
      L.push(`- sweep error: ${line.sweepError}`);
    } else {
      const alarmKinds =
        line.alarms.length > 0 ? line.alarms.map((a) => a.kind).join(', ') : 'none';
      L.push(`- alarms: ${line.alarmCount} (${alarmKinds})`);
      L.push(`- annotations: ${line.annotationCount}`);
      const laneKeys = Object.keys(line.lanes);
      const laneSummary =
        laneKeys.length > 0
          ? laneKeys
              .map((k) => {
                const l = line.lanes[k];
                const boot = l.bootId ? l.bootId.slice(0, 8) : 'UNRESOLVED';
                return `${k} boot ${boot} (${l.containerHealthy ? 'healthy' : 'unhealthy'})`;
              })
              .join('; ')
          : 'no lanes running';
      L.push(`- lanes: ${laneSummary}`);
    }
  }
  return L.join('\n') + '\n';
}
