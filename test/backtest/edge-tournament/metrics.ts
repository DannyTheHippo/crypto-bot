import Decimal from 'decimal.js';
import { EFFECTIVE_BOOK_USD, REPORTING_SEGMENTS } from './constants';
import type { CostBreakdown, SegmentMetrics, TrialResult } from './types';
import { totalCostsUsd } from './costs';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export interface EquityPoint {
  readonly ts: number;
  readonly equityUsd: string;
}

export function maxDrawdownFraction(curve: readonly EquityPoint[]): string {
  if (curve.length === 0) return '0';
  let peak = new Decimal(curve[0]!.equityUsd);
  let maxDd = new Decimal(0);
  for (const p of curve) {
    const eq = new Decimal(p.equityUsd);
    if (eq.gt(peak)) peak = eq;
    const dd = peak.gt(0) ? peak.minus(eq).div(peak) : new Decimal(0);
    if (dd.gt(maxDd)) maxDd = dd;
  }
  return maxDd.toFixed();
}

export function netBpsFromPnl(pnlUsd: Decimal): string {
  return pnlUsd.div(EFFECTIVE_BOOK_USD).mul(10_000).toFixed(4);
}

export function aggregateSymbolPnl(
  perStep: readonly { ts: number; bySymbol: Readonly<Record<string, string>> }[],
): Record<string, string> {
  const acc = new Map<string, Decimal>();
  for (const step of perStep) {
    for (const [sym, pnl] of Object.entries(step.bySymbol)) {
      acc.set(sym, (acc.get(sym) ?? new Decimal(0)).plus(pnl));
    }
  }
  const out: Record<string, string> = {};
  for (const [sym, v] of acc) out[sym] = v.toFixed();
  return out;
}

export function segmentMetricsFromCurve(
  segmentId: 1 | 2 | 3,
  curve: readonly EquityPoint[],
  cycles: number,
  costs: CostBreakdown,
  turnoverNotionalUsd: string,
  avgGrossExposureFraction: string,
  symbolPnlUsd: Readonly<Record<string, string>>,
): SegmentMetrics {
  if (curve.length === 0) {
    return {
      segmentId,
      netPnlUsd: '0',
      netBps: '0',
      cycles: 0,
      maxDrawdownFraction: '0',
      turnoverNotionalUsd,
      avgGrossExposureFraction,
      costs,
      symbolPnlUsd,
    };
  }
  const startEq = new Decimal(curve[0]!.equityUsd);
  const endEq = new Decimal(curve[curve.length - 1]!.equityUsd);
  const net = endEq.minus(startEq);
  return {
    segmentId,
    netPnlUsd: net.toFixed(),
    netBps: netBpsFromPnl(net),
    cycles,
    maxDrawdownFraction: maxDrawdownFraction(curve),
    turnoverNotionalUsd,
    avgGrossExposureFraction,
    costs,
    symbolPnlUsd,
  };
}

export function buildTrialResult(params: {
  trialId: TrialResult['trialId'];
  equityCurve: readonly EquityPoint[];
  segmentCurves: Readonly<Record<1 | 2 | 3, readonly EquityPoint[]>>;
  segmentCycles: Readonly<Record<1 | 2 | 3, number>>;
  costs: CostBreakdown;
  stress2xCosts: CostBreakdown;
  turnoverNotionalUsd: string;
  avgGrossExposureFraction: string;
  symbolPnlUsd: Readonly<Record<string, string>>;
  grossPnlUsd: string;
}): TrialResult {
  const startEq = new Decimal(EFFECTIVE_BOOK_USD);
  const endEq = new Decimal(
    params.equityCurve[params.equityCurve.length - 1]?.equityUsd ?? EFFECTIVE_BOOK_USD,
  );
  const net = endEq.minus(startEq);
  const extraStress = totalCostsUsd(params.stress2xCosts).minus(totalCostsUsd(params.costs));
  const stressNet = net.minus(extraStress);

  const segments: SegmentMetrics[] = REPORTING_SEGMENTS.map((seg) =>
    segmentMetricsFromCurve(
      seg.id,
      params.segmentCurves[seg.id] ?? [],
      params.segmentCycles[seg.id] ?? 0,
      params.costs,
      params.turnoverNotionalUsd,
      params.avgGrossExposureFraction,
      params.symbolPnlUsd,
    ),
  );

  return {
    trialId: params.trialId,
    aggregateNetPnlUsd: net.toFixed(),
    aggregateNetBps: netBpsFromPnl(net),
    cycles: Object.values(params.segmentCycles).reduce((a, b) => a + b, 0),
    maxDrawdownFraction: maxDrawdownFraction(params.equityCurve),
    turnoverNotionalUsd: params.turnoverNotionalUsd,
    avgGrossExposureFraction: params.avgGrossExposureFraction,
    costs: params.costs,
    symbolPnlUsd: params.symbolPnlUsd,
    segments,
    stress2xNetPnlUsd: stressNet.toFixed(),
    equityCurve: params.equityCurve,
  };
}

export function medianSegmentNetBps(segments: readonly SegmentMetrics[]): string {
  const vals = segments.map((s) => Number(s.netBps)).sort((a, b) => a - b);
  if (vals.length === 0) return '0';
  const mid = Math.floor(vals.length / 2);
  if (vals.length % 2 === 1) return vals[mid]!.toFixed(4);
  return ((vals[mid - 1]! + vals[mid]!) / 2).toFixed(4);
}
