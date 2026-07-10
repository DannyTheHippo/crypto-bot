import {
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
  Provider,
} from '@nestjs/common';
import { TypedConfigService } from '../config/environment/typed-config.service';
import * as path from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schemas/trading';

import {
  DATABASE_POOL,
  DRIZZLE_DB,
  DB_TRANSACTION,
  ORDER_REPO,
  FILL_REPO,
  SIGNAL_REPO,
  RISK_DECISION_REPO,
  AGENT_DECISION_REPO,
  PLAYBOOK_VERSION_REPO,
  OUTBOX,
  JOURNAL,
  CONFIG_SNAPSHOT_REPO,
  EQUITY_REPO,
  RECONCILIATION_REPO,
  MODE_TRANSITION_REPO,
  INTENT_REPO,
  EXPERIMENT_REPO,
} from './database.tokens';
import { DB_HEALTH } from '../ports/db-health';

import { IntentRepository } from './repositories/intent.repository';
import { OrderRepository } from './repositories/order.repository';
import { FillRepository } from './repositories/fill.repository';
import { SignalRepository } from './repositories/signal.repository';
import { RiskDecisionRepository } from './repositories/risk-decision.repository';
import { AgentDecisionRepository } from './repositories/agent-decision.repository';
import { PlaybookVersionRepository } from './repositories/playbook-version.repository';
import { OutboxRepository } from './repositories/outbox.repository';
import { JournalRepository } from './repositories/journal.repository';
import { ConfigSnapshotRepository } from './repositories/config-snapshot.repository';
import { EquityRepository } from './repositories/equity.repository';
import { ReconciliationRepository } from './repositories/reconciliation.repository';
import { ModeTransitionRepository } from './repositories/mode-transition.repository';
import { ExperimentRepository } from './repositories/experiment.repository';
import { DbHealthIndicator } from './db-health.indicator';

const poolProvider: Provider = {
  provide: DATABASE_POOL,
  useFactory: (config: TypedConfigService) => {
    const dbUrl = config.db.url;
    if (!dbUrl) {
      // When DATABASE_URL is absent the module registers but the pool is null.
      // DbHealthIndicator reports 'not_configured'; the app boots in paper mode without DB.
      return null;
    }
    const logger = new Logger('PersistenceModule');
    const pool = new Pool({ connectionString: dbUrl, max: 10 });
    pool.on('error', (err) => {
      logger.error('Idle pool client error', err instanceof Error ? err.message : String(err));
    });
    return pool;
  },
  inject: [TypedConfigService],
};

const drizzleProvider: Provider = {
  provide: DRIZZLE_DB,
  useFactory: (pool: Pool | null) => {
    if (!pool) return null;
    return drizzle(pool, { schema });
  },
  inject: [DATABASE_POOL],
};

const transactionProvider: Provider = {
  provide: DB_TRANSACTION,
  useFactory: (db: ReturnType<typeof drizzle<typeof schema>> | null) => {
    if (!db) return null;
    // Null when pool is not configured (paper mode without DB).
    return (fn: Parameters<typeof db.transaction>[0]) => db.transaction(fn);
  },
  inject: [DRIZZLE_DB],
};

const repoProviders: Provider[] = [
  { provide: INTENT_REPO, useClass: IntentRepository },
  { provide: ORDER_REPO, useClass: OrderRepository },
  { provide: FILL_REPO, useClass: FillRepository },
  { provide: SIGNAL_REPO, useClass: SignalRepository },
  { provide: RISK_DECISION_REPO, useClass: RiskDecisionRepository },
  { provide: AGENT_DECISION_REPO, useClass: AgentDecisionRepository },
  { provide: PLAYBOOK_VERSION_REPO, useClass: PlaybookVersionRepository },
  { provide: OUTBOX, useClass: OutboxRepository },
  { provide: JOURNAL, useClass: JournalRepository },
  { provide: CONFIG_SNAPSHOT_REPO, useClass: ConfigSnapshotRepository },
  { provide: EQUITY_REPO, useClass: EquityRepository },
  { provide: RECONCILIATION_REPO, useClass: ReconciliationRepository },
  { provide: MODE_TRANSITION_REPO, useClass: ModeTransitionRepository },
  { provide: EXPERIMENT_REPO, useClass: ExperimentRepository },
];

const dbHealthProvider: Provider = {
  provide: DB_HEALTH,
  useExisting: DbHealthIndicator,
};

// Resolved from package root at runtime. __dirname is dist/database after build;
// going up 2 levels lands at the project root. The drizzle/ folder is checked in at project root.
const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../drizzle');

function isTestEnv(): boolean {
  return (
    process.env['NODE_ENV'] === 'test' ||
    process.env['NODE_ENV'] === 'ci' ||
    Boolean(process.env['CI'])
  );
}

@Module({
  providers: [
    poolProvider,
    drizzleProvider,
    transactionProvider,
    ...repoProviders,
    DbHealthIndicator,
    dbHealthProvider,
  ],
  exports: [
    DATABASE_POOL,
    DRIZZLE_DB,
    DB_TRANSACTION,
    INTENT_REPO,
    ORDER_REPO,
    FILL_REPO,
    SIGNAL_REPO,
    RISK_DECISION_REPO,
    AGENT_DECISION_REPO,
    PLAYBOOK_VERSION_REPO,
    OUTBOX,
    JOURNAL,
    CONFIG_SNAPSHOT_REPO,
    EQUITY_REPO,
    RECONCILIATION_REPO,
    MODE_TRANSITION_REPO,
    EXPERIMENT_REPO,
    DB_HEALTH,
    // Exported so the global DbHealthBridgeModule (composition root) can alias
    // DB_HEALTH via `useExisting` without re-exporting an imported token (which
    // Nest forbids — a module may only export its own providers or imported modules).
    DbHealthIndicator,
  ],
})
export class PersistenceModule implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('PersistenceModule');

  constructor(
    @Inject(DATABASE_POOL)
    private readonly pool: Pool | null,
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
  ) {}

  // Applies pending migrations at boot. Skipped under test/ci (hermetic suites use their own
  // migrate call + SKIP guard; running the boot migrator there would require a live DB).
  async onModuleInit(): Promise<void> {
    if (isTestEnv() || !this.db) return;
    this.log.log(`running migrations from ${MIGRATIONS_FOLDER}`);
    await migrate(this.db, { migrationsFolder: MIGRATIONS_FOLDER });
    this.log.log('migrations applied');
  }

  // Drains the pool on graceful shutdown to avoid connection leaks.
  async onApplicationShutdown() {
    if (this.pool) await this.pool.end();
  }
}
