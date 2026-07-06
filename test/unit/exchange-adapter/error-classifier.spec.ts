import { describe, it, expect } from 'vitest';
import * as ccxt from 'ccxt';
import {
  classifyCcxtError,
  toAdapterError,
} from '../../../src/features/trading/exchange/error-classifier';
import { AdapterError, type AdapterErrorClass } from '../../../src/ports/exchange';

// §6.3 classifier is snapshot-tested against the PINNED ccxt error hierarchy (4.5.58). ccxt has
// restructured this tree between versions; CLAUDE.md makes a ccxt bump conditional on re-running
// this test precisely because an unnoticed remap silently converts query-first into blind-retry.
// Two assertions, both load-bearing: (1) the parent chains the classifier relies on are intact;
// (2) every referenced class still classifies as designed.

function parentChain(ctor: unknown): string[] {
  const chain: string[] = [];
  let p: unknown = Object.getPrototypeOf(ctor);
  while (typeof p === 'function' && (p as { name?: string }).name) {
    chain.push((p as { name: string }).name);
    p = Object.getPrototypeOf(p);
  }
  return chain;
}

describe('ccxt error hierarchy snapshot (4.5.58)', () => {
  // The exact tree §6.3 documents. RateLimitExceeded is a SIBLING of DDoSProtection under
  // NetworkError (no longer its child) — the single most consequential relationship here.
  const EXPECTED_CHAINS: Record<string, string[]> = {
    ExchangeError: ['BaseError', 'Error'],
    AuthenticationError: ['ExchangeError', 'BaseError', 'Error'],
    PermissionDenied: ['AuthenticationError', 'ExchangeError', 'BaseError', 'Error'],
    AccountSuspended: ['AuthenticationError', 'ExchangeError', 'BaseError', 'Error'],
    BadRequest: ['ExchangeError', 'BaseError', 'Error'],
    BadSymbol: ['BadRequest', 'ExchangeError', 'BaseError', 'Error'],
    InvalidOrder: ['ExchangeError', 'BaseError', 'Error'],
    OrderNotFound: ['InvalidOrder', 'ExchangeError', 'BaseError', 'Error'],
    DuplicateOrderId: ['InvalidOrder', 'ExchangeError', 'BaseError', 'Error'],
    OrderImmediatelyFillable: ['InvalidOrder', 'ExchangeError', 'BaseError', 'Error'],
    OrderNotFillable: ['InvalidOrder', 'ExchangeError', 'BaseError', 'Error'],
    InsufficientFunds: ['ExchangeError', 'BaseError', 'Error'],
    OperationRejected: ['ExchangeError', 'BaseError', 'Error'],
    NotSupported: ['ExchangeError', 'BaseError', 'Error'],
    OperationFailed: ['BaseError', 'Error'],
    NetworkError: ['OperationFailed', 'BaseError', 'Error'],
    DDoSProtection: ['NetworkError', 'OperationFailed', 'BaseError', 'Error'],
    RateLimitExceeded: ['NetworkError', 'OperationFailed', 'BaseError', 'Error'],
    ExchangeNotAvailable: ['NetworkError', 'OperationFailed', 'BaseError', 'Error'],
    OnMaintenance: [
      'ExchangeNotAvailable',
      'NetworkError',
      'OperationFailed',
      'BaseError',
      'Error',
    ],
    InvalidNonce: ['NetworkError', 'OperationFailed', 'BaseError', 'Error'],
    RequestTimeout: ['NetworkError', 'OperationFailed', 'BaseError', 'Error'],
    BadResponse: ['OperationFailed', 'BaseError', 'Error'],
    CancelPending: ['OperationFailed', 'BaseError', 'Error'],
  };

  for (const [name, expected] of Object.entries(EXPECTED_CHAINS)) {
    it(`${name} still exists with its documented parent chain`, () => {
      const ctor = (ccxt as Record<string, unknown>)[name];
      expect(typeof ctor).toBe('function');
      expect(parentChain(ctor)).toEqual(expected);
    });
  }
});

describe('classifyCcxtError', () => {
  const cases: ReadonlyArray<[new (msg: string) => Error, AdapterErrorClass]> = [
    // AUTH_FATAL
    [ccxt.AuthenticationError, 'AUTH_FATAL'],
    [ccxt.PermissionDenied, 'AUTH_FATAL'],
    [ccxt.AccountSuspended, 'AUTH_FATAL'],
    // TERMINAL_REJECT
    [ccxt.InvalidOrder, 'TERMINAL_REJECT'],
    [ccxt.OrderImmediatelyFillable, 'TERMINAL_REJECT'],
    [ccxt.OrderNotFillable, 'TERMINAL_REJECT'],
    [ccxt.BadSymbol, 'TERMINAL_REJECT'],
    [ccxt.BadRequest, 'TERMINAL_REJECT'],
    [ccxt.InsufficientFunds, 'TERMINAL_REJECT'],
    [ccxt.NotSupported, 'TERMINAL_REJECT'],
    [ccxt.OperationRejected, 'TERMINAL_REJECT'],
    // TRANSPORT_RETRYABLE
    [ccxt.DDoSProtection, 'TRANSPORT_RETRYABLE'],
    [ccxt.RateLimitExceeded, 'TRANSPORT_RETRYABLE'],
    [ccxt.InvalidNonce, 'TRANSPORT_RETRYABLE'],
    // MAINTENANCE
    [ccxt.OnMaintenance, 'MAINTENANCE'],
    // OUTCOME_AMBIGUOUS — the safe default branch (generic / write-may-have-landed)
    [ccxt.RequestTimeout, 'OUTCOME_AMBIGUOUS'],
    [ccxt.NetworkError, 'OUTCOME_AMBIGUOUS'],
    [ccxt.ExchangeNotAvailable, 'OUTCOME_AMBIGUOUS'],
    [ccxt.BadResponse, 'OUTCOME_AMBIGUOUS'],
    [ccxt.CancelPending, 'OUTCOME_AMBIGUOUS'],
    [ccxt.ExchangeError, 'OUTCOME_AMBIGUOUS'],
  ];

  for (const [Ctor, expected] of cases) {
    it(`${Ctor.name} → ${expected}`, () => {
      const { errorClass, code } = classifyCcxtError(new Ctor('boom'));
      expect(errorClass).toBe(expected);
      expect(code).toBe(Ctor.name);
    });
  }

  it('classifies the two special subtypes to the query path, preserving their name', () => {
    // Both are InvalidOrder subclasses (→ TERMINAL_REJECT for the parent) but must NOT inherit
    // it: DuplicateOrderId is an implicit ack, OrderNotFound-on-cancel is already-closed —
    // both resolve through the query loop, which is OUTCOME_AMBIGUOUS at this seam.
    const dup = classifyCcxtError(new ccxt.DuplicateOrderId('dup'));
    expect(dup).toEqual({ errorClass: 'OUTCOME_AMBIGUOUS', code: 'DuplicateOrderId' });
    const nf = classifyCcxtError(new ccxt.OrderNotFound('gone'));
    expect(nf).toEqual({ errorClass: 'OUTCOME_AMBIGUOUS', code: 'OrderNotFound' });
  });

  it('defaults a non-ccxt Error to OUTCOME_AMBIGUOUS with its own constructor name', () => {
    expect(classifyCcxtError(new TypeError('nope'))).toEqual({
      errorClass: 'OUTCOME_AMBIGUOUS',
      code: 'TypeError',
    });
  });

  it('defaults a thrown non-Error value to OUTCOME_AMBIGUOUS/UNKNOWN', () => {
    expect(classifyCcxtError('plain string')).toEqual({
      errorClass: 'OUTCOME_AMBIGUOUS',
      code: 'UNKNOWN',
    });
  });
});

describe('toAdapterError', () => {
  it('wraps a ccxt error as a typed AdapterError', () => {
    const e = toAdapterError(new ccxt.InsufficientFunds('broke'));
    expect(e).toBeInstanceOf(AdapterError);
    expect(e.errorClass).toBe('TERMINAL_REJECT');
    expect(e.code).toBe('InsufficientFunds');
    expect(e.message).toBe('broke');
  });

  it('passes an existing AdapterError through unchanged (idempotent re-wrap)', () => {
    const original = new AdapterError('MAINTENANCE', 'OnMaintenance', 'down');
    expect(toAdapterError(original)).toBe(original);
  });

  it('wraps a non-Error throwable with a stringified message', () => {
    const e = toAdapterError(42);
    expect(e.errorClass).toBe('OUTCOME_AMBIGUOUS');
    expect(e.code).toBe('UNKNOWN');
    expect(e.message).toBe('42');
  });
});
