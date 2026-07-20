import type { SymbolId, EpochMs } from '../domain/types/ids';

// Positioning context (2026-07-13): market-wide futures positioning (global long/short account
// ratio), a separate REST-poll source surfaced to the agentic prompt when fresh — same shape as
// DerivativesFeedPort. Liquidation-order flow was IN SCOPE per the original brief but is NOT shipped
// via THIS (REST-poll) mechanism: ccxt 4.5.58 declares `fetchLiquidations: false` for binance, and the
// only forceOrders REST endpoints it exposes (fapiPrivateGetForceOrders / dapiPrivateGetForceOrders /
// papiGet{Margin,Um,Cm}ForceOrders) are PRIVATE, per-account endpoints — they return the caller's OWN
// forced liquidations, never market-wide flow. Binance's market-wide liquidation feed is WS-only
// (`!forceOrder@arr`/per-symbol `forceOrder`), which THIS brief explicitly said to skip in favor of
// REST when a WS stream would be required — Push 3 P6 Unit 2 later verified ccxt PRO's
// watchLiquidationsForSymbols was usable and shipped it as its own WS-based feed instead (see
// liquidation-feed.ts). Display-grade numbers throughout: reference context for the LLM, never a
// money path.
export const POSITIONING_FEED = Symbol('POSITIONING_FEED');

export interface PositioningSnapshot {
  readonly asOf: EpochMs;
  // Global long/short ACCOUNT ratio (not position-weighted) for the symbol's USDT-margined perp,
  // from ccxt's fetchLongShortRatioHistory (maps to fapiDataGetGlobalLongShortAccountRatio).
  readonly longShortRatio: number;
  readonly longAccountPct: number; // 0..100
  readonly shortAccountPct: number; // 0..100
  // X3b (pos2): futures taker buy/sell volume — a SECOND Binance endpoint
  // (fapiDataGetTakerlongshortRatio) polled on the SAME poller as the account ratio above, distinct
  // from it (this is TRADE volume flow, not open-position accounts). null when the taker-ratio row
  // itself was unparseable — never discards the still-valid longShortRatio fields above for that.
  readonly takerBuySellRatio: number | null;
  readonly takerBuyVol: number | null;
  readonly takerSellVol: number | null;
}

export interface PositioningFeedPort {
  // Mirrors DerivativesFeedPort.latest — stale/absent both answer null.
  latest(symbol: SymbolId): PositioningSnapshot | null;
  lastSuccessfulPollAt(): EpochMs | null;
  pollErrorCount(): number;
}
