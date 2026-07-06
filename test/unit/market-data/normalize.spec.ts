import { describe, it, expect } from 'vitest';
import { normalizeRawEvent } from '../../../src/features/trading/market-data/normalize';
import { venueId, symbolId, epochMs } from '../../../src/domain/types/ids';
import type { RawVenueEvent } from '../../../src/ports/exchange-stream';
import type {
  TickerEvent,
  TradeEvent,
  CandleEvent,
  OrderBookSnapshotEvent,
} from '../../../src/domain/types/market-events';

const V = venueId('binance');
const ingest = epochMs(2000);

function raw(
  type: RawVenueEvent['type'],
  symbol: string,
  body: unknown,
  ts?: number,
): RawVenueEvent {
  return {
    type,
    venue: V,
    symbol: symbolId(symbol),
    timestamp: typeof ts === 'number' ? epochMs(ts) : undefined,
    raw: body,
  };
}

describe('normalize ticker', () => {
  it('parses string numerics to exact Decimals and uses exchange eventTime', () => {
    const ev = normalizeRawEvent(
      raw(
        'ticker',
        'NORM-TICK',
        { timestamp: 1234, bid: '100.5', ask: '100.60', last: '100.55' },
        1234,
      ),
      ingest,
    ) as TickerEvent;
    expect(ev.kind).toBe('TICKER');
    expect(ev.bid.toFixed()).toBe('100.5'); // exact string, never toBeCloseTo
    expect(ev.ask.toFixed()).toBe('100.6');
    expect(ev.last.toFixed()).toBe('100.55');
    expect(ev.eventTime).toBe(1234);
    expect(ev.eventTimeSynthetic).toBeUndefined();
  });

  it('marks eventTime synthetic and falls back to ingestTime when venue omits a timestamp', () => {
    const ev = normalizeRawEvent(
      raw('ticker', 'NORM-SYNTH', { bid: '1', ask: '2', last: '1.5' }),
      ingest,
    ) as TickerEvent;
    expect(ev.eventTime).toBe(2000);
    expect(ev.eventTimeSynthetic).toBe(true);
  });

  it('assigns a strictly increasing seq per (venue, symbol, channel)', () => {
    const a = normalizeRawEvent(
      raw('ticker', 'NORM-SEQ', { bid: '1', ask: '2', last: '1.5', timestamp: 1 }, 1),
      ingest,
    );
    const b = normalizeRawEvent(
      raw('ticker', 'NORM-SEQ', { bid: '1', ask: '2', last: '1.5', timestamp: 2 }, 2),
      ingest,
    );
    expect(b.seq).toBe(a.seq + 1n);
  });
});

describe('normalize ticker fallbacks', () => {
  it('falls back to bestBid/bestAsk/close when bid/ask/last are absent', () => {
    const ev = normalizeRawEvent(
      raw(
        'ticker',
        'NORM-TICK-FB',
        { timestamp: 9, bestBid: '10', bestAsk: '11', close: '10.5' },
        9,
      ),
      ingest,
    ) as TickerEvent;
    expect(ev.bid.toFixed()).toBe('10');
    expect(ev.ask.toFixed()).toBe('11');
    expect(ev.last.toFixed()).toBe('10.5');
  });
});

describe('normalize trade', () => {
  it('maps side, exact qty/price and tradeId', () => {
    const ev = normalizeRawEvent(
      raw(
        'trade',
        'NORM-TRADE',
        { timestamp: 10, price: '100', amount: '2.5', side: 'buy', id: 't1' },
        10,
      ),
      ingest,
    ) as TradeEvent;
    expect(ev.kind).toBe('TRADE');
    expect(ev.side).toBe('BUY');
    expect(ev.price.toFixed()).toBe('100');
    expect(ev.qty.toFixed()).toBe('2.5');
    expect(ev.tradeId).toBe('t1');
  });

  it('infers BUY from takerSide and qty from size when fields differ', () => {
    const ev = normalizeRawEvent(
      raw(
        'trade',
        'NORM-TRADE-TS',
        { timestamp: 11, price: '100', size: '3', takerSide: 'buy', tradeId: 'tt' },
        11,
      ),
      ingest,
    ) as TradeEvent;
    expect(ev.side).toBe('BUY');
    expect(ev.qty.toFixed()).toBe('3');
    expect(ev.tradeId).toBe('tt');
  });

  it('defaults to SELL when side is neither buy nor takerSide buy', () => {
    const ev = normalizeRawEvent(
      raw(
        'trade',
        'NORM-TRADE-SELL',
        { timestamp: 12, price: '100', amount: '1', side: 'sell', id: 's' },
        12,
      ),
      ingest,
    ) as TradeEvent;
    expect(ev.side).toBe('SELL');
  });
});

describe('normalize candle (OHLCV array)', () => {
  it('parses [t,o,h,l,c,v,closed] with exact prices and closed flag', () => {
    const ev = normalizeRawEvent(
      raw('candle', 'NORM-CANDLE', [60000, '100', '110.5', '90', '105.25', '10', true], 60000),
      ingest,
      '1m',
    ) as CandleEvent;
    expect(ev.kind).toBe('CANDLE');
    expect(ev.open.toFixed()).toBe('100');
    expect(ev.high.toFixed()).toBe('110.5');
    expect(ev.close.toFixed()).toBe('105.25');
    expect(ev.volume.toFixed()).toBe('10');
    expect(ev.closed).toBe(true);
    expect(ev.openTime).toBe(60000);
    expect(ev.closeTime).toBe(119999); // openTime + 1m - 1ms
  });
});

describe('normalize candle (parsed object form)', () => {
  it('parses an object-shaped candle with openTime/closed', () => {
    const ev = normalizeRawEvent(
      raw(
        'candle',
        'NORM-CANDLE-OBJ',
        {
          openTime: 300000,
          open: '50',
          high: '55',
          low: '49',
          close: '52.5',
          volume: '7',
          closed: false,
        },
        300000,
      ),
      ingest,
      '5m',
    ) as CandleEvent;
    expect(ev.kind).toBe('CANDLE');
    expect(ev.interval).toBe('5m');
    expect(ev.close.toFixed()).toBe('52.5');
    expect(ev.closed).toBe(false);
    expect(ev.openTime).toBe(300000);
    expect(ev.closeTime).toBe(300000 + 300000 - 1);
  });
});

describe('normalize order book', () => {
  it('prefers the exact .info string over the float cache value', () => {
    const ev = normalizeRawEvent(
      raw(
        'book',
        'NORM-BOOK1',
        {
          timestamp: 5,
          bids: [[100.5, 2, { price: '100.50000000', size: '2.00000000' }]],
          asks: [[100.6, 3, { price: '100.60000000', size: '3.00000000' }]],
        },
        5,
      ),
      ingest,
    ) as OrderBookSnapshotEvent;
    expect(ev.bids[0]?.price.toFixed()).toBe('100.5');
    expect(ev.bids[0]?.qty.toFixed()).toBe('2');
    expect(ev.asks[0]?.price.toFixed()).toBe('100.6');
  });

  it('handles a scientific-notation float level without parseFloat (Decimal-based)', () => {
    const ev = normalizeRawEvent(
      raw('book', 'NORM-BOOK2', { timestamp: 6, bids: [[1e-7, 0.5]], asks: [[2e-7, 1]] }, 6),
      ingest,
    ) as OrderBookSnapshotEvent;
    expect(ev.bids[0]?.price.toFixed()).toBe('0.0000001'); // 1e-7 expanded, no exponent
    expect(ev.bids[0]?.qty.toFixed()).toBe('0.5');
    expect(ev.asks[0]?.price.toFixed()).toBe('0.0000002');
  });

  it('skips a malformed level but keeps the valid side (book is reference-grade)', () => {
    const ev = normalizeRawEvent(
      raw(
        'book',
        'NORM-BOOK3',
        {
          timestamp: 7,
          bids: [['not-a-number', '1'], 'garbage'], // first throws in Decimal, second is not an array
          asks: [['100', '2']],
        },
        7,
      ),
      ingest,
    ) as OrderBookSnapshotEvent;
    expect(ev.bids).toHaveLength(0); // both bid entries dropped, never throws
    expect(ev.asks[0]?.price.toFixed()).toBe('100');
  });

  it('synthesizes eventTime from ingestTime when the book omits a timestamp', () => {
    const ev = normalizeRawEvent(
      raw('book', 'NORM-BOOK4', { bids: [['100', '1']], asks: [['101', '1']] }),
      ingest,
    ) as OrderBookSnapshotEvent;
    expect(ev.eventTime).toBe(2000);
    expect(ev.eventTimeSynthetic).toBe(true);
  });
});
