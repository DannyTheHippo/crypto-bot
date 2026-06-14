import { Module } from '@nestjs/common';
import { STRATEGY_REGISTRY, STRATEGY_HOST, SIGNAL_SINK } from '../../ports/strategy';
import { StrategyRegistry } from './strategy-registry';
import { StrategyHost } from './strategy-host';

const noopSignalSink = { recordSignal: () => undefined };

@Module({
  providers: [
    StrategyRegistry,
    { provide: STRATEGY_REGISTRY, useExisting: StrategyRegistry },
    { provide: SIGNAL_SINK, useValue: noopSignalSink },
    {
      provide: STRATEGY_HOST,
      useClass: StrategyHost,
    },
  ],
  exports: [STRATEGY_REGISTRY, STRATEGY_HOST],
})
export class StrategyModule {}
