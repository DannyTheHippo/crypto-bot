// Shared support code for the v3 rich-contract eval harness (a NEW test/eval/agentic/*.spec.ts,
// written separately — this module is import-only, same non-spec convention as fixtures.ts/
// recorded-payload-fixtures.ts: Vitest's default include glob never picks it up directly).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../../src/database/schemas/trading';
import { AgentDecisionJournalAdapter } from '../../../src/database/repositories/agent-decision-journal.adapter';
import { venueId } from '../../../src/domain/types/ids';
import type { SymbolCapabilities } from '../../../src/features/trading/agentic/agent-prompt';
import type { AgentTradingProfile } from '../../../src/ports/agentic-strategy';
import {
  summarizeRecentDecisionOutcomes,
  type ScoringRow,
} from '../../../src/features/trading/agentic/counterfactual-scoring';

// Byte-matches the production client defaults (anthropic-agent-client.ts's capabilitiesFor:
// DEFAULT_MAX_POSITION_FRACTION_PERP / DEFAULT_PERP_LEVERAGE_CAP) and the deployed $1k demo book
// (.env.app: AGENTIC_MAX_POSITION_FRACTION_PERP=0.35, PERP_LEVERAGE_CAP=2,
// VENUE_CAPITAL_SPLIT.binanceusdm=500) — replaying against these advertises exactly what a live
// perp symbol advertises, never a synthetic best-case.
export const SYNTHETIC_PERP_CAPS: SymbolCapabilities = {
  venue: venueId('binanceusdm'),
  shorts: true,
  leverage: '2',
  maxSizeFraction: '0.35',
  venueFreeCash: '500',
};

// v2-era recorded payloads predate the capabilities block (agent-prompt.ts's buildMarketPayload
// only renders `capabilities` when BuildMarketPayloadExtras.capabilities is supplied — a v3+
// caller); the v3 prompt gates 'open_short' on capabilities.shorts, so without injection a
// FLAT->open_short row is unreachable in replay. Surgery precedent: withCandleWindow in
// recorded-payload-fixtures.ts (same "trim/patch an already-rendered payload string" shape). A
// payload that already carries a `capabilities` key is v3-native and replayed VERBATIM — untouched,
// never overwritten.
export function withSyntheticCapabilities(payloadJson: string, caps: SymbolCapabilities): string {
  const payload = JSON.parse(payloadJson) as Record<string, unknown>;
  if ('capabilities' in payload) return payloadJson;
  return JSON.stringify({
    ...payload,
    capabilities: {
      venue: String(caps.venue),
      shorts: caps.shorts,
      leverage: caps.leverage,
      maxSizeFraction: caps.maxSizeFraction,
      venueFreeCash: caps.venueFreeCash,
    },
  });
}

// ── Model routing (kimi-k3 prerequisite-B pattern, generalized to N models) ─────────────────────

export interface ModelRoute {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly callDelayMs: number;
  // Callers send both x-api-key and Bearer auth when not default — the compat surface's wire auth
  // header is not uniformly documented (Bearer vs x-api-key); sending both on an overridden base is
  // harmless and removes a whole failure branch (mirrors candidate-model-eval.spec.ts's
  // callAnthropicPlanLive header-building comment).
  readonly isDefaultBase: boolean;
}

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

// .strict(): an unrecognized field here is a typo about to leak the wrong key (e.g. `apiKeyEnv`
// misspelled falls through to the ANTHROPIC_API_KEY fallback below and ships the Anthropic org key
// to the routed third-party host), never a benign extra — the token-price schema's .passthrough()
// precedent does not transfer to a route object.
const modelRouteSchema = z.record(
  z.string().min(1),
  z
    .object({
      baseUrl: z.string().min(1).optional(),
      // env-var-NAME indirection, not a key value — the actual API key comes from
      // process.env[apiKeyEnv] at resolve time, so a key never appears inside the JSON itself.
      apiKeyEnv: z.string().min(1).optional(),
      callDelayMs: z.number().nonnegative().optional(),
    })
    .strict(),
);

// Parses AGENTIC_EVAL_MODEL_ROUTES_JSON (shape: { [model]: { baseUrl?, apiKeyEnv?, callDelayMs? } })
// and resolves one model's effective route. Malformed JSON/shape THROWS — same throw-inside-the-test
// convention as candidate-model-eval.spec.ts's parseTokenPriceOverrides (a malformed value must fail
// the running test, never silently fall back).
export function resolveModelRoute(model: string): ModelRoute {
  const raw = process.env['AGENTIC_EVAL_MODEL_ROUTES_JSON'];
  let routes: z.infer<typeof modelRouteSchema> = {};
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `AGENTIC_EVAL_MODEL_ROUTES_JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const result = modelRouteSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`AGENTIC_EVAL_MODEL_ROUTES_JSON failed validation: ${issues}`);
    }
    routes = result.data;
  }
  const route = routes[model];

  const globalCallDelayMs = process.env['AGENTIC_EVAL_CALL_DELAY_MS'];
  const baseUrl = (
    route?.baseUrl ??
    process.env['AGENTIC_EVAL_BASE_URL'] ??
    DEFAULT_ANTHROPIC_BASE_URL
  ).replace(/\/+$/, '');
  // A per-model route that names its own baseUrl (a third-party host) must also name its own
  // apiKeyEnv explicitly — it never falls back to AGENTIC_EVAL_API_KEY/ANTHROPIC_API_KEY, which
  // would transmit the Anthropic org key to that third-party host. The global AGENTIC_EVAL_BASE_URL
  // legacy mode (no per-model baseUrl) keeps the old fallback chain.
  const apiKey = route?.baseUrl
    ? route.apiKeyEnv
      ? process.env[route.apiKeyEnv]
      : undefined
    : route?.apiKeyEnv
      ? process.env[route.apiKeyEnv]
      : (process.env['AGENTIC_EVAL_API_KEY'] ?? process.env['ANTHROPIC_API_KEY']);
  let callDelayMs: number;
  if (route?.callDelayMs !== undefined) {
    callDelayMs = route.callDelayMs;
  } else if (globalCallDelayMs !== undefined) {
    const parsedDelay = Number(globalCallDelayMs);
    // Malformed env fails the run, never silently falls back — a dropped delay hammers a
    // rate-limited paid endpoint (same throw-inside-the-run convention as the JSON parses above).
    if (!Number.isFinite(parsedDelay) || parsedDelay < 0) {
      throw new Error(
        `AGENTIC_EVAL_CALL_DELAY_MS must be a finite number >= 0, got "${globalCallDelayMs}"`,
      );
    }
    callDelayMs = parsedDelay;
  } else {
    callDelayMs = 0;
  }

  return { baseUrl, apiKey, callDelayMs, isDefaultBase: baseUrl === DEFAULT_ANTHROPIC_BASE_URL };
}

// ── Trade sanity (schema-valid submit_trade responses only) ─────────────────────────────────────

// The wire shape of a schema-VALID submit_trade tool response — re-declared locally because
// anthropic-agent-client.ts's TradeDecisionV2 (z.infer<ReturnType<typeof tradeDecisionSchema>>) is
// module-private, same re-declaration precedent as candidate-model-eval.spec.ts's planLikeSchema.
export interface TradeToolDecision {
  readonly action: 'open_long' | 'open_short' | 'close' | 'adjust' | 'hold';
  readonly sizeFraction?: number;
  readonly entry?: { readonly style: 'maker' | 'taker'; readonly offsetBps: number };
  readonly entryValidityBars?: number;
  readonly stopLossPct?: number;
  readonly takeProfitPct?: number;
  readonly maxHoldBars?: number;
  readonly partialCloseFraction?: number;
  readonly thesis?: string;
}

// Sanity over a schema-valid submit_trade response — the only prompt/tool-stated rules zod cannot
// encode structurally. No edge/R:R floor exists in the v3 prompt (unlike the legacy plan-mode
// prompt's MIN_EDGE_MULTIPLE/MIN_RR sentences), so this checks only what the v3 prompt and tool
// contract actually state; penalizing an unstated rule would be unfair pre-registration. null for
// 'hold'/'close'/'adjust' (excluded from the denominator, matching candidate-model-eval.spec.ts's
// planSane convention of scoring only the propose path).
export function isTradeSane(
  decision: TradeToolDecision,
  profile: AgentTradingProfile,
): boolean | null {
  if (decision.action === 'hold' || decision.action === 'close' || decision.action === 'adjust') {
    return null;
  }
  // Missing directive fields on an open_* action ⇒ false (schema should prevent this; fail
  // conservative rather than treating an impossible shape as vacuously sane).
  if (decision.takeProfitPct === undefined || decision.entry === undefined) return false;

  // (i) the prompt-stated fee floor: takeProfitPct must clear the round-trip fee fraction.
  const feeFraction = new Decimal(profile.makerBps).plus(profile.takerBps).div(10_000);
  const clearsFeeFloor = new Decimal(String(decision.takeProfitPct)).gte(feeFraction);
  // (ii) the tool-stated contract: a 'taker' entry ignores offsetBps, so the model must submit 0.
  const takerOffsetIsZero = decision.entry.style !== 'taker' || decision.entry.offsetBps === 0;

  return clearsFeeFloor && takerOffsetIsZero;
}

// ── Directional forward-return proxy (entries + shortEntries, combined) ─────────────────────────

// Mirrors candidate-model-eval.spec.ts's forwardProxyBps per-symbol grouping EXACTLY (that file,
// ~415-435: group rows per symbol — a mixed-symbol window reads a different symbol's close as row
// i's outcome, #37/5da2630 defect class — digest each group, combine count-weighted) but combines
// BOTH entry buckets: `entries` (raw mean — long: up is good) and the new `shortEntries` (NEGATED
// mean — short profits from a decline, so the sign flips) into one bps number. null when neither
// bucket has an entry in any symbol group.
export function directionalForwardProxyBps(rows: readonly ScoringRow[]): number | null {
  const groups = new Map<string, ScoringRow[]>();
  for (const row of rows) {
    const group = groups.get(row.symbol);
    if (group) group.push(row);
    else groups.set(row.symbol, [row]);
  }
  let count = 0;
  let weightedPctSum = 0;
  for (const groupRows of groups.values()) {
    const digest = summarizeRecentDecisionOutcomes(groupRows);
    if (digest.entries.count > 0 && digest.entries.meanForwardReturnPct !== null) {
      count += digest.entries.count;
      weightedPctSum += digest.entries.meanForwardReturnPct * digest.entries.count;
    }
    if (digest.shortEntries.count > 0 && digest.shortEntries.meanForwardReturnPct !== null) {
      count += digest.shortEntries.count;
      weightedPctSum += -digest.shortEntries.meanForwardReturnPct * digest.shortEntries.count;
    }
  }
  // meanForwardReturnPct is already a PERCENT (0.1 -> 10); this eval reports bps, so x100 — same
  // percent->bps conversion as candidate-model-eval.spec.ts's forwardProxyBps.
  return count === 0 ? null : (weightedPctSum / count) * 100;
}

// ── Corpus fingerprint + head-to-head verdict (hh-v1, pre-registered 2026-07-22) ─────────────────

// Embedded in every scorecard; verdicts refuse to compare scorecards from different corpus slices.
export function corpusFingerprint(rows: readonly { id: string; eventTime: number }[]): string {
  return createHash('sha256')
    .update(rows.map((r) => `${r.id}:${r.eventTime}`).join('\n'))
    .digest('hex');
}

// Stable-key-sorted JSON over the contract-shaping parts (deliberately NOT computePromptHash —
// that embeds modelId, which differs between legs by construction and would make every leg's
// fingerprint differ even when the contract itself is identical). Detects thinking/prompt/tool
// drift between legs that corpusFingerprint (corpus identity only) cannot see.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function contractFingerprint(parts: {
  readonly templateVersion: string;
  readonly playbookContent: string;
  readonly toolSchemaJson: string;
  readonly thinking: string;
  readonly maxTokens: number;
}): string {
  return createHash('sha256').update(stableStringify(parts)).digest('hex');
}

export interface TradeModelCandidateResult {
  readonly model: string;
  readonly rowsReplayed: number;
  readonly schemaValidRate: number;
  readonly tradeSanityRate: number | null;
  readonly proposeCount: number;
  readonly proposeRate: number;
  readonly directionalForwardProxyBps: number | null;
  readonly costPerDecideUsd: number | null;
  readonly corpusFingerprint: string;
  // Optional: only populated by callers that compute it (trade-model-eval.spec.ts). A validity gate
  // like corpusFingerprint's, not a criteria change — see evaluateHeadToHeadVerdict below.
  readonly contractFingerprint?: string;
}

export interface HeadToHeadVerdict {
  readonly criteriaVersion: 'hh-v1';
  readonly baselineModel: string;
  readonly candidateModel: string;
  readonly criteria: readonly {
    readonly criterion: string;
    readonly pass: boolean | null;
    readonly detail: string;
  }[];
  readonly pass: boolean;
}

// hh-v1 pre-registered criteria (criteriaVersion 'hh-v1', pre-registered 2026-07-22 BEFORE any paid
// run, per change-discipline). A null on either side of a criterion sinks that criterion to
// pass: null (never silently skipped, never counted as a pass); overall pass requires every
// criterion strictly true.
export function evaluateHeadToHeadVerdict(
  candidate: TradeModelCandidateResult,
  baseline: TradeModelCandidateResult,
): HeadToHeadVerdict {
  // Comparison-validity gate — fails CLOSED: a cross-corpus comparison must never be silently
  // scored (a candidate replayed against a different row slice than the baseline is not comparable
  // at all, not merely noisier).
  if (candidate.corpusFingerprint !== baseline.corpusFingerprint) {
    throw new Error(
      'evaluateHeadToHeadVerdict refuses to compare scorecards from different corpus slices: ' +
        `candidate fingerprint ${candidate.corpusFingerprint} !== baseline fingerprint ` +
        `${baseline.corpusFingerprint}.`,
    );
  }
  // Same fail-closed validity gate, covering contract identity (thinking/prompt/tool) rather than
  // corpus identity — only enforced when BOTH sides carry it, so older scorecards without the field
  // stay comparable.
  if (
    candidate.contractFingerprint !== undefined &&
    baseline.contractFingerprint !== undefined &&
    candidate.contractFingerprint !== baseline.contractFingerprint
  ) {
    throw new Error(
      'evaluateHeadToHeadVerdict refuses to compare scorecards from different contracts: ' +
        `candidate contractFingerprint ${candidate.contractFingerprint} !== baseline ` +
        `contractFingerprint ${baseline.contractFingerprint}.`,
    );
  }

  const proposeRatio =
    baseline.proposeRate === 0 ? null : candidate.proposeRate / baseline.proposeRate;

  const criteria: HeadToHeadVerdict['criteria'] = [
    {
      criterion: 'schema-valid rate >= baseline',
      pass: candidate.schemaValidRate >= baseline.schemaValidRate,
      detail: `candidate ${candidate.schemaValidRate.toFixed(3)} >= baseline ${baseline.schemaValidRate.toFixed(3)}`,
    },
    {
      criterion: 'trade sanity rate >= baseline',
      pass:
        candidate.tradeSanityRate === null || baseline.tradeSanityRate === null
          ? null
          : candidate.tradeSanityRate >= baseline.tradeSanityRate,
      detail: `candidate ${candidate.tradeSanityRate ?? 'n/a'} >= baseline ${baseline.tradeSanityRate ?? 'n/a'}`,
    },
    {
      criterion: 'directional forward proxy bps >= baseline - 2',
      pass:
        candidate.directionalForwardProxyBps === null ||
        baseline.directionalForwardProxyBps === null
          ? null
          : candidate.directionalForwardProxyBps >= baseline.directionalForwardProxyBps - 2,
      detail: `candidate ${candidate.directionalForwardProxyBps ?? 'n/a'} bps >= baseline ${baseline.directionalForwardProxyBps ?? 'n/a'} bps - 2`,
    },
    {
      criterion: 'propose-rate ratio in [0.5, 1.5]',
      pass: proposeRatio === null ? null : proposeRatio >= 0.5 && proposeRatio <= 1.5,
      detail: `ratio ${proposeRatio ?? 'n/a'} in [0.5, 1.5]`,
    },
    {
      criterion: 'cost/decide <= baseline',
      pass:
        candidate.costPerDecideUsd === null || baseline.costPerDecideUsd === null
          ? null
          : candidate.costPerDecideUsd <= baseline.costPerDecideUsd,
      detail: `candidate $${candidate.costPerDecideUsd ?? 'n/a'} <= baseline $${baseline.costPerDecideUsd ?? 'n/a'}`,
    },
  ];

  return {
    criteriaVersion: 'hh-v1',
    baselineModel: baseline.model,
    candidateModel: candidate.model,
    criteria,
    pass: criteria.every((c) => c.pass === true),
  };
}

// ── Corpus loading (JSONL file or Postgres) ──────────────────────────────────────────────────────

export interface CorpusRow {
  readonly id: string;
  readonly symbol: string;
  readonly eventTime: number;
  readonly action: string;
  readonly confidence: number | null;
  readonly refPrice: string | null;
  readonly close: string | null;
  readonly playbookVersion: number | null;
  readonly promptHash: string | null;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly inputPayload: string;
}

interface RawCorpusRow extends Omit<CorpusRow, 'inputPayload'> {
  readonly inputPayload: string | null;
}

// Mirrors recorded-rows.spec.ts's read-only DB gate (also locally re-mirrored in
// candidate-model-eval.spec.ts — see that file's own comment for the full rationale each
// self-contained gate copy follows).
function dbNameEndsWithTest(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/^\//, '').endsWith('_test');
  } catch {
    return false;
  }
}

// Legacy vocab normalization, exactly as candidate-model-eval.spec.ts's normalizeJournalAction
// does: a v2-era row journals 'long'/'flat'; ScoringRow.action (and this loader's CorpusRow.action)
// speak the v3 'open_long'/'close' vocabulary.
function normalizeLegacyAction(action: string): string {
  return action === 'long' ? 'open_long' : action === 'flat' ? 'close' : action;
}

// Sync (readFileSync) but shaped to match loadFromPostgres' async signature so the ternary in
// loadCorpusRows below can `await` either branch uniformly.
function loadFromJsonlFile(filePath: string): { rows: RawCorpusRow[]; sourceDescription: string } {
  const text = readFileSync(filePath, 'utf8');
  const rows: RawCorpusRow[] = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RawCorpusRow);
  // rows.length here is the RAW line count, before loadCorpusRows' inputPayload/window filtering —
  // callers report the post-filter count separately (loadCorpusRows' own `rows.length`), so label
  // this one explicitly or a failure message ends up showing two unexplained different numbers.
  return {
    rows,
    sourceDescription: `JSONL file ${filePath} (${rows.length} raw rows before filtering)`,
  };
}

async function loadFromPostgres(): Promise<{ rows: RawCorpusRow[]; sourceDescription: string }> {
  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) {
    throw new Error(
      'loadCorpusRows: neither AGENTIC_EVAL_CORPUS_FILE nor DATABASE_URL is set — nothing to load rows from.',
    );
  }
  const resetAllowed = process.env['DB_SUITE_ALLOW_RESET'] === '1' || dbNameEndsWithTest(dbUrl);
  if (!resetAllowed) {
    throw new Error(
      'loadCorpusRows: DATABASE_URL does not end in _test and DB_SUITE_ALLOW_RESET is not set — ' +
        'refusing to read a non-test database (same read-only DB gate candidate-model-eval.spec.ts uses).',
    );
  }
  const rowQueryLimit = Number(process.env['ROW_QUERY_LIMIT'] ?? '10000');
  const pool = new Pool({ connectionString: dbUrl });
  try {
    const db = drizzle(pool, { schema });
    const journal = new AgentDecisionJournalAdapter(db);
    const journalRows = await journal.recent(rowQueryLimit);
    const rows: RawCorpusRow[] = journalRows.map((r) => ({
      id: r.id,
      symbol: String(r.symbol),
      eventTime: Number(r.eventTime),
      action: r.action,
      confidence: r.confidence,
      refPrice: r.refPrice,
      close: r.close,
      playbookVersion: r.playbookVersion,
      promptHash: r.promptHash,
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      inputPayload: r.inputPayload,
    }));
    return {
      rows,
      sourceDescription: `Postgres via AgentDecisionJournalAdapter.recent(${rowQueryLimit})`,
    };
  } finally {
    await pool.end();
  }
}

// (a) AGENTIC_EVAL_CORPUS_FILE set ⇒ read that JSONL file (one JSON object per line, camelCase keys
// matching CorpusRow — produced by scripts/dump-eval-corpus.mjs), skipping blank lines. (b) else
// Postgres via AgentDecisionJournalAdapter.recent(ROW_QUERY_LIMIT), gated the same way
// candidate-model-eval.spec.ts gates its own DB read. Both modes then: filter to rows with a
// non-null/non-empty inputPayload, normalize legacy action vocab, sort oldest->newest by eventTime,
// and filter to the ROW_SINCE/ROW_UNTIL window (epoch ms, defaults 0/MAX_SAFE_INTEGER). ROW_LIMIT
// slicing is deliberately NOT done here — that stays the calling spec's job.
export async function loadCorpusRows(): Promise<{ rows: CorpusRow[]; sourceDescription: string }> {
  const corpusFile = process.env['AGENTIC_EVAL_CORPUS_FILE'];
  const { rows: rawRows, sourceDescription } = corpusFile
    ? loadFromJsonlFile(corpusFile)
    : await loadFromPostgres();

  const rowSince = Number(process.env['ROW_SINCE'] ?? '0');
  const rowUntil = Number(process.env['ROW_UNTIL'] ?? String(Number.MAX_SAFE_INTEGER));

  const rows: CorpusRow[] = rawRows
    .filter((r): r is RawCorpusRow & { inputPayload: string } => !!r.inputPayload)
    .map((r) => ({ ...r, action: normalizeLegacyAction(r.action) }))
    .sort((a, b) => a.eventTime - b.eventTime)
    .filter((r) => r.eventTime >= rowSince && r.eventTime <= rowUntil);

  return { rows, sourceDescription };
}

// ── Legacy live-call helpers (single source; both candidate-model-eval.spec.ts and ─────────────
// ── trade-model-eval.spec.ts import these directly — extracted 2026-07-22) ─────────────────────

// 429/529-only bounded retry (max 3, honoring Retry-After capped at
// 60s): rate-limit noise on a low-RPM key tier would otherwise degrade rows to 'error' and poison
// schemaValidRate. Every other failure still degrades the row exactly as before.
export async function fetchWithRateLimitRetry(url: string, init: RequestInit): Promise<Response> {
  const RETRY_DELAYS_MS = [2_000, 8_000, 30_000];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if ((res.status !== 429 && res.status !== 529) || attempt >= RETRY_DELAYS_MS.length) {
      return res;
    }
    const retryAfterSec = Number(res.headers.get('retry-after') ?? '');
    const delayMs =
      Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(retryAfterSec * 1000, 60_000)
        : RETRY_DELAYS_MS[attempt]!;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export interface ModelRate {
  readonly input: number;
  readonly output: number;
}

// Current published Anthropic per-1M-token USD rates (see https://www.anthropic.com/pricing —
// verify before trusting cost output, these drift).
const DEFAULT_TOKEN_PRICES_PER_MTOK: Readonly<Record<string, ModelRate>> = {
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-opus-4-8': { input: 5, output: 25 },
};
// Sonnet-tier fallback for a model id absent from both the override map and the defaults above —
// this is a toy cost estimate (never a promotion input), so failing OPEN to a mid-tier guess rather
// than throwing keeps the eval running; the printed scorecard names the model, so a wrong guess is
// visible, not silent.
const FALLBACK_RATE: ModelRate = { input: 3, output: 15 };

const decimalStringLocal = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string');
const tokenPriceOverrideSchema = z
  .record(
    z.string().min(1),
    z.object({ inputPerMtok: decimalStringLocal, outputPerMtok: decimalStringLocal }).passthrough(),
  )
  .optional();

// Parses AGENTIC_TOKEN_PRICES_JSON if set (same env var/shape as the production knob). Called from
// inside it() only: a malformed value must fail the running test, not throw during collection.
export function parseTokenPriceOverrides(
  raw: string | undefined,
): Readonly<Record<string, ModelRate>> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `AGENTIC_TOKEN_PRICES_JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = tokenPriceOverrideSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`AGENTIC_TOKEN_PRICES_JSON failed validation: ${issues}`);
  }
  if (!result.data) return undefined;
  const out: Record<string, ModelRate> = {};
  for (const [model, rates] of Object.entries(result.data)) {
    out[model] = { input: Number(rates.inputPerMtok), output: Number(rates.outputPerMtok) };
  }
  return out;
}

export function resolveRate(
  model: string,
  overrides: Readonly<Record<string, ModelRate>> | undefined,
): ModelRate {
  return overrides?.[model] ?? DEFAULT_TOKEN_PRICES_PER_MTOK[model] ?? FALLBACK_RATE;
}

const MTOK = 1_000_000;

export function callCostUsd(
  usage: { readonly inputTokens: number; readonly outputTokens: number },
  rate: ModelRate,
): Decimal {
  return new Decimal(usage.inputTokens)
    .div(MTOK)
    .mul(rate.input)
    .plus(new Decimal(usage.outputTokens).div(MTOK).mul(rate.output));
}

// Mean USD cost per decide over every entry that actually carries usage (schema-invalid/errored
// calls with no envelope usage are excluded from the average, never treated as $0) — null (never
// NaN) when none do.
export function meanCostUsd(
  entries: readonly {
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
    readonly model: string;
  }[],
  overrides: Readonly<Record<string, ModelRate>> | undefined,
): number | null {
  const withUsage = entries.filter(
    (e): e is { usage: { inputTokens: number; outputTokens: number }; model: string } =>
      e.usage !== null,
  );
  if (withUsage.length === 0) return null;
  const total = withUsage.reduce(
    (sum, e) => sum.plus(callCostUsd(e.usage, resolveRate(e.model, overrides))),
    new Decimal(0),
  );
  return total.div(withUsage.length).toNumber();
}
