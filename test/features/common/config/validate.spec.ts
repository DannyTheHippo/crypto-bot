import { describe, expect, it } from 'vitest';
import { validate as rawValidate } from '../../../../src/config/environment/environment.config';
import type { AppConfig } from '../../../../src/ports/common/app-config';

// Most assertions in this file exercise pure field-parsing/defaulting mechanics and don't care
// whether the boot path is test/ci or production — default NODE_ENV to 'test' so callers don't
// need to restate the v3-required DATABASE_URL/VENUES/TRADING_SYMBOLS knobs (environment.config.ts's
// test/ci carve-out, spec §3.2/§3.4). Tests that specifically exercise PRODUCTION-path behavior
// (mode resolution, the new DATABASE_URL/VENUES/PLAN_MODE refusals) override NODE_ENV: undefined
// explicitly, which restores the "no NODE_ENV at all" semantics validate() itself treats as
// non-test/ci (object spread with an explicit `undefined` value still overrides the default).
function validate(env: Record<string, string | undefined>): AppConfig {
  return rawValidate({ NODE_ENV: 'test', ...env });
}

// v3 §3.2/§3.4/§3.5: a minimal PRODUCTION-shaped env — DATABASE_URL + a covering VENUES/
// VENUE_CAPITAL_SPLIT/TRADING_SYMBOLS quadruple (spot-only by default) — for the handful of tests
// that must exercise the non-test/ci path. VENUE_CAPITAL_SPLIT's key-set must exactly match VENUES
// (§3.5) and AGENTIC_ACTIVE_MENU_SIZE must not exceed the basket, so both are pinned here too;
// callers overriding VENUES to add binanceusdm must override VENUE_CAPITAL_SPLIT to match.
function prodEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: undefined,
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    VENUES: JSON.stringify([{ id: 'binance', environment: 'demo' }]),
    VENUE_CAPITAL_SPLIT: JSON.stringify({ binance: '1000' }),
    TRADING_SYMBOLS: 'BTC/USDT',
    AGENTIC_ACTIVE_MENU_SIZE: '1',
    ...overrides,
  };
}

describe('validate()', () => {
  it('defaults to paper when TRADING_MODE is absent', () => {
    const cfg = validate({ PORT: '3100' });
    expect(cfg.mode.configMode).toBe('paper');
  });

  it('resolves to live when TRADING_MODE=live in a non-test env', () => {
    const cfg = validate(prodEnv({ TRADING_MODE: 'live', PORT: '3100' }));
    expect(cfg.mode.configMode).toBe('live');
    expect(cfg.mode.requestedMode).toBe('live');
  });

  it('resolves garbage TRADING_MODE to paper with downgrade reason', () => {
    const cfg = validate(prodEnv({ TRADING_MODE: 'garbage', PORT: '3100' }));
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

  // Deploy provenance is a measurement input, so it fails OPEN in BOTH directions — absent and
  // malformed. Compose interpolates it from the deployer's ambient GIT_SHA now, so an over-long value
  // is reachable by accident; throwing here would crash-loop the container and raise restart_storm on
  // an observability field. The degraded value is the one the sweep names as VOID.
  it('reads APP_GIT_SHA through, and degrades an over-long one to unknown rather than refusing boot', () => {
    expect(validate({ PORT: '3100', APP_GIT_SHA: 'c50db12' }).app.gitSha).toBe('c50db12');
    expect(validate({ PORT: '3100' }).app.gitSha).toBe('unknown');
    expect(validate({ PORT: '3100', APP_GIT_SHA: 'x'.repeat(65) }).app.gitSha).toBe('unknown');
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

  describe('DATABASE_URL required outside test/ci (v3 §3.2/§3.5)', () => {
    it('present → cfg.db.url is set to that value (test/ci — always optional there)', () => {
      const url = 'postgres://user:pass@localhost:5432/mydb';
      const cfg = validate({ PORT: '3100', DATABASE_URL: url });
      expect(cfg.db.url).toBe(url);
    });

    it('absent under test/ci (default) → cfg.db.url is undefined, never throws', () => {
      const cfg = validate({ PORT: '3100' });
      expect(cfg.db.url).toBeUndefined();
    });

    it('configHash is identical whether or not DATABASE_URL is present', () => {
      const withDb = validate({ PORT: '3100', DATABASE_URL: 'postgres://localhost/db' });
      const withoutDb = validate({ PORT: '3100' });
      expect(withDb.configHash).toBe(withoutDb.configHash);
    });

    it('throws outside test/ci when DATABASE_URL is absent', () => {
      expect(() => validate(prodEnv({ PORT: '3100', DATABASE_URL: undefined }))).toThrow(
        /DATABASE_URL/,
      );
    });

    it('passes outside test/ci when DATABASE_URL is present', () => {
      const cfg = validate(prodEnv({ PORT: '3100' }));
      expect(cfg.db.url).toBe('postgres://user:pass@localhost:5432/db');
    });
  });

  describe('VENUES required + exact symbol-coverage outside test/ci (v3 §3.2/§3.5)', () => {
    it('test/ci default never requires VENUES', () => {
      expect(validate({ PORT: '3100' }).venues).toEqual([]);
    });

    it('throws when VENUES is empty outside test/ci', () => {
      expect(() => validate(prodEnv({ PORT: '3100', VENUES: undefined }))).toThrow(/VENUES/);
    });

    it('throws when a perp symbol is configured but VENUES lacks binanceusdm', () => {
      expect(() =>
        validate(prodEnv({ PORT: '3100', TRADING_SYMBOLS: 'BTC/USDT,ETH/USDT:USDT' })),
      ).toThrow(/VENUES/);
    });

    it('throws when VENUES configures binanceusdm but no perp symbol is in TRADING_SYMBOLS', () => {
      expect(() =>
        validate(
          prodEnv({
            PORT: '3100',
            VENUES: JSON.stringify([
              { id: 'binance', environment: 'demo' },
              { id: 'binanceusdm', environment: 'demo' },
            ]),
            TRADING_SYMBOLS: 'BTC/USDT',
          }),
        ),
      ).toThrow(/VENUES/);
    });

    it('passes when VENUES exactly covers the venues implied by TRADING_SYMBOLS (mixed spot+perp)', () => {
      const cfg = validate(
        prodEnv({
          PORT: '3100',
          VENUES: JSON.stringify([
            { id: 'binance', environment: 'demo' },
            { id: 'binanceusdm', environment: 'demo' },
          ]),
          VENUE_CAPITAL_SPLIT: JSON.stringify({ binance: '500', binanceusdm: '500' }),
          TRADING_SYMBOLS: 'BTC/USDT,ETH/USDT:USDT',
        }),
      );
      expect(cfg.venues.map((v) => v.id).sort()).toEqual(['binance', 'binanceusdm']);
    });

    it('passes on a spot-only boot (default prodEnv shape)', () => {
      const cfg = validate(prodEnv({ PORT: '3100' }));
      expect(cfg.venues.map((v) => v.id)).toEqual(['binance']);
    });
  });

  describe('VENUE_CAPITAL_SPLIT key-set/positivity/Σ≤cap (v3 §3.1/§3.5)', () => {
    it('defaults to the both-venues 500/500 split', () => {
      expect(validate({ PORT: '3100' }).venueCapitalSplit).toEqual({
        binance: '500',
        binanceusdm: '500',
      });
    });

    it('throws malformed JSON loudly', () => {
      expect(() => validate({ PORT: '3100', VENUE_CAPITAL_SPLIT: '{nope' })).toThrow(
        /VENUE_CAPITAL_SPLIT is not valid JSON/,
      );
    });

    it('throws when a share is zero (positivity)', () => {
      expect(() =>
        validate({
          PORT: '3100',
          VENUE_CAPITAL_SPLIT: '{"binance":"0","binanceusdm":"500"}',
        }),
      ).toThrow(/VENUE_CAPITAL_SPLIT/);
    });

    it('throws when a share is negative (positivity)', () => {
      expect(() =>
        validate({
          PORT: '3100',
          VENUE_CAPITAL_SPLIT: '{"binance":"-100","binanceusdm":"500"}',
        }),
      ).toThrow(/VENUE_CAPITAL_SPLIT/);
    });

    it('key-set check no-ops while VENUES is unconfigured (test/ci default)', () => {
      expect(() =>
        validate({ PORT: '3100', VENUE_CAPITAL_SPLIT: '{"someOtherVenue":"1000"}' }),
      ).not.toThrow();
    });

    it('throws when the key set does not exactly match a configured VENUES', () => {
      expect(() =>
        validate(
          prodEnv({
            PORT: '3100',
            VENUE_CAPITAL_SPLIT: '{"binance":"500","binanceusdm":"500"}',
          }),
        ),
      ).toThrow(/VENUE_CAPITAL_SPLIT/);
    });

    it('passes when the key set exactly matches a configured single-venue VENUES', () => {
      const cfg = validate(prodEnv({ PORT: '3100', VENUE_CAPITAL_SPLIT: '{"binance":"1000"}' }));
      expect(cfg.venueCapitalSplit).toEqual({ binance: '1000' });
    });

    it('throws when the split sum exceeds SIZER_EQUITY_CAP', () => {
      expect(() =>
        validate({
          PORT: '3100',
          VENUE_CAPITAL_SPLIT: '{"binance":"600","binanceusdm":"600"}',
          SIZER_EQUITY_CAP: '1000',
        }),
      ).toThrow(/VENUE_CAPITAL_SPLIT/);
    });

    it('passes at exact equality (sum === cap)', () => {
      expect(() =>
        validate({
          PORT: '3100',
          VENUE_CAPITAL_SPLIT: '{"binance":"500","binanceusdm":"500"}',
          SIZER_EQUITY_CAP: '1000',
        }),
      ).not.toThrow();
    });

    it('sum-vs-cap check is skipped when SIZER_EQUITY_CAP is the disabled sentinel 0', () => {
      expect(() =>
        validate({
          PORT: '3100',
          VENUE_CAPITAL_SPLIT: '{"binance":"600","binanceusdm":"600"}',
          SIZER_EQUITY_CAP: '0',
        }),
      ).not.toThrow();
    });
  });

  describe('AGENTIC_PLAN_MODE=false refused when any perp symbol is configured (v3 §3.5)', () => {
    it('throws when plan mode is off and a perp symbol is configured', () => {
      expect(() =>
        validate({
          PORT: '3100',
          AGENTIC_PLAN_MODE: 'false',
          TRADING_SYMBOLS: 'BTC/USDT,ETH/USDT:USDT',
          AGENTIC_ACTIVE_MENU_SIZE: '2',
        }),
      ).toThrow(/AGENTIC_PLAN_MODE/);
    });

    it('passes when plan mode is off and every configured symbol is spot', () => {
      const cfg = validate({
        PORT: '3100',
        AGENTIC_PLAN_MODE: 'false',
        TRADING_SYMBOLS: 'BTC/USDT,ETH/USDT',
        AGENTIC_ACTIVE_MENU_SIZE: '2',
      });
      expect(cfg.agentic.planMode).toBe(false);
    });

    it('passes when plan mode is on (the v3 default) regardless of symbols', () => {
      const cfg = validate({
        PORT: '3100',
        TRADING_SYMBOLS: 'BTC/USDT,ETH/USDT:USDT',
        AGENTIC_ACTIVE_MENU_SIZE: '2',
      });
      expect(cfg.agentic.planMode).toBe(true);
    });
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
    // Boolean(env['CI']) where env['CI'] === 'false' → Boolean('false') === true → test-env override.
    // NODE_ENV explicitly unset here so this isolates the CI-truthy-string path from the wrapper's
    // own NODE_ENV='test' default (which would force paper regardless and make the test vacuous).
    const cfg = validate({ PORT: '3100', NODE_ENV: undefined, CI: 'false', TRADING_MODE: 'live' });
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
        maxTokens: 4096,
        minDecisionIntervalMs: 0,
        warmupBars: 50,
        maxCallsPerDay: 2000,
        maxTokensPerDay: 4_000_000,
        dailyCostStopUsd: 3,
        entryTtlBars: 2,
        // v3-transitional(#8,#10): derives from maxPositionFractionSpot until those workstreams
        // consume the per-venue-class fields directly.
        maxPositionFraction: '0.15',
        maxPositionFractionSpot: '0.15',
        maxPositionFractionPerp: '0.35',
        fallbackConsultBars: 8,
        wakeMovePct: '0.008',
        activeMenuSize: 8,
        maxEntriesPerDay: 12,
        drainCooldownBaseMs: 30_000,
        drainCooldownMaxMs: 900_000,
        // v3-transitional(#10): AGENTIC_AUTO_PROMOTE_MIN_TRADES deleted — permanently 0.
        autoPromoteMinTrades: 0,
        autoPromoteMinAttributedTrades: 0,
        playbookPin: undefined,
        playbookAbPct: 0,
        derivativesV2Enabled: false,
        bookStructureFeedEnabled: false,
        trackRecordEnabled: false,
        edgePolicyEnabled: false,
        edgePolicyFamily: 'none',
        crossSymbolEnabled: false,
        crossSymbolLookbackBars: 20,
        portfolioConsultEnabled: false,
        portfolioWindowMs: 3000,
        // v3 default flips false→true (the only deployed shape).
        planMode: true,
        planExitTtlBars: 2,
        // Plan-authoritative exits ship flag-off: unset ⇒ false ⇒ every model 'close' still exits.
        planAuthoritativeExits: false,
        quietPayloadSampleBars: 0,
        // v3 defaults flip false→true (the only deployed shape; the mutual-exclusion refusal that
        // used to gate this combination is retired — §3.5).
        venueTpEnabled: true,
        venueTpReplaceDriftBps: 10,
        venueStopEnabled: true,
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
        AGENTIC_MAX_POSITION_FRACTION_SPOT: '0.25',
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
      expect(cfg.agentic.maxPositionFractionSpot).toBe('0.25');
      expect(cfg.agentic.fallbackConsultBars).toBe(8);
      expect(cfg.agentic.wakeMovePct).toBe('0.03');
      expect(cfg.agentic.activeMenuSize).toBe(5);
    });

    describe('v3 contract knobs (§3.1/§3.2/§3.3)', () => {
      it('AGENTIC_MAX_POSITION_FRACTION_SPOT/_PERP default per §3.1 and reject an out-of-range fraction', () => {
        const defaults = validate({ PORT: '3100' }).agentic;
        expect(defaults.maxPositionFractionSpot).toBe('0.15');
        expect(defaults.maxPositionFractionPerp).toBe('0.35');
        expect(
          validate({ PORT: '3100', AGENTIC_MAX_POSITION_FRACTION_SPOT: '0.50' }).agentic
            .maxPositionFractionSpot,
        ).toBe('0.50');
        expect(() => validate({ PORT: '3100', AGENTIC_MAX_POSITION_FRACTION_PERP: '1.5' })).toThrow(
          /AGENTIC_MAX_POSITION_FRACTION_PERP/,
        );
      });

      it('AGENTIC_FALLBACK_CONSULT_BARS defaults to 8 (v3) and rejects below 1', () => {
        expect(validate({ PORT: '3100' }).agentic.fallbackConsultBars).toBe(8);
        expect(
          validate({ PORT: '3100', AGENTIC_FALLBACK_CONSULT_BARS: '4' }).agentic
            .fallbackConsultBars,
        ).toBe(4);
        expect(() => validate({ PORT: '3100', AGENTIC_FALLBACK_CONSULT_BARS: '0' })).toThrow(
          /AGENTIC_FALLBACK_CONSULT_BARS/,
        );
      });

      it('AGENTIC_WAKE_MOVE_PCT defaults to 0.008 (v3) and rejects an out-of-range fraction', () => {
        expect(validate({ PORT: '3100' }).agentic.wakeMovePct).toBe('0.008');
        expect(validate({ PORT: '3100', AGENTIC_WAKE_MOVE_PCT: '0.03' }).agentic.wakeMovePct).toBe(
          '0.03',
        );
        expect(() => validate({ PORT: '3100', AGENTIC_WAKE_MOVE_PCT: '2' })).toThrow(
          /AGENTIC_WAKE_MOVE_PCT/,
        );
      });

      it('SIZER_EQUITY_CAP defaults to 1000 (v3 — was optional/uncapped) and lands as an exact decimal string when set', () => {
        expect(validate({ PORT: '3100' }).risk.equityCap).toBe('1000');
        // Lowering the cap below the default VENUE_CAPITAL_SPLIT sum (1000) also needs a matching
        // split override, or the unrelated §3.5 sum-vs-cap refusal fires first — see the dedicated
        // VENUE_CAPITAL_SPLIT describe block above for that refusal's own coverage.
        expect(
          validate({
            PORT: '3100',
            SIZER_EQUITY_CAP: '500',
            VENUE_CAPITAL_SPLIT: '{"binance":"250","binanceusdm":"250"}',
          }).risk.equityCap,
        ).toBe('500');
        expect(() => validate({ PORT: '3100', SIZER_EQUITY_CAP: '-5' })).toThrow(
          /SIZER_EQUITY_CAP/,
        );
      });

      it('SIZER_MAX_PLANNED_STOP_RISK_FRACTION defaults to 0 and rejects out-of-range fractions', () => {
        expect(validate({ PORT: '3100' }).risk.maxPlannedStopRiskFraction).toBe('0');
        expect(
          validate({ PORT: '3100', SIZER_MAX_PLANNED_STOP_RISK_FRACTION: '0.01' }).risk
            .maxPlannedStopRiskFraction,
        ).toBe('0.01');
        expect(() => validate({ PORT: '3100', SIZER_MAX_PLANNED_STOP_RISK_FRACTION: '2' })).toThrow(
          /SIZER_MAX_PLANNED_STOP_RISK_FRACTION/,
        );
      });

      it('AGENTIC_ACTIVE_MENU_SIZE defaults to 8 (v3) and rejects a menu wider than the basket', () => {
        expect(validate({ PORT: '3100' }).agentic.activeMenuSize).toBe(8);
        expect(
          validate({
            PORT: '3100',
            AGENTIC_ACTIVE_MENU_SIZE: '2',
            TRADING_SYMBOLS: 'BTC/USDT,ETH/USDT,SOL/USDT',
          }).agentic.activeMenuSize,
        ).toBe(2);
        // test/ci default fallback basket is ['BTC/USDT'] (length 1) — the schema default of 8
        // exceeds that, so an explicit override is required to exercise the default cleanly.
        expect(
          validate({
            PORT: '3100',
            AGENTIC_ACTIVE_MENU_SIZE: '8',
            TRADING_SYMBOLS:
              'BTC/USDT,ETH/USDT,SOL/USDT,XRP/USDT,LINK/USDT,ZEC/USDT,AAVE/USDT,NEAR/USDT',
          }).agentic.activeMenuSize,
        ).toBe(8);
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

    // Decide-model A/B (AGENTIC_MODEL_AB_PCT). Neither knob is projected into cfg.agentic —
    // agentic-strategy.module.ts's selectAgentClient reads both raw off process.env, same convention
    // as AGENTIC_PORTFOLIO_CONSULT's sibling flags below (not every schema-validated AGENTIC_* key
    // has a cfg.agentic counterpart) — so these tests exercise validate()'s throw/no-throw contract
    // rather than a projected field.
    describe('AGENTIC_MODEL_AB_PCT / AGENTIC_MODEL_B pricing gate-honesty refusal', () => {
      const OPUS_PRICED_MODEL_B =
        '{"claude-opus-5":{"inputPerMtok":"5","outputPerMtok":"25","cacheReadPerMtok":"0.5","cacheWritePerMtok":"10"}}';

      it('AGENTIC_MODEL_AB_PCT defaults to 0 and never trips the refusal', () => {
        expect(() => validate({ PORT: '3100' })).not.toThrow();
      });

      it('throws on AGENTIC_MODEL_AB_PCT above 100', () => {
        expect(() => validate({ PORT: '3100', AGENTIC_MODEL_AB_PCT: '101' })).toThrow(
          /AGENTIC_MODEL_AB_PCT/,
        );
      });

      it('throws on negative AGENTIC_MODEL_AB_PCT', () => {
        expect(() => validate({ PORT: '3100', AGENTIC_MODEL_AB_PCT: '-1' })).toThrow(
          /AGENTIC_MODEL_AB_PCT/,
        );
      });

      it('throws when AGENTIC_MODEL_AB_PCT > 0 and AGENTIC_MODEL_B is unset', () => {
        expect(() => validate({ PORT: '3100', AGENTIC_MODEL_AB_PCT: '30' })).toThrow(
          /AGENTIC_MODEL_AB_PCT.*AGENTIC_MODEL_B/s,
        );
      });

      it('throws when AGENTIC_MODEL_B is set but AGENTIC_TOKEN_PRICES_JSON is absent', () => {
        expect(() =>
          validate({ PORT: '3100', AGENTIC_MODEL_AB_PCT: '30', AGENTIC_MODEL_B: 'claude-opus-5' }),
        ).toThrow(/AGENTIC_TOKEN_PRICES_JSON/);
      });

      it('throws when AGENTIC_TOKEN_PRICES_JSON is configured but omits AGENTIC_MODEL_B', () => {
        expect(() =>
          validate({
            PORT: '3100',
            AGENTIC_MODEL_AB_PCT: '30',
            AGENTIC_MODEL_B: 'claude-opus-5',
            AGENTIC_TOKEN_PRICES_JSON:
              '{"claude-sonnet-5":{"inputPerMtok":"3","outputPerMtok":"15","cacheReadPerMtok":"0.3","cacheWritePerMtok":"6"}}',
          }),
        ).toThrow(/AGENTIC_TOKEN_PRICES_JSON/);
      });

      it('passes when AGENTIC_MODEL_B has its own AGENTIC_TOKEN_PRICES_JSON entry', () => {
        expect(() =>
          validate({
            PORT: '3100',
            AGENTIC_MODEL_AB_PCT: '30',
            AGENTIC_MODEL_B: 'claude-opus-5',
            AGENTIC_TOKEN_PRICES_JSON: OPUS_PRICED_MODEL_B,
          }),
        ).not.toThrow();
      });

      it('never trips when AGENTIC_MODEL_AB_PCT is 0, regardless of AGENTIC_MODEL_B/pricing state', () => {
        expect(() =>
          validate({ PORT: '3100', AGENTIC_MODEL_AB_PCT: '0', AGENTIC_MODEL_B: 'claude-opus-5' }),
        ).not.toThrow();
      });

      it('malformed AGENTIC_TOKEN_PRICES_JSON still fails via its own throw, not this refusal', () => {
        expect(() =>
          validate({
            PORT: '3100',
            AGENTIC_MODEL_AB_PCT: '30',
            AGENTIC_MODEL_B: 'claude-opus-5',
            AGENTIC_TOKEN_PRICES_JSON: '{nope',
          }),
        ).toThrow(/AGENTIC_TOKEN_PRICES_JSON is not valid JSON/);
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

    describe('deleted lane-selector knobs (v3 §3.4)', () => {
      const SPOT_VENUE = JSON.stringify([{ id: 'binance', environment: 'paper' }]);
      const SPOT_SPLIT = JSON.stringify({ binance: '1000' });

      it('the deleted AGENTIC_SHORTS_ENABLED env var is silently ignored (unknown key, config parses)', () => {
        // zod object schemas strip unknown keys by default — the boot-flag semantics (and the
        // transitional derived field) are fully retired; shorts is a per-symbol capability now.
        const cfg = validate({
          PORT: '3100',
          AGENTIC_SHORTS_ENABLED: 'true',
          VENUES: SPOT_VENUE,
          VENUE_CAPITAL_SPLIT: SPOT_SPLIT,
        });
        expect('shortsEnabled' in cfg.agentic).toBe(false);
        expect('derivativesAbPct' in cfg.agentic).toBe(false);
      });
    });

    it('the reflection-loop and mint-backtest knobs are gone from cfg.agentic, and a stale env still boots', () => {
      // Deleted 2026-07-30 with the in-process reflection loop and its mint-time backtest. Same
      // `in`-assertion convention as the retired shortsEnabled/derivativesAbPct fields above. A
      // deployment whose env file still carries the keys must boot unchanged (they are simply
      // unknown keys now), which is the fail-open direction a retired knob requires.
      const cfg = validate({
        PORT: '3100',
        AGENTIC_REFLECTION_EVERY_N_TRADES: '5',
        AGENTIC_REFLECTION_COOLDOWN_MS: '3600000',
        AGENTIC_REFLECTION_TIMEOUT_MS: '90000',
        AGENTIC_MINT_BACKTEST_ROWS: '60',
        AGENTIC_MINT_BACKTEST_MARGIN_BPS: '15',
        AGENTIC_MINT_BACKTEST_MIN_TRIPS: '5',
      });
      for (const field of [
        'reflectionEveryNTrades',
        'reflectionCooldownMs',
        'reflectionTimeoutMs',
        'mintBacktestRows',
        'mintBacktestMarginBps',
        'mintBacktestMinTrips',
      ]) {
        expect(field in cfg.agentic).toBe(false);
      }
      // reflectionModel is NOT one of them — see the two cases below for why it survives.
      expect('reflectionModel' in cfg.agentic).toBe(true);
    });

    it('AGENTIC_REFLECTION_MODEL absent → undefined (one model, one price)', () => {
      const cfg = validate({ PORT: '3100' });
      expect(cfg.agentic.reflectionModel).toBeUndefined();
    });

    it('AGENTIC_REFLECTION_MODEL present → carried into cfg.agentic (priced, so the gate-honesty refusal below does not trip)', () => {
      const cfg = validate({
        PORT: '3100',
        AGENTIC_REFLECTION_MODEL: 'claude-opus-5',
        AGENTIC_TOKEN_PRICES_JSON:
          '{"claude-opus-5":{"inputPerMtok":"5","outputPerMtok":"25","cacheReadPerMtok":"0.5","cacheWritePerMtok":"10"}}',
      });
      expect(cfg.agentic.reflectionModel).toBe('claude-opus-5');
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

    it('AGENTIC_DERIVATIVES_AB_PCT is deleted (v3 §3.4, XA3) — the env var is silently ignored and the field is gone', () => {
      const cfg = validate({ PORT: '3100', AGENTIC_DERIVATIVES_AB_PCT: '30' });
      expect('derivativesAbPct' in cfg.agentic).toBe(false);
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

    it('agentic.autoPromoteMinTrades is permanently 0 — AGENTIC_AUTO_PROMOTE_MIN_TRADES is deleted (v3 §3.4)', () => {
      expect(validate({ PORT: '3100' }).agentic.autoPromoteMinTrades).toBe(0);
      // The deleted env var is silently ignored (unknown key), never resurrecting the legacy path.
      expect(
        validate({ PORT: '3100', AGENTIC_AUTO_PROMOTE_MIN_TRADES: '30' }).agentic
          .autoPromoteMinTrades,
      ).toBe(0);
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
          '{"claude-opus-5":{"inputPerMtok":"5","outputPerMtok":"25","cacheReadPerMtok":"0.5","cacheWritePerMtok":"10"}}',
      });
      expect(cfg.agentic.tokenPrices?.['claude-opus-5']).toEqual({
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
          AGENTIC_TOKEN_PRICES_JSON: '{"claude-opus-5":{"inputPerMtok":"5"}}',
        }),
      ).toThrow(/AGENTIC_TOKEN_PRICES_JSON failed validation/);
    });

    describe('AGENTIC_REFLECTION_MODEL pricing gate-honesty refusal (review finding, major)', () => {
      const OPUS_PRICED =
        '{"claude-opus-5":{"inputPerMtok":"5","outputPerMtok":"25","cacheReadPerMtok":"0.5","cacheWritePerMtok":"10"}}';

      it('throws when a differing reflection model has no AGENTIC_TOKEN_PRICES_JSON at all', () => {
        expect(() => validate({ PORT: '3100', AGENTIC_REFLECTION_MODEL: 'claude-opus-5' })).toThrow(
          /AGENTIC_REFLECTION_MODEL.*AGENTIC_MODEL.*AGENTIC_TOKEN_PRICES_JSON/s,
        );
      });

      it('throws when AGENTIC_TOKEN_PRICES_JSON is configured but omits the reflection model', () => {
        expect(() =>
          validate({
            PORT: '3100',
            AGENTIC_REFLECTION_MODEL: 'claude-opus-5',
            AGENTIC_TOKEN_PRICES_JSON:
              '{"claude-sonnet-5":{"inputPerMtok":"3","outputPerMtok":"15","cacheReadPerMtok":"0.3","cacheWritePerMtok":"6"}}',
          }),
        ).toThrow(/AGENTIC_TOKEN_PRICES_JSON/);
      });

      it('passes when the reflection model has its own AGENTIC_TOKEN_PRICES_JSON entry', () => {
        expect(() =>
          validate({
            PORT: '3100',
            AGENTIC_REFLECTION_MODEL: 'claude-opus-5',
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
            AGENTIC_REFLECTION_MODEL: 'claude-opus-5',
            AGENTIC_TOKEN_PRICES_JSON: '{nope',
          }),
        ).toThrow(/AGENTIC_TOKEN_PRICES_JSON is not valid JSON/);
      });

      // Shipped-lane regression: the deployed .env.app pins AGENTIC_REFLECTION_MODEL=claude-opus-5
      // with a price map covering both models — must never trip this refusal.
      it('shipped lane shape (opus reflection + both-model price map) never trips', () => {
        expect(() =>
          validate({
            PORT: '3100',
            AGENTIC_MODEL: 'claude-sonnet-5',
            AGENTIC_REFLECTION_MODEL: 'claude-opus-5',
            AGENTIC_TOKEN_PRICES_JSON:
              '{"claude-sonnet-5":{"inputPerMtok":"3","outputPerMtok":"15","cacheReadPerMtok":"0.3","cacheWritePerMtok":"6"},"claude-opus-5":{"inputPerMtok":"5","outputPerMtok":"25","cacheReadPerMtok":"0.5","cacheWritePerMtok":"10"}}',
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

    // v3 §3.5: the v2 "both TP+STOP only if all venues perp" refusal is RETIRED — mixed-venue boots
    // are the v3 norm and the mutual-exclusion rule is structurally unenforceable on them (a
    // per-symbol rule lives in the strategy lane, workstream #10, not here). Both default to true.
    describe('AGENTIC_VENUE_TP + AGENTIC_VENUE_STOP (v3: mutual-exclusion refusal retired)', () => {
      it('both default true and never throw on a spot-only VENUES', () => {
        const cfg = validate({
          PORT: '3100',
          VENUES: JSON.stringify([{ id: 'binance', environment: 'paper' }]),
          VENUE_CAPITAL_SPLIT: JSON.stringify({ binance: '1000' }),
        });
        expect(cfg.agentic.venueTpEnabled).toBe(true);
        expect(cfg.agentic.venueStopEnabled).toBe(true);
      });

      it('both stay true and never throw on a mixed spot+perp VENUES', () => {
        const cfg = validate({
          PORT: '3100',
          VENUES: JSON.stringify([
            { id: 'binanceusdm', environment: 'paper' },
            { id: 'binance', environment: 'paper' },
          ]),
        });
        expect(cfg.agentic.venueTpEnabled).toBe(true);
        expect(cfg.agentic.venueStopEnabled).toBe(true);
      });

      it('can still be individually disabled', () => {
        const cfg = validate({ PORT: '3100', AGENTIC_VENUE_STOP: 'false' });
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

    it('RISK_* limit knobs default to the v3 book-scale values (exact strings)', () => {
      const risk = validate({ PORT: '3100' }).risk;
      expect(risk.maxOrderNotional).toBe('400');
      expect(risk.maxPositionPerSymbol).toBe('350');
      expect(risk.maxGrossExposure).toBe('1200');
      expect(risk.maxNetExposure).toBe('1200');
      expect(risk.maxDailyLoss).toBe('50');
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
    it('PERP_LEVERAGE_CAP defaults to 2 (v3) and overrides as an exact decimal string', () => {
      expect(validate({ PORT: '3100' }).perp.leverageCap).toBe('2');
      // '3', not the new production '5' — paired with the unconfigured default MMR/buffer
      // (0.005/0.20), 5/0.005/0.20 now trips the F1a zeroing refusal (see its own describe block
      // below); this test only exercises override plumbing.
      expect(validate({ PORT: '3100', PERP_LEVERAGE_CAP: '3' }).perp.leverageCap).toBe('3');
    });

    it('rejects PERP_LEVERAGE_CAP=0 (fail closed: a zero cap divides margin/liqPrice by zero)', () => {
      expect(() => validate({ PORT: '3100', PERP_LEVERAGE_CAP: '0' })).toThrow(/PERP_LEVERAGE_CAP/);
      expect(() => validate({ PORT: '3100', PERP_LEVERAGE_CAP: '0.0' })).toThrow(
        /PERP_LEVERAGE_CAP/,
      );
    });

    it('PERP_LIQ_BUFFER_PCT defaults to 0.20 and overrides as an exact decimal string', () => {
      expect(validate({ PORT: '3100' }).perp.liqBufferPct).toBe('0.20');
      // '0.3', not '0.5' — paired with the unconfigured default leverage/MMR (2/0.005, distance
      // 0.495), 0.5 now trips the F1a zeroing refusal (see its own describe block below); this
      // test only exercises override plumbing.
      expect(validate({ PORT: '3100', PERP_LIQ_BUFFER_PCT: '0.3' }).perp.liqBufferPct).toBe('0.3');
    });

    it('throws on a PERP_LIQ_BUFFER_PCT value outside the 0..1 fraction range', () => {
      expect(() => validate({ PORT: '3100', PERP_LIQ_BUFFER_PCT: '2' })).toThrow(
        /PERP_LIQ_BUFFER_PCT/,
      );
      expect(() => validate({ PORT: '3100', PERP_LIQ_BUFFER_PCT: '-0.1' })).toThrow(
        /PERP_LIQ_BUFFER_PCT/,
      );
    });

    it('has no `enabled` field — PERP_VENUE_ENABLED is deleted (v3 §3.4)', () => {
      const perp = validate({ PORT: '3100' }).perp as unknown as Record<string, unknown>;
      expect(perp).not.toHaveProperty('enabled');
    });

    // F1a: liqSafeNotionalCap is not a graduated cap — a leverage/MMR/buffer triple either clears
    // the required liq-price buffer (any notional is safe) or it doesn't (every notional is
    // rejected). A triple that lands on the zero branch produces no boot-time signal today — refuse
    // at construction rather than let a misconfigured deployment boot into silent zero-size perp
    // entries.
    describe('perp leverage/MMR/buffer zeroing refusal (F1a)', () => {
      it('throws when leverage 5 pairs with the OLD default MMR/buffer (0.005/0.20)', () => {
        // 1/5 - 0.005 = 0.195 < 0.20 ⇒ liqSafeNotionalCap collapses to 0 — exactly the trap the
        // 2x→5x leverage cap change would have fallen into under the old buffer.
        expect(() => validate({ PORT: '3100', PERP_LEVERAGE_CAP: '5' })).toThrow(
          /PERP_LEVERAGE_CAP/,
        );
      });

      it('boots clean at the new production triple (5 / 0.02 / 0.15)', () => {
        const cfg = validate({
          PORT: '3100',
          PERP_LEVERAGE_CAP: '5',
          PERP_MMR_FALLBACK: '0.02',
          PERP_LIQ_BUFFER_PCT: '0.15',
        });
        expect(cfg.perp.leverageCap).toBe('5');
        expect(cfg.perp.mmrFallback).toBe('0.02');
        expect(cfg.perp.liqBufferPct).toBe('0.15');
      });

      it('boots clean at the current unconfigured default triple (2 / 0.005 / 0.20)', () => {
        const cfg = validate({ PORT: '3100' });
        expect(cfg.perp.leverageCap).toBe('2');
        expect(cfg.perp.mmrFallback).toBe('0.005');
        expect(cfg.perp.liqBufferPct).toBe('0.20');
      });
    });
  });

  describe('strategy config', () => {
    it("TRADING_SYMBOLS absent under test/ci (default) falls back to ['BTC/USDT']", () => {
      expect(validate({ PORT: '3100' }).strategy.symbols).toEqual(['BTC/USDT']);
    });

    it('throws outside test/ci when TRADING_SYMBOLS is absent (the legacy TRADING_SYMBOL fallback is deleted)', () => {
      expect(() => validate(prodEnv({ PORT: '3100', TRADING_SYMBOLS: undefined }))).toThrow(
        /TRADING_SYMBOLS/,
      );
    });

    it('TRADING_SYMBOLS CSV parses and trims', () => {
      const strategy = validate({
        PORT: '3100',
        TRADING_SYMBOLS: ' BTC/USDT , ETH/USDT ',
        // v3 default menu size (8) exceeds this 2-symbol basket — override to stay under the
        // menu-size-vs-basket superRefine (unrelated to what this test asserts).
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

    it('defaults: symbol/symbols/interval/active under the test/ci fallback basket', () => {
      const strategy = validate({ PORT: '3100' }).strategy;
      // v3-transitional(#5): symbol derives to the first configured symbol (app.module.ts's sole
      // consumer); TRADING_SYMBOL (the old single-knob source) is deleted.
      expect(strategy.symbol).toBe('BTC/USDT');
      expect(strategy.symbols).toEqual(['BTC/USDT']);
      expect(strategy.interval).toBe('5m');
      expect(strategy.active).toBe('agentic');
    });

    it('strategy.symbol derives to the first entry of a multi-symbol TRADING_SYMBOLS', () => {
      const strategy = validate({
        PORT: '3100',
        TRADING_SYMBOLS: 'ETH/USDT,BTC/USDT',
        AGENTIC_ACTIVE_MENU_SIZE: '2',
      }).strategy;
      expect(strategy.symbol).toBe('ETH/USDT');
      expect(strategy.symbols).toEqual(['ETH/USDT', 'BTC/USDT']);
    });

    it('reads STRATEGY_INTERVAL overrides', () => {
      const strategy = validate({
        PORT: '3100',
        STRATEGY_INTERVAL: '1m',
      }).strategy;
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
