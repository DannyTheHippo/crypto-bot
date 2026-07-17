import type { SymbolFilters } from './evaluate';

// Per-symbol exchange constraints for the paper/demo trading universe (Binance spot filters,
// ccxt 4.5.58). Without a non-empty entry the sizer fast-fails NO_REF_PRICE and the engine rejects
// LIMITS_INCOMPLETE, so every order dies — this map is the venue-capability wiring the composition
// root would otherwise inject. Values are the live Binance PRICE_FILTER/LOT_SIZE/NOTIONAL filters;
// the demo environment mirrors them. Both SIZER_DEPS and RISK_ENGINE_DEPS read this ONE constant so
// the sizer's stepping and the engine's F1 re-validation can never disagree.
export const DEFAULT_FILTERS: ReadonlyMap<string, SymbolFilters> = new Map<string, SymbolFilters>([
  ['BTC/USDT', { tickSize: '0.01', stepSize: '0.00001', minQty: '0.00001', minNotional: '5' }],
  ['ETH/USDT', { tickSize: '0.01', stepSize: '0.0001', minQty: '0.0001', minNotional: '5' }],
  // Binance spot exchangeInfo, fetched 2026-07-10.
  ['SOL/USDT', { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '5' }],
  ['XRP/USDT', { tickSize: '0.0001', stepSize: '0.1', minQty: '0.1', minNotional: '5' }],
  ['LINK/USDT', { tickSize: '0.001', stepSize: '0.01', minQty: '0.01', minNotional: '5' }],
  // 5→8 universe expansion (pre-auth fired 2026-07-17, reports/loop/universe-study-2026-07-13.md).
  // Values probe-verified against the LIVE demo venue (demo-api.binance.com loadMarkets,
  // 2026-07-17): all three TRADING/active; NOTIONAL filter (applyMinToMarket=true) mirrors prod.
  ['ZEC/USDT', { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '5' }],
  ['AAVE/USDT', { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '5' }],
  ['NEAR/USDT', { tickSize: '0.001', stepSize: '0.1', minQty: '0.1', minNotional: '5' }],
  // Push II Phase 8 (futures-demo venue, binanceusdm): USDⓈ-M perpetual filters — additive only
  // (never touched unless TRADING_SYMBOLS names one of these futures market ids), so the existing
  // spot deployment stays byte-identical. Values are the live fapi.binance.com/fapi/v1/exchangeInfo
  // PRICE_FILTER/LOT_SIZE/MIN_NOTIONAL figures, fetched 2026-07-13.
  ['BTC/USDT:USDT', { tickSize: '0.10', stepSize: '0.001', minQty: '0.001', minNotional: '50' }],
  ['ETH/USDT:USDT', { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '20' }],
]);
