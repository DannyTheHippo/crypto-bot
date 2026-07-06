/**
 * SACRED LIVEGATE SUITE — SEED FILE
 *
 * These tests assert the hard override: when NODE_ENV is 'test' or 'ci', or CI is truthy,
 * configMode MUST be 'paper' and live credential fields MUST be absent from the validated
 * config object regardless of what TRADING_MODE is set to.
 *
 * Never skip or delete these tests to make a suite pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validate } from '../../src/config/environment/environment.config';

const LIVE_ENV_BASE = {
  TRADING_MODE: 'live',
  PORT: '3100',
  BINANCE_LIVE_API_KEY: 'test-key-should-be-stripped',
  BINANCE_LIVE_API_SECRET: 'test-secret-should-be-stripped',
  ARMING_SECRET: 'test-arming-should-be-stripped',
  LIVE_BASE_URL_OVERRIDE: 'https://example.com',
};

describe('Config hard override: live credentials stripped in test/ci environments', () => {
  it('NODE_ENV=test + TRADING_MODE=live => configMode paper, downgrade recorded', () => {
    const env = { ...LIVE_ENV_BASE, NODE_ENV: 'test' };
    const cfg = validate(env);
    expect(cfg.mode.configMode).toBe('paper');
    expect(cfg.mode.downgrades.length).toBeGreaterThan(0);
    expect(cfg.mode.downgrades[0]).toMatch(/override/i);
  });

  it('NODE_ENV=test: BINANCE_LIVE_API_KEY absent from env after validate', () => {
    const env = { ...LIVE_ENV_BASE, NODE_ENV: 'test' };
    validate(env);
    expect(env['BINANCE_LIVE_API_KEY']).toBeUndefined();
    expect(env['BINANCE_LIVE_API_SECRET']).toBeUndefined();
    expect(env['ARMING_SECRET']).toBeUndefined();
    expect(env['LIVE_BASE_URL_OVERRIDE']).toBeUndefined();
  });

  it('CI=true + TRADING_MODE=live => configMode paper, downgrade recorded', () => {
    const env = { ...LIVE_ENV_BASE, CI: 'true' };
    const cfg = validate(env);
    expect(cfg.mode.configMode).toBe('paper');
    expect(cfg.mode.downgrades.length).toBeGreaterThan(0);
  });

  it('CI=true: live key fields stripped from env', () => {
    const env = { ...LIVE_ENV_BASE, CI: 'true' };
    validate(env);
    expect(env['BINANCE_LIVE_API_KEY']).toBeUndefined();
    expect(env['BINANCE_LIVE_API_SECRET']).toBeUndefined();
    expect(env['ARMING_SECRET']).toBeUndefined();
  });

  it('NODE_ENV=ci + TRADING_MODE=live => configMode paper, downgrade recorded', () => {
    const env = { ...LIVE_ENV_BASE, NODE_ENV: 'ci' };
    const cfg = validate(env);
    expect(cfg.mode.configMode).toBe('paper');
    expect(cfg.mode.downgrades.length).toBeGreaterThan(0);
  });

  it('NODE_ENV=ci: live key fields stripped from env', () => {
    const env = { ...LIVE_ENV_BASE, NODE_ENV: 'ci' };
    validate(env);
    expect(env['BINANCE_LIVE_API_KEY']).toBeUndefined();
    expect(env['BINANCE_LIVE_API_SECRET']).toBeUndefined();
    expect(env['ARMING_SECRET']).toBeUndefined();
  });

  it('NODE_ENV=test: live secrets are ABSENT from the validated AppConfig object (in-code backstop)', () => {
    // Stronger than the env-strip: even if a live credential leaked into env, validate() must not
    // carry it onto AppConfig under test/ci. This is the backstop the four-gate matrix relies on.
    const cfg = validate({ ...LIVE_ENV_BASE, NODE_ENV: 'test' });
    expect(cfg.liveApiKey).toBeUndefined();
    expect(cfg.liveApiSecret).toBeUndefined();
    expect(cfg.armingSecret).toBeUndefined();
    expect(cfg.liveBaseUrlOverride).toBeUndefined();
  });

  it('CI=true: live secrets absent from the validated AppConfig object', () => {
    const cfg = validate({ ...LIVE_ENV_BASE, CI: 'true' });
    expect(cfg.liveApiKey).toBeUndefined();
    expect(cfg.armingSecret).toBeUndefined();
  });

  it('outside test/ci: live secrets ARE read into AppConfig (the only path that reaches them)', () => {
    // No NODE_ENV/CI in the passed env ⇒ not test/ci ⇒ the read path is active and configMode=live.
    const cfg = validate({ ...LIVE_ENV_BASE });
    expect(cfg.mode.configMode).toBe('live');
    expect(cfg.liveApiKey).toBe('test-key-should-be-stripped');
    expect(cfg.liveApiSecret).toBe('test-secret-should-be-stripped');
    expect(cfg.armingSecret).toBe('test-arming-should-be-stripped');
    expect(cfg.liveBaseUrlOverride).toBe('https://example.com');
    // Secrets never enter the config hash.
    expect(cfg.configHash).not.toContain('test-key-should-be-stripped');
  });
});

describe('Config real-wiring: skipProcessEnv + validate() strips live secrets from ConfigService', () => {
  const KEYS_TO_SAVE = [
    'BINANCE_LIVE_API_KEY',
    'BINANCE_LIVE_API_SECRET',
    'ARMING_SECRET',
    'LIVE_BASE_URL_OVERRIDE',
    'NODE_ENV',
    'PORT',
    'TRADING_MODE',
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS_TO_SAVE) {
      savedEnv[k] = process.env[k];
    }
    vi.resetModules();
  });

  afterEach(async () => {
    for (const k of KEYS_TO_SAVE) {
      if (savedEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = savedEnv[k];
      }
    }
    // Clear prom-client registry to avoid duplicate metric errors across test runs
    const { register } = await import('prom-client');
    register.clear();
    vi.resetModules();
  });

  it('ConfigService.get returns undefined for BINANCE_LIVE_API_KEY and process.env is cleared when NODE_ENV=test', async () => {
    // Set env BEFORE dynamic import so forRoot/validate() sees it
    process.env['NODE_ENV'] = 'test';
    process.env['PORT'] = '3100';
    process.env['TRADING_MODE'] = 'live';
    process.env['BINANCE_LIVE_API_KEY'] = 'wiring-test-secret';
    process.env['BINANCE_LIVE_API_SECRET'] = 'wiring-test-secret2';
    process.env['ARMING_SECRET'] = 'wiring-arming';
    process.env['LIVE_BASE_URL_OVERRIDE'] = 'https://example.com';

    const { register } = await import('prom-client');
    register.clear();

    // Dynamic import ensures NestConfigModule.forRoot() evaluates after env is set
    const { AppConfigModule } = await import('../../src/config/config.module');
    const { Test } = await import('@nestjs/testing');
    const { ConfigService } = await import('@nestjs/config');

    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule],
    }).compile();

    await moduleRef.init();

    const configService = moduleRef.get(ConfigService);

    // validate() ran with NODE_ENV=test, so it deleted BINANCE_LIVE_API_KEY from process.env
    expect(process.env['BINANCE_LIVE_API_KEY']).toBeUndefined();
    // skipProcessEnv:true means ConfigService never falls back to process.env anyway
    expect(configService.get('BINANCE_LIVE_API_KEY')).toBeUndefined();

    await moduleRef.close();
  });
});
