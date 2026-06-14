import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { TeeingMarketStream, type RefPriceSink, type PaperFeedSink } from '../../../src/modules/trading/teeing-market-stream';
import type { MarketStreamPort, SubscriptionSpec } from '../../../src/ports/market-data';
import type { MarketEvent, OrderLevel } from '../../../src/domain/types/market-events';
import { price, qty, type Price } from '../../../src/domain/types/money';
import { venueId, symbolId, epochMs, type SymbolId, type EpochMs } from '../../../src/domain/types/ids';

const V = venueId('binance');
const S = symbolId('BTC/USDT');
const lvl = (p: string, q: string): OrderLevel => ({ price: price(p), qty: qty(q) });

function env(seq: number) {
  return { venue: V, symbol: S, channel: 'c', seq: BigInt(seq), eventTime: epochMs(1000 + seq), ingestTime: epochMs(1000 + seq) };
}
const TICKER: MarketEvent = { ...env(1), kind: 'TICKER', bid: price('100'), ask: price('100.02'), last: price('100.01') };
const BOOK: MarketEvent = { ...env(2), kind: 'ORDER_BOOK_SNAPSHOT', bids: [lvl('99.99', '1')], asks: [lvl('100.03', '1')] };
const BOOK_EMPTY: MarketEvent = { ...env(3), kind: 'ORDER_BOOK_SNAPSHOT', bids: [], asks: [] };
const TRADE: MarketEvent = { ...env(4), kind: 'TRADE', price: price('100.01'), qty: qty('0.5'), side: 'BUY', tradeId: 'x' };
const CANDLE: MarketEvent = {
  ...env(5), kind: 'CANDLE', interval: '1m', openTime: epochMs(1005), closeTime: epochMs(1064),
  open: price('100'), high: price('101'), low: price('99'), close: price('100.5'), volume: qty('1'), closed: true,
};
function forming(openTime: number, close: string): MarketEvent {
  return {
    ...env(openTime), kind: 'CANDLE', interval: '1m', openTime: epochMs(openTime), closeTime: epochMs(openTime + 59_999),
    open: price('100'), high: price('101'), low: price('99'), close: price(close), volume: qty('1'), closed: false,
  };
}

function innerOf(events: MarketEvent[], captured: { spec?: SubscriptionSpec }): MarketStreamPort {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    subscribe: async function* (spec: SubscriptionSpec): AsyncIterable<MarketEvent> {
      captured.spec = spec;
      for (const e of events) yield e;
    },
  };
}

class RecordingRef implements RefPriceSink {
  readonly calls: { symbol: SymbolId; mid: string; at: EpochMs }[] = [];
  updateRefPrice(symbol: SymbolId, mid: Price, at: EpochMs): void {
    this.calls.push({ symbol, mid: mid.toFixed(), at });
  }
}

class RecordingPaper implements PaperFeedSink {
  books = 0;
  trades: { price: string }[] = [];
  ingestBook(): void { this.books += 1; }
  ingestTrade(_s: SymbolId, print: { price: Decimal; qty: Decimal }): Promise<void> {
    this.trades.push({ price: print.price.toFixed() });
    return Promise.resolve();
  }
}

async function drain(it: AsyncIterable<MarketEvent>): Promise<MarketEvent[]> {
  const out: MarketEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('TeeingMarketStream', () => {
  it('augments the subscription with ticker/book/trades and yields every event through', async () => {
    const captured: { spec?: SubscriptionSpec } = {};
    const ref = new RecordingRef();
    const tee = new TeeingMarketStream(innerOf([TICKER, BOOK, CANDLE], captured), ref, { ticker: true, book: true, trades: true });
    const out = await drain(tee.subscribe({ venue: V, symbols: [S], channels: { candles: ['1m'] } }));
    expect(captured.spec?.channels).toEqual({ candles: ['1m'], ticker: true, book: true, trades: true });
    expect(out.map((e) => e.kind)).toEqual(['TICKER', 'ORDER_BOOK_SNAPSHOT', 'CANDLE']);
  });

  it('updates the ref price from ticker mid and best-of-book mid', async () => {
    const captured: { spec?: SubscriptionSpec } = {};
    const ref = new RecordingRef();
    const tee = new TeeingMarketStream(innerOf([TICKER, BOOK, BOOK_EMPTY, CANDLE], captured), ref, {});
    await drain(tee.subscribe({ venue: V, symbols: [S], channels: {} }));
    // ticker mid (100+100.02)/2=100.01 ; book mid (99.99+100.03)/2=100.01 ; empty book + candle = no update
    expect(ref.calls.map((c) => c.mid)).toEqual(['100.01', '100.01']);
  });

  it('feeds the paper sim adapter book/trade when present (paper fallback)', async () => {
    const captured: { spec?: SubscriptionSpec } = {};
    const paper = new RecordingPaper();
    const tee = new TeeingMarketStream(innerOf([BOOK, TRADE], captured), new RecordingRef(), {}, paper);
    await drain(tee.subscribe({ venue: V, symbols: [S], channels: {} }));
    expect(paper.books).toBe(1);
    expect(paper.trades).toEqual([{ price: '100.01' }]);
  });

  it('synthesizes a closed candle when the candle openTime rolls over (ccxt sends only forming candles)', async () => {
    const captured: { spec?: SubscriptionSpec } = {};
    const a = forming(60_000, '100.5');
    const b = forming(120_000, '101.5');
    const tee = new TeeingMarketStream(innerOf([a, b], captured), new RecordingRef(), {});
    const out = await drain(tee.subscribe({ venue: V, symbols: [S], channels: { candles: ['1m'] } }));
    const closed = out.filter((e) => e.kind === 'CANDLE' && e.closed);
    expect(closed).toHaveLength(1); // the first period closed when the second started
    expect(closed[0]?.kind === 'CANDLE' && closed[0].openTime).toBe(60_000);
    expect(closed[0]?.kind === 'CANDLE' && closed[0].close.toFixed()).toBe('100.5');
    // forming candles still pass through (a closed-only strategy ignores them)
    expect(out.filter((e) => e.kind === 'CANDLE').length).toBe(3); // a(forming), a(closed), b(forming)
  });

  it('never feeds a paper adapter in demo/live mode (no paperFeed) and survives a ref-sink throw', async () => {
    const captured: { spec?: SubscriptionSpec } = {};
    const throwingRef: RefPriceSink = { updateRefPrice: () => { throw new Error('boom'); } };
    const tee = new TeeingMarketStream(innerOf([TICKER, TRADE], captured), throwingRef, {});
    const out = await drain(tee.subscribe({ venue: V, symbols: [S], channels: {} }));
    expect(out.map((e) => e.kind)).toEqual(['TICKER', 'TRADE']); // stream not killed by the throw
  });
});
