import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { walkRoundTrips, type RoundTripFill } from '../../src/domain/trading/risk/round-trips';
import type { RawCandle } from './exit-simulator';
import {
  partitionFillsIntoCycles,
  computeCycleFrameStats,
  baseAssetOf,
  makeRand,
  clusterBootstrap,
} from './live-frame';

// ── Frame-audit study (backlog 57) ────────────────────────────────────────────
//
// Study: research/studies/frame-audit-2026-08-03.md.
//
// Question: market data runs FEED_ENV=live while orders execute against SANDBOX_ENV=demo
// (market-streams.module.ts:77-79). Recorded fills are therefore priced in the DEMO frame while
// every OHLCV-based replay prices in the LIVE frame. How much of the recorded PnL is an artifact of
// that decoupling?
//
// Cycle boundaries are OWNED by walkRoundTrips (the same fold the promotion gate runs) and are
// never re-derived here — only the MARKS are substituted, via live-frame.ts's
// partitionFillsIntoCycles/computeCycleFrameStats. A cycle whose recomputed demo pnl does not match
// walkRoundTrips's own realizedPnl is a partition failure and is EXCLUDED, never silently reported.
//
// A constant basis difference between the two frames contributes exactly zero to a closed cycle's
// artifact (sgn*qty sums to ~0 over BUY and SELL legs) — this measures the CHANGE in basis between
// the legs, i.e. an episodic divergence, not a standing offset.
//
// Gated like the sibling live evals: FRAME_AUDIT=1 + DATABASE_URL, self-skips otherwise. Read-only
// against fills/order_intents — never a write, never a reset.

const RUN = process.env['FRAME_AUDIT'] === '1';
const DB_URL = process.env['DATABASE_URL'];
const OUT_FILE = process.env['FRAME_AUDIT_OUTPUT_FILE'];

const EPOCH_MS = Date.parse('2026-07-21T11:21:00Z');
const DUST_NOTIONAL = '5'; // PROMOTION_DUST_NOTIONAL — same closure rule as the promotion gate
const DATA_DIR = join(__dirname, 'data');
const N_BOOT = 20_000;
const BOOTSTRAP_SEED = 20260803; // frozen for this study; sort-before-resample buys determinism

/** ohlcv-*.json keys strip the `/` and `:` separators: BTC/USDT:USDT -> BTCUSDTUSDT. */
function candlesFor(symbol: string): readonly RawCandle[] | null {
  const path = join(DATA_DIR, `ohlcv-${symbol.replace(/[/:]/g, '')}-15m.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as RawCandle[];
}

interface TripArtifact {
  readonly symbol: string;
  readonly openedAt: number;
  readonly closedAt: number;
  readonly pnlDemoUsd: Decimal;
  readonly pnlLiveUsd: Decimal;
  readonly pnlDemoBps: number;
  readonly pnlLiveBps: number;
  readonly artifactBps: number;
  readonly closingLiquidity: 'maker' | 'taker' | null;
  readonly gridMisses: number;
  readonly fillCount: number;
}

describe.skipIf(!RUN || !DB_URL)(
  'frame-audit: how much recorded PnL is a demo/live frame artifact',
  () => {
    it('measures artifact_bps over the recorded round trips, clustered by base asset', async () => {
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: DB_URL });
      const lines: string[] = [];
      try {
        // Mirrors PromotionStatsRepository.fillsForMode / exit-attribution.spec.ts:104-125 verbatim
        // (same join, same predicate, same ordering incl. the fill_id tiebreak), plus `liquidity` for
        // the maker/taker channel split.
        const fillsRes = await pool.query<{
          strategy_id: string | null;
          symbol: string;
          side: 'BUY' | 'SELL' | null;
          qty: string;
          price: string;
          fee_amount: string | null;
          fee_ccy: string | null;
          venue_timestamp: string;
          liquidity: 'maker' | 'taker';
        }>(
          `SELECT oi.strategy_id, f.symbol, oi.side, f.qty, f.price, f.fee_amount, f.fee_ccy,
                f.venue_timestamp, f.liquidity
           FROM fills f
           LEFT JOIN order_intents oi ON f.intent_id = oi.intent_id
          WHERE f.mode = 'testnet' AND f.venue_timestamp >= $1
          ORDER BY f.venue_timestamp ASC, f.fill_id ASC`,
          [EPOCH_MS],
        );

        const fills: (RoundTripFill & { liquidity: 'maker' | 'taker' })[] = fillsRes.rows.map(
          (r) => ({
            strategyId: r.strategy_id,
            symbol: r.symbol,
            side: r.side,
            qty: r.qty,
            price: r.price,
            fee: r.fee_amount,
            feeAsset: r.fee_ccy,
            executedAt: Number(r.venue_timestamp),
            liquidity: r.liquidity,
          }),
        );

        const dustNotional = new Decimal(DUST_NOTIONAL);
        const { cycles } = walkRoundTrips(fills, dustNotional);
        expect(cycles.length).toBeGreaterThan(0);

        const parts = partitionFillsIntoCycles(fills, cycles, dustNotional);

        const trips: TripArtifact[] = [];
        let partitionMismatches = 0;
        let noCandles = 0;
        let totalGridMisses = 0;
        let totalFills = 0;

        for (let i = 0; i < cycles.length; i += 1) {
          const c = cycles[i]!;
          const members = parts[i]!;
          totalFills += members.length;
          if (candlesFor(c.symbol) === null) {
            noCandles += 1;
            continue;
          }
          const stats = computeCycleFrameStats(members, c.closedAt, candlesFor);
          // The partition MUST reproduce the real fold's own answer before anything downstream is
          // trusted — a tied closing timestamp inside one (strategyId, symbol) group is the only way
          // this could disagree, and it fails the trip OPEN (excluded) rather than reporting a wrong
          // number.
          if (!stats.demoPnlCheck.eq(c.realizedPnl)) {
            partitionMismatches += 1;
            continue;
          }
          if (stats.turnover.lte(0)) continue;
          totalGridMisses += stats.gridMisses;

          const artifactBps = c.realizedPnl
            .minus(stats.livePnl)
            .div(stats.turnover.div(2))
            .mul(10_000);
          trips.push({
            symbol: c.symbol,
            openedAt: c.openedAt,
            closedAt: c.closedAt,
            pnlDemoUsd: c.realizedPnl,
            pnlLiveUsd: stats.livePnl,
            pnlDemoBps: c.realizedPnl.div(stats.turnover.div(2)).mul(10_000).toNumber(),
            pnlLiveBps: stats.livePnl.div(stats.turnover.div(2)).mul(10_000).toNumber(),
            artifactBps: artifactBps.toNumber(),
            closingLiquidity: stats.closingLiquidity,
            gridMisses: stats.gridMisses,
            fillCount: stats.fillCount,
          });
        }

        const mean = (xs: readonly number[]): number =>
          xs.length === 0 ? NaN : xs.reduce((s, x) => s + x, 0) / xs.length;
        const median = (xs: readonly number[]): number => {
          if (xs.length === 0) return NaN;
          const sorted = [...xs].sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
        };

        // A trip with ANY grid-missed fill has an incomplete live-frame leg (typically the whole
        // BUY or SELL side excluded), which manufactures a nonsensical lopsided "pnl" rather than a
        // measurement — these are EXCLUDED from every aggregate below and reported separately,
        // never silently averaged in.
        const measurable = trips.filter((t) => t.gridMisses === 0);
        const excludedForMisses = trips.filter((t) => t.gridMisses > 0);

        const artifacts = measurable.map((t) => t.artifactBps);
        const demoBps = measurable.map((t) => t.pnlDemoBps);
        const liveBps = measurable.map((t) => t.pnlLiveBps);
        const obs = measurable.map((t) => ({ symbol: t.symbol, value: t.artifactBps }));
        const clusters = new Set(measurable.map((t) => baseAssetOf(t.symbol))).size;
        const draws = clusterBootstrap(obs, makeRand(BOOTSTRAP_SEED), N_BOOT);
        const ciLo = draws.length > 0 ? draws[Math.floor(0.025 * draws.length)]! : NaN;
        const ciHi = draws.length > 0 ? draws[Math.floor(0.975 * draws.length)]! : NaN;
        const pAbsGe50 =
          measurable.length > 0
            ? measurable.filter((t) => Math.abs(t.artifactBps) >= 50).length / measurable.length
            : NaN;

        const makerTrips = measurable.filter((t) => t.closingLiquidity === 'maker');
        const takerTrips = measurable.filter((t) => t.closingLiquidity === 'taker');

        const sortedByArtifact = [...measurable].sort((a, b) => b.artifactBps - a.artifactBps);
        const topPositive = sortedByArtifact.slice(0, 3);
        const topNegative = sortedByArtifact.slice(-3).reverse();

        const totalDemoPnl = measurable.reduce((s, t) => s.plus(t.pnlDemoUsd), new Decimal(0));
        const totalLivePnl = measurable.reduce((s, t) => s.plus(t.pnlLiveUsd), new Decimal(0));

        lines.push(
          `[frame-audit] epoch=${new Date(EPOCH_MS).toISOString()} fills=${fills.length} ` +
            `cycles=${cycles.length} trips=${trips.length} measurable=${measurable.length} ` +
            `excludedForGridMiss=${excludedForMisses.length} partitionMismatches=${partitionMismatches} ` +
            `noCandles=${noCandles} gridMisses=${totalGridMisses}/${totalFills}`,
          '',
          '--- per-trip (all closed cycles; MISS rows excluded from every aggregate below) ---',
          ...trips.map(
            (t) =>
              `  ${t.gridMisses > 0 ? 'MISS ' : '     '}${t.symbol.padEnd(18)} demo=${t.pnlDemoBps.toFixed(1).padStart(8)}bps ` +
              `live=${t.pnlLiveBps.toFixed(1).padStart(8)}bps artifact=${t.artifactBps.toFixed(1).padStart(8)}bps ` +
              `close=${(t.closingLiquidity ?? 'null').padEnd(5)} misses=${t.gridMisses}/${t.fillCount} ` +
              `held=${(((t.closedAt - t.openedAt) / 3_600_000).toFixed(2) + 'h').padStart(8)} ` +
              `opened=${new Date(t.openedAt).toISOString()}`,
          ),
          '',
          '--- aggregate (n=' +
            measurable.length +
            ' measurable trips of ' +
            trips.length +
            ' closed) ---',
          `demo-frame gross realised   $${totalDemoPnl.toFixed(2)}  mean=${mean(demoBps).toFixed(1)}bps/trip`,
          `live-frame gross realised   $${totalLivePnl.toFixed(2)}  mean=${mean(liveBps).toFixed(1)}bps/trip`,
          `artifact_bps                mean=${mean(artifacts).toFixed(1)} median=${median(artifacts).toFixed(2)} ` +
            `clusters=${clusters} CI95=[${ciLo.toFixed(1)}, ${ciHi.toFixed(1)}] P(|artifact|>=50bps)=${pAbsGe50.toFixed(4)}`,
          `channel split                taker(n=${takerTrips.length}) mean=${mean(takerTrips.map((t) => t.artifactBps)).toFixed(1)}bps  ` +
            `maker(n=${makerTrips.length}) mean=${mean(makerTrips.map((t) => t.artifactBps)).toFixed(1)}bps`,
          '',
          '--- top positive artifact (flattering demo) ---',
          ...topPositive.map(
            (t) =>
              `  ${t.symbol.padEnd(18)} ${t.artifactBps.toFixed(1).padStart(8)}bps close=${t.closingLiquidity} ` +
              `opened=${new Date(t.openedAt).toISOString()} closed=${new Date(t.closedAt).toISOString()}`,
          ),
          '--- top negative artifact (penalising demo) ---',
          ...topNegative.map(
            (t) =>
              `  ${t.symbol.padEnd(18)} ${t.artifactBps.toFixed(1).padStart(8)}bps close=${t.closingLiquidity} ` +
              `opened=${new Date(t.openedAt).toISOString()} closed=${new Date(t.closedAt).toISOString()}`,
          ),
        );

        const out = lines.join('\n');
        console.log(out);
        if (OUT_FILE) writeFileSync(OUT_FILE, `${out}\n`, 'utf8');

        // The study must actually have measured something; the verdict is recorded by hand in the
        // study writeup, never asserted here (a green test must never imply a positive result).
        expect(partitionMismatches).toBe(0);
        expect(trips.length).toBeGreaterThan(0);
      } finally {
        await pool.end();
      }
    }, 120_000);
  },
);
