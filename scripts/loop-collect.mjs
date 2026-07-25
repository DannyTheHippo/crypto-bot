#!/usr/bin/env node
// Y3 standing health-digest COLLECTOR — a long-running foreground process that runs the Y2 sweep
// in-process every LOOP_COLLECT_INTERVAL_MS and appends one JSON line (+ a compact md section) per
// tick under research/loop/digests/. `pnpm loop:collect`. The OPERATOR chooses how to daemonize it
// (launchd/tmux/nohup); this script installs nothing and exits cleanly on SIGTERM after the in-flight
// tick finishes.
//
// Why it exists (loop-mechanism-learnings-2026-07.md §D "Y3"): the discrete 3x-daily pass model has a
// blind window as wide as its gap — an 8.2h candle-stall, a ~1h FATAL-latch death, and a 46-min $2.30
// reflection hot loop all opened and (mostly) closed inside a single inter-pass gap. A standing
// collector shrinks that window to one interval AND carries its own liveness contract so the collector
// is not itself a silent failure surface (the first W6 collector was a dud: 1 line in 8h).
//
// Liveness contract (§D, all binding):
//   (a) a heartbeat line EVERY interval — a clean sweep still lands a digest line, so "no output"
//       (process dead: no line for the interval) is distinguishable from "nothing happened".
//   (b) startup self-verification — write a sentinel line, read it back, refuse to start (exit 1) if
//       the read-back fails; the write path is proven before the loop is trusted.
//   (c) host-sleep tolerance — a tick whose elapsed exceeds 1.5x the interval appends an annotated gap
//       line; the missed ticks are recorded, never fabricated as rows.
//   (d) self-monitored cadence — every line carries seq + plannedAt + actualAt, so a seq gap or a large
//       drift is visible directly in the data.
//   (e) rotation — on startup and daily rollover, dated digest files older than 14 days move to
//       digests/archive/ (created if absent).
//
// The sweep is read-only against the stack (loop-transport.mjs); this collector only ever writes under
// research/loop/digests/ (single-writer guard below).

import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDigestLine,
  buildGapLine,
  buildSentinelLine,
  classifyCadence,
  renderMdSection,
  rotationTargets,
  utcDateString,
} from './loop-collect-core.mjs';
import { runSweep } from './loop-sweep.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const DIGESTS_DIR = join(REPO_ROOT, 'research', 'loop', 'digests');
const ARCHIVE_DIR = join(DIGESTS_DIR, 'archive');
const DEFAULT_INTERVAL_MS = 3_600_000;

function resolveIntervalMs() {
  const raw = process.env.LOOP_COLLECT_INTERVAL_MS;
  if (raw === undefined || raw === '') return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  // Config refusal at construction: a non-positive or non-numeric interval would silently misbehave
  // (busy-loop or never-fire), so refuse loudly at startup rather than fail open per-tick.
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`loop-collect: FATAL invalid LOOP_COLLECT_INTERVAL_MS='${raw}'\n`);
    process.exit(1);
  }
  return n;
}

// The ONLY writer: refuses any path escaping research/loop/digests/ (mirrors loop-sweep.mjs's guard).
function pathUnderDigests(relName) {
  const target = resolve(DIGESTS_DIR, relName);
  if (target !== DIGESTS_DIR && !target.startsWith(DIGESTS_DIR + sep)) {
    throw new Error(`refusing to write outside the digests dir: ${target}`);
  }
  return target;
}

function appendJsonl(dateStr, lineObj) {
  const path = pathUnderDigests(`${dateStr}.jsonl`);
  mkdirSync(DIGESTS_DIR, { recursive: true });
  appendFileSync(path, JSON.stringify(lineObj) + '\n');
  return path;
}

function appendMd(dateStr, lineObj) {
  const path = pathUnderDigests(`${dateStr}.md`);
  mkdirSync(DIGESTS_DIR, { recursive: true });
  const section = renderMdSection(lineObj);
  if (!existsSync(path)) {
    // H1 header on creation; the section is prefixed with a blank line by the append branch below, so
    // seed the header WITHOUT a trailing blank line — the next write supplies the separator.
    writeFileSync(path, `# Loop collector digest — ${dateStr}\n`);
  }
  appendFileSync(path, '\n' + section);
  return path;
}

// Startup self-verification (§D b): append a sentinel line, read the file back, confirm the last line
// parses to the exact sentinel we wrote. A mismatch means the write/read path is broken this boot —
// refuse to start rather than run blind. Fails CLOSED: a broken evidence path must not pretend to work.
function verifyWritePath(dateStr, seq) {
  const nonce = randomUUID();
  const sentinel = buildSentinelLine({ seq, actualAtMs: Date.now(), pid: process.pid, nonce });
  const path = appendJsonl(dateStr, sentinel);
  appendMd(dateStr, sentinel);
  let readBack;
  try {
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    readBack = JSON.parse(lines[lines.length - 1]);
  } catch (err) {
    process.stderr.write(`loop-collect: FATAL sentinel read-back failed: ${String(err)}\n`);
    process.exit(1);
  }
  if (readBack.type !== 'sentinel' || readBack.nonce !== nonce || readBack.seq !== seq) {
    process.stderr.write(
      `loop-collect: FATAL sentinel read-back mismatch (wrote nonce=${nonce}, read=${JSON.stringify(readBack)})\n`,
    );
    process.exit(1);
  }
  process.stderr.write(`loop-collect: sentinel verified (${path})\n`);
}

// Move dated digest files older than 14 days into digests/archive/. Discovery is by the DATE parsed
// from the filename (rotationTargets), never name ordering.
function rotate(refDateStr) {
  let names;
  try {
    names = readdirSync(DIGESTS_DIR);
  } catch {
    return; // dir not created yet — nothing to rotate.
  }
  const targets = rotationTargets(names, refDateStr);
  if (targets.length === 0) return;
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  for (const name of targets) {
    try {
      renameSync(pathUnderDigests(name), join(ARCHIVE_DIR, name));
    } catch (err) {
      process.stderr.write(`loop-collect: rotation skipped ${name}: ${String(err)}\n`);
    }
  }
  process.stderr.write(`loop-collect: rotated ${targets.length} file(s) to archive/\n`);
}

// ── the interval loop ─────────────────────────────────────────────────────────────────────────────
const intervalMs = resolveIntervalMs();
let seq = 0;
let prevActualAtMs = null;
let currentDateStr = null;
let shuttingDown = false;
let inTick = false;
let pendingTimer = null;

function emit(dateStr, lineObj) {
  appendJsonl(dateStr, lineObj);
  appendMd(dateStr, lineObj);
}

function runTick(plannedAtMs) {
  inTick = true;
  const actualAtMs = Date.now();
  const dateStr = utcDateString(actualAtMs);

  // Daily rollover: rotate old files once when the UTC date advances.
  if (dateStr !== currentDateStr) {
    rotate(dateStr);
    currentDateStr = dateStr;
  }

  // Host-sleep tolerance (§D c): an over-long gap is an annotated line, not fabricated rows.
  const cadence = classifyCadence({ prevActualAtMs, plannedAtMs, actualAtMs, intervalMs });
  if (cadence.gapDetected) {
    seq += 1;
    emit(
      dateStr,
      buildGapLine({
        seq,
        plannedAtMs,
        actualAtMs,
        gapMs: cadence.gapMs,
        missedTicks: cadence.missedTicks,
        intervalMs,
      }),
    );
  }

  // The heartbeat line — emitted whether the sweep found alarms, found nothing, or threw.
  seq += 1;
  let sweep = null;
  let sweepError = null;
  try {
    sweep = runSweep();
  } catch (err) {
    sweepError = err instanceof Error ? err.stack || err.message : String(err);
  }
  emit(dateStr, buildDigestLine({ seq, plannedAtMs, actualAtMs, sweep, sweepError }));

  prevActualAtMs = actualAtMs;
  inTick = false;

  if (shuttingDown) {
    process.stderr.write('loop-collect: SIGTERM — exiting after in-flight tick\n');
    process.exit(0);
  }

  const nextPlannedAtMs = plannedAtMs + intervalMs;
  const delay = Math.max(0, nextPlannedAtMs - Date.now());
  pendingTimer = setTimeout(() => runTick(nextPlannedAtMs), delay);
}

function shutdown() {
  shuttingDown = true;
  if (!inTick) {
    if (pendingTimer) clearTimeout(pendingTimer);
    process.stderr.write('loop-collect: SIGTERM — exiting (idle)\n');
    process.exit(0);
  }
  // Mid-tick: runTick's tail sees shuttingDown and exits once the in-flight sweep returns.
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function main() {
  const startMs = Date.now();
  currentDateStr = utcDateString(startMs);
  rotate(currentDateStr); // startup rotation (§D e)
  verifyWritePath(currentDateStr, (seq += 1)); // sentinel is seq 1
  process.stderr.write(
    `loop-collect: started (interval ${intervalMs}ms, pid ${process.pid}) — Ctrl-C / SIGTERM to stop\n`,
  );
  runTick(startMs); // first tick immediately, then every interval
}

main();
