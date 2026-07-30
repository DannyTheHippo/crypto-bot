// Live eval: v3 rich-contract HEAD-TO-HEAD model swap. Replays >= 200 REAL recorded
// agent_decisions.input_payload rows through the CURRENT production submit_trade contract
// (buildSystemPrompt/buildTradeTool from agent-prompt.ts, TRADE_TEMPLATE_VERSION 'v3') against N
// candidate models, and prints a per-model scorecard consumed by scripts/log-eval-experiment.mjs.
// Distinct from candidate-model-eval.spec.ts (that file replays the LEGACY plan-mode contract,
// PLAN_TOOL/submit_plan, §9-deleted from production) — this file replays the contract production
// actually serves today. Shorts are made reachable even on v2-era recorded payloads (which predate
// the `capabilities` block) via withSyntheticCapabilities — see trade-eval-fixtures.ts's own comment
// for why an unpatched v2 payload can never reach 'open_short' in replay.
//
// Champion never makes a network call: its reference numbers are derived entirely from the rows'
// own persisted action/confidence/usage. Only the candidate models are actually replayed. ONE system
// prompt and ONE tool schema are built per model call (not once globally) but are byte-identical
// across models within a run — that identity is the head-to-head invariant hh-v1's verdict criteria
// depend on (see trade-eval-fixtures.ts's evaluateHeadToHeadVerdict).
//
// Quadruple-gated (module scope never throws — a malformed env var degrades to a skip, never a
// collection-time crash):
//   - EVAL_TRADE_MODELS=1 — this suite's own opt-in.
//   - AGENTIC_EVAL_CANDIDATE_MODELS — comma-separated model ids, NO default: the paid run must name
//     its models explicitly.
//   - every listed model resolves a truthy apiKey via resolveModelRoute (ANTHROPIC_API_KEY /
//     AGENTIC_EVAL_API_KEY, or a per-model AGENTIC_EVAL_MODEL_ROUTES_JSON apiKeyEnv).
//   - a reachable corpus: AGENTIC_EVAL_CORPUS_FILE set, OR DATABASE_URL set AND the same read-only
//     DB_SUITE_ALLOW_RESET/_test-suffix gate recorded-rows.spec.ts uses.
//
// Env knobs:
//   EVAL_TRADE_MODELS=1                       (required — this suite's opt-in)
//   AGENTIC_EVAL_CANDIDATE_MODELS=model-a,...  (required — comma-separated model ids)
//   AGENTIC_EVAL_CORPUS_FILE=rows.jsonl         (or DATABASE_URL=postgres://..._test / +
//                                                DB_SUITE_ALLOW_RESET=1)
//   ROW_QUERY_LIMIT=1000                       (optional — Postgres branch only, rows fetched before
//                                                the ROW_SINCE/ROW_UNTIL window filter)
//   ROW_SINCE=... ROW_UNTIL=...                (optional — inclusive epoch-ms event_time window)
//   ROW_LIMIT=200                              (optional — rows actually REPLAYED per candidate
//                                                model; each replayed row costs one real API call
//                                                per model)
//   ANTHROPIC_API_KEY=sk-ant-...               (default route key)
//   AGENTIC_EVAL_API_KEY=...                    (optional — default-route key override)
//   AGENTIC_EVAL_MODEL_ROUTES_JSON='{"model":{"baseUrl":...,"apiKeyEnv":...,"callDelayMs":...}}'
//                                               (optional — per-model route overrides)
//   AGENTIC_EVAL_BASE_URL=... AGENTIC_EVAL_CALL_DELAY_MS=...
//                                               (optional — global fallback route knobs for models
//                                                with no entry in AGENTIC_EVAL_MODEL_ROUTES_JSON)
//   AGENTIC_EVAL_THINKING_BUDGET=0              (optional — 0 disabled/default, -1 omit the field,
//                                                >0 adaptive thinking with a budget-derived max_tokens)
//   AGENTIC_EVAL_MAX_TOKENS=4096                (optional — overrides the budget-derived max_tokens;
//                                                set 4096 for production parity: the 1024 legacy
//                                                default truncates v3 forced-tool proposes)
//   AGENTIC_TOKEN_PRICES_JSON='{"model":{"inputPerMtok":"1","outputPerMtok":"5"}}'
//                                               (optional — same shape as the production knob)
//   AGENTIC_EVAL_ROW_LOG_FILE=rows.jsonl         (optional — per-row JSONL audit trail)
//   AGENTIC_EVAL_SCORECARD_FILE=scorecard.json   (optional — persists the scorecard verbatim)
//   AGENTIC_EVAL_BASELINE_SCORECARD_FILE=baseline.json
//                                               (optional — a prior run's scorecard; every candidate
//                                                in THIS run is also verdicted against its
//                                                candidates[0])
//   AGENTIC_EVAL_TIMEOUT_MS=600000              (optional — it() timeout override)
//   DB_SUITE_ALLOW_RESET=1                      (optional — DB gate override, same as other suites)
//
// Recipe 1 — sonnet leg (solo baseline run against the dumped corpus file; dump via
// scripts/dump-eval-corpus.mjs — see .gitignore's test/eval/agentic/data entry):
//   AGENTIC_EVAL_CORPUS_FILE=test/eval/agentic/data/corpus-v2-clone.jsonl
//   ROW_SINCE=1783714500000 ROW_UNTIL=1783876500000 ROW_LIMIT=200
//   ANTHROPIC_API_KEY=sk-ant-...
//   EVAL_TRADE_MODELS=1
//   AGENTIC_EVAL_CANDIDATE_MODELS=claude-sonnet-5
//   AGENTIC_EVAL_MAX_TOKENS=4096
//   AGENTIC_EVAL_SCORECARD_FILE=research/scorecards/trade-model-eval-sonnet5-<date>.json
//   AGENTIC_EVAL_ROW_LOG_FILE=research/candidates/trade-model-eval-rows-sonnet5-<date>.jsonl
//   AGENTIC_EVAL_TIMEOUT_MS=1800000
//   pnpm eval:trade-models
//
// Recipe 2 — kimi leg (routed through the Moonshot Anthropic-compat surface, verdicted against the
// sonnet leg's scorecard from recipe 1 — same corpus file + window, or the fingerprint gate refuses):
//   AGENTIC_EVAL_CORPUS_FILE=test/eval/agentic/data/corpus-v2-clone.jsonl
//   ROW_SINCE=1783714500000 ROW_UNTIL=1783876500000 ROW_LIMIT=200
//   EVAL_TRADE_MODELS=1
//   AGENTIC_EVAL_CANDIDATE_MODELS=kimi-k3
//   AGENTIC_EVAL_MODEL_ROUTES_JSON='{"kimi-k3":{"baseUrl":"https://api.moonshot.ai/anthropic","apiKeyEnv":"MOONSHOT_API_KEY","callDelayMs":5000}}'
//   MOONSHOT_API_KEY=sk-...
//   AGENTIC_TOKEN_PRICES_JSON='{"kimi-k3":{"inputPerMtok":"3","outputPerMtok":"15"}}'
//   AGENTIC_EVAL_MAX_TOKENS=4096
//   AGENTIC_EVAL_BASELINE_SCORECARD_FILE=research/scorecards/trade-model-eval-sonnet5-<date>.json
//   AGENTIC_EVAL_SCORECARD_FILE=research/scorecards/trade-model-eval-kimi-k3-<date>.json
//   AGENTIC_EVAL_ROW_LOG_FILE=research/candidates/trade-model-eval-rows-kimi-k3-<date>.jsonl
//   AGENTIC_EVAL_TIMEOUT_MS=7200000
//   pnpm eval:trade-models
//
// AGENTIC_EVAL_TIMEOUT_MS sizing rule: >= ROW_LIMIT * (callDelayMs + p95 call latency), plus retry
// headroom — the kimi leg's 5s/row callDelayMs alone totals 1000s over 200 rows, well past the 600s
// default.
import { describe, it, expect } from 'vitest';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import {
  SYNTHETIC_PERP_CAPS,
  withSyntheticCapabilities,
  resolveModelRoute,
  isTradeSane,
  type TradeToolDecision,
  directionalForwardProxyBps,
  corpusFingerprint,
  contractFingerprint,
  evaluateHeadToHeadVerdict,
  type TradeModelCandidateResult,
  type HeadToHeadVerdict,
  loadCorpusRows,
  type CorpusRow,
  fetchWithRateLimitRetry,
  parseTokenPriceOverrides,
  resolveRate,
  meanCostUsd,
} from './trade-eval-fixtures';
import {
  buildSystemPrompt,
  buildTradeTool,
  TRADE_TEMPLATE_VERSION,
  computePromptHash,
} from '../../../src/features/strategy/agentic/agent-prompt';
import { tradeDecisionSchema } from '../../../src/features/strategy/agentic/anthropic-agent-client';
import { EVAL_PROFILE } from './fixtures';
import { SEED_PLAYBOOK } from '../../../src/features/strategy/agentic/agentic-strategy.module';
import {
  composeRecordedUserMessage,
  scoringRowFromPayload,
  type PromptIdentity,
  type RecordedDecisionOutcome,
} from './recorded-payload-fixtures';
import type { ScoringRow } from '../../../src/features/strategy/agentic/counterfactual-scoring';

// Mirrors recorded-rows.spec.ts's read-only DB gate — same self-contained-per-spec copy convention
// as trade-eval-fixtures.ts's own (unexported) loadFromPostgres gate and candidate-model-eval.spec.ts.
function dbNameEndsWithTest(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/^\//, '').endsWith('_test');
  } catch {
    return false;
  }
}

const EVAL_TRADE_MODELS_ENABLED = process.env['EVAL_TRADE_MODELS'] === '1';

// NO default — the paid run must name its models explicitly (unlike candidate-model-eval.spec.ts's
// single-model default, this harness's whole point is a head-to-head, so silently running one model
// would be a silent scope change).
const CANDIDATE_MODELS: readonly string[] = (process.env['AGENTIC_EVAL_CANDIDATE_MODELS'] ?? '')
  .split(',')
  .map((m) => m.trim())
  .filter((m) => m.length > 0);

const CORPUS_FILE = process.env['AGENTIC_EVAL_CORPUS_FILE'];
const DB_URL = process.env['DATABASE_URL'];
const resetAllowed =
  process.env['DB_SUITE_ALLOW_RESET'] === '1' || (!!DB_URL && dbNameEndsWithTest(DB_URL));
const corpusReachable = !!CORPUS_FILE || (!!DB_URL && resetAllowed);

// resolveModelRoute throws on a malformed AGENTIC_EVAL_MODEL_ROUTES_JSON — module scope must never
// throw, so an unrelated malformed env var degrades this gate to a skip rather than aborting
// collection for every suite in the file.
let allModelKeysPresent = false;
try {
  allModelKeysPresent =
    CANDIDATE_MODELS.length > 0 && CANDIDATE_MODELS.every((m) => !!resolveModelRoute(m).apiKey);
} catch {
  allModelKeysPresent = false;
}

const SKIP = !EVAL_TRADE_MODELS_ENABLED || !allModelKeysPresent || !corpusReachable;

const MIN_LOADED_ROWS = 200;
const ROW_LIMIT = Number(process.env['ROW_LIMIT'] ?? '200');
// Same defaults loadCorpusRows itself applies internally — read independently here (rather than
// returned by loadCorpusRows) purely to report the APPLIED window verbatim in the scorecard.
const ROW_SINCE = Number(process.env['ROW_SINCE'] ?? '0');
const ROW_UNTIL = Number(process.env['ROW_UNTIL'] ?? String(Number.MAX_SAFE_INTEGER));
const ROW_LOG_FILE = process.env['AGENTIC_EVAL_ROW_LOG_FILE'];

// Same THINKING_BUDGET sentinel semantics as candidate-model-eval.spec.ts's own const (see that
// file's comment): 0 (default) disabled, >0 adaptive with a budget-derived max_tokens ceiling, -1
// omits the field entirely (endpoint default) for an always-on-thinking compat endpoint.
const THINKING_BUDGET = Number(process.env['AGENTIC_EVAL_THINKING_BUDGET'] ?? '0');
// AGENTIC_EVAL_MAX_TOKENS overrides the budget-derived ceiling. The legacy 1024 default proved too
// tight for the v3 contract: the 2026-07-22 sonnet leg at 1024 emitted 32% schema-invalid proposes
// (open_long missing sizeFraction/entryValidityBars — the forced-tool response ran out of budget),
// while production ships AGENTIC_MAX_TOKENS=4096. Production-parity legs set 4096 explicitly.
const MAX_TOKENS_DERIVED =
  THINKING_BUDGET > 0 ? 1024 + THINKING_BUDGET : THINKING_BUDGET < 0 ? 9216 : 1024;
const MAX_TOKENS = Number(process.env['AGENTIC_EVAL_MAX_TOKENS'] ?? String(MAX_TOKENS_DERIVED));
const THINKING_BODY: Record<string, unknown> =
  THINKING_BUDGET > 0
    ? {
        thinking: { type: 'adaptive' },
        output_config: {
          effort: THINKING_BUDGET <= 1024 ? 'low' : THINKING_BUDGET <= 4096 ? 'medium' : 'high',
        },
      }
    : THINKING_BUDGET < 0
      ? {} // -1: omit the field — see candidate-model-eval.spec.ts's THINKING_BUDGET comment
      : { thinking: { type: 'disabled' } };
const THINKING_LABEL: 'disabled' | 'omitted' | 'adaptive' =
  THINKING_BUDGET > 0 ? 'adaptive' : THINKING_BUDGET < 0 ? 'omitted' : 'disabled';

interface TradeLiveCallUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

interface TradeLiveCallResult {
  readonly valid: boolean; // tool_use block present and submit_trade-schema-parsed
  readonly action: TradeToolDecision['action'] | 'error';
  // null when action !== 'open_long'/'open_short' (isTradeSane's own null convention).
  readonly tradeSane: boolean | null;
  readonly usage: TradeLiveCallUsage | null;
  // Diagnostic for an 'error' action — null on every non-error result. Truncated (~200 chars): this
  // exists for a human reading the row log/scorecard, not as a machine-parsed value.
  readonly errorDetail: string | null;
}

const ERROR_DETAIL_MAX_LEN = 200;
function truncateErrorDetail(text: string): string {
  return text.length > ERROR_DETAIL_MAX_LEN ? `${text.slice(0, ERROR_DETAIL_MAX_LEN)}…` : text;
}

// Same convention as candidate-model-eval.spec.ts's own assertNoNaN: null is a legitimate
// insufficient-data value throughout this harness, NaN never is.
function assertNoNaN(label: string, value: number | null): void {
  if (value === null) return;
  expect(Number.isNaN(value), `${label} must not be NaN`).toBe(false);
}

const RECORDED_DECISION_ACTIONS: ReadonlySet<RecordedDecisionOutcome['action']> = new Set([
  'long',
  'flat',
  'hold',
  'error',
  'open_long',
  'open_short',
  'close',
  'adjust',
]);
// Narrows a corpus row's untyped action string into RecordedDecisionOutcome['action'] — an
// out-of-vocabulary value (corrupt row, future vocab drift) degrades to 'error' rather than an
// unchecked cast smuggling an invalid literal past the type system.
function toRecordedDecisionAction(action: string): RecordedDecisionOutcome['action'] {
  return (RECORDED_DECISION_ACTIONS as ReadonlySet<string>).has(action)
    ? (action as RecordedDecisionOutcome['action'])
    : 'error';
}

// One HTTP call against the CURRENT production submit_trade contract, mirroring
// attemptOnce()'s request body (anthropic-agent-client.ts, ~1637-1654) minus the cache_control
// wrapper on `system` (a single-shot eval call gets no benefit from a cache breakpoint the way a
// long-lived production client's repeated calls do).
//
// The whole body is wrapped in try/catch: one failed call (ECONNRESET, a non-JSON body, etc.)
// degrades ONLY this row to 'error' — mirroring the production client's per-call error
// classification — rather than aborting the loop and destroying every prior paid row's aggregate
// (a 20+ minute paid loop must never lose its aggregate to one transport hiccup).
async function callTradeLive(
  systemPrompt: string,
  tool: ReturnType<typeof buildTradeTool>,
  userMessage: string,
  model: string,
  route: ReturnType<typeof resolveModelRoute>,
): Promise<TradeLiveCallResult> {
  try {
    const res = await fetchWithRateLimitRetry(`${route.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': route.apiKey!,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        ...(!route.isDefaultBase ? { authorization: `Bearer ${route.apiKey!}` } : {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        ...THINKING_BODY,
      }),
    });
    if (!res.ok) {
      // Body read is itself defensive — an undiagnosable bare "http 400" (2026-07-19 incident)
      // forces a double-spend rerun to find out what actually went wrong.
      let bodyText = '<unreadable body>';
      try {
        bodyText = await res.text();
      } catch {
        // keep the placeholder — the status code alone still beats nothing.
      }
      return {
        valid: false,
        action: 'error',
        tradeSane: null,
        usage: null,
        errorDetail: truncateErrorDetail(`http ${res.status}: ${bodyText}`),
      };
    }
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
    const toolBlock = body.content?.find((b) => b.type === 'tool_use' && b.name === tool.name);
    // A missing tool_use block (toolBlock undefined) parses `undefined` against the schema and fails
    // the same way a structurally-invalid input does — one error path, not two.
    const parsed = tradeDecisionSchema(Number(SYNTHETIC_PERP_CAPS.maxSizeFraction)).safeParse(
      toolBlock?.input,
    );
    if (!parsed.success) {
      return {
        valid: false,
        action: 'error',
        tradeSane: null,
        usage,
        errorDetail: truncateErrorDetail(
          `schema-invalid tool response: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        ),
      };
    }
    const tradeSane = isTradeSane(parsed.data, EVAL_PROFILE);
    return { valid: true, action: parsed.data.action, tradeSane, usage, errorDetail: null };
  } catch (err) {
    return {
      valid: false,
      action: 'error',
      tradeSane: null,
      usage: null,
      errorDetail: truncateErrorDetail(err instanceof Error ? err.message : String(err)),
    };
  }
}

interface TradeModelCandidateEntry extends TradeModelCandidateResult {
  readonly actionHistogram: Record<string, number>;
  // Overall fraction candidateAction === championAction — informational only, never part of hh-v1's
  // pass/fail criteria (the champion's recorded action came from a DIFFERENT contract/prompt, so raw
  // agreement is not a quality signal, merely a curiosity for the report).
  readonly agreementWithChampion: number;
  // Schema-invalid (including missing tool_use) responses, counted separately from the
  // schemaValidRate denominator for report detail.
  readonly invalidCount: number;
  // First errored row's diagnostic detail, null when no row errored — surfaces WHY without scanning
  // the full row log (2026-07-19 bare-"http 400" incident).
  readonly firstErrorDetail: string | null;
  // scoringRowFromPayload returning null (unparseable payload) silently shrinks the forward-proxy
  // sample; counted rather than left invisible.
  readonly droppedScoringRows: number;
  // Audit fields — computed but not consumed by hh-v1 criteria.
  readonly promptHash: string;
}

describe.skipIf(SKIP)(
  'agentic eval — v3 rich-contract head-to-head model swap (optional, requires EVAL_TRADE_MODELS=1 + AGENTIC_EVAL_CANDIDATE_MODELS + a resolvable API key per model + a reachable corpus)',
  () => {
    it(
      'replays >= 200 recorded rows through the CURRENT submit_trade contract for each candidate model and prints a head-to-head scorecard',
      async () => {
        // Number('2OO') is NaN and rows.slice(-NaN) replays the ENTIRE corpus, not the intended
        // window — a typo'd ROW_LIMIT must fail the run, never silently balloon into unbounded paid
        // spend across every candidate model.
        if (!Number.isInteger(ROW_LIMIT) || ROW_LIMIT <= 0) {
          throw new Error(
            `ROW_LIMIT must be a finite positive integer, got "${process.env['ROW_LIMIT'] ?? '200'}" ` +
              `(parsed ${ROW_LIMIT})`,
          );
        }

        const { rows, sourceDescription } = await loadCorpusRows();
        expect(
          rows.length,
          `trade-model-eval requires >= ${MIN_LOADED_ROWS} corpus rows with a usable input_payload ` +
            `(found ${rows.length} from ${sourceDescription}); raise ROW_QUERY_LIMIT or widen ` +
            'ROW_SINCE/ROW_UNTIL before running this eval',
        ).toBeGreaterThanOrEqual(MIN_LOADED_ROWS);

        // The replayed subset is capped by ROW_LIMIT to bound spend (each row costs one real API
        // call PER candidate model); the >=200 assert above is on rows LOADED, not replayed.
        const replayRows: CorpusRow[] = rows.slice(-ROW_LIMIT);
        const fingerprint = corpusFingerprint(replayRows);
        const tokenPriceOverrides = parseTokenPriceOverrides(
          process.env['AGENTIC_TOKEN_PRICES_JSON'],
        );

        // ── Champion reference (informational, from persisted rows — no network) ──────────────────
        const championActionHistogram: Record<string, number> = {};
        for (const row of replayRows) {
          championActionHistogram[row.action] = (championActionHistogram[row.action] ?? 0) + 1;
        }
        const championProposeCount = replayRows.filter(
          (r) => r.action === 'open_long' || r.action === 'open_short',
        ).length;
        const championScoringRows: ScoringRow[] = [];
        let championDroppedScoringRows = 0;
        for (const row of replayRows) {
          const identity: PromptIdentity = {
            promptHash: row.promptHash ?? 'unknown',
            playbookVersion: row.playbookVersion,
            model: row.model ?? 'unknown',
          };
          const scoringRow = scoringRowFromPayload(
            row.inputPayload,
            { action: toRecordedDecisionAction(row.action), confidence: row.confidence },
            identity,
          );
          if (scoringRow !== null) championScoringRows.push(scoringRow);
          else championDroppedScoringRows++;
        }
        const championForwardReturnProxyBps = directionalForwardProxyBps(championScoringRows);
        const championCostPerDecideUsd = meanCostUsd(
          replayRows.map((r) => ({
            usage:
              r.inputTokens !== null && r.outputTokens !== null
                ? { inputTokens: r.inputTokens, outputTokens: r.outputTokens }
                : null,
            model: r.model ?? 'unknown',
          })),
          tokenPriceOverrides,
        );
        const championReference = {
          actionHistogram: championActionHistogram,
          proposeCount: championProposeCount,
          forwardReturnProxyBps: championForwardReturnProxyBps,
          costPerDecideUsd: championCostPerDecideUsd,
          droppedScoringRows: championDroppedScoringRows,
        };
        assertNoNaN('champion forwardReturnProxyBps', championReference.forwardReturnProxyBps);
        assertNoNaN('champion costPerDecideUsd', championReference.costPerDecideUsd);

        // Once per run (not per model) — identical inputs across every candidate model in this run
        // (same tool/capabilities, same playbook, same thinking/max-tokens knobs), so one computation
        // detects a contract drift between legs. NOT computePromptHash — see contractFingerprint's
        // own comment for why that would differ between legs by construction.
        const runContractFingerprint = contractFingerprint({
          templateVersion: TRADE_TEMPLATE_VERSION,
          playbookContent: SEED_PLAYBOOK.content,
          toolSchemaJson: JSON.stringify(buildTradeTool()),
          thinking: THINKING_LABEL,
          maxTokens: MAX_TOKENS,
        });

        // ── Per-model replay ───────────────────────────────────────────────────────────────────────
        const tokenPrices: Record<string, { inputPerMtok: number; outputPerMtok: number }> = {};
        const candidates: TradeModelCandidateEntry[] = [];
        for (const model of CANDIDATE_MODELS) {
          const route = resolveModelRoute(model);
          const rate = resolveRate(model, tokenPriceOverrides);
          tokenPrices[model] = { inputPerMtok: rate.input, outputPerMtok: rate.output };

          // ONE system prompt and ONE tool built per model (not per row) — identical for every model
          // in this run, the head-to-head invariant hh-v1 depends on.
          const tool = buildTradeTool();
          const systemPrompt = buildSystemPrompt(EVAL_PROFILE);
          const promptHash = computePromptHash({
            templateVersion: TRADE_TEMPLATE_VERSION,
            playbookContent: SEED_PLAYBOOK.content,
            toolSchemaJson: JSON.stringify(tool),
            modelId: model,
          });

          const actionHistogram: Record<string, number> = {};
          const candidateScoringRows: ScoringRow[] = [];
          const usageRows: { usage: TradeLiveCallUsage | null; model: string }[] = [];
          let schemaValidCount = 0;
          let invalidCount = 0;
          let saneCount = 0;
          let openValidCount = 0;
          let proposeCount = 0;
          let agreementCount = 0;
          let droppedScoringRows = 0;
          let firstErrorDetail: string | null = null;

          for (const row of replayRows) {
            const patched = withSyntheticCapabilities(row.inputPayload, SYNTHETIC_PERP_CAPS);
            const userMessage = composeRecordedUserMessage(patched, SEED_PLAYBOOK.content);
            const result = await callTradeLive(systemPrompt, tool, userMessage, model, route);
            if (route.callDelayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, route.callDelayMs));
            }

            if (result.valid) schemaValidCount++;
            else invalidCount++;
            usageRows.push({ usage: result.usage, model });
            actionHistogram[result.action] = (actionHistogram[result.action] ?? 0) + 1;
            if (result.action === row.action) agreementCount++;
            if (result.errorDetail !== null && firstErrorDetail === null) {
              firstErrorDetail = result.errorDetail;
            }

            if (result.action === 'open_long' || result.action === 'open_short') {
              // invariant: callTradeLive's every invalid path returns action 'error' (see its own
              // comment), so reaching an open_* action here always implies valid: true — a future
              // denominator change reading openValidCount depends on this holding.
              proposeCount++;
              openValidCount++;
              if (result.tradeSane) saneCount++;
            }

            const scoringRow = scoringRowFromPayload(
              patched,
              { action: result.action, confidence: null },
              { promptHash, playbookVersion: null, model },
            );
            if (scoringRow !== null) candidateScoringRows.push(scoringRow);
            else droppedScoringRows++;

            if (ROW_LOG_FILE) {
              appendFileSync(
                ROW_LOG_FILE,
                JSON.stringify({
                  // First 12 chars of corpusFingerprint — separates interleaved runs when a file is
                  // reused across legs (log-line only, not part of the scorecard).
                  run: fingerprint.slice(0, 12),
                  model,
                  rowId: row.id,
                  symbol: row.symbol,
                  eventTime: row.eventTime,
                  championAction: row.action,
                  candidateAction: result.action,
                  valid: result.valid,
                  tradeSane: result.tradeSane,
                  usage: result.usage,
                  errorDetail: result.errorDetail,
                }) + '\n',
              );
            }
          }

          const schemaValidRate = schemaValidCount / replayRows.length;
          const tradeSanityRate = openValidCount > 0 ? saneCount / openValidCount : null;
          const proposeRate = proposeCount / replayRows.length;
          const candidateDirectionalForwardProxyBps =
            directionalForwardProxyBps(candidateScoringRows);
          const costPerDecideUsd = meanCostUsd(usageRows, tokenPriceOverrides);
          const agreementWithChampion = agreementCount / replayRows.length;

          assertNoNaN(`${model} schemaValidRate`, schemaValidRate);
          assertNoNaN(`${model} tradeSanityRate`, tradeSanityRate);
          assertNoNaN(`${model} proposeRate`, proposeRate);
          assertNoNaN(`${model} directionalForwardProxyBps`, candidateDirectionalForwardProxyBps);
          assertNoNaN(`${model} costPerDecideUsd`, costPerDecideUsd);
          assertNoNaN(`${model} agreementWithChampion`, agreementWithChampion);

          candidates.push({
            model,
            rowsReplayed: replayRows.length,
            schemaValidRate,
            tradeSanityRate,
            proposeCount,
            proposeRate,
            directionalForwardProxyBps: candidateDirectionalForwardProxyBps,
            costPerDecideUsd,
            corpusFingerprint: fingerprint,
            contractFingerprint: runContractFingerprint,
            actionHistogram,
            agreementWithChampion,
            invalidCount,
            firstErrorDetail,
            droppedScoringRows,
            promptHash,
          });
        }

        expect(candidates).toHaveLength(CANDIDATE_MODELS.length);

        // ── Verdicts (hh-v1) ───────────────────────────────────────────────────────────────────────
        // Computed in a try so a comparison refusal (evaluateHeadToHeadVerdict's fingerprint gate,
        // a malformed baseline file) still emits the paid replay's scorecard below before the test
        // fails: by then every replayed row has cost a real API call, so the refusal must cost the
        // COMPARISON, never the replay data. The error is embedded in the scorecard and rethrown
        // after the write.
        const verdicts: HeadToHeadVerdict[] = [];
        let verdictError: string | null = null;
        try {
          const [firstCandidate, ...restCandidates] = candidates;
          if (firstCandidate) {
            for (const candidate of restCandidates) {
              verdicts.push(evaluateHeadToHeadVerdict(candidate, firstCandidate));
            }
          }
          const baselineFile = process.env['AGENTIC_EVAL_BASELINE_SCORECARD_FILE'];
          if (baselineFile) {
            const baselineScorecard = JSON.parse(readFileSync(baselineFile, 'utf8')) as {
              readonly candidates: readonly TradeModelCandidateResult[];
            };
            // Picking candidates[0] implicitly is only safe for a single-model baseline leg — a
            // multi-candidate baseline file makes the choice silent and arbitrary, so refuse rather
            // than guess which one was meant.
            if (baselineScorecard.candidates.length > 1) {
              throw new Error(
                `AGENTIC_EVAL_BASELINE_SCORECARD_FILE ${baselineFile} carries ` +
                  `${baselineScorecard.candidates.length} candidates ` +
                  `(${baselineScorecard.candidates.map((c) => c.model).join(', ')}) — baseline ` +
                  'comparison requires exactly one; re-run the baseline leg with a single ' +
                  'AGENTIC_EVAL_CANDIDATE_MODELS entry.',
              );
            }
            const baselineCandidate = baselineScorecard.candidates[0];
            if (baselineCandidate) {
              for (const candidate of candidates) {
                verdicts.push(evaluateHeadToHeadVerdict(candidate, baselineCandidate));
              }
            }
          }
        } catch (err) {
          verdictError = err instanceof Error ? err.message : String(err);
        }

        // ── Scorecard — EXACT top-level contract; scripts/log-eval-experiment.mjs hard-validates it ──
        const scorecard = {
          criteriaVersion: 'hh-v1' as const,
          corpusFingerprint: fingerprint,
          contractFingerprint: runContractFingerprint,
          // Registry provenance from data, not a hardcoded literal — the registry is append-only, so
          // a wrong hardcoded row would be permanent.
          templateVersion: TRADE_TEMPLATE_VERSION,
          corpusSource: sourceDescription,
          window: {
            rowSince: ROW_SINCE,
            rowUntil: ROW_UNTIL,
            firstEventTime: replayRows[0]?.eventTime ?? null,
            lastEventTime: replayRows[replayRows.length - 1]?.eventTime ?? null,
            rowsLoaded: rows.length,
            rowsReplayed: replayRows.length,
          },
          capabilities: { ...SYNTHETIC_PERP_CAPS },
          thinking: THINKING_LABEL,
          maxTokens: MAX_TOKENS,
          tokenPrices,
          championReference,
          candidates,
          verdicts,
          ...(verdictError !== null ? { verdictError } : {}),
        };
        const scorecardJson = JSON.stringify(scorecard, null, 2);
        // The scorecard IS this script's deliverable — paste into an experiments-registry row (or
        // feed straight to scripts/log-eval-experiment.mjs --scorecard). Console alone is NOT
        // durable (vitest can intercept/suppress it — 2026-07-10 incident);
        // AGENTIC_EVAL_SCORECARD_FILE additionally persists it verbatim.
        console.log(scorecardJson);
        const scorecardFile = process.env['AGENTIC_EVAL_SCORECARD_FILE'];
        if (scorecardFile) {
          writeFileSync(scorecardFile, scorecardJson);
        }
        if (verdictError !== null) {
          throw new Error(`verdict computation failed after scorecard write: ${verdictError}`);
        }
      },
      Number(process.env['AGENTIC_EVAL_TIMEOUT_MS'] ?? '600000'),
    );
  },
);
