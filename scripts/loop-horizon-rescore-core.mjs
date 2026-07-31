#!/usr/bin/env node
// HOLD-MATCHED HORIZON RE-SCORE — pure core. Re-scores the LIVE playbook-version arms already read by
// loop-forward-return.mjs at two additional horizons chosen to match how long the book actually holds
// a position, rather than the grid {1,4,8,24} inherited from playbook-space-replay.ts:46 with no
// reference to realised holding time.
//
// WHY h=16 AND h=54 — measured 2026-07-31 off the live book (n=40 closes, last 10 days): median
// holding period 234.4 min = 15.6 bars -> h=16; mean holding period 817.3 min = 54.5 bars -> h=54.
// h=24 (6h, the deepest DECLARED horizon) is the only control column anywhere near the median, and the
// mean hold runs PAST every declared horizon — every arm in every study has therefore been scored
// substantially off the book's actual behaviour. Re-scoring is arithmetic on already-recorded data for
// the live arms (part A below); it is NOT free for the offline replay cells (part B) — see the SCOPE
// note.
//
// REUSE, NOT REWRITE: this module owns NO price-grid construction and NO bootstrap of its own. Every
// numeric primitive below — buildGrid, forwardBps, computeCell (and through it clusterBootstrap) — is
// imported verbatim from loop-forward-return-core.mjs, which owns the close-convention proof and the
// bootstrap's cluster-floor rationale. Re-deriving either here would be exactly the kind of drift that
// makes two "should always agree" tools quietly disagree. Only the HORIZON SET and the ordering/
// control-reproduction checks below are new.
//
// FAILURE DIRECTION — MEASUREMENT, FAILS OPEN, same as the module it reuses. No `alarms` key; a broken
// control check or a large gap-share regression is loud in the ANNOTATIONS, never a thrown error or a
// process exit that could block anything downstream.
//
// SCOPE: this module re-scores the LIVE arms (agent_decisions) only. The OFFLINE replay cells in
// research/scorecards/playbook-space-followon-2026-07-31.json cannot be re-scored at a new horizon
// from what is on disk — checked 2026-07-31: test/eval/agentic/playbook-space-replay.spec.ts builds a
// per-row `entries` array (symbol/eventTime/dir, e.g. spec:900-906 and :2276-2282) at replay time, but
// only ever writes the per-(arm,horizon) AGGREGATE `table` to research/candidates/*.json
// (spec:1017, :2479-onward) — the per-row action/direction never reaches disk. Re-scoring those cells
// at h=16/h=54 needs a fresh paid replay run, not arithmetic on recorded data.

import {
  BAR_MS,
  MIN_ENTRIES,
  MIN_CLUSTERS,
  MAX_GAP_SHARE,
  FLAT_MARKER,
  POPULATIONS,
  buildGrid,
  forwardBps,
  computeCell,
} from './loop-forward-return-core.mjs';

export { BAR_MS, MIN_ENTRIES, MIN_CLUSTERS, MAX_GAP_SHARE, FLAT_MARKER, POPULATIONS };

/** The declared grid this loop has scored on since inception (playbook-space-replay.ts:46). Kept as
 * the CONTROL set: every number at these horizons must reproduce loop-forward-return.mjs exactly, or
 * this module's own numbers earn no trust. */
export const CONTROL_HORIZONS = [1, 4, 8, 24];

/** The two hold-matched horizons this module adds — see header for the 2026-07-31 measurement. */
export const NEW_HORIZONS = [16, 54];

export const HORIZONS = [...CONTROL_HORIZONS, ...NEW_HORIZONS];

/** The ordering-flip and gap-regression checks compare each NEW horizon against this one — the deepest
 * DECLARED horizon, and the only one of the four anywhere near the measured median hold. */
export const ORDERING_REFERENCE_HORIZON = 24;

/** A NEW horizon's gap share is flagged when it exceeds the reference horizon's by more than this many
 * percentage points — one order of magnitude below MAX_GAP_SHARE itself, so the flag fires well before
 * a horizon is anywhere near the 20% UNDETERMINED floor and well above ordinary sampling noise. */
export const GAP_REGRESSION_MARGIN = 0.1;

/**
 * The h=1 figures `pnpm loop:forward-return` printed for playbook_version 1 and 2 on 2026-07-31 —
 * transcribed, not re-derived, the same way REPLAY_REFERENCE in the sibling module is frozen. This is
 * the control this module must reproduce before any h=16/h=54 number is trustworthy: a re-score that
 * cannot reproduce the OLD grid is broken, not informative.
 */
export const CONTROL_REFERENCE = {
  1: { mean: -16.9, ciLo: -28.5, ciHi: -4.9, n: 28, clusters: 13 },
  2: { mean: -15.9, ciLo: -25.1, ciHi: -5.5, n: 18, clusters: 11 },
};

function annotation(kind, detail) {
  return { kind, detail };
}

const fmtBps = (v) =>
  v === null || !Number.isFinite(v) ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(1)} bps`;

/** Round-to-the-printed-precision equality — CONTROL_REFERENCE was transcribed at 1dp, so a match at
 * that precision IS the reproduction the brief asks for, not an approximation of it. */
function matchesAtPrintedPrecision(actual, expected) {
  if (actual === null || !Number.isFinite(actual)) return false;
  return Number(actual.toFixed(1)) === expected;
}

/**
 * Compares the h=1 cell of a panel against CONTROL_REFERENCE, when a reference exists for that
 * playbook version. Returns null when there is nothing to check — no reference for this version, or
 * the cell was never powered in the first place (CONTROL_REFERENCE only pins POWERED figures).
 */
function controlCheckFor(version, h1Cell) {
  const ref = version === null ? undefined : CONTROL_REFERENCE[version];
  if (!ref || !h1Cell || !h1Cell.powered) return null;
  const mismatches = ['mean', 'ciLo', 'ciHi'].filter(
    (f) => !matchesAtPrintedPrecision(h1Cell[f], ref[f]),
  );
  if (h1Cell.n !== ref.n) mismatches.push('n');
  if (h1Cell.clusters !== ref.clusters) mismatches.push('clusters');
  return {
    version,
    reference: ref,
    actual: {
      mean: h1Cell.mean,
      ciLo: h1Cell.ciLo,
      ciHi: h1Cell.ciHi,
      n: h1Cell.n,
      clusters: h1Cell.clusters,
    },
    reproduced: mismatches.length === 0,
    mismatches,
  };
}

/**
 * Pairwise ranking of every two playbook versions with a POWERED cell at BOTH the reference horizon
 * (h=24, the declared grid's deepest column) and a NEW hold-matched horizon, per population. A pair
 * whose relative order (which version has the higher mean) differs between the two horizons is a FLIP
 * — the headline this tool exists to surface, because a call made off the declared grid could be
 * favouring the arm the book's actual holding time does not support.
 *
 * Deliberately restricted to POWERED cells on BOTH sides: an "order" built from an underpowered mean
 * is not a ranking, it is a coin flip dressed as one, and a flip detected there would be exactly the
 * kind of unattributable point estimate the sibling module refuses to let out unlabelled.
 */
export function computeOrderingFlips(panels) {
  const flips = [];
  for (const population of POPULATIONS) {
    const ofPop = panels.filter((p) => p.population === population);
    const refMeans = new Map();
    for (const p of ofPop) {
      const h = p.horizons.find((x) => x.h === ORDERING_REFERENCE_HORIZON);
      if (h && h.cell && h.cell.powered) refMeans.set(p.playbookVersion, h.cell.mean);
    }
    for (const comparedHorizon of NEW_HORIZONS) {
      const compMeans = new Map();
      for (const p of ofPop) {
        const h = p.horizons.find((x) => x.h === comparedHorizon);
        if (h && h.cell && h.cell.powered) compMeans.set(p.playbookVersion, h.cell.mean);
      }
      const versions = [...refMeans.keys()].filter((v) => compMeans.has(v));
      for (let i = 0; i < versions.length; i += 1) {
        for (let j = i + 1; j < versions.length; j += 1) {
          const a = versions[i];
          const b = versions[j];
          const refOrder = refMeans.get(a) > refMeans.get(b);
          const compOrder = compMeans.get(a) > compMeans.get(b);
          if (refOrder !== compOrder) {
            flips.push({
              population,
              a,
              b,
              comparedHorizon,
              atReference: refOrder ? `v${a}>v${b}` : `v${b}>v${a}`,
              atCompared: compOrder ? `v${a}>v${b}` : `v${b}>v${a}`,
            });
          }
        }
      }
    }
  }
  return flips;
}

/**
 * @param entryRows  Same shape loop-forward-return.mjs gathers: [{ eventTime, venue, symbol, action,
 *                   playbookVersion, isFlat }] or null when the probe failed.
 * @param gridRows   [{ eventTime, venue, symbol, close }] or null when the probe failed.
 * Never throws. Returns { status, panels, orderingFlips, annotations } and deliberately no `alarms`
 * key — see the header's failure-direction note.
 */
export function computeHorizonRescore({ entryRows, gridRows } = {}) {
  const annotations = [];

  if (!Array.isArray(entryRows)) {
    annotations.push(
      annotation(
        'horizon_rescore_entry_probe_failed',
        'the entry probe against agent_decisions returned no readable rows — this is NOT "no entries", ' +
          'it is no reading at all, and nothing below was measured',
      ),
    );
    return { status: 'undetermined', panels: [], orderingFlips: [], annotations };
  }
  if (!Array.isArray(gridRows)) {
    annotations.push(
      annotation(
        'horizon_rescore_grid_probe_failed',
        'the price-grid probe against agent_decisions returned no readable rows — forward prices are ' +
          'unavailable, so no horizon was scored (NOT a zero return)',
      ),
    );
    return { status: 'undetermined', panels: [], orderingFlips: [], annotations };
  }

  const { series, rejected, offGrid } = buildGrid(gridRows);
  if (rejected > 0) {
    annotations.push(
      annotation(
        'horizon_rescore_grid_rows_rejected',
        `${rejected} price-grid row(s) carried an unusable venue/symbol/close and were dropped — the ` +
          'cells below cover the rest only',
      ),
    );
  }
  if (offGrid > 0) {
    annotations.push(
      annotation(
        'horizon_rescore_grid_rows_off_bar',
        `${offGrid} price-grid row(s) had an event_time off the ${BAR_MS / 60000}m bar grid and were ` +
          'dropped — on a candle trigger event_time is the bar OPEN, so an off-grid row is not the bar ' +
          'the close convention describes',
      ),
    );
  }

  const entries = [];
  let entriesOffGrid = 0;
  let entriesUnusable = 0;
  for (const r of entryRows) {
    if (!r || typeof r.venue !== 'string' || typeof r.symbol !== 'string') {
      entriesUnusable += 1;
      continue;
    }
    const t0 = Number(r.eventTime);
    const dir = r.action === 'open_long' ? 1 : r.action === 'open_short' ? -1 : null;
    if (!Number.isFinite(t0) || dir === null) {
      entriesUnusable += 1;
      continue;
    }
    if (t0 % BAR_MS !== 0) {
      entriesOffGrid += 1;
      continue;
    }
    entries.push({
      t0,
      venue: r.venue,
      symbol: r.symbol,
      dir,
      playbookVersion:
        r.playbookVersion === null || r.playbookVersion === undefined
          ? null
          : Number(r.playbookVersion),
      isFlat: r.isFlat === true,
    });
  }
  if (entriesUnusable > 0) {
    annotations.push(
      annotation(
        'horizon_rescore_entries_unreadable',
        `${entriesUnusable} entry row(s) carried an unusable venue/symbol/event_time/action and were ` +
          'not scored — the panels below cover the rest only',
      ),
    );
  }
  if (entriesOffGrid > 0) {
    annotations.push(
      annotation(
        'horizon_rescore_entries_off_bar',
        `${entriesOffGrid} entry row(s) had an event_time off the ${BAR_MS / 60000}m grid and were not ` +
          'scored — an exec-triggered row stamps a FILL time, whose close belongs to an earlier bar',
      ),
    );
  }

  const flatCount = entries.filter((e) => e.isFlat).length;
  const flatMarkerVoid = entries.length > 0 && flatCount === 0;
  if (flatMarkerVoid) {
    annotations.push(
      annotation(
        'horizon_rescore_flat_marker_absent',
        `${entries.length} entries exist but ZERO carry the FLAT payload marker (${FLAT_MARKER}) — the ` +
          'payload shape has almost certainly changed. flat_only reads UNDETERMINED, NOT n=0',
      ),
    );
  }

  const versions = [...new Set(entries.map((e) => e.playbookVersion))].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a - b;
  });

  const panels = [];
  for (const version of versions) {
    const ofVersion = entries.filter((e) => e.playbookVersion === version);
    const scaleIns = ofVersion.filter((e) => !e.isFlat).length;
    for (const population of POPULATIONS) {
      const pool = population === 'flat_only' ? ofVersion.filter((e) => e.isFlat) : ofVersion;
      const horizons = [];
      for (const h of HORIZONS) {
        const counts = { ok: 0, gap: 0, pending: 0, noSeries: 0, badPrice: 0, noEntryBar: 0 };
        const obs = [];
        for (const e of pool) {
          const r = forwardBps(series, e.venue, e.symbol, e.t0, h, e.dir);
          if (r.status === 'ok') {
            counts.ok += 1;
            obs.push({ symbol: e.symbol, venue: e.venue, t0: e.t0, bps: r.bps });
          } else if (r.status === 'gap') counts.gap += 1;
          else if (r.status === 'pending') counts.pending += 1;
          else if (r.status === 'no_series') counts.noSeries += 1;
          else if (r.status === 'no_entry_bar') counts.noEntryBar += 1;
          else if (r.status === 'bad_price') counts.badPrice += 1;
        }
        // `pending` excluded from the denominator on purpose — see loop-forward-return-core.mjs's
        // identical rationale: a horizon that has not elapsed yet is not a hole.
        const nonBenignMiss = counts.gap + counts.noSeries + counts.badPrice + counts.noEntryBar;
        const attempted = counts.ok + nonBenignMiss;
        const gapShare = attempted === 0 ? 0 : nonBenignMiss / attempted;

        if (population === 'flat_only' && flatMarkerVoid) {
          horizons.push({
            h,
            status: 'undetermined',
            reason: 'flat_marker_absent',
            counts,
            gapShare: null,
            cell: null,
            summary:
              'UNDETERMINED — the FLAT payload marker matched zero rows, so the replay-comparable ' +
              'population could not be identified (this is not n=0)',
          });
          continue;
        }
        if (attempted > 0 && gapShare > MAX_GAP_SHARE) {
          annotations.push(
            annotation(
              'horizon_rescore_horizon_gap_undetermined',
              `playbook_version=${version ?? '(none)'} population=${population} h=${h}: ` +
                `${nonBenignMiss} of ${attempted} elapsed entries had no usable forward bar ` +
                `(${(gapShare * 100).toFixed(0)}% > ${(MAX_GAP_SHARE * 100).toFixed(0)}%) — reads ` +
                'UNDETERMINED rather than reporting a subsample biased toward calm bars',
            ),
          );
          horizons.push({
            h,
            status: 'undetermined',
            reason: 'gap_share_exceeded',
            counts,
            gapShare,
            cell: null,
            summary:
              `UNDETERMINED — ${(gapShare * 100).toFixed(0)}% of elapsed entries had no usable ` +
              'forward bar; a mean over what survived would measure a different population',
          });
          continue;
        }

        const cell = computeCell(obs);
        if (!cell.powered) {
          annotations.push(
            annotation(
              'horizon_rescore_underpowered',
              `playbook_version=${version ?? '(none)'} population=${population} h=${h}: n=${cell.n} ` +
                `clusters=${cell.clusters} mean=${fmtBps(cell.mean)} — UNDERPOWERED, reported for ` +
                'completeness, not actionable',
            ),
          );
        }
        horizons.push({
          h,
          status: 'measured',
          reason: null,
          counts,
          gapShare,
          cell,
          summary:
            cell.n === 0
              ? `${cell.powered ? 'POWERED' : 'UNDERPOWERED'} — no entries scored`
              : `${cell.powered ? 'POWERED' : 'UNDERPOWERED'} mean=${fmtBps(cell.mean)} n=${cell.n} ` +
                `clusters=${cell.clusters}` +
                (cell.ciLo === null
                  ? ' no interval (below the cluster floor — a lattice artifact, not a CI)'
                  : ` 95% CI [${fmtBps(cell.ciLo)}, ${fmtBps(cell.ciHi)}]`),
        });
      }

      // Gap-share regression: does a NEW horizon run over a MATERIALLY more-gapped population than the
      // reference horizon, for this exact panel? Only meaningful once the reference itself measured
      // something — an already-undetermined reference has no baseline to regress against.
      const refHorizon = horizons.find((x) => x.h === ORDERING_REFERENCE_HORIZON);
      if (refHorizon && refHorizon.gapShare !== null) {
        for (const nh of NEW_HORIZONS) {
          const newHorizon = horizons.find((x) => x.h === nh);
          if (!newHorizon || newHorizon.gapShare === null) continue;
          if (newHorizon.gapShare - refHorizon.gapShare > GAP_REGRESSION_MARGIN) {
            annotations.push(
              annotation(
                'horizon_rescore_gap_regression',
                `playbook_version=${version ?? '(none)'} population=${population}: h=${nh} gap share ` +
                  `${(newHorizon.gapShare * 100).toFixed(0)}% is materially worse than ` +
                  `h=${ORDERING_REFERENCE_HORIZON}'s ${(refHorizon.gapShare * 100).toFixed(0)}% — h=${nh} ` +
                  'runs over a different, more-gapped population than the control horizon, not a ' +
                  'like-for-like comparison',
              ),
            );
          }
        }
      }

      const h1 = horizons.find((x) => x.h === 1);
      const controlCheck = controlCheckFor(version, h1 ? h1.cell : null);
      if (controlCheck && !controlCheck.reproduced) {
        annotations.push(
          annotation(
            'horizon_rescore_control_reproduction_failed',
            `playbook_version=${version} population=${population} h=1 did NOT reproduce the pinned ` +
              `pnpm loop:forward-return figures (mismatched: ${controlCheck.mismatches.join(', ')}) — ` +
              'this re-score is UNTRUSTED until the discrepancy is explained; do not read any ' +
              'h=16/h=54 number for this panel',
          ),
        );
      }

      panels.push({
        playbookVersion: version,
        population,
        entries: pool.length,
        scaleIns: population === 'all' ? scaleIns : 0,
        horizons,
        controlCheck,
      });
    }
  }

  if (entries.length === 0) {
    annotations.push(
      annotation(
        'horizon_rescore_no_entries',
        'the probe succeeded and returned zero scoreable entries — this IS a determinate reading, ' +
          'distinct from a failed probe above',
      ),
    );
  }

  const orderingFlips = computeOrderingFlips(panels);
  for (const f of orderingFlips) {
    annotations.push(
      annotation(
        'horizon_rescore_ordering_flip',
        `population=${f.population}: v${f.a} vs v${f.b} ORDER FLIPS between h=${ORDERING_REFERENCE_HORIZON} ` +
          `(${f.atReference}) and h=${f.comparedHorizon} (${f.atCompared}) — the ranking depends on which ` +
          'grid it is scored at, and the hold-matched horizon is the one the book actually experiences',
      ),
    );
  }

  return {
    status: panels.length > 0 ? 'measured' : 'undetermined',
    panels,
    orderingFlips,
    annotations,
  };
}

/** Renderable report. Kept here (pure) so the runner cannot assemble a number without its label. */
export function renderHorizonRescore(result) {
  const lines = ['## Hold-matched horizon re-score (LIVE arms)', ''];
  lines.push(
    '_Re-scores the declared grid {1,4,8,24} plus two hold-matched horizons {16,54} against the SAME ' +
      'live agent_decisions data loop-forward-return.mjs reads. Measurement only — annotations, never ' +
      'alarms._',
    '',
  );
  if (!result || !Array.isArray(result.panels)) return lines.join('\n');
  for (const p of result.panels) {
    lines.push(
      `### playbook_version=${p.playbookVersion ?? '(none)'} — population \`${p.population}\` ` +
        `(${p.entries} entr${p.entries === 1 ? 'y' : 'ies'}` +
        `${p.scaleIns > 0 ? `, incl. ${p.scaleIns} scale-in${p.scaleIns === 1 ? '' : 's'}` : ''})`,
    );
    if (p.controlCheck) {
      lines.push(
        p.controlCheck.reproduced
          ? '- **control h=1**: REPRODUCED pnpm loop:forward-return exactly'
          : `- **control h=1**: FAILED TO REPRODUCE (mismatched: ${p.controlCheck.mismatches.join(', ')})`,
      );
    }
    for (const h of p.horizons) {
      const c = h.counts;
      const marker = CONTROL_HORIZONS.includes(h.h) ? 'control' : 'NEW hold-matched';
      lines.push(
        `- h=${h.h} (${marker}): ${h.summary}` +
          ` [ok=${c.ok} gap=${c.gap} pending=${c.pending} no-series=${c.noSeries} ` +
          `no-entry-bar=${c.noEntryBar} bad-price=${c.badPrice}]`,
      );
    }
    lines.push('');
  }
  lines.push(
    result.orderingFlips.length === 0
      ? '### Ordering flips: NONE — every pairwise comparison of POWERED cells agrees between the ' +
          'declared grid and the hold-matched horizons.'
      : `### Ordering flips: ${result.orderingFlips.length} — a ranking made off the declared grid ` +
          'would have picked differently than the hold-matched horizon:',
  );
  for (const f of result.orderingFlips) {
    lines.push(
      `- population=${f.population}: v${f.a} vs v${f.b} — h=${ORDERING_REFERENCE_HORIZON} says ` +
        `${f.atReference}, h=${f.comparedHorizon} says ${f.atCompared}`,
    );
  }
  lines.push('');
  lines.push(
    '### (B) Offline replay cells (research/scorecards/playbook-space-followon-2026-07-31.json)',
    '',
    'NOT RE-SCORED — per-row action/direction is never persisted by ' +
      'test/eval/agentic/playbook-space-replay.spec.ts (only the per-arm/per-horizon AGGREGATE is ' +
      'written to research/candidates/*.json). Re-scoring haiku_swarm/haiku_single/champion_v8 at ' +
      "h=16/h=54 requires a fresh paid replay run, not arithmetic on recorded data. See this module's " +
      'header for the exact spec:line citations checked 2026-07-31.',
    '',
  );
  if (result.annotations.length > 0) {
    lines.push('### Annotations', '');
    for (const a of result.annotations) lines.push(`- **${a.kind}** — ${a.detail}`);
    lines.push('');
  }
  return lines.join('\n');
}
