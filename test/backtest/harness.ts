// Backtest harness — drives any BarStrategy (test/backtest/strategy.ts) over historical OHLCV bars
// and settles every fill through the REAL domain PnL machinery: applyFillToPosition
// (src/domain/oms/position.ts, signed/short-capable) for per-fill position accounting and
// walkRoundTrips (src/domain/risk/round-trips.ts) for closed-cycle extraction — the SAME functions
// production reconciliation and the promotion-readiness verdict use, so a backtest verdict is
// evidence about the real settlement math, not a parallel reimplementation of it.
//
// Fills happen at the NEXT bar's open — strictly no lookahead: an action decided from bar i's context
// (closes up to and including i) fills at bar i+1's open. There is no fill on the last bar (nextOpen
// is null). Fees + adverse haircut are modelled by fill-models.ts; funding (perpetual carry) by
// funding.ts, applied at the bars the caller's funding schedule names.
//
// The strategy interface is BarContext→BacktestAction (enter/exit/hold) — the harness owns lifecycle,
// sizing, fills, fees, funding, and PnL. Every BarStrategy implementation (RuleStrategy,
// RecordedAgenticStrategy, LiveAgenticStrategy) shares this one settlement path.
import Decimal from 'decimal.js';
import { setupDecimal, roundToStep } from '../../src/domain/types/money';
import { applyFillToPosition, FLAT, type PositionState } from '../../src/domain/oms/position';
import {
  walkRoundTrips,
  type RoundTripFill,
  type ClosedRoundTrip,
} from '../../src/domain/risk/round-trips';
import { sharpeStats, type SharpeStats } from './stats';
import {
  effectiveFillPrice,
  takerFeeQuote,
  DEFAULT_FILL_CONFIG,
  type FillConfig,
} from './fill-models';
import { fundingPayment } from './funding';
import type { BarStrategy, BacktestAction, BarContext } from './strategy';

setupDecimal(); // production Decimal config (precision 40, ROUND_HALF_EVEN)

export type Bar = number[]; // ccxt OHLCV: [ts, open, high, low, close, volume]

export interface FundingEvent {
  readonly barIndex: number; // funding applies against the position held at this bar's close (mark)
  readonly rate: string; // decimal string, e.g. '0.0001'
}

export interface BacktestOpts {
  readonly startingCash?: string;
  readonly baseNotional?: string; // used when an 'enter' action carries no sizeHint
  readonly stepSize?: string;
  readonly minQty?: string;
  readonly minNotional?: string;
  readonly fill?: FillConfig;
  readonly funding?: readonly FundingEvent[];
  readonly symbol?: string; // walkRoundTrips grouping key (informational — single-strategy runs only)
  readonly strategyLabel?: string;
  readonly dustNotional?: string; // residual notional below which a cycle is considered closed
}

export interface BacktestResult {
  readonly bars: number;
  readonly equityCurve: readonly string[]; // startingCash + realizedPnl + unrealized, per bar close
  readonly closedRoundTrips: readonly ClosedRoundTrip[];
  readonly fundingPaid: string; // net funding paid over the run (negative = net received)
  readonly finalEquity: string;
  readonly stats: SharpeStats; // per-round-trip return stats (walkRoundTrips-derived)
}

export function runBacktest(
  bars: readonly Bar[],
  makeStrategy: () => BarStrategy,
  opts: BacktestOpts = {},
): BacktestResult {
  const startingCash = new Decimal(opts.startingCash ?? '5000');
  const baseNotional = new Decimal(opts.baseNotional ?? '1000');
  const stepSize = opts.stepSize ?? '0.00001';
  const minQty = new Decimal(opts.minQty ?? '0.00001');
  const minNotional = new Decimal(opts.minNotional ?? '5');
  const fillCfg = opts.fill ?? DEFAULT_FILL_CONFIG;
  const feeBps = new Decimal(fillCfg.takerFeeBps);
  const haircutBps = new Decimal(fillCfg.adverseHaircutBps);
  const symbol = opts.symbol ?? 'BT/USDT';
  const strategyLabel = opts.strategyLabel ?? 'bt';
  const dustNotional = new Decimal(opts.dustNotional ?? '0.01');

  const fundingByBar = new Map<number, Decimal>();
  for (const f of opts.funding ?? []) fundingByBar.set(f.barIndex, new Decimal(f.rate));

  const opens = bars.map((b) => new Decimal(b[1]!));
  const closes = bars.map((b) => new Decimal(b[4]!));

  const strat = makeStrategy();

  let pos: PositionState = FLAT;
  let fundingPaid = new Decimal(0);
  const equityCurve: string[] = [];
  const fills: RoundTripFill[] = [];
  // The SAME array is pushed into and handed to every decide() call (see strategy.ts's BarContext
  // doc) — O(1) amortized per bar rather than an O(n) slice/copy, which matters at 30k-bar 1m series.
  const closeStrs: string[] = [];

  for (let i = 0; i < bars.length; i++) {
    closeStrs.push(closes[i]!.toFixed());
    const nextOpen = i + 1 < bars.length ? opens[i + 1]! : null;
    const fundingRate = fundingByBar.get(i) ?? null;

    const ctx: BarContext = {
      closes: closeStrs,
      nextOpen: nextOpen ? nextOpen.toFixed() : null,
      markPrice: closes[i]!.toFixed(),
      fundingRate: fundingRate ? fundingRate.toFixed() : null,
      position: pos,
      barIndex: i,
    };
    const action: BacktestAction = strat.decide(ctx);

    const isNoOpExit = action.type === 'exit' && pos.signedQty.isZero();
    if (action.type !== 'hold' && nextOpen !== null && !isNoOpExit) {
      const side: 'BUY' | 'SELL' =
        action.type === 'enter'
          ? action.side === 'LONG'
            ? 'BUY'
            : 'SELL'
          : pos.signedQty.gt(0)
            ? 'SELL'
            : 'BUY';
      const isOpen = action.type === 'enter';
      const rawQty = isOpen
        ? new Decimal(action.sizeHint ?? baseNotional.toFixed()).div(nextOpen)
        : pos.signedQty.abs();
      const q = roundToStep(rawQty, stepSize, 'down');
      if (q.gt(0) && !(q.lt(minQty) || q.mul(nextOpen).lt(minNotional))) {
        const fillPrice = effectiveFillPrice(side, nextOpen, haircutBps);
        const feeQuote = takerFeeQuote(fillPrice, q, feeBps);
        pos = applyFillToPosition(pos, side, q, fillPrice, feeQuote);
        fills.push({
          strategyId: strategyLabel,
          symbol,
          side,
          qty: q.toFixed(),
          price: fillPrice.toFixed(),
          fee: feeQuote.toFixed(),
          feeAsset: symbol.split('/')[1] ?? 'USDT',
          executedAt: bars[i + 1]![0]!, // fills at next bar's open time
        });
      }
    }

    // Funding settles against the position held at this bar's mark, after any fill this bar.
    if (fundingRate !== null && !pos.signedQty.isZero()) {
      const payment = fundingPayment(pos.signedQty, closes[i]!, fundingRate);
      fundingPaid = fundingPaid.add(payment);
      pos = { ...pos, realizedPnl: pos.realizedPnl.add(payment) };
    }

    const unreal = pos.signedQty.mul(closes[i]!.sub(pos.avgEntry));
    equityCurve.push(startingCash.add(pos.realizedPnl).add(unreal).toFixed());
  }

  const { cycles } = walkRoundTrips(fills, dustNotional);
  const tradeReturns = cycles.map((c) => {
    const denom = c.entryVwap !== null && c.boughtQty.gt(0) ? c.entryVwap.mul(c.boughtQty) : null;
    return denom !== null && denom.gt(0) ? c.realizedPnl.div(denom).toNumber() : 0;
  });

  const finalEquity =
    equityCurve.length > 0 ? equityCurve[equityCurve.length - 1]! : startingCash.toFixed();

  return {
    bars: bars.length,
    equityCurve,
    closedRoundTrips: cycles,
    fundingPaid: fundingPaid.toFixed(),
    finalEquity,
    stats: sharpeStats(tradeReturns),
  };
}

// Default cv.ts / walk-forward.ts ScoreFn: runs the full lead-in+OOS slice through runBacktest, then
// baselines the OOS-only equity at series.oosStart (excluding the lead-in's PnL) — the same boundary
// derivation the pre-rebuild cv.ts/walk-forward.ts computed inline against their equityCurve. Returns
// startingCash + (oosEndEquity − oosStartEquity) so the result is directly comparable to opts's
// startingCash for a positive/negative fold verdict.
export function makeScorer(
  opts: BacktestOpts = {},
): (
  strategy: BarStrategy,
  series: { readonly bars: readonly Bar[]; readonly oosStart: number },
) => string {
  const startingCash = new Decimal(opts.startingCash ?? '5000');
  return (strategy, series) => {
    const result = runBacktest(series.bars, () => strategy, opts);
    const before =
      series.oosStart > 0
        ? new Decimal(result.equityCurve[series.oosStart - 1] ?? startingCash.toFixed())
        : startingCash;
    const after =
      result.equityCurve.length > 0
        ? new Decimal(result.equityCurve[result.equityCurve.length - 1]!)
        : before;
    return startingCash.add(after.sub(before)).toFixed();
  };
}
