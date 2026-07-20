import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { SymbolId, EpochMs } from '../../../domain/types/ids';
import { epochMs } from '../../../domain/types/ids';
import { splitSymbol } from '../../../domain/types/symbol';
import type { ClockPort } from '../../../ports/clock';
import type { PositioningFeedPort, PositioningSnapshot } from '../../../ports/positioning-feed';

const STALE_POLL_MULTIPLE = 2;

/** Minimal ccxt REST surface this service needs — injected so tests supply a fixture double instead
 * of a live exchange (mirrors DerivativesRestSource in derivatives-feed.service.ts). Calls the RAW
 * (unparsed) `fapiDataGetGlobalLongShortAccountRatio` implicit method directly rather than ccxt's
 * unified `fetchLongShortRatioHistory` wrapper: the unified wrapper's `parseLongShortRatio` keeps
 * only `longShortRatio` in its returned structure (verified: node_modules/ccxt/js/src/binance.js's
 * parseLongShortRatio drops longAccount/shortAccount from the parsed object, leaving them reachable
 * only via the row's raw `.info`) — the raw call sidesteps that reach-through, same "read the field
 * ccxt would otherwise not surface directly" pattern as TradeFlowRestSource. No API key required
 * (a public data endpoint). */
export interface PositioningRestSource {
  fetchRawLongShortRatio(
    symbol: string,
    period: string,
    limit: number,
  ): Promise<
    Array<{
      readonly longAccount?: string | number;
      readonly shortAccount?: string | number;
      readonly longShortRatio?: string | number;
      readonly timestamp?: number;
    }>
  >;
  // X3b: raw (unparsed) `fapiDataGetTakerlongshortRatio` implicit method (verified present in
  // node_modules/ccxt/js/src/binance.js's fapiData.get map, 2026-07-20) — futures taker buy/sell
  // volume, a SECOND endpoint on the SAME poller as fetchRawLongShortRatio above (no second poll
  // loop). ccxt has no unified wrapper for this endpoint, so — same rationale as
  // fetchRawLongShortRatio's own header comment — the raw implicit method is the only route to it.
  fetchRawTakerLongShortRatio(
    symbol: string,
    period: string,
    limit: number,
  ): Promise<
    Array<{
      readonly buySellRatio?: string | number;
      readonly buyVol?: string | number;
      readonly sellVol?: string | number;
      readonly timestamp?: number;
    }>
  >;
}

// BASE/QUOTE (spot) -> BASEQUOTE (the venue's own USDT-margined perp market id, e.g. 'BTCUSDT') —
// the raw implicit method takes the venue's own market id, not a ccxt unified symbol (distinct from
// DerivativesFeedService's perpSymbolFor, which returns ccxt's unified perp form for its unified
// fetchFundingRate/fetchOpenInterest calls).
function futuresMarketIdFor(symbol: SymbolId): string {
  const { base, quote } = splitSymbol(symbol);
  return `${base}${quote}`;
}

function asFiniteNumber(v: string | number | undefined): number | null {
  if (v === undefined) return null;
  // eslint-disable-next-line no-restricted-syntax -- Number() coerces display-grade reference data, not money.
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface PositioningFeedOptions {
  readonly symbols: readonly SymbolId[];
  // Binance long/short-ratio period ('5m', '15m', ...). Independent of the strategy's own candle
  // interval: this is a market-wide aggregate, not a per-bar series.
  readonly ratioPeriod: string;
  readonly pollIntervalMs: number;
  readonly clock: ClockPort;
  readonly logger?: { warn: (msg: string) => void };
}

/**
 * REST-poll service for market-wide futures positioning (global long/short account ratio) —
 * feature-flagged OFF by default (AGENTIC_POSITIONING_ENABLED), consumed by the agentic prompt via
 * PositioningFeedPort. Liquidation-order flow is NOT shipped here — see positioning-feed.ts's header
 * comment for why (no public REST source in ccxt 4.5.58; would require a WS subscription). Never on
 * the order path — a poll failure logs and continues; latest() answers null while stale/absent
 * (mirrors DerivativesFeedService exactly).
 */
@Injectable()
export class PositioningFeedService implements PositioningFeedPort, OnModuleInit, OnModuleDestroy {
  private readonly snapshots = new Map<SymbolId, PositioningSnapshot>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSuccessAt: EpochMs | null = null;
  private errorCount = 0;

  constructor(
    private readonly source: PositioningRestSource,
    private readonly options: PositioningFeedOptions,
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

  latest(symbol: SymbolId): PositioningSnapshot | null {
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
    const marketId = futuresMarketIdFor(symbol);
    try {
      // X3b: ONE poller, two endpoints (same Promise.all convention as DerivativesFeedService's
      // funding/OI/ticker triple) — a taker-ratio fetch failure fails the whole poll below, same as
      // fetchRawLongShortRatio always has, rather than caching a partial snapshot.
      const [rows, takerRows] = await Promise.all([
        this.source.fetchRawLongShortRatio(marketId, this.options.ratioPeriod, 1),
        this.source.fetchRawTakerLongShortRatio(marketId, this.options.ratioPeriod, 1),
      ]);
      const snapshot = this.toSnapshot(rows, takerRows);
      if (snapshot) {
        this.snapshots.set(symbol, snapshot);
        this.lastSuccessAt = snapshot.asOf;
      }
    } catch (err) {
      this.errorCount += 1;
      this.options.logger?.warn(
        `positioning-feed poll failed for ${marketId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private toSnapshot(
    rows: Awaited<ReturnType<PositioningRestSource['fetchRawLongShortRatio']>>,
    takerRows: Awaited<ReturnType<PositioningRestSource['fetchRawTakerLongShortRatio']>>,
  ): PositioningSnapshot | null {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const latestRow = rows[rows.length - 1];
    const longShortRatio = asFiniteNumber(latestRow?.longShortRatio);
    // longShortRatio is the one field this snapshot cannot render without — no partial/garbage
    // snapshot (mirrors DerivativesFeedService requiring fundingRate).
    if (longShortRatio === null) return null;
    const longAccount = asFiniteNumber(latestRow?.longAccount) ?? 0;
    const shortAccount = asFiniteNumber(latestRow?.shortAccount) ?? 0;

    // X3b: taker buy/sell volume is a SEPARATE endpoint — its own absence/parse-failure degrades only
    // the taker fields to null rather than discarding the whole (still-valid) account-ratio snapshot.
    const latestTakerRow = Array.isArray(takerRows) ? takerRows[takerRows.length - 1] : undefined;
    const takerBuySellRatio = asFiniteNumber(latestTakerRow?.buySellRatio);
    const takerBuyVol = asFiniteNumber(latestTakerRow?.buyVol);
    const takerSellVol = asFiniteNumber(latestTakerRow?.sellVol);

    return {
      asOf: epochMs(this.options.clock.now()),
      longShortRatio,
      longAccountPct: longAccount * 100,
      shortAccountPct: shortAccount * 100,
      takerBuySellRatio,
      takerBuyVol,
      takerSellVol,
    };
  }
}
