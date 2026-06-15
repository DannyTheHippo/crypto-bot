// Fill models — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// The taker harness fills every signal at the next-bar OPEN. A market-making strategy instead posts a
// RESTING LIMIT and only trades when the market comes to it — capturing (at best) the bid-ask spread
// but never paying it. This module adds a MAKER_RESTING model so the maker economics can be measured
// against the same production PnL math (applyFillToPosition) the taker harness uses.
//
// IMPORTANT (Binance spot VIP0): there is NO maker rebate — maker fee ≈ taker fee (~7.5-10 bps). The
// only maker edge is the spread (~1 bp on BTC/USDT), far below the ~15-20 bps round-trip fee. So the
// expected output of this model is a DOCUMENTED REJECTION. The heuristic is deliberately OPTIMISTIC
// about fills (any bar whose range touches the limit fills the whole order at the limit, ignoring queue
// position and partial fills) so that a negative verdict is robust: if even an over-generous maker
// model loses, a realistic one loses worse.
import Decimal from 'decimal.js';
import { applyFillToPosition, FLAT, type PositionState } from '../../src/domain/oms/position';
import { roundToStep } from '../../src/domain/types/money';
import type { Prepared, BtOpts, BtResult } from './harness';
import type { Strategy, MarketView } from '../../src/domain/strategy/strategy';

const STUB_VIEW = {} as MarketView;

export type FillModelKind = 'TAKER_NEXT_OPEN' | 'MAKER_RESTING';
export type Side = 'BUY' | 'SELL';

export interface MakerParams {
  // Passive offset from the signal-bar close: BUY rests BELOW (close·(1−off)), SELL rests ABOVE
  // (close·(1+off)). 0 = at the touch. Larger = deeper in the book = better price but lower fill odds.
  readonly limitOffsetBps: number;
  // Bars a resting order may wait before it is cancelled unfilled. Decoupled from the 30 s signal ttl
  // (a resting maker order lives on the book across many candles, not 30 s).
  readonly maxRestBars: number;
}

export interface RestingOrder {
  readonly side: Side;
  readonly limit: Decimal;
  readonly placedBar: number;
}

// BUY rests below the close, SELL above — the passive (maker) side of the spread.
export function makerLimitPrice(side: Side, close: Decimal, offsetBps: number): Decimal {
  const off = new Decimal(offsetBps).div(10_000);
  return side === 'BUY' ? close.mul(new Decimal(1).sub(off)) : close.mul(new Decimal(1).add(off));
}

// A resting BUY fills when a bar trades down to/through its limit (low ≤ limit); a SELL when a bar
// trades up to/through it (high ≥ limit). Optimistic: ignores queue priority and assumes a full fill.
export function restingFills(order: RestingOrder, high: Decimal, low: Decimal): boolean {
  return order.side === 'BUY' ? low.lte(order.limit) : high.gte(order.limit);
}

// Single-resting-order book (long-only alternating strategies place at most one order at a time).
export class MakerBook {
  private pending: RestingOrder | null = null;
  constructor(private readonly maxRestBars: number) {}

  get hasPending(): boolean {
    return this.pending !== null;
  }
  get pendingSide(): Side | null {
    return this.pending?.side ?? null;
  }
  place(side: Side, limit: Decimal, bar: number): void {
    this.pending = { side, limit, placedBar: bar };
  }
  cancel(): void {
    this.pending = null;
  }
  // Advance to `bar` (> placedBar): fill if the bar range crosses the limit; else expire if stale; else
  // keep resting. A fill returns the limit price (maker trades AT its limit, no slippage).
  step(
    bar: number,
    high: Decimal,
    low: Decimal,
  ): { kind: 'fill'; side: Side; price: Decimal } | { kind: 'expired'; side: Side } | null {
    const o = this.pending;
    if (!o) return null;
    if (bar <= o.placedBar) return null; // the placing bar's close already passed — fills start next bar
    if (restingFills(o, high, low)) {
      this.pending = null;
      return { kind: 'fill', side: o.side, price: o.limit };
    }
    if (bar - o.placedBar >= this.maxRestBars) {
      this.pending = null;
      return { kind: 'expired', side: o.side };
    }
    return null;
  }
}

export interface MakerBtResult extends BtResult {
  readonly makerFills: number; // resting orders that filled
  readonly takerFills: number; // always 0 in pure maker mode (kept for symmetry/diagnostics)
  readonly expiredEntries: number; // BUY orders cancelled unfilled (missed entries)
  readonly unfilledExits: number; // SELL orders cancelled while still holding (stuck-long risk)
  readonly fillRate: number; // makerFills / (makerFills + expiredEntries + unfilledExits)
}

// Maker backtest: same sizing / fee / position / equity machinery as the taker harness, but signals
// post resting limit orders that fill only when the market touches them (or expire). Fee defaults to
// the TAKER bps (no VIP0 rebate); pass a separate maker bps via opts.feeBps only if a rebate tier is
// being modelled explicitly.
export function runMakerBacktest(
  prep: Prepared,
  makeStrategy: () => Strategy,
  opts: BtOpts & { maker: MakerParams },
): MakerBtResult {
  const { events, opens, closes } = prep;
  void opens; // maker fills at the limit price, not the next open
  const startingCash = opts.startingCash ?? 5000;
  const baseNotional = new Decimal(opts.baseNotional ?? 1000);
  const feeRate = new Decimal(opts.feeBps ?? 10).div(10_000);
  const stepSize = opts.stepSize ?? '0.00001';
  const minQty = new Decimal(opts.minQty ?? '0.00001');
  const minNotional = new Decimal(opts.minNotional ?? '5');
  const recordSeries = opts.recordSeries ?? false;

  const strat = makeStrategy();
  strat.onInit({ params: {}, warmupCandles: new Map(), symbolConstraints: new Map() });

  const book = new MakerBook(opts.maker.maxRestBars);

  let pos: PositionState = FLAT;
  let feesPaid = new Decimal(0);
  let prevRealized = new Decimal(0);
  let wins = 0;
  let roundTrips = 0;
  let fills = 0;
  let makerFills = 0;
  let expiredEntries = 0;
  let unfilledExits = 0;
  let peak = startingCash;
  let maxDd = 0;
  const tradePnls: number[] = [];
  const tradeReturns: number[] = [];
  const equityCurve: number[] = [];
  let entryNotional = new Decimal(0);

  const applyFill = (side: Side, price: Decimal): void => {
    const rawQty = side === 'BUY' ? baseNotional.div(price) : pos.signedQty.abs();
    const q = roundToStep(rawQty, stepSize, 'down');
    if (q.lte(0)) return; // exit with no position, or rounds to zero
    if (q.lt(minQty) || q.mul(price).lt(minNotional)) return; // sizer BELOW_MINIMUM
    const feeQuote = price.mul(q).mul(feeRate);
    feesPaid = feesPaid.add(feeQuote);
    pos = applyFillToPosition(pos, side, q, price, feeQuote);
    fills++;
    makerFills++;
    if (side === 'BUY') {
      entryNotional = price.mul(q);
    } else {
      const delta = pos.realizedPnl.sub(prevRealized);
      roundTrips++;
      if (delta.gt(0)) wins++;
      prevRealized = pos.realizedPnl;
      if (recordSeries) {
        tradePnls.push(delta.toNumber());
        tradeReturns.push(entryNotional.gt(0) ? delta.div(entryNotional).toNumber() : 0);
      }
    }
  };

  for (let i = 0; i < events.length; i++) {
    // 1. Resolve any resting order against this bar's range (orders placed on earlier bars only).
    // events[i].high/low are Price (= Decimal & brand), structurally assignable to Decimal.
    const ev = book.step(i, events[i].high, events[i].low);
    if (ev?.kind === 'fill') {
      applyFill(ev.side, ev.price);
    } else if (ev?.kind === 'expired') {
      if (ev.side === 'SELL' && !pos.signedQty.isZero()) unfilledExits++;
      else if (ev.side === 'BUY') expiredEntries++;
    }

    // 2. New signals → (re)post resting limit orders.
    const signals = strat.onCandle(events[i], STUB_VIEW);
    for (const s of signals) {
      const side: Side = s.kind === 'ENTER_LONG' ? 'BUY' : 'SELL';
      if (book.hasPending && book.pendingSide !== side) book.cancel(); // CANCEL_OPEN on opposing signal
      const limit = makerLimitPrice(side, closes[i], opts.maker.limitOffsetBps);
      book.place(side, limit, i);
    }

    const unreal = pos.signedQty.mul(closes[i].sub(pos.avgEntry));
    const equity = startingCash + pos.realizedPnl.add(unreal).toNumber();
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDd) maxDd = dd;
    if (recordSeries) equityCurve.push(equity);
  }

  const lastClose = closes[closes.length - 1];
  const pnl = pos.realizedPnl.add(pos.signedQty.mul(lastClose.sub(pos.avgEntry)));
  const buyHold = closes.length > 1 ? lastClose.div(closes[0]).sub(1).mul(100).toNumber() : 0;
  const expiredTotal = expiredEntries + unfilledExits;
  return {
    bars: events.length,
    trades: roundTrips,
    fills,
    pnl: pnl.toNumber(),
    returnPct: pnl.div(startingCash).mul(100).toNumber(),
    winRate: roundTrips > 0 ? wins / roundTrips : 0,
    feesPaid: feesPaid.toNumber(),
    maxDrawdownPct: maxDd * 100,
    finalEquity: startingCash + pnl.toNumber(),
    buyHoldPct: buyHold,
    makerFills,
    takerFills: 0,
    expiredEntries,
    unfilledExits,
    fillRate: makerFills + expiredTotal > 0 ? makerFills / (makerFills + expiredTotal) : 0,
    ...(recordSeries ? { tradePnls, tradeReturns, equityCurve } : {}),
  };
}
