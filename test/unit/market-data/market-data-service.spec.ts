import { describe, it, expect } from 'vitest';
import { MarketDataService } from '../../../src/modules/market-data/market-data.service';
import type {
  ExchangeStreamPort,
  RawVenueEvent,
  RawUserEvent,
} from '../../../src/ports/exchange-stream';
import type { SubscriptionSpec } from '../../../src/ports/market-data';
import type { ClockPort } from '../../../src/ports/clock';
import type { MarketEvent } from '../../../src/domain/types/market-events';
import { venueId, symbolId, epochMs } from '../../../src/domain/types/ids';

const V = venueId('binance');
const S = symbolId('BTC/USDT');
const clock: ClockPort = { now: () => epochMs(999) };

const emptyUserEvents: AsyncIterable<RawUserEvent> = {
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ value: undefined as never, done: true }),
  }),
};

function streamOf(raws: RawVenueEvent[]): ExchangeStreamPort {
  return {
    marketRaw: () =>
      (async function* () {
        await Promise.resolve(); // async generators need an await to satisfy require-await
        for (const r of raws) yield r;
      })(),
    userEvents: () => emptyUserEvents,
  };
}

async function collect(it: AsyncIterable<MarketEvent>): Promise<MarketEvent[]> {
  const out: MarketEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe('MarketDataService.subscribe', () => {
  it('normalizes raw events and stamps ingestTime from the clock', async () => {
    const raws: RawVenueEvent[] = [
      {
        type: 'ticker',
        venue: V,
        symbol: S,
        timestamp: epochMs(1),
        raw: { timestamp: 1, bid: '100', ask: '101', last: '100.5' },
      },
      {
        type: 'trade',
        venue: V,
        symbol: S,
        timestamp: epochMs(2),
        raw: { timestamp: 2, price: '100', amount: '1', side: 'sell', id: 'x' },
      },
    ];
    const svc = new MarketDataService(streamOf(raws), clock);
    const spec: SubscriptionSpec = {
      venue: V,
      symbols: [S],
      channels: { ticker: true, trades: true },
    };
    const events = await collect(svc.subscribe(spec));
    expect(events.map((e) => e.kind)).toEqual(['TICKER', 'TRADE']);
    expect(events[0]?.ingestTime).toBe(999);
  });

  it('skips an event that fails normalization without killing the stream', async () => {
    const raws: RawVenueEvent[] = [
      {
        type: 'ticker',
        venue: V,
        symbol: S,
        timestamp: epochMs(1),
        raw: { timestamp: 1, bid: '100', ask: '101', last: '100.5' },
      },
      // Missing bid → numStr defaults '0' → price('0') throws NON_POSITIVE → skipped.
      {
        type: 'ticker',
        venue: V,
        symbol: S,
        timestamp: epochMs(2),
        raw: { timestamp: 2, ask: '101', last: '100.5' },
      },
      {
        type: 'trade',
        venue: V,
        symbol: S,
        timestamp: epochMs(3),
        raw: { timestamp: 3, price: '100', amount: '1', side: 'buy', id: 'y' },
      },
    ];
    const svc = new MarketDataService(streamOf(raws), clock);
    const spec: SubscriptionSpec = {
      venue: V,
      symbols: [S],
      channels: { ticker: true, trades: true },
    };
    const events = await collect(svc.subscribe(spec));
    expect(events.map((e) => e.kind)).toEqual(['TICKER', 'TRADE']); // bad ticker dropped
  });

  it('passes the subscription candle interval through to normalization', async () => {
    const raws: RawVenueEvent[] = [
      {
        type: 'candle',
        venue: V,
        symbol: S,
        timestamp: epochMs(60000),
        raw: [60000, '100', '110', '90', '105', '10', true],
      },
    ];
    const svc = new MarketDataService(streamOf(raws), clock);
    const spec: SubscriptionSpec = { venue: V, symbols: [S], channels: { candles: ['5m'] } };
    const events = await collect(svc.subscribe(spec));
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.kind).toBe('CANDLE');
    if (ev?.kind === 'CANDLE') expect(ev.interval).toBe('5m');
  });
});
