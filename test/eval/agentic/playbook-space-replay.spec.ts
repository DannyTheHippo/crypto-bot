// Call site for the playbook-space replay engine, preregistered in
// research/studies/playbook-space-replay-2026-07-28.md.
//
// TWO MODES, deliberately:
//   - default (no env): the FREE preconditions only — corpus manifest, arm reachability under the
//     live validator, and the scorer sanity gate. No network, no spend. These run under
//     `pnpm eval:agentic` so the harness cannot rot silently between paid runs.
//   - PLAYBOOK_SPACE=1 (+ ANTHROPIC_API_KEY): the paid run, ~4,632 calls, ~$46 against a $90 cap.
//
// The paid run is skipped rather than failed when its env is absent — a research harness that turns
// a missing key into a red suite would push someone toward deleting it.

import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALPHA,
  BONFERRONI_CELLS,
  HORIZONS,
  MIN_ENTRIES,
  MIN_TRANSPORT_RATE,
  REQUIRED_EDGE_BPS,
  assertArmsAreReachable,
  computeCell,
  corpusManifest,
  fwdBps,
  loadCorpus,
  loadRecordedEntries,
  loadSeries,
  preflightCanSpend,
  resolveArms,
  runReplay,
  scoreRecordedEntries,
  verdictFor,
  type CorpusRow,
  type Observation,
} from './playbook-space-replay';

const OUT_DIR = join(process.cwd(), 'research', 'candidates');

// The ENTRIES verdict this study must overturn, and the tolerance the preregistration fixed.
const ENTRIES_VERDICT_H1_BPS = -16.9;
const SCORER_TOLERANCE_BPS = 0.5;

const PAID = process.env.PLAYBOOK_SPACE === '1';
const API_KEY = process.env.ANTHROPIC_API_KEY ?? '';

// The 2.7 MB payload corpus stays gitignored (repo convention: research corpora are dumped on demand
// via scripts/dump-eval-corpus.mjs, never committed). Its checks therefore SKIP with a visible reason
// rather than fail on a fresh clone. The 6 KB recorded-entry index IS committed, so the scorer sanity
// gate — the check that validates this study's arithmetic — always runs.
const CORPUS_PRESENT = existsSync(
  join(process.cwd(), 'test/eval/agentic/data/corpus-v3-flat.jsonl'),
);

describe('playbook-space replay — free preconditions', () => {
  it.runIf(CORPUS_PRESENT)('loads the frozen corpus and reports its manifest', () => {
    const rows = loadCorpus();
    const manifest = corpusManifest(rows);
    console.log(`corpus manifest: ${JSON.stringify(manifest)}`);
    expect(manifest.rows).toBe(386);
    expect(manifest.symbols).toBe(26);
    // Every row must carry a payload — a blank one would silently become a "hold" for every arm and
    // dilute the entry rate without ever surfacing as a failure.
    expect(rows.every((r) => r.inputPayload.length > 0)).toBe(true);
  });

  it('every arm is reachable — the live validator accepts it', () => {
    const arms = resolveArms();
    expect(arms).toHaveLength(12);
    // Throws with the arm name and the validator's own reason if any arm is unreachable.
    assertArmsAreReachable(arms);
    for (const { arm, content } of arms) {
      expect(content.length).toBeGreaterThan(200);
      expect(arm.tests.length).toBeGreaterThan(0);
    }
  });

  it.runIf(CORPUS_PRESENT)('every corpus symbol has candle coverage', () => {
    const rows = loadCorpus();
    const series = loadSeries(rows.map((r) => r.symbol));
    // A missing series would silently drop paid rows from scoring rather than fail — so it is
    // checked BEFORE any money is spent, not discovered in the results table afterwards.
    const uncovered = [...new Set(rows.map((r) => r.symbol))].filter((s) => !series.has(s));
    expect(uncovered).toEqual([]);
  });

  it('SCORER SANITY GATE: agrees with inversion-test.mjs on the identical entry population', () => {
    // The gate is AGREEMENT BETWEEN TWO INDEPENDENT IMPLEMENTATIONS on the same rows — not equality
    // with a constant computed on a different one. The first version of this gate scored the
    // FLAT-only study corpus (a strict subset) against the full population's −16.9 and failed at
    // −16.23; the assertion was wrong, not the arithmetic. See loadRecordedEntries' own comment.
    const entries = loadRecordedEntries();
    const series = loadSeries(entries.map((r) => r.symbol));
    const scored = scoreRecordedEntries(entries, series, 1);
    console.log(
      `scorer sanity (full entry population): n=${scored.n} mean=${scored.meanBps.toFixed(2)}bps at h=1`,
    );
    expect(scored.n).toBe(61);
    expect(Math.abs(scored.meanBps - ENTRIES_VERDICT_H1_BPS)).toBeLessThan(SCORER_TOLERANCE_BPS);
  });

  it.runIf(CORPUS_PRESENT)(
    "reports the study corpus's own baseline, which legally differs from the population's",
    () => {
      const rows = loadCorpus();
      const series = loadSeries(rows.map((r) => r.symbol));
      const scored = scoreRecordedEntries(rows, series, 1);
      console.log(
        `study-corpus baseline (FLAT-only subset): n=${scored.n} mean=${scored.meanBps.toFixed(2)}bps at h=1`,
      );
      // Documented, not asserted tightly: the subset is smaller and its mean is its own quantity. The
      // only real requirement is that it is still solidly negative — if this ever reads positive, the
      // premise of the whole study has changed and the run must stop.
      expect(scored.n).toBeGreaterThanOrEqual(55);
      expect(scored.meanBps).toBeLessThan(0);
    },
  );

  it('reports the frozen bar so a reader never has to reconstruct it', () => {
    expect(REQUIRED_EDGE_BPS).toBe(13.0);
    expect(BONFERRONI_CELLS).toBe(48);
    // Exact equality, not toBeCloseTo — a significance threshold is a frozen constant, and the
    // repo-wide ban on approximate assertions is the right rule to inherit here.
    expect(ALPHA).toBe(0.05 / 48);
    expect(MIN_ENTRIES).toBe(12);
    expect([...HORIZONS]).toEqual([1, 4, 8, 24]);
  });
});

describe.runIf(PAID && API_KEY.length > 0 && CORPUS_PRESENT)(
  'playbook-space replay — PAID run',
  () => {
    it(
      'replays 12 arms over the frozen corpus and renders the verdict',
      async () => {
        const rows: readonly CorpusRow[] = loadCorpus();
        const series = loadSeries(rows.map((r) => r.symbol));
        const arms = resolveArms();
        assertArmsAreReachable(arms);

        const manifest = corpusManifest(rows);
        console.log(`\ncorpus: ${manifest.rows} rows, ${manifest.symbols} symbols`);
        console.log(`payload sha256: ${manifest.payloadSha256}`);
        console.log(`arms: ${arms.map((a) => a.arm.name).join(', ')}\n`);

        const model = process.env.PLAYBOOK_SPACE_MODEL ?? 'claude-sonnet-5';
        // Moonshot exposes an ANTHROPIC-COMPATIBLE surface at /anthropic, so the identical
        // replayPlanRow request shape reaches kimi with nothing but a baseUrl + key swap — no
        // second code path, and therefore no chance of the two legs drifting apart.
        const baseUrl = process.env.PLAYBOOK_SPACE_BASE_URL ?? 'https://api.anthropic.com';
        // ONE call before thousands. Runs 1 and 2 (2026-07-28) both burned through the corpus
        // discovering mid-run that the account could not pay; the old pre-flight checked that a key
        // EXISTED, never that it could SPEND.
        const preflight = await preflightCanSpend(API_KEY, model, baseUrl);
        if (!preflight.ok) {
          throw new Error(
            `PRE-FLIGHT FAILED — the API refused a 1-token probe with HTTP ${preflight.status}. ` +
              `No paid call was made. Detail: ${preflight.detail}`,
          );
        }
        console.log('pre-flight: API accepted a 1-token probe — proceeding\n');

        const run = await runReplay(
          rows,
          arms,
          {
            apiKey: API_KEY,
            model,
            baseUrl,
            timeoutMs: 120_000,
            sizeFractionMax: '0.25',
            shortsEnabled: true,
            rowsPerChunk: Number(process.env.PLAYBOOK_SPACE_CHUNK ?? 40),
            concurrency: Number(process.env.PLAYBOOK_SPACE_CONCURRENCY ?? 4),
            capUsd: process.env.PLAYBOOK_SPACE_CAP_USD ?? '90',
            reservePerCallUsd: '0.05',
            onProgress: (m) => console.log(`  ${m}`),
          },
          fetch,
        );

        console.log(
          `\nrun: rowsCovered=${run.rowsCovered}/${rows.length} (common to ALL arms) calls=${run.meter.calls} spend=$${run.meter.usd}` +
            `${run.aborted ? ' ABORTED ON BUDGET — partial, not complete' : ''}`,
        );
        console.log(
          `transport: ok=${run.transport.ok} 429=${run.transport.rateLimited} 5xx=${run.transport.serverError} ` +
            `otherHttp=${run.transport.otherHttp} net=${run.transport.networkError} retries=${run.transport.retries}`,
        );
        console.log(
          `transport rate: ${run.completion.transported}/${run.completion.total} = ` +
            `${(run.completion.transportRate * 100).toFixed(1)}% (VOID floor ${(MIN_TRANSPORT_RATE * 100).toFixed(0)}%)`,
        );
        console.log(
          `schema-valid rate: ${run.completion.parsed}/${run.completion.transported} = ` +
            `${(run.completion.schemaRate * 100).toFixed(1)}% — REPORTED, never gating (model behaviour)\n`,
        );

        if (run.transport.billingStop !== null) {
          throw new Error(
            `RUN ABORTED — the provider reported an unrecoverable billing state and the run stopped ` +
              `immediately rather than retrying it. Detail: ${run.transport.billingStop}`,
          );
        }

        if (run.voided) {
          // Fails CLOSED on TRANSPORT only. Run 1 (2026-07-28) made all 4,632 calls, reported
          // aborted=false, and printed a clean NO_SURVIVOR table off a ~13% transport rate — the arm
          // means came from whichever small, non-random subsample landed before the credit ran out.
          // A run like that must never reach the results table, so this throws rather than reports.
          // A low SCHEMA rate deliberately does NOT trip this: that is the model talking.
          throw new Error(
            `RUN VOID — transport ${(run.completion.transportRate * 100).toFixed(1)}% is below the ` +
              `${(MIN_TRANSPORT_RATE * 100).toFixed(0)}% floor ` +
              `(429=${run.transport.rateLimited}, 5xx=${run.transport.serverError}, ` +
              `otherHttp=${run.transport.otherHttp}, net=${run.transport.networkError}). ` +
              `No verdict may be published from this run.`,
          );
        }

        const byId = new Map(rows.map((r) => [r.id, r]));
        const table: Record<string, unknown>[] = [];
        const passes: string[] = [];

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
          const changed = results.filter((r) => {
            const champ = (run.perArm.get('champion_v8') ?? []).find((c) => c.rowId === r.rowId);
            return champ !== undefined && champ.action !== r.action;
          }).length;

          for (const h of HORIZONS) {
            const obs: Observation[] = [];
            for (const e of entries) {
              const v = fwdBps(series, e.symbol, e.eventTime, h, e.dir);
              if (v !== null) obs.push({ symbol: e.symbol, bps: v });
            }
            // Seed varies per cell so no two cells share a resampling stream, but is a pure function of
            // (arm, horizon) so the whole run reproduces exactly.
            const seed = 20260728 + arm.name.length * 1000 + h;
            const stats = computeCell(
              obs,
              entries.map((e) => ({ symbol: e.symbol, dir: e.dir })),
              series,
              h,
              seed,
            );
            const { verdict, failedClause } = verdictFor(stats);
            if (verdict === 'PASS') passes.push(`${arm.name}@h${h}`);
            table.push({
              arm: arm.name,
              tests: arm.tests,
              h,
              rowsParsed: parsed.length,
              entryRate: parsed.length > 0 ? entries.length / parsed.length : 0,
              decisionsChangedVsChampion: changed,
              ...stats,
              verdict,
              failedClause,
            });
          }
        }

        console.log(
          'arm                  h   n   clus  mean      CI                 p        placebo  halves            trim     verdict',
        );
        console.log('-'.repeat(126));
        for (const r of table) {
          const s = r as unknown as {
            arm: string;
            h: number;
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
            `${s.arm.padEnd(20)} ${String(s.h).padEnd(3)} ${String(s.n).padEnd(3)} ${String(s.clusters).padEnd(4)} ` +
              `${f(s.mean, 8)} [${f(s.ciLo)},${f(s.ciHi)}] ${s.pVsBar.toFixed(4).padStart(7)} ` +
              `${s.placeboP.toFixed(4).padStart(7)}  ${f(s.firstHalf, 7)}/${f(s.secondHalf, 7)} ${f(s.trimmed)}  ${s.verdict}`,
          );
        }
        console.log('-'.repeat(126));
        console.log(
          passes.length === 0
            ? `\nVERDICT: NO SURVIVOR — 0 of ${table.length} cells clear +${REQUIRED_EDGE_BPS} bps on every clause.`
            : `\nVERDICT: SURVIVOR — ${passes.length} cell(s): ${passes.join(', ')}`,
        );

        mkdirSync(OUT_DIR, { recursive: true });
        // Trial-scoped filename: the champion and kimi legs are SEPARATE registered trials
        // (Amendment 3), so they must never overwrite each other's results.
        const trialId = `playbook-space-replay-${model}-2026-07-28`;
        const outFile = join(OUT_DIR, `${trialId}.json`);
        writeFileSync(
          outFile,
          JSON.stringify(
            {
              study: trialId,
              model,
              baseUrl,
              manifest,
              run: {
                rowsAttempted: run.rowsAttempted,
                rowsCovered: run.rowsCovered,
                corpusRows: rows.length,
                aborted: run.aborted,
                transport: run.transport,
                completion: run.completion,
                ...run.meter,
              },
              bar: {
                requiredEdgeBps: REQUIRED_EDGE_BPS,
                alpha: ALPHA,
                bonferroniCells: BONFERRONI_CELLS,
                minEntries: MIN_ENTRIES,
              },
              cells: table,
              passes,
              verdict: passes.length === 0 ? 'NO_SURVIVOR' : 'SURVIVOR',
            },
            null,
            2,
          ),
          'utf8',
        );
        console.log(`\nwrote ${outFile}`);

        // The run is only INVALID if it produced nothing at all — a clean NO SURVIVOR is the expected
        // and valuable outcome, never a test failure.
        expect(table.length).toBe(BONFERRONI_CELLS);
        expect(byId.size).toBe(rows.length);
      },
      6 * 60 * 60 * 1000,
    );
  },
);
