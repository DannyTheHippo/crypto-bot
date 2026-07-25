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
  // X2 stage-1 perp basket (2026-07-20): values probe-verified against the DEMO venue
  // (demo-fapi.binance.com/fapi/v1/exchangeInfo — the venue this lane actually trades; the #54
  // pattern), all 8 status TRADING. BTC step/minQty corrected 0.001→0.0001 (the 2026-07-13 row
  // carried the PROD figure; demo is finer — and on a $1k book a 0.001 BTC step is a ~$110
  // quantum, so the finer demo step materially improves fraction sizing).
  ['BTC/USDT:USDT', { tickSize: '0.10', stepSize: '0.0001', minQty: '0.0001', minNotional: '50' }],
  ['ETH/USDT:USDT', { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '20' }],
  ['SOL/USDT:USDT', { tickSize: '0.01', stepSize: '0.01', minQty: '0.01', minNotional: '5' }],
  ['ZEC/USDT:USDT', { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '5' }],
  ['AAVE/USDT:USDT', { tickSize: '0.01', stepSize: '0.1', minQty: '0.1', minNotional: '5' }],
  ['NEAR/USDT:USDT', { tickSize: '0.001', stepSize: '1', minQty: '1', minNotional: '5' }],
  ['HYPE/USDT:USDT', { tickSize: '0.001', stepSize: '0.01', minQty: '0.01', minNotional: '5' }],
  ['KAITO/USDT:USDT', { tickSize: '0.0001', stepSize: '0.1', minQty: '0.1', minNotional: '5' }],
  // v3 §5.4 stage-2 perp basket (ranks 9-16): values probe-verified against
  // demo-fapi.binance.com/fapi/v1/exchangeInfo 2026-07-21 (same #54 pattern as stage-1 above),
  // all 8 status TRADING, minNotional 5 across the set. minQty mirrors stepSize per the venue's
  // LOT_SIZE (demo fapi reports minQty === stepSize for every one of these — same as stage-1).
  ['TRUMP/USDT:USDT', { tickSize: '0.001', stepSize: '0.01', minQty: '0.01', minNotional: '5' }],
  ['UNI/USDT:USDT', { tickSize: '0.001', stepSize: '1', minQty: '1', minNotional: '5' }],
  ['BCH/USDT:USDT', { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '5' }],
  ['XRP/USDT:USDT', { tickSize: '0.0001', stepSize: '0.1', minQty: '0.1', minNotional: '5' }],
  ['LINK/USDT:USDT', { tickSize: '0.001', stepSize: '0.01', minQty: '0.01', minNotional: '5' }],
  ['AVAX/USDT:USDT', { tickSize: '0.001', stepSize: '1', minQty: '1', minNotional: '5' }],
  ['SUI/USDT:USDT', { tickSize: '0.0001', stepSize: '0.1', minQty: '0.1', minNotional: '5' }],
  ['LTC/USDT:USDT', { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '5' }],
  // U1 (Design § Universe: 8 -> ~24 basket) venue-filters GROUNDWORK for the planned expansion
  // (BNB DOGE ADA AVAX DOT LTC SUI PEPE WIF TRX SHIB UNI APT ARB OP FIL). Chosen: mechanical table
  // extension with these rows as the DEFAULT_FILTERS fallback (smaller correct change than adding a
  // new exchangeInfo-at-boot fetch path — ExchangePort has no loadMarkets/fetchMarkets method today,
  // so option (b) would mean a new port method + adapter implementations + boot plumbing across
  // ccxt/paper/live adapters, well past this step's groundwork scope).
  //
  // Live-probe-verified 2026-07-18 against api.binance.com/api/v3/exchangeInfo (all 16 symbols
  // status TRADING). Eight of the original groundwork estimates were wrong and corrected to the
  // live PRICE_FILTER/LOT_SIZE/NOTIONAL values (AVAX tick/step were swapped, PEPE tick was 10x
  // off, TRX/APT ticks and WIF/OP steps differed, DOGE/PEPE/WIF/SHIB minNotional is 1 not 5) —
  // exactly the failure class the ZEC/AAVE/NEAR probe-verification precedent exists to catch.
  // minQty mirrors stepSize per this table's convention.
  ['BNB/USDT', { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '5' }],
  ['DOGE/USDT', { tickSize: '0.00001', stepSize: '1', minQty: '1', minNotional: '1' }],
  ['ADA/USDT', { tickSize: '0.0001', stepSize: '0.1', minQty: '0.1', minNotional: '5' }],
  ['AVAX/USDT', { tickSize: '0.001', stepSize: '0.01', minQty: '0.01', minNotional: '5' }],
  ['DOT/USDT', { tickSize: '0.001', stepSize: '0.01', minQty: '0.01', minNotional: '5' }],
  ['LTC/USDT', { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '5' }],
  ['SUI/USDT', { tickSize: '0.0001', stepSize: '0.1', minQty: '0.1', minNotional: '5' }],
  ['PEPE/USDT', { tickSize: '0.00000001', stepSize: '1', minQty: '1', minNotional: '1' }],
  ['WIF/USDT', { tickSize: '0.0001', stepSize: '0.01', minQty: '0.01', minNotional: '1' }],
  ['TRX/USDT', { tickSize: '0.0001', stepSize: '0.1', minQty: '0.1', minNotional: '5' }],
  ['SHIB/USDT', { tickSize: '0.00000001', stepSize: '1', minQty: '1', minNotional: '1' }],
  ['UNI/USDT', { tickSize: '0.001', stepSize: '0.01', minQty: '0.01', minNotional: '5' }],
  ['APT/USDT', { tickSize: '0.001', stepSize: '0.01', minQty: '0.01', minNotional: '5' }],
  ['ARB/USDT', { tickSize: '0.0001', stepSize: '0.1', minQty: '0.1', minNotional: '5' }],
  ['OP/USDT', { tickSize: '0.0001', stepSize: '0.01', minQty: '0.01', minNotional: '5' }],
  ['FIL/USDT', { tickSize: '0.001', stepSize: '0.01', minQty: '0.01', minNotional: '5' }],
]);
