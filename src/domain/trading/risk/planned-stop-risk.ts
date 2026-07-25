import Decimal from 'decimal.js';

// Pure planned-stop arithmetic shared by entry sizing and the agentic plan-update guard.
// It bounds cost-notional at the configured stop distance; it is not a gap/slippage/liquidation
// guarantee. Callers validate that fraction/stop are finite-positive before invoking it.
export function plannedStopNotionalCap(
  cappedEquity: Decimal,
  maxRiskFraction: Decimal,
  stopLossPct: Decimal,
): Decimal {
  return cappedEquity.mul(maxRiskFraction).div(stopLossPct);
}

export function plannedStopNotionalHeadroom(
  cappedEquity: Decimal,
  maxRiskFraction: Decimal,
  stopLossPct: Decimal,
  consumedCostNotional: Decimal,
): Decimal {
  return plannedStopNotionalCap(cappedEquity, maxRiskFraction, stopLossPct).sub(
    consumedCostNotional,
  );
}
