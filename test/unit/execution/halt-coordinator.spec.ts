import { describe, it, expect } from 'vitest';
import { HaltCoordinatorService } from '../../../src/modules/execution/halt-coordinator.service';
import { PortfolioStateService } from '../../../src/modules/execution/portfolio-state.service';
import { FeeLedgerService } from '../../../src/modules/execution/fee-ledger.service';
import { KillSwitchService } from '../../../src/modules/risk/kill-switch.service';
import { RateBucketsService } from '../../../src/modules/risk/rate-buckets.service';
import { CrossingRegistryService } from '../../../src/modules/risk/crossing-registry.service';
import { PositionSizerService } from '../../../src/modules/risk/position-sizer.service';
import { RiskEngineService } from '../../../src/modules/risk/risk-engine.service';
import type { ExecutionGatePort, ExecFilters, SubmitAck } from '../../../src/ports/execution';
import type { RiskEnginePort } from '../../../src/ports/risk';
import type { RiskApprovedIntent } from '../../../src/domain/types/risk-decision';
import type { SymbolFilters } from '../../../src/domain/risk/evaluate';
import type { FeedHealthPort } from '../../../src/ports/market-data';
import { price, qty } from '../../../src/domain/types/money';
import { epochMs, symbolId } from '../../../src/domain/types/ids';
import { makeIntent, makeFill, SYM, T } from './helpers';

const FILTERS: ExecFilters = new Map<string, SymbolFilters>([
  [String(SYM), { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '5' }],
]);

function build(opts: { mark?: string | null; engine?: RiskEnginePort } = {}) {
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

  const coord = new HaltCoordinatorService(
    clock,
    killSwitch,
    gate,
    portfolio,
    opts.engine ?? engine,
    sizer,
    feed,
    FILTERS,
  );
  return { clock, setNow, killSwitch, portfolio, coord, submits, flattenAllReasons };
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
