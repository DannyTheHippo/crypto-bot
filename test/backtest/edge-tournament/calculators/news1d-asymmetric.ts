import Decimal from 'decimal.js';
import { rollingNewsZ } from '../alignment';
import {
  DIRECTIONAL_FEE_BPS,
  DIRECTIONAL_SLIPPAGE_BPS,
  EFFECTIVE_BOOK_USD,
  NEWS_HOLD_DAYS,
  NEWS_Z_LONG_THRESHOLD,
  NEWS_Z_LOOKBACK_DAYS,
  NEWS_Z_SHORT_THRESHOLD,
  REPORTING_SEGMENTS,
} from '../constants';
import { emptyCostBreakdown, llmConsultCostUsd, mergeCosts } from '../costs';
import { buildTrialResult, type EquityPoint } from '../metrics';
import type { DailySeries, NewsObservation, TrialResult } from '../types';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

const LEG_BPS = new Decimal(DIRECTIONAL_FEE_BPS).plus(DIRECTIONAL_SLIPPAGE_BPS);

export function runNews1dAsymmetric(params: {
  btc: DailySeries;
  eth: DailySeries;
  news: readonly NewsObservation[];
  observedLlmCostUsd?: string | null;
}): TrialResult {
  const { btc, eth, news } = params;
  const tsList = btc.timestamps.filter((t) => eth.timestamps.includes(t));
  let equity = new Decimal(EFFECTIVE_BOOK_USD);
  const curve: EquityPoint[] = [{ ts: tsList[0] ?? 0, equityUsd: equity.toFixed() }];
  const segmentCurves: Record<1 | 2 | 3, EquityPoint[]> = { 1: [], 2: [], 3: [] };
  let costs = emptyCostBreakdown();
  let stressCosts = emptyCostBreakdown();
  let cycles = 0;
  const symbolPnl: Record<string, string> = {
    'BTC/USDT:USDT': '0',
    'ETH/USDT:USDT': '0',
  };

  let holdUntilIdx = -1;
  let position: 'flat' | 'short_btc' | 'long_eth' = 'flat';
  const exposure = new Decimal('0.20');

  for (let i = NEWS_Z_LOOKBACK_DAYS; i < tsList.length - 2; i += 1) {
    const ts = tsList[i]!;
    if (i >= holdUntilIdx) position = 'flat';

    if (position === 'flat') {
      const z = rollingNewsZ(news, ts, NEWS_Z_LOOKBACK_DAYS);
      if (z !== null) {
        if (z <= NEWS_Z_SHORT_THRESHOLD) {
          position = 'short_btc';
          holdUntilIdx = i + NEWS_HOLD_DAYS;
          cycles += 1;
        } else if (z >= NEWS_Z_LONG_THRESHOLD) {
          position = 'long_eth';
          holdUntilIdx = i + NEWS_HOLD_DAYS;
          cycles += 1;
        }
      }
      if (position !== 'flat') {
        const llm = llmConsultCostUsd(params.observedLlmCostUsd ?? null);
        equity = equity.minus(llm);
        costs = mergeCosts(costs, { ...emptyCostBreakdown(), llmUsd: llm.toFixed() });
        stressCosts = mergeCosts(stressCosts, {
          ...emptyCostBreakdown(),
          llmUsd: llm.mul(2).toFixed(),
        });
        const notional = exposure.mul(EFFECTIVE_BOOK_USD);
        const legCost = notional.mul(LEG_BPS).div(10_000);
        equity = equity.minus(legCost);
        costs = mergeCosts(costs, {
          feesUsd: notional.mul(DIRECTIONAL_FEE_BPS).div(10_000).toFixed(),
          slippageUsd: notional.mul(DIRECTIONAL_SLIPPAGE_BPS).div(10_000).toFixed(),
          fundingUsd: '0',
          llmUsd: '0',
          turnoverUsd: '0',
        });
        stressCosts = mergeCosts(stressCosts, {
          feesUsd: notional.mul(DIRECTIONAL_FEE_BPS).mul(2).div(10_000).toFixed(),
          slippageUsd: notional.mul(DIRECTIONAL_SLIPPAGE_BPS).mul(2).div(10_000).toFixed(),
          fundingUsd: '0',
          llmUsd: '0',
          turnoverUsd: '0',
        });
      }
    }

    const btcIdx = btc.timestamps.indexOf(ts);
    const ethIdx = eth.timestamps.indexOf(ts);
    if (
      btcIdx < 0 ||
      ethIdx < 0 ||
      btcIdx + 2 >= btc.opens.length ||
      ethIdx + 2 >= eth.opens.length
    ) {
      continue;
    }

    let stepPnl = new Decimal(0);
    if (position === 'short_btc') {
      const o0 = btc.opens[btcIdx + 1]!;
      const o1 = btc.opens[btcIdx + 2]!;
      const ret = new Decimal(o1).div(o0).minus(1).neg();
      stepPnl = exposure.mul(EFFECTIVE_BOOK_USD).mul(ret);
      symbolPnl['BTC/USDT:USDT'] = new Decimal(symbolPnl['BTC/USDT:USDT']!).plus(stepPnl).toFixed();
    } else if (position === 'long_eth') {
      const o0 = eth.opens[ethIdx + 1]!;
      const o1 = eth.opens[ethIdx + 2]!;
      const ret = new Decimal(o1).div(o0).minus(1);
      stepPnl = exposure.mul(EFFECTIVE_BOOK_USD).mul(ret);
      symbolPnl['ETH/USDT:USDT'] = new Decimal(symbolPnl['ETH/USDT:USDT']!).plus(stepPnl).toFixed();
    }
    equity = equity.plus(stepPnl);
    const fillTs = tsList[i + 1] ?? ts;
    curve.push({ ts: fillTs, equityUsd: equity.toFixed() });

    for (const seg of REPORTING_SEGMENTS) {
      if (ts >= seg.startMs && ts < seg.endMs) {
        const arr = segmentCurves[seg.id];
        if (arr.length === 0) arr.push({ ts, equityUsd: equity.minus(stepPnl).toFixed() });
        arr.push({ ts: fillTs, equityUsd: equity.toFixed() });
      }
    }
  }

  return buildTrialResult({
    trialId: 'news1d-asymmetric',
    equityCurve: curve,
    segmentCurves,
    segmentCycles: { 1: cycles, 2: 0, 3: 0 },
    costs,
    stress2xCosts: stressCosts,
    turnoverNotionalUsd: new Decimal(cycles).mul(exposure).mul(EFFECTIVE_BOOK_USD).mul(2).toFixed(),
    avgGrossExposureFraction: exposure.toFixed(),
    symbolPnlUsd: symbolPnl,
    grossPnlUsd: equity.minus(EFFECTIVE_BOOK_USD).toFixed(),
  });
}
