import { describe, it, expect } from 'vitest';
import { EmaCrossStrategy } from '../../../src/domain/strategy/ema-cross.strategy';
import type { MarketView } from '../../../src/domain/strategy/strategy';
import type { CandleEvent } from '../../../src/domain/types/market-events';
import type { Signal } from '../../../src/domain/types/signal';
import { price, qty } from '../../../src/domain/types/money';
import { strategyId, venueId, symbolId, epochMs } from '../../../src/domain/types/ids';

const V = venueId('binance');
const S = symbolId('BTC/USDT');
const view = {} as MarketView;

function candle(seq: number, close: string, t: number): CandleEvent {
  return {
    kind: 'CANDLE', venue: V, symbol: S, channel: 'candle:1h', seq: BigInt(seq),
    eventTime: epochMs(t), ingestTime: epochMs(t + 1), interval: '1h',
    openTime: epochMs(t), closeTime: epochMs(t + 3_600_000 - 1),
    open: price(close), high: price(close), low: price(close), close: price(close),
    volume: qty('1'), closed: true,
  };
}

const CLOSES = ['100', '100', '100', '100', '100', '110', '125', '140', '160', '150', '130', '110', '90', '70', '90', '120', '160'];

// Serialize a Signal to a plain, comparable shape (Decimals → exact strings, bigint → string).
function serialize(s: Signal) {
  return {
    strategyId: s.strategyId,
    kind: s.kind,
    strength: s.strength,
    refPrice: s.refPrice.toFixed(),
    basedOnSeq: s.basedOnSeq.toString(),
    eventTime: s.eventTime,
    ttlMs: s.ttlMs,
    dedupeKey: s.dedupeKey,
    reason: s.reason,
  };
}

function runOnce(): ReturnType<typeof serialize>[] {
  const strat = new EmaCrossStrategy(strategyId('ema1'), { fast: 3, slow: 5, symbol: S, venue: V, ttlMs: 30_000 });
  const out: ReturnType<typeof serialize>[] = [];
  CLOSES.forEach((c, i) => {
    for (const sig of strat.onCandle(candle(i, c, 1000 + i), view)) out.push(serialize(sig));
  });
  return out;
}

describe('replay determinism (backtest/live symmetry guarantee)', () => {
  it('produces a byte-identical Signal sequence for the same candle fixture', () => {
    const a = runOnce();
    const b = runOnce();
    expect(b).toEqual(a); // pure handlers + eventTime-only clock ⇒ reproducible
    expect(a.length).toBeGreaterThan(0); // the fixture actually exercises crosses
  });

  it('dedupeKeys are deterministic and unique across the run', () => {
    const a = runOnce();
    const keys = a.map((s) => s.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
