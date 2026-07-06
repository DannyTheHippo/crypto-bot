import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type {
  ChannelHealth,
  CandleEvent,
  CandleInterval,
} from '../../../domain/types/market-events';
import type { VenueId, SymbolId, EpochMs } from '../../../domain/types/ids';
import type { Price } from '../../../domain/types/money';
import { epochMs } from '../../../domain/types/ids';
import type { FeedHealthPort } from '../../../ports/market-data';
import { CLOCK, type ClockPort } from '../../../ports/clock';
import { normalizeRawEvent } from './normalize';
import type { ExchangeStreamPort } from '../../../ports/exchange-stream';
import { EXCHANGE_STREAM } from '../../../ports/exchange-stream';
import type { VenueConfig } from '../../../ports/app-config';

interface ChannelState {
  health: ChannelHealth;
  lastEventAt: EpochMs;
}

interface RefPrice {
  mid: Price;
  at: EpochMs;
}

@Injectable()
export class FeedHealthService implements FeedHealthPort {
  private readonly channelStates = new Map<string, ChannelState>();
  private readonly refPrices = new Map<string, RefPrice>();

  constructor(
    // protected: FeedHealthServiceWithBackfill reads the clock for ingestTime stamping.
    @Inject(CLOCK) protected readonly clock: ClockPort,
    @Inject(EXCHANGE_STREAM) private readonly exchangeStream: ExchangeStreamPort,
  ) {}

  private channelKey(venue: VenueId, symbol: SymbolId, channel: string): string {
    return `${venue}:${symbol}:${channel}`;
  }

  health(venue: VenueId, symbol: SymbolId, channel: string): ChannelHealth {
    const key = this.channelKey(venue, symbol, channel);
    return this.channelStates.get(key)?.health ?? 'GAP';
  }

  setHealth(venue: VenueId, symbol: SymbolId, channel: string, status: ChannelHealth): void {
    const key = this.channelKey(venue, symbol, channel);
    const existing = this.channelStates.get(key);
    this.channelStates.set(key, {
      health: status,
      lastEventAt: existing?.lastEventAt ?? this.clock.now(),
    });
  }

  recordEvent(venue: VenueId, symbol: SymbolId, channel: string): void {
    const key = this.channelKey(venue, symbol, channel);
    // A fresh event always restores LIVE and re-anchors the staleness clock.
    // Ref-price updates are driven separately by updateRefPrice (which carries the
    // mid), since recordEvent only knows the channel, not the quote.
    this.channelStates.set(key, { health: 'LIVE', lastEventAt: this.clock.now() });
  }

  updateRefPrice(symbol: SymbolId, mid: Price, at: EpochMs): void {
    const existing = this.refPrices.get(symbol);
    if (!existing || at >= existing.at) {
      this.refPrices.set(symbol, { mid, at });
    }
  }

  getRefPrice(symbol: SymbolId): { mid: Price; at: EpochMs } | undefined {
    return this.refPrices.get(symbol);
  }

  checkStaleness(
    venue: VenueId,
    symbol: SymbolId,
    channel: string,
    staleThresholdMs: number,
  ): void {
    const key = this.channelKey(venue, symbol, channel);
    const state = this.channelStates.get(key);
    if (!state) return;
    const now = this.clock.now();
    if (now - state.lastEventAt > staleThresholdMs && state.health === 'LIVE') {
      this.channelStates.set(key, { ...state, health: 'DEGRADED' });
    }
  }

  // Base implementation has no exchange handle, so it cannot backfill. Warmup
  // wiring uses FeedHealthServiceWithBackfill (constructed per-venue with the
  // ccxt exchange after mode setup); the plain service answers with no candles.
  fetchCandles(
    venue: VenueId,
    symbol: SymbolId,
    interval: CandleInterval,
    n: number,
  ): Promise<readonly CandleEvent[]> {
    void venue;
    void symbol;
    void interval;
    void n;
    void this.exchangeStream;
    return Promise.resolve([]);
  }
}

/** Minimal ccxt REST surface needed for OHLCV warmup backfill. */
export interface OhlcvSource {
  fetchOHLCV(
    symbol: string,
    timeframe: string,
    since?: number,
    limit?: number,
  ): Promise<unknown[][]>;
}

/**
 * Extended FeedHealthService that receives a raw ccxt exchange for REST backfill.
 * The adapter constructs this with the actual exchange instance after mode setup.
 */
@Injectable()
export class FeedHealthServiceWithBackfill extends FeedHealthService {
  constructor(
    @Inject(CLOCK) clock: ClockPort,
    @Inject(EXCHANGE_STREAM) exchangeStream: ExchangeStreamPort,
    private readonly rawExchange: OhlcvSource,
    private readonly venueConfig: VenueConfig,
  ) {
    super(clock, exchangeStream);
  }

  override async fetchCandles(
    venue: VenueId,
    symbol: SymbolId,
    interval: CandleInterval,
    n: number,
  ): Promise<readonly CandleEvent[]> {
    void venue;
    const ingestTime = this.clock.now();
    const ohlcv = await this.rawExchange.fetchOHLCV(symbol, interval, undefined, n);
    const results: CandleEvent[] = [];
    for (const bar of ohlcv) {
      const raw = {
        type: 'candle' as const,
        venue: this.venueConfig.id as VenueId,
        symbol,
        timestamp: typeof bar[0] === 'number' ? epochMs(bar[0]) : undefined,
        raw: bar,
      };
      const ev = normalizeRawEvent(raw, ingestTime, interval);
      // Backfill is HISTORICAL data: every bar is a closed candle. ccxt OHLCV arrays carry no
      // closed flag (6 elements), so normalizeCandle would default closed:false — which a
      // closed-only strategy (EMA cross) discards, leaving warmup inert. Mark them closed here so
      // warmup actually primes indicator state. (The most recent bar may be the still-forming
      // candle; the live feed re-emits its close, a negligible one-candle overlap washed out by the
      // bounded indicator window — warmup signals are discarded regardless.)
      if (ev.kind === 'CANDLE') results.push({ ...ev, closed: true });
    }
    return results;
  }
}
