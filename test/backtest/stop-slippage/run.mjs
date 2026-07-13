// $0 stop-side exit-slippage study — RESEARCH TOOLING (test/backtest/, off the production gate).
// DB-connected (unlike bounds-calibration/run.mjs's file-input replay): reads the live stack's own
// fills × order_intents × signals × agent_decisions rows to quantify how much the agentic lane's
// close-detected stop exits (plan-executor.ts's `stop` branch) actually leak versus (a) the signal's
// own ref_price (IOC-only slippage) and (b) the INTENDED stop price the plan meant to protect at
// (bar-close detection lag + gap-through — the full leak). See
// reports/loop/stop-slippage-2026-07-13.md for the verdict — READ THAT FIRST: this corpus is thin
// (single-digit stop-exit N as of this run), a descriptive diagnostic, not a validated distribution.
//
// Usage: DATABASE_URL=postgres://user:pass@host:5432/dbname node test/backtest/stop-slippage/run.mjs [--out <file>]
// No default connection string (same "no default — this is a loop action against the real DB"
// discipline as scripts/resolve-stale-orders.mjs) — the caller supplies it. Never logs the URL.
//
// ── Method ──────────────────────────────────────────────────────────────────────────────────────
// 1) Walk every (strategy_id, symbol)'s fills in venue_timestamp order, maintaining a running
//    VWAP cost basis (BUY adds qty*price to the numerator; any reducing fill reads the current VWAP
//    as that trip's entry price, then shrinks the basis proportionally; the basis resets to empty
//    once qty returns to ~0 — a new trip starts on the next BUY). This is a general position-VWAP
//    walk, not stop-exit-specific, so it also anchors max_hold reference rows and re-fire counting.
// 2) A stop-exit fill is one whose owning signal has reason 'plan exit: stop' (agentic.strategy.ts's
//    plan-executor exit path journals exactly this string; 'plan exit: max_hold' is the time-based
//    exit, counted separately for reference — neither has an "intended price" to leak against).
// 3) IOC slippage bps: fill.price vs order_intents.ref_price, same signed convention as the
//    order_slippage_decision_bps histogram (fill-ingestor.service.ts): sign = +1 BUY / -1 SELL,
//    bps = (fill.price - ref_price) / ref_price * 10000 * sign — positive = adverse both sides.
// 4) Intended-stop leak bps: agent_decisions.plan_json is NOT populated on the entry's own `long` row
//    in this corpus (verified against the live rows) — it is journaled on later `hold`-consult rows
//    while a plan is active, and can drift bar-to-bar (the model re-affirms/updates its stop view).
//    So "the owning plan" is read as the MOST RECENT plan_json row for the same (strategy_id, symbol)
//    with event_time between this trip's entry fill and the exit signal's event_time — the last
//    stopLossPct actually on record before the position closed. A trip with no such row inside its
//    window contributes no leak-bps sample (flagged, not guessed).
//    intendedStop = entryVwap * (1 - stopLossPct); leakBps = (intendedStop - fillPrice) / intendedStop
//    * 10000 (positive = adverse: the realized exit landed below the level the plan meant to defend).
// 5) Re-fires: per trip, count of distinct stop-exit fills before the position returns to flat minus
//    one (0 if the stop closed the trip on its first attempt).
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const { Pool } = pg;

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const OUT = arg('--out', null);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    'stop-slippage: DATABASE_URL is required (no default — this reads the real trading DB).',
  );
  process.exitCode = 1;
  process.exit(1);
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function worst(xs) {
  // "worst" = most adverse = highest positive bps under this sign convention.
  return xs.length ? Math.max(...xs) : null;
}
function fmt(n, d = 1) {
  return n === null || n === undefined ? 'n/a' : n.toFixed(d);
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    // Full fill timeline (every strategy/symbol), joined to its order_intent for side/ref_price and
    // (where present) the owning signal's reason/event_time — drives the VWAP walk.
    const { rows: fillRows } = await pool.query(`
      SELECT f.fill_id, f.symbol, f.price AS fill_price, f.qty, f.liquidity, f.venue_timestamp,
             f.intent_id, oi.side, oi.strategy_id, oi.ref_price,
             s.reason AS signal_reason, s.event_time AS signal_event_time
      FROM fills f
      JOIN order_intents oi ON f.intent_id = oi.intent_id
      LEFT JOIN signals s ON oi.intent_id = s.intent_id
      ORDER BY oi.strategy_id, f.symbol, f.venue_timestamp, f.fill_id
    `);

    // Every agent_decisions row that carries a plan snapshot, any action — the entry's own `long`
    // row does not carry one in this corpus (see header comment); later hold-consult rows do.
    const { rows: planRows } = await pool.query(`
      SELECT strategy_id, symbol, event_time, plan_json
      FROM agent_decisions
      WHERE plan_json IS NOT NULL
      ORDER BY strategy_id, symbol, event_time
    `);
    const plansByKey = new Map();
    for (const r of planRows) {
      const key = `${r.strategy_id}|${r.symbol}`;
      if (!plansByKey.has(key)) plansByKey.set(key, []);
      plansByKey.get(key).push({
        eventTime: Number(r.event_time),
        stopLossPct: Number(r.plan_json.stopLossPct),
      });
    }
    // Latest plan_json row with tripStartMs <= eventTime <= atOrBeforeMs, or null if none.
    function lookupStopLossPct(strategyId, symbol, tripStartMs, atOrBeforeMs) {
      const list = plansByKey.get(`${strategyId}|${symbol}`);
      if (!list) return null;
      let found = null;
      for (const p of list) {
        if (p.eventTime >= tripStartMs && p.eventTime <= atOrBeforeMs) found = p.stopLossPct;
        if (p.eventTime > atOrBeforeMs) break;
      }
      return found;
    }

    // ── VWAP walk per (strategy_id, symbol) ──────────────────────────────────────────────────────
    const byKey = new Map();
    for (const r of fillRows) {
      const key = `${r.strategy_id}|${r.symbol}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }

    const stopExits = [];
    const maxHoldExits = [];
    const tripStopCounts = new Map(); // tripKey -> count of stop-exit fills in that trip

    for (const [key, rows] of byKey) {
      let qty = 0;
      let costNumer = 0;
      let tripId = 0;
      let tripStartMs = null;
      const EPS = 1e-9;

      for (const r of rows) {
        const price = Number(r.fill_price);
        const q = Number(r.qty);
        const side = r.side;

        if (side === 'BUY') {
          if (qty <= EPS) {
            tripId += 1;
            tripStartMs = Number(r.venue_timestamp);
          }
          costNumer += price * q;
          qty += q;
          continue;
        }

        // Reducing (SELL) fill: read the VWAP entry price BEFORE shrinking the basis.
        const entryVwap = qty > EPS ? costNumer / qty : null;
        const tripKey = `${key}#${tripId}`;

        if (r.signal_reason === 'plan exit: stop' || r.signal_reason === 'plan exit: max_hold') {
          const sign = side === 'BUY' ? 1 : -1;
          const refPrice = Number(r.ref_price);
          const iocSlipBps = ((price - refPrice) / refPrice) * 10000 * sign;
          const record = {
            symbol: r.symbol,
            strategyId: r.strategy_id,
            fillId: r.fill_id,
            liquidity: r.liquidity,
            fillPrice: price,
            entryVwap,
            iocSlipBps,
            tripId,
          };
          if (r.signal_reason === 'plan exit: stop') {
            tripStopCounts.set(tripKey, (tripStopCounts.get(tripKey) ?? 0) + 1);
            const stopLossPct =
              entryVwap !== null && tripStartMs !== null
                ? lookupStopLossPct(
                    r.strategy_id,
                    r.symbol,
                    tripStartMs,
                    Number(r.signal_event_time),
                  )
                : null;
            let leakBps = null;
            let intendedStop = null;
            if (stopLossPct !== null && entryVwap !== null) {
              intendedStop = entryVwap * (1 - stopLossPct);
              leakBps = ((intendedStop - price) / intendedStop) * 10000;
            }
            stopExits.push({ ...record, stopLossPct, intendedStop, leakBps, tripKey });
          } else {
            maxHoldExits.push(record);
          }
        }

        // Shrink the basis proportionally (VWAP unchanged) and reset once flat.
        costNumer -= (entryVwap ?? 0) * q;
        qty -= q;
        if (qty <= EPS) {
          qty = 0;
          costNumer = 0;
        }
      }
    }

    const refires = [...tripStopCounts.values()]
      .map((n) => n - 1)
      .reduce((a, b) => a + Math.max(b, 0), 0);
    const tripsWithMultipleStopAttempts = [...tripStopCounts.values()].filter((n) => n > 1).length;

    // ── Aggregation ───────────────────────────────────────────────────────────────────────────────
    function summarize(rows, withLeak) {
      const leakBps = withLeak ? rows.filter((r) => r.leakBps !== null).map((r) => r.leakBps) : [];
      const iocBps = rows.map((r) => r.iocSlipBps);
      const maker = rows.filter((r) => r.liquidity === 'maker').length;
      const taker = rows.filter((r) => r.liquidity === 'taker').length;
      return {
        n: rows.length,
        nWithLeak: leakBps.length,
        meanLeakBps: mean(leakBps),
        medianLeakBps: median(leakBps),
        worstLeakBps: worst(leakBps),
        meanIocBps: mean(iocBps),
        medianIocBps: median(iocBps),
        maker,
        taker,
      };
    }

    const bySymbol = new Map();
    for (const r of stopExits) {
      if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
      bySymbol.get(r.symbol).push(r);
    }
    const maxHoldBySymbol = new Map();
    for (const r of maxHoldExits) {
      if (!maxHoldBySymbol.has(r.symbol)) maxHoldBySymbol.set(r.symbol, []);
      maxHoldBySymbol.get(r.symbol).push(r);
    }

    const stopAgg = summarize(stopExits, true);
    const maxHoldAgg = summarize(maxHoldExits, false);

    // ── Report ───────────────────────────────────────────────────────────────────────────────────
    console.log(
      `stop-exit fills: N=${stopAgg.n} (with reconstructed intended-stop: ${stopAgg.nWithLeak})`,
    );
    console.log(
      `  leak bps (fill vs intended stop): mean=${fmt(stopAgg.meanLeakBps)} median=${fmt(stopAgg.medianLeakBps)} worst=${fmt(stopAgg.worstLeakBps)}`,
    );
    console.log(
      `  IOC slippage bps (fill vs ref_price): mean=${fmt(stopAgg.meanIocBps, 2)} median=${fmt(stopAgg.medianIocBps, 2)}`,
    );
    console.log(`  maker=${stopAgg.maker} taker=${stopAgg.taker}`);
    console.log(
      `  re-fires: ${refires} extra attempt(s) across ${tripsWithMultipleStopAttempts} trip(s) with >1 stop-exit fill`,
    );
    console.log('\nper-symbol stop-exit detail:');
    for (const [symbol, rows] of bySymbol) {
      const s = summarize(rows, true);
      console.log(
        `  ${symbol}: N=${s.n} leak mean=${fmt(s.meanLeakBps)} median=${fmt(s.medianLeakBps)} worst=${fmt(s.worstLeakBps)} ioc_mean=${fmt(s.meanIocBps, 2)} maker=${s.maker} taker=${s.taker}`,
      );
    }
    console.log(`\nmax_hold reference: N=${maxHoldAgg.n}`);
    console.log(
      `  IOC slippage bps (fill vs ref_price): mean=${fmt(maxHoldAgg.meanIocBps, 2)} median=${fmt(maxHoldAgg.medianIocBps, 2)} maker=${maxHoldAgg.maker} taker=${maxHoldAgg.taker}`,
    );
    for (const [symbol, rows] of maxHoldBySymbol) {
      const s = summarize(rows, false);
      console.log(
        `  ${symbol}: N=${s.n} ioc_mean=${fmt(s.meanIocBps, 2)} maker=${s.maker} taker=${s.taker}`,
      );
    }

    if (OUT) {
      writeFileSync(
        OUT,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            stopExits,
            maxHoldExits,
            refires,
            tripsWithMultipleStopAttempts,
            aggregate: { stop: stopAgg, maxHold: maxHoldAgg },
          },
          null,
          1,
        ),
      );
      console.log(`\nwrote ${OUT}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(
    `stop-slippage: unexpected error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
});
