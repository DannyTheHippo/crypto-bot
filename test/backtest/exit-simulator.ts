import Decimal from 'decimal.js';

// ── Intrabar exit simulator for the exit-attribution study ────────────────────
//
// Preregistration: research/studies/edge-verdict-2026-08-10.md.
//
// WHY THIS EXISTS RATHER THAN REUSING evaluatePlan: production's plan-executor resolves stop and
// take-profit against the bar CLOSE only (plan-executor.ts:76-78 long, :93-95 short). The deployed
// stack, however, rests VENUE-NATIVE stop and take-profit orders (AGENTIC_VENUE_STOP=true,
// AGENTIC_VENUE_TP=true), and those trigger on the wick, not the close. A close-only simulator
// systematically UNDER-counts stop hits, which is exactly the bias the study is built to measure —
// so reusing evaluatePlan here would import the error under test. `resolution: 'close'` reproduces
// production's plan-executor semantics as a sensitivity arm; `'intrabar'` models the venue orders
// and is the study's primary mode.
//
// TOY RESEARCH METRIC — same caveats as counterfactual-scoring.ts: it never certifies anything, is
// never a promotion input, and is not a money path (no Price/Qty is minted or moved). Decimal is
// used throughout regardless, so no float rounding enters a reported figure.
//
// MODELLING LIMITS, stated so results are read honestly:
//   - A stop fills AT its trigger price; slippage beyond the flat fee is not modelled. The 2026-07-13
//     stop-slippage study measured a mean total leak of +3.2 bps per exit, so this understates costs
//     by roughly that much per stopped trip.
//   - When one bar touches both the stop and the take-profit, the STOP is taken. Without intrabar
//     tick data the true ordering is unknowable, and the conservative choice must not flatter a
//     study whose whole purpose is to ask whether wider stops help.
//   - A position still open when the candle series ends returns null and is EXCLUDED, never
//     marked-to-market — the openAtEnd discipline counterfactual-scoring.ts already uses.

/** OHLCV row as stored in test/backtest/data/ohlcv-*.json: [ts, open, high, low, close, volume]. */
export type RawCandle = readonly [number, string, string, string, string, string];

export type ExitReason = 'stop' | 'take_profit' | 'max_hold';
export type Side = 'long' | 'short';
export type Resolution = 'intrabar' | 'close';

export interface ExitOutcome {
  readonly reason: ExitReason;
  /** Decimal string. Trigger price for stop/take-profit, bar close for max_hold. */
  readonly exitPrice: string;
  readonly barsHeld: number;
  /** Signed return fraction net of the round-trip fee, as a Decimal string. */
  readonly netReturn: string;
}

export interface SimulateExitInput {
  readonly side: Side;
  /** Decimal string, > 0. */
  readonly entryPrice: string;
  /** Decimal string fraction (0.02 = 2%), or null for "no stop". */
  readonly stopLossPct: string | null;
  /** Decimal string fraction, or null for "no take-profit". */
  readonly takeProfitPct: string | null;
  readonly maxHoldBars: number;
  /** Bars strictly AFTER the entry bar, in ascending time order. */
  readonly bars: readonly RawCandle[];
  readonly resolution: Resolution;
  /** Round-trip fee fraction. 0.002 = 10 bps per leg, the verified demo schedule. */
  readonly roundTripFee: string;
}

const HIGH = 2;
const LOW = 3;
const CLOSE = 4;

/**
 * Replay one entry forward under a fixed exit rule.
 *
 * Returns null when the position is still open at the end of `bars` — the caller must exclude it
 * rather than mark it to market, so that a truncated window cannot manufacture a favourable result.
 */
export function simulateExit(input: SimulateExitInput): ExitOutcome | null {
  const { side, stopLossPct, takeProfitPct, maxHoldBars, bars, resolution } = input;
  const entry = new Decimal(input.entryPrice);
  if (entry.lte(0)) throw new Error(`entryPrice must be > 0, got ${input.entryPrice}`);

  const long = side === 'long';
  // A long stops BELOW entry and takes profit ABOVE it; a short is the mirror.
  const stopPrice =
    stopLossPct === null
      ? null
      : long
        ? entry.mul(new Decimal(1).minus(stopLossPct))
        : entry.mul(new Decimal(1).plus(stopLossPct));
  const takeProfitPrice =
    takeProfitPct === null
      ? null
      : long
        ? entry.mul(new Decimal(1).plus(takeProfitPct))
        : entry.mul(new Decimal(1).minus(takeProfitPct));

  const fee = new Decimal(input.roundTripFee);
  const settle = (reason: ExitReason, exitPrice: Decimal, barsHeld: number): ExitOutcome => {
    const gross = long ? exitPrice.minus(entry).div(entry) : entry.minus(exitPrice).div(entry);
    return {
      reason,
      exitPrice: exitPrice.toString(),
      barsHeld,
      netReturn: gross.minus(fee).toString(),
    };
  };

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    const barsHeld = i + 1;
    const close = new Decimal(bar[CLOSE]);
    // Intrabar uses the wick that moves AGAINST the position for the stop and WITH it for the
    // take-profit; close mode collapses both probes onto the close (production plan-executor).
    const stopProbe = resolution === 'close' ? close : new Decimal(long ? bar[LOW] : bar[HIGH]);
    const tpProbe = resolution === 'close' ? close : new Decimal(long ? bar[HIGH] : bar[LOW]);

    const stopHit =
      stopPrice !== null && (long ? stopProbe.lte(stopPrice) : stopProbe.gte(stopPrice));
    const tpHit =
      takeProfitPrice !== null &&
      (long ? tpProbe.gte(takeProfitPrice) : tpProbe.lte(takeProfitPrice));

    // Stop wins a same-bar tie: the ordering is unknowable without tick data, and the pessimistic
    // read is the only one that cannot flatter a wider-stop hypothesis.
    if (stopHit) return settle('stop', stopPrice, barsHeld);
    if (tpHit) return settle('take_profit', takeProfitPrice, barsHeld);
    if (barsHeld >= maxHoldBars) return settle('max_hold', close, barsHeld);
  }

  return null; // still open at series end — excluded by the caller, never marked to market
}
