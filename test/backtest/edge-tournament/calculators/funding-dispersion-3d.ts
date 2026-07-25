import Decimal from 'decimal.js';
import { fundingPayment } from '../../funding';
import {
  EFFECTIVE_BOOK_USD,
  FUNDING_CARRY_FEE_MULTIPLIER,
  FUNDING_HOLD_DAYS,
  FUNDING_STABILITY_SETTLEMENTS,
  FUNDING_VENUES,
  MAX_GROSS_EXPOSURE_FRACTION,
  REPORTING_SEGMENTS,
  type FundingVenue,
} from '../constants';
import {
  crossVenueEpisodeCostUsd,
  emptyCostBreakdown,
  llmConsultCostUsd,
  mergeCosts,
} from '../costs';
import { buildTrialResult, type EquityPoint } from '../metrics';
import type { TrialResult, VenueFundingSeries } from '../types';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export interface OrderedPair {
  readonly longVenue: FundingVenue;
  readonly shortVenue: FundingVenue;
}

export interface AlignedFundingRow {
  readonly timestamp: number;
  readonly rates: Readonly<Partial<Record<FundingVenue, string>>>;
}

/** Pick lowest-rate venue long, highest-rate short — deterministic tie-break by venue name. */
export function optimalOrderedPair(
  rates: Readonly<Partial<Record<FundingVenue, string>>>,
): OrderedPair | null {
  const entries = FUNDING_VENUES.filter((v) => rates[v] !== undefined).map((v) => ({
    venue: v,
    rate: new Decimal(rates[v]!),
  }));
  if (entries.length < 2) return null;
  entries.sort((a, b) => {
    const cmp = a.rate.comparedTo(b.rate);
    if (cmp !== 0) return cmp;
    return a.venue.localeCompare(b.venue);
  });
  const longVenue = entries[0]!.venue;
  const shortVenue = entries[entries.length - 1]!.venue;
  if (longVenue === shortVenue) return null;
  return { longVenue, shortVenue };
}

export function pairsEqual(a: OrderedPair | null, b: OrderedPair | null): boolean {
  if (!a || !b) return false;
  return a.longVenue === b.longVenue && a.shortVenue === b.shortVenue;
}

export function alignFundingRows(series: readonly VenueFundingSeries[]): AlignedFundingRow[] {
  // Venues stamp settlements with sub-second drift (e.g. Binance ...001Z vs Bybit ...000Z).
  // Bucket to the 8h funding grid so cross-venue rows actually join.
  const BUCKET_MS = 8 * 3_600_000;
  const bucket = (ts: number): number => Math.floor(ts / BUCKET_MS) * BUCKET_MS;
  const byBucket = new Map<number, Partial<Record<FundingVenue, string>>>();
  for (const s of series) {
    for (const row of s.settlements) {
      const b = bucket(row.timestamp);
      const rates = byBucket.get(b) ?? {};
      // Prefer the first rate in a bucket per venue (deterministic).
      if (rates[s.venue as FundingVenue] === undefined) {
        rates[s.venue as FundingVenue] = row.fundingRate;
      }
      byBucket.set(b, rates);
    }
  }
  return [...byBucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, rates]) => ({ timestamp, rates }));
}

export function projected3dCarryUsd(
  longVenue: FundingVenue,
  shortVenue: FundingVenue,
  upcoming: readonly AlignedFundingRow[],
  notionalUsd: Decimal,
): Decimal {
  let carry = new Decimal(0);
  for (const row of upcoming.slice(0, 9)) {
    const lr = row.rates[longVenue];
    const sr = row.rates[shortVenue];
    if (lr === undefined || sr === undefined) break;
    const spread = new Decimal(sr).minus(lr);
    carry = carry.plus(notionalUsd.mul(spread));
  }
  return carry;
}

export function runFundingDispersion3d(params: {
  symbol: string;
  venueSeries: readonly VenueFundingSeries[];
  observedLlmCostUsd?: string | null;
}): TrialResult {
  const aligned = alignFundingRows(params.venueSeries);
  const notional = new Decimal(EFFECTIVE_BOOK_USD).mul(MAX_GROSS_EXPOSURE_FRACTION);
  let equity = new Decimal(EFFECTIVE_BOOK_USD);
  const curve: EquityPoint[] = [{ ts: aligned[0]?.timestamp ?? 0, equityUsd: equity.toFixed() }];
  const segmentCurves: Record<1 | 2 | 3, EquityPoint[]> = { 1: [], 2: [], 3: [] };
  const segmentCycles: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
  let costs = emptyCostBreakdown();
  let stressCosts = emptyCostBreakdown();
  let cycles = 0;
  const symbolPnl: Record<string, string> = { [params.symbol]: '0' };

  let activePair: OrderedPair | null = null;
  let stableCount = 0;
  let entryIdx = -1;
  let lastPair: OrderedPair | null = null;

  for (let i = 0; i < aligned.length; i += 1) {
    const row = aligned[i]!;
    const pair = optimalOrderedPair(row.rates);
    if (pairsEqual(pair, lastPair)) stableCount += 1;
    else stableCount = pair ? 1 : 0;
    lastPair = pair;

    if (!activePair) {
      if (pair && stableCount >= FUNDING_STABILITY_SETTLEMENTS) {
        const upcoming = aligned.slice(i, i + 9);
        const carry = projected3dCarryUsd(pair.longVenue, pair.shortVenue, upcoming, notional);
        const episodeCost = crossVenueEpisodeCostUsd(pair.longVenue, pair.shortVenue, notional);
        const threshold = episodeCost.mul(FUNDING_CARRY_FEE_MULTIPLIER);
        if (carry.gt(threshold)) {
          activePair = pair;
          entryIdx = i;
          cycles += 1;
          equity = equity.minus(episodeCost);
          const llm = llmConsultCostUsd(params.observedLlmCostUsd ?? null);
          equity = equity.minus(llm);
          costs = mergeCosts(costs, {
            feesUsd: episodeCost.toFixed(),
            slippageUsd: '0',
            fundingUsd: '0',
            llmUsd: llm.toFixed(),
            turnoverUsd: '0',
          });
          stressCosts = mergeCosts(stressCosts, {
            feesUsd: episodeCost.mul(2).toFixed(),
            slippageUsd: '0',
            fundingUsd: '0',
            llmUsd: llm.mul(2).toFixed(),
            turnoverUsd: '0',
          });
        }
      }
    } else {
      const daysHeld = i - entryIdx;
      const pairChanged = !pairsEqual(pair, activePair);
      if (daysHeld >= FUNDING_HOLD_DAYS || pairChanged) {
        equity = equity.minus(
          crossVenueEpisodeCostUsd(activePair.longVenue, activePair.shortVenue, notional).div(2),
        );
        activePair = null;
        entryIdx = -1;
        stableCount = 0;
      } else if (pair) {
        const lr = row.rates[pair.longVenue];
        const sr = row.rates[pair.shortVenue];
        if (lr !== undefined && sr !== undefined) {
          const spread = new Decimal(sr).minus(lr);
          const pay = notional.mul(spread);
          equity = equity.plus(pay);
          symbolPnl[params.symbol] = new Decimal(symbolPnl[params.symbol]!).plus(pay).toFixed();
          costs = mergeCosts(costs, {
            ...emptyCostBreakdown(),
            fundingUsd: pay.toFixed(),
          });
        }
      }
    }

    curve.push({ ts: row.timestamp, equityUsd: equity.toFixed() });
    for (const seg of REPORTING_SEGMENTS) {
      if (row.timestamp >= seg.startMs && row.timestamp < seg.endMs) {
        const arr = segmentCurves[seg.id];
        if (arr.length === 0) {
          arr.push({ ts: row.timestamp, equityUsd: equity.toFixed() });
        } else {
          arr.push({ ts: row.timestamp, equityUsd: equity.toFixed() });
        }
      }
    }
  }

  return buildTrialResult({
    trialId: 'funding-dispersion-3d',
    equityCurve: curve,
    segmentCurves,
    segmentCycles,
    costs,
    stress2xCosts: stressCosts,
    turnoverNotionalUsd: notional.mul(cycles).mul(4).toFixed(),
    avgGrossExposureFraction: MAX_GROSS_EXPOSURE_FRACTION,
    symbolPnlUsd: symbolPnl,
    grossPnlUsd: equity.minus(EFFECTIVE_BOOK_USD).toFixed(),
  });
}

export function fundingSign(isLong: boolean, rate: string): 'pay' | 'receive' {
  const r = new Decimal(rate);
  if (r.eq(0)) return 'pay';
  if (isLong) return r.gt(0) ? 'pay' : 'receive';
  return r.gt(0) ? 'receive' : 'pay';
}

export function settlementPaymentUsd(isLong: boolean, notionalUsd: Decimal, rate: string): Decimal {
  const signedQty = isLong ? notionalUsd : notionalUsd.neg();
  return fundingPayment(signedQty, new Decimal(1), new Decimal(rate));
}
