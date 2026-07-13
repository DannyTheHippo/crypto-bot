import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
// AGENTIC_VENUE_TP end-to-end proof (paper lane): plan-mode's venue-resting take-profit, at the
// FULL chokepoint (SignalSink → gateway → sizer → risk engine → execution gate → PaperExchangeAdapter).
// Mirrors protective-exit.spec.ts's directly-constructed harness — no Nest, no strategy instance, no
// config/env wiring (confirmed no paper spec reads AppConfig/env; every paper spec hand-builds the
// Signal objects a strategy would emit and drives them through the real pipeline). The flag's "on"
// path is therefore expressed here by WHICH signals we construct — exitStyle:'RESTING' +
// limitPriceHint present, and CANCEL_OPEN with cancelSide:'SELL' — exactly the shapes
// agentic.strategy.ts's manageVenueTp / plan-exit branch emit when venueTpEnabled is true.
import { PortfolioStateService } from '../../src/features/trading/execution/portfolio-state.service';
import { FeeLedgerService } from '../../src/features/trading/execution/fee-ledger.service';
import { NonceLedgerService } from '../../src/features/trading/execution/nonce-ledger.service';
import { OrderBookService } from '../../src/features/trading/execution/order-book.service';
import { EquitySamplerService } from '../../src/features/trading/execution/equity-sampler.service';
import { FillIngestorService } from '../../src/features/trading/execution/fill-ingestor.service';
import { ExecReportConsumerService } from '../../src/features/trading/execution/exec-report-consumer.service';
import { ExecutionGateService } from '../../src/features/trading/execution/execution-gate.service';
import type { ModeControlPort } from '../../src/ports/mode-control';
import { SignalSinkService } from '../../src/features/trading/execution/signal-sink.service';
import { InMemoryExecOutbox } from '../../src/features/trading/execution/in-memory-outbox';
import { InMemoryExecutionStore } from '../../src/features/trading/execution/in-memory-store';
import {
  PaperExchangeAdapter,
  type PaperConfig,
} from '../../src/features/trading/exchange/paper-exchange.adapter';
import { KillSwitchService } from '../../src/features/trading/risk/kill-switch.service';
import { RateBucketsService } from '../../src/features/trading/risk/rate-buckets.service';
import { CrossingRegistryService } from '../../src/features/trading/risk/crossing-registry.service';
import { PositionSizerService } from '../../src/features/trading/risk/position-sizer.service';
import { RiskEngineService } from '../../src/features/trading/risk/risk-engine.service';
import { SignalGatewayService } from '../../src/features/trading/risk/signal-gateway.service';
import type { ExecRunContext } from '../../src/ports/execution';
import type { SymbolFilters } from '../../src/domain/risk/evaluate';
import type { PartialRiskLimits } from '../../src/domain/risk/limits';
import type { Signal } from '../../src/domain/types/signal';
import type { FeedHealthPort } from '../../src/ports/market-data';
import type { OrderLevel } from '../../src/domain/types/market-events';
import { price, qty } from '../../src/domain/types/money';
import { strategyId, venueId, symbolId, epochMs } from '../../src/domain/types/ids';

const T = 1_700_000_000_000;
const SID = strategyId('agentic-venue-tp');
const VEN = venueId('binance');
const SYM = symbolId('BTC/USDT');
const KEY = Buffer.alloc(32, 7);
const FILTERS = new Map<string, SymbolFilters>([
  [String(SYM), { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '5' }],
]);
const LIMITS: PartialRiskLimits = {
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
  maxDrawdownPct: '0.5',
  staleMaxAgeMs: 5000,
};
const CTX: ExecRunContext = { mode: 'paper', runId: 'run', bootId: 'boot' };
const lvl = (p: string, q: string): OrderLevel => ({ price: price(p), qty: qty(q) });

function buildLoop() {
  // Advanceable (not fixed) clock: RateBucketsService's per-symbol/-strategy token buckets (§5 R1,
  // cap 2/4) only refill by elapsed wall time — a fixed `now()` would exhaust them after 2 same-
  // symbol signals and RATE_LIMIT every signal after, regardless of this feature's own logic. Tests
  // call `advance(ms)` between simulated bars, mirroring real bar cadence.
  let nowMs = T;
  const clock = { now: () => epochMs(nowMs) };
  const advance = (ms: number) => {
    nowMs += ms;
  };
  let s = 1 >>> 0;
  const randomBytes = (n: number) => {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      a[i] = s & 0xff;
    }
    return a;
  };
  const mid = { value: '100' };
  // `at` tracks the same advanceable clock (not a fixed T): a fixed feed timestamp would age past
  // RISK_STALE_MAX_AGE_MS (5000) as soon as `advance` moves the clock forward across bars, and
  // STALE_DATA is not what these scenarios are testing.
  const feed: FeedHealthPort = {
    getRefPrice: () => ({ mid: price(mid.value), at: epochMs(nowMs) }),
    health: () => 'LIVE',
    fetchCandles: () => Promise.resolve([]),
  };
  const fees = new FeeLedgerService();
  const portfolio = new PortfolioStateService({ quoteAsset: 'USDT', startingCash: '100000' }, fees);
  const store = new InMemoryExecutionStore();
  const outbox = new InMemoryExecOutbox();
  const orders = new OrderBookService();
  const nonces = new NonceLedgerService();
  const killSwitch = new KillSwitchService();
  const sampler = new EquitySamplerService(portfolio, feed, clock, store);
  const ingestor = new FillIngestorService(store, killSwitch, orders, portfolio, sampler);
  const consumer = new ExecReportConsumerService(outbox, store, CTX, orders, portfolio, ingestor);
  const notify = () => consumer.pump().then(() => undefined);
  const paperCfg: PaperConfig = {
    seed: 42,
    takerBuffer: '0.05',
    fees: { makerBps: '1', takerBps: '10', feeCurrency: 'quote' },
    latency: { submitMs: [0, 0], eventMs: [0, 0] },
    insufficientDepthPolicy: 'partial_then_reject_rest',
    startingBalances: { USDT: '100000' },
  };
  const adapter = new PaperExchangeAdapter(clock, outbox, notify, paperCfg, VEN);
  const sizer = new PositionSizerService(clock, {
    baseNotional: '1000',
    mode: 'paper',
    filters: FILTERS,
    randomBytes,
  });
  const engine = new RiskEngineService(
    clock,
    { key: KEY, limits: LIMITS, limitsVersion: 'v1', mode: 'paper', filters: FILTERS, randomBytes },
    feed,
    killSwitch,
    new RateBucketsService(clock),
    new CrossingRegistryService(),
    { record: () => undefined },
  );
  const gateway = new SignalGatewayService(clock, killSwitch, sizer, engine);
  const modeControl: ModeControlPort = {
    resolveMode: () => ({ effective: 'paper', requested: 'paper', downgrades: [] }),
    armLive: () => ({ ok: true }),
    disarm: () => undefined,
    assertCanTrade: () => undefined,
  };
  const gate = new ExecutionGateService(
    clock,
    KEY,
    CTX,
    FILTERS,
    store,
    adapter,
    modeControl,
    nonces,
    orders,
    portfolio,
  );
  const signalOutcomes: string[] = [];
  const sink = new SignalSinkService(gateway, portfolio, gate, {
    record: (_signal, outcome) => void signalOutcomes.push(outcome),
  });
  return { adapter, sink, orders, portfolio, store, mid, signalOutcomes, advance };
}

function enterLong(): Signal {
  return {
    strategyId: SID,
    venue: VEN,
    symbol: SYM,
    kind: 'ENTER_LONG',
    strength: 1,
    refPrice: price('100'),
    basedOnSeq: 1n,
    eventTime: epochMs(T),
    ttlMs: 10_000,
    dedupeKey: 'entry-1',
    reason: 'test',
  };
}

// Mirrors agentic.strategy.ts's manageVenueTp "placed" branch: reduce-only EXIT_LONG, exitStyle
// RESTING, limitPriceHint = entry × (1 + takeProfitPct) — here hardcoded to '102' (entry 100, 2% TP)
// since this harness never runs the strategy's own venueTpPrice computation.
function restingTp(tpPrice: string, seq: number): Signal {
  return {
    strategyId: SID,
    venue: VEN,
    symbol: SYM,
    kind: 'EXIT_LONG',
    strength: 1,
    exitStyle: 'RESTING',
    limitPriceHint: price(tpPrice),
    refPrice: price('100'),
    basedOnSeq: BigInt(seq),
    eventTime: epochMs(T + seq),
    ttlMs: 10_000,
    dedupeKey: `venue_tp_place:${seq}`,
    reason: 'venue take-profit: resting exit placed',
  };
}

// Mirrors agentic.strategy.ts's buildCancelOpenSignal('SELL', ...) — the cancel-ahead-of-exit guard
// for the stop/max_hold branch.
function cancelSellSignal(seq: number, mid: string): Signal {
  return {
    strategyId: SID,
    venue: VEN,
    symbol: SYM,
    kind: 'CANCEL_OPEN',
    cancelSide: 'SELL',
    strength: 1,
    refPrice: price(mid),
    basedOnSeq: BigInt(seq),
    eventTime: epochMs(T + seq),
    ttlMs: 60_000,
    dedupeKey: `venue_tp_cancel:${seq}`,
    reason: 'venue take-profit: cancel resting SELL ahead of full-size exit',
  };
}

// Mirrors the plan exit's own EXIT_LONG (no exitStyle/hint ⇒ crossed IOC path — plan-executor's
// stop/max_hold reasons never carry a RESTING hint, only manageVenueTp's own placement signal does).
function stopExit(seq: number, mid: string): Signal {
  return {
    strategyId: SID,
    venue: VEN,
    symbol: SYM,
    kind: 'EXIT_LONG',
    strength: 1,
    refPrice: price(mid),
    basedOnSeq: BigInt(seq),
    eventTime: epochMs(T + seq),
    ttlMs: 10_000,
    dedupeKey: `plan_exit:${seq}`,
    reason: 'plan exit: stop',
  };
}

describe('AGENTIC_VENUE_TP: venue-resting take-profit (paper end-to-end)', () => {
  it('plan entry fills ⇒ ONE resting SELL at the exact TP price; a trade-through fills it and the position goes flat', async () => {
    const loop = buildLoop();
    loop.adapter.ingestBook(SYM, [lvl('99', '50')], [lvl('100', '50')]);
    await loop.sink.recordSignal(enterLong());
    expect([...loop.portfolio.snapshot().positions.values()][0]!.signedQty.toFixed()).toBe('10');

    loop.advance(2_000); // next bar: manageVenueTp observes the fill and rests the TP
    await loop.sink.recordSignal(restingTp('102', 2));

    // Exactly one resting SELL, priced at the exact TP hint — exact string, never a float.
    const sellOpen = loop.portfolio.snapshot().openOrders.filter((o) => o.side === 'SELL');
    expect(sellOpen).toHaveLength(1);
    expect(sellOpen[0]!.limitPrice!.toFixed()).toBe('102');
    const restingIntent = [...loop.store.intents.values()]
      .map((r) => r.intent)
      .find((i) => i.side === 'SELL')!;
    expect(restingIntent.timeInForce).toBe('GTC'); // rests, never IOC
    expect(
      loop.orders.all().find((o) => o.clientOrderId === restingIntent.clientOrderId)!.state,
    ).toBe('ACKED'); // resting, unfilled
    expect(loop.portfolio.snapshot().positions.size).toBe(1); // still long — TP hasn't filled yet

    // A print trades through the resting SELL's limit (102) — fills AT the limit price (maker),
    // per domain/paper/fill.ts's tradeThroughFill (a SELL fills only on a print strictly ABOVE its
    // limit).
    await loop.adapter.ingestTrade(SYM, { price: new Decimal('102.5'), qty: new Decimal('10') });

    expect(
      loop.orders.all().find((o) => o.clientOrderId === restingIntent.clientOrderId)!.state,
    ).toBe('FILLED');
    const fill = [...loop.store.fills.values()].find(
      (f) => f.clientOrderId === restingIntent.clientOrderId,
    );
    expect(fill!.price.toFixed()).toBe('102'); // maker fill AT the resting price, exact string
    expect(new Decimal(fill!.qty.toFixed()).toFixed()).toBe('10');
    expect(loop.portfolio.snapshot().positions.size).toBe(0); // flat
    expect(loop.portfolio.snapshot().openOrders).toHaveLength(0);

    // NOT reachable at this layer: "the next decide cycle clears the plan (position_closed) with no
    // new exit signal" is AgenticStrategy's own in-memory state transition (plan-executor.ts's
    // position_closed verdict, remapped in agentic.strategy.ts). No paper-lane spec instantiates
    // AgenticStrategy (confirmed: grep across test/paper finds no AgenticStrategy import) — this
    // harness proves only the venue-side substrate the position_closed verdict depends on (the TP
    // rests at the exact price and a trade-through takes the position to flat with no orders left).
    // The plan-clearing behavior itself is unit-covered in test/unit/agentic-strategy/plan-executor.spec.ts
    // and plan-lifecycle.spec.ts.
  });

  it('stop path: the resting SELL is cancelled BEFORE the IOC exit submits, and the exit fills clean (no insufficient-balance reject)', async () => {
    const loop = buildLoop();
    loop.adapter.ingestBook(SYM, [lvl('99', '50')], [lvl('100', '50')]);
    await loop.sink.recordSignal(enterLong());
    loop.advance(2_000);
    await loop.sink.recordSignal(restingTp('102', 2));
    const restingSell = loop.portfolio.snapshot().openOrders.find((o) => o.side === 'SELL')!;
    const restingClientOrderId = restingSell.clientOrderId;
    expect(loop.orders.all().find((o) => o.clientOrderId === restingClientOrderId)!.state).toBe(
      'ACKED',
    );

    // Price dumps through the stop, a later bar. Book follows so the crossed IOC exit can fill.
    // Advanced far enough that the per-symbol/-strategy rate buckets (§5 R1) — irrelevant to this
    // feature, but shared plumbing every signal passes through — have refilled.
    loop.advance(2_000);
    loop.mid.value = '90';
    loop.adapter.ingestBook(SYM, [lvl('90', '50')], [lvl('90.5', '50')]);

    // agentic.strategy.ts emits [cancelSignal, exitSignal] from ONE decide cycle and
    // strategy-host.ts's emitSignals dispatches each via `void this.signalSink.recordSignal(sig)` in
    // a loop — NEVER awaiting between them. This fires both the same uncoordinated way (no await
    // between the two calls) so the assertion below proves SignalSinkService's own per-(strategyId,
    // symbol) chain — not caller sequencing — is what holds the order.
    const cancelDone = loop.sink.recordSignal(cancelSellSignal(3, '90'));
    const exitDone = loop.sink.recordSignal(stopExit(4, '90'));
    await Promise.all([cancelDone, exitDone]);

    // entry, TP place: APPROVED. CANCEL_OPEN never reaches the gateway (signal-sink.service.ts
    // handles it directly against the execution layer) so it journals its own
    // `CANCEL_OPEN:<count>` outcome, not APPROVED — 1 order cancelled. The exit itself: APPROVED,
    // no insufficient-balance or rate-limit reject.
    expect(loop.signalOutcomes).toEqual(['APPROVED', 'APPROVED', 'CANCEL_OPEN:1', 'APPROVED']);

    // Observable ordering: the CANCEL_ACK for the resting SELL's own clientOrderId is journaled
    // strictly before any event for the new exit's clientOrderId.
    const cancelAckIdx = loop.store.events.findIndex(
      (e) => e.event.type === 'CANCEL_ACK' && e.clientOrderId === restingClientOrderId,
    );
    expect(cancelAckIdx).toBeGreaterThanOrEqual(0);
    const exitIntent = [...loop.store.intents.values()]
      .map((r) => r.intent)
      .find((i) => i.side === 'SELL' && i.clientOrderId !== restingClientOrderId)!;
    expect(exitIntent).toBeDefined();
    const firstExitEventIdx = loop.store.events.findIndex(
      (e) => e.clientOrderId === exitIntent.clientOrderId,
    );
    expect(firstExitEventIdx).toBeGreaterThan(cancelAckIdx);

    // The IOC exit fills to flat — no insufficient-balance rejection: the resting SELL's base lock
    // was released by the cancel before the exit tried to sell the same base qty.
    expect(loop.orders.all().find((o) => o.clientOrderId === exitIntent.clientOrderId)!.state).toBe(
      'FILLED',
    );
    expect(loop.portfolio.snapshot().positions.size).toBe(0);
    expect(loop.portfolio.snapshot().openOrders).toHaveLength(0);
  });

  it('idempotence: exactly one SELL ever rests — a repeat placement attempt across later bars never creates a second live order', async () => {
    const loop = buildLoop();
    loop.adapter.ingestBook(SYM, [lvl('99', '50')], [lvl('100', '50')]);
    await loop.sink.recordSignal(enterLong());

    // Bar 1: no SELL rests yet ⇒ placed (mirrors manageVenueTp's 'placed' branch).
    loop.advance(2_000);
    await loop.sink.recordSignal(restingTp('102', 2));
    const firstSell = loop.portfolio.snapshot().openOrders.find((o) => o.side === 'SELL')!;
    expect(loop.orders.all().find((o) => o.clientOrderId === firstSell.clientOrderId)!.state).toBe(
      'ACKED',
    );

    // Bars 2 and 3: a correctly-behaving manageVenueTp would see the resting SELL and skip
    // ('skipped_existing') — not exercised here, since that decision lives in AgenticStrategy, which
    // this harness never instantiates (see the scenario-1 note). What IS exercised, at the real
    // execution layer, is the invariant a skip-less caller would still be protected by: a second
    // reduce-only SELL for the same (unfilled, still-attributed) 10-qty position tries to lock
    // another 10 BTC base at the venue, but the first order's lock already holds all 10 free BTC —
    // so PaperExchangeAdapter.computeLock/placeOrder rejects it (INSUFFICIENT_FUNDS), the same
    // terminal-reject path paper-loop.spec.ts's "rejects to terminal when the venue has insufficient
    // funds" case proves for a BUY. Exactly one SELL is ever left resting regardless. Clock advanced
    // between attempts so the §5 R1 rate buckets (irrelevant to this feature) never mask the
    // balance-lock rejection this scenario is actually proving.
    for (let bar = 0; bar < 2; bar++) {
      loop.advance(2_000);
      await loop.sink.recordSignal(restingTp('102', 10 + bar));
    }

    const sellIntents = [...loop.store.intents.values()]
      .map((r) => r.intent)
      .filter((i) => i.side === 'SELL');
    expect(sellIntents).toHaveLength(3); // one placement attempt per bar, all sized and submitted
    const sellStates = sellIntents.map(
      (i) => loop.orders.all().find((o) => o.clientOrderId === i.clientOrderId)!.state,
    );
    expect(sellStates.filter((st) => st === 'ACKED')).toHaveLength(1); // only the first ever rests
    expect(sellStates.filter((st) => st === 'REJECTED')).toHaveLength(2); // the repeats terminal-reject
    expect(loop.portfolio.snapshot().openOrders.filter((o) => o.side === 'SELL')).toHaveLength(1);
    expect([...loop.portfolio.snapshot().positions.values()][0]!.signedQty.toFixed()).toBe('10'); // untouched
  });

  // UNREACHABLE in this harness (see the dispatch brief's scenario 4): every test/paper/*.spec.ts
  // harness (this one included) is directly constructed in-process — PortfolioStateService /
  // InMemoryExecutionStore / OrderBookService are plain `new`, never backed by the DB repositories,
  // and there is no Nest module bootstrap or ModeControl/PromotionReadiness wiring to tear down and
  // rebuild against the SAME persisted rows (grep across test/paper finds no reboot/rehydrate helper
  // anywhere — no second `build()` call reusing a prior one's store, no TestingModule). A
  // "rehydrated LONG+plan re-places the TP once" claim needs an app boot against durable storage
  // (DB-backed ExecutionStorePort + a real strategy-registry rehydration path) that this in-memory,
  // no-Nest harness cannot express. `it.skip` rather than a fabricated assertion — reported as
  // unreachable, not forced.
  it.skip('restart re-arm: unreachable — no paper-lane harness reboots against persisted state (see comment above)', () => {
    return;
  });
});
