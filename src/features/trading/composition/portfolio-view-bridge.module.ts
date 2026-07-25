import { Global, Module } from '@nestjs/common';
import { ExecutionModule } from '../execution/execution.module';
import { PortfolioStateService } from '../execution/portfolio-state.service';
import { PORTFOLIO_VIEW } from '../../../ports/trading/execution';

// W3 Part 4: pure code motion out of app.module.ts — see db-health-bridge.module.ts's own header
// comment on the boundaries 'app' zone widening this relies on.
//
// Lifts PORTFOLIO_VIEW (ExecutionModule's canonical snapshot) into the global scope so
// ObservabilityModule's MetricsService can @Optional() @Inject(PORTFOLIO_VIEW) and emit the §8
// trading gauges (equity/PnL/position) WITHOUT a modules→modules import (observability must not
// import execution — the boundary wall). Same bridge pattern as DbHealthBridgeModule.
@Global()
@Module({
  imports: [ExecutionModule],
  providers: [{ provide: PORTFOLIO_VIEW, useExisting: PortfolioStateService }],
  exports: [PORTFOLIO_VIEW],
})
export class PortfolioViewBridgeModule {}
