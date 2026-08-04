#!/usr/bin/env node
// REALISED entry forward return — PURE logic. No I/O, no clock, no process/env access, and it NEVER
// throws: given the entry rows and the price-grid rows the runner probed out of `agent_decisions`,
// derive per-(playbook_version x population x horizon) forward-return cells and the annotations that
// disclose everything the data could not answer. The runner (loop-forward-return.mjs) only gathers
// rows and renders what this returns.
//
// FAILURE DIRECTION — this is a MEASUREMENT and it FAILS OPEN. It emits ANNOTATIONS ONLY. It can
// never block a pass, a deploy, or trading, and it deliberately carries NO `alarms` key: the pass
// procedure turns any alarm into a defect investigation, and WATCH-PLAYBOOK-V10-1 is explicitly
// SYMMETRIC — a divergence between replay-predicted and live-realised entry return is a FINDING in
// either direction, not a fault. An adverse result is the measurement working, not the lane breaking.
// Every "cannot determine" path emits its OWN NAMED annotation; there is never one silent "no data",
// because an absence that reads as a clean zero is the exact defect class this loop keeps finding.
//
// WHY THIS IS CHEAP — the verified journal-close convention. `agent_decisions.close` at
// `event_time = E` is the close of the 15m bar whose OPEN is E, so the journal IS a dense 15-minute
// price grid and no candle fetching is needed. Verified 2026-07-31, not assumed:
//   * market-data/normalize.ts:206,209 — `eventTime: epochMs(openTimeMs)` and
//     `openTime: epochMs(openTimeMs)` are the SAME expression: a normalized candle stamps
//     eventTime = openTime.
//   * strategy-host.ts:458 — the snapshot carries the triggering candle's own eventTime through
//     verbatim, and that candle is the last element of history (:374-383), so for a candle trigger
//     `snapshot.eventTime === lastCandle.openTime`.
//   * strategy-host.ts:376-378 — "Partial candles never enter history and are never a trigger", so
//     the stamped close is a CLOSED bar's close.
//   * agentic.strategy.ts:3039 / :3093 / :3146 — the three (and only) journal writers all stamp
//     `close: lastCandle.close` beside `eventTime: input.snapshot.eventTime`.
//   * anthropic-agent-client.spec.ts:321-360 pins the relationship directly.
// Density comes from quiet/prescreen rows (agentic.strategy.ts:3146) being journaled per symbol per
// bar, so holds — not just trades — carry the grid.
//
// THE ONE EXCEPTION, and why the runner filters on it: `trigger_kind = 'exec'` rows BREAK the
// convention. strategy-host.ts:458 passes `item.event.eventTime` for every mailbox kind, and an
// ExecReport's eventTime is a FILL time (exec-report.ts:11), not bar-aligned — on such a row `close`
// is still a closed bar's close, but that bar opened strictly earlier than `event_time`. Both queries
// therefore restrict to `trigger_kind = 'candle'`, and this core additionally refuses any row whose
// event_time is off the 15m grid rather than trusting the filter alone.

// ── frozen constants ─────────────────────────────────────────────────────────────────────────────

/** The bar. STRATEGY_INTERVAL=15m (.env.app:73); INTERVAL_MS['15m'] (normalize.ts:155). */
export const BAR_MS = 900_000;

/** Ported from playbook-space-replay.ts:46 so live and replay are scored at the same horizons. */
export const HORIZONS = [1, 4, 8, 24];

/**
 * Ported from playbook-space-replay.ts:66 — "Never act on a sub-n>=12 cell", the loop's standing bar
 * after its own n=11 horizon cell reversed at n=84.
 */
export const MIN_ENTRIES = 12;

/**
 * The CLUSTER floor, declared NOW — before any live data exists — precisely so it can never be chosen
 * once something is known about the result.
 *
 * The bootstrap below resamples BASE ASSETS, not rows and not symbol strings. With k clusters every
 * resampled mean is an average over k draws from a k-element set, so the statistic lives on a small
 * discrete lattice: at k=3 the bootstrap distribution has at most 10 distinct values and its
 * 2.5%/97.5% order statistics are essentially the min and max of three numbers. That interval is an
 * ARTIFACT OF THE LATTICE, not a measurement of sampling error — it will look narrow or wide according
 * to which three assets happened to trade, and it cannot be read as 95% coverage of anything. Five is
 * the smallest k at which the lattice is dense enough (>= 126 distinct multisets) for the order
 * statistics to mean what they are printed as. n >= 12 alone does NOT rescue this: 20 entries
 * concentrated on 3 assets is 3 effective observations for a cluster bootstrap, which is why the two
 * clauses are independent.
 *
 * BASE ASSET, not symbol string, because the trading universe is 40 symbol strings over only 28
 * distinct base assets — twelve bases trade on BOTH venues (spot `BTC/USDT` and perp
 * `BTC/USDT:USDT`), and the measured spot/perp h=24 forward-return correlation for the same base is
 * 0.9993-0.9999. A same-base cross-venue pair is ~one observation wearing two symbol strings, not two
 * independent ones, so clustering on the raw symbol let a 3-base cell through this floor by counting
 * to 5 or 6 distinct strings first.
 */
export const MIN_CLUSTERS = 5;

/**
 * The base asset of a ccxt symbol string — the part before the first `/`. `BTC/USDT` (spot) and
 * `BTC/USDT:USDT` (USDⓈ-M perp) both yield `BTC`. This is the unit the cluster bootstrap resamples —
 * see MIN_CLUSTERS above for why the raw symbol string double-counts.
 *
 * Exported so a later study clusters on the SAME unit by importing this rather than re-deriving it —
 * `scripts/loop-oos-arm-core.mjs`'s paired bootstrap is the first consumer (a redefined clustering
 * function is as silently-different a study as a redefined constant, see the module header above).
 */
export function baseAsset(symbol) {
  const i = symbol.indexOf('/');
  return i === -1 ? symbol : symbol.slice(0, i);
}

/** Ported from playbook-space-replay.ts:385. */
export const N_BOOT = 20_000;

/**
 * FROZEN bootstrap seed. The point of naming it is reproducibility: two passes over identical rows
 * must produce byte-identical intervals, or a pass could re-roll an interval until it liked it.
 */
export const BOOTSTRAP_SEED = 20260731;

/**
 * Above this share of NON-BENIGN misses at a horizon, that horizon reads UNDETERMINED instead of
 * reporting the subsample that survived.
 *
 * Gaps are NOT missing-at-random. The lane goes down during incidents, and incidents correlate with
 * market events — so the bars that vanish from the grid are disproportionately the violent ones, and
 * a mean over the bars that remain is biased toward calm. A horizon missing a fifth of its forward
 * bars is not a noisy reading, it is a reading of a different population.
 */
export const MAX_GAP_SHARE = 0.2;

/**
 * THE ANCHOR IS NOT THE DECISION INSTANT, and this module now says so on every read.
 *
 * `c0` in forwardBps is the close of the bar whose OPEN is `event_time` — the price at
 * `event_time + BAR_MS`. The lane's direction is fixed LATER: buildSnapshot materializes the live
 * ticker/book maps at call time (strategy-host.ts:518-549, :425-427) and those maps REACH THE MODEL —
 * agent-prompt.ts:1343-1345 renders `ticker {bid,ask,last}` and :1372 splices in the `orderBook` block
 * (:840). Measured on the 94 entry rows: 94/94 payloads carry an orderBook block, 83/94 a non-null
 * ticker. So `dir` is chosen knowing part of the move being measured, and no order could have been
 * filled at this anchor.
 *
 * MEASURED, not assumed, on the exact ENTRY_SQL population (loop-forward-return.mjs:44-49), n=94,
 * as of 2026-08-04:
 *   select (extract(epoch from created_at)*1000 - event_time - 900000 - coalesce(latency_ms,0))
 *   from agent_decisions
 *   where action in ('open_long','open_short') and strategy_id not like 'replay-%'
 *     and trigger_kind = 'candle'
 *   -> p50 16.2s, min 1.3s, max 55.5s.
 *
 * `latency_ms` is SUBTRACTED deliberately. `created_at` is the journal WRITE time (defaultNow() at
 * insert) and lands after the LLM round trip (p50 9.5s), which happens AFTER the information set is
 * frozen — think time cannot buy look-ahead. prereg :452 quotes 28.3s; that is the write lag, and only
 * the information lag bounds an artifact.
 */
export const ANCHOR_LAG_SECONDS = { p50: 16.2, min: 1.3, max: 55.5 };

/**
 * HOW BIG THE LOOK-AHEAD ACTUALLY IS — measured on these rows, not extrapolated onto them.
 *
 * `agent_decisions.ref_price` IS the `ticker.last` the model saw ON 83/94 ROWS: deriveMarketBasis
 * (agentic.strategy.ts:3004-3008) reads the SAME `input.snapshot.tickers` map agent-prompt.ts:1307
 * renders from, but FALLS BACK to `lastCandle.close` when the ticker map carries no entry for the
 * symbol — the other 11/94 rows. Verified: every one of those 11 has `ref_price === close` EXACTLY,
 * so they carry a STRUCTURAL zero drift (a floor, not a reading) and dilute a pooled E|.| downward if
 * folded in uncritically.
 * So `dir * (ref_price - close)/close` is the look-ahead term itself, not a proxy for it, on the 83
 * rows where a live ticker was actually read. Measured 2026-08-04 on the exact ENTRY_SQL population:
 *   all 94 rows:                mean = +0.07 bps   (v10, n=23: +0.06)
 *   83/94 ticker-sourced rows (THE CEILING published below): E|.| = 0.57 bps, p95 |.| = 2.45 bps
 * E|.| is the CEILING: E[dir*drift] <= E|drift| for ANY direction rule, clairvoyant included, with no
 * random-walk and no borrowed variance. The model can also read the book, so the same probe on the
 * payload's best bid/ask: median |mid - close| = 0.52 bps, p90 3.40 bps, median spread 0.82 bps (the
 * mean 5.08 / max 139 are two wide-or-stale-book rows, not 16s of price movement).
 *
 * NOT 9.1 bps, and NOT 3.4 bps. 9.1 (prereg:460) is `2 * 0.798 * sigma` — a DIFFERENCE OF TWO GROUP
 * MEANS on a median split, the microstructure study's statistic, not this one's. Re-deriving it for a
 * single mean as `0.798 * sqrt(16.2/900) * 32.2 = 3.4` still extrapolates a grid-wide 15-minute SD down
 * to 16 seconds under a random walk, and the direct measurement above refutes that extrapolation by ~6x
 * on this population. Publish the measured number; a ceiling nobody measured is not more careful, it is
 * just larger.
 *
 * DISCLOSURE, never a filter: nothing below suppresses a cell, an interval or a divergence flag because
 * a number falls near this term. A measurement that hid its own findings to look careful would be
 * failing CLOSED, which this instrument never does.
 */
export const ANCHOR_LOOKAHEAD_BPS = { mean: 0.07, meanAbsCeiling: 0.57, p95Abs: 2.45 };

/**
 * The replay figures WATCH-PLAYBOOK-V10-1 was opened against (research/loop/watches.md:226-228),
 * transcribed rather than parsed out of the prose — a regex over a markdown paragraph is a silent
 * failure waiting to happen, and these numbers are frozen by the WATCH.
 *
 * `predicted` is the arm's OWN replayed entry forward return in bps at h=1/4/8/24; `incumbent` is
 * champion_v8's, carried only so a report can show what the deployment was betting against.
 *
 * NOT AN EDGE CLAIM, and the WATCH is explicit about it: v10 is a RESEARCH-BAR FAIL deployed on
 * DEPLOYMENT-BAR grounds. +47.6 must never be quoted as an edge — the arm fails on interval width
 * (h=24 CI lo -12.2, h=8 +1.1, both under the +13.0 bar) and is in-sample on one 6.35-day regime.
 */
export const REPLAY_REFERENCE = {
  10: {
    arm: 'inverted',
    predicted: { 1: -0.8, 4: 0.8, 8: 19.3, 24: 47.6 },
    incumbent: { 1: -12.7, 4: -36.3, 8: -32.7, 24: -70.1 },
  },
};

/**
 * The payload marker that identifies an entry taken from FLAT. ONLY these are comparable to the
 * replay cell: the replay's corpus filter was FLAT-only, while a live `open_long` also fires as a
 * same-side SCALE-IN (anthropic-agent-client.ts:1801-1803). Scale-ins are counted and reported, never
 * silently dropped.
 */
export const FLAT_MARKER = '"position":{"side":"FLAT"';

export const POPULATIONS = ['all', 'flat_only'];

// ── ported statistics ────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic PRNG — ported verbatim from playbook-space-replay.ts:426. Math.random() would make a
 * run unreproducible and every statistic below is a resampling statistic whose value depends on the
 * stream.
 */
export function makeRand(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const mean = (a) => (a.length === 0 ? null : a.reduce((s, x) => s + x, 0) / a.length);

/**
 * CLUSTER bootstrap — ported from playbook-space-replay.ts:558. Resamples BASE ASSETS, not
 * observations and not symbol strings: several entries on one asset within hours are not independent,
 * and neither are a spot and a perp entry on the same coin (MIN_CLUSTERS above), so a row-level or
 * symbol-level bootstrap would both overstate confidence.
 *
 * One deliberate difference from the port: the cluster list is SORTED BY BASE ASSET before
 * resampling. The original walks Map insertion order, which is input order — here the input order is
 * a psql row order that could change under an index or plan change, and identical rows arriving in a
 * different order must not move the interval. Sorting is what makes BOOTSTRAP_SEED actually buy
 * determinism.
 */
export function clusterBootstrap(obs, rand) {
  const byAsset = new Map();
  for (const o of obs) {
    const key = baseAsset(o.symbol);
    const list = byAsset.get(key);
    if (list) list.push(o.bps);
    else byAsset.set(key, [o.bps]);
  }
  const clusters = [...byAsset.keys()].sort().map((k) => byAsset.get(k));
  const draws = [];
  for (let b = 0; b < N_BOOT; b += 1) {
    let sum = 0;
    let count = 0;
    for (let k = 0; k < clusters.length; k += 1) {
      const pick = clusters[(rand() * clusters.length) | 0];
      for (const v of pick) {
        sum += v;
        count += 1;
      }
    }
    if (count > 0) draws.push(sum / count);
  }
  draws.sort((a, b) => a - b);
  return draws;
}

/**
 * PAIRED cluster bootstrap for a delta between two arms scored on the SAME rows — first consumer is
 * the out-of-sample session arm (`scripts/loop-oos-arm-core.mjs`), comparing the session's entries
 * against the live lane's on identical base-asset clusters. Ported from clusterBootstrap's own
 * resampling convention (N_BOOT draws, `clusters.length` picks per draw, WITH replacement) so the two
 * bootstraps cannot silently drift apart — the difference is that the SAME resampled base-asset list
 * is applied to both `obsA` and `obsB` in each draw, which is what makes the result a paired delta
 * rather than two independent intervals subtracted (subtracting two independent CIs overstates the
 * variance of a delta computed on the same rows).
 *
 * A DEGENERATE draw is one where the same resample carries zero observations for one side — obsA and
 * obsB are not guaranteed to have an entry on every base asset (the session may enter where the live
 * lane held, or the reverse), so a resample can land entirely on assets absent from one side. Such a
 * draw is COUNTED, never silently dropped: dropping it would narrow the interval exactly as if every
 * draw had been well-behaved, which is the same "absence reads as a clean reading" defect class
 * MAX_GAP_SHARE above exists to name rather than hide.
 */
export function pairedClusterBootstrapDelta(obsA, obsB, rand) {
  const groupByAsset = (obs) => {
    const byAsset = new Map();
    for (const o of obs) {
      const key = baseAsset(o.symbol);
      const list = byAsset.get(key);
      if (list) list.push(o.bps);
      else byAsset.set(key, [o.bps]);
    }
    return byAsset;
  };
  const byAssetA = groupByAsset(obsA);
  const byAssetB = groupByAsset(obsB);
  const bases = [...new Set([...byAssetA.keys(), ...byAssetB.keys()])].sort();
  const draws = [];
  let degenerate = 0;
  for (let b = 0; b < N_BOOT; b += 1) {
    let sumA = 0;
    let countA = 0;
    let sumB = 0;
    let countB = 0;
    for (let k = 0; k < bases.length; k += 1) {
      const pick = bases[(rand() * bases.length) | 0];
      for (const v of byAssetA.get(pick) ?? []) {
        sumA += v;
        countA += 1;
      }
      for (const v of byAssetB.get(pick) ?? []) {
        sumB += v;
        countB += 1;
      }
    }
    if (countA === 0 || countB === 0) {
      degenerate += 1;
      continue;
    }
    draws.push(sumA / countA - sumB / countB);
  }
  draws.sort((a, b) => a - b);
  return { bases: bases.length, draws, degenerate };
}

/**
 * The powered/underpowered decision and, ONLY when powered, the interval.
 *
 * An underpowered cell returns ciLo/ciHi as null rather than as numbers nobody may act on. That is
 * not squeamishness: an interval printed beside an UNDERPOWERED label still gets copied into a
 * sentence without it. The point estimate IS returned — it is the honest summary of what happened —
 * but see `summarise` below for why it never leaves this module unattached to its label.
 */
export function computeCell(obs) {
  const sorted = [...obs].sort(
    (a, b) => a.symbol.localeCompare(b.symbol) || a.t0 - b.t0 || a.venue.localeCompare(b.venue),
  );
  const bps = sorted.map((o) => o.bps);
  const clusters = new Set(sorted.map((o) => baseAsset(o.symbol))).size;
  const n = bps.length;
  const powered = n >= MIN_ENTRIES && clusters >= MIN_CLUSTERS;
  if (!powered) {
    return { n, clusters, mean: mean(bps), ciLo: null, ciHi: null, powered: false };
  }
  const draws = clusterBootstrap(sorted, makeRand(BOOTSTRAP_SEED));
  return {
    n,
    clusters,
    mean: mean(bps),
    ciLo: draws.length === 0 ? null : (draws[Math.floor(0.025 * draws.length)] ?? null),
    ciHi: draws.length === 0 ? null : (draws[Math.floor(0.975 * draws.length)] ?? null),
    powered: true,
  };
}

// ── the price grid ───────────────────────────────────────────────────────────────────────────────

/** Exported so every module printing a bps figure — `scripts/loop-oos-arm-core.mjs` included —
 * formats it identically rather than growing a second, silently-divergent formatter. */
export const fmtBps = (v) =>
  v === null || !Number.isFinite(v) ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(1)} bps`;

/**
 * Key on (venue, symbol), NEVER on symbol alone.
 *
 * Defect #37 interleaved symbols in one series and scored BTC->LINK transitions as -99.99%. Keying on
 * the PAIR makes the cross-venue form of that defect structurally impossible rather than merely
 * unlikely: the same symbol string on `binance` and `binanceusdm` is two different books with two
 * different prints, and a forward return that crossed between them would be pure fiction.
 */
export function gridKey(venue, symbol) {
  return `${venue} ${symbol}`;
}

/** Builds the per-(venue,symbol) sorted price series. Rows that cannot be trusted are dropped and
 * counted, never coerced — a NaN close silently becoming 0 is how a -9999 bps observation is born. */
export function buildGrid(gridRows) {
  const series = new Map();
  let rejected = 0;
  if (!Array.isArray(gridRows)) return { series, rejected, offGrid: 0 };
  let offGrid = 0;
  for (const r of gridRows) {
    if (!r || typeof r.venue !== 'string' || typeof r.symbol !== 'string') {
      rejected += 1;
      continue;
    }
    const t = Number(r.eventTime);
    const c = Number(r.close);
    if (!Number.isFinite(t) || !Number.isFinite(c) || !(c > 0)) {
      rejected += 1;
      continue;
    }
    // A row off the 15m grid cannot be the bar the convention describes, whatever its trigger_kind
    // claims. Refusing it here means the measurement does not depend on the SQL filter being right.
    if (t % BAR_MS !== 0) {
      offGrid += 1;
      continue;
    }
    const k = gridKey(r.venue, r.symbol);
    let s = series.get(k);
    if (!s) {
      s = { ts: [], close: [] };
      series.set(k, s);
    }
    s.ts.push(t);
    s.close.push(c);
  }
  for (const s of series.values()) {
    const order = s.ts.map((t, i) => i).sort((a, b) => s.ts[a] - s.ts[b]);
    const ts = order.map((i) => s.ts[i]);
    const close = order.map((i) => s.close[i]);
    // De-duplicate: several symbols share a bar, and one (venue,symbol) can carry more than one row
    // at the same event_time (a decide plus a quiet row). Same bar, same close — keep the first.
    s.ts = [];
    s.close = [];
    for (let i = 0; i < ts.length; i += 1) {
      if (i > 0 && ts[i] === ts[i - 1]) continue;
      s.ts.push(ts[i]);
      s.close.push(close[i]);
    }
  }
  return { series, rejected, offGrid };
}

/** First index whose ts >= target, or series length when every bar precedes target. */
function lowerBound(ts, target) {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Forward return in bps, `h` bars ahead of `t0`, signed by `dir`. The metric is
 * playbook-space-replay.ts:516's `fwdBps`; the LOOKUP is deliberately not.
 *
 * The port indexes `i + h` — position in the array. That is only the same thing as "h bars later"
 * when the series has no holes, and the whole reason this measurement exists is that the live series
 * DOES have holes (the lane goes down). Indexing forward across a hole silently measures a longer
 * horizon than it reports. So the lookup is by TIME TARGET (`t0 + h * BAR_MS`), and a match more than
 * one bar past target is a GAP that yields no observation rather than a mislabelled one.
 *
 * The returned `status` distinguishes the two misses that must never be pooled:
 *   'pending' — the forward bar has not happened yet. Benign, expected, counted, and NOT evidence of
 *               anything; it excludes itself from the gap share.
 *   'gap'     — the forward bar should exist and does not. Non-random (see MAX_GAP_SHARE).
 */
export function forwardBps(series, venue, symbol, t0, h, dir) {
  const s = series.get(gridKey(venue, symbol));
  if (!s || s.ts.length === 0) return { status: 'no_series', bps: null };
  const i0 = lowerBound(s.ts, t0);
  // The entry's own bar must be present and EXACT. An entry scored off a neighbouring bar's close is
  // a different measurement wearing this one's name.
  if (i0 >= s.ts.length || s.ts[i0] !== t0) return { status: 'no_entry_bar', bps: null };
  const target = t0 + h * BAR_MS;
  const i1 = lowerBound(s.ts, target);
  if (i1 >= s.ts.length) {
    // Nothing at or after target. If the series simply has not reached that far, the future has not
    // happened yet; if it runs past target but skipped it, that is a hole.
    return { status: s.ts[s.ts.length - 1] < target ? 'pending' : 'gap', bps: null };
  }
  if (s.ts[i1] - target > BAR_MS) return { status: 'gap', bps: null };
  const c0 = s.close[i0];
  const c1 = s.close[i1];
  if (!(c0 > 0) || !(c1 > 0)) return { status: 'bad_price', bps: null };
  return { status: 'ok', bps: dir * ((c1 - c0) / c0) * 10_000, matchedTs: s.ts[i1] };
}

// ── the measurement ──────────────────────────────────────────────────────────────────────────────

function annotation(kind, detail) {
  return { kind, detail };
}

/**
 * Every number this module lets out is bound to its power label IN THE SAME STRING.
 *
 * An UNDERPOWERED point estimate is not wrong, it is unattributable — and the way it does damage is
 * by being lifted into a sentence away from its caveat. Emitting the label and the estimate as
 * separate fields invites exactly that, so the renderable form is minted here, together, and the
 * runner prints this rather than assembling its own.
 *
 * Exported so every caller — `scripts/loop-oos-arm-core.mjs` included — renders a cell through this
 * SAME chokepoint rather than growing a second copy of the never-detach-the-label rule.
 */
export function summarise(cell, label) {
  // Name the clause that ACTUALLY failed. "n<12 or clusters<5" printed against a cell with clusters=5
  // is a false statement about the data, and the two clauses are independent by design (20 entries on
  // 3 symbols fails only the cluster clause) — so a reader must be able to see which one bit.
  const failed = [];
  if (cell.n < MIN_ENTRIES) failed.push(`n=${cell.n}<${MIN_ENTRIES}`);
  if (cell.clusters < MIN_CLUSTERS) failed.push(`clusters=${cell.clusters}<${MIN_CLUSTERS}`);
  const power = label ?? (cell.powered ? 'POWERED' : `UNDERPOWERED (${failed.join(' and ')})`);
  if (cell.n === 0) return `${power} — no entries scored`;
  const ci =
    cell.ciLo === null || cell.ciHi === null
      ? 'no interval (a cluster bootstrap below the floor is a lattice artifact, not a CI)'
      : `95% CI [${fmtBps(cell.ciLo)}, ${fmtBps(cell.ciHi)}]`;
  return `${power} mean=${fmtBps(cell.mean)} n=${cell.n} clusters=${cell.clusters} ${ci}`;
}

/**
 * Divergence against the replay prediction — evaluated ONLY on a powered cell.
 *
 * "However far apart the point estimates are" is not evidence while the cell is underpowered, so the
 * flag is not merely suppressed in rendering: it is never computed. The test is whether the interval
 * EXCLUDES the predicted value, which is the only comparison the interval supports; a bare distance
 * between two point estimates would flag noise.
 */
function divergenceFor(cell, predicted) {
  if (predicted === null || predicted === undefined || !Number.isFinite(predicted)) return null;
  if (!cell.powered || cell.ciLo === null || cell.ciHi === null || cell.mean === null) {
    return { predicted, delta: null, flagged: false, reason: 'underpowered' };
  }
  const flagged = predicted < cell.ciLo || predicted > cell.ciHi;
  return { predicted, delta: cell.mean - predicted, flagged, reason: null };
}

/**
 * @param entryRows  [{ eventTime, venue, symbol, action, playbookVersion, isFlat }] or null when the
 *                   probe failed. `isFlat` is the FLAT_MARKER match the runner computed in SQL.
 * @param gridRows   [{ eventTime, venue, symbol, close }] or null when the probe failed.
 * @param reference  REPLAY_REFERENCE-shaped table, or null when it could not be read/validated.
 * @param eligibleHorizons  optional subset of HORIZONS to score. Omitted (the default) scores every
 *   HORIZONS member, unchanged from before this parameter existed. A caller that restricts this — the
 *   out-of-sample session arm passes `[24]`, since its pre-registration declares ONLY h=24 as its
 *   SECONDARY bound — MUST NOT have the other horizons vanish silently: every HORIZONS member outside
 *   the passed set gets its own `forward_return_horizon_not_blind` annotation, once per call, naming
 *   exactly which horizons were excluded and why a study would exclude them (a horizon outside a
 *   study's declared scope is not blind to that study's own design, not a data gap).
 * @param includeObservations  when true, each measured horizon carries its own raw `obs` array (the
 *   per-entry bps observations `computeCell` was built from) alongside `cell` — added for
 *   `scripts/loop-oos-arm-core.mjs`'s paired bootstrap, which needs the SAME per-entry observations
 *   this module already computes rather than re-deriving them from the grid a second time. Omitted
 *   (the default), no `obs` key is added anywhere — the output shape is byte-identical to before this
 *   parameter existed, which is what keeps every existing consumer's assertions valid unchanged.
 * Never throws. Returns { status, panels, annotations } and deliberately no `alarms` key.
 */
export function computeForwardReturn({
  entryRows,
  gridRows,
  reference,
  eligibleHorizons,
  includeObservations,
} = {}) {
  const annotations = [];

  // A caller with no replay comparand at all (loop-oos-arm-core.mjs's armFr/liveFr calls pass
  // `reference: {}` — there is no replay cell for either arm) gets a SCOPED disclosure below: the
  // full text quotes look-ahead figures measured on the live v10 ENTRY_SQL population, which is a
  // different row set than whatever this call is scoring, and the "replay side of every divergence
  // below" sentence is vacuous when no divergence is ever evaluated (2026-08-04 review finding).
  const hasReferenceTable =
    reference !== null &&
    reference !== undefined &&
    typeof reference === 'object' &&
    Object.keys(reference).length > 0;

  // Emitted UNCONDITIONALLY, before every early return: the disclosure must reach the reader on every
  // read, including a void one, so no pass can quote an effect from this instrument without it.
  annotations.push(
    annotation(
      'forward_return_anchor_lag',
      hasReferenceTable
        ? `ANCHOR DISCLOSURE — every mean below is anchored on the DECISION BAR'S CLOSE, ` +
            `${ANCHOR_LAG_SECONDS.p50}s (p50; min ${ANCHOR_LAG_SECONDS.min}s, max ` +
            `${ANCHOR_LAG_SECONDS.max}s) EARLIER than the instant the lane fixed its direction. The ` +
            'direction was therefore chosen on an information set that already contained post-close ' +
            'market state (94/94 entry payloads carry a live orderBook block, 83/94 a live ticker — ' +
            "the other 11 read deriveMarketBasis's fallback to the entry bar's own close, " +
            'agentic.strategy.ts:3004-3008, a structural zero rather than a reading), and no order ' +
            'could have been filled at this anchor. MEASURED, not recomputed per read, 2026-08-04 on ' +
            `the live v10 entry population (n=94; dir-aligned ref_price vs close): mean ` +
            `${ANCHOR_LOOKAHEAD_BPS.mean} bps across all 94 rows; the ceiling — ` +
            `${ANCHOR_LOOKAHEAD_BPS.meanAbsCeiling} bps (E|drift|, an upper bound for ANY direction ` +
            `rule) and p95 ${ANCHOR_LOOKAHEAD_BPS.p95Abs} bps — on the 83 rows that actually held a ` +
            'live ticker, since the 11 structural-zero rows would dilute it downward. It is a sub-bp ' +
            'effect on a mean, not a discount to apply to every number. The replay side of every ' +
            'divergence below re-decides on RECORDED payloads (a different row set, not these rows) ' +
            'at the SAME bar-close anchor convention (playbook-space-replay.ts:562-577, :499-513), ' +
            'so the term sits on both sides of the comparison rather than only on live. Disclosure ' +
            'only: nothing here suppresses a cell, an interval or a divergence flag'
        : `ANCHOR DISCLOSURE — every mean below is anchored on the DECISION BAR'S CLOSE, ` +
            `${ANCHOR_LAG_SECONDS.p50}s (p50; min ${ANCHOR_LAG_SECONDS.min}s, max ` +
            `${ANCHOR_LAG_SECONDS.max}s) EARLIER than the instant the lane fixed its direction — the ` +
            'same structural lag measured 2026-08-04 on the live v10 ENTRY_SQL population (n=94; not ' +
            "recomputed per read, and NOT a claim about THIS call's own row population). No replay " +
            'reference was supplied for this call (`reference` carries no predicted values), so no ' +
            'replay-vs-live divergence is ever evaluated below — the comparison this disclosure ' +
            'otherwise qualifies does not run here',
    ),
  );

  const scoredHorizons = Array.isArray(eligibleHorizons)
    ? HORIZONS.filter((h) => eligibleHorizons.includes(h))
    : HORIZONS;
  const excludedHorizons = HORIZONS.filter((h) => !scoredHorizons.includes(h));
  if (excludedHorizons.length > 0) {
    annotations.push(
      annotation(
        'forward_return_horizon_not_blind',
        `h=${excludedHorizons.join(',')} excluded by the caller's eligibleHorizons filter — not ` +
          'scored for this read. This is a declared scope limit, never a silent drop: the caller ' +
          `restricted scoring to h=${scoredHorizons.join(',')} only`,
      ),
    );
  }

  if (!Array.isArray(entryRows)) {
    annotations.push(
      annotation(
        'forward_return_entry_probe_failed',
        'the entry probe against agent_decisions returned no readable rows — this is NOT "no entries", ' +
          'it is no reading at all, and nothing below was measured',
      ),
    );
    return { status: 'undetermined', panels: [], annotations };
  }
  if (!Array.isArray(gridRows)) {
    annotations.push(
      annotation(
        'forward_return_grid_probe_failed',
        'the price-grid probe against agent_decisions returned no readable rows — forward prices are ' +
          'unavailable, so no horizon was scored (NOT a zero return)',
      ),
    );
    return { status: 'undetermined', panels: [], annotations };
  }

  let refTable = reference;
  if (refTable === null || refTable === undefined || typeof refTable !== 'object') {
    annotations.push(
      annotation(
        'forward_return_reference_unreadable',
        'the replay reference table could not be read or failed shape validation — live returns below ' +
          'are still measured, but NO replay-vs-live divergence was evaluated for any version; ' +
          'absence of a divergence flag here means the comparison did not run, not that it agreed',
      ),
    );
    refTable = {};
  }

  const { series, rejected, offGrid } = buildGrid(gridRows);
  if (rejected > 0) {
    annotations.push(
      annotation(
        'forward_return_grid_rows_rejected',
        `${rejected} price-grid row(s) carried an unusable venue/symbol/close and were dropped — the ` +
          'cells below cover the rest only',
      ),
    );
  }
  if (offGrid > 0) {
    annotations.push(
      annotation(
        'forward_return_grid_rows_off_bar',
        `${offGrid} price-grid row(s) had an event_time off the ${BAR_MS / 60000}m bar grid and were ` +
          'dropped — on a candle trigger event_time is the bar OPEN, so an off-grid row is not the ' +
          'bar the close convention describes',
      ),
    );
  }

  // Normalise entries, refusing anything whose timestamp cannot be the open of a bar.
  const entries = [];
  let entriesOffGrid = 0;
  let entriesUnusable = 0;
  for (const r of entryRows) {
    if (!r || typeof r.venue !== 'string' || typeof r.symbol !== 'string') {
      entriesUnusable += 1;
      continue;
    }
    const t0 = Number(r.eventTime);
    const dir = r.action === 'open_long' ? 1 : r.action === 'open_short' ? -1 : null;
    if (!Number.isFinite(t0) || dir === null) {
      entriesUnusable += 1;
      continue;
    }
    if (t0 % BAR_MS !== 0) {
      entriesOffGrid += 1;
      continue;
    }
    entries.push({
      t0,
      venue: r.venue,
      symbol: r.symbol,
      dir,
      playbookVersion:
        r.playbookVersion === null || r.playbookVersion === undefined
          ? null
          : Number(r.playbookVersion),
      isFlat: r.isFlat === true,
    });
  }
  if (entriesUnusable > 0) {
    annotations.push(
      annotation(
        'forward_return_entries_unreadable',
        `${entriesUnusable} entry row(s) carried an unusable venue/symbol/event_time/action and were ` +
          'not scored — the panels below cover the rest only',
      ),
    );
  }
  if (entriesOffGrid > 0) {
    annotations.push(
      annotation(
        'forward_return_entries_off_bar',
        `${entriesOffGrid} entry row(s) had an event_time off the ${BAR_MS / 60000}m grid and were not ` +
          'scored — an exec-triggered row stamps a FILL time, whose close belongs to an earlier bar ' +
          '(strategy-host.ts:458), so scoring it would silently mislabel the horizon',
      ),
    );
  }

  // The FLAT marker is a payload SHAPE assumption, so its total absence is a schema change, not a
  // finding. Distinguishing "no FLAT entries" from "the marker stopped matching" is the whole point.
  const flatCount = entries.filter((e) => e.isFlat).length;
  const flatMarkerVoid = entries.length > 0 && flatCount === 0;
  if (flatMarkerVoid) {
    annotations.push(
      annotation(
        'forward_return_flat_marker_absent',
        `${entries.length} entries exist but ZERO carry the FLAT payload marker (${FLAT_MARKER}) — ` +
          'the payload shape has almost certainly changed. flat_only reads UNDETERMINED, NOT n=0: ' +
          'the replay-comparable population could not be identified at all',
      ),
    );
  }

  const versions = [...new Set(entries.map((e) => e.playbookVersion))].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a - b;
  });

  const panels = [];
  for (const version of versions) {
    const ofVersion = entries.filter((e) => e.playbookVersion === version);
    const scaleIns = ofVersion.filter((e) => !e.isFlat).length;
    const ref = version === null ? undefined : refTable[version];
    if (scaleIns > 0) {
      annotations.push(
        annotation(
          'forward_return_scale_ins_present',
          `playbook_version=${version ?? '(none)'}: ${scaleIns} of ${ofVersion.length} entries were ` +
            'same-side SCALE-INS, not entries from FLAT (anthropic-agent-client.ts:1801-1803). They ' +
            'are counted in the `all` population and excluded from `flat_only`; only `flat_only` is ' +
            'comparable to the replay cell, whose corpus filter was FLAT-only',
        ),
      );
    }
    for (const population of POPULATIONS) {
      const pool = population === 'flat_only' ? ofVersion.filter((e) => e.isFlat) : ofVersion;
      const horizons = [];
      for (const h of scoredHorizons) {
        const counts = { ok: 0, gap: 0, pending: 0, noSeries: 0, badPrice: 0, noEntryBar: 0 };
        const obs = [];
        for (const e of pool) {
          const r = forwardBps(series, e.venue, e.symbol, e.t0, h, e.dir);
          if (r.status === 'ok') {
            counts.ok += 1;
            obs.push({ symbol: e.symbol, venue: e.venue, t0: e.t0, bps: r.bps });
          } else if (r.status === 'gap') counts.gap += 1;
          else if (r.status === 'pending') counts.pending += 1;
          else if (r.status === 'no_series') counts.noSeries += 1;
          else if (r.status === 'no_entry_bar') counts.noEntryBar += 1;
          else if (r.status === 'bad_price') counts.badPrice += 1;
        }
        // `pending` is excluded from the denominator on purpose: a horizon that has not elapsed yet is
        // not a hole, and counting it as one would make every fresh deployment read UNDETERMINED.
        const nonBenignMiss = counts.gap + counts.noSeries + counts.badPrice + counts.noEntryBar;
        const attempted = counts.ok + nonBenignMiss;
        const gapShare = attempted === 0 ? 0 : nonBenignMiss / attempted;

        // flat_only is undetermined WHOLESALE when the marker vanished — the pool would read n=0 and
        // an n=0 cell is indistinguishable from "the strategy took no FLAT entries", which is exactly
        // the wrong conclusion.
        if (population === 'flat_only' && flatMarkerVoid) {
          horizons.push({
            h,
            status: 'undetermined',
            reason: 'flat_marker_absent',
            counts,
            gapShare: null,
            cell: null,
            divergence: null,
            summary:
              'UNDETERMINED — the FLAT payload marker matched zero rows, so the replay-comparable ' +
              'population could not be identified (this is not n=0)',
          });
          continue;
        }
        if (attempted > 0 && gapShare > MAX_GAP_SHARE) {
          annotations.push(
            annotation(
              'forward_return_horizon_gap_undetermined',
              `playbook_version=${version ?? '(none)'} population=${population} h=${h}: ` +
                `${nonBenignMiss} of ${attempted} elapsed entries had no usable forward bar ` +
                `(${(gapShare * 100).toFixed(0)}% > ${(MAX_GAP_SHARE * 100).toFixed(0)}%). Gaps are ` +
                'NOT missing-at-random — the lane goes down during incidents, which correlate with ' +
                'market events — so the surviving subsample is biased toward calm bars and this ' +
                'horizon reads UNDETERMINED rather than reporting it',
            ),
          );
          horizons.push({
            h,
            status: 'undetermined',
            reason: 'gap_share_exceeded',
            counts,
            gapShare,
            cell: null,
            divergence: null,
            summary:
              `UNDETERMINED — ${(gapShare * 100).toFixed(0)}% of elapsed entries had no usable ` +
              'forward bar; a mean over what survived would measure a different population',
          });
          continue;
        }

        const cell = computeCell(obs);
        const predicted = ref && ref.predicted ? ref.predicted[h] : null;
        const divergence = divergenceFor(cell, predicted);
        if (!cell.powered) {
          annotations.push(
            annotation(
              'forward_return_underpowered',
              `playbook_version=${version ?? '(none)'} population=${population} h=${h}: ` +
                `${summarise(cell)} — reported for completeness, NOT actionable, and no ` +
                'replay-vs-live divergence was evaluated',
            ),
          );
        } else if (divergence && divergence.flagged) {
          annotations.push(
            annotation(
              'forward_return_replay_divergence',
              `playbook_version=${version ?? '(none)'} (${ref?.arm ?? 'unknown arm'}) ` +
                `population=${population} h=${h}: live-realised ${summarise(cell)} vs ` +
                `replay-predicted ${fmtBps(predicted)} — the interval EXCLUDES the prediction ` +
                `(delta ${fmtBps(divergence.delta)}). WATCH-PLAYBOOK-V10-1 is symmetric: this is a ` +
                'FINDING to report in whichever direction it points, not a fault and not noise. ' +
                'This statistic scores agent_decisions rows (decisions, filled or not) on the SAME ' +
                'close-convention grid at both ends — no fill price, no fee, no fill/no-fill filter, ' +
                'matching how replay computes fwdBps — so it CANNOT show adverse selection: fills are ' +
                'invisible to it on both sides of the comparison, live and replay alike. The ' +
                'instrument that can is the filled-vs-unfilled split on these same rows (see ' +
                'watches.md WATCH-PLAYBOOK-V10-1, 2026-08-04 amendment)',
            ),
          );
        }
        const horizonEntry = {
          h,
          status: 'measured',
          reason: null,
          counts,
          gapShare,
          cell,
          divergence,
          summary: summarise(cell),
        };
        if (includeObservations === true) horizonEntry.obs = obs.slice();
        horizons.push(horizonEntry);
      }
      panels.push({
        playbookVersion: version,
        arm: ref?.arm ?? null,
        population,
        entries: pool.length,
        scaleIns: population === 'all' ? scaleIns : 0,
        hasReference: Boolean(ref),
        horizons,
      });
    }
  }

  if (entries.length === 0) {
    annotations.push(
      annotation(
        'forward_return_no_entries',
        'the probe succeeded and returned zero scoreable entries — this IS a determinate reading ' +
          '(the lane took no bar-aligned entries in the window), distinct from a failed probe above',
      ),
    );
  }

  return { status: panels.length > 0 ? 'measured' : 'undetermined', panels, annotations };
}

/**
 * The SWEEP view of the same result — what loop-sweep.mjs merges into `result.annotations`.
 *
 * Every void read, every scale-in disclosure and every divergence finding is carried through
 * VERBATIM: those are the facts a pass must not miss, and suppressing one to save space would be the
 * same "absence reads as a reading" defect this module exists to prevent. Only the per-cell
 * UNDERPOWERED annotations are rolled up — at four horizons x two populations x every version ever
 * routed they run to dozens of lines, and a sweep drowned in them is a sweep nobody reads.
 *
 * The roll-up deliberately carries NO point estimates. The rule is that an estimate never appears in
 * a string separated from its UNDERPOWERED label, and the safest way to honour that in a compacted
 * line is to not carry estimates at all — they are one command away in `pnpm loop:forward-return`,
 * where every one of them is printed welded to its label.
 */
export function sweepAnnotations(result) {
  if (!result || !Array.isArray(result.annotations)) {
    return [
      annotation(
        'forward_return_tool_failed',
        'the realised-entry-forward-return measurement returned no result object — void read, not a ' +
          'clean one',
      ),
    ];
  }
  const kept = result.annotations.filter((a) => a.kind !== 'forward_return_underpowered');
  const under = [];
  for (const p of result.panels ?? []) {
    const cells = (p.horizons ?? []).filter((h) => h.cell && !h.cell.powered);
    if (cells.length === 0) continue;
    const c = cells[0].cell;
    under.push(
      `v${p.playbookVersion ?? '(none)'}/${p.population} (n=${c.n}, clusters=${c.clusters})`,
    );
  }
  if (under.length > 0) {
    kept.push(
      annotation(
        'forward_return_underpowered_rollup',
        `${under.length} realised-entry-forward-return cell group(s) are UNDERPOWERED at every ` +
          `horizon and NONE of them is actionable: ${under.join(', ')} — the bar is n>=${MIN_ENTRIES} ` +
          `AND clusters>=${MIN_CLUSTERS} (the cluster bootstrap resamples base assets, so a few ` +
          'assets means a few effective observations however many rows there are — a spot and perp ' +
          'symbol on the same coin count once). No replay-vs-live ' +
          'divergence was evaluated for any of them. Point estimates are deliberately NOT quoted ' +
          'here; run `pnpm loop:forward-return` to see each one printed with its power label',
      ),
    );
  }
  return kept;
}

/** Renderable report. Kept here (pure) so the runner cannot assemble a number without its label. */
export function renderForwardReturn(result) {
  const lines = ['## Realised entry forward return (WATCH-PLAYBOOK-V10-1)', ''];
  lines.push(
    '_Measurement only — annotations, never alarms. A divergence is a FINDING in either direction._',
    '',
    `_Anchored on the decision bar's CLOSE, ${ANCHOR_LAG_SECONDS.p50}s (p50) before the lane fixed ` +
      `its direction on an information set already containing post-close state. Measured look-ahead ` +
      `term: mean ${ANCHOR_LOOKAHEAD_BPS.mean} bps, ceiling ${ANCHOR_LOOKAHEAD_BPS.meanAbsCeiling} ` +
      'bps — sub-bp on any mean below, and present on the replay side of every comparison too._',
    '',
  );
  if (!result || !Array.isArray(result.panels)) return lines.join('\n');
  for (const p of result.panels) {
    const arm = p.arm ? ` (${p.arm})` : '';
    lines.push(
      `### playbook_version=${p.playbookVersion ?? '(none)'}${arm} — population \`${p.population}\` ` +
        `(${p.entries} entr${p.entries === 1 ? 'y' : 'ies'}` +
        `${p.scaleIns > 0 ? `, incl. ${p.scaleIns} scale-in${p.scaleIns === 1 ? '' : 's'}` : ''})`,
    );
    for (const h of p.horizons) {
      const c = h.counts;
      lines.push(
        `- h=${h.h}: ${h.summary}` +
          ` [ok=${c.ok} gap=${c.gap} pending=${c.pending} no-series=${c.noSeries} ` +
          `no-entry-bar=${c.noEntryBar} bad-price=${c.badPrice}]` +
          (h.divergence && Number.isFinite(h.divergence.predicted)
            ? ` vs replay ${fmtBps(h.divergence.predicted)}` +
              (h.divergence.flagged ? ' — DIVERGENCE' : h.divergence.reason ? '' : ' — consistent')
            : ''),
      );
    }
    lines.push('');
  }
  if (result.annotations.length > 0) {
    lines.push('### Annotations', '');
    for (const a of result.annotations) lines.push(`- **${a.kind}** — ${a.detail}`);
    lines.push('');
  }
  return lines.join('\n');
}
