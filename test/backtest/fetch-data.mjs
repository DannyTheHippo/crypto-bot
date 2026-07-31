// Fetch real historical Binance OHLCV (public REST, no API keys) and cache to JSON. Read-only market
// data for the backtest study — never trades, never touches keys.
//
// Legacy invocation (no args): node test/backtest/fetch-data.mjs
//   Refreshes the fixed BTC/USDT spot BTCUSDT-{tf}.json files the recovered indicators/sanity-gate
//   fixtures pin against (unchanged behavior from the pre-rebuild script).
//
// Extended invocation: node test/backtest/fetch-data.mjs <SYMBOL> <TIMEFRAME> <targetBars> [--funding]
//   e.g. node test/backtest/fetch-data.mjs BTC/USDT:USDT 4h 500 --funding
//   TIMEFRAME is one of 15m/1h/4h/1d. Writes test/backtest/data/ohlcv-<SYMBOL>-<TIMEFRAME>.json, and
//   with --funding also test/backtest/data/funding-<SYMBOL>.json via fetchFundingRateHistory (SYMBOL
//   must be a linear-swap market, e.g. 'BTC/USDT:USDT' — spot markets carry no funding).
//   targetBars is REQUIRED — no implicit default. Both cache writes go through writeCacheNoShrink,
//   which refuses to overwrite a longer on-disk history with a shorter one (raise targetBars or set
//   FETCH_DATA_ALLOW_SHRINK=1 to overwrite deliberately).
//
// Sandbox-disabled for network either way (public REST only).
import ccxt from 'ccxt';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const INTERVAL_MS = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

const ex = new ccxt.binance({ enableRateLimit: true });

async function fetchWithRetry(fn, args, tries = 5) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn(...args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  retry ${attempt}/${tries}: ${msg}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error(`fetch failed after ${tries} tries`);
}

// Generic since/limit-paged OHLCV fetch for ANY symbol × timeframe. Both the legacy BTC/USDT fetch and
// the extended arbitrary-symbol fetch below share this one paging loop.
async function fetchOhlcvPaged(symbol, tf, sinceStart, targetBars, pageLimit = 1000) {
  const step = INTERVAL_MS[tf];
  if (!step) throw new Error(`unsupported timeframe: ${tf}`);
  const now = Date.now();
  let since = sinceStart;
  const bars = [];
  const seen = new Set();
  while (bars.length < targetBars) {
    const batch = await fetchWithRetry(ex.fetchOHLCV.bind(ex), [symbol, tf, since, pageLimit]);
    if (!batch || batch.length === 0) break;
    let added = 0;
    for (const b of batch) {
      if (seen.has(b[0])) continue;
      seen.add(b[0]);
      bars.push(b);
      added++;
    }
    const lastTs = batch[batch.length - 1][0];
    since = lastTs + step;
    process.stdout.write(
      `\r${symbol} ${tf}: ${bars.length} bars (last ${new Date(lastTs).toISOString()})   `,
    );
    if (added === 0 || lastTs >= now - step) break;
  }
  bars.sort((a, b) => a[0] - b[0]);
  return bars;
}

// Since/limit-paged funding rate history for a swap symbol. fundingRate is persisted as a decimal
// STRING (money-adjacent input to test/backtest/funding.ts's Decimal math) — never a bare float.
async function fetchFundingHistoryPaged(symbol, sinceStart, targetRows, pageLimit = 1000) {
  const now = Date.now();
  let since = sinceStart;
  const rows = [];
  const seen = new Set();
  while (rows.length < targetRows) {
    const batch = await fetchWithRetry(ex.fetchFundingRateHistory.bind(ex), [
      symbol,
      since,
      pageLimit,
    ]);
    if (!batch || batch.length === 0) break;
    let added = 0;
    for (const r of batch) {
      const ts = r.timestamp;
      if (ts === undefined || ts === null || seen.has(ts)) continue;
      seen.add(ts);
      rows.push({ timestamp: ts, fundingRate: String(r.fundingRate) });
      added++;
    }
    const lastTs = batch[batch.length - 1].timestamp;
    since = lastTs + 1;
    process.stdout.write(
      `\r${symbol} funding: ${rows.length} rows (last ${new Date(lastTs).toISOString()})   `,
    );
    if (added === 0 || lastTs >= now) break;
  }
  rows.sort((a, b) => a.timestamp - b.timestamp);
  return rows;
}

// ── Legacy fixed BTC/USDT spot fetch ──────────────────────────────────────────────────────────────
const LEGACY_SYMBOL = 'BTC/USDT';
const LEGACY_TARGETS = { '1h': 17_520, '15m': 23_000, '5m': 26_000, '1m': 30_000 }; // ~2y/8mo/3mo/3wk

async function fetchLegacyInterval(tf) {
  const out = join(DATA_DIR, `BTCUSDT-${tf}.json`);
  if (existsSync(out)) {
    const existing = JSON.parse(readFileSync(out, 'utf8'));
    console.log(`${tf}: cache exists (${existing.length} bars) — skipping`);
    return;
  }
  const target = LEGACY_TARGETS[tf];
  const bars = await fetchOhlcvPaged(
    LEGACY_SYMBOL,
    tf,
    Date.now() - target * INTERVAL_MS[tf],
    target,
  );
  writeFileSync(out, JSON.stringify(bars));
  const span = (bars[bars.length - 1][0] - bars[0][0]) / 86_400_000;
  console.log(`\n${tf}: wrote ${bars.length} bars spanning ${span.toFixed(0)} days -> ${out}`);
}

// ── Extended arbitrary symbol × timeframe fetch ───────────────────────────────────────────────────
const EXT_TIMEFRAMES = new Set(['15m', '1h', '4h', '1d']);

function safeName(symbol) {
  return symbol.replace(/[/:]/g, '');
}

// Refuses to shrink an on-disk cache — fails CLOSED for WRITING: a write that would replace a longer
// history with a shorter one is refused rather than silently truncating; a write that genuinely
// extends coverage is never blocked. Assumes row count is a valid span proxy for both writers: the
// OHLCV filename carries the tf so count is monotone in span for a given file; funding row count is
// proportional to span and every window ends at ~now, so a larger count is always a superset window,
// never a shifted one.
function writeCacheNoShrink(path, next, label) {
  let onDisk = 0;
  if (existsSync(path)) {
    try {
      // A non-array cache is as untrustworthy a span reference as an unparseable one — both read as
      // 0 so the file stays refetchable rather than being locked behind FETCH_DATA_ALLOW_SHRINK.
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      onDisk = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      onDisk = 0;
    }
  }
  if (onDisk > next.length) {
    if (process.env.FETCH_DATA_ALLOW_SHRINK === '1') {
      console.warn(
        `${label}: overwriting ${onDisk}-row cache at ${path} with ${next.length} rows (FETCH_DATA_ALLOW_SHRINK=1)`,
      );
    } else {
      throw new Error(
        `${label}: refusing to shrink ${path} from ${onDisk} rows to ${next.length} rows — raise ` +
          `targetBars (the window is targetBars x timeframe) or set FETCH_DATA_ALLOW_SHRINK=1 to ` +
          `overwrite deliberately`,
      );
    }
  }
  writeFileSync(path, JSON.stringify(next));
}

async function fetchExtended(symbol, tf, targetBars, withFunding) {
  if (!EXT_TIMEFRAMES.has(tf)) {
    throw new Error(`extended fetch supports ${[...EXT_TIMEFRAMES].join('/')}, got ${tf}`);
  }
  const ohlcvOut = join(DATA_DIR, `ohlcv-${safeName(symbol)}-${tf}.json`);
  const bars = await fetchOhlcvPaged(
    symbol,
    tf,
    Date.now() - targetBars * INTERVAL_MS[tf],
    targetBars,
  );
  if (bars.length < targetBars) {
    console.warn(`${symbol} ${tf}: venue returned ${bars.length} of ${targetBars} requested bars`);
  }
  writeCacheNoShrink(ohlcvOut, bars, `${symbol} ${tf}`);
  console.log(`\n${symbol} ${tf}: wrote ${bars.length} bars -> ${ohlcvOut}`);

  if (withFunding) {
    const fundingOut = join(DATA_DIR, `funding-${safeName(symbol)}.json`);
    // ~3 funding events/day on Binance perps; size the funding window to match the OHLCV request.
    // The filename carries no tf, so this span (targetBars x tf) is the ONLY thing distinguishing one
    // symbol's funding pull from another's on disk — a short-timeframe fetch competes for the same
    // file as a long-history study. Kept as-is: three readers depend on the tf-less name
    // (carry/carry-grid.ts, agentic-replay.ts, multi-strategy/funding-signal.mjs) — renaming it is a
    // larger, separate change.
    const days = (targetBars * INTERVAL_MS[tf]) / 86_400_000;
    const rows = await fetchFundingHistoryPaged(
      symbol,
      Date.now() - days * 86_400_000,
      Math.ceil(days * 3) + 10,
    );
    writeCacheNoShrink(fundingOut, rows, `${symbol} funding`);
    console.log(`${symbol} funding: wrote ${rows.length} rows -> ${fundingOut}`);
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────────────────────────
const [, , symArg, tfArg, targetArg, ...rest] = process.argv;

if (symArg && tfArg) {
  if (!targetArg) {
    throw new Error('targetBars is required for the extended invocation — see file header usage');
  }
  const targetBars = Number(targetArg);
  if (!Number.isInteger(targetBars) || targetBars <= 0) {
    // Number('abc') is NaN, and `bars.length < NaN` is always false — an unguarded NaN skips the
    // paging loop entirely and writes an EMPTY array over whatever cache already exists.
    throw new Error(`targetBars must be a positive integer, got '${targetArg}'`);
  }
  const withFunding = rest.includes('--funding');
  await fetchExtended(symArg, tfArg, targetBars, withFunding);
  console.log('done.');
} else {
  for (const tf of ['1h', '15m', '5m', '1m']) {
    await fetchLegacyInterval(tf);
  }
  console.log('done.');
}
