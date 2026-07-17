import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import { DemoFillPollerService } from '../../../src/features/trading/execution/demo-fill-poller.service';
import type { OrderBookService } from '../../../src/features/trading/execution/order-book.service';
import type {
  FillIngestorService,
  IngestResult,
} from '../../../src/features/trading/execution/fill-ingestor.service';
import type { AlgoStopRecoveryService } from '../../../src/features/trading/execution/algo-stop-recovery.service';
import type { ExchangePort, VenueFill } from '../../../src/ports/exchange';
import type { OrderRecord } from '../../../src/domain/oms/reducer';
import type { FillRecord } from '../../../src/domain/types/exec-report';
import {
  venueId,
  symbolId,
  epochMs,
  encodeClientOrderId,
  intentId,
  clientOrderId,
  type ClientOrderId,
} from '../../../src/domain/types/ids';

const T = 1_700_000_000_000;
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');
const OUR = encodeClientOrderId(intentId('0190abcd-1234-7abc-89ab-0123456789ab'), 'testnet');
const VENUE_ID = 'venue-777';

// VenueFill.clientOrderId carries the VENUE order id (ccxt trade.order), so a fill references our
// order by the venue id we recorded on the ACK.
function fill(
  over: Partial<VenueFill> & { clientOrderId: ClientOrderId; venueTradeId: string },
): VenueFill {
  return {
    venue: V,
    symbol: SYM,
    price: '100',
    qty: '0.01',
    fee: { ccy: 'USDT', amount: '0.01' },
    liquidity: 'maker',
    venueTimestamp: epochMs(T + 1),
    ...over,
  };
}

// Default: no symbol carries an algo anchor, so recoverSymbol is never reached — every
// pre-existing test (none of which know about Defect A recovery) stays byte-identical. The poller
// hook awaits hasAlgoAnchor (the async superset reaching a post-restart, store-rehydrated anchor,
// not just the in-flight map hasLiveAlgoIntent covers) — see algo-stop-recovery.service.ts.
function stubRecovery(
  over: Partial<{
    hasAlgoAnchor: (symbol: unknown) => boolean | Promise<boolean>;
    recoverSymbol: ReturnType<typeof vi.fn>;
  }> = {},
): AlgoStopRecoveryService {
  return {
    hasAlgoAnchor: over.hasAlgoAnchor ?? (() => false),
    recoverSymbol: over.recoverSymbol ?? vi.fn().mockResolvedValue('none'),
  } as unknown as AlgoStopRecoveryService;
}

function build(
  trades: VenueFill[],
  localOrders: OrderRecord[],
  applied = true,
  recovery: AlgoStopRecoveryService = stubRecovery(),
) {
  const ingested: FillRecord[] = [];
  const foldedFrom: OrderRecord[] = [];
  const sinceCalls: number[] = [];
  const clock = { now: () => epochMs(T) };
  const exchange = {
    fetchMyTrades: (...args: unknown[]) => {
      sinceCalls.push(args[1] as number); // capture the `since` passed each poll
      return Promise.resolve(trades);
    },
  } as unknown as ExchangePort;
  // Live book mock: get() serves the committed record, and the ingestor mock commits its fold
  // result back — mirroring FillIngestor's reduce → journal → OrderBook.commit pipeline so the
  // poller's live-record lookup (not the per-poll snapshot) is what the assertions observe.
  const book = new Map<string, OrderRecord>(localOrders.map((o) => [String(o.clientOrderId), o]));
  const orders = {
    all: () => localOrders,
    get: (coid: ClientOrderId) => book.get(String(coid)),
  } as unknown as OrderBookService;
  const ingestor = {
    ingest: (rec: OrderRecord, f: FillRecord): Promise<IngestResult> => {
      ingested.push(f);
      foldedFrom.push(rec);
      if (!applied) return Promise.resolve({ applied, record: rec }); // duplicate: no fold, no commit
      const next = { ...rec, cumQty: rec.cumQty.add(f.qty) } as OrderRecord;
      book.set(String(rec.clientOrderId), next);
      return Promise.resolve({ applied, record: next });
    },
  } as unknown as FillIngestorService;
  return {
    poller: new DemoFillPollerService(clock, exchange, orders, ingestor, recovery),
    ingested,
    foldedFrom,
    sinceCalls,
    book,
  };
}

const localOrder = (over: Partial<OrderRecord> = {}): OrderRecord =>
  ({
    clientOrderId: OUR,
    venueOrderId: VENUE_ID,
    state: 'ACKED',
    cumQty: new Decimal(0),
    ...over,
  }) as unknown as OrderRecord;

describe('DemoFillPollerService', () => {
  it('matches a fill to the local order by venue order id and ingests under the local clientOrderId', async () => {
    const { poller, ingested } = build(
      [fill({ clientOrderId: clientOrderId(VENUE_ID), venueTradeId: 't1' })],
      [localOrder()],
    );
    poller.init();
    const r = await poller.poll([SYM]);
    expect(r).toEqual({ ingested: 1, skippedUnknown: 0 });
    expect(ingested[0]?.clientOrderId).toBe(OUR); // ingested under the LOCAL coid, not the venue id
    expect(ingested[0]?.price.toFixed()).toBe('100');
    expect(ingested[0]?.fee?.amount.toFixed()).toBe('0.01');
    expect(ingested[0]?.source).toBe('rest_reconcile');
  });

  it('maps a null-fee fill', async () => {
    const { poller, ingested } = build(
      [fill({ clientOrderId: clientOrderId(VENUE_ID), venueTradeId: 't2', fee: null })],
      [localOrder()],
    );
    const r = await poller.poll([SYM]);
    expect(r.ingested).toBe(1);
    expect(ingested[0]?.fee).toBeNull();
  });

  it('counts a fill with no matching local order as skippedUnknown (foreign / pre-boot)', async () => {
    const { poller, ingested } = build(
      [fill({ clientOrderId: clientOrderId('other-venue-id'), venueTradeId: 't3' })],
      [localOrder()],
    );
    const r = await poller.poll([SYM]);
    expect(r).toEqual({ ingested: 0, skippedUnknown: 1 });
    expect(ingested).toHaveLength(0);
  });

  it('ignores local orders without a venue id and does not count a duplicate fill', async () => {
    const { poller } = build(
      [fill({ clientOrderId: clientOrderId(VENUE_ID), venueTradeId: 't4' })],
      [localOrder({ venueOrderId: undefined }), localOrder()], // first has no venueOrderId (skipped in index)
      false, // ingest reports duplicate
    );
    const r = await poller.poll([SYM]);
    expect(r).toEqual({ ingested: 0, skippedUnknown: 0 }); // matched but applied=false ⇒ not counted
  });

  it('advances the sweep watermark to the newest trade so the next poll fetches from there (no unbounded re-fetch)', async () => {
    const { poller, sinceCalls } = build(
      [
        fill({
          clientOrderId: clientOrderId(VENUE_ID),
          venueTradeId: 't5',
          venueTimestamp: epochMs(T + 50),
        }),
      ],
      [localOrder()],
    );
    poller.init(); // anchors since = now = T
    await poller.poll([SYM]);
    await poller.poll([SYM]);
    expect(sinceCalls[0]).toBe(T); // first poll swept from boot
    expect(sinceCalls[1]).toBe(T + 50); // second poll swept from the newest trade seen, not boot
  });

  it('keeps the highest timestamp as the watermark when a later trade in the batch is older', async () => {
    const { poller, sinceCalls } = build(
      [
        fill({
          clientOrderId: clientOrderId(VENUE_ID),
          venueTradeId: 't6',
          venueTimestamp: epochMs(T + 90),
        }),
        fill({
          clientOrderId: clientOrderId(VENUE_ID),
          venueTradeId: 't7',
          venueTimestamp: epochMs(T + 20),
        }), // older, must not lower it
      ],
      [localOrder()],
    );
    poller.init();
    await poller.poll([SYM]);
    await poller.poll([SYM]);
    expect(sinceCalls[1]).toBe(T + 90);
  });

  it('leaves the watermark unchanged when a poll returns no trades', async () => {
    const { poller, sinceCalls } = build([], [localOrder()]);
    poller.init();
    await poller.poll([SYM]);
    await poller.poll([SYM]);
    expect(sinceCalls).toEqual([T, T]); // no trades ⇒ since stays anchored at boot
  });

  // 2026-07-11 regression: three partials of ONE order arrived in ONE poll; each folded from the
  // per-poll snapshot (cumQty 0), journaling non-monotone FILL events and regressing the book —
  // the venue-FILLED order stranded non-terminal and the TTL sweep "cancelled" it into
  // RECONCILE_REQUIRED. The poller must fold every fill from the LIVE book record.
  it('folds multiple partials of the same order in one poll from the live record, not the snapshot', async () => {
    const { poller, foldedFrom, book } = build(
      [
        fill({ clientOrderId: clientOrderId(VENUE_ID), venueTradeId: 'p1', qty: '1.99' }),
        fill({ clientOrderId: clientOrderId(VENUE_ID), venueTradeId: 'p2', qty: '1.99' }),
        fill({ clientOrderId: clientOrderId(VENUE_ID), venueTradeId: 'p3', qty: '1.67' }),
      ],
      [localOrder()],
    );
    poller.init();
    const r = await poller.poll([SYM]);
    expect(r.ingested).toBe(3);
    // Each fold starts from the record the PREVIOUS fill produced — monotone, never the snapshot.
    expect(foldedFrom.map((rec) => rec.cumQty.toFixed())).toEqual(['0', '1.99', '3.98']);
    expect(book.get(String(OUR))?.cumQty.toFixed()).toBe('5.65');
  });

  // Defect A commit-1: the poller hook onto AlgoStopRecoveryService.
  describe('algo-stop recovery hook (Defect A)', () => {
    it('unmatched fill + live algo intent on the symbol: recoverSymbol invoked exactly once for it after the sweep', async () => {
      const recoverSymbol = vi.fn().mockResolvedValue('triggered');
      const recovery = stubRecovery({ hasAlgoAnchor: () => true, recoverSymbol });
      const { poller, ingested } = build(
        [fill({ clientOrderId: clientOrderId('other-venue-id'), venueTradeId: 't8' })],
        [localOrder()],
        true,
        recovery,
      );
      const r = await poller.poll([SYM]);
      expect(r).toEqual({ ingested: 0, skippedUnknown: 1 }); // skippedUnknown behavior unchanged
      expect(ingested).toHaveLength(0);
      expect(recoverSymbol).toHaveBeenCalledTimes(1);
      expect(recoverSymbol).toHaveBeenCalledWith(SYM);
    });

    it('unmatched fill with NO live algo intent: recoverSymbol not called, skippedUnknown unchanged', async () => {
      const recoverSymbol = vi.fn().mockResolvedValue('none');
      const recovery = stubRecovery({ hasAlgoAnchor: () => false, recoverSymbol });
      const { poller, ingested } = build(
        [fill({ clientOrderId: clientOrderId('other-venue-id'), venueTradeId: 't9' })],
        [localOrder()],
        true,
        recovery,
      );
      const r = await poller.poll([SYM]);
      expect(r).toEqual({ ingested: 0, skippedUnknown: 1 });
      expect(ingested).toHaveLength(0);
      expect(recoverSymbol).not.toHaveBeenCalled();
    });

    it('recoverSymbol throwing does not break the poll or the watermark', async () => {
      const recoverSymbol = vi.fn().mockRejectedValue(new Error('venue down'));
      const recovery = stubRecovery({ hasAlgoAnchor: () => true, recoverSymbol });
      const { poller, ingested, sinceCalls } = build(
        [
          fill({
            clientOrderId: clientOrderId('other-venue-id'),
            venueTradeId: 't10',
            venueTimestamp: epochMs(T + 30),
          }),
        ],
        [localOrder()],
        true,
        recovery,
      );
      poller.init(); // anchors since = now = T
      const r = await poller.poll([SYM]);
      expect(r).toEqual({ ingested: 0, skippedUnknown: 1 });
      expect(ingested).toHaveLength(0);
      expect(recoverSymbol).toHaveBeenCalledTimes(1);
      await poller.poll([SYM]);
      expect(sinceCalls[1]).toBe(T + 30); // watermark advanced despite the recovery throw
    });

    it('hasAlgoAnchor throwing does not abort the poll (fail OPEN: treated as not-anchored this pass, retried next poll)', async () => {
      const recoverSymbol = vi.fn().mockResolvedValue('none');
      const hasAlgoAnchor = vi.fn().mockRejectedValue(new Error('store down'));
      const recovery = stubRecovery({ hasAlgoAnchor, recoverSymbol });
      const { poller, ingested } = build(
        [fill({ clientOrderId: clientOrderId('other-venue-id'), venueTradeId: 't11' })],
        [localOrder()],
        true,
        recovery,
      );
      const r = await poller.poll([SYM]);
      expect(r).toEqual({ ingested: 0, skippedUnknown: 1 }); // poll completes despite the throw
      expect(ingested).toHaveLength(0);
      expect(hasAlgoAnchor).toHaveBeenCalledTimes(1);
      // Not-anchored this pass (fail OPEN = skip, matching the file's per-symbol tolerance
      // elsewhere) ⇒ never added to algoSuspects ⇒ recoverSymbol never reached.
      expect(recoverSymbol).not.toHaveBeenCalled();
    });
  });
});
