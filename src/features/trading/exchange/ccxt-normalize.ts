import {
  clientOrderId,
  epochMs,
  type ClientOrderId,
  type EpochMs,
  type SymbolId,
  type VenueId,
} from '../../../domain/types/ids';
import type {
  AlgoOrderHistoryView,
  AlgoOrderState,
  ExchangeOrderState,
  VenueFill,
} from '../../../ports/exchange';
import type { CcxtBalances, CcxtOrder, CcxtTrade, RawAlgoOrder } from './ccxt-order-client';

// ── String discipline ─────────────────────────────────────────────────────────
// Money values in ccxt with number:String arrive as strings; we accept a number
// fallback defensively. NEVER parseFloat/Number on money paths — String() only.

function toStr(v: string | number | undefined, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return fallback;
}

// ── Order state normalization ─────────────────────────────────────────────────

const VALID_STATUSES = new Set<ExchangeOrderState['status']>([
  'open',
  'closed',
  'canceled',
  'rejected',
  'expired',
]);

export function normalizeOrderState(
  o: CcxtOrder,
  coid: ClientOrderId,
  symbol: SymbolId,
): ExchangeOrderState {
  const rawStatus = o.status;
  if (!VALID_STATUSES.has(rawStatus as ExchangeOrderState['status'])) {
    throw new Error(`normalizeOrderState: unknown ccxt order status "${rawStatus ?? 'undefined'}"`);
  }

  return {
    clientOrderId: coid,
    venueOrderId: String(o.id),
    symbol,
    status: rawStatus as ExchangeOrderState['status'],
    cumQty: toStr(o.filled, '0'),
    qty: toStr(o.amount, '0'),
  };
}

// ── Trade normalization ───────────────────────────────────────────────────────

export function normalizeTrade(
  t: CcxtTrade,
  venue: VenueId,
  symbol: SymbolId,
  fallbackCoid?: ClientOrderId,
): VenueFill {
  // Fills are audit-grade; a missing timestamp is a data integrity problem, not a soft default.
  if (
    t.timestamp === undefined ||
    !Number.isFinite(t.timestamp) ||
    !Number.isInteger(t.timestamp)
  ) {
    throw new Error(
      `normalizeTrade: trade is missing a valid integer timestamp (got ${t.timestamp})`,
    );
  }
  const venueTimestamp: EpochMs = epochMs(t.timestamp);

  // t.order carries the venue's own order id but VenueFill requires the client order id.
  // The caller passes fallbackCoid (the coid we queried with) when t.order is absent.
  const coid: ClientOrderId =
    t.order !== undefined ? clientOrderId(t.order) : (fallbackCoid ?? clientOrderId(''));

  // takerOrMaker can be absent; default to 'taker' as the conservative assumption for fees.
  const liquidity: 'maker' | 'taker' = t.takerOrMaker === 'maker' ? 'maker' : 'taker';

  const fee: VenueFill['fee'] =
    t.fee != null ? { ccy: t.fee.currency ?? '', amount: toStr(t.fee.cost, '0') } : null;

  return {
    venue,
    symbol,
    venueTradeId: String(t.id),
    clientOrderId: coid,
    price: toStr(t.price, '0'),
    qty: toStr(t.amount, '0'),
    fee,
    liquidity,
    venueTimestamp,
  };
}

// ── Balance normalization ─────────────────────────────────────────────────────

// ccxt top-level keys that are not asset entries.
const CCXT_BALANCE_META_KEYS = new Set(['info', 'free', 'used', 'total', 'timestamp', 'datetime']);

export function normalizeBalances(b: CcxtBalances): Map<string, { free: string; locked: string }> {
  const out = new Map<string, { free: string; locked: string }>();
  for (const [asset, value] of Object.entries(b)) {
    if (CCXT_BALANCE_META_KEYS.has(asset)) continue;
    if (value == null || typeof value !== 'object') continue;
    const entry = value as { free?: string | number; used?: string | number };
    out.set(asset, {
      free: toStr(entry.free, '0'),
      locked: toStr(entry.used, '0'),
    });
  }
  return out;
}

// ── Algo-order normalization (Push 3 P7a) ──────────────────────────────────────

export function normalizeAlgoOrder(o: RawAlgoOrder, fallbackSymbol: SymbolId): AlgoOrderState {
  if (o.algoId === undefined) {
    throw new Error('normalizeAlgoOrder: raw algo order is missing algoId');
  }
  const symbol = (o.symbol as SymbolId | undefined) ?? fallbackSymbol;
  const side: 'BUY' | 'SELL' = o.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  return {
    algoId: String(o.algoId),
    clientAlgoId: o.clientAlgoId,
    symbol,
    side,
    type: o.orderType ?? 'STOP_MARKET',
    qty: toStr(o.quantity, '0'),
    triggerPrice: toStr(o.triggerPrice, '0'),
    status: o.algoStatus ?? 'UNKNOWN',
    reduceOnly: o.reduceOnly === true,
  };
}

// ── Algo-history normalization (Defect A) ──────────────────────────────────────

// NEW collapses to RESTING, TRIGGERED/FINISHED collapse to TRIGGERED (both mean the algo rail's job
// is done — the reducer only needs to know a fill may exist), CANCELED/EXPIRED pass through, and any
// other value is UNKNOWN rather than trusted (recoverSymbol retries UNKNOWN/RESTING identically).
function mapAlgoHistoryStatus(raw: string | undefined): AlgoOrderHistoryView['status'] {
  switch (raw) {
    case 'NEW':
      return 'RESTING';
    case 'TRIGGERED':
    case 'FINISHED':
      return 'TRIGGERED';
    case 'CANCELED':
      return 'CANCELED';
    case 'EXPIRED':
      return 'EXPIRED';
    default:
      return 'UNKNOWN';
  }
}

export function normalizeAlgoHistory(o: RawAlgoOrder): AlgoOrderHistoryView | undefined {
  if (o.algoId === undefined) return undefined;
  const rawUpdateMs = o.updateTime ?? o.triggerTime;
  // The demo venue carries the triggered market order's id as `actualOrderId` (keyed probe
  // 2026-07-17: the FINISHED row's actualOrderId equals the fill's own order id exactly; CANCELED
  // rows carry '' — empty string means absent, never a valid id). `orderId` stays as the
  // documented-prod-shape fallback. Missing this field was the S6b no-heal: spawnedOrderId came
  // out undefined, and recovery correctly refuses to guess without it.
  const spawnedRaw = [o.actualOrderId, o.orderId].find((v) => v != null && String(v) !== '');
  return {
    algoId: String(o.algoId),
    clientAlgoId: o.clientAlgoId,
    status: mapAlgoHistoryStatus(o.algoStatus),
    spawnedOrderId: spawnedRaw !== undefined ? String(spawnedRaw) : undefined,
    qty: toStr(o.quantity, '0'),
    triggerPrice: toStr(o.triggerPrice, '0'),
    updateTimeMs: rawUpdateMs !== undefined ? epochMs(rawUpdateMs) : undefined,
  };
}
