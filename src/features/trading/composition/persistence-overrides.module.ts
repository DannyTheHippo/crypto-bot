import { Global, Module } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { PersistenceModule } from '../../../database/database.module';
import { DrizzleExecutionStore } from '../../../database/repositories/trading/drizzle-execution-store';
import { DrizzleExecOutbox } from '../../../database/repositories/trading/drizzle-exec-outbox';
import { PgAdvisoryInstanceLock } from '../../../database/repositories/common/pg-advisory-instance-lock';
import { DrizzleModeAudit } from '../../../database/repositories/trading/drizzle-mode-audit';
import { RiskDecisionJournalAdapter } from '../../../database/repositories/trading/risk-decision-journal.adapter';
import { SignalJournalAdapter } from '../../../database/repositories/trading/signal-journal.adapter';
import { FundingPaymentsRepository } from '../../../database/repositories/venue/funding-payments.repository';
import type { ConfigSnapshotRepository } from '../../../database/repositories/trading/config-snapshot.repository';
import { CONFIG_SNAPSHOT_REPO, DATABASE_POOL, DRIZZLE_DB } from '../../../database/database.tokens';
import type * as schema from '../../../database/schemas/trading';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import {
  EXEC_OUTBOX_OVERRIDE,
  EXECUTION_STORE_OVERRIDE,
  INSTANCE_LOCK_OVERRIDE,
  type ExecOutboxPort,
  type ExecutionStorePort,
  type InstanceLockPort,
  type ExecRunContext,
} from '../../../ports/trading/execution';
import { MODE_AUDIT_OVERRIDE, type ModeAuditPort } from '../../../ports/trading/mode-control';
import { RISK_JOURNAL_OVERRIDE, type RiskJournalPort } from '../../../ports/trading/risk';
import {
  CONFIG_SNAPSHOT_WRITER,
  type ConfigSnapshotWriterPort,
} from '../../../ports/trading/config-snapshot';
import { SIGNAL_JOURNAL, type SignalJournalPort } from '../../../ports/strategy/strategy';
import { FUNDING_PAYMENTS, type FundingPaymentsPort } from '../../../ports/venue/funding-payments';

// v3 spec §1.3: pure code motion of app.module.ts's DrizzlePersistenceGlobalModule — same seven
// tokens, same factories. Policy change carried structurally rather than in code: v3 config refuses
// to boot outside test/ci without DATABASE_URL (§3), so the `db === null` fallback below is reachable
// only under test/ci — the hermetic suite keeps its in-memory backings; a production boot always has
// a pool.
function isTestEnv(): boolean {
  return (
    process.env['NODE_ENV'] === 'test' ||
    process.env['NODE_ENV'] === 'ci' ||
    Boolean(process.env['CI'])
  );
}

function dbRunContext(config: TypedConfigService): ExecRunContext {
  const bootId = config.app.bootId;
  return { mode: config.mode.configMode, runId: `run-${bootId}`, bootId };
}

@Global()
@Module({
  imports: [PersistenceModule],
  providers: [
    {
      provide: EXEC_OUTBOX_OVERRIDE,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: TypedConfigService,
      ): ExecOutboxPort | undefined =>
        isTestEnv() || db === null ? undefined : new DrizzleExecOutbox(db, dbRunContext(config)),
      inject: [DRIZZLE_DB, TypedConfigService],
    },
    {
      provide: EXECUTION_STORE_OVERRIDE,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: TypedConfigService,
      ): ExecutionStorePort | undefined =>
        isTestEnv() || db === null
          ? undefined
          : new DrizzleExecutionStore(db, dbRunContext(config)),
      inject: [DRIZZLE_DB, TypedConfigService],
    },
    {
      provide: INSTANCE_LOCK_OVERRIDE,
      useFactory: (pool: Pool | null): InstanceLockPort | undefined =>
        isTestEnv() || pool === null ? undefined : new PgAdvisoryInstanceLock(pool),
      inject: [DATABASE_POOL],
    },
    {
      provide: MODE_AUDIT_OVERRIDE,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: TypedConfigService,
      ): ModeAuditPort | undefined =>
        isTestEnv() || db === null ? undefined : new DrizzleModeAudit(db, config.app.bootId),
      inject: [DRIZZLE_DB, TypedConfigService],
    },
    {
      // DB-backed RISK_JOURNAL: persists every risk verdict to risk_decisions for offline analysis.
      provide: RISK_JOURNAL_OVERRIDE,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: TypedConfigService,
      ): RiskJournalPort | undefined =>
        isTestEnv() || db === null
          ? undefined
          : new RiskDecisionJournalAdapter(db, dbRunContext(config)),
      inject: [DRIZZLE_DB, TypedConfigService],
    },
    {
      // DB-backed SIGNAL_JOURNAL: persists every routed signal + its outcome to the signals table.
      // SignalSink injects this @Optional, so undefined (paper/no-DB/test) simply skips journaling.
      provide: SIGNAL_JOURNAL,
      useFactory: (
        db: NodePgDatabase<typeof schema> | null,
        config: TypedConfigService,
      ): SignalJournalPort | undefined =>
        isTestEnv() || db === null ? undefined : new SignalJournalAdapter(db, dbRunContext(config)),
      inject: [DRIZZLE_DB, TypedConfigService],
    },
    {
      // P5b: DB-backed FUNDING_PAYMENTS writer/cursor. No in-memory fallback (durability is
      // load-bearing — promotion math must survive a redeploy), mirroring PROMOTION_STATS's own
      // fail-closed-to-undefined posture: undefined under test/ci/no-DB, and FundingIngestService's
      // composition-root gate (ContextFeedsModule) simply never starts the poller when this is
      // undefined.
      provide: FUNDING_PAYMENTS,
      useFactory: (db: NodePgDatabase<typeof schema> | null): FundingPaymentsPort | undefined =>
        isTestEnv() || db === null ? undefined : new FundingPaymentsRepository(db),
      inject: [DRIZZLE_DB],
    },
    {
      // Wraps the ALREADY-BOUND CONFIG_SNAPSHOT_REPO (database.module.ts's repoProviders) rather
      // than constructing a second instance off the same db handle — CONFIG_SNAPSHOT_REPO has been
      // bound and unused since 214eb7d; this is the fix that finally consumes it. Undefined under
      // test/ci/no-DB mirrors every other override here — TradingRuntimeService's @Optional injection
      // then simply skips the write (write-config-snapshot.ts's own fail-open direction covers a
      // write that IS attempted but fails; this covers the write never being attempted at all).
      provide: CONFIG_SNAPSHOT_WRITER,
      useFactory: (
        repo: ConfigSnapshotRepository,
        db: NodePgDatabase<typeof schema> | null,
      ): ConfigSnapshotWriterPort | undefined => (isTestEnv() || db === null ? undefined : repo),
      inject: [CONFIG_SNAPSHOT_REPO, DRIZZLE_DB],
    },
  ],
  exports: [
    EXEC_OUTBOX_OVERRIDE,
    EXECUTION_STORE_OVERRIDE,
    INSTANCE_LOCK_OVERRIDE,
    MODE_AUDIT_OVERRIDE,
    RISK_JOURNAL_OVERRIDE,
    SIGNAL_JOURNAL,
    FUNDING_PAYMENTS,
    CONFIG_SNAPSHOT_WRITER,
  ],
})
export class PersistenceOverridesModule {}
