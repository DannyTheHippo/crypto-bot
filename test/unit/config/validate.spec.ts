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
});
