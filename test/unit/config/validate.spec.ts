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
        maxPositionFraction: '0.15',
        fallbackConsultBars: 16,
        wakeMovePct: '0.015',
        activeMenuSize: 12,
        maxEntriesPerDay: 12,
        drainCooldownBaseMs: 30_000,
        drainCooldownMaxMs: 900_000,
        reflectionEveryNTrades: 10,
        reflectionCooldownMs: 604_800_000,
        mintBacktestRows: 0,
        mintBacktestMarginBps: 10,
        mintBacktestMinTrips: 3,
        autoPromoteMinTrades: 0,
        autoPromoteMinAttributedTrades: 0,
        playbookPin: undefined,
        playbookAbPct: 0,
        derivativesAbPct: 0,
        derivativesV2Enabled: false,
        bookStructureFeedEnabled: false,
        trackRecordEnabled: false,
        crossSymbolEnabled: false,
        crossSymbolLookbackBars: 20,
        portfolioConsultEnabled: false,
        portfolioWindowMs: 3000,
        shortsEnabled: false,
        planMode: false,
        planExitTtlBars: 2,
        quietPayloadSampleBars: 0,
        venueTpEnabled: false,
        venueTpReplaceDriftBps: 10,
        venueStopEnabled: false,
        venueStopReplaceDriftBps: 10,
        tokenPriceInputPerMtok: '3',
        tokenPriceOutputPerMtok: '15',
        tokenPriceCacheReadPerMtok: '0.3',
        tokenPriceCacheWritePerMtok: '6',
        tokenPrices: undefined,
        promotionEvidenceEpoch: undefined,
        promotionDustNotional: '5',
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
        AGENTIC_MAX_POSITION_FRACTION: '0.25',
        AGENTIC_FALLBACK_CONSULT_BARS: '8',
        AGENTIC_WAKE_MOVE_PCT: '0.03',
        AGENTIC_ACTIVE_MENU_SIZE: '5',
        TRADING_SYMBOLS: 'BTC/USDT,ETH/USDT,SOL/USDT,XRP/USDT,LINK/USDT',
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
      expect(cfg.agentic.maxPositionFraction).toBe('0.25');
      expect(cfg.agentic.fallbackConsultBars).toBe(8);
      expect(cfg.agentic.wakeMovePct).toBe('0.03');
      expect(cfg.agentic.activeMenuSize).toBe(5);
    });

    describe('v2 contract knobs (D1)', () => {
      it('AGENTIC_MAX_POSITION_FRACTION defaults to 0.15 and rejects an out-of-range fraction', () => {
        expect(validate({ PORT: '3100' }).agentic.maxPositionFraction).toBe('0.15');
        expect(
          validate({ PORT: '3100', AGENTIC_MAX_POSITION_FRACTION: '0.50' }).agentic
            .maxPositionFraction,
        ).toBe('0.50');
        expect(() => validate({ PORT: '3100', AGENTIC_MAX_POSITION_FRACTION: '1.5' })).toThrow(
          /AGENTIC_MAX_POSITION_FRACTION/,
        );
      });

      it('AGENTIC_FALLBACK_CONSULT_BARS defaults to 16 and rejects below 1', () => {
        expect(validate({ PORT: '3100' }).agentic.fallbackConsultBars).toBe(16);
        expect(
          validate({ PORT: '3100', AGENTIC_FALLBACK_CONSULT_BARS: '4' }).agentic
            .fallbackConsultBars,
        ).toBe(4);
        expect(() => validate({ PORT: '3100', AGENTIC_FALLBACK_CONSULT_BARS: '0' })).toThrow(
          /AGENTIC_FALLBACK_CONSULT_BARS/,
        );
      });

      it('AGENTIC_WAKE_MOVE_PCT defaults to 0.015 and rejects an out-of-range fraction', () => {
        expect(validate({ PORT: '3100' }).agentic.wakeMovePct).toBe('0.015');
        expect(validate({ PORT: '3100', AGENTIC_WAKE_MOVE_PCT: '0.03' }).agentic.wakeMovePct).toBe(
          '0.03',
        );
        expect(() => validate({ PORT: '3100', AGENTIC_WAKE_MOVE_PCT: '2' })).toThrow(
          /AGENTIC_WAKE_MOVE_PCT/,
        );
      });

      it('SIZER_EQUITY_CAP is absent (uncapped) by default and lands as an exact decimal string when set', () => {
        expect(validate({ PORT: '3100' }).risk.equityCap).toBeUndefined();
        expect(validate({ PORT: '3100', SIZER_EQUITY_CAP: '1000' }).risk.equityCap).toBe('1000');
        expect(() => validate({ PORT: '3100', SIZER_EQUITY_CAP: '-5' })).toThrow(
          /SIZER_EQUITY_CAP/,
        );
      });

      it('AGENTIC_ACTIVE_MENU_SIZE defaults to 12 and rejects a menu wider than an EXPLICIT basket', () => {
        expect(validate({ PORT: '3100' }).agentic.activeMenuSize).toBe(12);
        expect(
          validate({
            PORT: '3100',
            AGENTIC_ACTIVE_MENU_SIZE: '2',
            TRADING_SYMBOLS: 'BTC/USDT,ETH/USDT,SOL/USDT',
          }).agentic.activeMenuSize,
        ).toBe(2);
        // The check binds only to an EXPLICIT TRADING_SYMBOLS CSV — the legacy single-symbol
        // fallback (TRADING_SYMBOLS unset) predates U1's menu concept and must stay byte-identical
        // for every unconfigured deployment, so the default menu size of 12 is a no-op here.
        expect(
          validate({ PORT: '3100', AGENTIC_ACTIVE_MENU_SIZE: '12' }).agentic.activeMenuSize,
        ).toBe(12);
        expect(() =>
          validate({
            PORT: '3100',
            AGENTIC_ACTIVE_MENU_SIZE: '4',
            TRADING_SYMBOLS: 'BTC/USDT,ETH/USDT,SOL/USDT',
          }),
        ).toThrow(/AGENTIC_ACTIVE_MENU_SIZE/);
        // Boundary: menu size exactly equal to the basket size passes.
        expect(
          validate({
            PORT: '3100',
            AGENTIC_ACTIVE_MENU_SIZE: '3',
            TRADING_SYMBOLS: 'BTC/USDT,ETH/USDT,SOL/USDT',
          }).agentic.activeMenuSize,
        ).toBe(3);
      });
    });

    describe('PROTECT_STOP_LOSS_PCT vs the v2 stop-loss upper bound (D1 backstop-vs-model-stop)', () => {
      it('default PROTECT_STOP_LOSS_PCT (0, disabled) never trips the refusal', () => {
        expect(validate({ PORT: '3100' }).risk.protectStopLossPct).toBe('0');
      });

      it('throws when PROTECT_STOP_LOSS_PCT is at or below the 0.05 SL bound', () => {
        expect(() => validate({ PORT: '3100', PROTECT_STOP_LOSS_PCT: '0.05' })).toThrow(
          /PROTECT_STOP_LOSS_PCT/,
        );
        expect(() => validate({ PORT: '3100', PROTECT_STOP_LOSS_PCT: '0.02' })).toThrow(
          /PROTECT_STOP_LOSS_PCT/,
        );
      });

      it('passes when PROTECT_STOP_LOSS_PCT clears the 0.05 SL bound', () => {
        const cfg = validate({ PORT: '3100', PROTECT_STOP_LOSS_PCT: '0.06' });
        expect(cfg.risk.protectStopLossPct).toBe('0.06');
      });
    });

    describe('AGENTIC_SHORTS_ENABLED requires a binanceusdm venue (D1)', () => {
      const SPOT_VENUE = JSON.stringify([{ id: 'binance', environment: 'paper' }]);
      const PERP_VENUE = JSON.stringify([{ id: 'binanceusdm', environment: 'paper' }]);

      it('throws when shorts are enabled with no configured venue', () => {
        expect(() => validate({ PORT: '3100', AGENTIC_SHORTS_ENABLED: 'true' })).toThrow(
          /AGENTIC_SHORTS_ENABLED/,
        );
      });

      it('throws when shorts are enabled on a spot-only venue', () => {
        expect(() =>
          validate({ PORT: '3100', AGENTIC_SHORTS_ENABLED: 'true', VENUES: SPOT_VENUE }),
        ).toThrow(/AGENTIC_SHORTS_ENABLED/);
      });

      it('passes when shorts are enabled with a binanceusdm venue configured', () => {
        const cfg = validate({
          PORT: '3100',
          AGENTIC_SHORTS_ENABLED: 'true',
          VENUES: PERP_VENUE,
        });
        expect(cfg.agentic.shortsEnabled).toBe(true);
      });

      it('passes when shorts are disabled regardless of venues', () => {
        const cfg = validate({ PORT: '3100', VENUES: SPOT_VENUE });
        expect(cfg.agentic.shortsEnabled).toBe(false);
      });
    });

    it('AGENTIC_REFLECTION_EVERY_N_TRADES=0 is valid (means off)', () => {
      const cfg = validate({ PORT: '3100', AGENTIC_REFLECTION_EVERY_N_TRADES: '0' });
      expect(cfg.agentic.reflectionEveryNTrades).toBe(0);
    });

    it('AGENTIC_REFLECTION_MODEL absent → undefined (reflection follows AGENTIC_MODEL)', () => {
      const cfg = validate({ PORT: '3100' });
      expect(cfg.agentic.reflectionModel).toBeUndefined();
    });

    it('AGENTIC_REFLECTION_MODEL present → carried into cfg.agentic (priced, so the gate-honesty refusal below does not trip)', () => {
      const cfg = validate({
        PORT: '3100',
        AGENTIC_REFLECTION_MODEL: 'claude-opus-4-8',
        AGENTIC_TOKEN_PRICES_JSON:
          '{"claude-opus-4-8":{"inputPerMtok":"5","outputPerMtok":"25","cacheReadPerMtok":"0.5","cacheWritePerMtok":"10"}}',
      });
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

    it('AGENTIC_DERIVATIVES_AB_PCT absent → 0 (control arm disabled)', () => {
      const cfg = validate({ PORT: '3100' });
      expect(cfg.agentic.derivativesAbPct).toBe(0);
    });

    it('AGENTIC_DERIVATIVES_AB_PCT present → parsed within 0-50', () => {
      const cfg = validate({ PORT: '3100', AGENTIC_DERIVATIVES_AB_PCT: '30' });
      expect(cfg.agentic.derivativesAbPct).toBe(30);
    });

    it('throws on AGENTIC_DERIVATIVES_AB_PCT above 50', () => {
      expect(() => validate({ PORT: '3100', AGENTIC_DERIVATIVES_AB_PCT: '51' })).toThrow(
        /AGENTIC_DERIVATIVES_AB_PCT/,
      );
    });

    it('AGENTIC_CROSS_SYMBOL_ENABLED="false" resolves to false (strict enum parse, not z.coerce.boolean — Boolean("false") === true was the bug)', () => {
      expect(validate({ PORT: '3100' }).agentic.crossSymbolEnabled).toBe(false);
      expect(
        validate({ PORT: '3100', AGENTIC_CROSS_SYMBOL_ENABLED: 'false' }).agentic
          .crossSymbolEnabled,
      ).toBe(false);
      expect(
        validate({ PORT: '3100', AGENTIC_CROSS_SYMBOL_ENABLED: 'true' }).agentic.crossSymbolEnabled,
      ).toBe(true);
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

    it('AGENTIC_MINT_BACKTEST_* default to (0, 10, 3) — off unless a deployment opts in — and coerce', () => {
      const defaults = validate({ PORT: '3100' }).agentic;
      expect(defaults.mintBacktestRows).toBe(0);
      expect(defaults.mintBacktestMarginBps).toBe(10);
      expect(defaults.mintBacktestMinTrips).toBe(3);

      const overridden = validate({
        PORT: '3100',
        AGENTIC_MINT_BACKTEST_ROWS: '60',
        AGENTIC_MINT_BACKTEST_MARGIN_BPS: '15',
        AGENTIC_MINT_BACKTEST_MIN_TRIPS: '5',
      }).agentic;
      expect(overridden.mintBacktestRows).toBe(60);
      expect(overridden.mintBacktestMarginBps).toBe(15);
      expect(overridden.mintBacktestMinTrips).toBe(5);
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

    describe('AGENTIC_REFLECTION_MODEL pricing gate-honesty refusal (review finding, major)', () => {
      const OPUS_PRICED =
        '{"claude-opus-4-8":{"inputPerMtok":"5","outputPerMtok":"25","cacheReadPerMtok":"0.5","cacheWritePerMtok":"10"}}';

      it('throws when a differing reflection model has no AGENTIC_TOKEN_PRICES_JSON at all', () => {
        expect(() =>
          validate({ PORT: '3100', AGENTIC_REFLECTION_MODEL: 'claude-opus-4-8' }),
        ).toThrow(/AGENTIC_REFLECTION_MODEL.*AGENTIC_MODEL.*AGENTIC_TOKEN_PRICES_JSON/s);
      });

      it('throws when AGENTIC_TOKEN_PRICES_JSON is configured but omits the reflection model', () => {
        expect(() =>
          validate({
            PORT: '3100',
            AGENTIC_REFLECTION_MODEL: 'claude-opus-4-8',
            AGENTIC_TOKEN_PRICES_JSON:
              '{"claude-sonnet-5":{"inputPerMtok":"3","outputPerMtok":"15","cacheReadPerMtok":"0.3","cacheWritePerMtok":"6"}}',
          }),
        ).toThrow(/AGENTIC_TOKEN_PRICES_JSON/);
      });

      it('passes when the reflection model has its own AGENTIC_TOKEN_PRICES_JSON entry', () => {
        expect(() =>
          validate({
            PORT: '3100',
            AGENTIC_REFLECTION_MODEL: 'claude-opus-4-8',
            AGENTIC_TOKEN_PRICES_JSON: OPUS_PRICED,
          }),
        ).not.toThrow();
      });

      it('never trips when AGENTIC_REFLECTION_MODEL is absent, regardless of AGENTIC_TOKEN_PRICES_JSON', () => {
        expect(() => validate({ PORT: '3100' })).not.toThrow();
      });

      it('never trips when AGENTIC_REFLECTION_MODEL equals AGENTIC_MODEL (same price either way)', () => {
        expect(() =>
          validate({
            PORT: '3100',
            AGENTIC_MODEL: 'claude-sonnet-5',
            AGENTIC_REFLECTION_MODEL: 'claude-sonnet-5',
          }),
        ).not.toThrow();
      });

      it('malformed AGENTIC_TOKEN_PRICES_JSON still fails via its own throw, not this refusal', () => {
        expect(() =>
          validate({
            PORT: '3100',
            AGENTIC_REFLECTION_MODEL: 'claude-opus-4-8',
            AGENTIC_TOKEN_PRICES_JSON: '{nope',
          }),
        ).toThrow(/AGENTIC_TOKEN_PRICES_JSON is not valid JSON/);
      });

      // Shipped-lane regression: both .env.app and .env.app-perp pin AGENTIC_REFLECTION_MODEL=
      // claude-opus-4-8 with a price map covering both models — must never trip this refusal.
      it('shipped lane shape (opus reflection + both-model price map) never trips', () => {
        expect(() =>
          validate({
            PORT: '3100',
            AGENTIC_MODEL: 'claude-sonnet-5',
            AGENTIC_REFLECTION_MODEL: 'claude-opus-4-8',
            AGENTIC_TOKEN_PRICES_JSON:
              '{"claude-sonnet-5":{"inputPerMtok":"3","outputPerMtok":"15","cacheReadPerMtok":"0.3","cacheWritePerMtok":"6"},"claude-opus-4-8":{"inputPerMtok":"5","outputPerMtok":"25","cacheReadPerMtok":"0.5","cacheWritePerMtok":"10"}}',
          }),
        ).not.toThrow();
      });
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
      // W4 audit: the currently-shipped lane epochs (full UTC instants) still pass.
      expect(
        validate({ PORT: '3100', PROMOTION_EVIDENCE_EPOCH: '2026-07-18T15:36:14Z' }).agentic
          .promotionEvidenceEpoch,
      ).toBe('2026-07-18T15:36:14Z');
      // W4 audit: a date-only string used to parse as silent midnight UTC — now refused.
      expect(() => validate({ PORT: '3100', PROMOTION_EVIDENCE_EPOCH: '2026-07-18' })).toThrow(
        /PROMOTION_EVIDENCE_EPOCH/,
      );
      // W4 audit: a non-Z (local/offset) instant is refused — the epoch must be unambiguous UTC.
      expect(() =>
        validate({ PORT: '3100', PROMOTION_EVIDENCE_EPOCH: '2026-07-18T15:36:14+02:00' }),
      ).toThrow(/PROMOTION_EVIDENCE_EPOCH/);
    });

    // Push 3 P7f fix 4: a resting venue TP already locks the full base balance — a spot deployment
    // has no balance left to back a second full-size protective stop, so both-on + any spot venue
    // must refuse loudly at construction rather than place-then-reject at runtime.
    describe('AGENTIC_VENUE_TP + AGENTIC_VENUE_STOP spot cross-field refusal', () => {
      const SPOT_VENUE = JSON.stringify([{ id: 'binance', environment: 'paper' }]);
      const PERP_VENUE = JSON.stringify([{ id: 'binanceusdm', environment: 'paper' }]);
      const MIXED_VENUES = JSON.stringify([
        { id: 'binanceusdm', environment: 'paper' },
        { id: 'binance', environment: 'paper' },
      ]);

      it('throws when both are enabled and the only configured venue is spot', () => {
        expect(() =>
          validate({
            PORT: '3100',
            AGENTIC_VENUE_TP: 'true',
            AGENTIC_VENUE_STOP: 'true',
            VENUES: SPOT_VENUE,
          }),
        ).toThrow(/AGENTIC_VENUE_TP and AGENTIC_VENUE_STOP/);
      });

      it('throws when both are enabled and ANY configured venue is spot (mixed deployment)', () => {
        expect(() =>
          validate({
            PORT: '3100',
            AGENTIC_VENUE_TP: 'true',
            AGENTIC_VENUE_STOP: 'true',
            VENUES: MIXED_VENUES,
          }),
        ).toThrow(/AGENTIC_VENUE_TP and AGENTIC_VENUE_STOP/);
      });

      it('passes when both are enabled and every configured venue is perp', () => {
        const cfg = validate({
          PORT: '3100',
          AGENTIC_VENUE_TP: 'true',
          AGENTIC_VENUE_STOP: 'true',
          VENUES: PERP_VENUE,
        });
        expect(cfg.agentic.venueTpEnabled).toBe(true);
        expect(cfg.agentic.venueStopEnabled).toBe(true);
      });

      it('passes on a spot venue when only AGENTIC_VENUE_TP is enabled (single-leg)', () => {
        const cfg = validate({
          PORT: '3100',
          AGENTIC_VENUE_TP: 'true',
          VENUES: SPOT_VENUE,
        });
        expect(cfg.agentic.venueTpEnabled).toBe(true);
        expect(cfg.agentic.venueStopEnabled).toBe(false);
      });

      it('throws with both enabled and no VENUES configured (empty VENUES resolves to the real spot venue at boot — treated as spot, not unconfigured)', () => {
        expect(() =>
          validate({
            PORT: '3100',
            AGENTIC_VENUE_TP: 'true',
            AGENTIC_VENUE_STOP: 'true',
          }),
        ).toThrow(/AGENTIC_VENUE_TP and AGENTIC_VENUE_STOP/);
      });

      it('passes on the spot lane shape: VENUE_TP alone (empty VENUES), VENUE_STOP off', () => {
        const cfg = validate({
          PORT: '3100',
          AGENTIC_VENUE_TP: 'true',
        });
        expect(cfg.agentic.venueTpEnabled).toBe(true);
        expect(cfg.agentic.venueStopEnabled).toBe(false);
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
      expect(risk.maxPassiveExitBandBps).toBe(1200);
      expect(risk.maxStopTriggerBandBps).toBe(2000);
      expect(risk.stopLimitBufferBps).toBe(50);
      expect(risk.staleMaxAgeMs).toBe(5000);
    });

    it('RISK_* overrides land as given (money knobs stay exact strings)', () => {
      const risk = validate({
        PORT: '3100',
        RISK_MAX_ORDER_NOTIONAL: '500',
        RISK_MAX_DAILY_LOSS: '100.25',
        RISK_MAX_BAND_BPS: '50',
        RISK_MAX_PASSIVE_EXIT_BAND_BPS: '900',
        RISK_MAX_STOP_TRIGGER_BAND_BPS: '1500',
        STOP_LIMIT_BUFFER_BPS: '75',
      }).risk;
      expect(risk.maxOrderNotional).toBe('500');
      expect(risk.maxDailyLoss).toBe('100.25');
      expect(risk.maxBandBps).toBe(50);
      expect(risk.maxPassiveExitBandBps).toBe(900);
      expect(risk.maxStopTriggerBandBps).toBe(1500);
      expect(risk.stopLimitBufferBps).toBe(75);
    });

    it('rejects a STOP_LIMIT_BUFFER_BPS above the 200 cap', () => {
      expect(() => validate({ PORT: '3100', STOP_LIMIT_BUFFER_BPS: '201' })).toThrow(
        /STOP_LIMIT_BUFFER_BPS/,
      );
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
      // D1: PROTECT_STOP_LOSS_PCT must clear the v2 SL bound (0.05) — 0.06 is the plan's deploy
      // target (Design § Live-scale economics), unlike the pre-D1 0.02 this test used to set.
      const set = validate({
        PORT: '3100',
        PROTECT_STOP_LOSS_PCT: '0.06',
        PROTECT_TRAILING_PCT: '0.015',
      }).risk;
      expect(set.protectStopLossPct).toBe('0.06');
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

    // EXIT_CROSS_BUFFER_BPS is schema-capped at 99 against the hardcoded RISK_MAX_BAND_BPS default
    // (100), but RISK_MAX_BAND_BPS is itself a configurable knob — a lowered band must refuse at
    // construction rather than silently self-veto every reduce-only exit at runtime.
    describe('EXIT_CROSS_BUFFER_BPS vs RISK_MAX_BAND_BPS cross-field refusal', () => {
      it('throws when RISK_MAX_BAND_BPS is lowered below EXIT_CROSS_BUFFER_BPS', () => {
        expect(() =>
          validate({ PORT: '3100', RISK_MAX_BAND_BPS: '20', EXIT_CROSS_BUFFER_BPS: '25' }),
        ).toThrow(/EXIT_CROSS_BUFFER_BPS/);
      });

      it('throws at the boundary (buffer equal to band)', () => {
        expect(() =>
          validate({ PORT: '3100', RISK_MAX_BAND_BPS: '25', EXIT_CROSS_BUFFER_BPS: '25' }),
        ).toThrow(/EXIT_CROSS_BUFFER_BPS/);
      });

      it('passes when the buffer stays strictly below the band', () => {
        const cfg = validate({
          PORT: '3100',
          RISK_MAX_BAND_BPS: '26',
          EXIT_CROSS_BUFFER_BPS: '25',
        });
        expect(cfg.risk.maxBandBps).toBe(26);
        expect(cfg.risk.exitCrossBufferBps).toBe(25);
      });

      it('passes with unconfigured defaults (buffer 25 < band 100)', () => {
        const cfg = validate({ PORT: '3100' });
        expect(cfg.risk.exitCrossBufferBps).toBe(25);
        expect(cfg.risk.maxBandBps).toBe(100);
      });
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

    it('PERP_LIQ_BUFFER_PCT defaults to 0.20 and overrides as an exact decimal string', () => {
      expect(validate({ PORT: '3100' }).perp.liqBufferPct).toBe('0.20');
      expect(validate({ PORT: '3100', PERP_LIQ_BUFFER_PCT: '0.5' }).perp.liqBufferPct).toBe('0.5');
    });

    it('throws on a PERP_LIQ_BUFFER_PCT value outside the 0..1 fraction range', () => {
      expect(() => validate({ PORT: '3100', PERP_LIQ_BUFFER_PCT: '2' })).toThrow(
        /PERP_LIQ_BUFFER_PCT/,
      );
      expect(() => validate({ PORT: '3100', PERP_LIQ_BUFFER_PCT: '-0.1' })).toThrow(
        /PERP_LIQ_BUFFER_PCT/,
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
        // D1: AGENTIC_ACTIVE_MENU_SIZE defaults to 12, which exceeds this 2-symbol basket — override
        // to stay under the menu-size-vs-basket superRefine (unrelated to what this test asserts).
        AGENTIC_ACTIVE_MENU_SIZE: '2',
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
