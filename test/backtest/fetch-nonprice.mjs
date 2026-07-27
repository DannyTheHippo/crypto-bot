// Backfill the non-price channel series for the study preregistered in
// research/studies/nonprice-channels-2026-07-27.md. Public keyless HTTP only; read-only; never
// trades, never touches keys. Caches to test/backtest/data/ alongside the OHLCV fixtures.
//
//   node test/backtest/fetch-nonprice.mjs wiki     -> nonprice-wiki-<ASSET>.json   (daily views)
//   node test/backtest/fetch-nonprice.mjs dvol     -> nonprice-dvol-<CCY>.json     (hourly index)
//   node test/backtest/fetch-nonprice.mjs gdelt    -> nonprice-gdelt-<QUERY>.json  (tone + volume)
//
// GDELT pacing is load-bearing, not defensive dressing: probe 2026-07-27 found long-span queries
// (>=90d) fail outright at any backoff, while short spans succeed at roughly one request per 5s with
// a STICKY throttle after a burst. So gdelt walks the window in short chunks with generous spacing.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
mkdirSync(DATA_DIR, { recursive: true });

const UA = 'crypto-bot-research/1.0 (offline forward-return study; contact via repo)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Study window: a year of history so the trailing 90-day z-scores have warmup and the scored window
// is still ~9 months. End-stamped by the caller rather than read from the clock at import time.
const START = '20250601';
const END = '20260727';
const startMs = Date.UTC(2025, 5, 1);
const endMs = Date.UTC(2026, 6, 27);

async function getJson(url, { attempts = 5, baseBackoffMs = 12_000, timeoutMs = 60_000 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) return { notFound: true };
      if (res.status === 429 || res.status >= 500) {
        await sleep(baseBackoffMs * (i + 1));
        continue;
      }
      if (!res.ok) return { error: `HTTP ${res.status}` };
      return { json: JSON.parse(await res.text()) };
    } catch (err) {
      if (i === attempts - 1) return { error: err instanceof Error ? err.message : String(err) };
      await sleep(baseBackoffMs * (i + 1));
    }
  }
  return { error: 'exhausted' };
}

// ── Wikipedia daily pageviews ────────────────────────────────────────────────
// Article titles are GUESSES per asset; the API 404s on a miss, so each asset carries candidates
// tried in order and the first that returns data wins. The resolved title is stored WITH the series
// so a later reader can audit which page a signal was actually built from — an altcoin whose article
// is a disambiguation stub is a thin signal, and that must be visible rather than inferred.
const WIKI_ARTICLES = {
  BTC: ['Bitcoin'],
  ETH: ['Ethereum'],
  SOL: ['Solana_(blockchain_platform)', 'Solana'],
  XRP: ['XRP', 'Ripple_(payment_protocol)'],
  LINK: ['Chainlink_(blockchain_oracle)', 'Chainlink'],
  AAVE: ['Aave', 'Aave_(company)'],
  NEAR: ['NEAR_Protocol', 'Near_Protocol'],
  ZEC: ['Zcash'],
  DOGE: ['Dogecoin'],
  ADA: ['Cardano_(blockchain_platform)', 'Cardano_(cryptocurrency)'],
  AVAX: ['Avalanche_(blockchain_platform)', 'Avalanche_(cryptocurrency)'],
  LTC: ['Litecoin'],
  UNI: ['Uniswap'],
  BCH: ['Bitcoin_Cash'],
  DOT: ['Polkadot_(cryptocurrency)', 'Polkadot_(blockchain_platform)'],
  TRX: ['Tron_(cryptocurrency)', 'TRON_(cryptocurrency)'],
};

async function fetchWiki() {
  const summary = [];
  for (const [asset, candidates] of Object.entries(WIKI_ARTICLES)) {
    let resolved = null;
    for (const article of candidates) {
      const url =
        `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/` +
        `all-access/user/${encodeURIComponent(article)}/daily/${START}/${END}`;
      const { json, notFound, error } = await getJson(url, { baseBackoffMs: 3000 });
      if (notFound || error || !Array.isArray(json?.items) || json.items.length === 0) {
        await sleep(400);
        continue;
      }
      resolved = { article, items: json.items };
      break;
    }
    if (resolved === null) {
      summary.push(`${asset}: NO ARTICLE RESOLVED (${candidates.join(' | ')})`);
      continue;
    }
    const series = resolved.items.map((r) => ({
      // timestamp is 'YYYYMMDD00' — normalise to a UTC midnight epoch so joins are unambiguous.
      ts: Date.UTC(
        Number(r.timestamp.slice(0, 4)),
        Number(r.timestamp.slice(4, 6)) - 1,
        Number(r.timestamp.slice(6, 8)),
      ),
      views: r.views,
    }));
    const meanViews = Math.round(series.reduce((s, p) => s + p.views, 0) / series.length);
    writeFileSync(
      join(DATA_DIR, `nonprice-wiki-${asset}.json`),
      JSON.stringify({ asset, article: resolved.article, series }),
      'utf8',
    );
    summary.push(
      `${asset}: article=${resolved.article} points=${series.length} meanViews/day=${meanViews}`,
    );
    await sleep(400);
  }
  console.log(summary.join('\n'));
}

// ── Deribit DVOL (BTC, ETH) ──────────────────────────────────────────────────
// 1000 points per call plus a `continuation` token. Paginate BACKWARD from the window end until the
// window start is covered or the token stops advancing.
async function fetchDvol() {
  for (const ccy of ['BTC', 'ETH']) {
    const points = new Map();
    let end = endMs;
    for (let page = 0; page < 40; page += 1) {
      const url =
        `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${ccy}` +
        `&start_timestamp=${startMs}&end_timestamp=${end}&resolution=3600`;
      const { json, error } = await getJson(url, { baseBackoffMs: 4000 });
      if (error) {
        console.log(`${ccy}: page ${page} error ${error}`);
        break;
      }
      const data = json?.result?.data ?? [];
      if (data.length === 0) break;
      for (const [ts, o, h, l, c] of data)
        points.set(ts, { ts, open: o, high: h, low: l, close: c });
      const cont = json.result?.continuation;
      const oldest = data[0][0];
      if (oldest <= startMs) break;
      const next = typeof cont === 'number' ? cont : oldest;
      if (next >= end) break; // token not advancing — stop rather than loop
      end = next;
      await sleep(400);
    }
    const series = [...points.values()].sort((a, b) => a.ts - b.ts);
    writeFileSync(
      join(DATA_DIR, `nonprice-dvol-${ccy}.json`),
      JSON.stringify({ currency: ccy, series }),
      'utf8',
    );
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    console.log(
      `${ccy}: points=${series.length} ${iso(series[0]?.ts)} -> ${iso(series[series.length - 1]?.ts)}`,
    );
  }
}

// ── GDELT tone + volume ──────────────────────────────────────────────────────
// Walks the window in short chunks. Long spans were probe-verified to fail at any backoff, so chunk
// size is the thing that makes this work at all. Partial coverage is written out and REPORTED rather
// than retried forever — a channel that can only be half-backfilled is a finding about the channel.
async function fetchGdelt() {
  const queries = { bitcoin: 'bitcoin', ethereum: 'ethereum', crypto: 'cryptocurrency' };
  const CHUNK_DAYS = 7;
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14);

  for (const [name, query] of Object.entries(queries)) {
    const out = { tone: [], vol: [] };
    let ok = 0;
    let fail = 0;
    for (let t = startMs; t < endMs; t += CHUNK_DAYS * 86_400_000) {
      const chunkEnd = Math.min(t + CHUNK_DAYS * 86_400_000, endMs);
      for (const [mode, key] of [
        ['timelinetone', 'tone'],
        ['timelinevol', 'vol'],
      ]) {
        const url =
          `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}` +
          `&mode=${mode}&startdatetime=${stamp(t)}&enddatetime=${stamp(chunkEnd)}&format=json`;
        const { json, error } = await getJson(url, { attempts: 3, baseBackoffMs: 15_000 });
        if (error || !Array.isArray(json?.timeline?.[0]?.data)) {
          fail += 1;
        } else {
          ok += 1;
          for (const p of json.timeline[0].data) {
            const d = p.date; // 'YYYYMMDDTHHMMSSZ'
            out[key].push({
              ts: Date.UTC(
                Number(d.slice(0, 4)),
                Number(d.slice(4, 6)) - 1,
                Number(d.slice(6, 8)),
                Number(d.slice(9, 11)),
                Number(d.slice(11, 13)),
              ),
              value: p.value,
            });
          }
        }
        await sleep(6000); // the documented floor is 5s; 6 leaves margin without crawling
      }
    }
    const dedupe = (rows) => {
      const m = new Map();
      for (const r of rows) m.set(r.ts, r);
      return [...m.values()].sort((a, b) => a.ts - b.ts);
    };
    const series = { query, tone: dedupe(out.tone), vol: dedupe(out.vol) };
    writeFileSync(join(DATA_DIR, `nonprice-gdelt-${name}.json`), JSON.stringify(series), 'utf8');
    console.log(
      `${name}: chunks ok=${ok} fail=${fail} tonePoints=${series.tone.length} volPoints=${series.vol.length}`,
    );
  }
}

const which = process.argv[2];
if (which === 'wiki') await fetchWiki();
else if (which === 'dvol') await fetchDvol();
else if (which === 'gdelt') await fetchGdelt();
else {
  console.error('usage: fetch-nonprice.mjs <wiki|dvol|gdelt>');
  process.exit(1);
}
