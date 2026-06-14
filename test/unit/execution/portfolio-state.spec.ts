import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { PortfolioStateService } from '../../../src/modules/execution/portfolio-state.service';
import { FeeLedgerService } from '../../../src/modules/execution/fee-ledger.service';
import { positionKey } from '../../../src/domain/risk/evaluate';
import { makeIntent, makeFill, SID, V, SYM } from './helpers';
import { price, qty, feeAmount } from '../../../src/domain/types/money';
import { strategyId } from '../../../src/domain/types/ids';

function make() {
  const fees = new FeeLedgerService();
  const ps = new PortfolioStateService({ quoteAsset: 'USDT', startingCash: '100000' }, fees);
  return { ps, fees };
}

describe('PortfolioStateService', () => {
  it('starts flat with cash = equity = peak = sod and seq 1', () => {
    const { ps } = make();
    const s = ps.snapshot();
    expect(s.equity.toFixed()).toBe('100000');
    expect(s.peakEquity.toFixed()).toBe('100000');
    expect(s.sodEquityUtc.toFixed()).toBe('100000');
    expect(s.positions.size).toBe(0);
    expect(s.balances.get('USDT')?.free.toFixed()).toBe('100000');
    expect(s.snapshotSeq).toBe(1n);
  });

  it('restoreFromSnapshot replaces in-memory state (cash/equity/peak/sod + positions) on boot recovery', () => {
    const { ps } = make();
    // Seed a pre-existing position so we prove restore clears the old map before loading the snapshot.
    ps.applyFill(makeIntent({ side: 'BUY' }), makeFill({ qty: qty('1'), price: price('100') }));

    const restored = {
      strategyId: SID,
      venue: V,
      symbol: SYM,
      signedQty: new Decimal('2'),
      avgEntry: price('150'),
      realizedPnl: new Decimal('5'),
    };
    ps.restoreFromSnapshot({
      cash: new Decimal('50000'),
      equity: new Decimal('50300'),
      peak: new Decimal('51000'),
      sodEquity: new Decimal('49000'),
      positions: [restored],
    });

    const s = ps.snapshot();
    expect(ps.cashBalance().toFixed()).toBe('50000');
    expect(s.equity.toFixed()).toBe('50300');
    expect(s.peakEquity.toFixed()).toBe('51000');
    expect(s.sodEquityUtc.toFixed()).toBe('49000');
    expect(s.positions.size).toBe(1);
    const p = s.positions.get(positionKey(SID, V, SYM));
    expect(p?.signedQty.toFixed()).toBe('2');
    expect(p?.avgEntry.toFixed()).toBe('150');
    expect(p?.realizedPnl.toFixed()).toBe('5');
  });

  it('opens a position and debits quote cash on a BUY fill', () => {
    const { ps } = make();
    ps.applyFill(makeIntent({ side: 'BUY' }), makeFill({ qty: qty('1'), price: price('100') }));
    const s = ps.snapshot();
    expect(ps.cashBalance().toFixed()).toBe('99900');
    expect(s.positions.get(positionKey(SID, V, SYM))?.signedQty.toFixed()).toBe('1');
    expect(s.balances.get('BTC')?.free.toFixed()).toBe('1');
    expect(s.snapshotSeq).toBe(2n);
  });

  it('removes the position when a fill closes it to flat; cash reflects the round trip', () => {
    const { ps } = make();
    ps.applyFill(makeIntent({ side: 'BUY' }), makeFill({ qty: qty('1'), price: price('100') }));
    ps.applyFill(makeIntent({ side: 'SELL' }), makeFill({ venueTradeId: 't2', qty: qty('1'), price: price('110') }));
    expect(ps.snapshot().positions.size).toBe(0);
    expect(ps.cashBalance().toFixed()).toBe('100010'); // -100 + 110
  });

  it('routes a third-asset fee to the fee ledger', () => {
    const { ps, fees } = make();
    ps.applyFill(makeIntent({ side: 'BUY' }), makeFill({ qty: qty('1'), price: price('100'), fee: { ccy: 'BNB', amount: feeAmount('0.5') } }));
    expect(fees.total('BNB').toFixed()).toBe('0.5');
  });

  it('shaves retained base on a base-currency fee', () => {
    const { ps } = make();
    ps.applyFill(makeIntent({ side: 'BUY' }), makeFill({ qty: qty('2'), price: price('100'), fee: { ccy: 'BTC', amount: feeAmount('0.002') } }));
    expect(ps.snapshot().positions.get(positionKey(SID, V, SYM))?.signedQty.toFixed()).toBe('1.998');
  });

  it('forStrategy returns only that strategy’s positions and open orders', () => {
    const { ps } = make();
    const sid2 = strategyId('s2');
    ps.applyFill(makeIntent({ side: 'BUY' }), makeFill({ qty: qty('1'), price: price('100') }));
    ps.applyFill(makeIntent({ side: 'BUY', strategyId: sid2 }), makeFill({ venueTradeId: 't9', qty: qty('1'), price: price('100') }));
    ps.openOrder(SID, { clientOrderId: makeIntent().clientOrderId, symbol: SYM, side: 'BUY', qty: qty('1'), limitPrice: price('100') });
    const view = ps.forStrategy(SID);
    expect(view.positions.size).toBe(1);
    expect(view.positions.get(positionKey(SID, V, SYM))).toBeDefined();
    expect(view.openOrders).toHaveLength(1);
  });

  it('ratchets peak equity and never lowers it', () => {
    const { ps } = make();
    ps.recordEquity(new Decimal('120000'));
    ps.recordEquity(new Decimal('110000'));
    const s = ps.snapshot();
    expect(s.equity.toFixed()).toBe('110000');
    expect(s.peakEquity.toFixed()).toBe('120000');
  });

  it('tracks in-flight intents and open orders in the snapshot, and clears them', () => {
    const { ps } = make();
    const intent = makeIntent();
    ps.addInFlight(intent);
    ps.openOrder(SID, { clientOrderId: intent.clientOrderId, symbol: SYM, side: 'BUY', qty: qty('1'), limitPrice: price('100') });
    let s = ps.snapshot();
    expect(s.inFlightIntents).toHaveLength(1);
    expect(s.openOrders).toHaveLength(1);
    ps.clearInFlight(intent.clientOrderId);
    ps.closeOrder(intent.clientOrderId);
    s = ps.snapshot();
    expect(s.inFlightIntents).toHaveLength(0);
    expect(s.openOrders).toHaveLength(0);
  });
});
