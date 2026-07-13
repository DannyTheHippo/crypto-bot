import type { SymbolId, EpochMs } from '../domain/types/ids';

// Positioning context (2026-07-13): market-wide futures positioning (global long/short account
// ratio), a separate REST-poll source surfaced to the agentic prompt when fresh — same shape as
// DerivativesFeedPort. Liquidation-order flow was IN SCOPE per the original brief but is NOT shipped:
// ccxt 4.5.58 declares `fetchLiquidations: false` for binance, and the only forceOrders REST endpoints
// it exposes (fapiPrivateGetForceOrders / dapiPrivateGetForceOrders / papiGet{Margin,Um,Cm}ForceOrders)
// are PRIVATE, per-account endpoints — they return the caller's OWN forced liquidations, never
// market-wide flow. Binance's market-wide liquidation feed is WS-only (`!forceOrder@arr`), which the
// brief explicitly said to skip in favor of REST when a WS stream would be required. Display-grade
// numbers throughout: reference context for the LLM, never a money path.
export const POSITIONING_FEED = Symbol('POSITIONING_FEED');

export interface PositioningSnapshot {
  readonly asOf: EpochMs;
  // Global long/short ACCOUNT ratio (not position-weighted) for the symbol's USDT-margined perp,
  // from ccxt's fetchLongShortRatioHistory (maps to fapiDataGetGlobalLongShortAccountRatio).
  readonly longShortRatio: number;
  readonly longAccountPct: number; // 0..100
  readonly shortAccountPct: number; // 0..100
}

export interface PositioningFeedPort {
  // Mirrors DerivativesFeedPort.latest — stale/absent both answer null.
  latest(symbol: SymbolId): PositioningSnapshot | null;
  lastSuccessfulPollAt(): EpochMs | null;
  pollErrorCount(): number;
}
