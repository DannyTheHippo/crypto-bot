import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { EpochMs } from '../../../domain/types/ids';
import { epochMs } from '../../../domain/types/ids';
import type { ClockPort } from '../../../ports/clock';
import type { SentimentFeedPort, SentimentSnapshot } from '../../../ports/sentiment-feed';

// latest() treats a snapshot older than this multiple of the poll interval as stale (absent to the
// caller) — mirrors DerivativesFeedService's STALE_POLL_MULTIPLE.
const STALE_POLL_MULTIPLE = 2;
// Rendered headline count cap (agent-prompt.ts's buildSentimentBlock reads this many); the fetched
// response may carry far more posts than the prompt should ever see.
const MAX_ITEMS = 5;

/** Minimal fetch-shaped surface this service needs — injected so tests supply a double instead of
 * global fetch (mirrors DerivativesRestSource in derivatives-feed.service.ts). */
export interface SentimentHttpSource {
  fetchPosts(): Promise<unknown>;
}

// CryptoPanic's post shape is unknown/untrusted at compile time (`fetchPosts` returns unknown) —
// this guard narrows defensively rather than trusting an interface the venue can change without
// notice. Every field is read as a string; a response shaped differently degrades to an empty list
// rather than throwing.
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// Per-field char caps: headlines are external, community-sourced text that ends up inside the LLM
// prompt, so length is bounded here the same way playbook-validator.ts caps playbook text — a
// persuasion-surface and token-cost bound on top of MAX_ITEMS (JSON.stringify framing already
// prevents delimiter breakout).
const MAX_TITLE_CHARS = 200;
const MAX_META_CHARS = 64;
// X4 residual: bound on the cross-poll dedupe set (seenIds below) — CryptoPanic re-serves its own
// trailing window of recent posts on every poll, so without a bound the set would grow unboundedly
// over a long-running process; a few hundred ids comfortably covers many days at MAX_ITEMS/poll.
const MAX_SEEN_IDS = 500;

// X4 residual: dedupes by the venue's own post id ACROSS POLLS (seenIds is the caller's persistent
// set, mutated in place — see SentimentFeedService.seenIds) so the SAME headline does not re-enter
// the model's context every cycle just because CryptoPanic re-served it. A post with no parseable id
// cannot be deduped and is rendered every time it appears — fail OPEN (never drops a headline because
// dedupe itself is unavailable for that entry).
function parsePosts(raw: unknown, seenIds: Set<string>): SentimentSnapshot['items'] {
  if (!isPlainObject(raw) || !Array.isArray(raw['results'])) return [];
  const items: { title: string; source: string; publishedAt: string }[] = [];
  for (const entry of raw['results']) {
    if (!isPlainObject(entry)) continue;
    const idRaw = entry['id'];
    const id = typeof idRaw === 'string' || typeof idRaw === 'number' ? String(idRaw) : null;
    if (id !== null && seenIds.has(id)) continue;
    const title = asNonEmptyString(entry['title']);
    const publishedAt = asNonEmptyString(entry['published_at']);
    if (title === null || publishedAt === null) continue;
    const domain = isPlainObject(entry['source']) ? entry['source']['domain'] : undefined;
    const source = asNonEmptyString(domain) ?? 'unknown';
    items.push({
      title: title.slice(0, MAX_TITLE_CHARS),
      source: source.slice(0, MAX_META_CHARS),
      publishedAt: publishedAt.slice(0, MAX_META_CHARS),
    });
    if (id !== null) {
      if (seenIds.size >= MAX_SEEN_IDS) {
        const oldest = seenIds.values().next().value;
        if (oldest !== undefined) seenIds.delete(oldest);
      }
      seenIds.add(id);
    }
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

export interface SentimentFeedOptions {
  readonly pollIntervalMs: number;
  readonly clock: ClockPort;
  readonly logger?: { warn: (msg: string) => void };
}

/**
 * REST-poll service for free news/sentiment headlines — feature-flagged OFF by default
 * (SENTIMENT_FEED_ENABLED), consumed by the agentic prompt (agent-prompt.ts's buildSentimentBlock)
 * via the SentimentFeedPort. Never on the order path — a poll failure logs and continues; latest()
 * answers null while stale/absent so a caller never blocks or delays on this feed (mirrors
 * DerivativesFeedService's own comment on CLAUDE.md rule 5 not applying here).
 */
@Injectable()
export class SentimentFeedService implements SentimentFeedPort, OnModuleInit, OnModuleDestroy {
  private snapshot: SentimentSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSuccessAt: EpochMs | null = null;
  private errorCount = 0;
  // X4 residual: cross-poll dedupe-by-id set — persists for the process lifetime (see parsePosts's
  // own header comment and MAX_SEEN_IDS's bound above).
  private readonly seenIds = new Set<string>();

  constructor(
    private readonly source: SentimentHttpSource,
    private readonly options: SentimentFeedOptions,
  ) {}

  onModuleInit(): void {
    this.start();
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.options.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  latest(): SentimentSnapshot | null {
    if (!this.snapshot) return null;
    const ageMs = this.options.clock.now() - this.snapshot.asOf;
    if (ageMs > this.options.pollIntervalMs * STALE_POLL_MULTIPLE) return null;
    return this.snapshot;
  }

  lastSuccessfulPollAt(): EpochMs | null {
    return this.lastSuccessAt;
  }

  // Monotonic cumulative count since process start — MetricsService's pull loop diffs successive
  // samples into the poll-errors Counter (mirrors DerivativesFeedService.pollErrorCount).
  pollErrorCount(): number {
    return this.errorCount;
  }

  async poll(): Promise<void> {
    try {
      const raw = await this.source.fetchPosts();
      const items = parsePosts(raw, this.seenIds);
      const asOf = epochMs(this.options.clock.now());
      this.snapshot = { asOf, items };
      this.lastSuccessAt = asOf;
    } catch (err) {
      this.errorCount += 1;
      this.options.logger?.warn(
        `sentiment-feed poll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
