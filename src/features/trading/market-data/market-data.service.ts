import { Injectable, Inject } from '@nestjs/common';
import type { MarketStreamPort, SubscriptionSpec } from '../../../ports/market-data';
import type { MarketEvent } from '../../../domain/types/market-events';
import type { ExchangeStreamPort } from '../../../ports/exchange-stream';
import { EXCHANGE_STREAM } from '../../../ports/exchange-stream';
import type { ClockPort } from '../../../ports/clock';
import { CLOCK } from '../../../ports/clock';
import type { EpochMs } from '../../../domain/types/ids';
import { normalizeRawEvent } from './normalize';
import type { CandleInterval } from '../../../domain/types/market-events';

@Injectable()
export class MarketDataService implements MarketStreamPort {
  constructor(
    @Inject(EXCHANGE_STREAM) private readonly exchangeStream: ExchangeStreamPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
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
        const event = normalizeRawEvent(rawEvent, ingestTime, candleInterval);
        yield event;
      } catch {
        // Normalization failure on a single event should not kill the stream
        // (e.g., bad book level that can't parse as Decimal). Log via caller.
      }
    }
  }
}
