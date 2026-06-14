import { describe, it, expect, vi } from 'vitest';
import { SignalSinkService } from '../../../src/modules/execution/signal-sink.service';
import { mintApproval } from '../../../src/domain/risk/proof';
import type { GatewayOutcome, SignalGatewayPort } from '../../../src/ports/risk';
import type { SignalJournalPort } from '../../../src/ports/strategy';
import type { ExecutionGatePort, PortfolioViewPort, SubmitAck } from '../../../src/ports/execution';
import type { RiskApprovedIntent } from '../../../src/domain/types/risk-decision';
import type { PortfolioSnapshot, StrategyPortfolioView } from '../../../src/domain/types/portfolio';
import { makeIntent, SID } from './helpers';
import { epochMs } from '../../../src/domain/types/ids';
import { qty } from '../../../src/domain/types/money';

const approved = (): RiskApprovedIntent =>
  mintApproval(makeIntent(), Buffer.alloc(32, 1), { nonce: 'n', approvedAtMs: epochMs(0), limitsVersion: 'v1', snapshotSeq: 1n });

function makeSink(outcome: GatewayOutcome, journal?: SignalJournalPort) {
  const submitted: RiskApprovedIntent[] = [];
  const gateway: SignalGatewayPort = { accept: () => outcome };
  const portfolio: PortfolioViewPort = {
    snapshot: () => ({} as PortfolioSnapshot),
    forStrategy: () => ({} as StrategyPortfolioView),
  };
  const gate: ExecutionGatePort = {
    submit: (a) => { submitted.push(a); return Promise.resolve({ clientOrderId: a.intent.clientOrderId, outcome: 'SUBMITTED' } as SubmitAck); },
    cancel: () => Promise.resolve(),
    cancelAllFor: () => Promise.resolve(),
    flattenAll: () => Promise.resolve(),
  };
  return { sink: new SignalSinkService(gateway, portfolio, gate, journal), submitted };
}

const signal = () => ({
  strategyId: SID, venue: makeIntent().venue, symbol: makeIntent().symbol, kind: 'ENTER_LONG' as const,
  strength: 1, refPrice: makeIntent().refPrice, basedOnSeq: 1n, eventTime: epochMs(0), ttlMs: 10_000, dedupeKey: 'k', reason: 't',
});

describe('SignalSinkService', () => {
  it('submits an APPROVED decision to the execution gate', async () => {
    const { sink, submitted } = makeSink({ status: 'DECIDED', decision: { verdict: 'APPROVED', approved: approved() } });
    await sink.recordSignal(signal());
    expect(submitted).toHaveLength(1);
  });

  it('submits a RESIZED decision', async () => {
    const { sink, submitted } = makeSink({
      status: 'DECIDED', decision: { verdict: 'RESIZED', approved: approved(), originalQty: qty('20'), reasons: ['POSITION_LIMIT'] },
    });
    await sink.recordSignal(signal());
    expect(submitted).toHaveLength(1);
  });

  it('does not submit a REJECTED decision', async () => {
    const { sink, submitted } = makeSink({
      status: 'DECIDED', decision: { verdict: 'REJECTED', intent: makeIntent(), reasons: ['KILL_SWITCH'] },
    });
    await sink.recordSignal(signal());
    expect(submitted).toHaveLength(0);
  });

  it('does not submit when the gateway fast-fails before deciding', async () => {
    const { sink, submitted } = makeSink({ status: 'GATEWAY_REJECTED', reason: 'DUPLICATE' });
    await sink.recordSignal(signal());
    expect(submitted).toHaveLength(0);
  });

  it('journals every routed signal with its outcome (and intentId on a decision)', async () => {
    const record = vi.fn();
    const journal: SignalJournalPort = { record };

    // Fast-fail before deciding → outcome string carries the status:reason.
    const fastFail = makeSink({ status: 'SIZING_REJECTED', reason: 'BELOW_MINIMUM' }, journal);
    await fastFail.sink.recordSignal(signal());
    expect(record.mock.calls[0]).toEqual([expect.objectContaining({ dedupeKey: 'k' }), 'SIZING_REJECTED:BELOW_MINIMUM']);

    // DECIDED + APPROVED → verdict + the approved intent's id.
    record.mockClear();
    const a = approved();
    const ok = makeSink({ status: 'DECIDED', decision: { verdict: 'APPROVED', approved: a } }, journal);
    await ok.sink.recordSignal(signal());
    expect(record.mock.calls[0]).toEqual([expect.anything(), 'APPROVED', a.intent.intentId]);

    // DECIDED + REJECTED → verdict only, no intentId.
    record.mockClear();
    const rej = makeSink({ status: 'DECIDED', decision: { verdict: 'REJECTED', intent: makeIntent(), reasons: ['KILL_SWITCH'] } }, journal);
    await rej.sink.recordSignal(signal());
    expect(record.mock.calls[0]).toEqual([expect.anything(), 'REJECTED']);
  });
});
