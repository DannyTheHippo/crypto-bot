import Decimal from 'decimal.js';
import { price, qty, feeAmount } from '../../../src/domain/types/money';
import {
  intentId,
  encodeClientOrderId,
  strategyId,
  venueId,
  symbolId,
  epochMs,
} from '../../../src/domain/types/ids';
import type { OrderIntent } from '../../../src/domain/types/order-intent';
import type { FillRecord } from '../../../src/domain/types/exec-report';
import type { FeedHealthPort } from '../../../src/ports/market-data';
import type { ClockPort } from '../../../src/ports/clock';
import type { KillSwitchPort } from '../../../src/ports/risk';
import type { KillSwitchState } from '../../../src/domain/risk/kill-switch';

export const T = 1_700_000_000_000;
export const V = venueId('binance');
export const SYM = symbolId('BTC/USDT');
export const SID = strategyId('s1');
export const IID = intentId('0190abcd-1234-7abc-89ab-0123456789ab');

export function fixedClock(t = T): ClockPort {
  return { now: () => epochMs(t) };
}

export function makeIntent(over: Partial<OrderIntent> = {}): OrderIntent {
  const id = over.intentId ?? IID;
  return {
    intentId: id,
    clientOrderId: over.clientOrderId ?? encodeClientOrderId(id, 'paper'),
    strategyId: SID,
    venue: V,
    symbol: SYM,
    side: 'BUY',
    type: 'LIMIT',
    qty: qty('1'),
    limitPrice: price('100'),
    timeInForce: 'GTC',
    reduceOnly: false,
    mode: 'paper',
    refPrice: price('100'),
    refSeq: 9n,
    createdAt: epochMs(0),
    expiresAt: epochMs(T + 10_000),
    source: { dedupeKey: 'k', eventTime: epochMs(0), basedOnSeq: 9n, strength: 1 },
    ...over,
  };
}

export function makeFill(over: Partial<FillRecord> = {}): FillRecord {
  return {
    venue: V,
    symbol: SYM,
    venueTradeId: 't1',
    clientOrderId: encodeClientOrderId(IID, 'paper'),
    price: price('100'),
    qty: qty('1'),
    fee: null,
    liquidity: 'taker',
    venueTimestamp: epochMs(T),
    source: 'paper',
    ...over,
  };
}

export function feeQuote(amount: string) {
  return { ccy: 'USDT', amount: feeAmount(amount) };
}

// Feed returning a fixed mid for every symbol; toggle to no-mark via refPresent=false.
export function fixedFeed(mid = '100', refPresent = true): FeedHealthPort {
  return {
    getRefPrice: () => (refPresent ? { mid: price(mid), at: epochMs(T) } : undefined),
    health: () => 'LIVE',
    fetchCandles: () => Promise.resolve([]),
  };
}

export const D = (s: string) => new Decimal(s);

// Recording kill-switch stub: stays RUNNING (so callers keep evaluating) and captures engagements.
export function killSwitchStub(): {
  ks: KillSwitchPort;
  engages: Array<{ reason: string; flatten: boolean }>;
} {
  const engages: Array<{ reason: string; flatten: boolean }> = [];
  const ks: KillSwitchPort = {
    state: (): KillSwitchState => 'RUNNING',
    engage: (reason, flatten) => {
      engages.push({ reason, flatten });
    },
    confirmCancels: () => undefined,
    cancelTimeout: () => undefined,
    allFlat: () => undefined,
  };
  return { ks, engages };
}
