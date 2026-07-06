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

const envSchema = z.object({
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
  AGENTIC_MODEL: z.string().min(1).default('claude-opus-4-8'),
  AGENTIC_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  AGENTIC_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
  AGENTIC_MIN_DECISION_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
  AGENTIC_WARMUP_BARS: z.coerce.number().int().positive().default(50),
  AGENTIC_MAX_CALLS_PER_DAY: z.coerce.number().int().positive().default(500),
  AGENTIC_MAX_TOKENS_PER_DAY: z.coerce.number().int().positive().default(2_000_000),
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
  // Cumulative closed-trade floor before a reflection candidate auto-promotes to ACTIVE (G4b); 0
  // (default) disables auto-promotion — see reflection.service.ts's autoPromoteMinTrades comment.
  AGENTIC_AUTO_PROMOTE_MIN_TRADES: z.coerce.number().int().min(0).default(0),
  // PromotionReadinessService LLM-cost math: USD per 1M tokens, operator-adjustable (claude-sonnet-5
  // list prices as of this writing) — same stance as the Grafana cost-panel variables.
  AGENTIC_TOKEN_PRICE_INPUT_PER_MTOK: decimalString.default('3'),
  AGENTIC_TOKEN_PRICE_OUTPUT_PER_MTOK: decimalString.default('15'),
  // Residual-position notional (quote ccy) below which PromotionReadinessService's round-trip walk
  // considers a cycle CLOSED — historical pre-IOC cycles carry dust remainders that would otherwise
  // never close. Default '5' mirrors BTC/USDT's exchange minNotional.
  PROMOTION_DUST_NOTIONAL: decimalString.default('5'),
  // Marketable-exit crossing buffer (bps) for reduce-only intents (PositionSizerService): how far
  // the IOC limit crosses the spread so a partial fill doesn't leave sub-minNotional dust resting
  // away from market. Capped at 99 (< DEFAULT_LIMITS.maxBandBps=100 in risk.module) so a crossed
  // exit price never trips domain/risk/evaluate.ts's price-band veto.
  EXIT_CROSS_BUFFER_BPS: z.coerce.number().int().min(0).max(99).default(25),
  // Quote-currency (USDT) notional per order. Default 100 matches the deployed .env — the prior
  // in-code fallback of '1000' (risk.module.ts/app.module.ts) was drift, never an intended default.
  BASE_NOTIONAL: decimalString.default('100'),
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
  // Strategy-lane knobs. ACTIVE_STRATEGY is a closed enum: 'agentic' is the only registered lane
  // (the deterministic pure lane was retired 2026-07-03).
  TRADING_SYMBOL: z.string().min(1).default('BTC/USDT'),
  STRATEGY_INTERVAL: z.enum(CANDLE_INTERVALS).default('5m'),
  ACTIVE_STRATEGY: z.enum(['agentic']).default('agentic'),
});

// dotenv/compose convention: `VAR=` (empty assignment) means UNSET, not "the empty string". Without
// this strip an emptied optional knob crashes the boot — zod v4 coerces '' to NaN (AGENTIC_PLAYBOOK_PIN=
// took the deployed bot down on 2026-07-06) and the decimal-string knobs would fail their regex the
// same way. Stripping before parse makes '' fall through to each field's default/optional handling.
function withoutEmptyValues(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
}

export function validate(rawEnv: Record<string, string | undefined>): AppConfig {
  const env = withoutEmptyValues(rawEnv);
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
    AGENTIC_TIMEOUT_MS: agenticTimeoutMs,
    AGENTIC_MAX_TOKENS: agenticMaxTokens,
    AGENTIC_MIN_DECISION_INTERVAL_MS: agenticMinDecisionIntervalMs,
    AGENTIC_WARMUP_BARS: agenticWarmupBars,
    AGENTIC_MAX_CALLS_PER_DAY: agenticMaxCallsPerDay,
    AGENTIC_MAX_TOKENS_PER_DAY: agenticMaxTokensPerDay,
    AGENTIC_MAX_ENTRIES_PER_DAY: agenticMaxEntriesPerDay,
    AGENTIC_DRAIN_COOLDOWN_BASE_MS: agenticDrainCooldownBaseMs,
    AGENTIC_DRAIN_COOLDOWN_MAX_MS: agenticDrainCooldownMaxMs,
    AGENTIC_REFLECTION_EVERY_N_TRADES: agenticReflectionEveryNTrades,
    AGENTIC_REFLECTION_COOLDOWN_MS: agenticReflectionCooldownMs,
    AGENTIC_PLAYBOOK_PIN: agenticPlaybookPin,
    AGENTIC_AUTO_PROMOTE_MIN_TRADES: agenticAutoPromoteMinTrades,
    AGENTIC_TOKEN_PRICE_INPUT_PER_MTOK: agenticTokenPriceInputPerMtok,
    AGENTIC_TOKEN_PRICE_OUTPUT_PER_MTOK: agenticTokenPriceOutputPerMtok,
    PROMOTION_DUST_NOTIONAL: promotionDustNotional,
    EXIT_CROSS_BUFFER_BPS: exitCrossBufferBps,
    BASE_NOTIONAL: baseNotional,
    RISK_MAX_ORDER_NOTIONAL: riskMaxOrderNotional,
    RISK_MAX_POSITION_PER_SYMBOL: riskMaxPositionPerSymbol,
    RISK_MAX_GROSS_EXPOSURE: riskMaxGrossExposure,
    RISK_MAX_NET_EXPOSURE: riskMaxNetExposure,
    RISK_MAX_DAILY_LOSS: riskMaxDailyLoss,
    RISK_MAX_DRAWDOWN_PCT: riskMaxDrawdownPct,
    RISK_MAX_BAND_BPS: riskMaxBandBps,
    RISK_STALE_MAX_AGE_MS: riskStaleMaxAgeMs,
    TRADING_SYMBOL: tradingSymbol,
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
      timeoutMs: agenticTimeoutMs,
      maxTokens: agenticMaxTokens,
      minDecisionIntervalMs: agenticMinDecisionIntervalMs,
      warmupBars: agenticWarmupBars,
      maxCallsPerDay: agenticMaxCallsPerDay,
      maxTokensPerDay: agenticMaxTokensPerDay,
      maxEntriesPerDay: agenticMaxEntriesPerDay,
      drainCooldownBaseMs: agenticDrainCooldownBaseMs,
      drainCooldownMaxMs: agenticDrainCooldownMaxMs,
      reflectionEveryNTrades: agenticReflectionEveryNTrades,
      reflectionCooldownMs: agenticReflectionCooldownMs,
      autoPromoteMinTrades: agenticAutoPromoteMinTrades,
      playbookPin: agenticPlaybookPin,
      tokenPriceInputPerMtok: agenticTokenPriceInputPerMtok,
      tokenPriceOutputPerMtok: agenticTokenPriceOutputPerMtok,
      promotionDustNotional,
    },
    risk: {
      exitCrossBufferBps,
      baseNotional,
      maxOrderNotional: riskMaxOrderNotional,
      maxPositionPerSymbol: riskMaxPositionPerSymbol,
      maxGrossExposure: riskMaxGrossExposure,
      maxNetExposure: riskMaxNetExposure,
      maxDailyLoss: riskMaxDailyLoss,
      maxDrawdownPct: riskMaxDrawdownPct,
      maxBandBps: riskMaxBandBps,
      staleMaxAgeMs: riskStaleMaxAgeMs,
    },
    strategy: {
      symbol: tradingSymbol,
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
