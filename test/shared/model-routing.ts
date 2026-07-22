// Shared LLM model routing + token pricing — RESEARCH TOOLING (test/, off the production gate).
//
// ONE implementation of "which endpoint/key/pacing does model X use, and what does one call cost",
// imported by BOTH research lanes rather than copied into each:
//   • test/eval/agentic/* — the recorded-row head-to-head eval (via trade-eval-fixtures.ts, which
//     re-exports every symbol here so its own callers' imports are unchanged).
//   • test/backtest/agentic-replay.ts — the LLM-in-the-loop walk-forward backtest.
// Extracted 2026-07-22 from trade-eval-fixtures.ts when the backtest gained per-model routing: a
// second copy of the key-resolution rule is exactly the shape that ships an Anthropic org key to a
// third-party host the moment one copy drifts (see resolveRouteFrom's own comment on that rule).
//
// SECRETS (CLAUDE.md rule 7): routes name an env-var NAME (apiKeyEnv), never a key value, so a key
// never appears inside the routes JSON itself. Nothing here logs, echoes, or serializes a key — the
// returned ModelRoute carries it solely for the caller's own auth header.
//
// LANE-NEUTRAL BY CONSTRUCTION: no module in this directory reads process.env at import time and
// none is a *.spec.ts, so neither `pnpm test`, `pnpm backtest`, nor `pnpm eval:agentic` sweeps it up
// as a suite — it is import-only, the same convention test/eval/agentic/fixtures.ts follows.
import Decimal from 'decimal.js';
import { z } from 'zod';

// ── Routing ──────────────────────────────────────────────────────────────────

export interface ModelRoute {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly callDelayMs: number;
  // Callers send both x-api-key and Bearer auth when not default — the compat surface's wire auth
  // header is not uniformly documented (Bearer vs x-api-key); sending both on an overridden base is
  // harmless and removes a whole failure branch.
  readonly isDefaultBase: boolean;
}

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

// .strict(): an unrecognized field here is a typo about to leak the wrong key (e.g. `apiKeyEnv`
// misspelled falls through to the default-key fallback below and ships the Anthropic org key to the
// routed third-party host), never a benign extra — the token-price schema's .passthrough()
// precedent deliberately does not transfer to a route object.
const modelRouteSchema = z.record(
  z.string().min(1),
  z
    .object({
      baseUrl: z.string().min(1).optional(),
      // env-var-NAME indirection, not a key value — the actual API key comes from
      // env[apiKeyEnv] at resolve time, so a key never appears inside the JSON itself.
      apiKeyEnv: z.string().min(1).optional(),
      callDelayMs: z.number().nonnegative().optional(),
    })
    .strict(),
);

export type ModelRoutes = z.infer<typeof modelRouteSchema>;

// Parses a routes JSON blob (shape: { [model]: { baseUrl?, apiKeyEnv?, callDelayMs? } }). Malformed
// JSON/shape THROWS, naming `label` (the env var the blob came from) so the operator can find it —
// a malformed routing value must fail the running test, never silently fall back to the default
// route and bill the wrong endpoint. Absent/empty ⇒ {} (no routes, every model takes the defaults).
export function parseModelRoutes(raw: string | undefined, label: string): ModelRoutes {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = modelRouteSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`${label} failed validation: ${issues}`);
  }
  return result.data;
}

export interface RouteDefaults {
  // Where env[apiKeyEnv] is looked up. Injectable so a caller (or a test) never has to mutate the
  // real process.env to exercise a route.
  readonly env: Record<string, string | undefined>;
  // Used only when the model's route names NO baseUrl of its own — see resolveRouteFrom's rule.
  readonly fallbackApiKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly callDelayMs?: number;
}

// One model's effective route, from an already-parsed routes map plus the caller's defaults.
//
// KEY RULE (fails CLOSED): a per-model route that names its own baseUrl (a third-party host) must
// ALSO name its own apiKeyEnv explicitly — it never falls back to the caller's default key, which
// would transmit the Anthropic org key to that third-party host. A route with no baseUrl of its own
// keeps the default-key fallback chain.
export function resolveRouteFrom(
  model: string,
  routes: ModelRoutes,
  defaults: RouteDefaults,
): ModelRoute {
  const route = routes[model];
  const baseUrl = (route?.baseUrl ?? defaults.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(
    /\/+$/,
    '',
  );
  const apiKey = route?.baseUrl
    ? route.apiKeyEnv
      ? defaults.env[route.apiKeyEnv]
      : undefined
    : route?.apiKeyEnv
      ? defaults.env[route.apiKeyEnv]
      : defaults.fallbackApiKey;
  const callDelayMs = route?.callDelayMs ?? defaults.callDelayMs ?? 0;
  return { baseUrl, apiKey, callDelayMs, isDefaultBase: baseUrl === DEFAULT_ANTHROPIC_BASE_URL };
}

// The env var name a model's key must be set under, for an operator-facing "you forgot to export X"
// message. Returns the route's own apiKeyEnv when it names one, else null (the caller's own default
// key channel supplies it) — NEVER the key value itself.
export function apiKeyEnvNameFor(model: string, routes: ModelRoutes): string | null {
  return routes[model]?.apiKeyEnv ?? null;
}

// The eval lane's env-var convention, unchanged from its pre-extraction form (AGENTIC_EVAL_*):
// callers there pass only the model id. Kept as a named wrapper rather than inlined at each call
// site so the eval's four env knobs stay described in exactly one place.
export function resolveModelRoute(
  model: string,
  env: Record<string, string | undefined> = process.env,
): ModelRoute {
  const routes = parseModelRoutes(
    env['AGENTIC_EVAL_MODEL_ROUTES_JSON'],
    'AGENTIC_EVAL_MODEL_ROUTES_JSON',
  );
  const globalCallDelayMs = env['AGENTIC_EVAL_CALL_DELAY_MS'];
  // The global knob is parsed ONLY when this model's own route does not name a delay — a per-model
  // callDelayMs shadows it entirely, so a malformed (and therefore unused) global must not fail a
  // run it could not have affected.
  const routeNamesDelay = routes[model]?.callDelayMs !== undefined;
  let callDelayMs: number | undefined;
  if (!routeNamesDelay && globalCallDelayMs !== undefined) {
    const parsedDelay = Number(globalCallDelayMs);
    // Malformed env fails the run, never silently falls back — a dropped delay hammers a
    // rate-limited paid endpoint (same throw-inside-the-run convention as the JSON parse above).
    if (!Number.isFinite(parsedDelay) || parsedDelay < 0) {
      throw new Error(
        `AGENTIC_EVAL_CALL_DELAY_MS must be a finite number >= 0, got "${globalCallDelayMs}"`,
      );
    }
    callDelayMs = parsedDelay;
  }
  return resolveRouteFrom(model, routes, {
    env,
    fallbackApiKey: env['AGENTIC_EVAL_API_KEY'] ?? env['ANTHROPIC_API_KEY'],
    baseUrl: env['AGENTIC_EVAL_BASE_URL'],
    ...(callDelayMs !== undefined ? { callDelayMs } : {}),
  });
}

// ── Token pricing ────────────────────────────────────────────────────────────

export interface ModelRate {
  readonly input: number;
  readonly output: number;
  // Cache-tier $/MTok. ABSENT ⇒ callCostUsd prices cache tokens at the model's own INPUT rate: the
  // only consumer of this number is a hard $ budget cap, and a spend gate fails CLOSED — an unknown
  // cache tier must over-price (abort early), never under-price (overspend past the cap).
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

// Current published Anthropic per-1M-token USD rates (see https://www.anthropic.com/pricing —
// verify before trusting cost output, these drift). Cache tiers follow Anthropic's own published
// ratios for the 1h TTL this program's clients use: read = 0.1x input, write = 2x input.
const DEFAULT_TOKEN_PRICES_PER_MTOK: Readonly<Record<string, ModelRate>> = {
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
};
// Sonnet-tier fallback for a model id absent from both the override map and the defaults above —
// this is a toy cost estimate (never a promotion input), so failing OPEN to a mid-tier guess rather
// than throwing keeps the run going; every scorecard names the model AND the rate it used, so a
// wrong guess is visible, not silent.
export const FALLBACK_RATE: ModelRate = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 };

const decimalStringLocal = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string');
const tokenPriceOverrideSchema = z
  .record(
    z.string().min(1),
    z
      .object({
        inputPerMtok: decimalStringLocal,
        outputPerMtok: decimalStringLocal,
        // Optional: a third-party compat endpoint usually has no prompt-cache tier at all, and
        // guessing Anthropic's ratios for one would be a fabricated number. Omitted ⇒ ModelRate's
        // own fail-closed input-rate substitution above.
        cacheReadPerMtok: decimalStringLocal.optional(),
        cacheWritePerMtok: decimalStringLocal.optional(),
      })
      .passthrough(),
  )
  .optional();

// Parses an AGENTIC_TOKEN_PRICES_JSON-shaped blob (same env var/shape as the production knob).
// Called from inside a running test/run only: a malformed value must fail that run, not throw
// during collection.
export function parseTokenPriceOverrides(
  raw: string | undefined,
  label = 'AGENTIC_TOKEN_PRICES_JSON',
): Readonly<Record<string, ModelRate>> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = tokenPriceOverrideSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`${label} failed validation: ${issues}`);
  }
  if (!result.data) return undefined;
  const out: Record<string, ModelRate> = {};
  for (const [model, rates] of Object.entries(result.data)) {
    out[model] = {
      input: Number(rates.inputPerMtok),
      output: Number(rates.outputPerMtok),
      ...(rates.cacheReadPerMtok !== undefined
        ? { cacheRead: Number(rates.cacheReadPerMtok) }
        : {}),
      ...(rates.cacheWritePerMtok !== undefined
        ? { cacheWrite: Number(rates.cacheWritePerMtok) }
        : {}),
    };
  }
  return out;
}

export function resolveRate(
  model: string,
  overrides: Readonly<Record<string, ModelRate>> | undefined,
): ModelRate {
  return overrides?.[model] ?? DEFAULT_TOKEN_PRICES_PER_MTOK[model] ?? FALLBACK_RATE;
}

const MTOK = new Decimal(1_000_000);

export interface CallUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  // Absent on models/routes without prompt caching — contribute nothing rather than being guessed.
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
}

// Decimal throughout: this feeds a $ budget ledger that decides when to stop spending, so the
// arithmetic stays off native-float accumulation even though the rates themselves are plain numbers
// read off a JSON knob.
export function callCostUsd(usage: CallUsage, rate: ModelRate): Decimal {
  const cacheRead = rate.cacheRead ?? rate.input;
  const cacheWrite = rate.cacheWrite ?? rate.input;
  return new Decimal(usage.inputTokens)
    .div(MTOK)
    .mul(rate.input)
    .plus(new Decimal(usage.outputTokens).div(MTOK).mul(rate.output))
    .plus(new Decimal(usage.cacheReadInputTokens ?? 0).div(MTOK).mul(cacheRead))
    .plus(new Decimal(usage.cacheCreationInputTokens ?? 0).div(MTOK).mul(cacheWrite));
}

// Mean USD cost per decide over every entry that actually carries usage (schema-invalid/errored
// calls with no envelope usage are excluded from the average, never treated as $0) — null (never
// NaN) when none do.
export function meanCostUsd(
  entries: readonly { readonly usage: CallUsage | null; readonly model: string }[],
  overrides: Readonly<Record<string, ModelRate>> | undefined,
): number | null {
  const withUsage = entries.filter(
    (e): e is { usage: CallUsage; model: string } => e.usage !== null,
  );
  if (withUsage.length === 0) return null;
  const total = withUsage.reduce(
    (sum, e) => sum.plus(callCostUsd(e.usage, resolveRate(e.model, overrides))),
    new Decimal(0),
  );
  return total.div(withUsage.length).toNumber();
}
