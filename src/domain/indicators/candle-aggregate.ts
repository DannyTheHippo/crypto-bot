import type { CandleEvent } from '../types/market-events';
import { qty } from '../types/money';
import { epochMs, type EpochMs } from '../types/ids';

// Folds a single-symbol, time-ordered CandleEvent stream into `factor`-wide higher-timeframe
// buckets. baseIntervalMs is an explicit param (rather than inferred from candle spacing) so the
// fold stays pure and unambiguous even across feed gaps. Bucket start = openTime floored to the
// bucket width (factor × baseIntervalMs); OHLC folds as first-open/max-high/min-low/last-close,
// volume sums via Qty (never a native float). The trailing bucket is emitted even when it holds
// fewer than `factor` members — it represents the still-developing higher-timeframe bar, and its
// `closed` flag is forced false in that case regardless of the last member's own `closed` state.
// `interval` is inherited unchanged from the source candles: CandleInterval's closed union has no
// slot for an arbitrary aggregated factor, so callers derive the effective timeframe themselves
// from (factor × baseIntervalMs) rather than from this field.
export function aggregateCandles(
  candles: readonly CandleEvent[],
  factor: number,
  baseIntervalMs: number,
): CandleEvent[] {
  if (!Number.isInteger(factor) || factor <= 0) {
    throw new Error(`aggregateCandles: factor must be a positive integer, got ${factor}`);
  }
  if (!Number.isInteger(baseIntervalMs) || baseIntervalMs <= 0) {
    throw new Error(
      `aggregateCandles: baseIntervalMs must be a positive integer, got ${baseIntervalMs}`,
    );
  }
  if (candles.length === 0) return [];

  const bucketWidthMs = factor * baseIntervalMs;
  const buckets: CandleEvent[][] = [];
  const bucketIndexByStart = new Map<number, number>();

  for (const candle of candles) {
    const bucketStart = Math.floor(candle.openTime / bucketWidthMs) * bucketWidthMs;
    let idx = bucketIndexByStart.get(bucketStart);
    if (idx === undefined) {
      idx = buckets.length;
      bucketIndexByStart.set(bucketStart, idx);
      buckets.push([]);
    }
    buckets[idx]!.push(candle);
  }

  return buckets.map((members) => foldBucket(members, factor, bucketWidthMs));
}

function foldBucket(
  members: readonly CandleEvent[],
  factor: number,
  bucketWidthMs: number,
): CandleEvent {
  const first = members[0]!;
  const last = members[members.length - 1]!;
  const bucketStart: EpochMs = epochMs(Math.floor(first.openTime / bucketWidthMs) * bucketWidthMs);

  let high = first.high;
  let low = first.low;
  let volume = first.volume;
  for (let i = 1; i < members.length; i++) {
    const c = members[i]!;
    if (c.high.gt(high)) high = c.high;
    if (c.low.lt(low)) low = c.low;
    volume = qty(volume.plus(c.volume));
  }

  return {
    ...last,
    openTime: bucketStart,
    closeTime: last.closeTime,
    open: first.open,
    high,
    low,
    close: last.close,
    volume,
    closed: members.length === factor && last.closed,
  };
}
