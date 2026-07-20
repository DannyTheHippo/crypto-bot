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
  // d2 (AGENTIC_DERIVATIVES_V2_ENABLED) fields — ALWAYS COMPUTED whenever the derivatives feed itself
  // is polling (accumulation is independent of the v2 flag, so a full lookback of ring-buffer history
  // already exists the moment v2 is switched on); the FLAG gates only whether agent-prompt.ts's
  // buildDerivativesBlock includes them in the rendered payload (see that file's DERIVATIVES_V2_
  // TEMPLATE_VERSION comment on why enabling mid-factorial is forbidden). null while the underlying
  // spot ticker/buffer data isn't available yet (first poll(s), or the source has no fetchTicker).
  // True spot-vs-perp basis: (perp mark − spot last) / spot last, in basis points — distinct from
  // basisBps above (which is mark-vs-INDEX, a venue-internal fair-value reference, not a tradable
  // spot price).
  readonly spotPerpBasisBps: number | null;
  // Percent change in open interest from the oldest sample retained in the ring buffer (as close to
  // the lookback window's start as the poll cadence allows) to the current value.
  readonly oiChangePct: number | null;
  // Same ring-buffer approach as oiChangePct, applied to fundingRate: raw fraction delta and its sign.
  readonly fundingTrendDelta: number | null;
  readonly fundingTrendDirection: 'up' | 'down' | 'flat' | null;
  // ADD-A (X2, perp basket widening): last up-to-3 SETTLED funding rates (raw fraction, oldest-
  // first), fetched via DerivativesRestSource.fetchFundingRateHistory — distinct from
  // fundingTrendDelta/Direction above, which is a poll-cadence ring buffer (V2_LOOKBACK_MS=1h) that
  // cannot span 8h-apart settlements. Optional: absent on pre-ADD-A fixtures/doubles; null when the
  // source has no fetchFundingRateHistory method, the history fetch failed, or it returned zero rows
  // — same fail-open-measurement contract as the other optional feed fields on this snapshot.
  readonly recentFundingRates?: readonly number[] | null;
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
