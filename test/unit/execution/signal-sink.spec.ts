import { describe, it, expect, vi } from 'vitest';
import { SignalSinkService } from '../../../src/features/trading/execution/signal-sink.service';
import { mintApproval } from '../../../src/domain/risk/proof';
import type { GatewayOutcome, SignalGatewayPort } from '../../../src/ports/risk';
import type { SignalJournalPort } from '../../../src/ports/strategy';
import type { ExecutionGatePort, PortfolioViewPort, SubmitAck } from '../../../src/ports/execution';
import type { RiskApprovedIntent } from '../../../src/domain/types/risk-decision';
import type { PortfolioSnapshot, OpenOrderSummary } from '../../../src/domain/types/portfolio';
import { makeIntent, SID } from './helpers';
import { clientOrderId, epochMs, symbolId } from '../../../src/domain/types/ids';
import { qty } from '../../../src/domain/types/money';

const approved = (): RiskApprovedIntent =>
  mintApproval(makeIntent(), Buffer.alloc(32, 1), {
    nonce: 'n',
    approvedAtMs: epochMs(0),
    limitsVersion: 'v1',
    snapshotSeq: 1n,
  });

function makeSink(
  outcome: GatewayOutcome,
  journal?: SignalJournalPort,
  rejects?: { inc: (labels: Record<string, string>) => void },
  openOrders?: readonly OpenOrderSummary[],
) {
  const submitted: RiskApprovedIntent[] = [];
  const cancelled: Array<{ clientOrderId: string; reason: string }> = [];
  const forStrategyCalls: string[] = [];
  const gateway: SignalGatewayPort = { accept: () => outcome };
  const portfolio: PortfolioViewPort = {
    snapshot: () => ({}) as PortfolioSnapshot,
    forStrategy: (id) => {
      forStrategyCalls.push(id);
      return {
        strategyId: id,
        positions: new Map(),
        openOrders: openOrders ?? [],
      };
    },
  };
  const gate: ExecutionGatePort = {
    submit: (a) => {
      submitted.push(a);
      return Promise.resolve({
        clientOrderId: a.intent.clientOrderId,
        outcome: 'SUBMITTED',
      } as SubmitAck);
    },
    cancel: (coid, reason) => {
      cancelled.push({ clientOrderId: coid, reason });
      return Promise.resolve();
    },
    cancelAllFor: () => Promise.resolve(),
    flattenAll: () => Promise.resolve(),
  };
  return {
    sink: new SignalSinkService(gateway, portfolio, gate, journal, rejects as never),
    submitted,
    cancelled,
    forStrategyCalls,
  };
}

function openOrder(symbol = makeIntent().symbol, coidSeed = '0'): OpenOrderSummary {
  return {
    clientOrderId: clientOrderId('cbp' + coidSeed.repeat(32)),
    symbol,
    side: 'BUY',
    qty: qty('1'),
  };
}

const signal = () => ({
  strategyId: SID,
  venue: makeIntent().venue,
  symbol: makeIntent().symbol,
  kind: 'ENTER_LONG' as const,
  strength: 1,
  refPrice: makeIntent().refPrice,
  basedOnSeq: 1n,
  eventTime: epochMs(0),
  ttlMs: 10_000,
  dedupeKey: 'k',
  reason: 't',
});

const cancelSignal = () => ({ ...signal(), kind: 'CANCEL_OPEN' as const });

describe('SignalSinkService', () => {
  it('submits an APPROVED decision to the execution gate', async () => {
    const { sink, submitted } = makeSink({
      status: 'DECIDED',
      decision: { verdict: 'APPROVED', approved: approved() },
    });
    await sink.recordSignal(signal());
    expect(submitted).toHaveLength(1);
  });

  it('submits a RESIZED decision', async () => {
    const { sink, submitted } = makeSink({
      status: 'DECIDED',
      decision: {
        verdict: 'RESIZED',
        approved: approved(),
        originalQty: qty('20'),
        reasons: ['POSITION_LIMIT'],
      },
    });
    await sink.recordSignal(signal());
    expect(submitted).toHaveLength(1);
  });

  it('does not submit a REJECTED decision', async () => {
    const { sink, submitted } = makeSink({
      status: 'DECIDED',
      decision: { verdict: 'REJECTED', intent: makeIntent(), reasons: ['KILL_SWITCH'] },
    });
    await sink.recordSignal(signal());
    expect(submitted).toHaveLength(0);
  });

  it('does not submit when the gateway fast-fails before deciding', async () => {
    const { sink, submitted } = makeSink({ status: 'GATEWAY_REJECTED', reason: 'DUPLICATE' });
    await sink.recordSignal(signal());
    expect(submitted).toHaveLength(0);
  });

  it('increments the front-door rejection counter with the stage and reason', async () => {
    const inc = vi.fn();
    const { sink } = makeSink({ status: 'SIZING_REJECTED', reason: 'NO_POSITION' }, undefined, {
      inc,
    });
    await sink.recordSignal(signal());
    expect(inc).toHaveBeenCalledWith({ stage: 'SIZING_REJECTED', reason: 'NO_POSITION' });
  });

  it('does not increment the rejection counter on a DECIDED outcome', async () => {
    const inc = vi.fn();
    const { sink } = makeSink(
      { status: 'DECIDED', decision: { verdict: 'APPROVED', approved: approved() } },
      undefined,
      { inc },
    );
    await sink.recordSignal(signal());
    expect(inc).not.toHaveBeenCalled();
  });

  it('journals every routed signal with its outcome (and intentId on a decision)', async () => {
    const record = vi.fn();
    const journal: SignalJournalPort = { record };

    // Fast-fail before deciding → outcome string carries the status:reason.
    const fastFail = makeSink({ status: 'SIZING_REJECTED', reason: 'BELOW_MINIMUM' }, journal);
    await fastFail.sink.recordSignal(signal());
    expect(record.mock.calls[0]).toEqual([
      expect.objectContaining({ dedupeKey: 'k' }),
      'SIZING_REJECTED:BELOW_MINIMUM',
    ]);

    // DECIDED + APPROVED → verdict + the approved intent's id.
    record.mockClear();
    const a = approved();
    const ok = makeSink(
      { status: 'DECIDED', decision: { verdict: 'APPROVED', approved: a } },
      journal,
    );
    await ok.sink.recordSignal(signal());
    expect(record.mock.calls[0]).toEqual([expect.anything(), 'APPROVED', a.intent.intentId]);

    // DECIDED + REJECTED → verdict only, no intentId.
    record.mockClear();
    const rej = makeSink(
      {
        status: 'DECIDED',
        decision: { verdict: 'REJECTED', intent: makeIntent(), reasons: ['KILL_SWITCH'] },
      },
      journal,
    );
    await rej.sink.recordSignal(signal());
    expect(record.mock.calls[0]).toEqual([expect.anything(), 'REJECTED']);
  });

  describe('CANCEL_OPEN', () => {
    it('cancels every open order for the strategy+symbol without touching the gateway', async () => {
      const { sink, submitted, cancelled, forStrategyCalls } = makeSink(
        { status: 'GATEWAY_REJECTED', reason: 'DUPLICATE' }, // would fail if the sink ever reached the gateway
        undefined,
        undefined,
        [openOrder(undefined, '0'), openOrder(undefined, '1')],
      );
      const sig = cancelSignal();
      await sink.recordSignal(sig);
      expect(forStrategyCalls).toEqual([sig.strategyId]); // scoped to the SIGNAL's own strategy
      expect(cancelled).toEqual([
        { clientOrderId: 'cbp' + '0'.repeat(32), reason: 'CANCEL_OPEN_SIGNAL' },
        { clientOrderId: 'cbp' + '1'.repeat(32), reason: 'CANCEL_OPEN_SIGNAL' },
      ]);
      expect(submitted).toHaveLength(0); // never reaches the risk/execution submit path
    });

    it('ignores open orders on a different symbol', async () => {
      const otherSymbol = symbolId('ETH/USDT');
      const { sink, cancelled } = makeSink(
        { status: 'GATEWAY_REJECTED', reason: 'DUPLICATE' },
        undefined,
        undefined,
        [openOrder(otherSymbol, '0')],
      );
      await sink.recordSignal(cancelSignal());
      expect(cancelled).toHaveLength(0);
    });

    it('is idempotent when there are no matching open orders (no-op)', async () => {
      const { sink, cancelled } = makeSink(
        { status: 'GATEWAY_REJECTED', reason: 'DUPLICATE' },
        undefined,
        undefined,
        [],
      );
      await sink.recordSignal(cancelSignal());
      expect(cancelled).toHaveLength(0);
    });

    it('journals the cancelled-order count as the outcome', async () => {
      const record = vi.fn();
      const journal: SignalJournalPort = { record };
      const { sink } = makeSink(
        { status: 'GATEWAY_REJECTED', reason: 'DUPLICATE' },
        journal,
        undefined,
        [openOrder(undefined, '0')],
      );
      await sink.recordSignal(cancelSignal());
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'CANCEL_OPEN' }),
        'CANCEL_OPEN:1',
      );
    });

    it('does not increment the front-door rejection counter for CANCEL_OPEN', async () => {
      const inc = vi.fn();
      const { sink } = makeSink(
        { status: 'GATEWAY_REJECTED', reason: 'DUPLICATE' },
        undefined,
        { inc },
        [openOrder(undefined, '0')],
      );
      await sink.recordSignal(cancelSignal());
      expect(inc).not.toHaveBeenCalled();
    });
  });
});
