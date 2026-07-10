import type { SymbolId, EpochMs } from '../domain/types/ids';

// C1: read-only public derivatives-data feed (funding rate, open interest, mark/index basis) — a
// separate REST-poll source alongside the WS-fed order book, surfaced to the agentic prompt when
// fresh. Display-grade numbers throughout (mirrors buildOrderBookBlock's spreadBps/imbalance in
// agent-prompt.ts): reference context for the LLM, never a money path.
export const DERIVATIVES_FEED = Symbol('DERIVATIVES_FEED');

export interface DerivativesSnapshot {
  readonly asOf: EpochMs;
  // Current funding rate, as a fraction (e.g. 0.0001 = 0.01%) — venue's raw fetchFundingRate value.
  readonly fundingRate: number;
  // fundingRate annualized to a percent, using the venue's funding interval (Binance: 3x/day).
  readonly fundingAnnualizedPct: number;
  readonly openInterest: number;
  // (mark − index) / index, in basis points.
  readonly basisBps: number;
}

export interface DerivativesFeedPort {
  // Latest polled snapshot for symbol; null when no successful poll has landed yet OR the most
  // recent successful poll is stale (see the service's staleness threshold) — stale data is treated
  // as absent, never served past its shelf life.
  latest(symbol: SymbolId): DerivativesSnapshot | null;
  // Feed-wide (not per-symbol) health, sampled by MetricsService's pull loop (see metrics.service.ts)
  // — mirrors FeedHealthPort's own data-plus-health shape (ports/market-data.ts). null before the
  // first successful poll. pollErrorCount is a monotonic cumulative count since process start,
  // consumed via delta against the previous sample (same pattern as the event-loop-utilization
  // gauge's prevElu in metrics.service.ts) rather than reset on read.
  lastSuccessfulPollAt(): EpochMs | null;
  pollErrorCount(): number;
}
