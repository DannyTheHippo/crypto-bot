import { describe, expect, it } from 'vitest';
import { validate } from '../../../src/config/environment/environment.config';

describe('validate()', () => {
  it('defaults to paper when TRADING_MODE is absent', () => {
    const cfg = validate({ PORT: '3100' });
    expect(cfg.mode.configMode).toBe('paper');
  });

  it('resolves to live when TRADING_MODE=live in a non-test env', () => {
    const cfg = validate({ TRADING_MODE: 'live', PORT: '3100' });
    expect(cfg.mode.configMode).toBe('live');
    expect(cfg.mode.requestedMode).toBe('live');
  });

  it('resolves garbage TRADING_MODE to paper with downgrade reason', () => {
    const cfg = validate({ TRADING_MODE: 'garbage', PORT: '3100' });
    expect(cfg.mode.configMode).toBe('paper');
    expect(cfg.mode.downgrades.length).toBeGreaterThan(0);
    expect(cfg.mode.downgrades[0]).toMatch(/garbage/);
  });

  it('reads SANDBOX_ENV=demo into mode.sandboxEnv', () => {
    const cfg = validate({ TRADING_MODE: 'testnet', SANDBOX_ENV: 'demo', PORT: '3100' });
    expect(cfg.mode.sandboxEnv).toBe('demo');
  });

  it('defaults sandboxEnv to demo when SANDBOX_ENV is absent', () => {
    expect(validate({ PORT: '3100' }).mode.sandboxEnv).toBe('demo');
  });

  it('honors SANDBOX_ENV=testnet override', () => {
    expect(validate({ SANDBOX_ENV: 'testnet', PORT: '3100' }).mode.sandboxEnv).toBe('testnet');
  });

  it('throws on an invalid SANDBOX_ENV', () => {
    expect(() => validate({ SANDBOX_ENV: 'bogus', PORT: '3100' })).toThrow(
      /SANDBOX_ENV|validation/i,
    );
  });

  it('throws on invalid PORT', () => {
    expect(() => validate({ PORT: 'notanumber' })).toThrow(/PORT/);
  });

  it('throws on PORT out of range', () => {
    expect(() => validate({ PORT: '99999' })).toThrow(/PORT/);
  });

  it('throws on garbage LOG_LEVEL (zod schema enforces pino enum)', () => {
    expect(() => validate({ PORT: '3100', LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('accepts all valid pino LOG_LEVEL values', () => {
    for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const) {
      const cfg = validate({ PORT: '3100', LOG_LEVEL: level });
      expect(cfg.observability.logLevel).toBe(level);
    }
  });

  it('config is deep-frozen', () => {
    const cfg = validate({ PORT: '3100' });
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.app)).toBe(true);
    expect(Object.isFrozen(cfg.mode)).toBe(true);
    expect(Object.isFrozen(cfg.observability)).toBe(true);
  });

  it('mutation on frozen config silently fails or throws in strict mode', () => {
    const cfg = validate({ PORT: '3100' });
    const tryMutate = () => {
      (cfg.mode as { configMode: string }).configMode = 'live';
    };
    // In strict mode this throws; in non-strict it silently fails.
    try {
      tryMutate();
    } catch {
      // TypeError expected in strict mode
    }
    expect(cfg.mode.configMode).toBe('paper');
  });

  it('configHash is stable across two validations of the same env', () => {
    const env = { TRADING_MODE: 'paper', PORT: '3100' };
    const cfg1 = validate({ ...env });
    const cfg2 = validate({ ...env });
    expect(cfg1.configHash).toBe(cfg2.configHash);
  });

  it('configHash differs when env differs', () => {
    const cfg1 = validate({ TRADING_MODE: 'paper', PORT: '3100' });
    const cfg2 = validate({ TRADING_MODE: 'testnet', PORT: '3100' });
    expect(cfg1.configHash).not.toBe(cfg2.configHash);
  });

  it('configHash excludes secrets: hash is identical whether or not live keys are present', () => {
    const withSecrets = validate({
      TRADING_MODE: 'live',
      PORT: '3100',
      BINANCE_LIVE_API_KEY: 'supersecret',
      BINANCE_LIVE_API_SECRET: 'anothersecret',
      ARMING_SECRET: 'armingsecret',
    });
    const withoutSecrets = validate({
      TRADING_MODE: 'live',
      PORT: '3100',
    });
    expect(withSecrets.configHash).toBe(withoutSecrets.configHash);
  });

  it('bootId is a UUID-format string', () => {
    const cfg = validate({ PORT: '3100' });
    expect(cfg.app.bootId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('bootId differs between two factory invocations', () => {
    const cfg1 = validate({ PORT: '3100' });
    const cfg2 = validate({ PORT: '3100' });
    expect(cfg1.app.bootId).not.toBe(cfg2.app.bootId);
  });

  it('DATABASE_URL present → cfg.db.url is set to that value', () => {
    const url = 'postgres://user:pass@localhost:5432/mydb';
    const cfg = validate({ PORT: '3100', DATABASE_URL: url });
    expect(cfg.db.url).toBe(url);
  });

  it('DATABASE_URL absent → cfg.db.url is undefined', () => {
    const cfg = validate({ PORT: '3100' });
    expect(cfg.db.url).toBeUndefined();
  });

  it('configHash is identical whether or not DATABASE_URL is present', () => {
    const withDb = validate({ PORT: '3100', DATABASE_URL: 'postgres://localhost/db' });
    const withoutDb = validate({ PORT: '3100' });
    expect(withDb.configHash).toBe(withoutDb.configHash);
  });

  describe('empty-string env values mean UNSET (dotenv/compose convention)', () => {
    // Regression: AGENTIC_PLAYBOOK_PIN='' crashed the deployed boot on 2026-07-06 — zod v4 coerces
    // '' to NaN, and the decimal-string knobs would fail their regex the same way.
    it('AGENTIC_PLAYBOOK_PIN="" resolves to unpinned, not a NaN crash', () => {
      const cfg = validate({ PORT: '3100', AGENTIC_PLAYBOOK_PIN: '' });
      expect(cfg.agentic.playbookPin).toBeUndefined();
    });

    it('BASE_NOTIONAL="" falls back to the default instead of failing the decimal regex', () => {
      expect(validate({ PORT: '3100', BASE_NOTIONAL: '' }).risk.baseNotional).toBe('100');
    });

    it('DATABASE_URL="" means no database (min(1) never sees it)', () => {
      expect(validate({ PORT: '3100', DATABASE_URL: '' }).db.url).toBeUndefined();
    });

    it('a leaked inline comment ("VAR= # note" → value "# note") is treated as unset', () => {
      // docker compose env_file quirk verified 2026-07-06: an empty assignment with a trailing
      // comment delivers the comment text itself as the value.
      const cfg = validate({
        PORT: '3100',
        AGENTIC_PLAYBOOK_PIN: '# optional playbook_version id to pin; unset = latest ACTIVE',
      });
      expect(cfg.agentic.playbookPin).toBeUndefined();
    });
  });

  it('N3 — CI="false" (string) forces paper because Boolean("false") is truthy', () => {
    // Boolean(env['CI']) where env['CI'] === 'false' → Boolean('false') === true → test-env override
    const cfg = validate({ PORT: '3100', CI: 'false', TRADING_MODE: 'live' });
    expect(cfg.mode.configMode).toBe('paper');
    expect(cfg.mode.downgrades.length).toBeGreaterThan(0);
  });

  describe('agentic config', () => {
    it('applies defaults when all AGENTIC_* vars are unset', () => {
      const cfg = validate({ PORT: '3100' });
      expect(cfg.agentic).toEqual({
        // Default matches the token-price defaults (Sonnet-5 at 3/15) so an unconfigured
        // deployment can never bill a pricier model at cheaper rates in the earned-live math.
        model: 'claude-sonnet-5',
        reflectionModel: undefined,
        timeoutMs: 30000,
        reflectionTimeoutMs: 240000,
        maxTokens: 1024,
        minDecisionIntervalMs: 0,
        warmupBars: 50,
        maxCallsPerDay: 500,
        maxTokensPerDay: 2_000_000,
        dailyCostStopUsd: 3,
        entryTtlBars: 2,
        maxEntriesPerDay: 12,
        drainCooldownBaseMs: 30_000,
        drainCooldownMaxMs: 900_000,
        reflectionEveryNTrades: 10,
        reflectionCooldownMs: 604_800_000,
        autoPromoteMinTrades: 0,
        autoPromoteMinAttributedTrades: 0,
        playbookPin: undefined,
        playbookAbPct: 0,
        expectancyLadderEnabled: false,
        planMode: false,
        minEdgeMultiple: '1.5',
        minRr: '1.5',
        planMaxQuietBars: 16,
        planExitTtlBars: 2,
        quietPayloadSampleBars: 0,
        tokenPriceInputPerMtok: '3',
        tokenPriceOutputPerMtok: '15',
        tokenPriceCacheReadPerMtok: '0.3',
        tokenPriceCacheWritePerMtok: '6',
        tokenPrices: undefined,
        promotionEvidenceEpoch: undefined,
        promotionDustNotional: '5',
        prescreenEnabled: true,
        prescreenVolShortBars: 10,
        prescreenVolLongBars: 50,
        prescreenVolRatio: 1.3,
        prescreenBreakoutLookbackBars: 20,
        prescreenBreakoutPct: 0.005,
      });
    });

    it('reads AGENTIC_* overrides into cfg.agentic', () => {
      const cfg = validate({
        PORT: '3100',
        AGENTIC_MODEL: 'claude-haiku-4-5',
        AGENTIC_TIMEOUT_MS: '5000',
        AGENTIC_MAX_TOKENS: '2048',
        AGENTIC_MIN_DECISION_INTERVAL_MS: '1000',
        AGENTIC_WARMUP_BARS: '80',
        AGENTIC_MAX_CALLS_PER_DAY: '1000',
        AGENTIC_MAX_TOKENS_PER_DAY: '5000000',
        AGENTIC_DAILY_COST_STOP_USD: '7.5',
        AGENTIC_MAX_ENTRIES_PER_DAY: '20',
        AGENTIC_DRAIN_COOLDOWN_BASE_MS: '15000',
        AGENTIC_DRAIN_COOLDOWN_MAX_MS: '600000',
        AGENTIC_REFLECTION_EVERY_N_TRADES: '5',
        AGENTIC_REFLECTION_COOLDOWN_MS: '3600000',
        AGENTIC_REFLECTION_TIMEOUT_MS: '90000',
        AGENTIC_PRESCREEN_ENABLED: 'false',
        AGENTIC_PRESCREEN_VOL_SHORT_BARS: '15',
        AGENTIC_PRESCREEN_VOL_LONG_BARS: '60',
        AGENTIC_PRESCREEN_VOL_RATIO: '1.5',
        AGENTIC_PRESCREEN_BREAKOUT_LOOKBACK_BARS: '30',
        AGENTIC_PRESCREEN_BREAKOUT_PCT: '0.01',
      });
      expect(cfg.agentic.model).toBe('claude-haiku-4-5');
      expect(cfg.agentic.timeoutMs).toBe(5000);
      expect(cfg.agentic.maxTokens).toBe(2048);
      expect(cfg.agentic.minDecisionIntervalMs).toBe(1000);
      expect(cfg.agentic.warmupBars).toBe(80);
      expect(cfg.agentic.maxCallsPerDay).toBe(1000);
      expect(cfg.agentic.maxTokensPerDay).toBe(5000000);
      expect(cfg.agentic.dailyCostStopUsd).toBe(7.5);
      expect(cfg.agentic.maxEntriesPerDay).toBe(20);
      expect(cfg.agentic.drainCooldownBaseMs).toBe(15000);
      expect(cfg.agentic.drainCooldownMaxMs).toBe(600000);
      expect(cfg.agentic.reflectionEveryNTrades).toBe(5);
      expect(cfg.agentic.reflectionCooldownMs).toBe(3600000);
      expect(cfg.agentic.reflectionTimeoutMs).toBe(90000);
      expect(cfg.agentic.prescreenEnabled).toBe(false);
      expect(cfg.agentic.prescreenVolShortBars).toBe(15);
      expect(cfg.agentic.prescreenVolLongBars).toBe(60);
      expect(cfg.agentic.prescreenVolRatio).toBe(1.5);
      expect(cfg.agentic.prescreenBreakoutLookbackBars).toBe(30);
      expect(cfg.agentic.prescreenBreakoutPct).toBe(0.01);
    });

    it('AGENTIC_REFLECTION_EVERY_N_TRADES=0 is valid (means off)', () => {
      const cfg = validate({ PORT: '3100', AGENTIC_REFLECTION_EVERY_N_TRADES: '0' });
      expect(cfg.agentic.reflectionEveryNTrades).toBe(0);
    });

    it('AGENTIC_REFLECTION_MODEL absent → undefined (reflection follows AGENTIC_MODEL)', () => {
      const cfg = validate({ PORT: '3100' });
      expect(cfg.agentic.reflectionModel).toBeUndefined();
    });

    it('AGENTIC_REFLECTION_MODEL present → carried into cfg.agentic', () => {
      const cfg = validate({ PORT: '3100', AGENTIC_REFLECTION_MODEL: 'claude-opus-4-8' });
      expect(cfg.agentic.reflectionModel).toBe('claude-opus-4-8');
    });

    it('AGENTIC_PLAYBOOK_PIN absent → undefined (unpinned)', () => {
      const cfg = validate({ PORT: '3100' });
      expect(cfg.agentic.playbookPin).toBeUndefined();
    });

    it('AGENTIC_PLAYBOOK_PIN present → parsed as a positive int', () => {
      const cfg = validate({ PORT: '3100', AGENTIC_PLAYBOOK_PIN: '7' });
      expect(cfg.agentic.playbookPin).toBe(7);
    });

    it('AGENTIC_PLAYBOOK_AB_PCT absent → 0 (routing disabled)', () => {
      const cfg = validate({ PORT: '3100' });
      expect(cfg.agentic.playbookAbPct).toBe(0);
    });

    it('AGENTIC_PLAYBOOK_AB_PCT present → parsed within 0-50', () => {
      const cfg = validate({ PORT: '3100', AGENTIC_PLAYBOOK_AB_PCT: '25' });
      expect(cfg.agentic.playbookAbPct).toBe(25);
    });

    it('throws on AGENTIC_PLAYBOOK_AB_PCT above 50', () => {
      expect(() => validate({ PORT: '3100', AGENTIC_PLAYBOOK_AB_PCT: '51' })).toThrow(
        /AGENTIC_PLAYBOOK_AB_PCT/,
      );
    });

    it('throws on non-numeric AGENTIC_TIMEOUT_MS', () => {
      expect(() => validate({ PORT: '3100', AGENTIC_TIMEOUT_MS: 'notanumber' })).toThrow(
        /AGENTIC_TIMEOUT_MS/,
      );
    });

    it('throws on negative AGENTIC_MAX_CALLS_PER_DAY', () => {
      expect(() => validate({ PORT: '3100', AGENTIC_MAX_CALLS_PER_DAY: '-1' })).toThrow(
        /AGENTIC_MAX_CALLS_PER_DAY/,
      );
    });

    it('throws on negative AGENTIC_PLAYBOOK_PIN', () => {
      expect(() => validate({ PORT: '3100', AGENTIC_PLAYBOOK_PIN: '-3' })).toThrow(
        /AGENTIC_PLAYBOOK_PIN/,
      );
    });

    it('throws on negative AGENTIC_REFLECTION_EVERY_N_TRADES', () => {
      expect(() => validate({ PORT: '3100', AGENTIC_REFLECTION_EVERY_N_TRADES: '-1' })).toThrow(
        /AGENTIC_REFLECTION_EVERY_N_TRADES/,
      );
    });

    it('ANTHROPIC_API_KEY never enters AppConfig (secret stays out of the validated schema)', () => {
      const cfg = validate({ PORT: '3100', ANTHROPIC_API_KEY: 'sk-secret' });
      expect(cfg as unknown as Record<string, unknown>).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(cfg.agentic as unknown as Record<string, unknown>).not.toHaveProperty(
        'ANTHROPIC_API_KEY',
      );
    });

    it('configHash is identical whether or not ANTHROPIC_API_KEY is present', () => {
      const withKey = validate({ PORT: '3100', ANTHROPIC_API_KEY: 'sk-secret' });
      const withoutKey = validate({ PORT: '3100' });
      expect(withKey.configHash).toBe(withoutKey.configHash);
    });

    it('AGENTIC_AUTO_PROMOTE_MIN_TRADES defaults to 0 (auto-promotion disabled) and coerces', () => {
      expect(validate({ PORT: '3100' }).agentic.autoPromoteMinTrades).toBe(0);
      expect(
        validate({ PORT: '3100', AGENTIC_AUTO_PROMOTE_MIN_TRADES: '30' }).agentic
          .autoPromoteMinTrades,
      ).toBe(30);
    });

    it('AGENTIC_TOKEN_PRICE_*_PER_MTOK and PROMOTION_DUST_NOTIONAL default and override as decimal strings', () => {
      const defaults = validate({ PORT: '3100' }).agentic;
      expect(defaults.tokenPriceInputPerMtok).toBe('3');
      expect(defaults.tokenPriceOutputPerMtok).toBe('15');
      expect(defaults.promotionDustNotional).toBe('5');

      const overridden = validate({
        PORT: '3100',
        AGENTIC_TOKEN_PRICE_INPUT_PER_MTOK: '2.5',
        AGENTIC_TOKEN_PRICE_OUTPUT_PER_MTOK: '12.75',
        PROMOTION_DUST_NOTIONAL: '10',
      }).agentic;
      expect(overridden.tokenPriceInputPerMtok).toBe('2.5');
      expect(overridden.tokenPriceOutputPerMtok).toBe('12.75');
      expect(overridden.promotionDustNotional).toBe('10');
    });

    it('throws on a non-decimal AGENTIC_TOKEN_PRICE_INPUT_PER_MTOK', () => {
      expect(() => validate({ PORT: '3100', AGENTIC_TOKEN_PRICE_INPUT_PER_MTOK: 'free' })).toThrow(
        /AGENTIC_TOKEN_PRICE_INPUT_PER_MTOK/,
      );
    });

    it('throws on a non-decimal PROMOTION_DUST_NOTIONAL', () => {
      expect(() => validate({ PORT: '3100', PROMOTION_DUST_NOTIONAL: '-5' })).toThrow(
        /PROMOTION_DUST_NOTIONAL/,
      );
    });

    it('throws on negative AGENTIC_AUTO_PROMOTE_MIN_TRADES', () => {
      expect(() => validate({ PORT: '3100', AGENTIC_AUTO_PROMOTE_MIN_TRADES: '-1' })).toThrow(
        /AGENTIC_AUTO_PROMOTE_MIN_TRADES/,
      );
    });

    it('AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES defaults to 0 (evaluator disabled) and coerces', () => {
      expect(validate({ PORT: '3100' }).agentic.autoPromoteMinAttributedTrades).toBe(0);
      expect(
        validate({ PORT: '3100', AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES: '10' }).agentic
          .autoPromoteMinAttributedTrades,
      ).toBe(10);
      expect(() =>
        validate({ PORT: '3100', AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES: '-1' }),
      ).toThrow(/AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES/);
    });

    it('AGENTIC_MIN_RR defaults to 1.5 and stays an exact decimal string', () => {
      expect(validate({ PORT: '3100' }).agentic.minRr).toBe('1.5');
      expect(validate({ PORT: '3100', AGENTIC_MIN_RR: '2' }).agentic.minRr).toBe('2');
      expect(() => validate({ PORT: '3100', AGENTIC_MIN_RR: 'lots' })).toThrow(/AGENTIC_MIN_RR/);
    });

    it('AGENTIC_PLAN_EXIT_TTL_BARS defaults to 2 and rejects a 1-bar TTL (races its own age)', () => {
      expect(validate({ PORT: '3100' }).agentic.planExitTtlBars).toBe(2);
      expect(
        validate({ PORT: '3100', AGENTIC_PLAN_EXIT_TTL_BARS: '3' }).agentic.planExitTtlBars,
      ).toBe(3);
      expect(() => validate({ PORT: '3100', AGENTIC_PLAN_EXIT_TTL_BARS: '1' })).toThrow(
        /AGENTIC_PLAN_EXIT_TTL_BARS/,
      );
    });

    it('AGENTIC_QUIET_PAYLOAD_SAMPLE_BARS defaults to 0 (disabled) and coerces', () => {
      expect(validate({ PORT: '3100' }).agentic.quietPayloadSampleBars).toBe(0);
      expect(
        validate({ PORT: '3100', AGENTIC_QUIET_PAYLOAD_SAMPLE_BARS: '4' }).agentic
          .quietPayloadSampleBars,
      ).toBe(4);
    });

    it('cache price knobs default to sonnet-5 list rates as exact decimal strings', () => {
      const defaults = validate({ PORT: '3100' }).agentic;
      expect(defaults.tokenPriceCacheReadPerMtok).toBe('0.3');
      expect(defaults.tokenPriceCacheWritePerMtok).toBe('6');
      expect(() =>
        validate({ PORT: '3100', AGENTIC_TOKEN_PRICE_CACHE_READ_PER_MTOK: 'cheap' }),
      ).toThrow(/AGENTIC_TOKEN_PRICE_CACHE_READ_PER_MTOK/);
    });

    it('AGENTIC_TOKEN_PRICES_JSON parses a valid per-model map and is absent by default', () => {
      expect(validate({ PORT: '3100' }).agentic.tokenPrices).toBeUndefined();
      const cfg = validate({
        PORT: '3100',
        AGENTIC_TOKEN_PRICES_JSON:
          '{"claude-opus-4-8":{"inputPerMtok":"5","outputPerMtok":"25","cacheReadPerMtok":"0.5","cacheWritePerMtok":"10"}}',
      });
      expect(cfg.agentic.tokenPrices?.['claude-opus-4-8']).toEqual({
        inputPerMtok: '5',
        outputPerMtok: '25',
        cacheReadPerMtok: '0.5',
        cacheWritePerMtok: '10',
      });
    });

    it('AGENTIC_TOKEN_PRICES_JSON fails LOUD on malformed JSON and on a partial entry', () => {
      expect(() => validate({ PORT: '3100', AGENTIC_TOKEN_PRICES_JSON: '{nope' })).toThrow(
        /AGENTIC_TOKEN_PRICES_JSON is not valid JSON/,
      );
      // A partial entry would silently price the missing component at $0 — the exact fail-open
      // hole the map exists to close.
      expect(() =>
        validate({
          PORT: '3100',
          AGENTIC_TOKEN_PRICES_JSON: '{"claude-opus-4-8":{"inputPerMtok":"5"}}',
        }),
      ).toThrow(/AGENTIC_TOKEN_PRICES_JSON failed validation/);
    });

    it('PROMOTION_EVIDENCE_EPOCH accepts ISO-8601, treats empty as unset, rejects garbage', () => {
      expect(validate({ PORT: '3100' }).agentic.promotionEvidenceEpoch).toBeUndefined();
      expect(
        validate({ PORT: '3100', PROMOTION_EVIDENCE_EPOCH: '' }).agentic.promotionEvidenceEpoch,
      ).toBeUndefined();
      expect(
        validate({ PORT: '3100', PROMOTION_EVIDENCE_EPOCH: '2026-07-08T12:00:00Z' }).agentic
          .promotionEvidenceEpoch,
      ).toBe('2026-07-08T12:00:00Z');
      expect(() => validate({ PORT: '3100', PROMOTION_EVIDENCE_EPOCH: 'yesterday-ish' })).toThrow(
        /PROMOTION_EVIDENCE_EPOCH/,
      );
    });

    describe('prescreen warmup cross-field validation', () => {
      // Regression: AGENTIC_WARMUP_BARS shorter than either prescreen window means
      // evaluatePrescreen's hasEnoughData is false on every bar post-warmup too — the gate
      // permanently fails open (insufficient_data every bar) and the cost floor silently no-ops.
      it('throws naming all three knobs when warmup is below volLongBars', () => {
        expect(() =>
          validate({
            PORT: '3100',
            AGENTIC_WARMUP_BARS: '40',
            AGENTIC_PRESCREEN_VOL_LONG_BARS: '50',
            AGENTIC_PRESCREEN_BREAKOUT_LOOKBACK_BARS: '20',
          }),
        ).toThrow(
          /AGENTIC_WARMUP_BARS \(40\).*AGENTIC_PRESCREEN_VOL_LONG_BARS \(50\).*AGENTIC_PRESCREEN_BREAKOUT_LOOKBACK_BARS \(20\)/s,
        );
      });

      it('throws naming all three knobs when warmup is below breakoutLookbackBars', () => {
        expect(() =>
          validate({
            PORT: '3100',
            AGENTIC_WARMUP_BARS: '15',
            AGENTIC_PRESCREEN_VOL_LONG_BARS: '10',
            AGENTIC_PRESCREEN_BREAKOUT_LOOKBACK_BARS: '20',
          }),
        ).toThrow(
          /AGENTIC_WARMUP_BARS \(15\).*AGENTIC_PRESCREEN_VOL_LONG_BARS \(10\).*AGENTIC_PRESCREEN_BREAKOUT_LOOKBACK_BARS \(20\)/s,
        );
      });

      it('passes at the boundary — warmup exactly equal to volLongBars and breakoutLookbackBars', () => {
        const cfg = validate({
          PORT: '3100',
          AGENTIC_WARMUP_BARS: '50',
          AGENTIC_PRESCREEN_VOL_LONG_BARS: '50',
          AGENTIC_PRESCREEN_BREAKOUT_LOOKBACK_BARS: '50',
        });
        expect(cfg.agentic.warmupBars).toBe(50);
      });

      it('skips the check entirely when the prescreen gate is disabled', () => {
        const cfg = validate({
          PORT: '3100',
          AGENTIC_PRESCREEN_ENABLED: 'false',
          AGENTIC_WARMUP_BARS: '5',
          AGENTIC_PRESCREEN_VOL_LONG_BARS: '50',
          AGENTIC_PRESCREEN_BREAKOUT_LOOKBACK_BARS: '20',
        });
        expect(cfg.agentic.warmupBars).toBe(5);
      });
    });
  });

  describe('risk config', () => {
    it('BASE_NOTIONAL defaults to the documented 100 (exact string, not the retired 1000)', () => {
      expect(validate({ PORT: '3100' }).risk.baseNotional).toBe('100');
      expect(validate({ PORT: '3100', BASE_NOTIONAL: '250.5' }).risk.baseNotional).toBe('250.5');
    });

    it('throws on a non-decimal BASE_NOTIONAL', () => {
      expect(() => validate({ PORT: '3100', BASE_NOTIONAL: '1e3' })).toThrow(/BASE_NOTIONAL/);
      expect(() => validate({ PORT: '3100', BASE_NOTIONAL: '-5' })).toThrow(/BASE_NOTIONAL/);
    });

    it('RISK_* limit knobs default to the shipped DEFAULT_LIMITS values (exact strings)', () => {
      const risk = validate({ PORT: '3100' }).risk;
      expect(risk.maxOrderNotional).toBe('100000');
      expect(risk.maxPositionPerSymbol).toBe('1000');
      expect(risk.maxGrossExposure).toBe('1000000');
      expect(risk.maxNetExposure).toBe('1000000');
      expect(risk.maxDailyLoss).toBe('5000');
      expect(risk.maxDrawdownPct).toBe('0.2');
      expect(risk.maxBandBps).toBe(100);
      expect(risk.staleMaxAgeMs).toBe(5000);
    });

    it('RISK_* overrides land as given (money knobs stay exact strings)', () => {
      const risk = validate({
        PORT: '3100',
        RISK_MAX_ORDER_NOTIONAL: '500',
        RISK_MAX_DAILY_LOSS: '100.25',
        RISK_MAX_BAND_BPS: '50',
      }).risk;
      expect(risk.maxOrderNotional).toBe('500');
      expect(risk.maxDailyLoss).toBe('100.25');
      expect(risk.maxBandBps).toBe(50);
    });

    it('throws on a non-decimal RISK_MAX_ORDER_NOTIONAL', () => {
      expect(() => validate({ PORT: '3100', RISK_MAX_ORDER_NOTIONAL: 'lots' })).toThrow(
        /RISK_MAX_ORDER_NOTIONAL/,
      );
    });

    it('PROTECT_* backstop knobs default to 0 (disabled) and land as exact fraction strings', () => {
      const defaults = validate({ PORT: '3100' }).risk;
      expect(defaults.protectStopLossPct).toBe('0');
      expect(defaults.protectTrailingPct).toBe('0');
      const set = validate({
        PORT: '3100',
        PROTECT_STOP_LOSS_PCT: '0.02',
        PROTECT_TRAILING_PCT: '0.015',
      }).risk;
      expect(set.protectStopLossPct).toBe('0.02');
      expect(set.protectTrailingPct).toBe('0.015');
    });

    it('throws on a PROTECT_* value outside the 0..1 fraction range', () => {
      expect(() => validate({ PORT: '3100', PROTECT_STOP_LOSS_PCT: '2' })).toThrow(
        /PROTECT_STOP_LOSS_PCT/,
      );
      expect(() => validate({ PORT: '3100', PROTECT_TRAILING_PCT: '-0.1' })).toThrow(
        /PROTECT_TRAILING_PCT/,
      );
    });
  });

  describe('perp config', () => {
    it('PERP_LEVERAGE_CAP defaults to 1 and overrides as an exact decimal string', () => {
      expect(validate({ PORT: '3100' }).perp.leverageCap).toBe('1');
      expect(validate({ PORT: '3100', PERP_LEVERAGE_CAP: '5' }).perp.leverageCap).toBe('5');
    });

    it('rejects PERP_LEVERAGE_CAP=0 (fail closed: a zero cap divides margin/liqPrice by zero)', () => {
      expect(() => validate({ PORT: '3100', PERP_LEVERAGE_CAP: '0' })).toThrow(/PERP_LEVERAGE_CAP/);
      expect(() => validate({ PORT: '3100', PERP_LEVERAGE_CAP: '0.0' })).toThrow(
        /PERP_LEVERAGE_CAP/,
      );
    });
  });

  describe('strategy config', () => {
    it('TRADING_SYMBOLS absent → symbols falls back to [TRADING_SYMBOL]', () => {
      expect(validate({ PORT: '3100' }).strategy.symbols).toEqual(['BTC/USDT']);
      expect(validate({ PORT: '3100', TRADING_SYMBOL: 'ETH/USDT' }).strategy.symbols).toEqual([
        'ETH/USDT',
      ]);
    });

    it('TRADING_SYMBOLS CSV parses, trims, and wins over TRADING_SYMBOL', () => {
      const strategy = validate({
        PORT: '3100',
        TRADING_SYMBOL: 'SOL/USDT',
        TRADING_SYMBOLS: ' BTC/USDT , ETH/USDT ',
      }).strategy;
      expect(strategy.symbols).toEqual(['BTC/USDT', 'ETH/USDT']);
    });

    it('TRADING_SYMBOLS rejects duplicates and an all-commas value', () => {
      expect(() => validate({ PORT: '3100', TRADING_SYMBOLS: 'BTC/USDT,BTC/USDT' })).toThrow(
        /TRADING_SYMBOLS/,
      );
      expect(() => validate({ PORT: '3100', TRADING_SYMBOLS: ' , ' })).toThrow(/TRADING_SYMBOLS/);
    });

    it('defaults: BTC/USDT on 5m, agentic lane', () => {
      const strategy = validate({ PORT: '3100' }).strategy;
      expect(strategy.symbol).toBe('BTC/USDT');
      expect(strategy.interval).toBe('5m');
      expect(strategy.active).toBe('agentic');
    });

    it('reads TRADING_SYMBOL and STRATEGY_INTERVAL overrides', () => {
      const strategy = validate({
        PORT: '3100',
        TRADING_SYMBOL: 'ETH/USDT',
        STRATEGY_INTERVAL: '1m',
      }).strategy;
      expect(strategy.symbol).toBe('ETH/USDT');
      expect(strategy.interval).toBe('1m');
    });

    it('throws on an unknown STRATEGY_INTERVAL', () => {
      expect(() => validate({ PORT: '3100', STRATEGY_INTERVAL: '7m' })).toThrow(
        /STRATEGY_INTERVAL/,
      );
    });

    it('throws on a non-agentic ACTIVE_STRATEGY (the only registered lane)', () => {
      expect(() => validate({ PORT: '3100', ACTIVE_STRATEGY: 'ema-cross' })).toThrow(
        /ACTIVE_STRATEGY/,
      );
    });
  });
});
