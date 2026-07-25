import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { SymbolId, EpochMs } from '../../../domain/common/types/ids';
import { epochMs } from '../../../domain/common/types/ids';
import { splitSymbol } from '../../../domain/venue/types/symbol';
import type { ClockPort } from '../../../ports/common/clock';
import type { TradeFlowFeedPort, TradeFlowSnapshot } from '../../../ports/venue/trade-flow-feed';

// latest() treats a snapshot older than this multiple of the poll interval as stale (absent to the
// caller) — mirrors DerivativesFeedService's STALE_POLL_MULTIPLE.
const STALE_POLL_MULTIPLE = 2;
// X5 (tf2): trailing window (in closed bars) for the per-bar cvdDeltas series + divergence flag —
// capped independently of lookbackBars (which can run to 20+) so the series/divergence read stays a
// short, recent-only window regardless of how deep the rolling CVD total's own lookback is.
const DIVERGENCE_WINDOW_BARS = 8;

/** Minimal ccxt REST surface this service needs — injected so tests supply a fixture double instead
 * of a live exchange (mirrors DerivativesRestSource in derivatives-feed.service.ts). Unlike that
 * source, this one calls the RAW (unparsed) klines endpoint directly — ccxt's unified fetchOHLCV/
 * parseOHLCV drops the venue's taker-buy-base-volume field unconditionally (see trade-flow-feed.ts's
 * header comment), so the only way to read it is the implicit method ccxt generates from the
 * exchange's own API map (`publicGetKlines` for binance spot), which returns the venue's raw
 * (unparsed) array-of-arrays response verbatim. */
export interface TradeFlowRestSource {
  // Raw Binance kline rows, oldest first: [openTime, open, high, low, close, volume, closeTime,
  // quoteVolume, numTrades, takerBuyBaseVolume, takerBuyQuoteVolume, ignore]. Every numeric field
  // arrives as a venue string.
  fetchRawKlines(symbol: string, interval: string, limit: number): Promise<unknown[][]>;
}

// Spot market id (no separator, e.g. 'BTCUSDT') for the raw klines endpoint's `symbol` param —
// distinct from DerivativesFeedService's perpSymbolFor (which returns ccxt's unified perp form for
// its unified fetchFundingRate/fetchOpenInterest calls); the raw implicit method takes the venue's
// own market id, not a ccxt unified symbol.
function spotMarketIdFor(symbol: SymbolId): string {
  const { base, quote } = splitSymbol(symbol);
  return `${base}${quote}`;
}

// Reference-grade coercion for a raw kline field (venue strings/numbers), never a money path.
function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    // eslint-disable-next-line no-restricted-syntax -- Number() coerces a raw kline volume field (reference data), not money.
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export interface TradeFlowFeedOptions {
  readonly symbols: readonly SymbolId[];
  // Binance interval string ('15m', '5m', ...) — matched to the strategy's own candle interval so
  // the rolling CVD lines up with the candles the model already sees.
  readonly interval: string;
  readonly lookbackBars: number;
  readonly pollIntervalMs: number;
  readonly clock: ClockPort;
  readonly logger?: { warn: (msg: string) => void };
}

/**
 * REST-poll service for taker aggressor imbalance / CVD — feature-flagged OFF by default
 * (AGENTIC_TRADEFLOW_ENABLED), consumed by the agentic prompt via TradeFlowFeedPort. Never on the
 * order path — a poll failure logs and continues; latest() answers null while stale/absent so a
 * caller never blocks or delays on this feed (mirrors DerivativesFeedService exactly).
 */
@Injectable()
export class TradeFlowFeedService implements TradeFlowFeedPort, OnModuleInit, OnModuleDestroy {
  private readonly snapshots = new Map<SymbolId, TradeFlowSnapshot>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSuccessAt: EpochMs | null = null;
  private errorCount = 0;

  constructor(
    private readonly source: TradeFlowRestSource,
    private readonly options: TradeFlowFeedOptions,
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

  latest(symbol: SymbolId): TradeFlowSnapshot | null {
    const snap = this.snapshots.get(symbol);
    if (!snap) return null;
    const ageMs = this.options.clock.now() - snap.asOf;
    if (ageMs > this.options.pollIntervalMs * STALE_POLL_MULTIPLE) return null;
    return snap;
  }

  lastSuccessfulPollAt(): EpochMs | null {
    return this.lastSuccessAt;
  }

  pollErrorCount(): number {
    return this.errorCount;
  }

  async pollAll(): Promise<void> {
    await Promise.all(this.options.symbols.map((s) => this.pollOne(s)));
  }

  private async pollOne(symbol: SymbolId): Promise<void> {
    const marketId = spotMarketIdFor(symbol);
    try {
      // +2 over lookbackBars: one buffer row for the venue's still-forming last bar (always dropped
      // below) plus one spare so a poll landing exactly on a bar boundary still nets a full window.
      const raw = await this.source.fetchRawKlines(
        marketId,
        this.options.interval,
        this.options.lookbackBars + 2,
      );
      const snapshot = this.toSnapshot(raw);
      if (snapshot) {
        this.snapshots.set(symbol, snapshot);
        this.lastSuccessAt = snapshot.asOf;
      }
    } catch (err) {
      this.errorCount += 1;
      this.options.logger?.warn(
        `trade-flow-feed poll failed for ${marketId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private toSnapshot(raw: unknown[][]): TradeFlowSnapshot | null {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    // Drop the venue's final row: Binance's klines response includes the still-forming (unclosed)
    // bar as its last element whenever `now` falls inside that bar's window — the request already
    // padded the limit by 2, so dropping one row unconditionally still leaves a full lookback window.
    const closedRows = raw.slice(0, -1).slice(-this.options.lookbackBars);
    if (closedRows.length === 0) return null;

    let cvd = 0;
    let barImbalance = 0;
    let countedBars = 0;
    // X5 (tf2): a SEPARATE pass over the same closedRows below builds this — kept independent of the
    // cvd/barImbalance accumulation above so a row missing `close` (required for divergence's price
    // direction, not for cvd/barImbalance) can never change those two EXISTING fields' values.
    for (const row of closedRows) {
      if (!Array.isArray(row)) continue;
      const totalVol = asFiniteNumber(row[5]);
      const takerBuyVol = asFiniteNumber(row[9]);
      if (totalVol === null || takerBuyVol === null) continue;
      const delta = takerBuyVol - (totalVol - takerBuyVol);
      cvd += delta;
      barImbalance = totalVol > 0 ? delta / totalVol : 0;
      countedBars += 1;
    }
    if (countedBars === 0) return null;

    const { cvdDeltas, divergence } = this.divergenceFrom(closedRows);

    return {
      asOf: epochMs(this.options.clock.now()),
      barImbalance,
      cvd,
      lookbackBars: countedBars,
      cvdDeltas,
      divergence,
    };
  }

  // X5 (tf2): per-bar (close, delta) pairs over the SAME closedRows toSnapshot already has, trimmed
  // to the trailing DIVERGENCE_WINDOW_BARS — a bar contributes only if BOTH close and volume/taker-
  // buy fields parse (a stricter requirement than the cvd/barImbalance loop above, which needs only
  // the volume fields); price direction compares the window's first vs last close, CVD direction sums
  // the window's deltas.
  private divergenceFrom(closedRows: readonly unknown[][]): {
    readonly cvdDeltas: readonly number[];
    readonly divergence: TradeFlowSnapshot['divergence'];
  } {
    const perBar: { readonly close: number; readonly delta: number }[] = [];
    for (const row of closedRows) {
      if (!Array.isArray(row)) continue;
      const close = asFiniteNumber(row[4]);
      const totalVol = asFiniteNumber(row[5]);
      const takerBuyVol = asFiniteNumber(row[9]);
      if (close === null || totalVol === null || takerBuyVol === null) continue;
      perBar.push({ close, delta: takerBuyVol - (totalVol - takerBuyVol) });
    }
    const window = perBar.slice(-DIVERGENCE_WINDOW_BARS);
    const cvdDeltas = window.map((b) => b.delta);
    if (window.length < 2) return { cvdDeltas, divergence: null };

    const priceDelta = window[window.length - 1]!.close - window[0]!.close;
    const cvdDelta = cvdDeltas.reduce((sum, d) => sum + d, 0);
    const divergence =
      priceDelta < 0 && cvdDelta > 0
        ? 'bullish_divergence'
        : priceDelta > 0 && cvdDelta < 0
          ? 'bearish_divergence'
          : null;
    return { cvdDeltas, divergence };
  }
}
