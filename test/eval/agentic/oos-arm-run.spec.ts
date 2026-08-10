// Out-of-sample SESSION arm — env-gated RUNNER. Preregistered in
// research/studies/oos-session-arm-2026-08-03.md; the decide-leg pass step this spec implements is
// documented in docs/planning/daily-profitability-loop.md § the decide leg (added alongside this
// file) — read that section for the candidates-file shape this module consumes and the gather query
// that produces it (scripts/loop-oos-arm-gather.mjs).
//
// Modelled on test/eval/agentic/loop-authoring-score.spec.ts's idiom: env-gated, skips CLEANLY when
// its gate is unset (`describe.runIf`), so `pnpm eval:agentic` / `pnpm eval:oos-arm` exercise this
// file's shape every run without ever spending anything or touching a committed record. Gate:
// `OOS_ARM_RUN=1`, plus `OOS_ARM_CANDIDATES_FILE` and `OOS_ARM_ANSWERS_FILE`.
//
// FAILURE DIRECTION, split by what each failure protects:
//   - assertEligible per row is called UNCAUGHT — an ineligible row (k<0 or k>3) ABORTS the whole
//     batch rather than being silently dropped. The eligibility filter is an invariant (pre-reg §
//     Eligibility), not a per-row skip: a candidates file that carries an ineligible row is evidence
//     the gather step's own event_time bound (§ vi, "event_time > now - 4*BAR_MS") or the gather
//     instant itself is wrong, and that is a defect to surface immediately, not to paper over.
//   - A row with NO answer on file is different: it is not a defect, it is an incomplete session
//     pass (the blind subagent ran out of turns, or a row arrived between the candidates gather and
//     the session's own read). It is SKIPPED and COUNTED, never silently dropped — a truncated batch
//     that reports its own truncation is honest; one that does not is the exact "silent skip" this
//     module's docstring calls a defect class in itself.
//   - checkCapsFaithfulness/checkEntryRateBound run BEFORE appendDecisionRecords, and a voided batch
//     writes NOTHING — the fail-closed direction the append-only decision record needs: once a line
//     is written it is never retracted (this module's sibling, oos-arm-record.ts, only appends), so
//     the gate belongs before the write, not after it.
//
// This file NEVER runs against a real candidates/answers file in this repo's own validation — the
// task that built this module is machinery only ("do not run the arm, do not seal anything, do not
// write any decision record with real data"). The always-on describe block below exercises
// decideCandidateBatch's own logic (missing-answer counting, eligibility abort, file-backed decide)
// with synthetic fixtures and zero I/O against research/oos-arm/, so this module's core behaviour has
// real coverage independent of ever firing the env-gated leg.

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeFileBackedFetchFn,
  loadSessionAnswers,
  assertEligible,
  decideOosRow,
  checkCapsFaithfulness,
  checkEntryRateBound,
  type OosCandidateRow,
  type OosRowOutcome,
  type SessionAnswerLine,
  type EntryRateBoundCheck,
  type CapsFaithfulnessCheck,
} from './oos-arm-decide';
import {
  buildDecisionRecord,
  appendDecisionRecords,
  decisionsFilePath,
  type DecisionRecord,
} from './oos-arm-record';
import { buildLiveSystemPrompt, agentPromptModuleFingerprint, sha256Hex } from './oos-arm-prompt';
import {
  DEFAULT_FLOOR_PROFILE,
  type PlanReplayCallConfig,
} from '../../../src/features/strategy/agentic/entry-rate-floor';
import { buildPlaybookBlock } from '../../../src/features/strategy/agentic/agent-prompt';

// BAR_MS is IMPORTED, not redefined — same read-the-source idiom oos-session-arm.spec.ts uses (see
// that file's own header comment for why a static `import` from a plain-ESM .mjs core does not
// typecheck here).
const LOOP_FORWARD_RETURN_CORE_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'scripts',
  'loop-forward-return-core.mjs',
);

function readBarMsFromCore(): number {
  const source = readFileSync(LOOP_FORWARD_RETURN_CORE_PATH, 'utf8');
  const match = /export const BAR_MS = ([\d_]+);/.exec(source);
  if (!match) {
    throw new Error(
      `could not read BAR_MS out of ${LOOP_FORWARD_RETURN_CORE_PATH} — the source format changed; ` +
        'this must not fall back to a hand-copied literal.',
    );
  }
  return Number(match[1]!.replace(/_/g, ''));
}

const BAR_MS = readBarMsFromCore();

/** One row of the candidates file (§ vi's gather query output, documented in
 * docs/planning/daily-profitability-loop.md). Extends OosCandidateRow with the two fields
 * buildDecisionRecord requires and the gather SQL selects but OosCandidateRow itself does not carry
 * (venue, playbookVersion) — the gather SQL never selects `action`, matching this row's own shape. */
export interface OosRunCandidateRow extends OosCandidateRow {
  readonly venue: string;
  readonly playbookVersion: number | null;
}

/** The candidates file this runner reads. `gatheredAtMsFromDb` is the DB clock's `now()` at gather
 * time (§ vi: "nowMs comes from the DATABASE clock, not the host") — eligibility is asserted against
 * it, never against `Date.now()` on whatever machine runs this spec. `playbookContent` is the single
 * playbook body active across the whole gather window (§ vi: a ~1-hour lookback rarely spans a
 * version bump; the row-level `playbookVersion` is carried for the decision record and as a
 * consistency check, not as a second content source). */
export interface OosArmCandidatesFile {
  readonly gatheredAtMsFromDb: number;
  readonly playbookContent: string;
  readonly rows: readonly OosRunCandidateRow[];
}

export function readCandidatesFile(path: string): OosArmCandidatesFile {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as OosArmCandidatesFile;
  if (!Array.isArray(parsed.rows) || !Number.isFinite(parsed.gatheredAtMsFromDb)) {
    throw new Error(
      `readCandidatesFile: ${path} does not carry the expected {gatheredAtMsFromDb, playbookContent, ` +
        'rows} shape',
    );
  }
  return parsed;
}

export interface CandidateBatchResult {
  readonly outcomes: readonly OosRowOutcome[];
  readonly decidedRows: readonly OosRunCandidateRow[];
  readonly missingAnswerRowIds: readonly string[];
}

/**
 * Decides every ELIGIBLE row in `rows` that has a matching answer on file. Pure with respect to I/O
 * beyond the injected `fetchFn` (file-backed or stubbed by the caller) — no network, no DB, no
 * filesystem write. Exported so it has coverage independent of the env-gated integration leg below.
 *
 * FAILS CLOSED on eligibility: `assertEligible` is called uncaught for every row BEFORE any decide
 * call, so an ineligible row throws out of this function entirely — nothing it already decided is
 * returned. A missing answer is different: it is skipped and its rowId collected in
 * `missingAnswerRowIds`, never thrown, matching oos-arm-decide.ts's own documented contract for an
 * absent answer-map key.
 */
export async function decideCandidateBatch(
  rows: readonly OosRunCandidateRow[],
  answers: ReadonlyMap<string, SessionAnswerLine>,
  nowMs: number,
  cfg: PlanReplayCallConfig,
  systemPrompt: string,
  playbookBlock: string,
): Promise<CandidateBatchResult> {
  // Eligibility is asserted over the WHOLE batch before any decide call — an ineligible row aborts
  // the batch rather than being silently dropped (module header).
  for (const row of rows) assertEligible(row, nowMs, BAR_MS);

  const outcomes: OosRowOutcome[] = [];
  const decidedRows: OosRunCandidateRow[] = [];
  const missingAnswerRowIds: string[] = [];
  for (const row of rows) {
    const answer = answers.get(row.id);
    if (!answer) {
      missingAnswerRowIds.push(row.id);
      continue;
    }
    const outcome = await decideOosRow(
      row,
      cfg,
      systemPrompt,
      playbookBlock,
      makeFileBackedFetchFn(answer),
    );
    outcomes.push(outcome);
    decidedRows.push(row);
  }
  return { outcomes, decidedRows, missingAnswerRowIds };
}

const DEFAULT_CFG: PlanReplayCallConfig = {
  apiKey: 'sk-ant-oos-arm-run-placeholder-never-sent',
  model: 'claude-oos-arm-run-placeholder',
  timeoutMs: 5_000,
  sizeFractionMax: '0.25',
  shortsEnabled: true,
};

function capsBlock(venue: string): Record<string, unknown> {
  return {
    capabilities: {
      venue,
      shorts: false,
      leverage: '1',
      maxSizeFraction: '0.15',
      venueFreeCash: '500',
    },
  };
}

describe('decideCandidateBatch — always-on coverage, zero I/O beyond the injected fetchFn', () => {
  const NOW_MS = 1_800_000_000_000;
  const { systemPrompt } = buildLiveSystemPrompt(DEFAULT_FLOOR_PROFILE);
  const playbookBlock = buildPlaybookBlock('decideCandidateBatch fixture playbook');

  function row(id: string, k: number, symbol = 'BTC/USDT'): OosRunCandidateRow {
    return {
      id,
      symbol,
      eventTime: NOW_MS - k * BAR_MS,
      venue: 'binance',
      playbookVersion: 1,
      inputPayload: JSON.stringify({ symbol, ...capsBlock('binance') }),
    };
  }

  it('decides every row that has a matching answer, in order', async () => {
    const rows = [row('r1', 0), row('r2', 1)];
    const answers = new Map<string, SessionAnswerLine>([
      ['r1', { rowId: 'r1', toolInput: { action: 'hold' } }],
      ['r2', { rowId: 'r2', toolInput: { action: 'hold' } }],
    ]);
    const result = await decideCandidateBatch(
      rows,
      answers,
      NOW_MS,
      DEFAULT_CFG,
      systemPrompt,
      playbookBlock,
    );
    expect(result.outcomes).toHaveLength(2);
    expect(result.decidedRows.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(result.missingAnswerRowIds).toEqual([]);
    expect(result.outcomes.every((o) => o.result.ok)).toBe(true);
  });

  it('skips a row with no answer on file and COUNTS it — never a silent drop', async () => {
    const rows = [row('r1', 0), row('r2', 1), row('r3', 2)];
    const answers = new Map<string, SessionAnswerLine>([
      ['r1', { rowId: 'r1', toolInput: { action: 'hold' } }],
      // r2 deliberately has no answer.
      ['r3', { rowId: 'r3', toolInput: { action: 'hold' } }],
    ]);
    const result = await decideCandidateBatch(
      rows,
      answers,
      NOW_MS,
      DEFAULT_CFG,
      systemPrompt,
      playbookBlock,
    );
    expect(result.outcomes).toHaveLength(2);
    expect(result.missingAnswerRowIds).toEqual(['r2']);
    // The skip is COUNTED (present in the returned shape), not merely absent from the outcomes.
    expect(result.missingAnswerRowIds.length).toBe(3 - result.outcomes.length);
  });

  it('ABORTS the whole batch on an ineligible row (k>3) — never silently drops it', async () => {
    const rows = [row('r1', 0), row('r2', 4)]; // r2 is 4 bars old — ineligible
    const answers = new Map<string, SessionAnswerLine>([
      ['r1', { rowId: 'r1', toolInput: { action: 'hold' } }],
      ['r2', { rowId: 'r2', toolInput: { action: 'hold' } }],
    ]);
    await expect(
      decideCandidateBatch(rows, answers, NOW_MS, DEFAULT_CFG, systemPrompt, playbookBlock),
    ).rejects.toThrow(/ineligible/);
  });

  it('ABORTS on a future-dated row (clock skew) exactly like a stale one', async () => {
    const rows = [row('r1', -1)]; // event_time AFTER nowMs
    const answers = new Map<string, SessionAnswerLine>([
      ['r1', { rowId: 'r1', toolInput: { action: 'hold' } }],
    ]);
    await expect(
      decideCandidateBatch(rows, answers, NOW_MS, DEFAULT_CFG, systemPrompt, playbookBlock),
    ).rejects.toThrow(/ineligible/);
  });
});

describe('readCandidatesFile — shape check, no gate required', () => {
  it('reads back an object it wrote, and refuses a shape missing rows/gatheredAtMsFromDb', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oos-arm-run-spec-'));
    const file = join(dir, 'candidates.json');
    const payload: OosArmCandidatesFile = {
      gatheredAtMsFromDb: 1_800_000_000_000,
      playbookContent: 'fixture playbook',
      rows: [
        {
          id: 'r1',
          symbol: 'BTC/USDT',
          eventTime: 1_800_000_000_000,
          venue: 'binance',
          playbookVersion: 1,
          inputPayload: '{}',
        },
      ],
    };
    writeFileSync(file, JSON.stringify(payload), 'utf8');
    expect(existsSync(file)).toBe(true);
    const read = readCandidatesFile(file);
    expect(read.rows).toHaveLength(1);
    expect(read.gatheredAtMsFromDb).toBe(payload.gatheredAtMsFromDb);

    const badFile = join(dir, 'bad.json');
    writeFileSync(badFile, JSON.stringify({ nope: true }), 'utf8');
    expect(() => readCandidatesFile(badFile)).toThrow(/expected/);
  });
});

// ── env-gated integration leg ───────────────────────────────────────────────────────────────────────
// Gate: OOS_ARM_RUN=1, plus OOS_ARM_CANDIDATES_FILE and OOS_ARM_ANSWERS_FILE. Skips CLEANLY (no tests
// run under this describe) when the gate is unset — proven by running this file/`eval:oos-arm` with no
// env set, which is exactly what this repo's own validation does; this leg never fires in that run.
const RUN = process.env['OOS_ARM_RUN'] === '1';
const CANDIDATES_FILE = process.env['OOS_ARM_CANDIDATES_FILE'] ?? '';
const ANSWERS_FILE = process.env['OOS_ARM_ANSWERS_FILE'] ?? '';

describe.runIf(RUN)('oos-arm-run — decide leg, real candidates and answers files', () => {
  it(
    'decides every eligible, answered candidate row and appends a record for each — VOID aborts the write',
    async () => {
      expect(CANDIDATES_FILE, 'OOS_ARM_CANDIDATES_FILE is required').not.toBe('');
      expect(ANSWERS_FILE, 'OOS_ARM_ANSWERS_FILE is required').not.toBe('');

      const candidates = readCandidatesFile(CANDIDATES_FILE);
      const answers = loadSessionAnswers(ANSWERS_FILE);
      const { systemPrompt, systemPromptSha256, toolSchemaSha256 } =
        buildLiveSystemPrompt(DEFAULT_FLOOR_PROFILE);
      const playbookBlock = buildPlaybookBlock(candidates.playbookContent);
      const fingerprint = agentPromptModuleFingerprint();

      const { outcomes, decidedRows, missingAnswerRowIds }: CandidateBatchResult =
        await decideCandidateBatch(
          candidates.rows,
          answers,
          candidates.gatheredAtMsFromDb,
          DEFAULT_CFG,
          systemPrompt,
          playbookBlock,
        );

      // The missing-answer count is REPORTED, not silently absorbed (module header) — this is the one
      // line an operator reading CI/pass output sees regardless of whether they inspect the return
      // value.
      console.log(
        `oos-arm-run: ${outcomes.length} decided, ${missingAnswerRowIds.length} of ` +
          `${candidates.rows.length} rows had no answer on file and were skipped: ` +
          `[${missingAnswerRowIds.join(', ')}]`,
      );

      const capsCheck: CapsFaithfulnessCheck = checkCapsFaithfulness(outcomes);
      const rateCheck: EntryRateBoundCheck = checkEntryRateBound(outcomes);
      // FAIL CLOSED: a voided batch writes NOTHING (module header) — checked BEFORE
      // appendDecisionRecords, never after.
      expect(capsCheck.void, `capsSource VOID: ${capsCheck.offendingRowIds.join(', ')}`).toBe(
        false,
      );
      expect(rateCheck.void, `entry-rate VOID: rate=${rateCheck.rate}`).toBe(false);

      const records: DecisionRecord[] = outcomes.map((outcome, i) => {
        const decidedRow = decidedRows[i]!;
        return buildDecisionRecord({
          rowId: outcome.rowId,
          symbol: outcome.symbol,
          eventTime: outcome.eventTime,
          venue: decidedRow.venue,
          playbookVersion: decidedRow.playbookVersion,
          hashes: {
            systemPromptSha256,
            playbookContentSha256: sha256Hex(playbookBlock),
            toolSchemaSha256,
            agentPromptBlobSha: fingerprint.worktreeBlobSha,
          },
          agentPromptCommitSha: fingerprint.commitSha,
          capsSource: outcome.result.capsSource ?? 'config',
          result: outcome.result,
        });
      });

      const dateIso = new Date(candidates.gatheredAtMsFromDb).toISOString().slice(0, 10);
      appendDecisionRecords(decisionsFilePath(dateIso), records);
    },
    10 * 60 * 1000,
  );
});
