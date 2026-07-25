import Decimal from 'decimal.js';
import {
  EFFECTIVE_BOOK_USD,
  WINNER_MAX_DRAWDOWN_FRACTION,
  WINNER_MAX_SYMBOL_PROFIT_SHARE,
  WINNER_MIN_CYCLES,
  WINNER_MIN_POSITIVE_SEGMENTS,
} from './constants';
import type { WinnerGateInput, WinnerGateResult, WinnerRankInput } from './types';
import { medianSegmentNetBps } from './metrics';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export function evaluateWinnerGate(input: WinnerGateInput): WinnerGateResult {
  const reasons: string[] = [];
  const { trial } = input;
  const net = new Decimal(trial.aggregateNetPnlUsd);
  const stress = new Decimal(trial.stress2xNetPnlUsd);
  const maxDd = new Decimal(trial.maxDrawdownFraction);
  const medianBps = medianSegmentNetBps(trial.segments);

  if (!net.gt(0)) reasons.push('aggregate net PnL not positive');
  const positiveSegs = trial.segments.filter((s) => new Decimal(s.netPnlUsd).gt(0)).length;
  if (positiveSegs < WINNER_MIN_POSITIVE_SEGMENTS) {
    reasons.push(`only ${positiveSegs} positive segments (need ${WINNER_MIN_POSITIVE_SEGMENTS})`);
  }
  for (const seg of trial.segments) {
    const segPnl = new Decimal(seg.netPnlUsd);
    if (segPnl.lt(0) && segPnl.abs().gt(net)) {
      reasons.push(`segment ${seg.segmentId} loss exceeds aggregate gain`);
    }
  }
  if (trial.cycles < WINNER_MIN_CYCLES) {
    reasons.push(`cycles ${trial.cycles} < ${WINNER_MIN_CYCLES}`);
  }
  if (stress.lt(0)) reasons.push('2x-cost stress is negative');
  if (maxDd.gt(WINNER_MAX_DRAWDOWN_FRACTION)) {
    reasons.push(`max drawdown ${maxDd.toFixed()} exceeds ${WINNER_MAX_DRAWDOWN_FRACTION}`);
  }
  if (net.gt(0)) {
    for (const [sym, pnlStr] of Object.entries(trial.symbolPnlUsd)) {
      const pnl = new Decimal(pnlStr);
      if (pnl.gt(0) && pnl.div(net).gt(WINNER_MAX_SYMBOL_PROFIT_SHARE)) {
        reasons.push(`symbol ${sym} contributes >40% of profit`);
      }
    }
  }
  if (!new Decimal(trial.aggregateNetPnlUsd).gt(input.flatBaselineNetPnlUsd)) {
    reasons.push('does not beat flat baseline');
  }
  if (!new Decimal(trial.aggregateNetPnlUsd).gt(input.agenticBaselineNetPnlUsd)) {
    reasons.push('does not beat agentic baseline');
  }
  if (!input.dataProbesOk) reasons.push('required data probe failed');

  return {
    passes: reasons.length === 0,
    reasons,
    medianSegmentNetBps: medianBps,
  };
}

/** Deterministic tie-break: highest median segment bps, then lower drawdown, then lower turnover. */
export function rankWinners(candidates: readonly WinnerRankInput[]): WinnerRankInput[] {
  return [...candidates]
    .filter((c) => c.gate.passes)
    .sort((a, b) => {
      const mbps = Number(b.gate.medianSegmentNetBps) - Number(a.gate.medianSegmentNetBps);
      if (mbps !== 0) return mbps;
      const dd = Number(a.trial.maxDrawdownFraction) - Number(b.trial.maxDrawdownFraction);
      if (dd !== 0) return dd;
      return Number(a.trial.turnoverNotionalUsd) - Number(b.trial.turnoverNotionalUsd);
    });
}

export function pickWinner(candidates: readonly WinnerRankInput[]): WinnerRankInput | null {
  const ranked = rankWinners(candidates);
  return ranked[0] ?? null;
}

export function symbolProfitShare(
  symbolPnlUsd: Readonly<Record<string, string>>,
  aggregateNetPnlUsd: string,
): Record<string, string> {
  const net = new Decimal(aggregateNetPnlUsd);
  const out: Record<string, string> = {};
  if (!net.gt(0)) return out;
  for (const [sym, pnl] of Object.entries(symbolPnlUsd)) {
    out[sym] = new Decimal(pnl).div(net).toFixed();
  }
  return out;
}

export function drawdownLimitUsd(): string {
  return new Decimal(EFFECTIVE_BOOK_USD).mul(WINNER_MAX_DRAWDOWN_FRACTION).toFixed();
}
