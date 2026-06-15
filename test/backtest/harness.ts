// Backtest harness — drives ANY real Strategy over historical candles and settles each signal
// through the REAL domain/oms position+PnL math. The only MODELLED parts are the fill price
// (next-bar OPEN — strictly no lookahead: a signal computed on bar i's close fills at bar i+1's
// open) and a flat per-side fee (default 10 bps taker — conservative; real maker is similar/lower).
// Sizing mirrors PositionSizerService: entries buy baseNotional/price rounded down to the lot step;
// exits sell the full attributed position; both are skipped below the venue minQty/minNotional
// (matching the sizer's BELOW_MINIMUM reject). No cash/leverage tracking — equity = startingCash +
// realizedPnl + mark-to-market unrealized, so returns are pure strategy PnL on a fixed base.
//
// The harness is strategy-AGNOSTIC: it takes a () => Strategy factory and NEVER reimplements signal
// logic. The EMA study and the mean-reversion study drive this same code path with byte-identical
// fill/fee/PnL machinery; only the injected strategy differs. This is the rung-3 generalization that
// lets a new edge hypothesis be vetted with the exact machinery that produced the EMA verdict.
import Decimal from 'decimal.js';
import { setupDecimal, price, qty as mkqty, roundToStep } from '../../src/domain/types/money';
import { applyFillToPosition, FLAT, type PositionState } from '../../src/domain/oms/position';
import type { CandleEvent, CandleInterval } from '../../src/domain/types/market-events';
import { venueId, symbolId, epochMs } from '../../src/domain/types/ids';
import type { MarketView, Strategy } from '../../src/domain/strategy/strategy';

setupDecimal(); // production Decimal config (precision 40, ROUND_HALF_EVEN)

// Exported so strategy factories build instances targeting the SAME venue/symbol the events carry
// (a strategy that filters on symbol — e.g. EmaCrossStrategy at strategy:65 — must match exactly).
export const BT_VENUE = venueId('binance');
export const BT_SYMBOL = symbolId('BTC/USDT');
const STUB_VIEW = {} as MarketView; // candle strategies under test ignore `view` (EMA: strategy:67)
const DUMMY_VOL = mkqty('1'); // volume is unused by the strategies and PnL math

export type Bar = number[]; // ccxt OHLCV: [ts, open, high, low, close, volume]

export interface Prepared {
  readonly events: readonly CandleEvent[];
  readonly opens: readonly Decimal[];
  readonly closes: readonly Decimal[];
}

const px8 = (n: number) => price(new Decimal(n).toDecimalPlaces(8)); // guard float-repr artifacts; venue data is <=8dp

// Mint candle events + open/close Decimals ONCE per dataset so a param sweep doesn't re-mint.
export function prepare(bars: readonly Bar[], interval: CandleInterval): Prepared {
  const events: CandleEvent[] = [];
  const opens: Decimal[] = [];
  const closes: Decimal[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const open = new Decimal(b[1]).toDecimalPlaces(8);
    const close = new Decimal(b[4]).toDecimalPlaces(8);
    opens.push(open);
    closes.push(close);
    events.push({
      kind: 'CANDLE', venue: BT_VENUE, symbol: BT_SYMBOL, channel: `candles:${interval}`, seq: BigInt(i + 1),
      eventTime: epochMs(b[0]), ingestTime: epochMs(b[0]), interval,
      openTime: epochMs(b[0]), closeTime: epochMs(b[0] + 1),
      open: price(open), high: px8(b[2]), low: px8(b[3]), close: price(close), volume: DUMMY_VOL, closed: true,
    });
  }
  return { events, opens, closes };
}

export function slice(p: Prepared, from: number, to: number): Prepared {
  return { events: p.events.slice(from, to), opens: p.opens.slice(from, to), closes: p.closes.slice(from, to) };
}

export interface BtOpts {
  readonly startingCash?: number;
  readonly baseNotional?: number;
  readonly feeBps?: number;
  readonly stepSize?: string;
  readonly minQty?: string;
  readonly minNotional?: string;
}
export interface BtResult {
  readonly bars: number;
  readonly trades: number; // completed round-trips (full exits)
  readonly fills: number;
  readonly pnl: number; // realized + final mark-to-market unrealized, USDT
  readonly returnPct: number; // pnl / startingCash * 100
  readonly winRate: number; // fraction of round-trips with positive net PnL
  readonly feesPaid: number;
  readonly maxDrawdownPct: number;
  readonly finalEquity: number;
  readonly buyHoldPct: number; // close[last]/close[0] - 1, for regime context
}

// Drives `makeStrategy()` over `prep`. The factory builds a FRESH strategy per call (no state leak
// across IS/OOS splits or grid points). The harness owns lifecycle (onInit), fills, fees, sizing,
// and PnL — exactly as for the EMA study, so the only variable across studies is the strategy.
export function runBacktest(prep: Prepared, makeStrategy: () => Strategy, opts: BtOpts = {}): BtResult {
  const { events, opens, closes } = prep;
  const startingCash = opts.startingCash ?? 5000;
  const baseNotional = new Decimal(opts.baseNotional ?? 1000);
  const feeRate = new Decimal(opts.feeBps ?? 10).div(10_000);
  const stepSize = opts.stepSize ?? '0.00001';
  const minQty = new Decimal(opts.minQty ?? '0.00001');
  const minNotional = new Decimal(opts.minNotional ?? '5');

  const strat = makeStrategy();
  strat.onInit({ params: {}, warmupCandles: new Map(), symbolConstraints: new Map() });

  let pos: PositionState = FLAT;
  let feesPaid = new Decimal(0);
  let prevRealized = new Decimal(0);
  let wins = 0;
  let roundTrips = 0;
  let fills = 0;
  let peak = startingCash;
  let maxDd = 0;

  for (let i = 0; i < events.length; i++) {
    const signals = strat.onCandle(events[i], STUB_VIEW);
    for (const s of signals) {
      const fillPrice = opens[i + 1]; // next-bar open; undefined at the last bar => no fill (no lookahead, no boundary cross)
      if (fillPrice === undefined) continue;
      const side: 'BUY' | 'SELL' = s.kind === 'ENTER_LONG' ? 'BUY' : 'SELL';
      const rawQty = side === 'BUY' ? baseNotional.div(fillPrice) : pos.signedQty.abs();
      const q = roundToStep(rawQty, stepSize, 'down');
      if (q.lte(0)) continue; // exit with no position (NO_POSITION) or rounds to zero
      if (q.lt(minQty) || q.mul(fillPrice).lt(minNotional)) continue; // sizer BELOW_MINIMUM
      const feeQuote = fillPrice.mul(q).mul(feeRate);
      feesPaid = feesPaid.add(feeQuote);
      pos = applyFillToPosition(pos, side, q, fillPrice, feeQuote);
      fills++;
      if (side === 'SELL') {
        const delta = pos.realizedPnl.sub(prevRealized); // this round-trip's net PnL (both legs' fees included)
        roundTrips++;
        if (delta.gt(0)) wins++;
        prevRealized = pos.realizedPnl;
      }
    }
    const unreal = pos.signedQty.mul(closes[i].sub(pos.avgEntry));
    const equity = startingCash + pos.realizedPnl.add(unreal).toNumber();
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  const lastClose = closes[closes.length - 1];
  const pnl = pos.realizedPnl.add(pos.signedQty.mul(lastClose.sub(pos.avgEntry)));
  const buyHold = closes.length > 1 ? lastClose.div(closes[0]).sub(1).mul(100).toNumber() : 0;
  return {
    bars: events.length, trades: roundTrips, fills,
    pnl: pnl.toNumber(), returnPct: pnl.div(startingCash).mul(100).toNumber(),
    winRate: roundTrips > 0 ? wins / roundTrips : 0,
    feesPaid: feesPaid.toNumber(), maxDrawdownPct: maxDd * 100,
    finalEquity: startingCash + pnl.toNumber(), buyHoldPct: buyHold,
  };
}
