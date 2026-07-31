import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUTHORING_ATTEMPT_FAMILY,
  COST_FLOOR_BPS,
  DEFAULT_MINT_FLOOR_MIN_ENTRIES,
  DEFAULT_MINT_FLOOR_MIN_ROWS,
  MEASURED_HORIZON_CELLS,
  RETIRED_OBJECTIVE_MARKERS,
  assertNoRetiredObjective,
  buildEvidenceDigest,
  buildPerHorizonNetTable,
  classifyEntryRateFloor,
  classifyMintGate,
  classifyRegistrySplitBrain,
  classifySameDayGate,
  corpusAttemptKey,
  parseArgs,
  parsePlaybookInfoVersion,
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
