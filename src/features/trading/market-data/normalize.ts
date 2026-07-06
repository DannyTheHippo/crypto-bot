import Decimal from 'decimal.js';
import { price, qty } from '../../../domain/types/money';
import { epochMs } from '../../../domain/types/ids';
import type {
  MarketEvent,
  TickerEvent,
  TradeEvent,
  CandleEvent,
  OrderBookSnapshotEvent,
  OrderLevel,
  CandleInterval,
} from '../../../domain/types/market-events';
import type { RawVenueEvent } from '../../../ports/exchange-stream';
import type { EpochMs, VenueId, SymbolId } from '../../../domain/types/ids';

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

function normalizeTicker(raw: RawVenueEvent, ingestTime: EpochMs): TickerEvent {
  const r = fields(raw.raw);
  const channel = 'ticker';
  const { eventTime, synthetic } = eventTimeOf(r['timestamp'], ingestTime);
  return {
    kind: 'TICKER',
    venue: raw.venue,
    symbol: raw.symbol,
    channel,
    seq: nextSeq(raw.venue, raw.symbol, channel),
    eventTime,
    ingestTime,
    eventTimeSynthetic: synthetic || undefined,
    bid: price(numStr(r['bid'] ?? r['bestBid'])),
    ask: price(numStr(r['ask'] ?? r['bestAsk'])),
    last: price(numStr(r['last'] ?? r['close'])),
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

function normalizeBook(raw: RawVenueEvent, ingestTime: EpochMs): OrderBookSnapshotEvent {
  const r = fields(raw.raw);
  const channel = 'book';
  const { eventTime, synthetic } = eventTimeOf(r['timestamp'], ingestTime);
  return {
    kind: 'ORDER_BOOK_SNAPSHOT',
    venue: raw.venue,
    symbol: raw.symbol,
    channel,
    seq: nextSeq(raw.venue, raw.symbol, channel),
    eventTime,
    ingestTime,
    eventTimeSynthetic: synthetic || undefined,
    bids: toLevels(r['bids']),
    asks: toLevels(r['asks']),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export { TIMEFRAME_MAP, nextSeq };

export function normalizeRawEvent(
  raw: RawVenueEvent,
  ingestTime: EpochMs,
  interval?: CandleInterval,
): MarketEvent {
  switch (raw.type) {
    case 'ticker':
      return normalizeTicker(raw, ingestTime);
    case 'trade':
      return normalizeTrade(raw, ingestTime);
    case 'candle':
      return normalizeCandle(raw, ingestTime, interval ?? '1m');
    case 'book':
      return normalizeBook(raw, ingestTime);
  }
}
