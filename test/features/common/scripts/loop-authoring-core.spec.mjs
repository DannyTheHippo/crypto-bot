import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_MINT_FLOOR_MIN_ENTRIES,
  DEFAULT_MINT_FLOOR_MIN_ROWS,
  RETIRED_OBJECTIVE_MARKERS,
  assertNoRetiredObjective,
  buildEvidenceDigest,
  classifyEntryRateFloor,
  classifyMintGate,
  parseArgs,
  parsePlaybookInfoVersion,
  renderTwoBars,
  resolveIncumbent,
  stripRetiredGuidance,
} from '../../../../scripts/loop-authoring-core.mjs';

// The loop-side authoring pass's decision core. Three things are load-bearing enough that a defect in
// any of them is silent in the output, which is why they are asserted rather than reviewed:
//
//  1. THE RETIRED OBJECTIVE. research/loop/playbook-authoring.md preserves the reflection prompt
//     verbatim INCLUDING the ANTI-RATCHET OBJECTIVE, marked "[RETIRED — HISTORICAL TEXT ONLY]" three
//     times over. Carrying it into a drafting call would re-impose the "roughly two closed round trips
//     per day" objective that research/studies/entry-rate-rederivation-2026-07-30.md retired — and the
//     retirement caveat says that paragraph is "the one most likely to be copied by reflex".
//  2. THE INCUMBENT. The deployment bar is "beats the CURRENTLY RUNNING playbook", so a wrong
//     incumbent silently redefines the bar. It was v8 until 2026-07-30 and is now v10 (`inverted`);
//     playbook-space-arms.ts had to correct exactly this mislabel once already, before any result
//     existed.
//  3. THE MINT GATE. agent_playbook_versions is append-only — a mint on an unmeasured, voided or
//     unlogged comparison cannot be taken back.
//
// Plain .mjs because it imports scripts/*.mjs, which sit outside the tsconfig project (see
// eslint.config.mjs's scripts/** ignore) — same reason as playbook-candidate-core.spec.mjs.

const GUIDANCE_FILE = join(process.cwd(), 'research', 'loop', 'playbook-authoring.md');

const PLAYBOOK_ROWS = [
  { version: 8, source: 'seed', content: 'champion v8 text' },
  { version: 9, source: 'reflection', content: 'candidate v9 text' },
  { version: 10, source: 'loop-candidate', content: 'inverted v10 text' },
  { version: 11, source: 'promotion', parent_version: 10, content: '' },
];

function cell(h, mean) {
  return { model: 'claude-sonnet-5', arm: 'x', h, n: 40, mean, ciLo: mean - 20, verdict: 'FAIL' };
}

function deployment(overrides = {}) {
  return {
    arm: 'draft_t1',
    incumbent: 'incumbent_v10',
    primaryHorizon: 24,
    perHorizon: [
      { h: 1, armMean: -1, incumbentMean: -12, deltaBps: 11, beats: true },
      { h: 4, armMean: 1, incumbentMean: -36, deltaBps: 37, beats: true },
      { h: 8, armMean: 19, incumbentMean: -32, deltaBps: 51, beats: true },
      { h: 24, armMean: 47, incumbentMean: -70, deltaBps: 117, beats: true },
    ],
    beatsAtPrimary: true,
    horizonsWon: 4,
    horizonsCompared: 4,
    ships: true,
    horizonDependent: false,
    attribution: 'PROMPT-CONTROLLED',
    ...overrides,
  };
}

const RESEARCH_FAIL = { cellsScored: 8, cellsDeclared: 8, passes: [], verdict: 'NO_SURVIVOR' };
const HEALTHY_RUN = { voided: false, aborted: false, unfaithfulCapsRows: 0 };
const FLOOR_PASS = classifyEntryRateFloor({ rowsParsed: 120, entries: 26 });

describe('loop-authoring keeps the RETIRED anti-ratchet objective out of the drafting prompt', () => {
  const raw = readFileSync(GUIDANCE_FILE, 'utf8');

  it('the preserved guidance file DOES still carry the retired text — otherwise this suite proves nothing', () => {
    // A vacuous strip (file no longer contains it) would make every assertion below pass for the
    // wrong reason. Both lane variants preserve the paragraph, hence two occurrences.
    expect(raw).toContain('ANTI-RATCHET OBJECTIVE');
    expect(raw).toContain('a flat week is a FAILING week');
  });

  it.each([
    ['perp', true],
    ['spot', false],
  ])('strips the %s lane’s retired block and every marker with it', (lane, shortsAllowed) => {
    const { text, blocksRemoved, lane: selected } = stripRetiredGuidance(raw, { shortsAllowed });
    expect(selected).toBe(lane);
    expect(blocksRemoved).toBe(1);
    for (const marker of RETIRED_OBJECTIVE_MARKERS) {
      expect(text.toLowerCase()).not.toContain(marker.toLowerCase());
    }
  });

  it('strips the X7 postMortems paragraph, which is retired in SUBSTANCE but not fenced', () => {
    // REGRESSION, 2026-07-30: found in a GENERATED drafting prompt, not in review. X7 opens "the SAME
    // anti-ratchet counterweight evidence" and closes by calling a sub-one-entry-per-day rate "a
    // strong prompt to act" on a rank-filter relaxation — the retired objective under another label.
    expect(raw).toContain('The postMortems digest (X7)');
    expect(raw).toContain('anti-ratchet counterweight evidence');
    const { text, substanceParagraphsRemoved } = stripRetiredGuidance(raw);
    expect(substanceParagraphsRemoved).toBe(1);
    expect(text).not.toContain('postMortems');
    expect(text.toLowerCase()).not.toContain('anti-ratchet');
  });

  it('matches "anti-ratchet" bare, so a paraphrase of the label cannot carry it through', () => {
    // The narrower 'ANTI-RATCHET OBJECTIVE' marker is what let X7 through the first time.
    expect(RETIRED_OBJECTIVE_MARKERS).toContain('anti-ratchet');
    expect(() => assertNoRetiredObjective('the same anti-ratchet counterweight evidence')).toThrow(
      /RETIRED/,
    );
  });

  it('keeps the guidance that carries no retirement judgement', () => {
    const { text } = stripRetiredGuidance(raw);
    expect(text).toContain('SIZING DISCIPLINE');
    expect(text).toContain('HARD LENGTH CAP');
    expect(text).toContain('## regime notes');
    expect(text).toContain('STRUCTURAL_CONSTRAINTS_RESTATEMENT');
  });

  it('drops the prose ABOUT the preservation, which names the retired objective in passing', () => {
    // The § Provenance table row and the § Related records bullet both name it; they are metadata,
    // and leaving them in was how the first version of this strip leaked the marker.
    const { text } = stripRetiredGuidance(raw);
    expect(text).not.toContain('Why this file exists');
    expect(text).not.toContain('Related records');
  });

  it('selects the lane the validator will actually accept', () => {
    expect(stripRetiredGuidance(raw, { shortsAllowed: true }).text).toContain(
      'this is a PERP lane',
    );
    expect(stripRetiredGuidance(raw, { shortsAllowed: false }).text).toContain(
      'this is a SPOT lane',
    );
  });

  it.each(RETIRED_OBJECTIVE_MARKERS)('refuses a prompt carrying "%s"', (marker) => {
    expect(() => assertNoRetiredObjective(`preamble ${marker} trailer`)).toThrow(/RETIRED/);
  });

  it('matches case-insensitively, so a re-cased paraphrase does not slip past', () => {
    expect(() => assertNoRetiredObjective('a Flat Week Is A Failing Week')).toThrow(/RETIRED/);
  });

  it('passes the stripped guidance, which is what the shell actually asserts on', () => {
    expect(() => assertNoRetiredObjective(stripRetiredGuidance(raw).text)).not.toThrow();
  });
});

describe('loop-authoring resolves the incumbent at run time', () => {
  it('parses the live gauge line shape', () => {
    expect(
      parsePlaybookInfoVersion(
        '# HELP agentic_playbook_info active playbook\n' +
          'agentic_playbook_info{instance="app:3100",job="crypto-bot",version="10"} 1\n',
      ),
    ).toBe(10);
  });

  it('ignores children the exporter set to 0 — a stale child names no live version', () => {
    expect(
      parsePlaybookInfoVersion(
        'agentic_playbook_info{version="8"} 0\nagentic_playbook_info{version="10"} 1\n',
      ),
    ).toBe(10);
  });

  it.each([
    ['no metric present', 'up 1\n'],
    ['not a string', undefined],
    ['no version label', 'agentic_playbook_info{instance="app:3100"} 1\n'],
  ])('fails OPEN to null when %s', (_label, text) => {
    expect(parsePlaybookInfoVersion(text)).toBeNull();
  });

  it('prefers the gauge — v10 (inverted) is RUNNING, and the DB mirror is only a mirror', () => {
    const r = resolveIncumbent({ rows: PLAYBOOK_ROWS, gaugeVersion: 10, dbVersion: 10 });
    expect(r).toMatchObject({ ok: true, version: 10, source: 'loop-candidate' });
    expect(r.resolvedFrom).toContain('gauge');
    expect(r.divergence).toBeNull();
  });

  it('falls back to the DB mirror when the gauge could not be scraped', () => {
    const r = resolveIncumbent({ rows: PLAYBOOK_ROWS, gaugeVersion: null, dbVersion: 10 });
    expect(r).toMatchObject({ ok: true, version: 10 });
    expect(r.resolvedFrom).toContain('DB precedence mirror');
  });

  it('reports a gauge/mirror disagreement rather than hiding it', () => {
    const r = resolveIncumbent({ rows: PLAYBOOK_ROWS, gaugeVersion: 8, dbVersion: 10 });
    expect(r).toMatchObject({ ok: true, version: 8 });
    expect(r.divergence).toContain('v8');
    expect(r.divergence).toContain('v10');
  });

  it('falls back and reports when the gauge names a version with no row', () => {
    const r = resolveIncumbent({ rows: PLAYBOOK_ROWS, gaugeVersion: 99, dbVersion: 10 });
    expect(r).toMatchObject({ ok: true, version: 10 });
    expect(r.divergence).toContain('no row');
  });

  it('fails CLOSED when neither source resolves — there is no bar to run against', () => {
    const r = resolveIncumbent({ rows: PLAYBOOK_ROWS, gaugeVersion: null, dbVersion: undefined });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('currently running');
  });

  it('fails CLOSED on an empty-content incumbent — the comparator arm cannot be scored', () => {
    const r = resolveIncumbent({ rows: PLAYBOOK_ROWS, gaugeVersion: 11, dbVersion: 11 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no readable content');
  });
});

describe('loop-authoring entry-rate floor (the squatting guard)', () => {
  it('passes a candidate that enters at all', () => {
    expect(classifyEntryRateFloor({ rowsParsed: 120, entries: 1 })).toMatchObject({
      pass: true,
      fired: true,
    });
  });

  it('VETOES a zero-entry candidate — it can never resolve its own slot', () => {
    const f = classifyEntryRateFloor({ rowsParsed: 120, entries: 0 });
    expect(f).toMatchObject({ pass: false, fired: true });
    expect(f.reason).toContain('squatting guard');
    // The floor must not be readable as a revived activity target — that objective was retired.
    expect(f.reason).toContain('abstention is a permitted terminal state');
  });

  it('fails OPEN below the row floor — a transport failure is not an abstention', () => {
    const f = classifyEntryRateFloor({ rowsParsed: DEFAULT_MINT_FLOOR_MIN_ROWS - 1, entries: 0 });
    expect(f).toMatchObject({ pass: true, fired: false });
    expect(f.reason).toContain('fails OPEN');
  });

  it('keeps the deleted driver’s own constants', () => {
    expect(DEFAULT_MINT_FLOOR_MIN_ROWS).toBe(6);
    expect(DEFAULT_MINT_FLOOR_MIN_ENTRIES).toBe(1);
  });
});

describe('loop-authoring mint gate', () => {
  it('MINTS a candidate that beats the incumbent, even on a research-bar FAIL', () => {
    // The first standing verdict in research/loop/verdicts.md, on an explicit owner ruling: a
    // research-bar FAIL is NOT a deployment veto. v10 itself shipped exactly this way.
    const gate = classifyMintGate({
      deployment: deployment(),
      research: RESEARCH_FAIL,
      floor: FLOOR_PASS,
      run: HEALTHY_RUN,
      experimentsLogged: true,
    });
    expect(gate).toMatchObject({
      mint: true,
      deploymentVerdict: 'SHIPS',
      researchVerdict: 'NO_SURVIVOR',
    });
    expect(gate.reason).toContain('NOT a claim of edge');
  });

  it('does NOT mint a candidate that loses to the incumbent', () => {
    const gate = classifyMintGate({
      deployment: deployment({
        perHorizon: [{ h: 24, armMean: -90, incumbentMean: -70, deltaBps: -20, beats: false }],
        beatsAtPrimary: false,
        horizonsWon: 0,
        horizonsCompared: 4,
        ships: false,
        horizonDependent: false,
      }),
      research: RESEARCH_FAIL,
      floor: FLOOR_PASS,
      run: HEALTHY_RUN,
      experimentsLogged: true,
    });
    expect(gate).toMatchObject({ mint: false, deploymentVerdict: 'LOSES' });
    expect(gate.blockers.join(' ')).toContain('does not beat the incumbent');
  });

  it('does NOT mint a horizon-dependent win — the robustness clause is pre-registered', () => {
    const gate = classifyMintGate({
      deployment: deployment({ horizonsWon: 1, ships: false, horizonDependent: true }),
      research: RESEARCH_FAIL,
      floor: FLOOR_PASS,
      run: HEALTHY_RUN,
      experimentsLogged: true,
    });
    expect(gate).toMatchObject({ mint: false, deploymentVerdict: 'HORIZON-DEPENDENT' });
  });

  it('does NOT mint a zero-entry candidate even when it "wins" every horizon', () => {
    const gate = classifyMintGate({
      deployment: deployment(),
      research: RESEARCH_FAIL,
      floor: classifyEntryRateFloor({ rowsParsed: 120, entries: 0 }),
      run: HEALTHY_RUN,
      experimentsLogged: true,
    });
    expect(gate.mint).toBe(false);
    expect(gate.blockers.join(' ')).toContain('entry-rate floor VETO');
  });

  it.each([
    ['a VOID run', { voided: true, aborted: false, unfaithfulCapsRows: 0 }, 'VOID'],
    ['a budget abort', { voided: false, aborted: true, unfaithfulCapsRows: 0 }, 'ABORTED'],
    [
      'unfaithful capabilities',
      { voided: false, aborted: false, unfaithfulCapsRows: 3 },
      'capabilities',
    ],
    ['no run at all', null, 'nothing was measured'],
  ])('fails CLOSED on %s', (_label, run, fragment) => {
    const gate = classifyMintGate({
      deployment: deployment(),
      research: RESEARCH_FAIL,
      floor: FLOOR_PASS,
      run,
      experimentsLogged: true,
    });
    expect(gate.mint).toBe(false);
    expect(gate.blockers.join(' ')).toContain(fragment);
  });

  it('fails CLOSED when the losers were not logged — that is how a selection effect launders', () => {
    const gate = classifyMintGate({
      deployment: deployment(),
      research: RESEARCH_FAIL,
      floor: FLOOR_PASS,
      run: HEALTHY_RUN,
      experimentsLogged: false,
    });
    expect(gate.mint).toBe(false);
    expect(gate.blockers.join(' ')).toContain('only its winners');
  });
});

describe('loop-authoring reporting', () => {
  it('renders both bars with their own labels and never merges them', () => {
    const out = renderTwoBars({
      arm: 'draft_t1',
      deployment: deployment(),
      research: RESEARCH_FAIL,
    });
    expect(out).toContain('DEPLOYMENT bar');
    expect(out).toContain('RESEARCH bar');
    expect(out).toContain('SHIPS');
    expect(out).toContain('NO_SURVIVOR');
    expect(out).toContain('NEVER the same bar');
  });

  it('reports "NOT SCORED"/"NOT COMPARED" rather than an implied zero', () => {
    const out = renderTwoBars({ arm: 'x', deployment: null, research: null });
    expect(out).toContain('NOT COMPARED');
    expect(out).toContain('NOT SCORED');
  });

  it('digests the whole-database read, naming the running version', () => {
    const digest = buildEvidenceDigest({
      decisions: {
        total: 1000,
        excludedNonModel: 26571,
        excluded: 422,
        symbols: 26,
        firstEventTime: 1784645100000,
        lastEventTime: 1785433500000,
        actionHistogram: { hold: 900, open_long: 100 },
      },
      versionStats: [
        { version: 8, source: 'seed', decides: 61, entries: 6 },
        { version: 10, source: 'loop-candidate', decides: 12, entries: 2 },
      ],
      roundTrips: {
        count: 32,
        symbols: 12,
        winners: 6,
        grossPnlQuote: '-20.000000',
        feesQuote: '21.000000',
        netPnlQuote: '-41.000000',
        meanNetPerTripQuote: '-1.281250',
      },
      incumbent: { version: 10 },
    });
    expect(digest).toContain('26571 non-LLM rows');
    expect(digest).toContain('422 degraded/pre-call rows excluded');
    expect(digest).toContain('v10 (loop-candidate)');
    expect(digest).toContain('← RUNNING');
    expect(digest).toContain('32 closed cycles');
  });

  it('renders an explicit no-data line instead of a zero that reads like a measurement', () => {
    const digest = buildEvidenceDigest({
      decisions: undefined,
      versionStats: [],
      roundTrips: null,
    });
    expect(digest).toContain('no decisions recorded');
    expect(digest).toContain('no per-version stats');
    expect(digest).toContain('no closed round trips');
  });

  it('surfaces the per-horizon deltas so a reader can check the verdict', () => {
    expect(
      renderTwoBars({ arm: 'x', deployment: deployment(), research: RESEARCH_FAIL }),
    ).toContain('h=24');
  });

  it('scores cells only through the harness — this core never recomputes a bar', () => {
    // Guards against the drift that would matter most: if this file ever grew its own ships/verdict
    // arithmetic, a pre-registered rule would be re-derived downstream of a result.
    const gate = classifyMintGate({
      deployment: deployment({ ships: false, horizonsWon: 4, beatsAtPrimary: true }),
      research: { ...RESEARCH_FAIL, verdict: 'SURVIVOR' },
      floor: FLOOR_PASS,
      run: HEALTHY_RUN,
      experimentsLogged: true,
    });
    expect(gate.mint).toBe(false);
    expect(cell(24, 47).mean).toBe(47);
  });
});

describe('loop-authoring argv', () => {
  it('parses the flags the pass takes', () => {
    expect(parseArgs(['--dry-run', '--out', 'x', '--rows', '150', '--model', 'm'])).toEqual({
      dryRun: true,
      outDir: 'x',
      rows: 150,
      model: 'm',
    });
  });

  it('defaults to a REAL run — --dry-run is opt-in, never implied', () => {
    expect(parseArgs([])).toEqual({ dryRun: false });
  });

  it.each([
    [['--dry-ru'], 'unknown option'],
    [['--out'], '--out requires a value'],
    [['--rows', '--model'], '--rows requires a value'],
    [['--rows', '0'], '--rows must be a positive integer'],
    [['stray'], 'unknown option'],
  ])('rejects %j rather than silently ignoring it', (argv, fragment) => {
    expect(parseArgs(argv).error).toContain(fragment);
  });
});
