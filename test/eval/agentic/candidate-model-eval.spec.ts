// Live eval: replays >= 200 REAL recorded agent_decisions.input_payload rows through one or more
// CANDIDATE MODELS (a model swap, not a prompt/playbook variant — see candidate-vs-champion.spec.ts
// for that axis) against the REAL Anthropic API in PLAN MODE, and prints a per-model scorecard next
// to the CHAMPION baseline the rows already recorded. Champion never makes a network call: its
// scorecard is derived entirely from the rows' own persisted action/confidence/usage — only the
// candidate models are actually replayed.
//
// Triple-gated (stricter than recorded-payload-live-compare.spec.ts's double gate — a full sweep
// over >= 200 rows per candidate model is materially more expensive than that file's 2x-row-count
// single-variant compare):
//   - EVAL_CANDIDATES=1 — this suite's own opt-in. Absent ⇒ skip, so `pnpm eval:agentic` (which sets
//     no env) never reaches this file even when ANTHROPIC_API_KEY/DATABASE_URL happen to be set.
//   - ANTHROPIC_API_KEY (or AGENTIC_EVAL_API_KEY) — the network gate every live eval file uses.
//   - DATABASE_URL + the same read-only DB_SUITE_ALLOW_RESET/_test-suffix gate recorded-rows.spec.ts
//     uses (mirrored locally below, not imported — each spec's gate stays self-contained and
//     independently auditable).
// Any one missing skips the whole suite; PLAN MODE is used for every candidate call (not the legacy
// submit_decision path) because it is the only response shape that can yield a plan-field sanity
// verdict (metric #4) — PLAN_TOOL's action enum is still long/flat/hold, so action-agreement and
// propose-rate against the recorded (legacy-path) actions are still meaningful.
//
// To run it against a real staging/local DB + key:
//   DATABASE_URL=postgres://...              (must end in _test, or set DB_SUITE_ALLOW_RESET=1)
//   ANTHROPIC_API_KEY=sk-ant-...
//   EVAL_CANDIDATES=1
//   AGENTIC_EVAL_CANDIDATE_MODELS=claude-haiku-4-5-20251001,claude-opus-5   (optional, comma-sep)
//   ROW_LIMIT=50                             (optional — rows actually REPLAYED per candidate model;
//                                              each replayed row costs one real API call per model)
//   ROW_QUERY_LIMIT=1000                     (optional — rows FETCHED before the >=200 filter/slice)
//   AGENTIC_TOKEN_PRICES_JSON='{"claude-haiku-4-5-20251001":{"inputPerMtok":"1","outputPerMtok":"5"}}'
//                                             (optional — same shape as the app config knob)
//   AGENTIC_EVAL_BASE_URL=https://api.moonshot.ai/anthropic
//                                             (optional — Anthropic-COMPATIBLE host to replay
//                                              against; the code owns the /v1/messages suffix;
//                                              default https://api.anthropic.com)
//   AGENTIC_EVAL_API_KEY=sk-...               (optional — key for that host, falls back to
//                                              ANTHROPIC_API_KEY; either satisfies the gate)
//   AGENTIC_EVAL_CALL_DELAY_MS=20000          (optional — inter-call sleep for low-RPM key tiers)
//   AGENTIC_EVAL_TIMEOUT_MS=1800000           (optional — it() timeout override, default 600000)
//   ROW_SINCE=1783714500000 ROW_UNTIL=1783876500000
//                                             (optional — inclusive epoch-ms event_time window;
//                                              aim at a propose-dense corpus stretch — an
//                                              all-hold champion window nulls propose-ratio and
//                                              the forward-proxy comparison)
//   AGENTIC_EVAL_ROW_LOG_FILE=rows.jsonl      (optional — per-row JSONL audit trail: champion vs
//                                              candidate action, validity, usage)
//   pnpm exec vitest run test/eval/agentic/candidate-model-eval.spec.ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../../src/database/schemas/trading';
import { AgentDecisionJournalAdapter } from '../../../src/database/repositories/strategy/agent-decision-journal.adapter';
import { appendFileSync, writeFileSync } from 'node:fs';
import type { AgentDecisionRow } from '../../../src/ports/strategy/agentic-strategy';
import {
  PLAN_BOUNDS,
  PLAN_TOOL,
  PLAN_TEMPLATE_VERSION,
  computePromptHash,
} from '../../../src/features/strategy/agentic/agent-prompt';
import { SEED_PLAYBOOK } from '../../../src/features/strategy/agentic/agentic-strategy.module';
import {
  summarizeRecentDecisionOutcomes,
  type ScoringRow,
} from '../../../src/features/strategy/agentic/counterfactual-scoring';
import { EVAL_PROFILE, toScoringAction, buildLegacyPlanSystemPrompt } from './fixtures';
import {
  composeRecordedUserMessage,
  scoringRowFromPayload,
  type PromptIdentity,
  type RecordedDecisionOutcome,
} from './recorded-payload-fixtures';
import {
  fetchWithRateLimitRetry,
  parseTokenPriceOverrides,
  meanCostUsd,
} from './trade-eval-fixtures';

const API_KEY = process.env['ANTHROPIC_API_KEY'];
// Prerequisite-B routing (kimi-k3 memo): AGENTIC_EVAL_BASE_URL/_API_KEY point the replay at an
// Anthropic-COMPATIBLE endpoint (e.g. Moonshot's /anthropic surface) without touching the
// production client. Defaults keep Anthropic runs byte-identical; the gate accepts either key, so
// a routed run needs no ANTHROPIC_API_KEY exported — and therefore cannot silently bill Anthropic.
const EVAL_API_KEY = process.env['AGENTIC_EVAL_API_KEY'] ?? API_KEY;
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const EVAL_BASE_URL = (process.env['AGENTIC_EVAL_BASE_URL'] ?? DEFAULT_BASE_URL).replace(
  /\/+$/,
  '',
);
const CANDIDATES_ENABLED = process.env['EVAL_CANDIDATES'] === '1';
const DB_URL = process.env['DATABASE_URL'];
const MIN_LOADED_ROWS = 200;
const ROW_QUERY_LIMIT = Number(process.env['ROW_QUERY_LIMIT'] ?? '1000');
const ROW_LIMIT = Number(process.env['ROW_LIMIT'] ?? '50');
// Optional inclusive event-time window (epoch ms) targeting a specific corpus stretch — an
// all-hold champion window nulls propose-ratio and the forward-proxy comparison, reducing the
// flip verdict to hold-mimicry + cost (owner critique 2026-07-22). MIN_LOADED_ROWS applies to
// the windowed count.
const ROW_SINCE = Number(process.env['ROW_SINCE'] ?? '0');
const ROW_UNTIL = Number(process.env['ROW_UNTIL'] ?? String(Number.MAX_SAFE_INTEGER));
// Thinking-on study variant (Push II Phase 6): >0 enables extended thinking with this budget on
// every candidate call — see callAnthropicPlanLive's comment for the tool_choice consequence.
// -1 omits the thinking field entirely (endpoint default) — always-on-thinking compat endpoints
// may reject an explicit {type:'disabled'}.
const THINKING_BUDGET = Number(process.env['AGENTIC_EVAL_THINKING_BUDGET'] ?? '0');
// Inter-call sleep for low-RPM key tiers (e.g. a fresh Moonshot account at ~3 RPM): spacing calls
// out beats burning the bounded 429 retries. 0 (default) preserves the un-throttled behavior.
const CALL_DELAY_MS = Number(process.env['AGENTIC_EVAL_CALL_DELAY_MS'] ?? '0');
// Opt-in per-row JSONL (one line per replayed row × model): champion vs candidate action,
// validity, plan sanity, usage — the disagreement-quality audit trail the aggregate scorecard
// cannot reconstruct after the fact.
const ROW_LOG_FILE = process.env['AGENTIC_EVAL_ROW_LOG_FILE'];

// Same edge-multiple/R:R floors AGENTIC_MIN_EDGE_MULTIPLE/AGENTIC_MIN_RR default to
// (environment.config.ts) — quoted into the system prompt below AND used by isPlanSane's local
// re-implementation of the client's business-rule veto (see that function's own comment).
const MIN_EDGE_MULTIPLE = '1.5';
const MIN_RR = '1.5';

const CANDIDATE_MODELS: readonly string[] = (
  process.env['AGENTIC_EVAL_CANDIDATE_MODELS'] ?? 'claude-haiku-4-5-20251001'
)
  .split(',')
  .map((m) => m.trim())
  .filter((m) => m.length > 0);

// Mirrors recorded-rows.spec.ts's read-only DB gate — see that file for the full rationale.
function dbNameEndsWithTest(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/^\//, '').endsWith('_test');
  } catch {
    return false;
  }
}

const resetAllowed =
  process.env['DB_SUITE_ALLOW_RESET'] === '1' || (!!DB_URL && dbNameEndsWithTest(DB_URL));

const SKIP = !CANDIDATES_ENABLED || !EVAL_API_KEY || !DB_URL || !resetAllowed;

// Mirrors anthropic-agent-client.ts's planSchema exactly (decisionSchema + optional plan, required
// when action==='long') — not imported because it is module-private there. The PLAN_BOUNDS min/max
// on each plan field IS metric #1's (schema-valid) bounds check; isPlanSane below adds the separate
// edge/R:R business-rule floor the zod schema does not (and structurally cannot) encode.
const planLikeSchema = z
  .object({
    action: z.enum(['long', 'flat', 'hold']),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(2000),
    plan: z
      .object({
        entryOffsetBps: z
          .number()
          .int()
          .min(PLAN_BOUNDS.entryOffsetBps.min)
          .max(PLAN_BOUNDS.entryOffsetBps.max),
        stopLossPct: z.number().min(PLAN_BOUNDS.stopLossPct.min).max(PLAN_BOUNDS.stopLossPct.max),
        takeProfitPct: z
          .number()
          .min(PLAN_BOUNDS.takeProfitPct.min)
          .max(PLAN_BOUNDS.takeProfitPct.max),
        entryValidityBars: z
          .number()
          .int()
          .min(PLAN_BOUNDS.entryValidityBars.min)
          .max(PLAN_BOUNDS.entryValidityBars.max),
        maxHoldBars: z
          .number()
          .int()
          .min(PLAN_BOUNDS.maxHoldBars.min)
          .max(PLAN_BOUNDS.maxHoldBars.max),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === 'long' && v.plan === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "plan is required when action is 'long'",
      });
    }
  });

type PlanLikePlan = NonNullable<z.infer<typeof planLikeSchema>['plan']>;

// Re-implements anthropic-agent-client.ts's plan-rejection business rule (propose()'s edge-floor/
// stop-floor/R:R checks, not reproduced there as an exported helper) against EVAL_PROFILE's own
// fee tier and the MIN_EDGE_MULTIPLE/MIN_RR floors quoted into this eval's system prompt.
function isPlanSane(plan: PlanLikePlan): boolean {
  const feeFraction = new Decimal(EVAL_PROFILE.spotFees.makerBps)
    .plus(EVAL_PROFILE.spotFees.takerBps)
    .div(10_000);
  const edgeFloor = new Decimal(MIN_EDGE_MULTIPLE).mul(feeFraction);
  const minRr = new Decimal(MIN_RR);
  const stopLossPct = new Decimal(String(plan.stopLossPct));
  const takeProfitPct = new Decimal(String(plan.takeProfitPct));
  if (takeProfitPct.lt(edgeFloor)) return false;
  if (stopLossPct.lt(feeFraction)) return false;
  if (takeProfitPct.div(stopLossPct).lt(minRr)) return false;
  return true;
}

interface LiveCallUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

interface LiveCallResult {
  readonly valid: boolean; // tool_use block present and schema-parsed (PLAN_BOUNDS-satisfying if a plan was required)
  readonly action: 'long' | 'flat' | 'hold' | 'error';
  readonly confidence: number | null;
  // null when action !== 'long' (no plan expected); boolean once a plan was actually evaluated.
  readonly planSane: boolean | null;
  readonly usage: LiveCallUsage | null;
}

// Calls the real Anthropic Messages API directly in PLAN MODE, mirroring
// recorded-payload-live-compare.spec.ts's callAnthropicLive in miniature (same rationale for why
// this re-implements attemptOnce() rather than going through AnthropicAgentClient.propose(): a
// persisted input_payload row has no surviving AgentDecisionInput to hand it). Unlike that sibling,
// this also surfaces usage (needed for metric #6) and validates/scores the plan (metric #4). No
// retry/backoff: a single failed call degrades that one row to an 'error' action. The imported
// fetchWithRateLimitRetry (trade-eval-fixtures.ts) adds the 429/529 bounded retry on top: rate-limit
// noise on a low-RPM key tier would otherwise degrade rows to 'error' and poison schemaValidRate —
// the very metric the flip verdict hinges on. Every other failure still degrades the row as before.
async function callAnthropicPlanLive(
  systemPrompt: string,
  userMessage: string,
  model: string,
): Promise<LiveCallResult> {
  const res = await fetchWithRateLimitRetry(`${EVAL_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': EVAL_API_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      // The compat surface's wire auth header is not uniformly documented (Bearer vs x-api-key);
      // sending both on an overridden base is harmless and removes a whole failure branch.
      ...(EVAL_BASE_URL !== DEFAULT_BASE_URL ? { authorization: `Bearer ${EVAL_API_KEY!}` } : {}),
    },
    body: JSON.stringify({
      model,
      // AGENTIC_EVAL_THINKING_BUDGET > 0 runs the thinking-on study variant. Claude 5 models
      // reject budgeted `thinking.enabled` (400: use adaptive + output_config.effort), so the
      // variant sends ADAPTIVE thinking with an effort tier mapped from the budget knob — and
      // keeps the forced tool_choice (adaptive thinking is compatible with it; the reflection
      // path runs exactly that combination live), so the comparison has no auto-tool confound.
      // Thinking tokens bill as output and count toward max_tokens, hence the raised ceiling.
      // Sentinel -1 (thinking field omitted) leaves headroom for an always-on-thinking endpoint
      // to spend thinking from the same max_tokens budget before the tool call (~$0.14/call
      // ceiling at $15/Mtok output; actual usage is what the cost metric reports).
      max_tokens: THINKING_BUDGET > 0 ? 1024 + THINKING_BUDGET : THINKING_BUDGET < 0 ? 9216 : 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      tools: [PLAN_TOOL],
      tool_choice: { type: 'tool', name: PLAN_TOOL.name },
      ...(THINKING_BUDGET > 0
        ? {
            thinking: { type: 'adaptive' },
            output_config: {
              effort: THINKING_BUDGET <= 1024 ? 'low' : THINKING_BUDGET <= 4096 ? 'medium' : 'high',
            },
          }
        : THINKING_BUDGET < 0
          ? {} // -1: omit the field — see the THINKING_BUDGET const's comment
          : { thinking: { type: 'disabled' } }),
    }),
  });
  if (!res.ok)
    return { valid: false, action: 'error', confidence: null, planSane: null, usage: null };
  const body = (await res.json()) as {
    readonly content?: readonly {
      readonly type: string;
      readonly name?: string;
      readonly input?: unknown;
    }[];
    readonly usage?: { readonly input_tokens: number; readonly output_tokens: number };
  };
  const usage = body.usage
    ? { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens }
    : null;
  const toolBlock = body.content?.find((b) => b.type === 'tool_use' && b.name === PLAN_TOOL.name);
  const parsed = planLikeSchema.safeParse(toolBlock?.input);
  if (!parsed.success)
    return { valid: false, action: 'error', confidence: null, planSane: null, usage };
  const { action, confidence, plan } = parsed.data;
  const planSane = action === 'long' ? plan !== undefined && isPlanSane(plan) : null;
  return { valid: true, action, confidence, planSane, usage };
}

function promptIdentityFor(model: string): PromptIdentity {
  return {
    promptHash: computePromptHash({
      templateVersion: PLAN_TEMPLATE_VERSION,
      playbookContent: SEED_PLAYBOOK.content,
      toolSchemaJson: JSON.stringify(PLAN_TOOL),
      modelId: model,
    }),
    playbookVersion: SEED_PLAYBOOK.version,
    model,
  };
}

// null-safe: DecisionOutcomeDigest.entries.meanForwardReturnPct is already a PERCENT (0.1 → 10, see
// counterfactual-scoring.ts's own comment); this eval reports bps, so ×100.
// Per-symbol first (#37, same defect class 5da2630 fixed in scoreRows): the digest's positional
// t+1 forward returns AND its long/flat exposure walk both assume one instrument's row sequence —
// a mixed 5-symbol window reads a different symbol's close as row i's outcome and lets one
// symbol's open long misclassify the next symbol's rows. Digest each symbol's own subsequence,
// then combine the entry buckets count-weighted.
function forwardProxyBps(rows: readonly ScoringRow[]): number | null {
  const groups = new Map<string, ScoringRow[]>();
  for (const row of rows) {
    const group = groups.get(row.symbol);
    if (group) group.push(row);
    else groups.set(row.symbol, [row]);
  }
  let count = 0;
  let weightedPctSum = 0;
  for (const groupRows of groups.values()) {
    const entries = summarizeRecentDecisionOutcomes(groupRows).entries;
    if (entries.count === 0 || entries.meanForwardReturnPct === null) continue;
    count += entries.count;
    weightedPctSum += entries.meanForwardReturnPct * entries.count;
  }
  return count === 0 ? null : (weightedPctSum / count) * 100;
}

function assertNoNaN(label: string, value: number | null): void {
  if (value === null) return;
  expect(Number.isNaN(value), `${label} must not be NaN`).toBe(false);
}

interface FlipCriterion {
  readonly label: string;
  readonly pass: boolean | null; // null: insufficient data to evaluate, never counted as a pass
}

interface FlipVerdict {
  readonly pass: boolean;
  readonly criteria: readonly FlipCriterion[];
}

// Informational only (never asserted — a failing flip rule must not fail this spec, per task spec).
// Every clause with insufficient data (a null metric on either side) reads as pass: null and sinks
// the overall verdict to false, rather than being silently skipped or crashing on a null comparison.
function evaluateFlipVerdict(
  candidate: {
    readonly schemaValidRate: number;
    readonly holdAgreementRate: number | null;
    readonly proposeRateRatio: number | null;
    readonly planSanityRate: number | null;
    readonly forwardReturnProxyBps: number | null;
    readonly costPerDecideUsd: number | null;
  },
  champion: {
    readonly schemaValidRate: number;
    readonly planSanityRate: number;
    readonly forwardReturnProxyBps: number | null;
    readonly costPerDecideUsd: number | null;
  },
): FlipVerdict {
  const criteria: FlipCriterion[] = [
    {
      label: `schema-valid (${candidate.schemaValidRate.toFixed(3)}) >= champion (${champion.schemaValidRate.toFixed(3)})`,
      pass: candidate.schemaValidRate >= champion.schemaValidRate,
    },
    {
      label: `hold-agreement (${candidate.holdAgreementRate ?? 'n/a'}) >= 0.85`,
      pass: candidate.holdAgreementRate === null ? null : candidate.holdAgreementRate >= 0.85,
    },
    {
      label: `propose ratio (${candidate.proposeRateRatio ?? 'n/a'}) in [0.5, 1.5]`,
      pass:
        candidate.proposeRateRatio === null
          ? null
          : candidate.proposeRateRatio >= 0.5 && candidate.proposeRateRatio <= 1.5,
    },
    {
      label: `plan sanity (${candidate.planSanityRate ?? 'n/a'}) >= champion (${champion.planSanityRate.toFixed(3)})`,
      pass:
        candidate.planSanityRate === null
          ? null
          : candidate.planSanityRate >= champion.planSanityRate,
    },
    {
      label: `forward proxy (${candidate.forwardReturnProxyBps ?? 'n/a'} bps) >= champion - 2bps (${champion.forwardReturnProxyBps ?? 'n/a'})`,
      pass:
        candidate.forwardReturnProxyBps === null || champion.forwardReturnProxyBps === null
          ? null
          : candidate.forwardReturnProxyBps >= champion.forwardReturnProxyBps - 2,
    },
    {
      // Parity, not ≤50% (owner grant 2026-07-22, changed pre-registered BEFORE run 2): the
      // half-price bar was designed for cheap-model swaps (haiku-class) and is structurally
      // unpassable for a same-price-tier challenger — it reduced the whole verdict to a cost
      // test. A same-tier flip is justified by decision quality at non-regressive cost.
      label: `cost/decide ($${candidate.costPerDecideUsd ?? 'n/a'}) <= champion ($${champion.costPerDecideUsd ?? 'n/a'})`,
      pass:
        candidate.costPerDecideUsd === null || champion.costPerDecideUsd === null
          ? null
          : candidate.costPerDecideUsd <= champion.costPerDecideUsd,
    },
  ];
  return { pass: criteria.every((c) => c.pass === true), criteria };
}

describe.skipIf(SKIP)(
  'agentic eval — candidate model swap (optional, requires EVAL_CANDIDATES=1 + an API key + DATABASE_URL + db-test gate)',
  () => {
    it(
      'replays >= 200 recorded rows through each candidate model in plan mode and prints a scorecard',
      async () => {
        const pool = new Pool({ connectionString: DB_URL! });
        try {
          const db = drizzle(pool, { schema });
          const journal = new AgentDecisionJournalAdapter(db);
          // The v2-era replay corpus journals the LEGACY action vocabulary ('long'/'flat') while
          // AgentDecisionRow's v3 type — and every champion-side counter below — speaks
          // 'open_long'/'close' (the port's comment assumes a greenfield v3 DB). Normalize at
          // load, or a propose-dense window under-counts every champion long: propose count, the
          // agreement split, and the forward-proxy entries bucket all key on 'open_long'.
          const normalizeJournalAction = (a: string): AgentDecisionRow['action'] =>
            (a === 'long' ? 'open_long' : a === 'flat' ? 'close' : a) as AgentDecisionRow['action'];
          const loadedRows: AgentDecisionRow[] = (await journal.recent(ROW_QUERY_LIMIT))
            .filter((r) => r.inputPayload !== null)
            .filter((r) => r.eventTime >= ROW_SINCE && r.eventTime <= ROW_UNTIL)
            .map((r) => ({ ...r, action: normalizeJournalAction(r.action) }));
          expect(
            loadedRows.length,
            `candidate-model-eval requires >= ${MIN_LOADED_ROWS} agent_decisions rows with ` +
              `input_payload IS NOT NULL (found ${loadedRows.length}); raise ROW_QUERY_LIMIT or let ` +
              'more decisions accumulate before running this eval',
          ).toBeGreaterThanOrEqual(MIN_LOADED_ROWS);

          // The replayed subset is capped by ROW_LIMIT to bound spend (each row costs one real API
          // call PER candidate model); the >=200 assert above is on rows LOADED, not replayed.
          const replayRows: AgentDecisionRow[] = loadedRows.slice(-ROW_LIMIT);
          const tokenPriceOverrides = parseTokenPriceOverrides(
            process.env['AGENTIC_TOKEN_PRICES_JSON'],
          );

          // Champion never calls the network — its scorecard comes straight from what the rows
          // already recorded.
          const championScoringRows: ScoringRow[] = replayRows;
          const championSchemaValidRate =
            replayRows.filter((r) => r.action !== 'error').length / replayRows.length;
          const championProposeCount = replayRows.filter((r) => r.action === 'open_long').length;
          const championForwardReturnProxyBps = forwardProxyBps(championScoringRows);
          const championCostPerDecideUsd = meanCostUsd(
            replayRows.map((r) => ({
              usage:
                r.inputTokens !== null && r.outputTokens !== null
                  ? { inputTokens: r.inputTokens, outputTokens: r.outputTokens }
                  : null,
              model: r.model,
            })),
            tokenPriceOverrides,
          );
          // No plan data is persisted on agent_decisions rows at all (AgentDecisionEntry has no plan
          // field) — champion's plan-sanity is vacuously perfect (never proposes an unsound plan
          // because it never proposes a plan), so "plan sanity >= champion" reduces to "candidate
          // reaches 1.0", the most a plan-emitting model can score.
          const championPlanSanityRate = 1;

          assertNoNaN('champion schemaValidRate', championSchemaValidRate);
          assertNoNaN('champion forwardReturnProxyBps', championForwardReturnProxyBps);
          assertNoNaN('champion costPerDecideUsd', championCostPerDecideUsd);

          const systemPrompt = buildLegacyPlanSystemPrompt(EVAL_PROFILE, MIN_EDGE_MULTIPLE, MIN_RR);

          const candidateScorecards: unknown[] = [];
          for (const model of CANDIDATE_MODELS) {
            const identity = promptIdentityFor(model);
            const candidateScoringRows: ScoringRow[] = [];
            const candidateUsageRows: { usage: LiveCallUsage | null; model: string }[] = [];
            let schemaValidCount = 0;
            let overallAgree = 0;
            let comparableCount = 0;
            let holdAgree = 0;
            let holdTotal = 0;
            let proposeAgree = 0;
            let proposeTotal = 0;
            let candidateProposeCount = 0;
            let planSaneCount = 0;
            let planLongCount = 0;

            for (const row of replayRows) {
              const userMessage = composeRecordedUserMessage(
                row.inputPayload!,
                SEED_PLAYBOOK.content,
              );
              const result = await callAnthropicPlanLive(systemPrompt, userMessage, model);
              if (CALL_DELAY_MS > 0) {
                await new Promise((resolve) => setTimeout(resolve, CALL_DELAY_MS));
              }

              if (result.valid) schemaValidCount++;
              candidateUsageRows.push({ usage: result.usage, model });
              const outcome: RecordedDecisionOutcome = {
                action: result.action,
                confidence: result.confidence,
              };
              const scoringRow = scoringRowFromPayload(row.inputPayload!, outcome, identity);
              if (scoringRow !== null) candidateScoringRows.push(scoringRow);

              if (result.action === 'long') {
                candidateProposeCount++;
                planLongCount++;
                if (result.planSane) planSaneCount++;
              }

              // Agreement/propose-ratio are scored only against rows with a real recorded ground
              // truth — a recorded 'error' row has no action to agree or disagree with. Journal rows
              // are v3-normalized while replay results still speak the legacy contract — map the
              // result through the same boundary normalizer before comparing.
              const resultAction = toScoringAction(result.action);
              if (row.action !== 'error') {
                comparableCount++;
                if (resultAction === row.action) overallAgree++;
                if (row.action === 'open_long') {
                  proposeTotal++;
                  if (resultAction === row.action) proposeAgree++;
                } else {
                  holdTotal++;
                  if (resultAction === row.action) holdAgree++;
                }
              }

              if (ROW_LOG_FILE) {
                appendFileSync(
                  ROW_LOG_FILE,
                  JSON.stringify({
                    model,
                    rowId: row.id,
                    symbol: row.symbol,
                    eventTime: row.eventTime,
                    championAction: row.action,
                    candidateAction: result.action,
                    valid: result.valid,
                    planSane: result.planSane,
                    usage: result.usage,
                  }) + '\n',
                );
              }
            }

            const schemaValidRate = schemaValidCount / replayRows.length;
            const actionAgreementOverall =
              comparableCount > 0 ? overallAgree / comparableCount : null;
            const holdAgreementRate = holdTotal > 0 ? holdAgree / holdTotal : null;
            const proposeAgreementRate = proposeTotal > 0 ? proposeAgree / proposeTotal : null;
            const proposeRateRatio =
              championProposeCount > 0 ? candidateProposeCount / championProposeCount : null;
            const planSanityRate = planLongCount > 0 ? planSaneCount / planLongCount : null;
            const forwardReturnProxyBps = forwardProxyBps(candidateScoringRows);
            const costPerDecideUsd = meanCostUsd(candidateUsageRows, tokenPriceOverrides);

            assertNoNaN(`${model} schemaValidRate`, schemaValidRate);
            assertNoNaN(`${model} actionAgreementOverall`, actionAgreementOverall);
            assertNoNaN(`${model} holdAgreementRate`, holdAgreementRate);
            assertNoNaN(`${model} proposeAgreementRate`, proposeAgreementRate);
            assertNoNaN(`${model} proposeRateRatio`, proposeRateRatio);
            assertNoNaN(`${model} planSanityRate`, planSanityRate);
            assertNoNaN(`${model} forwardReturnProxyBps`, forwardReturnProxyBps);
            assertNoNaN(`${model} costPerDecideUsd`, costPerDecideUsd);

            const flipVerdict = evaluateFlipVerdict(
              {
                schemaValidRate,
                holdAgreementRate,
                proposeRateRatio,
                planSanityRate,
                forwardReturnProxyBps,
                costPerDecideUsd,
              },
              {
                schemaValidRate: championSchemaValidRate,
                planSanityRate: championPlanSanityRate,
                forwardReturnProxyBps: championForwardReturnProxyBps,
                costPerDecideUsd: championCostPerDecideUsd,
              },
            );

            // Informational only — see evaluateFlipVerdict's own comment. Never asserted.
            console.log(
              `FLIP VERDICT [${model}]: ${flipVerdict.pass ? 'PROMOTE' : 'HOLD'} — ` +
                flipVerdict.criteria
                  .map((c) => `${c.pass === null ? '?' : c.pass ? 'OK' : 'X'} ${c.label}`)
                  .join('; '),
            );

            candidateScorecards.push({
              model,
              rowsReplayed: replayRows.length,
              schemaValidRate,
              actionAgreement: {
                overall: actionAgreementOverall,
                holdAgreement: holdAgreementRate,
                proposeAgreement: proposeAgreementRate,
              },
              proposeRateRatio,
              planSanityRate,
              forwardReturnProxyBps,
              costPerDecideUsd,
              flipVerdict,
            });
          }

          expect(candidateScorecards).toHaveLength(CANDIDATE_MODELS.length);

          // The scorecard IS this script's deliverable — paste into an experiments-registry row.
          // Console alone is NOT durable (vitest can intercept/suppress it — 2026-07-10 incident);
          // AGENTIC_EVAL_SCORECARD_FILE additionally persists it verbatim.
          const scorecard = JSON.stringify(
            {
              rowsLoaded: loadedRows.length,
              rowsReplayed: replayRows.length,
              champion: {
                schemaValidRate: championSchemaValidRate,
                proposeCount: championProposeCount,
                planSanityRate: championPlanSanityRate,
                forwardReturnProxyBps: championForwardReturnProxyBps,
                costPerDecideUsd: championCostPerDecideUsd,
              },
              candidates: candidateScorecards,
            },
            null,
            2,
          );
          console.log(scorecard);
          const scorecardFile = process.env['AGENTIC_EVAL_SCORECARD_FILE'];
          if (scorecardFile) {
            writeFileSync(scorecardFile, scorecard);
          }
        } finally {
          await pool.end();
        }
      },
      Number(process.env['AGENTIC_EVAL_TIMEOUT_MS'] ?? '600000'),
    );
  },
);
