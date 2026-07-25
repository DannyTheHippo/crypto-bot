import { describe, it, expect, vi } from 'vitest';
import { SignalSinkService } from '../../../../src/features/trading/execution/signal-sink.service';
import { mintApproval } from '../../../../src/domain/trading/risk/proof';
import type { GatewayOutcome, SignalGatewayPort } from '../../../../src/ports/trading/risk';
import type { SignalJournalPort } from '../../../../src/ports/strategy/strategy';
import type {
  ExecutionGatePort,
  ExecutionStorePort,
  PortfolioViewPort,
  SubmitAck,
} from '../../../../src/ports/trading/execution';
import type { RiskApprovedIntent } from '../../../../src/domain/trading/types/risk-decision';
import type {
  PortfolioSnapshot,
  OpenOrderSummary,
} from '../../../../src/domain/trading/types/portfolio';
import { makeIntent, SID } from './helpers';
import { clientOrderId, epochMs, symbolId } from '../../../../src/domain/common/types/ids';
import { qty } from '../../../../src/domain/common/types/money';

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
  store?: Pick<ExecutionStorePort, 'loadIntentByClientOrderId'>,
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
    sink: new SignalSinkService(gateway, portfolio, gate, journal, rejects as never, store),
    submitted,
    cancelled,
    forStrategyCalls,
  };
}

function openOrder(
  symbol = makeIntent().symbol,
  coidSeed = '0',
  side: 'BUY' | 'SELL' = 'BUY',
): OpenOrderSummary {
  return {
    clientOrderId: clientOrderId('cbp' + coidSeed.repeat(32)),
    symbol,
    side,
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

    it('cancelSide scopes the cancel to only that side, leaving the other side resting', async () => {
      const { sink, cancelled } = makeSink(
        { status: 'GATEWAY_REJECTED', reason: 'DUPLICATE' },
        undefined,
        undefined,
        [openOrder(undefined, '0', 'BUY'), openOrder(undefined, '1', 'SELL')],
      );
      await sink.recordSignal({ ...cancelSignal(), cancelSide: 'SELL' });
      expect(cancelled).toEqual([
        { clientOrderId: 'cbp' + '1'.repeat(32), reason: 'CANCEL_OPEN_SIGNAL' },
      ]);
    });

    it('with no cancelSide, cancels both BUY and SELL open orders (pinned absent-scope behavior)', async () => {
      const { sink, cancelled } = makeSink(
        { status: 'GATEWAY_REJECTED', reason: 'DUPLICATE' },
        undefined,
        undefined,
        [openOrder(undefined, '0', 'BUY'), openOrder(undefined, '1', 'SELL')],
      );
      await sink.recordSignal(cancelSignal());
      expect(cancelled).toHaveLength(2);
    });
  });

  describe('cancelRole (Push 3 P7c): role-scoped narrowing of a cancelSide match', () => {
    const vtp = openOrder(undefined, '2', 'SELL');
    const vsl = openOrder(undefined, '3', 'SELL');
    const roleSignal = (cancelRole: 'vtp' | 'vsl') => ({
      ...cancelSignal(),
      cancelSide: 'SELL' as const,
      cancelRole,
    });

    // Store double answering the SAME OrderIntent the real store round-trips: the role is read off
    // intent.source.dedupeKey (the string the placing strategy stamped), never off the order itself.
    const roleStore = (
      dedupeKeyByCoid: Record<string, string>,
    ): Pick<ExecutionStorePort, 'loadIntentByClientOrderId'> => ({
      loadIntentByClientOrderId: (coid) => {
        const dedupeKey = dedupeKeyByCoid[coid];
        return Promise.resolve(
          dedupeKey === undefined
            ? null
            : makeIntent({
                source: { dedupeKey, eventTime: epochMs(0), basedOnSeq: 9n, strength: 1 },
              }),
        );
      },
    });

    const bothRoles = () =>
      roleStore({
        [vtp.clientOrderId]: 'venue_tp_place:BTC/USDT',
        [vsl.clientOrderId]: 'venue_stop_place:BTC/USDT',
      });

    it("'vtp' cancels only the resting venue-TP, leaving the venue stop resting", async () => {
      const { sink, cancelled } = makeSink(
        { status: 'GATEWAY_REJECTED', reason: 'DUPLICATE' },
        undefined,
        undefined,
        [vtp, vsl],
        bothRoles(),
      );
      await sink.recordSignal(roleSignal('vtp'));
      expect(cancelled).toEqual([
        { clientOrderId: vtp.clientOrderId, reason: 'CANCEL_OPEN_SIGNAL' },
      ]);
    });

    it("'vsl' cancels only the resting venue stop, leaving the TP resting", async () => {
      const { sink, cancelled } = makeSink(
        { status: 'GATEWAY_REJECTED', reason: 'DUPLICATE' },
        undefined,
        undefined,
        [vtp, vsl],
        bothRoles(),
      );
      await sink.recordSignal(roleSignal('vsl'));
      expect(cancelled).toEqual([
        { clientOrderId: vsl.clientOrderId, reason: 'CANCEL_OPEN_SIGNAL' },
      ]);
    });

    it('journals the role-filtered count, not the side-matching count', async () => {
      const record = vi.fn();
      const { sink } = makeSink(
        { status: 'GATEWAY_REJECTED', reason: 'DUPLICATE' },
        { record },
        undefined,
        [vtp, vsl],
        bothRoles(),
      );
      await sink.recordSignal(roleSignal('vtp'));
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'CANCEL_OPEN' }),
        'CANCEL_OPEN:1',
      );
    });

    it('with no store wired, a role-scoped signal is a safe no-op — never a side-wide cancel it did not ask for', async () => {
      // Both shapes of "no lookup available": the @Optional injection absent entirely, and a store
      // that does not implement the (optional) method. Each must resolve 'unknown', which matches no
      // requested role — the failure direction is toward cancelling NOTHING, never toward cancelling
      // orders the signal deliberately narrowed away from.
      const noStore = makeSink(
        { status: 'GATEWAY_REJECTED', reason: 'DUPLICATE' },
        undefined,
        undefined,
        [vtp, vsl],
      );
      await noStore.sink.recordSignal(roleSignal('vtp'));
      expect(noStore.cancelled).toHaveLength(0);

      const methodless = makeSink(
        { status: 'GATEWAY_REJECTED', reason: 'DUPLICATE' },
        undefined,
        undefined,
        [vtp, vsl],
        {},
      );
      await methodless.sink.recordSignal(roleSignal('vtp'));
      expect(methodless.cancelled).toHaveLength(0);
    });

    it('an order whose intent the store cannot resolve stays resting under a role filter', async () => {
      // A foreign or already-pruned order: no intent row ⇒ no dedupeKey lineage ⇒ 'unknown'.
      const { sink, cancelled } = makeSink(
        { status: 'GATEWAY_REJECTED', reason: 'DUPLICATE' },
        undefined,
        undefined,
        [vtp, vsl],
        roleStore({}),
      );
      await sink.recordSignal(roleSignal('vtp'));
      expect(cancelled).toHaveLength(0);
    });

    it('a store failure fails open to unknown — nothing cancels and the signal still completes', async () => {
      const { sink, cancelled } = makeSink(
        { status: 'GATEWAY_REJECTED', reason: 'DUPLICATE' },
        undefined,
        undefined,
        [vtp, vsl],
        { loadIntentByClientOrderId: () => Promise.reject(new Error('order_intents unavailable')) },
      );
      await expect(sink.recordSignal(roleSignal('vtp'))).resolves.toBeUndefined();
      expect(cancelled).toHaveLength(0);
    });

    it('absent cancelRole cancels every side-matching order even with a store wired (regression pin)', async () => {
      const { sink, cancelled } = makeSink(
        { status: 'GATEWAY_REJECTED', reason: 'DUPLICATE' },
        undefined,
        undefined,
        [vtp, vsl],
        bothRoles(),
      );
      await sink.recordSignal({ ...cancelSignal(), cancelSide: 'SELL' });
      expect(cancelled).toHaveLength(2);
    });
  });

  describe('cancelBeforeSubmit (Defect B #49): compound atomic cancel-then-exit', () => {
    const restingSell = openOrder(undefined, '9', 'SELL');
    const compoundSignal = () => ({
      ...signal(),
      kind: 'EXIT_LONG' as const,
      cancelBeforeSubmit: { side: 'SELL' as const },
    });

    it('cancels the side-matching resting order strictly before the exit submits (call order)', async () => {
      const order: string[] = [];
      const gateway: SignalGatewayPort = {
        accept: () => ({
          status: 'DECIDED',
          decision: { verdict: 'APPROVED', approved: approved() },
        }),
      };
      const portfolio: PortfolioViewPort = {
        snapshot: () => ({}) as PortfolioSnapshot,
        forStrategy: () => ({ strategyId: SID, positions: new Map(), openOrders: [restingSell] }),
      };
      const gate: ExecutionGatePort = {
        submit: (a) => {
          order.push('submit');
          return Promise.resolve({
            clientOrderId: a.intent.clientOrderId,
            outcome: 'SUBMITTED',
          } as SubmitAck);
        },
        cancel: (coid) => {
          order.push(`cancel:${coid}`);
          return Promise.resolve();
        },
        cancelAllFor: () => Promise.resolve(),
        flattenAll: () => Promise.resolve(),
      };
      const sink = new SignalSinkService(gateway, portfolio, gate);
      await sink.recordSignal(compoundSignal());
      expect(order).toEqual([`cancel:${restingSell.clientOrderId}`, 'submit']);
    });

    it('journals the cancel-before-exit count, then the exit outcome, for the ONE signal', async () => {
      const record = vi.fn();
      const journal: SignalJournalPort = { record };
      const { sink } = makeSink(
        { status: 'DECIDED', decision: { verdict: 'APPROVED', approved: approved() } },
        journal,
        undefined,
        [restingSell],
      );
      await sink.recordSignal(compoundSignal());
      // The cancel-step row journals under a DERIVED dedupeKey (`:cbe` suffix): signalId is
      // `${dedupeKey}:${eventTime}` and is the signals-table PRIMARY KEY — the same key on both
      // rows would collide and silently drop the APPROVED+intentId row (review 2026-07-17).
      expect(record.mock.calls[0]).toEqual([
        expect.objectContaining({ dedupeKey: 'k:cbe' }),
        'CANCEL_BEFORE_EXIT:1',
      ]);
      expect(record.mock.calls[1]).toEqual([
        expect.objectContaining({ dedupeKey: 'k' }),
        'APPROVED',
        approved().intent.intentId,
      ]);
    });

    it('a third same-key signal enqueued mid-processing lands AFTER the compound exit (no interleave)', async () => {
      const symX = symbolId('BTC/USDT');
      const order: string[] = [];
      let releaseCancel: () => void = () => {};
      const blockCancel = new Promise<void>((r) => {
        releaseCancel = r;
      });
      const approvedFor = (coid: string) =>
        mintApproval(makeIntent({ clientOrderId: clientOrderId(coid) }), Buffer.alloc(32, 1), {
          nonce: 'n',
          approvedAtMs: epochMs(0),
          limitsVersion: 'v1',
          snapshotSeq: 1n,
        });
      const gateway: SignalGatewayPort = {
        accept: (s) => ({
          status: 'DECIDED',
          decision: {
            verdict: 'APPROVED',
            approved: approvedFor(
              s.dedupeKey === 'first' ? 'cbp' + 'a'.repeat(32) : 'cbp' + 'b'.repeat(32),
            ),
          },
        }),
      };
      const portfolio: PortfolioViewPort = {
        snapshot: () => ({}) as PortfolioSnapshot,
        forStrategy: () => ({ strategyId: SID, positions: new Map(), openOrders: [restingSell] }),
      };
      const gate: ExecutionGatePort = {
        submit: (a) => {
          order.push(`submit:${a.intent.clientOrderId}`);
          return Promise.resolve({
            clientOrderId: a.intent.clientOrderId,
            outcome: 'SUBMITTED',
          } as SubmitAck);
        },
        cancel: async () => {
          order.push('cancel-start');
          await blockCancel;
          order.push('cancel-resolved');
        },
        cancelAllFor: () => Promise.resolve(),
        flattenAll: () => Promise.resolve(),
      };
      const sink = new SignalSinkService(gateway, portfolio, gate);

      const p1 = sink.recordSignal({ ...compoundSignal(), symbol: symX, dedupeKey: 'first' });
      // Let the first signal's cancel-before-submit start (and block) before the second same-key
      // signal is recorded — it must chain BEHIND the whole compound entry (one chain entry per
      // recordSignal call — see SignalSinkService's own `chains` comment), never slot in between
      // the cancel ack and the exit submit (the pre-fix two-recordSignal pairing's exact bug).
      await Promise.resolve();
      await Promise.resolve();
      const p2 = sink.recordSignal({ ...signal(), symbol: symX, dedupeKey: 'second' });

      releaseCancel();
      await Promise.all([p1, p2]);
      expect(order).toEqual([
        'cancel-start',
        'cancel-resolved',
        'submit:' + 'cbp' + 'a'.repeat(32),
        'submit:' + 'cbp' + 'b'.repeat(32),
      ]);
    });

    it('a cancel failure is caught — the exit still submits (fail OPEN toward the protective action)', async () => {
      const submitted: RiskApprovedIntent[] = [];
      const gateway: SignalGatewayPort = {
        accept: () => ({
          status: 'DECIDED',
          decision: { verdict: 'APPROVED', approved: approved() },
        }),
      };
      const portfolio: PortfolioViewPort = {
        snapshot: () => ({}) as PortfolioSnapshot,
        forStrategy: () => ({ strategyId: SID, positions: new Map(), openOrders: [restingSell] }),
      };
      const gate: ExecutionGatePort = {
        submit: (a) => {
          submitted.push(a);
          return Promise.resolve({
            clientOrderId: a.intent.clientOrderId,
            outcome: 'SUBMITTED',
          } as SubmitAck);
        },
        cancel: () => Promise.reject(new Error('venue cancel down')),
        cancelAllFor: () => Promise.resolve(),
        flattenAll: () => Promise.resolve(),
      };
      const sink = new SignalSinkService(gateway, portfolio, gate);
      await expect(sink.recordSignal(compoundSignal())).resolves.toBeUndefined();
      expect(submitted).toHaveLength(1);
    });

    it('absent cancelBeforeSubmit never cancels — byte-identical to pre-fix behavior (regression pin)', async () => {
      const { sink, submitted, cancelled } = makeSink(
        { status: 'DECIDED', decision: { verdict: 'APPROVED', approved: approved() } },
        undefined,
        undefined,
        [restingSell],
      );
      await sink.recordSignal(signal()); // no cancelBeforeSubmit field
      expect(cancelled).toHaveLength(0);
      expect(submitted).toHaveLength(1);
    });
  });

  describe('per-(strategyId,symbol) serialization', () => {
    it('a slow signal does not let a later concurrent signal for the same symbol overtake it', async () => {
      const symX = symbolId('BTC/USDT');
      const approvedFor = (coid: string) =>
        mintApproval(makeIntent({ clientOrderId: clientOrderId(coid) }), Buffer.alloc(32, 1), {
          nonce: 'n',
          approvedAtMs: epochMs(0),
          limitsVersion: 'v1',
          snapshotSeq: 1n,
        });
      const submitted: string[] = [];
      const gateway: SignalGatewayPort = {
        accept: (s) => ({
          status: 'DECIDED',
          decision: {
            verdict: 'APPROVED',
            approved: approvedFor(
              s.dedupeKey === 'first' ? 'cbp' + 'a'.repeat(32) : 'cbp' + 'b'.repeat(32),
            ),
          },
        }),
      };
      const portfolio: PortfolioViewPort = {
        snapshot: () => ({}) as PortfolioSnapshot,
        forStrategy: () => ({ strategyId: SID, positions: new Map(), openOrders: [] }),
      };
      let releaseFirst: () => void = () => {};
      const blockFirst = new Promise<void>((r) => {
        releaseFirst = r;
      });
      const gate: ExecutionGatePort = {
        submit: async (a) => {
          if (a.intent.clientOrderId === 'cbp' + 'a'.repeat(32)) await blockFirst;
          submitted.push(a.intent.clientOrderId);
          return { clientOrderId: a.intent.clientOrderId, outcome: 'SUBMITTED' };
        },
        cancel: () => Promise.resolve(),
        cancelAllFor: () => Promise.resolve(),
        flattenAll: () => Promise.resolve(),
      };
      const sink = new SignalSinkService(gateway, portfolio, gate);

      const p1 = sink.recordSignal({ ...signal(), symbol: symX, dedupeKey: 'first' });
      const p2 = sink.recordSignal({ ...signal(), symbol: symX, dedupeKey: 'second' });

      // The second call must not even reach submit yet — it is queued behind the first.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(submitted).toHaveLength(0);

      releaseFirst();
      await Promise.all([p1, p2]);
      expect(submitted).toEqual(['cbp' + 'a'.repeat(32), 'cbp' + 'b'.repeat(32)]);
    });

    it('does not serialize across different symbols — a blocked signal for one symbol never delays another', async () => {
      const symX = symbolId('BTC/USDT');
      const symY = symbolId('ETH/USDT');
      const submitted: string[] = [];
      const approvedFor = (symbol: typeof symX) =>
        mintApproval(makeIntent({ symbol }), Buffer.alloc(32, 1), {
          nonce: 'n',
          approvedAtMs: epochMs(0),
          limitsVersion: 'v1',
          snapshotSeq: 1n,
        });
      const gateway: SignalGatewayPort = {
        accept: (s) => ({
          status: 'DECIDED',
          decision: { verdict: 'APPROVED', approved: approvedFor(s.symbol) },
        }),
      };
      const portfolio: PortfolioViewPort = {
        snapshot: () => ({}) as PortfolioSnapshot,
        forStrategy: () => ({ strategyId: SID, positions: new Map(), openOrders: [] }),
      };
      let releaseX: () => void = () => {};
      const blockX = new Promise<void>((r) => {
        releaseX = r;
      });
      const gate: ExecutionGatePort = {
        submit: async (a) => {
          if (a.intent.symbol === symX) await blockX;
          submitted.push(a.intent.symbol);
          return { clientOrderId: a.intent.clientOrderId, outcome: 'SUBMITTED' };
        },
        cancel: () => Promise.resolve(),
        cancelAllFor: () => Promise.resolve(),
        flattenAll: () => Promise.resolve(),
      };
      const sink = new SignalSinkService(gateway, portfolio, gate);

      const pX = sink.recordSignal({ ...signal(), symbol: symX });
      const pY = sink.recordSignal({ ...signal(), symbol: symY });

      await pY; // resolves even though X is still blocked
      expect(submitted).toEqual([symY]);

      releaseX();
      await pX;
      expect(submitted).toEqual([symY, symX]);
    });

    it('a rejected signal never wedges the chain — the one queued behind it still processes', async () => {
      // The tail promise stored in the map is the CAUGHT one; only the caller's own handle rejects.
      // Without that, one failed submit would strand every later signal for the same key forever.
      const symX = symbolId('BTC/USDT');
      const submitted: string[] = [];
      const gateway: SignalGatewayPort = {
        accept: () => ({
          status: 'DECIDED',
          decision: { verdict: 'APPROVED', approved: approved() },
        }),
      };
      const portfolio: PortfolioViewPort = {
        snapshot: () => ({}) as PortfolioSnapshot,
        forStrategy: () => ({ strategyId: SID, positions: new Map(), openOrders: [] }),
      };
      let attempts = 0;
      const gate: ExecutionGatePort = {
        submit: (a) => {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new Error('venue submit blew up'));
          submitted.push(a.intent.clientOrderId);
          return Promise.resolve({
            clientOrderId: a.intent.clientOrderId,
            outcome: 'SUBMITTED',
          } as SubmitAck);
        },
        cancel: () => Promise.resolve(),
        cancelAllFor: () => Promise.resolve(),
        flattenAll: () => Promise.resolve(),
      };
      const sink = new SignalSinkService(gateway, portfolio, gate);

      // Both enqueued before either settles, so the second genuinely chains onto the failing tail.
      const p1 = sink.recordSignal({ ...signal(), symbol: symX, dedupeKey: 'first' });
      const p2 = sink.recordSignal({ ...signal(), symbol: symX, dedupeKey: 'second' });

      await expect(p1).rejects.toThrow('venue submit blew up');
      await expect(p2).resolves.toBeUndefined();
      expect(submitted).toEqual([approved().intent.clientOrderId]);

      // And the key is releasable afterwards: a later signal for it still reaches the gate.
      await sink.recordSignal({ ...signal(), symbol: symX, dedupeKey: 'third' });
      expect(submitted).toHaveLength(2);
    });
  });
});
