import Decimal from 'decimal.js';

// Pure post-trade monitor predicates (§5 C1/C2). These are the PRIMARY owners of the daily-loss
// and drawdown limits — they evaluate every equity sample (per-fill + 5s), where the same-named
// pre-trade gates in evaluate.ts only close the race between monitor ticks. Equality trips in both
// (a limit is a ceiling you may reach, not exceed).

// C1 — realized + unrealized loss since the UTC start-of-day anchor reaches the cap.
export function dailyLossTripped(
  sodEquityUtc: Decimal,
  equity: Decimal,
  maxDailyLoss: string,
): boolean {
  return sodEquityUtc.sub(equity).gte(new Decimal(maxDailyLoss));
}

// C2 — peak-to-trough drawdown fraction reaches the cap. A non-positive peak (no equity history
// yet) can never trip; dividing by it would be meaningless.
export function drawdownTripped(
  peakEquity: Decimal,
  equity: Decimal,
  maxDrawdownPct: string,
): boolean {
  if (peakEquity.lte(0)) return false;
  return peakEquity.sub(equity).div(peakEquity).gte(new Decimal(maxDrawdownPct));
}
