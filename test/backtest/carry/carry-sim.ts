// Delta-neutral funding-carry simulator — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// Task S2 (reports/loop/state.md): the funding-carry offline study is a GO/NO-GO gate for the whole
// carry build. The position modelled is ONE synthetic delta-neutral unit (long spot + short equal-
// notional perp) of notional N — spot leg cancels price risk by construction, so only the funding leg
// carries PnL here. N = 1 throughout; every return below is per-unit-notional.
//
// STATE MACHINE (evaluated only at funding timestamps, the 8h grid):
//   OFF -> ON  when the trailing-L-interval mean funding rate, annualized (mean_per_8h_rate x 3 x 365),
//              is >= H.
//   ON  -> OFF when the exit rule fires:
//              'flip'  — trailing-1d (3-interval) mean funding rate <= 0.
//              'decay' — trailing-1d mean funding rate, annualized, < H/2.
// Both trailing means are computed over the L (or 3) rates STRICTLY BEFORE the decision timestamp —
// the rate settling AT the decision timestamp is never used for the transition decision (no lookahead).
//
// ACCRUAL TIMING (a documented choice, not specified verbatim by the task): transitions are resolved
// first each timestamp, then accrual runs against the POST-transition state at that same timestamp.
// Concretely: entering ON at t_i immediately captures t_i's funding settlement; exiting to OFF at t_i
// does NOT capture t_i's settlement (the position is already flat as of t_i). This is symmetric — one
// extra interval captured on entry, one fewer on exit — and roughly self-offsetting over many episodes
// (see the report's caveats for the honest framing: entry-side inclusion is mildly optimistic per
// episode, partially offset by exit-side exclusion).
//
// COSTS: 0.12% x N charged at entry and 0.12% x N charged at exit (0.24% round trip, both legs, taker
// + slippage haircut, per the task spec — not fill-models.ts's DEFAULT_FILL_CONFIG, which prices a
// different instrument/venue assumption).
//
// An ENTRY -> EXIT pair is one EPISODE. A position still ON at the end of the data window (no matching
// exit) is NOT a closed episode and is dropped — mirrors walkRoundTrips' closed-cycles-only convention
// (src/domain/trading/risk/round-trips.ts) used everywhere else in this backtest spine.
import Decimal from 'decimal.js';
import { fundingPayment } from '../funding';

export interface FundingRow {
  readonly timestamp: number;
  readonly fundingRate: string;
}

export type Bar = readonly number[]; // ccxt OHLCV: [ts, open, high, low, close, volume]

export type ExitRule = 'flip' | 'decay';

export interface CarryCellParams {
  readonly entryLookback: number; // L, in funding intervals (9 | 21 | 42 => 3d | 7d | 14d)
  readonly entryThresholdAnnualized: number; // H, e.g. 0.05 for 5% annualized
  readonly exitRule: ExitRule;
}

export interface CarryEpisode {
  readonly entryIndex: number;
  readonly entryTimestamp: number;
  readonly exitIndex: number;
  readonly exitTimestamp: number;
  readonly intervalsHeld: number; // funding settlements captured while ON
  readonly accruedFunding: number; // sum of per-interval funding payments, N=1
  readonly netReturn: number; // (accruedFunding - entryCost - exitCost) / N, N=1
  readonly netReturnBasisLow: number; // netReturn - 2bps robustness band
  readonly netReturnBasisHigh: number; // netReturn + 2bps robustness band
}

export const ENTRY_COST_FRACTION = 0.0012;
export const EXIT_COST_FRACTION = 0.0012;
export const EXIT_LOOKBACK_INTERVALS = 3; // 1 day = 3 x 8h funding intervals — fixed regardless of L
export const ANNUALIZATION_FACTOR = 3 * 365; // 8h-interval mean rate -> annualized
const BASIS_SENSITIVITY = 0.0002; // +/- 2bps

// Mean of rates[endExclusive - window .. endExclusive - 1]; null if not enough trailing history.
function trailingMean(
  rates: readonly number[],
  endExclusive: number,
  window: number,
): number | null {
  const start = endExclusive - window;
  if (start < 0) return null;
  let sum = 0;
  for (let i = start; i < endExclusive; i++) sum += rates[i]!;
  return sum / window;
}

export function simulateCarry(
  funding: readonly FundingRow[],
  ohlcv: readonly Bar[],
  params: CarryCellParams,
): CarryEpisode[] {
  const rates = funding.map((f) => Number(f.fundingRate));
  const episodes: CarryEpisode[] = [];

  // Both series are chronological; the mark cursor only ever advances (monotonic in ts across calls).
  let barCursor = 0;
  const markAtOrBefore = (ts: number): number => {
    while (barCursor + 1 < ohlcv.length && ohlcv[barCursor + 1]![0]! <= ts) barCursor++;
    return ohlcv[barCursor]![4]!; // close
  };

  let state: 'OFF' | 'ON' = 'OFF';
  let entryIndex = -1;
  let entryTimestamp = 0;
  let accrued = new Decimal(0);
  let intervalsHeld = 0;

  for (let i = 0; i < funding.length; i++) {
    const ts = funding[i]!.timestamp;

    if (state === 'OFF') {
      const meanL = trailingMean(rates, i, params.entryLookback);
      if (meanL !== null && meanL * ANNUALIZATION_FACTOR >= params.entryThresholdAnnualized) {
        state = 'ON';
        entryIndex = i;
        entryTimestamp = ts;
        accrued = new Decimal(0);
        intervalsHeld = 0;
      }
    } else {
      const mean1d = trailingMean(rates, i, EXIT_LOOKBACK_INTERVALS);
      const exitFires =
        mean1d !== null &&
        (params.exitRule === 'flip'
          ? mean1d <= 0
          : mean1d * ANNUALIZATION_FACTOR < params.entryThresholdAnnualized / 2);
      if (exitFires) {
        const net = accrued.sub(ENTRY_COST_FRACTION).sub(EXIT_COST_FRACTION).toNumber();
        episodes.push({
          entryIndex,
          entryTimestamp,
          exitIndex: i,
          exitTimestamp: ts,
          intervalsHeld,
          accruedFunding: accrued.toNumber(),
          netReturn: net,
          netReturnBasisLow: net - BASIS_SENSITIVITY,
          netReturnBasisHigh: net + BASIS_SENSITIVITY,
        });
        state = 'OFF';
        entryIndex = -1;
        continue; // flat as of ts — no accrual this interval, see ACCRUAL TIMING above
      }
    }

    if (state === 'ON') {
      const mark = markAtOrBefore(ts);
      const rate = new Decimal(funding[i]!.fundingRate);
      const signedQty = new Decimal(1).div(mark).neg(); // short perp, notional N=1
      accrued = accrued.add(fundingPayment(signedQty, new Decimal(mark), rate));
      intervalsHeld++;
    }
  }

  return episodes;
}
