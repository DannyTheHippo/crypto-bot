import { Injectable, Inject } from '@nestjs/common';
import type { MarketStreamPort, SubscriptionSpec } from '../../../ports/venue/market-data';
import type { MarketEvent } from '../../../domain/venue/types/market-events';
import type { ExchangeStreamPort } from '../../../ports/venue/exchange-stream';
import { EXCHANGE_STREAM } from '../../../ports/venue/exchange-stream';
import type { ClockPort } from '../../../ports/common/clock';
import { CLOCK } from '../../../ports/common/clock';
import type { EpochMs } from '../../../domain/common/types/ids';
import { normalizeRawEvent, type BookLimits } from './normalize';
import type { CandleInterval } from '../../../domain/venue/types/market-events';

@Injectable()
export class MarketDataService implements MarketStreamPort {
  constructor(
    @Inject(EXCHANGE_STREAM) private readonly exchangeStream: ExchangeStreamPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    // MARKET_BOOK_BAND_BPS/MARKET_BOOK_MAX_LEVELS (environment.config.ts's marketData group).
    // Optional, appended last so every existing call site (tests included) keeps compiling
    // unchanged — absent means both bounds disabled, same as normalizeBook's own defaults.
    private readonly bookLimits?: BookLimits,
  ) {}

  async *subscribe(spec: SubscriptionSpec): AsyncIterable<MarketEvent> {
    const raw = this.exchangeStream.marketRaw(spec);

    for await (const rawEvent of raw) {
      const ingestTime: EpochMs = this.clock.now();

      // For candle events, determine the interval from the subscription spec
      let candleInterval: CandleInterval | undefined;
      if (rawEvent.type === 'candle' && spec.channels.candles?.length) {
        candleInterval = spec.channels.candles[0];
      }

      try {
        const event = normalizeRawEvent(rawEvent, ingestTime, candleInterval, this.bookLimits);
        yield event;
      } catch {
        // Normalization failure on a single event should not kill the stream
        // (e.g., bad book level that can't parse as Decimal). Log via caller.
      }
    }
  }
}
