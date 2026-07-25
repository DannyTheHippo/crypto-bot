import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { applyFillToPortfolio } from '../../../../src/domain/trading/oms/portfolio-fill';
import { FLAT } from '../../../../src/domain/trading/oms/position';

const D = (s: string) => new Decimal(s);

describe('applyFillToPortfolio (§6.6 fee regimes)', () => {
  it('BUY with no fee spends quote and opens the position at the fill', () => {
    const r = applyFillToPortfolio(FLAT, {
      side: 'BUY',
      fillQty: D('2'),
      fillPrice: D('100'),
      fee: null,
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
    });
    expect(r.cashDelta.toFixed()).toBe('-200');
    expect(r.position.signedQty.toFixed()).toBe('2');
    expect(r.position.avgEntry.toFixed()).toBe('100');
    expect(r.feeLedger).toBeNull();
  });

  it('quote fee is charged to both quote cash and realized PnL (one cost, two ledgers)', () => {
    const long = applyFillToPortfolio(FLAT, {
      side: 'BUY',
      fillQty: D('2'),
      fillPrice: D('100'),
      fee: null,
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
    }).position;
    const r = applyFillToPortfolio(long, {
      side: 'SELL',
      fillQty: D('2'),
      fillPrice: D('110'),
      fee: { ccy: 'USDT', amount: D('0.22') },
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
    });
    expect(r.cashDelta.toFixed()).toBe('219.78'); // +220 proceeds − 0.22 fee
    expect(r.position.signedQty.toFixed()).toBe('0'); // closed
    expect(r.position.realizedPnl.toFixed()).toBe('19.78'); // (110−100)×2 − 0.22
    expect(r.feeLedger).toBeNull();
  });

  it('base fee shaves retained base (net), keeps cost basis gross, no fee ledger', () => {
    const r = applyFillToPortfolio(FLAT, {
      side: 'BUY',
      fillQty: D('2'),
      fillPrice: D('100'),
      fee: { ccy: 'BTC', amount: D('0.002') },
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
    });
    expect(r.cashDelta.toFixed()).toBe('-200'); // gross quote spent; fee taken in base
    expect(r.position.signedQty.toFixed()).toBe('1.998'); // 2 − 0.002 net base retained
    expect(r.position.avgEntry.toFixed()).toBe('100'); // cost basis stays gross
    expect(r.feeLedger).toBeNull();
  });

  it('third-asset fee is recorded in the ledger and never touches position or cash', () => {
    const r = applyFillToPortfolio(FLAT, {
      side: 'BUY',
      fillQty: D('2'),
      fillPrice: D('100'),
      fee: { ccy: 'BNB', amount: D('0.5') },
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
    });
    expect(r.cashDelta.toFixed()).toBe('-200');
    expect(r.position.signedQty.toFixed()).toBe('2');
    expect(r.position.realizedPnl.toFixed()).toBe('0');
    expect(r.feeLedger).toEqual({ asset: 'BNB', amount: D('0.5') });
  });
});
