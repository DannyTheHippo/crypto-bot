import { randomBytes } from 'node:crypto';
import { Global, Module } from '@nestjs/common';
import { RISK_SIGNING_KEY } from '../../../ports/trading/risk';

// W3 Part 4: pure code motion out of app.module.ts — see db-health-bridge.module.ts's own header
// comment on the boundaries 'app' zone widening this relies on.
//
// §4.2: ONE process-lifetime signing key, generated at the composition root and shared by exactly
// the RiskEngine (mint) and Execution (verify). Global so both modules resolve the same instance;
// never persisted, never in env.
@Global()
@Module({
  providers: [{ provide: RISK_SIGNING_KEY, useFactory: () => randomBytes(32) }],
  exports: [RISK_SIGNING_KEY],
})
export class SigningKeyModule {}
