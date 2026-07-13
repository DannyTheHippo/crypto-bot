// TP/SL/maxHold calibration study — RESEARCH TOOLING (test/backtest/, off the production gate).
// $0, no LLM calls, no network: replays the agentic lane's own 26 recorded `long` entries
// (agent_decisions rows) through a TP/SL/maxHold grid on real 15m candles, in two exit-fill modes,
// to quantify what a venue-resting take-profit (touch-fill) would be worth versus the current
// plan-executor's close-detected exits, on this sample. See
// reports/loop/bounds-calibration-2026-07-13.md for the writeup and verdict — READ THAT FIRST:
// N=26 with overlapping regime is a descriptive diagnostic, not a validated edge claim.
//
// Usage:
//   node test/backtest/bounds-calibration/run.mjs <entries.json> <candles.json> [--out <file>]
//
// Input shapes (both pre-extracted, read-only — this script only replays them):
//   entries.json  — array of agent_decisions rows: {id, strategy_id, symbol ("BTC/USDT" style),
//                    event_time (ms, string), action ('long'), confidence, ref_price, close,
//                    playbook_version, plan_json, created_at}.
//   candles.json  — {BTCUSDT: [[openTime, open, high, low, close, volume], ...], ...}, 15m bars,
//                    OHLCV as strings (ccxt convention), one array per symbol (no slash in the key).
//
// Extraction recipe (re-runnable against the live stack — see
// ~/.claude memory "Crypto-bot live data access": psql/curl are sandbox-denied for this agent, so
// this session's extraction ran via a session with direct DB/network access):
//
//   1) Entries — every recorded `long` decision, oldest first:
//        SELECT id, strategy_id, symbol, event_time, action, confidence, ref_price, close,
//               playbook_version, plan_json, created_at
//        FROM agent_decisions
//        WHERE action = 'long'
//        ORDER BY event_time ASC;
//      (psql -Atc "<query>" -F',' ... or any JSON-array export of the same rows in the same order.)
//
//   2) Candles — 15m OHLCV for the five traded symbols spanning the entries' event_time range,
//      fetched the same way as test/backtest/fetch-data.mjs's extended invocation:
//        node test/backtest/fetch-data.mjs BTC/USDT 15m 300
//        node test/backtest/fetch-data.mjs ETH/USDT 15m 300
//        node test/backtest/fetch-data.mjs SOL/USDT 15m 300
//        node test/backtest/fetch-data.mjs XRP/USDT 15m 300
//        node test/backtest/fetch-data.mjs LINK/USDT 15m 300
//      then merged into one object keyed by symbol with the slash stripped (BTCUSDT, ETHUSDT, ...).
//
// Entry-fill assumption: each entry's decision bar is the bar whose `openTime` equals the entry's
// `event_time` (verified: that bar's `close` equals the entry's recorded `close` field, exactly, for
// all 26 rows). This script fills the simulated trade at that bar's close — the current
// plan-executor's `ref_price` (used as the real entry, at an offset below close) is NOT what is
// simulated here; see the report's caveat.
//
// Simulation (per entry x grid cell), walking bars strictly after the decision bar:
//   Mode A "close-detection" (current plan-executor semantics) — each bar, stop-loss checked FIRST
//     (fill at that bar's close if close <= entry*(1-sl)), else take-profit (fill at that bar's
//     close if close >= entry*(1+tp)), else continue; if `hold` bars elapse with neither firing,
//     exit at the close of the hold-th bar.
//   Mode B "touch-detection" (venue-resting-TP change under evaluation) — same stop-loss check
//     (still bot-side, close-detected) checked FIRST each bar; only if the stop did not fire, take-
//     profit fires on bar HIGH touching entry*(1+tp), filled at EXACTLY that price (not the high).
//     Checking stop before touch-TP each bar is what makes a same-bar double-touch resolve to SL —
//     the conservative tie-break the task calls for.
// Fees: 20bps round-trip (10bps entry + 10bps exit) baked into net return on both modes:
//   net = exitPrice / entryPrice - 1 - 0.0020.
// Censoring: a trade is `censored` only when it reaches the end of available candle data without
// either SL or TP having fired AND the requested `hold` still had bars remaining — it exits at the
// last available close instead. A trade that resolves (SL/TP) inside the available window is never
// censored, even if `hold` would have overrun the data had it continued.
import { readFileSync, writeFileSync } from 'node:fs';

const TP_GRID = [0.003, 0.005, 0.008, 0.01, 0.015, 0.02, 0.03];
const SL_GRID = [0.003, 0.005, 0.008, 0.01, 0.015, 0.02];
const HOLD_GRID = [8, 16, 32, 64, 96];
const FEE_ROUND_TRIP = 0.002; // 10bps entry + 10bps exit
const MODES = ['A', 'B'];

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const OUT = arg('--out', null);
const [, , entriesPath, candlesPath] = process.argv;
if (!entriesPath || !candlesPath) {
  // eslint-disable-next-line no-console
  console.error('usage: node run.mjs <entries.json> <candles.json> [--out <file>]');
  process.exit(1);
}

const rawEntries = JSON.parse(readFileSync(entriesPath, 'utf8'));
const candles = JSON.parse(readFileSync(candlesPath, 'utf8'));

// Resolve each entry to its decision-bar index in the matching symbol's candle series.
function resolveEntry(e) {
  const sym = e.symbol.replace('/', '');
  const bars = candles[sym];
  if (!bars) return null;
  const eventTime = Number(e.event_time);
  const idx = bars.findIndex((b) => b[0] === eventTime);
  if (idx < 0) return null;
  return {
    id: e.id,
    symbol: sym,
    strategyId: e.strategy_id,
    entryIdx: idx,
    entryPrice: Number(bars[idx][4]), // decision bar's close
    barsAvailableAfter: bars.length - 1 - idx,
    planJson: e.plan_json,
  };
}

const entries = rawEntries.map(resolveEntry).filter((e) => e !== null);
if (entries.length !== rawEntries.length) {
  // eslint-disable-next-line no-console
  console.error(
    `warning: ${rawEntries.length - entries.length} of ${rawEntries.length} entries did not resolve to a candle bar`,
  );
}

// Simulate one entry through one (tp, sl, hold, mode) cell. Returns exitPrice, netReturn (fraction,
// fees included), barsHeld, exitReason, and censored.
function simulateTrade(bars, entryIdx, entryPrice, tp, sl, hold, mode) {
  const windowEnd = Math.min(entryIdx + hold, bars.length - 1);
  for (let i = entryIdx + 1; i <= windowEnd; i += 1) {
    const bar = bars[i];
    const high = Number(bar[2]);
    const close = Number(bar[4]);
    const stopHit = close <= entryPrice * (1 - sl);
    if (stopHit) {
      return finish(close, 'sl', i - entryIdx, false);
    }
    if (mode === 'A') {
      const tpHit = close >= entryPrice * (1 + tp);
      if (tpHit) return finish(close, 'tp', i - entryIdx, false);
    } else {
      const tpTouch = high >= entryPrice * (1 + tp);
      if (tpTouch) return finish(entryPrice * (1 + tp), 'tp', i - entryIdx, false);
    }
  }
  const censored = windowEnd < entryIdx + hold;
  return finish(Number(bars[windowEnd][4]), 'hold', windowEnd - entryIdx, censored);

  function finish(exitPrice, reason, barsHeld, censored) {
    return {
      exitPrice,
      netReturn: exitPrice / entryPrice - 1 - FEE_ROUND_TRIP,
      barsHeld,
      exitReason: reason,
      censored,
    };
  }
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
function winRate(xs) {
  return xs.length ? xs.filter((x) => x > 0).length / xs.length : null;
}

function runCell(tp, sl, hold, mode) {
  const trades = entries.map((e) => {
    const bars = candles[e.symbol];
    const t = simulateTrade(bars, e.entryIdx, e.entryPrice, tp, sl, hold, mode);
    return { entryId: e.id, symbol: e.symbol, ...t };
  });
  const bpsAll = trades.map((t) => t.netReturn * 10000);
  const excl = trades.filter((t) => !t.censored);
  const bpsExcl = excl.map((t) => t.netReturn * 10000);
  return {
    tp,
    sl,
    hold,
    mode,
    n: trades.length,
    nCensored: trades.length - excl.length,
    meanBps: mean(bpsAll),
    medianBps: median(bpsAll),
    winRate: winRate(bpsAll),
    nExcl: excl.length,
    meanBpsExcl: mean(bpsExcl),
    medianBpsExcl: median(bpsExcl),
    winRateExcl: winRate(bpsExcl),
    trades,
  };
}

const cells = [];
for (const mode of MODES) {
  for (const tp of TP_GRID) {
    for (const sl of SL_GRID) {
      for (const hold of HOLD_GRID) {
        cells.push(runCell(tp, sl, hold, mode));
      }
    }
  }
}

// The single recorded plan_json cell (id 636: tp=0.02, sl=0.012, hold=16), off-grid — computed
// directly for the report's plan_json comparison, not part of the swept grid.
const planCell = { tp: 0.02, sl: 0.012, hold: 16 };
const planCellResults = MODES.map((mode) => runCell(planCell.tp, planCell.sl, planCell.hold, mode));

const ranked = {};
for (const mode of MODES) {
  ranked[mode] = cells
    .filter((c) => c.mode === mode)
    .slice()
    .sort((a, b) => b.meanBps - a.meanBps);
}

// eslint-disable-next-line no-console
console.log(`resolved ${entries.length}/${rawEntries.length} entries; ${cells.length} cells total`);
for (const mode of MODES) {
  // eslint-disable-next-line no-console
  console.log(`\n=== MODE ${mode} — TOP 10 BY MEAN NET BPS/TRADE ===`);
  for (const c of ranked[mode].slice(0, 10)) {
    // eslint-disable-next-line no-console
    console.log(
      `  tp=${c.tp} sl=${c.sl} hold=${c.hold} | mean=${c.meanBps.toFixed(1)}bps median=${c.medianBps.toFixed(1)}bps win=${(c.winRate * 100).toFixed(0)}% N=${c.n} censored=${c.nCensored}`,
    );
  }
}

if (OUT) {
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        config: { TP_GRID, SL_GRID, HOLD_GRID, FEE_ROUND_TRIP },
        entriesResolved: entries.length,
        entriesTotal: rawEntries.length,
        cells,
        planCell: { spec: planCell, results: planCellResults },
      },
      null,
      1,
    ),
  );
  // eslint-disable-next-line no-console
  console.log(`\nwrote ${OUT}`);
}

export { runCell, simulateTrade, resolveEntry, entries, cells, ranked, planCellResults };
