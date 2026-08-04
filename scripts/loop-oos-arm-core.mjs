#!/usr/bin/env node
// Out-of-sample SESSION arm — SCORER, PURE logic. No I/O, no clock, no process/env access, never
// throws. Pre-registered in research/studies/oos-session-arm-2026-08-03.md; this module scores what
// the decide leg (test/eval/agentic/oos-arm-{decide,record,prompt}.ts) records, joining the live
// lane's own action at score time from `agent_decisions` — the decision record never carries it (the
// whole point: the record cannot carry the comparator's answer, § Blindness is procedural).
//
// FAILURE DIRECTION — this is a MEASUREMENT and it FAILS OPEN, exactly like
// loop-forward-return-core.mjs (imported here, never forked): it emits ANNOTATIONS ONLY, carries no
// `alarms` key, and an unsealed/unstarted arm is reported as such — never as a clean pass and never by
// throwing. An adverse or absent finding is the measurement working, not the loop breaking.
//
// WHAT THIS SCORER CAN AND CANNOT CHECK, stated once here rather than scattered:
//   - VOID condition 1 (capsSource !== 'recorded')  — CHECKED, independently of the decide leg's own
//     checkCapsFaithfulness (test/eval/agentic/oos-arm-decide.ts) as a defense-in-depth read.
//   - VOID condition 3, AS AMENDED 2026-08-04 (arm/live entry-rate ratio outside [1/6, 6.0], or arm
//     rate above 65% absolute) — CHECKED, same independence rationale. The retired absolute [4%, 40%]
//     band is gone: its 4% floor sat above the incumbent's own measured rate and voided correct
//     behaviour (research/studies/oos-session-arm-2026-08-03.md § 3 of that amendment).
//   - VOID condition 5 (missing seal) — CHECKED: no experiments row, no score.
//   - VOID condition 2 (system-prompt fidelity hash match) — CHECKED when the caller supplies
//     `promptBlobAtCommit` (the I/O shell's job: `git rev-parse <commitSha>:<PROMPT_SURFACE_FILE>` per
//     row's own recorded `agentPromptCommitSha`, the SAME primitive
//     test/eval/agentic/playbook-space-replay.ts's `checkPromptSurface` uses for HEAD, generalised to
//     an arbitrary historical commit). A row whose resolved blob differs from its own recorded
//     `hashes.agentPromptBlobSha` VOIDS the read — the working tree was dirty relative to that commit
//     when the row was decided, so what was recorded is not what that commit actually held. A row
//     whose commit cannot be resolved (git failure, unrelated history) is named as UNVERIFIABLE, never
//     silently passed or silently voided. When the caller supplies no map at all — the I/O shell has
//     no git access, or a caller exercises this core directly — every row is UNVERIFIABLE and named
//     `oos_arm_prompt_fidelity_unchecked`, never a silent clean assumption.
//     Corrected 2026-08-03: an earlier draft of this header claimed `checkPromptSurface` did not
//     exist in playbook-space-replay.ts. That was a stale read taken while the peer module was being
//     written concurrently — it exists (`:1680`), the peer's own tests pass against it, and this
//     scorer now uses the same primitive. The claim above is corrected, not merely removed, per the
//     amendment discipline this program uses for its own pre-registrations.
//   - VOID condition 4 (transcript blindness) — not code-checkable at all (§ Blindness is procedural
//     in the pre-registration); no code path can evaluate it, so no annotation claims to.
//
// Six disjoint scored reads, one per sealed window (§ Multiplicity, § Row-window bookkeeping) — each
// `experiments` row with family='oos-arm-seal' is exactly one read, scored independently against its
// own sealed rowIds/window. The DB-assigned `created_at` is the only timestamp this module trusts for
// ordering reads (root CLAUDE.md hard rule 6: `experiments` is append-only, read-only here).

import {
  BAR_MS,
  MIN_ENTRIES,
  MIN_CLUSTERS,
  N_BOOT,
  BOOTSTRAP_SEED,
  makeRand,
  baseAsset,
  computeForwardReturn,
  pairedClusterBootstrapDelta,
  summarise,
  fmtBps,
} from './loop-forward-return-core.mjs';

export const OOS_ARM_SEAL_FAMILY = 'oos-arm-seal';

/** Six disjoint scored reads, alpha = 0.05/6 (pre-registration § Multiplicity). A seventh seal is a
 * new pre-registration and may not be scored against this alpha. */
export const MAX_FAMILY_READS = 6;
export const ALPHA = 0.05 / MAX_FAMILY_READS;

/** The two-sided critical z at this arm's own alpha — TRANSCRIBED, not re-derived, from the
 * pre-registration's own arithmetic (research/studies/oos-session-arm-2026-08-03.md § The arithmetic:
 * "z = 2.639 + 0.8416 = 3.4806" — the first term is the critical value at alpha=8.33e-3 two-sided;
 * the second is the power term, not used by a single test). */
export const Z_ALPHA = 2.639;

/** Entry-rate VOID band — pre-registration § VOID conditions condition 3 AS AMENDED 2026-08-04
 * (research/studies/oos-session-arm-2026-08-03.md § 3 of that amendment). The absolute [4%, 40%]
 * band is RETIRED: its 4% floor sat ABOVE the incumbent lane's own v10 rate (21/543 = 3.8674%), so
 * it voided correct behaviour and discarded the arm's most informative outcome. The band is now
 * RELATIVE to the live lane's rate on the SAME sealed rows, plus one absolute ceiling above every
 * rate ever recorded on this corpus (kimi 62.0%, verdicts.md:190). 6.0 sits above the largest
 * model-axis ratio on record (3.85x) and below the recorded capabilities-defect magnitude (7.64x),
 * which is the payload-vs-model separation the condition claimed to make. */
export const ENTRY_RATE_RATIO_MAX = 6.0;
export const ENTRY_RATE_RATIO_MIN = 1 / 6.0;
export const MAX_ENTRY_RATE_ABS = 0.65;

/** ONLY h=24 is the declared SECONDARY bound (pre-registration § SECONDARY — an h=24 forward-return
 * BOUND: "What is reported: the h=24 mean and its cluster-bootstrap 95% interval ... over the read's
 * own rows"). h=1/4/8 are computed by the imported core by default but are out of THIS arm's declared
 * scope — passed as `eligibleHorizons` so their exclusion is NAMED, never silent. */
export const SECONDARY_HORIZONS = [24];

/** Required ROWS to detect an absolute entry-rate difference `d` at this arm's alpha/power, per
 * § 2 of the 2026-08-04 amendment (two-proportion, pooled, planning p = 0.041743) — carried
 * alongside every primary read so a point estimate never appears without the row-count context
 * that says whether it could possibly have moved. Supersedes the original one-sample table
 * (140/558/1551) — NOT uniformly larger: the two-proportion form needs MORE rows at d=10pp
 * (202 vs 140, 1.44x) and marginally more at d=5pp (604 vs 558, 1.08x), but FEWER at d=3pp
 * (1441 vs 1551, 0.93x). The table below is correct (n = 2z²p̄q̄/d², z=3.4806, p=0.041743); only
 * this comment's earlier blanket "needs more of them" claim was wrong. */
export const PRIMARY_REQUIRED_ROWS = [
  { d: 0.1, n: 202 },
  { d: 0.05, n: 604 },
  { d: 0.03, n: 1441 },
];

function annotation(kind, detail) {
  return { kind, detail };
}

function mean(a) {
  return a.length === 0 ? null : a.reduce((s, x) => s + x, 0) / a.length;
}

// Lanczos approximation for ln(Gamma(x)) — used only to build log-binomial coefficients for the
// Fisher's-exact substitution below (§ 2 of the 2026-08-04 amendment). Every call site here passes
// x >= 1 (n+1, k+1 forms with n, k >= 0), so the reflection branch is dead in this module's own
// usage; it is kept anyway so the function is correct on its own terms rather than correct only for
// its current callers.
const LANCZOS_G = 7;
const LANCZOS_COEF = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const xm1 = x - 1;
  let a = LANCZOS_COEF[0];
  const t = xm1 + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_G + 2; i++) a += LANCZOS_COEF[i] / (xm1 + i);
  return 0.5 * Math.log(2 * Math.PI) + (xm1 + 0.5) * Math.log(t) - t + Math.log(a);
}

function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}

/**
 * Two-sided Fisher's exact test p-value for the 2x2 table [[a, b], [c, d]] — the pre-declared
 * substitution for the pooled two-proportion z when either arm's entry count is below 5 (§ 2 of the
 * 2026-08-04 amendment). Sums hypergeometric probabilities no greater than the observed table's, in
 * log-space to avoid factorial overflow at n in the hundreds. Returns null (never NaN, never throws)
 * on a degenerate table — a zero row/column sum, where every possible table is equally likely and no
 * statistic distinguishes them.
 */
function fisherExactTwoSidedP(a, b, c, d) {
  const r1 = a + b;
  const r2 = c + d;
  const col1 = a + c;
  const total = r1 + r2;
  if (r1 <= 0 || r2 <= 0 || col1 <= 0 || col1 >= total) return null;
  const kMin = Math.max(0, col1 - r2);
  const kMax = Math.min(r1, col1);
  const logDenom = logChoose(total, col1);
  const logPAt = (k) => logChoose(r1, k) + logChoose(r2, col1 - k) - logDenom;
  const logObserved = logPAt(a);
  const eps = 1e-9;
  let p = 0;
  for (let k = kMin; k <= kMax; k++) {
    const logPk = logPAt(k);
    if (logPk <= logObserved + eps) p += Math.exp(logPk);
  }
  return Math.min(1, p);
}

const fmtPct = (v) => (v === null || !Number.isFinite(v) ? 'n/a' : `${(v * 100).toFixed(1)}%`);

/**
 * One line of research/oos-arm/decisions-*.jsonl, parsed defensively against the shape
 * test/eval/agentic/oos-arm-record.ts's DecisionRecord/ALLOWED_RECORD_KEYS emits (rowId, eventTime,
 * venue, symbol, base, playbookVersion, hashes, agentPromptCommitSha, capsSource, schemaValid,
 * action, directives). Returns null on ANY shape failure rather than throwing — a malformed line is
 * counted by the caller, never fatal to the read.
 */
export function parseDecisionLine(line) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (!row || typeof row !== 'object') return null;
  if (typeof row.rowId !== 'string' || row.rowId.length === 0) return null;
  if (!Number.isFinite(row.eventTime)) return null;
  if (typeof row.venue !== 'string' || typeof row.symbol !== 'string') return null;
  return row;
}

/**
 * The PRIMARY doctrine, tailored to a proportion rather than a bps mean: never let the arm/live
 * entry-rate point estimates leave this module detached from their POWERED/UNDERPOWERED label, same
 * rule loop-forward-return-core.mjs's `summarise` enforces for a bps cell — this is a parallel
 * implementation rather than a reuse of that function because a proportion is not a bps figure and
 * dressing it in `fmtBps`'s "+X.X bps" suffix would misstate the unit.
 */
function summarisePrimary(cell) {
  const failed = [];
  if (cell.n < MIN_ENTRIES) failed.push(`n=${cell.n}<${MIN_ENTRIES}`);
  if (cell.clusters < MIN_CLUSTERS) failed.push(`clusters=${cell.clusters}<${MIN_CLUSTERS}`);
  const power = cell.powered ? 'POWERED' : `UNDERPOWERED (${failed.join(' and ')})`;
  // Pre-declared substitution (§ 2 of the 2026-08-04 amendment): below 5 entries in either arm the
  // normal approximation is invalid and the primary is a Fisher exact p, never a z.
  const statStr = cell.usedFisher
    ? cell.fisherP === null
      ? 'fisher p=n/a'
      : `fisher p=${cell.fisherP.toFixed(4)} (flags at alpha=${ALPHA.toFixed(4)})`
    : cell.z === null
      ? 'z=n/a'
      : `z=${cell.z.toFixed(2)} (|z|>${Z_ALPHA} flags at alpha=${ALPHA.toFixed(4)})`;
  return (
    `${power} arm entry-rate=${fmtPct(cell.armRate)} live entry-rate=${fmtPct(cell.liveRate)} ` +
    `n=${cell.n} armTrials=${cell.armTrials} clusters=${cell.clusters} ${statStr}`
  );
}

/** One sealed window, scored independently. Never throws — every branch returns a shape, and a
 * missing/unreadable field yields a VOID or an UNDERPOWERED read rather than a crash. */
function scoreOneRead({
  seal,
  readIndex,
  decisionsByRowId,
  liveByKey,
  gridRows,
  promptBlobAtCommit,
}) {
  const annotations = [];
  const metrics = seal.metrics && typeof seal.metrics === 'object' ? seal.metrics : {};
  const rowIds = Array.isArray(metrics.rowIds) ? metrics.rowIds : null;
  const windowStart = Number(metrics.windowStart);
  const windowEnd = Number(metrics.windowEnd);

  if (rowIds === null || !Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
    annotations.push(
      annotation(
        'oos_arm_seal_metrics_unreadable',
        `read ${readIndex}: the seal's metrics carried no readable rowIds/windowStart/windowEnd — ` +
          'VOID (condition 5: a seal without a fixed row set is no evidence the window was fixed ' +
          'before the look)',
      ),
    );
    return {
      readIndex,
      windowStart: Number.isFinite(windowStart) ? windowStart : null,
      windowEnd: Number.isFinite(windowEnd) ? windowEnd : null,
      sealedAtMs: seal.createdAtMs,
      n: 0,
      void: true,
      voidReasons: ['seal_metrics_unreadable'],
      primary: null,
      secondary: null,
      companions: null,
      annotations,
    };
  }

  // Pair each sealed row id against its decision-record line and the live lane's own action, joined
  // by (eventTime, venue, symbol) — the decision record never carries the live action itself.
  const paired = [];
  let missingDecision = 0;
  let joinMiss = 0;
  for (const rowId of rowIds) {
    const decision = decisionsByRowId.get(rowId);
    if (!decision) {
      missingDecision += 1;
      continue;
    }
    const key = `${decision.eventTime}|${decision.venue}|${decision.symbol}`;
    const live = liveByKey.get(key);
    if (!live) {
      joinMiss += 1;
      continue;
    }
    paired.push({ decision, live });
  }
  if (missingDecision > 0) {
    annotations.push(
      annotation(
        'oos_arm_sealed_row_decision_missing',
        `read ${readIndex}: ${missingDecision} of ${rowIds.length} sealed row id(s) have no matching ` +
          'line in the decision record — excluded from every statistic below rather than guessed',
      ),
    );
  }
  if (joinMiss > 0) {
    annotations.push(
      annotation(
        'oos_arm_live_join_miss',
        `read ${readIndex}: ${joinMiss} of ${rowIds.length - missingDecision} decided row(s) had no ` +
          'matching agent_decisions row at score time — excluded rather than paired with a guessed ' +
          'comparator',
      ),
    );
  }

  // VOID condition 2: system-prompt fidelity hash match. Checked ONLY when the I/O shell supplied a
  // commit->blob resolution map (`promptBlobAtCommit` — see module header); every row is otherwise
  // named UNCHECKED rather than silently assumed clean. A row whose commit cannot be resolved is
  // UNVERIFIABLE, never silently passed or silently voided.
  let condition2Void = false;
  const hasBlobMap =
    promptBlobAtCommit !== null &&
    promptBlobAtCommit !== undefined &&
    typeof promptBlobAtCommit === 'object';
  if (!hasBlobMap) {
    annotations.push(
      annotation(
        'oos_arm_prompt_fidelity_unchecked',
        `read ${readIndex}: VOID condition 2 (system-prompt fidelity hash match) was NOT evaluated — ` +
          'the caller supplied no commit->blob resolution map. This is an open gap for THIS call, not ' +
          'a clean pass: do not read its absence as evidence the prompt surface matched',
      ),
    );
  } else {
    let mismatches = 0;
    let unresolvable = 0;
    for (const p of paired) {
      const commitSha = p.decision.agentPromptCommitSha;
      const recordedBlob = p.decision.hashes?.agentPromptBlobSha;
      if (
        typeof commitSha !== 'string' ||
        commitSha.length === 0 ||
        typeof recordedBlob !== 'string'
      ) {
        unresolvable += 1;
        continue;
      }
      const resolvedBlob = promptBlobAtCommit[commitSha];
      if (typeof resolvedBlob !== 'string' || resolvedBlob.length === 0) {
        unresolvable += 1;
        continue;
      }
      if (resolvedBlob !== recordedBlob) mismatches += 1;
    }
    if (unresolvable > 0) {
      annotations.push(
        annotation(
          'oos_arm_prompt_fidelity_unverifiable',
          `read ${readIndex}: ${unresolvable} of ${paired.length} row(s) carry a commit SHA this ` +
            'scorer could not resolve to a blob (git failure, unrelated history, or a missing hash ' +
            'field) — condition 2 is UNVERIFIABLE for those rows, neither passed nor voided',
        ),
      );
    }
    if (mismatches > 0) {
      annotations.push(
        annotation(
          'oos_arm_void_prompt_fidelity',
          `read ${readIndex}: ${mismatches} of ${paired.length} row(s) recorded an agent-prompt.ts ` +
            'blob hash that does NOT match what their own recorded commit actually held — VOID ' +
            'condition 2 (the working tree was dirty relative to that commit when the row was ' +
            'decided, so what was recorded is not what that commit holds)',
        ),
      );
    } else if (unresolvable < paired.length) {
      annotations.push(
        annotation(
          'oos_arm_prompt_fidelity_verified',
          `read ${readIndex}: every resolvable row's recorded agent-prompt.ts blob hash matches its ` +
            'own recorded commit — VOID condition 2 clean for this read',
        ),
      );
    }
    if (mismatches > 0) condition2Void = true;
  }

  const voidReasons = [];
  if (condition2Void) voidReasons.push('prompt_fidelity');

  // VOID condition 1: capsSource !== 'recorded' on ANY row.
  const nonRecordedCaps = paired.filter((p) => p.decision.capsSource !== 'recorded');
  if (nonRecordedCaps.length > 0) {
    voidReasons.push('caps_source');
    annotations.push(
      annotation(
        'oos_arm_void_caps_source',
        `read ${readIndex}: ${nonRecordedCaps.length} of ${paired.length} row(s) carry capsSource ` +
          "!== 'recorded' — VOID condition 1. A single non-recorded row voids this read (WATCH-V4-9 " +
          'precedent: a caps mismatch does not perturb an entry rate, it manufactures one)',
      ),
    );
  }

  const schemaValidRows = paired.filter((p) => p.decision.schemaValid === true);
  const armEntryDecisions = schemaValidRows.filter(
    (p) => p.decision.action === 'open_long' || p.decision.action === 'open_short',
  );
  const armEntryRate =
    schemaValidRows.length === 0 ? null : armEntryDecisions.length / schemaValidRows.length;

  // The live comparator on the SAME sealed rows (§ 1 of the 2026-08-04 amendment, replacing the
  // supplied 13.29% figure) — moved ahead of VOID condition 3 below because that condition is now
  // defined relative to this rate, not against a frozen constant.
  const liveEntryCount = paired.filter(
    (p) => p.live.action === 'open_long' || p.live.action === 'open_short',
  ).length;
  const liveEntryRate = paired.length === 0 ? null : liveEntryCount / paired.length;

  // VOID condition 3 AS AMENDED 2026-08-04: (a) S/L outside [1/6, 6.0], or (b) S > 65% absolute.
  // There is NO absolute floor: a low session entry count is reported with its true n and achieved
  // power (§ Underpowered and incomplete), never voided.
  if (armEntryRate !== null && armEntryRate > MAX_ENTRY_RATE_ABS) {
    // Distinct from the ratio reason below (condition 3(a)) — a read that trips BOTH must never
    // print the same reason twice, which reads as one finding rather than two.
    voidReasons.push('entry_rate_ceiling');
    annotations.push(
      annotation(
        'oos_arm_void_entry_rate',
        `read ${readIndex}: arm entry rate ${fmtPct(armEntryRate)} exceeds the absolute ceiling ` +
          `${fmtPct(MAX_ENTRY_RATE_ABS)} — VOID condition 3(b)`,
      ),
    );
  }
  if (armEntryRate !== null && liveEntryRate !== null && liveEntryRate > 0) {
    const entryRateRatio = armEntryRate / liveEntryRate;
    if (entryRateRatio > ENTRY_RATE_RATIO_MAX || entryRateRatio < ENTRY_RATE_RATIO_MIN) {
      voidReasons.push('entry_rate_ratio');
      annotations.push(
        annotation(
          'oos_arm_void_entry_rate',
          `read ${readIndex}: arm/live entry-rate ratio ${entryRateRatio.toFixed(2)}x ` +
            `(${fmtPct(armEntryRate)} vs ${fmtPct(liveEntryRate)}) is outside ` +
            `[${ENTRY_RATE_RATIO_MIN.toFixed(3)}, ${ENTRY_RATE_RATIO_MAX.toFixed(1)}] — ` +
            'VOID condition 3(a): payload/prompt-surface integrity, not a model difference',
        ),
      );
    }
  } else if (armEntryRate !== null && liveEntryRate === 0) {
    annotations.push(
      annotation(
        'oos_arm_entry_rate_ratio_inapplicable',
        `read ${readIndex}: the live lane entered 0 of ${paired.length} sealed rows, so the ` +
          'ratio arm of VOID condition 3 is INAPPLICABLE (not a VOID) — only the 65% ceiling ' +
          'applies and the primary is computed by Fisher exact per § 2 of the 2026-08-04 amendment',
      ),
    );
  }

  if (voidReasons.length > 0) {
    return {
      readIndex,
      windowStart,
      windowEnd,
      sealedAtMs: seal.createdAtMs,
      n: paired.length,
      void: true,
      voidReasons,
      primary: null,
      secondary: null,
      companions: null,
      annotations,
    };
  }

  // ---- PRIMARY: arm entry rate vs the live lane's OWN rate on the SAME rows ----
  // liveEntryCount/liveEntryRate were computed above, ahead of VOID condition 3, which now depends
  // on them. The comparator is still the live lane's OWN measured rate on THIS read's own rows, never
  // the retired 13.29% figure (§ 1 of the 2026-08-04 amendment).
  const n = paired.length;
  const clustersInRead = new Set(paired.map((p) => baseAsset(p.decision.symbol))).size;
  // Imported MIN_ENTRIES/MIN_CLUSTERS floor, reused as a coarse gate — NOT the study's own
  // required-row table (202-1441 rows, § 2 of the 2026-08-04 amendment), which is carried alongside
  // every primary read via PRIMARY_REQUIRED_ROWS instead of being enforced as a hard gate here.
  const powered = n >= MIN_ENTRIES && clustersInRead >= MIN_CLUSTERS;
  const armEntryCount = armEntryDecisions.length;
  // armTrials is the arm's OWN denominator (armEntryRate = armEntryCount / armTrials above), and it
  // is NOT n whenever any sealed row is schema-invalid — n counts every PAIRED row, armTrials counts
  // only the schema-valid ones the arm actually offered a rate over. Reusing n as the arm's row total
  // in the table below silently rescales the arm's rate to armEntryCount/n, which is a DIFFERENT
  // proportion than the one printed beside it (2026-08-04 review finding: a 12.5%-vs-6.3% arm/live
  // gap printed fisher p=1.0000 because the mis-scaled table was symmetric by construction whenever
  // armEntryCount === liveEntryCount, independent of the true rate gap).
  const armTrials = schemaValidRows.length;
  let z = null;
  let fisherP = null;
  let usedFisher = false;
  if (armEntryRate !== null && liveEntryRate !== null && armTrials > 0 && n > 0) {
    if (armEntryCount < 5 || liveEntryCount < 5) {
      // Pre-declared substitution (§ 2 of the amendment), made before any read, never chosen after
      // seeing counts: below 5 entries in either arm the normal approximation is invalid.
      usedFisher = true;
      fisherP = fisherExactTwoSidedP(
        armEntryCount,
        armTrials - armEntryCount,
        liveEntryCount,
        n - liveEntryCount,
      );
      annotations.push(
        annotation(
          'oos_arm_primary_fisher_exact',
          `read ${readIndex}: primary computed by Fisher's exact test (arm entries=${armEntryCount}, ` +
            `live entries=${liveEntryCount}, at least one below 5) per § 2 of the 2026-08-04 amendment`,
        ),
      );
    } else {
      const pPool = (armEntryCount + liveEntryCount) / (armTrials + n);
      if (pPool > 0 && pPool < 1) {
        z =
          (armEntryRate - liveEntryRate) / Math.sqrt(pPool * (1 - pPool) * (1 / armTrials + 1 / n));
      }
    }
  }
  // No divergence/flag is ever computed on an underpowered cell — the SAME rule computeCell's
  // `powered` gate enforces for the bps secondary.
  const flagged =
    powered && ((z !== null && Math.abs(z) > Z_ALPHA) || (fisherP !== null && fisherP <= ALPHA));
  const primaryCell = {
    n,
    armTrials,
    clusters: clustersInRead,
    armRate: armEntryRate,
    liveRate: liveEntryRate,
    z,
    fisherP,
    usedFisher,
    powered,
  };
  const primary = {
    summary: summarisePrimary(primaryCell),
    flagged,
    requiredRowsContext: PRIMARY_REQUIRED_ROWS,
  };

  // ---- SECONDARY: h=24 forward-return bound, arm vs live, on the SAME gridRows ----
  // The arm has no position state to scale into — each row is classified independently — so isFlat is
  // uniformly true for both arms; `population: 'all'` and `'flat_only'` are therefore identical here
  // by construction, which is a declared simplification, not a defect.
  const toEntryRow = (p, action) => ({
    eventTime: p.decision.eventTime,
    venue: p.decision.venue,
    symbol: p.decision.symbol,
    action,
    playbookVersion: p.decision.playbookVersion ?? null,
    isFlat: true,
  });
  const armEntryRowsForFr = armEntryDecisions.map((p) => toEntryRow(p, p.decision.action));
  const liveEntryRowsForFr = paired
    .filter((p) => p.live.action === 'open_long' || p.live.action === 'open_short')
    .map((p) => toEntryRow(p, p.live.action));

  // reference: {} — an empty reference table suppresses divergence-vs-replay flags cleanly (there is
  // no replay comparand for either arm) rather than computing a divergence against a missing one.
  const armFr = computeForwardReturn({
    entryRows: armEntryRowsForFr,
    gridRows,
    reference: {},
    eligibleHorizons: SECONDARY_HORIZONS,
    includeObservations: true,
  });
  const liveFr = computeForwardReturn({
    entryRows: liveEntryRowsForFr,
    gridRows,
    reference: {},
    eligibleHorizons: SECONDARY_HORIZONS,
    includeObservations: true,
  });
  for (const a of armFr.annotations) {
    annotations.push(
      annotation(`oos_arm_secondary_arm_${a.kind}`, `read ${readIndex}: ${a.detail}`),
    );
  }
  for (const a of liveFr.annotations) {
    annotations.push(
      annotation(`oos_arm_secondary_live_${a.kind}`, `read ${readIndex}: ${a.detail}`),
    );
  }

  const findH24 = (fr) =>
    fr.panels.flatMap((p) => p.horizons).find((h) => h.h === 24 && h.status === 'measured') ?? null;
  const armH24 = findH24(armFr);
  const liveH24 = findH24(liveFr);

  let secondary = null;
  if (armH24 && liveH24) {
    const pairedDelta = pairedClusterBootstrapDelta(
      armH24.obs ?? [],
      liveH24.obs ?? [],
      makeRand(BOOTSTRAP_SEED),
    );
    const deltaPowered = armH24.cell.powered && liveH24.cell.powered;
    const draws = pairedDelta.draws;
    const deltaMean = draws.length === 0 ? null : mean(draws);
    const deltaCell = {
      n: Math.min(armH24.cell.n, liveH24.cell.n),
      clusters: pairedDelta.bases,
      mean: deltaMean,
      ciLo:
        deltaPowered && draws.length > 0 ? (draws[Math.floor(0.025 * draws.length)] ?? null) : null,
      ciHi:
        deltaPowered && draws.length > 0 ? (draws[Math.floor(0.975 * draws.length)] ?? null) : null,
      powered: deltaPowered,
    };
    if (pairedDelta.degenerate > 0) {
      annotations.push(
        annotation(
          'oos_arm_paired_bootstrap_degenerate_draws',
          `read ${readIndex}: ${pairedDelta.degenerate} of ${N_BOOT} paired bootstrap draws were ` +
            'degenerate (the resample carried zero observations for one arm) and are COUNTED, not ' +
            'silently dropped, in the reported interval',
        ),
      );
    }
    secondary = {
      arm: { summary: summarise(armH24.cell) },
      live: { summary: summarise(liveH24.cell) },
      delta: { summary: summarise(deltaCell), degenerateDraws: pairedDelta.degenerate },
    };
    if (!deltaPowered) {
      annotations.push(
        annotation(
          'oos_arm_secondary_underpowered',
          `read ${readIndex}: h=24 delta is UNDERPOWERED (${summarise(deltaCell)}) — no divergence ` +
            'or model-axis claim may be drawn from it (pre-registration § THIS ARM IS NOT POWERED)',
        ),
      );
    }
  } else {
    annotations.push(
      annotation(
        'oos_arm_secondary_unavailable',
        `read ${readIndex}: h=24 could not be scored for one or both arms (no eligible entries, or ` +
          'the underlying probe failed) — no secondary bound is reported for this read',
      ),
    );
  }

  // ---- companions — descriptive only, never scored, never a PASS (pre-registration § The four
  // reported companions) ----
  const bothHold = paired.filter(
    (p) => p.decision.action === 'hold' && p.live.action === 'hold',
  ).length;
  const longs = armEntryDecisions.filter((p) => p.decision.action === 'open_long').length;
  const shorts = armEntryDecisions.filter((p) => p.decision.action === 'open_short').length;
  const companions = {
    schemaCompliance: paired.length === 0 ? null : schemaValidRows.length / paired.length,
    holdAgreement: paired.length === 0 ? null : bothHold / paired.length,
    actionChange:
      paired.length === 0
        ? null
        : paired.filter((p) => p.decision.action !== p.live.action).length / paired.length,
    directionMix: { long: longs, short: shorts },
  };

  return {
    readIndex,
    windowStart,
    windowEnd,
    sealedAtMs: seal.createdAtMs,
    n,
    void: false,
    voidReasons: [],
    primary,
    secondary,
    companions,
    annotations,
  };
}

/**
 * @param decisionLines  every line of research/oos-arm/decisions-*.jsonl, concatenated across every
 *   matching file in file-then-line order, or null when the read failed outright (distinct from an
 *   empty array, which means the file(s) exist and carry zero lines).
 * @param seals  experiments rows with family='oos-arm-seal' as
 *   `{ createdAtMs, metrics }` (metrics is the jsonb column, parsed), or null when the probe failed.
 *   An empty array is a valid "zero seals yet" reading, not a probe failure.
 * @param liveEntryRows  the live lane's own agent_decisions rows for the symbols/venues/times the
 *   decision record touches — `{ eventTime, venue, symbol, action }` — or null when the probe failed.
 * @param gridRows  the price grid, `computeForwardReturn`-shaped, or null when the probe failed.
 * @param promptBlobAtCommit  optional plain object mapping an `agentPromptCommitSha` to the blob hash
 *   `git rev-parse <sha>:<PROMPT_SURFACE_FILE>` resolved to (I/O shell's job) — enables VOID condition
 *   2. Omitted entirely, every read names condition 2 UNCHECKED rather than silently assuming it clean.
 * Never throws. Returns { status, reads, familySpent, annotations } and deliberately no `alarms` key.
 */
export function computeOosArm({
  decisionLines,
  seals,
  liveEntryRows,
  gridRows,
  promptBlobAtCommit,
} = {}) {
  const annotations = [];

  let decisionRows = null;
  if (!Array.isArray(decisionLines)) {
    annotations.push(
      annotation(
        'oos_arm_decision_record_absent',
        'research/oos-arm/decisions-*.jsonl could not be read (absent or unreadable) — the arm has ' +
          'recorded no offered rows. Per the pre-registration (§ Cadence) this is EXPECTED until the ' +
          'owner-side hourly decide-leg trigger exists: the arm is UNSTARTED, not FAILED, and this is ' +
          'a void read rather than a clean zero',
      ),
    );
  } else {
    decisionRows = [];
    let unparseable = 0;
    for (const line of decisionLines) {
      const row = parseDecisionLine(line);
      if (row === null) {
        unparseable += 1;
        continue;
      }
      decisionRows.push(row);
    }
    if (unparseable > 0) {
      annotations.push(
        annotation(
          'oos_arm_decision_lines_unparseable',
          `${unparseable} of ${decisionLines.length} decision-record line(s) failed to parse into ` +
            'the expected shape and were dropped — the rest are scored on their own',
        ),
      );
    }
    if (decisionLines.length === 0) {
      annotations.push(
        annotation(
          'oos_arm_decision_record_empty',
          'research/oos-arm/ carries zero decision-record lines — either the directory does not ' +
            'exist yet or its files are empty (this core does not distinguish the two; the I/O shell ' +
            'folds both into the same empty reading). No rows have been offered yet either way',
        ),
      );
    }
  }

  let validSeals = null;
  if (!Array.isArray(seals)) {
    annotations.push(
      annotation(
        'oos_arm_seal_probe_failed',
        `the experiments probe for family='${OOS_ARM_SEAL_FAMILY}' returned no readable rows — this ` +
          'is NOT "zero seals", it is no reading at all (VOID condition 5 cannot even be evaluated)',
      ),
    );
  } else {
    validSeals = seals.filter(
      (s) => s && Number.isFinite(s.createdAtMs) && s.metrics && typeof s.metrics === 'object',
    );
    const invalid = seals.length - validSeals.length;
    if (invalid > 0) {
      annotations.push(
        annotation(
          'oos_arm_seal_rows_unreadable',
          `${invalid} of ${seals.length} experiments row(s) with family='${OOS_ARM_SEAL_FAMILY}' ` +
            'carried an unusable created_at/metrics shape and were dropped',
        ),
      );
    }
  }

  const familySpent = validSeals !== null && validSeals.length > MAX_FAMILY_READS;
  if (familySpent) {
    annotations.push(
      annotation(
        'oos_arm_family_spent',
        `${validSeals.length} seal(s) recorded — the family is SPENT past its ${MAX_FAMILY_READS}` +
          '-read budget (§ Multiplicity). Any read beyond the sixth is a new pre-registration and ' +
          "may not be scored against this document's alpha",
      ),
    );
  }

  if (validSeals === null || validSeals.length === 0) {
    annotations.push(
      annotation(
        'oos_arm_unstarted',
        'no sealed window exists yet — VOID condition 5 ("no seal, no score") means no read may be ' +
          'scored. This is UNSTARTED, not FAILED (§ Cadence: "Until [the hourly] trigger exists the ' +
          'arm is UNSTARTED, not failed, and no read may be sealed")',
      ),
    );
    return { status: 'unstarted', reads: [], familySpent, annotations };
  }

  if (decisionRows === null) {
    // A seal exists but the decision record itself could not be read — genuinely UNDETERMINED, not
    // merely unstarted: something WAS sealed, so the corresponding rows should be readable and are not.
    return { status: 'undetermined', reads: [], familySpent, annotations };
  }

  const decisionsByRowId = new Map();
  for (const row of decisionRows) decisionsByRowId.set(row.rowId, row);

  const liveByKey = new Map();
  if (Array.isArray(liveEntryRows)) {
    for (const r of liveEntryRows) {
      if (
        !r ||
        typeof r.venue !== 'string' ||
        typeof r.symbol !== 'string' ||
        !Number.isFinite(r.eventTime)
      ) {
        continue;
      }
      liveByKey.set(`${r.eventTime}|${r.venue}|${r.symbol}`, r);
    }
  } else {
    annotations.push(
      annotation(
        'oos_arm_live_comparator_probe_failed',
        'the live-lane comparator probe against agent_decisions returned no readable rows — no row ' +
          "can be paired against the live lane's own action, so no primary/secondary statistic can " +
          'be scored for any read below',
      ),
    );
  }

  const reads = [...validSeals]
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .slice(0, MAX_FAMILY_READS)
    .map((seal, idx) =>
      scoreOneRead({
        seal,
        readIndex: idx + 1,
        decisionsByRowId,
        liveByKey,
        gridRows,
        promptBlobAtCommit,
      }),
    );

  for (const r of reads) annotations.push(...r.annotations);

  return {
    status: 'measured',
    reads: reads.map(({ annotations: _annotations, ...rest }) => rest),
    familySpent,
    annotations,
  };
}

/** Renderable report — kept here (pure) so the runner cannot assemble a number without its label,
 * same discipline as loop-forward-return-core.mjs's renderForwardReturn. */
export function renderOosArm(result) {
  const lines = [
    '## Out-of-sample session arm (research/studies/oos-session-arm-2026-08-03.md)',
    '',
    '_Measurement only — annotations, never alarms. Fails OPEN: a broken scorer must never block the ' +
      'arm it measures. PRIMARY is behavioural (entry-rate agreement); SECONDARY is a declared BOUND, ' +
      'never a model-axis verdict._',
    '',
  ];
  if (!result) return lines.join('\n');
  lines.push(`Status: **${result.status}**${result.familySpent ? ' — FAMILY SPENT' : ''}`, '');
  for (const r of result.reads ?? []) {
    const sealedIso = Number.isFinite(r.sealedAtMs) ? new Date(r.sealedAtMs).toISOString() : 'n/a';
    lines.push(
      `### Read ${r.readIndex} — sealed ${sealedIso}, window [${r.windowStart ?? 'n/a'}, ` +
        `${r.windowEnd ?? 'n/a'})`,
    );
    if (r.void) {
      lines.push(`- **VOID** — ${r.voidReasons.join(', ')}`);
    } else {
      lines.push(`- PRIMARY: ${r.primary.summary}${r.primary.flagged ? ' — FLAGGED' : ''}`);
      lines.push(
        '  required rows for a d-point entry-rate difference: ' +
          r.primary.requiredRowsContext.map((x) => `${(x.d * 100).toFixed(0)}pp→${x.n}`).join(', '),
      );
      if (r.secondary) {
        lines.push(
          `- SECONDARY (h=24 bound, NOT a model-axis test): arm ${r.secondary.arm.summary}`,
        );
        lines.push(`  live: ${r.secondary.live.summary}`);
        lines.push(
          `  delta: ${r.secondary.delta.summary} (degenerate draws: ${r.secondary.delta.degenerateDraws})`,
        );
      } else {
        lines.push('- SECONDARY: not available for this read');
      }
      lines.push(
        `- companions (descriptive only, never scored): schema=${fmtPct(r.companions.schemaCompliance)} ` +
          `hold-agree=${fmtPct(r.companions.holdAgreement)} action-change=${fmtPct(r.companions.actionChange)} ` +
          `direction long/short=${r.companions.directionMix.long}/${r.companions.directionMix.short}`,
      );
    }
    lines.push('');
  }
  if ((result.annotations ?? []).length > 0) {
    lines.push('### Annotations', '');
    for (const a of result.annotations) lines.push(`- **${a.kind}** — ${a.detail}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The SWEEP view of the same result — what loop-sweep.mjs merges into `result.annotations`, mirroring
 * `sweepAnnotations` in loop-forward-return-core.mjs. Unlike that module's per-horizon matrix, this
 * arm has few enough moving parts (at most six reads) that no rollup is needed yet — every annotation
 * is carried verbatim. A future amendment adding a rollup would do so here, not by growing a second
 * copy of this function in the runner.
 */
export function oosArmAnnotations(result) {
  if (!result || !Array.isArray(result.annotations)) {
    return [
      annotation(
        'oos_arm_tool_failed',
        'the out-of-sample session-arm scorer returned no result object — void read, not a clean one',
      ),
    ];
  }
  return result.annotations;
}

export { BAR_MS };
