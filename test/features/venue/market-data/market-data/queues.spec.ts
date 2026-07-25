import { describe, it, expect } from 'vitest';
import {
  makeTickerCell,
  tickerCellPut,
  tickerCellTake,
  makeBookCell,
  bookCellPut,
  bookCellTake,
  makeTradeRing,
  tradeRingPush,
  tradeRingDrain,
  makeCandleQueue,
  candleQueuePush,
  candleQueueDrain,
} from '../../../src/features/trading/market-data/queues';
import { price, qty } from '../../../src/domain/types/money';
import { venueId, symbolId, epochMs } from '../../../src/domain/types/ids';
import type {
  TickerEvent,
  TradeEvent,
  CandleEvent,
  OrderBookSnapshotEvent,
} from '../../../src/domain/types/market-events';

const V = venueId('binance');
const S = symbolId('BTC/USDT');

function ticker(seq: bigint, last: string): TickerEvent {
  return {
    kind: 'TICKER',
    venue: V,
    symbol: S,
    channel: 'ticker',
    seq,
    eventTime: epochMs(1000),
    ingestTime: epochMs(1001),
    bid: price('100'),
    ask: price('101'),
    last: price(last),
  };
}

function trade(seq: bigint, tradeId: string): TradeEvent {
  return {
    kind: 'TRADE',
    venue: V,
    symbol: S,
    channel: 'trade',
    seq,
    eventTime: epochMs(1000),
    ingestTime: epochMs(1001),
    price: price('100'),
    qty: qty('1'),
    side: 'BUY',
    tradeId,
  };
}

function candle(seq: bigint, closed: boolean): CandleEvent {
  return {
    kind: 'CANDLE',
    venue: V,
    symbol: S,
    channel: 'candle:1m',
    seq,
    eventTime: epochMs(60000),
    ingestTime: epochMs(60001),
    interval: '1m',
    openTime: epochMs(60000),
    closeTime: epochMs(119999),
    open: price('100'),
    high: price('110'),
    low: price('90'),
    close: price('105'),
    volume: qty('10'),
    closed,
  };
}

function book(seq: bigint): OrderBookSnapshotEvent {
  return {
    kind: 'ORDER_BOOK_SNAPSHOT',
    venue: V,
    symbol: S,
    channel: 'book',
    seq,
    eventTime: epochMs(1000),
    ingestTime: epochMs(1001),
    bids: [{ price: price('100'), qty: qty('1') }],
    asks: [{ price: price('101'), qty: qty('1') }],
  };
}

describe('ticker conflation cell', () => {
  it('is latest-wins and counts conflated updates since last read', () => {
    const cell = makeTickerCell();
    tickerCellPut(cell, ticker(1n, '100'));
    expect(cell.conflatedCount).toBe(0); // first put is not a conflation
    tickerCellPut(cell, ticker(2n, '101'));
    tickerCellPut(cell, ticker(3n, '102'));
    expect(cell.conflatedCount).toBe(2);

    const taken = tickerCellTake(cell);
    expect(taken?.last.toFixed()).toBe('102'); // latest wins, exact string
    expect(cell.conflatedCount).toBe(0); // reset after take
    expect(tickerCellTake(cell)).toBeUndefined(); // empty after take
  });
});

describe('book conflation cell', () => {
  it('keeps only the latest maintained snapshot', () => {
    const cell = makeBookCell();
    bookCellPut(cell, book(1n));
    bookCellPut(cell, book(2n));
    expect(cell.conflatedCount).toBe(1);
    const taken = bookCellTake(cell);
    expect(taken?.seq).toBe(2n);
    expect(bookCellTake(cell)).toBeUndefined();
  });
});

describe('trade ring buffer (bounded 1024, drop-oldest)', () => {
  it('drains in FIFO order with no gap when under capacity', () => {
    const ring = makeTradeRing();
    tradeRingPush(ring, trade(1n, 'a'));
    tradeRingPush(ring, trade(2n, 'b'));
    const out = tradeRingDrain(ring);
    expect(out.map((t) => t.tradeId)).toEqual(['a', 'b']);
    expect(out.some((t) => t.gapBefore)).toBe(false);
  });

  it('drops oldest on overflow and stamps gapBefore on the oldest survivor', () => {
    const ring = makeTradeRing();
    for (let i = 0; i < 1025; i++) {
      tradeRingPush(ring, trade(BigInt(i), `t${i}`));
    }
    const out = tradeRingDrain(ring);
    expect(out.length).toBe(1024);
    expect(out[0]?.gapBefore).toBe(true); // consumer learns it missed prints
    expect(out[0]?.tradeId).toBe('t1'); // t0 was dropped
    expect(out[1]?.gapBefore).toBeUndefined();
    // After drain the ring is empty and gap flag cleared
    expect(tradeRingDrain(ring).length).toBe(0);
  });
});

describe('candle queue (bounded 256, closed-candle loss is a GAP)', () => {
  it('flags GAP when a CLOSED candle is dropped on overflow', () => {
    const q = makeCandleQueue();
    for (let i = 0; i < 256; i++) candleQueuePush(q, candle(BigInt(i), true));
    candleQueuePush(q, candle(256n, true)); // overflow drops a closed candle
    const { events, gapDetected } = candleQueueDrain(q);
    expect(events.length).toBe(256);
    expect(gapDetected).toBe(true);
  });

  it('does NOT flag GAP when an unclosed candle is dropped', () => {
    const q = makeCandleQueue();
    for (let i = 0; i < 256; i++) candleQueuePush(q, candle(BigInt(i), false));
    candleQueuePush(q, candle(256n, false)); // overflow drops an unclosed candle
    const { gapDetected } = candleQueueDrain(q);
    expect(gapDetected).toBe(false);
  });
});
