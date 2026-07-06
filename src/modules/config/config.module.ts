import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validate } from './app-config.schema';

// Hermetic under test/CI: a developer's local ./.env (deployed-stack values — TRADING_MODE=testnet,
// a compose-internal DATABASE_URL) must never leak into unit runs, or the suite diverges from CI
// (which has no .env). Mirrors app-config.schema.ts's isTestOrCiEnv semantics; evaluated once at
// import time, same as forRoot itself.
const isTestOrCi =
  process.env['NODE_ENV'] === 'test' || process.env['NODE_ENV'] === 'ci' || !!process.env['CI'];

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      skipProcessEnv: true,
      ignoreEnvFile: isTestOrCi,
      validate: (env: Record<string, string | undefined>) => validate(env),
    }),
  ],
  exports: [NestConfigModule],
})
export class AppConfigModule {}
