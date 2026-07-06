import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  walkRoundTrips,
  sumFeesQuote,
  type RoundTripFill,
} from '../../../src/domain/risk/round-trips';

const DUST = new Decimal(5);

function fill(over: Partial<RoundTripFill> = {}): RoundTripFill {
  return {
    strategyId: 'agentic-1',
    symbol: 'BTC/USDT',
    side: 'BUY',
    qty: '1',
    price: '100',
    fee: null,
    feeAsset: null,
    executedAt: 1_000,
    ...over,
  };
}

describe('domain/risk round-trip walk', () => {
  it('closes a simple buy→sell cycle with gross PnL, VWAPs, and the open/close window', () => {
    const { cycles, unconvertibleFeeAsset } = walkRoundTrips(
      [
        fill({ qty: '1', price: '100', executedAt: 1_000 }),
        fill({ side: 'SELL', qty: '1', price: '110', executedAt: 2_000 }),
      ],
      DUST,
    );
    expect(unconvertibleFeeAsset).toBe(false);
    expect(cycles).toHaveLength(1);
    const c = cycles[0]!;
    expect(c.strategyId).toBe('agentic-1');
    expect(c.symbol).toBe('BTC/USDT');
    expect(c.realizedPnl.toFixed()).toBe('10');
    expect(c.openedAt).toBe(1_000);
    expect(c.closedAt).toBe(2_000);
    expect(c.entryVwap!.toFixed()).toBe('100');
    expect(c.exitVwap!.toFixed()).toBe('110');
    expect(c.boughtQty.toFixed()).toBe('1');
    expect(c.soldQty.toFixed()).toBe('1');
    expect(c.meanSlippageBps).toBeNull(); // no refPrice on any fill
  });

  it('entry VWAP averages multiple buys; a partial exit above dust keeps the cycle open', () => {
    const { cycles } = walkRoundTrips(
      [
        fill({ qty: '1', price: '100', executedAt: 1 }),
        fill({ qty: '1', price: '120', executedAt: 2 }),
        fill({ side: 'SELL', qty: '1', price: '130', executedAt: 3 }), // residual 1×130 ≥ dust → open
        fill({ side: 'SELL', qty: '1', price: '90', executedAt: 4 }),
      ],
      DUST,
    );
    expect(cycles).toHaveLength(1);
    const c = cycles[0]!;
    expect(c.entryVwap!.toFixed()).toBe('110'); // (100+120)/2
    expect(c.exitVwap!.toFixed()).toBe('110'); // (130+90)/2
    expect(c.realizedPnl.toFixed()).toBe('0'); // 220 proceeds − 220 cost
    expect(c.openedAt).toBe(1);
    expect(c.closedAt).toBe(4);
  });

  it('a second cycle in the same group starts fresh (accumulators and openedAt reset)', () => {
    const { cycles } = walkRoundTrips(
      [
        fill({ qty: '1', price: '100', executedAt: 1 }),
        fill({ side: 'SELL', qty: '1', price: '105', executedAt: 2 }),
        fill({ qty: '2', price: '200', executedAt: 3 }),
        fill({ side: 'SELL', qty: '2', price: '210', executedAt: 4 }),
      ],
      DUST,
    );
    expect(cycles).toHaveLength(2);
    expect(cycles[0]!.realizedPnl.toFixed()).toBe('5');
    expect(cycles[1]!.realizedPnl.toFixed()).toBe('20');
    expect(cycles[1]!.openedAt).toBe(3);
    expect(cycles[1]!.entryVwap!.toFixed()).toBe('200');
  });

  it('walks (strategyId, symbol) groups independently', () => {
    const { cycles } = walkRoundTrips(
      [
        fill({ strategyId: 'a', qty: '1', price: '100', executedAt: 1 }),
        fill({ strategyId: 'b', symbol: 'ETH/USDT', qty: '1', price: '10', executedAt: 2 }),
        fill({ strategyId: 'a', side: 'SELL', qty: '1', price: '101', executedAt: 3 }),
        fill({
          strategyId: 'b',
          symbol: 'ETH/USDT',
          side: 'SELL',
          qty: '1',
          price: '12',
          executedAt: 4,
        }),
      ],
      DUST,
    );
    expect(cycles.map((c) => `${c.strategyId}:${c.realizedPnl.toFixed()}`)).toEqual(['a:1', 'b:2']);
  });

  it('skips null-join fills (unresolved strategyId or side) entirely', () => {
    const { cycles } = walkRoundTrips(
      [
        fill({ strategyId: null, executedAt: 1 }),
        fill({ side: null, executedAt: 2 }),
        fill({ qty: '1', price: '100', executedAt: 3 }),
        fill({ side: 'SELL', qty: '1', price: '104', executedAt: 4 }),
      ],
      DUST,
    );
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.realizedPnl.toFixed()).toBe('4');
    expect(cycles[0]!.openedAt).toBe(3); // the null-join rows never opened the cycle
  });

  it('a dust-close on a stray SELL yields a cycle with no entry VWAP', () => {
    // 0.01 × 100 = 1 < dust 5 → the lone SELL closes instantly; nothing was bought.
    const { cycles } = walkRoundTrips(
      [fill({ side: 'SELL', qty: '0.01', price: '100', executedAt: 7 })],
      DUST,
    );
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.entryVwap).toBeNull();
    expect(cycles[0]!.exitVwap!.toFixed()).toBe('100');
    expect(cycles[0]!.realizedPnl.toFixed()).toBe('1');
  });

  it('a dust-close on a tiny BUY yields a cycle with no exit VWAP', () => {
    const { cycles } = walkRoundTrips([fill({ qty: '0.01', price: '100', executedAt: 8 })], DUST);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.exitVwap).toBeNull();
    expect(cycles[0]!.entryVwap!.toFixed()).toBe('100');
    expect(cycles[0]!.realizedPnl.toFixed()).toBe('-1');
  });

  it('accumulates per-cycle fees: quote directly, base at the fill price', () => {
    const { cycles, unconvertibleFeeAsset } = walkRoundTrips(
      [
        fill({ qty: '1', price: '100', fee: '0.001', feeAsset: 'BTC', executedAt: 1 }), // 0.001×100 = 0.1
        fill({
          side: 'SELL',
          qty: '1',
          price: '110',
          fee: '0.11',
          feeAsset: 'USDT',
          executedAt: 2,
        }),
      ],
      DUST,
    );
    expect(unconvertibleFeeAsset).toBe(false);
    expect(cycles[0]!.feesQuote.toFixed()).toBe('0.21');
  });

  it('flags an unconvertible fee asset and excludes it from the per-cycle sum', () => {
    const { cycles, unconvertibleFeeAsset } = walkRoundTrips(
      [
        fill({ qty: '1', price: '100', fee: '0.05', feeAsset: 'BNB', executedAt: 1 }),
        fill({ side: 'SELL', qty: '1', price: '110', executedAt: 2 }),
      ],
      DUST,
    );
    expect(unconvertibleFeeAsset).toBe(true);
    expect(cycles[0]!.feesQuote.toFixed()).toBe('0');
  });

  it('computes mean signed slippage over fills carrying a usable refPrice', () => {
    const { cycles } = walkRoundTrips(
      [
        // BUY at 101 vs ref 100 → +100 bps adverse.
        fill({ qty: '1', price: '101', refPrice: '100', executedAt: 1 }),
        // SELL at 99 vs ref 100 → +100 bps adverse (sign flipped for sells).
        fill({ side: 'SELL', qty: '1', price: '99', refPrice: '100', executedAt: 2 }),
      ],
      DUST,
    );
    expect(cycles[0]!.meanSlippageBps!.toFixed()).toBe('100');
  });

  it('favorable fills read negative; refPrice null/absent/non-positive contribute nothing', () => {
    const { cycles } = walkRoundTrips(
      [
        // BUY below ref → favorable → −100 bps.
        fill({ qty: '1', price: '99', refPrice: '100', executedAt: 1 }),
        fill({ qty: '1', price: '100', refPrice: null, executedAt: 2 }),
        fill({ qty: '1', price: '100', executedAt: 3 }), // refPrice absent
        fill({ qty: '1', price: '100', refPrice: '0', executedAt: 4 }), // non-positive guard
        fill({ side: 'SELL', qty: '4', price: '100', executedAt: 5 }),
      ],
      DUST,
    );
    expect(cycles[0]!.meanSlippageBps!.toFixed()).toBe('-100'); // single contributing fill
  });
});

describe('domain/risk sumFeesQuote', () => {
  it('sums quote fees directly and base fees at the fill price; skips null fee fields', () => {
    const total = sumFeesQuote([
      fill({ fee: '0.5', feeAsset: 'USDT' }),
      fill({ fee: '0.001', feeAsset: 'BTC', price: '200' }), // 0.2
      fill({ fee: null, feeAsset: 'USDT' }),
      fill({ fee: '1', feeAsset: null }),
    ]);
    expect(total.toFixed()).toBe('0.7');
  });

  it('excludes unconvertible fee assets from the sum', () => {
    const total = sumFeesQuote([fill({ fee: '3', feeAsset: 'BNB' })]);
    expect(total.toFixed()).toBe('0');
  });

  it('treats a slashless symbol as having no quote asset (unconvertible quote-looking fee)', () => {
    // 'BTCUSDT' has no '/' → quoteAssetOf '' → a USDT fee is neither base nor quote.
    const { unconvertibleFeeAsset } = walkRoundTrips(
      [
        fill({ symbol: 'BTCUSDT', fee: '1', feeAsset: 'USDT', qty: '1', price: '100' }),
        fill({ symbol: 'BTCUSDT', side: 'SELL', qty: '1', price: '100', executedAt: 2 }),
      ],
      DUST,
    );
    expect(unconvertibleFeeAsset).toBe(true);
    expect(sumFeesQuote([fill({ symbol: 'BTCUSDT', fee: '1', feeAsset: 'USDT' })]).toFixed()).toBe(
      '0',
    );
  });
});
