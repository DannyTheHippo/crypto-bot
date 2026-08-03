#!/usr/bin/env node
// Out-of-sample SESSION arm — the I/O shell. Gathers the decision record
// (research/oos-arm/decisions-*.jsonl), the batch seals (`experiments` where
// family='oos-arm-seal'), the live lane's own comparator rows, and the price grid, then hands them to
// the pure core (loop-oos-arm-core.mjs), which owns every judgement. This file makes no decision
// about the data beyond "did the read succeed" — mirrors loop-forward-return.mjs's own split exactly.
//
// FAILURE DIRECTION — MEASUREMENT, FAILS OPEN. Annotations only; no alarms, no gate, no exit code
// that could stop a pass. `main()` exits non-zero only if the TOOL ITSELF crashes, never because the
// measurement came out unfavourable or because the arm is UNSTARTED, and `oosArmSweepAnnotations()`
// (what loop-sweep.mjs merges) swallows even a crash into a named annotation so a broken measurement
// can never block the sweep that carries it.
//
// WHY THE GRID QUERY'S LOWER BOUND DIFFERS FROM loop-forward-return.mjs's GRID_SQL: that module
// anchors its lower bound to the earliest LIVE entry (open_long/open_short) ever recorded — a
// reasonable bound for a measurement whose whole entryRows set IS the live lane's own entries. This
// arm's entries are the SESSION's, not the live lane's, and the pre-registration is explicit that nothing
// requires the two to coincide (a row the session enters may be a row the live lane only held on, or
// never entered on at all in its own history). Anchoring on the live lane's entry actions would bound
// this arm's grid by a fact that has nothing to do with which rows THIS arm needs priced. So the bound
// here is anchored to the arm's OWN offered rows (the decision record's own eventTime range) instead —
// relaxed in the sense that it no longer depends on the live lane having entered anything at all.
//
// experiments is APPEND-ONLY (root CLAUDE.md hard rule 6) and read-only here — this module never
// writes a seal; `experiments` is written by test/eval/agentic/oos-arm-record.ts's sealBatch only.
//
// VOID condition 2 (system-prompt fidelity) resolution: `git rev-parse <commitSha>:<PROMPT_SURFACE_FILE>`
// per DISTINCT `agentPromptCommitSha` the decision record carries — the SAME primitive
// test/eval/agentic/playbook-space-replay.ts's `checkPromptSurface` uses for HEAD (`git rev-parse
// HEAD:<path>`), generalised to an arbitrary historical commit rather than only HEAD. `git`, not
// `loop-transport.mjs`, because this reads THIS repo's own history, not the running stack — same
// local-read posture as this module's own `gitTip()`-style local reads elsewhere in the loop tooling.

import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { psql } from './loop-transport.mjs';
import { computeOosArm, oosArmAnnotations, renderOosArm } from './loop-oos-arm-core.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const OOS_ARM_DIR = join(REPO_ROOT, 'research', 'oos-arm');

// Hand-transcribed from test/eval/agentic/playbook-space-replay.ts's own `PROMPT_SURFACE_FILE` — a
// plain .mjs run via `node` cannot import a .ts module directly (no loader configured for that path),
// so this is a deliberate duplication, not a fork of logic: both name the SAME repo-relative path.
const PROMPT_SURFACE_FILE = 'src/features/strategy/agentic/agent-prompt.ts';

const DECISIONS_FILE_RE = /^decisions-.*\.jsonl$/;

// `replay-%` and non-'candle' triggers are excluded for the SAME reasons loop-forward-return.mjs's own
// queries exclude them — see that module's header. `family='oos-arm-seal'` is this study's own,
// distinct from any other `experiments` writer, so a scorer here never picks up an unrelated trial.
const SEALS_SQL =
  'select row_to_json(t) from (select id, extract(epoch from created_at) * 1000 as created_at_ms, ' +
  "metrics from experiments where family = 'oos-arm-seal' order by id) t";

function buildLiveEntrySql(minEventTime, maxEventTime) {
  return (
    'select event_time, venue, symbol, action, coalesce(playbook_version, -1) from agent_decisions' +
    " where trigger_kind = 'candle' and strategy_id not like 'replay-%'" +
    ` and event_time >= ${Math.floor(minEventTime)} and event_time <= ${Math.ceil(maxEventTime)}` +
    ' order by event_time, venue, symbol'
  );
}

// NO action filter and NO anchor to a live entry action — see module header. Anchored instead to the
// arm's OWN row range so this arm's grid coverage never depends on whether the live lane entered
// anything at all.
function buildArmGridSql(minEventTime) {
  return (
    'select event_time, venue, symbol, close from agent_decisions' +
    " where trigger_kind = 'candle' and close is not null and strategy_id not like 'replay-%'" +
    ` and event_time >= ${Math.floor(minEventTime)}` +
    ' order by venue, symbol, event_time'
  );
}

/** `git rev-parse <commitSha>:<PROMPT_SURFACE_FILE>` — the blob agent-prompt.ts held in `commitSha`,
 * or null on ANY failure (unresolvable commit, git unavailable, path absent at that commit). Never
 * throws — a git failure is UNVERIFIABLE data for the core, not a crash for this shell. */
export function resolveBlobAtCommit(commitSha, cwd = REPO_ROOT) {
  try {
    const res = spawnSync('git', ['rev-parse', `${commitSha}:${PROMPT_SURFACE_FILE}`], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (res.error || res.status !== 0) return null;
    const out = (res.stdout || '').toString().trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Every DISTINCT `agentPromptCommitSha` a decision-record line carries. Malformed lines are simply
 * skipped here — the core is what counts and names an unparseable line
 * (`oos_arm_decision_lines_unparseable`); this shell only needs the sha set. */
export function distinctCommitShas(decisionLines) {
  const shas = new Set();
  if (!Array.isArray(decisionLines)) return shas;
  for (const line of decisionLines) {
    try {
      const row = JSON.parse(line);
      if (typeof row?.agentPromptCommitSha === 'string' && row.agentPromptCommitSha.length > 0) {
        shas.add(row.agentPromptCommitSha);
      }
    } catch {
      // skipped — see comment above.
    }
  }
  return shas;
}

/** One `git rev-parse` per DISTINCT commit sha in the decision record — bounded by the number of
 * PLAYBOOK-PROMPT-touching commits the record spans, not by row count. */
export function buildPromptBlobAtCommit(decisionLines, cwd = REPO_ROOT) {
  const shas = distinctCommitShas(decisionLines);
  const out = {};
  for (const sha of shas) out[sha] = resolveBlobAtCommit(sha, cwd);
  return out;
}

/** Every `decisions-*.jsonl` file under research/oos-arm/, in filename (== chronological) order. Its
 * own absence is NOT an error — the arm is UNSTARTED until the owner-side hourly trigger exists and
 * the first file is written (§ Cadence). Returns null ONLY on a genuine read failure of a file that
 * DOES exist, so the core can distinguish "nothing here yet" from "something is wrong". */
export function readDecisionLines(dir = OOS_ARM_DIR) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    // ENOENT (directory absent) is the expected pre-launch state — an empty array, not null: the core
    // treats [] as "the file(s) exist but carry nothing", which is close enough to "nothing exists yet"
    // that no separate signal is needed here (both funnel into the SAME oos_arm_unstarted verdict once
    // paired with zero seals).
    return [];
  }
  const files = names.filter((n) => DECISIONS_FILE_RE.test(n)).sort();
  const lines = [];
  for (const name of files) {
    try {
      const text = readFileSync(join(dir, name), 'utf8');
      for (const line of text.split('\n')) {
        if (line.trim().length > 0) lines.push(line);
      }
    } catch {
      // One unreadable file voids the WHOLE read rather than silently scoring a partial corpus — a
      // partial decisions file is exactly the kind of absence that could read as a clean reading.
      return null;
    }
  }
  return lines;
}

function parseJsonLines(res) {
  if (!res || res.ok !== true || typeof res.value !== 'string') return null;
  const text = res.value.trim();
  if (text === '') return [];
  const out = [];
  for (const line of text.split('\n')) {
    try {
      out.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return out;
}

/** Reads every `experiments` row with family='oos-arm-seal', shaped `{ createdAtMs, metrics }`. Null
 * on a genuine transport/parse failure — distinct from an empty array (zero seals so far). */
export function readSeals(opts = {}) {
  const res = opts.sealsRes ?? psql(SEALS_SQL, { cwd: opts.cwd });
  const rows = parseJsonLines(res);
  if (rows === null) return null;
  return rows.map((r) => ({ createdAtMs: Number(r.created_at_ms), metrics: r.metrics ?? null }));
}

function parseDelimitedRows(res, arity) {
  if (!res || res.ok !== true || typeof res.value !== 'string') return null;
  const text = res.value.trim();
  if (text === '') return [];
  const rows = [];
  for (const line of text.split('\n')) {
    const parts = line.split('|');
    if (parts.length !== arity) return null;
    rows.push(parts);
  }
  return rows;
}

function gatherLiveEntryRows({ minEventTime, maxEventTime, cwd, liveEntryRes }) {
  const res = liveEntryRes ?? psql(buildLiveEntrySql(minEventTime, maxEventTime), { cwd });
  const parts = parseDelimitedRows(res, 5);
  if (parts === null) return null;
  return parts.map((p) => ({
    eventTime: Number(p[0]),
    venue: p[1],
    symbol: p[2],
    action: p[3],
    playbookVersion: Number(p[4]) === -1 ? null : Number(p[4]),
  }));
}

function gatherArmGridRows({ minEventTime, cwd, gridRes }) {
  const res = gridRes ?? psql(buildArmGridSql(minEventTime), { cwd });
  const parts = parseDelimitedRows(res, 4);
  if (parts === null) return null;
  return parts.map((p) => ({
    eventTime: Number(p[0]),
    venue: p[1],
    symbol: p[2],
    close: Number(p[3]),
  }));
}

/**
 * Full gather: decisions -> seals -> (only if both carry something) the live-comparator and grid
 * probes, bounded by the decision record's OWN eventTime range. Skipping the two DB-heavy probes when
 * there is plainly nothing to score yet keeps a pass over an UNSTARTED arm cheap.
 */
export function gatherOosArm(opts = {}) {
  const cwd = opts.cwd ?? REPO_ROOT;
  const decisionLines = opts.decisionLines ?? readDecisionLines(opts.oosArmDir ?? OOS_ARM_DIR);
  const seals = opts.seals ?? readSeals({ cwd, sealsRes: opts.sealsRes });

  const haveDecisions = Array.isArray(decisionLines) && decisionLines.length > 0;
  const haveSeals = Array.isArray(seals) && seals.length > 0;
  if (!haveDecisions || !haveSeals) {
    return { decisionLines, seals, liveEntryRows: null, gridRows: null, promptBlobAtCommit: null };
  }

  const promptBlobAtCommit = opts.promptBlobAtCommit ?? buildPromptBlobAtCommit(decisionLines, cwd);

  const eventTimes = [];
  for (const line of decisionLines) {
    try {
      const row = JSON.parse(line);
      if (Number.isFinite(row?.eventTime)) eventTimes.push(row.eventTime);
    } catch {
      // A malformed line is the CORE's problem to count (oos_arm_decision_lines_unparseable) — this
      // shell only needs a bound, and skips what it cannot parse rather than voiding the whole gather.
    }
  }
  if (eventTimes.length === 0) {
    return { decisionLines, seals, liveEntryRows: [], gridRows: [], promptBlobAtCommit };
  }
  const minEventTime = Math.min(...eventTimes);
  const maxEventTime = Math.max(...eventTimes);

  const liveEntryRows =
    opts.liveEntryRows ??
    gatherLiveEntryRows({
      minEventTime,
      maxEventTime,
      cwd,
      liveEntryRes: opts.liveEntryRes,
    });
  const gridRows = opts.gridRows ?? gatherArmGridRows({ minEventTime, cwd, gridRes: opts.gridRes });

  return { decisionLines, seals, liveEntryRows, gridRows, promptBlobAtCommit };
}

export function runOosArm(opts = {}) {
  return computeOosArm(gatherOosArm(opts));
}

/** What loop-sweep.mjs merges into `result.annotations` — wrapped so this measurement can never abort
 * the sweep: a throw here becomes a named annotation, matching forwardReturnAnnotations's own posture. */
export function oosArmSweepAnnotations(opts = {}) {
  try {
    return oosArmAnnotations(runOosArm(opts));
  } catch (err) {
    return [
      {
        kind: 'oos_arm_tool_failed',
        detail:
          'the out-of-sample session-arm scorer threw and produced NO reading: ' +
          `${err instanceof Error ? err.message : String(err)} — this is a void read, not a clean one`,
      },
    ];
  }
}

function main() {
  process.stdout.write(renderOosArm(runOosArm()) + '\n');
}

// CLI entry-point guard: an `import` (the spec suite imports the helpers above) must NOT fire a
// blocking pair of database reads as an import side effect.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`loop-oos-arm: FATAL ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  }
}
