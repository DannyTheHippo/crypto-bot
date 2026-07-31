#!/usr/bin/env node
// HOLD-MATCHED HORIZON RE-SCORE — the I/O shell. Gathers the SAME two reads out of `agent_decisions`
// loop-forward-return.mjs uses (same ENTRY_SQL/GRID_SQL, duplicated below rather than imported — that
// runner does not export them, and editing it is out of scope for this pass; keep the two in sync by
// hand if the journal-close convention ever changes) and hands them to the pure core
// (loop-horizon-rescore-core.mjs), which owns every judgement. This file makes no decision about the
// data beyond "did the read succeed".
//
// FAILURE DIRECTION — MEASUREMENT, FAILS OPEN. Prints a report; exits non-zero only if the TOOL ITSELF
// crashes, never because a re-scored number came out unfavourable or a control check failed — a failed
// control is loud in the printed annotations, which is the correct place for a human to see it.
//
// Standalone research tool, off the production gate (root CLAUDE.md § Research), same as
// loop:forward-return. Not wired into loop-sweep.mjs — this is a one-off re-score, not a standing probe.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { psql } from './loop-transport.mjs';
import { computeHorizonRescore, renderHorizonRescore } from './loop-horizon-rescore-core.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');

// Identical to loop-forward-return.mjs's FLAT_MARKER_SQL/ENTRY_SQL/GRID_SQL — same data source, same
// invariants (trigger_kind='candle' only; replay-% excluded; forward returns walk wall-clock via the
// core's forwardBps, never array indices). See that file's header for the five-reason close-convention
// proof this depends on.
const FLAT_MARKER_SQL = '\'"position":{"side":"FLAT"\'';

const ENTRY_SQL =
  'select event_time, venue, symbol, action, coalesce(playbook_version, -1),' +
  ` case when strpos(coalesce(input_payload, ''), ${FLAT_MARKER_SQL}) > 0 then 1 else 0 end` +
  " from agent_decisions where action in ('open_long','open_short')" +
  " and strategy_id not like 'replay-%' and trigger_kind = 'candle'" +
  ' order by event_time, venue, symbol';

const GRID_SQL =
  'select event_time, venue, symbol, close from agent_decisions' +
  " where trigger_kind = 'candle' and close is not null and strategy_id not like 'replay-%'" +
  ' and event_time >= coalesce((select min(event_time) from agent_decisions' +
  " where action in ('open_long','open_short') and strategy_id not like 'replay-%'" +
  " and trigger_kind = 'candle'), 0)" +
  ' order by venue, symbol, event_time';

function parseRows(res, arity) {
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

export function gatherHorizonRescore(opts = {}) {
  const cwd = opts.cwd ?? REPO_ROOT;
  const entryRes = opts.entryRes ?? psql(ENTRY_SQL, { cwd });
  const gridRes = opts.gridRes ?? psql(GRID_SQL, { cwd });

  const entryParts = parseRows(entryRes, 6);
  const gridParts = parseRows(gridRes, 4);

  const entryRows =
    entryParts === null
      ? null
      : entryParts.map((p) => ({
          eventTime: Number(p[0]),
          venue: p[1],
          symbol: p[2],
          action: p[3],
          playbookVersion: Number(p[4]) === -1 ? null : Number(p[4]),
          isFlat: p[5] === '1',
        }));
  const gridRows =
    gridParts === null
      ? null
      : gridParts.map((p) => ({
          eventTime: Number(p[0]),
          venue: p[1],
          symbol: p[2],
          close: Number(p[3]),
        }));

  return { entryRows, gridRows };
}

export function runHorizonRescore(opts = {}) {
  const { entryRows, gridRows } = gatherHorizonRescore(opts);
  return computeHorizonRescore({ entryRows, gridRows });
}

function main() {
  process.stdout.write(renderHorizonRescore(runHorizonRescore()) + '\n');
}

// CLI entry-point guard: an `import` (the spec suite imports the helpers above) must NOT fire a
// blocking pair of database reads as an import side effect.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    process.stderr.write(
      `loop-horizon-rescore: FATAL ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}
