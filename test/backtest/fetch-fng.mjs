// Fetch the full Fear & Greed index history (alternative.me, public REST, no API key) and cache to
// JSON. Read-only sentiment data for the non-price backtest sweep — never trades, never touches
// keys. Mirrors fetch-data.mjs's conventions (retry loop, DATA_DIR cache, sandbox-disabled network).
//
//   node test/backtest/fetch-fng.mjs
//
// Writes test/backtest/data/fng.json as [{ timestamp: <ms>, value: <0-100 int> }, ...] ascending by
// timestamp (the source API returns newest-first; this script re-sorts and normalizes the value to a
// number — the index itself is a research signal, never a money path, so a plain number is fine here,
// unlike ccxt fill/order paths which must stay Decimal/string).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const URL = 'https://api.alternative.me/fng/?limit=0&format=json';

async function fetchWithRetry(tries = 5) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  retry ${attempt}/${tries}: ${msg}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error(`fng fetch failed after ${tries} tries`);
}

const body = await fetchWithRetry();
const rows = (body.data ?? [])
  .map((r) => ({ timestamp: Number(r.timestamp) * 1000, value: Number(r.value) }))
  .sort((a, b) => a.timestamp - b.timestamp);

const out = join(DATA_DIR, 'fng.json');
writeFileSync(out, JSON.stringify(rows));
const first = new Date(rows[0].timestamp).toISOString();
const last = new Date(rows[rows.length - 1].timestamp).toISOString();
console.log(`fng: wrote ${rows.length} rows spanning ${first} -> ${last} -> ${out}`);
