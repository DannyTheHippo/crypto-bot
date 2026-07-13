import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
// Full paper loop, directly constructed (deterministic, no Nest, no DB): Signal → SignalGateway
// → Risk → Execution gate → PaperExchangeAdapter → outbox → consumer → portfolio. Exercises
// book-walk fills, partials, insufficient funds, byte-identical determinism, and both delivery
// orderings (implicit-ack vs ACK-then-fill).
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
const SID = strategyId('s1');
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

function feed(mid = '100'): FeedHealthPort {
  return {
    getRefPrice: () => ({ mid: price(mid), at: epochMs(T) }),
    health: () => 'LIVE',
    fetchCandles: () => Promise.resolve([]),
  };
}

function buildLoop(
  opts: { reorder?: boolean; balances?: Record<string, string>; byteSeed?: number } = {},
) {
  const clock = { now: () => epochMs(T) };
  // Deterministic byte source so intent ids / nonces are reproducible across runs.
  let s = (opts.byteSeed ?? 1) >>> 0;
  const randomBytes = (n: number) => {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      a[i] = s & 0xff;
    }
    return a;
  };
  const fees = new FeeLedgerService();
  const portfolio = new PortfolioStateService({ quoteAsset: 'USDT', startingCash: '100000' }, fees);
  const store = new InMemoryExecutionStore();
  const outbox = new InMemoryExecOutbox();
  const orders = new OrderBookService();
  const nonces = new NonceLedgerService();
  const sampler = new EquitySamplerService(portfolio, feed(), clock, store);
  const ingestor = new FillIngestorService(
    store,
    new KillSwitchService(),
    orders,
    portfolio,
    sampler,
  );
  const consumer = new ExecReportConsumerService(outbox, store, CTX, orders, portfolio, ingestor);
  const notify = () => consumer.pump().then(() => undefined);
  const paperCfg: PaperConfig = {
    seed: 42,
    takerBuffer: '0.05',
    fees: { makerBps: '1', takerBps: '10', feeCurrency: 'quote' },
    latency: { submitMs: [0, 0], eventMs: [0, 0] },
    insufficientDepthPolicy: 'partial_then_reject_rest',
    reorderDelivery: opts.reorder,
    startingBalances: opts.balances ?? { USDT: '100000' },
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
    feed(),
    new KillSwitchService(),
    new RateBucketsService(clock),
    new CrossingRegistryService(),
    { record: () => undefined },
  );
  const gateway = new SignalGatewayService(clock, new KillSwitchService(), sizer, engine);
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
  const sink = new SignalSinkService(gateway, portfolio, gate);
  return { adapter, gate, sink, consumer, orders, portfolio, store, outbox };
}

function enterLong(over: Partial<Signal> = {}): Signal {
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
    dedupeKey: 'sig-1',
    reason: 'test',
    ...over,
  };
}

describe('paper loop (end-to-end, deterministic)', () => {
  it('routes a signal to a marketable fill and opens a position (implicit ack)', async () => {
    const loop = buildLoop();
    loop.adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    await loop.sink.recordSignal(enterLong());

    const snap = loop.portfolio.snapshot();
    expect(snap.positions.size).toBe(1);
    expect([...snap.positions.values()][0]!.signedQty.toFixed()).toBe('10');
    expect(loop.orders.all()[0]!.state).toBe('FILLED');
    // The fill was delivered while SUBMITTING (auto-notify) → implicit ack, no ACK event.
    expect(loop.store.events.some((e) => e.event.type === 'ACK')).toBe(false);
    expect(snap.equity.toFixed()).toBe('99999'); // 100000 − 1 (10 bps taker fee on 1000)
  });

  it('fills across multiple book levels (partial then final)', async () => {
    const loop = buildLoop();
    loop.adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '6'), lvl('100', '6')]);
    await loop.sink.recordSignal(enterLong());
    expect(loop.store.fills.size).toBe(2); // 6 + 4
    expect(loop.orders.all()[0]!.state).toBe('FILLED');
    expect([...loop.portfolio.snapshot().positions.values()][0]!.signedQty.toFixed()).toBe('10');
  });

  // Phase 10 — deterministic paper soak (bounded stand-in for the 72h RUN). Drives many enter/exit
  // cycles across varying book prices and asserts the money/OMS invariants hold throughout: every
  // fill is exact decimal strings (no float drift), equity/cash stay finite and non-negative, and
  // no order is left in an illegal state. Seeded ⇒ byte-identical across runs.
  it('soak: sustained enter/exit cycles preserve money exactness, finite non-negative equity, and legal order states', async () => {
    const loop = buildLoop();
    const KNOWN_STATES = new Set([
      'NEW',
      'SUBMITTING',
      'SUBMIT_UNKNOWN',
      'ACKED',
      'PARTIALLY_FILLED',
      'FILLED',
      'CANCEL_PENDING',
      'CANCEL_UNKNOWN',
      'CANCELED',
      'REJECTED',
      'EXPIRED',
      'RECONCILE_REQUIRED',
    ]);
    for (let i = 0; i < 40; i++) {
      const p = 100 + (i % 7); // 100..106
      loop.adapter.ingestBook(SYM, [lvl(String(p - 1), '50')], [lvl(String(p), '50')]);
      const kind = i % 2 === 0 ? 'ENTER_LONG' : 'EXIT_LONG';
      await loop.sink.recordSignal(
        enterLong({
          kind,
          refPrice: price(String(p)),
          basedOnSeq: BigInt(i + 1),
          eventTime: epochMs(T + i),
          dedupeKey: `soak-${i}`,
        }),
      );
    }

    const snap = loop.portfolio.snapshot();
    expect(snap.equity.isFinite()).toBe(true);
    expect(loop.portfolio.cashBalance().isFinite()).toBe(true);
    expect(loop.portfolio.cashBalance().isNegative()).toBe(false); // never spend below zero
    for (const f of loop.store.fills.values()) {
      expect(() => new Decimal(f.price)).not.toThrow(); // exact decimal string, never NaN
      expect(() => new Decimal(f.qty)).not.toThrow();
    }
    for (const o of loop.orders.all()) {
      expect(KNOWN_STATES.has(o.state)).toBe(true); // no illegal/limbo state
    }
  });

  it('rejects to terminal when the venue has insufficient funds', async () => {
    const loop = buildLoop({ balances: { USDT: '500' } }); // lock needs ~1050 quote
    loop.adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    await loop.sink.recordSignal(enterLong());
    expect(loop.portfolio.snapshot().positions.size).toBe(0);
    expect(loop.orders.all().some((o) => o.state === 'REJECTED')).toBe(true);
  });

  it('produces a byte-identical report log for the same seed + inputs', async () => {
    const run = async () => {
      const loop = buildLoop({ byteSeed: 7 });
      loop.adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
      await loop.sink.recordSignal(enterLong());
      return (await loop.outbox.consume('probe', 0)).map((r) => JSON.stringify(r.report));
    };
    expect(await run()).toEqual(await run());
  });

  it('defers delivery in reorderDelivery mode: ACK first, then a manual pump fills', async () => {
    const loop = buildLoop({ reorder: true });
    loop.adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('100', '10')]);
    await loop.sink.recordSignal(enterLong());

    // Fill is queued in the outbox but not delivered → the gate folded a real ACK.
    expect(loop.orders.all()[0]!.state).toBe('ACKED');
    expect(loop.portfolio.snapshot().positions.size).toBe(0);
    expect(loop.store.events.some((e) => e.event.type === 'ACK')).toBe(true);

    await loop.consumer.pump(); // deliver the queued fill (ACKED → FILLED)
    expect(loop.orders.all()[0]!.state).toBe('FILLED');
    expect([...loop.portfolio.snapshot().positions.values()][0]!.signedQty.toFixed()).toBe('10');
  });

  it('fills a resting limit on trade-through (passive maker path)', async () => {
    const loop = buildLoop();
    loop.adapter.ingestBook(SYM, [lvl('99', '10')], [lvl('101', '10')]); // bestAsk 101 > limit 100 → rests
    await loop.sink.recordSignal(enterLong());
    expect(loop.orders.all()[0]!.state).toBe('ACKED'); // resting, acked, unfilled
    expect(loop.portfolio.snapshot().positions.size).toBe(0);

    await loop.adapter.ingestTrade(SYM, { price: new Decimal('99.5'), qty: new Decimal('10') }); // < 100 → trades through
    expect(loop.orders.all()[0]!.state).toBe('FILLED');
    expect([...loop.portfolio.snapshot().positions.values()][0]!.signedQty.toFixed()).toBe('10');
  });
});
