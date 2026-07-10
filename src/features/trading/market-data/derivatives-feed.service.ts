import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { SymbolId, EpochMs } from '../../../domain/types/ids';
import { epochMs } from '../../../domain/types/ids';
import { splitSymbol } from '../../../domain/types/symbol';
import type { ClockPort } from '../../../ports/clock';
import type { DerivativesFeedPort, DerivativesSnapshot } from '../../../ports/derivatives-feed';

// Binance USDM funding settles 3x/day (every 8h) for the vast majority of listed perps; used only
// to annualize the polled fundingRate into a display-grade percent when the venue response omits
// its own `interval` field (observed absent on some ccxt binanceusdm responses).
const DEFAULT_FUNDING_PERIODS_PER_YEAR = 3 * 365;
// latest() treats a snapshot older than this multiple of the poll interval as stale (absent to the
// caller) — a symbol whose poll loop has stalled (network outage, venue error) must stop answering
// with an ever-more-outdated snapshot rather than silently going quiet.
const STALE_POLL_MULTIPLE = 2;

/** Minimal ccxt REST surface this service needs — injected so tests supply a fixture double
 * instead of a live exchange (mirrors OhlcvSource in feed-health.service.ts). */
export interface DerivativesRestSource {
  fetchFundingRate(symbol: string): Promise<{
    fundingRate?: number;
    markPrice?: number;
    indexPrice?: number;
    interval?: string;
  }>;
  fetchOpenInterest(symbol: string): Promise<{
    openInterestAmount?: number;
  }>;
}

function periodsPerYear(interval: string | undefined): number {
  if (!interval) return DEFAULT_FUNDING_PERIODS_PER_YEAR;
  const match = /^(\d+)h$/.exec(interval);
  if (!match) return DEFAULT_FUNDING_PERIODS_PER_YEAR;
  // eslint-disable-next-line no-restricted-syntax -- Number() coerces an interval string ("8h"), not money.
  const hours = Number(match[1]);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_FUNDING_PERIODS_PER_YEAR;
  return (24 / hours) * 365;
}

// BASE/QUOTE (spot, e.g. BTC/USDT) -> BASE/QUOTE:QUOTE (ccxt's linear-swap perp form) — this feed
// polls the USDT-margined perpetual for a spot symbol's futures-market context (funding/OI/basis
// have no spot-market equivalent). Every symbol this deployment trades settles in its quote asset
// (USDT), so settle===quote always holds here (see splitSymbol's own header comment).
function perpSymbolFor(symbol: SymbolId): string {
  const { base, quote } = splitSymbol(symbol);
  return `${base}/${quote}:${quote}`;
}

export interface DerivativesFeedOptions {
  readonly symbols: readonly SymbolId[];
  readonly pollIntervalMs: number;
  readonly clock: ClockPort;
  readonly logger?: { warn: (msg: string) => void };
}

/**
 * REST-poll service for public derivatives-market context (funding rate, open interest, mark/index
 * basis) — feature-flagged OFF by default (DERIVATIVES_FEED_ENABLED), consumed by the agentic prompt
 * (agent-prompt.ts's buildDerivativesBlock) via the DerivativesFeedPort. Never on the order path —
 * a poll failure logs and continues; latest() answers null while stale/absent so a caller never
 * blocks or delays on this feed (CLAUDE.md rule 5's OMS caution does not apply here: no network call
 * this service makes is ever awaited by a decide()/order path).
 */
@Injectable()
export class DerivativesFeedService implements DerivativesFeedPort, OnModuleInit, OnModuleDestroy {
  private readonly snapshots = new Map<SymbolId, DerivativesSnapshot>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSuccessAt: EpochMs | null = null;
  private errorCount = 0;

  constructor(
    private readonly source: DerivativesRestSource,
    private readonly options: DerivativesFeedOptions,
  ) {}

  onModuleInit(): void {
    this.start();
  }

  start(): void {
    if (this.timer) return;
    void this.pollAll();
    this.timer = setInterval(() => {
      void this.pollAll();
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

  latest(symbol: SymbolId): DerivativesSnapshot | null {
    const snap = this.snapshots.get(symbol);
    if (!snap) return null;
    const ageMs = this.options.clock.now() - snap.asOf;
    if (ageMs > this.options.pollIntervalMs * STALE_POLL_MULTIPLE) return null;
    return snap;
  }

  lastSuccessfulPollAt(): EpochMs | null {
    return this.lastSuccessAt;
  }

  // Monotonic cumulative count since process start — MetricsService's pull loop diffs successive
  // samples into the poll-errors Counter (same delta-against-previous-sample pattern it already
  // uses for event_loop_utilization's prevElu).
  pollErrorCount(): number {
    return this.errorCount;
  }

  async pollAll(): Promise<void> {
    await Promise.all(this.options.symbols.map((s) => this.pollOne(s)));
  }

  private async pollOne(symbol: SymbolId): Promise<void> {
    const perpSymbol = perpSymbolFor(symbol);
    try {
      const [funding, oi] = await Promise.all([
        this.source.fetchFundingRate(perpSymbol),
        this.source.fetchOpenInterest(perpSymbol),
      ]);
      const snapshot = this.toSnapshot(funding, oi);
      if (snapshot) {
        this.snapshots.set(symbol, snapshot);
        this.lastSuccessAt = snapshot.asOf;
      }
    } catch (err) {
      this.errorCount += 1;
      this.options.logger?.warn(
        `derivatives-feed poll failed for ${perpSymbol}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private toSnapshot(
    funding: Awaited<ReturnType<DerivativesRestSource['fetchFundingRate']>>,
    oi: Awaited<ReturnType<DerivativesRestSource['fetchOpenInterest']>>,
  ): DerivativesSnapshot | null {
    const fundingRate = funding.fundingRate;
    // fundingRate is the one field this block cannot render without — no partial/garbage snapshot.
    if (typeof fundingRate !== 'number' || !Number.isFinite(fundingRate)) return null;

    const markPrice = funding.markPrice;
    const indexPrice = funding.indexPrice;
    const basisBps =
      typeof markPrice === 'number' && typeof indexPrice === 'number' && indexPrice > 0
        ? ((markPrice - indexPrice) / indexPrice) * 10_000
        : 0;
    const openInterest =
      typeof oi.openInterestAmount === 'number' && Number.isFinite(oi.openInterestAmount)
        ? oi.openInterestAmount
        : 0;

    return {
      asOf: epochMs(this.options.clock.now()),
      fundingRate,
      fundingAnnualizedPct: fundingRate * periodsPerYear(funding.interval) * 100,
      openInterest,
      basisBps,
    };
  }
}
