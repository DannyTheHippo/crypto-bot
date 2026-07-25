import { describe, it, expect, beforeAll } from 'vitest';
import Decimal from 'decimal.js';
import { PortfolioStateService } from '../../../../src/features/trading/execution/portfolio-state.service';
import { FeeLedgerService } from '../../../../src/features/trading/execution/fee-ledger.service';
import { positionKey } from '../../../../src/domain/trading/risk/evaluate';
import { makeIntent, makeFill, SID, V, SYM } from './helpers';
import { price, qty, feeAmount, setupDecimal } from '../../../../src/domain/common/types/money';
import { strategyId, venueId, symbolId } from '../../../../src/domain/common/types/ids';

// Production runs under the global Decimal config (precision 40, ROUND_HALF_EVEN); main.ts calls
// setupDecimal() at bootstrap. The PRECISION_OVERFLOW regression below only reproduces under that
// config (default precision 20 truncates the quotient before it can overflow), so the whole spec
// runs under it. Every other assertion here is precision-insensitive (exact integer/short-decimal).
beforeAll(() => setupDecimal());

function make(dustNotional?: string) {
  const fees = new FeeLedgerService();
  const ps = new PortfolioStateService(
    { quoteAsset: 'USDT', startingCash: '100000', dustNotional },
    fees,
  );
  return { ps, fees };
}

// v3 §6.4: seeds the per-venue cash split (PortfolioConfig.venueCapitalShare) — a separate helper
// from make() above so every existing pre-split call site stays byte-identical.
function makeWithVenues(venueCapitalShare: ReadonlyMap<string, string>) {
  const fees = new FeeLedgerService();
  const ps = new PortfolioStateService(
    { quoteAsset: 'USDT', startingCash: '100000', venueCapitalShare },
    fees,
  );
  return { ps, fees };
}

describe('PortfolioStateService', () => {
  it('starts flat with cash = equity = peak = sod and seq 1', () => {
    const { ps } = make();
    const s = ps.snapshot();
    expect(s.equity.toFixed()).toBe('100000');
    expect(s.peakEquity.toFixed()).toBe('100000');
    expect(s.sodEquityUtc.toFixed()).toBe('100000');
    expect(s.unrealized.toFixed()).toBe('0'); // no marks recorded yet
    expect(s.startingCash.toFixed()).toBe('100000'); // seed baseline
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
    const app = ps.applyFill(
      makeIntent({ side: 'BUY' }),
      makeFill({ qty: qty('1'), price: price('100') }),
    );
    // An opening fill is not a round trip: no closed-to-flat, no realized PnL.
    expect(app.closedToFlat).toBe(false);
    expect(app.roundTripRealizedPnl).toBeNull();
    const s = ps.snapshot();
    expect(ps.cashBalance().toFixed()).toBe('99900');
    expect(s.positions.get(positionKey(SID, V, SYM))?.signedQty.toFixed()).toBe('1');
    expect(s.balances.get('BTC')?.free.toFixed()).toBe('1');
    expect(s.snapshotSeq).toBe(2n);
  });

  it('removes the position when a fill closes it to flat; returns the round-trip realized PnL', () => {
    const { ps } = make();
    const open = ps.applyFill(
      makeIntent({ side: 'BUY' }),
      makeFill({ qty: qty('1'), price: price('100') }),
    );
    expect(open.closedToFlat).toBe(false);
    const close = ps.applyFill(
      makeIntent({ side: 'SELL' }),
      makeFill({ venueTradeId: 't2', qty: qty('1'), price: price('110') }),
    );
    expect(ps.snapshot().positions.size).toBe(0);
    expect(ps.cashBalance().toFixed()).toBe('100010'); // -100 + 110
    expect(close.closedToFlat).toBe(true);
    expect(close.roundTripRealizedPnl?.toFixed()).toBe('10'); // (110 − 100) × 1, net of (no) fees
  });

  it('routes a third-asset fee to the fee ledger', () => {
    const { ps, fees } = make();
    ps.applyFill(
      makeIntent({ side: 'BUY' }),
      makeFill({
        qty: qty('1'),
        price: price('100'),
        fee: { ccy: 'BNB', amount: feeAmount('0.5') },
      }),
    );
    expect(fees.total('BNB').toFixed()).toBe('0.5');
  });

  it('shaves retained base on a base-currency fee', () => {
    const { ps } = make();
    ps.applyFill(
      makeIntent({ side: 'BUY' }),
      makeFill({
        qty: qty('2'),
        price: price('100'),
        fee: { ccy: 'BTC', amount: feeAmount('0.002') },
      }),
    );
    expect(
      ps
        .snapshot()
        .positions.get(positionKey(SID, V, SYM))
        ?.signedQty.toFixed(),
    ).toBe('1.998');
  });

  it('forStrategy returns only that strategy’s positions and open orders', () => {
    const { ps } = make();
    const sid2 = strategyId('s2');
    ps.applyFill(makeIntent({ side: 'BUY' }), makeFill({ qty: qty('1'), price: price('100') }));
    ps.applyFill(
      makeIntent({ side: 'BUY', strategyId: sid2 }),
      makeFill({ venueTradeId: 't9', qty: qty('1'), price: price('100') }),
    );
    ps.openOrder(SID, {
      clientOrderId: makeIntent().clientOrderId,
      symbol: SYM,
      side: 'BUY',
      qty: qty('1'),
      limitPrice: price('100'),
    });
    const view = ps.forStrategy(SID);
    expect(view.positions.size).toBe(1);
    expect(view.positions.get(positionKey(SID, V, SYM))).toBeDefined();
    expect(view.openOrders).toHaveLength(1);
  });

  it('ratchets peak equity and never lowers it; surfaces the last-recorded unrealized PnL', () => {
    const { ps } = make();
    ps.recordEquity(new Decimal('120000'), new Decimal('500'));
    ps.recordEquity(new Decimal('110000'), new Decimal('-300'));
    const s = ps.snapshot();
    expect(s.equity.toFixed()).toBe('110000');
    expect(s.peakEquity.toFixed()).toBe('120000');
    expect(s.unrealized.toFixed()).toBe('-300'); // tracks the latest sample, not the peak
    expect(s.startingCash.toFixed()).toBe('100000'); // unchanged by equity recording
  });

  it('tracks in-flight intents and open orders in the snapshot, and clears them', () => {
    const { ps } = make();
    const intent = makeIntent();
    ps.addInFlight(intent);
    ps.openOrder(SID, {
      clientOrderId: intent.clientOrderId,
      symbol: SYM,
      side: 'BUY',
      qty: qty('1'),
      limitPrice: price('100'),
    });
    let s = ps.snapshot();
    expect(s.inFlightIntents).toHaveLength(1);
    expect(s.openOrders).toHaveLength(1);
    ps.clearInFlight(intent.clientOrderId);
    ps.closeOrder(intent.clientOrderId);
    s = ps.snapshot();
    expect(s.inFlightIntents).toHaveLength(0);
    expect(s.openOrders).toHaveLength(0);
  });

  // Regression for the live testnet/demo fill-poller stall: an add-to-position fill whose
  // average-cost entry is non-terminating. avgEntry is minted as a Price at applyFill (the
  // portfolio-state mint), so a >18-dp quotient threw MoneyError[PRECISION_OVERFLOW] and aborted
  // fill ingestion. Numbers are real BTC/USDT fills from the live DB (fills #1 + #14): open
  // 0.00156 @ 63965.66, then add 0.00046 @ 64113.19. The pure applyFillToPosition test alone is
  // insufficient — the production throw is the Price mint, which only the full applyFill exercises.
  it('rounds a non-terminating weighted-average entry to ≤18 dp on an add-to-position fill (no PRECISION_OVERFLOW)', () => {
    const { ps } = make();
    ps.applyFill(
      makeIntent({ side: 'BUY' }),
      makeFill({ venueTradeId: 't1', qty: qty('0.00156'), price: price('63965.66') }),
    );
    ps.applyFill(
      makeIntent({ side: 'BUY' }),
      makeFill({ venueTradeId: 't14', qty: qty('0.00046'), price: price('64113.19') }),
    );
    const p = ps.snapshot().positions.get(positionKey(SID, V, SYM));
    expect(p?.signedQty.toFixed()).toBe('0.00202');
    // (0.00156×63965.66 + 0.00046×64113.19) / 0.00202 = 63999.25594059405940594…, rounded
    // HALF_EVEN to the money type's 18-dp maximum — exact string, never toBeCloseTo (CLAUDE.md #1).
    expect(p?.avgEntry.toFixed()).toBe('63999.255940594059405941');
    expect((p?.avgEntry.toFixed().split('.')[1] ?? '').length).toBeLessThanOrEqual(18);
  });

  // The fix newly unblocks the reduce path: before it, the add above threw and ingestion stalled,
  // so a subsequent reducing fill was unreachable. realizedPnl = (fillPrice − avgEntry)×closeQty is
  // a product of ≤18-dp values, so it can legitimately exceed 18 dp — but it is NEVER minted through
  // a money constructor (held raw on PositionState, persisted via toFixed() into NUMERIC(38,18)
  // which Postgres rounds, exported to metrics via toNumber()). So the reduce must NOT throw, and
  // realizedPnl stays an exact raw Decimal. avgEntry is unchanged on a partial reduce.
  it('reduces after the rounded-entry add without overflow; realizedPnl stays raw (>18 dp, unminted)', () => {
    const { ps } = make();
    ps.applyFill(
      makeIntent({ side: 'BUY' }),
      makeFill({ venueTradeId: 't1', qty: qty('0.00156'), price: price('63965.66') }),
    );
    ps.applyFill(
      makeIntent({ side: 'BUY' }),
      makeFill({ venueTradeId: 't14', qty: qty('0.00046'), price: price('64113.19') }),
    );
    expect(() =>
      ps.applyFill(
        makeIntent({ side: 'SELL' }),
        makeFill({ venueTradeId: 't-sell', qty: qty('0.001'), price: price('64200') }),
      ),
    ).not.toThrow();
    const p = ps.snapshot().positions.get(positionKey(SID, V, SYM));
    expect(p?.signedQty.toFixed()).toBe('0.00102');
    expect(p?.avgEntry.toFixed()).toBe('63999.255940594059405941'); // unchanged on partial reduce
    // (64200 − 63999.255940594059405941) × 0.001 = 0.200744059405940594059 — 21 dp, exact, raw.
    expect(p?.realizedPnl.toFixed()).toBe('0.200744059405940594059');
  });

  // W2.2 — align live round-trip metrics with the promotion verdict's dust-tolerant walk
  // (round-trips.ts): sub-stepSize residue below PROMOTION_DUST_NOTIONAL never reaches exact zero,
  // so metrics must fire on the dust-close instead. Position accounting itself never changes.
  describe('dust-close round-trip metrics (W2.2)', () => {
    it('reports the round trip once when a reducing fill leaves residual notional at/below dustNotional; position retained', () => {
      const { ps } = make('5'); // PROMOTION_DUST_NOTIONAL default
      ps.applyFill(makeIntent({ side: 'BUY' }), makeFill({ qty: qty('1'), price: price('100') }));
      // Reduce to 0.0004 @ 110 → residual notional 0.044 ≤ 5: dust-close, position retained nonzero.
      const dustClose = ps.applyFill(
        makeIntent({ side: 'SELL' }),
        makeFill({ venueTradeId: 't2', qty: qty('0.9996'), price: price('110') }),
      );
      expect(dustClose.closedToFlat).toBe(false); // position accounting: never treated as flat
      expect(dustClose.roundTripClosed).toBe(true); // metrics: dust-close counts as closed
      // realizedPnl = (110 − 100) × 0.9996 = 9.996 — the existing fold's own number, no new math.
      expect(dustClose.roundTripRealizedPnl?.toFixed()).toBe('9.996');
      const p = ps.snapshot().positions.get(positionKey(SID, V, SYM));
      expect(p?.signedQty.toFixed()).toBe('0.0004'); // RETAINED, never deleted while nonzero
      expect(ps.cashBalance().toFixed()).toBe('100009.956'); // -100 + 0.9996×110 = +9.956, unchanged money math
    });

    it('does not double-count an eventual exact-zero on the same dust after it already reported', () => {
      const { ps } = make('5');
      ps.applyFill(makeIntent({ side: 'BUY' }), makeFill({ qty: qty('1'), price: price('100') }));
      const dustClose = ps.applyFill(
        makeIntent({ side: 'SELL' }),
        makeFill({ venueTradeId: 't2', qty: qty('0.9996'), price: price('110') }),
      );
      expect(dustClose.roundTripClosed).toBe(true);
      // The leftover 0.0004 later gets swept to exact zero — must NOT fire a second metric.
      const exactClose = ps.applyFill(
        makeIntent({ side: 'SELL' }),
        makeFill({ venueTradeId: 't3', qty: qty('0.0004'), price: price('120') }),
      );
      expect(exactClose.closedToFlat).toBe(true);
      expect(exactClose.roundTripClosed).toBe(false); // already reported this epoch — suppressed
      expect(exactClose.roundTripRealizedPnl).toBeNull();
      expect(ps.snapshot().positions.size).toBe(0); // position deletion on exact-zero is unaffected
    });

    it('re-arms the dust-report epoch once the position re-enters (grows back above dustNotional)', () => {
      const { ps } = make('5');
      ps.applyFill(makeIntent({ side: 'BUY' }), makeFill({ qty: qty('1'), price: price('100') }));
      const firstDustClose = ps.applyFill(
        makeIntent({ side: 'SELL' }),
        makeFill({ venueTradeId: 't2', qty: qty('0.9996'), price: price('110') }),
      );
      expect(firstDustClose.roundTripClosed).toBe(true);
      // Re-enter: BUY back above the dust threshold (notional 0.9996×100 ≈ 99.96 > 5).
      const reenter = ps.applyFill(
        makeIntent({ side: 'BUY' }),
        makeFill({ venueTradeId: 't3', qty: qty('0.9996'), price: price('100') }),
      );
      expect(reenter.roundTripClosed).toBe(false); // opening fill, not a close
      // Close again down to dust: a new epoch, so the metric fires again.
      const secondDustClose = ps.applyFill(
        makeIntent({ side: 'SELL' }),
        makeFill({ venueTradeId: 't4', qty: qty('0.9996'), price: price('105') }),
      );
      expect(secondDustClose.roundTripClosed).toBe(true);
      expect(secondDustClose.roundTripRealizedPnl?.toFixed()).toBe('4.998'); // (105−100)×0.9996
    });

    it('threshold absent/0 disables dust-close reporting: only an exact-zero fold counts', () => {
      const { ps } = make(); // no dustNotional → defaults to '0'
      ps.applyFill(makeIntent({ side: 'BUY' }), makeFill({ qty: qty('1'), price: price('100') }));
      // Same reducing fill that dust-closes at threshold '5' above; with threshold 0 it must NOT
      // report — the leftover dust position is retained, unreported, exactly as pre-W2.2.
      const reduce = ps.applyFill(
        makeIntent({ side: 'SELL' }),
        makeFill({ venueTradeId: 't2', qty: qty('0.9996'), price: price('110') }),
      );
      expect(reduce.closedToFlat).toBe(false);
      expect(reduce.roundTripClosed).toBe(false);
      expect(reduce.roundTripRealizedPnl).toBeNull();
      const p = ps.snapshot().positions.get(positionKey(SID, V, SYM));
      expect(p?.signedQty.toFixed()).toBe('0.0004'); // money accounting unchanged either way
    });

    // Reviewer must-fix regression (2026-07-07): dust-close must key off an actual REDUCTION —
    // an opening/adding fill whose resulting notional is still tiny (e.g. the first partial fill
    // of a resting entry) is a position being built, never a round trip ending. Pre-fix this
    // emitted a spurious loss round trip into the metrics on every small opening fill.
    it('does not report a round trip on an opening or adding fill at/below dustNotional', () => {
      const { ps } = make('5');
      // Open from FLAT with notional 1.0 ≤ 5: no report.
      const open = ps.applyFill(
        makeIntent({ side: 'BUY' }),
        makeFill({ qty: qty('0.01'), price: price('100') }),
      );
      expect(open.closedToFlat).toBe(false);
      expect(open.roundTripClosed).toBe(false);
      expect(open.roundTripRealizedPnl).toBeNull();
      // Add another tiny partial fill (still ≤ 5 total): still building, still no report.
      const add = ps.applyFill(
        makeIntent({ side: 'BUY' }),
        makeFill({ venueTradeId: 't2', qty: qty('0.01'), price: price('100') }),
      );
      expect(add.roundTripClosed).toBe(false);
      expect(add.roundTripRealizedPnl).toBeNull();
      const p = ps.snapshot().positions.get(positionKey(SID, V, SYM));
      expect(p?.signedQty.toFixed()).toBe('0.02'); // position retained and growing
    });
  });

  // v3 §6.4: venueBalances — the per-venue wallet split PositionSizerService's venueFree(v) reads.
  describe('v3 §6.4: venueBalances (per-venue cash split)', () => {
    const V_PERP = venueId('binanceusdm');
    const SYM_PERP = symbolId('ETH/USDT:USDT');

    it('absent venueCapitalShare ⇒ venueBalances reports nothing (byte-identical to pre-split behavior)', () => {
      const { ps } = make();
      const s = ps.snapshot();
      expect(s.venueBalances?.size).toBe(0);
      // The combined fields are completely unaffected either way.
      expect(s.balances.get('USDT')?.free.toFixed()).toBe('100000');
    });

    it('seeds each venue bucket from venueCapitalShare and surfaces it as quote-asset free cash', () => {
      const { ps } = makeWithVenues(
        new Map([
          [String(V), '500'],
          [String(V_PERP), '500'],
        ]),
      );
      const s = ps.snapshot();
      expect(s.venueBalances?.get(V)?.get('USDT')?.free.toFixed()).toBe('500');
      expect(s.venueBalances?.get(V_PERP)?.get('USDT')?.free.toFixed()).toBe('500');
      // The combined book cash stays independent — startingCash ('100000'), not the venue seeds.
      expect(s.balances.get('USDT')?.free.toFixed()).toBe('100000');
    });

    it('a fill on one venue only debits/credits THAT venue bucket — the other venue is untouched', () => {
      const { ps } = makeWithVenues(
        new Map([
          [String(V), '500'],
          [String(V_PERP), '500'],
        ]),
      );
      ps.applyFill(
        makeIntent({ venue: V, side: 'BUY' }),
        makeFill({ venue: V, qty: qty('1'), price: price('100') }),
      );
      const s = ps.snapshot();
      // V spent $100 quote cash on the BUY; V_PERP's seed is untouched.
      expect(s.venueBalances?.get(V)?.get('USDT')?.free.toFixed()).toBe('400');
      expect(s.venueBalances?.get(V_PERP)?.get('USDT')?.free.toFixed()).toBe('500');
    });

    it('positions attribute base-asset holdings into their OWN venue bucket, not the other venue', () => {
      const { ps } = makeWithVenues(
        new Map([
          [String(V), '500'],
          [String(V_PERP), '500'],
        ]),
      );
      ps.applyFill(
        makeIntent({ venue: V, symbol: SYM, side: 'BUY' }),
        makeFill({ venue: V, symbol: SYM, qty: qty('1'), price: price('100') }),
      );
      ps.applyFill(
        makeIntent({ venue: V_PERP, symbol: SYM_PERP, side: 'BUY' }),
        makeFill({ venue: V_PERP, symbol: SYM_PERP, qty: qty('2'), price: price('50') }),
      );
      const s = ps.snapshot();
      expect(s.venueBalances?.get(V)?.get('BTC')?.free.toFixed()).toBe('1');
      expect(s.venueBalances?.get(V)?.get('ETH')).toBeUndefined(); // ETH position lives on V_PERP
      expect(s.venueBalances?.get(V_PERP)?.get('ETH')?.free.toFixed()).toBe('2');
      expect(s.venueBalances?.get(V_PERP)?.get('BTC')).toBeUndefined();
    });

    it('a fill on a venue absent from venueCapitalShare still balances (lazily opened at 0)', () => {
      const { ps } = makeWithVenues(new Map([[String(V), '500']])); // V_PERP never seeded
      ps.applyFill(
        makeIntent({ venue: V_PERP, symbol: SYM_PERP, side: 'BUY' }),
        makeFill({ venue: V_PERP, symbol: SYM_PERP, qty: qty('1'), price: price('50') }),
      );
      const s = ps.snapshot();
      // Opened at 0, then debited $50 ⇒ −50 (an unlisted venue is never silently dropped).
      expect(s.venueBalances?.get(V_PERP)?.get('USDT')?.free.toFixed()).toBe('-50');
      expect(s.venueBalances?.get(V)?.get('USDT')?.free.toFixed()).toBe('500'); // unaffected
    });

    it('a RESTORED position on a venue absent from venueCapitalShare lands in no bucket at all', () => {
      // restoreFromSnapshot deliberately does NOT restore cashByVenue (its own comment): a reboot
      // re-seeds the split from PortfolioConfig, so a snapshot position on a venue the config no
      // longer lists has no bucket to attribute into. The holding must be DROPPED from the split
      // rather than invented onto some other venue — the sizer's venueFree(v) read would otherwise
      // clamp against a phantom holding on a venue that never held it.
      const { ps } = makeWithVenues(new Map([[String(V), '500']])); // V_PERP never seeded
      ps.restoreFromSnapshot({
        cash: new Decimal('100000'),
        equity: new Decimal('100000'),
        peak: new Decimal('100000'),
        sodEquity: new Decimal('100000'),
        positions: [
          {
            strategyId: SID,
            venue: V_PERP,
            symbol: SYM_PERP,
            signedQty: new Decimal('2'),
            avgEntry: price('50'),
            realizedPnl: new Decimal('0'),
          },
        ],
      });
      const s = ps.snapshot();
      expect(s.venueBalances?.size).toBe(1); // only the configured venue has a bucket
      expect(s.venueBalances?.get(V_PERP)).toBeUndefined(); // none invented for the unlisted venue
      expect(s.venueBalances?.get(V)?.get('ETH')).toBeUndefined(); // and never misattributed to V
      expect(s.venueBalances?.get(V)?.get('USDT')?.free.toFixed()).toBe('500'); // seed untouched
      // The one-book truth still sees the restored holding — only the per-venue split drops it.
      expect(s.balances.get('ETH')?.free.toFixed()).toBe('2');
    });
  });
});
