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
// d2 (AGENTIC_DERIVATIVES_V2_ENABLED): trailing lookback window for the OI-change and funding-trend
// ring buffers — a constant, not an env knob (Unit 1 spec: default 1h, no per-deployment tuning).
const V2_LOOKBACK_MS = 60 * 60 * 1000;

/** Minimal ccxt REST surface this service needs — injected so tests supply a fixture double
 * instead of a live exchange (mirrors OhlcvSource in feed-health.service.ts). */
export interface DerivativesRestSource {
  // string | number: constructed with `number: String` (CLAUDE.md rule 1), ccxt returns every
  // parsed numeric as a string at runtime even though its .d.ts declares number — the same
  // contract ccxt-order-client.ts types around defensively.
  fetchFundingRate(symbol: string): Promise<{
    fundingRate?: string | number;
    markPrice?: string | number;
    indexPrice?: string | number;
    interval?: string;
  }>;
  fetchOpenInterest(symbol: string): Promise<{
    openInterestAmount?: string | number;
  }>;
  // d2 true spot-perp basis: unified ccxt fetchTicker on the SPOT market (mirrors
  // trade-flow-feed.service.ts's own spot-client precedent) — returns the venue's own last trade
  // price. Optional: absent sources (pre-v2 fixtures/doubles) simply produce spotPerpBasisBps: null.
  fetchTicker?(symbol: string): Promise<{ last?: string | number }>;
}

// d2 ring-buffer sample: one (timestamp, value) pair, oldest-first within the retained window.
interface TrendSample {
  readonly ts: number;
  readonly value: number;
}

// Percent change from the oldest sample retained in the buffer (as close to V2_LOOKBACK_MS ago as
// the poll cadence allows) to the newest — null with fewer than 2 samples (buffer just started
// accumulating) or a non-positive reference value (a percent change against it would be meaningless).
function pctChangeFromBuffer(buf: readonly TrendSample[]): number | null {
  if (buf.length < 2) return null;
  const first = buf[0]!.value;
  const last = buf[buf.length - 1]!.value;
  if (first <= 0) return null;
  return ((last - first) / first) * 100;
}

// Raw delta + sign over the same buffer — funding rate can be negative, so (unlike OI) a percent
// change against the reference sample is not always meaningful; direction/delta is.
function trendFromBuffer(
  buf: readonly TrendSample[],
): { readonly delta: number; readonly direction: 'up' | 'down' | 'flat' } | null {
  if (buf.length < 2) return null;
  const delta = buf[buf.length - 1]!.value - buf[0]!.value;
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  return { delta, direction };
}

// Display-grade coercion for reference floats (funding/OI/basis are order-book-class data, not
// money): accepts ccxt's number-or-string, rejects anything non-finite.
function asFiniteNumber(v: string | number | undefined): number | null {
  if (v === undefined) return null;
  // eslint-disable-next-line no-restricted-syntax -- Number() coerces display-grade reference data, not money.
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
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
  // d2 accumulation buffers — populated on EVERY successful poll regardless of
  // AGENTIC_DERIVATIVES_V2_ENABLED (see V2_LOOKBACK_MS's comment and this file's class header).
  private readonly oiHistory = new Map<SymbolId, TrendSample[]>();
  private readonly fundingHistory = new Map<SymbolId, TrendSample[]>();

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
      // d2: the spot ticker rides the SAME Promise.all as funding/OI — a spot-fetch failure fails
      // the whole poll (existing catch below), rather than a silently-partial v2-less snapshot.
      const [funding, oi, ticker] = await Promise.all([
        this.source.fetchFundingRate(perpSymbol),
        this.source.fetchOpenInterest(perpSymbol),
        this.source.fetchTicker
          ? this.source.fetchTicker(String(symbol))
          : Promise.resolve(undefined),
      ]);
      const snapshot = this.toSnapshot(symbol, funding, oi, ticker);
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

  // d2: appends a fresh (ts, value) sample to `map`'s buffer for `symbol`, pruning anything older
  // than V2_LOOKBACK_MS — called on EVERY successful poll regardless of
  // AGENTIC_DERIVATIVES_V2_ENABLED, so a full lookback of history already exists the moment the flag
  // is switched on (see this file's class header comment).
  private recordSample(
    map: Map<SymbolId, TrendSample[]>,
    symbol: SymbolId,
    ts: number,
    value: number,
  ): readonly TrendSample[] {
    const buf = map.get(symbol) ?? [];
    buf.push({ ts, value });
    const cutoff = ts - V2_LOOKBACK_MS;
    while (buf.length > 0 && buf[0]!.ts < cutoff) buf.shift();
    map.set(symbol, buf);
    return buf;
  }

  private toSnapshot(
    symbol: SymbolId,
    funding: Awaited<ReturnType<DerivativesRestSource['fetchFundingRate']>>,
    oi: Awaited<ReturnType<DerivativesRestSource['fetchOpenInterest']>>,
    ticker: Awaited<ReturnType<NonNullable<DerivativesRestSource['fetchTicker']>>> | undefined,
  ): DerivativesSnapshot | null {
    const fundingRate = asFiniteNumber(funding.fundingRate);
    // fundingRate is the one field this block cannot render without — no partial/garbage snapshot.
    if (fundingRate === null) return null;

    const markPrice = asFiniteNumber(funding.markPrice);
    const indexPrice = asFiniteNumber(funding.indexPrice);
    const basisBps =
      markPrice !== null && indexPrice !== null && indexPrice > 0
        ? ((markPrice - indexPrice) / indexPrice) * 10_000
        : 0;
    const openInterest = asFiniteNumber(oi.openInterestAmount) ?? 0;
    const asOf = epochMs(this.options.clock.now());

    // d2 accumulation — ALWAYS recorded regardless of AGENTIC_DERIVATIVES_V2_ENABLED; a v2-off
    // deployment simply never renders the resulting fields (agent-prompt.ts's buildDerivativesBlock
    // gates that, not this service).
    const oiBuf = this.recordSample(this.oiHistory, symbol, asOf, openInterest);
    const fundingBuf = this.recordSample(this.fundingHistory, symbol, asOf, fundingRate);
    const oiChangePct = pctChangeFromBuffer(oiBuf);
    const fundingTrend = trendFromBuffer(fundingBuf);

    const spotLast = asFiniteNumber(ticker?.last);
    const spotPerpBasisBps =
      spotLast !== null && spotLast > 0 && markPrice !== null
        ? ((markPrice - spotLast) / spotLast) * 10_000
        : null;

    return {
      asOf,
      fundingRate,
      fundingAnnualizedPct: fundingRate * periodsPerYear(funding.interval) * 100,
      openInterest,
      basisBps,
      spotPerpBasisBps,
      oiChangePct,
      fundingTrendDelta: fundingTrend?.delta ?? null,
      fundingTrendDirection: fundingTrend?.direction ?? null,
    };
  }
}
