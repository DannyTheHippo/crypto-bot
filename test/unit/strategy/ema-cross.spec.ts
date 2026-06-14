import { describe, it, expect } from 'vitest';
import { EmaCrossStrategy } from '../../../src/domain/strategy/ema-cross.strategy';
import type { MarketView } from '../../../src/domain/strategy/strategy';
import type { CandleEvent } from '../../../src/domain/types/market-events';
import type { Signal } from '../../../src/domain/types/signal';
import { price, qty } from '../../../src/domain/types/money';
import { strategyId, venueId, symbolId, epochMs } from '../../../src/domain/types/ids';

const V = venueId('binance');
const S = symbolId('BTC/USDT');

// The EMA-cross strategy ignores the view (candle-driven); a bare stub suffices.
const view = {} as MarketView;

function candle(seq: number, close: string, t: number): CandleEvent {
  return {
    kind: 'CANDLE',
    venue: V,
    symbol: S,
    channel: 'candle:1h',
    seq: BigInt(seq),
    eventTime: epochMs(t),
    ingestTime: epochMs(t + 1),
    interval: '1h',
    openTime: epochMs(t),
    closeTime: epochMs(t + 3_600_000 - 1),
    open: price(close),
    high: price(close),
    low: price(close),
    close: price(close),
    volume: qty('1'),
    closed: true,
  };
}

// Flat, then a sharp rise (golden cross), then a sharp fall (death cross).
const CLOSES = ['100', '100', '100', '100', '100', '110', '125', '140', '160', '150', '130', '110', '90', '70'];

function run(): { signals: Signal[]; closeAt: Map<number, string> } {
  const strat = new EmaCrossStrategy(strategyId('ema1'), { fast: 3, slow: 5, symbol: S, venue: V, ttlMs: 30_000 });
  const signals: Signal[] = [];
  const closeAt = new Map<number, string>();
  CLOSES.forEach((c, i) => {
    const t = 1000 + i;
    closeAt.set(t, c);
    signals.push(...strat.onCandle(candle(i, c, t), view));
  });
  return { signals, closeAt };
}

describe('EmaCrossStrategy golden behaviour', () => {
  it('emits an ENTER_LONG on the golden cross and an EXIT_LONG on the death cross, in order', () => {
    const { signals } = run();
    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain('ENTER_LONG');
    expect(kinds).toContain('EXIT_LONG');
    expect(kinds.indexOf('ENTER_LONG')).toBeLessThan(kinds.indexOf('EXIT_LONG'));
    expect(signals.every((s) => s.kind === 'ENTER_LONG' || s.kind === 'EXIT_LONG')).toBe(true);
  });

  it('stamps refPrice as the exact close of the emitting candle and a monotonic cross index', () => {
    const { signals, closeAt } = run();
    let lastCross = 0;
    for (const s of signals) {
      // refPrice is the exact close string of the candle at the signal's eventTime.
      expect(s.refPrice.toFixed()).toBe(closeAt.get(s.eventTime));
      expect(s.strength).toBe(1);
      expect(s.ttlMs).toBe(30_000);
      const m = /:(golden|death):(\d+):/.exec(s.dedupeKey);
      expect(m).not.toBeNull();
      const idx = Number(m![2]);
      expect(idx).toBeGreaterThan(lastCross); // crossIndex strictly increases → unique dedupeKeys
      lastCross = idx;
      expect(s.reason).toBe(s.kind === 'ENTER_LONG' ? 'EMA golden cross' : 'EMA death cross');
    }
  });

  it('emits nothing before a full slow-period window exists', () => {
    const strat = new EmaCrossStrategy(strategyId('ema2'), { fast: 3, slow: 5, symbol: S, venue: V, ttlMs: 1000 });
    // Fewer than `slow` closed candles → no signal possible.
    const out = [
      ...strat.onCandle(candle(0, '100', 1000), view),
      ...strat.onCandle(candle(1, '110', 1001), view),
      ...strat.onCandle(candle(2, '120', 1002), view),
    ];
    expect(out).toEqual([]);
  });

  it('non-candle handlers are inert and onInit/onStop are no-ops (candle-driven v1)', () => {
    const strat = new EmaCrossStrategy(strategyId('ema4'), { fast: 3, slow: 5, symbol: S, venue: V, ttlMs: 1000 });
    strat.onInit({ params: {}, warmupCandles: new Map(), symbolConstraints: new Map() });
    const c = candle(0, '100', 1000);
    const ticker = { ...c, kind: 'TICKER' as const, bid: price('99'), ask: price('101'), last: price('100') };
    const book = { ...c, kind: 'ORDER_BOOK_SNAPSHOT' as const, bids: [], asks: [] };
    const exec = {
      reportId: 'r', clientOrderId: 'cbp0000000000000007000800000000000000' as never,
      venue: V, symbol: S, eventTime: epochMs(1), ingestTime: epochMs(1), kind: 'ACK' as const, venueOrderId: 'v',
    };
    expect(strat.onTick(ticker as never, view)).toEqual([]);
    expect(strat.onOrderBook(book as never, view)).toEqual([]);
    expect(strat.onExecReport(exec, view)).toEqual([]);
    expect(strat.onStop()).toBeUndefined();
  });

  it('ignores non-closed candles and other symbols', () => {
    const strat = new EmaCrossStrategy(strategyId('ema3'), { fast: 3, slow: 5, symbol: S, venue: V, ttlMs: 1000 });
    const open = { ...candle(0, '100', 1000), closed: false };
    const other = { ...candle(1, '100', 1001), symbol: symbolId('ETH/USDT') };
    expect(strat.onCandle(open, view)).toEqual([]);
    expect(strat.onCandle(other, view)).toEqual([]);
  });
});
