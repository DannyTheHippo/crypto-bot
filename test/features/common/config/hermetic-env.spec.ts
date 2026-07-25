import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import { AppConfigModule } from '../../../../src/config/config.module';
import type { AppConfig } from '../../../../src/ports/common/app-config';

// Regression guard for the P0-baseline leak: a developer's local ./.env carries deployed-stack
// values (TRADING_MODE=testnet, a compose-internal DATABASE_URL) that used to flow into unit-test
// AppModule boots — health checks went 503 on an unreachable pg host and the suite diverged from CI
// (which has no .env). AppConfigModule now sets ignoreEnvFile under NODE_ENV=test/ci; this spec
// boots the REAL module and proves .env values do not surface. The file-content guards keep the
// spec meaningful on a developer machine and vacuously green in CI where no .env exists.
describe('AppConfigModule hermeticity (test/CI never reads ./.env)', () => {
  it('a config booted under NODE_ENV=test ignores ./.env values', async () => {
    const mod = await Test.createTestingModule({ imports: [AppConfigModule] }).compile();
    const config = mod.get<ConfigService<AppConfig, true>>(ConfigService);
    const db = config.get('db', { infer: true });
    const mode = config.get('mode', { infer: true });

    const envFile = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
    if (/^DATABASE_URL=.+/m.test(envFile) && process.env['DATABASE_URL'] === undefined) {
      expect(db.url).toBeUndefined();
    }
    if (/^TRADING_MODE=testnet/m.test(envFile) && process.env['TRADING_MODE'] === undefined) {
      expect(mode.requestedMode).not.toBe('testnet');
    }
    // Unconditional backstop: NODE_ENV=test forces paper no matter what leaked.
    expect(mode.configMode).toBe('paper');
    await mod.close();
  });
});
