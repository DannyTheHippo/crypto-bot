import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { Counter } from 'prom-client';
import {
  DemoFillPollerService,
  SWEEP_OVERLAP_MS,
} from '../../../../src/features/trading/execution/demo-fill-poller.service';
import type { OrderBookService } from '../../../../src/features/trading/execution/order-book.service';
import type {
  FillIngestorService,
  IngestResult,
} from '../../../../src/features/trading/execution/fill-ingestor.service';
import type { AlgoStopRecoveryService } from '../../../../src/features/trading/execution/algo-stop-recovery.service';
import type { ExchangePort, VenueFill } from '../../../../src/ports/venue/exchange';
import {
  VENUE_TIMESTAMP_SKEW_ALLOWANCE_MS,
  type ExecutionStorePort,
} from '../../../../src/ports/trading/execution';
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
// A clock position far enough past the boot anchor that the read-side overlap subtraction is
// OBSERVABLE: every `since` below bootAnchor + SWEEP_OVERLAP_MS clamps to the anchor (by design — the
// sweep never reads before boot), which would collapse every watermark assertion in this file to a
// vacuous `T`. The watermark tests therefore init at T and then run the poll at LATE, as a
// long-running process does.
const LATE = T + 2 * SWEEP_OVERLAP_MS;
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
  // Mutable so a test can init() at the boot anchor and poll at LATE — the only way the overlap
  // subtraction shows up in `since` at all. Defaults to T, so every test that never calls setNow
  // behaves exactly as it did when the clock was a frozen literal.
  let now = T;
  const clock = { now: () => epochMs(now) };
  const counterCalls: Array<{ labels: Record<string, string>; by: number }> = [];
  const counter = {
    inc: (labels: Record<string, string>, by: number) => void counterCalls.push({ labels, by }),
  } as unknown as Counter<string>;
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
    poller: new DemoFillPollerService(
      clock,
      exchange,
      orders,
      ingestor,
      recovery,
      undefined,
      counter,
    ),
    ingested,
    foldedFrom,
    sinceCalls,
    counterCalls,
    book,
    setNow: (at: number) => {
      now = at;
    },
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

  it('advances the sweep watermark to the newest trade so the next poll fetches from there minus the overlap (no unbounded re-fetch)', async () => {
    const { poller, sinceCalls, setNow } = build(
      [
        fill({
          clientOrderId: clientOrderId(VENUE_ID),
          venueTradeId: 't5',
          venueTimestamp: epochMs(LATE + 50),
        }),
      ],
      [localOrder()],
    );
    poller.init(); // anchors since = now = T
    setNow(LATE);
    await poller.poll(V, [SYM]);
    await poller.poll(V, [SYM]);
    expect(sinceCalls[0]).toBe(T); // first poll swept from boot (watermark - overlap clamps to it)
    // Second poll swept from the newest trade seen minus the overlap — bounded work, not boot.
    expect(sinceCalls[1]).toBe(LATE + 50 - SWEEP_OVERLAP_MS);
  });

  it('keeps the highest timestamp as the watermark when a later trade in the batch is older', async () => {
    const { poller, sinceCalls, setNow } = build(
      [
        fill({
          clientOrderId: clientOrderId(VENUE_ID),
          venueTradeId: 't6',
          venueTimestamp: epochMs(LATE + 90),
        }),
        fill({
          clientOrderId: clientOrderId(VENUE_ID),
          venueTradeId: 't7',
          venueTimestamp: epochMs(LATE + 20),
        }), // older, must not lower it
      ],
      [localOrder()],
    );
    poller.init();
    setNow(LATE);
    await poller.poll(V, [SYM]);
    await poller.poll(V, [SYM]);
    expect(sinceCalls[1]).toBe(LATE + 90 - SWEEP_OVERLAP_MS);
  });

  // The watermark is MONOTONE, so a single unbounded-future venueTimestamp used to pin it past every
  // real trade permanently and every later fill was swept out of the `since` window forever.
  // ccxt-normalize.ts only range-checks finite-integer, never an upper bound. The fill still ingests
  // (dropping a real fill would be the worse error); only the watermark refuses to follow the stamp.
  it('a fill stamped 10 years in the future still ingests, but the watermark stops at now + skew allowance', async () => {
    const TEN_YEARS_MS = 10 * 365 * 86_400_000;
    const { poller, ingested, sinceCalls, setNow } = build(
      [
        fill({
          clientOrderId: clientOrderId(VENUE_ID),
          venueTradeId: 'future-1',
          venueTimestamp: epochMs(LATE + TEN_YEARS_MS),
        }),
      ],
      [localOrder()],
    );
    poller.init();
    setNow(LATE);
    const r = await poller.poll(V, [SYM]);
    expect(r).toEqual({ ingested: 1, skippedUnknown: 0 }); // the fill itself is NOT dropped
    expect(ingested[0]?.venueTimestamp).toBe(LATE + TEN_YEARS_MS); // recorded verbatim, unclamped
    await poller.poll(V, [SYM]);
    // Watermark pinned at the exact ceiling, not the stamp; the read then backs off by the overlap.
    expect(sinceCalls[1]).toBe(LATE + VENUE_TIMESTAMP_SKEW_ALLOWANCE_MS - SWEEP_OVERLAP_MS);
  });

  // The allowance is a tolerance band, not a ceiling on ordinary progress: a trade a few seconds
  // ahead of our clock (venue/host skew) must still advance the watermark to its own stamp.
  it('a trade inside the skew allowance advances the watermark to its own timestamp, unclamped', async () => {
    const { poller, sinceCalls, setNow } = build(
      [
        fill({
          clientOrderId: clientOrderId(VENUE_ID),
          venueTradeId: 'skewed-1',
          venueTimestamp: epochMs(LATE + 5_000),
        }),
      ],
      [localOrder()],
    );
    poller.init();
    setNow(LATE);
    await poller.poll(V, [SYM]);
    await poller.poll(V, [SYM]);
    expect(sinceCalls[1]).toBe(LATE + 5_000 - SWEEP_OVERLAP_MS);
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
      const { poller, ingested, sinceCalls, setNow } = build(
        [
          fill({
            clientOrderId: clientOrderId('other-venue-id'),
            venueTradeId: 't10',
            venueTimestamp: epochMs(LATE + 30),
          }),
        ],
        [localOrder()],
        true,
        recovery,
      );
      poller.init(); // anchors since = now = T
      setNow(LATE);
      const r = await poller.poll(V, [SYM]);
      expect(r).toEqual({ ingested: 0, skippedUnknown: 1 });
      expect(ingested).toHaveLength(0);
      expect(recoverSymbol).toHaveBeenCalledTimes(1);
      await poller.poll(V, [SYM]);
      // Watermark advanced despite the recovery throw (read backed off by the overlap).
      expect(sinceCalls[1]).toBe(LATE + 30 - SWEEP_OVERLAP_MS);
    });

    // A rejected ccxt/pg promise is not always an Error (drivers reject with plain strings and
    // objects) — the fail-OPEN catch must survive that shape too, not just Error.
    it('recoverSymbol rejecting with a non-Error value is still tolerated', async () => {
      const recoverSymbol = vi.fn().mockRejectedValue('venue down');
      const recovery = stubRecovery({ hasAlgoAnchor: () => true, recoverSymbol });
      const { poller, sinceCalls, setNow } = build(
        [
          fill({
            clientOrderId: clientOrderId('other-venue-id'),
            venueTradeId: 't12',
            venueTimestamp: epochMs(LATE + 40),
          }),
        ],
        [localOrder()],
        true,
        recovery,
      );
      poller.init();
      setNow(LATE);
      const r = await poller.poll(V, [SYM]);
      expect(r).toEqual({ ingested: 0, skippedUnknown: 1 });
      expect(recoverSymbol).toHaveBeenCalledTimes(1);
      await poller.poll(V, [SYM]);
      // Watermark advanced despite the non-Error rejection (read backed off by the overlap).
      expect(sinceCalls[1]).toBe(LATE + 40 - SWEEP_OVERLAP_MS);
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
  // per-symbol isolation AND the per-symbol watermark key (`${venue}|${symbol}`): a failing symbol
  // must hold back only its own `since`, never a healthy sibling's.
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
      let now = T; // mutable for the same reason as build()'s — see LATE
      const clock = { now: () => epochMs(now) };
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
      return {
        poller,
        ingested,
        sinceCalls,
        setNow: (at: number) => {
          now = at;
        },
      };
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

    // Watermark keyed `${venue}|${symbol}`: SYM_A's throw holds back only ITS OWN key. SYM_B's key
    // advances independently on its own successful poll — a per-venue watermark would have pinned
    // SYM_B's `since` at T too, unboundedly widening its re-read window for as long as SYM_A stays
    // broken (the exact defect this key shape fixes).
    it("a throw on one symbol leaves that symbol's watermark unmoved while the other symbol's advances", async () => {
      const { poller, sinceCalls, setNow } = buildIsolation({
        bySymbol: {
          [SYM_A]: new Error('ExchangeNotAvailable: 502 Bad Gateway'),
          [SYM_B]: [
            fill({
              clientOrderId: clientOrderId(VENUE_ID),
              venueTradeId: 'b3',
              symbol: SYM_B,
              venueTimestamp: epochMs(LATE + 500),
            }),
          ],
        },
        localOrders: [localOrder()],
      });
      poller.init(); // since = T
      setNow(LATE);
      await poller.poll(V, [SYM_A, SYM_B]); // SYM_A throws, SYM_B sees a newer trade
      sinceCalls.length = 0;
      await poller.poll(V, [SYM_A, SYM_B]);
      // SYM_A still at the boot anchor (its overlap clamps there), SYM_B advanced minus the overlap.
      expect(sinceCalls).toEqual([T, LATE + 500 - SWEEP_OVERLAP_MS]);
    });

    // The key is `${venue}|${symbol}`, not `${venue}` — polling ONLY SYM_A must never touch SYM_B's
    // key, even implicitly. Confirmed by polling SYM_A alone to a new watermark, then polling SYM_B
    // alone and observing it still starts from the boot anchor.
    it("a successful poll advances only the polled symbol's own watermark key", async () => {
      const { poller, sinceCalls } = buildIsolation({
        bySymbol: {
          [SYM_A]: [
            fill({
              clientOrderId: clientOrderId(VENUE_ID),
              venueTradeId: 'a-only',
              symbol: SYM_A,
              venueTimestamp: epochMs(T + 900),
            }),
          ],
          [SYM_B]: [],
        },
        localOrders: [localOrder()],
      });
      poller.init(); // since = T for both keys
      await poller.poll(V, [SYM_A]); // SYM_A only — advances venue|SYM_A to T + 900
      sinceCalls.length = 0;
      await poller.poll(V, [SYM_B]); // SYM_B only — its own key was never touched above
      expect(sinceCalls).toEqual([T]); // still the boot anchor, not SYM_A's T + 900
    });

    // A rejected ccxt/network promise is not always an Error (drivers reject with plain strings and
    // objects too) — the fetchMyTrades catch's `err instanceof Error ? err.message : String(err)`
    // must survive that shape, same as the recoverSymbol/hasAlgoAnchor non-Error tests above.
    it("fetchMyTrades rejecting with a non-Error value is still tolerated — remaining symbols still polled, only SYM_A's own watermark held", async () => {
      const { poller, ingested, sinceCalls, setNow } = buildIsolation({
        bySymbol: {
          [SYM_A]: 'ECONNRESET', // non-Error rejection
          [SYM_B]: [
            fill({
              clientOrderId: clientOrderId(VENUE_ID),
              venueTradeId: 'b5',
              symbol: SYM_B,
              venueTimestamp: epochMs(LATE + 700),
            }),
          ],
        },
        localOrders: [localOrder()],
      });
      poller.init(); // since = T
      setNow(LATE);
      const r = await poller.poll(V, [SYM_A, SYM_B]);
      expect(r.ingested).toBe(1); // SYM_B still polled and ingested despite SYM_A's non-Error rejection
      expect(ingested[0]?.venueTradeId).toBe('b5');
      sinceCalls.length = 0;
      await poller.poll(V, [SYM_A, SYM_B]);
      // SYM_A held at the boot anchor, SYM_B advanced minus the overlap.
      expect(sinceCalls).toEqual([T, LATE + 700 - SWEEP_OVERLAP_MS]);
    });

    // Each symbol's watermark reflects only ITS OWN trades: SYM_A's fill advances venue|SYM_A, while
    // SYM_B (no trades this poll) stays at the boot anchor on its own key — a per-venue watermark
    // would have dragged SYM_B's `since` up to T + 300 too, purely as a side effect of SYM_A's fill.
    it("the watermark advances per-symbol on a fully-swept poll — SYM_B's own since is unaffected by SYM_A's fill", async () => {
      const { poller, sinceCalls, setNow } = buildIsolation({
        bySymbol: {
          [SYM_A]: [
            fill({
              clientOrderId: clientOrderId(VENUE_ID),
              venueTradeId: 'a4',
              symbol: SYM_A,
              venueTimestamp: epochMs(LATE + 300),
            }),
          ],
          [SYM_B]: [],
        },
        localOrders: [localOrder()],
      });
      poller.init();
      setNow(LATE);
      await poller.poll(V, [SYM_A, SYM_B]);
      sinceCalls.length = 0;
      await poller.poll(V, [SYM_A, SYM_B]);
      expect(sinceCalls).toEqual([LATE + 300 - SWEEP_OVERLAP_MS, T]);
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

    // Per-symbol keying: SYM_A's throw is unrelated to SYM_B's own clamp — SYM_B swept cleanly, so
    // it logs its own "clamped to" against its own watermark, exactly as if it had been polled alone.
    // SYM_A's key is untouched (still the boot anchor) and never appears in a clamp log at all — it
    // never reached the fills loop.
    it('SYM_A throwing does not suppress or alter SYM_B’s own clamp log on the same poll', async () => {
      const TEN_YEARS_MS = 10 * 365 * 86_400_000;
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const { poller, sinceCalls, setNow } = buildIsolation({
          bySymbol: {
            [SYM_A]: new Error('ExchangeNotAvailable: 502 Bad Gateway'),
            [SYM_B]: [
              fill({
                clientOrderId: clientOrderId(VENUE_ID),
                venueTradeId: 'clamp-partial',
                symbol: SYM_B,
                venueTimestamp: epochMs(LATE + TEN_YEARS_MS),
              }),
            ],
          },
          localOrders: [localOrder()],
        });
        poller.init(); // since = T for both keys
        setNow(LATE);
        await poller.poll(V, [SYM_A, SYM_B]);
        const ceiling = LATE + VENUE_TIMESTAMP_SKEW_ALLOWANCE_MS;
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining(`symbol ${SYM_B} returned 1 trade(s)`),
        );
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining(`sweep watermark clamped to ${ceiling}`),
        );
        sinceCalls.length = 0;
        await poller.poll(V, [SYM_A, SYM_B]);
        // SYM_A still at the boot anchor, SYM_B clamped at the ceiling then backed off by the overlap.
        expect(sinceCalls).toEqual([T, ceiling - SWEEP_OVERLAP_MS]);
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  // LIVE INCIDENT 2026-08-11 (binanceusdm KAITO/USDT:USDT, intent
  // 019ff277-34bd-7b21-a378-dd4d0bf7a4d4): at 20:15:47.418Z one fetchMyTrades returned venue trade
  // 56287002 (ts 1786479340803) while WITHHOLDING already-executed trades 56286996–56287001
  // (ts 1786479338135–1786479340419) that matched the same `since` predicate. The bare watermark
  // advanced past all six; the next four polls journalled nothing for them, and only
  // ReconciliationService's independent 300s overlap recovered them 42s later. These pin the
  // read-side overlap that makes the poller self-healing instead of dependent on another service's
  // configuration.
  describe('sweep overlap (2026-08-11 KAITO withheld-older-trades incident)', () => {
    const PERP = venueId('binanceusdm');
    const KAITO = symbolId('KAITO/USDT:USDT');
    const PERP_ORDER = 'venue-56287000';
    // The clock position of the incident polls — far enough past boot that the overlap window is not
    // clamped at the anchor, i.e. the long-running process the incident actually happened on.
    const RUNTIME = LATE;

    const perpFill = (venueTradeId: string, ts: number): VenueFill =>
      fill({
        clientOrderId: clientOrderId(PERP_ORDER),
        venueTradeId,
        venue: PERP,
        symbol: KAITO,
        venueTimestamp: epochMs(ts),
      });

    // Venue semantics, unlike the fixtures above: fetchMyTrades filters on `since` (ts >= since), so
    // a trade the cursor has already passed is UNREACHABLE — which is what makes these tests
    // discriminate. `pages[i]` is what the venue is willing to show on poll i BEFORE that filter, so
    // page 0 can withhold trades page 1 reveals. The ingestor fake dedupes on venueTradeId, mirroring
    // FillIngestorService's own idempotency.
    function buildOverlap(
      pages: readonly (readonly VenueFill[])[],
      opts: {
        counterThrows?: boolean;
        store?: ExecutionStorePort;
        /** false ⇒ the local order carries no venueOrderId yet: the ACK has not landed (see ack()). */
        acked?: boolean;
      } = {},
    ) {
      const counterThrows = opts.counterThrows ?? false;
      const ingested: FillRecord[] = [];
      const sinceCalls: number[] = [];
      const seenTradeIds = new Set<string>();
      let now = T;
      let poll = 0;
      const clock = { now: () => epochMs(now) };
      let order = localOrder({
        venueOrderId: (opts.acked ?? true) ? PERP_ORDER : undefined,
      });
      const book = new Map<string, OrderRecord>([[String(order.clientOrderId), order]]);
      const orders = {
        all: () => [order],
        get: (coid: ClientOrderId) => book.get(String(coid)),
      } as unknown as OrderBookService;
      const ingestor = {
        ingest: (rec: OrderRecord, f: FillRecord): Promise<IngestResult> => {
          if (seenTradeIds.has(f.venueTradeId))
            return Promise.resolve({ applied: false, record: rec });
          seenTradeIds.add(f.venueTradeId);
          ingested.push(f);
          const next = { ...rec, cumQty: rec.cumQty.add(f.qty) } as OrderRecord;
          book.set(String(rec.clientOrderId), next);
          return Promise.resolve({ applied: true, record: next });
        },
      } as unknown as FillIngestorService;
      const exchange = {
        venue: PERP,
        fetchMyTrades: (_symbol: unknown, since: unknown) => {
          sinceCalls.push(since as number);
          const page = pages[poll] ?? [];
          poll += 1;
          return Promise.resolve(page.filter((t) => t.venueTimestamp >= (since as number)));
        },
      } as unknown as ExchangePort;
      const counterCalls: Array<{ labels: Record<string, string>; by: number }> = [];
      const counter = {
        inc: (labels: Record<string, string>, by: number) => {
          counterCalls.push({ labels, by });
          if (counterThrows) throw new Error('counter exploded');
        },
      } as unknown as Counter<string>;
      const poller = new DemoFillPollerService(
        clock,
        exchange,
        orders,
        ingestor,
        stubRecovery(),
        undefined,
        counter,
        opts.store,
      );
      return {
        poller,
        ingested,
        sinceCalls,
        counterCalls,
        setNow: (at: number) => {
          now = at;
        },
        // The ACK landing late: the order gains its venueOrderId between polls, so a trade that was
        // unmatched (skippedUnknown) on an earlier poll now resolves.
        ack: () => {
          order = { ...order, venueOrderId: PERP_ORDER };
          book.set(String(order.clientOrderId), order);
        },
      };
    }

    const OLDER_A = perpFill('56286996', RUNTIME + 100);
    const OLDER_B = perpFill('56287001', RUNTIME + 200);
    const NEWER = perpFill('56287002', RUNTIME + 2_000);

    it('re-reads behind the watermark and ingests trades the venue withheld while returning a newer one', async () => {
      const { poller, ingested, sinceCalls, setNow } = buildOverlap([
        [NEWER], // poll 1: the venue shows ONLY the newest trade
        [OLDER_A, OLDER_B, NEWER], // poll 2: the older ones finally become visible
      ]);
      poller.init();
      setNow(RUNTIME);
      const r1 = await poller.poll(PERP, [KAITO]);
      expect(r1.ingested).toBe(1); // just 56287002 — the watermark is now past the older trades
      const r2 = await poller.poll(PERP, [KAITO]);
      // Reachable ONLY because the read backs off by the overlap: without it since would be
      // RUNTIME + 2_000 and the venue filter would hide both older trades forever (the fills are the
      // assertion that matters — the `since` arithmetic below is the mechanism).
      expect(r2.ingested).toBe(2);
      expect(ingested.map((f) => f.venueTradeId)).toEqual(['56287002', '56286996', '56287001']);
      expect(sinceCalls[1]).toBe(RUNTIME + 2_000 - SWEEP_OVERLAP_MS);
    });

    it('the trade re-fetched by the overlap is deduped — ingested once, no second FILL fold', async () => {
      const { poller, ingested, counterCalls, setNow } = buildOverlap([
        [NEWER],
        [OLDER_A, OLDER_B, NEWER],
        [OLDER_A, OLDER_B, NEWER], // a third pass re-covers all three: nothing may fold twice
      ]);
      poller.init();
      setNow(RUNTIME);
      await poller.poll(PERP, [KAITO]);
      await poller.poll(PERP, [KAITO]);
      const r3 = await poller.poll(PERP, [KAITO]);
      expect(r3.ingested).toBe(0); // every trade already applied — dedupe holds
      expect(ingested).toHaveLength(3);
      // The recovery counter counts recoveries, never re-reads: only the two withheld trades, on the
      // one poll that actually folded them.
      expect(counterCalls.filter((c) => c.by === 1)).toHaveLength(2);
    });

    it('counts each below-watermark recovery on demo_fill_poller_overlap_recovered_total{venue,symbol}, and seeds the series at 0', async () => {
      const { poller, counterCalls, setNow } = buildOverlap([[NEWER], [OLDER_A, OLDER_B, NEWER]]);
      poller.init();
      setNow(RUNTIME);
      await poller.poll(PERP, [KAITO]);
      // Seeded on the very first poll, before anything is recovered — a key that never recovers must
      // still export a series (otherwise "stays 0" is a void read, not a reading).
      expect(counterCalls).toEqual([{ labels: { venue: PERP, symbol: KAITO }, by: 0 }]);
      counterCalls.length = 0;
      await poller.poll(PERP, [KAITO]);
      expect(counterCalls).toEqual([
        { labels: { venue: PERP, symbol: KAITO }, by: 0 },
        { labels: { venue: PERP, symbol: KAITO }, by: 1 }, // 56286996
        { labels: { venue: PERP, symbol: KAITO }, by: 1 }, // 56287001
      ]);
    });

    // The overlap is subtracted from the STORED high-water mark, never written back to it: seeding the
    // write from the overlap-reduced `since` would lower the mark on any poll that returns nothing
    // newer, and the read window would walk backwards by 300s every cycle — unbounded re-read growth,
    // the exact failure the watermark exists to prevent.
    it('a poll that returns no trades leaves the stored watermark untouched — the read window never walks backwards', async () => {
      const { poller, sinceCalls, setNow } = buildOverlap([[NEWER], [], []]);
      poller.init();
      setNow(RUNTIME);
      await poller.poll(PERP, [KAITO]); // watermark := RUNTIME + 2_000
      await poller.poll(PERP, [KAITO]); // nothing returned
      await poller.poll(PERP, [KAITO]);
      expect(sinceCalls[1]).toBe(RUNTIME + 2_000 - SWEEP_OVERLAP_MS);
      expect(sinceCalls[2]).toBe(sinceCalls[1]); // stable, not reduced by a second overlap
    });

    // Measurement-only, so it fails OPEN: a misbehaving counter must never cost a fill.
    it('a throwing recovery counter never breaks the poll or the recovery it was counting', async () => {
      const { poller, ingested, setNow } = buildOverlap([[NEWER], [OLDER_A, OLDER_B, NEWER]], {
        counterThrows: true, // every inc() throws, seed included
      });
      poller.init();
      setNow(RUNTIME);
      await poller.poll(PERP, [KAITO]);
      const r2 = await poller.poll(PERP, [KAITO]);
      expect(r2.ingested).toBe(2);
      expect(ingested).toHaveLength(3);
    });

    it('never reads before the boot anchor — the overlap is clamped, not subtracted blindly', async () => {
      const { poller, sinceCalls } = buildOverlap([[]]);
      poller.init(); // bootAnchor = T
      await poller.poll(PERP, [KAITO]);
      expect(sinceCalls).toEqual([T]); // not T - SWEEP_OVERLAP_MS
    });

    // The counter answers "did the overlap reach a trade the bare watermark had already passed?", so
    // the comparison is strict: a trade stamped exactly AT the mark was inside the old window too.
    it('a trade stamped exactly at the high-water mark is ingested but is NOT counted as a recovery', async () => {
      const TWIN = perpFill('56287003', RUNTIME + 2_000); // same ts as NEWER, withheld on poll 1
      const { poller, ingested, counterCalls, setNow } = buildOverlap([[NEWER], [NEWER, TWIN]]);
      poller.init();
      setNow(RUNTIME);
      await poller.poll(PERP, [KAITO]); // watermark := RUNTIME + 2_000
      counterCalls.length = 0;
      const r2 = await poller.poll(PERP, [KAITO]);
      expect(r2.ingested).toBe(1); // the twin IS ingested
      expect(ingested.map((f) => f.venueTradeId)).toEqual(['56287002', '56287003']);
      expect(counterCalls.filter((c) => c.by === 1)).toHaveLength(0); // …but not as a recovery
    });

    // M1: the venue answers with a bounded page (500 rows by default — ccxt sends no `limit`). If the
    // overlap window alone fills it, every row sits at or below the mark, the watermark writes back
    // unchanged, and the identical request repeats forever — the cursor is wedged and every later fill
    // on that symbol is invisible until restart. Pre-fix this was impossible (`since` WAS the
    // frontier), so the overlap is what has to carry the guard for it.
    describe('forward-progress guard (page saturated by the overlap window alone)', () => {
      const foreign = (venueTradeId: string, ts: number): VenueFill =>
        fill({
          clientOrderId: clientOrderId('someone-elses-order'),
          venueTradeId,
          venue: PERP,
          symbol: KAITO,
          venueTimestamp: epochMs(ts),
        });
      // A full page of trades the poller does not own — same wedge, without 500 ingest round trips.
      const fullPage = (newestTs: number): VenueFill[] =>
        Array.from({ length: 500 }, (_unused, i) => foreign(`sat-${newestTs}-${i}`, newestTs - i));

      it('a full page with nothing past the mark drops the overlap for exactly one poll, then restores it', async () => {
        const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        try {
          const H = RUNTIME + 2_000;
          const { poller, sinceCalls, setNow } = buildOverlap([
            [NEWER], // watermark := H
            fullPage(H), // 500 rows, newest exactly at H — nothing new, page saturated
            fullPage(H + 5_000), // full page that DOES advance: the guard must stay a no-op here
            [],
          ]);
          poller.init();
          setNow(RUNTIME);
          await poller.poll(PERP, [KAITO]);
          await poller.poll(PERP, [KAITO]);
          expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('returned a full 500-row page with no trade past watermark'),
          );
          await poller.poll(PERP, [KAITO]);
          expect(sinceCalls[2]).toBe(H); // frontier read — the wedge is broken, not repeated
          await poller.poll(PERP, [KAITO]);
          // Overlap restored behind the NEW mark: one poll of narrower window, never a lasting one.
          expect(sinceCalls[3]).toBe(H + 5_000 - SWEEP_OVERLAP_MS);
        } finally {
          errorSpy.mockRestore();
        }
      });
    });

    // M3: `since` is floored at a ROLLING now - 6d, not just the static boot anchor. A perp symbol
    // that stays quiet keeps its watermark at the anchor, and once that is >7d stale ccxt derives
    // endTime = min(since + 7d, now) from it (binance.js:8261-8266, live because the adapter sends no
    // endTime and no limit) — the venue answers with silence, nothing throws, and the symbol is blind
    // until restart.
    it('a symbol quiet since boot never lets `since` go stale enough for ccxt to derive a past endTime', async () => {
      const EIGHT_DAYS = 8 * 86_400_000;
      const { poller, sinceCalls, setNow } = buildOverlap([[], []]);
      poller.init(); // bootAnchor = T
      await poller.poll(PERP, [KAITO]); // quiet: the watermark never leaves the anchor
      setNow(T + EIGHT_DAYS);
      await poller.poll(PERP, [KAITO]);
      expect(sinceCalls[0]).toBe(T);
      // Floored at now - 6d, INSIDE the venue's 7-day window — not the 8-day-stale anchor.
      expect(sinceCalls[1]).toBe(T + EIGHT_DAYS - 6 * 86_400_000);
    });

    // The second loss class this repair closes: the ACK lands after the venue already reported the
    // trade. Pre-fix the cursor advanced past it on the unmatched poll and it was unreachable forever;
    // the overlap re-presents it once the local order can be matched.
    it('a trade seen before its ACK landed is re-read and ingested once the order is matchable', async () => {
      // A LATER unrelated trade on the same symbol is what makes this the real loss shape: it drags
      // the watermark PAST the unmatched trade, so the pre-fix cursor could never return to it (a
      // trade merely AT the mark was still inside the old inclusive `since`).
      const laterForeign = fill({
        clientOrderId: clientOrderId('someone-elses-order'),
        venueTradeId: '56287009',
        venue: PERP,
        symbol: KAITO,
        venueTimestamp: epochMs(RUNTIME + 3_000),
      });
      const { poller, ingested, counterCalls, setNow, ack } = buildOverlap(
        [
          [NEWER, laterForeign],
          [NEWER, laterForeign],
        ],
        { acked: false },
      );
      poller.init();
      setNow(RUNTIME);
      const r1 = await poller.poll(PERP, [KAITO]);
      // Neither resolves yet: our order carries no venue id, and the watermark advances past both.
      expect(r1).toEqual({ ingested: 0, skippedUnknown: 2 });
      ack();
      counterCalls.length = 0;
      const r2 = await poller.poll(PERP, [KAITO]);
      expect(r2.ingested).toBe(1);
      expect(ingested.map((f) => f.venueTradeId)).toEqual(['56287002']);
      // Below the mark this poll started from — the same recovery the counter exists to report.
      expect(counterCalls.filter((c) => c.by === 1)).toHaveLength(1);
    });

    // S1: the overlap re-presents a settled trade to every poll it spans (~30 at a 10s cadence), and
    // each re-submission would otherwise re-enter saveFill's payload comparison, whose conflict arm
    // engages the kill switch. Mirrors reconciliation.service.ts:1318's own already-recorded filter.
    it('a trade the store already holds is filtered before the ingestor is reached', async () => {
      const store = { hasFill: () => Promise.resolve(true) } as unknown as ExecutionStorePort;
      const { poller, ingested, setNow } = buildOverlap([[NEWER]], { store });
      poller.init();
      setNow(RUNTIME);
      const r = await poller.poll(PERP, [KAITO]);
      expect(r).toEqual({ ingested: 0, skippedUnknown: 0 });
      expect(ingested).toHaveLength(0); // the ingestor was never called at all
    });

    it('a throwing hasFill lookup falls through to the ingestor — a filter outage costs a query, never a fill', async () => {
      const store = {
        hasFill: () => Promise.reject(new Error('pg down')),
      } as unknown as ExecutionStorePort;
      const { poller, ingested, setNow } = buildOverlap([[NEWER]], { store });
      poller.init();
      setNow(RUNTIME);
      const r = await poller.poll(PERP, [KAITO]);
      expect(r.ingested).toBe(1);
      expect(ingested).toHaveLength(1);
    });

    // Same non-Error-rejection shape the recoverSymbol/hasAlgoAnchor/fetchMyTrades tests above pin:
    // pg and its drivers reject with plain strings too, and the catch renders `String(err)` only on
    // that arm.
    it('a hasFill lookup rejecting with a non-Error value is still tolerated', async () => {
      const store = {
        // The bare-string rejection IS the behaviour under test; wrapping it in an Error would delete
        // the only coverage of the catch's `String(err)` arm.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        hasFill: () => Promise.reject('pg down'),
      } as unknown as ExecutionStorePort;
      const { poller, ingested, setNow } = buildOverlap([[NEWER]], { store });
      poller.init();
      setNow(RUNTIME);
      const r = await poller.poll(PERP, [KAITO]);
      expect(r.ingested).toBe(1);
      expect(ingested).toHaveLength(1);
    });
  });

  // A fully-swept poll must name the value it actually wrote to the watermark ("clamped to" the
  // ceiling), not the raw discarded venue stamp.
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
