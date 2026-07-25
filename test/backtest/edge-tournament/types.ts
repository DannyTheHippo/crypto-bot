import type { TrialId } from './constants';

/** ccxt OHLCV row: [openTimeMs, open, high, low, close, volume] — research metric floats OK. */
export type OhlcvBar = readonly [number, number, number, number, number, number];

export interface DailySeries {
  readonly symbol: string;
  readonly timestamps: readonly number[];
  readonly opens: readonly number[];
  readonly closes: readonly number[];
}

export interface FundingSettlement {
  readonly timestamp: number;
  readonly fundingRate: string;
}

export interface VenueFundingSeries {
  readonly venue: string;
  readonly symbol: string;
  readonly settlements: readonly FundingSettlement[];
}

export interface NewsObservation {
  readonly publishedMs: number;
  readonly toneZ: string;
}

export interface MacroEvent {
  readonly name: string;
  readonly atMs: number;
  readonly kind: 'FOMC' | 'CPI';
}

export interface CostBreakdown {
  readonly feesUsd: string;
  readonly slippageUsd: string;
  readonly fundingUsd: string;
  readonly llmUsd: string;
  readonly turnoverUsd: string;
}

export interface SegmentMetrics {
  readonly segmentId: 1 | 2 | 3;
  readonly netPnlUsd: string;
  readonly netBps: string;
  readonly cycles: number;
  readonly maxDrawdownFraction: string;
  readonly turnoverNotionalUsd: string;
  readonly avgGrossExposureFraction: string;
  readonly costs: CostBreakdown;
  readonly symbolPnlUsd: Readonly<Record<string, string>>;
}

export interface TrialResult {
  readonly trialId: TrialId;
  readonly aggregateNetPnlUsd: string;
  readonly aggregateNetBps: string;
  readonly cycles: number;
  readonly maxDrawdownFraction: string;
  readonly turnoverNotionalUsd: string;
  readonly avgGrossExposureFraction: string;
  readonly costs: CostBreakdown;
  readonly symbolPnlUsd: Readonly<Record<string, string>>;
  readonly segments: readonly SegmentMetrics[];
  readonly stress2xNetPnlUsd: string;
  readonly equityCurve?: readonly { readonly ts: number; readonly equityUsd: string }[];
}

export interface WinnerGateInput {
  readonly trial: TrialResult;
  readonly flatBaselineNetPnlUsd: string;
  readonly agenticBaselineNetPnlUsd: string;
  readonly dataProbesOk: boolean;
}

export interface WinnerGateResult {
  readonly passes: boolean;
  readonly reasons: readonly string[];
  readonly medianSegmentNetBps: string;
}

export interface WinnerRankInput {
  readonly trialId: TrialId;
  readonly gate: WinnerGateResult;
  readonly trial: TrialResult;
}
