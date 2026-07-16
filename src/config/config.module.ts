import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validate } from './environment/environment.config';
import { TypedConfigService } from './environment/typed-config.service';

// Hermetic under test/CI: a developer's local ./.env (deployed-stack values — TRADING_MODE=testnet,
// a compose-internal DATABASE_URL) must never leak into unit runs, or the suite diverges from CI
// (which has no .env). Mirrors environment.config.ts's isTestOrCiEnv semantics; evaluated once at
// import time, same as forRoot itself.
const isTestOrCi =
  process.env['NODE_ENV'] === 'test' || process.env['NODE_ENV'] === 'ci' || !!process.env['CI'];

// @Global: forRoot's isGlobal:true only globalizes the INNER NestConfigModule/ConfigService — it
// does not extend to sibling providers added to THIS module later. TypedConfigService is consumed
// by modules that never import AppConfigModule (RiskModule, ExecutionModule, PersistenceModule,
// ObservabilityModule, ModeControlModule — see each module's own CONFIG_OPTIONAL/@Optional comment),
// exactly as ConfigService is today. Without @Global here, those non-optional injection sites fail
// DI resolution at boot and the @Optional sites silently fall back to paper defaults even outside
// test/ci — confirmed empirically via test/unit/execution/app-module.boot.spec.ts's full AppModule
// boot, which fails at app.init() ("Nest can't resolve dependencies of TypedConfigService") without
// this decorator.
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      skipProcessEnv: true,
      ignoreEnvFile: isTestOrCi,
      // Secrets first (.env), then deploy knobs (.env.app). Nest loadEnvFile gives first path
      // precedence — same order as docker compose env_file: [.env.app, .env] where later wins.
      envFilePath: ['.env', '.env.app'],
      validate: (env: Record<string, string | undefined>) => validate(env),
    }),
  ],
  providers: [TypedConfigService],
  exports: [NestConfigModule, TypedConfigService],
})
export class AppConfigModule {}
