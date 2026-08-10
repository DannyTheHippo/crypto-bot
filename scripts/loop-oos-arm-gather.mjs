#!/usr/bin/env node
// Out-of-sample SESSION arm — GATHER. Builds the candidates file the decide-leg pass step
// (docs/planning/daily-profitability-loop.md § the decide leg) feeds to
// test/eval/agentic/oos-arm-run.spec.ts (OOS_ARM_CANDIDATES_FILE). Read-only against the running
// stack; writes ONE JSON file. Never appends a decision record and never seals a window — those are
// the decide leg's own job (oos-arm-run.spec.ts) and the seal step's own job (sealBatch,
// test/eval/agentic/oos-arm-record.ts), respectively.
//
// CANDIDATES (research/studies/oos-session-arm-2026-08-03.md § vi, as pre-registered by the task that
// built this module): `agent_decisions` rows with `trigger_kind = 'candle'` (an exec-triggered row
// stamps a fill time whose close belongs to an earlier bar, per loop-forward-return-core.mjs's own
// header), non-replay (`strategy_id NOT LIKE 'replay-%'`), a FLAT position marker (the SAME
// FLAT_MARKER_SQL literal loop-forward-return.mjs uses, so this gather cannot drift from the arm's
// own registered denominator by a stray character), and `event_time > nowMs - 4*BAR_MS`. `nowMs` is
// the DATABASE clock, never the host's (§ vi: "nowMs comes from the database clock, not the host") —
// this stack runs on a laptop that sleeps and drifts, and the eligibility check downstream
// (assertEligible, test/eval/agentic/oos-arm-decide.ts) must be evaluated against the SAME instant
// this query used as its own bound, which is why `now_ms` is read ONCE and reused for both.
//
// The SQL never selects `action` — the gather step is upstream of the blind decide leg (the pass
// step's own rule: "the gather step never carries `action` into the candidates file"). A candidates
// file built by this script structurally cannot leak the live lane's own decision to a session
// deciding blind on the same rows.
//
// PLAYBOOK CONTENT: fetched for the SINGLE `playbook_version` the candidate rows carry. A gather
// window spanning MORE than one distinct version (a promotion landed mid-window) is refused rather
// than guessed at — see `assertSingleVersion` below — because a single `playbookContent` field
// covering rows decided under two different playbooks would silently misstate VOID condition 2's
// "same playbook block" requirement for whichever rows are on the other version. A refusal here costs
// nothing: the next decide leg (the very next pass-start/pass-end firing) re-gathers a fresh, almost
// certainly single-version window.
//
// DEDUPE: rowIds already present in ANY research/oos-arm/decisions-*.jsonl file are excluded — the
// SAME rowId offered twice could enter the scored family twice (pre-registration § Multiplicity:
// "NO ROW MAY EVER BE SCORED TWICE").

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { psql } from './loop-transport.mjs';
import { BAR_MS } from './loop-forward-return-core.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const OOS_ARM_DIR = join(REPO_ROOT, 'research', 'oos-arm');

const ELIGIBLE_K_MAX = 3;

// The SAME literal loop-forward-return.mjs uses for the FLAT-population marker — kept as one string
// so it cannot drift from that module's FLAT_MARKER_SQL by a stray character.
const FLAT_MARKER_SQL = '\'"position":{"side":"FLAT"\'';

const NOW_MS_SQL = 'select (extract(epoch from now()) * 1000)::bigint';

function buildCandidatesSql(nowMs) {
  const minEventTime = Math.floor(nowMs - (ELIGIBLE_K_MAX + 1) * BAR_MS);
  return (
    'select row_to_json(t) from (' +
    'select id::text as id, event_time, venue, symbol, playbook_version, input_payload ' +
    'from agent_decisions ' +
    "where trigger_kind = 'candle' and strategy_id not like 'replay-%' " +
    `and strpos(coalesce(input_payload, ''), ${FLAT_MARKER_SQL}) > 0 ` +
    `and event_time > ${minEventTime} ` +
    'order by event_time, venue, symbol' +
    ') t'
  );
}

function buildPlaybookContentSql(version) {
  return (
    'select row_to_json(t) from (' +
    `select content from agent_playbook_versions where version = ${Math.trunc(version)} ` +
    'order by created_at desc limit 1' +
    ') t'
  );
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

/** Reads the DB clock ONCE — reused as both the SQL bound and the candidates file's own
 * `gatheredAtMsFromDb`, so the eligibility check downstream (assertEligible) is evaluated against
 * exactly the instant this query used, never a second, independently-drifted read. Never throws:
 * returns null on any transport/parse failure so the caller can refuse cleanly. */
export function readNowMsFromDb(opts = {}) {
  const res = opts.nowRes ?? psql(NOW_MS_SQL, { cwd: opts.cwd });
  if (!res || res.ok !== true || typeof res.value !== 'string') return null;
  const trimmed = res.value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Every `decisions-*.jsonl` rowId already recorded under research/oos-arm/ — the dedupe set. An
 * absent directory (nothing gathered/decided yet) is the expected pre-launch state and yields an
 * empty set, not an error. */
export function existingRowIds(dir = OOS_ARM_DIR) {
  const ids = new Set();
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return ids;
  }
  for (const name of names) {
    if (!/^decisions-.*\.jsonl$/.test(name)) continue;
    let text;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const row = JSON.parse(line);
        if (typeof row?.rowId === 'string') ids.add(row.rowId);
      } catch {
        // A malformed already-recorded line is not this gather step's problem to repair — skipped.
      }
    }
  }
  return ids;
}

/** Refuses (throws) when candidate rows span more than one distinct non-null playbook_version — see
 * module header. Rows with a null playbook_version are ignored by this check (they carry no version
 * to conflict with); an all-null batch is fine and yields `null` (no content lookup performed). */
export function assertSingleVersion(rows) {
  const versions = new Set(
    rows.map((r) => r.playbook_version).filter((v) => v !== null && v !== undefined),
  );
  if (versions.size > 1) {
    throw new Error(
      `loop-oos-arm-gather: candidate rows span ${versions.size} distinct playbook_version values ` +
        `(${[...versions].join(', ')}) — a promotion landed mid-window. Refusing rather than picking ` +
        'one version to misattribute to the others; re-gather on the next decide-leg firing.',
    );
  }
  return versions.size === 1 ? [...versions][0] : null;
}

export function gatherCandidates(opts = {}) {
  const cwd = opts.cwd ?? REPO_ROOT;
  const nowMs = opts.nowMs ?? readNowMsFromDb({ cwd, nowRes: opts.nowRes });
  if (nowMs === null) {
    throw new Error('loop-oos-arm-gather: could not read the database clock — refusing to gather');
  }

  const rowsRes = opts.rowsRes ?? psql(buildCandidatesSql(nowMs), { cwd });
  const rawRows = parseJsonLines(rowsRes);
  if (rawRows === null) {
    throw new Error('loop-oos-arm-gather: candidates query failed or returned unparseable rows');
  }

  const already = opts.existingRowIds ?? existingRowIds(opts.oosArmDir ?? OOS_ARM_DIR);
  const fresh = rawRows.filter((r) => typeof r.id === 'string' && !already.has(r.id));

  const version = assertSingleVersion(fresh);
  let playbookContent = '';
  if (version !== null) {
    const contentRes = opts.playbookContentRes ?? psql(buildPlaybookContentSql(version), { cwd });
    const contentRows = parseJsonLines(contentRes);
    if (contentRows === null || contentRows.length === 0) {
      throw new Error(
        `loop-oos-arm-gather: no agent_playbook_versions row found for version=${version} — ` +
          'refusing to gather rows this pass cannot compose a faithful playbook block for',
      );
    }
    playbookContent = String(contentRows[0].content ?? '');
  }

  return {
    gatheredAtMsFromDb: nowMs,
    playbookContent,
    rows: fresh.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      eventTime: Number(r.event_time),
      venue: r.venue,
      playbookVersion:
        r.playbook_version === null || r.playbook_version === undefined
          ? null
          : Number(r.playbook_version),
      inputPayload:
        typeof r.input_payload === 'string'
          ? r.input_payload
          : JSON.stringify(r.input_payload ?? {}),
    })),
  };
}

function main() {
  const outPath = process.env['OOS_ARM_CANDIDATES_FILE'];
  if (!outPath) {
    throw new Error('loop-oos-arm-gather: OOS_ARM_CANDIDATES_FILE is required');
  }
  const candidates = gatherCandidates();
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(candidates), 'utf8');
  process.stdout.write(
    `loop-oos-arm-gather: wrote ${candidates.rows.length} candidate row(s) to ${outPath} ` +
      `(gatheredAtMsFromDb=${candidates.gatheredAtMsFromDb})\n`,
  );
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    process.stderr.write(
      `loop-oos-arm-gather: FATAL ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}
