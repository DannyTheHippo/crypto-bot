#!/usr/bin/env node
// $0 entry fill-quality study — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// Measures LIMIT_MAKER (post-only, ENTRY_ORDER_TYPE=LIMIT_MAKER) entry fill quality: fill rate,
// expiry rate, bars-to-fill, and — for entries that expired unfilled — a settlement replay of what
// the plan's own TP/SL/maxHold would have done had the entry actually filled, so the "missed fill"
// can be priced instead of just counted. See reports/loop/entry-fill-quality-2026-07-13.md for the
// writeup and verdict — READ THAT FIRST, especially its N and small-sample caveats.
//
// DB reads only (no writes, no LLM calls). DATABASE_URL: read from <repo>/.env if present, else the
// checked-in docker-compose.yml dev default (postgres://cryptobot:cryptobot@localhost:5432/cryptobot
// — non-secret, local-stack-only credentials); NEVER logged either way.
//
// Correlation strategy (no FK links agent_decisions to orders/order_intents):
//   - Entry order -> its originating plan decision: order_intents.created_at (epoch-ms, stamped by
//     position-sizer.service.ts's clock.now() at intent-build time) lands within single-digit
//     milliseconds of the agent_decisions row's created_at (DB now() at journal-insert time) for the
//     SAME decide cycle — both happen synchronously in the same strategy.decide() call, no await
//     between them. Verified empirically against this DB's own single LIMIT_MAKER row (2ms apart).
//     Matched on (strategy_id, symbol, action='long', plan_json IS NOT NULL), nearest created_at,
//     rejected past CORRELATION_TOLERANCE_MS (a real mismatch, not just clock skew).
//   - Entry order -> its expiry mechanism: agent_decisions rows with model='plan-executor' and
//     rationale 'plan cleared: cancel_entry'/'plan cleared: plan_expired' (see
//     src/features/strategy/agentic/agentic.strategy.ts's runActivePlan) — same strategy/symbol, first
//     one at or after the entry decision's created_at.
//
// Fill ground truth (task-flagged #40 caveat): orders.first_fill_at was only stamped for good starting
// with backlog #40 — older FILLED rows can carry first_fill_at IS NULL despite a real fill. This
// script NEVER trusts first_fill_at alone: every order is cross-checked against the fills table by
// client_order_id, and the EARLIEST fills.venue_timestamp is used as the ground-truth fill time
// whenever fills exist, regardless of what first_fill_at says. `stampGap: true` on a row flags exactly
// this case (first_fill_at NULL, a real fill exists) so the report can call it out.
//
// Missed-fill pricing: entry orders are LIMIT_MAKER — their own order_intents.limit_price IS the
// intended entry price (no need to re-derive it from entryOffsetBps/close), so a never-filled expired
// entry is replayed starting from that exact resting price. The walk (stop checked first, then take-
// profit, else max_hold at the last bar) is byte-identical to plan-executor.ts's evaluatePlan LONG/
// SHORT arms; candles are real 15m OHLCV fetched from Binance public REST (ccxt, no keys) starting at
// the order's own creation time — this is a genuine forward candle series, not the sparse
// decision-close approximation candidate-backtest.ts uses (that module has no candle source available
// to it; this offline script does). Fees: 20bps round trip (CLAUDE.md / reflection.service.ts /
// candidate-backtest.ts's shared convention).
import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ccxtPkg from 'ccxt';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

const INTERVAL_MS = 15 * 60 * 1000; // 15m bars — this repo's decide-cadence convention (bounds-calibration, recorded-entry-scoring.ts)
const ROUND_TRIP_FEE_FRACTION = 0.002; // 20bps, CLAUDE.md / candidate-backtest.ts's shared convention
const CORRELATION_TOLERANCE_MS = 10_000; // same-decide-cycle proximity; observed ~2ms in this DB

// Never logs the resolved value — only whether a .env override was found.
function loadDatabaseUrl() {
  const envPath = join(REPO_ROOT, '.env');
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const m = /^DATABASE_URL=(.*)$/.exec(line.trim());
      if (m) return { url: m[1].trim(), source: '.env' };
    }
  }
  return {
    url: 'postgres://cryptobot:cryptobot@localhost:5432/cryptobot',
    source: 'docker-compose.yml dev default (no .env override found)',
  };
}

async function fetchEntryOrders(pool) {
  const { rows } = await pool.query(`
    SELECT o.intent_id, o.client_order_id, o.symbol, o.state, o.mode,
           o.first_fill_at, o.terminal_at,
           oi.strategy_id, oi.created_at AS intent_created_at, oi.limit_price
    FROM orders o
    JOIN order_intents oi ON oi.intent_id = o.intent_id
    WHERE o.type = 'LIMIT_MAKER' AND oi.reduce_only = false
    ORDER BY oi.created_at ASC
  `);
  return rows;
}

async function fillGroundTruth(pool, clientOrderId) {
  const { rows } = await pool.query(
    `SELECT min(venue_timestamp) AS first_ts, count(*)::int AS n
     FROM fills WHERE client_order_id = $1`,
    [clientOrderId],
  );
  const r = rows[0];
  return { firstTs: r.first_ts !== null ? Number(r.first_ts) : null, n: r.n };
}

async function nearestEntryPlan(pool, strategyId, symbol, intentCreatedAtMs) {
  const { rows } = await pool.query(
    `SELECT id, event_time, plan_json, created_at
     FROM agent_decisions
     WHERE strategy_id = $1 AND symbol = $2 AND action = 'long' AND plan_json IS NOT NULL
     ORDER BY abs(extract(epoch FROM created_at) * 1000 - $3) ASC
     LIMIT 1`,
    [strategyId, symbol, intentCreatedAtMs],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const createdAtMs = new Date(row.created_at).getTime();
  const diffMs = Math.abs(createdAtMs - intentCreatedAtMs);
  if (diffMs > CORRELATION_TOLERANCE_MS) return null;
  return { id: row.id, eventTime: Number(row.event_time), plan: row.plan_json, diffMs };
}

async function clearedJournalRow(pool, strategyId, symbol, sinceCreatedAtIso) {
  const { rows } = await pool.query(
    `SELECT id, event_time, rationale, created_at
     FROM agent_decisions
     WHERE strategy_id = $1 AND symbol = $2 AND model = 'plan-executor'
       AND (rationale LIKE 'plan cleared: cancel_entry%' OR rationale LIKE 'plan cleared: plan_expired%')
       AND created_at >= $3
     ORDER BY created_at ASC
     LIMIT 1`,
    [strategyId, symbol, sinceCreatedAtIso],
  );
  return rows[0] ?? null;
}

// Byte-identical walk semantics to plan-executor.ts's evaluatePlan LONG/SHORT arms (stop checked
// first, then take-profit, else max_hold at the last bar); fee-adjusted net return net of
// ROUND_TRIP_FEE_FRACTION. `closes` is the subsequent 15m close series starting the bar AFTER the
// entry order was created.
function simulateMissedEntry(entryPrice, plan, closes, isShort) {
  const sl = Number(plan.stopLossPct);
  const tp = Number(plan.takeProfitPct);
  const maxHold = plan.maxHoldBars;
  const walkLen = Math.min(closes.length, maxHold);
  if (walkLen === 0) return null; // no forward data at all — unsimulatable
  let exitClose = closes[walkLen - 1];
  let exitReason = 'max_hold';
  for (let i = 0; i < walkLen; i++) {
    const c = closes[i];
    const stopHit = isShort ? c >= entryPrice * (1 + sl) : c <= entryPrice * (1 - sl);
    const tpHit = isShort ? c <= entryPrice * (1 - tp) : c >= entryPrice * (1 + tp);
    if (stopHit) {
      exitClose = c;
      exitReason = 'stop';
      break;
    }
    if (tpHit) {
      exitClose = c;
      exitReason = 'take_profit';
      break;
    }
  }
  const rawReturn = isShort ? 1 - exitClose / entryPrice : exitClose / entryPrice - 1;
  const netReturn = rawReturn - ROUND_TRIP_FEE_FRACTION;
  return {
    netReturn,
    exitReason,
    barsSimulated: walkLen,
    censored: walkLen < maxHold && exitReason === 'max_hold' && closes.length < maxHold,
  };
}

// Real 15m OHLCV forward of `sinceMs`, public REST, no keys — same source as
// test/backtest/fetch-data.mjs. Returns just the close series (numbers), oldest-first.
async function fetchForwardCloses(ex, symbol, sinceMs, barsNeeded) {
  const bars = await ex.fetchOHLCV(
    symbol,
    '15m',
    sinceMs + INTERVAL_MS,
    Math.min(barsNeeded, 1000),
  );
  return (bars ?? []).map((b) => Number(b[4]));
}

function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function main() {
  const { url: databaseUrl, source } = loadDatabaseUrl();
  console.log(`entry-fill-quality: DATABASE_URL source = ${source} (value never logged)`);
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const orders = await fetchEntryOrders(pool);
    console.log(
      `entry-fill-quality: ${orders.length} LIMIT_MAKER, non-reduce-only entry order(s) found`,
    );

    const entries = [];
    for (const o of orders) {
      const { firstTs, n: fillsCount } = await fillGroundTruth(pool, o.client_order_id);
      const stampGap = o.first_fill_at === null && fillsCount > 0;
      const filled = o.first_fill_at !== null || fillsCount > 0;
      const fillTs = o.first_fill_at !== null ? Number(o.first_fill_at) : firstTs;
      const intentCreatedAtMs = Number(o.intent_created_at);

      const planMatch = await nearestEntryPlan(pool, o.strategy_id, o.symbol, intentCreatedAtMs);
      let clearedReason = null;
      if (!filled && planMatch) {
        const decisionCreatedAtIso = new Date(intentCreatedAtMs).toISOString();
        const cleared = await clearedJournalRow(
          pool,
          o.strategy_id,
          o.symbol,
          decisionCreatedAtIso,
        );
        if (cleared)
          clearedReason = /cancel_entry/.test(cleared.rationale) ? 'cancel_entry' : 'plan_expired';
      }

      const barsToFill = filled ? (fillTs - intentCreatedAtMs) / INTERVAL_MS : null;

      entries.push({
        symbol: o.symbol,
        strategyId: o.strategy_id,
        intentId: o.intent_id,
        clientOrderId: o.client_order_id,
        state: o.state,
        mode: o.mode,
        filled,
        stampGap,
        fillsCount,
        intentCreatedAtMs,
        limitPrice: o.limit_price !== null ? Number(o.limit_price) : null,
        expired: !filled && o.terminal_at !== null,
        stillOpen: !filled && o.terminal_at === null,
        barsToFill,
        plan: planMatch ? planMatch.plan : null,
        planCorrelationDiffMs: planMatch ? planMatch.diffMs : null,
        clearedReason,
      });
    }

    // Missed-fill pricing: only entries that expired unfilled AND correlated to a plan (need
    // stopLossPct/takeProfitPct/maxHoldBars + the order's own limitPrice as the intended entry).
    const missedCandidates = entries.filter((e) => e.expired && e.plan && e.limitPrice !== null);
    const missedResults = [];
    if (missedCandidates.length > 0) {
      const ex = new ccxtPkg.binance({ enableRateLimit: true });
      for (const e of missedCandidates) {
        const isShort = e.plan.direction === 'short';
        const barsNeeded = e.plan.maxHoldBars;
        let closes;
        try {
          closes = await fetchForwardCloses(ex, e.symbol, e.intentCreatedAtMs, barsNeeded);
        } catch (err) {
          console.error(`entry-fill-quality: candle fetch failed for ${e.symbol}: ${err.message}`);
          continue;
        }
        const sim = simulateMissedEntry(e.limitPrice, e.plan, closes, isShort);
        if (sim === null) continue;
        missedResults.push({ ...e, ...sim });
      }
    } else {
      console.log(
        'entry-fill-quality: no expired+plan-correlated missed fills to price — skipping candle fetch',
      );
    }

    // ── Per-symbol + aggregate stats ──────────────────────────────────────────────────────────────
    const bySymbol = new Map();
    for (const e of entries) {
      const list = bySymbol.get(e.symbol) ?? [];
      list.push(e);
      bySymbol.set(e.symbol, list);
    }

    function summarize(list, missedForList) {
      const n = list.length;
      const filledN = list.filter((e) => e.filled).length;
      const expiredN = list.filter((e) => e.expired).length;
      const stillOpenN = list.filter((e) => e.stillOpen).length;
      const barsToFillMedian = median(list.filter((e) => e.filled).map((e) => e.barsToFill));
      const missedN = missedForList.length;
      const totalNetFraction = missedForList.reduce((a, m) => a + m.netReturn, 0);
      const wonList = missedForList.filter((m) => m.netReturn > 0);
      const lostList = missedForList.filter((m) => m.netReturn <= 0);
      return {
        n,
        fillRate: n > 0 ? filledN / n : null,
        expiryRate: n > 0 ? expiredN / n : null,
        stillOpenN,
        barsToFillMedian,
        missedN,
        wouldHaveWonN: wonList.length,
        wouldHaveLostN: lostList.length,
        totalNetFractionForegone: totalNetFraction,
        wouldHaveWonNetFraction: wonList.reduce((a, m) => a + m.netReturn, 0),
        wouldHaveLostNetFraction: lostList.reduce((a, m) => a + m.netReturn, 0),
      };
    }

    console.log('\n=== PER-SYMBOL ===');
    const perSymbol = {};
    for (const [symbol, list] of bySymbol) {
      const missedForSymbol = missedResults.filter((m) => m.symbol === symbol);
      const s = summarize(list, missedForSymbol);
      perSymbol[symbol] = s;
      console.log(
        `${symbol}: N=${s.n} fillRate=${s.fillRate !== null ? (s.fillRate * 100).toFixed(0) + '%' : 'n/a'} ` +
          `expiryRate=${s.expiryRate !== null ? (s.expiryRate * 100).toFixed(0) + '%' : 'n/a'} ` +
          `medianBarsToFill=${s.barsToFillMedian !== null ? s.barsToFillMedian.toFixed(2) : 'n/a'} ` +
          `missed=${s.missedN} foregoneNetBps=${(s.totalNetFractionForegone * 10000).toFixed(1)}`,
      );
    }

    console.log('\n=== AGGREGATE ===');
    const aggregate = summarize(entries, missedResults);
    console.log(
      `ALL: N=${aggregate.n} fillRate=${aggregate.fillRate !== null ? (aggregate.fillRate * 100).toFixed(0) + '%' : 'n/a'} ` +
        `expiryRate=${aggregate.expiryRate !== null ? (aggregate.expiryRate * 100).toFixed(0) + '%' : 'n/a'} ` +
        `stillOpen=${aggregate.stillOpenN} medianBarsToFill=${aggregate.barsToFillMedian !== null ? aggregate.barsToFillMedian.toFixed(2) : 'n/a'} ` +
        `missed=${aggregate.missedN} (won=${aggregate.wouldHaveWonN}/lost=${aggregate.wouldHaveLostN}) ` +
        `signedForegoneNetBps=${(aggregate.totalNetFractionForegone * 10000).toFixed(1)}`,
    );

    console.log('\n=== RAW ENTRIES ===');
    console.log(JSON.stringify(entries, null, 1));
    if (missedResults.length > 0) {
      console.log('\n=== MISSED-FILL SIMULATIONS ===');
      console.log(JSON.stringify(missedResults, null, 1));
    }

    return { perSymbol, aggregate, entries, missedResults };
  } finally {
    await pool.end();
  }
}

export { simulateMissedEntry, median, loadDatabaseUrl };

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`entry-fill-quality: fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}
