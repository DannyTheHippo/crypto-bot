import Decimal from 'decimal.js';
import { price, qty, type Price } from '../../../domain/common/types/money';
import { epochMs } from '../../../domain/common/types/ids';
import type {
  MarketEvent,
  TickerEvent,
  TradeEvent,
  CandleEvent,
  OrderBookSnapshotEvent,
  OrderLevel,
  CandleInterval,
} from '../../../domain/venue/types/market-events';
import type { RawVenueEvent } from '../../../ports/venue/exchange-stream';
import type { EpochMs, VenueId, SymbolId } from '../../../domain/common/types/ids';

// Per-(venue, symbol, channel) monotonic sequence counter.
// Bigint to avoid integer overflow over long-running processes.
const seqCounters = new Map<string, bigint>();

function nextSeq(venue: VenueId, symbol: SymbolId, channel: string): bigint {
  const key = `${venue}:${symbol}:${channel}`;
  const next = (seqCounters.get(key) ?? 0n) + 1n;
  seqCounters.set(key, next);
  return next;
}

// ── unknown → primitive coercion (ccxt number:String yields strings) ──────────
// Reads venue fields without `any`: money values arrive as strings; we accept a
// numeric fallback defensively, and anything else collapses to the default.

function fields(raw: unknown): Record<string, unknown> {
  return (raw ?? {}) as Record<string, unknown>;
}

function numStr(v: unknown, fallback = '0'): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return fallback;
}

// A raw quote field parsed to a POSITIVE Price, or `fallback` when it is absent, zero, or otherwise
// invalid. Lets a ticker that omits top-of-book still yield a usable bid/ask (= last) instead of
// throwing on price('0') and dropping the whole event — see normalizeTicker's own comment for why
// that drop silently blocked trading on every such symbol.
function positivePriceOr(rawVal: unknown, fallback: Price): Price {
  const s = numStr(rawVal, '');
  if (s === '') return fallback;
  try {
    return price(s);
  } catch {
    return fallback;
  }
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function eventTimeOf(ts: unknown, ingestTime: EpochMs): { eventTime: EpochMs; synthetic: boolean } {
  const t = numOrUndef(ts);
  return t === undefined
    ? { eventTime: ingestTime, synthetic: true }
    : { eventTime: epochMs(t), synthetic: false };
}

/**
 * Builds a Decimal for a price/qty level from a ccxt order book entry.
 * ccxt pro book caches store floats unconditionally; prefer the .info string
 * (exact venue value) when present. Books are reference-grade data, not exact
 * fills, so constructing a Decimal from the float fallback is acceptable.
 *
 * decimal.js accepts exponent notation natively (e.g. "1e-7"), so no parseFloat
 * is needed — and `Number()`/`parseFloat` on money paths is lint-banned anyway.
 * The branded value is still minted by money.ts's `price`/`qty`.
 */
function levelDecimal(value: unknown, infoStr?: unknown): Decimal {
  if (typeof infoStr === 'string' && infoStr !== '') return new Decimal(infoStr);
  return new Decimal(value as Decimal.Value);
}

// ── Ticker normalization ─────────────────────────────────────────────────────

// A venue ticker may carry NO top-of-book: Binance USD-M's @ticker 24h stream has last/close but no
// best bid/ask (only @bookTicker does). Before bid/ask fell back to `last`, price(numStr(undefined))
// => price('0') THREW, dropping the whole event, so such a symbol got no ref price at all and
// RiskEngine vetoed every intent on it STALE_DATA (mark === undefined). Confirmed root cause of the
// 2026-07-23 zero-trades finding: off-menu perps have no book channel either, so the ticker's `last`
// is their only ref-price source. bid/ask therefore fall back to `last`, yielding a usable mid
// (= last trade price) for the risk mark — the sole consumer of ticker bid/ask is
// teeing-market-stream's setRef, which wants exactly that mid. `last` itself has no fallback: a ticker
// with no last/close at all is genuinely priceless and still (correctly) throws + drops.
function normalizeTicker(raw: RawVenueEvent, ingestTime: EpochMs): TickerEvent {
  const r = fields(raw.raw);
  const channel = 'ticker';
  const { eventTime, synthetic } = eventTimeOf(r['timestamp'], ingestTime);
  const last = price(numStr(r['last'] ?? r['close']));
  return {
    kind: 'TICKER',
    venue: raw.venue,
    symbol: raw.symbol,
    channel,
    seq: nextSeq(raw.venue, raw.symbol, channel),
    eventTime,
    ingestTime,
    eventTimeSynthetic: synthetic || undefined,
    bid: positivePriceOr(r['bid'] ?? r['bestBid'], last),
    ask: positivePriceOr(r['ask'] ?? r['bestAsk'], last),
    last,
  };
}

// ── Trade normalization ──────────────────────────────────────────────────────

function normalizeTrade(raw: RawVenueEvent, ingestTime: EpochMs): TradeEvent {
  const r = fields(raw.raw);
  const channel = 'trade';
  const { eventTime, synthetic } = eventTimeOf(r['timestamp'], ingestTime);

  const sideRaw = r['side'];
  const side: 'BUY' | 'SELL' =
    (typeof sideRaw === 'string' && sideRaw.toUpperCase() === 'BUY') || r['takerSide'] === 'buy'
      ? 'BUY'
      : 'SELL';

  return {
    kind: 'TRADE',
    venue: raw.venue,
    symbol: raw.symbol,
    channel,
    seq: nextSeq(raw.venue, raw.symbol, channel),
    eventTime,
    ingestTime,
    eventTimeSynthetic: synthetic || undefined,
    price: price(numStr(r['price'])),
    qty: qty(numStr(r['amount'] ?? r['qty'] ?? r['size'])),
    side,
    tradeId: numStr(r['id'] ?? r['tradeId'], ''),
  };
}

// ── Candle normalization ─────────────────────────────────────────────────────

const TIMEFRAME_MAP: Record<string, CandleInterval> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

function normalizeCandle(
  raw: RawVenueEvent,
  ingestTime: EpochMs,
  interval: CandleInterval,
): CandleEvent {
  const channel = `candle:${interval}`;

  // ccxt OHLCV array: [timestamp, open, high, low, close, volume, (closed?)].
  // watchOHLCV may also deliver a parsed object.
  let openTimeMs: number;
  let openStr: string;
  let highStr: string;
  let lowStr: string;
  let closeStr: string;
  let volStr: string;
  let closed: boolean;

  if (Array.isArray(raw.raw)) {
    const a = raw.raw as unknown[];
    openTimeMs = numOrUndef(a[0]) ?? 0;
    openStr = numStr(a[1]);
    highStr = numStr(a[2]);
    lowStr = numStr(a[3]);
    closeStr = numStr(a[4]);
    volStr = numStr(a[5]);
    closed = a[6] === true;
  } else {
    const r = fields(raw.raw);
    openTimeMs = numOrUndef(r['openTime']) ?? numOrUndef(r['timestamp']) ?? 0;
    openStr = numStr(r['open']);
    highStr = numStr(r['high']);
    lowStr = numStr(r['low']);
    closeStr = numStr(r['close']);
    volStr = numStr(r['volume'] ?? r['baseVolume']);
    closed = r['closed'] === true;
  }

  const closeTimeMs = openTimeMs + INTERVAL_MS[interval] - 1;

  return {
    kind: 'CANDLE',
    venue: raw.venue,
    symbol: raw.symbol,
    channel,
    seq: nextSeq(raw.venue, raw.symbol, channel),
    eventTime: epochMs(openTimeMs),
    ingestTime,
    interval,
    openTime: epochMs(openTimeMs),
    closeTime: epochMs(closeTimeMs),
    open: price(openStr),
    high: price(highStr),
    low: price(lowStr),
    close: price(closeStr),
    volume: qty(volStr),
    closed,
  };
}

// ── Order book normalization ─────────────────────────────────────────────────

function normalizeLevel(entry: unknown[]): OrderLevel {
  // ccxt order book entries: [price, qty] stored as floats; entry[2] may carry
  // an info object with the exact venue strings.
  const info = entry[2] as Record<string, unknown> | undefined;
  return {
    price: price(levelDecimal(entry[0], info?.['price'] ?? info?.['p'])),
    qty: qty(levelDecimal(entry[1], info?.['size'] ?? info?.['q'])),
  };
}

function toLevels(raw: unknown): OrderLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: OrderLevel[] = [];
  for (const entry of raw as unknown[]) {
    if (!Array.isArray(entry)) continue;
    try {
      out.push(normalizeLevel(entry as unknown[]));
    } catch {
      // Book is reference-grade — one malformed level is tolerable, never fatal.
    }
  }
  return out;
}

// ── Book memory bound (band filter + hard cap) ──────────────────────────────
// ccxt pro book caches accumulate every level the venue streams (diff-depth updates), unbounded by
// this codebase — a deep/illiquid book or a long-running process can carry thousands of levels per
// side through normalizeBook on every snapshot. Two independent bounds, applied to the RAW float
// arrays BEFORE any Decimal is constructed (Decimal construction + GC churn is the dominant cost, not
// the array walk): a percent-of-mid band filter (irrelevant far-touch levels never even reach
// toLevels) and a hard per-side cap (belt-and-suspenders against a band-filter miss or a disabled
// band). This is a MEASUREMENT-PATH filter, never a money-path one — the surviving levels still go
// through the exact levelDecimal/.info-string path unchanged.

// Reads a raw ccxt level's price as a Decimal without ever calling parseFloat/Number() (project-wide
// money-path ban, eslint.config.mjs) — ccxt pro book caches store this as a native float already, but
// Decimal accepts both number and string natively. Returns undefined for anything unparseable
// (malformed entry, non-finite price) — the caller treats that as "mid unavailable", never a throw.
function rawLevelPrice(entry: unknown): Decimal | undefined {
  if (!Array.isArray(entry)) return undefined;
  // Array.isArray narrows unknown to any[]; re-widen so the element read stays type-checked.
  const p: unknown = (entry as unknown[])[0];
  if (typeof p !== 'number' && typeof p !== 'string') return undefined;
  try {
    const d = new Decimal(p);
    return d.isFinite() ? d : undefined;
  } catch {
    return undefined;
  }
}

// Mid from the best RAW (unfiltered) bid/ask — computed once per book, before either side is
// filtered, so bandFilterLevels below judges every level against the SAME reference point. Returns
// undefined (mid unavailable) whenever either side is empty or its best level is unparseable — the
// caller's fail-open contract (see filterAndCapLevels) then skips the band filter entirely.
function rawBookMid(rawBids: unknown, rawAsks: unknown): Decimal | undefined {
  if (!Array.isArray(rawBids) || !Array.isArray(rawAsks)) return undefined;
  const bestBid = rawLevelPrice(rawBids[0]);
  const bestAsk = rawLevelPrice(rawAsks[0]);
  if (bestBid === undefined || bestAsk === undefined) return undefined;
  return bestBid.plus(bestAsk).dividedBy(2);
}

// Keeps only raw levels within bandBps of mid, then hard-caps at maxLevels. ccxt book arrays are
// best-first on both sides (bids sorted highest-price-first — nearest mid from below; asks sorted
// lowest-price-first — nearest mid from above; this codebase already relies on that convention
// elsewhere, e.g. ccxt-stream.adapter.ts's risk-mark comment reading bids[0]/asks[0] as the touch), so
// a plain slice(0, maxLevels) after the band filter keeps the nearest-mid survivors on both sides —
// no re-sort needed.
//
// Failure direction: this is a measurement-path filter, not a validity gate — it fails OPEN. Any of
// {bandBps <= 0 (config disables it), mid undefined (either side empty or its best level unparseable)}
// skips the band filter and falls through to the cap-only path; maxLevels <= 0 (config disables the
// cap) likewise leaves the array untouched. The event (and every level toLevels can still parse) is
// NEVER dropped by this function — at worst it does no filtering at all.
function filterAndCapLevels(
  rawLevels: unknown,
  mid: Decimal | undefined,
  bandBps: number,
  maxLevels: number,
): unknown {
  if (!Array.isArray(rawLevels)) return rawLevels; // let toLevels' own non-array guard handle it
  let entries: unknown[] = rawLevels;
  if (bandBps > 0 && mid !== undefined) {
    const bandFraction = new Decimal(bandBps).dividedBy(10_000);
    const lo = mid.times(new Decimal(1).minus(bandFraction));
    const hi = mid.times(new Decimal(1).plus(bandFraction));
    entries = entries.filter((entry) => {
      const p = rawLevelPrice(entry);
      // Fail open per-entry too: an unparseable level is left IN (toLevels' own try/catch drops it
      // later if it truly cannot become a Decimal) rather than silently excluded by the band filter.
      return p === undefined || (p.gte(lo) && p.lte(hi));
    });
  }
  if (maxLevels > 0) entries = entries.slice(0, maxLevels);
  return entries;
}

function normalizeBook(
  raw: RawVenueEvent,
  ingestTime: EpochMs,
  bandBps = 0,
  maxLevels = 0,
): OrderBookSnapshotEvent {
  const r = fields(raw.raw);
  const channel = 'book';
  const { eventTime, synthetic } = eventTimeOf(r['timestamp'], ingestTime);
  const rawBids = r['bids'];
  const rawAsks = r['asks'];
  const mid = rawBookMid(rawBids, rawAsks);
  return {
    kind: 'ORDER_BOOK_SNAPSHOT',
    venue: raw.venue,
    symbol: raw.symbol,
    channel,
    seq: nextSeq(raw.venue, raw.symbol, channel),
    eventTime,
    ingestTime,
    eventTimeSynthetic: synthetic || undefined,
    bids: toLevels(filterAndCapLevels(rawBids, mid, bandBps, maxLevels)),
    asks: toLevels(filterAndCapLevels(rawAsks, mid, bandBps, maxLevels)),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export { TIMEFRAME_MAP, nextSeq };

/** Book memory bound, threaded from AppConfig.marketData (see environment.config.ts's
 *  MARKET_BOOK_BAND_BPS/MARKET_BOOK_MAX_LEVELS) down to normalizeBook. Absent ⇒ both bounds disabled
 *  (0), matching normalizeBook's own defaults — a caller that omits this stays byte-identical to
 *  pre-feature behavior (every existing call site that does not thread it, e.g. warmup backfill's
 *  candle-only normalizeRawEvent calls, is unaffected: this option is a no-op for every event kind but
 *  'book'). */
export interface BookLimits {
  readonly bandBps: number;
  readonly maxLevels: number;
}

export function normalizeRawEvent(
  raw: RawVenueEvent,
  ingestTime: EpochMs,
  interval?: CandleInterval,
  bookLimits?: BookLimits,
): MarketEvent {
  switch (raw.type) {
    case 'ticker':
      return normalizeTicker(raw, ingestTime);
    case 'trade':
      return normalizeTrade(raw, ingestTime);
    case 'candle':
      return normalizeCandle(raw, ingestTime, interval ?? '1m');
    case 'book':
      return normalizeBook(raw, ingestTime, bookLimits?.bandBps, bookLimits?.maxLevels);
  }
}
