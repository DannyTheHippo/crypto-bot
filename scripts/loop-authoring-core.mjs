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
// FAILURE DIRECTIONS — five gates, and they do not all point the same way:
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
 * @returns {{mint:boolean,reason:string,deploymentVerdict:string,researchVerdict:string,blockers:string[]}}
 */
export function classifyMintGate({ deployment, research, floor, run, experimentsLogged }) {
  const blockers = [];

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
    blockers.push('no deployment comparison — the incumbent was never scored on the same rows');
  } else if (deployment.ships !== true) {
    blockers.push(
      deployment.horizonDependent === true
        ? `beats the incumbent at h=${deployment.primaryHorizon} only (${deployment.horizonsWon}/${deployment.horizonsCompared} horizons) — ` +
            'horizon-dependent, and the pre-registered robustness clause does not ship it'
        : `does not beat the incumbent under the declared deployment bar (${deployment.horizonsWon}/${deployment.horizonsCompared} horizons won, ` +
            `primary h=${deployment.primaryHorizon} ${deployment.beatsAtPrimary === true ? 'won' : 'lost'})`,
    );
  }

  if (floor === undefined || floor === null) {
    blockers.push('the entry-rate floor was never measured');
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
        : deployment.horizonDependent === true
          ? 'HORIZON-DEPENDENT'
          : 'LOSES';

  return {
    mint: blockers.length === 0,
    blockers,
    deploymentVerdict,
    researchVerdict,
    reason:
      blockers.length === 0
        ? `deployment bar ${deploymentVerdict}, research bar ${researchVerdict} — the deployment bar ` +
          'governs playbook selection and nothing else; this mint is NOT a claim of edge.'
        : `refusing to mint: ${blockers.join('; ')}.`,
  };
}

/**
 * The two verdicts side by side, never merged. verdicts.md's first standing verdict exists because
 * they were being conflated, so this renders both with their own labels even when they agree.
 */
export function renderTwoBars({ arm, deployment, research }) {
  const lines = [
    `  variant:          ${arm}`,
    `  DEPLOYMENT bar    (beats the RUNNING playbook on the same corpus/metric/horizons):`,
  ];
  if (deployment === undefined || deployment === null) {
    lines.push('    NOT COMPARED');
  } else {
    lines.push(
      `    incumbent ${deployment.incumbent}, primary h=${deployment.primaryHorizon}, ` +
        `${deployment.horizonsWon}/${deployment.horizonsCompared} horizons won ⇒ ` +
        `${deployment.ships === true ? 'SHIPS' : deployment.horizonDependent === true ? 'HORIZON-DEPENDENT (does NOT ship)' : 'LOSES'}`,
    );
    for (const h of deployment.perHorizon ?? []) {
      lines.push(
        `      h=${String(h.h).padStart(2)}  arm ${h.armMean.toFixed(1).padStart(8)} vs incumbent ` +
          `${h.incumbentMean.toFixed(1).padStart(8)} bps  Δ ${h.deltaBps.toFixed(1).padStart(8)}  ${h.beats ? 'win' : 'loss'}`,
      );
    }
    lines.push(`    attribution: ${deployment.attribution}`);
  }
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
export function buildEvidenceDigest({ decisions, versionStats, roundTrips, incumbent }) {
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
