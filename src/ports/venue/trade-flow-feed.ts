import type { SymbolId, EpochMs } from '../../domain/common/types/ids';

// Trade-flow / CVD context (2026-07-13): taker aggressor imbalance derived from RAW closed-bar
// klines — a separate REST-poll source alongside the WS-fed candle stream, surfaced to the agentic
// prompt when fresh. ccxt's own OHLCV parsing (both REST fetchOHLCV and WS watchOHLCV) UNCONDITIONALLY
// drops the venue's taker-buy-base-volume field (verified: node_modules/ccxt/js/src/binance.js
// parseOHLCV returns only [time,open,high,low,close,volume] — the raw Binance kline array's index 9
// never survives), so the strategy's own candle history (market-data/normalize.ts) structurally
// cannot carry it — this feed instead polls the raw (unparsed) klines endpoint directly, bypassing
// ccxt's parseOHLCV, the same "read the field ccxt would otherwise discard" pattern as
// DerivativesFeedService reading funding/OI off a sibling public REST call. Display-grade numbers
// throughout (mirrors DerivativesSnapshot): reference context for the LLM, never a money path.
export const TRADE_FLOW_FEED = Symbol('TRADE_FLOW_FEED');

export interface TradeFlowSnapshot {
  readonly asOf: EpochMs;
  // Most recent CLOSED bar's aggressor imbalance: (takerBuyVol - takerSellVol) / totalVol, in
  // [-1, 1]. Positive means the bar's volume skewed toward taker BUYS (aggressive buying).
  readonly barImbalance: number;
  // Rolling cumulative volume delta (taker buy − taker sell, base-asset units) summed over the last
  // `lookbackBars` CLOSED bars — the standard CVD construction, reset to a plain rolling-window sum
  // here (not an all-time running total) so the value stays comparable across symbols/timeframes.
  readonly cvd: number;
  readonly lookbackBars: number;
  // X5 (tf2): per-bar CVD deltas (taker buy − taker sell, base-asset units) for the last
  // min(lookbackBars, 8) CLOSED bars, oldest-first — a compact series alongside the single rolling
  // `cvd` total above, for spotting a bar-by-bar shift the cumulative number alone hides. Always
  // present (possibly empty) whenever the snapshot itself renders — never independently gated.
  readonly cvdDeltas: readonly number[];
  // Price direction over the SAME trailing window as cvdDeltas vs that window's own CVD direction:
  // 'bullish_divergence' = price fell while CVD rose (selling pressure without matching sell flow —
  // a MODULATOR on conviction, never a standalone entry trigger); 'bearish_divergence' = the mirror
  // (price rose while CVD fell). null when the window is too short (<2 bars) or the two directions
  // do not diverge.
  readonly divergence: 'bullish_divergence' | 'bearish_divergence' | null;
}

export interface TradeFlowFeedPort {
  // Latest polled snapshot for symbol; null when no successful poll has landed yet OR the most
  // recent successful poll is stale (see the service's staleness threshold) — stale data is treated
  // as absent, never served past its shelf life. Mirrors DerivativesFeedPort.latest.
  latest(symbol: SymbolId): TradeFlowSnapshot | null;
  lastSuccessfulPollAt(): EpochMs | null;
  pollErrorCount(): number;
}
