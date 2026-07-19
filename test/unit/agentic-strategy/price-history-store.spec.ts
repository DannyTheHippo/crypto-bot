import { describe, it, expect } from 'vitest';
import { PriceHistoryStore } from '../../../src/features/trading/agentic/price-history-store';
import type { CandleEvent } from '../../../src/domain/types/market-events';
import { price, qty } from '../../../src/domain/types/money';
import { venueId, symbolId, epochMs } from '../../../src/domain/types/ids';

const T = 1_700_000_000_000;
const V = venueId('binance');
const BTC = symbolId('BTC/USDT');
const ETH = symbolId('ETH/USDT');

function candle(closeStr: string, index: number, closed = true, symbol = BTC): CandleEvent {
  const t = T + index * 60_000;
  return {
    kind: 'CANDLE',
    venue: V,
    symbol,
    channel: 'candle:1m',
    seq: BigInt(index + 1),
    eventTime: epochMs(t),
    ingestTime: epochMs(t + 1),
    interval: '1m',
    openTime: epochMs(t),
    closeTime: epochMs(t + 60_000),
    open: price(closeStr),
    high: price(closeStr),
    low: price(closeStr),
    close: price(closeStr),
    volume: qty('1'),
    closed,
  };
}

describe('PriceHistoryStore', () => {
  it('records a fresh window in full, oldest→newest', () => {
    const store = new PriceHistoryStore();
    store.recordWindow(BTC, [candle('100', 0), candle('101', 1), candle('102', 2)]);
    expect(store.seriesFor(BTC)).toEqual([
      { eventTime: T, close: '100' },
      { eventTime: T + 60_000, close: '101' },
      { eventTime: T + 120_000, close: '102' },
    ]);
  });

  it('merges an overlapping re-delivered window without duplicating already-stored bars', () => {
    const store = new PriceHistoryStore();
    store.recordWindow(BTC, [candle('100', 0), candle('101', 1), candle('102', 2)]);
    // Next decide() call re-delivers its own rolling window: bars 1-2 overlap, bar 3 is new.
    store.recordWindow(BTC, [candle('101', 1), candle('102', 2), candle('103', 3)]);
    expect(store.seriesFor(BTC)).toEqual([
      { eventTime: T, close: '100' },
      { eventTime: T + 60_000, close: '101' },
      { eventTime: T + 120_000, close: '102' },
      { eventTime: T + 180_000, close: '103' },
    ]);
  });

  it('ignores an unclosed (still-forming) candle', () => {
    const store = new PriceHistoryStore();
    store.recordWindow(BTC, [candle('100', 0), candle('101', 1, false)]);
    expect(store.seriesFor(BTC)).toEqual([{ eventTime: T, close: '100' }]);
  });

  it('keeps per-symbol series independent', () => {
    const store = new PriceHistoryStore();
    store.recordWindow(BTC, [candle('100', 0)]);
    store.recordWindow(ETH, [candle('50', 0, true, ETH)]);
    expect(store.seriesFor(BTC)).toEqual([{ eventTime: T, close: '100' }]);
    expect(store.seriesFor(ETH)).toEqual([{ eventTime: T, close: '50' }]);
    expect([...store.symbols()].sort()).toEqual([BTC, ETH].sort());
  });

  it('returns an empty series for a symbol never recorded', () => {
    const store = new PriceHistoryStore();
    expect(store.seriesFor(BTC)).toEqual([]);
    expect(store.symbols()).toEqual([]);
  });

  it('bounds the stored window to maxBars, dropping the oldest first', () => {
    const store = new PriceHistoryStore(3);
    store.recordWindow(
      BTC,
      Array.from({ length: 5 }, (_, i) => candle(String(100 + i), i)),
    );
    expect(store.seriesFor(BTC)).toEqual([
      { eventTime: T + 120_000, close: '102' },
      { eventTime: T + 180_000, close: '103' },
      { eventTime: T + 240_000, close: '104' },
    ]);
  });

  it('returns a defensive copy — mutating the returned array never affects the store', () => {
    const store = new PriceHistoryStore();
    store.recordWindow(BTC, [candle('100', 0)]);
    const series = store.seriesFor(BTC) as { eventTime: number; close: string }[];
    series.push({ eventTime: T + 60_000, close: '999' });
    expect(store.seriesFor(BTC)).toEqual([{ eventTime: T, close: '100' }]);
  });
});
