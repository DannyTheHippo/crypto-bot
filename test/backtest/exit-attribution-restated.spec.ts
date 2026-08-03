import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { walkRoundTrips } from '../../src/domain/trading/risk/round-trips';
import { simulateExit, type ExitReason, type RawCandle, type Side } from './exit-simulator';
import { partitionFillsIntoCycles, computeCycleFrameStats } from './live-frame';
import {
  measureFeeSchedule,
  openingSideOf,
  anchorVwapOf,
  openingQtyOf,
  openingLegFeeRate,
  exitLegLiquidity,
  netReturnOf,
  type CostFill,
  type CostModel,
  type Liquidity,
  type MeasuredFeeSchedule,
} from './restated-cost';

// ── Exit-attribution RESTATEMENT (2026-08-03) ────────────────────────────────────────────────────
//
// Study: research/studies/exit-attribution-restated-2026-08-03.md.
// Amends (never rewrites) the frozen pre-registration research/studies/edge-verdict-2026-08-10.md,
// whose verdict lands 2026-08-10 on cells produced by test/backtest/exit-attribution.spec.ts.
//
// That spec has two MEASUREMENT defects. Neither is fixed there — its published cells are frozen and
// are reported here BESIDE the restatement, with a per-arm delta:
//
//   (a) COST BASIS. `ROUND_TRIP_FEE='0.002'` is the binance SPOT schedule (10 bps/leg, maker=taker,
//       exact). The book is ~85% `binanceusdm` by notional at 2 bps maker / 4-5 bps taker per leg
//       (fee-floor-derivation-2026-07-31.md § 2). The study bills ~2.15x the real cost on most trips.
//   (b) ENTRY ANCHOR. `entryVwap` is `cost / boughtQty` — BUY-side only (round-trips.ts:201). On a
//       SHORT trip the BUYs are the COVER, so the EXIT price is used as the entry anchor. Verified
//       live on TRUMP/USDT:USDT (16 SELL @1.561 opening, one BUY @1.593 covering, entryVwap=1.593).
//
// FIVE passes over ONE population, so every delta is attributable to exactly one change:
//
//   control        buy-side anchor, decision side, flat 20 bps   -> must reproduce the frozen cells
//   fees-only      buy-side anchor, decision side, measured fees -> isolates defect (a)
//   anchor-only    opening-leg anchor, fill side, flat 20 bps    -> isolates defect (b)
//   RESTATED       opening-leg anchor, fill side, measured fees  -> both
//   RESTATED/taker as RESTATED, every counterfactual exit leg priced TAKER (sensitivity on the one
//                  modelling judgement in the cost model — see restate-cost.ts exitLegLiquidity)
//
// The population defaults to the pre-registration's own freeze cutoff (fills before
// 2026-07-27T16:00:00Z: 175 fills, 61 entry decisions, the frozen run's own inputs) so the control
// pass is a LIKE-FOR-LIKE reproduction of the published table rather than a different book. Override
// with EXIT_ATTRIBUTION_RESTATED_UNTIL_MS to restate over the current book.
//
// The cycle-closure rule is untouched: walkRoundTrips is imported and used, never reimplemented — a
// second walk would be a second source of truth for the number the promotion gate returns.
//
// Gated like the sibling live evals: EXIT_ATTRIBUTION_RESTATED=1 + DATABASE_URL, self-skips
// otherwise, and never joins the production gate. Read-only against fills/order_intents/
// agent_decisions — never a write, never a reset.

const RUN = process.env['EXIT_ATTRIBUTION_RESTATED'] === '1';
const DB_URL = process.env['DATABASE_URL'];
const OUT_FILE = process.env['EXIT_ATTRIBUTION_RESTATED_OUTPUT_FILE'];

const EPOCH_MS = Date.parse('2026-07-21T11:21:00Z');
/** The frozen run's own population bound: the 176th post-epoch fill lands 2026-07-27T20:15:32Z. */
const DEFAULT_UNTIL_MS = Date.parse('2026-07-27T16:00:00Z');
const UNTIL_MS = Number(
  process.env['EXIT_ATTRIBUTION_RESTATED_UNTIL_MS'] ?? String(DEFAULT_UNTIL_MS),
);
// The OHLCV cache under test/backtest/data/ has been REFRESHED since the frozen run (it now reaches
// 2026-07-31T20:45Z), so replaying with today's cache hands every arm forward bars the frozen run
// did not have and resolves trips it excluded under the openAtEnd rule. Forward bars are therefore
// bounded at the same instant as the fill population: no arm may see past the freeze. Set
// EXIT_ATTRIBUTION_RESTATED_BARS_UNTIL_MS to a later bound to replay on the full cache instead.
const BARS_UNTIL_MS = Number(
  process.env['EXIT_ATTRIBUTION_RESTATED_BARS_UNTIL_MS'] ?? String(UNTIL_MS),
);

const DUST_NOTIONAL = '5'; // PROMOTION_DUST_NOTIONAL — same closure rule as the promotion gate
const FROZEN_ROUND_TRIP_FEE = '0.002'; // the frozen spec's constant, reproduced, never adopted
const DATA_DIR = join(__dirname, 'data');

const STOP_MULTIPLES = ['1', '1.5', '2', '3'] as const;
const TP_MULTIPLES = ['0.5', '1', '2'] as const;
const CELL_KEYS: readonly string[] = [
  ...STOP_MULTIPLES.flatMap((sm) => TP_MULTIPLES.map((tm) => `${sm}|${tm}`)),
  'timeonly',
  'nostop',
];

interface EntryDecision {
  readonly strategyId: string;
  readonly symbol: string;
  readonly eventTime: number;
  readonly side: Side;
  readonly stopLossPct: string;
  readonly takeProfitPct: string;
  readonly maxHoldBars: number;
}

/** ohlcv-*.json keys strip the `/` and `:` separators: BTC/USDT:USDT -> BTCUSDTUSDT. */
function candlesFor(symbol: string): readonly RawCandle[] | null {
  const path = join(DATA_DIR, `ohlcv-${symbol.replace(/[/:]/g, '')}-15m.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as RawCandle[];
}

/** Bars strictly after `afterMs`, i.e. the forward path a position actually lived through. */
function barsAfter(candles: readonly RawCandle[], afterMs: number): readonly RawCandle[] {
  return candles.filter((c) => c[0] > afterMs && c[0] < BARS_UNTIL_MS);
}

interface ArmAccumulator {
  readonly label: string;
  trips: number;
  wins: number;
  sum: Decimal;
  excluded: number;
  stops: number;
  takeProfits: number;
  maxHolds: number;
}

function newArm(label: string): ArmAccumulator {
  return {
    label,
    trips: 0,
    wins: 0,
    sum: new Decimal(0),
    excluded: 0,
    stops: 0,
    takeProfits: 0,
    maxHolds: 0,
  };
}

function meanBps(arm: ArmAccumulator): Decimal {
  return arm.trips > 0 ? arm.sum.div(arm.trips).mul(10_000) : new Decimal(0);
}

function hitPct(arm: ArmAccumulator): Decimal {
  return arm.trips > 0 ? new Decimal(arm.wins).div(arm.trips).mul(100) : new Decimal(0);
}

function summarise(arm: ArmAccumulator): string {
  return (
    `${arm.label.padEnd(30)} trips=${String(arm.trips).padStart(3)} ` +
    `hit=${hitPct(arm).toFixed(1).padStart(5)}% meanNet=${meanBps(arm).toFixed(1).padStart(8)}bps ` +
    `stop/tp/hold=${arm.stops}/${arm.takeProfits}/${arm.maxHolds} excl=${arm.excluded}`
  );
}

/** Cell label shared by every pass, so the five tables line up row for row. */
function cellLabel(key: string): string {
  if (key === 'timeonly') return 'Arm3 time-stop only';
  if (key === 'nostop') return 'Arm3 no take-profit';
  const [sm, tm] = key.split('|');
  return `Arm3 stop x${sm} tp x${tm}`;
}

interface PassConfig {
  readonly label: string;
  readonly anchor: 'buy-vwap' | 'opening-leg';
  readonly sideSource: 'decision' | 'fills';
  readonly cost: 'flat20' | 'measured';
  readonly exitLiquidity: 'by-reason' | 'taker';
}

interface PassResult {
  readonly config: PassConfig;
  readonly arm1: ArmAccumulator;
  readonly arm2: ArmAccumulator;
  readonly arm3: Map<string, ArmAccumulator>;
}

/** One usable cycle, with everything both defect axes need precomputed. */
interface Trip {
  readonly symbol: string;
  readonly venue: string;
  readonly decisionSide: Side;
  readonly fillSide: Side;
  readonly buyVwap: Decimal;
  readonly openingVwap: Decimal;
  readonly boughtQty: Decimal;
  readonly soldQty: Decimal;
  readonly realizedPnl: Decimal;
  readonly feesQuote: Decimal;
  /** Measured opening-leg fee fraction, keyed by which side the pass treats as the opening leg. */
  readonly openingFeeRate: Readonly<Record<Side, Decimal>>;
  readonly exitRate: Readonly<Record<Liquidity, Decimal>>;
  readonly stopLossPct: string;
  readonly takeProfitPct: string;
  readonly maxHoldBars: number;
  readonly forward: readonly RawCandle[];
}

const PASSES: readonly PassConfig[] = [
  {
    label: 'CONTROL (frozen spec)',
    anchor: 'buy-vwap',
    sideSource: 'decision',
    cost: 'flat20',
    exitLiquidity: 'by-reason',
  },
  {
    label: 'FEES-ONLY restated',
    anchor: 'buy-vwap',
    sideSource: 'decision',
    cost: 'measured',
    exitLiquidity: 'by-reason',
  },
  {
    label: 'ANCHOR-ONLY restated',
    anchor: 'opening-leg',
    sideSource: 'fills',
    cost: 'flat20',
    exitLiquidity: 'by-reason',
  },
  {
    label: 'RESTATED (both)',
    anchor: 'opening-leg',
    sideSource: 'fills',
    cost: 'measured',
    exitLiquidity: 'by-reason',
  },
  {
    label: 'RESTATED all-taker exits',
    anchor: 'opening-leg',
    sideSource: 'fills',
    cost: 'measured',
    exitLiquidity: 'taker',
  },
];

function runPass(config: PassConfig, trips: readonly Trip[]): PassResult {
  const arm1 = newArm('Arm1 actual (discretionary)');
  const arm2 = newArm('Arm2 declared plan, mechanical');
  const arm3 = new Map<string, ArmAccumulator>();
  for (const key of CELL_KEYS) arm3.set(key, newArm(cellLabel(key)));

  for (const t of trips) {
    const side = config.sideSource === 'decision' ? t.decisionSide : t.fillSide;
    const entryPrice = config.anchor === 'buy-vwap' ? t.buyVwap : t.openingVwap;
    const qty = side === 'long' ? t.boughtQty : t.soldQty;
    const notional = entryPrice.mul(qty);

    // ARM 1 — what actually happened. realizedPnl is GROSS of fees by contract (round-trips.ts
    // header) and feesQuote is the trip's OWN measured fee, so Arm 1 already carries the real cost
    // in every pass; only the anchor NOTIONAL (the denominator) differs across passes.
    if (notional.gt(0)) {
      const actualNet = t.realizedPnl.minus(t.feesQuote).div(notional);
      arm1.trips += 1;
      arm1.sum = arm1.sum.plus(actualNet);
      if (actualNet.gt(0)) arm1.wins += 1;
    }

    const costFor = (reason: ExitReason): CostModel => {
      if (config.cost === 'flat20') {
        return { kind: 'flat', roundTrip: new Decimal(FROZEN_ROUND_TRIP_FEE) };
      }
      const liq: Liquidity = config.exitLiquidity === 'taker' ? 'taker' : exitLegLiquidity(reason);
      return { kind: 'measured', entryRate: t.openingFeeRate[side], exitRate: t.exitRate[liq] };
    };

    const run = (
      arm: ArmAccumulator,
      stopLossPct: string | null,
      takeProfitPct: string | null,
    ): void => {
      const outcome = simulateExit({
        side,
        entryPrice: entryPrice.toString(),
        stopLossPct,
        takeProfitPct,
        maxHoldBars: t.maxHoldBars,
        bars: t.forward,
        resolution: 'intrabar',
        // Fees are applied by netReturnOf below so that ONE code path prices every pass; the
        // simulator's own flat-fee subtraction is switched off rather than double-counted.
        roundTripFee: '0',
      });
      if (outcome === null) {
        arm.excluded += 1;
        return;
      }
      const net = netReturnOf({
        side,
        entryPrice,
        exitPrice: new Decimal(outcome.exitPrice),
        cost: costFor(outcome.reason),
      });
      arm.trips += 1;
      arm.sum = arm.sum.plus(net);
      if (net.gt(0)) arm.wins += 1;
      if (outcome.reason === 'stop') arm.stops += 1;
      else if (outcome.reason === 'take_profit') arm.takeProfits += 1;
      else arm.maxHolds += 1;
    };

    run(arm2, t.stopLossPct, t.takeProfitPct);
    for (const sm of STOP_MULTIPLES) {
      for (const tm of TP_MULTIPLES) {
        run(
          arm3.get(`${sm}|${tm}`)!,
          new Decimal(t.stopLossPct).mul(sm).toString(),
          new Decimal(t.takeProfitPct).mul(tm).toString(),
        );
      }
    }
    run(arm3.get('timeonly')!, null, null);
    run(arm3.get('nostop')!, t.stopLossPct, null);
  }

  return { config, arm1, arm2, arm3 };
}

function scheduleLines(schedule: MeasuredFeeSchedule): string[] {
  return schedule.rows.map(
    (r) =>
      `  ${r.venue.padEnd(12)} ${r.liquidity.padEnd(5)} ${r.rate.mul(10_000).toFixed(4).padStart(8)} bps/leg ` +
      `fills=${String(r.fills).padStart(3)} notional=$${r.notional.toFixed(2).padStart(9)}`,
  );
}

describe.skipIf(!RUN || !DB_URL)(
  'exit-attribution RESTATED: measured fees + side-aware anchor',
  () => {
    it('reruns the frozen grid under a corrected cost basis and entry anchor', async () => {
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: DB_URL });
      const lines: string[] = [];
      try {
        // Mirrors exit-attribution.spec.ts's query verbatim (same join, same predicate, same ordering
        // incl. the fill_id same-millisecond tiebreak) plus `venue` and `liquidity` for the measured
        // cost basis, and bounded above so the control pass replays the frozen run's own population.
        const fillsRes = await pool.query<{
          strategy_id: string | null;
          symbol: string;
          side: 'BUY' | 'SELL' | null;
          qty: string;
          price: string;
          fee_amount: string | null;
          fee_ccy: string | null;
          venue_timestamp: string;
          ref_price: string | null;
          venue: string;
          liquidity: Liquidity;
        }>(
          `SELECT oi.strategy_id, f.symbol, oi.side, f.qty, f.price, f.fee_amount, f.fee_ccy,
                f.venue_timestamp, oi.ref_price, f.venue, f.liquidity
           FROM fills f
           LEFT JOIN order_intents oi ON f.intent_id = oi.intent_id
          WHERE f.mode = 'testnet' AND f.venue_timestamp >= $1 AND f.venue_timestamp < $2
          ORDER BY f.venue_timestamp ASC, f.fill_id ASC`,
          [EPOCH_MS, UNTIL_MS],
        );

        const fills: CostFill[] = fillsRes.rows.map((r) => ({
          strategyId: r.strategy_id,
          symbol: r.symbol,
          side: r.side,
          qty: r.qty,
          price: r.price,
          fee: r.fee_amount,
          feeAsset: r.fee_ccy,
          executedAt: Number(r.venue_timestamp),
          refPrice: r.ref_price,
          venue: r.venue,
          liquidity: r.liquidity,
        }));

        const dustNotional = new Decimal(DUST_NOTIONAL);
        const { cycles, unconvertibleFeeAsset } = walkRoundTrips(fills, dustNotional);
        expect(cycles.length).toBeGreaterThan(0);

        const schedule = measureFeeSchedule(fills);
        const parts = partitionFillsIntoCycles(fills, cycles, dustNotional);

        const decRes = await pool.query<{
          strategy_id: string;
          symbol: string;
          event_time: string;
          action: string;
          stop_loss_pct: string | null;
          take_profit_pct: string | null;
          max_hold_bars: string | null;
        }>(
          `SELECT strategy_id, symbol, event_time, action,
                plan_json->>'stopLossPct'   AS stop_loss_pct,
                plan_json->>'takeProfitPct' AS take_profit_pct,
                plan_json->>'maxHoldBars'   AS max_hold_bars
           FROM agent_decisions
          WHERE action IN ('open_long','open_short') AND plan_json IS NOT NULL
            AND event_time < $1
          ORDER BY event_time ASC`,
          [UNTIL_MS],
        );

        const decisions: EntryDecision[] = decRes.rows
          .filter((r) => r.stop_loss_pct !== null && r.take_profit_pct !== null)
          .map((r) => ({
            strategyId: r.strategy_id,
            symbol: r.symbol,
            eventTime: Number(r.event_time),
            side: r.action === 'open_short' ? 'short' : 'long',
            stopLossPct: r.stop_loss_pct!,
            takeProfitPct: r.take_profit_pct!,
            maxHoldBars: Number(r.max_hold_bars ?? '72'),
          }));

        const matchEntry = (
          strategyId: string,
          symbol: string,
          openedAt: number,
        ): EntryDecision | null => {
          let best: EntryDecision | null = null;
          for (const d of decisions) {
            if (d.strategyId !== strategyId || d.symbol !== symbol) continue;
            // The decide fires on candle OPEN while the fill lands after it, so allow a one-bar lead.
            if (d.eventTime > openedAt + 15 * 60_000) continue;
            if (best === null || d.eventTime > best.eventTime) best = d;
          }
          return best;
        };

        // A trip is admitted only if EVERY pass can price it, so all five tables share one population
        // and each delta is attributable to the pass's own change rather than to a moved denominator.
        const trips: Trip[] = [];
        const perTrip: string[] = [];
        let unmatched = 0;
        let noCandles = 0;
        let partitionMismatches = 0;
        let noAnchor = 0;
        let noFeeBasis = 0;
        let sideDisagreements = 0;
        let shortTrips = 0;

        for (let i = 0; i < cycles.length; i += 1) {
          const c = cycles[i]!;
          const members = parts[i]!;
          const entry = matchEntry(c.strategyId, c.symbol, c.openedAt);
          if (entry === null) {
            unmatched += 1;
            continue;
          }
          // The partition MUST reproduce walkRoundTrips's own realizedPnl before its per-leg fee split
          // is trusted (same discipline as frame-audit.spec.ts) — a mismatch fails the trip OPEN.
          const frameStats = computeCycleFrameStats(members, c.closedAt, candlesFor);
          if (!frameStats.demoPnlCheck.eq(c.realizedPnl)) {
            partitionMismatches += 1;
            continue;
          }
          const fillSide = openingSideOf(members);
          if (fillSide === null) {
            noAnchor += 1;
            continue;
          }
          const buyVwap = c.entryVwap;
          const openingVwap = anchorVwapOf(c, fillSide);
          if (
            buyVwap === null ||
            buyVwap.lte(0) ||
            openingVwap === null ||
            openingVwap.lte(0) ||
            openingQtyOf(c, fillSide).lte(0)
          ) {
            noAnchor += 1;
            continue;
          }
          const longLeg = openingLegFeeRate(members, 'long');
          const shortLeg = openingLegFeeRate(members, 'short');
          const venue = members[0]!.venue;
          const makerRate = schedule.rateFor(venue, 'maker');
          const takerRate = schedule.rateFor(venue, 'taker');
          if (longLeg === null || shortLeg === null || makerRate === null || takerRate === null) {
            noFeeBasis += 1;
            continue;
          }
          const candles = candlesFor(c.symbol);
          if (candles === null) {
            noCandles += 1;
            continue;
          }

          if (fillSide !== entry.side) sideDisagreements += 1;
          if (fillSide === 'short') shortTrips += 1;

          trips.push({
            symbol: c.symbol,
            venue,
            decisionSide: entry.side,
            fillSide,
            buyVwap,
            openingVwap,
            boughtQty: c.boughtQty,
            soldQty: c.soldQty,
            realizedPnl: c.realizedPnl,
            feesQuote: c.feesQuote,
            openingFeeRate: { long: longLeg.rate, short: shortLeg.rate },
            exitRate: { maker: makerRate, taker: takerRate },
            stopLossPct: entry.stopLossPct,
            takeProfitPct: entry.takeProfitPct,
            maxHoldBars: entry.maxHoldBars,
            forward: barsAfter(candles, c.openedAt),
          });

          const anchorShift = openingVwap.minus(buyVwap).div(buyVwap).mul(10_000);
          perTrip.push(
            `  ${c.symbol.padEnd(16)} ${fillSide.padEnd(5)} ${venue.padEnd(12)} ` +
              `buyVwap=${buyVwap.toFixed(6).padStart(12)} openVwap=${openingVwap.toFixed(6).padStart(12)} ` +
              `anchorShift=${anchorShift.toFixed(1).padStart(8)}bps ` +
              `entryFee=${(fillSide === 'long' ? longLeg.rate : shortLeg.rate).mul(10_000).toFixed(3).padStart(7)}bps ` +
              `decl=${entry.side}`,
          );
        }

        expect(trips.length).toBeGreaterThan(0);

        const results = PASSES.map((p) => runPass(p, trips));
        const control = results[0]!;
        const restated = results[3]!;

        const marginOf = (r: PassResult): Decimal => meanBps(r.arm2).minus(meanBps(r.arm1));
        const signFlipped = (a: Decimal, b: Decimal): string =>
          a.isNeg() !== b.isNeg() && !a.isZero() && !b.isZero() ? 'YES' : 'no';

        lines.push(
          `[exit-attribution-restated] epoch=${new Date(EPOCH_MS).toISOString()} ` +
            `until=${new Date(UNTIL_MS).toISOString()} fills=${fills.length} cycles=${cycles.length} ` +
            `entryDecisions=${decisions.length} usableTrips=${trips.length} shortTrips=${shortTrips}`,
          `  excluded: unmatched=${unmatched} noCandles=${noCandles} noAnchor=${noAnchor} ` +
            `noFeeBasis=${noFeeBasis} partitionMismatches=${partitionMismatches} | ` +
            `sideDisagreements=${sideDisagreements} unconvertibleFeeAsset=${unconvertibleFeeAsset}`,
          '',
          '--- MEASURED fee schedule (this population, notional-weighted; frozen spec assumed 10.0000 ' +
            'bps/leg everywhere) ---',
          ...scheduleLines(schedule),
          '',
          '--- per-trip anchor and opening-leg fee ---',
          ...perTrip,
        );

        for (const r of results) {
          lines.push(
            '',
            `--- ${r.config.label} (anchor=${r.config.anchor} side=${r.config.sideSource} ` +
              `cost=${r.config.cost} exitLiq=${r.config.exitLiquidity}) ---`,
            summarise(r.arm1),
            summarise(r.arm2),
            ...CELL_KEYS.map((k) => summarise(r.arm3.get(k)!)),
          );
        }

        lines.push(
          '',
          '--- CELL DELTAS: RESTATED minus CONTROL (mean net bps per round trip) ---',
          `  ${'cell'.padEnd(30)} ${'control'.padStart(9)} ${'restated'.padStart(9)} ${'delta'.padStart(9)}  signFlip`,
        );
        const deltaRow = (label: string, a: ArmAccumulator, b: ArmAccumulator): string =>
          `  ${label.padEnd(30)} ${meanBps(a).toFixed(1).padStart(9)} ${meanBps(b).toFixed(1).padStart(9)} ` +
          `${meanBps(b).minus(meanBps(a)).toFixed(1).padStart(9)}  ${signFlipped(meanBps(a), meanBps(b))}`;
        lines.push(
          deltaRow('Arm1 actual', control.arm1, restated.arm1),
          deltaRow('Arm2 declared plan', control.arm2, restated.arm2),
          ...CELL_KEYS.map((k) =>
            deltaRow(cellLabel(k), control.arm3.get(k)!, restated.arm3.get(k)!),
          ),
        );

        const bestCell = (r: PassResult): { key: string; mean: Decimal } => {
          let best = { key: CELL_KEYS[0]!, mean: meanBps(r.arm3.get(CELL_KEYS[0]!)!) };
          for (const k of CELL_KEYS) {
            const m = meanBps(r.arm3.get(k)!);
            if (m.gt(best.mean)) best = { key: k, mean: m };
          }
          return best;
        };

        lines.push(
          '',
          '--- FROZEN VERDICT-RULE CLAUSES re-evaluated (edge-verdict-2026-08-10.md § Frozen verdict rule) ---',
        );
        for (const r of results) {
          const margin = marginOf(r);
          const best = bestCell(r);
          lines.push(
            `  ${r.config.label.padEnd(26)} Arm2-Arm1=${margin.toFixed(1).padStart(7)}bps ` +
              `(>=30: ${margin.gte(30) ? 'MET' : 'not met'})  Arm2 hit=${hitPct(r.arm2).toFixed(1)}% ` +
              `(>=34: ${hitPct(r.arm2).gte(34) ? 'MET' : 'not met'})  ` +
              `bestArm3=${cellLabel(best.key)} ${best.mean.toFixed(1)}bps ` +
              `(net-positive: ${best.mean.gt(0) ? 'YES' : 'no'})`,
          );
        }
        lines.push(
          '',
          `Arm2-Arm1 margin sign flip control->restated: ${signFlipped(marginOf(control), marginOf(restated))}`,
          `any Arm3 cell net-positive under RESTATED: ${bestCell(restated).mean.gt(0) ? 'YES' : 'no'}`,
        );

        const out = lines.join('\n');
        console.log(out);
        if (OUT_FILE) writeFileSync(OUT_FILE, `${out}\n`, 'utf8');

        // The study must actually have measured something; the verdict itself is recorded by hand in
        // the study writeup and the pre-registration amendment, never asserted here (a green test must
        // never imply a positive result).
        expect(partitionMismatches).toBe(0);
        expect(control.arm2.trips + control.arm2.excluded).toBeGreaterThan(0);
        expect(restated.arm2.trips + restated.arm2.excluded).toBeGreaterThan(0);
      } finally {
        await pool.end();
      }
    }, 180_000);
  },
);
