import { describe, it, expect } from 'vitest';
import {
  FeedHealthService,
  FeedHealthServiceWithBackfill,
  type OhlcvSource,
} from '../../../src/features/trading/market-data/feed-health.service';
import type { ExchangeStreamPort } from '../../../src/ports/exchange-stream';
import type { ClockPort } from '../../../src/ports/clock';
import type { VenueConfig } from '../../../src/ports/app-config';
import { venueId, symbolId, epochMs } from '../../../src/domain/types/ids';
import { price } from '../../../src/domain/types/money';

const V = venueId('binance');
const S = symbolId('BTC/USDT');
const stubStream = {} as ExchangeStreamPort;

function mutableClock(start = 1000): { clock: ClockPort; set: (t: number) => void } {
  let t = start;
  return { clock: { now: () => epochMs(t) }, set: (n) => (t = n) };
}

describe('FeedHealthService', () => {
  it('reports GAP for an unknown channel and LIVE after an event', () => {
    const { clock } = mutableClock();
    const svc = new FeedHealthService(clock, stubStream);
    expect(svc.health(V, S, 'book')).toBe('GAP');
    svc.recordEvent(V, S, 'book');
    expect(svc.health(V, S, 'book')).toBe('LIVE');
  });

  it('setHealth overrides status and preserves the staleness anchor', () => {
    const { clock } = mutableClock();
    const svc = new FeedHealthService(clock, stubStream);
    svc.recordEvent(V, S, 'ticker');
    svc.setHealth(V, S, 'ticker', 'DEGRADED');
    expect(svc.health(V, S, 'ticker')).toBe('DEGRADED');
  });

  it('checkStaleness drives a LIVE channel to DEGRADED only past the threshold', () => {
    const { clock, set } = mutableClock(1000);
    const svc = new FeedHealthService(clock, stubStream);
    svc.recordEvent(V, S, 'trade'); // anchored at 1000
    set(1000 + 5000); // within threshold
    svc.checkStaleness(V, S, 'trade', 5000);
    expect(svc.health(V, S, 'trade')).toBe('LIVE');
    set(1000 + 5001); // past threshold
    svc.checkStaleness(V, S, 'trade', 5000);
    expect(svc.health(V, S, 'trade')).toBe('DEGRADED');
  });

  it('checkStaleness is a no-op for an unknown channel', () => {
    const { clock } = mutableClock();
    const svc = new FeedHealthService(clock, stubStream);
    svc.checkStaleness(V, S, 'nope', 1000); // must not throw
    expect(svc.health(V, S, 'nope')).toBe('GAP');
  });

  it('getRefPrice keeps the newest mid (older timestamps ignored)', () => {
    const { clock } = mutableClock();
    const svc = new FeedHealthService(clock, stubStream);
    expect(svc.getRefPrice(S)).toBeUndefined();
    svc.updateRefPrice(S, price('100'), epochMs(10));
    svc.updateRefPrice(S, price('99'), epochMs(5)); // older — ignored
    expect(svc.getRefPrice(S)?.mid.toFixed()).toBe('100');
    svc.updateRefPrice(S, price('101'), epochMs(20)); // newer — wins
    expect(svc.getRefPrice(S)?.mid.toFixed()).toBe('101');
  });

  it('base fetchCandles returns no candles (no exchange handle)', async () => {
    const { clock } = mutableClock();
    const svc = new FeedHealthService(clock, stubStream);
    expect(await svc.fetchCandles(V, S, '1m', 10)).toEqual([]);
  });
});

describe('FeedHealthServiceWithBackfill.fetchCandles (REST OHLCV warmup)', () => {
  it('normalizes ccxt OHLCV arrays into exact-Decimal CandleEvents', async () => {
    const { clock } = mutableClock();
    const ohlcv: OhlcvSource = {
      fetchOHLCV: () =>
        Promise.resolve([
          [60000, '100', '110', '90', '105.5', '10', false],
          [120000, '105.5', '112', '104', '108', '12', true],
        ]),
    };
    const cfg: VenueConfig = { id: 'binance', environment: 'paper' };
    const svc = new FeedHealthServiceWithBackfill(clock, stubStream, ohlcv, cfg);
    const candles = await svc.fetchCandles(V, S, '1m', 2);
    expect(candles.length).toBe(2);
    expect(candles[0]?.close.toFixed()).toBe('105.5'); // exact string
    // Backfill marks every historical bar closed (warmup must prime a closed-only strategy), even
    // the first bar whose raw closed flag was false.
    expect(candles.every((c) => c.closed)).toBe(true);
    expect(candles[0]?.interval).toBe('1m');
  });
});
