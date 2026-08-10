import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  walkRoundTrips,
  openCycleOpenedAt,
  sumFeesQuote,
  type RoundTripFill,
} from '../../../src/domain/trading/risk/round-trips';

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

  // BEHAVIOUR CHANGED 2026-07-27. These two cases previously asserted that a sub-dust fill mints a
  // whole round trip on its own — a stray 0.01 SELL booking +1 of realized PnL, a stray 0.01 BUY
  // booking −1 (i.e. −100% of its own notional). That is the phantom-trip defect, written down as
  // expected behaviour: it fires while a position is still BUILDING, so a multi-fill order whose
  // first fill lands under the dust floor closes a trip with cost and no proceeds. Observed live on
  // BCH/USDT:USDT (first fill 0.022 @ 218.49 = $4.81 against a $5 floor). The dust rule now requires
  // the cycle to have actually held a position of at least dustNotional before it may close one.
  it('does not mint a round trip from a stray sub-dust SELL that never opened a position', () => {
    const { cycles } = walkRoundTrips(
      [fill({ side: 'SELL', qty: '0.01', price: '100', executedAt: 7 })],
      DUST,
    );
    // Stays open: real inventory, not a completed trip. It joins the next cycle for this group
    // rather than inflating the promotion gate's trip count with a phantom.
    expect(cycles).toHaveLength(0);
  });

  it('does not mint a round trip from a stray sub-dust BUY that never opened a position', () => {
    const { cycles } = walkRoundTrips([fill({ qty: '0.01', price: '100', executedAt: 8 })], DUST);
    expect(cycles).toHaveLength(0);
  });

  it('folds a multi-fill entry whose FIRST fill is sub-dust into ONE cycle (BCH regression)', () => {
    // The live shape: 0.022 @ 218.49 = $4.81 < $5 opens the order, seven more fills build to 0.365,
    // then the exit closes it. Pre-fix this walked as TWO cycles — a −10,004 bps phantom at fill 1
    // plus a second fragment matching 0.343 bought against 0.365 sold.
    const { cycles } = walkRoundTrips(
      [
        fill({ symbol: 'BCH/USDT:USDT', qty: '0.022', price: '218.49', executedAt: 1 }),
        fill({ symbol: 'BCH/USDT:USDT', qty: '0.343', price: '218.49', executedAt: 2 }),
        fill({
          symbol: 'BCH/USDT:USDT',
          side: 'SELL',
          qty: '0.365',
          price: '215.31',
          executedAt: 3,
        }),
      ],
      DUST,
    );
    expect(cycles).toHaveLength(1);
    const c = cycles[0]!;
    expect(c.boughtQty.toFixed()).toBe('0.365');
    expect(c.soldQty.toFixed()).toBe('0.365');
    // 0.365 × (215.31 − 218.49) = −1.1607 — the true round-trip loss, not the −7.3 the split booked.
    expect(c.realizedPnl.toFixed(4)).toBe('-1.1607');
    expect(c.openedAt).toBe(1);
    expect(c.closedAt).toBe(3);
  });

  // The entryVwap/exitVwap null branches used to be reached by the two stray-dust cases above.
  // Under the peak-notional guard a sub-dust fill no longer closes anything, so the only way to
  // close a cycle with one side empty is a COLLAPSE in price: the dust test measures the residual at
  // the CURRENT fill's price, so a position that stays open in units can fall under the dust floor
  // in quote terms. Contrived, and deliberately kept — a token that falls ~4 orders of magnitude is
  // exactly when a one-sided cycle would be booked, and the null branches exist for it.
  it('a short whose price collapses closes with no entry VWAP (never bought)', () => {
    const { cycles } = walkRoundTrips(
      [
        fill({ side: 'SELL', qty: '1', price: '100', executedAt: 1 }), // peak notional 100 ≥ dust
        fill({ side: 'SELL', qty: '0.001', price: '0.01', executedAt: 2 }), // residual 0.01 < dust
      ],
      DUST,
    );
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.entryVwap).toBeNull();
    expect(cycles[0]!.exitVwap).not.toBeNull();
  });

  it('a long whose price collapses closes with no exit VWAP (never sold)', () => {
    const { cycles } = walkRoundTrips(
      [
        fill({ qty: '1', price: '100', executedAt: 1 }),
        fill({ qty: '0.001', price: '0.01', executedAt: 2 }),
      ],
      DUST,
    );
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.exitVwap).toBeNull();
    expect(cycles[0]!.entryVwap).not.toBeNull();
  });

  it('still dust-closes a residual once the cycle has held a real position', () => {
    // Peak notional 100 ≥ dust, so winding down to a 0.01 × 100 = 1 residual closes the trip —
    // the wind-down case the dust rule exists for is untouched by the build-up guard.
    const { cycles } = walkRoundTrips(
      [
        fill({ qty: '1', price: '100', executedAt: 1 }),
        fill({ side: 'SELL', qty: '0.99', price: '110', executedAt: 2 }),
      ],
      DUST,
    );
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.realizedPnl.toFixed()).toBe('8.9');
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

  it("treats a linear-swap BASE/QUOTE:SETTLE symbol's quote fee as convertible (settle suffix stripped)", () => {
    const { cycles, unconvertibleFeeAsset } = walkRoundTrips(
      [
        fill({
          symbol: 'BTC/USDT:USDT',
          qty: '1',
          price: '100',
          fee: '0.1',
          feeAsset: 'USDT',
          executedAt: 1,
        }),
        fill({
          symbol: 'BTC/USDT:USDT',
          side: 'SELL',
          qty: '1',
          price: '110',
          executedAt: 2,
        }),
      ],
      DUST,
    );
    expect(unconvertibleFeeAsset).toBe(false);
    expect(cycles[0]!.feesQuote.toFixed()).toBe('0.1');
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

// Backlog #149 (CLOCK half): the durable open-time source rearmExitGeometry needs — walkRoundTrips
// itself deliberately excludes the still-open trailing cycle, so this is a separate walk.
describe('domain/risk openCycleOpenedAt', () => {
  it('returns null for a group with no fills at all (flat, never traded)', () => {
    expect(openCycleOpenedAt([], DUST, 'agentic-1', 'BTC/USDT')).toBeNull();
  });

  it('returns null once every cycle in the group has closed (flat again)', () => {
    const opened = openCycleOpenedAt(
      [
        fill({ qty: '1', price: '100', executedAt: 1 }),
        fill({ side: 'SELL', qty: '1', price: '110', executedAt: 2 }),
      ],
      DUST,
      'agentic-1',
      'BTC/USDT',
    );
    expect(opened).toBeNull();
  });

  it('returns the still-open cycle openedAt for a position that never closed', () => {
    const opened = openCycleOpenedAt(
      [
        fill({ qty: '1', price: '100', executedAt: 1_000 }),
        fill({ qty: '1', price: '105', executedAt: 2_000 }), // scale-in — same open cycle
      ],
      DUST,
      'agentic-1',
      'BTC/USDT',
    );
    expect(opened).toBe(1_000); // the FIRST opening fill, not the scale-in
  });

  it('resumes tracking at the SECOND cycle once the first closes (openedAt resets)', () => {
    const opened = openCycleOpenedAt(
      [
        fill({ qty: '1', price: '100', executedAt: 1 }),
        fill({ side: 'SELL', qty: '1', price: '105', executedAt: 2 }), // cycle 1 closes
        fill({ qty: '1', price: '200', executedAt: 3 }), // cycle 2 opens — still open
      ],
      DUST,
      'agentic-1',
      'BTC/USDT',
    );
    expect(opened).toBe(3);
  });

  it('scopes to the requested (strategyId, symbol) only, ignoring other groups', () => {
    const fills = [
      fill({ strategyId: 'agentic-1', qty: '1', price: '100', executedAt: 1 }),
      fill({ strategyId: 'agentic-2', symbol: 'ETH/USDT', qty: '1', price: '10', executedAt: 2 }),
    ];
    expect(openCycleOpenedAt(fills, DUST, 'agentic-1', 'BTC/USDT')).toBe(1);
    expect(openCycleOpenedAt(fills, DUST, 'agentic-2', 'ETH/USDT')).toBe(2);
    expect(openCycleOpenedAt(fills, DUST, 'agentic-3', 'SOL/USDT')).toBeNull();
  });

  it('never phantom-closes a still-building sub-dust position (same peak-notional guard as walkRoundTrips)', () => {
    const opened = openCycleOpenedAt(
      [fill({ qty: '0.01', price: '100', executedAt: 5 })], // notional 1 < dust 5
      DUST,
      'agentic-1',
      'BTC/USDT',
    );
    expect(opened).toBe(5); // still open — never reached dustNotional, so it cannot close
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

  it("sums a linear-swap symbol's quote fee (settle suffix stripped, not dropped)", () => {
    // Pre-fix, quoteAssetOf('BTC/USDT:USDT') returned 'USDT:USDT', so a USDT perp fee fell out
    // of this sum — the cross-cycle fee total the promotion verdict subtracts for net-of-cost.
    const total = sumFeesQuote([
      fill({ symbol: 'BTC/USDT:USDT', fee: '0.5', feeAsset: 'USDT' }),
      fill({ symbol: 'BTC/USDT:USDT', fee: '0.001', feeAsset: 'BTC', price: '200' }), // 0.2
    ]);
    expect(total.toFixed()).toBe('0.7');
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
