import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { buildAgentPortfolioBlock } from '../../../src/features/trading/agentic/agent-portfolio-block';
import { PriceHistoryStore } from '../../../src/features/trading/agentic/price-history-store';
import type { CandleEvent } from '../../../src/domain/types/market-events';
import type { PortfolioSnapshot, Position } from '../../../src/domain/types/portfolio';
import type { OrderIntent } from '../../../src/domain/types/order-intent';
import { price, qty } from '../../../src/domain/types/money';
import {
  venueId,
  symbolId,
  strategyId,
  epochMs,
  clientOrderId,
  intentId,
} from '../../../src/domain/types/ids';

const T = 1_700_000_000_000;
const V = venueId('binance');
const PERP_V = venueId('binanceusdm');
const BTC = symbolId('BTC/USDT');
const ALT = symbolId('ALT/USDT');
const SID = strategyId('agentic-1');

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

// One counter drives distinct clientOrderIds across in-flight-intent fixtures in this describe block.
let reservedSeq = 0;
function reservedIntent(o: Partial<OrderIntent> = {}): OrderIntent {
  reservedSeq += 1;
  return {
    intentId: intentId(
      `01900000-0000-7000-8000-00000000${reservedSeq.toString(16).padStart(4, '0')}`,
    ),
    clientOrderId: clientOrderId(`reserved-${reservedSeq}`),
    strategyId: SID,
    venue: V,
    symbol: BTC,
    side: 'BUY',
    type: 'LIMIT',
    qty: qty('1'),
    limitPrice: price('100'),
    timeInForce: 'GTC',
    reduceOnly: false,
    mode: 'paper',
    refPrice: price('100'),
    refSeq: 1n,
    createdAt: epochMs(T),
    expiresAt: epochMs(T + 5000),
    source: { dedupeKey: 'reserved', eventTime: epochMs(T), basedOnSeq: 1n, strength: 1 },
    ...o,
  };
}

function position(o: Partial<Position> = {}): Position {
  return {
    strategyId: SID,
    venue: V,
    symbol: BTC,
    signedQty: new Decimal('1'),
    avgEntry: price('100'),
    realizedPnl: new Decimal('0'),
    ...o,
  };
}

describe('buildAgentPortfolioBlock — perVenue (v3 §6.4)', () => {
  it('omits perVenue entirely when no venueCapitalShare is supplied (fail open, byte-identical to pre-v3)', () => {
    const block = buildAgentPortfolioBlock(emptySnapshot(), undefined);
    expect(block.perVenue).toBeUndefined();
  });

  it('omits perVenue entirely when venueCapitalShare is supplied but the snapshot carries no venueBalances yet (fail open — never a misleadingly-zeroed freeCash)', () => {
    const block = buildAgentPortfolioBlock(emptySnapshot(), undefined, undefined, {
      binance: '500',
      binanceusdm: '500',
    });
    expect(block.perVenue).toBeUndefined();
  });

  it('renders one entry per configured venue with freeCash/capitalShare/headroom, once both venueCapitalShare and snapshot.venueBalances are present', () => {
    const snapshot: PortfolioSnapshot = {
      ...emptySnapshot(),
      venueBalances: new Map([
        [V, new Map([['USDT', { free: new Decimal('212.41'), locked: new Decimal('0') }]])],
        [PERP_V, new Map([['USDT', { free: new Decimal('480'), locked: new Decimal('0') }]])],
      ]),
    };

    const block = buildAgentPortfolioBlock(snapshot, undefined, undefined, {
      binance: '500',
      binanceusdm: '500',
    });

    expect(block.perVenue).toEqual([
      { venue: 'binance', freeCash: '212.41', capitalShare: '500', headroom: '500' },
      { venue: 'binanceusdm', freeCash: '480', capitalShare: '500', headroom: '500' },
    ]);
  });

  it('headroom subtracts venue-wide open-position notional and reduce-only-exempt in-flight reservations (mirrors position-sizer.service.ts venueOpenNotional/venueReservedNotional)', () => {
    const snapshot: PortfolioSnapshot = {
      ...emptySnapshot(),
      positions: new Map([
        ['BTC/USDT', position({ signedQty: new Decimal('1'), avgEntry: price('100') })],
      ]),
      inFlightIntents: [reservedIntent({ qty: qty('0.5'), limitPrice: price('100') })],
      venueBalances: new Map([
        [V, new Map([['USDT', { free: new Decimal('300'), locked: new Decimal('0') }]])],
      ]),
    };

    const block = buildAgentPortfolioBlock(snapshot, undefined, undefined, { binance: '500' });

    // headroom = 500 (cap) − 100 (|1| × 100 open notional) − 50 (0.5 × 100 reserved) = 350.
    expect(block.perVenue).toEqual([
      { venue: 'binance', freeCash: '300', capitalShare: '500', headroom: '350' },
    ]);
  });

  it('headroom can render negative (over-reserved) — spec §6.4 split-boundary coverage, never clamped to 0', () => {
    const snapshot: PortfolioSnapshot = {
      ...emptySnapshot(),
      positions: new Map([
        ['BTC/USDT', position({ signedQty: new Decimal('5'), avgEntry: price('100') })],
      ]),
      venueBalances: new Map([
        [V, new Map([['USDT', { free: new Decimal('0'), locked: new Decimal('0') }]])],
      ]),
    };

    const block = buildAgentPortfolioBlock(snapshot, undefined, undefined, { binance: '100' });

    // headroom = 100 (cap) − 500 (|5| × 100 open notional) = −400.
    expect(block.perVenue).toEqual([
      { venue: 'binance', freeCash: '0', capitalShare: '100', headroom: '-400' },
    ]);
  });
});
