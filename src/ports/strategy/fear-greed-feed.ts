import type { EpochMs } from '../../domain/common/types/ids';

// X3a: read-only Crypto Fear & Greed Index (alternative.me) — a REST-poll source alongside the
// derivatives/sentiment/tradeFlow/positioning feeds, surfaced to the agentic prompt when fresh.
// LANE-WIDE (not per-symbol): the index is a single market-wide reading, so there is one snapshot
// for the whole deployment, not one per symbol (same convention as SentimentFeedPort — no symbol
// argument). Daily-ish upstream cadence (the source updates roughly once a day); polled far more
// often than that is wasted, hence the 6h default poll interval (FEAR_GREED_POLL_MS).
export const FEAR_GREED_FEED = Symbol('FEAR_GREED_FEED');

export interface FearGreedSnapshot {
  readonly asOf: EpochMs;
  // 0..100 index value as published by the source (0 = extreme fear, 100 = extreme greed).
  readonly value: number;
  // The source's own classification string for `value` (e.g. "Extreme Fear", "Greed") — rendered
  // verbatim, never re-derived from `value` here, so a future upstream bucket-boundary change can
  // never silently disagree with this snapshot's own text.
  readonly classification: string;
  // Direction over the fetched history window (oldest vs newest retained day): 'rising' means the
  // index moved toward greed, 'falling' toward fear. null when fewer than 2 usable history rows were
  // parsed (never guessed from a single reading).
  readonly trend: 'rising' | 'falling' | 'flat' | null;
}

export interface FearGreedFeedPort {
  // Mirrors SentimentFeedPort.latest — stale/absent both answer null. No symbol argument (see this
  // module's own header comment).
  latest(): FearGreedSnapshot | null;
  lastSuccessfulPollAt(): EpochMs | null;
  pollErrorCount(): number;
}
