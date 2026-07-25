#!/usr/bin/env node
// Fetch public datasets for the edge-tournament (manifest + cache only — no outcome scorecards).
// Read-only REST/ccxt; never trades, never touches secrets.
//
//   node scripts/fetch-edge-tournament-data.mjs [--smoke] [--manifest-only]
//   pnpm fetch:edge-tournament
//
// Writes gitignored caches under test/backtest/edge-tournament/cache/ and updates manifest.json.
// Full historical pulls are intentionally opt-in; default --smoke fetches ~200 daily bars per symbol.
import ccxt from 'ccxt';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE_DIR = join(ROOT, 'test/backtest/edge-tournament/cache');
const MANIFEST_PATH = join(CACHE_DIR, 'manifest.json');

const UNIVERSE = [
  'BTC/USDT:USDT',
  'ETH/USDT:USDT',
  'SOL/USDT:USDT',
  'ZEC/USDT:USDT',
  'AAVE/USDT:USDT',
  'NEAR/USDT:USDT',
  'HYPE/USDT:USDT',
  'KAITO/USDT:USDT',
  'TRUMP/USDT:USDT',
  'UNI/USDT:USDT',
  'BCH/USDT:USDT',
  'XRP/USDT:USDT',
  'LINK/USDT:USDT',
  'AVAX/USDT:USDT',
  'SUI/USDT:USDT',
  'LTC/USDT:USDT',
];

const FUNDING_VENUES = [
  { id: 'binanceusdm', ccxtId: 'binanceusdm' },
  { id: 'bybit', ccxtId: 'bybit' },
  { id: 'okx', ccxtId: 'okx' },
];

const DAY_MS = 86_400_000;
const SEGMENT_START = Date.parse('2023-07-25T00:00:00.000Z');
const SEGMENT_END = Date.parse('2026-07-25T00:00:00.000Z');

const smoke = process.argv.includes('--smoke') || !process.argv.includes('--full');
const manifestOnly = process.argv.includes('--manifest-only');

mkdirSync(CACHE_DIR, { recursive: true });

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function safeName(symbol) {
  return symbol.replace(/[/:]/g, '');
}

async function fetchWithRetry(fn, tries = 5) {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  retry ${attempt}/${tries}: ${msg}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error('fetch failed after retries');
}

async function fetchOhlcv1d(ex, symbol, targetBars) {
  const since = smoke ? Date.now() - targetBars * DAY_MS : SEGMENT_START;
  const limit = 1000;
  let cursor = since;
  const bars = [];
  const seen = new Set();
  while (bars.length < targetBars) {
    const batch = await fetchWithRetry(() => ex.fetchOHLCV(symbol, '1d', cursor, limit));
    if (!batch?.length) break;
    for (const b of batch) {
      if (seen.has(b[0])) continue;
      seen.add(b[0]);
      if (b[0] >= SEGMENT_END) continue;
      bars.push(b);
    }
    const last = batch[batch.length - 1][0];
    cursor = last + DAY_MS;
    process.stdout.write(`\r${symbol} 1d: ${bars.length} bars`);
    if (last >= Date.now() - DAY_MS) break;
  }
  bars.sort((a, b) => a[0] - b[0]);
  console.log('');
  return bars;
}

async function fetchFunding(ex, symbol, targetRows) {
  const since = smoke ? Date.now() - 90 * DAY_MS : SEGMENT_START;
  let cursor = since;
  const rows = [];
  const seen = new Set();
  while (rows.length < targetRows) {
    const batch = await fetchWithRetry(() => ex.fetchFundingRateHistory(symbol, cursor, 1000));
    if (!batch?.length) break;
    for (const r of batch) {
      if (seen.has(r.timestamp)) continue;
      seen.add(r.timestamp);
      rows.push({ timestamp: r.timestamp, fundingRate: String(r.fundingRate) });
    }
    cursor = batch[batch.length - 1].timestamp + 1;
    process.stdout.write(`\r${symbol} funding@${ex.id}: ${rows.length} rows`);
    if (batch[batch.length - 1].timestamp >= Date.now()) break;
  }
  rows.sort((a, b) => a.timestamp - b.timestamp);
  console.log('');
  return rows;
}

function parseGdeltDateMs(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  // GDELT DOC timeline: YYYYMMDDTHHMMSSZ (Date.parse alone returns NaN)
  const withT = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/i.exec(s);
  if (withT) {
    return Date.UTC(
      Number(withT[1]),
      Number(withT[2]) - 1,
      Number(withT[3]),
      Number(withT[4]),
      Number(withT[5]),
      Number(withT[6]),
    );
  }
  // Compact without T: YYYYMMDDHHMMSS or YYYYMMDD
  const compact = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?$/.exec(s);
  if (compact) {
    return Date.UTC(
      Number(compact[1]),
      Number(compact[2]) - 1,
      Number(compact[3]),
      Number(compact[4] ?? 0),
      Number(compact[5] ?? 0),
      Number(compact[6] ?? 0),
    );
  }
  // ISO / RFC-ish / "YYYY-MM-DD HH:MM:SS"
  const normalized = s.includes('T') ? s : `${s.replace(' ', 'T')}${s.endsWith('Z') ? '' : 'Z'}`;
  const iso = Date.parse(normalized);
  return Number.isFinite(iso) ? iso : null;
}

async function fetchGdeltTimeline() {
  // Prefer tone (prereg news1d-asymmetric); fall back to volume timeline if tone is empty/rate-limited.
  const modes = ['timelinetone', 'timelinevolinfo'];
  let lastErr;
  for (const mode of modes) {
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=cryptocurrency&mode=${mode}&timespan=90d&format=json`;
    try {
      const res = await fetchWithRetry(() => fetch(url));
      if (!res.ok) throw new Error(`GDELT HTTP ${res.status} mode=${mode}`);
      const text = await res.text();
      if (text.startsWith('Please limit')) throw new Error(`GDELT rate-limited mode=${mode}`);
      const body = JSON.parse(text);
      const series = body?.timeline?.[0]?.data ?? [];
      const rows = [];
      for (const p of series) {
        const publishedMs = parseGdeltDateMs(p.date);
        if (publishedMs === null) continue;
        rows.push({ publishedMs, toneZ: String(p.value ?? 0) });
      }
      if (rows.length === 0) throw new Error(`GDELT ${mode}: 0 parseable rows`);
      rows.sort((a, b) => a.publishedMs - b.publishedMs);
      console.log(
        `GDELT ${mode}: ${rows.length} rows (${new Date(rows[0].publishedMs).toISOString()} .. ${new Date(rows.at(-1).publishedMs).toISOString()})`,
      );
      return { url: url.split('?')[0], rows, mode };
    } catch (err) {
      lastErr = err;
      console.warn(String(err));
      await new Promise((r) => setTimeout(r, 6000));
    }
  }
  throw lastErr ?? new Error('GDELT fetch failed');
}

function datasetEntry(id, url, requestParams, rows, cachePath) {
  const content = readFileSync(cachePath, 'utf8');
  const parsed = JSON.parse(content);
  const arr = Array.isArray(parsed) ? parsed : (parsed.rows ?? []);
  const firstTs = arr[0]?.[0] ?? arr[0]?.timestamp ?? arr[0]?.publishedMs ?? null;
  const lastTs =
    arr[arr.length - 1]?.[0] ??
    arr[arr.length - 1]?.timestamp ??
    arr[arr.length - 1]?.publishedMs ??
    null;
  return {
    id,
    url,
    requestParams,
    rangeStartMs: firstTs,
    rangeEndMs: lastTs,
    rowCount: arr.length,
    sha256: sha256(content),
    cachePath: cachePath.replace(ROOT + '/', ''),
  };
}

const datasets = [];

if (!manifestOnly) {
  const binance = new ccxt.binanceusdm({ enableRateLimit: true });
  await binance.loadMarkets();
  const targetBars = smoke ? 200 : Math.ceil((SEGMENT_END - SEGMENT_START) / DAY_MS) + 5;

  for (const symbol of UNIVERSE) {
    if (!binance.markets[symbol]) {
      console.warn(`skip OHLCV (market missing): ${symbol}`);
      continue;
    }
    const out = join(CACHE_DIR, `ohlcv-${safeName(symbol)}-1d.json`);
    const bars = await fetchOhlcv1d(binance, symbol, targetBars);
    writeFileSync(out, JSON.stringify(bars));
    datasets.push(
      datasetEntry(
        `ohlcv-${safeName(symbol)}-1d`,
        'https://fapi.binance.com/fapi/v1/klines',
        { symbol: safeName(symbol), interval: '1d', smoke },
        bars,
        out,
      ),
    );
  }

  for (const venue of FUNDING_VENUES) {
    const ex = new ccxt[venue.ccxtId]({ enableRateLimit: true });
    await ex.loadMarkets();
    for (const symbol of ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT']) {
      if (!ex.markets[symbol]) continue;
      const out = join(CACHE_DIR, `funding-${venue.id}-${safeName(symbol)}.json`);
      const rows = await fetchFunding(ex, symbol, smoke ? 270 : 2000);
      writeFileSync(out, JSON.stringify(rows));
      datasets.push(
        datasetEntry(
          `funding-${venue.id}-${safeName(symbol)}`,
          `${venue.id} fetchFundingRateHistory`,
          { symbol, venue: venue.id, smoke },
          rows,
          out,
        ),
      );
    }
  }

  try {
    const gdeltOut = join(CACHE_DIR, 'gdelt-crypto-news.json');
    // GDELT DOC timeline is rate-limited; retry with backoff before giving up.
    let lastErr;
    let gdelt;
    for (let i = 1; i <= 6; i += 1) {
      try {
        gdelt = await fetchGdeltTimeline();
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        const wait = 2000 * i;
        console.warn(`GDELT retry ${i}/6 after ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    if (!gdelt) throw lastErr ?? new Error('GDELT failed');
    const { url, rows, mode } = gdelt;
    writeFileSync(gdeltOut, JSON.stringify(rows));
    datasets.push(
      datasetEntry(
        'gdelt-crypto-news',
        url.split('?')[0],
        { query: 'cryptocurrency', mode, timespan: '90d', smoke },
        rows,
        gdeltOut,
      ),
    );
  } catch (err) {
    console.warn('GDELT fetch skipped:', err instanceof Error ? err.message : String(err));
  }
} else if (existsSync(MANIFEST_PATH)) {
  const prior = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  datasets.push(...(prior.datasets ?? []));
}

const manifest = {
  version: 1,
  frozenAt: '2026-07-24',
  preregReport: 'research/studies/edge-tournament-preregistration-2026-07-24.md',
  datasets,
};

writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
console.log(`manifest: ${datasets.length} datasets -> ${MANIFEST_PATH.replace(ROOT + '/', '')}`);
console.log('done (outcome scorecards NOT produced — tooling/manifest only).');
