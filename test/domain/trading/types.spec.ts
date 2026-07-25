import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  setupDecimal,
  price,
  qty,
  feeAmount,
  notional,
} from '../../../src/domain/common/types/money';
import {
  strategyId,
  venueId,
  symbolId,
  intentId,
  signalId,
  epochMs,
  encodeClientOrderId,
} from '../../../src/domain/common/types/ids';
import type { Signal } from '../../../src/domain/strategy/types/signal';
import type { OrderIntent } from '../../../src/domain/trading/types/order-intent';
import type {
  ExecReport,
  FillReport,
  AckReport,
  RejectReport,
  CancelAckReport,
  ExpireReport,
  FillRecord,
} from '../../../src/domain/trading/types/exec-report';
import type {
  PortfolioSnapshot,
  StrategyPortfolioView,
  Position,
} from '../../../src/domain/trading/types/portfolio';
import type { RiskDecision } from '../../../src/domain/trading/types/risk-decision';

// These tests construct representative literal values and use `satisfies`
// to pin the shapes at the type level — they fail to compile if the types drift.

setupDecimal();

const SID = strategyId('strat-1');
const VID = venueId('binance');
const SYM = symbolId('BTC/USDT');
const IID = intentId('01900000-0000-7000-8000-000000000001');
const CID = encodeClientOrderId(IID, 'paper');
const NOW = epochMs(1700000000000);
const REF_PRICE = price('50000');
const Q = qty('0.01');
const P = price('49900');

describe('Signal — type shape', () => {
  it('accepts a representative Signal literal', () => {
    const sig = {
      strategyId: SID,
      venue: VID,
      symbol: SYM,
      kind: 'ENTER_LONG' as const,
      strength: 0.8,
      refPrice: REF_PRICE,
      basedOnSeq: 42n,
      eventTime: NOW,
      ttlMs: 5000,
      dedupeKey: 'ema-cross-buy-1700000000000',
      reason: 'EMA20 crossed above EMA50',
    } satisfies Signal;

    expect(sig.kind).toBe('ENTER_LONG');
    expect(sig.strength).toBe(0.8);
  });

  it('Signal.kind covers all six values (incl. short open/cover)', () => {
    const kinds: Signal['kind'][] = [
      'ENTER_LONG',
      'EXIT_LONG',
      'ENTER_SHORT',
      'EXIT_SHORT',
      'FLATTEN',
      'CANCEL_OPEN',
    ];
    expect(kinds.length).toBe(6);
  });
});

describe('OrderIntent — type shape', () => {
  it('accepts a representative OrderIntent literal', () => {
    const intent = {
      intentId: IID,
      clientOrderId: CID,
      strategyId: SID,
      venue: VID,
      symbol: SYM,
      side: 'BUY' as const,
      type: 'LIMIT' as const,
      qty: Q,
      limitPrice: P,
      timeInForce: 'GTC' as const,
      reduceOnly: false,
      mode: 'paper' as const,
      refPrice: REF_PRICE,
      refSeq: 42n,
      createdAt: NOW,
      expiresAt: epochMs(NOW + 5000),
      source: {
        dedupeKey: 'ema-cross-buy-1700000000000',
        eventTime: NOW,
        basedOnSeq: 42n,
        strength: 0.8,
      },
    } satisfies OrderIntent;

    expect(intent.side).toBe('BUY');
    expect(intent.timeInForce).toBe('GTC');
  });
});

describe('ExecReport — type shapes', () => {
  it('AckReport', () => {
    const report = {
      kind: 'ACK' as const,
      reportId: 'r1',
      clientOrderId: CID,
      venue: VID,
      symbol: SYM,
      eventTime: NOW,
      ingestTime: NOW,
      venueOrderId: 'venue-123',
    } satisfies AckReport;

    expect(report.kind).toBe('ACK');
  });

  it('RejectReport', () => {
    const report = {
      kind: 'REJECT' as const,
      reportId: 'r2',
      clientOrderId: CID,
      venue: VID,
      symbol: SYM,
      eventTime: NOW,
      ingestTime: NOW,
      reason: 'INSUFFICIENT_FUNDS',
      code: '-2010',
    } satisfies RejectReport;

    expect(report.kind).toBe('REJECT');
  });

  it('FillReport with fee', () => {
    const report = {
      kind: 'FILL' as const,
      reportId: 'r3',
      clientOrderId: CID,
      venue: VID,
      symbol: SYM,
      eventTime: NOW,
      ingestTime: NOW,
      venueTradeId: 'trade-456',
      price: P,
      qty: Q,
      fee: { ccy: 'BNB', amount: feeAmount('0.0001') },
      liquidity: 'taker' as const,
      venueTimestamp: NOW,
    } satisfies FillReport;

    expect(report.kind).toBe('FILL');
    expect(report.fee?.ccy).toBe('BNB');
  });

  it('FillReport with null fee', () => {
    const report = {
      kind: 'FILL' as const,
      reportId: 'r4',
      clientOrderId: CID,
      venue: VID,
      symbol: SYM,
      eventTime: NOW,
      ingestTime: NOW,
      venueTradeId: 'trade-789',
      price: P,
      qty: Q,
      fee: null,
      liquidity: 'maker' as const,
      venueTimestamp: NOW,
    } satisfies FillReport;

    expect(report.fee).toBeNull();
  });

  it('CancelAckReport', () => {
    const report = {
      kind: 'CANCEL_ACK' as const,
      reportId: 'r5',
      clientOrderId: CID,
      venue: VID,
      symbol: SYM,
      eventTime: NOW,
      ingestTime: NOW,
    } satisfies CancelAckReport;

    expect(report.kind).toBe('CANCEL_ACK');
  });

  it('ExpireReport', () => {
    const report = {
      kind: 'EXPIRE' as const,
      reportId: 'r6',
      clientOrderId: CID,
      venue: VID,
      symbol: SYM,
      eventTime: NOW,
      ingestTime: NOW,
    } satisfies ExpireReport;

    expect(report.kind).toBe('EXPIRE');
  });

  it('ExecReport discriminated union narrows correctly', () => {
    const report: ExecReport = {
      kind: 'FILL',
      reportId: 'r3',
      clientOrderId: CID,
      venue: VID,
      symbol: SYM,
      eventTime: NOW,
      ingestTime: NOW,
      venueTradeId: 'trade-456',
      price: P,
      qty: Q,
      fee: null,
      liquidity: 'taker',
      venueTimestamp: NOW,
    };

    if (report.kind === 'FILL') {
      expect(report.venueTradeId).toBe('trade-456');
    }
  });
});

describe('FillRecord — type shape', () => {
  it('accepts a representative FillRecord', () => {
    const fill = {
      venue: VID,
      symbol: SYM,
      venueTradeId: 'trade-001',
      clientOrderId: CID,
      price: P,
      qty: Q,
      fee: null,
      liquidity: 'taker' as const,
      venueTimestamp: NOW,
      source: 'ws' as const,
    } satisfies FillRecord;

    expect(fill.source).toBe('ws');
  });
});

describe('PortfolioSnapshot — type shape', () => {
  it('accepts a representative PortfolioSnapshot', () => {
    const pos: Position = {
      strategyId: SID,
      venue: VID,
      symbol: SYM,
      signedQty: new Decimal('0.5'),
      avgEntry: P,
      realizedPnl: new Decimal('25.0'),
    };

    const snapshot = {
      positions: new Map([['strat-1:binance:BTC/USDT', pos]]),
      balances: new Map([['USDT', { free: new Decimal('10000'), locked: new Decimal('500') }]]),
      openOrders: [],
      inFlightIntents: [],
      equity: new Decimal('10500'),
      unrealized: new Decimal('250'),
      startingCash: new Decimal('10000'),
      peakEquity: new Decimal('11000'),
      sodEquityUtc: new Decimal('10000'),
      reconcileStatus: 'CLEAN' as const,
      snapshotSeq: 1n,
    } satisfies PortfolioSnapshot;

    expect(snapshot.reconcileStatus).toBe('CLEAN');
  });
});

describe('StrategyPortfolioView — type shape (no balances/equity)', () => {
  it('accepts a representative StrategyPortfolioView', () => {
    const view = {
      strategyId: SID,
      positions: new Map<string, Position>(),
      openOrders: [],
    } satisfies StrategyPortfolioView;

    expect(view.strategyId).toBe(SID);
    // StrategyPortfolioView has no .equity or .balances — type system enforces this at compile time
  });
});

describe('RiskDecision — type shapes', () => {
  it('REJECTED variant has intent + reasons', () => {
    const intent: OrderIntent = {
      intentId: IID,
      clientOrderId: CID,
      strategyId: SID,
      venue: VID,
      symbol: SYM,
      side: 'BUY',
      type: 'LIMIT',
      qty: Q,
      limitPrice: P,
      timeInForce: 'GTC',
      reduceOnly: false,
      mode: 'paper',
      refPrice: REF_PRICE,
      refSeq: 1n,
      createdAt: NOW,
      expiresAt: epochMs(NOW + 5000),
      source: {
        dedupeKey: 'k',
        eventTime: NOW,
        basedOnSeq: 1n,
        strength: 0.5,
      },
    };

    const decision: RiskDecision = {
      verdict: 'REJECTED',
      intent,
      reasons: ['KILL_SWITCH'],
    };

    expect(decision.verdict).toBe('REJECTED');
    if (decision.verdict === 'REJECTED') {
      expect(decision.reasons).toContain('KILL_SWITCH');
    }
  });
});

// Unused-import guard for signalId — ensures the import is exercised
describe('misc id constructors', () => {
  it('signalId accepts valid UUIDv7', () => {
    expect(() => signalId('01900000-0000-7000-8000-000000000002')).not.toThrow();
  });
  it('notional(0) is valid', () => {
    expect(() => notional('0')).not.toThrow();
  });
});
