import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { walkRoundTrips, type RoundTripFill } from '../../src/domain/trading/risk/round-trips';
import { simulateExit, type RawCandle, type Side } from './exit-simulator';

// ── Exit-attribution study (three arms) ──────────────────────────────────────
//
// Preregistration: research/studies/edge-verdict-2026-08-10.md. Arms, cost model, exclusions and the
// verdict rule are frozen there and must not be edited after seeing results.
//
// Question: of the gap between the hit rate the strategy needs (~34% at its own declared R:R 2.02)
// and the 18.2% it achieves, how much is the model's DISCRETIONARY exit timing, how much its
// declared stop/TP GEOMETRY, and how much the ENTRIES themselves?
//
//   Arm 1 — actual: the realised round trips, discretionary closes included.
//   Arm 2 — declared plan run mechanically: identical entries, exited ONLY at the model's own
//           stopLossPct / takeProfitPct / maxHoldBars. Isolates the 72.7% of live exits the model
//           performs by hand.
//   Arm 3 — geometry grid: multiples of each entry's OWN declared values, plus two boundary arms.
//
// Every arm replays the identical entry set at the identical achieved entry VWAP, so the comparison
// is paired by construction. That pairing is also why cell counts must not be treated as independent
// trials — see the preregistration's stated statistical limitation.
//
// Gated like the sibling live evals: EXIT_ATTRIBUTION=1 + DATABASE_URL, self-skips otherwise.
// Read-only against fills/order_intents/agent_decisions — never a write, never a reset.

const RUN = process.env['EXIT_ATTRIBUTION'] === '1';
const DB_URL = process.env['DATABASE_URL'];
const OUT_FILE = process.env['EXIT_ATTRIBUTION_OUTPUT_FILE'];

const EPOCH_MS = Date.parse('2026-07-21T11:21:00Z');
const DUST_NOTIONAL = '5'; // PROMOTION_DUST_NOTIONAL — same closure rule as the promotion gate
const ROUND_TRIP_FEE = '0.002'; // 20 bps: 10 bps per leg, maker = taker (verified demo schedule)
const DATA_DIR = join(__dirname, 'data');

const STOP_MULTIPLES = ['1', '1.5', '2', '3'] as const;
const TP_MULTIPLES = ['0.5', '1', '2'] as const;

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
  return candles.filter((c) => c[0] > afterMs);
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

function summarise(arm: ArmAccumulator): string {
  const mean = arm.trips > 0 ? arm.sum.div(arm.trips).mul(10_000) : new Decimal(0);
  const hit = arm.trips > 0 ? new Decimal(arm.wins).div(arm.trips).mul(100) : new Decimal(0);
  return (
    `${arm.label.padEnd(34)} trips=${String(arm.trips).padStart(3)} ` +
    `hit=${hit.toFixed(1).padStart(5)}% meanNet=${mean.toFixed(1).padStart(8)}bps ` +
    `stop/tp/hold=${arm.stops}/${arm.takeProfits}/${arm.maxHolds} excl=${arm.excluded}`
  );
}

describe.skipIf(!RUN || !DB_URL)('exit-attribution: discretion vs geometry vs entries', () => {
  it('runs all three arms over the recorded round trips and reports every cell', async () => {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: DB_URL });
    const lines: string[] = [];
    try {
      // Mirrors PromotionStatsRepository.fillsForMode verbatim (same join, same predicate, same
      // ordering incl. the fill_id same-millisecond tiebreak) so Arm 1 reproduces the promotion
      // gate's own round-trip walk rather than a parallel reimplementation of it.
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
      }>(
        `SELECT oi.strategy_id, f.symbol, oi.side, f.qty, f.price, f.fee_amount, f.fee_ccy,
                f.venue_timestamp, oi.ref_price
           FROM fills f
           LEFT JOIN order_intents oi ON f.intent_id = oi.intent_id
          WHERE f.mode = 'testnet' AND f.venue_timestamp >= $1
          ORDER BY f.venue_timestamp ASC, f.fill_id ASC`,
        [EPOCH_MS],
      );

      const fills: RoundTripFill[] = fillsRes.rows.map((r) => ({
        strategyId: r.strategy_id,
        symbol: r.symbol,
        side: r.side,
        qty: r.qty,
        price: r.price,
        fee: r.fee_amount,
        feeAsset: r.fee_ccy,
        executedAt: Number(r.venue_timestamp),
        refPrice: r.ref_price,
      }));

      const { cycles } = walkRoundTrips(fills, new Decimal(DUST_NOTIONAL));
      expect(cycles.length).toBeGreaterThan(0);

      // Entry decisions carry the declared geometry in plan_json. Matched to a cycle by ASOF join:
      // the latest open_* decision for that (strategy, symbol) at or before the cycle's open.
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
          ORDER BY event_time ASC`,
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

      const arm1 = newArm('Arm1 actual (discretionary)');
      const arm2 = newArm('Arm2 declared plan, mechanical');
      const arm3 = new Map<string, ArmAccumulator>();
      for (const sm of STOP_MULTIPLES) {
        for (const tm of TP_MULTIPLES) {
          arm3.set(`${sm}|${tm}`, newArm(`Arm3 stop x${sm} tp x${tm}`));
        }
      }
      arm3.set('timeonly', newArm('Arm3 time-stop only'));
      arm3.set('nostop', newArm('Arm3 no take-profit'));

      let unmatched = 0;
      let noCandles = 0;
      let phantomTrips = 0;
      const arm1NoPhantom = newArm('Arm1 actual, phantoms excluded');
      const perTrip: string[] = [];

      for (const c of cycles) {
        const entry = matchEntry(c.strategyId, c.symbol, c.openedAt);
        if (entry === null) {
          unmatched += 1;
          continue;
        }
        const entryVwap = c.entryVwap;
        if (entryVwap === null || entryVwap.lte(0)) {
          unmatched += 1;
          continue;
        }

        // ARM 1 — what actually happened. realizedPnl is GROSS of fees by contract
        // (round-trips.ts header), so fees are subtracted here exactly once.
        const qty = entry.side === 'long' ? c.boughtQty : c.soldQty;
        const notional = entryVwap.mul(qty);
        if (notional.lte(0)) {
          unmatched += 1;
          continue;
        }
        const actualNet = c.realizedPnl.minus(c.feesQuote).div(notional);
        arm1.trips += 1;
        arm1.sum = arm1.sum.plus(actualNet);
        if (actualNet.gt(0)) arm1.wins += 1;

        const candles = candlesFor(c.symbol);
        if (candles === null) {
          noCandles += 1;
          continue;
        }
        const forward = barsAfter(candles, c.openedAt);

        const run = (
          arm: ArmAccumulator,
          stopLossPct: string | null,
          takeProfitPct: string | null,
        ): void => {
          const outcome = simulateExit({
            side: entry.side,
            entryPrice: entryVwap.toString(),
            stopLossPct,
            takeProfitPct,
            maxHoldBars: entry.maxHoldBars,
            bars: forward,
            resolution: 'intrabar',
            roundTripFee: ROUND_TRIP_FEE,
          });
          if (outcome === null) {
            arm.excluded += 1;
            return;
          }
          arm.trips += 1;
          arm.sum = arm.sum.plus(outcome.netReturn);
          if (new Decimal(outcome.netReturn).gt(0)) arm.wins += 1;
          if (outcome.reason === 'stop') arm.stops += 1;
          else if (outcome.reason === 'take_profit') arm.takeProfits += 1;
          else arm.maxHolds += 1;
        };

        run(arm2, entry.stopLossPct, entry.takeProfitPct);
        for (const sm of STOP_MULTIPLES) {
          for (const tm of TP_MULTIPLES) {
            run(
              arm3.get(`${sm}|${tm}`)!,
              new Decimal(entry.stopLossPct).mul(sm).toString(),
              new Decimal(entry.takeProfitPct).mul(tm).toString(),
            );
          }
        }
        run(arm3.get('timeonly')!, null, null);
        run(arm3.get('nostop')!, entry.stopLossPct, null);

        // A cycle whose notional is at or under the dust threshold is a PHANTOM: walkRoundTrips
        // closes a trip as soon as the running position dips below PROMOTION_DUST_NOTIONAL, so a
        // multi-fill backfill whose first fill is small mints a "closed round trip" at that first
        // fill, with no proceeds and therefore a ~−100% return. Flagged, not silently dropped.
        const phantom = notional.lte(DUST_NOTIONAL);
        perTrip.push(
          `  ${phantom ? 'PHANTOM ' : '        '}${c.symbol.padEnd(18)} ${entry.side.padEnd(5)} ` +
            `notional=$${notional.toFixed(2).padStart(8)} sl=${entry.stopLossPct} tp=${entry.takeProfitPct} ` +
            `hold=${entry.maxHoldBars} actualNet=${actualNet.mul(10_000).toFixed(1)}bps`,
        );
        if (phantom) phantomTrips += 1;
        else {
          arm1NoPhantom.trips += 1;
          arm1NoPhantom.sum = arm1NoPhantom.sum.plus(actualNet);
          if (actualNet.gt(0)) arm1NoPhantom.wins += 1;
        }
      }

      lines.push(
        `[exit-attribution] epoch=${new Date(EPOCH_MS).toISOString()} fills=${fills.length} ` +
          `cycles=${cycles.length} entryDecisions=${decisions.length} unmatched=${unmatched} ` +
          `noCandles=${noCandles} phantomDustTrips=${phantomTrips}`,
        '',
        '--- per-trip (Arm 1 actual) ---',
        ...perTrip,
        '',
        '--- ARMS (mean net bps per round trip; break-even hit rate ~34% at R:R 2.02) ---',
        summarise(arm1),
        summarise(arm1NoPhantom),
        summarise(arm2),
        ...[...arm3.values()].map(summarise),
      );

      const out = lines.join('\n');
      console.log(out);
      if (OUT_FILE) writeFileSync(OUT_FILE, `${out}\n`, 'utf8');

      // The study must actually have measured something; the verdict itself is recorded by hand in
      // the preregistration, never asserted here (a green test must never imply a positive result).
      expect(arm1.trips).toBeGreaterThan(0);
      expect(arm2.trips + arm2.excluded).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  }, 120_000);
});
