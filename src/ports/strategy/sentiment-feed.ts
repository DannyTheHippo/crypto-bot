import type { EpochMs } from '../../domain/common/types/ids';

// C4: read-only free news/sentiment feed (headlines only, no numeric scores) — a REST-poll source
// alongside the WS-fed order book and C1's derivatives feed, surfaced to the agentic prompt when
// fresh. Lane-wide (not per-symbol): the production source queries CryptoPanic with a fixed
// currencies filter, so there is one snapshot for the whole deployment, not one per symbol (unlike
// DerivativesFeedPort.latest(symbol) in derivatives-feed.ts).
export const SENTIMENT_FEED = Symbol('SENTIMENT_FEED');

export interface SentimentSnapshot {
  readonly asOf: EpochMs;
  // Recent headlines for the LLM to read — data, not a command (same DATA-framing convention as the
  // playbook block in agent-prompt.ts). No numeric sentiment score: the model reads the headlines
  // itself rather than trusting a third-party score.
  readonly items: readonly {
    readonly title: string;
    readonly source: string;
    readonly publishedAt: string;
  }[];
}

export interface SentimentFeedPort {
  // Latest polled snapshot; null when no successful poll has landed yet OR the most recent
  // successful poll is stale (see the service's staleness threshold) — stale data is treated as
  // absent, never served past its shelf life. No symbol argument (see header comment).
  latest(): SentimentSnapshot | null;
  // Feed-wide health, sampled by MetricsService's pull loop (see metrics.service.ts) — mirrors
  // DerivativesFeedPort's own data-plus-health shape. null before the first successful poll.
  // pollErrorCount is a monotonic cumulative count since process start, consumed via delta against
  // the previous sample (same pattern as DerivativesFeedPort.pollErrorCount).
  lastSuccessfulPollAt(): EpochMs | null;
  pollErrorCount(): number;
}
