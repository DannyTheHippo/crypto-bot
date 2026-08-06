import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { DemoFillPollerService } from '../../../../src/features/trading/execution/demo-fill-poller.service';
import type { OrderBookService } from '../../../../src/features/trading/execution/order-book.service';
import type {
  FillIngestorService,
  IngestResult,
} from '../../../../src/features/trading/execution/fill-ingestor.service';
import type { AlgoStopRecoveryService } from '../../../../src/features/trading/execution/algo-stop-recovery.service';
import type { ExchangePort, VenueFill } from '../../../../src/ports/venue/exchange';
import { VENUE_TIMESTAMP_SKEW_ALLOWANCE_MS } from '../../../../src/ports/trading/execution';
import type { OrderRecord } from '../../../../src/domain/trading/oms/reducer';
import type { FillRecord } from '../../../../src/domain/trading/types/exec-report';
import {
  venueId,
  symbolId,
  epochMs,
  encodeClientOrderId,
  intentId,
  clientOrderId,
  type ClientOrderId,
} from '../../../../src/domain/common/types/ids';

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
    venue: V,
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
    const r = await poller.poll(V, [SYM]);
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
    const r = await poller.poll(V, [SYM]);
    expect(r.ingested).toBe(1);
    expect(ingested[0]?.fee).toBeNull();
  });

  it('counts a fill with no matching local order as skippedUnknown (foreign / pre-boot)', async () => {
    const { poller, ingested } = build(
      [fill({ clientOrderId: clientOrderId('other-venue-id'), venueTradeId: 't3' })],
      [localOrder()],
    );
    const r = await poller.poll(V, [SYM]);
    expect(r).toEqual({ ingested: 0, skippedUnknown: 1 });
    expect(ingested).toHaveLength(0);
  });

  it('ignores local orders without a venue id and does not count a duplicate fill', async () => {
    const { poller } = build(
      [fill({ clientOrderId: clientOrderId(VENUE_ID), venueTradeId: 't4' })],
      [localOrder({ venueOrderId: undefined }), localOrder()], // first has no venueOrderId (skipped in index)
      false, // ingest reports duplicate
    );
    const r = await poller.poll(V, [SYM]);
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
    await poller.poll(V, [SYM]);
    await poller.poll(V, [SYM]);
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
    await poller.poll(V, [SYM]);
    await poller.poll(V, [SYM]);
    expect(sinceCalls[1]).toBe(T + 90);
  });

  // The watermark is MONOTONE, so a single unbounded-future venueTimestamp used to pin it past every
  // real trade permanently and every later fill was swept out of the `since` window forever.
  // ccxt-normalize.ts only range-checks finite-integer, never an upper bound. The fill still ingests
  // (dropping a real fill would be the worse error); only the watermark refuses to follow the stamp.
  it('a fill stamped 10 years in the future still ingests, but the watermark stops at now + skew allowance', async () => {
    const TEN_YEARS_MS = 10 * 365 * 86_400_000;
    const { poller, ingested, sinceCalls } = build(
      [
        fill({
          clientOrderId: clientOrderId(VENUE_ID),
          venueTradeId: 'future-1',
          venueTimestamp: epochMs(T + TEN_YEARS_MS),
        }),
      ],
      [localOrder()],
    );
    poller.init();
    const r = await poller.poll(V, [SYM]);
    expect(r).toEqual({ ingested: 1, skippedUnknown: 0 }); // the fill itself is NOT dropped
    expect(ingested[0]?.venueTimestamp).toBe(T + TEN_YEARS_MS); // recorded verbatim, unclamped
    await poller.poll(V, [SYM]);
    expect(sinceCalls[1]).toBe(T + VENUE_TIMESTAMP_SKEW_ALLOWANCE_MS); // exact ceiling, not the stamp
  });

  // The allowance is a tolerance band, not a ceiling on ordinary progress: a trade a few seconds
  // ahead of our clock (venue/host skew) must still advance the watermark to its own stamp.
  it('a trade inside the skew allowance advances the watermark to its own timestamp, unclamped', async () => {
    const { poller, sinceCalls } = build(
      [
        fill({
          clientOrderId: clientOrderId(VENUE_ID),
          venueTradeId: 'skewed-1',
          venueTimestamp: epochMs(T + 5_000),
        }),
      ],
      [localOrder()],
    );
    poller.init();
    await poller.poll(V, [SYM]);
    await poller.poll(V, [SYM]);
    expect(sinceCalls[1]).toBe(T + 5_000);
  });

  it('leaves the watermark unchanged when a poll returns no trades', async () => {
    const { poller, sinceCalls } = build([], [localOrder()]);
    poller.init();
    await poller.poll(V, [SYM]);
    await poller.poll(V, [SYM]);
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
    const r = await poller.poll(V, [SYM]);
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
      const r = await poller.poll(V, [SYM]);
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
      const r = await poller.poll(V, [SYM]);
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
      const r = await poller.poll(V, [SYM]);
      expect(r).toEqual({ ingested: 0, skippedUnknown: 1 });
      expect(ingested).toHaveLength(0);
      expect(recoverSymbol).toHaveBeenCalledTimes(1);
      await poller.poll(V, [SYM]);
      expect(sinceCalls[1]).toBe(T + 30); // watermark advanced despite the recovery throw
    });

    // A rejected ccxt/pg promise is not always an Error (drivers reject with plain strings and
    // objects) — the fail-OPEN catch must survive that shape too, not just Error.
    it('recoverSymbol rejecting with a non-Error value is still tolerated', async () => {
      const recoverSymbol = vi.fn().mockRejectedValue('venue down');
      const recovery = stubRecovery({ hasAlgoAnchor: () => true, recoverSymbol });
      const { poller, sinceCalls } = build(
        [
          fill({
            clientOrderId: clientOrderId('other-venue-id'),
            venueTradeId: 't12',
            venueTimestamp: epochMs(T + 40),
          }),
        ],
        [localOrder()],
        true,
        recovery,
      );
      poller.init();
      const r = await poller.poll(V, [SYM]);
      expect(r).toEqual({ ingested: 0, skippedUnknown: 1 });
      expect(recoverSymbol).toHaveBeenCalledTimes(1);
      await poller.poll(V, [SYM]);
      expect(sinceCalls[1]).toBe(T + 40); // watermark advanced despite the non-Error rejection
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
      const r = await poller.poll(V, [SYM]);
      expect(r).toEqual({ ingested: 0, skippedUnknown: 1 }); // poll completes despite the throw
      expect(ingested).toHaveLength(0);
      expect(hasAlgoAnchor).toHaveBeenCalledTimes(1);
      // Not-anchored this pass (fail OPEN = skip, matching the file's per-symbol tolerance
      // elsewhere) ⇒ never added to algoSuspects ⇒ recoverSymbol never reached.
      expect(recoverSymbol).not.toHaveBeenCalled();
    });

    it('hasAlgoAnchor rejecting with a non-Error value is still tolerated', async () => {
      const recoverSymbol = vi.fn().mockResolvedValue('none');
      const hasAlgoAnchor = vi.fn().mockRejectedValue('store down');
      const recovery = stubRecovery({ hasAlgoAnchor, recoverSymbol });
      const { poller, ingested } = build(
        [fill({ clientOrderId: clientOrderId('other-venue-id'), venueTradeId: 't13' })],
        [localOrder()],
        true,
        recovery,
      );
      const r = await poller.poll(V, [SYM]);
      expect(r).toEqual({ ingested: 0, skippedUnknown: 1 });
      expect(ingested).toHaveLength(0);
      expect(recoverSymbol).not.toHaveBeenCalled(); // not-anchored this pass, same as the Error case
    });
  });

  // v3 §1.5: poll(venue, symbols) resolves the exchange port for THAT venue from VENUE_EXCHANGE_PORTS
  // and tracks its own sweep watermark, independent of any other venue's.
  describe('v3 multi-venue routing', () => {
    const PERP = venueId('binanceusdm');

    function buildMultiVenue() {
      const clock = { now: () => epochMs(T) };
      const spotSince: number[] = [];
      const perpSince: number[] = [];
      const spotPort = {
        venue: V,
        fetchMyTrades: (...args: unknown[]) => {
          spotSince.push(args[1] as number);
          return Promise.resolve([]);
        },
      } as unknown as ExchangePort;
      const perpPort = {
        venue: PERP,
        fetchMyTrades: (...args: unknown[]) => {
          perpSince.push(args[1] as number);
          return Promise.resolve([]);
        },
      } as unknown as ExchangePort;
      const orders = { all: () => [], get: () => undefined } as unknown as OrderBookService;
      const ingestor = {} as unknown as FillIngestorService;
      const recovery = stubRecovery();
      const poller = new DemoFillPollerService(
        clock,
        spotPort, // legacy single-venue slot — unused whenever VENUE_EXCHANGE_PORTS resolves the venue
        orders,
        ingestor,
        recovery,
        new Map([
          [V, spotPort],
          [PERP, perpPort],
        ]),
      );
      return { poller, spotSince, perpSince };
    }

    it('polls each venue against its OWN exchange port', async () => {
      const { poller, spotSince, perpSince } = buildMultiVenue();
      poller.init();
      await poller.poll(V, [SYM]);
      await poller.poll(PERP, [symbolId('BTC/USDT:USDT')]);
      expect(spotSince).toHaveLength(1);
      expect(perpSince).toHaveLength(1);
    });

    it('tracks independent watermarks per venue — one venue advancing never affects the other', async () => {
      const { poller, spotSince, perpSince } = buildMultiVenue();
      poller.init();
      await poller.poll(V, [SYM]); // since = T (boot anchor)
      await poller.poll(V, [SYM]); // since still T (no trades to advance it in this fixture)
      await poller.poll(PERP, [symbolId('BTC/USDT:USDT')]); // first perp poll — its own boot anchor
      expect(spotSince).toEqual([T, T]);
      expect(perpSince).toEqual([T]);
    });

    it('an unregistered venue is skipped (logged, never throws)', async () => {
      const { poller } = buildMultiVenue();
      poller.init();
      const r = await poller.poll(venueId('unknown-venue'), [SYM]);
      expect(r).toEqual({ ingested: 0, skippedUnknown: 0 });
    });
  });

  // LIVE INCIDENT 2026-08-05/06: binanceusdm's userTrades endpoint threw ExchangeNotAvailable on
  // ~29% of calls for ~10.7h; the unguarded fetchMyTrades in the per-symbol loop aborted the whole
  // venue poll on ANY one symbol's throw, starving the algoSuspects -> recoverSymbol() loop for
  // hours and leaving two venue-fired stop fills un-ingested (phantom local shorts). These pin the
  // per-symbol isolation and its load-bearing watermark guard.
  describe('per-symbol fetchMyTrades isolation (2026-08-05/06 incident)', () => {
    const SYM_A = symbolId('BTC/USDT');
    const SYM_B = symbolId('ETH/USDT');

    // `string` covers a rejection that is not an Error — ccxt/network drivers reject with plain
    // strings too (same non-Error-rejection shape the recoverSymbol/hasAlgoAnchor tests above pin).
    type SymbolResponse = VenueFill[] | Error | string | (() => VenueFill[] | Error | string);

    // Own fixture, not the top-level `build()`: that helper returns the SAME `trades` array for
    // every symbol polled, which cannot express "this symbol throws, that one doesn't" or "this
    // symbol's first call throws, its retry succeeds" (needed for the partial-poll-then-clean-poll
    // case below). The ingestor fake dedupes on venueTradeId — mirroring FillIngestorService's own
    // idempotency — so a trade re-fetched across polls (the watermark-guard's intended retry path)
    // is provably ingested once, not just fetched once.
    function buildIsolation(opts: {
      bySymbol: Record<string, SymbolResponse>;
      localOrders: OrderRecord[];
      recovery?: AlgoStopRecoveryService;
    }) {
      const ingested: FillRecord[] = [];
      const sinceCalls: number[] = [];
      const seenTradeIds = new Set<string>();
      const clock = { now: () => epochMs(T) };
      const book = new Map<string, OrderRecord>(
        opts.localOrders.map((o) => [String(o.clientOrderId), o]),
      );
      const orders = {
        all: () => opts.localOrders,
        get: (coid: ClientOrderId) => book.get(String(coid)),
      } as unknown as OrderBookService;
      const ingestor = {
        ingest: (rec: OrderRecord, f: FillRecord): Promise<IngestResult> => {
          if (seenTradeIds.has(f.venueTradeId)) {
            return Promise.resolve({ applied: false, record: rec }); // duplicate — dedupe holds
          }
          seenTradeIds.add(f.venueTradeId);
          ingested.push(f);
          const next = { ...rec, cumQty: rec.cumQty.add(f.qty) } as OrderRecord;
          book.set(String(rec.clientOrderId), next);
          return Promise.resolve({ applied: true, record: next });
        },
      } as unknown as FillIngestorService;
      const exchange = {
        venue: V,
        fetchMyTrades: (symbol: unknown, since: unknown) => {
          sinceCalls.push(since as number);
          const entry = opts.bySymbol[String(symbol)];
          const resolved = typeof entry === 'function' ? entry() : entry;
          if (resolved instanceof Error || typeof resolved === 'string') {
            // Rejecting with a BARE STRING is the behaviour under test, not an oversight: the
            // production catch renders `err instanceof Error ? err.message : String(err)`, and the
            // `String(err)` arm is only reachable from a non-Error rejection. ccxt and the venue
            // transport can both reject with a plain string, so this fixture reproduces a real
            // shape. Satisfying the rule by wrapping in an Error would delete the only coverage of
            // that arm and reopen the 100%-branch gap on src/features/trading/execution/** that
            // this test exists to close.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            return Promise.reject(resolved);
          }
          return Promise.resolve(resolved ?? []);
        },
      } as unknown as ExchangePort;
      const poller = new DemoFillPollerService(
        clock,
        exchange,
        orders,
        ingestor,
        opts.recovery ?? stubRecovery(),
      );
      return { poller, ingested, sinceCalls };
    }

    it('one symbol throwing does not prevent the remaining symbols being polled, and their fills are still ingested', async () => {
      const { poller, ingested } = buildIsolation({
        bySymbol: {
          [SYM_A]: new Error('ExchangeNotAvailable: 502 Bad Gateway'),
          [SYM_B]: [
            fill({ clientOrderId: clientOrderId(VENUE_ID), venueTradeId: 'b1', symbol: SYM_B }),
          ],
        },
        localOrders: [localOrder()],
      });
      const r = await poller.poll(V, [SYM_A, SYM_B]);
      expect(r.ingested).toBe(1);
      expect(ingested[0]?.venueTradeId).toBe('b1');
    });

    it('one symbol throwing does not prevent the algoSuspects recovery loop from running for symbols that did succeed', async () => {
      const recoverSymbol = vi.fn().mockResolvedValue('triggered');
      const recovery = stubRecovery({ hasAlgoAnchor: () => true, recoverSymbol });
      const { poller } = buildIsolation({
        bySymbol: {
          [SYM_A]: new Error('ExchangeNotAvailable: 502 Bad Gateway'),
          [SYM_B]: [
            fill({
              clientOrderId: clientOrderId('other-venue-id'),
              venueTradeId: 'b2',
              symbol: SYM_B,
            }),
          ],
        },
        localOrders: [localOrder()],
        recovery,
      });
      const r = await poller.poll(V, [SYM_A, SYM_B]);
      expect(r.skippedUnknown).toBe(1); // SYM_B's unmatched fill is the phantom-position signature
      expect(recoverSymbol).toHaveBeenCalledTimes(1);
      expect(recoverSymbol).toHaveBeenCalledWith(SYM_B);
    });

    // Load-bearing: sinceByVenue is per-VENUE, so advancing it while SYM_A was skipped would move
    // the window past trades SYM_A never got to report.
    it('the watermark does NOT advance when any symbol was skipped', async () => {
      const { poller, sinceCalls } = buildIsolation({
        bySymbol: {
          [SYM_A]: new Error('ExchangeNotAvailable: 502 Bad Gateway'),
          [SYM_B]: [
            fill({
              clientOrderId: clientOrderId(VENUE_ID),
              venueTradeId: 'b3',
              symbol: SYM_B,
              venueTimestamp: epochMs(T + 500),
            }),
          ],
        },
        localOrders: [localOrder()],
      });
      poller.init(); // since = T
      await poller.poll(V, [SYM_A, SYM_B]); // SYM_A throws, SYM_B sees a newer trade
      sinceCalls.length = 0;
      await poller.poll(V, [SYM_A, SYM_B]);
      expect(sinceCalls).toEqual([T, T]); // still the boot anchor, not T + 500
    });

    // A rejected ccxt/network promise is not always an Error (drivers reject with plain strings and
    // objects too) — the fetchMyTrades catch's `err instanceof Error ? err.message : String(err)`
    // must survive that shape, same as the recoverSymbol/hasAlgoAnchor non-Error tests above.
    it('fetchMyTrades rejecting with a non-Error value is still tolerated — remaining symbols still polled, watermark held', async () => {
      const { poller, ingested, sinceCalls } = buildIsolation({
        bySymbol: {
          [SYM_A]: 'ECONNRESET', // non-Error rejection
          [SYM_B]: [
            fill({
              clientOrderId: clientOrderId(VENUE_ID),
              venueTradeId: 'b5',
              symbol: SYM_B,
              venueTimestamp: epochMs(T + 700),
            }),
          ],
        },
        localOrders: [localOrder()],
      });
      poller.init(); // since = T
      const r = await poller.poll(V, [SYM_A, SYM_B]);
      expect(r.ingested).toBe(1); // SYM_B still polled and ingested despite SYM_A's non-Error rejection
      expect(ingested[0]?.venueTradeId).toBe('b5');
      sinceCalls.length = 0;
      await poller.poll(V, [SYM_A, SYM_B]);
      expect(sinceCalls).toEqual([T, T]); // watermark held at the boot anchor, not advanced to T + 700
    });

    it('the watermark DOES advance on a fully-swept poll', async () => {
      const { poller, sinceCalls } = buildIsolation({
        bySymbol: {
          [SYM_A]: [
            fill({
              clientOrderId: clientOrderId(VENUE_ID),
              venueTradeId: 'a4',
              symbol: SYM_A,
              venueTimestamp: epochMs(T + 300),
            }),
          ],
          [SYM_B]: [],
        },
        localOrders: [localOrder()],
      });
      poller.init();
      await poller.poll(V, [SYM_A, SYM_B]);
      sinceCalls.length = 0;
      await poller.poll(V, [SYM_A, SYM_B]);
      expect(sinceCalls).toEqual([T + 300, T + 300]);
    });

    it('a partial poll followed by a clean poll ingests the previously-missed trade exactly once (dedupe holds)', async () => {
      const missedFill = fill({
        clientOrderId: clientOrderId(VENUE_ID),
        venueTradeId: 'missed-1',
        symbol: SYM_A,
        venueTimestamp: epochMs(T + 10),
      });
      let symAAttempts = 0;
      const { poller, ingested } = buildIsolation({
        bySymbol: {
          [SYM_A]: () => {
            symAAttempts += 1;
            if (symAAttempts === 1) throw new Error('ExchangeNotAvailable: 502 Bad Gateway');
            return [missedFill];
          },
          [SYM_B]: [],
        },
        localOrders: [localOrder()],
      });
      poller.init();
      const r1 = await poller.poll(V, [SYM_A, SYM_B]); // SYM_A throws — watermark held at boot
      expect(r1.ingested).toBe(0);
      const r2 = await poller.poll(V, [SYM_A, SYM_B]); // retried at the same `since` — recovers it
      expect(r2.ingested).toBe(1);
      const r3 = await poller.poll(V, [SYM_A, SYM_B]); // watermark now past it, but re-fetched anyway
      expect(r3.ingested).toBe(0); // dedupe holds even if re-fetched
      expect(ingested).toHaveLength(1);
      expect(ingested[0]?.venueTradeId).toBe('missed-1');
    });

    // FIX 4 (adversarial review, 2026-08-06): the clamp log's "sweep watermark clamped to ${maxTs}"
    // phrase used to fire unconditionally whenever clampedTrades > 0, even on a partial poll where
    // maxTs was computed but the WATERMARK GUARD above never wrote it to sinceByVenue — naming a
    // value that was never persisted. Pins the corrected, partial-poll branch of the wording (the
    // fully-swept "clamped to" branch is already covered by the top-level 10-years-future test).
    it('a partial poll logs "held at" the pre-poll watermark, never "clamped to" the discarded candidate', async () => {
      const TEN_YEARS_MS = 10 * 365 * 86_400_000;
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const { poller, sinceCalls } = buildIsolation({
          bySymbol: {
            [SYM_A]: new Error('ExchangeNotAvailable: 502 Bad Gateway'),
            [SYM_B]: [
              fill({
                clientOrderId: clientOrderId(VENUE_ID),
                venueTradeId: 'clamp-partial',
                symbol: SYM_B,
                venueTimestamp: epochMs(T + TEN_YEARS_MS),
              }),
            ],
          },
          localOrders: [localOrder()],
        });
        poller.init(); // since = T, never advances this poll (SYM_A failed)
        await poller.poll(V, [SYM_A, SYM_B]);
        expect(sinceCalls).toEqual([T, T]); // watermark held, confirming the log's claim
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining(`sweep watermark held at ${T}`),
        );
        expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('clamped to'));
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  // FIX 4's other branch: a fully-swept poll must still name the value it actually wrote to the
  // watermark ("clamped to" the ceiling), not the raw discarded venue stamp.
  it('a fully-swept poll logs "clamped to" the value actually written to the watermark', async () => {
    const TEN_YEARS_MS = 10 * 365 * 86_400_000;
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const { poller } = build(
        [
          fill({
            clientOrderId: clientOrderId(VENUE_ID),
            venueTradeId: 'clamp-swept',
            venueTimestamp: epochMs(T + TEN_YEARS_MS),
          }),
        ],
        [localOrder()],
      );
      poller.init(); // since = T
      await poller.poll(V, [SYM]);
      const ceiling = T + VENUE_TIMESTAMP_SKEW_ALLOWANCE_MS;
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`sweep watermark clamped to ${ceiling}`),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
