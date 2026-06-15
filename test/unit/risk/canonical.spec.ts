import { describe, it, expect } from 'vitest';
import { canonicalJson, intentCanonical } from '../../../src/domain/risk/canonical';
import { price, qty } from '../../../src/domain/types/money';
import type { OrderIntent } from '../../../src/domain/types/order-intent';
import {
  intentId,
  encodeClientOrderId,
  strategyId,
  venueId,
  symbolId,
  epochMs,
} from '../../../src/domain/types/ids';

describe('canonicalJson', () => {
  it('serializes Decimals via toFixed (no exponent notation)', () => {
    expect(canonicalJson(price('0.0000001'))).toBe('"0.0000001"'); // never "1e-7"
  });
  it('serializes bigint as a base-10 string', () => {
    expect(canonicalJson(123456789012345678901234567890n)).toBe('"123456789012345678901234567890"');
  });
  it('sorts object keys and preserves array order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
  it('maps null and undefined to null and passes primitives through', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson({ x: undefined, y: 'a', z: true })).toBe('{"x":null,"y":"a","z":true}');
  });
  it('recurses into nested objects and arrays', () => {
    expect(canonicalJson({ outer: { b: [1, { d: 4, c: 3 }], a: 1 } })).toBe(
      '{"outer":{"a":1,"b":[1,{"c":3,"d":4}]}}',
    );
  });
});

describe('intentCanonical', () => {
  const IID = intentId('0190abcd-1234-7abc-89ab-0123456789ab');
  function intent(o: Partial<OrderIntent> = {}): OrderIntent {
    return {
      intentId: IID,
      clientOrderId: encodeClientOrderId(IID, 'paper'),
      strategyId: strategyId('s'),
      venue: venueId('binance'),
      symbol: symbolId('BTC/USDT'),
      side: 'BUY',
      type: 'LIMIT',
      qty: qty('1'),
      limitPrice: price('100'),
      timeInForce: 'GTC',
      reduceOnly: false,
      mode: 'paper',
      refPrice: price('100'),
      refSeq: 1n,
      createdAt: epochMs(0),
      expiresAt: epochMs(1),
      source: { dedupeKey: 'k', eventTime: epochMs(0), basedOnSeq: 1n, strength: 1 },
      ...o,
    };
  }
  it('is identical for identical intents and differs when any field changes', () => {
    expect(intentCanonical(intent())).toBe(intentCanonical(intent()));
    expect(intentCanonical(intent({ qty: qty('2') }))).not.toBe(intentCanonical(intent()));
  });
});
