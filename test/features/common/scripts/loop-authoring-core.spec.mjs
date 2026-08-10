import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUTHORING_ATTEMPT_FAMILY,
  COST_FLOOR_BPS,
  DEFAULT_MINT_FLOOR_MIN_ENTRIES,
  DEFAULT_MINT_FLOOR_MIN_ROWS,
  EST_COST_PER_DECIDE_USD,
  MEASURED_HORIZON_CELLS,
  MINT_TRIGGER_HORIZONS,
  MINT_TRIGGER_POPULATION,
  RETIRED_OBJECTIVE_MARKERS,
  assertNoRetiredObjective,
  buildEvidenceDigest,
  buildPerHorizonNetTable,
  buildScorecard,
  classifyDeclaredBudget,
  classifyEntryRateFloor,
  classifyMintGate,
  classifyMintTrigger,
  classifyRegistrySplitBrain,
  classifySameDayGate,
  corpusAttemptKey,
  describeRunTruncation,
  parseArgs,
  parsePlaybookInfoVersion,
  primaryHorizonDeltaBps,
  renderPriorAttempts,
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
    arm: 'draft_conservative',
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
    beatsHorizonBar: true,
    ships: true,
    horizonDependent: false,
    // The chronological-halves clause, DETERMINED and won on both sides. The harness computes this;
    // the fixture only has to carry the shape the gate reads.
    halvesVerdict: 'BOTH_WON',
    halves: {
      splitAtMs: 1784913300000,
      armEarly: 40,
      armLate: 54,
      incumbentEarly: -60,
      incumbentLate: -80,
      armEarlyN: 30,
      armLateN: 30,
      incumbentEarlyN: 34,
      incumbentLateN: 35,
      minEntries: 12,
      determined: true,
      reason: 'wins BOTH chronological halves at the primary horizon.',
    },
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

  // ── the deployment-absent blocker: "no candidate selected" vs "never scored" (2026-08-04) ──────
  //
  // Before this fix both causes produced ONE sentence — "the incumbent was never scored on the same
  // rows" — written for the case where no comparison was ever attempted. loop-authoring.mjs's actual
  // call passes `deployment: winner`, the best of the SHIPPING candidates, which is `undefined`
  // whenever every candidate lost even though every candidate WAS compared (stage 5 prints each one).
  // That is the real run this suite reproduces: two variants scored and printed in full, neither
  // shipped, and the refusal claimed a fact (never scored) contradicted by the run's own output.

  it('REFUSES with "no candidate selected", never "never scored", when N candidates were compared and none shipped', () => {
    const losingComparisons = [
      deployment({ arm: 'draft_conservative', ships: false, horizonsWon: 3 }),
      deployment({
        arm: 'draft_exploratory',
        ships: false,
        horizonsWon: 1,
        horizonDependent: true,
      }),
    ];
    const gate = classifyMintGate({
      deployment: undefined, // no winner — mirrors loop-authoring.mjs's `winner` when shipping.length === 0
      deploymentComparisons: losingComparisons,
      research: RESEARCH_FAIL,
      floor: undefined,
      run: HEALTHY_RUN,
      experimentsLogged: true,
    });
    expect(gate.mint).toBe(false);
    const blockers = gate.blockers.join(' ');
    expect(blockers).toContain('2 candidate(s) were compared against the incumbent');
    expect(blockers).toContain('no candidate was SELECTED');
    // The falsified claim this fix removes: the run demonstrably DID score the incumbent (stage 5
    // prints it for every comparison), so the refusal must never say otherwise.
    expect(blockers).not.toContain('the incumbent was never scored on the same rows');
  });

  it('REFUSES with "never scored" only when NO comparison was attempted at all — the genuinely-unmeasured path', () => {
    const gate = classifyMintGate({
      deployment: undefined,
      deploymentComparisons: undefined, // stage 4/5 never ran — a distinct cause from "compared but not selected"
      research: RESEARCH_FAIL,
      floor: undefined,
      run: HEALTHY_RUN,
      experimentsLogged: true,
    });
    expect(gate.mint).toBe(false);
    const blockers = gate.blockers.join(' ');
    expect(blockers).toContain('the incumbent was never scored on the same rows');
    // Distinct from, and must not be confused with, the "no candidate selected" wording above.
    expect(blockers).not.toContain('no candidate was SELECTED');
  });

  it('the same disambiguation applies to the entry-rate floor, whose absence today shares the deployment cause', () => {
    const withSelection = classifyMintGate({
      deployment: undefined,
      deploymentComparisons: [deployment({ ships: false })],
      floor: undefined,
      research: RESEARCH_FAIL,
      run: HEALTHY_RUN,
      experimentsLogged: true,
    });
    expect(withSelection.mint).toBe(false);
    expect(withSelection.blockers.join(' ')).toContain('no candidate was SELECTED to evaluate it');
    expect(withSelection.blockers.join(' ')).not.toContain(
      'the entry-rate floor was never measured',
    );

    const withoutAnyRun = classifyMintGate({
      deployment: undefined,
      deploymentComparisons: undefined,
      floor: undefined,
      research: RESEARCH_FAIL,
      run: HEALTHY_RUN,
      experimentsLogged: true,
    });
    expect(withoutAnyRun.mint).toBe(false);
    expect(withoutAnyRun.blockers.join(' ')).toContain('the entry-rate floor was never measured');
  });

  it('REGRESSION: the deployment- and floor-absent refusal still fires when compared candidates are also aborted', () => {
    // A/B evidence for the actual defect run: the scoring run ABORTED on budget AND no candidate
    // shipped. Every blocker that fired before this fix must still fire — the wording changed, the
    // decision did not.
    const gate = classifyMintGate({
      deployment: undefined,
      deploymentComparisons: [deployment({ ships: false }), deployment({ ships: false })],
      floor: undefined,
      research: RESEARCH_FAIL,
      run: { voided: false, aborted: true, unfaithfulCapsRows: 0 },
      experimentsLogged: true,
    });
    expect(gate.mint).toBe(false);
    const blockers = gate.blockers.join(' ');
    expect(blockers).toContain('ABORTED on budget'); // the run blocker — untouched by this fix
    expect(blockers).toContain('no candidate was SELECTED'); // the deployment blocker — reworded, still blocks
    expect(blockers).toContain('no candidate was SELECTED to evaluate it'); // the floor blocker — reworded, still blocks
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

  // ── the chronological-halves clause (deployment-bar-halves-clause-2026-07-31.md) ───────────────

  it('does NOT mint a HALF-LOST win, and says so differently from the horizon refusal', () => {
    // Wins every horizon INCLUDING the primary — the two original conjuncts are both satisfied — and
    // still does not ship, because the win is located in half of a single-regime window.
    const gate = classifyMintGate({
      deployment: deployment({
        ships: false,
        halvesVerdict: 'HALF_LOST',
        halves: {
          splitAtMs: 1784913300000,
          armEarly: -90,
          armLate: 120,
          incumbentEarly: -60,
          incumbentLate: -80,
          armEarlyN: 30,
          armLateN: 30,
          incumbentEarlyN: 34,
          incumbentLateN: 35,
          minEntries: 12,
          determined: true,
          reason: 'loses the EARLY half at the primary horizon.',
        },
      }),
      research: RESEARCH_FAIL,
      floor: FLOOR_PASS,
      run: HEALTHY_RUN,
      experimentsLogged: true,
    });
    expect(gate).toMatchObject({ mint: false, deploymentVerdict: 'HALF-LOST' });
    const blockers = gate.blockers.join(' ');
    expect(blockers).toContain('LOSES A CHRONOLOGICAL HALF');
    // The distinguishability requirement: a reader must never see this reported as the OTHER
    // refusal. The horizon refusal's own two phrases are absent, and the text says which one this is
    // NOT — asserted positively, because the discriminating sentence is the deliverable.
    expect(blockers).not.toContain('only (4/4 horizons)');
    expect(blockers).not.toContain('the pre-registered robustness clause does not ship it');
    expect(blockers).toContain('is NOT the horizon-dependent refusal');
    expect(gate.deploymentVerdict).not.toBe('HORIZON-DEPENDENT');
    // And the arm did win the horizon clause outright, so the two refusals cannot be conflated.
    expect(gate.blockers).toHaveLength(1);
  });

  it.each([
    [
      'UNDETERMINED',
      {
        halvesVerdict: 'UNDETERMINED',
        halves: { determined: false, reason: 'a half-mean is not finite.' },
      },
    ],
    // A comparison from a harness that predates the clause did not compute it either — same
    // condition, so the same refusal. Absent is never read as satisfied.
    ['ABSENT', { halvesVerdict: undefined, halves: undefined }],
  ])(
    'refuses the UNATTENDED mint on a %s halves clause, even though it SHIPS',
    (_label, overrides) => {
      const d = deployment(overrides);
      // The clause fails OPEN for a human: `ships` is unaffected, and that is the point of the
      // asymmetry — the gate restricts the WRITER, not the finding.
      expect(d.ships).toBe(true);
      const gate = classifyMintGate({
        deployment: d,
        research: RESEARCH_FAIL,
        floor: FLOOR_PASS,
        run: HEALTHY_RUN,
        experimentsLogged: true,
      });
      expect(gate.mint).toBe(false);
      // Still SHIPS: the deployment verdict is NOT downgraded. Only the automated write is refused.
      expect(gate.deploymentVerdict).toBe('SHIPS');
      const blockers = gate.blockers.join(' ');
      expect(blockers).toContain('chronological-halves clause is');
      expect(blockers).toContain('on its own authority');
    },
  );

  it('reports the attempt count on the record, and NOT COUNTED rather than a zero', () => {
    const counted = classifyMintGate({
      deployment: deployment(),
      research: RESEARCH_FAIL,
      floor: FLOOR_PASS,
      run: HEALTHY_RUN,
      experimentsLogged: true,
      priorAttemptsOnCorpus: {
        count: 6,
        byFingerprint: 2,
        key: { rowsLoaded: 386, rowSince: 1784646000000, rowUntil: 1785180600000 },
      },
    });
    expect(counted.mint).toBe(true);
    expect(counted.reason).toContain('6 prior registry row(s)');
    // The count is a REPORT. It must never be readable as a threshold that was cleared.
    expect(counted.reason).toContain('never a gate');
    // The fingerprint disagreement is surfaced wherever it exists, not buried.
    expect(counted.reason).toContain('drift');

    const uncounted = classifyMintGate({
      deployment: deployment(),
      research: RESEARCH_FAIL,
      floor: FLOOR_PASS,
      run: HEALTHY_RUN,
      experimentsLogged: true,
    });
    // An unmeasured count reads as unmeasured. A zero here would be a false claim about history.
    expect(uncounted.reason).toContain('NOT COUNTED');
    expect(uncounted.mint).toBe(true);
  });

  it('keys the counter on the identity tuple, never on the drifting fields', () => {
    expect(corpusAttemptKey({ rows: 386, firstEventTime: 10, lastEventTime: 20 })).toEqual({
      rowsLoaded: 386,
      rowSince: 10,
      rowUntil: 20,
    });
    // rowSince/rowUntil win over firstEventTime/lastEventTime when both are present: registry row
    // id=5 records a firstEventTime of its replayed SUBSET while its five siblings on the same
    // corpus record the corpus's. The query bounds held across all six.
    expect(
      corpusAttemptKey({
        rowsLoaded: 204,
        rowSince: 1783714500000,
        rowUntil: 1783876500000,
        firstEventTime: 1783862100000,
        lastEventTime: 1783876500000,
      }),
    ).toEqual({ rowsLoaded: 204, rowSince: 1783714500000, rowUntil: 1783876500000 });
    // Underivable ⇒ null ⇒ "NOT COUNTED". Never a fabricated key that would silently group nothing.
    expect(corpusAttemptKey({ rows: 386 })).toBeNull();
    expect(corpusAttemptKey(null)).toBeNull();
    expect(renderPriorAttempts(null)).toBe('NOT COUNTED');
  });
});

// 6. THE REGISTRY SCORECARD. public.experiments is append-only — a row logged with no truncation
//    marker off an ABORTED or VOID run cannot ever be corrected. buildScorecard used to live
//    UN-exported in loop-authoring.mjs and was called with the raw `score` rather than the run-status
//    wrapper every other renderer receives; that wiring gap logged three real rows (id=18/19/20) with
//    no marker at all before this suite existed. Moved here specifically so the wiring is a tested
//    contract, not a call site nobody checked.
describe('loop-authoring registry scorecard', () => {
  function scoreFixture(overrides = {}) {
    return {
      corpus: { payloadSha256: 'corpus-sha', firstEventTime: 100, lastEventTime: 200, rows: 67 },
      rowsCovered: 67,
      model: 'claude-sonnet-5',
      incumbentArm: 'incumbent_v10',
      dryRun: false,
      costPerDecideUsd: 0.0021,
      ...overrides,
    };
  }

  function reportFixture(overrides = {}) {
    return {
      arm: 'draft_conservative',
      role: 'candidate',
      rowsReplayed: 67,
      schemaValidRate: 1,
      entries: 1,
      entryRate: 0.015,
      actionHistogram: { hold: 66, open_long: 1 },
      decisionsChangedVsIncumbent: 12,
      cells: [{ h: 24, mean: 47.6, ciLo: -12.2 }],
      ...overrides,
    };
  }

  it('carries an EMPTY runTruncation on a healthy run — the row is a plain, uncaveated measurement', () => {
    const card = buildScorecard(scoreFixture(), reportFixture(), null, HEALTHY_RUN);
    expect(card.candidates[0].runTruncation).toEqual([]);
  });

  it('carries the truncation reasons INSIDE candidates[0], where log-eval-experiment.mjs’s spread keeps them', () => {
    // log-eval-experiment.mjs builds `metrics` as `{...candidate, corpusFingerprint, championReference,
    // window, priorAttemptsOnCorpus, …}` — an explicit, short list of TOP-LEVEL scorecard fields plus
    // whatever `candidates[0]` itself carries. A field placed at the scorecard's own top level and not
    // on that list would be silently dropped before it reached the row; this assertion is what makes
    // that placement a checked contract rather than a fact only a reader of the other script would know.
    const abortedRun = { voided: false, aborted: true, unfaithfulCapsRows: 0 };
    const card = buildScorecard(scoreFixture(), reportFixture(), null, abortedRun);
    expect(card.runTruncation).toBeUndefined(); // NOT at the top level — it would be dropped there
    expect(card.candidates[0].runTruncation).toHaveLength(1);
    expect(card.candidates[0].runTruncation[0]).toContain('ABORTED on budget');
  });

  it('the unfaithful-capabilities defect reaches the registry row too — the gate refusal this used to miss', () => {
    const unfaithfulRun = { voided: false, aborted: false, unfaithfulCapsRows: 4 };
    const card = buildScorecard(scoreFixture(), reportFixture(), null, unfaithfulRun);
    expect(card.candidates[0].runTruncation[0]).toContain('measured a different account');
  });

  it('A/B: the raw score object (the pre-fix call shape) carries NO run-usability information at all', () => {
    // This IS the actual defect that logged id=18/19/20: loop-authoring.mjs used to call
    // `buildScorecard(score, report, priorAttemptsOnCorpus)` — no fourth argument — so an ABORTED run
    // produced a row indistinguishable from a clean one. Passing `score` itself in the run slot (as
    // the old call site effectively did, by omitting it) demonstrates the row is UNLABELLED even
    // though the run that produced it aborted, because `score` alone carries no `aborted`/`voided`
    // status until the shell wraps it into `scoringRun`.
    const score = scoreFixture(); // note: NOT wrapped with { aborted: true } — this is `score`, not `run`
    const cardWithRawScore = buildScorecard(score, reportFixture(), null, undefined);
    // Even with nothing indicating the run's status, this function now REFUSES to render a bare "[]" —
    // a missing run argument is itself uncertified (describeRunTruncation's own contract).
    expect(cardWithRawScore.candidates[0].runTruncation).toHaveLength(1);
    expect(cardWithRawScore.candidates[0].runTruncation[0]).toContain('no run object was supplied');

    // The fixed call shape: the SAME aborted run threaded through explicitly labels the row.
    const cardWithScoringRun = buildScorecard(score, reportFixture(), null, {
      ...score,
      voided: false,
      aborted: true,
    });
    expect(cardWithScoringRun.candidates[0].runTruncation[0]).toContain('ABORTED on budget');
  });

  it('does not otherwise disturb the scorecard shape log-eval-experiment.mjs requires', () => {
    const card = buildScorecard(scoreFixture(), reportFixture(), null, HEALTHY_RUN);
    expect(card).toMatchObject({
      criteriaVersion: 'loop-authoring-v1',
      corpusFingerprint: 'corpus-sha',
      capabilities: 'recorded (per-row, from the live payload)',
      championReference: 'incumbent_v10',
    });
    expect(card.candidates[0]).toMatchObject({
      model: 'claude-sonnet-5',
      arm: 'draft_conservative',
      proposeCount: 1,
      directionalForwardProxyBps: 47.6,
    });
  });
});

describe('loop-authoring reporting', () => {
  it('renders both bars with their own labels and never merges them', () => {
    const out = renderTwoBars({
      arm: 'draft_conservative',
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

  // ── the truncation banner (2026-08-04) ────────────────────────────────────────────────────────
  //
  // The defect this reproduces: an ABORTED run's stage-5 table printed full bps deltas with no label
  // anywhere near them, so a reader (or a future automated pass reading research/loop/LOG.md) could
  // copy a number out of the table without also copying the words that void it.

  describe('describeRunTruncation', () => {
    it('returns no reasons for a healthy run — the only case with an empty result', () => {
      expect(describeRunTruncation(HEALTHY_RUN)).toEqual([]);
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
    ])(
      'treats a MISSING run (%s) as UNCERTIFIED, not as "nothing to report" — a misquotation guard must not fail open',
      (_label, run) => {
        const reasons = describeRunTruncation(run);
        expect(reasons).toHaveLength(1);
        expect(reasons[0]).toContain('no run object was supplied');
      },
    );

    it('names a VOID run', () => {
      const reasons = describeRunTruncation({ voided: true, aborted: false });
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toContain('VOID');
    });

    it('names an ABORTED run', () => {
      const reasons = describeRunTruncation({ voided: false, aborted: true });
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toContain('ABORTED on budget');
    });

    it('carries spend and row coverage inline when the run supplies them — the 2026-08-06 shape', () => {
      // The real defect run (research/loop/LOG.md, authoring-2026-08-06): $5.0015 across 348 calls,
      // 108 of 150 requested rows covered before the cap tripped. "ABORTED on budget" alone told the
      // operator neither number.
      const reasons = describeRunTruncation({
        voided: false,
        aborted: true,
        meter: { calls: 348, usd: '5.0015' },
        rowsRequested: 150,
        rowsCovered: 108,
      });
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toContain('ABORTED on budget');
      expect(reasons[0]).toContain('$5.0015');
      expect(reasons[0]).toContain('108/150 rows scored');
    });

    it('drops the spend/coverage clauses rather than rendering $undefined or 0/0 when the run lacks them', () => {
      // Same case as 'names an ABORTED run' above, restated as the negative to make the omission an
      // assertion rather than an accident of what the fixture happens to carry.
      const reasons = describeRunTruncation({ voided: false, aborted: true });
      expect(reasons[0]).not.toContain('$undefined');
      expect(reasons[0]).not.toContain('0/0 rows');
      expect(reasons[0]).toBe(
        'the scoring run ABORTED on budget — arms are truncated, not comparable',
      );
    });

    // REGRESSION for the must-fix: classifyMintGate refuses on unfaithfulCapsRows > 0 ("the replay
    // measured a different account") and, before this fix, describeRunTruncation had no idea that
    // blocker existed — a run with unfaithful capabilities and NEITHER voided NOR aborted rendered as
    // fully usable everywhere except the gate itself.
    it('names the unfaithful-capabilities defect — the gate refusal this function used to miss entirely', () => {
      const reasons = describeRunTruncation({
        voided: false,
        aborted: false,
        unfaithfulCapsRows: 3,
      });
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toContain('3 row(s)');
      expect(reasons[0]).toContain('measured a different account');
    });

    it('names ALL THREE when they all fire — same independence as classifyMintGate’s own run block', () => {
      const reasons = describeRunTruncation({ voided: true, aborted: true, unfaithfulCapsRows: 5 });
      expect(reasons).toHaveLength(3);
    });
  });

  it('defaults to an UNCERTIFIED banner when the run is not passed at all — the misquotation guard fails CLOSED, not open', () => {
    const out = renderTwoBars({
      arm: 'draft_conservative',
      deployment: deployment(),
      research: RESEARCH_FAIL,
    });
    expect(out).toContain('TRUNCATED');
    expect(out).toContain('no run object was supplied');
  });

  it('renders NO banner only for an explicitly healthy run — the one case that is genuinely certified', () => {
    const out = renderTwoBars({
      arm: 'draft_conservative',
      deployment: deployment(),
      research: RESEARCH_FAIL,
      run: HEALTHY_RUN,
    });
    expect(out).not.toContain('TRUNCATED');
    expect(out).not.toContain('VOID');
  });

  it('A/B: an ABORTED run carries the truncation label on the SAME table that prints its bps deltas', () => {
    // "A" — the baseline: an explicitly healthy run renders the table with no banner at all.
    const before = renderTwoBars({
      arm: 'draft_conservative',
      deployment: deployment(),
      research: RESEARCH_FAIL,
      run: HEALTHY_RUN,
    });
    expect(before).not.toContain('TRUNCATED');
    expect(before).toContain('h=24'); // the bps deltas render, unlabelled, because nothing voids them here

    // "B" — post-fix shape for an ABORTED run: the SAME table now carries the label inline, adjacent
    // to the numbers it voids, not as a footnote elsewhere. This is the actual production defect: the
    // real 2026-08-04 run aborted on budget and stage 5 printed this exact table with no such banner.
    const after = renderTwoBars({
      arm: 'draft_conservative',
      deployment: deployment(),
      research: RESEARCH_FAIL,
      run: { voided: false, aborted: true, unfaithfulCapsRows: 0 },
    });
    expect(after).toContain('TRUNCATED');
    expect(after).toContain('MAY NOT BE QUOTED');
    expect(after).toContain('ABORTED on budget');
    // The label sits ABOVE the per-horizon deltas in the same block, not merely somewhere in the file.
    const bannerLine = after.split('\n').findIndex((l) => l.includes('TRUNCATED'));
    const firstDeltaLine = after.split('\n').findIndex((l) => l.includes('h='));
    expect(bannerLine).toBeGreaterThanOrEqual(0);
    expect(bannerLine).toBeLessThan(firstDeltaLine);
    // Nothing else about the table was weakened — every field from the healthy render still appears.
    expect(after).toContain('h=24');
    expect(after).toContain('SHIPS');
    expect(after).toContain('NEVER the same bar');
  });

  // A/B for the must-fix: unfaithful capabilities used to be invisible to every renderer even though
  // the gate itself refuses on it.
  it('A/B: unfaithful-capabilities rows also carry the banner — the gate refusal this function used to miss', () => {
    const healthy = renderTwoBars({
      arm: 'draft_conservative',
      deployment: deployment(),
      research: RESEARCH_FAIL,
      run: HEALTHY_RUN,
    });
    expect(healthy).not.toContain('TRUNCATED');

    const unfaithful = renderTwoBars({
      arm: 'draft_conservative',
      deployment: deployment(),
      research: RESEARCH_FAIL,
      run: { voided: false, aborted: false, unfaithfulCapsRows: 3 },
    });
    expect(unfaithful).toContain('TRUNCATED');
    expect(unfaithful).toContain('measured a different account');
  });

  // ── the 2026-08-06 budget-abort regression (null-scored cells) ───────────────────────────────
  //
  // research/loop/LOG.md, authoring-2026-08-06: the day's slot (public.experiments id=21) drafted 2
  // variants, ran 630s of replay, then hit the $5 spend cap mid-scoring and aborted. Every deployment
  // cell was legitimately unscored — `armMean`/`incumbentMean`/`deltaBps: null` throughout — and
  // renderTwoBars called `h.armMean.toFixed(1)` directly on that null and threw. The throw fired at
  // stage 5, so stage 6 (buildScorecard → public.experiments) never ran: the whole paid run
  // ($5.0015, 348 calls) left NO registry evidence at all. A `--dry-run` beforehand does not catch
  // this — synthetic dry-run variants score non-null, so the abort path is never exercised.

  function abortedNullDeployment(overrides = {}) {
    return {
      arm: 'draft_conservative',
      incumbent: 'incumbent_v10',
      primaryHorizon: 24,
      perHorizon: [
        { h: 1, armMean: null, incumbentMean: null, deltaBps: null, beats: false },
        { h: 4, armMean: null, incumbentMean: null, deltaBps: null, beats: false },
        { h: 8, armMean: null, incumbentMean: null, deltaBps: null, beats: false },
        { h: 24, armMean: null, incumbentMean: null, deltaBps: null, beats: false },
      ],
      horizonsWon: 0,
      horizonsCompared: 4,
      ships: false,
      halvesVerdict: undefined,
      ...overrides,
    };
  }

  const ABORTED_2026_08_06_RUN = {
    voided: false,
    aborted: true,
    unfaithfulCapsRows: 0,
    meter: { calls: 348, usd: '5.0015' },
    rowsRequested: 150,
    rowsCovered: 108,
  };

  it('REGRESSION: an aborted score object whose perHorizon cells are all-null renders without throwing', () => {
    // MUTATION PROOF this test fails against unpatched code: reverting renderTwoBars's per-horizon
    // loop to `h.armMean.toFixed(1)` (dropping formatBpsOrUnscored and the optional-chained `h?.`
    // reads) reproduces exactly the 2026-08-06 crash — `TypeError: Cannot read properties of null
    // (reading 'toFixed')` — and this assertion is what catches it (verified by hand against the
    // pre-fix source before this test was added; see the PR's return summary for the transcript).
    expect(() =>
      renderTwoBars({
        arm: 'draft_conservative',
        deployment: abortedNullDeployment(),
        research: null,
        run: ABORTED_2026_08_06_RUN,
      }),
    ).not.toThrow();
  });

  it('REGRESSION: the same call shows the unscored marker on every null cell, not a fabricated number', () => {
    const out = renderTwoBars({
      arm: 'draft_conservative',
      deployment: abortedNullDeployment(),
      research: null,
      run: ABORTED_2026_08_06_RUN,
    });
    // The trailing verdict reads `n/a`, NOT `loss`: an unscored cell carries beats:false, so the
    // original `beats ? win : loss` reported a defeat that was never measured and rendered the
    // self-contradicting row `n/a n/a n/a loss`. Tightened here rather than relaxed — the row now
    // pins the verdict column too.
    expect(out).toContain('h= 1  arm      n/a vs incumbent      n/a bps  Δ      n/a  n/a');
    expect(out).toContain('h=24  arm      n/a vs incumbent      n/a bps  Δ      n/a  n/a');
    // Never mistakable for a measured zero.
    expect(out).not.toMatch(/arm\s+0\.0/);
    expect(out).not.toMatch(/incumbent\s+0\.0/);
    expect(out).not.toMatch(/Δ\s+0\.0/);
  });

  it('the abort banner leads the render and carries the spend and row coverage', () => {
    const out = renderTwoBars({
      arm: 'draft_conservative',
      deployment: abortedNullDeployment(),
      research: null,
      run: ABORTED_2026_08_06_RUN,
    });
    expect(out).toContain('TRUNCATED');
    expect(out).toContain('MAY NOT BE QUOTED');
    expect(out).toContain('ABORTED on budget');
    expect(out).toContain('$5.0015');
    expect(out).toContain('108/150 rows scored');
    // Leads the render: above the per-horizon rows it voids, same as the 2026-08-04 fix's own check.
    const bannerLine = out.split('\n').findIndex((l) => l.includes('TRUNCATED'));
    const firstHorizonLine = out.split('\n').findIndex((l) => l.includes('h='));
    expect(bannerLine).toBeGreaterThanOrEqual(0);
    expect(bannerLine).toBeLessThan(firstHorizonLine);
  });

  it('an unscored cell never renders as 0.0', () => {
    const out = renderTwoBars({
      arm: 'x',
      deployment: abortedNullDeployment({
        perHorizon: [{ h: 1, armMean: undefined, incumbentMean: undefined, deltaBps: undefined }],
      }),
      research: null,
      run: ABORTED_2026_08_06_RUN,
    });
    expect(out).toContain('n/a');
    expect(out).not.toContain('0.0');
  });

  // Number('') === 0, Number(false) === 0 and Number([]) === 0 are all FINITE, so a Number()-based
  // guard renders them '0.0' — a fabricated zero indistinguishable from a measured one, which is the
  // single thing this marker exists to prevent. Real scoring data is null, so this is defence
  // against a future shape rather than an observed case.
  it.each([
    ['empty string', ''],
    ['false', false],
    ['empty array', []],
  ])('a non-numeric %s renders as unscored, never as a fabricated 0.0', (_label, poison) => {
    const out = renderTwoBars({
      arm: 'x',
      deployment: abortedNullDeployment({
        perHorizon: [{ h: 1, armMean: poison, incumbentMean: poison, deltaBps: poison }],
      }),
      research: null,
      run: ABORTED_2026_08_06_RUN,
    });
    expect(out).toContain('n/a');
    expect(out).not.toContain('0.0');
  });

  // An unscored cell carries beats:false alongside its null means, so a bare `beats ? win : loss`
  // printed a measured defeat that was never measured — and produced the self-contradicting row
  // `n/a n/a n/a loss`. The verdict must key off the same means the bps columns key off.
  it('an unscored cell renders no win/loss verdict, so the row cannot contradict itself', () => {
    const out = renderTwoBars({
      arm: 'x',
      deployment: abortedNullDeployment({
        perHorizon: [{ h: 1, armMean: null, incumbentMean: null, deltaBps: null, beats: false }],
      }),
      research: null,
      run: ABORTED_2026_08_06_RUN,
    });
    const row = out.split('\n').find((l) => l.includes('h= 1'));
    expect(row).toBeDefined();
    expect(row).not.toContain('loss');
    expect(row).not.toContain('win');
  });

  it('a fully scored cell still renders its win/loss verdict', () => {
    const out = renderTwoBars({
      arm: 'x',
      deployment: abortedNullDeployment({
        perHorizon: [{ h: 1, armMean: 10, incumbentMean: -2, deltaBps: 12, beats: true }],
      }),
      research: null,
      run: ABORTED_2026_08_06_RUN,
    });
    expect(out.split('\n').find((l) => l.includes('h= 1'))).toContain('win');
  });

  it('renderTwoBars is TOTAL: never throws for any shape of deployment/perHorizon/research', () => {
    const healthyRun = HEALTHY_RUN;
    const cases = [
      [
        'missing deployment',
        { arm: 'x', deployment: undefined, research: RESEARCH_FAIL, run: healthyRun },
      ],
      [
        'missing perHorizon',
        { arm: 'x', deployment: { arm: 'x' }, research: RESEARCH_FAIL, run: healthyRun },
      ],
      [
        'empty perHorizon array',
        {
          arm: 'x',
          deployment: { arm: 'x', perHorizon: [] },
          research: RESEARCH_FAIL,
          run: healthyRun,
        },
      ],
      [
        'empty/malformed per-horizon cells ("empty arms")',
        {
          arm: 'x',
          deployment: { arm: 'x', perHorizon: [{}, null, undefined] },
          research: RESEARCH_FAIL,
          run: healthyRun,
        },
      ],
      [
        'a non-array perHorizon',
        {
          arm: 'x',
          deployment: { arm: 'x', perHorizon: 'not-an-array' },
          research: RESEARCH_FAIL,
          run: healthyRun,
        },
      ],
      [
        'null research',
        { arm: 'x', deployment: abortedNullDeployment(), research: null, run: healthyRun },
      ],
      [
        'the exact 2026-08-06 abort shape',
        {
          arm: 'x',
          deployment: abortedNullDeployment(),
          research: null,
          run: ABORTED_2026_08_06_RUN,
        },
      ],
    ];
    for (const [, args] of cases) {
      expect(() => renderTwoBars(args)).not.toThrow();
    }
  });

  // ── FIX 5 (2026-08-06 adversarial review): the winner-sort's own perHorizon guard ────────────────
  //
  // loop-authoring.mjs's stage-5/7 boundary keeps `shipping`/`winner` OUTSIDE the renderTwoBars
  // try/catch on purpose (load-bearing for stage 7's mint). But the winner sort used to do
  // `a.perHorizon.find(...)` unguarded on the SAME `perHorizon` field renderTwoBars was just hardened
  // against one line above — so a `ships: true` candidate with a malformed `perHorizon` (the exact
  // budget-cap shape formatBpsOrUnscored's header describes) reproduced the identical lost-registry-row
  // defect one line below the render guard. primaryHorizonDeltaBps is the extracted, guarded lookup the
  // sort now calls instead.
  describe('primaryHorizonDeltaBps', () => {
    it('returns the deltaBps of the cell matching the candidate primaryHorizon', () => {
      const candidate = {
        primaryHorizon: 24,
        perHorizon: [
          { h: 4, deltaBps: 5 },
          { h: 24, deltaBps: 117 },
        ],
      };
      expect(primaryHorizonDeltaBps(candidate)).toBe(117);
    });

    it('returns -Infinity when perHorizon has no cell for the primary horizon', () => {
      const candidate = { primaryHorizon: 24, perHorizon: [{ h: 4, deltaBps: 5 }] };
      expect(primaryHorizonDeltaBps(candidate)).toBe(-Infinity);
    });

    // MUTATION PROOF: reverting this function's body to the pre-fix
    // `candidate.perHorizon.find((h) => h.h === candidate.primaryHorizon)?.deltaBps ?? -Infinity`
    // (dropping the Array.isArray guard) throws `TypeError: Cannot read properties of undefined
    // (reading 'find')` on each of the cases below.
    it.each([
      ['missing perHorizon', { primaryHorizon: 24 }],
      ['null perHorizon', { primaryHorizon: 24, perHorizon: null }],
      [
        'non-array perHorizon (the malformed-cell shape)',
        { primaryHorizon: 24, perHorizon: 'n/a' },
      ],
      ['empty perHorizon array', { primaryHorizon: 24, perHorizon: [] }],
      ['null cells inside perHorizon', { primaryHorizon: 24, perHorizon: [null, undefined, {}] }],
      ['undefined candidate', undefined],
    ])('never throws — %s', (_label, candidate) => {
      expect(() => primaryHorizonDeltaBps(candidate)).not.toThrow();
      expect(primaryHorizonDeltaBps(candidate)).toBe(-Infinity);
    });

    it('a candidate with no data ranks LAST when sorting shippers, never throws the sort itself', () => {
      const healthy = { arm: 'healthy', primaryHorizon: 24, perHorizon: [{ h: 24, deltaBps: 10 }] };
      const malformed = { arm: 'malformed', primaryHorizon: 24, perHorizon: 'not-an-array' };
      const shipping = [malformed, healthy];
      let winner;
      expect(() => {
        winner = shipping
          .slice()
          .sort((a, b) => primaryHorizonDeltaBps(b) - primaryHorizonDeltaBps(a))[0];
      }).not.toThrow();
      expect(winner.arm).toBe('healthy');
    });
  });

  it('PIN: a fully-scored, healthy run renders byte-identically to today’s output — no happy-path regression', () => {
    // Generated off the ACTUAL patched output and pinned verbatim, so any future edit that changes a
    // single space in the healthy path fails this test loudly rather than drifting unnoticed.
    const out = renderTwoBars({
      arm: 'draft_conservative',
      deployment: deployment(),
      research: RESEARCH_FAIL,
      run: HEALTHY_RUN,
    });
    expect(out).toBe(
      [
        '  variant:          draft_conservative',
        '  DEPLOYMENT bar    (beats the RUNNING playbook on the same corpus/metric/horizons):',
        '    incumbent incumbent_v10, primary h=24, 4/4 horizons won ⇒ SHIPS',
        '      h= 1  arm     -1.0 vs incumbent    -12.0 bps  Δ     11.0  win',
        '      h= 4  arm      1.0 vs incumbent    -36.0 bps  Δ     37.0  win',
        '      h= 8  arm     19.0 vs incumbent    -32.0 bps  Δ     51.0  win',
        '      h=24  arm     47.0 vs incumbent    -70.0 bps  Δ    117.0  win',
        '    chronological halves (h=24 only): BOTH_WON — wins BOTH chronological halves at the primary horizon.',
        '    attribution: PROMPT-CONTROLLED',
        '  ATTEMPTS ON THIS CORPUS: NOT COUNTED',
        '  RESEARCH bar      (does an edge exist? mean AND CI lo > +13.0 bps under the family alpha):',
        '    8/8 cells, 0 passes ⇒ NO_SURVIVOR',
        '  These are NEVER the same bar. A research-bar FAIL is not a deployment veto (verdicts.md,',
        '  owner ruling 2026-07-30); a deployment win is not an edge claim.',
      ].join('\n'),
    );
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

  it('renders the halves clause on its own line and the attempt count beside the bar', () => {
    const out = renderTwoBars({
      arm: 'x',
      deployment: deployment(),
      research: RESEARCH_FAIL,
      priorAttemptsOnCorpus: {
        count: 6,
        byFingerprint: 2,
        key: { rowsLoaded: 386, rowSince: 1784646000000, rowUntil: 1785180600000 },
      },
    });
    expect(out).toContain('chronological halves');
    expect(out).toContain('BOTH_WON');
    expect(out).toContain('ATTEMPTS ON THIS CORPUS');
    expect(out).toContain('6 prior registry row(s)');
  });

  it('labels a HALF-LOST refusal as such rather than as a horizon-dependent one', () => {
    const out = renderTwoBars({
      arm: 'x',
      deployment: deployment({ ships: false, halvesVerdict: 'HALF_LOST' }),
      research: RESEARCH_FAIL,
    });
    expect(out).toContain('HALF-LOST (does NOT ship)');
    expect(out).not.toContain('HORIZON-DEPENDENT');
    // An uncounted pass says so here too.
    expect(out).toContain('NOT COUNTED');
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

describe('loop-authoring per-horizon net table', () => {
  // The standing objective is qualified PER HORIZON ("reduce the rate where net is negative, hold
  // where it is not"), so the drafting model must be SHOWN the net. The failure this suite guards is
  // the void read: an unmeasured horizon that is omitted, or rendered as a zero, reads to a model as
  // "measured, and fine" — and the horizons the running playbook actually holds to (40, 48) are
  // exactly the ones nothing has ever measured.

  const PLANNED = [
    { h: 40, n: 1 },
    { h: 48, n: 5 },
  ];

  /** Single-digit horizons are right-padded in the table, so `h=1` renders as `h= 1`. */
  const rowFor = (table, h) =>
    table.split('\n').find((l) => new RegExp(`^h=\\s*${h}\\b`).test(l.trim()));

  it('renders an UNMEASURED horizon as UNMEASURED — not omitted, not defaulted to zero', () => {
    const table = buildPerHorizonNetTable({ incumbent: { version: 10 }, plannedHorizons: PLANNED });
    for (const h of [40, 48]) {
      const row = rowFor(table, h);
      expect(row, `h=${h} row must exist`).toBeDefined();
      expect(row).toContain('UNMEASURED');
      expect(row).toContain('NOT zero and NOT favourable');
      // No figure may appear on an unmeasured row: a "+0.0" or an "n=0" is the interpolation the
      // instruction forbids.
      expect(row).not.toMatch(/[+-]\d+\.\d/);
      expect(row).not.toContain('NET');
    }
  });

  it('carries the horizons the running playbook actually plans, with their counts', () => {
    const table = buildPerHorizonNetTable({ incumbent: { version: 10 }, plannedHorizons: PLANNED });
    expect(table).toContain('planned this hold length 5x');
    expect(table).toContain('planned this hold length 1x');
  });

  it('nets every measured cell against the demo floor and never a flat 20 bps', () => {
    const table = buildPerHorizonNetTable({ incumbent: { version: 10 }, plannedHorizons: PLANNED });
    expect(COST_FLOOR_BPS).toEqual({ demo: 13.0, live: 24.2 });
    // h=1 gross -0.8 - 13.0 = -13.8; h=24 gross +47.6 - 13.0 = +34.6 (a flat-20 floor would read
    // +27.6, the figure verdicts.md records as an error).
    expect(table).toContain('NET  -13.8');
    expect(table).toContain('NET  +34.6');
    expect(table).not.toContain('+27.6');
    expect(table).toContain('+24.2 bps/trip live');
  });

  it('labels each measured horizon with the action the standing objective prescribes', () => {
    const table = buildPerHorizonNetTable({ incumbent: { version: 10 } });
    expect(rowFor(table, 1)).toContain('NET NEGATIVE — reduce the entry rate here');
    expect(rowFor(table, 4)).toContain('NET NEGATIVE — reduce the entry rate here');
    // h=8 nets +6.3 at the mean but -11.9 at the CI lower bound: hold, do not raise.
    expect(rowFor(table, 8)).toContain(
      'CI lower bound below the floor — hold the rate, do not raise it',
    );
    expect(rowFor(table, 24)).toContain('hold the rate, do not raise it');
  });

  it('renders EVERY horizon UNMEASURED when the running playbook has no frozen measurement', () => {
    // The same posture resolveIncumbent takes: no literal fallback. Quoting v10's cells for another
    // version would attribute a measurement to a playbook nobody scored.
    expect(MEASURED_HORIZON_CELLS[8]).toBeUndefined();
    const table = buildPerHorizonNetTable({
      incumbent: { version: 8 },
      plannedHorizons: [{ h: 24, n: 3 }],
    });
    expect(table).toContain('No frozen per-horizon measurement exists');
    expect(table).toContain('every row below is UNMEASURED');
    expect(rowFor(table, 24)).toContain('UNMEASURED');
  });

  it('measures h in {1,4,8,24} and NOTHING beyond — the declared horizon set, unchanged', () => {
    expect(MEASURED_HORIZON_CELLS[10].cells.map((c) => c.h)).toEqual([1, 4, 8, 24]);
  });

  it('reports no horizons rather than an empty table when nothing is measured or planned', () => {
    expect(buildPerHorizonNetTable({ incumbent: { version: 8 } })).toContain(
      'no horizons to report',
    );
  });

  it('reaches the drafting model — the digest carries the table, not just this function', () => {
    const digest = buildEvidenceDigest({
      decisions: undefined,
      versionStats: [],
      roundTrips: null,
      incumbent: { version: 10 },
      plannedHorizons: PLANNED,
    });
    expect(digest).toContain('PER-HORIZON FORWARD RETURN, NET OF THE COST FLOOR');
    expect(rowFor(digest, 48)).toContain('UNMEASURED');
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

// 4. THE SPLIT BRAIN. The pass READS its same-day gate and attempt counter over DATABASE_URL and
//    WRITES every scored variant to public.experiments over REGISTRY_DATABASE_URL. Divergence is the
//    worst class of defect this pass can have: the gate reads a table nobody writes and the counter
//    under-reports forever, while every stage still prints OK. It is asserted because there is no
//    output in which it would ever look wrong.
describe('registry split-brain guard', () => {
  const PASSWORD = 'hunter2';
  const READ = `postgres://cryptobot:${PASSWORD}@127.0.0.1:5432/cryptobot`;

  it('passes when both URLs address the same host and database', () => {
    expect(classifyRegistrySplitBrain({ databaseUrl: READ, registryUrl: READ })).toMatchObject({
      ok: true,
      checked: true,
    });
  });

  it('ignores credential and query-string differences — they do not change the target', () => {
    const sameTargetOtherCreds =
      'postgres://other:different@127.0.0.1:5432/cryptobot?sslmode=require';
    expect(
      classifyRegistrySplitBrain({ databaseUrl: READ, registryUrl: sameTargetOtherCreds }).ok,
    ).toBe(true);
  });

  it('treats an omitted port as the pg default rather than a divergence', () => {
    expect(
      classifyRegistrySplitBrain({
        databaseUrl: 'postgres://cryptobot@db.internal/cryptobot',
        registryUrl: 'postgres://cryptobot@db.internal:5432/cryptobot',
      }).ok,
    ).toBe(true);
  });

  it.each([
    ['a different database', `postgres://cryptobot:${PASSWORD}@127.0.0.1:5432/cryptobot_test`],
    ['a different host', `postgres://cryptobot:${PASSWORD}@postgres:5432/cryptobot`],
    ['a different port', `postgres://cryptobot:${PASSWORD}@127.0.0.1:5433/cryptobot`],
  ])('refuses on %s', (_label, registryUrl) => {
    const verdict = classifyRegistrySplitBrain({ databaseUrl: READ, registryUrl });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('SPLIT BRAIN');
  });

  // Not a normalisation the guard is allowed to make: this process cannot know whether the two
  // spellings reach one server, and guessing wrong is the silent failure the guard exists to stop.
  it('reports localhost vs 127.0.0.1 as the genuine ambiguity it is', () => {
    const verdict = classifyRegistrySplitBrain({
      databaseUrl: READ,
      registryUrl: `postgres://cryptobot:${PASSWORD}@localhost:5432/cryptobot`,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('localhost');
  });

  it('never prints the password in a refusal', () => {
    const verdict = classifyRegistrySplitBrain({
      databaseUrl: READ,
      registryUrl: `postgres://cryptobot:${PASSWORD}@postgres:5432/cryptobot`,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).not.toContain(PASSWORD);
    expect(verdict.reason).toContain('127.0.0.1:5432/cryptobot');
  });

  // Fails CLOSED: a target this pass cannot identify is ambiguity, not agreement.
  it.each([
    ['an unparseable registry URL', READ, 'not-a-url'],
    ['an unparseable DATABASE_URL', 'not-a-url', READ],
    ['a registry URL with no database name', READ, 'postgres://cryptobot@127.0.0.1:5432'],
  ])('refuses on %s', (_label, databaseUrl, registryUrl) => {
    const verdict = classifyRegistrySplitBrain({ databaseUrl, registryUrl });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('ambiguity');
  });

  // Not this guard's job: log-eval-experiment.mjs's own gate fails closed on an unset registry, and
  // refusing here would break --dry-run, which logs nothing and needs no registry at all.
  it.each([[undefined], [''], [null]])('stays out of the way when the registry URL is %j', (v) => {
    expect(classifyRegistrySplitBrain({ databaseUrl: READ, registryUrl: v })).toMatchObject({
      ok: true,
      checked: false,
    });
  });
});

// 5. THE ONCE-PER-UTC-DAY CEILING. A documented "run this at most once a day" rule is one an
//    unattended pass can forget, and the forgetting is invisible — two mints in a day both look like
//    successful passes. classifySameDayGate turns the rule into a decision that is a function of its
//    arguments alone, with the day boundary taken from the DATABASE clock: this stack runs on a
//    laptop that sleeps, and a host-derived UTC midnight is a skewed boundary. The purity assertion at
//    the bottom of this block is what makes that failure structurally unable to recur.
describe('once-per-UTC-day gate', () => {
  const NOW = Date.UTC(2026, 6, 31, 12, 3, 42);
  const NEXT_SLOT = '2026-08-01T00:00:00.000Z';
  const TODAYS_ROW = {
    id: '42',
    createdAt: '2026-07-31T09:00:00Z',
    createdAtMs: Date.UTC(2026, 6, 31, 9, 0, 0),
  };
  const YESTERDAYS_ROW = {
    id: '41',
    createdAt: '2026-07-30T23:59:59Z',
    createdAtMs: Date.UTC(2026, 6, 30, 23, 59, 59),
  };

  it('proceeds when no attempt row exists for the DB clock’s UTC day', () => {
    const verdict = classifySameDayGate({ blockingRow: null, nowMsFromDb: NOW, dryRun: false });
    expect(verdict).toMatchObject({
      proceed: true,
      exempt: false,
      verdict: 'SLOT_OPEN',
      utcDay: '2026-07-31',
      nextSlotIso: NEXT_SLOT,
      blockingRow: null,
    });
    expect(verdict.reason).toContain(AUTHORING_ATTEMPT_FAMILY);
  });

  it('refuses on a same-day row, naming its id, its created_at and the next slot', () => {
    const verdict = classifySameDayGate({
      blockingRow: TODAYS_ROW,
      nowMsFromDb: NOW,
      dryRun: false,
    });
    expect(verdict.proceed).toBe(false);
    expect(verdict.verdict).toBe('SLOT_SPENT');
    // All three are the operator's whole remedy: which row took the slot, when, and when the next
    // one opens. A refusal missing any of them sends the reader to psql.
    expect(verdict.reason).toContain('id=42');
    expect(verdict.reason).toContain('2026-07-31T09:00:00Z');
    expect(verdict.reason).toContain(NEXT_SLOT);
    expect(verdict.blockingRow).toMatchObject({ id: '42' });
  });

  it('proceeds when the newest row falls in the PREVIOUS UTC day', () => {
    // The day comparison is made here rather than trusted from the SQL predicate that fetched the
    // row: a date_trunc written without its closing `AT TIME ZONE 'UTC'` silently becomes a LOCAL
    // midnight, and a boundary wrong by a few hours looks exactly like one that is right.
    const verdict = classifySameDayGate({
      blockingRow: YESTERDAYS_ROW,
      nowMsFromDb: NOW,
      dryRun: false,
    });
    expect(verdict.proceed).toBe(true);
    expect(verdict.verdict).toBe('SLOT_OPEN');
    expect(verdict.blockingRow).toBeNull();
    expect(verdict.reason).toContain('EARLIER');
  });

  it.each([
    ['a same-day row', TODAYS_ROW],
    ['no row at all', null],
    ['a row whose timestamp is unreadable', { id: '7', createdAtMs: Number.NaN }],
  ])('exempts --dry-run given %s — it spends nothing and writes nothing', (_label, blockingRow) => {
    const verdict = classifySameDayGate({ blockingRow, nowMsFromDb: NOW, dryRun: true });
    expect(verdict).toMatchObject({ proceed: true, exempt: true, verdict: 'EXEMPT' });
    // The exemption is stated with its own reason, and names the case that is NOT exempt.
    expect(verdict.reason).toContain('--draft-file is NOT');
  });

  it.each([
    // The boundary the arithmetic is most likely to get wrong, in every shape that exists.
    ['a month boundary', Date.UTC(2026, 0, 31, 23, 59, 59, 999), '2026-02-01T00:00:00.000Z'],
    ['a year boundary', Date.UTC(2026, 11, 31, 12, 0, 0), '2027-01-01T00:00:00.000Z'],
    ['a leap-day boundary', Date.UTC(2028, 1, 28, 23, 0, 0), '2028-02-29T00:00:00.000Z'],
    // Exactly at midnight the day's slot has just opened, so the NEXT one is 24h out, not now.
    ['midnight itself', Date.UTC(2026, 6, 31, 0, 0, 0), '2026-08-01T00:00:00.000Z'],
  ])('opens the next slot correctly across %s', (_label, nowMsFromDb, expected) => {
    const verdict = classifySameDayGate({ blockingRow: null, nowMsFromDb, dryRun: false });
    expect(verdict.nextSlotIso).toBe(expected);
    expect(verdict.nextSlotMs).toBe(Date.parse(expected));
  });

  it.each([
    ['an unreadable DB clock', { blockingRow: null, nowMsFromDb: null }],
    ['a NaN DB clock', { blockingRow: null, nowMsFromDb: Number.NaN }],
    [
      'an unreachable registry',
      { blockingRow: null, nowMsFromDb: NOW, registryError: 'ECONNREFUSED 127.0.0.1:5432' },
    ],
  ])('fails CLOSED on %s', (_label, input) => {
    const verdict = classifySameDayGate({ ...input, dryRun: false });
    expect(verdict.proceed).toBe(false);
    expect(verdict.verdict).toBe('CLOCK_UNAVAILABLE');
  });

  it('treats a row it cannot date as blocking — the query said today and nothing contradicts it', () => {
    const verdict = classifySameDayGate({
      blockingRow: { id: '99', createdAt: 'unparseable' },
      nowMsFromDb: NOW,
      dryRun: false,
    });
    expect(verdict.proceed).toBe(false);
    expect(verdict.reason).toContain('id=99');
  });

  it('has NO override flag — the escape hatch would make it a documented rule again', () => {
    // Mechanical, not a promise: argv rejects the flag outright, and an unknown key handed to the
    // classifier changes nothing about the refusal.
    expect(parseArgs(['--i-really-mean-it']).error).toContain('unknown option');
    expect(parseArgs(['--force']).error).toContain('unknown option');
    const withJunk = classifySameDayGate({
      blockingRow: TODAYS_ROW,
      nowMsFromDb: NOW,
      dryRun: false,
      force: true,
      override: 'yes',
    });
    expect(withJunk.proceed).toBe(false);
  });

  it.each([[undefined], [{}], [{ blockingRow: { id: {} }, nowMsFromDb: 'not-a-number' }]])(
    'never throws on %j — a gate that throws is a gate that skipped its own decision',
    (input) => {
      expect(() => classifySameDayGate(input)).not.toThrow();
      expect(classifySameDayGate(input).proceed).toBe(false);
    },
  );

  // THE PURITY ASSERTION. This is the one that makes the host-sleep problem structurally unable to
  // recur: if any future edit reaches for the host clock, `Date.now` throwing here fails the suite
  // rather than shipping a boundary that skews whenever the laptop sleeps through midnight.
  it('is a function of its arguments alone — no host clock, no ambient state', () => {
    const args = { blockingRow: TODAYS_ROW, nowMsFromDb: NOW, dryRun: false };
    const baseline = classifySameDayGate(args);

    const realNow = Date.now;
    try {
      Date.now = () => {
        throw new Error(
          'classifySameDayGate read the HOST clock — the day boundary must come from the DB',
        );
      };
      expect(classifySameDayGate(args)).toEqual(baseline);
    } finally {
      Date.now = realNow;
    }

    // Same arguments, same answer, repeatedly — including the rendered strings, which are what the
    // operator acts on.
    expect(classifySameDayGate(args)).toEqual(baseline);
    expect(classifySameDayGate({ ...args })).toEqual(baseline);

    // And the boundary follows the ARGUMENT, not today: a DB clock on a completely different UTC day
    // yields that day's slot, with no trace of the day this suite happens to run on.
    const longAgo = classifySameDayGate({
      blockingRow: null,
      nowMsFromDb: Date.UTC(2001, 1, 28, 23, 59, 0),
      dryRun: false,
    });
    expect(longAgo.utcDay).toBe('2001-02-28');
    expect(longAgo.nextSlotIso).toBe('2001-03-01T00:00:00.000Z');
    expect(longAgo.reason).not.toContain(new Date().toISOString().slice(0, 10));
  });
});

describe('loop-authoring declared-budget gate (2026-08-10 — arms cut before rows)', () => {
  it('proceeds at the default shape — 2 arms × 150 rows, $4.3116 against the $5.00 cap', () => {
    const g = classifyDeclaredBudget({
      rows: 150,
      arms: 2,
      estCostPerDecideUsd: EST_COST_PER_DECIDE_USD,
      capUsd: '5',
    });
    expect(g.proceed).toBe(true);
    expect(g.declaredUsd).toBeCloseTo(4.3116, 4);
    expect(g.reason).toContain('within budget');
  });

  it('refuses the OLD 3-arm default — quotes declared, cap, rows, arms and per-decide cost', () => {
    // 150 × 3 × 0.014372 = $6.4674, exactly the $6.47 that guaranteed an abort on every run of the
    // shape research/loop/LOG.md's Pass-65 entry records.
    const g = classifyDeclaredBudget({
      rows: 150,
      arms: 3,
      estCostPerDecideUsd: EST_COST_PER_DECIDE_USD,
      capUsd: '5',
    });
    expect(g.proceed).toBe(false);
    expect(g.declaredUsd).toBeCloseTo(6.4674, 4);
    expect(g.reason).toContain('refusing to draft');
    expect(g.reason).toContain('150 rows');
    expect(g.reason).toContain('3 arms');
    expect(g.reason).toContain(String(EST_COST_PER_DECIDE_USD));
    expect(g.reason).toContain('$5.00 cap');
  });

  it('refuses exactly AT the cap boundary’s far side and proceeds exactly ON it', () => {
    expect(
      classifyDeclaredBudget({ rows: 100, arms: 1, estCostPerDecideUsd: 0.05, capUsd: '5' })
        .proceed,
    ).toBe(true); // 100 * 1 * 0.05 = 5.00, <=, proceeds
    expect(
      classifyDeclaredBudget({ rows: 101, arms: 1, estCostPerDecideUsd: 0.05, capUsd: '5' })
        .proceed,
    ).toBe(false); // 5.05 > 5.00
  });

  it('has no fails-OPEN reading — a malformed input refuses exactly like an over-cap one', () => {
    expect(
      classifyDeclaredBudget({
        rows: Number.NaN,
        arms: 2,
        estCostPerDecideUsd: EST_COST_PER_DECIDE_USD,
        capUsd: '5',
      }).proceed,
    ).toBe(false);
  });

  it.each([[undefined], [{}], [{ rows: 'not-a-number' }]])(
    'never throws on %j — a spend gate that throws is a spend gate that skipped its own decision',
    (input) => {
      expect(() => classifyDeclaredBudget(input)).not.toThrow();
      expect(classifyDeclaredBudget(input).proceed).toBe(false);
    },
  );
});

describe('loop-authoring event-driven mint trigger (2026-08-10 owner decision, supersedes daily minting)', () => {
  const AS_OF_MS = Date.UTC(2026, 7, 10, 8, 53, 0);
  const AS_OF_ISO = '2026-08-10T08:53:00.000Z';

  function horizonEntry(h, cellOverrides) {
    return {
      h,
      status: 'measured',
      cell:
        cellOverrides === null
          ? null
          : { n: 40, clusters: 8, mean: -5, ciLo: -10, ciHi: -1, powered: true, ...cellOverrides },
    };
  }

  function panelFixture({ playbookVersion = 10, population = MINT_TRIGGER_POPULATION, horizons }) {
    return { playbookVersion, population, entries: 1, horizons };
  }

  // The frozen ground truth this trigger must NOT fire on — measured 2026-08-10T08:53Z, v10
  // flat_only: h=4 POWERED mean −9.3 bps n=55 k=10 CI [−32.1, +15.7]; h=8 POWERED mean −20.8 bps n=54
  // k=10 CI [−45.1, +3.9]. Both intervals include zero.
  const V10_FLAT_ONLY_2026_08_10 = panelFixture({
    playbookVersion: 10,
    horizons: [
      // h=1/h=24 are OUT OF SCOPE for this trigger and carry an adverse-looking mean on purpose — the
      // trigger must never read them.
      horizonEntry(1, { n: 60, clusters: 11, mean: -30, ciLo: -50, ciHi: -10, powered: true }),
      horizonEntry(4, { n: 55, clusters: 10, mean: -9.3, ciLo: -32.1, ciHi: 15.7, powered: true }),
      horizonEntry(8, { n: 54, clusters: 10, mean: -20.8, ciLo: -45.1, ciHi: 3.9, powered: true }),
      horizonEntry(24, { n: 50, clusters: 9, mean: -40, ciLo: -80, ciHi: -5, powered: true }),
    ],
  });

  it('does NOT fire on the frozen 2026-08-10 v10 flat_only data — minting nothing here is the trigger working, not a bug', () => {
    const t = classifyMintTrigger({
      panels: [V10_FLAT_ONLY_2026_08_10],
      incumbentVersion: 10,
      asOfMs: AS_OF_MS,
    });
    expect(t.proceed).toBe(false);
    expect(t.fired).toBe(false);
    expect(t.reason).toContain(AS_OF_ISO);
    expect(t.reason).toContain('v10');
    // h=4
    expect(t.reason).toContain('n=55');
    expect(t.reason).toContain('clusters=10');
    expect(t.reason).toContain('-9.3');
    expect(t.reason).toContain('-32.1');
    expect(t.reason).toContain('15.7');
    // h=8
    expect(t.reason).toContain('n=54');
    expect(t.reason).toContain('-20.8');
    expect(t.reason).toContain('-45.1');
    expect(t.reason).toContain('3.9');
    // h=1/h=24 are declared out of scope and must never be quoted as evidence for this trigger.
    expect(t.reason).not.toContain('n=60');
    expect(t.reason).not.toContain('n=50');
  });

  it('fires on h=4 alone when it is adverse-POWERED (ciHi < 0)', () => {
    const p = panelFixture({
      horizons: [
        horizonEntry(4, { n: 20, clusters: 6, mean: -15, ciLo: -30, ciHi: -1, powered: true }),
      ],
    });
    const t = classifyMintTrigger({ panels: [p], incumbentVersion: 10, asOfMs: AS_OF_MS });
    expect(t).toMatchObject({ proceed: true, fired: true, horizon: 4 });
    expect(t.reason).toContain('ADVERSE-POWERED');
    expect(t.reason).toContain('n=20');
    expect(t.reason).toContain('clusters=6');
  });

  it('fires on h=8 alone when h=4 is not adverse', () => {
    const p = panelFixture({
      horizons: [
        horizonEntry(4, { n: 20, clusters: 6, mean: 2, ciLo: -3, ciHi: 8, powered: true }),
        horizonEntry(8, { n: 20, clusters: 6, mean: -15, ciLo: -30, ciHi: -1, powered: true }),
      ],
    });
    const t = classifyMintTrigger({ panels: [p], incumbentVersion: 10, asOfMs: AS_OF_MS });
    expect(t).toMatchObject({ proceed: true, fired: true, horizon: 8 });
  });

  it('ignores an adverse-POWERED cell on the `all` population — only `flat_only` is comparable', () => {
    const p = panelFixture({
      population: 'all',
      horizons: [
        horizonEntry(4, { n: 20, clusters: 6, mean: -15, ciLo: -30, ciHi: -1, powered: true }),
      ],
    });
    const t = classifyMintTrigger({ panels: [p], incumbentVersion: 10, asOfMs: AS_OF_MS });
    expect(t.proceed).toBe(false);
    expect(t.reason).toContain(`no ${MINT_TRIGGER_POPULATION} panel`);
  });

  it('ignores adverse-POWERED cells at h=1 and h=24 — out of this trigger’s declared scope', () => {
    const p = panelFixture({
      horizons: [
        horizonEntry(1, { n: 20, clusters: 6, mean: -15, ciLo: -30, ciHi: -1, powered: true }),
        horizonEntry(24, { n: 20, clusters: 6, mean: -15, ciLo: -30, ciHi: -1, powered: true }),
      ],
    });
    const t = classifyMintTrigger({ panels: [p], incumbentVersion: 10, asOfMs: AS_OF_MS });
    expect(t.proceed).toBe(false);
  });

  it('does not fire on an UNDERPOWERED adverse cell — `powered` must be true, not merely ciHi < 0', () => {
    const p = panelFixture({
      horizons: [
        horizonEntry(4, { n: 3, clusters: 2, mean: -50, ciLo: null, ciHi: null, powered: false }),
      ],
    });
    const t = classifyMintTrigger({ panels: [p], incumbentVersion: 10, asOfMs: AS_OF_MS });
    expect(t.proceed).toBe(false);
    expect(t.reason).toContain('UNDERPOWERED');
  });

  it('refuses without measured evidence on empty panels — a probe failure', () => {
    const t = classifyMintTrigger({ panels: [], incumbentVersion: 10, asOfMs: AS_OF_MS });
    expect(t.proceed).toBe(false);
    expect(t.reason).toContain('no panels');
  });

  it('refuses when no incumbent version was resolved', () => {
    const t = classifyMintTrigger({
      panels: [V10_FLAT_ONLY_2026_08_10],
      incumbentVersion: undefined,
      asOfMs: AS_OF_MS,
    });
    expect(t.proceed).toBe(false);
    expect(t.reason).toContain('no incumbent version');
  });

  it('coerces the version comparison — a string incumbentVersion still matches a numeric playbookVersion', () => {
    const p = panelFixture({
      playbookVersion: 10,
      horizons: [
        horizonEntry(4, { n: 20, clusters: 6, mean: -15, ciLo: -30, ciHi: -1, powered: true }),
      ],
    });
    const t = classifyMintTrigger({ panels: [p], incumbentVersion: '10', asOfMs: AS_OF_MS });
    expect(t.proceed).toBe(true);
  });

  it('has NO override flag — extra fields cannot turn a refusal into a proceed', () => {
    const t = classifyMintTrigger({
      panels: [V10_FLAT_ONLY_2026_08_10],
      incumbentVersion: 10,
      asOfMs: AS_OF_MS,
      force: true,
      override: 'yes',
    });
    expect(t.proceed).toBe(false);
  });

  it('exempts --dry-run and still reports what a REAL run would do', () => {
    const notFired = classifyMintTrigger({
      panels: [V10_FLAT_ONLY_2026_08_10],
      incumbentVersion: 10,
      asOfMs: AS_OF_MS,
      dryRun: true,
    });
    expect(notFired).toMatchObject({ proceed: true, exempt: true, fired: false });
    expect(notFired.reason).toContain('EXEMPT');
    expect(notFired.reason).toContain('A REAL run would REFUSE here');

    const p = panelFixture({
      horizons: [
        horizonEntry(4, { n: 20, clusters: 6, mean: -15, ciLo: -30, ciHi: -1, powered: true }),
      ],
    });
    const fired = classifyMintTrigger({
      panels: [p],
      incumbentVersion: 10,
      asOfMs: AS_OF_MS,
      dryRun: true,
    });
    expect(fired).toMatchObject({ proceed: true, exempt: true, fired: true });
    expect(fired.reason).toContain('A REAL run would PROCEED here');
  });

  it('quotes the as-of instant, falling back to an explicit label when the clock is unreadable', () => {
    const t = classifyMintTrigger({ panels: [], incumbentVersion: 10, asOfMs: Number.NaN });
    expect(t.reason).toContain('unknown instant');
  });

  it.each([[undefined], [{}], [{ panels: 'not-an-array', incumbentVersion: 10 }]])(
    'never throws on %j — a gate that throws is a gate that skipped its own decision',
    (input) => {
      expect(() => classifyMintTrigger(input)).not.toThrow();
      expect(classifyMintTrigger(input).proceed).toBe(false);
    },
  );
});
