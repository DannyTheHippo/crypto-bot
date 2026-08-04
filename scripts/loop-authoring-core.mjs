// Pure decision core for the loop-side playbook AUTHORING pass (scripts/loop-authoring.mjs is the IO
// shell). Split the same way loop-pass-lock-core.mjs and playbook-candidate-core.mjs are: the
// interesting behaviour is the classification, and a mint gate shipped without tests is a gate nobody
// has checked. Every function here is pure — no fs, no pg, no clock, no network, no process.
//
// WHY THIS PASS EXISTS, stated without softening. `NO_SURVIVOR` settled that PROSE DOES NOT MOVE THE
// ENTRY SIGN: the `minimal` arm carried no guidance at all and scored −13.3 bps at h=1, within a bar
// of `champion_v8`'s −12.7, while every arm changed 9–55% of decisions (verdicts.md § NO_SURVIVOR).
// So this is a LOW-PRIOR BET. Its justification is cost and information, not an expectation that
// better prose flips the sign:
//   * cost — the daily loop runs on a subscription at ~zero marginal cost, against the $5.01 the
//     deleted in-process reflection lane charged per revision;
//   * information — the loop can read the whole database, where reflection saw one strategy's newest
//     200 journal rows, mostly prescreen noise.
// Neither is evidence of edge. The measurement gate below is the only thing keeping this honest: a
// draft ships iff it BEATS THE RUNNING PLAYBOOK on the same corpus, metric and horizons, and the
// research bar is reported alongside so the two are never conflated.
//
// FAILURE DIRECTIONS — seven gates, and they do not all point the same way:
//
//  * resolveIncumbent fails CLOSED. The deployment bar is DEFINED by the currently running playbook
//    ("beats the currently running playbook", verdicts.md § Standing verdicts, first entry), so a
//    comparison run against a guessed incumbent is not a deployment decision at all — and the mint it
//    would authorise writes a parent_version into an append-only table that can never be corrected.
//    No resolvable incumbent ⇒ the pass refuses.
//
//  * parsePlaybookInfoVersion fails OPEN to null. It reads the `agentic_playbook_info` gauge, which is
//    the authority on what is running; a scrape failure must not stop the pass, because the DB mirror
//    (resolveActiveVersion in lib/playbook-shared.mjs) applies the SAME precedence the gauge is
//    stamped from. It falls back to that mirror and NEVER to a literal — hardcoding "v8" is exactly
//    the error playbook-space-arms.ts corrected before any result existed, and v10 has since replaced
//    v8 anyway.
//
//  * assertNoRetiredObjective fails CLOSED, by throwing. research/loop/playbook-authoring.md preserves
//    the reflection prompt verbatim INCLUDING the ANTI-RATCHET OBJECTIVE, which is marked
//    "[RETIRED — HISTORICAL TEXT ONLY]" three times over. Carrying it into a drafting prompt would
//    silently re-impose the "roughly two closed round trips per day" objective that
//    research/studies/entry-rate-rederivation-2026-07-30.md spent a whole record deciding to drop.
//    That is a failure a reader cannot see in the output, so it is asserted rather than reviewed.
//
//  * classifyEntryRateFloor fails OPEN below minRows parseable replays and CLOSED on a measured zero.
//    Ported behaviour, not resurrected code: the deleted measureEntryRate loop (entry-rate-floor.ts,
//    removed with reflection on 2026-07-30) failed open below DEFAULT_MINT_FLOOR_MIN_ROWS because a
//    transport failure is not an abstention, and that reasoning is unchanged. What IS changed is the
//    floor's justification: it is no longer an activity target (the retired objective's job) but a
//    SQUATTING GUARD — a candidate that never enters cannot be measured against anything, and it would
//    occupy the one candidate slot the A/B router offers while producing no evidence.
//
//  * classifyMintGate fails CLOSED. agent_playbook_versions is append-only; an absent, voided,
//    incomplete or unlogged measurement therefore refuses the mint rather than minting on hope.
//    Complete experiment logging is one of its preconditions ON PURPOSE: a pass that records only its
//    winners launders a selection effect into the registry, so partial logging blocks the mint exactly
//    as a failed measurement does.
//
//  * classifyRegistrySplitBrain fails CLOSED, including on a target it cannot identify. Reads and
//    writes landing in two different databases is the one defect of this pass that is invisible in its
//    own output — every stage still prints OK — so an unparseable URL is treated as ambiguity rather
//    than agreement. (This entry was missing from this list until 2026-07-31; the guard itself
//    documents the direction at its own definition.)
//
//  * classifySameDayGate fails CLOSED, and has NO override flag. It is the once-per-UTC-day ceiling on
//    the whole pass. A same-day attempt row refuses; an unreadable registry ALSO refuses, because the
//    pass cannot honour its log-everything precondition against a registry it cannot reach and would
//    only spend the drafting and replay budget to arrive at a guaranteed stage-7 refusal. The day
//    boundary is the DATABASE clock and never the host's: this stack runs on a laptop that sleeps
//    (worst measured duty cycle 8%/24h; one pass spanned a ~7.5h sleep and expired its own 2h lease),
//    so a host-derived UTC midnight is a skewed boundary while the DB is the one clock every writer
//    shares. `--dry-run` is the ONLY exemption and it is not a hole: it spends nothing and writes
//    nothing, so it can neither burn the slot nor need bounding. `--draft-file` is deliberately NOT
//    exempt — it skips the drafting call and still spends the full stage-4 replay budget.

// ── the retired objective, and how it is kept out of the drafting prompt ─────────────────────────

/**
 * Markers that identify the RETIRED ANTI-RATCHET OBJECTIVE inside the preserved reflection prompt.
 *
 * Matched case-insensitively on the joined prompt text. The first is the paragraph's own opening
 * label; the rest are the load-bearing clauses that would re-impose the objective even if the label
 * were paraphrased away — which is the realistic failure, since the paragraph is the one most likely
 * to be copied by reflex (playbook-authoring.md's own retirement caveat says so).
 */
export const RETIRED_OBJECTIVE_MARKERS = Object.freeze([
  // Bare, not 'ANTI-RATCHET OBJECTIVE'. The first version of this list matched the full label and
  // MISSED a live leak: the X7 postMortems paragraph, which is NOT inside a retired fence, opens
  // "The postMortems digest (X7) is the SAME anti-ratchet counterweight evidence in mechanically
  // graded form" and closes by calling a sub-one-entry-per-day rate "a strong prompt to act" on a
  // rank-filter relaxation. That is the retired objective wearing a different label, and it reached
  // a generated drafting prompt before this marker was widened (verified 2026-07-30).
  'anti-ratchet',
  'a flat week is a FAILING week',
  'two closed round trips per day',
  'roughly two round trips per day',
]);

/** Fence markers playbook-authoring.md wraps the retired paragraph in. */
const RETIRED_BLOCK_OPEN = '**[RETIRED';
const RETIRED_BLOCK_CLOSE = '**[END RETIRED PARAGRAPH.]**';

/**
 * Paragraphs that are RETIRED IN SUBSTANCE while sitting outside a retired fence.
 *
 * Exactly one today: the X7 postMortems paragraph (see RETIRED_OBJECTIVE_MARKERS' own note). The
 * change-discipline record authorises "changing the entry OBJECTIVE, and the mechanisms whose sole
 * purpose is to enforce it" (entry-rate-rederivation-2026-07-30.md § 7); an instruction to relax a
 * rank filter when the entry rate falls below one per day is such a mechanism.
 *
 * Dropped at PROMPT-ASSEMBLY time and never by editing playbook-authoring.md — that file is a
 * verbatim preservation artifact, and rewriting it to fix a prompt would destroy the thing it exists
 * to be. Matching is on a distinctive phrase rather than a paragraph index so a re-flow of the source
 * cannot silently move the cut.
 */
const RETIRED_IN_SUBSTANCE_MARKERS = Object.freeze(['The postMortems digest (X7)']);

/** Headings of the sections that are PROMPT; everything else in the file is about the file. */
const LANE_HEADING = '## System prompt — ';
const PERP_LANE_HEADING = `${LANE_HEADING}perp lane`;
const SPOT_LANE_HEADING = `${LANE_HEADING}spot lane`;
const RESTATEMENT_HEADING = '## `STRUCTURAL_CONSTRAINTS_RESTATEMENT`';

/**
 * The prompt text out of research/loop/playbook-authoring.md, minus every retired paragraph.
 *
 * Two filters, and both are necessary:
 *
 *  1. **Section selection.** Only the lane's own `## System prompt — …` section and the
 *     `STRUCTURAL_CONSTRAINTS_RESTATEMENT` section are prompt. `## Why this file exists`,
 *     `## Provenance …` and `## Related records` are prose ABOUT the preservation — and they name the
 *     retired objective in passing, which is exactly how it would reach a drafting call by a route
 *     nobody was watching. The lane is chosen from the same `shortsAllowed` capability the validator
 *     is given, so the drafting model is never told to write for a lane the validator will reject.
 *  2. **Retired-block drop.** The fenced `**[RETIRED …]**` … `**[END RETIRED PARAGRAPH.]**` region
 *     goes wholesale rather than sentence by sentence: the file's caveat says every OTHER paragraph is
 *     preserved as-is, so a partial edit would be a judgement this function is not entitled to make.
 *  3. **Retired-in-substance drop.** RETIRED_IN_SUBSTANCE_MARKERS — currently the X7 postMortems
 *     paragraph, which is not fenced but instructs the same behaviour the fenced one does.
 *
 * `blocksRemoved` and `substanceParagraphsRemoved` are returned so the shell can report that each
 * strip actually fired — a silently vacuous strip (headings renamed, fences reworded, the paragraph
 * re-flowed) would otherwise look identical to a clean file.
 * @returns {{text:string,blocksRemoved:number,substanceParagraphsRemoved:number,lane:'perp'|'spot'}}
 */
export function stripRetiredGuidance(markdown, { shortsAllowed = true } = {}) {
  const lane = shortsAllowed ? 'perp' : 'spot';
  const wanted = shortsAllowed ? PERP_LANE_HEADING : SPOT_LANE_HEADING;
  const lines = String(markdown).split('\n');
  const out = [];
  let keeping = false;
  let inBlock = false;
  let blocksRemoved = 0;
  let substanceParagraphsRemoved = 0;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      keeping = line.startsWith(wanted) || line.startsWith(RESTATEMENT_HEADING);
      inBlock = false;
      if (keeping) out.push(line);
      continue;
    }
    if (!keeping) continue;
    if (!inBlock && line.startsWith(RETIRED_BLOCK_OPEN)) {
      inBlock = true;
      blocksRemoved += 1;
      continue;
    }
    if (inBlock) {
      if (line.trim() === RETIRED_BLOCK_CLOSE) inBlock = false;
      continue;
    }
    if (RETIRED_IN_SUBSTANCE_MARKERS.some((m) => line.includes(m))) {
      substanceParagraphsRemoved += 1;
      continue;
    }
    out.push(line);
  }
  return {
    text: out.join('\n').trim(),
    blocksRemoved,
    substanceParagraphsRemoved,
    lane,
  };
}

/**
 * Refuses any drafting prompt that still carries the retired objective. Fails CLOSED — see the header.
 * @throws {Error} naming the marker found, so the failure is diagnosable without re-reading 4,000
 *   characters of prompt.
 */
export function assertNoRetiredObjective(promptText, label = 'drafting prompt') {
  const haystack = String(promptText).toLowerCase();
  for (const marker of RETIRED_OBJECTIVE_MARKERS) {
    if (haystack.includes(marker.toLowerCase())) {
      throw new Error(
        `${label} carries RETIRED text ("${marker}") — the ANTI-RATCHET OBJECTIVE was retired by ` +
          'research/studies/entry-rate-rederivation-2026-07-30.md and must never reach a drafting ' +
          'call. Refusing to draft.',
      );
    }
  }
}

// ── incumbent resolution ─────────────────────────────────────────────────────────────────────────

/**
 * The version off an `agentic_playbook_info` exposition line, or null. Fails OPEN — see the header.
 *
 * Tolerates any label order and either quoting style, because the exposition format guarantees
 * neither. A sample line: `agentic_playbook_info{instance="app:3100",version="10"} 1`.
 */
export function parsePlaybookInfoVersion(metricsText) {
  if (typeof metricsText !== 'string') return null;
  let best = null;
  for (const line of metricsText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('agentic_playbook_info{')) continue;
    // Only lines the exporter set to 1 name a live version; a stale child at 0 does not.
    const value = Number(trimmed.slice(trimmed.lastIndexOf('}') + 1).trim());
    if (value !== 1) continue;
    const match = /version="(\d+)"/.exec(trimmed);
    if (match === null) continue;
    const version = Number(match[1]);
    if (Number.isInteger(version) && (best === null || version > best)) best = version;
  }
  return best;
}

/**
 * The playbook the deployment bar compares against. Fails CLOSED — see the header.
 *
 * `gaugeVersion` (from parsePlaybookInfoVersion) wins when it names a row that exists; otherwise the
 * DB mirror `dbVersion` (resolveActiveVersion, which applies PlaybookStoreAdapter.resolve()'s own
 * pin > newest-promotion's-parent > newest-seed precedence) stands in. A gauge naming a version the
 * table does not carry is reported as a DIVERGENCE rather than silently preferred either way: that
 * shape means the running process and this script disagree about reality, which is a finding.
 * @returns {{ok:true,version:number,content:string,source:string,resolvedFrom:string,divergence:string|null}
 *          |{ok:false,reason:string}}
 */
export function resolveIncumbent({ rows, gaugeVersion, dbVersion }) {
  const byVersion = new Map((rows ?? []).map((r) => [r.version, r]));
  let divergence = null;
  let version;
  let resolvedFrom;

  if (gaugeVersion !== null && gaugeVersion !== undefined && byVersion.has(gaugeVersion)) {
    version = gaugeVersion;
    resolvedFrom = 'agentic_playbook_info gauge';
    if (dbVersion !== undefined && dbVersion !== gaugeVersion) {
      divergence =
        `agentic_playbook_info reports v${gaugeVersion} while the DB precedence mirror resolves ` +
        `v${dbVersion} — the gauge wins (it is what is RUNNING), and the disagreement is a finding.`;
    }
  } else if (dbVersion !== undefined && byVersion.has(dbVersion)) {
    version = dbVersion;
    resolvedFrom = 'DB precedence mirror (resolveActiveVersion)';
    if (gaugeVersion !== null && gaugeVersion !== undefined) {
      divergence =
        `agentic_playbook_info reports v${gaugeVersion}, which has no row in ` +
        'agent_playbook_versions — falling back to the DB mirror and reporting the gap.';
    }
  } else {
    return {
      ok: false,
      reason:
        'could not resolve the RUNNING playbook from either the agentic_playbook_info gauge or the ' +
        'DB precedence mirror. The deployment bar is defined as "beats the currently running ' +
        'playbook", so there is no bar to run against — refusing rather than comparing to a guess.',
    };
  }

  const row = byVersion.get(version);
  if (typeof row.content !== 'string' || row.content.length === 0) {
    return {
      ok: false,
      reason: `incumbent v${version} has no readable content — cannot score the comparator arm.`,
    };
  }
  return { ok: true, version, content: row.content, source: row.source, resolvedFrom, divergence };
}

// ── the entry-rate floor, re-expressed ───────────────────────────────────────────────────────────

/** The deleted measureEntryRate driver's own constants (reflection.service.ts:121-123), unchanged. */
export const DEFAULT_MINT_FLOOR_MIN_ROWS = 6;
export const DEFAULT_MINT_FLOOR_MIN_ENTRIES = 1;

/**
 * The squatting guard. Fails OPEN below `minRows`, CLOSED on a measured zero — see the header.
 *
 * Measured off the SCORING run rather than a separate replay batch: the run already replayed every
 * variant against the same rows, so a second batch would spend money to re-measure a number already
 * in hand. `rowsParsed` is contract-valid replies, not attempted calls, for the same reason the
 * original counted parseable replays.
 * @returns {{pass:boolean,fired:boolean,reason:string,rowsParsed:number,entries:number}}
 */
export function classifyEntryRateFloor({
  rowsParsed,
  entries,
  minRows = DEFAULT_MINT_FLOOR_MIN_ROWS,
  minEntries = DEFAULT_MINT_FLOOR_MIN_ENTRIES,
}) {
  const parsed = Number(rowsParsed) || 0;
  const fired = Number(entries) || 0;
  if (parsed < minRows) {
    return {
      pass: true,
      fired: false,
      rowsParsed: parsed,
      entries: fired,
      reason:
        `only ${parsed} parseable replays (< ${minRows}) — too little to distinguish abstention from ` +
        'transport failure, so the floor does not fire (fails OPEN, as the deleted measureEntryRate did).',
    };
  }
  if (fired < minEntries) {
    return {
      pass: false,
      fired: true,
      rowsParsed: parsed,
      entries: fired,
      reason:
        `${fired} entries in ${parsed} parseable replays (< ${minEntries}) — a candidate that never ` +
        'enters produces no evidence while occupying the single candidate slot the A/B router offers. ' +
        'This is a squatting guard, NOT an activity target: the entry-rate objective was retired ' +
        '(research/studies/entry-rate-rederivation-2026-07-30.md) and abstention is a permitted ' +
        'terminal state — but a slot that can never resolve is not abstention, it is a stall.',
    };
  }
  return {
    pass: true,
    fired: true,
    rowsParsed: parsed,
    entries: fired,
    reason: `${fired} entries in ${parsed} parseable replays — clears the ${minEntries}-entry floor.`,
  };
}

// ── the attempt counter ──────────────────────────────────────────────────────────────────────────

/**
 * The corpus identity a prior-attempt count is grouped by — and it is deliberately NOT the payload
 * fingerprint.
 *
 * The multiplicity nobody was tracking is "how many times has something been scored against this
 * corpus". Three keys were available and two do not answer it:
 *
 * - `dataset_hash` folds the RUN's own shape into the hash — `rowsLoaded` AND `rowsReplayed`
 *   (log-eval-experiment.mjs § datasetHash). Two runs against the identical corpus at different row
 *   budgets get different values, so grouping by it counts run CONFIGURATIONS. Correct key for "was
 *   this the same run setup"; wrong key for "how many bites at this apple".
 * - `metrics->>'corpusFingerprint'` is the payload sha over every row's id and payload bytes. It is
 *   the *conceptually* right key and it is MEASURABLY BROKEN here: the corpus on disk hashes to
 *   `030367ba…` while ten frozen artifacts covering 20 scored cells record `f1dd13c6…`, with every
 *   identity field matching. Keying on it reports ZERO prior attempts on a corpus that has already
 *   been scored twenty times over — the loophole is the counter's present state, not a future risk
 *   (halves-clause record § 7.3; cause and evidence in
 *   research/studies/corpus-fingerprint-drift-2026-07-31.md).
 *
 * So the key is `(rowsLoaded, rowSince, rowUntil)` out of `metrics.window`, which every registry row
 * written by a scorecard already carries because log-eval-experiment.mjs copies the window verbatim.
 * The three fields it does NOT use were each rejected against the actual rows, not on taste:
 *
 * - `symbolCount` is recorded nowhere by any writer that has ever run. Including it would null the
 *   key on every historical row and reproduce the exact defect being worked around.
 * - `firstEventTime` is NOT corpus-stable across writers. Registry row id=5 replayed a 40-row
 *   subsample of the SAME 204-row corpus as rows 2/3/4/6/7 and records `firstEventTime`
 *   1783862100000 against their 1783716300000 — it tracks the REPLAYED SUBSET. Keying on it would
 *   split runs that share a corpus, which is the same failure in a different coordinate.
 * - That same row id=5 also records a different `corpusFingerprint` (`99a3c1a3…` vs `bc9390e4…`)
 *   from its five siblings. So the fingerprint's inability to identify one corpus is not a
 *   one-off tied to the playbook-space drift — it has fired twice, on two unrelated corpora.
 *
 * `rowSince`/`rowUntil` hold at 1783714500000/1783876500000 across ALL SIX of those rows, including
 * id=5. That is the measurement this key is chosen on.
 *
 * WHAT IT GIVES UP, stated rather than discovered later: two genuinely different corpora that happen
 * to share a row count and both query bounds count as one, and rows written without a `window` at
 * all (ids 1 and 8 today) are invisible to it. The key is deliberately COARSE, and that is only
 * acceptable because the counter is a REPORT with no threshold attached — an over-count is a louder
 * warning, where the fingerprint's under-count is a silent all-clear.
 */
export function corpusAttemptKey(corpus) {
  if (corpus === undefined || corpus === null) return null;
  const rows = corpus.rows ?? corpus.rowsLoaded;
  const rowSince = corpus.rowSince ?? corpus.firstEventTime;
  const rowUntil = corpus.rowUntil ?? corpus.lastEventTime;
  for (const v of [rows, rowSince, rowUntil]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  }
  return { rowsLoaded: rows, rowSince, rowUntil };
}

/**
 * One line describing the count, honest about which key produced it.
 *
 * The fingerprint count is carried alongside and rendered whenever it DISAGREES with the identity
 * count, because that disagreement is the § 7.3 drift measuring itself on every pass — the moment it
 * closes, or widens, a reader sees it without going looking.
 */
export function renderPriorAttempts(a) {
  if (a === undefined || a === null) return 'NOT COUNTED';
  const { count, byFingerprint, key } = a;
  const where =
    key === undefined || key === null
      ? 'unkeyed'
      : `rows=${key.rowsLoaded}, since=${key.rowSince}, until=${key.rowUntil}`;
  const drift =
    typeof byFingerprint === 'number' && byFingerprint !== count
      ? `; the payload fingerprint matches only ${byFingerprint} of them — the corpus-fingerprint ` +
        'drift (halves-clause record § 7.3) is still open and this is it measuring itself'
      : '';
  return (
    `${count} prior registry row(s) on this corpus identity (${where})${drift}. ` +
    'REPORTED, never a gate — no threshold is declared, and one chosen after seeing these counts ' +
    'would be the post-hoc bar-setting the record refuses.'
  );
}

// ── the two bars ─────────────────────────────────────────────────────────────────────────────────

/**
 * The mint gate. Fails CLOSED — see the header.
 *
 * `deployment` is the harness's own DeploymentComparison (compareToIncumbent in
 * test/eval/agentic/playbook-space-replay.ts): `ships` there is already "wins the declared primary
 * horizon AND at least DEPLOYMENT_MIN_HORIZONS_WON of the four", declared before any comparison was
 * looked at. This function does NOT re-derive it — re-deriving a pre-registered rule downstream of a
 * result is how a bar gets moved.
 *
 * `research` is the same run's FamilyVerdict. It is REPORTED and never gates: "a research-bar FAIL is
 * not a deployment veto" is the first standing verdict in research/loop/verdicts.md, on an explicit
 * owner ruling, and applying the opposite rule "throws away everything the study measured while
 * leaving the worst-measured option running".
 *
 * `priorAttemptsOnCorpus` is likewise REPORTED and never gates — see `renderPriorAttempts`. It rides
 * in the reason so the count is on the record next to the decision it qualifies.
 *
 * ONE clause of the deployment bar is re-read here rather than taken from `ships`, and only one: the
 * chronological-halves outcome, which blocks on UNDETERMINED. That is not a re-derivation of the bar
 * — `ships` already carries the halves clause's CLOSED direction — it is a caller-specific
 * restriction on a clause whose OPEN direction is deliberate everywhere else. The reason is authority
 * rather than evidence, and it is spelled out at the branch.
 *
 * `deployment` is the WINNER only — the best-ranked candidate among those whose own `ships` was true,
 * or `undefined` when none shipped (loop-authoring.mjs's `winner`). `deploymentComparisons` is the
 * FULL set scored this run (`score.deployment`, one entry per candidate, win or lose) and exists
 * SOLELY so the `deployment`-absent blocker below can tell two different facts apart: "N candidates
 * were compared and none was selected" is not "the incumbent was never scored". 2026-08-04: before
 * this parameter existed, both facts produced the same sentence — a run that printed a full stage-5
 * comparison table for two candidates against the incumbent still refused with "the incumbent was
 * never scored on the same rows", which was false as written even though the refusal itself was
 * correct. The refusal is UNCHANGED here; only the sentence naming its cause is.
 * @returns {{mint:boolean,reason:string,deploymentVerdict:string,researchVerdict:string,blockers:string[],priorAttemptsOnCorpus:object|null}}
 */
export function classifyMintGate({
  deployment,
  deploymentComparisons,
  research,
  floor,
  run,
  experimentsLogged,
  priorAttemptsOnCorpus,
}) {
  const blockers = [];
  // See the deploymentComparisons paragraph above. Used by both the deployment- and floor-absent
  // blockers below, since a floor never evaluated has the identical root cause when a candidate was
  // scored but not selected — there is no separate "floor genuinely unmeasured despite a selection"
  // path in the caller today.
  const attempted = Array.isArray(deploymentComparisons) ? deploymentComparisons.length : 0;

  if (run === undefined || run === null) {
    blockers.push('no scoring run result — nothing was measured');
  } else {
    if (run.voided === true)
      blockers.push(
        'the scoring run is VOID (transport floor) — no verdict may be published from it',
      );
    if (run.aborted === true)
      blockers.push('the scoring run ABORTED on budget — arms are truncated, not comparable');
    if ((run.unfaithfulCapsRows ?? 0) > 0) {
      blockers.push(
        `${run.unfaithfulCapsRows} row(s) replayed with capabilities the live system never recorded — ` +
          'the replay measured a different account (the 2026-07-30 venueFreeCash defect)',
      );
    }
  }

  if (deployment === undefined || deployment === null) {
    blockers.push(
      attempted > 0
        ? `${attempted} candidate(s) were compared against the incumbent this run and NONE cleared ` +
            'the deployment bar — no candidate was SELECTED, so there is no single winning comparison ' +
            'for this row to gate on (each candidate’s own verdict is printed in full at stage 5, above).'
        : 'no deployment comparison was attempted — the incumbent was never scored on the same rows.',
    );
  } else {
    if (deployment.ships !== true) {
      blockers.push(
        deployment.halvesVerdict === 'HALF_LOST'
          ? `LOSES A CHRONOLOGICAL HALF at h=${deployment.primaryHorizon} — ${deployment.halves?.reason ?? 'one half not won'} ` +
              `It wins the horizon clause (${deployment.horizonsWon}/${deployment.horizonsCompared} horizons), so this ` +
              'is NOT the horizon-dependent refusal: the window average is carried by half the window'
          : deployment.horizonDependent === true
            ? `beats the incumbent at h=${deployment.primaryHorizon} only (${deployment.horizonsWon}/${deployment.horizonsCompared} horizons) — ` +
              'horizon-dependent, and the pre-registered robustness clause does not ship it'
            : `does not beat the incumbent under the declared deployment bar (${deployment.horizonsWon}/${deployment.horizonsCompared} horizons won, ` +
              `primary h=${deployment.primaryHorizon} ${deployment.beatsAtPrimary === true ? 'won' : 'lost'})`,
      );
    }
    // THE ASYMMETRY, and it is about AUTHORITY rather than evidence. The halves clause fails OPEN
    // everywhere else — an unmeasurable clause is not a failed clause, and blocking a deployment on a
    // clause that could not be computed leaves the worst-measured option running for a reason that is
    // not evidence about the arms (halves-clause record § 5.2). But this gate is the UNATTENDED mint:
    // the row it writes lands in an append-only registry and cannot be retracted, and "the robustness
    // clause could not be computed" is precisely the condition under which an automated selection walk
    // would be invisible. A human may ship on an unverifiable clause; a pass writing on its own
    // authority may not (§ 5.3). An ABSENT verdict is treated as UNDETERMINED for the same reason —
    // a comparison that carries no halves field did not compute the clause either.
    if (deployment.halvesVerdict !== 'BOTH_WON' && deployment.halvesVerdict !== 'HALF_LOST') {
      blockers.push(
        `the chronological-halves clause is ${deployment.halvesVerdict ?? 'ABSENT'} — ` +
          `${deployment.halves?.reason ?? 'the comparison carries no halves verdict at all'} ` +
          'It fails OPEN for a human reader and CLOSED here: an unattended mint writes an ' +
          'append-only row on its own authority and may not do so on an unverifiable robustness clause.',
      );
    }
  }

  if (floor === undefined || floor === null) {
    // Same disambiguation as the deployment blocker above, and the same reason: loop-authoring.mjs
    // only ever computes `floor` off the WINNER's report, so an absent floor and an absent `deployment`
    // share one root cause today — there is no code path where a candidate is selected but its floor
    // is separately unmeasured. Stated as its own sentence anyway, because a reader should not have to
    // infer that a floor's fate follows the deployment blocker's.
    blockers.push(
      attempted > 0
        ? 'the entry-rate floor was never evaluated — no candidate was SELECTED to evaluate it ' +
            'against (see the deployment blocker above; this is the same cause, not a second failure).'
        : 'the entry-rate floor was never measured',
    );
  } else if (floor.pass !== true) {
    blockers.push(`entry-rate floor VETO — ${floor.reason}`);
  }

  // Not a measurement gate: a mint whose evidence is not in the append-only registry is precisely the
  // selection effect this pass is required to make impossible.
  if (experimentsLogged !== true) {
    blockers.push(
      'the scored variants were not ALL logged to public.experiments — a pass that records only its ' +
        'winners launders a selection effect into the registry',
    );
  }

  const researchVerdict = research?.verdict ?? 'NOT SCORED';
  const deploymentVerdict =
    deployment === undefined || deployment === null
      ? 'NOT COMPARED'
      : deployment.ships === true
        ? 'SHIPS'
        : deployment.halvesVerdict === 'HALF_LOST'
          ? 'HALF-LOST'
          : deployment.horizonDependent === true
            ? 'HORIZON-DEPENDENT'
            : 'LOSES';

  // Reported on EVERY mint decision, pass or refusal, and embedded in each scorecard so an
  // append-only row records the count at its OWN decision moment. It is a REPORT, not a gate: no
  // threshold is declared anywhere, because a threshold chosen after seeing the counts would be the
  // post-hoc bar-setting the halves record refuses (§ 9.2). Absent ⇒ said to be absent, never 0.
  const attempts =
    priorAttemptsOnCorpus === undefined || priorAttemptsOnCorpus === null
      ? 'prior attempts on this corpus: NOT COUNTED'
      : `prior attempts on this corpus: ${renderPriorAttempts(priorAttemptsOnCorpus)}`;

  return {
    mint: blockers.length === 0,
    blockers,
    deploymentVerdict,
    researchVerdict,
    priorAttemptsOnCorpus: priorAttemptsOnCorpus ?? null,
    reason:
      blockers.length === 0
        ? `deployment bar ${deploymentVerdict}, research bar ${researchVerdict} — the deployment bar ` +
          'governs playbook selection and nothing else; this mint is NOT a claim of edge. ' +
          `${attempts}.`
        : `refusing to mint: ${blockers.join('; ')}. ${attempts}.`,
  };
}

/**
 * Every reason a scoring run's own numbers may not be read as measurements. NEVER empty for an
 * uncertified run — a MISSING run object is itself a reason, not "nothing to report" (see the
 * paragraph below on why the opposite default was itself an instance of this same defect).
 *
 * Mirrors classifyMintGate's run-block checks — VOID, ABORTED, and the unfaithful-capabilities
 * (venueFreeCash) defect — rather than sharing code with it: those are independent `if`s there (more
 * than one CAN fire on one run) and this returns every reason that applies, not the first, so a reader
 * of a rendered table sees the identical set of reasons the gate itself would refuse on for the SAME
 * run object — never a subset.
 *
 * Added 2026-08-04, after a run whose stage-5 comparison table and stage-7 entry-rate line both
 * printed an ABORTED run's numbers with no truncation label anywhere near them, while the mint gate fed
 * the same run and correctly refused (research/loop/LOG.md, authoring-2026-08-04). A reader — including
 * a future automated pass reading that LOG entry — could copy a bps delta out of stage 5 without also
 * copying the words that void it. This is the shared single source for those words.
 *
 * WIDENED same day, on adversarial review: the first version checked only VOID/ABORTED and returned `[]` for a missing run,
 * on the reasoning "no run passed ⇒ no rendering input ⇒ no banner". Both were the SAME defect one
 * level up: `unfaithfulCapsRows > 0` is a real, distinct gate refusal ("the replay measured a
 * different account") that produced no banner at all, and a caller that forgot to pass `run` produced
 * a silently unlabelled table rather than an explicit "uncertified" — a label whose entire purpose is
 * preventing misquotation must not itself fail open.
 * @returns {string[]}
 */
export function describeRunTruncation(run) {
  if (run === undefined || run === null) {
    return [
      'no run object was supplied to this render — the numbers cannot be certified against a scoring run at all',
    ];
  }
  const reasons = [];
  if (run.voided === true) {
    reasons.push('the scoring run is VOID (transport floor) — no verdict may be published from it');
  }
  if (run.aborted === true) {
    reasons.push('the scoring run ABORTED on budget — arms are truncated, not comparable');
  }
  if ((run.unfaithfulCapsRows ?? 0) > 0) {
    reasons.push(
      `${run.unfaithfulCapsRows} row(s) replayed with capabilities the live system never recorded — ` +
        'the replay measured a different account (the 2026-07-30 venueFreeCash defect)',
    );
  }
  return reasons;
}

/**
 * The two verdicts side by side, never merged. verdicts.md's first standing verdict exists because
 * they were being conflated, so this renders both with their own labels even when they agree.
 *
 * `run` defaults to an UNCERTIFIED banner when omitted (see describeRunTruncation) rather than to no
 * banner at all — the one production call site always passes it, so this only matters for a future
 * caller, and a fail-open default on a misquotation guard is exactly the shape this whole fix removes
 * everywhere else.
 */
export function renderTwoBars({ arm, deployment, research, priorAttemptsOnCorpus, run }) {
  const truncation = describeRunTruncation(run);
  const lines = [`  variant:          ${arm}`];
  if (truncation.length > 0) {
    lines.push(
      `  *** THESE NUMBERS ARE TRUNCATED / VOID AND MAY NOT BE QUOTED: ${truncation.join('; ')} ***`,
    );
  }
  lines.push(
    `  DEPLOYMENT bar    (beats the RUNNING playbook on the same corpus/metric/horizons):`,
  );
  if (deployment === undefined || deployment === null) {
    lines.push('    NOT COMPARED');
  } else {
    lines.push(
      `    incumbent ${deployment.incumbent}, primary h=${deployment.primaryHorizon}, ` +
        `${deployment.horizonsWon}/${deployment.horizonsCompared} horizons won ⇒ ` +
        `${
          deployment.ships === true
            ? 'SHIPS'
            : deployment.halvesVerdict === 'HALF_LOST'
              ? 'HALF-LOST (does NOT ship)'
              : deployment.horizonDependent === true
                ? 'HORIZON-DEPENDENT (does NOT ship)'
                : 'LOSES'
        }`,
    );
    for (const h of deployment.perHorizon ?? []) {
      lines.push(
        `      h=${String(h.h).padStart(2)}  arm ${h.armMean.toFixed(1).padStart(8)} vs incumbent ` +
          `${h.incumbentMean.toFixed(1).padStart(8)} bps  Δ ${h.deltaBps.toFixed(1).padStart(8)}  ${h.beats ? 'win' : 'loss'}`,
      );
    }
    // The third conjunct, on its own line and never folded into the horizon count: "wins h=24 only"
    // and "loses a half" are different findings about different failure shapes.
    lines.push(
      `    chronological halves (h=${deployment.primaryHorizon} only): ${deployment.halvesVerdict ?? 'ABSENT'}` +
        `${deployment.halves?.reason ? ` — ${deployment.halves.reason}` : ''}`,
    );
    lines.push(`    attribution: ${deployment.attribution}`);
  }
  // The multiplicity nobody was counting. Printed next to the bar it qualifies, because a bar read
  // without it looks like one comparison rather than the n-th.
  lines.push(`  ATTEMPTS ON THIS CORPUS: ${renderPriorAttempts(priorAttemptsOnCorpus)}`);
  lines.push(
    '  RESEARCH bar      (does an edge exist? mean AND CI lo > +13.0 bps under the family alpha):',
  );
  lines.push(
    research === undefined || research === null
      ? '    NOT SCORED'
      : `    ${research.cellsScored}/${research.cellsDeclared} cells, ${research.passes?.length ?? 0} passes ⇒ ${research.verdict}`,
  );
  lines.push(
    '  These are NEVER the same bar. A research-bar FAIL is not a deployment veto (verdicts.md,',
  );
  lines.push('  owner ruling 2026-07-30); a deployment win is not an edge claim.');
  return lines.join('\n');
}

// ── the registry scorecard ───────────────────────────────────────────────────────────────────────

/**
 * One scorecard per SCORED VARIANT, in log-eval-experiment.mjs's own required shape — winners and
 * losers alike, and the incumbent too.
 *
 * Built per-variant rather than as one multi-candidate scorecard because that script derives each
 * row's label from `candidate.model`, so several variants on one model would collide into
 * indistinguishable labels — and an evidence row nobody can attribute is not evidence.
 *
 * `runTruncation` is placed INSIDE `candidates[0]` rather than at the scorecard's own top level,
 * because that is where it survives the trip into the registry row: log-eval-experiment.mjs builds its
 * `metrics` column by spreading `candidates[0]` (`{...candidate, corpusFingerprint, championReference,
 * window, priorAttemptsOnCorpus, …}`, its own source) and copying a short, explicit list of top-level
 * scorecard fields — anything added at the top level and not on that list is silently dropped before
 * it reaches the row. Inside `candidates[0]`, the `...candidate` spread carries it automatically.
 *
 * PURE data shaping off already-fetched values — no fs, no pg, no network — which is why it lives
 * here rather than in the IO shell, and it is the reason this defect was reachable at all.
 * 2026-08-04: this function used to live in loop-authoring.mjs, un-exported and untested, called with
 * the raw `score` object rather than the run-status wrapper every OTHER consumer of run usability
 * already received (`renderTwoBars`'s `run`, `classifyMintGate`'s `run`). The result was three real
 * registry rows — public.experiments id=18, 19, 20 — logged from a run that had ABORTED on budget,
 * with no truncation marker anywhere on them. Append-only means those three cannot be amended; moving
 * this function here and exporting it is what makes the wiring a tested contract from now on, not a
 * call site nobody was checking.
 *
 * `run` takes the SAME run-status object `classifyMintGate` and `renderTwoBars` take (see
 * `describeRunTruncation`) — not the raw scoring result, which alone carries no VOID/exit-status
 * information. The caller resolves that once (`scoringRun` in loop-authoring.mjs) and must thread the
 * identical object everywhere; passing `score` here again would silently reopen this exact gap.
 * @returns {object} the scorecard `log-eval-experiment.mjs --scorecard <file>` expects.
 */
export function buildScorecard(score, report, priorAttemptsOnCorpus, run) {
  const primary = report.cells.find((c) => c.h === 24) ?? report.cells[0];
  return {
    criteriaVersion: 'loop-authoring-v1',
    corpusFingerprint: score.corpus.payloadSha256,
    // The count at THIS row's own decision moment, frozen into an append-only row. Recorded per-row
    // rather than derived later because the registry only ever grows: a count re-derived afterwards
    // answers "how many attempts exist now", and the question that matters is "how many had already
    // been made when this decision was taken".
    priorAttemptsOnCorpus: priorAttemptsOnCorpus?.count ?? null,
    priorAttemptsKey: priorAttemptsOnCorpus?.key ?? null,
    priorAttemptsOnCorpusFingerprint: priorAttemptsOnCorpus?.byFingerprint ?? null,
    corpusSource: 'agent_decisions.input_payload (corpus-v3-flat.jsonl)',
    templateVersion: 'v3',
    window: {
      rowSince: score.corpus.firstEventTime,
      rowUntil: score.corpus.lastEventTime,
      firstEventTime: score.corpus.firstEventTime,
      lastEventTime: score.corpus.lastEventTime,
      rowsLoaded: score.corpus.rows,
      rowsReplayed: score.rowsCovered,
    },
    capabilities: 'recorded (per-row, from the live payload)',
    thinking: 'disabled',
    maxTokens: 512,
    tokenPrices: { [score.model]: null },
    championReference: score.incumbentArm,
    candidates: [
      {
        model: score.model,
        rowsReplayed: report.rowsReplayed,
        schemaValidRate: report.schemaValidRate,
        // The replay contract has no separate sanity layer beyond the schema, so this mirrors it
        // rather than inventing a second number that would read as an independent check.
        tradeSanityRate: report.schemaValidRate,
        proposeCount: report.entries,
        proposeRate: report.entryRate,
        actionHistogram: report.actionHistogram,
        directionalForwardProxyBps: primary?.mean ?? null,
        costPerDecideUsd: score.costPerDecideUsd,
        arm: report.arm,
        role: report.role,
        decisionsChangedVsIncumbent: report.decisionsChangedVsIncumbent,
        cells: report.cells,
        dryRun: score.dryRun,
        // Empty ⇒ the run this row was scored under was usable when the row was written. Non-empty ⇒
        // every reason it was not, in describeRunTruncation's own words — a reader of THIS row alone
        // (an append-only registry row, possibly read years from now with no other context) needs no
        // other document to know it is untrustworthy. See the header note on id=18/19/20, the three
        // rows that predate this field and carry no such marker.
        runTruncation: describeRunTruncation(run),
      },
    ],
  };
}

// ── the registry split-brain guard ───────────────────────────────────────────────────────────────

/**
 * Parses a pg URL down to the only components that decide whether two connection strings address the
 * same table. An empty port is the pg default, so `host/db` and `host:5432/db` are the same target;
 * everything else is compared verbatim — hostnames especially, because this process cannot know
 * whether `localhost` and `127.0.0.1` resolve to the same server. Returns null when the URL cannot be
 * identified at all, which callers must treat as ambiguity rather than agreement.
 *
 * `render` carries host, port and database ONLY. The URLs it is built from carry a password, and
 * every caller of this module prints the result.
 */
function parsePgTarget(url) {
  if (typeof url !== 'string' || url === '') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const database = parsed.pathname.replace(/^\//, '');
  if (parsed.hostname === '' || database === '') return null;
  const port = parsed.port === '' ? '5432' : parsed.port;
  return {
    host: parsed.hostname,
    port,
    database,
    render: `${parsed.hostname}:${port}/${database}`,
  };
}

/**
 * Refuses an authoring pass whose READS and WRITES would land in different databases.
 *
 * The same-day gate and the attempt counter READ over the shell's DATABASE_URL pool, while stage 6
 * WRITES every scored variant to public.experiments over log-eval-experiment.mjs's
 * REGISTRY_DATABASE_URL. If those two diverge, the gate reads a table nobody writes and the counter
 * under-reports forever — and every stage still prints OK, so it is a silent failure that looks like
 * success. That is the whole reason this is a refusal and not a warning.
 *
 * Failure direction: CLOSED. An unparseable or unidentifiable URL on either side refuses, because a
 * target this process cannot name is ambiguity, not agreement. An UNSET registryUrl is NOT this
 * guard's business — log-eval-experiment.mjs's own gate already fails closed on it, and duplicating
 * that refusal here would break `--dry-run`, which logs nothing and so needs no registry at all.
 */
export function classifyRegistrySplitBrain({ databaseUrl, registryUrl }) {
  if (registryUrl === undefined || registryUrl === null || registryUrl === '') {
    return { ok: true, checked: false, reason: null };
  }
  const read = parsePgTarget(databaseUrl);
  const write = parsePgTarget(registryUrl);
  if (read === null || write === null) {
    const which = read === null ? 'DATABASE_URL' : 'REGISTRY_DATABASE_URL';
    return {
      ok: false,
      checked: true,
      reason:
        `cannot compare the read and write targets — ${which} is not a URL this pass can identify ` +
        '(host and database name). An unidentifiable target is ambiguity, not agreement, so this ' +
        'guard refuses rather than assuming the two agree.',
    };
  }
  if (read.render === write.render) return { ok: true, checked: true, reason: null };
  return {
    ok: false,
    checked: true,
    reason:
      `REGISTRY SPLIT BRAIN — DATABASE_URL addresses ${read.render} but REGISTRY_DATABASE_URL ` +
      `addresses ${write.render}. This pass READS its same-day gate and attempt counter over the ` +
      'first and WRITES every scored variant to public.experiments over the second; split across two ' +
      'databases the gate reads a table nobody writes and the counter under-reports forever, while ' +
      'every stage still reports success. Point both at the same host and database — spelled the ' +
      'same way, since this pass cannot know whether two spellings resolve to one server.',
  };
}

// ── the once-per-UTC-day ceiling ─────────────────────────────────────────────────────────────────

/**
 * The family every day-slot marker is written under. One family, so the gate's read and the shell's
 * write can never drift apart: the SCORED rows land under `playbook-authoring`, and keying the
 * ceiling on those instead would be too late to bound anything — stage 4's replay is the expensive
 * part and runs before stage 6 logs it, so a scored-row gate permits two full replays in a day.
 */
export const AUTHORING_ATTEMPT_FAMILY = 'playbook-authoring-attempt';

/**
 * The UTC day `ms` falls in, as `YYYY-MM-DD`. Deterministic in its argument: `new Date(ms)` reads the
 * host clock only when constructed with no argument, which is exactly what this module never does.
 */
function utcDayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The instant the NEXT UTC day opens, strictly after `ms`.
 *
 * `Date.UTC` normalises a day overflow into the following month or year, so 31 December and the end
 * of February need no special case — they are asserted anyway, because "the arithmetic is obviously
 * right" is how off-by-one boundaries survive review.
 */
function nextUtcMidnightMs(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/**
 * A finite epoch-ms, or null. STRICT about the falsy cases on purpose: `Number(null)` is 0, so a bare
 * `Number()` coercion turns a missing clock into 1970-01-01 — a readable boundary in the wrong
 * direction (the gate would proceed, and a row from any real date would look like a different day).
 * Numeric strings are accepted because pg returns `bigint` as text.
 */
function finiteMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * The once-per-UTC-day ceiling on the whole authoring pass. Fails CLOSED — see the header.
 *
 * PURE, and the purity is the feature rather than a style preference. A documented "run this once a
 * day" rule is a rule an unattended pass can forget, and the failure is invisible: two mints in a day
 * both look like successful passes. This function turns the rule into a decision that is a function
 * of its arguments alone — which is also what makes the host-sleep problem structurally unable to
 * recur here. `nowMsFromDb` is the DATABASE clock, taken in the same round trip as `blockingRow` so
 * the boundary and the row are read against one clock; nothing in this file can reach a host clock to
 * disagree with it.
 *
 * There is deliberately NO override flag. An `--i-really-mean-it` escape converts a mechanical gate
 * back into a documented one, and a documented one is precisely what this replaces.
 *
 * @param {{blockingRow?:{id?:string|number,createdAt?:string,createdAtMs?:number}|null,
 *          nowMsFromDb?:number|null, dryRun?:boolean, registryError?:string|null}} input
 * @returns {{proceed:boolean, exempt:boolean, verdict:'EXEMPT'|'SLOT_OPEN'|'SLOT_SPENT'|'CLOCK_UNAVAILABLE',
 *            utcDay:string|null, nextSlotMs:number|null, nextSlotIso:string|null,
 *            blockingRow:{id:string,createdAt:string,createdAtMs:number|null}|null, reason:string}}
 */
export function classifySameDayGate({
  blockingRow = null,
  nowMsFromDb = null,
  dryRun = false,
  registryError = null,
} = {}) {
  const nowMs = finiteMs(nowMsFromDb);
  const clockReadable = nowMs !== null;
  const utcDay = clockReadable ? utcDayKey(nowMs) : null;
  const nextSlotMs = clockReadable ? nextUtcMidnightMs(nowMs) : null;
  const nextSlotIso = nextSlotMs === null ? null : new Date(nextSlotMs).toISOString();
  // Rendered from whatever the row actually carries, never fabricated: an unknown timestamp says so.
  const candidate =
    blockingRow === null || blockingRow === undefined
      ? null
      : {
          id: String(blockingRow.id ?? 'unknown'),
          createdAtMs: finiteMs(blockingRow.createdAtMs),
          createdAt:
            typeof blockingRow.createdAt === 'string' && blockingRow.createdAt !== ''
              ? blockingRow.createdAt
              : finiteMs(blockingRow.createdAtMs) === null
                ? 'unknown'
                : new Date(finiteMs(blockingRow.createdAtMs)).toISOString(),
        };
  // THE DAY COMPARISON IS MADE HERE, not left to the SQL predicate that fetched the row. Both are
  // computed off the same DB clock, so this is not a second opinion — it is the one that is unit
  // tested, which matters because a `date_trunc('day', now() AT TIME ZONE 'UTC')` written without its
  // closing cast silently becomes a LOCAL midnight, and a boundary that is wrong by a few hours looks
  // exactly like a boundary that is right. A row whose own timestamp is unreadable is treated as
  // blocking (CLOSED): the query said it was today's and nothing here contradicts it.
  const staleRow =
    candidate !== null &&
    clockReadable &&
    candidate.createdAtMs !== null &&
    utcDayKey(candidate.createdAtMs) !== utcDay;
  const blocker = candidate === null || staleRow ? null : candidate;

  if (dryRun === true) {
    return {
      proceed: true,
      exempt: true,
      verdict: 'EXEMPT',
      utcDay,
      nextSlotMs,
      nextSlotIso,
      blockingRow: candidate,
      reason:
        '--dry-run is EXEMPT from the once-per-UTC-day ceiling: it makes no paid call and writes no ' +
        'row, so it can neither burn the day’s slot nor need bounding by it. --draft-file is NOT ' +
        'exempt — it skips the drafting call and still spends the full stage-4 replay budget.' +
        (candidate === null
          ? ''
          : ` (An attempt row exists — id=${candidate.id}, ${candidate.createdAt} — and is ignored ` +
            `here; a real run would ${staleRow ? 'also proceed, since that row is not from the current UTC day' : 'refuse on it'}.)`),
    };
  }

  if (registryError !== null && registryError !== undefined && registryError !== '') {
    return {
      proceed: false,
      exempt: false,
      verdict: 'CLOCK_UNAVAILABLE',
      utcDay,
      nextSlotMs,
      nextSlotIso,
      blockingRow: blocker,
      reason:
        `the registry could not be read (${registryError}), so neither the day boundary nor the day’s ` +
        'attempt row can be established. Fails CLOSED, and not out of caution: this pass cannot ' +
        'honour its log-everything precondition against a registry it cannot reach, so proceeding ' +
        'would spend the drafting and replay budget to arrive at a guaranteed mint refusal.',
    };
  }

  if (!clockReadable) {
    return {
      proceed: false,
      exempt: false,
      verdict: 'CLOCK_UNAVAILABLE',
      utcDay: null,
      nextSlotMs: null,
      nextSlotIso: null,
      blockingRow: blocker,
      reason:
        'the DATABASE clock was not readable, so the UTC day boundary cannot be established. Fails ' +
        'CLOSED, and the host clock is NOT a fallback: this stack runs on a laptop that sleeps (one ' +
        'pass spanned a ~7.5h sleep and expired its own 2h lease), so a host-derived UTC midnight is ' +
        'a skewed boundary while the DB is the one clock every writer shares.',
    };
  }

  if (blocker !== null) {
    return {
      proceed: false,
      exempt: false,
      verdict: 'SLOT_SPENT',
      utcDay,
      nextSlotMs,
      nextSlotIso,
      blockingRow: blocker,
      reason:
        `the ${utcDay} slot is already spent: public.experiments id=${blocker.id} ` +
        `(family='${AUTHORING_ATTEMPT_FAMILY}') was written at ${blocker.createdAt}, inside the ` +
        `current UTC day as the DATABASE clock reads it. The next slot opens at ${nextSlotIso}. ` +
        'There is no override flag by design — an escape hatch would convert this mechanical ceiling ' +
        'back into a documented rule, which is the thing it replaces.',
    };
  }

  return {
    proceed: true,
    exempt: false,
    verdict: 'SLOT_OPEN',
    utcDay,
    nextSlotMs,
    nextSlotIso,
    blockingRow: null,
    reason:
      `no ${AUTHORING_ATTEMPT_FAMILY} row exists for ${utcDay} (the UTC day per the DATABASE clock, ` +
      `now ${new Date(nowMs).toISOString()}) — this pass takes the day’s single slot, and the next ` +
      `one opens at ${nextSlotIso}.` +
      (staleRow
        ? ` The newest attempt row (id=${candidate.id}, ${candidate.createdAt}) falls in an EARLIER ` +
          'UTC day and therefore blocks nothing — the day comparison is made against the DB clock ' +
          'here, not left to the query that fetched the row.'
        : ''),
  };
}

// ── the per-horizon net table ────────────────────────────────────────────────────────────────────

/**
 * Break-even GROSS forward return per trip, by lane. Demo mirrors REQUIRED_EDGE_BPS in
 * test/eval/agentic/playbook-space-replay.ts; both trace to verdicts.md § THE ENTRY SIGNAL.
 *
 * Do NOT substitute a flat 20 bps: a +27.6 "net" derived that way is recorded as an error in
 * research/loop/verdicts.md § the +27.6 figure. (This comment previously claimed 20 bps "appears
 * nowhere in this program's own cost model" — FALSE, corrected 2026-07-31. It is stated at
 * research/studies/edge-verdict-2026-08-10.md:93 as the verified binance SPOT schedule, 10 bps/leg
 * maker = taker. The reason not to use it is that this book is ~85% perp by notional, where the
 * schedule is 2/4/5 bps/leg.)
 *
 * These two floors are ASSERTED, NOT DERIVED — they enter the repo fully formed in commit 7b3e977.
 * Measured over every post-epoch fill, the demo lane actually pays 9.29 bps/round trip, so 13.0 is
 * CONSERVATIVE by ~3 bps. Left at 13.0 deliberately: this gates whether a candidate may claim it
 * clears cost, so erring high is the correct direction, and no verdict turns on the difference (the
 * measured performance gap exceeds 110 bps). Full derivation and per-venue rates:
 * research/studies/fee-floor-derivation-2026-07-31.md.
 */
export const COST_FLOOR_BPS = Object.freeze({ demo: 13.0, live: 24.2 });

/**
 * The FROZEN per-horizon measurement of a running playbook, keyed by version.
 *
 * Keyed rather than global because a table quoted for the wrong playbook is worse than no table: v10
 * is the `inverted` arm of the completed playbook-space study, and no other version's cells were
 * measured under that harness. An incumbent with no key here renders EVERY horizon UNMEASURED, which
 * is the honest reading — the same reason resolveIncumbent never falls back to a literal version.
 *
 * Frozen numbers, transcribed from research/studies/playbook-space-replay-2026-07-28.md § Results —
 * `claude-sonnet-5` leg (the `inverted` rows). h ∈ {1,4,8,24} is the whole declared horizon set
 * (HORIZONS in playbook-space-replay.ts); NOTHING was measured at h=40 or h=48, which is exactly
 * where the running playbook's own plans sit.
 */
export const MEASURED_HORIZON_CELLS = Object.freeze({
  10: Object.freeze({
    arm: 'inverted',
    source: 'research/studies/playbook-space-replay-2026-07-28.md § Results — claude-sonnet-5 leg',
    cells: Object.freeze([
      Object.freeze({ h: 1, n: 117, clusters: 20, meanBps: -0.8, ciLoBps: -7.7 }),
      Object.freeze({ h: 4, n: 117, clusters: 20, meanBps: 0.8, ciLoBps: -10.9 }),
      Object.freeze({ h: 8, n: 117, clusters: 20, meanBps: 19.3, ciLoBps: 1.1 }),
      Object.freeze({ h: 24, n: 117, clusters: 20, meanBps: 47.6, ciLoBps: -12.2 }),
    ]),
  }),
});

/** Explicit sign on every figure — an unsigned "0.8" in a table of losses reads as a gain. */
function bps(value) {
  const v = Number(value);
  return `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(1)}`;
}

/**
 * The per-horizon NET table the drafting model is judged against.
 *
 * Exists because the standing objective is qualified PER HORIZON ("reduce the rate where net is
 * negative, hold where it is not") and the model was previously never shown the net — an instruction
 * nothing in the prompt made implementable.
 *
 * VOID-READ POSTURE, which is the load-bearing behaviour here: a horizon with no measured cell is
 * rendered as an explicit UNMEASURED row. It is never omitted and never defaulted — an absent row
 * reads to a model as a zero, and a zero at a horizon of unknown sign is a favourable reading this
 * program has no evidence for. `plannedHorizons` is what the running playbook's own
 * plan_json.maxHoldBars actually asks for, so the horizons it holds to appear in the table whether or
 * not anyone has measured them.
 *
 * @param {{incumbent?:{version:number}, plannedHorizons?:{h:number,n:number}[], floorBps?:number}} input
 * @returns {string}
 */
export function buildPerHorizonNetTable({
  incumbent,
  plannedHorizons = [],
  floorBps = COST_FLOOR_BPS.demo,
} = {}) {
  const measured = MEASURED_HORIZON_CELLS[incumbent?.version];
  const planned = new Map(
    (plannedHorizons ?? [])
      .filter((p) => Number.isFinite(Number(p?.h)))
      .map((p) => [Number(p.h), Number(p.n) || 0]),
  );
  const byHorizon = new Map((measured?.cells ?? []).map((c) => [c.h, c]));
  const horizons = [...new Set([...byHorizon.keys(), ...planned.keys()])].sort((a, b) => a - b);

  const lines = [
    `## PER-HORIZON FORWARD RETURN, NET OF THE COST FLOOR (+${floorBps.toFixed(1)} bps/trip, demo fees)`,
    `The floor is +${COST_FLOOR_BPS.demo.toFixed(1)} bps/trip at demo fees and ` +
      `+${COST_FLOOR_BPS.live.toFixed(1)} bps/trip live (research/loop/verdicts.md). NET = gross mean ` +
      'minus the floor of the lane the arm runs on. There is no flat-20-bps floor in this program.',
    measured === undefined
      ? `No frozen per-horizon measurement exists for the running playbook (v${incumbent?.version ?? '?'}) — ` +
        'every row below is UNMEASURED.'
      : `Measured cells: the ${measured.arm} arm, ${measured.source}.`,
  ];
  if (horizons.length === 0) {
    lines.push('no horizons to report — neither a measured cell nor a planned hold length exists');
    return lines.join('\n');
  }
  for (const h of horizons) {
    const label = `  h=${String(h).padStart(2)}`;
    const plannedNote =
      planned.has(h) === false
        ? ''
        : `  [the running playbook planned this hold length ${planned.get(h)}x]`;
    const cell = byHorizon.get(h);
    if (cell === undefined) {
      lines.push(
        `${label}  UNMEASURED — no cell exists at this horizon. NOT zero and NOT favourable: ` +
          `unvalidated.${plannedNote}`,
      );
      continue;
    }
    const netMean = cell.meanBps - floorBps;
    const netCiLo = cell.ciLoBps - floorBps;
    const verdict =
      netMean < 0
        ? 'NET NEGATIVE — reduce the entry rate here'
        : netCiLo > 0
          ? 'NET POSITIVE at the mean AND the CI lower bound — hold the rate here'
          : 'NET POSITIVE at the mean ONLY, CI lower bound below the floor — hold the rate, do not raise it';
    lines.push(
      `${label}  n=${cell.n}  gross mean ${bps(cell.meanBps).padStart(6)}  ` +
        `CI lo ${bps(cell.ciLoBps).padStart(6)}  NET ${bps(netMean).padStart(6)}  ` +
        `(NET at CI lo ${bps(netCiLo)})  ${verdict}${plannedNote}`,
    );
  }
  lines.push(
    'A gross mean is not an edge: the h=24 cell fails the research bar on its interval and must never ' +
      'be quoted as a level (research/loop/STATUS.md).',
  );
  return lines.join('\n');
}

// ── evidence digest handed to the drafting model ─────────────────────────────────────────────────

/**
 * Compacts the whole-database read into the block the drafting call sees.
 *
 * Deliberately reports COUNTS and MEANS rather than raw rows: the asymmetry this pass is justified by
 * is that the loop can read the whole database, and a digest is how that becomes a prompt instead of
 * a context overflow. Every field is derived from data the shell already fetched; nothing is invented
 * here, and a missing input renders as an explicit "no data" line rather than a zero that reads like a
 * measurement.
 */
export function buildEvidenceDigest({
  decisions,
  versionStats,
  roundTrips,
  incumbent,
  plannedHorizons,
}) {
  const lines = [];
  lines.push('## DECISION JOURNAL (whole table, MODEL-AUTHORED rows only)');
  if (!decisions || decisions.total === 0) {
    lines.push('no decisions recorded');
  } else {
    lines.push(
      `${decisions.excludedNonModel ?? 0} non-LLM rows (prescreen, plan-executor) and ` +
        `${decisions.excluded ?? 0} degraded/pre-call rows excluded — those describe the harness, ` +
        'not the strategy.',
    );
    lines.push(
      `${decisions.total} decides, ${decisions.symbols} symbols, ` +
        `${new Date(decisions.firstEventTime).toISOString()} → ${new Date(decisions.lastEventTime).toISOString()}`,
    );
    for (const [action, count] of Object.entries(decisions.actionHistogram ?? {})) {
      lines.push(
        `  ${action}: ${count} (${((count / decisions.total) * 100).toFixed(1)}% of decides)`,
      );
    }
  }

  lines.push('');
  lines.push('## PER-VERSION ENTRY STATS (AgentDecisionJournalPort.versionEntryStats)');
  if (!versionStats || versionStats.length === 0) {
    lines.push('no per-version stats');
  } else {
    for (const s of versionStats) {
      const rate = s.decides > 0 ? ((s.entries / s.decides) * 100).toFixed(1) : 'n/a';
      lines.push(
        `  v${s.version} (${s.source}): ${s.entries} entries / ${s.decides} attributed decides = ${rate}%` +
          (s.version === incumbent?.version ? '   ← RUNNING' : ''),
      );
    }
  }

  lines.push('');
  lines.push('## CLOSED ROUND TRIPS (walkRoundTrips over the fills table)');
  if (!roundTrips || roundTrips.count === 0) {
    lines.push('no closed round trips');
  } else {
    lines.push(
      `${roundTrips.count} closed cycles, gross ${roundTrips.grossPnlQuote} quote, ` +
        `fees ${roundTrips.feesQuote} quote, net ${roundTrips.netPnlQuote} quote, ` +
        `${roundTrips.winners} winners (${((roundTrips.winners / roundTrips.count) * 100).toFixed(1)}%)`,
    );
    lines.push(
      `mean net per trip: ${roundTrips.meanNetPerTripQuote} quote over ${roundTrips.symbols} symbols`,
    );
  }

  lines.push('');
  lines.push(buildPerHorizonNetTable({ incumbent, plannedHorizons }));
  return lines.join('\n');
}

// ── argv ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Parse argv. Unknown `--options` are rejected rather than ignored — same reasoning as
 * playbook-candidate-core.parseArgs: a mistyped `--dry-ru` that silently became a no-op would spend
 * money the operator believes they suppressed.
 * @returns {{dryRun:boolean,outDir:string|undefined,rows:number|undefined,capUsd:string|undefined,
 *            model:string|undefined,draftFile:string|undefined,label:string|undefined}|{error:string}}
 */
export function parseArgs(argv) {
  const out = { dryRun: false };
  const valued = {
    '--out': 'outDir',
    '--rows': 'rows',
    '--cap-usd': 'capUsd',
    '--model': 'model',
    '--draft-file': 'draftFile',
    '--label': 'label',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    const key = valued[arg];
    if (key !== undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return { error: `${arg} requires a value` };
      out[key] = key === 'rows' ? Number(next) : next;
      i++;
      continue;
    }
    return { error: `unknown option "${arg}"` };
  }
  if (out.rows !== undefined && (!Number.isInteger(out.rows) || out.rows <= 0)) {
    return { error: `--rows must be a positive integer, got ${out.rows}` };
  }
  return out;
}
