import Decimal from 'decimal.js';
import type { EpochMs, SymbolId } from '../../../domain/types/ids';
import type { CandleEvent, MarketEvent, OrderLevel } from '../../../domain/types/market-events';
import { price } from '../../../domain/types/money';
import type { MarketStreamPort, SubscriptionSpec } from '../../../ports/market-data';

// Populated by the teeing stream on every ticker/book so the RiskEngine's mark is fresh — the
// RiskEngine rejects STALE_DATA without it. FeedHealthService implements this.
export interface RefPriceSink {
  updateRefPrice(
    symbol: SymbolId,
    mid: import('../../../domain/types/money').Price,
    at: EpochMs,
  ): void;
}

// Paper-only fill simulation feed. In demo/live the venue fills orders, so this is absent and the
// tee only updates ref price. Structurally satisfied by PaperExchangeAdapter (paper fallback).
export interface PaperFeedSink {
  ingestBook(symbol: SymbolId, bids: readonly OrderLevel[], asks: readonly OrderLevel[]): void;
  ingestTrade(symbol: SymbolId, print: { price: Decimal; qty: Decimal }): Promise<void>;
}

// Decorates the normalized MARKET_STREAM the StrategyHost consumes. Two composition concerns the
// strategy must not own live here: (1) it augments the strategy's subscription with the ticker/book
// channels the *risk mark* and *paper sim* need (the strategy declares only the channels it reads);
// (2) for each event it updates the shared FeedHealth ref price (so Risk has a fresh mark and the
// 'book' channel reports LIVE) and, in paper mode only, feeds the sim adapter — BEFORE yielding the
// event onward, so the host acts on a candle only after the mark for that instant is current.
export class TeeingMarketStream implements MarketStreamPort {
  constructor(
    private readonly inner: MarketStreamPort,
    private readonly feedHealth: RefPriceSink,
    private readonly augment: SubscriptionSpec['channels'],
    private readonly paperFeed?: PaperFeedSink,
  ) {}

  async *subscribe(spec: SubscriptionSpec): AsyncIterable<MarketEvent> {
    const merged: SubscriptionSpec = { ...spec, channels: { ...spec.channels, ...this.augment } };
    // ccxt watchOHLCV streams the still-FORMING candle and its arrays carry no closed flag, so every
    // live CandleEvent arrives closed:false — which a closed-only strategy (EMA cross) discards. We
    // detect the close by the openTime rolling over: when a new candle period starts, the previously
    // tracked one has closed, so we emit a synthetic closed copy of it before the new forming candle.
    const lastForming = new Map<SymbolId, CandleEvent>();
    for await (const ev of this.inner.subscribe(merged)) {
      await this.observe(ev);
      if (ev.kind === 'CANDLE' && !ev.closed) {
        const prev = lastForming.get(ev.symbol);
        if (prev !== undefined && ev.openTime > prev.openTime) {
          yield { ...prev, closed: true };
        }
        lastForming.set(ev.symbol, ev);
      }
      yield ev;
    }
  }

  private async observe(ev: MarketEvent): Promise<void> {
    switch (ev.kind) {
      case 'TICKER':
        this.setRef(ev.symbol, ev.bid, ev.ask, ev.eventTime);
        break;
      case 'ORDER_BOOK_SNAPSHOT': {
        const bestBid = ev.bids[0]?.price;
        const bestAsk = ev.asks[0]?.price;
        if (bestBid !== undefined && bestAsk !== undefined)
          this.setRef(ev.symbol, bestBid, bestAsk, ev.eventTime);
        this.paperFeed?.ingestBook(ev.symbol, ev.bids, ev.asks);
        break;
      }
      case 'TRADE':
        await this.paperFeed?.ingestTrade(ev.symbol, { price: ev.price, qty: ev.qty });
        break;
      case 'CANDLE':
        break;
    }
  }

  private setRef(symbol: SymbolId, bid: Decimal, ask: Decimal, at: EpochMs): void {
    try {
      // mid of two valid prices terminates (÷2) ⇒ bounded decimals; guard anyway so one odd quote
      // never kills the feed loop. FeedHealthPort requires updateRefPrice — the 2026-07-23
      // STALE_DATA hole (facade omitted the method; empty catch swallowed TypeError) is closed at
      // compile time. Do NOT rethrow TypeError here: StrategyHost.consumeEvents is void-fired with
      // no catch, so a mid-calc TypeError would permanently kill market-event consumption without
      // HALT (adversarial review 2026-07-24).
      this.feedHealth.updateRefPrice(symbol, price(bid.add(ask).div(2)), at);
    } catch {
      // malformed mid / sink throw — continue the feed loop
    }
  }
}
