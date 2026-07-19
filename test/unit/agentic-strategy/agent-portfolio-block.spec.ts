import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { buildAgentPortfolioBlock } from '../../../src/features/trading/agentic/agent-portfolio-block';
import { PriceHistoryStore } from '../../../src/features/trading/agentic/price-history-store';
import type { CandleEvent } from '../../../src/domain/types/market-events';
import type { PortfolioSnapshot } from '../../../src/domain/types/portfolio';
import { price, qty } from '../../../src/domain/types/money';
import { venueId, symbolId, epochMs } from '../../../src/domain/types/ids';

const T = 1_700_000_000_000;
const V = venueId('binance');
const BTC = symbolId('BTC/USDT');
const ALT = symbolId('ALT/USDT');

function candle(closeStr: string, index: number, symbol = BTC): CandleEvent {
  const t = T + index * 60_000;
  return {
    kind: 'CANDLE',
    venue: V,
    symbol,
    channel: 'candle:1m',
    seq: BigInt(index + 1),
    eventTime: epochMs(t),
    ingestTime: epochMs(t + 1),
    interval: '1m',
    openTime: epochMs(t),
    closeTime: epochMs(t + 60_000),
    open: price(closeStr),
    high: price(closeStr),
    low: price(closeStr),
    close: price(closeStr),
    volume: qty('1'),
    closed: true,
  };
}

function emptySnapshot(): PortfolioSnapshot {
  return {
    positions: new Map(),
    balances: new Map([['USDT', { free: new Decimal('1000'), locked: new Decimal('0') }]]),
    openOrders: [],
    inFlightIntents: [],
    equity: new Decimal('1000'),
    unrealized: new Decimal('0'),
    startingCash: new Decimal('1000'),
    peakEquity: new Decimal('1000'),
    sodEquityUtc: new Decimal('1000'),
    reconcileStatus: 'CLEAN',
    snapshotSeq: 1n,
  };
}

describe('buildAgentPortfolioBlock — correlation (W3 Part 2)', () => {
  it('omits correlation entirely when no priceHistory store is supplied', () => {
    const block = buildAgentPortfolioBlock(emptySnapshot(), undefined);
    expect(block.correlation).toBeUndefined();
  });

  it('omits correlation when the store has no data yet', () => {
    const store = new PriceHistoryStore();
    const block = buildAgentPortfolioBlock(emptySnapshot(), undefined, store);
    expect(block.correlation).toBeUndefined();
  });

  it('computes an exact btcBeta of 2 and a matching summary string when the basket tracks BTC at 2x', () => {
    const store = new PriceHistoryStore();
    store.recordWindow(BTC, [
      candle('100', 0),
      candle('110', 1), // +0.10
      candle('99', 2), // -0.10 (110 * 0.9)
      candle('118.8', 3), // +0.20 (99 * 1.2)
    ]);
    store.recordWindow(ALT, [
      candle('100', 0, ALT),
      candle('120', 1, ALT), // +0.20 (2x BTC)
      candle('96', 2, ALT), // -0.20 (2x BTC; 120 * 0.8)
      candle('134.4', 3, ALT), // +0.40 (2x BTC; 96 * 1.4)
    ]);

    const block = buildAgentPortfolioBlock(emptySnapshot(), undefined, store);

    expect(block.correlation).toEqual({
      btcBeta: 2,
      summary:
        "basket beta to BTC 2.00 (high correlation) — alt positions move roughly 2.00x BTC's own return",
    });
  });

  it("excludes BTC's own series from the basket side of the comparison", () => {
    // Only BTC has data recorded — with BTC excluded from its own basket, there is no ALT series left
    // to pair against it, so correlation stays omitted (never a trivially-1.0 self-beta).
    const store = new PriceHistoryStore();
    store.recordWindow(BTC, [candle('100', 0), candle('110', 1), candle('99', 2)]);

    const block = buildAgentPortfolioBlock(emptySnapshot(), undefined, store);

    expect(block.correlation).toBeUndefined();
  });

  it('still populates cappedEquity/freeQuote/grossExposure/positions unchanged alongside correlation', () => {
    const store = new PriceHistoryStore();
    store.recordWindow(BTC, [candle('100', 0), candle('110', 1), candle('99', 2)]);
    store.recordWindow(ALT, [candle('100', 0, ALT), candle('110', 1, ALT), candle('99', 2, ALT)]);

    const block = buildAgentPortfolioBlock(emptySnapshot(), '500', store);

    expect(block.cappedEquity).toBe('500'); // equityCap caps the $1000 snapshot equity
    expect(block.freeQuote).toBe('1000');
    expect(block.grossExposure).toBe('0');
    expect(block.positions).toEqual([]);
    expect(block.correlation!.btcBeta).toBe(1);
  });
});
