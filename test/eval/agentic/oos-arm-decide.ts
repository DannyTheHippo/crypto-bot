// Out-of-sample SESSION arm — decide leg. Preregistered in
// research/studies/oos-session-arm-2026-08-03.md.
//
// Routes through entry-rate-floor.ts's replayPlanRow — never forked — so this decide leg inherits
// recordedCapabilities/capsSource faithfulness, the identical buildTradeTool JSON and zod bound taken
// from `caps`, the identical {ok:false} failure collapse, and the identical cache layout. See that
// pre-registration's "Route through replayPlanRow, do not fork it": forking silently changes the
// measurement — the v3 defect where constant capabilities moved a measured entry rate from 18.2% to
// 4.5% on 33 identical rows.
//
// A Claude SESSION cannot be called from inside a vitest process (the pre-registration's "the one
// seam" section), so the decision SOURCE is pluggable. Two implementations ship here:
//   - makeStubFetchFn: a fixed Anthropic-shaped envelope, used by the dry-run test to prove $0 and
//     exercise the whole path with zero network egress.
//   - makeFileBackedFetchFn: wraps ONE pre-recorded session answer (written out-of-band, keyed by
//     row id, by the real standing arm once the owner-side hourly trigger exists) into the identical
//     envelope shape — it never touches the network either; it builds a Response from an in-memory
//     object the caller already loaded off disk.
//
// FAILURE DIRECTION: this module never widens what replayPlanRow accepts, and never fabricates a
// decision for a row with no session answer on file — a missing answer is the CALLER's job to skip
// and count (loadSessionAnswers returns a map; an absent key is the caller's signal), never silently
// dropped.

import { readFileSync, existsSync } from 'node:fs';
import {
  replayPlanRow,
  type PlanReplayCallConfig,
  type PlanReplayResult,
  type CapabilitiesSource,
} from '../../../src/features/strategy/agentic/entry-rate-floor';
import { buildTradeTool } from '../../../src/features/strategy/agentic/agent-prompt';
import { checkPromptFidelity, type PromptFidelityResult } from './oos-arm-prompt';

/**
 * Row shape this harness offers to a decide call. Structurally carries NO live-lane action field —
 * the live lane's own recorded action is never read or threaded through this module (pre-registration
 * § Deliverable B: "The live lane's own action is NEVER written to this file"). Enforced by TYPE, not
 * just by convention: nothing downstream of this interface can reach a field that does not exist on
 * it — see this file's own spec asserting the exact key set.
 */
export interface OosCandidateRow {
  readonly id: string;
  readonly symbol: string;
  readonly eventTime: number;
  readonly inputPayload: string;
}

const ANTHROPIC_ENVELOPE_TOOL_NAME = buildTradeTool().name; // 'submit_trade'

interface EnvelopeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

function anthropicEnvelope(toolInput: Record<string, unknown>, usage?: EnvelopeUsage): unknown {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: ANTHROPIC_ENVELOPE_TOOL_NAME, input: toolInput }],
    ...(usage
      ? { usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens } }
      : {}),
  };
}

/**
 * $0 by construction: never opens a socket, never resolves a hostname — the Response is built
 * entirely in memory from `toolInput`. Used by the dry-run test (a fixed 'hold') and by anything that
 * wants a deterministic canned decision without a session answer on file.
 */
export function makeStubFetchFn(
  toolInput: Record<string, unknown> = { action: 'hold' },
): typeof fetch {
  const stub = (): Promise<Response> =>
    Promise.resolve(
      new Response(
        JSON.stringify(anthropicEnvelope(toolInput, { inputTokens: 0, outputTokens: 0 })),
        {
          status: 200,
        },
      ),
    );
  return stub;
}

/** One out-of-band session answer, read from the JSONL a real session wrote — never a network call. */
export interface SessionAnswerLine {
  readonly rowId: string;
  readonly toolInput: Record<string, unknown>;
  readonly usage?: EnvelopeUsage;
}

/**
 * Reads every session-answer line once. Missing rows are reported by the CALLER (see the header
 * comment) — an absent key in the returned map is the caller's signal to skip and count that row,
 * never to abort the whole batch on one gap.
 */
export function loadSessionAnswers(jsonlPath: string): ReadonlyMap<string, SessionAnswerLine> {
  const out = new Map<string, SessionAnswerLine>();
  if (!existsSync(jsonlPath)) return out;
  const lines = readFileSync(jsonlPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  for (const line of lines) {
    const parsed = JSON.parse(line) as SessionAnswerLine;
    out.set(parsed.rowId, parsed);
  }
  return out;
}

/** $0 by construction, same as makeStubFetchFn — wraps ONE already-loaded session answer. */
export function makeFileBackedFetchFn(answer: SessionAnswerLine): typeof fetch {
  const stub = (): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(anthropicEnvelope(answer.toolInput, answer.usage)), {
        status: 200,
      }),
    );
  return stub;
}

/** Eligibility (pre-registration § Eligibility): bars elapsed between the row's event_time and the
 * decide instant, at the imported BAR_MS grid. */
export function barsElapsed(eventTimeMs: number, nowMs: number, barMs: number): number {
  return Math.floor((nowMs - eventTimeMs) / barMs);
}

const MAX_ELIGIBLE_K = 3;

/**
 * FAILS CLOSED: a row at k>3 (or k<0 — a clock skew / future-dated row) is REFUSED, never clamped
 * into eligibility — matches the pre-registration's own wording exactly ("a row presented at k > 3
 * is refused, not clamped").
 */
export function assertEligible(row: OosCandidateRow, nowMs: number, barMs: number): void {
  const k = barsElapsed(row.eventTime, nowMs, barMs);
  if (k < 0 || k > MAX_ELIGIBLE_K) {
    throw new Error(
      `row ${row.id} ineligible: k=${k} bars elapsed since event_time (must be 0..${MAX_ELIGIBLE_K})`,
    );
  }
}

export interface OosRowOutcome {
  readonly rowId: string;
  readonly symbol: string;
  readonly eventTime: number;
  readonly result: PlanReplayResult;
  readonly promptFidelity: PromptFidelityResult;
}

/** Decides ONE row, given a fetchFn already bound to that row's own answer (stub or file-backed). */
export async function decideOosRow(
  row: OosCandidateRow,
  cfg: PlanReplayCallConfig,
  systemPrompt: string,
  playbookBlock: string,
  fetchFn: typeof fetch,
): Promise<OosRowOutcome> {
  const promptFidelity = checkPromptFidelity(row.inputPayload);
  const result = await replayPlanRow(cfg, systemPrompt, playbookBlock, row.inputPayload, fetchFn);
  return { rowId: row.id, symbol: row.symbol, eventTime: row.eventTime, result, promptFidelity };
}

// ── VOID condition checks, scored over a batch of decided rows ─────────────────────────────────────

export interface CapsFaithfulnessCheck {
  readonly void: boolean;
  readonly offendingRowIds: readonly string[];
}

/** VOID condition 1: a single non-'recorded' capsSource voids the whole read. */
export function checkCapsFaithfulness(
  outcomes: readonly {
    readonly rowId: string;
    readonly result: { readonly capsSource?: CapabilitiesSource };
  }[],
): CapsFaithfulnessCheck {
  const offendingRowIds = outcomes
    .filter((o) => o.result.capsSource !== 'recorded')
    .map((o) => o.rowId);
  return { void: offendingRowIds.length > 0, offendingRowIds };
}

export interface EntryRateMeasurement {
  readonly rate: number | null;
  readonly entries: number;
  readonly decided: number;
}

/**
 * MEASUREMENT ONLY — never voids. VOID condition 3(b) (the absolute 65% ceiling) is a SEAL-TIME
 * condition defined over the sealed rows (§ 1 of the pre-registration, per the 2026-08-04
 * amendment) and is already enforced there: scripts/loop-oos-arm-core.mjs:436, against the
 * registered scripts/loop-oos-arm-core.mjs:82 constant. A firing here gathers only 1–6 rows, so the
 * condition cannot carry any statistical meaning at that n, and voiding on it would select against
 * entry-heavy firings while keeping hold-heavy ones — a selection effect on the arm's own primary
 * statistic. FAILS OPEN (rules/code-hygiene.md: measurement/veto-only gates fail open): this
 * function only reports `rate` as telemetry for the caller to log alongside the write; it never
 * blocks appendDecisionRecords. `rate: null` on zero decided rows.
 */
export function measureEntryRate(
  outcomes: readonly { readonly result: { readonly ok: boolean; readonly action?: string } }[],
): EntryRateMeasurement {
  const decided = outcomes.filter((o) => o.result.ok);
  const entries = decided.filter(
    (o) => o.result.action === 'open_long' || o.result.action === 'open_short',
  ).length;
  if (decided.length === 0) return { rate: null, entries: 0, decided: 0 };
  return { rate: entries / decided.length, entries, decided: decided.length };
}
