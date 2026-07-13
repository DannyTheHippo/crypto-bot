import type { SymbolId, EpochMs } from '../domain/types/ids';

// #43 (Push 3 P6 Unit 2): read-only public liquidation-order feed (binanceusdm forceOrder stream via
// ccxt PRO's watchLiquidationsForSymbols) — a WS-fed sibling to the REST-polled derivatives/
// positioning feeds, surfaced to the agentic prompt when the stream is healthy. Liquidations are
// naturally SPARSE (a quiet market may see none for hours), so staleness here is NOT "no recent
// event" the way it is for the REST-poll feeds — it is STREAM HEALTH (connected vs currently
// erroring/reconnecting). See LiquidationFeedPort.latest's own comment for the resulting contract.
// Display-grade numbers throughout, never a money path.
export const LIQUIDATION_FEED = Symbol('LIQUIDATION_FEED');

export interface LiquidationSnapshot {
  readonly asOf: EpochMs;
  readonly windowMin: number;
  // Total (long + short) liquidation notional, in quote currency (USDT), within the trailing window.
  readonly liqNotionalUsd: number;
  // longLiqNotional / (longLiqNotional + shortLiqNotional) — null when the window carries zero
  // notional (never NaN; a healthy, quiet window is still a valid snapshot, see `count`).
  readonly longShareOfLiqs: number | null;
  readonly count: number;
}

export interface LiquidationFeedPort {
  // null ONLY while the stream itself is down (never started, or currently erroring/reconnecting —
  // see streamHealthy()). A HEALTHY stream with zero liquidation events in the trailing window still
  // answers a snapshot (count: 0, liqNotionalUsd: 0, longShareOfLiqs: null) — "quiet market" and
  // "dead stream" are deliberately NOT the same absence (the brief's own distinction).
  latest(symbol: SymbolId): LiquidationSnapshot | null;
  // Feed-wide (not per-symbol) stream health — true once the watch loop is running without an
  // unrecovered error, false while actively backing off before a reconnect attempt.
  streamHealthy(): boolean;
  // Monotonic cumulative count since process start (mirrors DerivativesFeedPort.pollErrorCount).
  reconnectCount(): number;
}
