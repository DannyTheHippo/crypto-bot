import Decimal from 'decimal.js';
import {
  walkRoundTrips,
  type RoundTripFill,
  type ClosedRoundTrip,
} from '../../src/domain/trading/risk/round-trips';
import type { RawCandle } from './exit-simulator';

// ── Live-frame marking, shared by frame-audit.spec.ts and exit-attribution.spec.ts ────────────────
//
// Backlog 57: market data runs FEED_ENV=live while orders execute against SANDBOX_ENV=demo
// (market-streams.module.ts:77-79), so every recorded fill is priced in the DEMO frame while every
// OHLCV-based study (this cache) prices in the LIVE frame. This module marks a demo-frame fill to
// the live frame via the cached 15m OHLCV grid, and partitions fills into the SAME cycles
// walkRoundTrips already closed — it never re-derives WHEN a cycle closes (the dust/peakNotional
// fold in round-trips.ts stays the single source of that decision).

const OPEN = 1;

/**
 * Linear interpolation of the live-frame series between consecutive bar OPEN prices, treating each
 * bar's open as a price sample AT its own open timestamp (bars are contiguous, so a bar's open is
 * ~= the prior bar's close). Returns null outside the grid — before the first bar, or beyond the
 * last bar's own window — a GRID MISS, never silently extrapolated. Carries +-7.5min of drift as
 * noise (half the 15m bar width) for any ts that does not land exactly on a knot.
 */
export function livePriceAt(candles: readonly RawCandle[], ts: number): Decimal | null {
  if (candles.length === 0) return null;
  const first = candles[0]!;
  if (ts < first[0]) return null;
  for (let i = 0; i < candles.length - 1; i += 1) {
    const cur = candles[i]!;
    const next = candles[i + 1]!;
    if (ts >= cur[0] && ts <= next[0]) {
      const span = next[0] - cur[0];
      if (span <= 0) return new Decimal(cur[OPEN]);
      const frac = (ts - cur[0]) / span;
      const openCur = new Decimal(cur[OPEN]);
      const openNext = new Decimal(next[OPEN]);
      return openCur.plus(openNext.minus(openCur).mul(frac));
    }
  }
  const last = candles[candles.length - 1]!;
  const barMs = candles.length >= 2 ? candles[1]![0] - candles[0]![0] : 900_000;
  if (ts <= last[0] + barMs) return new Decimal(last[OPEN]); // still inside the final bar's window
  return null;
}

/**
 * Slices `fills` into the SAME cycles `cycles` already closed, aligned 1:1 with `cycles` (same
 * order, same length). Groups by (strategyId, symbol) exactly as walkRoundTrips does (trivial
 * partitioning by key, not the closure rule).
 *
 * Cutting membership on `fill.executedAt === cycle.closedAt` was tried first and is WRONG: two
 * fills in the same group can share a millisecond timestamp (the query's own fill_id tiebreak
 * exists for exactly this reason), so a timestamp match can land on the wrong fill and silently
 * misassign every fill in that group from that point on. Instead this re-derives each group's own
 * boundaries by calling the REAL walkRoundTrips repeatedly on that group's growing prefix and
 * watching `cycles.length` increase — the closure RULE (dust/peakNotional) is never re-implemented,
 * only probed via the production function itself, so the boundary is exactly what walkRoundTrips
 * would have decided for these fills in isolation (correct because groups never interact: the fold
 * is keyed per (strategyId, symbol) and one group's fills never affect another's cycle state).
 */
export function partitionFillsIntoCycles<F extends RoundTripFill>(
  fills: readonly F[],
  cycles: readonly ClosedRoundTrip[],
  dustNotional: Decimal,
): readonly (readonly F[])[] {
  const groups = new Map<string, F[]>();
  for (const f of fills) {
    if (f.strategyId === null || f.side === null) continue;
    const key = `${f.strategyId} ${f.symbol}`;
    const arr = groups.get(key);
    if (arr) arr.push(f);
    else groups.set(key, [f]);
  }

  // For each group, the 0-based fill index that closed each successive cycle.
  const boundariesByKey = new Map<string, number[]>();
  for (const [key, groupFills] of groups) {
    const boundaries: number[] = [];
    let prevCount = 0;
    for (let k = 1; k <= groupFills.length; k += 1) {
      const { cycles: prefixCycles } = walkRoundTrips(groupFills.slice(0, k), dustNotional);
      if (prefixCycles.length > prevCount) {
        boundaries.push(k - 1);
        prevCount = prefixCycles.length;
      }
    }
    boundariesByKey.set(key, boundaries);
  }

  const cursors = new Map<string, number>(); // next un-consumed boundary index, per group key
  const startByKey = new Map<string, number>(); // next un-consumed fill index, per group key
  return cycles.map((c) => {
    const key = `${c.strategyId} ${c.symbol}`;
    const groupFills = groups.get(key) ?? [];
    const boundaries = boundariesByKey.get(key) ?? [];
    const bIdx = cursors.get(key) ?? 0;
    const start = startByKey.get(key) ?? 0;
    if (bIdx >= boundaries.length) return [];
    const end = boundaries[bIdx]!;
    cursors.set(key, bIdx + 1);
    startByKey.set(key, end + 1);
    return groupFills.slice(start, end + 1);
  });
}

export interface CycleFrameStats {
  /** Recomputed from `members` alone; MUST equal the source cycle's realizedPnl or the partition
   *  above sliced this cycle wrong (a tied closing timestamp inside one group) and must not be used. */
  readonly demoPnlCheck: Decimal;
  /** proceeds - cost with every fill marked at the interpolated live price instead of its own demo
   *  fill price; gross of fees, same convention as ClosedRoundTrip.realizedPnl. */
  readonly livePnl: Decimal;
  /** Buy-side VWAP in the live frame (cost / boughtQty using live marks), null with no live-priced
   *  BUY fill in the cycle (either no BUY fill, or every BUY fill was a grid miss). */
  readonly liveEntryVwap: Decimal | null;
  readonly turnover: Decimal; // demoCost + demoProceeds, i.e. total notional traded both legs
  readonly gridMisses: number;
  readonly fillCount: number;
  readonly closingLiquidity: 'maker' | 'taker' | null;
}

export function computeCycleFrameStats<
  F extends RoundTripFill & { readonly liquidity?: 'maker' | 'taker' | null },
>(
  members: readonly F[],
  closedAt: number,
  candlesFor: (symbol: string) => readonly RawCandle[] | null,
): CycleFrameStats {
  let demoCost = new Decimal(0);
  let demoProceeds = new Decimal(0);
  let liveCost = new Decimal(0);
  let liveProceeds = new Decimal(0);
  let liveBoughtQty = new Decimal(0);
  let gridMisses = 0;
  let closingLiquidity: 'maker' | 'taker' | null = null;

  for (const f of members) {
    const qty = new Decimal(f.qty);
    const price = new Decimal(f.price);
    const notional = qty.mul(price);
    const candles = candlesFor(f.symbol);
    const livePx = candles ? livePriceAt(candles, f.executedAt) : null;
    if (livePx === null) gridMisses += 1;

    if (f.side === 'BUY') {
      demoCost = demoCost.plus(notional);
      if (livePx !== null) {
        liveCost = liveCost.plus(qty.mul(livePx));
        liveBoughtQty = liveBoughtQty.plus(qty);
      }
    } else {
      demoProceeds = demoProceeds.plus(notional);
      if (livePx !== null) liveProceeds = liveProceeds.plus(qty.mul(livePx));
    }
    if (f.executedAt === closedAt) closingLiquidity = f.liquidity ?? null;
  }

  return {
    demoPnlCheck: demoProceeds.minus(demoCost),
    livePnl: liveProceeds.minus(liveCost),
    liveEntryVwap: liveBoughtQty.gt(0) ? liveCost.div(liveBoughtQty) : null,
    turnover: demoCost.plus(demoProceeds),
    gridMisses,
    fillCount: members.length,
    closingLiquidity,
  };
}

// ── Cluster bootstrap, ported from scripts/loop-forward-return-core.mjs's clusterBootstrap ────────
//
// Same resample unit (base asset, not symbol string, not row) for the same reason documented there:
// spot BTC/USDT and perp BTC/USDT:USDT are near-collinear, not independent draws. Sort-before-
// resample keeps a frozen seed byte-identical across reruns regardless of psql row order.

export function baseAssetOf(symbol: string): string {
  const i = symbol.indexOf('/');
  return i === -1 ? symbol : symbol.slice(0, i);
}

export function makeRand(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export function clusterBootstrap(
  obs: readonly { readonly symbol: string; readonly value: number }[],
  rand: () => number,
  nBoot: number,
): number[] {
  const byAsset = new Map<string, number[]>();
  for (const o of obs) {
    const key = baseAssetOf(o.symbol);
    const list = byAsset.get(key);
    if (list) list.push(o.value);
    else byAsset.set(key, [o.value]);
  }
  const clusters = [...byAsset.keys()].sort().map((k) => byAsset.get(k)!);
  const draws: number[] = [];
  for (let b = 0; b < nBoot; b += 1) {
    let sum = 0;
    let count = 0;
    for (let k = 0; k < clusters.length; k += 1) {
      const pick = clusters[(rand() * clusters.length) | 0]!;
      for (const v of pick) {
        sum += v;
        count += 1;
      }
    }
    if (count > 0) draws.push(sum / count);
  }
  draws.sort((a, b) => a - b);
  return draws;
}
