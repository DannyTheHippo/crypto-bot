// Shared cross-sectional engine for trials 1, 2, 3, 6 — RESEARCH TOOLING.
import Decimal from 'decimal.js';
import { tradingCalendarTimestamps } from './alignment';
import {
  BETA_LOOKBACK_DAYS,
  EFFECTIVE_BOOK_USD,
  ELIGIBILITY_LOOKBACK_DAYS,
  MAX_GROSS_EXPOSURE_FRACTION,
  REPORTING_SEGMENTS,
  RETURN_LOOKBACK_DAYS,
  VOL_LOOKBACK_DAYS,
  XSEC_BOTTOM_N,
  XSEC_REBALANCE_DAYS,
  XSEC_TOP_N,
  type TrialId,
} from './constants';
import { emptyCostBreakdown, llmConsultCostUsd, mergeCosts, turnoverCostUsd } from './costs';
import {
  eligibleSymbolsAtBar,
  trailingBetaAtTs,
  trailingRealizedVol,
  trailingReturn,
} from './eligibility';
import { aggregateSymbolPnl, buildTrialResult, type EquityPoint } from './metrics';
import type { DailySeries, MacroEvent, TrialResult } from './types';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export type WeightMode = 'equal' | 'volbeta';
export type RankMode = 'raw' | 'residual';

export interface XsecSimOptions {
  readonly trialId: TrialId;
  readonly weightMode: WeightMode;
  readonly rankMode: RankMode;
  readonly macroEvents?: readonly MacroEvent[];
  readonly observedLlmCostUsd?: string | null;
}

interface Weights {
  readonly bySymbol: Readonly<Record<string, string>>;
}

function sideGrossFraction(): Decimal {
  return new Decimal(MAX_GROSS_EXPOSURE_FRACTION).div(2);
}

function seriesIndexAt(series: DailySeries, ts: number): number {
  return series.timestamps.indexOf(ts);
}

function rankScoreAtTs(
  series: DailySeries,
  btc: DailySeries,
  decisionTs: number,
  rankMode: RankMode,
): number | null {
  const idx = seriesIndexAt(series, decisionTs);
  const btcIdx = seriesIndexAt(btc, decisionTs);
  if (idx < 0 || btcIdx < 0) return null;
  const ret = trailingReturn(series.closes, idx, RETURN_LOOKBACK_DAYS);
  if (ret === null) return null;
  if (rankMode === 'raw') return ret;
  const beta = trailingBetaAtTs(series, btc, decisionTs, BETA_LOOKBACK_DAYS);
  const btcRet = trailingReturn(btc.closes, btcIdx, RETURN_LOOKBACK_DAYS);
  if (beta === null || btcRet === null) return null;
  return ret - beta * btcRet;
}

function volBetaWeights(
  longs: string[],
  shorts: string[],
  bySymbol: ReadonlyMap<string, DailySeries>,
  btc: DailySeries,
  decisionTs: number,
): Weights | null {
  const sideFrac = sideGrossFraction();
  const buildSide = (syms: string[], sign: number): Record<string, Decimal> | null => {
    const invVols: { sym: string; w: Decimal }[] = [];
    for (const sym of syms) {
      const s = bySymbol.get(sym);
      if (!s) return null;
      const idx = seriesIndexAt(s, decisionTs);
      if (idx < 0) return null;
      const vol = trailingRealizedVol(s.closes, idx, VOL_LOOKBACK_DAYS);
      if (vol === null || !(vol > 0)) return null;
      invVols.push({ sym, w: new Decimal(1).div(vol) });
    }
    const sum = invVols.reduce((a, x) => a.plus(x.w), new Decimal(0));
    if (!sum.gt(0)) return null;
    const out: Record<string, Decimal> = {};
    for (const { sym, w } of invVols) out[sym] = w.div(sum).mul(sideFrac).mul(sign);
    return out;
  };

  const longW = buildSide(longs, 1);
  const shortW = buildSide(shorts, -1);
  if (!longW || !shortW) return null;
  const w: Record<string, Decimal> = { ...longW, ...shortW };

  let longBetaSum = new Decimal(0);
  let shortBetaSum = new Decimal(0);
  let grossLong = new Decimal(0);
  let grossShort = new Decimal(0);
  for (const sym of longs) {
    const beta = trailingBetaAtTs(bySymbol.get(sym)!, btc, decisionTs, BETA_LOOKBACK_DAYS);
    if (beta === null) return null;
    longBetaSum = longBetaSum.plus(w[sym]!.mul(beta));
    grossLong = grossLong.plus(w[sym]!.abs());
  }
  for (const sym of shorts) {
    const beta = trailingBetaAtTs(bySymbol.get(sym)!, btc, decisionTs, BETA_LOOKBACK_DAYS);
    if (beta === null) return null;
    shortBetaSum = shortBetaSum.plus(w[sym]!.mul(beta));
    grossShort = grossShort.plus(w[sym]!.abs());
  }
  const portBeta = longBetaSum.plus(shortBetaSum);
  if (portBeta.abs().lt(1e-12)) {
    const out: Record<string, string> = {};
    for (const [sym, val] of Object.entries(w)) out[sym] = val.toFixed();
    return { bySymbol: out };
  }
  const bL = grossLong.gt(0) ? longBetaSum.div(grossLong) : new Decimal(0);
  const bS = grossShort.gt(0) ? shortBetaSum.div(grossShort.abs()) : new Decimal(0);
  if (bL.eq(bS)) {
    const out: Record<string, string> = {};
    for (const [sym, val] of Object.entries(w)) out[sym] = val.toFixed();
    return { bySymbol: out };
  }
  const targetLongGross = grossShort.mul(bS.abs()).div(bL.abs());
  const adj = grossLong.gt(0) ? targetLongGross.div(grossLong) : new Decimal(1);
  const out: Record<string, string> = {};
  for (const [sym, val] of Object.entries(w)) {
    out[sym] = longs.includes(sym) ? val.mul(adj).toFixed() : val.toFixed();
  }
  return { bySymbol: out };
}

function macroExposureMultiplier(ts: number, events: readonly MacroEvent[] | undefined): Decimal {
  if (!events?.length) return new Decimal(1);
  for (const ev of events) {
    const blackoutStart = ev.atMs - 6 * 3_600_000;
    const blackoutEnd = ev.atMs + 2 * 3_600_000;
    if (ts >= blackoutStart && ts <= blackoutEnd) return new Decimal(0);
    const reducedEnd = blackoutEnd + 48 * 3_600_000;
    if (ts > blackoutEnd && ts <= reducedEnd) return new Decimal('0.50');
  }
  return new Decimal(1);
}

export function simulateXsec(
  rawBySymbol: ReadonlyMap<string, DailySeries>,
  options: XsecSimOptions,
): TrialResult {
  // BTC calendar + per-bar eligibility (prereg: missing history ⇒ ineligible, not axis truncate).
  const timestamps = tradingCalendarTimestamps(rawBySymbol);
  const bySymbol = rawBySymbol;
  const btc = bySymbol.get('BTC/USDT:USDT');
  if (!btc) throw new Error('BTC/USDT:USDT series required');

  let equity = new Decimal(EFFECTIVE_BOOK_USD);
  const curve: EquityPoint[] = [{ ts: timestamps[0] ?? 0, equityUsd: equity.toFixed() }];
  const segmentCurves: Record<1 | 2 | 3, EquityPoint[]> = { 1: [], 2: [], 3: [] };
  const segmentCycles: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
  let costs = emptyCostBreakdown();
  let stressCosts = emptyCostBreakdown();
  let turnover = new Decimal(0);
  let grossExposureSum = new Decimal(0);
  let steps = 0;
  const symbolSteps: { ts: number; bySymbol: Record<string, string> }[] = [];

  let prevWeights: Record<string, Decimal> = {};
  const warmup = Math.max(RETURN_LOOKBACK_DAYS, BETA_LOOKBACK_DAYS, ELIGIBILITY_LOOKBACK_DAYS) + 1;

  for (let ti = warmup; ti < timestamps.length - 2; ti += 1) {
    const ts = timestamps[ti]!;
    const eligible = eligibleSymbolsAtBar(bySymbol, ti, timestamps);
    if (eligible.length < XSEC_TOP_N + XSEC_BOTTOM_N) continue;

    let target: Weights | null = null;
    if ((ti - warmup) % XSEC_REBALANCE_DAYS === 0) {
      const scored = eligible
        .map((sym) => ({
          sym,
          score: rankScoreAtTs(bySymbol.get(sym)!, btc, ts, options.rankMode),
        }))
        .filter((x): x is { sym: string; score: number } => x.score !== null)
        .sort((a, b) => b.score - a.score);
      if (scored.length < XSEC_TOP_N + XSEC_BOTTOM_N) continue;
      const longs = scored.slice(0, XSEC_TOP_N).map((x) => x.sym);
      const shorts = scored.slice(-XSEC_BOTTOM_N).map((x) => x.sym);
      if (options.weightMode === 'equal') {
        const sideFrac = sideGrossFraction();
        const out: Record<string, string> = {};
        for (const sym of longs) out[sym] = sideFrac.div(longs.length).toFixed();
        for (const sym of shorts) out[sym] = sideFrac.div(shorts.length).neg().toFixed();
        target = { bySymbol: out };
      } else {
        target = volBetaWeights(longs, shorts, bySymbol, btc, ts);
      }
      if (!target) continue;
      const llm = llmConsultCostUsd(options.observedLlmCostUsd ?? null);
      equity = equity.minus(llm);
      costs = mergeCosts(costs, { ...emptyCostBreakdown(), llmUsd: llm.toFixed() });
      const llm2 = llm.mul(2);
      stressCosts = mergeCosts(stressCosts, { ...emptyCostBreakdown(), llmUsd: llm2.toFixed() });
    }

    const nextWeights: Record<string, Decimal> = {};
    if (target) {
      for (const [sym, wt] of Object.entries(target.bySymbol)) {
        nextWeights[sym] = new Decimal(wt).mul(macroExposureMultiplier(ts, options.macroEvents));
      }
      const allSyms = new Set([...Object.keys(prevWeights), ...Object.keys(nextWeights)]);
      for (const sym of allSyms) {
        const prev = prevWeights[sym] ?? new Decimal(0);
        const next = nextWeights[sym] ?? new Decimal(0);
        const delta = next.minus(prev).abs();
        if (delta.gt(0)) {
          const tc = turnoverCostUsd(delta);
          const tc2 = turnoverCostUsd(delta, 2);
          equity = equity.minus(tc.feesUsd).minus(tc.slippageUsd);
          costs = mergeCosts(costs, {
            feesUsd: tc.feesUsd.toFixed(),
            slippageUsd: tc.slippageUsd.toFixed(),
            fundingUsd: '0',
            llmUsd: '0',
            turnoverUsd: '0',
          });
          stressCosts = mergeCosts(stressCosts, {
            feesUsd: tc2.feesUsd.toFixed(),
            slippageUsd: tc2.slippageUsd.toFixed(),
            fundingUsd: '0',
            llmUsd: '0',
            turnoverUsd: '0',
          });
          turnover = turnover.plus(delta.mul(EFFECTIVE_BOOK_USD));
        }
      }
      prevWeights = nextWeights;
    }

    let stepPnl = new Decimal(0);
    const bySymPnl: Record<string, string> = {};
    let gross = new Decimal(0);
    for (const [sym, weight] of Object.entries(prevWeights)) {
      const s = bySymbol.get(sym);
      if (!s) continue;
      const idx = seriesIndexAt(s, ts);
      if (idx < 0 || idx + 2 >= s.opens.length) continue;
      const o0 = s.opens[idx + 1]!;
      const o1 = s.opens[idx + 2]!;
      if (!(o0 > 0) || !(o1 > 0)) continue;
      const ret = new Decimal(o1).div(o0).minus(1);
      const pnl = weight.mul(EFFECTIVE_BOOK_USD).mul(ret);
      stepPnl = stepPnl.plus(pnl);
      bySymPnl[sym] = pnl.toFixed();
      gross = gross.plus(weight.abs());
    }
    equity = equity.plus(stepPnl);
    const fillTs = timestamps[ti + 1] ?? ts;
    curve.push({ ts: fillTs, equityUsd: equity.toFixed() });
    symbolSteps.push({ ts, bySymbol: bySymPnl });
    grossExposureSum = grossExposureSum.plus(gross);
    steps += 1;

    for (const seg of REPORTING_SEGMENTS) {
      if (ts >= seg.startMs && ts < seg.endMs) {
        const arr = segmentCurves[seg.id];
        if (arr.length === 0) arr.push({ ts, equityUsd: equity.minus(stepPnl).toFixed() });
        arr.push({ ts: fillTs, equityUsd: equity.toFixed() });
        if (target) segmentCycles[seg.id] += 1;
      }
    }
  }

  return buildTrialResult({
    trialId: options.trialId,
    equityCurve: curve,
    segmentCurves,
    segmentCycles,
    costs,
    stress2xCosts: stressCosts,
    turnoverNotionalUsd: turnover.toFixed(),
    avgGrossExposureFraction: steps > 0 ? grossExposureSum.div(steps).toFixed() : '0',
    symbolPnlUsd: aggregateSymbolPnl(symbolSteps),
    grossPnlUsd: equity.minus(EFFECTIVE_BOOK_USD).toFixed(),
  });
}
