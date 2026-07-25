import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { EpochMs } from '../../../domain/common/types/ids';
import { epochMs } from '../../../domain/common/types/ids';
import type { ClockPort } from '../../../ports/common/clock';
import type { FearGreedFeedPort, FearGreedSnapshot } from '../../../ports/strategy/fear-greed-feed';

// latest() treats a snapshot older than this multiple of the poll interval as stale (absent to the
// caller) — mirrors SentimentFeedService's own STALE_POLL_MULTIPLE.
const STALE_POLL_MULTIPLE = 2;
// Source-data freshness bound, INDEPENDENT of the poll-interval staleness above: alternative.me
// publishes roughly one reading per day, so a "current" row can legitimately sit unchanged for many
// polls — that is a fresh value, not stale data. What DOES make the value untrustworthy is the
// upstream source itself going quiet (an outage, a discontinued feed) — a newest row whose OWN
// timestamp is more than two days old is no longer a live reading, so the snapshot is omitted
// entirely rather than served on a technicality of "we polled recently."
const SOURCE_DATA_STALE_MS = 48 * 60 * 60 * 1000;

/** Minimal fetch-shaped surface this service needs — injected so tests supply a double instead of
 * global fetch (mirrors SentimentHttpSource in sentiment-feed.service.ts). */
export interface FearGreedHttpSource {
  fetchIndex(): Promise<unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// Reference-grade coercion (index value / unix timestamp), never a money path.
function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    // eslint-disable-next-line no-restricted-syntax -- Number() coerces a display-grade index/timestamp field, not money.
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

interface ParsedRow {
  // Unix ms (the venue's own field is unix SECONDS — normalized on parse).
  readonly ts: number;
  readonly value: number;
  readonly classification: string;
}

// alternative.me's `data` array shape is unknown/untrusted at compile time — this guard narrows
// defensively rather than assuming an ordering or a fixed row count (the brief: "it returns prior
// days — do NOT assume, parse defensively"). Rows are sorted ascending (oldest first) below rather
// than trusted to already arrive in a particular order.
function parseHistory(raw: unknown): ParsedRow[] {
  if (!isPlainObject(raw) || !Array.isArray(raw['data'])) return [];
  const rows: ParsedRow[] = [];
  for (const entry of raw['data']) {
    if (!isPlainObject(entry)) continue;
    const value = asFiniteNumber(entry['value']);
    const tsSeconds = asFiniteNumber(entry['timestamp']);
    const classification =
      typeof entry['value_classification'] === 'string' ? entry['value_classification'] : null;
    if (value === null || tsSeconds === null || classification === null) continue;
    rows.push({ ts: tsSeconds * 1000, value, classification });
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

function trendFrom(rows: readonly ParsedRow[]): FearGreedSnapshot['trend'] {
  if (rows.length < 2) return null;
  const delta = rows[rows.length - 1]!.value - rows[0]!.value;
  return delta > 0 ? 'rising' : delta < 0 ? 'falling' : 'flat';
}

export interface FearGreedFeedOptions {
  readonly pollIntervalMs: number;
  readonly clock: ClockPort;
  readonly logger?: { warn: (msg: string) => void };
}

/**
 * REST-poll service for the Crypto Fear & Greed Index (alternative.me) — feature-flagged OFF by
 * default (FEAR_GREED_FEED_ENABLED), consumed by the agentic prompt (agent-prompt.ts's
 * buildFearGreedBlock) via FearGreedFeedPort. Never on the order path — a poll failure logs and
 * continues; latest() answers null while stale/absent so a caller never blocks or delays on this
 * feed (mirrors DerivativesFeedService's own comment on CLAUDE.md rule 5 not applying here).
 */
@Injectable()
export class FearGreedFeedService implements FearGreedFeedPort, OnModuleInit, OnModuleDestroy {
  private snapshot: FearGreedSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSuccessAt: EpochMs | null = null;
  private errorCount = 0;

  constructor(
    private readonly source: FearGreedHttpSource,
    private readonly options: FearGreedFeedOptions,
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

  latest(): FearGreedSnapshot | null {
    if (!this.snapshot) return null;
    const ageMs = this.options.clock.now() - this.snapshot.asOf;
    if (ageMs > this.options.pollIntervalMs * STALE_POLL_MULTIPLE) return null;
    return this.snapshot;
  }

  lastSuccessfulPollAt(): EpochMs | null {
    return this.lastSuccessAt;
  }

  pollErrorCount(): number {
    return this.errorCount;
  }

  async poll(): Promise<void> {
    try {
      const raw = await this.source.fetchIndex();
      const snapshot = this.toSnapshot(raw, epochMs(this.options.clock.now()));
      if (snapshot) {
        this.snapshot = snapshot;
        this.lastSuccessAt = snapshot.asOf;
      }
    } catch (err) {
      this.errorCount += 1;
      this.options.logger?.warn(
        `fear-greed-feed poll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private toSnapshot(raw: unknown, now: EpochMs): FearGreedSnapshot | null {
    const rows = parseHistory(raw);
    if (rows.length === 0) return null;
    const newest = rows[rows.length - 1]!;
    if (now - newest.ts > SOURCE_DATA_STALE_MS) return null;
    return {
      asOf: now,
      value: newest.value,
      classification: newest.classification,
      trend: trendFrom(rows),
    };
  }
}
