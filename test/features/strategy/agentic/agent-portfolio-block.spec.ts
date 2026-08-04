import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { buildAgentPortfolioBlock } from '../../../../src/features/strategy/agentic/agent-portfolio-block';
import { PriceHistoryStore } from '../../../../src/features/strategy/agentic/price-history-store';
import type { CandleEvent } from '../../../../src/domain/venue/types/market-events';
import type { PortfolioSnapshot, Position } from '../../../../src/domain/trading/types/portfolio';
import type { OrderIntent } from '../../../../src/domain/trading/types/order-intent';
import { price, qty } from '../../../../src/domain/common/types/money';
import {
  venueId,
  symbolId,
  strategyId,
  epochMs,
  clientOrderId,
  intentId,
} from '../../../../src/domain/common/types/ids';

const T = 1_700_000_000_000;
const V = venueId('binance');
const PERP_V = venueId('binanceusdm');
const BTC = symbolId('BTC/USDT');
const ETH = symbolId('ETH/USDT');
const SHIB = symbolId('SHIB/USDT');
// ALT/USDT deliberately has NO DEFAULT_FILTERS row — the dust filter's fail-open case.
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

  it('excludes BOTH the spot and perp listings of BTC from the basket side of the comparison', () => {
    const BTC_PERP = symbolId('BTC/USDT:USDT');
    const store = new PriceHistoryStore();
    store.recordWindow(BTC, [
      candle('100', 0),
      candle('110', 1), // +0.10
      candle('99', 2), // -0.10
      candle('118.8', 3), // +0.20
    ]);
    // BTC's perp listing tracks BTC's OWN spot price path exactly — the worst-case leak: if this
    // listing survives the exclusion, the basket ends up partly self-correlated with BTC.
    store.recordWindow(BTC_PERP, [
      candle('100', 0, BTC_PERP),
      candle('110', 1, BTC_PERP),
      candle('99', 2, BTC_PERP),
      candle('118.8', 3, BTC_PERP),
    ]);
    store.recordWindow(ALT, [
      candle('100', 0, ALT),
      candle('120', 1, ALT), // +0.20 (2x BTC)
      candle('96', 2, ALT), // -0.20 (2x BTC)
      candle('134.4', 3, ALT), // +0.40 (2x BTC)
    ]);

    const block = buildAgentPortfolioBlock(emptySnapshot(), undefined, store);

    // True beta of the basket excluding both BTC listings is 2 (ALT alone, tracking BTC at 2x — same
    // fixture as the "exact btcBeta of 2" test above). An exclusion that only matches the literal
    // spot string 'BTC/USDT' leaves the perp listing in the basket, averaging it with ALT
    // (mean(1x, 2x) = 1.5x) — silently pulling the reported beta toward BTC's own self-correlation of 1.
    expect(block.correlation!.btcBeta).toBe(2);
  });

  it("omits correlation (never a silently self-correlated beta of 1) when BOTH of BTC's listings are the store's only symbols", () => {
    const BTC_PERP = symbolId('BTC/USDT:USDT');
    const store = new PriceHistoryStore();
    store.recordWindow(BTC, [candle('100', 0), candle('110', 1), candle('99', 2)]);
    store.recordWindow(BTC_PERP, [
      candle('100', 0, BTC_PERP),
      candle('110', 1, BTC_PERP),
      candle('99', 2, BTC_PERP),
    ]);

    const block = buildAgentPortfolioBlock(emptySnapshot(), undefined, store);

    // An exclusion that only matches the spot string leaves the perp listing as the sole basket
    // member, tracking BTC's own series exactly — cov/var of a series against itself is 1, so a
    // defect here would render a textbook-perfect but meaningless btcBeta of 1 instead of omitting
    // the block (mirrors the single-listing "excludes BTC's own series" test above).
    expect(block.correlation).toBeUndefined();
  });

  it('contributes a dual-listed NON-BTC asset exactly once to the basket, not once per listing', () => {
    const ETH_PERP = symbolId('ETH/USDT:USDT');
    const store = new PriceHistoryStore();
    store.recordWindow(BTC, [
      candle('100', 0),
      candle('110', 1), // +0.10
      candle('99', 2), // -0.10
      candle('118.8', 3), // +0.20
    ]);
    // ETH tracks BTC at 2x, on BOTH its spot and perp listings (identical price path on each).
    store.recordWindow(ETH, [
      candle('100', 0, ETH),
      candle('120', 1, ETH),
      candle('96', 2, ETH),
      candle('134.4', 3, ETH),
    ]);
    store.recordWindow(ETH_PERP, [
      candle('100', 0, ETH_PERP),
      candle('120', 1, ETH_PERP),
      candle('96', 2, ETH_PERP),
      candle('134.4', 3, ETH_PERP),
    ]);
    // ALT is flat (0 return every bar), so it pulls a correctly-deduped 2-member basket to exactly
    // 1x BTC (mean(2x, 0x) = 1x).
    store.recordWindow(ALT, [
      candle('100', 0, ALT),
      candle('100', 1, ALT),
      candle('100', 2, ALT),
      candle('100', 3, ALT),
    ]);

    const block = buildAgentPortfolioBlock(emptySnapshot(), undefined, store);

    // Deduped basket = mean(ETH's 2x return, ALT's 0x return) = 1x BTC ⇒ beta 1. Counting ETH once
    // per listing instead skews the mean to mean(2x, 2x, 0x) = 4/3x ⇒ beta 1.3333 — a silent
    // over-weighting of whichever asset happens to be dual-listed on this venue pair.
    expect(block.correlation!.btcBeta).toBe(1);
  });

  it('computes beta unchanged over a basket of multiple single-listing (non-duplicated) symbols — regression guard for the routing change', () => {
    const store = new PriceHistoryStore();
    store.recordWindow(BTC, [
      candle('100', 0),
      candle('110', 1), // +0.10
      candle('99', 2), // -0.10
      candle('118.8', 3), // +0.20
    ]);
    store.recordWindow(ALT, [
      candle('100', 0, ALT),
      candle('120', 1, ALT), // +0.20 (2x BTC)
      candle('96', 2, ALT), // -0.20 (2x BTC)
      candle('134.4', 3, ALT), // +0.40 (2x BTC)
    ]);
    store.recordWindow(SHIB, [
      candle('100', 0, SHIB),
      candle('110', 1, SHIB), // +0.10 (1x BTC)
      candle('99', 2, SHIB), // -0.10 (1x BTC)
      candle('118.8', 3, SHIB), // +0.20 (1x BTC)
    ]);

    const block = buildAgentPortfolioBlock(emptySnapshot(), undefined, store);

    // mean(ALT's 2x BTC return, SHIB's 1x BTC return) = 1.5x every bar ⇒ beta 1.5 — unchanged by
    // routing basket population through distinctBaseAssetRepresentatives, since none of these three
    // symbols share a base asset (dedup is a no-op here).
    expect(block.correlation!.btcBeta).toBe(1.5);
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

// Every expectation below is an EXACT string (toBeCloseTo is banned on money): the trim is display-only
// but its output is still a money string, so it gets money-string assertions.
describe('buildAgentPortfolioBlock — display-only precision trim', () => {
  // 0.123456789012345 × 1000.0000001 = 123.4567890246906789 — the "notional is a Decimal multiply of
  // two full-precision values" case that put the longest tails in the payload.
  function messySnapshot(): PortfolioSnapshot {
    return {
      ...emptySnapshot(),
      equity: new Decimal('1000.000000000049'),
      balances: new Map([
        ['USDT', { free: new Decimal('212.4100000000000001'), locked: new Decimal('0') }],
      ]),
      positions: new Map([
        [
          'BTC/USDT',
          position({
            signedQty: new Decimal('0.123456789012345'),
            avgEntry: price('1000.0000001'),
          }),
        ],
      ]),
    };
  }

  it('renders quote amounts at cents and quantities at significant digits', () => {
    const block = buildAgentPortfolioBlock(messySnapshot(), undefined);

    expect(block.cappedEquity).toBe('1000');
    expect(block.freeQuote).toBe('212.41');
    expect(block.grossExposure).toBe('123.46');
    expect(block.positions).toEqual([
      { symbol: 'BTC/USDT', side: 'LONG', qty: '0.123457', notional: '123.46' },
    ]);
  });

  it('trims the equity cap itself, not just the uncapped equity', () => {
    const block = buildAgentPortfolioBlock(messySnapshot(), '499.999999999');

    expect(block.cappedEquity).toBe('500');
  });

  it('keeps significant digits meaningful across quantity scales (a fixed decimal count could not)', () => {
    const snapshot: PortfolioSnapshot = {
      ...emptySnapshot(),
      positions: new Map([
        [
          'SHIB/USDT',
          position({
            symbol: SHIB,
            signedQty: new Decimal('-12345678.912345'),
            avgEntry: price('0.00001'),
          }),
        ],
        [
          'BTC/USDT',
          position({ signedQty: new Decimal('0.000123456789'), avgEntry: price('100000') }),
        ],
      ]),
    };

    const block = buildAgentPortfolioBlock(snapshot, undefined);

    expect(block.positions).toEqual([
      // 12345678.912345 × 0.00001 = 123.45678912345.
      { symbol: 'SHIB/USDT', side: 'SHORT', qty: '12345700', notional: '123.46' },
      // 0.000123456789 × 100000 = 12.3456789.
      { symbol: 'BTC/USDT', side: 'LONG', qty: '0.000123457', notional: '12.35' },
    ]);
  });

  it('renders no full-precision decimal tail anywhere in the block', () => {
    const snapshot: PortfolioSnapshot = {
      ...messySnapshot(),
      inFlightIntents: [reservedIntent({ qty: qty('0.333333333333'), limitPrice: price('3.3') })],
      venueBalances: new Map([
        [
          V,
          new Map([
            ['USDT', { free: new Decimal('212.4100000000000001'), locked: new Decimal('0') }],
          ]),
        ],
      ]),
    };

    // No priceHistory ⇒ correlation omitted, so this regex sees money strings only. btcBeta is a
    // port-typed native `number` statistic (AgentPortfolioBlock.correlation), not a money string —
    // out of this helper's remit by design.
    const block = buildAgentPortfolioBlock(snapshot, '499.999999999', undefined, {
      binance: '500',
    });

    // headroom = 500 − 123.4567890246906789 (open) − 1.0999999999989 (reserved) = 375.4432109753104211.
    expect(block.perVenue).toEqual([
      { venue: 'binance', freeCash: '212.41', capitalShare: '500', headroom: '375.44' },
    ]);
    expect(JSON.stringify(block)).not.toMatch(/\.\d{10}/);
  });
});

describe('buildAgentPortfolioBlock — sub-minNotional dust positions', () => {
  // ETH/USDT minNotional is 5 (DEFAULT_FILTERS): 0.0001 × 49999 = 4.9999 is un-exitable dust — and
  // note it would RENDER as '5' after the cents trim, i.e. look like it met the minimum it misses.
  function dustEth(): Position {
    return position({ symbol: ETH, signedQty: new Decimal('0.0001'), avgEntry: price('49999') });
  }

  it('drops a position whose notional is under its venue minNotional', () => {
    const snapshot: PortfolioSnapshot = {
      ...emptySnapshot(),
      positions: new Map([['ETH/USDT', dustEth()]]),
    };

    const block = buildAgentPortfolioBlock(snapshot, undefined);

    expect(block.positions).toEqual([]);
  });

  it('still counts dropped dust in grossExposure (the book gross the sizer sees, never understated)', () => {
    const snapshot: PortfolioSnapshot = {
      ...emptySnapshot(),
      positions: new Map([
        [
          'BTC/USDT',
          position({
            signedQty: new Decimal('0.123456789012345'),
            avgEntry: price('1000.0000001'),
          }),
        ],
        ['ETH/USDT', dustEth()],
      ]),
    };

    const block = buildAgentPortfolioBlock(snapshot, undefined);

    expect(block.positions).toEqual([
      { symbol: 'BTC/USDT', side: 'LONG', qty: '0.123457', notional: '123.46' },
    ]);
    // 123.4567890246906789 + 4.9999 = 128.4566890246906789.
    expect(block.grossExposure).toBe('128.46');
  });

  it('keeps a position sitting exactly at minNotional (strictly-below is the dust test)', () => {
    const snapshot: PortfolioSnapshot = {
      ...emptySnapshot(),
      positions: new Map([
        [
          'ETH/USDT',
          position({ symbol: ETH, signedQty: new Decimal('0.05'), avgEntry: price('100') }),
        ],
      ]),
    };

    const block = buildAgentPortfolioBlock(snapshot, undefined);

    expect(block.positions).toEqual([
      { symbol: 'ETH/USDT', side: 'LONG', qty: '0.05', notional: '5' },
    ]);
  });

  it('keeps a position whose symbol has no DEFAULT_FILTERS row (fail open — never hide an unclassifiable position)', () => {
    const snapshot: PortfolioSnapshot = {
      ...emptySnapshot(),
      positions: new Map([
        ['ALT/USDT', position({ symbol: ALT, signedQty: new Decimal('2'), avgEntry: price('1') })],
      ]),
    };

    const block = buildAgentPortfolioBlock(snapshot, undefined);

    expect(block.positions).toEqual([
      { symbol: 'ALT/USDT', side: 'LONG', qty: '2', notional: '2' },
    ]);
  });
});
