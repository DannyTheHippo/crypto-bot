import Decimal from 'decimal.js';
import type { AgentDirectives } from '../../../ports/strategy/agentic-strategy';
import { evaluatePlan } from './plan-executor';

// Offline fill model for a replayed plan: walk a plan forward over a sequence of closes and report
// what the round trip would have netted. Introduced for the mint-time candidate-vs-champion
// expectancy backtest, whose runCandidateBacktest driver was deleted with the in-process reflection
// loop on 2026-07-30 (research/studies/entry-rate-rederivation-2026-07-30.md); the fill model itself
// survives as test/backtest/agentic-replay-r1.ts's fill model.
//
// FORWARD-CANDLE APPROXIMATION (prominent by design — read before trusting a number this module
// produces): callers feed a forward path built from whatever closes they have. The original caller
// built it from the RECORDED ROWS THEMSELVES — each row's own `close`, grouped by symbol and ordered
// by event time. Since decides land roughly one per ~15m bar while the lane is active, that is a
// SPARSE, decide-cadence forward path, not the strategy's true intra-bar candle series — a plan's
// stop/take-profit may have touched and reverted between two consecutive closes without ever showing
// up here. A path with too few forward points for its own plan's maxHoldBars is reported
// unsimulatable (null) rather than extrapolated. Treat every bps figure as a coarse estimate at the
// caller's own sampling resolution — directionally useful for a COMPARISON between two arms that
// suffer the same approximation, never a precise expectancy.

// Round-trip fee fraction subtracted from every simulated exit — matches CLAUDE.md's own
// round-trip-cost convention used elsewhere in this lane (20bps = 0.0020, the maker+taker pairing
// this lane's prompts also state).
const ROUND_TRIP_FEE_FRACTION = new Decimal('0.0020');

// A path needs at least this share of its own plan's maxHoldBars worth of forward closes before its
// simulated outcome is trusted — below it, the sparse forward path (see this file's header comment)
// is too short to tell a real stop/TP/max-hold outcome apart from a window that simply ran out of
// recorded data.
const MIN_FORWARD_COVERAGE = 0.25;

// Walks plan-executor's own evaluatePlan bar-by-bar over `forwardCloses` (entry assumed filled at
// `entryClose`, the row's own decision close — this module never models the resting-entry window),
// stopping at the first stop/take_profit/max_hold exit. If maxHoldBars worth of forward data isn't
// available but MIN_FORWARD_COVERAGE's floor is cleared, the walk uses whatever forward closes exist
// and falls back to the LAST available close as an approximate exit (the sparse path ran out before
// evaluatePlan ever fired an exit of its own) — never fabricates data beyond what was recorded.
// Returns null (unsimulatable) below MIN_FORWARD_COVERAGE.
//
// P3: widened from LONG-only to LONG/SHORT (v2 'open_short' is a real entry this module replays)
// — `positionSide` selects evaluatePlan's mirrored stop/TP arm, and the net-bps formula below mirrors
// counterfactual-scoring.ts's own computeToyEquity SHORT precedent: a LONG profits on exit/entry, a
// SHORT profits on the INVERTED entry/exit ratio (the exact mirror of a LONG's own multiplier).
export function simulateRoundTrip(
  entryClose: string,
  plan: AgentDirectives,
  forwardCloses: readonly string[],
  positionSide: 'LONG' | 'SHORT',
): { readonly netBps: number } | null {
  const minPoints = Math.ceil(plan.maxHoldBars * MIN_FORWARD_COVERAGE);
  if (forwardCloses.length < minPoints) return null;

  const walkLen = Math.min(forwardCloses.length, plan.maxHoldBars);
  let exitClose = forwardCloses[walkLen - 1]!;
  for (let barsElapsed = 1; barsElapsed <= walkLen; barsElapsed++) {
    const closePrice = forwardCloses[barsElapsed - 1]!;
    const action = evaluatePlan({
      state: { plan, entryPrice: entryClose, planStartedBar: 0, barsElapsed },
      closePrice,
      positionSide,
      hasRestingEntry: false,
    });
    if (action.type === 'exit') {
      exitClose = closePrice;
      break;
    }
  }

  const grossFraction =
    positionSide === 'LONG'
      ? new Decimal(exitClose).div(entryClose).minus(1)
      : new Decimal(entryClose).div(exitClose).minus(1);
  const netFraction = grossFraction.minus(ROUND_TRIP_FEE_FRACTION);
  return { netBps: netFraction.mul(10_000).toNumber() };
}
