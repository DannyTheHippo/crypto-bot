#!/usr/bin/env node
// REALISED entry forward return — the I/O shell. Gathers two reads out of `agent_decisions` through
// scripts/loop-transport.mjs and hands them to the pure core (loop-forward-return-core.mjs), which
// owns every judgement. This file makes no decision about the data beyond "did the read succeed".
//
// FAILURE DIRECTION — MEASUREMENT, FAILS OPEN. Annotations only; no alarms, no gate, no exit code
// that could stop a pass. `main()` exits non-zero only if the TOOL ITSELF crashes, never because the
// measurement came out unfavourable, and `forwardReturnAnnotations()` (what loop-sweep.mjs merges)
// swallows even that into a named annotation so a broken measurement can never block the sweep that
// carries it.
//
// WHY THIS IS NOT GATED ON THE APP BEING UP: postgres is durable and stays up when the app does not.
// Gating the read on container health would convert an app outage into a SILENT VOID READ — the sweep
// would print nothing and the absence would look like "no divergence". The two probes below run
// unconditionally; only a transport failure voids them, and it voids them BY NAME.
//
// WHY IT IS OUT OF computeSweep: same argument as classifyUnrecordedSweeps (loop-sweep-core.mjs:21-24)
// — computeSweep's output feeds the watermark, and a watermark carrying a bootstrap CI would be
// nonsense. This is merged into `result.annotations` by the sweep runner instead.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { psql } from './loop-transport.mjs';
import {
  HORIZONS,
  REPLAY_REFERENCE,
  computeForwardReturn,
  renderForwardReturn,
  sweepAnnotations,
} from './loop-forward-return-core.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');

// The FLAT-population marker, as a SQL literal. Kept as one string so it cannot drift from the core's
// FLAT_MARKER by a stray character; `strpos` rather than LIKE so no wildcard escaping is involved.
const FLAT_MARKER_SQL = '\'"position":{"side":"FLAT"\'';

// `replay-%` MUST stay excluded: scripts/replay-agentic.mjs journals SYNTHETIC rows into this same
// live table, and without the filter a backfill scores as live behaviour. Same BY-FILTER exclusion
// loop-sweep.mjs's realDecides probe applies for the same reason.
// `trigger_kind = 'candle'` is load-bearing, not cosmetic — see the core header: an exec-triggered row
// stamps a FILL time, so its event_time is not a bar open and its close belongs to an earlier bar.
const ENTRY_SQL =
  'select event_time, venue, symbol, action, coalesce(playbook_version, -1),' +
  ` case when strpos(coalesce(input_payload, ''), ${FLAT_MARKER_SQL}) > 0 then 1 else 0 end` +
  " from agent_decisions where action in ('open_long','open_short')" +
  " and strategy_id not like 'replay-%' and trigger_kind = 'candle'" +
  ' order by event_time, venue, symbol';

// NO action filter: holds and prescreen rows are exactly what make the grid dense (one row per symbol
// per bar), and without them the series would have a hole at every bar the lane did not trade.
// Bounded below by the first entry — bars before the first entry can never be a forward bar for it.
const GRID_SQL =
  'select event_time, venue, symbol, close from agent_decisions' +
  " where trigger_kind = 'candle' and close is not null and strategy_id not like 'replay-%'" +
  ' and event_time >= coalesce((select min(event_time) from agent_decisions' +
  " where action in ('open_long','open_short') and strategy_id not like 'replay-%'" +
  " and trigger_kind = 'candle'), 0)" +
  ' order by venue, symbol, event_time';

// psql -At emits pipe-separated rows. Empty stdout is ZERO ROWS (a determinate reading), which is why
// it returns [] here and only a transport failure returns null — the core treats the two differently
// and the whole point of this measurement is that it never confuses them.
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

export function gatherForwardReturn(opts = {}) {
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
          // -1 is the coalesce sentinel for a NULL playbook_version — mapped back to null here so the
          // core reports it as "(none)" rather than as a real version numbered -1.
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

  return { entryRows, gridRows, entryError: entryRes?.ok ? null : (entryRes?.error ?? null) };
}

/**
 * Shape-validates the frozen replay table before the core is allowed to compare against it.
 *
 * This is the "reference unreadable" path and it is a real guard, not a formality: if an edit drops a
 * horizon or fat-fingers a value into a string, the comparison must VOID BY NAME rather than silently
 * compare live returns against `undefined` and report no divergence — which would read exactly like
 * agreement.
 */
export function validateReference(table) {
  if (!table || typeof table !== 'object') return null;
  const out = {};
  for (const [version, ref] of Object.entries(table)) {
    if (!ref || typeof ref !== 'object' || !ref.predicted) return null;
    for (const h of HORIZONS) {
      if (!Number.isFinite(ref.predicted[h])) return null;
    }
    out[version] = ref;
  }
  return out;
}

export function runForwardReturn(opts = {}) {
  const { entryRows, gridRows } = gatherForwardReturn(opts);
  return computeForwardReturn({
    entryRows,
    gridRows,
    reference: validateReference(opts.reference ?? REPLAY_REFERENCE),
  });
}

/**
 * What loop-sweep.mjs merges into `result.annotations`. Wrapped so this measurement can never abort
 * the sweep: a throw here becomes an annotation naming itself, which is the fail-open direction (a
 * broken measurement must not block the thing it measures).
 */
export function forwardReturnAnnotations(opts = {}) {
  try {
    return sweepAnnotations(runForwardReturn(opts));
  } catch (err) {
    return [
      {
        kind: 'forward_return_tool_failed',
        detail:
          'the realised-entry-forward-return measurement threw and produced NO reading: ' +
          `${err instanceof Error ? err.message : String(err)} — this is a void read, not a clean one`,
      },
    ];
  }
}

function main() {
  process.stdout.write(renderForwardReturn(runForwardReturn()) + '\n');
}

// CLI entry-point guard: an `import` (the spec suite imports the helpers above) must NOT fire a
// blocking pair of database reads as an import side effect.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    process.stderr.write(
      `loop-forward-return: FATAL ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}
