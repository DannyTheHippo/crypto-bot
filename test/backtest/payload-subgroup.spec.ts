import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import {
  ALPHA_CELL,
  ALPHA_FAMILY,
  BOOTSTRAP_SEED,
  CUTS,
  DECLARED_CELLS,
  FEATURES,
  HORIZONS,
  MAX_GAP_SHARE,
  MIN_CLUSTERS,
  MIN_ENTRIES,
  N_BOOT,
  N_PLACEBO,
  PLACEBO_SEED,
  UNDERPOWERED_READING,
  baseAssetsOf,
  buildGrid,
  extractEntries,
  renderCell,
  runPlacebo,
  scoreCells,
  type EntryRow,
  type GridRow,
} from './payload-features';

// ── Payload-microstructure subgroup search ───────────────────────────────────────────────────────
//
// Pre-registration: research/studies/payload-microstructure-prereg-2026-08-04.md — written and frozen
// BEFORE this file existed. Every family, feature, cut, horizon, threshold and the 64-cell Bonferroni
// denominator come from that document; this spec gathers rows and renders, and owns no knob.
//
// Question: the standing "no edge in anything the system records" verdict rests on a subgroup search
// bounded by PERSISTED pgTable columns. Four microstructure channels plus funding term structure are
// rendered into the model's user message on every consult and hit no table, so that search
// structurally could not condition on them. `agent_decisions.input_payload` embeds those blocks on
// every entry row, so the search is possible today at $0 — no API calls, no network, no LLM.
//
// A powered positive would LOCALIZE the standing claim (which was scoped to recorded columns), not
// contradict it. A null is the expected outcome and is reported whichever way it points.
//
// Gated like the sibling live studies (frame-audit.spec.ts:36-38): PAYLOAD_SUBGROUP=1 + DATABASE_URL,
// self-skipping so a clean clone stays green and it never joins the production gate (`pnpm test`
// covers test/features test/domain test/ports test/livegate; this lives under test/backtest).
// READ-ONLY against agent_decisions — never a write, never a migration, never a reset.

const RUN = process.env['PAYLOAD_SUBGROUP'] === '1';
const DB_URL = process.env['DATABASE_URL'];
const OUT_FILE = process.env['PAYLOAD_SUBGROUP_OUTPUT_FILE'];

// The frozen population (pre-registration §1). LIFETIME — no time filter. `replay-%` MUST stay
// excluded: scripts/replay-agentic.mjs journals SYNTHETIC rows into this same live table, and without
// the filter a backfill would score as live behaviour. `trigger_kind='candle'` is load-bearing: an
// exec-triggered row stamps a FILL time, so its event_time is not a bar open
// (scripts/loop-forward-return-core.mjs:33-38).
const ENTRY_SQL = `
  SELECT event_time, venue, symbol, action, input_payload
    FROM agent_decisions
   WHERE action IN ('open_long','open_short')
     AND trigger_kind = 'candle'
     AND strategy_id NOT LIKE 'replay-%'
   ORDER BY event_time, venue, symbol`;

// NO action filter: holds and prescreen rows are what make the grid dense (one row per symbol per
// bar), and without them the series would have a hole at every bar the lane did not trade.
const GRID_SQL = `
  SELECT event_time, venue, symbol, close
    FROM agent_decisions
   WHERE trigger_kind = 'candle'
     AND close IS NOT NULL
     AND strategy_id NOT LIKE 'replay-%'
   ORDER BY venue, symbol, event_time`;

describe.skipIf(!RUN || !DB_URL)(
  'payload-subgroup: do the unpersisted microstructure blocks separate forward returns',
  () => {
    it('scores the frozen 64-cell grid over the lifetime entry population', async () => {
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: DB_URL });
      const lines: string[] = [];
      try {
        const entryRes = await pool.query<{
          event_time: string;
          venue: string;
          symbol: string;
          action: string;
          input_payload: string | null;
        }>(ENTRY_SQL);
        const gridRes = await pool.query<{
          event_time: string;
          venue: string;
          symbol: string;
          close: string;
        }>(GRID_SQL);

        const entryRows: EntryRow[] = entryRes.rows.map((r) => ({
          eventTime: Number(r.event_time),
          venue: r.venue,
          symbol: r.symbol,
          action: r.action,
          payloadText: r.input_payload,
        }));
        const gridRows: GridRow[] = gridRes.rows.map((r) => ({
          eventTime: Number(r.event_time),
          venue: r.venue,
          symbol: r.symbol,
          close: Number(r.close),
        }));

        const extraction = extractEntries(entryRows);
        const grid = buildGrid(gridRows);
        const entries = extraction.entries;
        const anchors = entries.map((e) => e.eventTime);
        const scored = scoreCells(entries, grid.series, anchors, {
          nBoot: N_BOOT,
          seed: BOOTSTRAP_SEED,
        });
        const placebo = runPlacebo(entries, grid.series, scored.maxAbsDelta, {
          realizations: N_PLACEBO,
          seed: PLACEBO_SEED,
        });

        const powered = scored.cells.filter((c) => c.powered);
        const underpowered = scored.cells.filter((c) => !c.powered);
        const hits = powered.filter((c) => c.excludesZero);
        const bases = baseAssetsOf(entries.map((e) => e.symbol));

        lines.push(
          '[payload-subgroup] pre-registration: ' +
            'research/studies/payload-microstructure-prereg-2026-08-04.md',
          `declaredCells=${DECLARED_CELLS} (features=${FEATURES.length} x cuts=${CUTS.length} ` +
            `x horizons=${HORIZONS.length}) alphaFamily=${ALPHA_FAMILY} alphaCell=${ALPHA_CELL} ` +
            `bootstrapCoverage=${((1 - ALPHA_CELL) * 100).toFixed(6)}%`,
          `nBoot=${N_BOOT} bootstrapSeed=${BOOTSTRAP_SEED} placeboSeed=${PLACEBO_SEED} ` +
            `nPlacebo=${N_PLACEBO} minEntries=${MIN_ENTRIES} minClusters=${MIN_CLUSTERS} ` +
            `maxGapShare=${MAX_GAP_SHARE}`,
          '',
          '--- population ---',
          `entryRowsRead=${entryRows.length} scored=${entries.length} ` +
            `unparseablePayload=${extraction.unparseable} noPayload=${extraction.noPayload} ` +
            `unusable=${extraction.unusable} offGrid=${extraction.offGrid}`,
          `longs=${entries.filter((e) => e.dir === 1).length} ` +
            `shorts=${entries.filter((e) => e.dir === -1).length} ` +
            `symbols=${new Set(entries.map((e) => e.symbol)).size} baseAssets=${bases}`,
          `gridRowsRead=${gridRows.length} series=${grid.series.size} rejected=${grid.rejected} ` +
            `offGrid=${grid.offGrid}`,
          '',
          '--- feature presence over the scored entries (the 80% bar is a pre-registration gate) ---',
          ...FEATURES.map((f) => {
            const n = extraction.presence.get(f.id) ?? 0;
            const share = entries.length === 0 ? 0 : (n / entries.length) * 100;
            const med = scored.medians.get(f.id);
            return (
              `  ${f.id} ${f.family}.${f.label.padEnd(38)} present=${String(n).padStart(3)}/` +
              `${entries.length} (${share.toFixed(1)}%) alignedMedian=` +
              `${med === undefined ? 'n/a' : med.toPrecision(6)}`
            );
          }),
          '',
          '--- horizon accounting (pending is benign and excluded from the gap denominator) ---',
          ...scored.horizons.map(
            (a) =>
              `  h=${String(a.h).padStart(2)} ok=${a.ok} gap=${a.gap} pending=${a.pending} ` +
              `no-series=${a.noSeries} no-entry-bar=${a.noEntryBar} bad-price=${a.badPrice} ` +
              `gapShare=${(a.gapShare * 100).toFixed(1)}% ` +
              `${a.undetermined ? 'UNDETERMINED — all 16 cells at this horizon are void' : 'scored'}`,
          ),
          '',
          `--- cells (${scored.cells.length} scored of ${DECLARED_CELLS} declared; ` +
            `powered=${powered.length} underpowered=${underpowered.length}) ---`,
          ...scored.cells.map((c) => `  ${renderCell(c)}`),
          '',
          '--- placebo (random-bar; feature values, groups, clusters and direction all held fixed) ---',
          `observedMaxAbsDelta=${scored.maxAbsDelta.toFixed(2)} bps over ${scored.cells.length} ` +
            `scored cells; ${placebo.realizations} realizations, ` +
            `${placebo.atLeastAsExtreme} at least as extreme; familywise p=${placebo.p.toFixed(4)} ` +
            `(placeboNoSeries=${placebo.noSeries})`,
          '',
          '--- verdict (pre-registration §10: POWERED and interval excludes 0 and placebo p <= 0.05) ---',
          hits.length === 0
            ? 'NULL — no powered cell has a Bonferroni-corrected interval excluding 0. Reported as ' +
                'the expected outcome, not as a failure.'
            : hits.map((c) => `  CANDIDATE ${renderCell(c)}`).join('\n'),
          hits.length > 0 && placebo.p > 0.05
            ? `  ...but the family-wise placebo p=${placebo.p.toFixed(4)} > 0.05, so clause 3 of the ` +
                'verdict rule FAILS and no cell is POSITIVE.'
            : '',
          '',
          `Underpowered cells read: ${UNDERPOWERED_READING}`,
        );

        const out = lines.filter((l) => l !== '').join('\n');
        console.log(out);
        if (OUT_FILE) writeFileSync(OUT_FILE, `${out}\n`, 'utf8');

        // The study must actually have measured something. The VERDICT is recorded by hand in the
        // pre-registration's Results section, never asserted here — a green test must never imply a
        // positive result, and a red one must never be the price of an unfavourable reading.
        expect(DECLARED_CELLS).toBe(64);
        expect(entries.length).toBeGreaterThan(0);
        expect(grid.series.size).toBeGreaterThan(0);
        expect(scored.cells.length).toBeGreaterThan(0);
      } finally {
        await pool.end();
      }
    }, 600_000);
  },
);
