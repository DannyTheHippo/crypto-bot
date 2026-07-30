// Call site for the playbook-space replay engine, preregistered in
// research/studies/playbook-space-replay-2026-07-28.md.
//
// FIVE MODES, in the order they must be run (Amendment 5):
//   - default (no env): the FREE preconditions and every unit check of the sizing rule. No network, no
//     spend. These run under `pnpm eval:agentic` so the harness cannot rot between paid runs.
//   - PLAYBOOK_SPACE_CALIBRATE=1: one arm over CALIBRATION_ROWS rows on ONE model, ~$1. Measures the
//     per-call cost, transport rate, schema rate and entry rate. Tests NO hypothesis — it exists
//     because the budget cannot be allocated without a measured cost, and the two costs on record
//     disagreed by 2.4x ($0.0163/call in the smoke run, $0.039668/call on the live decide path).
//   - PLAYBOOK_SPACE_SIZE=1: free, no network. Reads both calibration files, applies the frozen sizing
//     rule, writes the design. This is the moment the Bonferroni family is fixed.
//   - PLAYBOOK_SPACE=1: the paid edge run, which REFUSES to start without a design file on disk.
//   - PLAYBOOK_SPACE_LEVER=1: the lever tier — entry rate and decision change for all twelve arms, no
//     edge test and no family entry.
//
// The paid modes skip rather than fail when their env is absent — a research harness that turns a
// missing key into a red suite would push someone toward deleting it.

import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARM_PRIORITY,
  CALIBRATION_ROWS,
  DESIGN_FILE,
  FOLLOW_STUDY_BUDGET_USD,
  FULL_DESIGN_CELLS,
  HORIZONS,
  LEAD_STUDY_BUDGET_USD,
  LEVER_PROBE_ROWS,
  MAX_LEAD_ONLY_EDGE_ARMS,
  MAX_SHARED_EDGE_ARMS,
  MIN_EDGE_ROWS,
  MIN_ENTRIES,
  MIN_TRANSPORT_RATE,
  MODEL_AXIS,
  REQUIRED_EDGE_BPS,
  aggregateVerdict,
  alphaFor,
  assertArmPriorityCoversEveryArm,
  assertArmsAreReachable,
  assertDesignMatchesCorpus,
  bonferroniCells,
  computeCell,
  corpusManifest,
  edgeArmsFor,
  fwdBps,
  loadCorpus,
  loadDesign,
  loadRecordedEntries,
  loadSeries,
  preflightCanSpend,
  resolveArms,
  runReplay,
  scoreRecordedEntries,
  selectArms,
  sizeDesign,
  strideSample,
  verdictFor,
  writeDesign,
  type CorpusRow,
  type Observation,
  type LaneCell,
  type StudyDesign,
  type TransportStats,
} from './playbook-space-replay';

const OUT_DIR = join(process.cwd(), 'research', 'candidates');

// The ENTRIES verdict this study must overturn, and the tolerance the preregistration fixed.
const ENTRIES_VERDICT_H1_BPS = -16.9;
const SCORER_TOLERANCE_BPS = 0.5;

const PAID = process.env.PLAYBOOK_SPACE === '1';
const CALIBRATE = process.env.PLAYBOOK_SPACE_CALIBRATE === '1';
const SIZE = process.env.PLAYBOOK_SPACE_SIZE === '1';
const LEVER = process.env.PLAYBOOK_SPACE_LEVER === '1';
const VERDICT = process.env.PLAYBOOK_SPACE_VERDICT === '1';
const API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const MODEL = process.env.PLAYBOOK_SPACE_MODEL ?? MODEL_AXIS[0];
// Moonshot exposes an ANTHROPIC-COMPATIBLE surface at /anthropic, so the identical replayPlanRow
// request shape reaches kimi with nothing but a baseUrl + key swap — no second code path, and
// therefore no chance of the two legs drifting apart.
const BASE_URL = process.env.PLAYBOOK_SPACE_BASE_URL ?? 'https://api.anthropic.com';

const calibrationFile = (model: string): string =>
  join(OUT_DIR, `playbook-space-calibration-${model}.json`);

interface Calibration {
  readonly model: string;
  readonly baseUrl: string;
  readonly rows: number;
  readonly calls: number;
  readonly usd: string;
  readonly usdPerCall: number;
  /**
   * `usdPerCall` scaled by attempts-per-usable-response, and the figure the design is sized on.
   *
   * The meter can only price a response that carried a `usage` block, so the 22 empty-body 200s in the
   * 2026-07-30 kimi probe cost the meter nothing — while quite possibly costing the ACCOUNT something,
   * since the provider generated tokens before returning nothing. Whether Moonshot bills them is not
   * observable from here, so the budget assumes it does. Wrong in the safe direction: if they are free,
   * the study simply underspends.
   */
  readonly usdPerCallEffective: number;
  readonly transportRate: number;
  readonly schemaRate: number;
  readonly entryRate: number;
  /**
   * WHY a transport rate came out low, not merely that it did. The first kimi calibration
   * (2026-07-30) returned 72.5% and the file recorded no cause, so nothing in it could distinguish
   * rate limiting from timeouts from a bad endpoint — and those have opposite fixes.
   */
  readonly transport: TransportStats;
  /**
   * False when the probe itself was measured through a broken pipe. Load-bearing: a calibration is the
   * one input every later budget decision rests on, so an invalid one must be unusable rather than
   * merely annotated. The sizing step refuses it.
   */
  readonly transportFloorMet: boolean;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly corpusSha256: string;
}

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

  it('ARM_PRIORITY names every arm exactly once', () => {
    // A typo here would shorten the priority list and quietly drop an arm from the study.
    assertArmPriorityCoversEveryArm();
    expect(ARM_PRIORITY).toHaveLength(12);
    // The first two are the arms the MODEL AXIS is compared on, so they are asserted by name: the
    // live status quo, and the only arm carrying a positive-prior lead.
    expect(ARM_PRIORITY[0]).toBe('champion_v8');
    expect(ARM_PRIORITY[1]).toBe('inverted');
    // The last three are the arms a pre-run power calculation says cannot produce a powered cell on
    // this corpus. Their position is a deliberate, declared choice — asserted so it cannot drift.
    expect([...ARM_PRIORITY].slice(-3)).toEqual([
      'high_conviction_only',
      'trade_almost_never',
      'one_symbol_btc',
    ]);
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
    expect([...MODEL_AXIS]).toEqual(['claude-sonnet-5', 'kimi-k3']);
    expect(MIN_ENTRIES).toBe(12);
    expect([...HORIZONS]).toEqual([1, 4, 8, 24]);
    // The family a fully-funded run would carry, kept only so the reduced design can be compared
    // against it: 2 models x 12 arms x 4 horizons.
    expect(FULL_DESIGN_CELLS).toBe(96);
  });
});

// A literal rather than a sizeDesign() call: the unit checks below must not silently follow a change
// in the sizing rule, and a fixture that moves with the code under test proves nothing.
const TEST_DESIGN: StudyDesign = {
  sharedEdgeArms: 2,
  leadModelOnlyEdgeArms: 3,
  edgeRows: 386,
  leverRows: 35,
  measured: {
    leadUsdPerCall: 0.0163,
    followUsdPerCall: 0.0163,
    leadEdgeBudgetUsd: 28.154,
    followBudgetUsd: 13,
    leverTierUsd: 6.846,
  },
  corpusSha256: 'test-fixture',
};

describe('Amendment 5 — the sizing rule', () => {
  it('the family is the funded design, not the full grid', () => {
    // 2 shared arms on 2 models + 3 lead-only arms, all x 4 horizons = 16 + 12 = 28.
    expect(bonferroniCells(TEST_DESIGN)).toBe(28);
    // Exact equality, not toBeCloseTo — a significance threshold is a frozen constant, and the
    // repo-wide ban on approximate assertions is the right rule to inherit here.
    expect(alphaFor(TEST_DESIGN)).toBe(0.05 / 28);
    // Shrinking the family RAISES alpha, which makes a pass easier. Stated as an assertion so the
    // direction is impossible to overlook when reading the design: the justification is that fewer
    // hypotheses are actually being tested, never that an easier bar was wanted.
    expect(alphaFor(TEST_DESIGN)).toBeGreaterThan(0.05 / FULL_DESIGN_CELLS);
  });

  it('relaxes ONLY the significance clauses — the economic bar does not move', () => {
    // A cell that misses +13.0 bps fails under any family size. This is the guarantee that buying a
    // smaller study cannot argue the fee floor down.
    const missesTheBar = {
      n: 60,
      clusters: 20,
      mean: 9.0,
      ciLo: 4.0,
      ciHi: 14.0,
      pVsBar: 0,
      placeboP: 0,
      firstHalf: 9.0,
      secondHalf: 9.0,
      trimmed: 9.0,
    };
    expect(verdictFor(missesTheBar, alphaFor(TEST_DESIGN)).verdict).toBe('FAIL');
    expect(verdictFor(missesTheBar, 0.05).verdict).toBe('FAIL');
    expect(verdictFor(missesTheBar, 1).failedClause).toBe('mean <= bar');
  });

  it('at the SMOKE cost, rows stay at full depth and arms absorb the budget', () => {
    const d = sizeDesign({
      edgeRows: 386,
      leadUsdPerCall: 0.0163,
      followUsdPerCall: 0.0163,
      leadStudyBudgetUsd: LEAD_STUDY_BUDGET_USD,
      followBudgetUsd: FOLLOW_STUDY_BUDGET_USD,
      corpusSha256: 'abc',
    });
    // Rows are not traded away while the axis can afford them: the argument of Amendment 5 is that
    // cutting rows costs sensitivity (1/sqrt(n)) while cutting arms costs only coverage.
    expect(d.edgeRows).toBe(386);
    // $13 / (386 x $0.0163 = $6.29) = 2 shared arms, both models.
    expect(d.sharedEdgeArms).toBe(2);
    // $35 − $6.85 lever tier = $28.15; / $6.29 = 4 arms of capacity, minus the 2 shared = 2.
    expect(d.leadModelOnlyEdgeArms).toBe(2);
    // The lever tier is capped at its 20% share, so it takes 35 rows rather than the 60-row ideal.
    expect(d.leverRows).toBe(35);
    expect(bonferroniCells(d)).toBe(24);
  });

  it('at the LIVE cost, row depth gives way so the model axis survives', () => {
    // The reason calibration exists: the two costs on record differ by 2.4x and imply materially
    // different studies. At $0.039668/call the follow budget cannot buy 386 rows ($15.31 > $13), so
    // depth is reduced — the model axis is the owner's question and outranks the extra rows.
    const d = sizeDesign({
      edgeRows: 386,
      leadUsdPerCall: 0.039668,
      followUsdPerCall: 0.039668,
      leadStudyBudgetUsd: LEAD_STUDY_BUDGET_USD,
      followBudgetUsd: FOLLOW_STUDY_BUDGET_USD,
      corpusSha256: 'abc',
    });
    expect(d.edgeRows).toBe(327);
    expect(d.sharedEdgeArms).toBe(1);
    expect(d.leadModelOnlyEdgeArms).toBe(1);
    // The lever tier could only afford 14 rows here — too wide to mean anything, so it is dropped
    // outright instead of being run as decoration that crowds out the edge tier.
    expect(d.leverRows).toBe(0);
    expect(d.measured.leverTierUsd).toBe(0);
    // Still above the floor, so cells can be powered: 327 rows at the corpus entry rate is n≈52.
    expect(d.edgeRows).toBeGreaterThanOrEqual(MIN_EDGE_ROWS);
  });

  it('REFUSES below the row floor rather than buying UNDERPOWERED cells', () => {
    // Amendment 4 rule 1 says a partial axis is INCOMPLETE, never NO_SURVIVOR. This enforces the same
    // idea one step earlier: an unfundable axis surfaces at sizing time with the arithmetic attached,
    // instead of producing cells too thin to answer anything.
    expect(() =>
      sizeDesign({
        edgeRows: 386,
        leadUsdPerCall: 0.0163,
        followUsdPerCall: 0.2,
        leadStudyBudgetUsd: LEAD_STUDY_BUDGET_USD,
        followBudgetUsd: FOLLOW_STUDY_BUDGET_USD,
        corpusSha256: 'abc',
      }),
    ).toThrow(/below the 150-row floor/);
  });

  it('refuses a non-positive budget or cost at construction', () => {
    const base = {
      edgeRows: 386,
      leadUsdPerCall: 0.0163,
      followUsdPerCall: 0.0163,
      leadStudyBudgetUsd: LEAD_STUDY_BUDGET_USD,
      followBudgetUsd: FOLLOW_STUDY_BUDGET_USD,
      corpusSha256: 'abc',
    };
    expect(() => sizeDesign({ ...base, followBudgetUsd: 0 })).toThrow(/followBudgetUsd must be/);
    expect(() => sizeDesign({ ...base, leadUsdPerCall: 0 })).toThrow(/leadUsdPerCall must be/);
    expect(() => sizeDesign({ ...base, edgeRows: Number.NaN })).toThrow(/edgeRows must be/);
  });

  it('clamps both arm counts so an implausibly cheap measurement cannot run away', () => {
    const d = sizeDesign({
      edgeRows: 386,
      leadUsdPerCall: 0.00001,
      followUsdPerCall: 0.00001,
      leadStudyBudgetUsd: 10_000,
      followBudgetUsd: 10_000,
      corpusSha256: 'abc',
    });
    expect(d.sharedEdgeArms).toBe(MAX_SHARED_EDGE_ARMS);
    expect(d.leadModelOnlyEdgeArms).toBe(MAX_LEAD_ONLY_EDGE_ARMS);
    // Even fully clamped the design stays inside the twelve frozen arms.
    expect(d.sharedEdgeArms + d.leadModelOnlyEdgeArms).toBeLessThanOrEqual(ARM_PRIORITY.length);
  });

  it('assigns each model a frozen PREFIX of the priority order', () => {
    expect(edgeArmsFor(MODEL_AXIS[0], TEST_DESIGN)).toEqual([
      'champion_v8',
      'inverted',
      'minimal',
      'momentum_pure',
      'meanrev_pure',
    ]);
    // The follow model runs the shared prefix only — so the model comparison is on identical arms AND
    // identical rows, which is the only reading that answers "which lane is best".
    expect(edgeArmsFor(MODEL_AXIS[1], TEST_DESIGN)).toEqual(['champion_v8', 'inverted']);
    // The champion is first for both, so the decision-change reference always exists.
    expect(edgeArmsFor(MODEL_AXIS[1], TEST_DESIGN)[0]).toBe(ARM_PRIORITY[0]);
  });

  it('pins a design to the corpus it was sized for', () => {
    expect(() => assertDesignMatchesCorpus(TEST_DESIGN, 'a-different-corpus')).toThrow(
      /does not transfer/,
    );
    expect(() => assertDesignMatchesCorpus(TEST_DESIGN, 'test-fixture')).not.toThrow();
  });

  it('the edge run refuses to size its own family', () => {
    expect(() => loadDesign(join(OUT_DIR, 'definitely-not-a-design-file.json'))).toThrow(
      /run the calibration probe first/,
    );
  });
});

describe('sampling and arm selection helpers', () => {
  it('strideSample spans the whole window instead of taking a head slice', () => {
    const rows = Array.from({ length: 386 }, (_, i) => i);
    const sample = strideSample(rows, LEVER_PROBE_ROWS);
    expect(sample).toHaveLength(LEVER_PROBE_ROWS);
    expect(sample[0]).toBe(0);
    // A head slice would end at 59; a spanning sample must reach the far end of the corpus, because
    // the corpus is chronological and 60 consecutive rows is one day of a 6.35-day window.
    expect(sample[sample.length - 1]).toBeGreaterThan(370);
    // Deterministic and strictly increasing — no PRNG, so a calibration reproduces exactly.
    expect([...sample].sort((a, b) => a - b)).toEqual([...sample]);
    expect(new Set(sample).size).toBe(LEVER_PROBE_ROWS);
  });

  it('strideSample degenerates safely', () => {
    expect(strideSample([1, 2, 3], 10)).toEqual([1, 2, 3]);
    expect(strideSample([1, 2, 3], 0)).toEqual([]);
  });

  it('selectArms preserves priority order and throws on an unknown name', () => {
    const arms = resolveArms();
    const picked = selectArms(arms, ['inverted', 'champion_v8']);
    expect(picked.map((a) => a.arm.name)).toEqual(['inverted', 'champion_v8']);
    expect(() => selectArms(arms, ['no_such_arm'])).toThrow(/no arm named no_such_arm/);
  });
});

describe('joint verdict across the model axis', () => {
  const cell = (model: string, arm: string, n: number, mean: number, verdict: string) => ({
    model,
    arm,
    h: 1,
    n,
    mean,
    ciLo: mean - 5,
    verdict,
  });

  it('a PARTIAL axis is INCOMPLETE, never NO_SURVIVOR', () => {
    // The trap this exists to prevent: one model runs, finds nothing, and the study gets written up
    // as "no lane works" when the other lane was simply never tested. Same error shape as reading a
    // rate-limited run as a finding.
    const v = aggregateVerdict(
      new Map([['claude-sonnet-5', [cell('claude-sonnet-5', 'champion_v8', 40, -19, 'FAIL')]]]),
      TEST_DESIGN,
    );
    expect(v.verdict).toBe('INCOMPLETE');
    expect(v.complete).toBe(false);
    expect(v.modelsDeclared).toEqual(['claude-sonnet-5', 'kimi-k3']);
    expect(v.cellsDeclared).toBe(28);
  });

  it('NO_SURVIVOR only once every declared model has run', () => {
    const v = aggregateVerdict(
      new Map([
        ['claude-sonnet-5', [cell('claude-sonnet-5', 'champion_v8', 40, -19, 'FAIL')]],
        ['kimi-k3', [cell('kimi-k3', 'champion_v8', 40, 4, 'FAIL')]],
      ]),
      TEST_DESIGN,
    );
    expect(v.verdict).toBe('NO_SURVIVOR');
    // "Which lane is best" still gets an answer — but ranking is NOT passing.
    expect(v.bestPowered?.model).toBe('kimi-k3');
    expect(v.passes).toHaveLength(0);
  });

  it('reports the winning lane by model AND arm when one clears the bar', () => {
    const v = aggregateVerdict(
      new Map([
        ['claude-sonnet-5', [cell('claude-sonnet-5', 'champion_v8', 40, -19, 'FAIL')]],
        ['kimi-k3', [cell('kimi-k3', 'inverted', 40, 31, 'PASS')]],
      ]),
      TEST_DESIGN,
    );
    expect(v.verdict).toBe('SURVIVOR');
    expect(v.passes[0]?.model).toBe('kimi-k3');
    expect(v.passes[0]?.arm).toBe('inverted');
  });

  it('an underpowered cell can never be the best lane', () => {
    // n=3 with a huge mean is noise, and "best" must not surface it as the answer.
    const v = aggregateVerdict(
      new Map([
        ['claude-sonnet-5', [cell('claude-sonnet-5', 'one_symbol_btc', 3, 900, 'UNDERPOWERED')]],
        ['kimi-k3', [cell('kimi-k3', 'champion_v8', 40, -19, 'FAIL')]],
      ]),
      TEST_DESIGN,
    );
    expect(v.bestPowered?.model).toBe('kimi-k3');
    expect(v.bestPowered?.n).toBe(40);
  });
});

// ── CALIBRATION: measure the per-call cost before allocating a budget to it ───────────────────────
describe.runIf(CALIBRATE && API_KEY.length > 0 && CORPUS_PRESENT)(
  'playbook-space replay — CALIBRATION probe',
  () => {
    it(
      'measures per-call cost, transport, schema and entry rate on one arm',
      async () => {
        const corpus = loadCorpus();
        const rows = strideSample(corpus, CALIBRATION_ROWS);
        const manifest = corpusManifest(corpus);
        const arms = selectArms(resolveArms(), [ARM_PRIORITY[0]]);
        assertArmsAreReachable(arms);

        console.log(
          `\ncalibration: model=${MODEL} rows=${rows.length} arm=${ARM_PRIORITY[0]} baseUrl=${BASE_URL}`,
        );
        const preflight = await preflightCanSpend(API_KEY, MODEL, BASE_URL);
        if (!preflight.ok) {
          throw new Error(
            `PRE-FLIGHT FAILED — the API refused a 1-token probe with HTTP ${preflight.status}. ` +
              `No paid call was made. Detail: ${preflight.detail}`,
          );
        }

        const run = await runReplay(
          rows,
          arms,
          {
            apiKey: API_KEY,
            model: MODEL,
            baseUrl: BASE_URL,
            // kimi-k3 runs reasoning at max and cannot disable it, so its replies are materially
            // slower than sonnet's — the 2026-07-30 probe measured ~70s per call wall-clock. A fixed
            // 120s timeout is what turns that into transport failure, so the timeout is a knob.
            timeoutMs: Number(process.env.PLAYBOOK_SPACE_TIMEOUT_MS ?? 120_000),
            sizeFractionMax: '0.25',
            shortsEnabled: true,
            rowsPerChunk: rows.length,
            concurrency: Number(process.env.PLAYBOOK_SPACE_CONCURRENCY ?? 4),
            // A calibration that could cost more than a few dollars defeats its own purpose.
            capUsd: process.env.PLAYBOOK_SPACE_CAP_USD ?? '3',
            reservePerCallUsd: '0.05',
            onProgress: (m) => console.log(`  ${m}`),
          },
          fetch,
        );

        // FAILS CLOSED on faithfulness. A replay that presented capabilities the live system never
        // recorded is measuring a different account: the 2026-07-30 `venueFreeCash: 0` defect cut the
        // entry rate from 18.2% to 4.5% on identical rows, so this can never be a warning.
        if (run.unfaithfulCapsRows > 0) {
          throw new Error(
            `RUN VOID —  row(s) replayed with capabilities the live system did ` +
              `not record. The corpus payloads must carry a capabilities block; see ` +
              `recordedCapabilities in entry-rate-floor.ts.`,
          );
        }

        if (run.transport.billingStop !== null) {
          throw new Error(`RUN ABORTED — billing state: ${run.transport.billingStop}`);
        }

        const results = run.perArm.get(ARM_PRIORITY[0]) ?? [];
        const parsed = results.filter((r) => r.ok);
        const entries = parsed.filter(
          (r) => r.action === 'open_long' || r.action === 'open_short',
        ).length;
        const usdPerCall = run.meter.calls === 0 ? 0 : Number(run.meter.usd) / run.meter.calls;
        const timeoutMs = Number(process.env.PLAYBOOK_SPACE_TIMEOUT_MS ?? 120_000);
        const concurrency = Number(process.env.PLAYBOOK_SPACE_CONCURRENCY ?? 4);
        const calibration: Calibration = {
          model: MODEL,
          baseUrl: BASE_URL,
          rows: run.rowsCovered,
          calls: run.meter.calls,
          usd: run.meter.usd,
          usdPerCall,
          usdPerCallEffective:
            run.transport.ok === 0
              ? usdPerCall
              : usdPerCall * (run.transport.attempts / run.transport.ok),
          transportRate: run.completion.transportRate,
          schemaRate: run.completion.schemaRate,
          entryRate: parsed.length === 0 ? 0 : entries / parsed.length,
          transport: run.transport,
          transportFloorMet: run.completion.transportRate >= MIN_TRANSPORT_RATE,
          timeoutMs,
          concurrency,
          corpusSha256: manifest.payloadSha256,
        };

        console.log(`\n  calls              ${calibration.calls}`);
        console.log(`  spend              $${calibration.usd}`);
        console.log(`  USD/call           $${usdPerCall.toFixed(6)} (metered)`);
        console.log(
          `  USD/call effective $${calibration.usdPerCallEffective.toFixed(6)} ` +
            `(${run.transport.attempts} attempts / ${run.transport.ok} usable — the figure the design is sized on)`,
        );
        console.log(
          `  empty-body 200s    ${run.transport.emptyBody} (retried ${run.transport.retries}x)`,
        );
        console.log(
          `  transport rate     ${(calibration.transportRate * 100).toFixed(1)}% (VOID floor ${(MIN_TRANSPORT_RATE * 100).toFixed(0)}%)`,
        );
        console.log(
          `  schema-valid rate  ${(calibration.schemaRate * 100).toFixed(1)}% — reported, never gating`,
        );
        console.log(`  entry rate         ${(calibration.entryRate * 100).toFixed(1)}%`);
        // Entries per arm at full depth is what decides whether a cell can be powered at all.
        console.log(
          `  projected n at ${corpus.length} rows: ${Math.round(corpus.length * calibration.entryRate)}` +
            ` (MIN_ENTRIES ${MIN_ENTRIES})\n`,
        );

        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(calibrationFile(MODEL), JSON.stringify(calibration, null, 2), 'utf8');
        console.log(`wrote ${calibrationFile(MODEL)}`);

        // Fails CLOSED on transport: a calibration measured through a rate-limited pipe would size the
        // whole study wrong, and it is the one number every later decision rests on.
        expect(run.completion.transportRate).toBeGreaterThanOrEqual(MIN_TRANSPORT_RATE);
        expect(usdPerCall).toBeGreaterThan(0);
      },
      30 * 60 * 1000,
    );
  },
);

// ── SIZING: fix the family. Free, no network, and it must happen before the first edge call ───────
describe.runIf(SIZE && CORPUS_PRESENT)('playbook-space replay — size the design', () => {
  it('applies the frozen sizing rule to the measured costs and writes the design', () => {
    const missing = MODEL_AXIS.filter((m) => !existsSync(calibrationFile(m)));
    if (missing.length > 0) {
      throw new Error(
        `cannot size the design — no calibration for [${missing.join(', ')}]. ` +
          `Run PLAYBOOK_SPACE_CALIBRATE=1 against each model on the axis first.`,
      );
    }
    const cal = new Map(
      MODEL_AXIS.map((m) => [
        m,
        JSON.parse(readFileSync(calibrationFile(m), 'utf8')) as Calibration,
      ]),
    );
    const corpus = loadCorpus();
    const manifest = corpusManifest(corpus);
    for (const [model, c] of cal) {
      if (c.corpusSha256 !== manifest.payloadSha256) {
        throw new Error(`calibration for ${model} was measured on a different corpus`);
      }
      // A calibration file written by an older harness is missing fields the sizing rule needs. Name
      // the remedy here rather than letting `undefined` surface three frames down as an arithmetic
      // complaint about a number nobody chose.
      if (typeof c.usdPerCallEffective !== 'number' || typeof c.transportFloorMet !== 'boolean') {
        throw new Error(
          `calibration for ${model} predates the current harness (no usdPerCallEffective / ` +
            `transportFloorMet) — re-run PLAYBOOK_SPACE_CALIBRATE=1 for it.`,
        );
      }
      // Fails CLOSED on a voided probe. Without this the harness would size a whole study off a
      // measurement taken through a broken pipe — the exact class of error the transport floor exists
      // to prevent, reintroduced one layer up. The kimi probe of 2026-07-30 returned 72.5%.
      if (!c.transportFloorMet) {
        throw new Error(
          `calibration for ${model} is VOID — transport ${(c.transportRate * 100).toFixed(1)}% is ` +
            `below the ${(MIN_TRANSPORT_RATE * 100).toFixed(0)}% floor ` +
            `(429=${c.transport.rateLimited}, 5xx=${c.transport.serverError}, ` +
            `otherHttp=${c.transport.otherHttp}, net=${c.transport.networkError}, ` +
            `retries=${c.transport.retries}, timeout=${c.timeoutMs}ms, concurrency=${c.concurrency}). ` +
            `Fix the transport and re-probe; a cost measured through a broken pipe cannot size a study.`,
        );
      }
    }
    const lead = cal.get(MODEL_AXIS[0])!;
    const follow = cal.get(MODEL_AXIS[1])!;
    // The allocations are constants, but a re-size part-way through a study must budget what is LEFT of
    // them, not what they started as — otherwise a second sizing silently doubles the authorised spend.
    // Env-overridable for exactly that, and the value used is recorded in the design file.
    const leadBudget = Number(process.env.PLAYBOOK_SPACE_LEAD_BUDGET_USD ?? LEAD_STUDY_BUDGET_USD);
    const followBudget = Number(
      process.env.PLAYBOOK_SPACE_FOLLOW_BUDGET_USD ?? FOLLOW_STUDY_BUDGET_USD,
    );
    const design = sizeDesign({
      edgeRows: corpus.length,
      // EFFECTIVE cost, which charges the study for retried attempts the meter cannot see.
      leadUsdPerCall: lead.usdPerCallEffective,
      followUsdPerCall: follow.usdPerCallEffective,
      leadStudyBudgetUsd: leadBudget,
      followBudgetUsd: followBudget,
      corpusSha256: manifest.payloadSha256,
    });
    writeDesign(design);

    const leadCalls = design.edgeRows * (design.sharedEdgeArms + design.leadModelOnlyEdgeArms);
    const followCalls = design.edgeRows * design.sharedEdgeArms;
    console.log(`\nsized design (family FIXED at this moment, before any edge call):`);
    console.log(
      `  rows/arm             ${design.edgeRows}/${corpus.length}` +
        (design.edgeRows < corpus.length
          ? '  REDUCED — the axis could not afford full depth'
          : '  (full depth)'),
    );
    console.log(
      `  shared arms          ${design.sharedEdgeArms}  ${edgeArmsFor(MODEL_AXIS[1], design).join(', ')}`,
    );
    console.log(`  ${MODEL_AXIS[0]}-only arms  ${design.leadModelOnlyEdgeArms}`);
    console.log(
      `  Bonferroni cells     ${bonferroniCells(design)} (full grid would be ${FULL_DESIGN_CELLS})`,
    );
    console.log(`  alpha                ${alphaFor(design).toExponential(4)}`);
    console.log(
      `  lever tier           ${
        design.leverRows === 0
          ? 'DROPPED — unaffordable at this per-call cost'
          : `${ARM_PRIORITY.length} arms x ${design.leverRows} rows (cap ${LEVER_PROBE_ROWS})`
      }`,
    );
    console.log(
      `  est. spend           lead $${(leadCalls * lead.usdPerCall + design.measured.leverTierUsd).toFixed(2)} of ` +
        `$${leadBudget} · follow $${(followCalls * follow.usdPerCall).toFixed(2)} of $${followBudget}`,
    );
    console.log(`  projected n/cell     ~${Math.round(design.edgeRows * lead.entryRate)}`);
    console.log(`wrote ${DESIGN_FILE}\n`);

    expect(design.sharedEdgeArms).toBeGreaterThanOrEqual(1);
    // Row depth is reduced when the axis cannot afford full depth (owner direction 2026-07-30), but
    // never below the floor at which a cell could not reach MIN_ENTRIES.
    expect(design.edgeRows).toBeLessThanOrEqual(corpus.length);
    expect(design.edgeRows).toBeGreaterThanOrEqual(MIN_EDGE_ROWS);
    expect(bonferroniCells(design)).toBeLessThanOrEqual(FULL_DESIGN_CELLS);
  });
});

// ── EDGE RUN: the hypothesis test. Refuses to start without a design on disk ──────────────────────
describe.runIf(PAID && API_KEY.length > 0 && CORPUS_PRESENT)(
  'playbook-space replay — PAID edge run',
  () => {
    it(
      "replays this model's funded arms over the frozen corpus and renders the verdict",
      async () => {
        const corpus: readonly CorpusRow[] = loadCorpus();
        const series = loadSeries(corpus.map((r) => r.symbol));
        // The manifest is over the WHOLE corpus, which is what the design was pinned to — the row
        // depth is a budget decision recorded in the design, not a different corpus.
        const manifest = corpusManifest(corpus);

        // The design file's existence BEFORE this run is the evidence the family was fixed before any
        // hypothesis was tested. Loading it (rather than recomputing) is the whole point.
        const design = loadDesign();
        assertDesignMatchesCorpus(design, manifest.payloadSha256);
        const alpha = alphaFor(design);
        const armNames = edgeArmsFor(MODEL, design);
        const arms = selectArms(resolveArms(), armNames);
        assertArmsAreReachable(arms);
        // A spanning sample, never a head slice: the corpus is chronological, so the first N rows are
        // one contiguous market slice and would confound "reduced depth" with "a different window".
        const rows = strideSample(corpus, design.edgeRows);

        console.log(`\ncorpus: ${manifest.rows} rows, ${manifest.symbols} symbols`);
        console.log(`payload sha256: ${manifest.payloadSha256}`);
        console.log(
          `rows this run: ${rows.length}` +
            (rows.length < corpus.length
              ? ' (spanning sample — the design reduced depth to fit the funded model axis)'
              : ' (full depth)'),
        );
        console.log(`model: ${MODEL}   arms (frozen prefix): ${armNames.join(', ')}`);
        console.log(
          `family: ${bonferroniCells(design)} cells, alpha ${alpha.toExponential(4)} ` +
            `(${design.sharedEdgeArms} shared x ${MODEL_AXIS.length} models + ${design.leadModelOnlyEdgeArms} lead-only)\n`,
        );

        // ONE call before thousands. Runs 1 and 2 (2026-07-28) both burned through the corpus
        // discovering mid-run that the account could not pay; the old pre-flight checked that a key
        // EXISTED, never that it could SPEND.
        const preflight = await preflightCanSpend(API_KEY, MODEL, BASE_URL);
        if (!preflight.ok) {
          throw new Error(
            `PRE-FLIGHT FAILED — the API refused a 1-token probe with HTTP ${preflight.status}. ` +
              `No paid call was made. Detail: ${preflight.detail}`,
          );
        }
        console.log('pre-flight: API accepted a 1-token probe — proceeding\n');

        // The cap comes from the design's own budget line, so the run cannot outspend what was
        // allocated to it even if the measured cost was optimistic.
        const capUsd =
          process.env.PLAYBOOK_SPACE_CAP_USD ??
          String(
            MODEL === MODEL_AXIS[0]
              ? design.measured.leadEdgeBudgetUsd
              : design.measured.followBudgetUsd,
          );

        const run = await runReplay(
          rows,
          arms,
          {
            apiKey: API_KEY,
            model: MODEL,
            baseUrl: BASE_URL,
            // kimi-k3 runs reasoning at max and cannot disable it, so its replies are materially
            // slower than sonnet's — the 2026-07-30 probe measured ~70s per call wall-clock. A fixed
            // 120s timeout is what turns that into transport failure, so the timeout is a knob.
            timeoutMs: Number(process.env.PLAYBOOK_SPACE_TIMEOUT_MS ?? 120_000),
            sizeFractionMax: '0.25',
            shortsEnabled: true,
            rowsPerChunk: Number(process.env.PLAYBOOK_SPACE_CHUNK ?? 40),
            concurrency: Number(process.env.PLAYBOOK_SPACE_CONCURRENCY ?? 4),
            capUsd,
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

        // FAILS CLOSED on faithfulness. A replay that presented capabilities the live system never
        // recorded is measuring a different account: the 2026-07-30 `venueFreeCash: 0` defect cut the
        // entry rate from 18.2% to 4.5% on identical rows, so this can never be a warning.
        if (run.unfaithfulCapsRows > 0) {
          throw new Error(
            `RUN VOID —  row(s) replayed with capabilities the live system did ` +
              `not record. The corpus payloads must carry a capabilities block; see ` +
              `recordedCapabilities in entry-rate-floor.ts.`,
          );
        }

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

        const table: Record<string, unknown>[] = [];
        const passes: string[] = [];
        // The decision-change reference is ARM_PRIORITY[0], which edgeArmsFor guarantees is present
        // for every model — so this count is never silently zero for want of a baseline.
        const referenceArm = ARM_PRIORITY[0];

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
          const reference = run.perArm.get(referenceArm) ?? [];
          const changed = results.filter((r) => {
            const ref = reference.find((c) => c.rowId === r.rowId);
            return ref !== undefined && ref.action !== r.action;
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
            const { verdict, failedClause } = verdictFor(stats, alpha);
            if (verdict === 'PASS') passes.push(`${arm.name}@h${h}`);
            table.push({
              model: MODEL,
              arm: arm.name,
              tests: arm.tests,
              h,
              rowsParsed: parsed.length,
              entryRate: parsed.length > 0 ? entries.length / parsed.length : 0,
              decisionsChangedVsReference: changed,
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
            ? `\nThis LEG: 0 of ${table.length} cells clear +${REQUIRED_EDGE_BPS} bps on every clause. ` +
                `The STUDY verdict is joint across ${MODEL_AXIS.join(' + ')} — a single leg finding nothing is INCOMPLETE, not NO_SURVIVOR.`
            : `\nThis LEG: SURVIVOR — ${passes.length} cell(s): ${passes.join(', ')}`,
        );

        mkdirSync(OUT_DIR, { recursive: true });
        // Model-scoped filename: the legs are separate processes and must never overwrite each other.
        const trialId = `playbook-space-replay-${MODEL}-2026-07-28`;
        const outFile = join(OUT_DIR, `${trialId}.json`);
        writeFileSync(
          outFile,
          JSON.stringify(
            {
              study: trialId,
              model: MODEL,
              baseUrl: BASE_URL,
              manifest,
              design,
              armsRun: armNames,
              run: {
                rowsAttempted: run.rowsAttempted,
                rowsCovered: run.rowsCovered,
                rowsSampled: rows.length,
                corpusRows: corpus.length,
                aborted: run.aborted,
                transport: run.transport,
                completion: run.completion,
                ...run.meter,
              },
              bar: {
                requiredEdgeBps: REQUIRED_EDGE_BPS,
                alpha,
                bonferroniCells: bonferroniCells(design),
                fullDesignCells: FULL_DESIGN_CELLS,
                minEntries: MIN_ENTRIES,
              },
              cells: table,
              passes,
              // Deliberately NOT a study verdict: one leg cannot produce one (Amendment 4 rule 1).
              legOutcome: passes.length === 0 ? 'NO_PASS_THIS_LEG' : 'PASS_THIS_LEG',
            },
            null,
            2,
          ),
          'utf8',
        );
        console.log(`\nwrote ${outFile}`);

        // This LEG's cell count — the FAMILY spans the axis and is larger. Conflating the two is what
        // made the pre-Amendment-5 assertion wrong: it compared one leg's 48 cells against a 96-cell
        // family and would have failed every complete run.
        expect(table.length).toBe(armNames.length * HORIZONS.length);
      },
      6 * 60 * 60 * 1000,
    );
  },
);

// ── JOINT VERDICT: free, no network. The only reading that decides the study ───────────────────────
describe.runIf(VERDICT)('playbook-space replay — joint verdict across the model axis', () => {
  it('aggregates every leg and names the outcome', () => {
    // Computed, never asserted by hand. Amendment 4 makes the verdict joint across the axis, so a
    // human adding up two result files in prose is exactly the step that could quietly turn an
    // INCOMPLETE into a NO_SURVIVOR.
    const legFile = (model: string): string =>
      join(OUT_DIR, `playbook-space-replay-${model}-2026-07-28.json`);
    const perModel = new Map<string, LaneCell[]>();
    const missing: string[] = [];
    let design: StudyDesign | undefined;
    for (const model of MODEL_AXIS) {
      if (!existsSync(legFile(model))) {
        missing.push(model);
        continue;
      }
      const leg = JSON.parse(readFileSync(legFile(model), 'utf8')) as {
        design: StudyDesign;
        cells: (LaneCell & { failedClause: string | null })[];
      };
      design ??= leg.design;
      perModel.set(
        model,
        leg.cells.map((c) => ({
          model,
          arm: c.arm,
          h: c.h,
          n: c.n,
          mean: c.mean,
          ciLo: c.ciLo,
          verdict: c.verdict,
        })),
      );
    }
    if (design === undefined) throw new Error('no leg results found — nothing to aggregate');

    const joint = aggregateVerdict(perModel, design);
    console.log(`\nmodels declared : ${joint.modelsDeclared.join(', ')}`);
    console.log(
      `models run      : ${joint.modelsRun.join(', ')}${missing.length ? ` (MISSING: ${missing.join(', ')})` : ''}`,
    );
    console.log(`cells scored    : ${joint.cellsScored} of ${joint.cellsDeclared} declared`);
    console.log(
      `passes          : ${joint.passes.length === 0 ? 'none' : joint.passes.map((p) => `${p.model}/${p.arm}@h${p.h}`).join(', ')}`,
    );
    if (joint.bestPowered !== null) {
      const b = joint.bestPowered;
      console.log(
        `best POWERED    : ${b.model}/${b.arm}@h${b.h} mean=${b.mean.toFixed(1)}bps ciLo=${b.ciLo.toFixed(1)} n=${b.n} — ranking is NOT passing`,
      );
    }
    console.log(`\nSTUDY VERDICT   : ${joint.verdict}\n`);

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      join(OUT_DIR, 'playbook-space-joint-verdict-2026-07-28.json'),
      JSON.stringify({ ...joint, design, missingModels: missing }, null, 2),
      'utf8',
    );

    // A verdict is a valid outcome in every direction, so nothing here asserts which one it is — only
    // that the aggregation is internally coherent.
    expect(joint.modelsDeclared).toEqual([...MODEL_AXIS]);
    expect(joint.complete).toBe(missing.length === 0);
    if (!joint.complete) expect(joint.verdict).toBe('INCOMPLETE');
    if (joint.verdict === 'NO_SURVIVOR') expect(joint.passes).toHaveLength(0);
  });
});

// ── LEVER TIER: is playbook prose a lever at all? No edge test, no family entry ────────────────────
describe.runIf(LEVER && API_KEY.length > 0 && CORPUS_PRESENT)(
  'playbook-space replay — LEVER tier',
  () => {
    it(
      'measures entry rate and decision change for ALL twelve arms',
      async () => {
        const corpus = loadCorpus();
        const design = loadDesign();
        assertDesignMatchesCorpus(design, corpusManifest(corpus).payloadSha256);
        if (design.leverRows === 0) {
          throw new Error(
            'the sized design dropped the lever tier — at the measured per-call cost it could not ' +
              'fund enough rows for a usable proportion. Nothing to run.',
          );
        }
        const rows = strideSample(corpus, design.leverRows);
        const arms = selectArms(resolveArms(), [...ARM_PRIORITY]);
        assertArmsAreReachable(arms);

        const preflight = await preflightCanSpend(API_KEY, MODEL, BASE_URL);
        if (!preflight.ok) {
          throw new Error(
            `PRE-FLIGHT FAILED — HTTP ${preflight.status}. No paid call was made. ${preflight.detail}`,
          );
        }

        const run = await runReplay(
          rows,
          arms,
          {
            apiKey: API_KEY,
            model: MODEL,
            baseUrl: BASE_URL,
            // kimi-k3 runs reasoning at max and cannot disable it, so its replies are materially
            // slower than sonnet's — the 2026-07-30 probe measured ~70s per call wall-clock. A fixed
            // 120s timeout is what turns that into transport failure, so the timeout is a knob.
            timeoutMs: Number(process.env.PLAYBOOK_SPACE_TIMEOUT_MS ?? 120_000),
            sizeFractionMax: '0.25',
            shortsEnabled: true,
            rowsPerChunk: rows.length,
            concurrency: Number(process.env.PLAYBOOK_SPACE_CONCURRENCY ?? 4),
            capUsd:
              process.env.PLAYBOOK_SPACE_CAP_USD ?? String(design.measured.leverTierUsd * 1.2),
            reservePerCallUsd: '0.05',
            onProgress: (m) => console.log(`  ${m}`),
          },
          fetch,
        );

        // FAILS CLOSED on faithfulness. A replay that presented capabilities the live system never
        // recorded is measuring a different account: the 2026-07-30 `venueFreeCash: 0` defect cut the
        // entry rate from 18.2% to 4.5% on identical rows, so this can never be a warning.
        if (run.unfaithfulCapsRows > 0) {
          throw new Error(
            `RUN VOID —  row(s) replayed with capabilities the live system did ` +
              `not record. The corpus payloads must carry a capabilities block; see ` +
              `recordedCapabilities in entry-rate-floor.ts.`,
          );
        }

        if (run.transport.billingStop !== null) {
          throw new Error(`RUN ABORTED — billing state: ${run.transport.billingStop}`);
        }
        if (run.voided) {
          throw new Error(
            `RUN VOID — transport ${(run.completion.transportRate * 100).toFixed(1)}% below the ` +
              `${(MIN_TRANSPORT_RATE * 100).toFixed(0)}% floor.`,
          );
        }

        const reference = run.perArm.get(ARM_PRIORITY[0]) ?? [];
        const table = arms.map(({ arm }) => {
          const results = run.perArm.get(arm.name) ?? [];
          const parsed = results.filter((r) => r.ok);
          const entries = parsed.filter(
            (r) => r.action === 'open_long' || r.action === 'open_short',
          ).length;
          const changed = results.filter((r) => {
            const ref = reference.find((c) => c.rowId === r.rowId);
            return ref !== undefined && ref.action !== r.action;
          }).length;
          const entryRate = parsed.length === 0 ? 0 : entries / parsed.length;
          return {
            arm: arm.name,
            tests: arm.tests,
            parsed: parsed.length,
            entries,
            entryRate,
            changedVsReference: changed,
            changeRate: results.length === 0 ? 0 : changed / results.length,
            // What this arm's n WOULD be at full corpus depth — the number that decides whether it
            // could ever be edge-tested here at all.
            projectedNAtFullDepth: Math.round(corpus.length * entryRate),
          };
        });

        console.log(
          '\narm                  parsed  entries  entryRate  changed  changeRate  proj.n',
        );
        console.log('-'.repeat(88));
        for (const r of table) {
          console.log(
            `${r.arm.padEnd(20)} ${String(r.parsed).padStart(6)} ${String(r.entries).padStart(8)} ` +
              `${(r.entryRate * 100).toFixed(1).padStart(9)}% ${String(r.changedVsReference).padStart(8)} ` +
              `${(r.changeRate * 100).toFixed(1).padStart(10)}% ${String(r.projectedNAtFullDepth).padStart(7)}`,
          );
        }
        console.log('-'.repeat(88));
        // Pre-registration weakness 6, answered directly: an arm whose decisions barely differ from the
        // champion's did not test what its label claims. That is a finding about the LEVER, not the
        // market, and it is reported as such — never as evidence about edge.
        const inert = table.filter((r) => r.arm !== ARM_PRIORITY[0] && r.changeRate < 0.05);
        console.log(
          inert.length === 0
            ? '\nevery arm changed at least 5% of decisions — playbook prose IS a lever on behaviour.'
            : `\nINERT ARMS (<5% of decisions changed — the prose did not move the model): ${inert.map((r) => r.arm).join(', ')}`,
        );
        console.log(
          'NO EDGE TEST WAS RUN HERE. This tier tests no hypothesis against the +13.0 bps bar and ' +
            'contributes nothing to the Bonferroni family.\n',
        );

        mkdirSync(OUT_DIR, { recursive: true });
        const outFile = join(OUT_DIR, `playbook-space-lever-${MODEL}-2026-07-28.json`);
        writeFileSync(
          outFile,
          JSON.stringify(
            {
              study: `playbook-space-lever-${MODEL}`,
              model: MODEL,
              rows: run.rowsCovered,
              tier: 'LEVER — entry rate and decision change only; NOT an edge test',
              design,
              run: { transport: run.transport, completion: run.completion, ...run.meter },
              arms: table,
              inertArms: inert.map((r) => r.arm),
            },
            null,
            2,
          ),
          'utf8',
        );
        console.log(`wrote ${outFile}`);

        expect(table).toHaveLength(ARM_PRIORITY.length);
      },
      3 * 60 * 60 * 1000,
    );
  },
);
