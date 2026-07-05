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
});

export function validate(env: Record<string, string | undefined>): AppConfig {
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
      playbookPin: agenticPlaybookPin,
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
