import { Global, Module } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { KillSwitchService } from '../risk/kill-switch.service';
import {
  KILL_SWITCH,
  KILL_SWITCH_AUDIT,
  type KillSwitchAuditPort,
} from '../../../ports/trading/risk';
import { PersistenceModule } from '../../../database/database.module';
import { DRIZZLE_DB } from '../../../database/database.tokens';
import { DrizzleKillSwitchAudit } from '../../../database/repositories/trading/drizzle-kill-switch-audit';
import type * as schema from '../../../database/schemas/trading';

// W3 Part 4: pure code motion out of app.module.ts — see db-health-bridge.module.ts's own header
// comment on the boundaries 'app' zone widening this relies on.
//
// §5: ONE global kill switch. Risk engages it (monitors/reconcile/anomalies) and reads it in the
// pre-trade gate; Execution engages it too (fill-payload conflict, unknown-state timeout,
// reconciliation HALT). A single shared instance is load-bearing — two would let Execution halt a
// switch Risk never reads. RiskModule and ExecutionModule both consume this global, neither owns it.
function isTestEnv(): boolean {
  return (
    process.env['NODE_ENV'] === 'test' ||
    process.env['NODE_ENV'] === 'ci' ||
    Boolean(process.env['CI'])
  );
}

@Global()
@Module({
  imports: [PersistenceModule],
  providers: [
    KillSwitchService,
    { provide: KILL_SWITCH, useExisting: KillSwitchService },
    {
      // M2: undefined under test/ci/no-DB, mirroring every other *_OVERRIDE-style token's
      // fail-to-undefined posture (e.g. persistence-overrides.module.ts's MODE_AUDIT_OVERRIDE).
      // KillSwitchService's own @Optional injection treats absence as a silent no-op.
      provide: KILL_SWITCH_AUDIT,
      useFactory: (db: NodePgDatabase<typeof schema> | null): KillSwitchAuditPort | undefined =>
        isTestEnv() || db === null ? undefined : new DrizzleKillSwitchAudit(db),
      inject: [DRIZZLE_DB],
    },
  ],
  exports: [KillSwitchService, KILL_SWITCH],
})
export class KillSwitchModule {}
