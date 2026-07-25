// Tournament cost model — exact Decimal strings on money-adjacent paths.
import Decimal from 'decimal.js';
import {
  DIRECTIONAL_FEE_BPS,
  DIRECTIONAL_SLIPPAGE_BPS,
  EFFECTIVE_BOOK_USD,
  LLM_COST_FLOOR_USD,
  type FundingVenue,
  VENUE_TAKER_FEE_BPS,
} from './constants';
import type { CostBreakdown } from './types';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export function bpsToFraction(bps: string): Decimal {
  return new Decimal(bps).div(10_000);
}

export function notionalFromWeight(weight: string): Decimal {
  return new Decimal(EFFECTIVE_BOOK_USD).mul(weight);
}

/** One directional leg: fee + adverse slippage. */
export function directionalLegCostUsd(notionalUsd: Decimal, stressMultiplier = 1): Decimal {
  const bps = new Decimal(DIRECTIONAL_FEE_BPS).plus(DIRECTIONAL_SLIPPAGE_BPS).mul(stressMultiplier);
  return notionalUsd.mul(bps).div(10_000);
}

/** One cross-venue fill at venue VIP-0 taker + 5bps slippage. */
export function crossVenueFillCostUsd(
  venue: FundingVenue,
  notionalUsd: Decimal,
  stressMultiplier = 1,
): Decimal {
  const bps = new Decimal(VENUE_TAKER_FEE_BPS[venue])
    .plus(DIRECTIONAL_SLIPPAGE_BPS)
    .mul(stressMultiplier);
  return notionalUsd.mul(bps).div(10_000);
}

/** Four-leg episode entry+exit at two venues. */
export function crossVenueEpisodeCostUsd(
  longVenue: FundingVenue,
  shortVenue: FundingVenue,
  notionalUsd: Decimal,
  stressMultiplier = 1,
): Decimal {
  return crossVenueFillCostUsd(longVenue, notionalUsd, stressMultiplier)
    .plus(crossVenueFillCostUsd(shortVenue, notionalUsd, stressMultiplier))
    .mul(2);
}

/** LLM consult allocated against the effective book. */
export function llmConsultCostUsd(observedAvgUsd: string | null, stressMultiplier = 1): Decimal {
  const observed = observedAvgUsd ? new Decimal(observedAvgUsd) : new Decimal(0);
  const base = Decimal.max(new Decimal(LLM_COST_FLOOR_USD), observed);
  return base.mul(stressMultiplier);
}

export function emptyCostBreakdown(): CostBreakdown {
  return {
    feesUsd: '0',
    slippageUsd: '0',
    fundingUsd: '0',
    llmUsd: '0',
    turnoverUsd: '0',
  };
}

export function mergeCosts(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    feesUsd: new Decimal(a.feesUsd).plus(b.feesUsd).toFixed(),
    slippageUsd: new Decimal(a.slippageUsd).plus(b.slippageUsd).toFixed(),
    fundingUsd: new Decimal(a.fundingUsd).plus(b.fundingUsd).toFixed(),
    llmUsd: new Decimal(a.llmUsd).plus(b.llmUsd).toFixed(),
    turnoverUsd: new Decimal(a.turnoverUsd).plus(b.turnoverUsd).toFixed(),
  };
}

export function totalCostsUsd(c: CostBreakdown): Decimal {
  return new Decimal(c.feesUsd)
    .plus(c.slippageUsd)
    .plus(c.fundingUsd)
    .plus(c.llmUsd)
    .plus(c.turnoverUsd);
}

/** Turnover charge on |Δweight| × notional at directional fee+slippage per leg. */
export function turnoverCostUsd(
  deltaWeightAbs: Decimal,
  stressMultiplier = 1,
): {
  feesUsd: Decimal;
  slippageUsd: Decimal;
} {
  const notional = notionalFromWeight(deltaWeightAbs.toFixed());
  const fee = notional.mul(new Decimal(DIRECTIONAL_FEE_BPS).mul(stressMultiplier)).div(10_000);
  const slip = notional
    .mul(new Decimal(DIRECTIONAL_SLIPPAGE_BPS).mul(stressMultiplier))
    .div(10_000);
  return { feesUsd: fee, slippageUsd: slip };
}
