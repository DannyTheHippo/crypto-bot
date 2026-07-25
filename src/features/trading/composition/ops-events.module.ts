import { Global, Module } from '@nestjs/common';
import { ObservabilityModule } from '../../common/observability/observability.module';
import { OpsEventLogger } from '../../common/observability/ops-event-logger';
import { OPS_EVENTS } from '../../../ports/common/observability';

// Backlog #52 (W12 operational event logging): mirrors limits-complete.module.ts / kill-switch.
// module.ts's own shape — a small @Global() binding that lets execution/risk feature services depend
// on OPS_EVENTS via @Optional @Inject without a cross-feature import (boundaries wall — see
// ports/common/observability.ts's own header comment). Only the composition root ('app' zone) may import
// ObservabilityModule directly; this module exists solely to carry that right to the token.
@Global()
@Module({
  imports: [ObservabilityModule],
  providers: [{ provide: OPS_EVENTS, useExisting: OpsEventLogger }],
  exports: [OPS_EVENTS],
})
export class OpsEventsModule {}
