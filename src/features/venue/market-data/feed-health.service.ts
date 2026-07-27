import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type {
  ChannelHealth,
  CandleEvent,
  CandleInterval,
} from '../../../domain/venue/types/market-events';
import type { VenueId, SymbolId, EpochMs } from '../../../domain/common/types/ids';
import type { Price } from '../../../domain/common/types/money';
import { epochMs } from '../../../domain/common/types/ids';
import type {
  FeedHealthPort,
  MarketChannelAge,
  MarketStreamTelemetryPort,
} from '../../../ports/venue/market-data';
import { CLOCK, type ClockPort } from '../../../ports/common/clock';
import { normalizeRawEvent } from './normalize';
import type { ExchangeStreamPort } from '../../../ports/venue/exchange-stream';
import { EXCHANGE_STREAM } from '../../../ports/venue/exchange-stream';
import type { VenueConfig } from '../../../ports/common/app-config';

// How far ahead of our own clock a venue's event timestamp may sit before updateRefPrice refuses it.
// Generous enough to absorb ordinary NTP skew and venue clock drift (a legitimately-stamped frame is
// never rejected in practice), tight enough that a microsecond-scale or grossly skewed stamp cannot
// pin the ref price — see updateRefPrice's own comment for why pinning is the dangerous part.
const REF_PRICE_SKEW_TOLERANCE_MS = 5_000;

interface ChannelState {
  health: ChannelHealth;
  lastEventAt: EpochMs;
  // Identity parts kept alongside the state: the composite map key cannot be split back apart
  // (symbols and channels both legitimately contain ':', e.g. "BTC/USDT:USDT" / "candle:15m"),
  // and channelAges() must report per-channel identities to the metrics exporter.
  venue: VenueId;
  symbol: SymbolId;
  channel: string;
}

interface RefPrice {
  mid: Price;
  at: EpochMs;
}

@Injectable()
export class FeedHealthService implements FeedHealthPort, MarketStreamTelemetryPort {
  private readonly channelStates = new Map<string, ChannelState>();
  private readonly refPrices = new Map<string, RefPrice>();
  private forcedReconnects = 0;

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
      venue,
      symbol,
      channel,
    });
  }

  recordEvent(venue: VenueId, symbol: SymbolId, channel: string): void {
    const key = this.channelKey(venue, symbol, channel);
    // A fresh event always restores LIVE and re-anchors the staleness clock.
    // Ref-price updates are driven separately by updateRefPrice (which carries the
    // mid), since recordEvent only knows the channel, not the quote.
    this.channelStates.set(key, {
      health: 'LIVE',
      lastEventAt: this.clock.now(),
      venue,
      symbol,
      channel,
    });
  }

  recordForcedReconnect(): void {
    this.forcedReconnects += 1;
  }

  // XA6: a tier-parked channel (ccxt-stream.adapter.ts ChannelTierResolver) deregisters entirely —
  // channelAges()/staleness gauges must not carry a deliberately-off channel as an ever-aging
  // DEGRADED entry. health() then answers 'GAP' for it (the unknown-channel default) —
  // RiskEngineService reads that alongside the ticker channel's health and takes the best of the
  // two (the old book-only entry gate was repealed 2026-07-22, see risk-engine.service.ts's own
  // header comment), so a parked book alone no longer vetoes entry: ticker stays subscribed
  // regardless of tier and keeps the mark's feedHealth LIVE.
  clearChannel(venue: VenueId, symbol: SymbolId, channel: string): void {
    this.channelStates.delete(this.channelKey(venue, symbol, channel));
  }

  forcedReconnectCount(): number {
    return this.forcedReconnects;
  }

  channelAges(): readonly MarketChannelAge[] {
    const now = this.clock.now();
    return [...this.channelStates.values()].map((s) => ({
      venue: s.venue,
      symbol: s.symbol,
      channel: s.channel,
      ageSeconds: Math.max(0, (now - s.lastEventAt) / 1000),
      health: s.health,
    }));
  }

  // Refuses a far-FUTURE stamp at the source (fix 2026-07-22, security review MF1). The monotonic
  // `at >= existing.at` rule below is what makes a bogus stamp so damaging: one frame timestamped an
  // hour ahead (a venue emitting microseconds, or clock skew — both pass the adapter's bare
  // `typeof === 'number'` check and are stored verbatim by normalize.ts) would PIN the ref price,
  // because every subsequent correct frame is then discarded as older. RiskEngine would keep pricing
  // orders off that frozen mid for as long as the stamp leads the clock. The RiskEngine now also
  // rejects a negative age (evaluate.ts's two-sided bound) — this is the second half of that fix,
  // stopping the poison from being stored at all rather than only from being traded on.
  updateRefPrice(symbol: SymbolId, mid: Price, at: EpochMs): void {
    if (at > this.clock.now() + REF_PRICE_SKEW_TOLERANCE_MS) return; // fail closed: drop, never pin
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
