import Decimal from 'decimal.js';

// Pure isolated-margin perp entry-sizing caps (B2). Mirrors PaperPerpAdapter's own fixed-leverage
// liquidation model (liqPrice: long entry×(1−1/lev+MMR), short entry×(1+1/lev−MMR)) — same lev/MMR
// source (PERP_LEVERAGE_CAP/PERP_MMR_FALLBACK), so a sizing decision never disagrees with what the
// adapter would actually liquidate at. No @nestjs/*, ccxt, Date.now, or process.env (domain purity).

// margin × leverageCap: the affordability ceiling — cannot request more notional than the free
// isolated margin, levered at the configured cap, can support.
export function marginNotionalCap(freeMargin: Decimal, leverageCap: Decimal): Decimal {
  return freeMargin.mul(leverageCap);
}

// liqSafeNotional: the liquidation-safety gate. Because the adapter applies ONE fixed leverage
// figure to every position (never a per-order effective leverage), the fractional distance from
// entry to liqPrice — 1/leverageCap − mmrFallback, identical for long and short by construction of
// the two liqPrice formulas — is a CONSTANT, independent of notional or price. So this is not a
// graduated cap: either the configured leverage/MMR combination already clears the required buffer
// (any notional is liq-safe at that leverage ⇒ Infinity, imposing no further restriction) or it
// doesn't (no notional is safe at that leverage ⇒ 0, rejecting the entry outright).
export function liqSafeNotionalCap(
  leverageCap: Decimal,
  mmrFallback: Decimal,
  liqBufferPct: Decimal,
): Decimal {
  const liqDistance = new Decimal(1).div(leverageCap).sub(mmrFallback);
  return liqDistance.gte(liqBufferPct) ? new Decimal(Infinity) : new Decimal(0);
}

// Funding-aware sizing HOOK (no consumer yet — a future task wires a real funding-rate forecast
// through SizerDeps.perp.expectedFundingBpsPerHold). Scales notional down proportionally to the
// expected funding cost over the anticipated hold, expressed in bps; undefined ⇒ no scaling
// (byte-identical to the pre-hook behavior). Floored at 0 rather than allowed to go negative.
export function applyFundingScaling(
  notional: Decimal,
  expectedFundingBpsPerHold: Decimal | undefined,
): Decimal {
  if (expectedFundingBpsPerHold === undefined) return notional;
  const scale = Decimal.max(
    new Decimal(1).sub(expectedFundingBpsPerHold.abs().div(10_000)),
    new Decimal(0),
  );
  return notional.mul(scale);
}
