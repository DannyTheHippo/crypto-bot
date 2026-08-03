import { describe, it, expect } from 'vitest';
import {
  FeedHealthService,
  FeedHealthServiceWithBackfill,
  type OhlcvSource,
} from '../../../../src/features/venue/market-data/feed-health.service';
import type { ExchangeStreamPort } from '../../../../src/ports/venue/exchange-stream';
import type { ClockPort } from '../../../../src/ports/common/clock';
import type { VenueConfig } from '../../../../src/ports/common/app-config';
import { venueId, symbolId, epochMs } from '../../../../src/domain/common/types/ids';
import { price } from '../../../../src/domain/common/types/money';

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

  it('channelAges reports per-channel identity, age, and health for the metrics exporter', () => {
    const { clock, set } = mutableClock(1000);
    const svc = new FeedHealthService(clock, stubStream);
    const perpSym = symbolId('BTC/USDT:USDT'); // colon-bearing symbol must survive round-trip
    svc.recordEvent(V, S, 'ticker');
    svc.recordEvent(V, perpSym, 'candle:15m');
    set(1000 + 42_000);
    svc.checkStaleness(V, S, 'ticker', 30_000); // → DEGRADED
    const ages = svc.channelAges();
    expect(ages).toHaveLength(2);
    const ticker = ages.find((a) => a.channel === 'ticker');
    const candle = ages.find((a) => a.channel === 'candle:15m');
    expect(ticker).toMatchObject({ venue: V, symbol: S, ageSeconds: 42, health: 'DEGRADED' });
    expect(candle).toMatchObject({ venue: V, symbol: perpSym, ageSeconds: 42, health: 'LIVE' });
  });

  it('forcedReconnectCount accumulates recordForcedReconnect calls', () => {
    const { clock } = mutableClock();
    const svc = new FeedHealthService(clock, stubStream);
    expect(svc.forcedReconnectCount()).toBe(0);
    svc.recordForcedReconnect();
    svc.recordForcedReconnect();
    expect(svc.forcedReconnectCount()).toBe(2);
  });
});

describe('FeedHealthServiceWithBackfill.fetchCandles (REST OHLCV warmup)', () => {
  it('normalizes ccxt OHLCV arrays into exact-Decimal CandleEvents', async () => {
    // Clock set well past both bars' closeTime (openTime + 1m − 1ms): both are genuinely closed,
    // so this test exercises normalization only, not the closedness-by-clock logic below.
    const { clock } = mutableClock(200_000);
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
    // closed is derived from the clock (openTime + interval ≤ ingestTime), never from ccxt's own
    // (absent) closed flag — both bars enter closed:true here regardless of the raw a[6] value.
    expect(candles.every((c) => c.closed)).toBe(true);
    expect(candles[0]?.interval).toBe('1m');
  });

  it('drops a still-forming bar (closeTime has not yet passed ingestTime) instead of marking it closed', async () => {
    const { clock } = mutableClock(200_000);
    const ohlcv: OhlcvSource = {
      fetchOHLCV: () =>
        Promise.resolve([
          [60_000, '100', '110', '90', '105', '10'], // closeTime 119_999 < 200_000 — closed
          [120_000, '105', '112', '104', '108', '12'], // closeTime 179_999 < 200_000 — closed
          [180_000, '108', '109', '107', '108.5', '5'], // closeTime 239_999 ≥ 200_000 — still forming
        ]),
    };
    const cfg: VenueConfig = { id: 'binance', environment: 'paper' };
    const svc = new FeedHealthServiceWithBackfill(clock, stubStream, ohlcv, cfg);
    const candles = await svc.fetchCandles(V, S, '1m', 3);

    // The still-forming bar (openTime 180_000) never enters history at all — dropped, not
    // returned closed:false — so strategy-host.ts's warmup loop (which pushes whatever this
    // returns, with no closed-filter of its own) never sees a partial bar.
    expect(candles.map((c) => c.openTime)).toEqual([epochMs(60_000), epochMs(120_000)]);
    expect(candles.every((c) => c.closed)).toBe(true);
  });

  it('a backfill whose bars are all genuinely closed enters history in full', async () => {
    const { clock } = mutableClock(200_000);
    const ohlcv: OhlcvSource = {
      fetchOHLCV: () =>
        Promise.resolve([
          [60_000, '100', '110', '90', '105', '10'],
          [120_000, '105', '112', '104', '108', '12'],
        ]),
    };
    const cfg: VenueConfig = { id: 'binance', environment: 'paper' };
    const svc = new FeedHealthServiceWithBackfill(clock, stubStream, ohlcv, cfg);
    const candles = await svc.fetchCandles(V, S, '1m', 2);

    expect(candles).toHaveLength(2);
    expect(candles.every((c) => c.closed)).toBe(true);
  });
});
