// Call site for `arm-sweep-v1`, preregistered in
// research/studies/learning-capacity-2026-07-31.md § 7a — frozen 2026-07-31T21:55Z, before any paid
// call. Not an edit of playbook-space-replay.{ts,spec.ts} (a DIFFERENT, earlier-frozen study, dated
// 2026-07-28): this study tests two arms neither of which are in that study's funded design at h=16
// (a horizon that engine's own HORIZONS constant does not include), so it gets its own call site that
// REUSES that engine's frozen primitives (runReplay, computeCell, verdictFor, fwdBps, the USD meter,
// the transport/faithfulness guards) rather than duplicating or editing them.
//
// Arms under test (2, both from playbook-space-arms.ts, unedited): `shorts_only` (primary hypothesis)
// and `meanrev_pure`. Model: claude-sonnet-5 only (matches the incumbent — no model axis here, so no
// kimi leg). Corpus: corpus-v3-flat.jsonl (386 rows), chosen for comparability with champion_v8.
// Horizons: h in {1,4,8,16,24}, h=16 PRIMARY. Bar: the unchanged research bar (mean/CI/p/placebo/
// halves/trimmed > +13.0 bps, n>=12 AND clusters>=5) — verdictFor implements every clause except the
// clusters floor, so `withPowerGate` below adds exactly that one clause and changes nothing else.
//
// THREE MODES, run in this order (calibrate, then size, then run — a planning constant carried into a
// budget is exactly what reversed the kimi cost estimate from 0.61x to 1.9x, per the study doc):
//   - default (no env): free preconditions — corpus manifest, spot/perp split (the structural ceiling
//     on shorts_only's entry population), arm reachability, the frozen bar echoed. No network, no
//     spend.
//   - ARM_SWEEP_CALIBRATE=1: both arms over ~30 rows, capped at ARM_SWEEP_CALIBRATE_CAP_USD (default
//     $2). Measures $/call and each arm's entry rate; projects n at full corpus depth and REFUSES
//     (throws) to record a funding recommendation for an arm whose projection cannot reach
//     MIN_ENTRIES=12 — that refusal is the sizing gate working, not a defect.
//   - ARM_SWEEP_FULL=1: reads the calibration file, refuses to fund (throws) any arm named in
//     ARM_SWEEP_ARMS whose calibrated entry rate cannot project to n>=12 on the full corpus, then
//     replays the funded arms at full depth and scores every horizon.
//
// FAILURE DIRECTION: a measurement harness gating nothing and authorising nothing (identical posture
// to playbook-space-replay.ts's own header). Fails LOUD and CLOSED on a broken precondition (corpus
// fingerprint drift between the calibration and full legs, an unfaithful-capabilities row, a voided
// transport rate, an unfunded arm someone tried to run anyway) rather than emitting a number dressed
// as evidence.

import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MIN_ENTRIES,
  MIN_TRANSPORT_RATE,
  REQUIRED_EDGE_BPS,
  assertArmsAreReachable,
  computeCell,
  corpusManifest,
  fwdBps,
  loadCorpus,
  loadSeries,
  preflightCanSpend,
  resolveArms,
  runReplay,
  selectArms,
  strideSample,
  verdictFor,
  type CellStats,
  type CorpusRow,
  type Observation,
  type Verdict,
} from './playbook-space-replay';
import { recordedCapabilities } from '../../../src/features/strategy/agentic/entry-rate-floor';

const OUT_DIR = join(process.cwd(), 'research', 'candidates');
const CALIBRATION_FILE = join(OUT_DIR, 'arm-sweep-v1-calibration.json');
const RESULTS_FILE = join(OUT_DIR, 'arm-sweep-v1-results.json');

// ── frozen, declared before any paid call (§ 7a) ────────────────────────────────────────────────────
export const STUDY_ARMS = ['shorts_only', 'meanrev_pure'] as const;
export const MODEL = 'claude-sonnet-5';
export const HORIZONS = [1, 4, 8, 16, 24] as const;
export const PRIMARY_HORIZON = 16;
/** Not a module constant in playbook-space-replay.ts (that engine's callers never checked it); the
 * pre-registration's own bar text names it explicitly, so it is declared here rather than folded
 * silently into a modified `verdictFor`. */
export const MIN_CLUSTERS = 5;
/** Family = 2 arms x 5 horizons = 10 cells, declared before any result — fixed regardless of whether
 * both arms end up funded, since shrinking the family after seeing which arm the sizing gate refused
 * would loosen the bar for the surviving one. */
export const FAMILY_CELLS = STUDY_ARMS.length * HORIZONS.length;
export const ALPHA = 0.05 / FAMILY_CELLS;
export const CALIBRATION_ROWS = 30;

const CALIBRATE = process.env.ARM_SWEEP_CALIBRATE === '1';
const FULL = process.env.ARM_SWEEP_FULL === '1';
const API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const BASE_URL = process.env.PLAYBOOK_SPACE_BASE_URL ?? 'https://api.anthropic.com';
const CORPUS_PRESENT = existsSync(
  join(process.cwd(), 'test/eval/agentic/data/corpus-v3-flat.jsonl'),
);

interface ArmCalibration {
  readonly rows: number;
  readonly calls: number;
  readonly parsed: number;
  readonly entries: number;
  readonly entryRate: number;
  readonly distinctEntrySymbols: number;
  /** Point-estimate projection at full corpus depth — the number the sizing gate reads. */
  readonly projectedN: number;
  readonly sizingGate: 'FUNDABLE' | 'UNDERPOWERED_PROJECTION';
}

interface Calibration {
  readonly rows: number;
  readonly corpusRows: number;
  readonly corpusSha256: string;
  readonly usdPerCall: number;
  readonly totalUsd: string;
  readonly totalCalls: number;
  readonly transportRate: number;
  readonly spotPerpSplit: {
    readonly spot: number;
    readonly perp: number;
    readonly unknown: number;
  };
  readonly arms: Readonly<Record<string, ArmCalibration>>;
}

/** verdictFor implements every bar clause except the clusters floor the pre-registration also names. */
function withPowerGate(
  s: CellStats,
  alpha: number,
): { readonly verdict: Verdict; readonly failedClause: string | null } {
  if (s.clusters < MIN_CLUSTERS) {
    return { verdict: 'UNDERPOWERED', failedClause: `clusters=${s.clusters} < ${MIN_CLUSTERS}` };
  }
  return verdictFor(s, alpha);
}

function spotPerpSplit(rows: readonly CorpusRow[]): {
  spot: number;
  perp: number;
  unknown: number;
} {
  let spot = 0;
  let perp = 0;
  let unknown = 0;
  for (const r of rows) {
    const caps = recordedCapabilities(r.inputPayload);
    if (caps === undefined) unknown += 1;
    else if (caps.shorts) perp += 1;
    else spot += 1;
  }
  return { spot, perp, unknown };
}

describe('arm-sweep-v1 — free preconditions', () => {
  it.runIf(CORPUS_PRESENT)(
    'reports the corpus manifest, the spot/perp split, and the frozen bar',
    () => {
      const rows = loadCorpus();
      const manifest = corpusManifest(rows);
      const split = spotPerpSplit(rows);
      console.log(`\ncorpus manifest: ${JSON.stringify(manifest)}`);
      console.log(
        `spot/perp split: spot=${split.spot} perp=${split.perp} unknown=${split.unknown} ` +
          `(shorts_only's entry ceiling is the perp population)`,
      );
      console.log(
        `bar: mean/CI/p/placebo/halves/trimmed > +${REQUIRED_EDGE_BPS}bps, n>=${MIN_ENTRIES} AND ` +
          `clusters>=${MIN_CLUSTERS}, alpha=${ALPHA} (family=${FAMILY_CELLS}), primary h=${PRIMARY_HORIZON}`,
      );
      expect(manifest.rows).toBe(386);
      expect(split.spot + split.perp + split.unknown).toBe(386);
    },
  );

  it('both study arms are reachable — the live validator accepts them', () => {
    const arms = selectArms(resolveArms(), [...STUDY_ARMS]);
    assertArmsAreReachable(arms);
    expect(arms).toHaveLength(2);
  });
});

// ── CALIBRATION: ~30 rows, both arms, <=$2 ─────────────────────────────────────────────────────────
describe.runIf(CALIBRATE && API_KEY.length > 0 && CORPUS_PRESENT)(
  'arm-sweep-v1 — CALIBRATION leg',
  () => {
    it(
      'measures $/call and each arm entry rate, and projects the sizing gate',
      async () => {
        const corpus = loadCorpus();
        const manifest = corpusManifest(corpus);
        const split = spotPerpSplit(corpus);
        const rows = strideSample(corpus, CALIBRATION_ROWS);
        const arms = selectArms(resolveArms(), [...STUDY_ARMS]);
        assertArmsAreReachable(arms);

        console.log(
          `\ncalibration: model=${MODEL} rows=${rows.length} arms=${STUDY_ARMS.join(', ')}`,
        );
        const preflight = await preflightCanSpend(API_KEY, MODEL, BASE_URL);
        if (!preflight.ok) {
          throw new Error(
            `PRE-FLIGHT FAILED — HTTP ${preflight.status}, no paid call made. Detail: ${preflight.detail}`,
          );
        }

        const run = await runReplay(
          rows,
          arms,
          {
            apiKey: API_KEY,
            model: MODEL,
            baseUrl: BASE_URL,
            timeoutMs: Number(process.env.PLAYBOOK_SPACE_TIMEOUT_MS ?? 120_000),
            sizeFractionMax: '0.25',
            shortsEnabled: true,
            rowsPerChunk: rows.length,
            concurrency: Number(process.env.PLAYBOOK_SPACE_CONCURRENCY ?? 4),
            capUsd: process.env.ARM_SWEEP_CALIBRATE_CAP_USD ?? '2',
            reservePerCallUsd: '0.05',
            onProgress: (m) => console.log(`  ${m}`),
          },
          fetch,
        );

        if (run.unfaithfulCapsRows > 0) {
          throw new Error(
            `RUN VOID — ${run.unfaithfulCapsRows} row(s) replayed with capabilities the live system ` +
              `did not record.`,
          );
        }
        if (run.transport.billingStop !== null) {
          throw new Error(`RUN ABORTED — billing state: ${run.transport.billingStop}`);
        }

        const armCalibrations: Record<string, ArmCalibration> = {};
        for (const { arm } of arms) {
          const results = run.perArm.get(arm.name) ?? [];
          const parsed = results.filter((r) => r.ok);
          const entryRows = parsed.filter(
            (r) => r.action === 'open_long' || r.action === 'open_short',
          );
          const entryRate = parsed.length === 0 ? 0 : entryRows.length / parsed.length;
          const projectedN = Math.round(entryRate * manifest.rows);
          armCalibrations[arm.name] = {
            rows: results.length,
            calls: results.length,
            parsed: parsed.length,
            entries: entryRows.length,
            entryRate,
            distinctEntrySymbols: new Set(entryRows.map((r) => r.symbol)).size,
            projectedN,
            sizingGate: projectedN >= MIN_ENTRIES ? 'FUNDABLE' : 'UNDERPOWERED_PROJECTION',
          };
        }

        const usdPerCall = run.meter.calls === 0 ? 0 : Number(run.meter.usd) / run.meter.calls;
        const calibration: Calibration = {
          rows: rows.length,
          corpusRows: manifest.rows,
          corpusSha256: manifest.payloadSha256,
          usdPerCall,
          totalUsd: run.meter.usd,
          totalCalls: run.meter.calls,
          transportRate: run.completion.transportRate,
          spotPerpSplit: split,
          arms: armCalibrations,
        };

        console.log(
          `\n  spend        $${calibration.totalUsd} over ${calibration.totalCalls} calls`,
        );
        console.log(`  $/call       $${usdPerCall.toFixed(6)}`);
        console.log(
          `  transport    ${(calibration.transportRate * 100).toFixed(1)}% (VOID floor ${(MIN_TRANSPORT_RATE * 100).toFixed(0)}%)`,
        );
        for (const [name, c] of Object.entries(armCalibrations)) {
          console.log(
            `  ${name.padEnd(14)} entryRate=${(c.entryRate * 100).toFixed(1)}% ` +
              `(${c.entries}/${c.parsed}) distinctSymbols=${c.distinctEntrySymbols} ` +
              `projectedN@${manifest.rows}rows=${c.projectedN} -> ${c.sizingGate}`,
          );
        }

        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(CALIBRATION_FILE, JSON.stringify(calibration, null, 2), 'utf8');
        console.log(`\nwrote ${CALIBRATION_FILE}`);

        expect(run.completion.transportRate).toBeGreaterThanOrEqual(MIN_TRANSPORT_RATE);
      },
      30 * 60 * 1000,
    );
  },
);

// ── FULL LEG: only the arm(s) named in ARM_SWEEP_ARMS, and only if the sizing gate clears ─────────
describe.runIf(FULL && API_KEY.length > 0 && CORPUS_PRESENT)('arm-sweep-v1 — FULL leg', () => {
  it(
    'replays the funded arm(s) at full corpus depth and scores h in {1,4,8,16,24}',
    async () => {
      const fundedNames = (process.env.ARM_SWEEP_ARMS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (fundedNames.length === 0) {
        throw new Error(
          'ARM_SWEEP_ARMS is required (comma-separated arm names) — refusing to guess.',
        );
      }
      for (const n of fundedNames) {
        if (!STUDY_ARMS.includes(n as (typeof STUDY_ARMS)[number])) {
          throw new Error(
            `ARM_SWEEP_ARMS names ${n}, which is not one of ${STUDY_ARMS.join(', ')}`,
          );
        }
      }

      if (!existsSync(CALIBRATION_FILE)) {
        throw new Error(`no calibration at ${CALIBRATION_FILE} — run ARM_SWEEP_CALIBRATE=1 first.`);
      }
      const calibration = JSON.parse(readFileSync(CALIBRATION_FILE, 'utf8')) as Calibration;

      const corpus = loadCorpus();
      const series = loadSeries(corpus.map((r) => r.symbol));
      const manifest = corpusManifest(corpus);
      if (calibration.corpusSha256 !== manifest.payloadSha256) {
        throw new Error(
          `corpus fingerprint mismatch — calibration was measured on ${calibration.corpusSha256.slice(0, 12)}, ` +
            `this corpus is ${manifest.payloadSha256.slice(0, 12)}. Re-calibrate; the projection does not transfer.`,
        );
      }

      // THE SIZING GATE, enforced, not just reported: an arm whose calibrated entry rate cannot
      // project to MIN_ENTRIES on the full corpus is refused here even if named in ARM_SWEEP_ARMS.
      for (const name of fundedNames) {
        const c = calibration.arms[name];
        if (c === undefined) {
          throw new Error(`no calibration recorded for arm ${name} — cannot size its funding.`);
        }
        if (c.sizingGate !== 'FUNDABLE') {
          throw new Error(
            `SIZING GATE REFUSES ${name} — projected n=${c.projectedN} < ${MIN_ENTRIES} at the ` +
              `calibrated entry rate (${(c.entryRate * 100).toFixed(1)}%). Buying a guaranteed-` +
              `UNDERPOWERED cell is refused; remove it from ARM_SWEEP_ARMS.`,
          );
        }
      }

      const arms = selectArms(resolveArms(), fundedNames);
      assertArmsAreReachable(arms);
      const rows = strideSample(corpus, corpus.length); // full depth, chronological order preserved

      console.log(`\nfull leg: model=${MODEL} rows=${rows.length} arms=${fundedNames.join(', ')}`);
      const preflight = await preflightCanSpend(API_KEY, MODEL, BASE_URL);
      if (!preflight.ok) {
        throw new Error(
          `PRE-FLIGHT FAILED — HTTP ${preflight.status}, no paid call made. Detail: ${preflight.detail}`,
        );
      }

      const capUsd = process.env.ARM_SWEEP_FULL_CAP_USD;
      if (capUsd === undefined) {
        throw new Error(
          'ARM_SWEEP_FULL_CAP_USD is required — refusing to run without an explicit cap.',
        );
      }

      const run = await runReplay(
        rows,
        arms,
        {
          apiKey: API_KEY,
          model: MODEL,
          baseUrl: BASE_URL,
          timeoutMs: Number(process.env.PLAYBOOK_SPACE_TIMEOUT_MS ?? 120_000),
          sizeFractionMax: '0.25',
          shortsEnabled: true,
          rowsPerChunk: Number(process.env.ARM_SWEEP_CHUNK ?? 40),
          concurrency: Number(process.env.PLAYBOOK_SPACE_CONCURRENCY ?? 4),
          capUsd,
          reservePerCallUsd: '0.05',
          onProgress: (m) => console.log(`  ${m}`),
        },
        fetch,
      );

      console.log(
        `\nrun: rowsCovered=${run.rowsCovered}/${rows.length} calls=${run.meter.calls} spend=$${run.meter.usd}` +
          `${run.aborted ? ' ABORTED ON BUDGET — partial, not complete' : ''}`,
      );
      console.log(
        `transport: ok=${run.transport.ok} 429=${run.transport.rateLimited} 5xx=${run.transport.serverError} ` +
          `otherHttp=${run.transport.otherHttp} net=${run.transport.networkError} retries=${run.transport.retries}`,
      );
      console.log(
        `transport rate: ${(run.completion.transportRate * 100).toFixed(1)}% (VOID floor ${(MIN_TRANSPORT_RATE * 100).toFixed(0)}%)`,
      );

      if (run.unfaithfulCapsRows > 0) {
        throw new Error(
          `RUN VOID — ${run.unfaithfulCapsRows} row(s) replayed with capabilities the live system did not record.`,
        );
      }
      if (run.transport.billingStop !== null) {
        throw new Error(`RUN ABORTED — billing state: ${run.transport.billingStop}`);
      }
      if (run.voided) {
        throw new Error(
          `RUN VOID — transport ${(run.completion.transportRate * 100).toFixed(1)}% is below the ` +
            `${(MIN_TRANSPORT_RATE * 100).toFixed(0)}% floor. No verdict may be published from this run.`,
        );
      }

      const table: Record<string, unknown>[] = [];
      for (const { arm } of arms) {
        const results = run.perArm.get(arm.name) ?? [];
        const parsed = results.filter((r) => r.ok);
        const entries: { symbol: string; eventTime: number; dir: 1 | -1 }[] = parsed
          .filter((r) => r.action === 'open_long' || r.action === 'open_short')
          .map((r) => ({
            symbol: r.symbol,
            eventTime: r.eventTime,
            dir: r.action === 'open_short' ? -1 : 1,
          }));

        for (const h of HORIZONS) {
          const obs: Observation[] = [];
          for (const e of entries) {
            const v = fwdBps(series, e.symbol, e.eventTime, h, e.dir);
            if (v !== null) obs.push({ symbol: e.symbol, bps: v, eventTime: e.eventTime });
          }
          const seed = 20260731 + arm.name.length * 1000 + h;
          const stats = computeCell(
            obs,
            entries.map((e) => ({ symbol: e.symbol, dir: e.dir })),
            series,
            h,
            seed,
          );
          const { verdict, failedClause } = withPowerGate(stats, ALPHA);
          table.push({
            model: MODEL,
            arm: arm.name,
            h,
            primary: h === PRIMARY_HORIZON,
            rowsParsed: parsed.length,
            entryRate: parsed.length > 0 ? entries.length / parsed.length : 0,
            ...stats,
            verdict,
            failedClause,
          });
        }
      }

      console.log(
        '\narm            h    n   clus  mean      CI                 p        placebo  halves            trim     verdict',
      );
      console.log('-'.repeat(130));
      for (const r of table) {
        const s = r as unknown as {
          arm: string;
          h: number;
          primary: boolean;
          n: number;
          clusters: number;
          mean: number;
          ciLo: number;
          ciHi: number;
          pVsBar: number;
          placeboP: number;
          firstHalf: number;
          secondHalf: number;
          trimmed: number;
          verdict: string;
        };
        const f = (x: number, w = 7): string =>
          (Number.isFinite(x) ? x.toFixed(1) : 'n/a').padStart(w);
        console.log(
          `${s.arm.padEnd(14)} ${String(s.h).padEnd(4)}${s.primary ? '*' : ' '} ${String(s.n).padEnd(3)} ${String(s.clusters).padEnd(4)} ` +
            `${f(s.mean, 8)} [${f(s.ciLo)},${f(s.ciHi)}] ${s.pVsBar.toFixed(4).padStart(7)} ` +
            `${s.placeboP.toFixed(4).padStart(7)}  ${f(s.firstHalf, 7)}/${f(s.secondHalf, 7)} ${f(s.trimmed)}  ${s.verdict}`,
        );
      }
      console.log('-'.repeat(130));
      console.log('(* = primary horizon h=16)\n');

      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(
        RESULTS_FILE,
        JSON.stringify(
          {
            study: 'arm-sweep-v1',
            prereg: 'research/studies/learning-capacity-2026-07-31.md § 7a',
            model: MODEL,
            fundedArms: fundedNames,
            manifest,
            run: {
              rowsAttempted: run.rowsAttempted,
              rowsCovered: run.rowsCovered,
              aborted: run.aborted,
              transport: run.transport,
              completion: run.completion,
              ...run.meter,
            },
            bar: {
              requiredEdgeBps: REQUIRED_EDGE_BPS,
              alpha: ALPHA,
              familyCells: FAMILY_CELLS,
              minEntries: MIN_ENTRIES,
              minClusters: MIN_CLUSTERS,
              primaryHorizon: PRIMARY_HORIZON,
            },
            cells: table,
          },
          null,
          2,
        ),
        'utf8',
      );
      console.log(`wrote ${RESULTS_FILE}`);

      expect(table.length).toBe(fundedNames.length * HORIZONS.length);
    },
    6 * 60 * 60 * 1000,
  );
});
