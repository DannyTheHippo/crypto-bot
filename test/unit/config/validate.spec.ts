import { describe, expect, it } from 'vitest';
import { validate } from '../../../src/modules/config/app-config.schema';

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
        model: 'claude-opus-4-8',
        timeoutMs: 30000,
        maxTokens: 1024,
        minDecisionIntervalMs: 0,
        warmupBars: 50,
        maxCallsPerDay: 500,
        maxTokensPerDay: 2_000_000,
        maxEntriesPerDay: 12,
        drainCooldownBaseMs: 30_000,
        drainCooldownMaxMs: 900_000,
        reflectionEveryNTrades: 10,
        playbookPin: undefined,
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
        AGENTIC_MAX_ENTRIES_PER_DAY: '20',
        AGENTIC_DRAIN_COOLDOWN_BASE_MS: '15000',
        AGENTIC_DRAIN_COOLDOWN_MAX_MS: '600000',
        AGENTIC_REFLECTION_EVERY_N_TRADES: '5',
      });
      expect(cfg.agentic.model).toBe('claude-haiku-4-5');
      expect(cfg.agentic.timeoutMs).toBe(5000);
      expect(cfg.agentic.maxTokens).toBe(2048);
      expect(cfg.agentic.minDecisionIntervalMs).toBe(1000);
      expect(cfg.agentic.warmupBars).toBe(80);
      expect(cfg.agentic.maxCallsPerDay).toBe(1000);
      expect(cfg.agentic.maxTokensPerDay).toBe(5000000);
      expect(cfg.agentic.maxEntriesPerDay).toBe(20);
      expect(cfg.agentic.drainCooldownBaseMs).toBe(15000);
      expect(cfg.agentic.drainCooldownMaxMs).toBe(600000);
      expect(cfg.agentic.reflectionEveryNTrades).toBe(5);
    });

    it('AGENTIC_REFLECTION_EVERY_N_TRADES=0 is valid (means off)', () => {
      const cfg = validate({ PORT: '3100', AGENTIC_REFLECTION_EVERY_N_TRADES: '0' });
      expect(cfg.agentic.reflectionEveryNTrades).toBe(0);
    });

    it('AGENTIC_PLAYBOOK_PIN absent → undefined (unpinned)', () => {
      const cfg = validate({ PORT: '3100' });
      expect(cfg.agentic.playbookPin).toBeUndefined();
    });

    it('AGENTIC_PLAYBOOK_PIN present → parsed as a positive int', () => {
      const cfg = validate({ PORT: '3100', AGENTIC_PLAYBOOK_PIN: '7' });
      expect(cfg.agentic.playbookPin).toBe(7);
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
  });
});
