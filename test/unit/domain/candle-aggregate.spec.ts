import { describe, it, expect } from 'vitest';
import { aggregateCandles } from '../../../src/domain/indicators/candle-aggregate';
import type { CandleEvent } from '../../../src/domain/types/market-events';
import { price, qty } from '../../../src/domain/types/money';
import { venueId, symbolId, epochMs } from '../../../src/domain/types/ids';

const V = venueId('binance');
const SYM = symbolId('BTC/USDT');

interface CandleSpec {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closed: boolean;
}

function candle(spec: CandleSpec): CandleEvent {
  return {
    kind: 'CANDLE',
    venue: V,
    symbol: SYM,
    channel: 'candle:1m',
    seq: BigInt(spec.openTime + 1),
    eventTime: epochMs(spec.openTime),
    ingestTime: epochMs(spec.openTime + 1),
    interval: '1m',
    openTime: epochMs(spec.openTime),
    closeTime: epochMs(spec.openTime + 60_000),
    open: price(spec.open),
    high: price(spec.high),
    low: price(spec.low),
    close: price(spec.close),
    volume: qty(spec.volume),
    closed: spec.closed,
  };
}

describe('aggregateCandles', () => {
  it('returns an empty array for empty input', () => {
    expect(aggregateCandles([], 3, 60_000)).toEqual([]);
  });

  it('throws for a non-integer or non-positive factor', () => {
    expect(() => aggregateCandles([], 0, 60_000)).toThrow();
    expect(() => aggregateCandles([], 1.5, 60_000)).toThrow();
    expect(() => aggregateCandles([], -2, 60_000)).toThrow();
  });

  it('throws for a non-integer or non-positive baseIntervalMs', () => {
    expect(() => aggregateCandles([], 3, 0)).toThrow();
    expect(() => aggregateCandles([], 3, 1.5)).toThrow();
    expect(() => aggregateCandles([], 3, -60_000)).toThrow();
  });

  it('is an identity-ish passthrough at factor 1', () => {
    const input = [
      candle({
        openTime: 0,
        open: '100',
        high: '110',
        low: '95',
        close: '105',
        volume: '1',
        closed: true,
      }),
      candle({
        openTime: 60_000,
        open: '105',
        high: '108',
        low: '100',
        close: '106',
        volume: '2',
        closed: false,
      }),
    ];
    const out = aggregateCandles(input, 1, 60_000);
    expect(out).toHaveLength(2);
    out.forEach((c, i) => {
      expect(c.openTime).toBe(input[i]!.openTime);
      expect(c.closeTime).toBe(input[i]!.closeTime);
      expect(c.open).toEqual(input[i]!.open);
      expect(c.high).toEqual(input[i]!.high);
      expect(c.low).toEqual(input[i]!.low);
      expect(c.close).toEqual(input[i]!.close);
      expect(c.volume).toEqual(input[i]!.volume);
      expect(c.closed).toBe(input[i]!.closed);
    });
  });

  describe('3x bucketing over a stream that starts mid-bucket', () => {
    // base=1m, factor=3 -> 3m buckets: [0,180000) [180000,360000) [360000,540000). The stream
    // starts at 60000 (one candle already into the first bucket), so bucket 0 is short; bucket 1
    // is fully populated; bucket 2 (trailing) holds a single, still-developing candle.
    const input = [
      candle({
        openTime: 60_000,
        open: '50',
        high: '55',
        low: '48',
        close: '52',
        volume: '1',
        closed: true,
      }),
      candle({
        openTime: 120_000,
        open: '52',
        high: '58',
        low: '47',
        close: '54',
        volume: '1',
        closed: true,
      }),
      candle({
        openTime: 180_000,
        open: '100',
        high: '110',
        low: '95',
        close: '105',
        volume: '1',
        closed: true,
      }),
      candle({
        openTime: 240_000,
        open: '105',
        high: '115',
        low: '90',
        close: '108',
        volume: '2',
        closed: true,
      }),
      candle({
        openTime: 300_000,
        open: '108',
        high: '112',
        low: '98',
        close: '103',
        volume: '3',
        closed: true,
      }),
      candle({
        openTime: 360_000,
        open: '200',
        high: '205',
        low: '195',
        close: '202',
        volume: '5',
        closed: true,
      }),
    ];
    const out = aggregateCandles(input, 3, 60_000);

    it('lands each candle in the bucket its openTime floors into', () => {
      expect(out).toHaveLength(3);
      expect(out.map((c) => c.openTime)).toEqual([0, 180_000, 360_000]);
    });

    it('folds a full bucket as first-open/max-high/min-low/last-close/summed-volume', () => {
      const full = out[1]!;
      expect(full.closeTime).toBe(360_000);
      expect(full.open).toEqual(price('100'));
      expect(full.high).toEqual(price('115'));
      expect(full.low).toEqual(price('90'));
      expect(full.close).toEqual(price('103'));
      expect(full.volume).toEqual(qty('6'));
      expect(full.closed).toBe(true);
    });

    it('marks a short leading bucket closed=false regardless of its last member', () => {
      const short = out[0]!;
      expect(short.open).toEqual(price('50'));
      expect(short.high).toEqual(price('58'));
      expect(short.low).toEqual(price('47'));
      expect(short.close).toEqual(price('54'));
      expect(short.volume).toEqual(qty('2'));
      expect(short.closed).toBe(false); // only 2 of 3 members, though the last member itself closed
    });

    it('emits the trailing partial bucket forced closed=false even when its sole member closed', () => {
      const trailing = out[2]!;
      expect(trailing.open).toEqual(price('200'));
      expect(trailing.high).toEqual(price('205'));
      expect(trailing.low).toEqual(price('195'));
      expect(trailing.close).toEqual(price('202'));
      expect(trailing.volume).toEqual(qty('5'));
      expect(trailing.closed).toBe(false); // 1 of 3 members, still developing — forced false
    });
  });
});
