import * as crypto from 'crypto';
import { z } from 'zod';
import Decimal from 'decimal.js';
import type { AppConfig, TradingMode, VenueConfig } from '../../ports/common/app-config';
import { AGENTIC_MAX_STOP_LOSS_PCT } from '../../domain/trading/risk/agentic-bounds';
import { liqSafeNotionalCap } from '../../domain/trading/risk/perp-sizing';
import { EDGE_POLICY_TRIAL_FAMILY_IDS } from '../../ports/strategy/agentic-strategy';
import { splitSymbol } from '../../domain/venue/types/symbol';
import { symbolId } from '../../domain/common/types/ids';

export type { AppConfig, TradingMode } from '../../ports/common/app-config';

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
// (domain/trading/risk/limits.ts) — never a native float on a money path.
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

// v3 §1.2: the two fixed venue ids this program ever wires. Single source for the config layer's
// own venue-resolution needs (VENUES-coverage + VENUE_CAPITAL_SPLIT refusals below).
const SPOT_VENUE_ID = 'binance';
const PERP_VENUE_ID = 'binanceusdm';

// v3-transitional(#5): mirrors spec §1.2's venueForSymbol pure helper (settle-suffix check).
// Workstream #5 mints the authoritative src/domain/venue/types/venue-map.ts copy this converges on; this
// local copy exists so the config layer's own cross-field refusals (VENUES coverage,
// VENUE_CAPITAL_SPLIT key-set, AGENTIC_PLAN_MODE-vs-perp) can resolve a symbol's venue without
// reaching into composition-layer code (config stays upstream of every feature, eslint-boundaries).
function venueIdForSymbol(symbol: string): string {
  return splitSymbol(symbolId(symbol)).settle !== undefined ? PERP_VENUE_ID : SPOT_VENUE_ID;
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

// v3 §3.1: fixed wallet split of the one book, JSON {"binance":"500","binanceusdm":"500"}. Parsed
// fail-LOUD (mirrors AGENTIC_TOKEN_PRICES_JSON's parseTokenPrices below), unlike parseVenues'
// silent-drop — a malformed split corrupts the sizer's venue-headroom clamp (§6.1), never a
// silently-empty map. Positivity is enforced per-share here; the key-set-vs-VENUES and
// sum-vs-SIZER_EQUITY_CAP checks are cross-field and run later in validate().
const venueCapitalSplitSchema = z.record(z.string().min(1), positiveDecimalString);

function parseVenueCapitalSplit(raw: string): Readonly<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `VENUE_CAPITAL_SPLIT is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = venueCapitalSplitSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`VENUE_CAPITAL_SPLIT failed validation: ${issues}`);
  }
  return result.data;
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
    // v3 §3.1: fixed wallet split of the one book across VENUES. Default matches the deployed v3
    // shape (both venues demo, 500/500 of the $1k SIZER_EQUITY_CAP). Cross-field checks (key-set vs
    // VENUES, Σ vs SIZER_EQUITY_CAP) run in validate() below, once venues/equityCap are resolved.
    VENUE_CAPITAL_SPLIT: z.string().default('{"binance":"500","binanceusdm":"500"}'),
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
    // learning loop at the seed playbook. Since backlog #32 the reflection call STREAMS (SSE), so
    // this value is the IDLE-gap budget (aborts when no chunk arrives for this long — liveness, not
    // total duration) plus a 3× hard cap on the whole call; a healthy long generation keeps
    // emitting deltas and never trips it, removing the wall-clock guess about Opus's worst case.
    AGENTIC_REFLECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(240000),
    // v3 §3.2 default: 1024→4096 — the rich decision contract's richer per-consult output (directives,
    // thesis, portfolio scheduling) needs the headroom the deployed shape already carried.
    AGENTIC_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
    AGENTIC_MIN_DECISION_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
    AGENTIC_WARMUP_BARS: z.coerce.number().int().positive().default(50),
    // v3 §3.3: the two lane-split caps (500/1100-ish per lane) merge into one book-wide cap —
    // 500→2000 (was two ~1000-ish lane caps summed).
    AGENTIC_MAX_CALLS_PER_DAY: z.coerce.number().int().positive().default(2000),
    // v3 §3.3: two lane-split token caps merge into one — 2,000,000→4,000,000.
    AGENTIC_MAX_TOKENS_PER_DAY: z.coerce.number().int().positive().default(4_000_000),
    // Daily USD cost circuit breaker for the LLM budget (agent-budget.ts's DailyLlmBudget), priced
    // off AGENTIC_TOKEN_PRICE_*PER_MTOK below at the same rate the promotion-readiness cost math
    // uses. 0 disables it. Not .int(): a dollar cap is legitimately fractional.
    AGENTIC_DAILY_COST_STOP_USD: z.coerce.number().min(0).default(3),
    // W2.1 stale-entry sweep: a resting entry older than this many observed decide cycles gets a
    // CANCEL_OPEN (risk-reducing; SignalSink routes it to an order-cancel). 0 disables.
    AGENTIC_ENTRY_TTL_BARS: z.coerce.number().int().min(0).default(2),
    // v3 §3.1/§3.3: the two lane-split AGENTIC_MAX_POSITION_FRACTION knobs (spot 0.15 / perp 0.35 /
    // 0.50 depending on deployment) collapse into one process's two per-venue-class caps — upper
    // bound on sizeFraction, injected into both the trade-tool description and the client's zod
    // schema (S3), now per-symbol via the payload's capabilities.maxSizeFraction (§4.2).
    AGENTIC_MAX_POSITION_FRACTION_SPOT: fractionString.default('0.15'),
    AGENTIC_MAX_POSITION_FRACTION_PERP: fractionString.default('0.35'),
    // v2 consult scheduler (B2, replaces the deleted prescreen gate): a portfolio schedule normally
    // drives consult cadence (the model's own nextConsultBars), but this is the FLOOR — a re-consult
    // fires at least this often even if the model requested a longer gap or the schedule stalls, so a
    // stuck/quiet basket never goes fully dark. Default 16→8 (XA1 2026-07-20, v3 §3.2 default): 16
    // (4h) starved evidence pace at the deployed cadence — 8 (2h) is the v3 floor.
    AGENTIC_FALLBACK_CONSULT_BARS: z.coerce.number().int().min(1).default(8),
    // v2 consult scheduler (B2): wake-on-move — a bar close whose |close − lastConsultPrice| /
    // lastConsultPrice clears this fraction forces an immediate re-consult regardless of schedule,
    // closing the reaction gap on a fast move mid-quiet-period. Default 0.015→0.008 (XA1 2026-07-20,
    // v3 §3.2 default): 1.5% never fired in the dominant sub-0.5% chop regime.
    AGENTIC_WAKE_MOVE_PCT: fractionString.default('0.008'),
    // W3.1 plan-based trading: the LLM emits a full trade plan (entry offset, stop, take-profit,
    // validity) via submit_plan and plan-executor.ts manages it deterministically between consults.
    // v3 §3.2 default: false→true — the only deployed shape; the rich decision contract, shorts, and
    // venue rails all require it (see the AGENTIC_PLAN_MODE-vs-perp-symbol refusal in validate()
    // below, §3.5). AGENTIC_SHORTS_ENABLED is DELETED (§3.4): shorts are now a per-symbol capability
    // derived from venue presence (agentic.shortsEnabled below is a transitional derived field, not
    // an env knob).
    AGENTIC_PLAN_MODE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    // TTL in bars for plan-executor-emitted EXIT signals. Executor exits carry eventTime = the
    // evaluated bar's close, so ttl = one bar loses the race against its own age on any ≥2s jitter
    // (observed live 2026-07-07: a max_hold exit EXPIRED at age 902.2s vs ttl 900s). Min 2.
    AGENTIC_PLAN_EXIT_TTL_BARS: z.coerce.number().int().min(2).default(2),
    // Sample the decide-time input payload every Nth plan-managed (quiet) bar so the offline
    // replay harness accrues rows under plan mode (which otherwise journals inputPayload: null on
    // every managed bar). 0 (default) disables — no journal-volume change unconfigured.
    AGENTIC_QUIET_PAYLOAD_SAMPLE_BARS: z.coerce.number().int().min(0).default(0),
    // Venue-resting take-profit lifecycle for plan-mode longs: rests the plan's TP at the venue
    // (reduce-only EXIT_LONG, exitStyle RESTING) instead of waiting for plan-executor's own
    // close-price crossing to fire an IOC exit. v3 §3.2 default: false→true (the only deployed
    // shape). The v2 "both TP+STOP only if all venues perp" refusal is RETIRED (§3.5) — mixed-venue
    // boots are the v3 norm and the mutual-exclusion rule is structurally unenforceable on them; a
    // per-symbol rule (perp rests both legs, spot rests TP-only) replaces it in the strategy lane
    // (workstream #10), not here.
    AGENTIC_VENUE_TP: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    // Re-place threshold (bps): a resting TP SELL priced more than this many bps away from the
    // plan's current TP price gets cancelled this bar for next-bar re-placement.
    AGENTIC_VENUE_TP_REPLACE_DRIFT_BPS: z.coerce.number().int().positive().default(10),
    // Push 3 P7d: venue-resting protective stop lifecycle for plan-mode positions — rests the plan's
    // stop at the venue (SPOT: STOP_LOSS_LIMIT on the regular open-orders rail; PERP: STOP_MARKET on
    // the swap algo/conditional rail) instead of relying solely on the executor's own bar-close
    // stop-price crossing. v3 §3.2 default: false→true (the only deployed shape) — see AGENTIC_VENUE_TP
    // above for the retired mutual-exclusion refusal.
    AGENTIC_VENUE_STOP: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    // Re-place threshold (bps), mirrors AGENTIC_VENUE_TP_REPLACE_DRIFT_BPS above.
    AGENTIC_VENUE_STOP_REPLACE_DRIFT_BPS: z.coerce.number().int().positive().default(10),
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
    // AGENTIC_DERIVATIVES_AB_PCT DELETED (§3.4, XA3 2026-07-20 decision record): the information-
    // context control arm is retired at 0 — treatment drove 8.4% vs 1.9% proposes, so every consult
    // gets the full info bundle now. agentic.derivativesAbPct below is a transitional derived field
    // (hardcoded 0), not an env knob.
    // d2 (Push 3 P6 Unit 1): switches the derivatives block/sentence/promptHash tag from d1 to d2,
    // adding three fields the feed ALREADY accumulates whenever it polls (true spot-vs-perp basis,
    // OI percent change over a 1h lookback, funding-rate trend) — see derivatives-feed.service.ts's
    // V2_LOOKBACK_MS comment. Inert unless DERIVATIVES_FEED_ENABLED is also on. 'true'/'false' (not
    // z.coerce.boolean(), same rationale as AGENTIC_PORTFOLIO_CONSULT below). Default 'false' ⇒
    // byte-identical d1 behavior. ENABLING MID-FACTORIAL IS FORBIDDEN — never flip this while an A/B
    // or offline sweep is comparing d1-tagged rows against a baseline; see agent-prompt.ts's
    // DERIVATIVES_V2_TEMPLATE_VERSION comment for why the two template versions are not
    // cross-comparable (d1 and d2 render structurally different payload blocks).
    AGENTIC_DERIVATIVES_V2_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Cross-symbol relative-strength context (2026-07-12): when true, each agentic instance records
    // its symbol's trailing return into a shared basket and the model sees where its symbol ranks
    // (see cross-symbol-context.ts). The strongest signal found in the 2026-07-12 multi-strategy
    // search — for a spot long-only lane it means concentrating longs in relatively strong symbols
    // and avoiding laggards. Gated together with the derivatives block under the information-context
    // A/B (AGENTIC_DERIVATIVES_AB_PCT). Default false ⇒ byte-identical to pre-feature. 'true'/
    // 'false' (not z.coerce.boolean() — that idiom is Boolean(input): the string 'false' coerces to
    // true, silently ENABLING the flag on the documented off-value; fixed 2026-07-18, was the only
    // z.coerce.boolean() flag in this schema), same rationale as AGENTIC_PORTFOLIO_CONSULT below.
    AGENTIC_CROSS_SYMBOL_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Trailing-return lookback (bars) for the cross-symbol ranking. Default 20 (the winning
    // cross-sectional lookback from the search). Bounded to keep it inside typical warmup windows.
    AGENTIC_CROSS_SYMBOL_LOOKBACK_BARS: z.coerce.number().int().min(2).max(200).default(20),
    // Book-structure block (Push 3 P6 Unit 3): microprice offset from mid, depth-weighted top-10
    // imbalance, and ±25bps depth notional — computed from the ALREADY-STREAMING order book, no new
    // feed/cost. Does NOT ride the information-context A/B (see agent-prompt.ts's own comment). 'true'/
    // 'false' (not z.coerce.boolean(), same rationale as AGENTIC_PORTFOLIO_CONSULT below). Default
    // 'false' ⇒ byte-identical to pre-feature.
    AGENTIC_BOOK_STRUCTURE_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Track-record block (Push 3 P6 Unit 4, #17 residual): surfaces this strategy's own realized
    // tripCount/winRate/meanNetBpsPerTrip/trailingWindowTrips over the SAME trailing window/floor the
    // renamed TRACK_RECORD_* consts define (agentic.strategy.ts — B3 deleted the expectancy ladder
    // outright; these consts were renamed, not removed, and now feed this block only) — a decide-side
    // read, inert without a RoundTripEvidencePort wired. Does NOT ride the information-context A/B.
    // 'true'/'false' (not z.coerce.boolean(), same rationale as above). Default 'false' ⇒
    // byte-identical to pre-feature.
    AGENTIC_TRACK_RECORD_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Phase 4 (Profitability Edge Program): tournament-derived systematic edge policy — off by default.
    // 'true'/'false' (not z.coerce.boolean(), same rationale as AGENTIC_TRACK_RECORD_ENABLED above).
    // Default 'false' ⇒ DisabledEdgePolicy bound, byte-identical runtime.
    AGENTIC_EDGE_POLICY_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Selected trial family. Empty/unset ⇒ 'none'. No winner calculator registered ⇒ fail-closed
    // inactive at runtime even when enabled (see disabled-edge-policy.ts).
    AGENTIC_EDGE_POLICY_FAMILY: z
      .string()
      .default('none')
      .transform((v) => (v === '' ? 'none' : v))
      .pipe(z.enum([...EDGE_POLICY_TRIAL_FAMILY_IDS, 'none'])),
    // Portfolio-consult batching (Push II Phase 5, DESIGN Task 2): coalesces the up-to-5 concurrent
    // single-symbol propose() calls landing within one window into ONE Anthropic call via
    // BatchingAgentClient/submit_portfolio, instead of 5 separate submit_decision calls. 'true'/
    // 'false' (not z.coerce.boolean(), same rationale as AGENTIC_PLAN_MODE above). Default
    // 'false': an unconfigured deployment sees zero behavior change — BatchingAgentClient is not
    // even constructed (see agentic-strategy.module.ts's selectAgentClient).
    AGENTIC_PORTFOLIO_CONSULT: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Coalescing window (ms): the first propose() call to arrive opens it; every call arriving
    // before it closes (or before all configured symbols have checked in, whichever first) joins
    // the same batch. Inert unless AGENTIC_PORTFOLIO_CONSULT is on.
    AGENTIC_PORTFOLIO_WINDOW_MS: z.coerce.number().int().positive().default(3000),
    // AGENTIC_AUTO_PROMOTE_MIN_TRADES DELETED (§3.4): the legacy count-only auto-promotion path
    // (promoted on LANE-WIDE trade count with zero candidate-attributed evidence) is superseded by
    // AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES below. agentic.autoPromoteMinTrades is a
    // transitional derived field (hardcoded 0 — permanently disabled), not an env knob.
    // Mint-time candidate-vs-champion offline expectancy backtest (reflection.service.ts's
    // runMintBacktest): rows of the newest recorded decisions (regardless of action) replayed against
    // BOTH the draft candidate and the current champion playbook, simulating each 'long' plan's
    // outcome. 0 (default) disables it entirely — a brand-new, LLM-call-doubling knob (2 arms × rows
    // calls per mint attempt) defaults OFF for any unconfigured deployment, like other experimental
    // knobs; this deployment's docker-compose.yml opts in explicitly. NOTE: reflection.service.ts's
    // createReflectionService reads this off raw process.env (same convention as the mint-floor
    // knobs below, which have no schema entry at all) rather than through this validated field —
    // this schema entry exists so the knob is documented/bounded/configHash-visible, not because the
    // reflection wiring consumes AppConfig.agentic.mintBacktestRows directly.
    AGENTIC_MINT_BACKTEST_ROWS: z.coerce.number().int().min(0).default(0),
    // Noise HANDICAP (bps), not a beat-the-champion hurdle: the candidate mints unless its mean net
    // bps/trip trails the champion's by MORE than this (candidate >= champion − margin passes);
    // trailing by more is treated exactly like a floor rejection.
    AGENTIC_MINT_BACKTEST_MARGIN_BPS: z.coerce.number().int().min(0).default(10),
    // Minimum simulated round trips BOTH arms need before the backtest verdict is trusted — below
    // this the sample is too thin to judge and the backtest fails open (mint proceeds unbacktested).
    AGENTIC_MINT_BACKTEST_MIN_TRIPS: z.coerce.number().int().min(0).default(3),
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
    // W4 audit (2026-07-18): strict full ISO-8601 UTC instant with a time component and trailing Z.
    // A bare Date.parse accepted a date-only string ('2026-07-18'), silently resolving to midnight
    // UTC — an evidence window hours off the owner's intended flat instant. The gate must refuse an
    // ambiguous epoch at construction (gate-honesty refusal, fails CLOSED), never guess a time.
    PROMOTION_EVIDENCE_EPOCH: z
      .string()
      .refine(
        (v) =>
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v) &&
          !Number.isNaN(Date.parse(v)),
        'must be a full ISO-8601 UTC instant with a time component and trailing Z (e.g. 2026-07-18T15:36:14Z)',
      )
      .optional(),
    // Residual-position notional (quote ccy) below which PromotionReadinessService's round-trip walk
    // considers a cycle CLOSED — historical pre-IOC cycles carry dust remainders that would otherwise
    // never close. Default '5' mirrors BTC/USDT's exchange minNotional.
    PROMOTION_DUST_NOTIONAL: decimalString.default('5'),
    // Universe: top-N ranking size the deterministic UniverseScannerService (U1) selects daily from
    // the full TRADING_SYMBOLS basket as the "active menu" batched into consults; idle (non-menu)
    // instances still stream candles/warm up but never consult. Bounded ≤ basket size below (a menu
    // wider than the basket is nonsensical config, refused at construction). v3 §3.2/§3.3 default:
    // 12→8 — the two lane-split menu sizes (12 spot / 4 perp) collapse into one combined-basket menu
    // (§5.2's starvation-check arithmetic: 8 clears the ≥2.14 closed-trips/day promotion pace with
    // headroom while staying inside the unified $3/day cost breaker).
    AGENTIC_ACTIVE_MENU_SIZE: z.coerce.number().int().min(1).default(8),
    // Marketable-exit crossing buffer (bps) for reduce-only intents (PositionSizerService): how far
    // the IOC limit crosses the spread so a partial fill doesn't leave sub-minNotional dust resting
    // away from market. Capped at 99 (< DEFAULT_LIMITS.maxBandBps=100 in risk.module) so a crossed
    // exit price never trips domain/trading/risk/evaluate.ts's price-band veto.
    EXIT_CROSS_BUFFER_BPS: z.coerce.number().int().min(0).max(99).default(25),
    // Entry order type (PositionSizerService). 'LIMIT' (default) is byte-identical to pre-knob
    // behavior. 'LIMIT_MAKER' rests entries post-only (maker-fee, never taker) — the sizer falls
    // back to plain LIMIT per-intent when the plan-derived entry price would cross the book (a
    // post-only order priced there is venue-rejected). A residual at-touch/moved-book cross still
    // rejects, but fails safely (TERMINAL_REJECT, no blind resubmit; strategy re-fires).
    ENTRY_ORDER_TYPE: z.enum(['LIMIT', 'LIMIT_MAKER']).default('LIMIT'),
    // Quote-currency (USDT) notional per order. Default 100 matches the deployed .env — the prior
    // in-code fallback of '1000' (risk.module.ts/app.module.ts) was drift, never an intended default.
    BASE_NOTIONAL: decimalString.default('100'),
    // Compounding position sizing (P5): fraction of current equity sized per entry, scaled further by
    // signal strength. '0' (default) disables the fractional path — PositionSizerService falls back to
    // the legacy baseNotional × strength sizing unchanged, so an unconfigured deployment sees zero
    // behavior change.
    SIZER_EQUITY_FRACTION: fractionString.default('0'),
    // $1k-book economics (Design § Live-scale economics): sizing equity = min(actualEquity, this
    // cap) on every sizer path, so every position/PnL figure/promotion verdict is earned at exactly
    // live proportions even while the demo account itself carries a larger balance. v3 §3.2 default:
    // now DEFAULTED (was optional/uncapped) — the $1k effective book is the program constraint, not
    // an opt-in; explicit '0' still disables the cap (position-sizer.service.ts's cappedEquity()
    // already treats a non-positive cap as pass-through, so '0' stays a legitimate escape hatch).
    SIZER_EQUITY_CAP: decimalString.default('1000'),
    // Profitability Edge Program: aggregate planned-stop entry risk cap — max same-side cost
    // notional = cappedEquity × fraction / Signal.stopLossPct (held |qty|×avgEntry + reserved +
    // proposed). '0' (default) disables — byte-identical when Signal.stopLossPct is also absent.
    SIZER_MAX_PLANNED_STOP_RISK_FRACTION: fractionString.default('0'),
    // ProtectiveExitService (bot-side stop-loss/trailing-stop backstop): fraction below avgEntry
    // (stop) or below the ratcheted high-water mark (trailing) that force-exits a long via the normal
    // Strategy→Risk→Execution path (an EXIT_LONG Signal, never a direct execution call). '0' (default)
    // disables each independently — an unconfigured deployment sees zero behavior change.
    PROTECT_STOP_LOSS_PCT: fractionString.default('0'),
    PROTECT_TRAILING_PCT: fractionString.default('0'),
    // Plan-stop watcher (Push 3 P2): when true, ProtectiveExitService's 1s tick consults the
    // plan-stop registry (ports/trading/risk.ts's PlanStopRegistryPort, populated by AgenticStrategy on plan
    // entry-fill) for each live position BEFORE the global stop/trailing logic above, firing the
    // SAME EXIT_LONG/EXIT_SHORT path off the plan's own stop price instead of avgEntry/hwm. Default
    // 'false' — the registry is never consulted, byte-identical to pre-feature. Rollback = flip back
    // to 'false'.
    PLAN_STOP_WATCH_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Force-fire threshold (bps): a registry entry whose venueStopResting is true stands down unless
    // the breach beyond the plan's stop exceeds this many bps (a resting venue stop should already
    // have filled at a small breach; a wide miss means the venue-side order failed). Inert while
    // PLAN_STOP_WATCH_ENABLED is false.
    PLAN_STOP_FORCE_BPS: z.coerce.number().int().min(0).default(30),
    // RiskLimitsConfig overlay knobs (domain/trading/risk/limits.ts) — RiskModule merges these onto
    // DEFAULT_LIMITS. v3 §3.2 defaults: re-defaulted to the $1k-book scale (the deployed v2-contract
    // values were pre-$1k-book drift) — an unconfigured deployment now inherits the book-scale
    // envelope directly instead of the legacy pre-D1 figures. maxDriftBps has no knob in this pass;
    // it stays hardcoded in DEFAULT_LIMITS.
    RISK_MAX_ORDER_NOTIONAL: decimalString.default('400'),
    RISK_MAX_POSITION_PER_SYMBOL: decimalString.default('350'),
    RISK_MAX_GROSS_EXPOSURE: decimalString.default('1200'),
    RISK_MAX_NET_EXPOSURE: decimalString.default('1200'),
    RISK_MAX_DAILY_LOSS: decimalString.default('50'),
    RISK_MAX_DRAWDOWN_PCT: decimalString.default('0.2'),
    RISK_MAX_BAND_BPS: z.coerce.number().int().positive().default(100),
    // P2 passive-exit override (domain/trading/risk/limits.ts): a reduce-only intent priced on the passive
    // side of ref (a resting take-profit) checks against this wider band instead of
    // RISK_MAX_BAND_BPS. Default 1200 (12%) covers plan-mode TP offsets well beyond the tight
    // RISK_MAX_BAND_BPS=100 (1%) that would otherwise veto every resting exit.
    RISK_MAX_PASSIVE_EXIT_BAND_BPS: z.coerce.number().int().positive().default(1200),
    // P7b protective-stop trigger checks (domain/trading/risk/evaluate.ts's hasTrigger branch): a trigger
    // order's |trigger − mid| / mid must be ≤ this (basis points). Default 2000 (20%) — wide enough
    // for a deliberately distant stop, tight enough to catch a badly-priced trigger as a bug.
    RISK_MAX_STOP_TRIGGER_BAND_BPS: z.coerce.number().int().positive().default(2000),
    // P7b: a spot STOP_LOSS_LIMIT's limit leg sits this many bps past its own trigger (buffered so
    // the leg is immediately marketable once the trigger fires — PositionSizerService); evaluate.ts's
    // T3 check then requires the leg to stay within 2× this many bps of the trigger (sanity). Capped
    // at 200 (2%) — a wider buffer would leave the leg unmarketable-adjacent on a fast move.
    STOP_LIMIT_BUFFER_BPS: z.coerce.number().int().positive().max(200).default(50),
    RISK_STALE_MAX_AGE_MS: z.coerce.number().int().positive().default(5000),
    // Owner-authorized 2026-07-22 recovery program: whether a HALTED/HALTED_DEGRADED kill switch
    // (RecoveryCoordinatorService), a daily-loss/drawdown halt (EquityMonitorService's own
    // cause-clearing), or an OPERATOR-provenance strategy drain (a healthy decide, strategy-host.ts)
    // may auto-resume/auto-clear once their own fail-closed preconditions confirm cleared, without a
    // human gate. Default true — the safety mechanism is the per-cause + universal preconditions and
    // debounce, NOT this flag; setting it 'false' reproduces exactly today's manual-only behavior.
    RECOVERY_AUTO_RESUME_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    // PERP_VENUE_ENABLED DELETED (§3.4): venue presence in VENUES is the signal now — a perp-capable
    // deployment is defined by VENUES containing binanceusdm, never a separate boot flag.
    // v3 §3.2 default: 1→2 (owner round 6, "perp gets leverage to a 2x cap") — the deployed perp
    // value; existing margin-notional and liq-safe caps with the 20% liquidation buffer stay
    // authoritative on top.
    PERP_LEVERAGE_CAP: positiveDecimalString.default('2'),
    // Conservative fallback maintenance-margin-rate (see PaperPerpAdapter's why-comment on the
    // TODO fetchLeverageTiers wiring): ≈0.005 for the 1-2× BTC/ETH bracket at time of writing — ONE
    // flat figure applied to every configured symbol, which increasingly understates real per-symbol
    // MMR as the perp basket widens past BTC/ETH toward ~16 symbols (fail-SAFE direction regardless:
    // an early paper liquidation, never a missed one — see the adapter's own comment).
    PERP_MMR_FALLBACK: decimalString.default('0.005'),
    // B2: required liquidation-price buffer (fraction of price) a perp entry's liq price must
    // clear at PERP_LEVERAGE_CAP/PERP_MMR_FALLBACK — domain/trading/risk/perp-sizing.ts's
    // liqSafeNotionalCap. '0.20' default (liq at least 20% away) is deliberately conservative;
    // moot until a perp-venue Signal exists (B1's adapter is unwired), so this default changes
    // nothing observable yet.
    PERP_LIQ_BUFFER_PCT: fractionString.default('0.20'),
    // Strategy-lane knobs. ACTIVE_STRATEGY is a closed enum: 'agentic' is the only registered lane
    // (the deterministic pure lane was retired 2026-07-03). TRADING_SYMBOL (the legacy single-symbol
    // fallback) is DELETED (§3.4) — TRADING_SYMBOLS is now required OUTSIDE TEST/CI (validate()
    // below throws there when absent; test/ci falls back to ['BTC/USDT'], matching every other
    // test/ci-exempt knob in this file so the hermetic suite's many real-module boots stay green).
    // Multi-symbol (P7): CSV of symbols, one agentic strategy instance per entry. Every entry must
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
    // C1: read-only public derivatives-data feed (funding rate, open interest, mark/index basis),
    // surfaced to the agentic prompt when fresh. Off by default — zero behavior change unconfigured.
    // 'true'/'false' (not z.coerce.boolean()), same rationale as AGENTIC_PLAN_MODE above.
    DERIVATIVES_FEED_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    DERIVATIVES_FEED_POLL_MS: z.coerce.number().int().positive().default(60_000),
    // P5b: perp funding-payment settlement ingestion (funding-ingest.service.ts). Off by default —
    // zero behavior change unconfigured. Same 'true'/'false' convention as DERIVATIVES_FEED_ENABLED.
    FUNDING_INGEST_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Hourly default — funding settles at most 3x/day on Binance USDM; hourly polling is comfortably
    // inside that cadence while staying resilient to a single missed poll.
    FUNDING_INGEST_POLL_MS: z.coerce.number().int().positive().default(3_600_000),
    // C4: read-only free news/sentiment feed (headlines only), surfaced to the agentic prompt when
    // fresh. Off by default — zero behavior change unconfigured. SENTIMENT_FEED_API_KEY deliberately
    // excluded from this schema (secret; stays out of AppConfig per the ANTHROPIC_API_KEY precedent
    // above) — read directly off process.env in the app.module.ts factory, never logged/hashed.
    SENTIMENT_FEED_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    SENTIMENT_FEED_POLL_MS: z.coerce.number().int().positive().default(300_000),
    // X3a: read-only Crypto Fear & Greed Index (alternative.me), surfaced to the agentic prompt when
    // fresh. Off by default — zero behavior change unconfigured. Lane-wide (not per-symbol), same
    // convention as SENTIMENT_FEED_ENABLED above; no API key required (a public endpoint).
    FEAR_GREED_FEED_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // 6h default — the index updates roughly once a day upstream; polling far more often than that
    // is wasted (see fear-greed-feed.ts's own header comment).
    FEAR_GREED_POLL_MS: z.coerce.number().int().positive().default(21_600_000),
    // Trade-flow/CVD context (taker aggressor imbalance), surfaced to the agentic prompt when fresh.
    // Off by default — zero behavior change unconfigured. Rides the SAME information-context A/B
    // control arm as DERIVATIVES_FEED_ENABLED/AGENTIC_CROSS_SYMBOL_ENABLED above.
    AGENTIC_TRADEFLOW_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    AGENTIC_TRADEFLOW_POLL_MS: z.coerce.number().int().positive().default(60_000),
    // Positioning context (global long/short account ratio), surfaced to the agentic prompt when
    // fresh. Off by default — zero behavior change unconfigured. Same A/B convention as above.
    // Liquidation-order flow was NOT shippable via this REST-poll knob — no public REST source in
    // ccxt 4.5.58 (see positioning-feed.ts's header comment) — but IS shipped separately below via a
    // WS subscription (AGENTIC_LIQUIDATIONS_ENABLED), which the original brief had deferred pending
    // verification that ccxt PRO's watchLiquidationsForSymbols was usable (Push 3 P6 Unit 2).
    AGENTIC_POSITIONING_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    AGENTIC_POSITIONING_POLL_MS: z.coerce.number().int().positive().default(300_000),
    // #43 (Push 3 P6 Unit 2): public liquidation-order flow (rolling notional + long/short side-skew)
    // via ccxt PRO's watchLiquidationsForSymbols WS stream on binanceusdm — surfaced to the agentic
    // prompt when the stream is healthy. Off by default — zero behavior change unconfigured. No poll
    // interval knob (WS-driven, not REST-polled); rides the SAME information-context A/B control arm
    // as the feeds above.
    AGENTIC_LIQUIDATIONS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Order-book memory bound (normalize.ts's normalizeBook): a percent-of-mid band filter applied
    // to the raw ccxt float arrays before any Decimal is constructed. 0 disables the band filter
    // entirely (cap-only). Default 50 (0.5%) — comfortably wider than the book-structure block's own
    // 25bps depth-notional window (agent-prompt.ts's BOOK_STRUCTURE_BAND_BPS) so nothing that block
    // reads is ever truncated by this filter.
    MARKET_BOOK_BAND_BPS: z.coerce.number().int().min(0).default(50),
    // Hard per-side cap on book levels, applied after the band filter. 0 disables the cap. Default
    // 1000 — belt-and-suspenders against a disabled/miss band filter on a deep book; far above the
    // top-10 levels any prompt block ever reads (agent-prompt.ts's BOOK_STRUCTURE_DEPTH_LEVELS).
    MARKET_BOOK_MAX_LEVELS: z.coerce.number().int().min(0).default(1000),
  })
  .superRefine((data, ctx) => {
    // Backstop-vs-model-stop (Design § Conflict resolutions): ProtectiveExitService's bot-side
    // stop-loss backstop must sit STRICTLY ABOVE the v2 decision contract's stop-loss upper bound
    // (domain/trading/risk/agentic-bounds.ts) — otherwise the backstop could fire BEFORE the model's own
    // worst-case stop, silently overriding the model's exit ownership with a tighter bot-side exit
    // the model never agreed to. Fail CLOSED (config refusal at construction, never a runtime
    // place-then-reject): a misconfigured deployment must never boot into that gap. Skipped only
    // when PROTECT_STOP_LOSS_PCT is the explicit '0' disabled-sentinel (the backstop is off — see
    // its own schema comment) — an unconfigured deployment (default '0') stays byte-identical.
    if (data.PROTECT_STOP_LOSS_PCT !== '0') {
      const protectPct = new Decimal(data.PROTECT_STOP_LOSS_PCT);
      const slBound = new Decimal(AGENTIC_MAX_STOP_LOSS_PCT);
      if (protectPct.lte(slBound)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PROTECT_STOP_LOSS_PCT'],
          message:
            `PROTECT_STOP_LOSS_PCT (${data.PROTECT_STOP_LOSS_PCT}) must be strictly greater than ` +
            `the v2 decision contract's stop-loss upper bound (${AGENTIC_MAX_STOP_LOSS_PCT}) — ` +
            `otherwise the bot-side backstop could fire before the model's own worst-case stop, ` +
            `overriding the model's exit ownership.`,
        });
      }
    }
    // Universe (U1): a menu wider than the configured basket is nonsensical config (the scanner
    // would rank a top-N that exceeds the pool it ranks from) — refused at construction rather than
    // silently clamped, so a config typo surfaces immediately instead of at first scanner run.
    // TRADING_SYMBOLS is optional at the SCHEMA level only so validate() below can resolve its
    // test/ci fallback (§3.4 — the legacy single-TRADING_SYMBOL fallback is deleted; a real,
    // non-test/ci boot without TRADING_SYMBOLS throws there, never reaching this default-menu-size
    // no-op).
    if (
      data.TRADING_SYMBOLS !== undefined &&
      data.AGENTIC_ACTIVE_MENU_SIZE > data.TRADING_SYMBOLS.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AGENTIC_ACTIVE_MENU_SIZE'],
        message:
          `AGENTIC_ACTIVE_MENU_SIZE (${data.AGENTIC_ACTIVE_MENU_SIZE}) must be <= the number of ` +
          `configured TRADING_SYMBOLS (${data.TRADING_SYMBOLS.length}) — the active menu cannot be ` +
          `wider than the basket it is ranked from.`,
      });
    }
    // EXIT_CROSS_BUFFER_BPS is schema-capped at 99 (< the hardcoded RISK_MAX_BAND_BPS DEFAULT of
    // 100) so a crossed reduce-only exit price never trips domain/trading/risk/evaluate.ts's price-band
    // veto — but RISK_MAX_BAND_BPS is itself a freely-settable operator knob, so that static cap
    // alone does not bind the CONFIGURED band. Fail CLOSED (permission/safety gate, config refusal
    // at construction, never a runtime place-then-reject): an operator who tightens
    // RISK_MAX_BAND_BPS at or below EXIT_CROSS_BUFFER_BPS must never boot into a state where every
    // reduce-only IOC exit (including a bot-side stop firing) self-vetoes on PRICE_BAND.
    if (data.EXIT_CROSS_BUFFER_BPS >= data.RISK_MAX_BAND_BPS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EXIT_CROSS_BUFFER_BPS'],
        message:
          `EXIT_CROSS_BUFFER_BPS (${data.EXIT_CROSS_BUFFER_BPS}) must stay strictly below ` +
          `RISK_MAX_BAND_BPS (${data.RISK_MAX_BAND_BPS}) — otherwise a crossed reduce-only exit ` +
          `price always exceeds the configured price band and evaluate.ts vetoes every exit with ` +
          `PRICE_BAND, stranding a position that needs to be reduced.`,
      });
    }
    // Reflection-model pricing gate-honesty refusal (review finding, major). ratesFor()
    // (mode-control/promotion-readiness.service.ts) prices EVERY model at the flat
    // AGENTIC_TOKEN_PRICE_* knobs whenever AGENTIC_TOKEN_PRICES_JSON is ABSENT — the per-model map's
    // own "unknown model -> most-expensive rate" fail-closed fallback (AGENTIC_TOKEN_PRICES_JSON's
    // own schema comment above) only fires once a map IS configured; an absent map is a DIFFERENT,
    // fail-OPEN branch that prices under a pinned pricier reflection model at the cheaper decide
    // rate. Refuse at construction (permission/safety gate, fails CLOSED) rather than let a
    // misconfigured deployment boot on understated LLM-cost evidence inside the earned-live
    // promotion gate. Malformed AGENTIC_TOKEN_PRICES_JSON is left to parseTokenPrices' own throw at
    // config-build time (below) — that JSON.parse attempt here only decides whether to skip this
    // check, never reports its own issue, so the two failures are never double-reported.
    if (
      data.AGENTIC_REFLECTION_MODEL !== undefined &&
      data.AGENTIC_REFLECTION_MODEL !== data.AGENTIC_MODEL
    ) {
      let hasEntry = false;
      if (data.AGENTIC_TOKEN_PRICES_JSON !== undefined) {
        try {
          const parsedMap: unknown = JSON.parse(data.AGENTIC_TOKEN_PRICES_JSON);
          hasEntry =
            typeof parsedMap === 'object' &&
            parsedMap !== null &&
            Object.prototype.hasOwnProperty.call(parsedMap, data.AGENTIC_REFLECTION_MODEL);
        } catch {
          hasEntry = true; // malformed JSON fails boot separately via parseTokenPrices below
        }
      }
      if (!hasEntry) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AGENTIC_TOKEN_PRICES_JSON'],
          message:
            `AGENTIC_REFLECTION_MODEL (${data.AGENTIC_REFLECTION_MODEL}) differs from AGENTIC_MODEL ` +
            `(${data.AGENTIC_MODEL}) but has no entry in AGENTIC_TOKEN_PRICES_JSON — with the map ` +
            `unset (or missing this model), PromotionReadinessService prices EVERY model at the ` +
            `flat AGENTIC_TOKEN_PRICE_* knobs, under-counting a pricier reflection model's real ` +
            `spend inside the earned-live promotion gate. Add a per-model entry for ` +
            `${data.AGENTIC_REFLECTION_MODEL} to AGENTIC_TOKEN_PRICES_JSON.`,
        });
      }
    }
    // Perp leverage/MMR/buffer zeroing refusal (F1a). domain/trading/risk/perp-sizing.ts's
    // liqSafeNotionalCap is not a graduated cap: the configured triple either clears the required
    // liq-price buffer (any notional is liq-safe ⇒ Infinity) or it doesn't (⇒ 0, rejecting every
    // entry). A triple that lands on the zero branch produces no boot-time signal today — every
    // perp entry silently rejects NO_POSITION/BELOW_MINIMUM at runtime. Fail CLOSED (config refusal
    // at construction, never a runtime place-then-reject): refuse boot rather than let a
    // misconfigured leverage/MMR/buffer combination silently collapse every perp entry to zero size.
    const perpLeverageCapDec = new Decimal(data.PERP_LEVERAGE_CAP);
    const perpMmrFallbackDec = new Decimal(data.PERP_MMR_FALLBACK);
    const perpLiqBufferPctDec = new Decimal(data.PERP_LIQ_BUFFER_PCT);
    if (liqSafeNotionalCap(perpLeverageCapDec, perpMmrFallbackDec, perpLiqBufferPctDec).isZero()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PERP_LEVERAGE_CAP'],
        message:
          `PERP_LEVERAGE_CAP (${data.PERP_LEVERAGE_CAP}) / PERP_MMR_FALLBACK ` +
          `(${data.PERP_MMR_FALLBACK}) / PERP_LIQ_BUFFER_PCT (${data.PERP_LIQ_BUFFER_PCT}) zero out ` +
          `liqSafeNotionalCap — every perp entry would silently collapse to zero size, rejecting ` +
          `with NO_POSITION/BELOW_MINIMUM at runtime with no boot-time signal.`,
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
    VENUE_CAPITAL_SPLIT: venueCapitalSplitRaw,
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
    AGENTIC_MAX_POSITION_FRACTION_SPOT: agenticMaxPositionFractionSpot,
    AGENTIC_MAX_POSITION_FRACTION_PERP: agenticMaxPositionFractionPerp,
    AGENTIC_FALLBACK_CONSULT_BARS: agenticFallbackConsultBars,
    AGENTIC_WAKE_MOVE_PCT: agenticWakeMovePct,
    AGENTIC_ACTIVE_MENU_SIZE: agenticActiveMenuSize,
    AGENTIC_MAX_ENTRIES_PER_DAY: agenticMaxEntriesPerDay,
    AGENTIC_DRAIN_COOLDOWN_BASE_MS: agenticDrainCooldownBaseMs,
    AGENTIC_DRAIN_COOLDOWN_MAX_MS: agenticDrainCooldownMaxMs,
    AGENTIC_REFLECTION_EVERY_N_TRADES: agenticReflectionEveryNTrades,
    AGENTIC_REFLECTION_COOLDOWN_MS: agenticReflectionCooldownMs,
    AGENTIC_PLAYBOOK_PIN: agenticPlaybookPin,
    AGENTIC_PLAYBOOK_AB_PCT: agenticPlaybookAbPct,
    AGENTIC_DERIVATIVES_V2_ENABLED: agenticDerivativesV2Enabled,
    AGENTIC_CROSS_SYMBOL_ENABLED: agenticCrossSymbolEnabled,
    AGENTIC_CROSS_SYMBOL_LOOKBACK_BARS: agenticCrossSymbolLookbackBars,
    AGENTIC_BOOK_STRUCTURE_ENABLED: agenticBookStructureEnabled,
    AGENTIC_TRACK_RECORD_ENABLED: agenticTrackRecordEnabled,
    AGENTIC_EDGE_POLICY_ENABLED: agenticEdgePolicyEnabled,
    AGENTIC_EDGE_POLICY_FAMILY: agenticEdgePolicyFamily,
    AGENTIC_PORTFOLIO_CONSULT: agenticPortfolioConsult,
    AGENTIC_PORTFOLIO_WINDOW_MS: agenticPortfolioWindowMs,
    AGENTIC_MINT_BACKTEST_ROWS: agenticMintBacktestRows,
    AGENTIC_MINT_BACKTEST_MARGIN_BPS: agenticMintBacktestMarginBps,
    AGENTIC_MINT_BACKTEST_MIN_TRIPS: agenticMintBacktestMinTrips,
    AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES: agenticAutoPromoteMinAttributedTrades,
    AGENTIC_TOKEN_PRICE_INPUT_PER_MTOK: agenticTokenPriceInputPerMtok,
    AGENTIC_TOKEN_PRICE_OUTPUT_PER_MTOK: agenticTokenPriceOutputPerMtok,
    AGENTIC_TOKEN_PRICE_CACHE_READ_PER_MTOK: agenticTokenPriceCacheReadPerMtok,
    AGENTIC_TOKEN_PRICE_CACHE_WRITE_PER_MTOK: agenticTokenPriceCacheWritePerMtok,
    AGENTIC_TOKEN_PRICES_JSON: agenticTokenPricesJson,
    PROMOTION_EVIDENCE_EPOCH: promotionEvidenceEpoch,
    PROMOTION_DUST_NOTIONAL: promotionDustNotional,
    AGENTIC_PLAN_MODE: agenticPlanMode,
    AGENTIC_PLAN_EXIT_TTL_BARS: agenticPlanExitTtlBars,
    AGENTIC_QUIET_PAYLOAD_SAMPLE_BARS: agenticQuietPayloadSampleBars,
    AGENTIC_VENUE_TP: agenticVenueTp,
    AGENTIC_VENUE_TP_REPLACE_DRIFT_BPS: agenticVenueTpReplaceDriftBps,
    AGENTIC_VENUE_STOP: agenticVenueStop,
    AGENTIC_VENUE_STOP_REPLACE_DRIFT_BPS: agenticVenueStopReplaceDriftBps,
    EXIT_CROSS_BUFFER_BPS: exitCrossBufferBps,
    ENTRY_ORDER_TYPE: entryOrderType,
    BASE_NOTIONAL: baseNotional,
    SIZER_EQUITY_FRACTION: sizerEquityFraction,
    SIZER_EQUITY_CAP: sizerEquityCap,
    SIZER_MAX_PLANNED_STOP_RISK_FRACTION: sizerMaxPlannedStopRiskFraction,
    PROTECT_STOP_LOSS_PCT: protectStopLossPct,
    PROTECT_TRAILING_PCT: protectTrailingPct,
    PLAN_STOP_WATCH_ENABLED: planStopWatchEnabled,
    PLAN_STOP_FORCE_BPS: planStopForceBps,
    RISK_MAX_ORDER_NOTIONAL: riskMaxOrderNotional,
    RISK_MAX_POSITION_PER_SYMBOL: riskMaxPositionPerSymbol,
    RISK_MAX_GROSS_EXPOSURE: riskMaxGrossExposure,
    RISK_MAX_NET_EXPOSURE: riskMaxNetExposure,
    RISK_MAX_DAILY_LOSS: riskMaxDailyLoss,
    RISK_MAX_DRAWDOWN_PCT: riskMaxDrawdownPct,
    RISK_MAX_BAND_BPS: riskMaxBandBps,
    RISK_MAX_PASSIVE_EXIT_BAND_BPS: riskMaxPassiveExitBandBps,
    RISK_MAX_STOP_TRIGGER_BAND_BPS: riskMaxStopTriggerBandBps,
    STOP_LIMIT_BUFFER_BPS: stopLimitBufferBps,
    RISK_STALE_MAX_AGE_MS: riskStaleMaxAgeMs,
    RECOVERY_AUTO_RESUME_ENABLED: recoveryAutoResumeEnabled,
    PERP_LEVERAGE_CAP: perpLeverageCap,
    PERP_MMR_FALLBACK: perpMmrFallback,
    PERP_LIQ_BUFFER_PCT: perpLiqBufferPct,
    TRADING_SYMBOLS: tradingSymbolsRaw,
    STRATEGY_INTERVAL: strategyInterval,
    ACTIVE_STRATEGY: activeStrategy,
    DERIVATIVES_FEED_ENABLED: derivativesFeedEnabled,
    DERIVATIVES_FEED_POLL_MS: derivativesFeedPollMs,
    FUNDING_INGEST_ENABLED: fundingIngestEnabled,
    FUNDING_INGEST_POLL_MS: fundingIngestPollMs,
    SENTIMENT_FEED_ENABLED: sentimentFeedEnabled,
    SENTIMENT_FEED_POLL_MS: sentimentFeedPollMs,
    FEAR_GREED_FEED_ENABLED: fearGreedFeedEnabled,
    FEAR_GREED_POLL_MS: fearGreedPollMs,
    AGENTIC_TRADEFLOW_ENABLED: agenticTradeFlowEnabled,
    AGENTIC_TRADEFLOW_POLL_MS: agenticTradeFlowPollMs,
    AGENTIC_POSITIONING_ENABLED: agenticPositioningEnabled,
    AGENTIC_POSITIONING_POLL_MS: agenticPositioningPollMs,
    AGENTIC_LIQUIDATIONS_ENABLED: agenticLiquidationsEnabled,
    MARKET_BOOK_BAND_BPS: marketBookBandBps,
    MARKET_BOOK_MAX_LEVELS: marketBookMaxLevels,
  } = parsed.data;
  const bootId = crypto.randomUUID();
  const venues = parseVenues(env);

  // v3 §3.4: TRADING_SYMBOLS is required outside test/ci (the legacy TRADING_SYMBOL fallback is
  // deleted); test/ci falls back to ['BTC/USDT'] — matching the OLD default's observable shape —
  // so the many real-module boots in the hermetic suite (hermetic-env.spec.ts, app-module.boot.spec.ts,
  // openapi-snapshot.spec.ts, health/metrics specs) stay green without each restating a basket. Fail
  // CLOSED outside test/ci (config refusal at construction).
  const tradingSymbols = tradingSymbolsRaw ?? (isTestOrCi ? ['BTC/USDT'] : undefined);
  if (tradingSymbols === undefined) {
    throw new Error(
      'TRADING_SYMBOLS is required outside test/ci — the legacy TRADING_SYMBOL fallback was ' +
        'deleted in v3.',
    );
  }

  // v3 §3.2/§3.5: DATABASE_URL is required outside test/ci — the one-book evidence chain (promotion
  // verdict, reconciliation, audit_log) needs a durable database on every real boot. test/ci keeps
  // the in-memory backings (PersistenceOverridesModule's test/ci-only fallbacks), so this stays a
  // no-op for the hermetic suite. Fail CLOSED (config refusal at construction).
  if (!isTestOrCi && (dbUrl === undefined || dbUrl.length === 0)) {
    throw new Error(
      'DATABASE_URL is required outside test/ci — the one-book evidence chain (promotion verdict, ' +
        'reconciliation, audit_log) has no durable store without it.',
    );
  }

  // v3 §3.2/§3.5: VENUES must be non-empty outside test/ci, and its id set must EXACTLY cover the
  // venues implied by TRADING_SYMBOLS via venueIdForSymbol (a :SETTLE-suffixed symbol with no
  // binanceusdm entry, or a binanceusdm entry with no perp symbol behind it, ⇒ refusal either way).
  // Fail CLOSED — a real boot must never route an order through an undeclared venue, and an idle
  // configured venue is equally a config error (nothing to trade there). test/ci is exempt (VENUES
  // defaults to empty, matching every other feature-inert-until-configured knob in this file).
  if (!isTestOrCi) {
    if (venues.length === 0) {
      throw new Error(
        'VENUES must be non-empty outside test/ci — a real boot must declare at least one venue.',
      );
    }
    const configuredVenueIds = new Set(venues.map((v) => v.id));
    const impliedVenueIds = new Set(tradingSymbols.map(venueIdForSymbol));
    const missingFromVenues = [...impliedVenueIds].filter((id) => !configuredVenueIds.has(id));
    const unusedInVenues = [...configuredVenueIds].filter((id) => !impliedVenueIds.has(id));
    if (missingFromVenues.length > 0 || unusedInVenues.length > 0) {
      throw new Error(
        `VENUES (${[...configuredVenueIds].join(',')}) must exactly cover the venues implied by ` +
          `TRADING_SYMBOLS (${[...impliedVenueIds].join(',')}) — ` +
          `${missingFromVenues.length > 0 ? `missing venue(s): ${missingFromVenues.join(',')}. ` : ''}` +
          `${unusedInVenues.length > 0 ? `configured but unused venue(s): ${unusedInVenues.join(',')}.` : ''}`,
      );
    }
  }

  // v3 §3.1/§3.5: VENUE_CAPITAL_SPLIT — fixed wallet split of the one book. Every share is already
  // positivity-checked by the schema (positiveDecimalString); the two cross-field checks below run
  // here, once VENUES/SIZER_EQUITY_CAP are resolved. Fail CLOSED — both are permission/safety gates
  // on the sizer's venue-headroom clamp (§6.1), never a runtime place-then-reject.
  const venueCapitalSplit = parseVenueCapitalSplit(venueCapitalSplitRaw);
  // Key-set-vs-VENUES match only binds once VENUES is actually configured — an empty/test VENUES has
  // no ids to match against, so this narrows to a no-op for the unconfigured/test-default case,
  // consistent with every other feature-inert-until-configured knob in this file (VENUES itself is
  // required outside test/ci above, so a real boot always exercises this check).
  if (venues.length > 0) {
    const splitKeys = new Set(Object.keys(venueCapitalSplit));
    const venueIds = new Set(venues.map((v) => v.id));
    const missingFromSplit = [...venueIds].filter((id) => !splitKeys.has(id));
    const unusedInSplit = [...splitKeys].filter((id) => !venueIds.has(id));
    if (missingFromSplit.length > 0 || unusedInSplit.length > 0) {
      throw new Error(
        `VENUE_CAPITAL_SPLIT keys (${[...splitKeys].join(',')}) must exactly equal the configured ` +
          `VENUES ids (${[...venueIds].join(',')}).`,
      );
    }
  }
  const venueCapitalSplitSum = Object.values(venueCapitalSplit).reduce(
    (acc, v) => acc.plus(new Decimal(v)),
    new Decimal(0),
  );
  const equityCapDecimal = new Decimal(sizerEquityCap);
  // '0' is the documented disabled-cap sentinel (SIZER_EQUITY_CAP's own schema comment) — the split
  // sum then has no book-size ceiling to respect, mirroring position-sizer.service.ts's cappedEquity.
  if (equityCapDecimal.gt(0) && venueCapitalSplitSum.gt(equityCapDecimal)) {
    throw new Error(
      `VENUE_CAPITAL_SPLIT shares sum to ${venueCapitalSplitSum.toString()}, which exceeds ` +
        `SIZER_EQUITY_CAP (${sizerEquityCap}).`,
    );
  }

  // v3 §3.5: AGENTIC_PLAN_MODE=false is refused when any perp symbol is configured — shorts and the
  // venue-resting TP/stop rails all require plan mode (carried from the v2 perp constraint, now
  // cross-field since VENUES/TRADING_SYMBOLS may mix spot and perp in one boot). Fail CLOSED.
  if (!agenticPlanMode && tradingSymbols.some((s) => venueIdForSymbol(s) === PERP_VENUE_ID)) {
    throw new Error(
      'AGENTIC_PLAN_MODE=false is refused when any perp symbol is configured in TRADING_SYMBOLS — ' +
        'shorts and the venue-resting TP/stop rails require plan mode.',
    );
  }

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
    venueCapitalSplit,
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
      // v3-transitional(#8,#10): AGENTIC_MAX_POSITION_FRACTION is renamed to the SPOT/PERP split
      // above (§3.3); risk.module.ts's maxAgentPositionFractionFor and agentic-strategy.module.ts /
      // reflection.service.ts still read this single field as their lane-wide sizeFraction cap.
      // Derives to the SPOT value (the pre-v3 default lane) until those workstreams consume
      // maxPositionFractionSpot/maxPositionFractionPerp per-symbol directly.
      maxPositionFraction: agenticMaxPositionFractionSpot,
      maxPositionFractionSpot: agenticMaxPositionFractionSpot,
      maxPositionFractionPerp: agenticMaxPositionFractionPerp,
      fallbackConsultBars: agenticFallbackConsultBars,
      wakeMovePct: agenticWakeMovePct,
      activeMenuSize: agenticActiveMenuSize,
      maxEntriesPerDay: agenticMaxEntriesPerDay,
      drainCooldownBaseMs: agenticDrainCooldownBaseMs,
      drainCooldownMaxMs: agenticDrainCooldownMaxMs,
      reflectionEveryNTrades: agenticReflectionEveryNTrades,
      reflectionCooldownMs: agenticReflectionCooldownMs,
      mintBacktestRows: agenticMintBacktestRows,
      mintBacktestMarginBps: agenticMintBacktestMarginBps,
      mintBacktestMinTrips: agenticMintBacktestMinTrips,
      // v3-transitional(#10): AGENTIC_AUTO_PROMOTE_MIN_TRADES is deleted (§3.4) — the legacy
      // count-only path is permanently superseded by autoPromoteMinAttributedTrades below.
      // reflection.service.ts / agentic-strategy.module.ts still read this field; hardcoded 0
      // (disabled) reproduces the deleted knob's only sane deployed value.
      autoPromoteMinTrades: 0,
      autoPromoteMinAttributedTrades: agenticAutoPromoteMinAttributedTrades,
      playbookPin: agenticPlaybookPin,
      playbookAbPct: agenticPlaybookAbPct,
      derivativesV2Enabled: agenticDerivativesV2Enabled,
      crossSymbolEnabled: agenticCrossSymbolEnabled,
      crossSymbolLookbackBars: agenticCrossSymbolLookbackBars,
      bookStructureFeedEnabled: agenticBookStructureEnabled,
      trackRecordEnabled: agenticTrackRecordEnabled,
      edgePolicyEnabled: agenticEdgePolicyEnabled,
      edgePolicyFamily: agenticEdgePolicyFamily,
      portfolioConsultEnabled: agenticPortfolioConsult,
      portfolioWindowMs: agenticPortfolioWindowMs,
      tokenPriceInputPerMtok: agenticTokenPriceInputPerMtok,
      tokenPriceOutputPerMtok: agenticTokenPriceOutputPerMtok,
      tokenPriceCacheReadPerMtok: agenticTokenPriceCacheReadPerMtok,
      tokenPriceCacheWritePerMtok: agenticTokenPriceCacheWritePerMtok,
      tokenPrices: parseTokenPrices(agenticTokenPricesJson),
      promotionEvidenceEpoch,
      promotionDustNotional,
      venueTpEnabled: agenticVenueTp,
      venueTpReplaceDriftBps: agenticVenueTpReplaceDriftBps,
      venueStopEnabled: agenticVenueStop,
      venueStopReplaceDriftBps: agenticVenueStopReplaceDriftBps,
      planMode: agenticPlanMode,
      planExitTtlBars: agenticPlanExitTtlBars,
      quietPayloadSampleBars: agenticQuietPayloadSampleBars,
    },
    risk: {
      exitCrossBufferBps,
      entryOrderType,
      baseNotional,
      equityFraction: sizerEquityFraction,
      equityCap: sizerEquityCap,
      maxPlannedStopRiskFraction: sizerMaxPlannedStopRiskFraction,
      protectStopLossPct,
      protectTrailingPct,
      planStopWatchEnabled,
      planStopForceBps,
      maxOrderNotional: riskMaxOrderNotional,
      maxPositionPerSymbol: riskMaxPositionPerSymbol,
      maxGrossExposure: riskMaxGrossExposure,
      maxNetExposure: riskMaxNetExposure,
      maxDailyLoss: riskMaxDailyLoss,
      maxDrawdownPct: riskMaxDrawdownPct,
      maxBandBps: riskMaxBandBps,
      maxPassiveExitBandBps: riskMaxPassiveExitBandBps,
      maxStopTriggerBandBps: riskMaxStopTriggerBandBps,
      stopLimitBufferBps,
      staleMaxAgeMs: riskStaleMaxAgeMs,
    },
    recovery: {
      autoResumeEnabled: recoveryAutoResumeEnabled,
    },
    perp: {
      // PERP_VENUE_ENABLED deleted (§3.4): no `enabled` field — venue presence in VENUES is the
      // signal now, and this field had no consumer outside environment.config.ts itself.
      leverageCap: perpLeverageCap,
      mmrFallback: perpMmrFallback,
      liqBufferPct: perpLiqBufferPct,
    },
    strategy: {
      // v3-transitional(#5): TRADING_SYMBOL (the legacy single-symbol fallback) is deleted (§3.4—
      // TRADING_SYMBOLS is now required). app.module.ts:1694's symbolId(config.strategy.symbol) is
      // this field's only consumer; derives to the first configured symbol until #5's
      // TradingRuntimeService iterates config.strategy.symbols directly instead.
      symbol: tradingSymbols[0]!,
      symbols: tradingSymbols,
      interval: strategyInterval,
      active: activeStrategy,
    },
    derivativesFeed: {
      enabled: derivativesFeedEnabled,
      pollIntervalMs: derivativesFeedPollMs,
    },
    fundingIngest: {
      enabled: fundingIngestEnabled,
      pollIntervalMs: fundingIngestPollMs,
    },
    sentimentFeed: {
      enabled: sentimentFeedEnabled,
      pollIntervalMs: sentimentFeedPollMs,
    },
    fearGreedFeed: {
      enabled: fearGreedFeedEnabled,
      pollIntervalMs: fearGreedPollMs,
    },
    tradeFlowFeed: {
      enabled: agenticTradeFlowEnabled,
      pollIntervalMs: agenticTradeFlowPollMs,
    },
    positioningFeed: {
      enabled: agenticPositioningEnabled,
      pollIntervalMs: agenticPositioningPollMs,
    },
    liquidationFeed: {
      enabled: agenticLiquidationsEnabled,
    },
    marketData: {
      bookBandBps: marketBookBandBps,
      bookMaxLevels: marketBookMaxLevels,
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
