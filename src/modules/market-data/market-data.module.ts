import { Module } from '@nestjs/common';
import { MARKET_STREAM, FEED_HEALTH } from '../../ports/market-data';
import { CLOCK } from '../../ports/clock';
import { SystemClock } from '../../ports/clock';
import { EXCHANGE_STREAM } from '../../ports/exchange-stream';
import { WATCH_SOURCE, RealWatchSource } from './ccxt-stream.adapter';
import { MarketDataService } from './market-data.service';
import { FeedHealthService } from './feed-health.service';

/**
 * MarketDataModule wires market-data infrastructure providers.
 * Exports only the port tokens MARKET_STREAM and FEED_HEALTH — never concretions.
 *
 * The EXCHANGE_STREAM provider is registered here as a stub (no-op) for Phase 2
 * since the full CcxtExchangeStreamAdapter requires a live ccxt exchange instance
 * constructed per-venue at runtime. For integration, construct the adapter with
 * buildCcxtExchange() and override EXCHANGE_STREAM in the module config.
 */
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: WATCH_SOURCE, useClass: RealWatchSource },
    // EXCHANGE_STREAM is provided externally (per-venue adapter instance).
    // Modules consuming MARKET_STREAM/FEED_HEALTH must provide EXCHANGE_STREAM.
    {
      provide: EXCHANGE_STREAM,
      useFactory: (): unknown => {
        // Placeholder — must be overridden at runtime with a real CcxtExchangeStreamAdapter
        throw new Error(
          'EXCHANGE_STREAM must be provided by the consuming module (per-venue adapter)',
        );
      },
    },
    {
      provide: MARKET_STREAM,
      useClass: MarketDataService,
    },
    {
      provide: FEED_HEALTH,
      useClass: FeedHealthService,
    },
  ],
  exports: [MARKET_STREAM, FEED_HEALTH],
})
export class MarketDataModule {}
