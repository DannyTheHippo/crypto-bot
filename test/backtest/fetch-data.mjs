// Fetch real historical Binance BTC/USDT OHLCV (public REST, no API keys) and cache to JSON.
// Read-only market data for the backtest study — never trades, never touches keys.
// Run: node test/backtest/fetch-data.mjs   (sandbox-disabled for network)
import ccxt from 'ccxt';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const SYMBOL = 'BTC/USDT';
const INTERVAL_MS = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 };
// Target history per interval (bars). Longer intervals span more calendar time for robustness.
const TARGETS = { '1h': 17_520, '15m': 23_000, '5m': 26_000, '1m': 30_000 }; // ~2y / 8mo / 3mo / 3wk

const ex = new ccxt.binance({ enableRateLimit: true });

async function fetchBatchWithRetry(tf, since, limit, tries = 5) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await ex.fetchOHLCV(SYMBOL, tf, since, limit);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  retry ${attempt}/${tries} (since=${since}): ${msg}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error(`fetchOHLCV failed after ${tries} tries at since=${since}`);
}

async function fetchInterval(tf) {
  const out = join(DATA_DIR, `BTCUSDT-${tf}.json`);
  if (existsSync(out)) {
    const existing = JSON.parse(readFileSync(out, 'utf8'));
    console.log(`${tf}: cache exists (${existing.length} bars) — skipping`);
    return;
  }
  const step = INTERVAL_MS[tf];
  const target = TARGETS[tf];
  const now = Date.now();
  let since = now - target * step;
  const bars = [];
  const seen = new Set();
  while (bars.length < target) {
    const batch = await fetchBatchWithRetry(tf, since, 1000);
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
    process.stdout.write(`\r${tf}: ${bars.length} bars (last ${new Date(lastTs).toISOString()})   `);
    if (added === 0 || lastTs >= now - step) break;
  }
  bars.sort((a, b) => a[0] - b[0]);
  writeFileSync(out, JSON.stringify(bars));
  const span = (bars[bars.length - 1][0] - bars[0][0]) / 86_400_000;
  console.log(`\n${tf}: wrote ${bars.length} bars spanning ${span.toFixed(0)} days -> ${out}`);
}

for (const tf of ['1h', '15m', '5m', '1m']) {
  await fetchInterval(tf);
}
console.log('done.');
