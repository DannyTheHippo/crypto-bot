// Live eval: the ~$3 OHLCV-degradation pre-check — gating evidence for the planned LLM-in-the-loop
// backtest, which can only ever reconstruct candles/indicators (no order book, no live ticker) from
// historical OHLCV. This script answers: does an OHLCV-only reconstruction of a recorded decide
// payload predict the SAME action the real payload (with orderBook + ticker intact) produced? If not,
// the backtest premise is refuted before any backtest is built.
//
// Sibling of recorded-payload-live-compare.spec.ts — same gating, same row-loading convention
// (journal.recent(), newest-N, ascending), same direct-fetch client-invocation pattern (this script
// does NOT go through AnthropicAgentClient.propose() for the same reason that sibling doesn't: a
// persisted input_payload row has no surviving AgentDecisionInput to hand it — see
// recorded-payload-fixtures.ts's composeRecordedUserMessage comment). Differs in what varies between
// the two calls: the sibling swaps the PLAYBOOK; this script swaps the PAYLOAD (same champion
// playbook, same template, arm (b) has orderBook+ticker deleted) and scores action agreement +
// propose-rate + plan-field deltas instead of forward-return counterfactual scoring — there is no
// "candidate playbook" here, so counterfactual-scoring.ts's forward-return machinery does not apply.
//
// Quadruple-gated exactly like the sibling (any one missing skips the whole suite; never wired into
// CI; never called from `pnpm eval:agentic`'s default `vitest run test/eval`):
//   - ANTHROPIC_API_KEY + EVAL_LIVE=1 — the network gate.
//   - DATABASE_URL + the same read-only DB_SUITE_ALLOW_RESET/_test-suffix gate (mirrored locally,
//     not imported, so each spec's gate stays self-contained and independently auditable).
//
// To run it against a real staging/local DB + key:
//   DATABASE_URL=postgres://...              (must end in _test, or set DB_SUITE_ALLOW_RESET=1)
//   ANTHROPIC_API_KEY=sk-ant-...
//   EVAL_LIVE=1
//   AGENTIC_MODEL=claude-sonnet-5             (optional, defaults below — matches prod AGENTIC_MODEL)
//   PAYLOAD_DEGRADATION_ROWS=15               (optional, default 15, hard-capped at 25 — 2 live calls
//                                              per row, budget must stay under ~$3)
//   pnpm exec vitest run test/eval/agentic/payload-degradation-live.spec.ts
import { writeFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../../src/database/schemas/trading';
import { AgentDecisionJournalAdapter } from '../../../src/database/repositories/agent-decision-journal.adapter';
import { PlaybookStoreAdapter } from '../../../src/database/repositories/playbook-store.adapter';
import {
  DERIVATIVES_TEMPLATE_VERSION,
  PLAN_BOUNDS,
  PLAN_TOOL,
  PLAN_TEMPLATE_VERSION,
  buildSystemPrompt,
  computePromptHash,
} from '../../../src/features/trading/agentic/agent-prompt';
import { SEED_PLAYBOOK } from '../../../src/features/trading/agentic/agentic-strategy.module';
import { EVAL_PROFILE } from './fixtures';
import {
  composeRecordedUserMessage,
  type RecordedMarketPayload,
} from './recorded-payload-fixtures';

const API_KEY = process.env['ANTHROPIC_API_KEY'];
const LIVE_ENABLED = process.env['EVAL_LIVE'] === '1';
const DB_URL = process.env['DATABASE_URL'];
// Matches src/config/environment/environment.config.ts's AGENTIC_MODEL default — this script's
// whole premise is "predicts LIVE decide behavior", so its default model must be the one prod
// actually runs, not an arbitrary eval default.
const MODEL = process.env['AGENTIC_MODEL'] ?? 'claude-sonnet-5';
// Default 15, hard-capped at 25 regardless of what's requested — each row costs 2 real API calls, so
// an uncapped env override could silently blow the ~$3 budget this script is designed around.
const REQUESTED_ROWS = Number(process.env['PAYLOAD_DEGRADATION_ROWS'] ?? '15');
const ROW_LIMIT = Math.min(
  Math.max(1, Number.isFinite(REQUESTED_ROWS) ? Math.trunc(REQUESTED_ROWS) : 15),
  25,
);
// Wall-clock budget scales with the row budget (2 sequential real calls/row, ~3-5s each) — a fixed
// cap silently contradicts a raised PAYLOAD_DEGRADATION_ROWS, same reasoning as the sibling's
// TIMEOUT_MS (AGENTIC_EVAL_TIMEOUT_MS there). 6s/call budget, floored at the sibling's 120s default.
const TIMEOUT_MS = Number(
  process.env['AGENTIC_EVAL_TIMEOUT_MS'] ?? String(Math.max(120_000, ROW_LIMIT * 2 * 6_000)),
);

// Mirrors recorded-rows.spec.ts's read-only DB gate — see that file (and the sibling live-compare
// spec) for the full rationale; deliberately re-declared, not imported, so each spec's gate stays
// self-contained and independently auditable.
function dbNameEndsWithTest(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/^\//, '').endsWith('_test');
  } catch {
    return false;
  }
}

const resetAllowed =
  process.env['DB_SUITE_ALLOW_RESET'] === '1' || (!!DB_URL && dbNameEndsWithTest(DB_URL));

const SKIP = !API_KEY || !LIVE_ENABLED || !DB_URL || !resetAllowed;

// Mirrors anthropic-agent-client.ts's local planSchema (not exported, so re-declared here rather
// than reaching into module internals) — action/confidence/rationale plus an optional plan object,
// REQUIRED when action is 'long', bounded by the same PLAN_BOUNDS constant the wire tool schema's
// prose ranges and the production zod gate both render from. A row that fails this parse (or fails
// the API call outright) becomes an 'error' arm outcome — this script does not replicate the
// production edge-floor/minRr plan-viability rejection (anthropic-agent-client.ts's post-parse
// stopLossPct/takeProfitPct/RR floors): schema-parse success alone defines "proposed" here, a
// deliberate simplification for this pre-check's scope.
const planLiveSchema = z
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

interface LiveArmDecision {
  readonly action: 'long' | 'flat' | 'hold' | 'error';
  readonly confidence: number | null;
  // String form (matches AgentPlan / production's `String(rawPlan.stopLossPct)` mapping boundary —
  // anthropic-agent-client.ts) so delta math below stays Decimal-on-strings, never a native float
  // subtraction. Present only when action === 'long' (schema-guaranteed) or a 'hold' re-arm supplied
  // one — see the propose-rate note below for why re-arm plans are excluded from that count anyway.
  readonly plan: { stopLossPct: string; takeProfitPct: string; maxHoldBars: number } | null;
}

// Calls the real Anthropic Messages API directly with the PLAN_TOOL schema, mirroring
// anthropic-agent-client.ts's attemptOnce()/response-envelope handling in miniature — same
// no-retry-on-a-single-failed-call convention as the sibling's callAnthropicLive (one degraded row,
// not a second real API call).
async function callAnthropicPlanLive(
  systemPrompt: string,
  userMessage: string,
): Promise<LiveArmDecision> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024, // matches prod AGENTIC_MAX_TOKENS default (docker-compose.yml)
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      tools: [PLAN_TOOL],
      tool_choice: { type: 'tool', name: 'submit_plan' },
      thinking: { type: 'disabled' },
    }),
  });
  if (!res.ok) return { action: 'error', confidence: null, plan: null };
  const body = (await res.json()) as {
    readonly content?: readonly {
      readonly type: string;
      readonly name?: string;
      readonly input?: unknown;
    }[];
  };
  const toolBlock = body.content?.find((b) => b.type === 'tool_use' && b.name === 'submit_plan');
  const parsed = planLiveSchema.safeParse(toolBlock?.input);
  if (!parsed.success) return { action: 'error', confidence: null, plan: null };
  const rawPlan = parsed.data.plan;
  return {
    action: parsed.data.action,
    confidence: parsed.data.confidence,
    plan: rawPlan
      ? {
          stopLossPct: String(rawPlan.stopLossPct),
          takeProfitPct: String(rawPlan.takeProfitPct),
          maxHoldBars: rawPlan.maxHoldBars,
        }
      : null,
  };
}

// Deletes ONLY orderBook and ticker — nothing else changes, per this script's scope (it does NOT
// also strip derivatives/sentiment/constraints; an OHLCV-reconstructed backtest premise is scoped
// to "no order book / no live ticker", not "no venue feeds of any kind"). Safe to call on a payload
// missing either key already (many recorded rows have no book snapshot; ticker may be null) — a
// no-op delete, so per-row partial degradation (a row that already lacked a book) is unremarkable,
// not a bug.
function stripOrderBookAndTicker(payloadJson: string): string {
  const payload = JSON.parse(payloadJson) as Record<string, unknown>;
  delete payload['orderBook'];
  delete payload['ticker'];
  return JSON.stringify(payload);
}

interface Accumulator {
  rows: number;
  errorRows: number;
  nonErrorRows: number;
  agree: number;
  totalA: number;
  proposeA: number;
  totalB: number;
  proposeB: number;
  bothProposed: number;
  deltaStopLossSum: Decimal;
  deltaTakeProfitSum: Decimal;
  deltaMaxHoldSum: number;
}

function emptyAcc(): Accumulator {
  return {
    rows: 0,
    errorRows: 0,
    nonErrorRows: 0,
    agree: 0,
    totalA: 0,
    proposeA: 0,
    totalB: 0,
    proposeB: 0,
    bothProposed: 0,
    deltaStopLossSum: new Decimal(0),
    deltaTakeProfitSum: new Decimal(0),
    deltaMaxHoldSum: 0,
  };
}

// Folds one row's (a, b) arm outcomes into an accumulator. "propose" = action === 'long' (schema
// guarantees a plan on that action) — a 'hold' that re-attaches a plan to re-arm an already-open
// position (PLAN MODE's re-arm path — see agent-prompt.ts's managedPlan sentence) is NOT counted as
// a proposal here, and its plan fields are NOT included in the delta set, which is scoped to rows
// where BOTH arms opened a fresh long.
function bump(acc: Accumulator, a: LiveArmDecision, b: LiveArmDecision): void {
  acc.rows += 1;
  const eitherError = a.action === 'error' || b.action === 'error';
  if (eitherError) {
    acc.errorRows += 1;
  } else {
    acc.nonErrorRows += 1;
    if (a.action === b.action) acc.agree += 1;
  }
  if (a.action !== 'error') {
    acc.totalA += 1;
    if (a.action === 'long') acc.proposeA += 1;
  }
  if (b.action !== 'error') {
    acc.totalB += 1;
    if (b.action === 'long') acc.proposeB += 1;
  }
  if (a.action === 'long' && b.action === 'long' && a.plan && b.plan) {
    acc.bothProposed += 1;
    acc.deltaStopLossSum = acc.deltaStopLossSum.plus(
      new Decimal(a.plan.stopLossPct).minus(b.plan.stopLossPct).abs(),
    );
    acc.deltaTakeProfitSum = acc.deltaTakeProfitSum.plus(
      new Decimal(a.plan.takeProfitPct).minus(b.plan.takeProfitPct).abs(),
    );
    acc.deltaMaxHoldSum += Math.abs(a.plan.maxHoldBars - b.plan.maxHoldBars);
  }
}

interface SymbolScorecard {
  readonly symbol: string;
  readonly n: number;
  readonly errorRows: number;
  readonly agreementRate: number | null;
  readonly proposeRateA: number | null;
  readonly proposeRateB: number | null;
  readonly bothProposedRows: number;
  readonly meanAbsDeltaStopLossPct: string | null;
  readonly meanAbsDeltaTakeProfitPct: string | null;
  readonly meanAbsDeltaMaxHoldBars: number | null;
}

function summarize(symbol: string, acc: Accumulator): SymbolScorecard {
  return {
    symbol,
    n: acc.rows,
    errorRows: acc.errorRows,
    agreementRate: acc.nonErrorRows > 0 ? acc.agree / acc.nonErrorRows : null,
    proposeRateA: acc.totalA > 0 ? acc.proposeA / acc.totalA : null,
    proposeRateB: acc.totalB > 0 ? acc.proposeB / acc.totalB : null,
    bothProposedRows: acc.bothProposed,
    meanAbsDeltaStopLossPct:
      acc.bothProposed > 0 ? acc.deltaStopLossSum.div(acc.bothProposed).toFixed(6) : null,
    meanAbsDeltaTakeProfitPct:
      acc.bothProposed > 0 ? acc.deltaTakeProfitSum.div(acc.bothProposed).toFixed(6) : null,
    meanAbsDeltaMaxHoldBars: acc.bothProposed > 0 ? acc.deltaMaxHoldSum / acc.bothProposed : null,
  };
}

function verdictFor(agreementRate: number | null): string {
  if (agreementRate === null) return 'INSUFFICIENT DATA — no non-error rows to compare';
  if (agreementRate >= 0.85) return 'OHLCV-only reconstruction is a fair proxy';
  if (agreementRate >= 0.7) return 'usable with caution, label results';
  return 'REFUTES the OHLCV-only backtest premise';
}

describe.skipIf(SKIP)(
  'agentic eval — OHLCV-degradation live pre-check (optional, requires ANTHROPIC_API_KEY + EVAL_LIVE=1 + DATABASE_URL + db-test gate)',
  () => {
    it(
      'replays recorded rows with and without orderBook/ticker through the current champion playbook and prints an agreement scorecard',
      async () => {
        const pool = new Pool({ connectionString: DB_URL! });
        try {
          const db = drizzle(pool, { schema });
          const journal = new AgentDecisionJournalAdapter(db);
          const pinEnv = process.env['AGENTIC_PLAYBOOK_PIN'];
          const store = new PlaybookStoreAdapter(
            db,
            SEED_PLAYBOOK,
            pinEnv ? Number(pinEnv) : undefined,
          );
          // Same pin > promotion > seed precedence the running process uses (PlaybookStoreAdapter.
          // resolve()) — "current champion playbook" means what's actually active, not a hardcoded
          // SEED fallback.
          const champion = await store.current();

          // journal.recent(N) has no "input_payload IS NOT NULL" WHERE clause, so the newest
          // ROW_LIMIT rows by (event_time, id) DESC may include null-payload rows — buffer well past
          // ROW_LIMIT, filter, THEN take the newest ROW_LIMIT of what remains (still ascending
          // oldest-first — recent()'s documented order). Under-fetching here would silently deliver
          // fewer rows than requested; the buffer is a free DB read, not a spent API call.
          const buffered = await journal.recent(Math.max(ROW_LIMIT * 4, 50));
          const withPayload = buffered.filter((r) => r.inputPayload !== null);
          const rows = withPayload.slice(-ROW_LIMIT);
          expect(rows.length).toBeGreaterThan(0);

          // Current production plan-mode template: docker-compose.yml runs AGENTIC_PLAN_MODE=true
          // AND DERIVATIVES_FEED_ENABLED=true, so recorded rows may already carry a `derivatives`
          // block — documenting it in the system prompt (not stripping it; only orderBook/ticker are
          // stripped, see stripOrderBookAndTicker) is what makes arm (a) a faithful "live decide"
          // ground truth. sentiment/shorts stay off, matching docker-compose.yml's current flags.
          const systemPrompt = buildSystemPrompt(EVAL_PROFILE, {
            planMode: true,
            minEdgeMultiple: '1.5',
            minRr: '1.5',
            derivativesFeedEnabled: true,
          });
          const promptHash = computePromptHash({
            templateVersion: `${PLAN_TEMPLATE_VERSION}+${DERIVATIVES_TEMPLATE_VERSION}`,
            playbookContent: champion.content,
            toolSchemaJson: JSON.stringify(PLAN_TOOL),
            modelId: MODEL,
          });

          const combined = emptyAcc();
          const bySymbol = new Map<string, Accumulator>();
          let skippedRows = 0;

          for (const row of rows) {
            const payloadJson = row.inputPayload!;
            let payload: RecordedMarketPayload;
            try {
              payload = JSON.parse(payloadJson) as RecordedMarketPayload;
            } catch {
              skippedRows += 1;
              continue;
            }
            const symbol =
              typeof payload.symbol === 'string' && payload.symbol.length > 0
                ? payload.symbol
                : null;
            if (symbol === null) {
              skippedRows += 1;
              continue;
            }

            const degradedPayloadJson = stripOrderBookAndTicker(payloadJson);
            const userMessageA = composeRecordedUserMessage(payloadJson, champion.content);
            const userMessageB = composeRecordedUserMessage(degradedPayloadJson, champion.content);

            const decisionA = await callAnthropicPlanLive(systemPrompt, userMessageA);
            const decisionB = await callAnthropicPlanLive(systemPrompt, userMessageB);

            bump(combined, decisionA, decisionB);
            const symAcc = bySymbol.get(symbol) ?? emptyAcc();
            bump(symAcc, decisionA, decisionB);
            bySymbol.set(symbol, symAcc);
          }
          expect(combined.rows).toBeGreaterThan(0);

          const perSymbol = [...bySymbol.entries()]
            .sort(([x], [y]) => x.localeCompare(y))
            .map(([symbol, acc]) => summarize(symbol, acc));
          const combinedCard = summarize('ALL', combined);
          const verdict = verdictFor(combinedCard.agreementRate);

          // The scorecard IS this script's deliverable — console alone is NOT durable (vitest's
          // reporter can intercept/suppress console output; see recorded-payload-live-compare.spec.ts's
          // 2026-07-10 incident note), so when AGENTIC_EVAL_SCORECARD_FILE is set it's ALSO written
          // there verbatim, thresholds and verdict included in both.
          const scorecard = JSON.stringify(
            {
              rowsRequested: ROW_LIMIT,
              rowsScored: combined.rows,
              rowsSkipped: skippedRows,
              model: MODEL,
              championVersion: champion.version,
              promptHash,
              perSymbol,
              combined: combinedCard,
              interpretationThresholds: {
                fairProxy: 'agreement >= 0.85 => OHLCV-only reconstruction is a fair proxy',
                usableWithCaution: '0.70 <= agreement < 0.85 => usable with caution, label results',
                refutesPremise: 'agreement < 0.70 => REFUTES the OHLCV-only backtest premise',
              },
              verdict,
            },
            null,
            2,
          );
          console.log(scorecard);
          console.log(
            `VERDICT (combined agreement=${combinedCard.agreementRate ?? 'n/a'}): ${verdict}`,
          );
          const scorecardFile = process.env['AGENTIC_EVAL_SCORECARD_FILE'];
          if (scorecardFile) {
            writeFileSync(scorecardFile, scorecard);
          }
        } finally {
          await pool.end();
        }
      },
      TIMEOUT_MS,
    );
  },
);
