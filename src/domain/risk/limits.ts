import Decimal from 'decimal.js';

// RiskLimitsConfig — every field mandatory; absence or non-positivity blocks live
// mode (ModeControl gate d) and trips the in-engine completeness rule (§5 G2).
// Money/qty fields are plain decimal strings (validated into Decimal here).
export interface RiskLimitsConfig {
  readonly maxBandBps: number; // P2: |limit − mid| / mid ≤ this (basis points)
  readonly maxOrderNotional: string; // P3: qty × price ≤ this (quote)
  readonly maxDriftBps: number; // P4: |refPrice − mark| / mark ≤ this
  readonly maxPositionPerSymbol: string; // E1: post-trade |position| ≤ this (base qty)
  readonly maxGrossExposure: string; // E2: Σ|notional| ≤ this (quote)
  readonly maxNetExposure: string; // E3: |Σ signed notional| ≤ this (quote)
  readonly maxDailyLoss: string; // C1: sodEquityUtc − equity < this (quote)
  readonly maxDrawdownPct: string; // C2: (peak − equity)/peak < this (fraction 0..1)
  readonly staleMaxAgeMs: number; // P1: mark age ≤ this
}

// A partial shape that may carry nulls/undefined — what arrives before validation.
export type PartialRiskLimits = {
  readonly [K in keyof RiskLimitsConfig]?: RiskLimitsConfig[K] | null;
};

// G2: every limit present, and every numeric/decimal strictly positive.
// Returns the complete config (narrowed) or null when incomplete.
export function validateLimits(limits: PartialRiskLimits | null | undefined): RiskLimitsConfig | null {
  if (!limits) return null;
  const numericFields: ReadonlyArray<keyof RiskLimitsConfig> = ['maxBandBps', 'maxDriftBps', 'staleMaxAgeMs'];
  const decimalFields: ReadonlyArray<keyof RiskLimitsConfig> = [
    'maxOrderNotional',
    'maxPositionPerSymbol',
    'maxGrossExposure',
    'maxNetExposure',
    'maxDailyLoss',
    'maxDrawdownPct',
  ];
  for (const f of numericFields) {
    const v = limits[f];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  }
  for (const f of decimalFields) {
    const v = limits[f];
    if (typeof v !== 'string' || v === '') return null;
    let d: Decimal;
    try {
      d = new Decimal(v);
    } catch {
      return null;
    }
    if (!d.isFinite() || d.lte(0)) return null;
  }
  return limits as RiskLimitsConfig;
}
