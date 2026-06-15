import { describe, it, expect } from 'vitest';
import { DonchianBreakoutStrategy } from '../../../src/domain/strategy/donchian-breakout.strategy';
import type { MarketView } from '../../../src/domain/strategy/strategy';
import type { CandleEvent } from '../../../src/domain/types/market-events';
import type { Signal } from '../../../src/domain/types/signal';
import { price, qty } from '../../../src/domain/types/money';
import { strategyId, venueId, symbolId, epochMs } from '../../../src/domain/types/ids';

const V = venueId('binance');
const S = symbolId('BTC/USDT');
const view = {} as MarketView; // candle-driven; ignores the view

function candle(seq: number, h: string, l: string, c: string, t: number): CandleEvent {
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
    open: price(c),
    high: price(h),
    low: price(l),
    close: price(c),
    volume: qty('1'),
    closed: true,
  };
}

// [high, low, close]: 4 flat warmup bars, a breakout above the prior-3 high (ENTER), holds, then a
// breakdown below the prior-2 low (EXIT). entryLookback 3 / exitLookback 2 ⇒ maxLen 4.
const BARS: [string, string, string][] = [
  ['100', '100', '100'],
  ['100', '100', '100'],
  ['100', '100', '100'],
  ['100', '100', '100'], // window now full; close 100 not > upper 100 ⇒ no signal
  ['101', '100', '101'], // close 101 > prior-3 high 100 ⇒ ENTER_LONG
  ['103', '101', '103'], // hold
  ['105', '103', '105'], // hold
  ['92', '90', '91'], // close 91 < prior-2 low 101 ⇒ EXIT_LONG
];

function run(): { signals: Signal[]; closeAt: Map<number, string> } {
  const strat = new DonchianBreakoutStrategy(strategyId('don1'), {
    entryLookback: 3,
    exitLookback: 2,
    symbol: S,
    venue: V,
    ttlMs: 30_000,
    interval: '1h',
  });
  const signals: Signal[] = [];
  const closeAt = new Map<number, string>();
  BARS.forEach(([h, l, c], i) => {
    const t = 1000 + i;
    closeAt.set(t, c);
    signals.push(...strat.onCandle(candle(i, h, l, c, t), view));
  });
  return { signals, closeAt };
}

describe('DonchianBreakoutStrategy', () => {
  it('emits ENTER_LONG on the channel breakout and EXIT_LONG on the breakdown, in order', () => {
    const { signals } = run();
    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain('ENTER_LONG');
    expect(kinds).toContain('EXIT_LONG');
    expect(kinds.indexOf('ENTER_LONG')).toBeLessThan(kinds.indexOf('EXIT_LONG'));
    expect(signals.every((s) => s.kind === 'ENTER_LONG' || s.kind === 'EXIT_LONG')).toBe(true);
  });

  it('stamps refPrice/strength/ttl and a strictly-increasing cross index in the dedupeKey', () => {
    const { signals, closeAt } = run();
    let lastCross = 0;
    for (const s of signals) {
      expect(s.refPrice.toFixed()).toBe(closeAt.get(s.eventTime));
      expect(s.strength).toBe(1);
      expect(s.ttlMs).toBe(30_000);
      const m = /:(breakout|breakdown):(\d+):/.exec(s.dedupeKey);
      expect(m).not.toBeNull();
      const idx = Number(m![2]);
      expect(idx).toBeGreaterThan(lastCross);
      lastCross = idx;
      expect(s.reason).toBe(s.kind === 'ENTER_LONG' ? 'Donchian breakout' : 'Donchian breakdown');
    }
  });

  it('is replay-deterministic: identical inputs produce byte-identical signals', () => {
    const a = run().signals;
    const b = run().signals;
    expect(b.map((s) => `${s.kind}:${s.eventTime}:${s.dedupeKey}:${s.refPrice.toFixed()}`)).toEqual(
      a.map((s) => `${s.kind}:${s.eventTime}:${s.dedupeKey}:${s.refPrice.toFixed()}`),
    );
  });

  it('emits nothing before a full prior window exists', () => {
    const strat = new DonchianBreakoutStrategy(strategyId('don2'), {
      entryLookback: 3,
      exitLookback: 2,
      symbol: S,
      venue: V,
      ttlMs: 1000,
      interval: '1h',
    });
    const out = [
      ...strat.onCandle(candle(0, '100', '99', '100', 1000), view),
      ...strat.onCandle(candle(1, '110', '100', '110', 1001), view),
      ...strat.onCandle(candle(2, '120', '110', '120', 1002), view),
    ];
    expect(out).toEqual([]); // fewer than maxLen (4) bars
  });

  it('defaults the interval to 1h when not specified', () => {
    const strat = new DonchianBreakoutStrategy(strategyId('don5'), {
      entryLookback: 20,
      exitLookback: 10,
      symbol: S,
      venue: V,
      ttlMs: 1000,
    });
    expect(strat.warmup.interval).toBe('1h');
    expect(strat.warmup.bars).toBe(21); // max(20,10)+1
    expect(strat.subscriptions.channels.candles).toEqual(['1h']);
  });

  it('non-candle handlers are inert and onInit/onStop are no-ops', () => {
    const strat = new DonchianBreakoutStrategy(strategyId('don4'), {
      entryLookback: 3,
      exitLookback: 2,
      symbol: S,
      venue: V,
      ttlMs: 1000,
      interval: '1h',
    });
    strat.onInit({ params: {}, warmupCandles: new Map(), symbolConstraints: new Map() });
    const c = candle(0, '100', '99', '100', 1000);
    const ticker = {
      ...c,
      kind: 'TICKER' as const,
      bid: price('99'),
      ask: price('101'),
      last: price('100'),
    };
    const book = { ...c, kind: 'ORDER_BOOK_SNAPSHOT' as const, bids: [], asks: [] };
    const exec = {
      reportId: 'r',
      clientOrderId: 'cbp0000000000000007000800000000000000' as never,
      venue: V,
      symbol: S,
      eventTime: epochMs(1),
      ingestTime: epochMs(1),
      kind: 'ACK' as const,
      venueOrderId: 'v',
    };
    expect(strat.onTick(ticker as never, view)).toEqual([]);
    expect(strat.onOrderBook(book as never, view)).toEqual([]);
    expect(strat.onExecReport(exec, view)).toEqual([]);
    expect(strat.onStop()).toBeUndefined();
  });

  it('ignores non-closed candles and other symbols', () => {
    const strat = new DonchianBreakoutStrategy(strategyId('don3'), {
      entryLookback: 3,
      exitLookback: 2,
      symbol: S,
      venue: V,
      ttlMs: 1000,
      interval: '1h',
    });
    const open = { ...candle(0, '100', '99', '100', 1000), closed: false };
    const other = { ...candle(1, '100', '99', '100', 1001), symbol: symbolId('ETH/USDT') };
    expect(strat.onCandle(open, view)).toEqual([]);
    expect(strat.onCandle(other, view)).toEqual([]);
  });
});
