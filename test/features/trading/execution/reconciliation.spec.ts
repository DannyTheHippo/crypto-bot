import { Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { Counter, Gauge } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import { initialOrder } from '../../../../src/domain/trading/oms/reducer';
import {
  encodeClientOrderId,
  epochMs,
  intentId,
  symbolId,
  venueId,
  type VenueId,
} from '../../../../src/domain/common/types/ids';
import { price, qty } from '../../../../src/domain/common/types/money';
import { EquitySamplerService } from '../../../../src/features/trading/execution/equity-sampler.service';
import { FeeLedgerService } from '../../../../src/features/trading/execution/fee-ledger.service';
import { FillIngestorService } from '../../../../src/features/trading/execution/fill-ingestor.service';
import { InMemoryExecutionStore } from '../../../../src/features/trading/execution/in-memory-store';
import { OrderBookService } from '../../../../src/features/trading/execution/order-book.service';
import { PortfolioStateService } from '../../../../src/features/trading/execution/portfolio-state.service';
import { ReconciliationService } from '../../../../src/features/trading/execution/reconciliation.service';
import {
  AdapterError,
  type AlgoOrderState,
  type ExchangeOrderState,
  type ExchangePort,
  type VenueFill,
  type VenuePosition,
} from '../../../../src/ports/venue/exchange';
import {
  AXIS_NOT_RUN,
  VENUE_TIMESTAMP_SKEW_ALLOWANCE_MS,
  type ReconConfig,
} from '../../../../src/ports/trading/execution';
import type { OpsEvent, OpsEventPort } from '../../../../src/ports/common/observability';
import type { VenueRuntimeDescriptor } from '../../../../src/ports/venue/venue-registry';
import { fixedFeed, killSwitchStub, makeFill, makeIntent, SYM, T, V } from './helpers';

const CFG: ReconConfig = {
  epsAbs: '0.00000001',
  epsRel: '0.0001',
  overlapMs: 300_000,
  driftPasses: 3,
  balanceAxis: true,
  sweepSymbols: [],
};
const OTHER_COID = encodeClientOrderId(intentId('0190ffff-1234-7abc-89ab-0123456789ab'), 'paper');

interface ExchangeScript {
  openOrders?: ExchangeOrderState[];
  openOrdersThrow?: boolean;
  // Task C4: a specific Error (subclass) to throw instead of the generic 'open orders down' one —
  // lets a test assert on the injected instance's own message/constructor name.
  openOrdersThrowError?: Error;
  // Test-only latch: when set, fetchOpenOrders awaits it before resolving, so a pass can be held
  // mid-flight to exercise ReconciliationService's re-entrancy guard (the unguarded 30s driver
  // interval can otherwise start a second interleaved pass — security review 2026-07-22).
  openOrdersGate?: Promise<void>;
  fetchOrder?: () => ExchangeOrderState;
  trades?: VenueFill[];
  tradesThrow?: boolean;
  // Test-only hook fired inside fetchMyTrades, i.e. AFTER the trade axis has built its venue-order
  // index and before any trade is classified — the only window in which a mid-pass ACK can be
  // simulated (axis 1 runs earlier, so ACKing there would land before the index is built).
  beforeTrades?: () => void;
  balances?: () => Map<string, { free: string; locked: string }>;
  balancesThrow?: boolean;
  // Absent (both undefined) leaves ExchangePort.fetchPositions undefined, matching a spot/paper
  // adapter — the position axis must skip entirely, exactly the pre-Defect-A behavior.
  positions?: () => VenuePosition[];
  positionsThrow?: boolean;
  // R2: absent (both undefined) leaves ExchangePort.fetchOpenAlgoOrders undefined, matching a
  // spot/paper adapter — reconcileAlgoRailOrphans must skip entirely, mirroring the positions gate
  // above.
  algoOpen?: (symbol: string) => AlgoOrderState[];
  algoOpenThrow?: boolean;
}

function build(
  script: ExchangeScript = {},
  mismatchCounter?: Counter<string>,
  runsCounter?: Counter<string>,
  lastSuccessGauge?: Gauge<string>,
  cfgOver: Partial<ReconConfig> = {},
  axisErrorCounter?: Counter<string>,
) {
  let nowMs = T;
  const clock = { now: () => epochMs(nowMs) };
  const store = new InMemoryExecutionStore();
  const orders = new OrderBookService();
  const portfolio = new PortfolioStateService(
    { quoteAsset: 'USDT', startingCash: '100000' },
    new FeeLedgerService(),
  );
  const sampler = new EquitySamplerService(portfolio, fixedFeed('100'), clock, store);
  const { ks, engages } = killSwitchStub();
  const ingestor = new FillIngestorService(store, ks, orders, portfolio, sampler);
  const opsEvents: OpsEvent[] = [];
  const opsEventLogger: OpsEventPort = { emit: (e) => opsEvents.push(e) };
  // Every `since` the trade axis asked for, in order — the only external view of the per-(venue,
  // symbol) checkpoint (a private map), and what the future-timestamp clamp has to be pinned on.
  const tradeSinceCalls: number[] = [];

  const exchange: ExchangePort = {
    venue: V,
    capabilities: {
      clientOrderId: true,
      fetchOrderByClientId: true,
      wsUserStream: true,
      stp: false,
      sandbox: true,
    },
    placeOrder: () => Promise.reject(new Error('unused')),
    cancelOrder: () => Promise.reject(new Error('unused')),
    fetchOrder: () =>
      Promise.resolve(
        (
          script.fetchOrder ??
          (() => {
            throw new Error('no fetchOrder');
          })
        )(),
      ),
    fetchOpenOrders: async () => {
      if (script.openOrdersThrowError) throw script.openOrdersThrowError;
      if (script.openOrdersThrow) throw new Error('open orders down');
      if (script.openOrdersGate !== undefined) await script.openOrdersGate;
      return script.openOrders ?? [];
    },
    fetchBalances: () =>
      script.balancesThrow
        ? Promise.reject(new Error('balances down'))
        : Promise.resolve(
            script.balances
              ? script.balances()
              : new Map([['USDT', { free: '100000', locked: '0' }]]),
          ),
    fetchMyTrades: (...args: unknown[]) => {
      tradeSinceCalls.push(args[1] as number); // the `since` the checkpoint produced for this sweep
      script.beforeTrades?.();
      return script.tradesThrow
        ? Promise.reject(new Error('trades down'))
        : Promise.resolve(script.trades ?? []);
    },
    validateCredentials: () => Promise.reject(new Error('unused')),
    ...(script.positions !== undefined || script.positionsThrow
      ? {
          fetchPositions: () =>
            script.positionsThrow
              ? Promise.reject(new Error('positions down'))
              : Promise.resolve(script.positions!()),
        }
      : {}),
    ...(script.algoOpen !== undefined || script.algoOpenThrow
      ? {
          fetchOpenAlgoOrders: (symbol?: string) =>
            script.algoOpenThrow
              ? Promise.reject(new Error('algo open orders down'))
              : Promise.resolve(script.algoOpen!(symbol ?? '')),
        }
      : {}),
  };

  const recon = new ReconciliationService(
    clock,
    exchange,
    store,
    ks,
    { ...CFG, ...cfgOver },
    orders,
    portfolio,
    ingestor,
    mismatchCounter,
    runsCounter,
    lastSuccessGauge,
    undefined, // venuePorts — single-venue legacy path (see this file's own CFG-driven fixtures)
    undefined, // venueRegistry
    opsEventLogger,
    axisErrorCounter,
  );
  return {
    store,
    orders,
    portfolio,
    recon,
    engages,
    opsEvents,
    tradeSinceCalls,
    setNow: (t: number) => {
      nowMs = t;
    },
  };
}

type Ctx = ReturnType<typeof build>;

function seedOpenOrder(
  ctx: Ctx,
  coid = makeIntent().clientOrderId,
  over: Partial<ReturnType<typeof makeIntent>> = {},
  venueOrderId = 'v1',
) {
  const intent = makeIntent({ clientOrderId: coid, ...over });
  ctx.orders.create(initialOrder(coid, intent.qty, '0.001', SYM));
  ctx.orders.apply(coid, { type: 'SUBMIT_SENT' });
  ctx.orders.apply(coid, { type: 'ACK', venueOrderId });
  ctx.portfolio.addInFlight(intent);
  ctx.portfolio.openOrder(intent.strategyId, {
    clientOrderId: coid,
    symbol: SYM,
    side: 'BUY',
    qty: intent.qty,
    limitPrice: price('100'),
  });
  return coid;
}

// R2: an ACKED, zero-cumQty algo-rail (STOP_MARKET) order the way a just-restarted process would
// see it — the intent resolves ONLY through the durable write-ahead store (loadIntentByClientOrderId),
// never through the in-memory in-flight map, matching the real four-row 2026-07-31-boot defect
// (a post-restart, store-only anchor — see AlgoStopRecoveryService.candidateAlgoIntents' own
// header). Deliberately does NOT call portfolio.addInFlight/openOrder: algo-rail orders are kept off
// both by execution-gate/boot-recovery's own isAlgoRailIntent gating (reconcileOpenOrders' header).
async function seedAlgoOrphan(
  ctx: Ctx,
  coid = makeIntent({ type: 'STOP_MARKET', triggerPrice: price('90') }).clientOrderId,
  venueOrderId = 'algo-v1',
): Promise<typeof coid> {
  const intent = makeIntent({
    clientOrderId: coid,
    type: 'STOP_MARKET',
    triggerPrice: price('90'),
  });
  ctx.orders.create(initialOrder(coid, intent.qty, '0.001', SYM));
  ctx.orders.apply(coid, { type: 'SUBMIT_SENT' });
  ctx.orders.apply(coid, { type: 'ACK', venueOrderId });
  await ctx.store.saveIntent(intent, { nonce: 'n', approvedAtMs: T, ttlMs: 60_000 } as never);
  return coid;
}

const venueOrder = (coid: string, status: ExchangeOrderState['status']): ExchangeOrderState => ({
  clientOrderId: coid as ExchangeOrderState['clientOrderId'],
  venueOrderId: 'v1',
  symbol: SYM,
  status,
  cumQty: '0',
  qty: '1',
});

// R2: a resting algo-rail (STOP_MARKET) order as fetchOpenAlgoOrders would report it — the venue
// counterpart reconcileAlgoRailOrphans checks for before ever folding a coid.
const algoOrder = (coid: string): AlgoOrderState => ({
  algoId: 'a1',
  clientAlgoId: coid,
  symbol: SYM,
  side: 'SELL',
  type: 'STOP_MARKET',
  qty: '1',
  triggerPrice: '90',
  status: 'NEW',
  reduceOnly: true,
});

const trade = (coid: string, tradeId: string): VenueFill => ({
  venue: V,
  symbol: SYM,
  venueTradeId: tradeId,
  clientOrderId: coid as VenueFill['clientOrderId'],
  price: '100',
  qty: '1',
  fee: null,
  liquidity: 'taker',
  venueTimestamp: epochMs(T),
});

describe('ReconciliationService (§6.4)', () => {
  it("sweeps a held position's symbol and stays clean when the venue ledger agrees", async () => {
    const intent = makeIntent(); // BUY 1 BTC @ 100
    const ctx = build({
      balances: () =>
        new Map([
          ['USDT', { free: '99900', locked: '0' }],
          ['BTC', { free: '1', locked: '0' }],
        ]),
    });
    ctx.portfolio.applyFill(intent, makeFill({ qty: intent.qty, price: intent.refPrice })); // creates the position
    const r = await ctx.recon.reconcile();
    expect(r).toEqual({ mismatches: 0, actionableMismatches: 0, halted: false }); // position symbol swept, balances agree
  });

  it('increments reconciliation_mismatch_total with the mismatch class label (#24): a foreign open order counts as foreign_open_order', async () => {
    const counter = { inc: vi.fn() } as unknown as Counter<string>;
    // A foreign venue open order is a WARN mismatch (count 1) — a deterministic non-zero pass.
    // SYM is in the configured sweep set (no local state yet — the per-symbol sweep must still run).
    const ctx = build(
      { openOrders: [venueOrder('someoneElseOrder', 'open')] },
      counter,
      undefined,
      undefined,
      {
        sweepSymbols: [SYM],
      },
    );
    const r = await ctx.recon.reconcile();
    expect(r.mismatches).toBeGreaterThan(0);
    // Not calls[0]: the constructor now seeds every known class's zero series first (Pass 47) — the
    // pass's own increment lands somewhere after those, not necessarily first.
    expect((counter.inc as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
      { class: 'foreign_open_order' },
      r.mismatches,
    ]);
  });

  // Pass 47 (2026-07-29): WATCH-V4-1/2 (research/loop/state.md) read
  // reconciliation_mismatch_total{class="adopt_non_adoptable"} / {class="fill_overflow"} expecting a
  // literal 0 to mean "stays 0" — a class prom-client had never touched instead exported an empty
  // vector (void read, §C.9), identical to the market_stream_forced_reconnects_total defect Pass 44
  // fixed. Asserted at CONSTRUCTION, before reconcile() ever runs, so deleting the seed (and leaving
  // only the per-pass `this.mismatchCounter?.inc({ class: cls }, n)` call) fails this test — the
  // vacuous-test check the task calls for.
  it('seeds every mismatch class at its true zero on construction (Pass 47), before any pass runs', () => {
    const counter = { inc: vi.fn() } as unknown as Counter<string>;
    build({}, counter); // construction alone — no reconcile() call
    const calls = (counter.inc as ReturnType<typeof vi.fn>).mock.calls;
    const allClasses = [
      'unknown_ours_open',
      'fill_for_unknown_order',
      'balance_drift',
      'balance_leak',
      'position_drift',
      'foreign_open_order',
      'adopted_terminal',
      'backfilled_fill',
      'adopt_query_failure',
      'adopt_non_adoptable',
      'fill_overflow',
      'fill_fold_failed',
      'sweep_failure',
    ];
    for (const cls of allClasses) {
      expect(calls, cls).toContainEqual([{ class: cls }, 0]);
    }
  });

  // Pass 49 (2026-07-30): the runs-counter twin of the seed test above — same construction-only
  // assertion, extended to reconciliation_runs_total. This is what makes ReconciliationHalt
  // (observability/alerts.rules.yml) able to fire on a ONE-SHOT halt: without this seed, a halt's
  // first increment lazily creates the {result="halt"} child at 1, and increase() over any LATER
  // window reads 0 forever (the same newborn-child trap live-verified on
  // agentic_reflection_outcomes_total). Deleting the seed (leaving only the per-pass
  // `this.runsCounter?.inc({venue,result})` call) fails this test. Legacy single-venue construction
  // path here (no venuePorts/venueRegistry) — the v3 multi-venue registry path has its own seed test
  // below (§1.5 multi-venue iteration block).
  it('seeds every (venue, result) pair — including halt — on reconciliation_runs_total at construction (Pass 49), before any pass runs', () => {
    const runs = { inc: vi.fn() } as unknown as Counter<string>;
    build({}, undefined, runs); // construction alone — no reconcile() call
    const calls = (runs.inc as ReturnType<typeof vi.fn>).mock.calls;
    for (const result of ['clean', 'mismatch', 'halt', 'error']) {
      expect(calls, result).toContainEqual([{ venue: V, result }, 0]);
    }
    expect(calls).toContainEqual([{ venue: 'all', result: 'skipped' }, 0]);
  });

  // Pass 50 (2026-07-30): reconciliation_axis_error_total's own zero-seed, single-venue legacy path.
  // openOrders/trades always reachable; positions is unreachable here (the legacy `exchange` fixture
  // never implements fetchPositions unless a script opts in), and balances IS reachable (default CFG
  // has balanceAxis: true) — so exactly those three axes seed, not a blind four-axis cross-product,
  // proving the seed reads each venue's OWN axis config.
  it('seeds reconciliation_axis_error_total{venue,axis,error_class="none"} at construction, only for axes this venue can actually reach', () => {
    const axisErrorCounter = { inc: vi.fn() } as unknown as Counter<string>;
    build({}, undefined, undefined, undefined, {}, axisErrorCounter); // construction alone — no reconcile() call
    const calls = (axisErrorCounter.inc as ReturnType<typeof vi.fn>).mock.calls;
    for (const axis of ['openOrders', 'trades', 'balances']) {
      expect(calls, axis).toContainEqual([{ venue: V, axis, error_class: 'none' }, 0]);
    }
    // positions is unreachable off the default legacy fixture (no fetchPositions implemented) — must
    // not be seeded, or it would be a fabricated child this fixture's exchange can never move.
    expect(calls.some(([labels]) => (labels as { axis: string }).axis === 'positions')).toBe(false);
  });

  // Companion to the seed test above: the single-venue legacy path's OWN positions/balances
  // reachability checks (this.cfg.positionAxis / this.exchange.fetchPositions / this.cfg.balanceAxis)
  // are each a real branch, not vacuously false forever — this pins the true arm of both.
  it('single-venue axis-error seed reaches positions when the fixture implements fetchPositions, and skips balances when the venue config disables it', () => {
    const axisErrorCounter = { inc: vi.fn() } as unknown as Counter<string>;
    build(
      { positions: () => [] },
      undefined,
      undefined,
      undefined,
      { balanceAxis: false },
      axisErrorCounter,
    ); // construction alone
    const calls = (axisErrorCounter.inc as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toContainEqual([{ venue: V, axis: 'positions', error_class: 'none' }, 0]);
    expect(calls.some(([labels]) => (labels as { axis: string }).axis === 'balances')).toBe(false);
  });

  it('records reconciliation_runs_total{venue,result} and stamps last-success only on a clean pass', async () => {
    const runs = { inc: vi.fn() } as unknown as Counter<string>;
    const lastSuccess = { set: vi.fn() } as unknown as Gauge<string>;
    const incCalls = (runs.inc as ReturnType<typeof vi.fn>).mock.calls;
    const setCalls = (lastSuccess.set as ReturnType<typeof vi.fn>).mock.calls;

    // clean pass → result 'clean', gauge set to clock-now/1000
    const clean = build({}, undefined, runs, lastSuccess);
    await clean.recon.reconcile();
    expect(incCalls.at(-1)).toEqual([{ venue: V, result: 'clean' }]);
    expect(setCalls.at(-1)).toEqual([T / 1000]);

    // Mismatch pass → result 'mismatch', no new gauge set. Task C3 re-decision (2026-07-27): this
    // case used to use a foreign open order, but a foreign order is a BENIGN class and no longer
    // withholds the clean stamp (that literal-zero requirement is exactly what starved auto-resume
    // for 39h). The invariant worth pinning is unchanged in substance — an ACTIONABLE mismatch must
    // not advance the gauge — so it now uses adopt_query_failure (local-open, venue-absent, fetchOrder
    // throws): non-halting, actionable, and therefore still clean-blocking.
    const setCountAfterClean = setCalls.length;
    const mismatch = build({ openOrders: [] }, undefined, runs, lastSuccess, {
      sweepSymbols: [SYM],
    });
    seedOpenOrder(mismatch, OTHER_COID);
    await mismatch.recon.reconcile();
    expect(incCalls.at(-1)).toEqual([{ venue: V, result: 'mismatch' }]);
    expect(setCalls.length).toBe(setCountAfterClean); // gauge unchanged on an ACTIONABLE mismatch

    // Companion to the above: a benign-only pass DOES advance the gauge post-C3.
    const benign = build(
      { openOrders: [venueOrder('someoneElseOrder', 'open')] },
      undefined,
      runs,
      lastSuccess,
      { sweepSymbols: [SYM] },
    );
    await benign.recon.reconcile();
    expect(incCalls.at(-1)).toEqual([{ venue: V, result: 'mismatch' }]); // raw total still non-zero
    expect(setCalls.length).toBe(setCountAfterClean + 1); // but the clean stamp advances

    // halt pass (our-prefix unknown open) → result 'halt'
    const halt = build(
      { openOrders: [venueOrder(OTHER_COID, 'open')] },
      undefined,
      runs,
      lastSuccess,
      { sweepSymbols: [SYM] },
    );
    await halt.recon.reconcile();
    expect(incCalls.at(-1)).toEqual([{ venue: V, result: 'halt' }]);
  });

  it('a clean pass: no mismatches, not halted, one reconciliations row', async () => {
    const ctx = build();
    const r = await ctx.recon.reconcile();
    expect(r).toEqual({ mismatches: 0, actionableMismatches: 0, halted: false });
    expect(ctx.store.reconciliations).toHaveLength(1);
    expect(ctx.store.reconciliations[0]!.detail).toBe('clean');
    expect(ctx.engages).toHaveLength(0);
  });

  // 2026-07-29: every reconciliations row written since the v3 cutover carried durationMs /
  // openOrdersChecked / tradesChecked / balancesChecked as a literal 0 — the persisting store
  // hardcoded them because ReconciliationRow never carried them, so 23,973 audit rows said nothing
  // about the pass that wrote them, and `open_orders_checked=0` had already been cited as venue
  // evidence when it was a constant. A constant is indistinguishable from a real measured zero, so
  // this pins a NON-zero value on every field whose axis produced one.
  it('the reconciliations row records what the pass actually examined, not a constant', async () => {
    const ctxRef: { current?: Ctx } = {};
    const ctx = build(
      {
        openOrders: [venueOrder('someoneElseOrder', 'open')],
        // foreign trades: counted by the axis, ignored by classification — so the count is pinned
        // NON-zero without dragging a halt into the assertion. A toBe(0) here would pass just as
        // happily with the increment deleted, which is the whole failure mode being pinned.
        trades: [trade('someoneElseTrade', 'foreign-1'), trade('someoneElseTrade', 'foreign-2')],
        // fires mid-pass, after the open-orders axis and before the row is written
        beforeTrades: () => ctxRef.current!.setNow(T + 250),
      },
      undefined,
      undefined,
      undefined,
      { sweepSymbols: [SYM] },
    );
    ctxRef.current = ctx;
    await ctx.recon.reconcile();

    const row = ctx.store.reconciliations[0]!;
    expect(row.openOrdersChecked).toBe(1); // the one open order the venue sweep returned
    expect(row.tradesChecked).toBe(2); // both trades the sweep returned
    expect(row.balancesChecked).toBe(1); // the local USDT balance the axis compared
    expect(row.durationMs).toBe(250); // read off the clock across the pass, not a literal
  });

  // The deployed config is the one this matters for: every venue is `demo`, so venueReconConfig
  // turns balanceAxis off and the count would otherwise be a 0 indistinguishable from the constant
  // it replaced — on the ONLY configuration that actually runs.
  it('a disabled axis writes AXIS_NOT_RUN, never a zero that reads as "compared nothing"', async () => {
    const ctx = build({}, undefined, undefined, undefined, {
      sweepSymbols: [SYM],
      balanceAxis: false,
    });
    await ctx.recon.reconcile();

    const row = ctx.store.reconciliations[0]!;
    expect(row.balancesChecked).toBe(AXIS_NOT_RUN);
    expect(row.balancesChecked).not.toBe(0);
    expect(row.openOrdersChecked).toBe(0); // this axis DID run and found none — a measured zero
  });

  // Backlog #52: reconcile.pass is a diagnostic mirror of the same result the runsCounter increments —
  // asserted once here (clean) rather than per-branch, since every branch already exercises `result`
  // via runsCounter/detail assertions above.
  it('emits an ops-event reconcile.pass{result,mismatchClasses,venue} on every pass', async () => {
    const ctx = build();
    await ctx.recon.reconcile();
    expect(ctx.opsEvents).toEqual([
      { event: 'reconcile.pass', result: 'clean', mismatchClasses: [], venue: V },
    ]);
  });

  it('a foreign venue open order is a WARN mismatch, not a halt', async () => {
    const ctx = build(
      { openOrders: [venueOrder('someoneElseOrder', 'open')] },
      undefined,
      undefined,
      undefined,
      {
        sweepSymbols: [SYM],
      },
    );
    const r = await ctx.recon.reconcile();
    expect(r.mismatches).toBe(1);
    expect(r.halted).toBe(false);
  });

  it('our-prefix venue open order unknown locally HALTs (no auto-cancel)', async () => {
    const ctx = build(
      { openOrders: [venueOrder(OTHER_COID, 'open')] },
      undefined,
      undefined,
      undefined,
      {
        sweepSymbols: [SYM],
      },
    );
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(true);
    expect(ctx.engages[0]!.flatten).toBe(false); // HALT, never auto-flatten
    expect(ctx.engages[0]!.reason).toContain('UNKNOWN_OURS_OPEN');
  });

  it('labels a halting class and a benign class separately on one pass (#24): unknown_ours_open + foreign_open_order', async () => {
    const counter = { inc: vi.fn() } as unknown as Counter<string>;
    const ctx = build(
      { openOrders: [venueOrder(OTHER_COID, 'open'), venueOrder('someoneElseOrder', 'open')] },
      counter,
      undefined,
      undefined,
      { sweepSymbols: [SYM] },
    );
    const r = await ctx.recon.reconcile();
    expect(r.mismatches).toBe(2);
    const calls = (counter.inc as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toContainEqual([{ class: 'unknown_ours_open' }, 1]);
    expect(calls).toContainEqual([{ class: 'foreign_open_order' }, 1]);
  });

  // 2026-07-31 incident (boot 4753ef53): the axis reads localOpen ONCE, AFTER the whole per-symbol
  // fetchOpenOrders loop finishes, so a coid resting at the venue when ITS symbol was swept, then
  // cancelled locally before the loop ended, misclassified as UNKNOWN_OURS purely from that timing
  // gap. resolveUnknownOursOpen resolves the coid against OrderBookService first (never pruned
  // within a process) and the durable store second, before concluding corruption.
  describe('UNKNOWN_OURS second-tier resolution (2026-07-31 incident)', () => {
    it('no book record and no durable row ⇒ still HALTs, and detail now carries the coid', async () => {
      const ctx = build(
        { openOrders: [venueOrder(OTHER_COID, 'open')] },
        undefined,
        undefined,
        undefined,
        { sweepSymbols: [SYM] },
      );
      const r = await ctx.recon.reconcile();
      expect(r.halted).toBe(true);
      expect(ctx.store.reconciliations[0]!.detail).toBe(`UNKNOWN_OURS_OPEN:${OTHER_COID}`);
    });

    it('book record TERMINAL ⇒ no halt, stale_venue_open bumped, clean stamp still withheld', async () => {
      const counter = { inc: vi.fn() } as unknown as Counter<string>;
      const ctx = build(
        { openOrders: [venueOrder(OTHER_COID, 'open')] },
        counter,
        undefined,
        undefined,
        { sweepSymbols: [SYM] },
      );
      const coid = seedOpenOrder(ctx, OTHER_COID);
      // Simulate the race: the strategy cancelled it (OrderBookService folds the venue truth, the
      // portfolio open-order entry is retired) between this symbol's sweep and the local read.
      ctx.orders.apply(coid, { type: 'VENUE_CANCELED' });
      ctx.portfolio.closeOrder(coid);
      const r = await ctx.recon.reconcile();
      expect(r.halted).toBe(false);
      expect(r.mismatches).toBe(1);
      expect(r.actionableMismatches).toBeGreaterThan(0); // stays out of NON_ACTIONABLE_CLASSES
      expect((counter.inc as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
        { class: 'stale_venue_open' },
        1,
      ]);
    });

    it('durable row CANCELED, no book record ⇒ no halt, stale_venue_open bumped (durable tier)', async () => {
      const counter = { inc: vi.fn() } as unknown as Counter<string>;
      const ctx = build(
        { openOrders: [venueOrder(OTHER_COID, 'open')] },
        counter,
        undefined,
        undefined,
        { sweepSymbols: [SYM] },
      );
      // No OrderBookService record at all — but the durable store still holds it, TERMINAL, on the
      // same venue: the in-memory book merely hadn't caught up. This is the branch behind the durable
      // tier's whole reason for existing.
      ctx.store.orders.set(OTHER_COID, {
        state: 'CANCELED',
        qty: '1',
        cumQty: '0',
        venueOrderId: 'v1',
        intentId: 'durable-intent',
        venue: V,
        symbol: SYM,
      });
      const r = await ctx.recon.reconcile();
      expect(r.halted).toBe(false);
      expect(r.mismatches).toBe(1);
      expect((counter.inc as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
        { class: 'stale_venue_open' },
        1,
      ]);
    });

    it('durable row exists NON-terminal ⇒ still HALTs (lost from memory while genuinely live)', async () => {
      const ctx = build(
        { openOrders: [venueOrder(OTHER_COID, 'open')] },
        undefined,
        undefined,
        undefined,
        { sweepSymbols: [SYM] },
      );
      // No OrderBookService record — but the durable store still holds it, non-terminal, on the
      // same venue: exactly the FILL_FOR_UNKNOWN_ORDER shape the trade axis halts on.
      ctx.store.orders.set(OTHER_COID, {
        state: 'ACKED',
        qty: '1',
        cumQty: '0',
        venueOrderId: 'v1',
        intentId: 'durable-intent',
        venue: V,
        symbol: SYM,
      });
      const r = await ctx.recon.reconcile();
      expect(r.halted).toBe(true);
      expect(ctx.engages[0]!.reason).toContain(`UNKNOWN_OURS_OPEN:${OTHER_COID}`);
    });

    it('durable row ACKED on a different venue than the sweeping exchange ⇒ still HALTs', async () => {
      const ctx = build(
        { openOrders: [venueOrder(OTHER_COID, 'open')] },
        undefined,
        undefined,
        undefined,
        { sweepSymbols: [SYM] },
      );
      // The row is real and non-terminal, but it belongs to a DIFFERENT venue — comparing row.venue
      // directly (not deriving venue from symbol) must treat this identically to no row at all.
      ctx.store.orders.set(OTHER_COID, {
        state: 'ACKED',
        qty: '1',
        cumQty: '0',
        venueOrderId: 'v1',
        intentId: 'durable-intent',
        venue: venueId('binanceusdm'),
        symbol: SYM,
      });
      const r = await ctx.recon.reconcile();
      expect(r.halted).toBe(true);
      expect(ctx.engages[0]!.reason).toContain(`UNKNOWN_OURS_OPEN:${OTHER_COID}`);
    });

    it('durable read throwing still HALTs — fail closed on "could not confirm"', async () => {
      const ctx = build(
        { openOrders: [venueOrder(OTHER_COID, 'open')] },
        undefined,
        undefined,
        undefined,
        { sweepSymbols: [SYM] },
      );
      ctx.store.loadOrderByClientOrderId = () => {
        throw new Error('durable store unavailable');
      };
      const r = await ctx.recon.reconcile();
      expect(r.halted).toBe(true);
      expect(ctx.engages[0]!.reason).toContain(`UNKNOWN_OURS_OPEN:${OTHER_COID}`);
    });

    it('regression: a coid cancelled AFTER its own symbol sweep resolves but BEFORE the sweep loop finishes does not halt', async () => {
      const counter = { inc: vi.fn() } as unknown as Counter<string>;
      let releaseGate: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const ctx = build(
        { openOrders: [venueOrder(OTHER_COID, 'open')], openOrdersGate: gate },
        counter,
        undefined,
        undefined,
        { sweepSymbols: [SYM] },
      );
      const coid = seedOpenOrder(ctx, OTHER_COID);
      const pending = ctx.recon.reconcile();
      // The pass is suspended inside fetchOpenOrders(SYM), exactly where the live incident's
      // CANCEL_OPEN_SIGNAL landed mid-sweep — fold the cancel now, before the gate releases and the
      // loop's post-sweep localOpen read runs.
      ctx.orders.apply(coid, { type: 'VENUE_CANCELED' });
      ctx.portfolio.closeOrder(coid);
      releaseGate();
      const r = await pending;
      expect(r.halted).toBe(false);
      expect((counter.inc as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
        { class: 'stale_venue_open' },
        1,
      ]);
    });

    // Cause C (MUST-FIX 1): a resolved-terminal reading that the venue keeps listing open anyway is
    // not always the sampling race above — it could be an order genuinely still resting live at the
    // venue. A per-coid consecutive-pass streak is what tells the two apart.
    describe('staleVenueOpenStreak escalation', () => {
      it(`stays open ${CFG.driftPasses} consecutive stale_venue_open passes without halting, then HALTs on pass ${CFG.driftPasses + 1}`, async () => {
        const ctx = build(
          { openOrders: [venueOrder(OTHER_COID, 'open')] },
          undefined,
          undefined,
          undefined,
          { sweepSymbols: [SYM] },
        );
        const coid = seedOpenOrder(ctx, OTHER_COID);
        ctx.orders.apply(coid, { type: 'VENUE_CANCELED' });
        ctx.portfolio.closeOrder(coid);
        for (let i = 0; i < CFG.driftPasses; i++) {
          expect((await ctx.recon.reconcile()).halted).toBe(false);
        }
        const r = await ctx.recon.reconcile();
        expect(r.halted).toBe(true);
        expect(ctx.engages[0]!.reason).toContain(`UNKNOWN_OURS_OPEN:${OTHER_COID}`);
      });

      it('resets the streak the moment the coid drops out of venueOpen', async () => {
        const script: ExchangeScript = { openOrders: [venueOrder(OTHER_COID, 'open')] };
        const ctx = build(script, undefined, undefined, undefined, { sweepSymbols: [SYM] });
        const coid = seedOpenOrder(ctx, OTHER_COID);
        ctx.orders.apply(coid, { type: 'VENUE_CANCELED' });
        ctx.portfolio.closeOrder(coid);
        for (let i = 0; i < CFG.driftPasses; i++) {
          expect((await ctx.recon.reconcile()).halted).toBe(false);
        }
        // The coid drops out of venue truth for one pass — a resolved race, not corruption — so the
        // streak must reset rather than merely pause.
        script.openOrders = [];
        expect((await ctx.recon.reconcile()).halted).toBe(false);
        // Had the streak NOT reset, this re-appearance would push it past cfg.driftPasses and HALT.
        script.openOrders = [venueOrder(OTHER_COID, 'open')];
        expect((await ctx.recon.reconcile()).halted).toBe(false);
      });

      // v3 §1.5: the cleanup sweep in reconcileOpenOrders is scoped to `${exchange.venue}|` — a
      // second venue's pass, sharing the SAME ReconciliationService instance and its SAME
      // staleVenueOpenStreak map, must skip (not delete) a streak entry that belongs to a different
      // venue, even though that entry does not appear in ITS OWN venueCoids either.
      it("a streak entry left by one venue is never pruned by another venue's own cleanup sweep", async () => {
        const PERP = venueId('binanceusdm');
        const clock = { now: () => epochMs(T) };
        const store = new InMemoryExecutionStore();
        const orders = new OrderBookService();
        const portfolio = new PortfolioStateService(
          { quoteAsset: 'USDT', startingCash: '100000' },
          new FeeLedgerService(),
        );
        const sampler = new EquitySamplerService(portfolio, fixedFeed('100'), clock, store);
        const { ks, engages } = killSwitchStub();
        const ingestor = new FillIngestorService(store, ks, orders, portfolio, sampler);
        const baseExchange = {
          capabilities: {
            clientOrderId: true,
            fetchOrderByClientId: true,
            wsUserStream: true,
            stp: false,
            sandbox: true,
          },
          placeOrder: () => Promise.reject(new Error('unused')),
          cancelOrder: () => Promise.reject(new Error('unused')),
          fetchOrder: () => Promise.reject(new Error('unused')),
          fetchBalances: () =>
            Promise.resolve(new Map([['USDT', { free: '100000', locked: '0' }]])),
          fetchMyTrades: () => Promise.resolve([]),
          validateCredentials: () => Promise.reject(new Error('unused')),
        };
        const spotPort: ExchangePort = {
          ...baseExchange,
          venue: V,
          fetchOpenOrders: () => Promise.resolve([venueOrder(OTHER_COID, 'open')]),
        };
        const perpPort: ExchangePort = {
          ...baseExchange,
          venue: PERP,
          fetchOpenOrders: () => Promise.resolve([]),
        };
        const ports = new Map([
          [V, spotPort],
          [PERP, perpPort],
        ]);
        const registry = new Map<VenueId, VenueRuntimeDescriptor>([
          [
            V,
            {
              venue: V,
              config: { id: V, environment: 'demo' },
              symbols: [SYM],
              capitalShare: '500',
              perpCapable: false,
            },
          ],
          [
            PERP,
            {
              venue: PERP,
              config: { id: PERP, environment: 'demo' },
              symbols: [],
              capitalShare: '500',
              perpCapable: false,
            },
          ],
        ]);
        const recon = new ReconciliationService(
          clock,
          spotPort,
          store,
          ks,
          CFG,
          orders,
          portfolio,
          ingestor,
          undefined,
          undefined,
          undefined,
          ports,
          registry,
          undefined,
          undefined,
        );
        // SPOT: venue-open, terminal locally ⇒ stale_venue_open, leaving `${V}|${OTHER_COID}` in
        // staleVenueOpenStreak. PERP has no orders of its own, so its OWN cleanup sweep runs over an
        // empty venueCoids — the SPOT key must survive that sweep untouched (wrong prefix, `continue`).
        orders.create(initialOrder(OTHER_COID, qty('1'), '0.001', SYM));
        orders.apply(OTHER_COID, { type: 'SUBMIT_SENT' });
        orders.apply(OTHER_COID, { type: 'ACK', venueOrderId: 'v1' });
        portfolio.addInFlight(makeIntent({ clientOrderId: OTHER_COID }));
        portfolio.openOrder(makeIntent().strategyId, {
          clientOrderId: OTHER_COID,
          symbol: SYM,
          side: 'BUY',
          qty: qty('1'),
          limitPrice: price('100'),
        });
        orders.apply(OTHER_COID, { type: 'VENUE_CANCELED' });
        portfolio.closeOrder(OTHER_COID);

        const r = await recon.reconcile();
        expect(r.halted).toBe(false);
        expect(r.mismatches).toBe(1); // SPOT's stale_venue_open only — PERP's pass is clean
        expect(engages).toHaveLength(0);
      });
    });

    // Cause A/B vs. a genuine portfolio-vs-book desync: an order OrderBookService still tracks
    // NON-terminal (still ACKED) is KNOWN by any honest reading even if the portfolio's own
    // open-order set no longer lists it — this must record nothing, not even stale_venue_open.
    it('OrderBookService tracks the coid NON-terminal ⇒ nothing recorded (no bump, no halt)', async () => {
      const ctx = build(
        { openOrders: [venueOrder(OTHER_COID, 'open')] },
        undefined,
        undefined,
        undefined,
        { sweepSymbols: [SYM] },
      );
      const coid = seedOpenOrder(ctx, OTHER_COID); // ACKed in OrderBookService, open in portfolio
      // Retire it from the portfolio's open-order set WITHOUT a terminal fold — OrderBookService
      // still reads ACKED, simulating a portfolio/book desync rather than an actual cancel.
      ctx.portfolio.closeOrder(coid);
      const r = await ctx.recon.reconcile();
      expect(r.halted).toBe(false);
      expect(r.mismatches).toBe(0);
    });
  });

  it('labels a failed per-symbol sweep as sweep_failure (#24)', async () => {
    const counter = { inc: vi.fn() } as unknown as Counter<string>;
    const ctx = build({ openOrdersThrow: true }, counter);
    seedOpenOrder(ctx);
    await ctx.recon.reconcile();
    expect((counter.inc as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
      { class: 'sweep_failure' },
      1,
    ]);
  });

  it('a failed per-symbol open-order sweep is a WARN mismatch and skips terminal adoption', async () => {
    const ctx = build({ openOrdersThrow: true });
    const coid = seedOpenOrder(ctx); // SYM has local state → swept → the sweep fails
    const r = await ctx.recon.reconcile();
    // Exactly the sweep-failure mismatch: adoptTerminal must NOT run (its fetchOrder stub would
    // throw and add a second mismatch if it did).
    expect(r.mismatches).toBe(1);
    expect(r.halted).toBe(false);
    expect(ctx.orders.get(coid)?.state).toBe('ACKED'); // absence ≠ venue truth when the fetch failed
  });

  // Task C4 (2026-07-27 incident): 39h / 93,738 binance sweep_failure increments with the caught
  // error discarded by a bare `catch {}` — these four cases are the diagnostic surfacing fix.
  describe('axis-error diagnostics (Task C4) and the detail precedence fix (Task H1)', () => {
    class FakeVenueTimeout extends Error {}

    it("a per-symbol sweep failure logs a WARN containing the injected error's message and increments reconciliation_axis_error_total with venue/axis/error_class", async () => {
      const err = new FakeVenueTimeout('binance timed out fetching open orders');
      const axisErrorCounter = { inc: vi.fn() } as unknown as Counter<string>;
      const logged: string[] = [];
      const warnSpy = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation((msg: unknown) => void logged.push(String(msg)));
      try {
        const ctx = build(
          { openOrdersThrowError: err },
          undefined,
          undefined,
          undefined,
          { sweepSymbols: [SYM] },
          axisErrorCounter,
        );
        await ctx.recon.reconcile();
        expect(logged.some((l) => l.includes('binance timed out fetching open orders'))).toBe(true);
        expect((axisErrorCounter.inc as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
          { venue: V, axis: 'openOrders', error_class: 'FakeVenueTimeout' },
        ]);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("errorClassName composes AdapterError's errorClass:code — the only shape production ever throws (every ccxt-exchange.adapter.ts sweep call rethrows toAdapterError(e), so err.constructor.name alone is always the literal 'AdapterError')", async () => {
      const err = new AdapterError(
        'TRANSPORT_RETRYABLE',
        'RequestTimeout',
        'binance request timed out',
      );
      const axisErrorCounter = { inc: vi.fn() } as unknown as Counter<string>;
      const ctx = build(
        { openOrdersThrowError: err },
        undefined,
        undefined,
        undefined,
        { sweepSymbols: [SYM] },
        axisErrorCounter,
      );
      await ctx.recon.reconcile();
      expect((axisErrorCounter.inc as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
        { venue: V, axis: 'openOrders', error_class: 'TRANSPORT_RETRYABLE:RequestTimeout' },
      ]);
    });

    it('rate-limits the WARN to one line per venue:axis per pass while the counter increments per-event: the same error on 3 symbols logs once but increments 3 times', async () => {
      const err = new FakeVenueTimeout('symbol-scoped timeout');
      const axisErrorCounter = { inc: vi.fn() } as unknown as Counter<string>;
      const logged: string[] = [];
      const warnSpy = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation((msg: unknown) => void logged.push(String(msg)));
      try {
        const ctx = build(
          { openOrdersThrowError: err },
          undefined,
          undefined,
          undefined,
          { sweepSymbols: [SYM, symbolId('ETH/USDT'), symbolId('SOL/USDT')] },
          axisErrorCounter,
        );
        await ctx.recon.reconcile();
        expect(logged.filter((l) => l.includes('symbol-scoped timeout'))).toHaveLength(1); // rate-limited
        // Pass 50: the constructor now seeds this counter's reachable zero children first — filter
        // those out (error_class:'none') to count only this pass's real per-event increments.
        const realCalls = (axisErrorCounter.inc as ReturnType<typeof vi.fn>).mock.calls.filter(
          ([labels]) => (labels as { error_class: string }).error_class !== 'none',
        );
        expect(realCalls).toHaveLength(3); // per-event
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('a throwing logger and a throwing counter do not break the pass (fail-open regression)', async () => {
      const throwingCounter = {
        inc: vi.fn(() => {
          throw new Error('counter exploded');
        }),
      } as unknown as Counter<string>;
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
        throw new Error('logger exploded');
      });
      try {
        const ctx = build(
          { openOrdersThrow: true },
          undefined,
          undefined,
          undefined,
          { sweepSymbols: [SYM] },
          throwingCounter,
        );
        const r = await ctx.recon.reconcile();
        expect(r.mismatches).toBe(1); // the sweep_failure mismatch still landed
        expect(r.halted).toBe(false);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('a pass with sweep_failure mismatches and no halts persists a detail naming the class and count, never "clean"', async () => {
      const ctx = build({ openOrdersThrow: true }, undefined, undefined, undefined, {
        sweepSymbols: [SYM],
      });
      const r = await ctx.recon.reconcile();
      expect(r.halted).toBe(false);
      expect(ctx.store.reconciliations[0]!.detail).toBe('sweep_failure:1');
    });
  });

  it('balanceAxis=false skips the balances axis entirely (shared demo account)', async () => {
    const ctx = build(
      { balances: () => new Map([['USDT', { free: '90000', locked: '0' }]]) }, // would be BALANCE_DRIFT
      undefined,
      undefined,
      undefined,
      { balanceAxis: false },
    );
    const r = await ctx.recon.reconcile();
    expect(r).toEqual({ mismatches: 0, actionableMismatches: 0, halted: false });
    expect(ctx.engages).toHaveLength(0);
  });

  it('configured sweepSymbols are swept even with zero local state', async () => {
    // No orders, no positions — only the config names SYM; the failing trade sweep proves it ran.
    const ctx = build({ tradesThrow: true }, undefined, undefined, undefined, {
      sweepSymbols: [SYM],
    });
    const r = await ctx.recon.reconcile();
    expect(r.mismatches).toBe(1);
    expect(r.halted).toBe(false);
  });

  it('an axis throw past the per-item guards records result=error + PASS_ERROR row, then rethrows', async () => {
    const runs = { inc: vi.fn() } as unknown as Counter<string>;
    const coid = makeIntent().clientOrderId;
    const ctx = build(
      { openOrders: [venueOrder(coid, 'open')], trades: [trade(coid, 'boom-1')] },
      undefined,
      runs,
    );
    seedOpenOrder(ctx, coid);
    // The ingest path's store write throwing is exactly the kind of escape the pass accounting must
    // survive: the row and the runs counter still land, and the driver sees the rethrow.
    ctx.store.saveFill = () => {
      throw new Error('db down');
    };
    await expect(ctx.recon.reconcile()).rejects.toThrow('db down');
    expect((runs.inc as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([
      { venue: V, result: 'error' },
    ]);
    expect(ctx.store.reconciliations).toHaveLength(1);
    expect(ctx.store.reconciliations[0]!.detail).toBe('PASS_ERROR:Error:db down');
    expect(ctx.store.reconciliations[0]!.halted).toBe(false);
  });

  it('a non-Error axis throw is described by type in the PASS_ERROR detail', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({ openOrders: [venueOrder(coid, 'open')], trades: [trade(coid, 'boom-2')] });
    seedOpenOrder(ctx, coid);
    ctx.store.saveFill = () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising the non-Error branch
      throw 'string failure';
    };
    await expect(ctx.recon.reconcile()).rejects.toBe('string failure');
    expect(ctx.store.reconciliations[0]!.detail).toBe('PASS_ERROR:string:string failure');
  });

  it.each<[ExchangeOrderState['status'], string]>([
    ['canceled', 'CANCELED'],
    ['expired', 'EXPIRED'],
  ])(
    'a local open order absent from the venue adopts the venue terminal truth (%s)',
    async (status, expected) => {
      const ctx = build({
        openOrders: [],
        fetchOrder: () => venueOrder(makeIntent().clientOrderId, status),
      });
      const coid = seedOpenOrder(ctx);
      const r = await ctx.recon.reconcile();
      expect(ctx.orders.get(coid)?.state).toBe(expected);
      expect(r.mismatches).toBeGreaterThan(0);
      expect(r.halted).toBe(false);
    },
  );

  it('a venue "rejected" for an order we already acked is a WARN inconsistency, not an illegal adopt', async () => {
    const ctx = build({
      openOrders: [],
      fetchOrder: () => venueOrder(makeIntent().clientOrderId, 'rejected'),
    });
    const coid = seedOpenOrder(ctx);
    const r = await ctx.recon.reconcile();
    expect(ctx.orders.get(coid)?.state).toBe('ACKED'); // unchanged — never folded illegally
    expect(r.mismatches).toBeGreaterThan(0);
    expect(r.halted).toBe(false);
  });

  it('venue closed (filled) forces myTrades backfill — does not cancel-adopt', async () => {
    const intent = makeIntent();
    const coid = intent.clientOrderId;
    const ctx = build(
      {
        openOrders: [],
        fetchOrder: () => ({ ...venueOrder(coid, 'closed'), cumQty: '1' }),
        // ccxt myTrades shape: clientOrderId field carries the venue numeric order id
        trades: [trade('v1', 'fill-closed-1')],
        // Post-fill book: spent ~100 USDT for 1 BTC — avoid BALANCE_DRIFT HALT noise.
        balances: () =>
          new Map([
            ['USDT', { free: '99900', locked: '0' }],
            ['BTC', { free: '1', locked: '0' }],
          ]),
      },
      undefined,
      undefined,
      undefined,
      { balanceAxis: true },
    );
    seedOpenOrder(ctx, coid, {}, 'v1');
    const r = await ctx.recon.reconcile();
    expect(ctx.orders.get(coid)?.state).toBe('FILLED');
    expect(r.halted).toBe(false);
    expect(r.mismatches).toBeGreaterThan(0); // backfilled_fill still counts as a mismatch class
  });

  it('venue closed with no matching trades stays ACKED + adopt_non_adoptable', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({
      openOrders: [],
      fetchOrder: () => venueOrder(coid, 'closed'),
      trades: [],
    });
    seedOpenOrder(ctx, coid);
    const r = await ctx.recon.reconcile();
    expect(ctx.orders.get(coid)?.state).toBe('ACKED');
    expect(r.mismatches).toBeGreaterThan(0);
    expect(r.halted).toBe(false);
  });

  // Same trap Pass 60 fixed for the sibling MAX_TRADE_LOOKBACK_MS floor (see the census comment
  // above it), left open here: pinned ccxt 4.5.58 derives endTime = min(since + 7d, now) once
  // now - since >= 7d for a linear market, and equality alone satisfies >=. An exact-7d lookback
  // therefore always collapses `endTime` to a `now` read before loadMarkets/signing/the network
  // round trip, silently truncating the newest trades — including possibly the fill this backfill
  // exists to recover — with no thrown error (empty-array success).
  it("floors the closed-order backfill lookback strictly inside ccxt's 7-day linear-market cap, never at it", async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({
      openOrders: [],
      fetchOrder: () => venueOrder(coid, 'closed'),
      trades: [],
    });
    seedOpenOrder(ctx, coid);
    await ctx.recon.reconcile();
    // Two DISTINCT fetchMyTrades calls are expected: reconcileOpenOrders' adoptTerminal →
    // backfillClosedOrderTrades (axis 1) runs before reconcileTrades (axis 2, reconcileEveryVenue),
    // so index 0 is the backfill's own `since`. The length assertion is load-bearing, not
    // decorative: on this cold checkpoint both axes independently floor to the SAME T-6d (axis 2 via
    // the unrelated MAX_TRADE_LOOKBACK_MS floor), so checking index 0's VALUE alone cannot tell
    // "backfill ran and computed 6d" apart from "backfill was skipped entirely and index 0 is really
    // axis 2's call" — asserting exactly 2 calls happened is what proves the backfill's own call is
    // genuinely present (a regression that dropped it would collapse this to length 1).
    expect(ctx.tradeSinceCalls).toHaveLength(2);
    const since = ctx.tradeSinceCalls[0]!;
    expect(T - since).toBe(6 * 86_400_000);
    expect(T - since).toBeLessThan(7 * 86_400_000);
  });

  it('a "closed" order whose local record never captured a venueOrderId refuses via adopt_non_adoptable rather than guessing which trades are its own', async () => {
    const intent = makeIntent();
    const coid = intent.clientOrderId;
    const ctx = build({
      openOrders: [],
      fetchOrder: () => venueOrder(coid, 'closed'),
    });
    // Believed open in the portfolio (a crash between placeOrder and the ACK persist), but the
    // order-book record itself never recorded a venueOrderId — backfillClosedOrderTrades cannot
    // resolve WHICH venue order id any trades would belong to.
    ctx.orders.create(initialOrder(coid, intent.qty, '0.001', SYM));
    ctx.orders.apply(coid, { type: 'SUBMIT_SENT' }); // no ACK — venueOrderId stays undefined
    ctx.portfolio.addInFlight(intent);
    ctx.portfolio.openOrder(intent.strategyId, {
      clientOrderId: coid,
      symbol: SYM,
      side: 'BUY',
      qty: intent.qty,
      limitPrice: price('100'),
    });
    const r = await ctx.recon.reconcile();
    expect(ctx.orders.get(coid)?.state).toBe('SUBMITTING'); // untouched — never adopted
    expect(r.mismatches).toBeGreaterThan(0);
    expect(r.halted).toBe(false);
    expect(ctx.store.reconciliations[0]!.detail).toContain('adopt_non_adoptable');
  });

  it("a fetchMyTrades failure during closed-order backfill records adopt_query_failure, and — combined with the trade axis's own sweep_failure — the detail column sorts by class name", async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({
      openOrders: [],
      fetchOrder: () => venueOrder(coid, 'closed'),
      tradesThrow: true, // both the closed-order backfill AND the trade axis call fetchMyTrades
    });
    seedOpenOrder(ctx, coid);
    const r = await ctx.recon.reconcile();
    expect(ctx.orders.get(coid)?.state).toBe('ACKED'); // never adopted — the query itself failed
    expect(r.halted).toBe(false);
    // Three classes land: the failed backfill query itself (adopt_query_failure), the still-
    // non-terminal record adoptTerminal notices afterward (adopt_non_adoptable), and the trade
    // axis's own independent sweep of the same symbol (sweep_failure) — sorted alphabetically,
    // never insertion order.
    expect(ctx.store.reconciliations[0]!.detail).toBe(
      'adopt_non_adoptable:1,adopt_query_failure:1,sweep_failure:1',
    );
  });

  it('closed-order backfill applies only the trade matching the recorded venueOrderId, skipping a foreign one under the same symbol', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({
      openOrders: [],
      fetchOrder: () => venueOrder(coid, 'closed'),
      trades: [trade('foreign-venue-id', 'skip-1'), trade('v1', 'match-1')],
      balances: () =>
        new Map([
          ['USDT', { free: '99900', locked: '0' }],
          ['BTC', { free: '1', locked: '0' }],
        ]),
    });
    seedOpenOrder(ctx, coid, {}, 'v1');
    const r = await ctx.recon.reconcile();
    expect(ctx.orders.get(coid)?.state).toBe('FILLED'); // only the matching trade folded it terminal
    expect(ctx.store.fills.size).toBe(1); // the foreign trade under the same venueOrderId scope skipped
    expect(r.mismatches).toBeGreaterThan(0); // backfilled_fill
    expect(r.halted).toBe(false);
  });

  it('venueOrderIndex never indexes a record with no symbol recorded — a trade citing that venueOrderId falls through as foreign rather than risking a cross-venue mismatch', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build(
      { openOrders: [], trades: [trade('v-nosym', 'nosym-1')] },
      undefined,
      undefined,
      undefined,
      { sweepSymbols: [SYM] },
    );
    // A record with no symbol (a legacy/lost-symbol row) — venueOrderIndex must skip it rather than
    // index it blind, which could hand a DIFFERENT venue's trade to this record (its own header
    // comment's rule 1).
    ctx.orders.create(initialOrder(coid, qty('1'), '0.001')); // no symbol argument
    ctx.orders.apply(coid, { type: 'SUBMIT_SENT' });
    ctx.orders.apply(coid, { type: 'ACK', venueOrderId: 'v-nosym' });
    const r = await ctx.recon.reconcile();
    expect(ctx.orders.get(coid)?.cumQty.toFixed()).toBe('0'); // never resolved via the in-memory index
    expect(ctx.store.fills.size).toBe(0);
    expect(r.halted).toBe(false);
  });

  it.each<['CANCEL_PENDING' | 'CANCEL_UNKNOWN']>([['CANCEL_PENDING'], ['CANCEL_UNKNOWN']])(
    'adopts venue "canceled" for a %s order — the 2026-07-07 stranded-cancel regression',
    async (state) => {
      const runs = { inc: vi.fn() } as unknown as Counter<string>;
      const ctx = build(
        { openOrders: [], fetchOrder: () => venueOrder('any', 'canceled') },
        undefined,
        runs,
      );
      const coid = seedOpenOrder(ctx);
      ctx.orders.apply(coid, { type: 'CANCEL_REQUESTED' }); // ACKED → CANCEL_PENDING
      if (state === 'CANCEL_UNKNOWN') ctx.orders.apply(coid, { type: 'CANCEL_REJECT_UNKNOWN' });
      const r = await ctx.recon.reconcile();
      expect(ctx.orders.get(coid)?.state).toBe('CANCELED');
      expect(ctx.portfolio.snapshot().openOrders).toHaveLength(0); // retired, not stuck
      expect(r.halted).toBe(false);
      expect((runs.inc as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([
        { venue: V, result: 'mismatch' }, // an adopted terminal, never a PASS_ERROR abort
      ]);
    },
  );

  it('a fold the reducer refuses does not abort the pass — remaining orders still reconcile', async () => {
    const runs = { inc: vi.fn() } as unknown as Counter<string>;
    const ctx = build(
      { openOrders: [], fetchOrder: () => venueOrder('any', 'canceled') },
      undefined,
      runs,
    );
    // First order frozen at RECONCILE_REQUIRED: VENUE_CANCELED is illegal there and the fold throws.
    const frozen = seedOpenOrder(ctx);
    ctx.orders.apply(frozen, { type: 'CANCEL_REQUESTED' });
    ctx.orders.apply(frozen, { type: 'CANCEL_REJECT_UNKNOWN' });
    ctx.orders.apply(frozen, { type: 'QUERY_INCONCLUSIVE' });
    // Second order is a healthy ACKED adoption that must still run after the refused fold.
    const adoptable = seedOpenOrder(ctx, OTHER_COID);
    const r = await ctx.recon.reconcile();
    expect(ctx.orders.get(frozen)?.state).toBe('RECONCILE_REQUIRED'); // untouched
    expect(ctx.orders.get(adoptable)?.state).toBe('CANCELED'); // the pass kept going
    expect((runs.inc as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([
      { venue: V, result: 'mismatch' }, // 2026-07-07: this was result=error and 100% reconcile downtime
    ]);
    expect(r.halted).toBe(false);
  });

  it('a non-TransitionError from an adopt-terminal fold still aborts the pass (rethrown past the refusal guard)', async () => {
    const runs = { inc: vi.fn() } as unknown as Counter<string>;
    const ctx = build(
      { openOrders: [], fetchOrder: () => venueOrder('any', 'canceled') },
      undefined,
      runs,
    );
    seedOpenOrder(ctx);
    // The refusal guard swallows only reducer refusals (TransitionError); an infrastructure
    // throw (store down) must escape it and abort through the PASS_ERROR machinery.
    ctx.store.appendOrderEvent = () => {
      throw new Error('store down');
    };
    await expect(ctx.recon.reconcile()).rejects.toThrow('store down');
    expect((runs.inc as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([
      { venue: V, result: 'error' },
    ]);
  });

  it('backfills a missed fill for a known order via the FillIngestor (WARN)', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({
      openOrders: [venueOrder(coid, 'open')],
      trades: [trade(coid, 'missed-1')],
    });
    seedOpenOrder(ctx, coid);
    const r = await ctx.recon.reconcile();
    expect(ctx.store.fills.size).toBe(1); // the missed fill was ingested
    expect(r.mismatches).toBeGreaterThan(0);
  });

  it('a trade for a DURABLY-ours order unknown locally HALTs', async () => {
    // Seed a known order on SYM so SYM is swept; the orphan trade is a DIFFERENT our-prefix id.
    // The write-ahead intent for that id IS present, so its absence from the book is corruption.
    const known = makeIntent().clientOrderId;
    const ctx = build({
      openOrders: [venueOrder(known, 'open')],
      trades: [trade(OTHER_COID, 'orphan-1')],
    });
    seedOpenOrder(ctx, known);
    await ctx.store.saveIntent(makeIntent({ clientOrderId: OTHER_COID }), {
      nonce: 'n',
      approvedAtMs: T,
      ttlMs: 60_000,
    } as never);
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(true);
    expect(ctx.engages.some((e) => e.reason.includes('FILL_FOR_UNKNOWN_ORDER'))).toBe(true);
  });

  it('the same trade with NO durable write-ahead intent is a foreign twin, not a halt', async () => {
    // isOurClientOrderId matches the cb-shape only — no venue, no run, no boot — so a second
    // instance of this software on the shared demo key mints ids indistinguishable from ours. The
    // write-ahead persists every one of OUR intents before the network call, so a missing intent
    // row proves the trade was never ours; halting the whole book on it would hand a stranger a
    // kill switch. Uncertainty still fails CLOSED — only a definite null downgrades the verdict.
    const known = makeIntent().clientOrderId;
    const ctx = build({
      openOrders: [venueOrder(known, 'open')],
      trades: [trade(OTHER_COID, 'orphan-1')],
    });
    seedOpenOrder(ctx, known);
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(false);
    expect(ctx.engages.some((e) => e.reason.includes('FILL_FOR_UNKNOWN_ORDER'))).toBe(false);
  });

  it('a write-ahead intent lookup that THROWS halts exactly as before — "could not confirm foreign" is never "confirmed foreign"', async () => {
    // The downgrade above rests on a DEFINITE null. An unavailable intent store answers neither
    // "ours" nor "theirs", and the benign reading is the one that would let a real corruption pass
    // as a stranger's trade — so the only safe resolution of a throw is the original halt (rule 6).
    const known = makeIntent().clientOrderId;
    const ctx = build({
      openOrders: [venueOrder(known, 'open')],
      trades: [trade(OTHER_COID, 'orphan-1')],
    });
    seedOpenOrder(ctx, known);
    const lookupSpy = vi
      .spyOn(ctx.store, 'loadIntentByClientOrderId')
      .mockRejectedValue(new Error('intent store unreachable'));
    const logged: string[] = [];
    const errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((msg: unknown) => void logged.push(String(msg)));
    try {
      const r = await ctx.recon.reconcile();
      expect(r.halted).toBe(true);
      expect(ctx.engages.some((e) => e.reason.includes('FILL_FOR_UNKNOWN_ORDER'))).toBe(true);
      // The diagnostic must name the coid and the cause, or the halt is unactionable: this is the
      // only place the operator learns the verdict came from an unavailable store, not from evidence.
      expect(
        logged.some((l) => l.includes(OTHER_COID) && l.includes('intent store unreachable')),
      ).toBe(true);
    } finally {
      errorSpy.mockRestore();
      lookupSpy.mockRestore();
    }
  });

  it('a store that never wired the OPTIONAL write-ahead lookup halts too — the downgrade is earned by evidence, never assumed from its absence', async () => {
    // ExecutionStorePort declares loadIntentByClientOrderId with a `?`, so a conforming
    // implementation may omit it entirely (the pre-2026-08-03 store shape). Reading an unwired probe
    // as "no intent row" would turn every cb-shaped orphan into a foreign twin on such a store —
    // silently disabling the corruption halt rather than a stranger's kill switch.
    const known = makeIntent().clientOrderId;
    const ctx = build({
      openOrders: [venueOrder(known, 'open')],
      trades: [trade(OTHER_COID, 'orphan-1')],
    });
    seedOpenOrder(ctx, known);
    (ctx.store as unknown as { loadIntentByClientOrderId?: unknown }).loadIntentByClientOrderId =
      undefined;
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(true);
    expect(ctx.engages.some((e) => e.reason.includes('FILL_FOR_UNKNOWN_ORDER'))).toBe(true);
  });

  // Cluster-A: on the real venue, VenueFill.clientOrderId carries the numeric venue order id
  // (ccxt myTrades has no clientOrderId field) — normalizeTrade sets it from `t.order`. These three
  // cases exercise the venue-id-first resolution + durable second-tier discrimination that replaces
  // the old cb-prefix-only classification.
  it('resolves a venue-shaped trade (numeric order id, no coid) to OUR order via the venueOrderId index and backfills it — the ccxt myTrades path (cluster-A)', async () => {
    const coid = makeIntent().clientOrderId;
    // balanceAxis:false isolates this to the trade axis — applying the fill moves local cash away
    // from the default venue-balance stub, an unrelated axis this test does not exercise (same
    // isolation the position-axis tests below use for the identical reason).
    const ctx = build(
      {
        openOrders: [venueOrder(coid, 'open')],
        trades: [trade('48212893', 'venue-shaped-1')], // numeric venue order id, not our coid
      },
      undefined,
      undefined,
      undefined,
      { balanceAxis: false },
    );
    seedOpenOrder(ctx, coid, {}, '48212893'); // ACKED with this order's real venue order id
    const r = await ctx.recon.reconcile();
    expect(ctx.store.fills.size).toBe(1); // backfilled_fill — the trade resolved via venueOrderId
    expect(r.halted).toBe(false);
  });

  // 2026-07-27 incident regression: several trades of ONE order inside a SINGLE pass. byVenueId is
  // built once per pass, so folding from it restarts every trade at that snapshot's cumQty — the
  // order ends at the LAST trade's qty, stays non-terminal forever, and reports adopt_non_adoptable
  // on every later pass (starving the clean stamp and auto-resume). Live shape: 8 trades summing to
  // the full qty left cum_qty at the final trade's 0.045 of 0.365.
  it('two partial trades of the SAME order in ONE pass accumulate to FILLED — folds read the live book, never the per-pass venueOrderId snapshot', async () => {
    const coid = makeIntent().clientOrderId; // BUY 1 @ 100, step 0.001
    const half = (tradeId: string): VenueFill => ({ ...trade('v1', tradeId), qty: '0.5' });
    const ctx = build(
      { openOrders: [venueOrder(coid, 'open')], trades: [half('partial-1'), half('partial-2')] },
      undefined,
      undefined,
      undefined,
      { balanceAxis: false }, // isolate to the trade axis — the fills move local cash off the stub
    );
    seedOpenOrder(ctx, coid, {}, 'v1');
    const r = await ctx.recon.reconcile();
    expect(ctx.orders.get(coid)?.cumQty.toFixed()).toBe('1'); // 0.5 + 0.5, not the last trade's 0.5
    expect(ctx.orders.get(coid)?.state).toBe('FILLED');
    expect(ctx.store.fills.size).toBe(2);
    expect(r.halted).toBe(false);
    // The incident's defining artifact was a NON-MONOTONE cumQty run in the append-only journal
    // (0.022, 0.05, …, 0.045). Pin the sequence, not just the end state — rule 6 makes those rows
    // permanent, so a regression here is unrepairable after the fact.
    expect(ctx.store.events.filter((e) => e.event.type === 'FILL').map((e) => e.cumQty)).toEqual([
      '0.5',
      '1',
    ]);
    // Money: every fill must still reach the portfolio. Exact string, never toBeCloseTo.
    const positions = [...ctx.portfolio.snapshot().positions.values()];
    expect(positions).toHaveLength(1);
    expect(positions[0]!.signedQty.toFixed()).toBe('1');
  });

  it('a backfill that would fold PAST the order qty halts as FILL_OVERFLOW carrying the symbol, and the LATER axes still run — an escaping reducer throw would abort the pass before them', async () => {
    const coid = makeIntent().clientOrderId; // qty 1, step 0.001
    const ctx = build({
      openOrders: [venueOrder(coid, 'open')],
      // Two FULL-qty trades attributed to one order: the second fold sees cumQty 2 > qty + step.
      trades: [trade('v1', 'overflow-1'), trade('v1', 'overflow-2')],
      // Balances axis LEFT ON and deliberately disagreeing (the first fill moved local cash to
      // 99900 while the venue still says 100000). BALANCE_DRIFT can only appear if the pass reached
      // the balances axis AFTER the overflow — that is what pins "the pass finishes".
    });
    seedOpenOrder(ctx, coid, {}, 'v1');
    const r = await ctx.recon.reconcile(); // must RESOLVE, not reject
    expect(r.halted).toBe(true);
    const reason = ctx.engages.map((e) => e.reason).join('|');
    expect(reason).toContain(`FILL_OVERFLOW:${SYM}`); // symbol carried into the audit trail
    expect(reason).toContain('BALANCE_DRIFT'); // the later axis ran
    expect(r.actionableMismatches).toBeGreaterThan(0); // fail closed — never stamps clean

    // The residue, and why the runbook calls this a one-shot notification: BOTH fill rows are
    // committed (saveFill runs before the fold), so the already-recorded filter skips the offending
    // trade next pass and the overflow is NEVER re-detected. Pinned so the operator-facing claim
    // cannot silently stop being true.
    expect(ctx.store.fills.size).toBe(2);
    ctx.engages.length = 0;
    await ctx.recon.reconcile();
    expect(ctx.engages.map((e) => e.reason).join('|')).not.toContain('FILL_OVERFLOW');
  });

  it('a NON-reducer throw past saveFill is contained as fill_fold_failed — actionable (blocks the clean stamp) but not a halt, since a store blip is not a proven money divergence', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build(
      {
        openOrders: [venueOrder(coid, 'open')],
        trades: [trade('v1', 'fold-fail-1')],
      },
      undefined,
      undefined,
      undefined,
      { balanceAxis: false },
    );
    seedOpenOrder(ctx, coid, {}, 'v1');
    // The fill row commits, then the journal write fails — the shape a Postgres blip produces.
    ctx.store.appendOrderEvent = () => Promise.reject(new Error('store down'));
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(false);
    expect(r.actionableMismatches).toBeGreaterThan(0);
    expect(ctx.store.fills.size).toBe(1); // the residue: row committed, fold never landed
  });

  it('a venue-shaped trade (numeric order id, no coid) resolving to a NON-terminal durable-only order HALTs as FILL_FOR_UNKNOWN_ORDER — in-memory-lost live state is ours, never foreign (cluster-A)', async () => {
    const ctx = build(
      { trades: [trade('77777777', 'venue-shaped-2')] },
      undefined,
      undefined,
      undefined,
      {
        sweepSymbols: [SYM],
      },
    );
    // Durable-only: I1's write-ahead persisted this order (saveNewOrder + the ACK's
    // appendOrderEvent) but it was never (re)loaded into the runtime OrderBookService — simulates a
    // crash / second instance / a recovery gap, exactly the corruption FILL_FOR_UNKNOWN_ORDER exists
    // to catch. State is ACKED — NON-terminal — which is the load-bearing bit: 2026-07-19's tier-2
    // refinement only ingests when the durable order is terminal; a still-live order missing from
    // memory must still HALT unconditionally, unchanged.
    const lost = OTHER_COID;
    await ctx.store.saveNewOrder(
      initialOrder(lost, qty('1'), '0.001', SYM),
      makeIntent({ clientOrderId: lost }),
    );
    await ctx.store.appendOrderEvent({
      clientOrderId: lost,
      dedupeKey: 'ack',
      event: { type: 'ACK', venueOrderId: '77777777' },
      derivedState: 'ACKED',
      cumQty: '0',
      venueOrderId: '77777777',
    });
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(true);
    expect(ctx.engages.some((e) => e.reason.includes('FILL_FOR_UNKNOWN_ORDER'))).toBe(true);
  });

  // 2026-07-19 spot-lane false-HALT incident: a historical TERMINAL order (a TP fill that executed
  // server-side while the host slept) is absent from the rehydrated in-memory book by design (boot
  // recovery only reloads non-terminal orders) — every 30s pass kept re-discovering the same old
  // trade via the checkpoint/overlap window and HALTing on it forever. These two cases are the fix.
  it('an already-recorded fill for a historical TERMINAL durable-only order is a silent no-op — the first filter stops the recurring false-HALT', async () => {
    const ctx = build(
      { trades: [trade('55555555', 'historical-1')] },
      undefined,
      undefined,
      undefined,
      { sweepSymbols: [SYM] },
    );
    const lost = OTHER_COID;
    await ctx.store.saveNewOrder(
      initialOrder(lost, qty('1'), '0.001', SYM),
      makeIntent({ clientOrderId: lost }),
    );
    await ctx.store.appendOrderEvent({
      clientOrderId: lost,
      dedupeKey: 'ack',
      event: { type: 'ACK', venueOrderId: '55555555' },
      derivedState: 'FILLED', // durably TERMINAL — boot recovery never rehydrates it
      cumQty: '1',
      venueOrderId: '55555555',
    });
    // Pre-record the SAME venueTradeId — simulates the fill having already been ingested (a prior
    // boot, or earlier this same boot).
    await ctx.store.saveFill(
      {
        venue: V,
        symbol: SYM,
        venueTradeId: 'historical-1',
        clientOrderId: lost,
        price: price('100'),
        qty: qty('1'),
        fee: null,
        liquidity: 'taker',
        venueTimestamp: epochMs(T),
        source: 'rest_reconcile',
      },
      'some-intent-id',
    );
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(false);
    expect(ctx.store.fills.size).toBe(1); // unchanged — no double-ingest
  });

  it('an UNRECORDED fill for a historical TERMINAL durable-only order backfills as backfilled_fill — no halt (the missed-fill recovery actually working)', async () => {
    const ctx = build(
      { trades: [{ ...trade('66666666', 'unrecorded-1'), qty: '0.00000001' }] }, // dust-sized: stays within the FILLED order's qty+stepSize tolerance
      undefined,
      undefined,
      undefined,
      { sweepSymbols: [SYM] },
    );
    const lost = OTHER_COID;
    await ctx.store.saveNewOrder(
      initialOrder(lost, qty('1'), '0.001', SYM),
      makeIntent({ clientOrderId: lost }),
    );
    await ctx.store.appendOrderEvent({
      clientOrderId: lost,
      dedupeKey: 'ack',
      event: { type: 'ACK', venueOrderId: '66666666' },
      derivedState: 'FILLED',
      cumQty: '1',
      venueOrderId: '66666666',
    });
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(false);
    expect(ctx.store.fills.size).toBe(1); // backfilled — never seen before, correctly ingested
  });

  it('balance drift beyond ε HALTs, no auto-flatten', async () => {
    const ctx = build({ balances: () => new Map([['USDT', { free: '90000', locked: '0' }]]) }); // 10000 < 100000 by 10000 ≫ ε
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(true);
    expect(ctx.engages[0]!.reason).toContain('BALANCE_DRIFT:USDT');
    expect(ctx.engages[0]!.flatten).toBe(false);
  });

  it('within-ε drift that grows monotonically across 3 passes HALTs (systematic leak)', async () => {
    let n = 0;
    const ctx = build({
      balances: () => {
        n += 1;
        // 0.001, 0.002, 0.003 below the local 100000 — each within ε (tol 10) but strictly growing.
        return new Map([
          [
            'USDT',
            { free: new Decimal(100000).add(new Decimal(0.001).mul(n)).toFixed(), locked: '0' },
          ],
        ]);
      },
    });
    expect((await ctx.recon.reconcile()).halted).toBe(false); // pass 1
    expect((await ctx.recon.reconcile()).halted).toBe(false); // pass 2
    const third = await ctx.recon.reconcile(); // pass 3 — strictly growing window
    expect(third.halted).toBe(true);
    expect(ctx.engages.at(-1)!.reason).toContain('BALANCE_LEAK:USDT');
  });

  it('drift history trims to driftPasses entries across many passes, and strictly-growing detection still fires past the trim boundary', async () => {
    const driftPasses = 3;
    let n = 0;
    const ctx = build(
      {
        balances: () => {
          n += 1;
          // Strictly increasing every pass, same shape as the 3-pass case above, run well past
          // driftPasses so the front-trim (reconciliation.service.ts's driftHistory push site) fires
          // repeatedly — proves the per-asset array never grows past driftPasses AND the
          // strictly-growing window detection is unaffected by the trim.
          return new Map([
            [
              'USDT',
              { free: new Decimal(100000).add(new Decimal(0.001).mul(n)).toFixed(), locked: '0' },
            ],
          ]);
        },
      },
      undefined,
      undefined,
      undefined,
      { driftPasses },
    );
    const passes = driftPasses + 5;
    for (let i = 0; i < passes; i++) {
      await ctx.recon.reconcile();
    }
    const driftHistory = (ctx.recon as unknown as { driftHistory: Map<string, Decimal[]> })
      .driftHistory;
    // v3: keyed by `${venue}|${asset}` (not asset alone) so a spot wallet's and a perp wallet's same-
    // ticker balance can never share a drift-history bucket (reconciliation.service.ts).
    expect(driftHistory.get(`${V}|USDT`)).toHaveLength(driftPasses); // never grows past driftPasses
    // One more strictly-increasing pass past the trim boundary still HALTs on the leak.
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(true);
    expect(ctx.engages.at(-1)!.reason).toContain('BALANCE_LEAK:USDT');
  });

  it('a local-open order the venue still reports open is an inconsistency WARN (no terminal adopt)', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({ openOrders: [], fetchOrder: () => venueOrder(coid, 'open') }); // absent from list yet "open"
    seedOpenOrder(ctx, coid);
    const r = await ctx.recon.reconcile();
    expect(ctx.orders.get(coid)?.state).toBe('ACKED'); // not adopted to a terminal
    expect(r.mismatches).toBeGreaterThan(0);
    expect(r.halted).toBe(false);
  });

  it('an order we cannot query while believed open is a WARN mismatch', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({
      openOrders: [],
      fetchOrder: () => {
        throw new Error('fetchOrder down');
      },
    });
    seedOpenOrder(ctx, coid);
    const r = await ctx.recon.reconcile();
    expect(r.mismatches).toBeGreaterThan(0);
    expect(r.halted).toBe(false);
  });

  it('a failed trade sweep for a symbol is a WARN mismatch', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({ openOrders: [venueOrder(coid, 'open')], tradesThrow: true });
    seedOpenOrder(ctx, coid); // SYM is of interest → its trade sweep is attempted and fails
    const r = await ctx.recon.reconcile();
    expect(r.mismatches).toBeGreaterThan(0);
    expect(r.halted).toBe(false);
  });

  it('a failed balance fetch is a WARN mismatch', async () => {
    const ctx = build({ balancesThrow: true });
    const r = await ctx.recon.reconcile();
    expect(r.mismatches).toBe(1);
    expect(r.halted).toBe(false);
  });

  it('an already-recorded trade is a no-op (no new mismatch)', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({ openOrders: [venueOrder(coid, 'open')], trades: [trade(coid, 'known-1')] });
    seedOpenOrder(ctx, coid);
    // The fill is already in the store with the SAME payload — reconcile must not double-count it.
    await ctx.store.saveFill(
      {
        venue: V,
        symbol: SYM,
        venueTradeId: 'known-1',
        clientOrderId: coid,
        price: price('100'),
        qty: makeIntent().qty,
        fee: null,
        liquidity: 'taker',
        venueTimestamp: epochMs(T),
        source: 'ws',
      },
      'i1',
    );
    const r = await ctx.recon.reconcile();
    expect(r.mismatches).toBe(0); // dedupe: nothing new
    expect(r.halted).toBe(false);
  });

  it('advances the per-(venue,symbol) checkpoint so a second pass re-reads it', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({ openOrders: [venueOrder(coid, 'open')], trades: [trade(coid, 'cp-1')] });
    seedOpenOrder(ctx, coid); // stays ACKED + open (KNOWN); SYM is swept both passes
    // Pre-store the fill so each sweep dedupes it (no balance change), isolating the checkpoint path.
    await ctx.store.saveFill(
      {
        venue: V,
        symbol: SYM,
        venueTradeId: 'cp-1',
        clientOrderId: coid,
        price: price('100'),
        qty: makeIntent().qty,
        fee: null,
        liquidity: 'taker',
        venueTimestamp: epochMs(T),
        source: 'ws',
      },
      'i1',
    );
    const first = await ctx.recon.reconcile(); // sets checkpoint = T (the trade's venueTimestamp)
    const second = await ctx.recon.reconcile(); // reads the non-zero checkpoint → since = T − overlap
    expect(first.mismatches).toBe(0);
    expect(second.mismatches).toBe(0);
    expect(ctx.store.fills.size).toBe(1);
    // Once a checkpoint exists the overlap window is unchanged by the cold-start floor below.
    expect(ctx.tradeSinceCalls[1]).toBe(T - CFG.overlapMs);
  });

  // 2026-08-03 census: binanceusdm checked ZERO trades across all 19,587 lifetime passes while its
  // open-orders axis ran normally. A cold checkpoint asked for `since = 0`, and pinned ccxt 4.5.58
  // turns that into a 1970-01-01..1970-01-08 window on a linear market (binance.js:8253-8266 derives
  // endTime = min(since + 7d, now)); the venue answers an EMPTY ARRAY without throwing, so no
  // sweep_failure is recorded and the checkpoint — which only advances off a returned trade — stays
  // 0 forever. Probe-verified in-container: HYPE/USDT:USDT since=0 ⇒ 0 trades, since=now−24h ⇒ 9.
  it('floors a cold checkpoint at a bounded recent lookback, never 0, so the trades axis cannot deadlock on an unanswerable window', async () => {
    const ctx = build({ trades: [] }, undefined, undefined, undefined, { sweepSymbols: [SYM] });
    await ctx.recon.reconcile();
    expect(ctx.tradeSinceCalls).toHaveLength(1);
    const since = ctx.tradeSinceCalls[0]!;
    expect(since).not.toBe(0);
    expect(since).toBe(T - 6 * 86_400_000);
    // The window must stay strictly inside Binance's 7-day startTime..endTime cap, or ccxt derives
    // an endTime behind `now` and truncates exactly the newest trades this axis exists to find.
    expect(T - since).toBeLessThan(7 * 86_400_000);
  });

  // The floor is a FLOOR, not a replacement: a checkpoint newer than the lookback keeps its own
  // narrow overlap window, so the fix cannot silently widen every steady-state sweep.
  it('leaves a fresh checkpoint on its overlap window and re-floors only once the checkpoint goes stale', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build(
      { openOrders: [venueOrder(coid, 'open')], trades: [trade(coid, 'lb-1')] },
      undefined,
      undefined,
      undefined,
      // balanceAxis:false isolates this to the trade axis — the backfilled BUY moves quote cash away
      // from the default venue balance stub, which would add an unrelated BALANCE_DRIFT halt.
      { sweepSymbols: [SYM], balanceAxis: false },
    );
    seedOpenOrder(ctx, coid);
    await ctx.recon.reconcile(); // cold: floored
    await ctx.recon.reconcile(); // checkpoint = T ⇒ overlap window
    ctx.setNow(T + 30 * 86_400_000); // 30 days later: the checkpoint is far outside the venue's cap
    await ctx.recon.reconcile();
    expect(ctx.tradeSinceCalls[0]).toBe(T - 6 * 86_400_000);
    expect(ctx.tradeSinceCalls[1]).toBe(T - CFG.overlapMs);
    expect(ctx.tradeSinceCalls[2]).toBe(T + 30 * 86_400_000 - 6 * 86_400_000);
  });

  // The floor's twin at the other end (2026-08-03). The checkpoint is monotone and drives the next
  // pass's `since`, so ONE trade stamped in an unbounded future would advance it past every real
  // trade and sweep this symbol's fills out of the window forever — the same permanent blindness the
  // cold-start floor above exists to prevent, arrived at from the opposite direction.
  it('reconciles future-stamped trades but refuses to let the checkpoint follow the stamp, and reports the whole sweep in ONE error line', async () => {
    const coid = makeIntent().clientOrderId; // BUY 1 @ 100, step 0.001
    // Two HALVES of the same order: a venue emitting the wrong time UNIT stamps the whole batch, and
    // two full-qty trades would halt on FILL_OVERFLOW instead of exercising the clamp.
    const future = (tradeId: string): VenueFill => ({
      ...trade(coid, tradeId),
      qty: '0.5',
      venueTimestamp: epochMs(T + 30 * 86_400_000),
    });
    const ctx = build(
      { openOrders: [venueOrder(coid, 'open')], trades: [future('skew-1'), future('skew-2')] },
      undefined,
      undefined,
      undefined,
      // balanceAxis:false isolates this to the trade axis (see the venueOrderId-backfill test above).
      { sweepSymbols: [SYM], balanceAxis: false },
    );
    seedOpenOrder(ctx, coid);
    const logged: string[] = [];
    const errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((msg: unknown) => void logged.push(String(msg)));
    try {
      const first = await ctx.recon.reconcile();
      expect(first.halted).toBe(false);
      expect(ctx.store.fills.size).toBe(2); // the trades themselves are reconciled regardless
      const clampLines = logged.filter((l) => l.includes('stamped beyond'));
      expect(clampLines).toHaveLength(1); // per (venue, symbol) sweep — a per-trade line would bury it
      expect(clampLines[0]).toContain('returned 2 trade(s)');
      expect(clampLines[0]).toContain(`clamped to ${T + VENUE_TIMESTAMP_SKEW_ALLOWANCE_MS}`);
      await ctx.recon.reconcile();
    } finally {
      errorSpy.mockRestore();
    }
    // The clamped checkpoint read through its only external view: the `since` the SECOND sweep asked
    // for. Following the stamp would have asked for T + 30d − overlap, i.e. a window containing no
    // trade that has actually happened yet.
    expect(ctx.tradeSinceCalls[1]).toBe(T + VENUE_TIMESTAMP_SKEW_ALLOWANCE_MS - CFG.overlapMs);
  });

  it('does not re-fold an adopt-terminal the journal already recorded (replay-safe)', async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({ openOrders: [], fetchOrder: () => venueOrder(coid, 'canceled') });
    seedOpenOrder(ctx, coid);
    // A prior life journaled the cancel adopt under the reconcile dedupe key.
    await ctx.store.appendOrderEvent({
      clientOrderId: coid,
      dedupeKey: 'reconcile:VENUE_CANCELED',
      event: { type: 'VENUE_CANCELED' },
      derivedState: 'CANCELED',
      cumQty: '0',
    });
    await ctx.recon.reconcile();
    expect(ctx.orders.get(coid)?.state).toBe('ACKED'); // fold skipped — journal said duplicate
  });

  it('a trade resolving to neither an in-memory nor a durable order is genuinely foreign — ignored, never a halt (cluster-A) — only the known order backfills its fee-bearing fill', async () => {
    const coid = makeIntent().clientOrderId;
    const feeTrade: VenueFill = { ...trade(coid, 'fee-1'), fee: { ccy: 'USDT', amount: '0.1' } };
    const foreign: VenueFill = { ...trade('someoneElseTrade', 'foreign-1') };
    // balanceAxis:false isolates this to the trade axis (see the venueOrderId-backfill test above).
    const ctx = build(
      { openOrders: [venueOrder(coid, 'open')], trades: [foreign, feeTrade] },
      undefined,
      undefined,
      undefined,
      { balanceAxis: false },
    );
    seedOpenOrder(ctx, coid);
    const r = await ctx.recon.reconcile();
    expect(ctx.store.fills.size).toBe(1); // only ours ingested; the foreign trade is ignored
    expect([...ctx.store.fills.values()][0]!.fee?.amount.toFixed()).toBe('0.1');
    expect(r.halted).toBe(false); // no in-memory or durable match ⇒ genuinely foreign, never a halt
  });

  describe('position axis (Defect A fail-closed backstop)', () => {
    // balanceAxis:false isolates every case below to the position axis alone — the local BUY fill
    // moves quote cash away from the default venue balance stub, which would otherwise add an
    // unrelated BALANCE_DRIFT mismatch to these assertions.
    function seedLocalLong(ctx: Ctx, sz = '0.001', symbol = SYM) {
      const intent = makeIntent({ qty: qty(sz), symbol });
      ctx.portfolio.applyFill(
        intent,
        makeFill({ qty: intent.qty, price: intent.refPrice, symbol }),
      );
    }

    it('first divergent pass: position_drift counted, NO halt (debounce lets in-flight recovery land)', async () => {
      const counter = { inc: vi.fn() } as unknown as Counter<string>;
      const ctx = build({ positions: () => [] }, counter, undefined, undefined, {
        balanceAxis: false,
      });
      seedLocalLong(ctx);
      const r = await ctx.recon.reconcile();
      expect(r.halted).toBe(false);
      expect(ctx.engages).toHaveLength(0);
      expect((counter.inc as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
        { class: 'position_drift' },
        1,
      ]);
    });

    it('first divergent pass (non-halting): the persisted detail names the symbol and both exact qty strings — the debounce makes this the ONLY record whenever the drift self-heals (2026-08-03 KAITO/USDT:USDT incident)', async () => {
      const ctx = build({ positions: () => [] }, undefined, undefined, undefined, {
        balanceAxis: false,
      });
      seedLocalLong(ctx, '0.001'); // local 0.001, venue 0 (positions: () => [])
      const r = await ctx.recon.reconcile();
      expect(r.halted).toBe(false);
      const detail = ctx.store.reconciliations[0]!.detail;
      // Exact-equality, not toContain: the `?` discriminator (observed-not-halted) vs `:` (the
      // HALTING form, same symbol prefix) is the entire operational distinction this note exists to
      // preserve — a refactor emitting POSITION_DRIFT:${symbol} here instead would keep a loose
      // toContain green while destroying that distinction.
      expect(detail).toBe('position_drift:1;POSITION_DRIFT?BTC/USDT:local=0.001,venue=0');
    });

    it('a single pass with MORE THAN MAX_ACC_NOTES (20) distinct divergent symbols caps the persisted notes at exactly 20 and drops the rest (acc.notes.length < MAX_ACC_NOTES false arm)', async () => {
      const ctx = build({ positions: () => [] }, undefined, undefined, undefined, {
        balanceAxis: false,
      });
      const symbols = Array.from({ length: 21 }, (_, i) => symbolId(`SYM${i}/USDT`));
      for (const symbol of symbols) seedLocalLong(ctx, '0.001', symbol);
      const r = await ctx.recon.reconcile();
      expect(r.halted).toBe(false);
      const detail = ctx.store.reconciliations[0]!.detail;
      const notes = detail.split(';').filter((part) => part.startsWith('POSITION_DRIFT?'));
      expect(notes).toHaveLength(20);
      expect(detail).toContain('position_drift:21'); // all 21 divergences counted — only the notes are capped
    });

    it('second CONSECUTIVE divergent pass HALTs with POSITION_DRIFT, never auto-flattens', async () => {
      const ctx = build({ positions: () => [] }, undefined, undefined, undefined, {
        balanceAxis: false,
      });
      seedLocalLong(ctx);
      const first = await ctx.recon.reconcile();
      expect(first.halted).toBe(false);
      const second = await ctx.recon.reconcile();
      expect(second.halted).toBe(true);
      expect(ctx.engages.some((e) => e.reason.includes(`POSITION_DRIFT:${SYM}`))).toBe(true);
      expect(ctx.engages.every((e) => e.flatten === false)).toBe(true); // HALT, never auto-flatten
    });

    it('divergent → clean → divergent: no HALT (consecutive streak resets on a clean pass)', async () => {
      let venueQty = '0';
      const ctx = build(
        { positions: () => (venueQty === 'absent' ? [] : [{ symbol: SYM, signedQty: venueQty }]) },
        undefined,
        undefined,
        undefined,
        { balanceAxis: false },
      );
      seedLocalLong(ctx); // local 0.001
      expect((await ctx.recon.reconcile()).halted).toBe(false); // divergent #1 (venue 0)
      venueQty = '0.001';
      expect((await ctx.recon.reconcile()).halted).toBe(false); // clean — streak resets
      venueQty = '0';
      expect((await ctx.recon.reconcile()).halted).toBe(false); // divergent #1 again, still no HALT
      expect(ctx.engages).toHaveLength(0);
    });

    it('venue matches local exactly ⇒ clean', async () => {
      const ctx = build(
        { positions: () => [{ symbol: SYM, signedQty: '0.001' }] },
        undefined,
        undefined,
        undefined,
        { balanceAxis: false },
      );
      seedLocalLong(ctx);
      const r = await ctx.recon.reconcile();
      expect(r).toEqual({ mismatches: 0, actionableMismatches: 0, halted: false });
    });

    it('positionAxis:false ⇒ axis skipped even when fetchPositions is defined (spot-lane config)', async () => {
      // The shared adapter defines fetchPositions on every venue (vacuous [] off-perp), so config —
      // not method presence — is the decider; reconConfigFrom sets this false off-perp.
      const ctx = build({ positions: () => [] }, undefined, undefined, undefined, {
        balanceAxis: false,
        positionAxis: false,
      });
      seedLocalLong(ctx); // would drift every pass if the axis ran
      expect((await ctx.recon.reconcile()).halted).toBe(false);
      expect((await ctx.recon.reconcile()).halted).toBe(false); // past the debounce too — axis truly off
      expect(ctx.engages).toHaveLength(0);
    });

    it('fetchPositions undefined ⇒ axis skipped (existing behavior byte-identical)', async () => {
      const ctx = build({}, undefined, undefined, undefined, { balanceAxis: false });
      seedLocalLong(ctx); // would drift POSITION_DRIFT if the axis ran — no venue truth ⇒ never observed
      const r = await ctx.recon.reconcile();
      expect(r).toEqual({ mismatches: 0, actionableMismatches: 0, halted: false });
    });

    it('fetchPositions throw ⇒ sweep_failure only, no halt', async () => {
      const counter = { inc: vi.fn() } as unknown as Counter<string>;
      const ctx = build({ positionsThrow: true }, counter, undefined, undefined, {
        balanceAxis: false,
      });
      const r = await ctx.recon.reconcile();
      expect(r.halted).toBe(false);
      expect((counter.inc as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
        { class: 'sweep_failure' },
        1,
      ]);
    });

    it('exact-string qty comparison: venue 0.00100 vs local 0.001 MATCH (Decimal, not string equality)', async () => {
      const ctx = build(
        { positions: () => [{ symbol: SYM, signedQty: '0.00100' }] },
        undefined,
        undefined,
        undefined,
        { balanceAxis: false },
      );
      seedLocalLong(ctx, '0.001');
      const r = await ctx.recon.reconcile();
      expect(r).toEqual({ mismatches: 0, actionableMismatches: 0, halted: false });
    });
  });

  // R2 (2026-08-10): the repair for the four demo-fapi rows stuck ACKED since the 2026-07-31 boot —
  // an algo-rail (STOP_MARKET) order with zero exposure that NO live path (AlgoStopRecoveryService's
  // own fail-open retry, the strategy lane, HaltCoordinatorService) ever revisits once its venue
  // algo-history entry stops answering conclusively. Fails CLOSED: every case below except the first
  // asserts the row is left exactly as seeded.
  describe('algo-rail orphan repair (R2, 2026-08-10)', () => {
    const ORPHAN_COID = makeIntent({
      type: 'STOP_MARKET',
      triggerPrice: price('90'),
    }).clientOrderId;

    it('ACKED, zero cumQty, STOP_MARKET, absent from a successful read for driftPasses+1 consecutive passes ⇒ folds VENUE_EXPIRED under its own dedupe namespace, never halts', async () => {
      const counter = { inc: vi.fn() } as unknown as Counter<string>;
      // balanceAxis:false isolates this block to the algo-rail axis alone — driftPasses:1 also
      // shortens the balance-leak window to a single sample, which driftStrictlyGrowing (unrelated,
      // pre-existing) treats as vacuously "growing" and would otherwise HALT on BALANCE_LEAK.
      const ctx = build({ algoOpen: () => [] }, counter, undefined, undefined, {
        driftPasses: 1,
        balanceAxis: false,
      });
      const coid = await seedAlgoOrphan(ctx, ORPHAN_COID);
      const first = await ctx.recon.reconcile();
      expect(first.halted).toBe(false);
      expect(ctx.orders.get(coid)?.state).toBe('ACKED'); // streak=1, at the threshold — not yet
      const second = await ctx.recon.reconcile();
      expect(second.halted).toBe(false);
      expect(ctx.orders.get(coid)?.state).toBe('EXPIRED'); // streak=2 > driftPasses(1) — folds
      expect(
        ctx.store.events.some(
          (e) => e.clientOrderId === coid && e.dedupeKey === 'algo-orphan-repair:VENUE_EXPIRED',
        ),
      ).toBe(true);
      expect((counter.inc as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
        { class: 'algo_orphan_adopted' },
        1,
      ]);
      expect(ctx.engages).toHaveLength(0); // adopted_terminal's own family — never a halt
    });

    it('fold refused mid-pass (race between the candidate snapshot and the fold freezes the order at RECONCILE_REQUIRED) ⇒ contained, no bump, no halt, order left exactly as frozen', async () => {
      const counter = { inc: vi.fn() } as unknown as Counter<string>;
      const ctxRef: { current?: Ctx } = {};
      let pass = 0;
      const ctx = build(
        {
          algoOpen: () => {
            pass += 1;
            // Fires inside the awaited fetchOpenAlgoOrders call — strictly AFTER
            // candidatesBySymbol's synchronous snapshot (top of reconcileAlgoRailOrphans) already
            // read ACKED/zero-cumQty, and strictly BEFORE this same pass's fold() re-reads
            // this.orders.get(coid). Gated to the SECOND pass only — the one where streak already
            // exceeds driftPasses and a fold is actually attempted; freezing on pass 1 would just
            // make the order stop being a candidate before the debounce threshold is even reached.
            // Same CANCEL_REQUESTED → CANCEL_REJECT_UNKNOWN → QUERY_INCONCLUSIVE chain the
            // regular-rail axis's own "fold the reducer refuses" test above uses to freeze an order
            // at RECONCILE_REQUIRED — VENUE_EXPIRED is illegal there (reducer.ts case
            // 'RECONCILE_REQUIRED'), so fold's reduce() throws TransitionError.
            if (pass === 2) {
              const c = ctxRef.current!;
              c.orders.apply(ORPHAN_COID, { type: 'CANCEL_REQUESTED' });
              c.orders.apply(ORPHAN_COID, { type: 'CANCEL_REJECT_UNKNOWN' });
              c.orders.apply(ORPHAN_COID, { type: 'QUERY_INCONCLUSIVE' });
            }
            return [];
          },
        },
        counter,
        undefined,
        undefined,
        { driftPasses: 1, balanceAxis: false },
      );
      ctxRef.current = ctx;
      await seedAlgoOrphan(ctx, ORPHAN_COID);
      const first = await ctx.recon.reconcile();
      expect(first.halted).toBe(false); // streak=1, at the threshold — no fold attempted yet
      expect(ctx.orders.get(ORPHAN_COID)?.state).toBe('ACKED');
      const second = await ctx.recon.reconcile();
      expect(second.halted).toBe(false); // refusal contained — never a halt (rule 6 untouched)
      expect(ctx.orders.get(ORPHAN_COID)?.state).toBe('RECONCILE_REQUIRED'); // frozen, left alone
      expect((counter.inc as ReturnType<typeof vi.fn>).mock.calls).not.toContainEqual([
        { class: 'algo_orphan_adopted' },
        1,
      ]);
      expect(ctx.engages).toHaveLength(0);
    });

    it('a non-TransitionError from an algo-orphan fold still aborts the pass (rethrown past the refusal guard)', async () => {
      const runs = { inc: vi.fn() } as unknown as Counter<string>;
      const ctx = build({ algoOpen: () => [] }, undefined, runs, undefined, {
        driftPasses: 1,
        balanceAxis: false,
      });
      await seedAlgoOrphan(ctx, ORPHAN_COID);
      await ctx.recon.reconcile(); // streak=1, no fold attempt yet
      // The refusal guard swallows only reducer refusals (TransitionError); an infrastructure
      // throw (store down) must escape it and abort through the PASS_ERROR machinery — mirrors the
      // regular-rail axis's own equivalent test above.
      ctx.store.appendOrderEvent = () => {
        throw new Error('store down');
      };
      await expect(ctx.recon.reconcile()).rejects.toThrow('store down');
      expect((runs.inc as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([
        { venue: V, result: 'error' },
      ]);
    });

    it('venue still lists the algo-rail counterpart ⇒ left ACKED, no bump, no fold', async () => {
      const counter = { inc: vi.fn() } as unknown as Counter<string>;
      const ctx = build(
        { algoOpen: () => [algoOrder(ORPHAN_COID)] },
        counter,
        undefined,
        undefined,
        {
          driftPasses: 1,
          balanceAxis: false,
        },
      );
      const coid = await seedAlgoOrphan(ctx, ORPHAN_COID);
      await ctx.recon.reconcile();
      await ctx.recon.reconcile();
      expect(ctx.orders.get(coid)?.state).toBe('ACKED');
      expect((counter.inc as ReturnType<typeof vi.fn>).mock.calls).not.toContainEqual([
        { class: 'algo_orphan_adopted' },
        1,
      ]);
    });

    it('cumQty > 0 (PARTIALLY_FILLED) ⇒ never a candidate — the position axis stays the fail-closed backstop for real exposure', async () => {
      const ctx = build({ algoOpen: () => [] }, undefined, undefined, undefined, {
        driftPasses: 1,
        balanceAxis: false,
      });
      const coid = await seedAlgoOrphan(ctx, ORPHAN_COID);
      ctx.orders.apply(coid, { type: 'FILL', cumQty: new Decimal('0.5') });
      await ctx.recon.reconcile();
      await ctx.recon.reconcile();
      expect(ctx.orders.get(coid)?.state).toBe('PARTIALLY_FILLED');
    });

    it('fetchOpenAlgoOrders throws ⇒ sweep_failure only, no fold, streak untouched', async () => {
      const counter = { inc: vi.fn() } as unknown as Counter<string>;
      const ctx = build({ algoOpenThrow: true }, counter, undefined, undefined, {
        driftPasses: 1,
        balanceAxis: false,
      });
      const coid = await seedAlgoOrphan(ctx, ORPHAN_COID);
      const r = await ctx.recon.reconcile();
      expect(r.halted).toBe(false);
      expect(ctx.orders.get(coid)?.state).toBe('ACKED');
      expect((counter.inc as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
        { class: 'sweep_failure' },
        1,
      ]);
    });

    it('below the debounce threshold (one absent pass, default driftPasses=3) ⇒ left ACKED', async () => {
      const ctx = build({ algoOpen: () => [] });
      const coid = await seedAlgoOrphan(ctx, ORPHAN_COID);
      await ctx.recon.reconcile();
      expect(ctx.orders.get(coid)?.state).toBe('ACKED');
    });

    it('present after being absent resets the streak — a later disappearance restarts the debounce', async () => {
      let present = false;
      const ctx = build(
        { algoOpen: () => (present ? [algoOrder(ORPHAN_COID)] : []) },
        undefined,
        undefined,
        undefined,
        { driftPasses: 1, balanceAxis: false },
      );
      const coid = await seedAlgoOrphan(ctx, ORPHAN_COID);
      await ctx.recon.reconcile(); // absent, streak=1
      present = true;
      await ctx.recon.reconcile(); // present — streak reset
      present = false;
      await ctx.recon.reconcile(); // absent again, streak=1 (not carried over) — still no fold
      expect(ctx.orders.get(coid)?.state).toBe('ACKED');
      await ctx.recon.reconcile(); // absent, streak=2 > driftPasses(1) — folds
      expect(ctx.orders.get(coid)?.state).toBe('EXPIRED');
    });

    it('fetchOpenAlgoOrders undefined (spot/paper adapter) ⇒ axis skipped entirely, byte-identical to no repair existing', async () => {
      const ctx = build({}, undefined, undefined, undefined, {
        driftPasses: 1,
        balanceAxis: false,
      });
      const coid = await seedAlgoOrphan(ctx, ORPHAN_COID);
      const r = await ctx.recon.reconcile();
      expect(r).toEqual({ mismatches: 0, actionableMismatches: 0, halted: false });
      expect(ctx.orders.get(coid)?.state).toBe('ACKED');
    });

    it('ACKED, zero cumQty, but a non-STOP_MARKET intent (regular LIMIT order) ⇒ never a candidate', async () => {
      const ctx = build({ algoOpen: () => [] }, undefined, undefined, undefined, {
        driftPasses: 1,
        balanceAxis: false,
      });
      const coid = makeIntent({ type: 'LIMIT' }).clientOrderId;
      ctx.orders.create(initialOrder(coid, qty('1'), '0.001', SYM));
      ctx.orders.apply(coid, { type: 'SUBMIT_SENT' });
      ctx.orders.apply(coid, { type: 'ACK', venueOrderId: 'v1' });
      await ctx.store.saveIntent(makeIntent({ clientOrderId: coid, type: 'LIMIT' }), {
        nonce: 'n',
        approvedAtMs: T,
        ttlMs: 60_000,
      } as never);
      await ctx.recon.reconcile();
      await ctx.recon.reconcile();
      expect(ctx.orders.get(coid)?.state).toBe('ACKED');
    });

    it('ACKED, zero cumQty, but NO resolvable intent anywhere (neither in-flight nor durable) ⇒ never a candidate — the nullish chain falls all the way through to undefined', async () => {
      const ctx = build({ algoOpen: () => [] }, undefined, undefined, undefined, {
        driftPasses: 1,
        balanceAxis: false,
      });
      // A local row with no backing intent at all — a genuinely orphaned book entry (corruption, or
      // an intent row lost to a gap) this repair must never paper over by assuming STOP_MARKET.
      const coid = makeIntent().clientOrderId;
      ctx.orders.create(initialOrder(coid, qty('1'), '0.001', SYM));
      ctx.orders.apply(coid, { type: 'SUBMIT_SENT' });
      ctx.orders.apply(coid, { type: 'ACK', venueOrderId: 'v1' });
      await ctx.recon.reconcile();
      await ctx.recon.reconcile();
      expect(ctx.orders.get(coid)?.state).toBe('ACKED'); // left exactly alone
    });

    it('fetchOpenAlgoOrders resolves to a nullish, non-array read ⇒ the defensive `?? []` fallback treats it identically to an empty array', async () => {
      const ctx = build(
        { algoOpen: () => undefined as unknown as AlgoOrderState[] },
        undefined,
        undefined,
        undefined,
        { driftPasses: 1, balanceAxis: false },
      );
      const coid = await seedAlgoOrphan(ctx, ORPHAN_COID);
      await ctx.recon.reconcile(); // streak=1, at the threshold — not yet
      const r = await ctx.recon.reconcile();
      expect(r.halted).toBe(false);
      expect(ctx.orders.get(coid)?.state).toBe('EXPIRED'); // streak=2 > driftPasses(1) — same as `[]`
    });

    it('a candidate that stops being a candidate between passes (a fill arrives) leaves its stale streak entry for the cleanup pass to sweep — it never lingers under a coid that can no longer resurface', async () => {
      const ctx = build({ algoOpen: () => [] }, undefined, undefined, undefined, {
        balanceAxis: false,
      });
      const coid = await seedAlgoOrphan(ctx, ORPHAN_COID);
      await ctx.recon.reconcile(); // absent, streak=1 recorded
      // A fill arrives between passes — no longer zero-cumQty, so the NEXT pass's candidatesBySymbol
      // snapshot never re-adds it, and the stale streak entry from the pass above (present in
      // algoOrphanStreak, absent from THIS pass's stillCandidate) is swept by the cleanup loop.
      ctx.orders.apply(coid, { type: 'FILL', cumQty: new Decimal('0.5') });
      const r = await ctx.recon.reconcile();
      expect(r.halted).toBe(false);
      expect(ctx.orders.get(coid)?.state).toBe('PARTIALLY_FILLED'); // untouched by this axis
    });
  });
});

// v3 §1.5: one pass per venue per tick, one reconciliations row per venue pass. This block
// constructs the service with venuePorts/venueRegistry supplied (the composition-root wiring) and
// asserts iteration behavior; every case above this block exercises the legacy single-venue
// constructor path unchanged (byte-identical — venuePorts/venueRegistry are @Optional).
describe('ReconciliationService — v3 multi-venue iteration (§1.5)', () => {
  const SPOT = venueId('binance');
  const PERP = venueId('binanceusdm');

  function fakePort(
    venue: VenueId,
    script: { balancesThrow?: boolean; positions?: () => VenuePosition[] } = {},
  ): ExchangePort {
    return {
      venue,
      capabilities: {
        clientOrderId: true,
        fetchOrderByClientId: true,
        wsUserStream: true,
        stp: false,
        sandbox: true,
      },
      placeOrder: () => Promise.reject(new Error('unused')),
      cancelOrder: () => Promise.reject(new Error('unused')),
      fetchOrder: () => Promise.reject(new Error('unused')),
      fetchOpenOrders: () => Promise.resolve([]),
      fetchBalances: () =>
        script.balancesThrow
          ? Promise.reject(new Error('balances down'))
          : Promise.resolve(new Map([['USDT', { free: '100000', locked: '0' }]])),
      fetchMyTrades: () => Promise.resolve([]),
      validateCredentials: () => Promise.reject(new Error('unused')),
      ...(script.positions ? { fetchPositions: () => Promise.resolve(script.positions!()) } : {}),
    };
  }

  function descriptor(
    venue: VenueId,
    perpCapable: boolean,
    environment: 'demo' | 'live' = 'demo',
  ): VenueRuntimeDescriptor {
    return {
      venue,
      config: { id: venue, environment },
      symbols: [],
      capitalShare: '500',
      perpCapable,
    };
  }

  function buildMultiVenue(
    ports: ReadonlyMap<VenueId, ExchangePort>,
    registry: ReadonlyMap<VenueId, VenueRuntimeDescriptor>,
    runsCounter?: Counter<string>,
    axisErrorCounter?: Counter<string>,
  ) {
    const clock = { now: () => epochMs(T) };
    const store = new InMemoryExecutionStore();
    const orders = new OrderBookService();
    const portfolio = new PortfolioStateService(
      { quoteAsset: 'USDT', startingCash: '100000' },
      new FeeLedgerService(),
    );
    const sampler = new EquitySamplerService(portfolio, fixedFeed('100'), clock, store);
    const { ks } = killSwitchStub();
    const ingestor = new FillIngestorService(store, ks, orders, portfolio, sampler);
    const recon = new ReconciliationService(
      clock,
      ports.values().next().value!, // legacy single-venue slot — unused whenever venuePorts is present
      store,
      ks,
      { ...CFG },
      orders,
      portfolio,
      ingestor,
      undefined,
      runsCounter,
      undefined,
      ports,
      registry,
      undefined,
      axisErrorCounter,
    );
    return { store, recon };
  }

  // Pass 49 (2026-07-30): mirrors the single-venue seed test above (Pass 47) for
  // reconciliation_runs_total, but through the v3 registry path — the venue source the seed loop must
  // use to avoid naming a venue this pass never actually writes to (or missing one it does).
  it('seeds every (venue, result) pair — including halt — at construction, over every registry venue', () => {
    const runs = { inc: vi.fn() } as unknown as Counter<string>;
    const ports = new Map([
      [SPOT, fakePort(SPOT)],
      [PERP, fakePort(PERP)],
    ]);
    const registry = new Map([
      [SPOT, descriptor(SPOT, false)],
      [PERP, descriptor(PERP, true)],
    ]);
    buildMultiVenue(ports, registry, runs); // construction alone — no reconcile() call
    const calls = (runs.inc as ReturnType<typeof vi.fn>).mock.calls;
    for (const venue of [SPOT, PERP]) {
      for (const result of ['clean', 'mismatch', 'halt', 'error']) {
        expect(calls, `${venue}/${result}`).toContainEqual([{ venue, result }, 0]);
      }
    }
    expect(calls).toContainEqual([{ venue: 'all', result: 'skipped' }, 0]);
  });

  // Pass 50 (2026-07-30): the axis-error seed's own multi-venue registry-path test. Both descriptors
  // are 'demo' environment (balanceAxis off, per venueReconConfig) and fakePort never implements
  // fetchPositions — so, unlike the single-venue legacy test above, NEITHER positions NOR balances is
  // reachable for either venue here, and the seed must reflect that rather than a blind cross-product.
  it('seeds reconciliation_axis_error_total{venue,axis} over every registry venue, restricted to axes each venue can reach', () => {
    const axisErrorCounter = { inc: vi.fn() } as unknown as Counter<string>;
    const ports = new Map([
      [SPOT, fakePort(SPOT)],
      [PERP, fakePort(PERP)],
    ]);
    const registry = new Map([
      [SPOT, descriptor(SPOT, false)],
      [PERP, descriptor(PERP, true)],
    ]);
    buildMultiVenue(ports, registry, undefined, axisErrorCounter); // construction alone
    const calls = (axisErrorCounter.inc as ReturnType<typeof vi.fn>).mock.calls;
    for (const venue of [SPOT, PERP]) {
      for (const axis of ['openOrders', 'trades']) {
        expect(calls, `${venue}/${axis}`).toContainEqual([{ venue, axis, error_class: 'none' }, 0]);
      }
    }
    expect(calls.some(([labels]) => (labels as { axis: string }).axis === 'positions')).toBe(false);
    expect(calls.some(([labels]) => (labels as { axis: string }).axis === 'balances')).toBe(false);
  });

  // Companion: the registry-path seed loop's own reachability branches (positionAxis/fetchPositions,
  // balanceAxis) are each real, not vacuously false forever — and a registry venue with NO matching
  // port entry (`if (!port) continue`, mirroring reconcileEveryVenue's own guard) must be skipped
  // rather than seeding a phantom child no writer can ever move.
  it('seeds positions for a perp-capable venue whose port implements fetchPositions, balances for a non-demo venue, and skips a registry venue with no matching port', () => {
    const axisErrorCounter = { inc: vi.fn() } as unknown as Counter<string>;
    const ports = new Map([[PERP, fakePort(PERP, { positions: () => [] })]]); // SPOT has no port entry
    const registry = new Map([
      [SPOT, descriptor(SPOT, false)], // registered, but no matching port
      [PERP, descriptor(PERP, true, 'live')], // perpCapable + non-demo ⇒ both axes reachable
    ]);
    buildMultiVenue(ports, registry, undefined, axisErrorCounter); // construction alone
    const calls = (axisErrorCounter.inc as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toContainEqual([{ venue: PERP, axis: 'positions', error_class: 'none' }, 0]);
    expect(calls).toContainEqual([{ venue: PERP, axis: 'balances', error_class: 'none' }, 0]);
    expect(calls.some(([labels]) => (labels as { venue: VenueId }).venue === SPOT)).toBe(false);
  });

  it('runs one pass per venue and writes one reconciliations row per venue', async () => {
    const ports = new Map([
      [SPOT, fakePort(SPOT)],
      [PERP, fakePort(PERP)],
    ]);
    const registry = new Map([
      [SPOT, descriptor(SPOT, false)],
      [PERP, descriptor(PERP, true)],
    ]);
    const { store, recon } = buildMultiVenue(ports, registry);

    const result = await recon.reconcile();

    expect(result).toEqual({ mismatches: 0, actionableMismatches: 0, halted: false });
    expect(store.reconciliations).toHaveLength(2);
    expect(store.reconciliations.map((r) => r.venue).sort()).toEqual([PERP, SPOT].sort());
  });

  it("one venue's balances-fetch failure is isolated to that venue's row — the other venue's pass still completes clean", async () => {
    const ports = new Map([
      [SPOT, fakePort(SPOT, { balancesThrow: true })],
      [PERP, fakePort(PERP)],
    ]);
    const registry = new Map([
      // balanceAxis derives from descriptor.config.environment !== 'demo' — 'testnet' here so the
      // axis actually runs and the spot venue's fetchBalances throw is exercised.
      [SPOT, { ...descriptor(SPOT, false), config: { id: SPOT, environment: 'testnet' } }],
      [PERP, descriptor(PERP, true)],
    ]);
    const { store, recon } = buildMultiVenue(ports, registry);

    const result = await recon.reconcile();

    expect(result.halted).toBe(false); // sweep_failure never halts
    expect(result.mismatches).toBe(1); // the spot venue's one failed balances sweep, summed book-wide
    const spotRow = store.reconciliations.find((r) => r.venue === SPOT)!;
    const perpRow = store.reconciliations.find((r) => r.venue === PERP)!;
    expect(spotRow.mismatches).toBe(1); // the failed sweep is visible on the spot venue's OWN row
    expect(perpRow.mismatches).toBe(0); // the other venue's pass is unaffected
    expect(perpRow.detail).toBe('clean');
  });

  it('a registry venue with no exchange port is logged and skipped — the ported venues still reconcile', async () => {
    // Misconfiguration guard: the registry and the port map are wired independently at the
    // composition root, so a venue can appear in one and not the other. Reconciliation is a
    // measurement pass, so this fails OPEN on the missing venue (skip + error log) rather than
    // throwing and aborting every OTHER venue's pass — silently reconciling nothing would be worse.
    const ports = new Map([[SPOT, fakePort(SPOT)]]); // PERP registered but never wired a port
    const registry = new Map([
      [SPOT, descriptor(SPOT, false)],
      [PERP, descriptor(PERP, true)],
    ]);
    const { store, recon } = buildMultiVenue(ports, registry);
    const logged: string[] = [];
    const errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((msg: unknown) => void logged.push(String(msg)));

    try {
      const result = await recon.reconcile();

      expect(result).toEqual({ mismatches: 0, actionableMismatches: 0, halted: false }); // the skip is not a mismatch
      expect(store.reconciliations).toHaveLength(1); // only the ported venue wrote a row
      expect(store.reconciliations[0]!.venue).toBe(SPOT);
      expect(logged).toEqual([`no exchange port registered for venue "${PERP}" — skipping`]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// RecoveryCoordinatorService's own universal precondition read (owner-authorized auto-resume,
// 2026-07-22). Direct coverage of cleanWithin/cleanAfter, independent of the coordinator's own tests
// (which fake this port) — both methods read a private field reconcile() alone writes, so they need
// their own real-ReconciliationService exercise to be covered at all.
describe('ReconciliationService — cleanWithin/cleanAfter/cleanIsLatest (RecoveryCoordinatorService precondition)', () => {
  it('both report false before any reconcile() pass has ever run', () => {
    const ctx = build();
    expect(ctx.recon.cleanWithin(1_000_000, epochMs(T))).toBe(false);
    expect(ctx.recon.cleanAfter(epochMs(T - 1))).toBe(false);
  });

  it('cleanWithin: exactly at the freshness boundary is fresh, one ms past is stale', async () => {
    const ctx = build();
    await ctx.recon.reconcile(); // clean pass — stamps lastCleanAt = T
    expect(ctx.recon.cleanWithin(1000, epochMs(T + 1000))).toBe(true); // boundary: <=
    expect(ctx.recon.cleanWithin(1000, epochMs(T + 1001))).toBe(false); // one ms stale
  });

  it('cleanAfter: true only once the clean pass is strictly after the given instant, false at equality', async () => {
    const ctx = build();
    await ctx.recon.reconcile(); // clean pass — stamps lastCleanAt = T
    expect(ctx.recon.cleanAfter(epochMs(T - 1))).toBe(true); // clean pass came after
    expect(ctx.recon.cleanAfter(epochMs(T))).toBe(false); // equal — not STRICTLY after (fail closed)
    expect(ctx.recon.cleanAfter(epochMs(T + 1))).toBe(false); // clean pass predates this instant
  });

  // Task C3 (2026-07-27 incident): the stamp used to demand a literal process-wide zero, so one
  // venue's routine benign noise starved auto-resume forever — 39h halted with lastCleanAt never set
  // once. These pin the exact discount set: benign/transient classes stamp, everything else does not.
  it('C3: a pass whose only mismatch is benign (foreign open order) still stamps lastCleanAt', async () => {
    const ctx = build(
      { openOrders: [venueOrder('someoneElseOrder', 'open')] },
      undefined,
      undefined,
      undefined,
      {
        sweepSymbols: [SYM],
      },
    );
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(false);
    expect(r.mismatches).toBe(1); // raw total still reports the foreign order — unchanged for every consumer
    expect(r.actionableMismatches).toBe(0);
    expect(ctx.recon.cleanWithin(1_000_000, epochMs(T))).toBe(true);
    expect(ctx.recon.cleanIsLatest()).toBe(true);
  });

  it('C3: a pass whose only mismatch is a transient sweep_failure still stamps lastCleanAt', async () => {
    const ctx = build({ openOrdersThrow: true }, undefined, undefined, undefined, {
      sweepSymbols: [SYM],
    });
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(false);
    expect(r.mismatches).toBeGreaterThan(0);
    expect(r.actionableMismatches).toBe(0);
    expect(ctx.recon.cleanWithin(1_000_000, epochMs(T))).toBe(true);
  });

  it('C3: adopt_query_failure is NOT discounted — a local open order the venue does not list, whose fetchOrder throws, still blocks the stamp', async () => {
    const ctx = build({ openOrders: [] }, undefined, undefined, undefined, { sweepSymbols: [SYM] });
    seedOpenOrder(ctx, OTHER_COID); // local-open, venue-absent, default fetchOrder throws
    const r = await ctx.recon.reconcile();
    expect(r.actionableMismatches).toBeGreaterThan(0);
    expect(ctx.recon.cleanWithin(1_000_000, epochMs(T))).toBe(false);
    expect(ctx.recon.cleanIsLatest()).toBe(false);
  });

  it('C3: a halting class still blocks the stamp even when actionableMismatches would otherwise be discounted', async () => {
    const ctx = build(
      { openOrders: [venueOrder(OTHER_COID, 'open'), venueOrder('someoneElseOrder', 'open')] },
      undefined,
      undefined,
      undefined,
      { sweepSymbols: [SYM] },
    );
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(true); // unknown_ours_open — hard rule 6 path, untouched by C3
    expect(ctx.recon.cleanWithin(1_000_000, epochMs(T))).toBe(false);
    expect(ctx.recon.cleanIsLatest()).toBe(false);
  });

  it('a mismatch/halt pass never stamps lastCleanAt — both stay false afterward', async () => {
    const ctx = build(
      { openOrders: [venueOrder(OTHER_COID, 'open')] },
      undefined,
      undefined,
      undefined,
      { sweepSymbols: [SYM] },
    );
    const r = await ctx.recon.reconcile();
    expect(r.halted).toBe(true);
    expect(ctx.recon.cleanWithin(1_000_000, epochMs(T))).toBe(false);
    expect(ctx.recon.cleanAfter(epochMs(T - 1_000_000))).toBe(false);
  });

  it('an errored/outage pass (reconcile() rejects) never stamps lastCleanAt — fail closed', async () => {
    const ctx = build();
    ctx.store.saveReconciliation = () => {
      throw new Error('db down mid-pass');
    };
    await expect(ctx.recon.reconcile()).rejects.toThrow('db down mid-pass');
    expect(ctx.recon.cleanWithin(1_000_000, epochMs(T))).toBe(false);
    expect(ctx.recon.cleanAfter(epochMs(T - 1_000_000))).toBe(false);
  });

  it('a later clean pass after a halt-then-clear correctly reports cleanAfter the halt instant', async () => {
    const ctx = build();
    await ctx.recon.reconcile(); // clean at T
    ctx.setNow(T + 500); // a halt happens here (simulated by the caller, not this service)
    ctx.setNow(T + 1000); // reconcile runs again, still clean, AFTER the simulated halt instant
    await ctx.recon.reconcile();
    expect(ctx.recon.cleanAfter(epochMs(T + 500))).toBe(true); // T+1000 clean pass is after T+500
    expect(ctx.recon.cleanAfter(epochMs(T + 1000))).toBe(false); // not strictly after itself
  });

  // cleanIsLatest — the M1-residual no-re-dirty bound. cleanWithin/cleanAfter check only that SOME
  // clean stamp exists in their window; cleanIsLatest additionally requires no dirty/errored pass to
  // have run since. This is what closes the same-reason-string re-halt hole (a re-drift that
  // re-engages a byte-identical RECONCILE_MISMATCH reason, invisible to the coordinator's
  // reason-change-keyed haltedSinceAt).
  it('cleanIsLatest: false before any pass has ever run', () => {
    const ctx = build();
    expect(ctx.recon.cleanIsLatest()).toBe(false);
  });

  it('cleanIsLatest: tracks the LATEST outcome — clean⇒true, a later dirty pass⇒false, a later clean pass⇒true', async () => {
    const script: ExchangeScript = { openOrders: [] };
    const ctx = build(script, undefined, undefined, undefined, { sweepSymbols: [SYM] });

    await ctx.recon.reconcile(); // clean at T
    expect(ctx.recon.cleanIsLatest()).toBe(true);

    script.openOrders = [venueOrder(OTHER_COID, 'open')]; // an unknown venue order on the swept symbol
    ctx.setNow(T + 30_000);
    const dirty = await ctx.recon.reconcile();
    expect(dirty.halted).toBe(true);
    // The pre-re-dirty clean stamp (T) is still fresh AND still after any earlier halt instant, so
    // cleanWithin/cleanAfter alone would both still read true — cleanIsLatest is the one that closes.
    expect(ctx.recon.cleanWithin(1_000_000, epochMs(T + 30_000))).toBe(true);
    expect(ctx.recon.cleanAfter(epochMs(T - 1))).toBe(true);
    expect(ctx.recon.cleanIsLatest()).toBe(false); // latest pass is dirty

    script.openOrders = []; // drift clears
    ctx.setNow(T + 60_000);
    await ctx.recon.reconcile(); // clean again — now the LATEST pass
    expect(ctx.recon.cleanIsLatest()).toBe(true);
  });

  it('cleanIsLatest: a dirty pass at the SAME instant as the clean stamp is not latest-clean (strict >)', async () => {
    const script: ExchangeScript = { openOrders: [] };
    const ctx = build(script, undefined, undefined, undefined, { sweepSymbols: [SYM] });
    await ctx.recon.reconcile(); // clean, stamps lastCleanAt = T
    script.openOrders = [venueOrder(OTHER_COID, 'open')];
    const dirty = await ctx.recon.reconcile(); // dirty at the SAME now (T) — stamps lastMismatchAt = T
    expect(dirty.halted).toBe(true);
    expect(ctx.recon.cleanIsLatest()).toBe(false); // T > T is false — fail closed at equality
  });

  it('cleanIsLatest: an errored/outage pass counts as non-clean, flipping a prior clean false (fail closed)', async () => {
    const ctx = build();
    await ctx.recon.reconcile(); // clean at T
    expect(ctx.recon.cleanIsLatest()).toBe(true);
    ctx.store.saveReconciliation = () => {
      throw new Error('db down mid-pass');
    };
    ctx.setNow(T + 1000);
    await expect(ctx.recon.reconcile()).rejects.toThrow('db down mid-pass');
    expect(ctx.recon.cleanIsLatest()).toBe(false); // the throw stamped lastMismatchAt > lastCleanAt
  });

  // Security review 2026-07-22: the scheduled driver is an UNGUARDED setInterval(30s) while one pass
  // issues ~80 sequential REST calls over the 40-symbol two-venue basket, so passes routinely overlap.
  it('re-entrancy guard: a second reconcile() while one is in flight coalesces onto it instead of interleaving a second pass', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: Array<Record<string, string>> = [];
    const runsCounter = {
      inc: (labels: Record<string, string>) => void seen.push(labels),
    } as unknown as Counter<string>;
    const script: ExchangeScript = { openOrders: [], openOrdersGate: gate };
    const ctx = build(script, undefined, runsCounter);

    const first = ctx.recon.reconcile();
    const second = ctx.recon.reconcile(); // lands while `first` is still stalled on the gate
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual(b); // the coalesced caller observes the in-flight pass's own result
    expect(seen).toContainEqual({ venue: 'all', result: 'skipped' }); // never a silent skip
  });

  it('a slow CLEAN pass credits lastCleanAt to when it STARTED, not to completion — so a halt raised mid-pass is NOT cleared by it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const script: ExchangeScript = { openOrders: [], openOrdersGate: gate };
    const ctx = build(script);

    const slow = ctx.recon.reconcile(); // starts at T — its observations can only describe T
    ctx.setNow(T + 45_000); // 45s of wall clock elapses while the pass is stalled mid-sweep
    release();
    await slow;

    // A halt raised at T+33s (AFTER this pass began looking) must NOT read as cleared by it: the pass
    // never observed anything later than its own start. Stamping at completion would have said T+45s
    // and wrongly satisfied cleanAfter — the exact stale-clean resume the review found.
    expect(ctx.recon.cleanAfter(epochMs(T + 33_000))).toBe(false);
    expect(ctx.recon.cleanAfter(epochMs(T - 1))).toBe(true); // it does clear a halt that predates it
  });
});

// Money-critical 100% gate close-out: the last two reconciliation.service.ts branches reachable off
// the single-venue `build()` fixture — axis 2's venueOrderId index build (byVenueId) and the
// ingestor's own already-applied report.
describe('ReconciliationService — trailing coverage close-out (§1.5)', () => {
  it('an order not yet ACKed (no venueOrderId) is excluded from the venue-order-id trade index — a fill landing on it while still SUBMITTING (WS beat REST) still resolves via its own clientOrderId, never a phantom venue-id key', async () => {
    const coid = makeIntent().clientOrderId;
    // balanceAxis:false isolates this to the trade axis — the fill below moves local cash/BTC
    // position away from the default venue-balance stub, an unrelated axis this test does not
    // exercise (same isolation the cluster-A venueOrderId-backfill test above uses).
    const ctx = build(
      {
        openOrders: [venueOrder(coid, 'open')],
        trades: [trade(coid, 'ws-beat-rest-1')],
      },
      undefined,
      undefined,
      undefined,
      { balanceAxis: false },
    );
    // Deliberately stop short of seedOpenOrder's ACK step: this.orders.all() (axis 2's byVenueId
    // index build) sees an OrderRecord with venueOrderId === undefined — the guarded arm must skip
    // it, never index it under a bogus key.
    const intent = makeIntent({ clientOrderId: coid });
    ctx.orders.create(initialOrder(coid, intent.qty, '0.001', SYM));
    ctx.orders.apply(coid, { type: 'SUBMIT_SENT' }); // SUBMITTING — no venueOrderId yet
    ctx.portfolio.addInFlight(intent);
    ctx.portfolio.openOrder(intent.strategyId, {
      clientOrderId: coid,
      symbol: SYM,
      side: 'BUY',
      qty: intent.qty,
      limitPrice: price('100'),
    });
    const r = await ctx.recon.reconcile();
    // Resolved via the isOurClientOrderId tier (this.orders.get(coid) is defined even without a
    // venueOrderId) — byVenueId correctly never indexed this order, so there was nothing to match
    // through the wrong tier.
    expect(ctx.orders.get(coid)?.state).toBe('FILLED');
    expect(ctx.store.fills.size).toBe(1);
    expect(r.halted).toBe(false);
  });

  // A pass issues dozens of sequential REST calls over ~60s. An order ACKed inside that window is
  // absent from a pass-start snapshot of the venue-order index, matches neither in-memory tier, and
  // reaches the durable tier as a NON-terminal "lost in memory" order — which halts the whole book
  // as corruption. The index is therefore re-read on a miss before that conclusion is drawn.
  it('an order ACKed mid-pass still resolves its own trade instead of halting as FILL_FOR_UNKNOWN_ORDER', async () => {
    const seeded = makeIntent().clientOrderId;
    const late = OTHER_COID; // ACKs only once the pass is already underway
    const lateVenueId = 'v-late';
    // Declared before build() so the hook can close over the context the fixture returns.
    let acked = false;
    const ctx: Ctx = build(
      {
        openOrders: [venueOrder(seeded, 'open')],
        trades: [{ ...trade(lateVenueId, 'late-ack-1'), qty: '1' }],
        beforeTrades: () => {
          if (acked) return;
          acked = true;
          ctx.orders.apply(late, { type: 'ACK', venueOrderId: lateVenueId });
        },
      },
      undefined,
      undefined,
      undefined,
      { balanceAxis: false },
    );
    seedOpenOrder(ctx, seeded, {}, 'v1');
    // The late order exists but is still SUBMITTING when the pass starts — it has no venueOrderId,
    // so no index built before the hook fires can possibly name it.
    const lateIntent = makeIntent({ clientOrderId: late });
    ctx.orders.create(initialOrder(late, lateIntent.qty, '0.001', SYM));
    ctx.orders.apply(late, { type: 'SUBMIT_SENT' });
    ctx.portfolio.addInFlight(lateIntent);

    const r = await ctx.recon.reconcile();

    expect(ctx.engages.map((e) => e.reason).join('|')).not.toContain('FILL_FOR_UNKNOWN_ORDER');
    expect(r.halted).toBe(false);
    expect(ctx.orders.get(late)?.cumQty.toFixed()).toBe('1'); // resolved and folded
    expect(ctx.store.fills.size).toBe(1);
  });

  it("a fill whose store.saveFill reports not-inserted (a concurrent writer already recorded it between reconcile's own hasFill check and its own saveFill call) is a silent no-op — no backfilled_fill double count", async () => {
    const coid = makeIntent().clientOrderId;
    const ctx = build({
      openOrders: [venueOrder(coid, 'open')],
      trades: [trade(coid, 'race-1')],
    });
    seedOpenOrder(ctx, coid);
    // Simulates the WS ingest path winning the race after reconcile's own hasFill() pre-check
    // (line 536) already returned false — FillIngestorService.ingest's own idempotency guard
    // (`!inserted`), not this axis, is what must win; reconcile must not count it as a fresh backfill.
    ctx.store.saveFill = () => Promise.resolve({ inserted: false, conflict: false });
    const r = await ctx.recon.reconcile();
    expect(r.mismatches).toBe(0); // no backfilled_fill bump — ingest reported already-applied
    expect(r.halted).toBe(false);
    expect(ctx.store.fills.size).toBe(0); // the override intercepted the write; nothing landed here
  });
});

// Money-critical 100% gate close-out, multi-venue axis: the remaining reconciliation.service.ts
// branches are all "this venue's local view must never leak in the OTHER venue's local view" —
// unreachable off the single-venue build() fixture (venuePorts/venueRegistry both undefined there),
// so these mirror the "v3 multi-venue iteration" describe above's construction pattern.
describe('ReconciliationService — venue-axis symbol/position filtering (§1.5 multi-venue close-out)', () => {
  const SPOT = venueId('binance');
  const PERP = venueId('binanceusdm');

  function fakePort(venue: VenueId, over: Partial<ExchangePort> = {}): ExchangePort {
    return {
      venue,
      capabilities: {
        clientOrderId: true,
        fetchOrderByClientId: true,
        wsUserStream: true,
        stp: false,
        sandbox: true,
      },
      placeOrder: () => Promise.reject(new Error('unused')),
      cancelOrder: () => Promise.reject(new Error('unused')),
      fetchOrder: () => Promise.reject(new Error('unused')),
      fetchOpenOrders: () => Promise.resolve([]),
      fetchBalances: () => Promise.resolve(new Map([['USDT', { free: '100000', locked: '0' }]])),
      fetchMyTrades: () => Promise.resolve([]),
      validateCredentials: () => Promise.reject(new Error('unused')),
      ...over,
    };
  }

  function descriptor(venue: VenueId, perpCapable: boolean): VenueRuntimeDescriptor {
    return {
      venue,
      config: { id: venue, environment: 'demo' }, // demo ⇒ balanceAxis off, isolates these cases
      symbols: [], // empty: a symbol can only reach a venue's sweep here via local-state bleed
      capitalShare: '500',
      perpCapable,
    };
  }

  function buildMultiVenue(
    ports: ReadonlyMap<VenueId, ExchangePort>,
    registry: ReadonlyMap<VenueId, VenueRuntimeDescriptor>,
  ) {
    const clock = { now: () => epochMs(T) };
    const store = new InMemoryExecutionStore();
    const orders = new OrderBookService();
    const portfolio = new PortfolioStateService(
      { quoteAsset: 'USDT', startingCash: '100000' },
      new FeeLedgerService(),
    );
    const sampler = new EquitySamplerService(portfolio, fixedFeed('100'), clock, store);
    const { ks } = killSwitchStub();
    const ingestor = new FillIngestorService(store, ks, orders, portfolio, sampler);
    const recon = new ReconciliationService(
      clock,
      ports.values().next().value!,
      store,
      ks,
      { ...CFG },
      orders,
      portfolio,
      ingestor,
      undefined,
      undefined,
      undefined,
      ports,
      registry,
    );
    return { store, orders, portfolio, recon };
  }

  it("sweepSymbols excludes a SPOT-only open order's symbol from the PERP venue's own sweep (venueForSymbol(o.symbol) === exchange.venue, false arm)", async () => {
    const perpFetchOpenOrders = vi.fn().mockResolvedValue([]);
    const ports = new Map([
      [SPOT, fakePort(SPOT)],
      [PERP, fakePort(PERP, { fetchOpenOrders: perpFetchOpenOrders })],
    ]);
    const registry = new Map([
      [SPOT, descriptor(SPOT, false)],
      [PERP, descriptor(PERP, true)],
    ]);
    const { orders, portfolio, recon } = buildMultiVenue(ports, registry);
    // A local open order on SYM (venueForSymbol(SYM) === SPOT) — no PERP-side state at all.
    const coid = makeIntent().clientOrderId;
    orders.create(initialOrder(coid, makeIntent().qty, '0.001', SYM));
    orders.apply(coid, { type: 'SUBMIT_SENT' });
    orders.apply(coid, { type: 'ACK', venueOrderId: 'v1' });
    portfolio.openOrder(makeIntent().strategyId, {
      clientOrderId: coid,
      symbol: SYM,
      side: 'BUY',
      qty: makeIntent().qty,
      limitPrice: price('100'),
    });

    await recon.reconcile();

    // PERP's own sweepSymbols() must stay empty (cfg.sweepSymbols is [] and the SPOT order's
    // symbol must not bleed in) — fetchOpenOrders is never even called for PERP.
    expect(perpFetchOpenOrders).not.toHaveBeenCalled();
  });

  // A venue order id is unique only PER VENUE, but the trade index is built from the book-wide
  // OrderBookService. Before this was venue-qualified, a perp trade carrying id 'v1' matched the
  // SPOT order that happened to hold the same id and folded the fill onto the wrong symbol's
  // position, filed under the wrong intent.
  it('a PERP trade whose venueOrderId collides with a SPOT order does NOT fold onto that spot order', async () => {
    const PERP_SYM = symbolId('BTC/USDT:USDT');
    const collidingId = 'v1'; // held by the spot order below AND named by the perp trade
    const perpTrade: VenueFill = {
      venue: PERP,
      symbol: PERP_SYM,
      venueTradeId: 'perp-collide-1',
      clientOrderId: collidingId as VenueFill['clientOrderId'],
      price: '100',
      qty: '1',
      fee: null,
      liquidity: 'taker',
      venueTimestamp: epochMs(T),
    };
    const ports = new Map([
      [SPOT, fakePort(SPOT)],
      [PERP, fakePort(PERP, { fetchMyTrades: () => Promise.resolve([perpTrade]) })],
    ]);
    const registry = new Map([
      [SPOT, { ...descriptor(SPOT, false), symbols: [SYM] }],
      [PERP, { ...descriptor(PERP, true), symbols: [PERP_SYM] }],
    ]);
    const { store, orders, portfolio, recon } = buildMultiVenue(ports, registry);
    const spotCoid = makeIntent().clientOrderId;
    orders.create(initialOrder(spotCoid, makeIntent().qty, '0.001', SYM));
    orders.apply(spotCoid, { type: 'SUBMIT_SENT' });
    orders.apply(spotCoid, { type: 'ACK', venueOrderId: collidingId });
    portfolio.addInFlight(makeIntent({ clientOrderId: spotCoid }));
    portfolio.openOrder(makeIntent().strategyId, {
      clientOrderId: spotCoid,
      symbol: SYM,
      side: 'BUY',
      qty: makeIntent().qty,
      limitPrice: price('100'),
    });

    await recon.reconcile();

    // The spot order is untouched: no fill folded onto it, no position minted on its symbol.
    expect(orders.get(spotCoid)?.cumQty.toFixed()).toBe('0');
    expect(orders.get(spotCoid)?.state).toBe('ACKED');
    expect(portfolio.snapshot().positions.size).toBe(0);
    // The perp trade resolves to nothing of ours and is ignored as foreign — never mis-attributed.
    expect(store.fills.size).toBe(0);
  });

  it('adopt loop does not fetchOrder a spot coid on the perp venue (cross-venue filter)', async () => {
    const perpFetchOrder = vi.fn().mockRejectedValue(new Error('wrong venue'));
    const ports = new Map([
      [SPOT, fakePort(SPOT, { fetchOpenOrders: vi.fn().mockResolvedValue([]) })],
      [
        PERP,
        fakePort(PERP, {
          fetchOpenOrders: vi.fn().mockResolvedValue([]),
          fetchOrder: perpFetchOrder,
        }),
      ],
    ]);
    const registry = new Map([
      [SPOT, descriptor(SPOT, false)],
      [PERP, descriptor(PERP, true)],
    ]);
    const { orders, portfolio, recon } = buildMultiVenue(ports, registry);
    const coid = makeIntent().clientOrderId;
    orders.create(initialOrder(coid, makeIntent().qty, '0.001', SYM));
    orders.apply(coid, { type: 'SUBMIT_SENT' });
    orders.apply(coid, { type: 'ACK', venueOrderId: 'v1' });
    portfolio.openOrder(makeIntent().strategyId, {
      clientOrderId: coid,
      symbol: SYM,
      side: 'BUY',
      qty: makeIntent().qty,
      limitPrice: price('100'),
    });
    await recon.reconcile();
    expect(perpFetchOrder).not.toHaveBeenCalled();
  });

  it("sweepSymbols excludes a SPOT-only position's symbol from the PERP venue's own sweep (p.venue === exchange.venue, false arm)", async () => {
    const perpFetchOpenOrders = vi.fn().mockResolvedValue([]);
    const ports = new Map([
      [SPOT, fakePort(SPOT)],
      [PERP, fakePort(PERP, { fetchOpenOrders: perpFetchOpenOrders })],
    ]);
    const registry = new Map([
      [SPOT, descriptor(SPOT, false)],
      [PERP, descriptor(PERP, true)],
    ]);
    const { portfolio, recon } = buildMultiVenue(ports, registry);
    // A local SPOT-venue position on SYM — no PERP-side state at all.
    const intent = makeIntent({ venue: SPOT, qty: qty('0.001') });
    portfolio.applyFill(intent, makeFill({ qty: intent.qty, price: intent.refPrice }));

    await recon.reconcile();

    expect(perpFetchOpenOrders).not.toHaveBeenCalled();
  });

  it("position axis: a local position on a DIFFERENT venue never pollutes this venue's own local aggregation (venue filter + the ?? Decimal(0) fallback for a swept symbol with no local position at all)", async () => {
    const perpFetchPositions = vi.fn().mockResolvedValue([]); // the PERP venue itself reports flat
    const ports = new Map([
      [SPOT, fakePort(SPOT)],
      [PERP, fakePort(PERP, { fetchPositions: perpFetchPositions })],
    ]);
    const registry = new Map([
      [SPOT, descriptor(SPOT, false)],
      [PERP, { ...descriptor(PERP, true), symbols: [SYM] }], // PERP explicitly sweeps SYM
    ]);
    const { portfolio, store, recon } = buildMultiVenue(ports, registry);
    // A local SPOT-venue position on SYM. If the venue filter or the local-fallback were wrong,
    // this would wrongly count as the PERP venue's own local qty on SYM and diverge against the
    // PERP venue's own flat (0) reading — position_drift, then a HALT on the second pass. Correctly
    // filtered, PERP's local qty for SYM is 0 == its own venue's 0 ⇒ clean, both passes.
    const intent = makeIntent({ venue: SPOT, qty: qty('0.001') });
    portfolio.applyFill(intent, makeFill({ qty: intent.qty, price: intent.refPrice }));

    const first = await recon.reconcile();
    const second = await recon.reconcile(); // past the debounce too, in case the filter were wrong
    expect(first.halted).toBe(false);
    expect(second.halted).toBe(false);
    const perpRow = store.reconciliations.filter((r) => r.venue === PERP).at(-1)!;
    expect(perpRow.mismatches).toBe(0);
    expect(perpRow.detail).toBe('clean');
  });

  // R2 close-out: reconcileAlgoRailOrphans' own venue filter (venueForSymbol(rec.symbol) !==
  // exchange.venue) is unreachable off the single-venue build() fixture for the same reason every
  // other case in this describe block is — there is only ever one exchange.venue to compare against.
  it("an algo-rail orphan candidate on a DIFFERENT venue's symbol is filtered before ever reaching this venue's own algo sweep (venueForSymbol(rec.symbol) !== exchange.venue)", async () => {
    const PERP_SYM = symbolId('BTC/USDT:USDT');
    const spotAlgoOpen = vi.fn().mockResolvedValue([]);
    const perpAlgoOpen = vi.fn().mockResolvedValue([]);
    const ports = new Map([
      [SPOT, fakePort(SPOT, { fetchOpenAlgoOrders: spotAlgoOpen })],
      [PERP, fakePort(PERP, { fetchOpenAlgoOrders: perpAlgoOpen })],
    ]);
    const registry = new Map([
      [SPOT, descriptor(SPOT, false)],
      [PERP, descriptor(PERP, true)],
    ]);
    const { store, orders, recon } = buildMultiVenue(ports, registry);
    // ACKED, zero cumQty, STOP_MARKET — a candidate by every OTHER criterion — but on a PERP symbol.
    const coid = makeIntent({
      type: 'STOP_MARKET',
      triggerPrice: price('90'),
      venue: PERP,
      symbol: PERP_SYM,
    }).clientOrderId;
    orders.create(initialOrder(coid, qty('1'), '0.001', PERP_SYM));
    orders.apply(coid, { type: 'SUBMIT_SENT' });
    orders.apply(coid, { type: 'ACK', venueOrderId: 'algo-v1' });
    await store.saveIntent(
      makeIntent({
        clientOrderId: coid,
        type: 'STOP_MARKET',
        triggerPrice: price('90'),
        venue: PERP,
        symbol: PERP_SYM,
      }),
      { nonce: 'n', approvedAtMs: T, ttlMs: 60_000 } as never,
    );

    await recon.reconcile();

    // SPOT's own pass never calls fetchOpenAlgoOrders at all — venueForSymbol(PERP_SYM) resolves to
    // PERP, so SPOT's candidatesBySymbol snapshot stays empty for this coid.
    expect(spotAlgoOpen).not.toHaveBeenCalled();
    // PERP's own pass DOES see it as a candidate — proof this is the venue filter, not a missing
    // candidate (a false-negative "not called" would pass just as happily with the filter deleted).
    expect(perpAlgoOpen).toHaveBeenCalledWith(PERP_SYM);
  });

  it("algo-rail orphan streaks are tracked independently per venue — one venue's cleanup pass skips another venue's own streak key (key.startsWith(streakPrefix), false arm)", async () => {
    const PERP_SYM = symbolId('BTC/USDT:USDT');
    const ports = new Map([
      [SPOT, fakePort(SPOT, { fetchOpenAlgoOrders: () => Promise.resolve([]) })],
      [PERP, fakePort(PERP, { fetchOpenAlgoOrders: () => Promise.resolve([]) })],
    ]);
    const registry = new Map([
      [SPOT, descriptor(SPOT, false)],
      [PERP, descriptor(PERP, true)],
    ]);
    const { store, orders, recon } = buildMultiVenue(ports, registry);

    const spotCoid = makeIntent({
      type: 'STOP_MARKET',
      triggerPrice: price('90'),
      venue: SPOT,
      symbol: SYM,
    }).clientOrderId;
    orders.create(initialOrder(spotCoid, qty('1'), '0.001', SYM));
    orders.apply(spotCoid, { type: 'SUBMIT_SENT' });
    orders.apply(spotCoid, { type: 'ACK', venueOrderId: 'spot-algo-v1' });
    await store.saveIntent(
      makeIntent({
        clientOrderId: spotCoid,
        type: 'STOP_MARKET',
        triggerPrice: price('90'),
        venue: SPOT,
        symbol: SYM,
      }),
      { nonce: 'n', approvedAtMs: T, ttlMs: 60_000 } as never,
    );

    const perpIntentId = intentId('0190ffff-3333-7abc-89ab-0123456789ab');
    const perpCoid = makeIntent({
      intentId: perpIntentId,
      type: 'STOP_MARKET',
      triggerPrice: price('90'),
      venue: PERP,
      symbol: PERP_SYM,
    }).clientOrderId;
    orders.create(initialOrder(perpCoid, qty('1'), '0.001', PERP_SYM));
    orders.apply(perpCoid, { type: 'SUBMIT_SENT' });
    orders.apply(perpCoid, { type: 'ACK', venueOrderId: 'perp-algo-v1' });
    await store.saveIntent(
      makeIntent({
        intentId: perpIntentId,
        clientOrderId: perpCoid,
        type: 'STOP_MARKET',
        triggerPrice: price('90'),
        venue: PERP,
        symbol: PERP_SYM,
      }),
      { nonce: 'n', approvedAtMs: T, ttlMs: 60_000 } as never,
    );

    // CFG.driftPasses is 3 (the legacy cfg both venues derive from — venueReconConfig only overrides
    // balanceAxis/positionAxis/sweepSymbols, never driftPasses), so 4 consecutive absent-successful
    // reads are needed before either folds. Both venues' streaks live in the SAME shared
    // this.algoOrphanStreak map every pass — if the cleanup loop's key-prefix filter were missing,
    // one venue's cleanup could delete or corrupt the other's still-live streak count, folding early
    // or never.
    for (let i = 0; i < 3; i++) {
      const r = await recon.reconcile();
      expect(r.halted).toBe(false);
      expect(orders.get(spotCoid)?.state).toBe('ACKED');
      expect(orders.get(perpCoid)?.state).toBe('ACKED');
    }
    await recon.reconcile();
    expect(orders.get(spotCoid)?.state).toBe('EXPIRED'); // both fold on exactly the 4th pass —
    expect(orders.get(perpCoid)?.state).toBe('EXPIRED'); // proof neither venue's count was disturbed
  });
});
