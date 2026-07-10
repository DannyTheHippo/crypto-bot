import * as crypto from 'crypto';
import { z } from 'zod';
import type { AppConfig, TradingMode, VenueConfig } from '../../ports/app-config';

export type { AppConfig, TradingMode } from '../../ports/app-config';

const LIVE_CREDENTIAL_KEYS = [
  'BINANCE_LIVE_API_KEY',
  'BINANCE_LIVE_API_SECRET',
  'ARMING_SECRET',
  'LIVE_BASE_URL_OVERRIDE',
] as const;

const PINO_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

const VENUE_ENVIRONMENTS = ['paper', 'testnet', 'demo', 'live'] as const;

const CANDLE_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;

// Money/decimal-string knobs (RiskLimitsConfig fields + BASE_NOTIONAL): plain non-negative decimal
// strings, validated here and converted to Decimal only where the consuming module already does so
// (domain/risk/limits.ts) — never a native float on a money path.
const decimalString = z.string().regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string');
// Fraction knob (SIZER_EQUITY_FRACTION): a plain decimalString would accept '2' (200% of equity per
// entry) — the bounded regex rejects anything above 1 at parse time, never via a float compare.
const fractionString = z
  .string()
  .regex(/^(0(\.\d+)?|1(\.0+)?)$/, 'must be a decimal string between 0 and 1 inclusive');
// Positive decimal knob (PERP_LEVERAGE_CAP): a plain decimalString accepts '0', which zeroes the
// divisor in every margin/liqPrice computation in PaperPerpAdapter (openOrAdd, liqPrice) — fail
// closed at parse time instead of surfacing as a division-by-zero deep in the adapter.
const positiveDecimalString = decimalString.refine(
  (v) => !/^0+(\.0+)?$/.test(v),
  'must be a positive decimal string',
);

function isTestOrCiEnv(env: Record<string, string | undefined>): boolean {
  const nodeEnv = env['NODE_ENV'] ?? '';
  return nodeEnv === 'test' || nodeEnv === 'ci' || Boolean(env['CI']);
}

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === 'object') {
    Object.freeze(obj);
    for (const key of Object.keys(obj)) {
      const val = (obj as Record<string, unknown>)[key];
      if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
        deepFreeze(val);
      }
    }
  }
  return obj;
}

function canonicalJsonWithoutSecrets(config: AppConfig): string {
  // DATABASE_URL contains credentials — excluded from hash like other secrets.
  const secretFields = new Set([
    'liveApiKey',
    'liveApiSecret',
    'armingSecret',
    'liveBaseUrlOverride',
    'bootId',
    'db',
  ]);
  const sanitized: Record<string, unknown> = {};

  function copyNonSecret(src: Record<string, unknown>, dst: Record<string, unknown>) {
    const keys = Object.keys(src).sort();
    for (const k of keys) {
      if (secretFields.has(k)) continue;
      const v = src[k];
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        dst[k] = {};
        copyNonSecret(v as Record<string, unknown>, dst[k] as Record<string, unknown>);
      } else {
        dst[k] = v;
      }
    }
  }

  copyNonSecret(config as unknown as Record<string, unknown>, sanitized);
  return JSON.stringify(sanitized);
}

const tradingModeValues = ['paper', 'testnet', 'live'] as const;

// Per-model token-price entries (AGENTIC_TOKEN_PRICES_JSON). All four rates required per model —
// a partial entry would silently price the missing component at $0, the exact fail-open hole the
// map exists to close. Parsed fail-LOUD (throws into validate()'s error path), unlike parseVenues'
// silent-drop: a malformed price map corrupts the promotion gate's cost math.
const tokenPriceEntrySchema = z.object({
  inputPerMtok: decimalString,
  outputPerMtok: decimalString,
  cacheReadPerMtok: decimalString,
  cacheWritePerMtok: decimalString,
});
const tokenPricesSchema = z.record(z.string().min(1), tokenPriceEntrySchema);

function parseTokenPrices(
  raw: string | undefined,
): Readonly<Record<string, z.infer<typeof tokenPriceEntrySchema>>> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `AGENTIC_TOKEN_PRICES_JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = tokenPricesSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`AGENTIC_TOKEN_PRICES_JSON failed validation: ${issues}`);
  }
  return result.data;
}

const venueConfigSchema = z.object({
  id: z.string().min(1),
  environment: z.enum(VENUE_ENVIRONMENTS),
  baseUrlOverride: z.string().optional(),
});

// Venues are configured via JSON in VENUES env var: '[{"id":"binance","environment":"paper"}]'
// Default is empty array (paper-safe: no live venues configured).
function parseVenues(env: Record<string, string | undefined>): readonly VenueConfig[] {
  const raw = env['VENUES'];
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const result: VenueConfig[] = [];
    for (const item of parsed) {
      const v = venueConfigSchema.safeParse(item);
      if (v.success) result.push(v.data);
    }
    return result;
  } catch {
    return [];
  }
}

const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    LOG_LEVEL: z.enum(PINO_LEVELS).default('info'),
    TRADING_MODE: z.string().optional(),
    NODE_ENV: z.string().optional(),
    CI: z.string().optional(),
    DATABASE_URL: z.string().min(1).optional(),
    VENUES: z.string().optional(),
    // §3.5 sandbox flavor for testnet mode: 'testnet' (setSandboxMode) or 'demo' (enableDemoTrading).
    // Inert unless TRADING_MODE=testnet. Default 'demo' (live-mirroring dress rehearsal; the keys this
    // deployment ships are BINANCE_DEMO_*). Set SANDBOX_ENV=testnet for the testnet.binance.vision sandbox.
    SANDBOX_ENV: z.enum(['testnet', 'demo']).default('demo'),
    // Agentic lane knobs — validated here so a later composition pass can read them off ConfigService
    // instead of process.env, without renaming. ANTHROPIC_API_KEY deliberately excluded (secret; stays
    // out of AppConfig per the live-secret-stripping precedent above).
    // Default matches the AGENTIC_TOKEN_PRICE_* defaults below (Sonnet-5 at 3/15): an unconfigured
    // deployment previously defaulted to Opus while the earned-live verdict priced its tokens at
    // Sonnet rates — understating LLM cost inside a promotion gate (fail-OPEN direction).
    AGENTIC_MODEL: z.string().min(1).default('claude-sonnet-5'),
    // Reflection-path model override. Absent ⇒ reflection uses AGENTIC_MODEL (one model, one price).
    // If you pin a PRICIER model here, set both AGENTIC_TOKEN_PRICE_* knobs to that model's rates —
    // the flat pricing then OVER-counts decide-path cost, which is the fail-closed direction.
    AGENTIC_REFLECTION_MODEL: z.string().min(1).optional(),
    AGENTIC_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    // Reflection-path request timeout, DELIBERATELY separate from (and much larger than) the decide
    // timeout above. Reflection runs AGENTIC_REFLECTION_MODEL (a pricier tier, e.g. Opus) with
    // adaptive thinking over a large calibration/attribution prompt; the 30s decide timeout aborted
    // every live attempt (2026-07-09: "transport error: This operation was aborted"), stranding the
    // learning loop at the seed playbook. Off the trading hot path (reflection is detached), so
    // headroom is free — 240s buys margin against Opus worst-case rather than a tight wall-clock guess.
    AGENTIC_REFLECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(240000),
    AGENTIC_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
    AGENTIC_MIN_DECISION_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
    AGENTIC_WARMUP_BARS: z.coerce.number().int().positive().default(50),
    AGENTIC_MAX_CALLS_PER_DAY: z.coerce.number().int().positive().default(500),
    AGENTIC_MAX_TOKENS_PER_DAY: z.coerce.number().int().positive().default(2_000_000),
    // Daily USD cost circuit breaker for the LLM budget (agent-budget.ts's DailyLlmBudget), priced
    // off AGENTIC_TOKEN_PRICE_*PER_MTOK below at the same rate the promotion-readiness cost math
    // uses. 0 disables it. Not .int(): a dollar cap is legitimately fractional.
    AGENTIC_DAILY_COST_STOP_USD: z.coerce.number().min(0).default(3),
    // W2.1 stale-entry sweep: a resting entry older than this many observed decide cycles gets a
    // CANCEL_OPEN (risk-reducing; SignalSink routes it to an order-cancel). 0 disables.
    AGENTIC_ENTRY_TTL_BARS: z.coerce.number().int().min(0).default(2),
    // W3.1 plan-based trading: the LLM emits a full trade plan (entry offset, stop, take-profit,
    // validity) via submit_plan and plan-executor.ts manages it deterministically between consults.
    // Off by default — enabling is gated on offline A/B evidence + owner approval (approved plan).
    AGENTIC_PLAN_MODE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Fee-aware plan viability floor: a plan is rejected when takeProfitPct < multiple × the
    // round-trip fee fraction (maker+taker bps / 10000). Decimal string — money-adjacent math.
    AGENTIC_MIN_EDGE_MULTIPLE: decimalString.default('1.5'),
    // R:R structure floor: a plan is rejected when takeProfitPct / stopLossPct < this ratio.
    // minEdgeMultiple floors only the WIN side; without this, a stop may sit below the round-trip
    // fee itself (measured live: avg win +$0.06 vs avg loss -$0.21 — payoff 0.29:1).
    AGENTIC_MIN_RR: decimalString.default('1.5'),
    // Safety re-consult cadence while a plan is active without executor action.
    AGENTIC_PLAN_MAX_QUIET_BARS: z.coerce.number().int().min(1).default(16),
    // TTL in bars for plan-executor-emitted EXIT signals. Executor exits carry eventTime = the
    // evaluated bar's close, so ttl = one bar loses the race against its own age on any ≥2s jitter
    // (observed live 2026-07-07: a max_hold exit EXPIRED at age 902.2s vs ttl 900s). Min 2.
    AGENTIC_PLAN_EXIT_TTL_BARS: z.coerce.number().int().min(2).default(2),
    // Sample the decide-time input payload every Nth plan-managed (quiet) bar so the offline
    // replay harness accrues rows under plan mode (which otherwise journals inputPayload: null on
    // every managed bar). 0 (default) disables — no journal-volume change unconfigured.
    AGENTIC_QUIET_PAYLOAD_SAMPLE_BARS: z.coerce.number().int().min(0).default(0),
    AGENTIC_MAX_ENTRIES_PER_DAY: z.coerce.number().int().positive().default(12),
    AGENTIC_DRAIN_COOLDOWN_BASE_MS: z.coerce.number().int().positive().default(30_000),
    AGENTIC_DRAIN_COOLDOWN_MAX_MS: z.coerce.number().int().positive().default(900_000),
    // 0 disables periodic reflection.
    AGENTIC_REFLECTION_EVERY_N_TRADES: z.coerce.number().int().min(0).default(10),
    // Minimum wall-clock between reflection attempts (F7 tunable). Default 7 days; floored at 0. A
    // cost/noise throttle, never a safety gate — see reflection.service.ts's SEVEN_DAYS_MS comment.
    AGENTIC_REFLECTION_COOLDOWN_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(7 * 24 * 60 * 60 * 1000),
    // Absent means unpinned — no default (an explicit default would look like a pin).
    AGENTIC_PLAYBOOK_PIN: z.coerce.number().int().positive().optional(),
    // W4.1 champion/candidate A/B: percent (0-50) of decides deterministically routed to a newer
    // INACTIVE reflection-minted candidate (see PlaybookAbRoutingProvider, app.module.ts) instead of
    // the resolved ACTIVE version, so per-version PnL attribution accrues candidate evidence before
    // promotion. 0 (default) disables routing — every decide sees ACTIVE, byte-identical to pre-W4.1.
    // Capped at 50 so a candidate can never outweigh the active version's own evidence share.
    AGENTIC_PLAYBOOK_AB_PCT: z.coerce.number().int().min(0).max(50).default(0),
    // Cumulative closed-trade floor before a reflection candidate auto-promotes to ACTIVE (G4b); 0
    // (default) disables auto-promotion — see reflection.service.ts's autoPromoteMinTrades comment.
    // LEGACY count-only path: superseded by AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES below (the
    // count-only gate promotes on LANE-WIDE trade count with zero candidate-attributed evidence).
    AGENTIC_AUTO_PROMOTE_MIN_TRADES: z.coerce.number().int().min(0).default(0),
    // Attributed auto-promotion (owner decision 2026-07-08): the promotion evaluator promotes a
    // reflection candidate only once the CANDIDATE's own attributed closed trips reach this floor
    // AND its mean net/trip (realized − fees) beats the champion's over the same trailing window.
    // 0 (default) disables the evaluator.
    AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES: z.coerce.number().int().min(0).default(0),
    // PromotionReadinessService LLM-cost math: USD per 1M tokens, operator-adjustable (claude-sonnet-5
    // list prices as of this writing) — same stance as the Grafana cost-panel variables.
    AGENTIC_TOKEN_PRICE_INPUT_PER_MTOK: decimalString.default('3'),
    AGENTIC_TOKEN_PRICE_OUTPUT_PER_MTOK: decimalString.default('15'),
    // Cache-token pricing for the default model: reads ~0.1x input, 1h-TTL writes ~2x input
    // (claude-sonnet-5 list: 0.3 / 6). Priced $0 before W4/W13 — understated true spend inside a
    // promotion gate (fail-open direction); now first-class in llmCostUsd + the daily breaker.
    AGENTIC_TOKEN_PRICE_CACHE_READ_PER_MTOK: decimalString.default('0.3'),
    AGENTIC_TOKEN_PRICE_CACHE_WRITE_PER_MTOK: decimalString.default('6'),
    // Per-model price override map, JSON: {"<model-id>": {"inputPerMtok": "5", "outputPerMtok":
    // "25", "cacheReadPerMtok": "0.5", "cacheWritePerMtok": "10"}, ...}. Mandatory for gate honesty
    // the moment reflectionModel ≠ model — flat pricing under-counts a pricier reflection model.
    // Absent models fall back to the flat knobs above; unknown models in cost rows price at the
    // MOST EXPENSIVE configured rates (fail-closed). Validated below; a malformed value fails boot.
    AGENTIC_TOKEN_PRICES_JSON: z.string().optional(),
    // Owner-declared evidence epoch (ISO-8601 instant, e.g. 2026-07-08T12:00:00Z): the promotion
    // gate evaluates fills/tokens/window from this instant instead of all-time, so post-fix
    // evidence judges the post-fix configuration (owner decision 2026-07-08). Absent/'' ⇒ all-time.
    PROMOTION_EVIDENCE_EPOCH: z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), 'must be an ISO-8601 timestamp')
      .optional(),
    // Residual-position notional (quote ccy) below which PromotionReadinessService's round-trip walk
    // considers a cycle CLOSED — historical pre-IOC cycles carry dust remainders that would otherwise
    // never close. Default '5' mirrors BTC/USDT's exchange minNotional.
    PROMOTION_DUST_NOTIONAL: decimalString.default('5'),
    // Cost-floor pre-screen gate: a cheap indicator check consulted before each LLM call so a quiet
    // market never burns a token spend on a call the agent was always going to pass on. 'true'/'false'
    // (not z.coerce.boolean(): Boolean('false') === true would invert an explicit disable).
    AGENTIC_PRESCREEN_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    AGENTIC_PRESCREEN_VOL_SHORT_BARS: z.coerce.number().int().positive().default(10),
    AGENTIC_PRESCREEN_VOL_LONG_BARS: z.coerce.number().int().positive().default(50),
    AGENTIC_PRESCREEN_VOL_RATIO: z.coerce.number().positive().default(1.3),
    AGENTIC_PRESCREEN_BREAKOUT_LOOKBACK_BARS: z.coerce.number().int().positive().default(20),
    AGENTIC_PRESCREEN_BREAKOUT_PCT: z.coerce.number().positive().default(0.005),
    // W4.2 expectancy-laddered strength modulation: scales ENTER_LONG signal strength by this
    // strategy's rolling realized net expectancy — reduction-only (never raises strength above what
    // the LLM proposed). 'true'/'false' (not z.coerce.boolean(), same rationale as
    // AGENTIC_PRESCREEN_ENABLED above). Default 'false': an unconfigured deployment sees zero
    // behavior change.
    AGENTIC_EXPECTANCY_LADDER: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Marketable-exit crossing buffer (bps) for reduce-only intents (PositionSizerService): how far
    // the IOC limit crosses the spread so a partial fill doesn't leave sub-minNotional dust resting
    // away from market. Capped at 99 (< DEFAULT_LIMITS.maxBandBps=100 in risk.module) so a crossed
    // exit price never trips domain/risk/evaluate.ts's price-band veto.
    EXIT_CROSS_BUFFER_BPS: z.coerce.number().int().min(0).max(99).default(25),
    // Quote-currency (USDT) notional per order. Default 100 matches the deployed .env — the prior
    // in-code fallback of '1000' (risk.module.ts/app.module.ts) was drift, never an intended default.
    BASE_NOTIONAL: decimalString.default('100'),
    // Compounding position sizing (P5): fraction of current equity sized per entry, scaled further by
    // signal strength. '0' (default) disables the fractional path — PositionSizerService falls back to
    // the legacy baseNotional × strength sizing unchanged, so an unconfigured deployment sees zero
    // behavior change.
    SIZER_EQUITY_FRACTION: fractionString.default('0'),
    // ProtectiveExitService (bot-side stop-loss/trailing-stop backstop): fraction below avgEntry
    // (stop) or below the ratcheted high-water mark (trailing) that force-exits a long via the normal
    // Strategy→Risk→Execution path (an EXIT_LONG Signal, never a direct execution call). '0' (default)
    // disables each independently — an unconfigured deployment sees zero behavior change.
    PROTECT_STOP_LOSS_PCT: fractionString.default('0'),
    PROTECT_TRAILING_PCT: fractionString.default('0'),
    // RiskLimitsConfig overlay knobs (domain/risk/limits.ts) — RiskModule merges these onto
    // DEFAULT_LIMITS. Defaults equal the CURRENT hardcoded values, so an unconfigured deployment sees
    // zero behavior change. maxDriftBps has no knob in this pass; it stays hardcoded in DEFAULT_LIMITS.
    RISK_MAX_ORDER_NOTIONAL: decimalString.default('100000'),
    RISK_MAX_POSITION_PER_SYMBOL: decimalString.default('1000'),
    RISK_MAX_GROSS_EXPOSURE: decimalString.default('1000000'),
    RISK_MAX_NET_EXPOSURE: decimalString.default('1000000'),
    RISK_MAX_DAILY_LOSS: decimalString.default('5000'),
    RISK_MAX_DRAWDOWN_PCT: decimalString.default('0.2'),
    RISK_MAX_BAND_BPS: z.coerce.number().int().positive().default(100),
    RISK_STALE_MAX_AGE_MS: z.coerce.number().int().positive().default(5000),
    // Perp/swap paper adapter knobs (B1: PaperPerpAdapter, not yet wired into app.module.ts).
    // 'true'/'false' (not z.coerce.boolean(), same rationale as AGENTIC_PRESCREEN_ENABLED above).
    // Default 'false': an unconfigured deployment sees zero behavior change.
    PERP_VENUE_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    PERP_LEVERAGE_CAP: positiveDecimalString.default('1'),
    // Conservative fallback maintenance-margin-rate (see PaperPerpAdapter's why-comment on the
    // TODO fetchLeverageTiers wiring): ≈0.005 for the 1-2× BTC/ETH bracket at time of writing.
    PERP_MMR_FALLBACK: decimalString.default('0.005'),
    // B2: required liquidation-price buffer (fraction of price) a perp entry's liq price must
    // clear at PERP_LEVERAGE_CAP/PERP_MMR_FALLBACK — domain/risk/perp-sizing.ts's
    // liqSafeNotionalCap. '0.20' default (liq at least 20% away) is deliberately conservative;
    // moot until a perp-venue Signal exists (B1's adapter is unwired), so this default changes
    // nothing observable yet.
    PERP_LIQ_BUFFER_PCT: fractionString.default('0.20'),
    // Strategy-lane knobs. ACTIVE_STRATEGY is a closed enum: 'agentic' is the only registered lane
    // (the deterministic pure lane was retired 2026-07-03).
    TRADING_SYMBOL: z.string().min(1).default('BTC/USDT'),
    // Multi-symbol (P7): CSV of symbols, one agentic strategy instance per entry. Absent ⇒ falls
    // back to [TRADING_SYMBOL] (which is thereby deprecated but still honored). Every entry must
    // have a DEFAULT_FILTERS row — asserted loud at startTrading before any enable.
    TRADING_SYMBOLS: z
      .string()
      .min(1)
      .transform((raw) =>
        raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      )
      .refine((symbols) => symbols.length > 0, 'TRADING_SYMBOLS must name at least one symbol')
      .refine(
        (symbols) => new Set(symbols).size === symbols.length,
        'TRADING_SYMBOLS entries must be unique',
      )
      .optional(),
    STRATEGY_INTERVAL: z.enum(CANDLE_INTERVALS).default('5m'),
    ACTIVE_STRATEGY: z.enum(['agentic']).default('agentic'),
  })
  .superRefine((data, ctx) => {
    // The prescreen gate (prescreen.ts) needs AGENTIC_WARMUP_BARS bars of history before its
    // vol/breakout windows are full — if warmup is shorter than either window, hasEnoughData is
    // false on every single bar post-warmup too, so evaluatePrescreen permanently returns
    // insufficient_data (fail-open: every bar consults the LLM) and the cost-floor gate silently
    // no-ops while AGENTIC_PRESCREEN_ENABLED still reads true. Only checked when the gate is
    // actually enabled — a disabled gate never reads these windows.
    if (!data.AGENTIC_PRESCREEN_ENABLED) return;
    if (
      data.AGENTIC_WARMUP_BARS < data.AGENTIC_PRESCREEN_VOL_LONG_BARS ||
      data.AGENTIC_WARMUP_BARS < data.AGENTIC_PRESCREEN_BREAKOUT_LOOKBACK_BARS
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AGENTIC_WARMUP_BARS'],
        message:
          `AGENTIC_WARMUP_BARS (${data.AGENTIC_WARMUP_BARS}) must be >= ` +
          `AGENTIC_PRESCREEN_VOL_LONG_BARS (${data.AGENTIC_PRESCREEN_VOL_LONG_BARS}) and >= ` +
          `AGENTIC_PRESCREEN_BREAKOUT_LOOKBACK_BARS (${data.AGENTIC_PRESCREEN_BREAKOUT_LOOKBACK_BARS}) ` +
          `— otherwise the prescreen gate never sees enough history and permanently fail-opens ` +
          `(insufficient_data every bar), silently no-opping the cost floor.`,
      });
    }
  });

// dotenv/compose convention: `VAR=` (empty assignment) means UNSET, not "the empty string". Without
// this strip an emptied optional knob crashes the boot — zod v4 coerces '' to NaN (AGENTIC_PLAYBOOK_PIN=
// took the deployed bot down on 2026-07-06) and the decimal-string knobs would fail their regex the
// same way. ALSO unset: values that are nothing but a leaked inline comment — docker compose's
// env_file parser strips `value # comment` correctly but turns `VAR= # comment` into the literal
// string '# comment' (verified via `docker compose config` on the same outage). A '#'-leading value
// can never be a legitimate knob here (no secret or symbol starts with '#'), so it is treated as
// the empty assignment it was meant to be. Stripping before parse makes both shapes fall through to
// each field's default/optional handling.
//
// Mutates IN PLACE, deliberately: validate() has a load-bearing mutate-the-caller contract — the
// test/ci live-credential strip below deletes secret keys from the SAME record the caller handed in
// (config-override.spec.ts asserts this). A copy here would silently break that strip: the secrets
// would be deleted from the copy while surviving in the caller's env.
function stripEmptyValues(env: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(env)) {
    if (v === '' || (v !== undefined && v.trimStart().startsWith('#'))) delete env[k];
  }
}

export function validate(env: Record<string, string | undefined>): AppConfig {
  stripEmptyValues(env);
  const isTestOrCi = isTestOrCiEnv(env);
  const rawMode = env['TRADING_MODE'] ?? '';

  let configMode: TradingMode;
  const downgrades: string[] = [];

  if (isTestOrCi) {
    configMode = 'paper';
    if (rawMode !== '' && rawMode !== 'paper') {
      downgrades.push(`NODE_ENV/CI override: forced paper (was "${rawMode}")`);
    }
  } else if (tradingModeValues.includes(rawMode as TradingMode)) {
    configMode = rawMode as TradingMode;
  } else {
    configMode = 'paper';
    if (rawMode !== '') {
      downgrades.push(`invalid TRADING_MODE "${rawMode}": resolved to paper`);
    }
  }

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Config validation failed: ${issues}`);
  }

  const {
    PORT: port,
    LOG_LEVEL: logLevel,
    DATABASE_URL: dbUrl,
    SANDBOX_ENV: sandboxEnv,
    AGENTIC_MODEL: agenticModel,
    AGENTIC_REFLECTION_MODEL: agenticReflectionModel,
    AGENTIC_TIMEOUT_MS: agenticTimeoutMs,
    AGENTIC_REFLECTION_TIMEOUT_MS: agenticReflectionTimeoutMs,
    AGENTIC_MAX_TOKENS: agenticMaxTokens,
    AGENTIC_MIN_DECISION_INTERVAL_MS: agenticMinDecisionIntervalMs,
    AGENTIC_WARMUP_BARS: agenticWarmupBars,
    AGENTIC_MAX_CALLS_PER_DAY: agenticMaxCallsPerDay,
    AGENTIC_MAX_TOKENS_PER_DAY: agenticMaxTokensPerDay,
    AGENTIC_DAILY_COST_STOP_USD: agenticDailyCostStopUsd,
    AGENTIC_ENTRY_TTL_BARS: agenticEntryTtlBars,
    AGENTIC_MAX_ENTRIES_PER_DAY: agenticMaxEntriesPerDay,
    AGENTIC_DRAIN_COOLDOWN_BASE_MS: agenticDrainCooldownBaseMs,
    AGENTIC_DRAIN_COOLDOWN_MAX_MS: agenticDrainCooldownMaxMs,
    AGENTIC_REFLECTION_EVERY_N_TRADES: agenticReflectionEveryNTrades,
    AGENTIC_REFLECTION_COOLDOWN_MS: agenticReflectionCooldownMs,
    AGENTIC_PLAYBOOK_PIN: agenticPlaybookPin,
    AGENTIC_PLAYBOOK_AB_PCT: agenticPlaybookAbPct,
    AGENTIC_AUTO_PROMOTE_MIN_TRADES: agenticAutoPromoteMinTrades,
    AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES: agenticAutoPromoteMinAttributedTrades,
    AGENTIC_TOKEN_PRICE_INPUT_PER_MTOK: agenticTokenPriceInputPerMtok,
    AGENTIC_TOKEN_PRICE_OUTPUT_PER_MTOK: agenticTokenPriceOutputPerMtok,
    AGENTIC_TOKEN_PRICE_CACHE_READ_PER_MTOK: agenticTokenPriceCacheReadPerMtok,
    AGENTIC_TOKEN_PRICE_CACHE_WRITE_PER_MTOK: agenticTokenPriceCacheWritePerMtok,
    AGENTIC_TOKEN_PRICES_JSON: agenticTokenPricesJson,
    PROMOTION_EVIDENCE_EPOCH: promotionEvidenceEpoch,
    PROMOTION_DUST_NOTIONAL: promotionDustNotional,
    AGENTIC_PRESCREEN_ENABLED: agenticPrescreenEnabled,
    AGENTIC_PRESCREEN_VOL_SHORT_BARS: agenticPrescreenVolShortBars,
    AGENTIC_PRESCREEN_VOL_LONG_BARS: agenticPrescreenVolLongBars,
    AGENTIC_PRESCREEN_VOL_RATIO: agenticPrescreenVolRatio,
    AGENTIC_PRESCREEN_BREAKOUT_LOOKBACK_BARS: agenticPrescreenBreakoutLookbackBars,
    AGENTIC_PRESCREEN_BREAKOUT_PCT: agenticPrescreenBreakoutPct,
    AGENTIC_EXPECTANCY_LADDER: agenticExpectancyLadder,
    AGENTIC_PLAN_MODE: agenticPlanMode,
    AGENTIC_MIN_EDGE_MULTIPLE: agenticMinEdgeMultiple,
    AGENTIC_MIN_RR: agenticMinRr,
    AGENTIC_PLAN_MAX_QUIET_BARS: agenticPlanMaxQuietBars,
    AGENTIC_PLAN_EXIT_TTL_BARS: agenticPlanExitTtlBars,
    AGENTIC_QUIET_PAYLOAD_SAMPLE_BARS: agenticQuietPayloadSampleBars,
    EXIT_CROSS_BUFFER_BPS: exitCrossBufferBps,
    BASE_NOTIONAL: baseNotional,
    SIZER_EQUITY_FRACTION: sizerEquityFraction,
    PROTECT_STOP_LOSS_PCT: protectStopLossPct,
    PROTECT_TRAILING_PCT: protectTrailingPct,
    RISK_MAX_ORDER_NOTIONAL: riskMaxOrderNotional,
    RISK_MAX_POSITION_PER_SYMBOL: riskMaxPositionPerSymbol,
    RISK_MAX_GROSS_EXPOSURE: riskMaxGrossExposure,
    RISK_MAX_NET_EXPOSURE: riskMaxNetExposure,
    RISK_MAX_DAILY_LOSS: riskMaxDailyLoss,
    RISK_MAX_DRAWDOWN_PCT: riskMaxDrawdownPct,
    RISK_MAX_BAND_BPS: riskMaxBandBps,
    RISK_STALE_MAX_AGE_MS: riskStaleMaxAgeMs,
    PERP_VENUE_ENABLED: perpVenueEnabled,
    PERP_LEVERAGE_CAP: perpLeverageCap,
    PERP_MMR_FALLBACK: perpMmrFallback,
    PERP_LIQ_BUFFER_PCT: perpLiqBufferPct,
    TRADING_SYMBOL: tradingSymbol,
    TRADING_SYMBOLS: tradingSymbols,
    STRATEGY_INTERVAL: strategyInterval,
    ACTIVE_STRATEGY: activeStrategy,
  } = parsed.data;
  const bootId = crypto.randomUUID();
  const venues = parseVenues(env);

  // Live secrets are read into the validated config ONLY outside test/ci. Under test/ci they are
  // both stripped from env (below) AND never read here, so the AppConfig object cannot carry a live
  // credential — the in-code backstop behind the four gates (§10), independent of the env strip.
  const liveFields = isTestOrCi
    ? {}
    : {
        liveApiKey: env['BINANCE_LIVE_API_KEY'],
        liveApiSecret: env['BINANCE_LIVE_API_SECRET'],
        armingSecret: env['ARMING_SECRET'],
        liveBaseUrlOverride: env['LIVE_BASE_URL_OVERRIDE'],
      };

  const partialConfig: Omit<AppConfig, 'configHash'> = {
    app: { port, bootId },
    mode: { requestedMode: rawMode, configMode, sandboxEnv, downgrades },
    observability: { logLevel },
    db: { url: dbUrl },
    venues,
    agentic: {
      model: agenticModel,
      reflectionModel: agenticReflectionModel,
      timeoutMs: agenticTimeoutMs,
      reflectionTimeoutMs: agenticReflectionTimeoutMs,
      maxTokens: agenticMaxTokens,
      minDecisionIntervalMs: agenticMinDecisionIntervalMs,
      warmupBars: agenticWarmupBars,
      maxCallsPerDay: agenticMaxCallsPerDay,
      maxTokensPerDay: agenticMaxTokensPerDay,
      dailyCostStopUsd: agenticDailyCostStopUsd,
      entryTtlBars: agenticEntryTtlBars,
      maxEntriesPerDay: agenticMaxEntriesPerDay,
      drainCooldownBaseMs: agenticDrainCooldownBaseMs,
      drainCooldownMaxMs: agenticDrainCooldownMaxMs,
      reflectionEveryNTrades: agenticReflectionEveryNTrades,
      reflectionCooldownMs: agenticReflectionCooldownMs,
      autoPromoteMinTrades: agenticAutoPromoteMinTrades,
      autoPromoteMinAttributedTrades: agenticAutoPromoteMinAttributedTrades,
      playbookPin: agenticPlaybookPin,
      playbookAbPct: agenticPlaybookAbPct,
      tokenPriceInputPerMtok: agenticTokenPriceInputPerMtok,
      tokenPriceOutputPerMtok: agenticTokenPriceOutputPerMtok,
      tokenPriceCacheReadPerMtok: agenticTokenPriceCacheReadPerMtok,
      tokenPriceCacheWritePerMtok: agenticTokenPriceCacheWritePerMtok,
      tokenPrices: parseTokenPrices(agenticTokenPricesJson),
      promotionEvidenceEpoch,
      promotionDustNotional,
      prescreenEnabled: agenticPrescreenEnabled,
      prescreenVolShortBars: agenticPrescreenVolShortBars,
      prescreenVolLongBars: agenticPrescreenVolLongBars,
      prescreenVolRatio: agenticPrescreenVolRatio,
      prescreenBreakoutLookbackBars: agenticPrescreenBreakoutLookbackBars,
      prescreenBreakoutPct: agenticPrescreenBreakoutPct,
      expectancyLadderEnabled: agenticExpectancyLadder,
      planMode: agenticPlanMode,
      minEdgeMultiple: agenticMinEdgeMultiple,
      planMaxQuietBars: agenticPlanMaxQuietBars,
      minRr: agenticMinRr,
      planExitTtlBars: agenticPlanExitTtlBars,
      quietPayloadSampleBars: agenticQuietPayloadSampleBars,
    },
    risk: {
      exitCrossBufferBps,
      baseNotional,
      equityFraction: sizerEquityFraction,
      protectStopLossPct,
      protectTrailingPct,
      maxOrderNotional: riskMaxOrderNotional,
      maxPositionPerSymbol: riskMaxPositionPerSymbol,
      maxGrossExposure: riskMaxGrossExposure,
      maxNetExposure: riskMaxNetExposure,
      maxDailyLoss: riskMaxDailyLoss,
      maxDrawdownPct: riskMaxDrawdownPct,
      maxBandBps: riskMaxBandBps,
      staleMaxAgeMs: riskStaleMaxAgeMs,
    },
    perp: {
      enabled: perpVenueEnabled,
      leverageCap: perpLeverageCap,
      mmrFallback: perpMmrFallback,
      liqBufferPct: perpLiqBufferPct,
    },
    strategy: {
      symbol: tradingSymbol,
      // TRADING_SYMBOLS wins; the legacy single TRADING_SYMBOL is the one-element fallback.
      symbols: tradingSymbols ?? [tradingSymbol],
      interval: strategyInterval,
      active: activeStrategy,
    },
    ...liveFields,
  };

  const configHash = crypto
    .createHash('sha256')
    .update(
      canonicalJsonWithoutSecrets({
        ...partialConfig,
        configHash: '',
      }),
    )
    .digest('hex');

  const appConfig: AppConfig = {
    ...partialConfig,
    configHash,
  };

  if (isTestOrCi) {
    for (const key of LIVE_CREDENTIAL_KEYS) {
      delete env[key];
      delete process.env[key];
    }
  }

  return deepFreeze(appConfig);
}

export { deepFreeze };
