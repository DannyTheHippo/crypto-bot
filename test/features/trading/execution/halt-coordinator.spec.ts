import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import type { SymbolFilters } from '../../../../src/domain/trading/risk/evaluate';
import { positionKey } from '../../../../src/domain/trading/risk/evaluate';
import type { SymbolId } from '../../../../src/domain/common/types/ids';
import {
  epochMs,
  intentId,
  strategyId,
  symbolId,
  venueId,
} from '../../../../src/domain/common/types/ids';
import { price, qty } from '../../../../src/domain/common/types/money';
import type { RiskApprovedIntent } from '../../../../src/domain/trading/types/risk-decision';
import type {
  AlgoRecoverOutcome,
  AlgoStopRecoveryService,
} from '../../../../src/features/trading/execution/algo-stop-recovery.service';
import { FeeLedgerService } from '../../../../src/features/trading/execution/fee-ledger.service';
import { HaltCoordinatorService } from '../../../../src/features/trading/execution/halt-coordinator.service';
import { PortfolioStateService } from '../../../../src/features/trading/execution/portfolio-state.service';
import { CrossingRegistryService } from '../../../../src/features/trading/risk/crossing-registry.service';
import { KillSwitchService } from '../../../../src/features/trading/risk/kill-switch.service';
import { PositionSizerService } from '../../../../src/features/trading/risk/position-sizer.service';
import { RateBucketsService } from '../../../../src/features/trading/risk/rate-buckets.service';
import { RiskEngineService } from '../../../../src/features/trading/risk/risk-engine.service';
import type { ExchangePort } from '../../../../src/ports/venue/exchange';
import type {
  ExecFilters,
  ExecutionGatePort,
  SubmitAck,
} from '../../../../src/ports/trading/execution';
import type { FeedHealthPort } from '../../../../src/ports/venue/market-data';
import type { OpsEvent, OpsEventPort } from '../../../../src/ports/common/observability';
import type {
  PlanStop,
  PlanStopRegistryPort,
  RiskEnginePort,
} from '../../../../src/ports/trading/risk';
import { makeFill, makeIntent, SYM, T } from './helpers';

// Minimal in-memory PlanStopRegistryPort fake for the fix-7a algo-cancel tests below.
function fakePlanStops(seed: ReadonlyMap<string, PlanStop> = new Map()): PlanStopRegistryPort {
  const store = new Map(seed);
  return {
    set: (key, stop) => store.set(key, stop),
    clear: (key) => store.delete(key),
    get: (key) => store.get(key),
    entries: () => store,
  };
}

// AlgoStopRecoveryService fake for the journal seam. The coordinator fires it WITHOUT awaiting
// (fail-open: the drain must never sit behind a venue read), so `settled` exposes the in-flight
// promises for a test to await deliberately — the tests never rely on incidental microtask ordering.
// `hooks.onRecover` is mutable so a test can install a behavior that closes over the built ctx.
function fakeAlgoRecovery() {
  const calls: SymbolId[] = [];
  const pending: Promise<unknown>[] = [];
  const hooks: { onRecover: (symbol: SymbolId) => Promise<AlgoRecoverOutcome> } = {
    onRecover: () => Promise.resolve('none'),
  };
  const service: Pick<AlgoStopRecoveryService, 'recoverSymbol'> = {
    recoverSymbol: (symbol) => {
      calls.push(symbol);
      const p = hooks.onRecover(symbol);
      pending.push(p.catch(() => undefined)); // settled() must not itself reject on the fail-open case
      return p;
    },
  };
  return { calls, hooks, service, settled: () => Promise.all(pending) };
}

const FILTERS: ExecFilters = new Map<string, SymbolFilters>([
  [String(SYM), { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '5' }],
]);

function build(
  opts: {
    mark?: string | null;
    engine?: RiskEnginePort;
    planStops?: PlanStopRegistryPort;
    exchange?: Pick<ExchangePort, 'cancelAlgoOrder'>;
    algoRecovery?: Pick<AlgoStopRecoveryService, 'recoverSymbol'>;
  } = {},
) {
  let nowMs = T;
  const clock = { now: () => epochMs(nowMs) };
  const setNow = (t: number) => {
    nowMs = t;
  };
  const killSwitch = new KillSwitchService();
  const portfolio = new PortfolioStateService(
    { quoteAsset: 'USDT', startingCash: '100000' },
    new FeeLedgerService(),
  );

  const feed: FeedHealthPort = {
    getRefPrice: () =>
      opts.mark === null ? undefined : { mid: price(opts.mark ?? '100'), at: epochMs(T) },
    updateRefPrice: () => undefined,
    health: () => 'LIVE',
    fetchCandles: () => Promise.resolve([]),
  };
  const sizer = new PositionSizerService(clock, {
    baseNotional: '1000',
    mode: 'paper',
    filters: FILTERS,
    randomBytes: (n) => new Uint8Array(n).fill(3),
  });
  const engine = new RiskEngineService(
    clock,
    {
      key: Buffer.alloc(32, 1),
      limits: {
        maxBandBps: 100,
        maxPassiveExitBandBps: 1200,
        maxStopTriggerBandBps: 2000,
        stopLimitBufferBps: 50,
        maxOrderNotional: '1000000',
        maxDriftBps: 100,
        maxPositionPerSymbol: '1000',
        maxGrossExposure: '1000000',
        maxNetExposure: '1000000',
        maxDailyLoss: '5000',
        maxDrawdownPct: '0.9',
        staleMaxAgeMs: 5000,
      },
      limitsVersion: 'v1',
      mode: 'paper',
      filters: FILTERS,
      randomBytes: (n) => new Uint8Array(n).fill(3),
    },
    feed,
    killSwitch,
    new RateBucketsService(clock),
    new CrossingRegistryService(),
    { record: () => undefined },
  );

  const submits: RiskApprovedIntent[] = [];
  const flattenAllReasons: string[] = [];
  const gate: ExecutionGatePort = {
    // Mirror the real gate's effect: a submitted order reserves in-flight + opens an order, so the
    // stacking guard sees the symbol as busy on the next tick.
    submit: (a) => {
      submits.push(a);
      portfolio.addInFlight(a.intent);
      portfolio.openOrder(a.intent.strategyId, {
        clientOrderId: a.intent.clientOrderId,
        symbol: a.intent.symbol,
        side: a.intent.side,
        qty: a.intent.qty,
        limitPrice: a.intent.limitPrice,
      });
      return Promise.resolve({
        clientOrderId: a.intent.clientOrderId,
        outcome: 'SUBMITTED',
      } as SubmitAck);
    },
    cancel: () => Promise.resolve(),
    cancelAllFor: () => Promise.resolve(),
    flattenAll: (reason) => {
      flattenAllReasons.push(reason);
      return Promise.resolve();
    },
  };

  const opsEvents: OpsEvent[] = [];
  const opsEventLogger: OpsEventPort = { emit: (e) => opsEvents.push(e) };
  const coord = new HaltCoordinatorService(
    clock,
    killSwitch,
    gate,
    portfolio,
    opts.engine ?? engine,
    sizer,
    feed,
    FILTERS,
    opts.planStops,
    opts.exchange,
    opsEventLogger,
    opts.algoRecovery,
  );
  return { clock, setNow, killSwitch, portfolio, coord, submits, flattenAllReasons, opsEvents };
}

type Ctx = ReturnType<typeof build>;

// Give the portfolio a long position by folding a BUY fill, mimicking a normal entry.
function seedPosition(ctx: Ctx, q: string) {
  const intent = makeIntent({ qty: qty(q), side: 'BUY' });
  ctx.portfolio.applyFill(intent, makeFill({ qty: qty(q), price: price('100') }));
}

// A short position. v1 strategies are long-only, but the sizer + flatten path now orient by position
// sign, so the coordinator covers a short with a reduce-only BUY (it no longer abandons it as residue).
function seedShort(ctx: Ctx, q: string) {
  const intent = makeIntent({ qty: qty(q), side: 'SELL' });
  ctx.portfolio.applyFill(intent, makeFill({ qty: qty(q), price: price('100') }));
}

function toFlattening(ctx: Ctx) {
  ctx.killSwitch.engage('drawdown', true); // RUNNING → HALTING (flatten requested)
  ctx.killSwitch.confirmCancels(); // → FLATTENING
}

describe('HaltCoordinatorService — HALTING', () => {
  it('issues cancel-all once and confirms when no open orders remain → HALTED', async () => {
    const ctx = build();
    ctx.killSwitch.engage('anomaly', false); // HALTING, no flatten
    await ctx.coord.tick(epochMs(T));
    expect(ctx.flattenAllReasons).toEqual(['HALT']);
    expect(ctx.killSwitch.state()).toBe('HALTED'); // no open orders ⇒ cancels confirmed, no flatten
  });

  // Backlog #52: the same tick both engages (cancelAllIssued flips true) and clears (no open orders
  // ⇒ resetEpisode fires within the same tick) — durationMs is 0 since haltingSince == now here.
  it('emits ops-events halt.engage then halt.cancels_drained (to HALTED) across a single-tick HALTING episode', async () => {
    const ctx = build();
    ctx.killSwitch.engage('anomaly', false);
    await ctx.coord.tick(epochMs(T));
    expect(ctx.opsEvents).toEqual([
      { event: 'halt.engage', reason: 'anomaly' },
      { event: 'halt.cancels_drained', durationMs: 0, to: 'HALTED' },
    ]);
  });

  it('a mismatch HALT (flatten:false) reaches HALTED WITHOUT flattening an open position', async () => {
    // Design line 681 / CLAUDE.md hard-rule #6: a reconciliation mismatch HALTs and NEVER auto-flattens.
    // The complement of the drawdown→FLATTENING path: with a live long present, engage(flatten:false)
    // must drive HALTING → HALTED with zero reduce-only slices fired and the position left untouched.
    const ctx = build();
    seedPosition(ctx, '5'); // a real long the HALT must NOT sell
    ctx.killSwitch.engage('RECONCILE_REQUIRED', false); // mismatch-style HALT, no flatten
    await ctx.coord.tick(epochMs(T)); // no open orders ⇒ cancels confirmed ⇒ HALTED (NOT FLATTENING)
    await ctx.coord.tick(epochMs(T + 1000)); // a second tick must still not flatten
    expect(ctx.killSwitch.state()).toBe('HALTED'); // never entered FLATTENING
    expect(ctx.submits).toHaveLength(0); // no reduce-only flatten slice fired
    expect([...ctx.portfolio.snapshot().positions.values()][0]!.signedQty.toFixed()).toBe('5'); // position untouched
  });

  it('confirming cancels with a flatten request transitions to FLATTENING', async () => {
    const ctx = build();
    ctx.killSwitch.engage('drawdown', true);
    await ctx.coord.tick(epochMs(T));
    expect(ctx.killSwitch.state()).toBe('FLATTENING');
  });

  it('does not re-issue cancel-all across ticks while open orders persist', async () => {
    const ctx = build();
    ctx.killSwitch.engage('anomaly', false);
    ctx.portfolio.openOrder(makeIntent().strategyId, {
      clientOrderId: makeIntent().clientOrderId,
      symbol: SYM,
      side: 'BUY',
      qty: qty('1'),
    });
    await ctx.coord.tick(epochMs(T));
    await ctx.coord.tick(epochMs(T + 1000));
    expect(ctx.flattenAllReasons).toHaveLength(1); // issued once
    expect(ctx.killSwitch.state()).toBe('HALTING'); // still waiting on the cancel
  });

  it('escalates to HALTED_DEGRADED when cancels are unconfirmed past 10s', async () => {
    const ctx = build();
    ctx.killSwitch.engage('anomaly', false);
    ctx.portfolio.openOrder(makeIntent().strategyId, {
      clientOrderId: makeIntent().clientOrderId,
      symbol: SYM,
      side: 'BUY',
      qty: qty('1'),
    });
    await ctx.coord.tick(epochMs(T)); // haltingSince = T
    await ctx.coord.tick(epochMs(T + 10_000)); // 10s elapsed, still open
    expect(ctx.killSwitch.state()).toBe('HALTED_DEGRADED');
  });
});

describe('HaltCoordinatorService — FLATTENING', () => {
  it('fires one marketable reduce-only flatten slice for a non-flat, non-busy position', async () => {
    const ctx = build();
    seedPosition(ctx, '2'); // long 2 BTC
    toFlattening(ctx);
    await ctx.coord.tick(epochMs(T));
    expect(ctx.submits).toHaveLength(1);
    expect(ctx.submits[0]!.intent.reduceOnly).toBe(true);
    expect(ctx.submits[0]!.intent.side).toBe('SELL');
    expect(ctx.killSwitch.state()).toBe('FLATTENING'); // position not yet flat
  });

  it('STACKING GUARD: does not fire a second slice while the first is still working', async () => {
    const ctx = build();
    seedPosition(ctx, '2');
    toFlattening(ctx);
    await ctx.coord.tick(epochMs(T)); // fires slice #1 → reserves in-flight on SYM
    await ctx.coord.tick(epochMs(T + 100)); // SYM now busy → must NOT fire again
    expect(ctx.submits).toHaveLength(1);
  });

  it('skips a position whose symbol already has an open order (busy)', async () => {
    const ctx = build();
    seedPosition(ctx, '2');
    ctx.portfolio.openOrder(makeIntent().strategyId, {
      clientOrderId: makeIntent().clientOrderId,
      symbol: SYM,
      side: 'SELL',
      qty: qty('1'),
    });
    toFlattening(ctx);
    await ctx.coord.tick(epochMs(T));
    expect(ctx.submits).toHaveLength(0); // guard: symbol busy
  });

  it('declares ALL_FLAT and halts when every position is dust (< minQty)', async () => {
    const ctx = build();
    seedPosition(ctx, '0.0005'); // below minQty 0.001 ⇒ dust
    toFlattening(ctx);
    await ctx.coord.tick(epochMs(T));
    expect(ctx.submits).toHaveLength(0);
    expect(ctx.killSwitch.state()).toBe('HALTED'); // ALL_FLAT
  });

  it('declares ALL_FLAT immediately when there are no positions', async () => {
    const ctx = build();
    toFlattening(ctx);
    await ctx.coord.tick(epochMs(T));
    expect(ctx.killSwitch.state()).toBe('HALTED');
  });

  it('treats a sub-minNotional position as residual dust (sizer rejects) → ALL_FLAT', async () => {
    const ctx = build();
    seedPosition(ctx, '0.001'); // ≥ minQty (not dust by qty) but slice notional < minNotional ⇒ unflattenable
    toFlattening(ctx);
    await ctx.coord.tick(epochMs(T));
    expect(ctx.submits).toHaveLength(0);
    expect(ctx.killSwitch.state()).toBe('HALTED'); // converges — never loops on the residue
  });

  it('treats a flatten the RISK ENGINE rejects as unflattenable residue → converges to HALTED', async () => {
    // fireFlatten contract (service line 124): a slice the sizer CAN size but the risk engine then
    // REJECTS (e.g. rate-limit, crossing a sibling's resting order, ref-drift) is unflattenable residue
    // — it counts toward ALL_FLAT so FLATTENING converges instead of looping forever. Post-Phase-3 the
    // sizer covers shorts, so the former trigger (an un-coverable short → REDUCE_ONLY_VIOLATION) is gone;
    // the engine's own reject rules live in evaluate.spec.ts, so here we inject a rejecting engine to
    // assert the COORDINATOR's response to any rejection.
    const rejectingEngine: RiskEnginePort = {
      evaluate: (intent) => ({ verdict: 'REJECTED', intent, reasons: ['RATE_LIMIT'] }),
      evaluateFlatten: (intent) => ({ verdict: 'REJECTED', intent, reasons: ['RATE_LIMIT'] }),
    };
    const ctx = build({ engine: rejectingEngine });
    seedPosition(ctx, '2'); // a real long the sizer sizes fine ⇒ we reach the engine, which rejects
    toFlattening(ctx);
    await ctx.coord.tick(epochMs(T));
    expect(ctx.submits).toHaveLength(0); // engine rejected the sized slice ⇒ nothing submitted
    expect(ctx.killSwitch.state()).toBe('HALTED'); // UNFLATTENABLE ⇒ ALL_FLAT ⇒ converges (no loop)
  });

  it('covers a short during FLATTENING: sizer now sizes a reduce-only BUY → FIRED, awaits fill', async () => {
    // Phase 3 short support: FLATTEN is oriented by position sign, so a short sizes a reduce-only BUY
    // (cover), which evaluateFlatten clamps to the marketable band edge. The coordinator now actively
    // covers the short instead of abandoning it as unflattenable residue (the old long-only behavior).
    const ctx = build();
    seedShort(ctx, '2'); // short 2 BTC
    toFlattening(ctx);
    await ctx.coord.tick(epochMs(T));
    expect(ctx.submits).toHaveLength(1);
    expect(ctx.submits[0]!.intent.reduceOnly).toBe(true);
    expect(ctx.submits[0]!.intent.side).toBe('BUY'); // cover
    // The marketable hint must be ABOVE mark for a BUY cover (review finding: a direction-blind
    // 0.98 hint would rest below the market and, under an operator-widened band >= 200bps where
    // the flatten clamp never fires, the IOC cover would never fill — FLATTENING never converges).
    // Mark = last trade 100 (seedShort's fill); band clamp at the default 100bps reprices the 1.02
    // hint to the 1.01 edge — either way strictly above mark.
    expect(new Decimal(ctx.submits[0]!.intent.limitPrice!.toFixed()).gt(100)).toBe(true);
    expect(ctx.killSwitch.state()).toBe('FLATTENING'); // cover in flight, not yet flat
  });

  it('a position on a symbol with no configured filter is residue (no minQty, sizer cannot size it)', async () => {
    const ctx = build();
    const eth = symbolId('ETH/USDT');
    const intent = makeIntent({ symbol: eth, qty: qty('3'), side: 'BUY' });
    ctx.portfolio.applyFill(intent, makeFill({ symbol: eth, qty: qty('3'), price: price('100') }));
    toFlattening(ctx);
    await ctx.coord.tick(epochMs(T)); // isDust uses minQty '0' (not dust); sizer rejects (no filter) ⇒ residue
    expect(ctx.submits).toHaveLength(0);
    expect(ctx.killSwitch.state()).toBe('HALTED');
  });

  it('cannot price the slice with no mark: skips the fire, stays FLATTENING', async () => {
    const ctx = build({ mark: null }); // feed returns no reference price
    seedPosition(ctx, '2');
    toFlattening(ctx);
    await ctx.coord.tick(epochMs(T));
    expect(ctx.submits).toHaveLength(0);
    expect(ctx.killSwitch.state()).toBe('FLATTENING'); // retry next tick
  });

  it('flattens a position that was created by a fill arriving DURING HALTING', async () => {
    const ctx = build();
    ctx.killSwitch.engage('drawdown', true); // HALTING (flatten requested)
    const openCoid = makeIntent().clientOrderId;
    ctx.portfolio.openOrder(makeIntent().strategyId, {
      clientOrderId: openCoid,
      symbol: SYM,
      side: 'BUY',
      qty: qty('2'),
    });
    await ctx.coord.tick(epochMs(T)); // cancel-all issued; still open ⇒ stays HALTING

    // A fill lands during HALTING: position opens, the order closes (cancel race — fills win).
    seedPosition(ctx, '2');
    ctx.portfolio.closeOrder(openCoid);
    await ctx.coord.tick(epochMs(T + 100)); // open orders drained ⇒ confirm cancels ⇒ FLATTENING
    expect(ctx.killSwitch.state()).toBe('FLATTENING');
    await ctx.coord.tick(epochMs(T + 200)); // flattens the position created during HALTING
    expect(ctx.submits).toHaveLength(1);
    expect(ctx.submits[0]!.intent.side).toBe('SELL');
  });
});

// Push 3 P7f fix 7a: a resting perp algo-rail stop is invisible to gate.flattenAll()/openOrders
// (fix 1 keeps it off the regular-rail set), so the HALT drain must separately best-effort cancel
// any registry entry carrying an algoId, WITH the regular-rail flatten, never blocking on failure.
describe('HaltCoordinatorService — HALTING algo-rail stop cancel (fix 7a)', () => {
  const KEY = positionKey(strategyId('s1'), venueId('binance'), SYM);

  it('best-effort cancels a registry-tracked algo stop alongside the regular-rail flatten', async () => {
    const cancelCalls: [string, string][] = [];
    const planStops = fakePlanStops(
      new Map([
        [
          KEY,
          {
            side: 'LONG',
            stopPrice: '95',
            venueStopResting: true,
            algoId: 'algo-1',
          } satisfies PlanStop,
        ],
      ]),
    );
    const exchange: Pick<ExchangePort, 'cancelAlgoOrder'> = {
      cancelAlgoOrder: (algoId, symbol) => {
        cancelCalls.push([algoId, String(symbol)]);
        return Promise.resolve();
      },
    };
    const ctx = build({ planStops, exchange });
    seedPosition(ctx, '2'); // position must exist under KEY for the symbol lookup to resolve
    ctx.killSwitch.engage('anomaly', false); // HALTING
    await ctx.coord.tick(epochMs(T));
    expect(cancelCalls).toEqual([['algo-1', String(SYM)]]);
    expect(ctx.flattenAllReasons).toEqual(['HALT']); // regular-rail flatten still ran
  });

  it('a failed algo cancel never blocks the regular-rail flatten (fail-safe)', async () => {
    const planStops = fakePlanStops(
      new Map([
        [
          KEY,
          {
            side: 'LONG',
            stopPrice: '95',
            venueStopResting: true,
            algoId: 'algo-1',
          } satisfies PlanStop,
        ],
      ]),
    );
    const exchange: Pick<ExchangePort, 'cancelAlgoOrder'> = {
      cancelAlgoOrder: () => Promise.reject(new Error('venue down')),
    };
    const rec = fakeAlgoRecovery();
    const ctx = build({ planStops, exchange, algoRecovery: rec.service });
    seedPosition(ctx, '2');
    ctx.killSwitch.engage('anomaly', false);
    await expect(ctx.coord.tick(epochMs(T))).resolves.toBeUndefined();
    expect(ctx.flattenAllReasons).toEqual(['HALT']);
    // The journal is keyed off cancels that ACTUALLY landed: a throw leaves the stop possibly still
    // resting at the venue, and folding a live stop terminal is the one direction this seam must
    // never take.
    await rec.settled();
    expect(rec.calls).toHaveLength(0);
  });

  it('skips registry entries with no algoId (spot vsl — nothing to cancel here)', async () => {
    const cancelCalls: string[] = [];
    const planStops = fakePlanStops(
      new Map([
        [KEY, { side: 'LONG', stopPrice: '95', venueStopResting: false } satisfies PlanStop],
      ]),
    );
    const exchange: Pick<ExchangePort, 'cancelAlgoOrder'> = {
      cancelAlgoOrder: (algoId) => {
        cancelCalls.push(algoId);
        return Promise.resolve();
      },
    };
    const ctx = build({ planStops, exchange });
    seedPosition(ctx, '2');
    ctx.killSwitch.engage('anomaly', false);
    await ctx.coord.tick(epochMs(T));
    expect(cancelCalls).toHaveLength(0);
  });

  it('skips a registry entry whose position is absent from the snapshot (stale/foreign key)', async () => {
    // The cancel needs a SYMBOL, and the only trustworthy source is the snapshot's own position map
    // (the registry key's symbol segment can itself contain colons, so it is never parsed). An entry
    // whose position already closed — or that belongs to another lane's snapshot — therefore has
    // nothing to cancel against and is skipped, WITHOUT stopping the drain of the live entries after it.
    const cancelCalls: string[] = [];
    const staleKey = positionKey(strategyId('s1'), venueId('binance'), symbolId('ETH/USDT'));
    const planStops = fakePlanStops(
      new Map([
        [
          staleKey,
          {
            side: 'LONG',
            stopPrice: '95',
            venueStopResting: true,
            algoId: 'algo-stale',
          } satisfies PlanStop,
        ],
        [
          KEY,
          {
            side: 'LONG',
            stopPrice: '95',
            venueStopResting: true,
            algoId: 'algo-live',
          } satisfies PlanStop,
        ],
      ]),
    );
    const exchange: Pick<ExchangePort, 'cancelAlgoOrder'> = {
      cancelAlgoOrder: (algoId) => {
        cancelCalls.push(algoId);
        return Promise.resolve();
      },
    };
    const ctx = build({ planStops, exchange });
    seedPosition(ctx, '2'); // only KEY has a live position; staleKey's ETH position is long gone
    ctx.killSwitch.engage('anomaly', false);
    await ctx.coord.tick(epochMs(T));
    expect(cancelCalls).toEqual(['algo-live']);
    expect(ctx.flattenAllReasons).toEqual(['HALT']); // regular-rail flatten still ran
  });

  it('no-ops (byte-identical) when neither planStops nor exchange is wired', async () => {
    const ctx = build(); // no planStops/exchange — pre-fix construction shape
    ctx.killSwitch.engage('anomaly', false);
    await expect(ctx.coord.tick(epochMs(T))).resolves.toBeUndefined();
    expect(ctx.flattenAllReasons).toEqual(['HALT']);
  });
});

// 2026-07-31 stale-non-terminal-algo-stop defect: an algo-rail cancel is invisible to the OMS, so the
// local order row stays non-terminal and its intent stays registered in inFlightIntents — which
// driveFlattening reads as a BUSY symbol, blocking the very HALT that produced the stranding.
// The coordinator therefore journals each cancel that LANDED through AlgoStopRecoveryService
// (append-only CANCELED fold), fire-and-forget so the drain never waits on a venue read.
describe('HaltCoordinatorService — HALTING algo-stop cancel journal', () => {
  const KEY = positionKey(strategyId('s1'), venueId('binance'), SYM);
  const STOP_IID = intentId('0190abcd-1234-7abc-89ab-0123456789cd');
  const STOP_COID = makeIntent({ intentId: STOP_IID }).clientOrderId;

  const restingAlgoStop = (): PlanStopRegistryPort =>
    fakePlanStops(
      new Map([
        [
          KEY,
          {
            side: 'LONG',
            stopPrice: '95',
            venueStopResting: true,
            algoId: 'algo-1',
          } satisfies PlanStop,
        ],
      ]),
    );

  const okCancel: Pick<ExchangePort, 'cancelAlgoOrder'> = {
    cancelAlgoOrder: () => Promise.resolve(),
  };

  // The stranding the fix targets: the cancelled stop's own STOP_MARKET intent, still registered
  // in-flight because no exec report will ever arrive to retire it.
  function seedStrandedStopIntent(ctx: Ctx) {
    ctx.portfolio.addInFlight(
      makeIntent({ intentId: STOP_IID, side: 'SELL', type: 'STOP_MARKET', qty: qty('2') }),
    );
  }

  it('journals a landed algo-stop cancel through recovery for that symbol', async () => {
    const rec = fakeAlgoRecovery();
    const ctx = build({
      planStops: restingAlgoStop(),
      exchange: okCancel,
      algoRecovery: rec.service,
    });
    seedPosition(ctx, '2');
    ctx.killSwitch.engage('anomaly', false);
    await ctx.coord.tick(epochMs(T));
    await rec.settled();
    expect(rec.calls).toEqual([SYM]);
    expect(ctx.flattenAllReasons).toEqual(['HALT']); // regular-rail flatten still ran
  });

  it('REGRESSION: a symbol whose algo stop was cancelled no longer blocks FLATTENING — ALL_FLAT is reached', async () => {
    const rec = fakeAlgoRecovery();
    const ctx = build({
      planStops: restingAlgoStop(),
      exchange: okCancel,
      algoRecovery: rec.service,
    });
    // Sub-minNotional long: NOT dust by qty, so the busy guard genuinely applies to it, but
    // UNFLATTENABLE once it is evaluated — so allFlat is reachable within one FLATTENING tick and
    // this asserts on killSwitch.allFlat()'s own observable (HALTED), not a proxy for it.
    seedPosition(ctx, '0.001');
    seedStrandedStopIntent(ctx);
    // Mirror foldVenueTerminal's effect on a CANCELED fold: the order retires from in-flight.
    rec.hooks.onRecover = async () => {
      await Promise.resolve();
      ctx.portfolio.clearInFlight(STOP_COID);
      return 'canceled';
    };
    ctx.killSwitch.engage('drawdown', true); // HALTING, flatten requested
    await ctx.coord.tick(epochMs(T)); // cancel + journal; no open orders ⇒ cancels confirmed
    expect(ctx.killSwitch.state()).toBe('FLATTENING');
    await rec.settled(); // the journal is fire-and-forget — await it deliberately, never incidentally
    await ctx.coord.tick(epochMs(T + 100));
    expect(ctx.killSwitch.state()).toBe('HALTED'); // ALL_FLAT — the stale registration is gone
  });

  it('control: with no recovery wired the same symbol stalls FLATTENING forever (the defect)', async () => {
    const ctx = build({ planStops: restingAlgoStop(), exchange: okCancel }); // journal seam absent
    seedPosition(ctx, '0.001');
    seedStrandedStopIntent(ctx);
    ctx.killSwitch.engage('drawdown', true);
    await ctx.coord.tick(epochMs(T));
    await ctx.coord.tick(epochMs(T + 100));
    // Busy on a registration nothing will ever clear ⇒ allFlat can never be declared for SYM: the
    // HALT cannot complete until the next boot. Byte-identical to pre-fix behavior when unwired.
    expect(ctx.killSwitch.state()).toBe('FLATTENING');
  });

  it('FAILS OPEN: a rejecting recovery call never propagates and never stops the drain', async () => {
    const rec = fakeAlgoRecovery();
    rec.hooks.onRecover = () => Promise.reject(new Error('venue read timed out'));
    const ctx = build({
      planStops: restingAlgoStop(),
      exchange: okCancel,
      algoRecovery: rec.service,
    });
    seedPosition(ctx, '0.001');
    ctx.killSwitch.engage('drawdown', true);
    await expect(ctx.coord.tick(epochMs(T))).resolves.toBeUndefined();
    await rec.settled();
    expect(rec.calls).toEqual([SYM]); // the rejection is the dep's own, not a stubbed success
    await ctx.coord.tick(epochMs(T + 100));
    expect(ctx.killSwitch.state()).toBe('HALTED'); // drain completed regardless
    expect(ctx.flattenAllReasons).toEqual(['HALT']);
  });
});

describe('HaltCoordinatorService — idle', () => {
  it('does nothing while RUNNING', async () => {
    const ctx = build();
    await ctx.coord.tick(epochMs(T));
    expect(ctx.submits).toHaveLength(0);
    expect(ctx.flattenAllReasons).toHaveLength(0);
  });

  it('does nothing while HALTED', async () => {
    const ctx = build();
    ctx.killSwitch.engage('x', false);
    ctx.killSwitch.confirmCancels(); // → HALTED (no flatten)
    await ctx.coord.tick(epochMs(T));
    expect(ctx.flattenAllReasons).toHaveLength(0);
  });
});
