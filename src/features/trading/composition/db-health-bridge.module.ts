import { Global, Module } from '@nestjs/common';
import { PersistenceModule } from '../../../database/database.module';
import { DbHealthIndicator } from '../../../database/db-health.indicator';
import { DB_HEALTH } from '../../../ports/common/db-health';

// W3 Part 4: pure code motion out of app.module.ts (boundaries' 'app' zone pattern was widened to
// cover src/features/trading/composition/** for exactly this decomposition — see eslint.config.mjs's
// own comment on that zone entry). Byte-identical provider/export shape to the original.
//
// Lifts only DB_HEALTH from PersistenceModule into the global DI scope so ObservabilityModule's
// HealthController resolves it via @Optional() @Inject(DB_HEALTH) without importing persistence.
@Global()
@Module({
  imports: [PersistenceModule],
  providers: [{ provide: DB_HEALTH, useExisting: DbHealthIndicator }],
  exports: [DB_HEALTH],
})
export class DbHealthBridgeModule {}
