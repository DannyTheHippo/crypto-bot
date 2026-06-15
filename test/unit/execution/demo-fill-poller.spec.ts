import { describe, it, expect } from 'vitest';
import { DemoFillPollerService } from '../../../src/modules/execution/demo-fill-poller.service';
import type { OrderBookService } from '../../../src/modules/execution/order-book.service';
import type {
  FillIngestorService,
  IngestResult,
} from '../../../src/modules/execution/fill-ingestor.service';
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

function build(trades: VenueFill[], localOrders: OrderRecord[], applied = true) {
  const ingested: FillRecord[] = [];
  const sinceCalls: number[] = [];
  const clock = { now: () => epochMs(T) };
  const exchange = {
    fetchMyTrades: (...args: unknown[]) => {
      sinceCalls.push(args[1] as number); // capture the `since` passed each poll
      return Promise.resolve(trades);
    },
  } as unknown as ExchangePort;
  const orders = { all: () => localOrders } as unknown as OrderBookService;
  const ingestor = {
    ingest: (rec: OrderRecord, f: FillRecord): Promise<IngestResult> => {
      ingested.push(f);
      return Promise.resolve({ applied, record: rec });
    },
  } as unknown as FillIngestorService;
  return {
    poller: new DemoFillPollerService(clock, exchange, orders, ingestor),
    ingested,
    sinceCalls,
  };
}

const localOrder = (over: Partial<OrderRecord> = {}): OrderRecord =>
  ({
    clientOrderId: OUR,
    venueOrderId: VENUE_ID,
    state: 'ACKED',
    cumQty: epochMs(0) as never,
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
});
