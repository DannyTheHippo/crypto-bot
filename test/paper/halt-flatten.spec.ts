import { describe, it, expect } from 'vitest';
// Integrated §5/§9 scenario with the REAL execution edge (one SHARED kill switch, no fakes): a
// drawdown sample trips the post-trade monitor → the kill switch engages with flatten → the halt
// coordinator drains cancels (HALTING → FLATTENING) → fires a reduce-only flatten through the real
// sizer + evaluateFlatten → the real ExecutionGate → the real PaperExchangeAdapter, whose fill flows
// back through the outbox → consumer → FillIngestor → portfolio. This closes the loop the prior
// fake-gate version stopped short of: the SELL flatten ACTUALLY FILLS, the position reaches flat,
// and the coordinator declares ALL_FLAT → HALTED with a clean book (no positions, no open orders,
// no in-flight). The end state is design §9's "flat", proven with a real fill, not a recorded submit.
import { PortfolioStateService } from '../../src/features/trading/execution/portfolio-state.service';
import { FeeLedgerService } from '../../src/features/trading/execution/fee-ledger.service';
import { EquitySamplerService } from '../../src/features/trading/execution/equity-sampler.service';
import { EquityMonitorService } from '../../src/features/trading/execution/equity-monitor.service';
import { InMemoryExecutionStore } from '../../src/features/trading/execution/in-memory-store';
import { InMemoryExecOutbox } from '../../src/features/trading/execution/in-memory-outbox';
import { OrderBookService } from '../../src/features/trading/execution/order-book.service';
import { NonceLedgerService } from '../../src/features/trading/execution/nonce-ledger.service';
import { FillIngestorService } from '../../src/features/trading/execution/fill-ingestor.service';
import { ExecReportConsumerService } from '../../src/features/trading/execution/exec-report-consumer.service';
import { ExecutionGateService } from '../../src/features/trading/execution/execution-gate.service';
import type { ModeControlPort } from '../../src/ports/trading/mode-control';
import { HaltCoordinatorService } from '../../src/features/trading/execution/halt-coordinator.service';
import {
  PaperExchangeAdapter,
  type PaperConfig,
} from '../../src/features/venue/exchange/paper-exchange.adapter';
import { KillSwitchService } from '../../src/features/trading/risk/kill-switch.service';
import { RateBucketsService } from '../../src/features/trading/risk/rate-buckets.service';
import { CrossingRegistryService } from '../../src/features/trading/risk/crossing-registry.service';
import { PositionSizerService } from '../../src/features/trading/risk/position-sizer.service';
import { RiskEngineService } from '../../src/features/trading/risk/risk-engine.service';
import type { ExecFilters, EquityLimits, ExecRunContext } from '../../src/ports/trading/execution';
import type { SymbolFilters } from '../../src/domain/trading/risk/evaluate';
import type { PartialRiskLimits } from '../../src/domain/trading/risk/limits';
import type { FeedHealthPort } from '../../src/ports/venue/market-data';
import type { OrderLevel } from '../../src/domain/venue/types/market-events';
import { price, qty } from '../../src/domain/common/types/money';
import {
  intentId,
  encodeClientOrderId,
  strategyId,
  venueId,
  symbolId,
  epochMs,
} from '../../src/domain/common/types/ids';
import type { OrderIntent } from '../../src/domain/trading/types/order-intent';

const T = 1_700_000_000_000;
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');
const SID = strategyId('s1');
const KEY = Buffer.alloc(32, 1); // ONE signing key: the engine mints, the gate verifies
const CTX: ExecRunContext = { mode: 'paper', runId: 'run', bootId: 'boot' };
const FILTERS: ExecFilters = new Map<string, SymbolFilters>([
  [String(SYM), { tickSize: '0.01', stepSize: '0.001', minQty: '0.001', minNotional: '5' }],
]);
const EQUITY_LIMITS: EquityLimits = { maxDailyLoss: '999999', maxDrawdownPct: '0.05' }; // only drawdown can trip here
const RISK_LIMITS: PartialRiskLimits = {
  maxBandBps: 100,
  maxPassiveExitBandBps: 1200,
  maxStopTriggerBandBps: 2000,
  stopLimitBufferBps: 50,
  maxOrderNotional: '10000000',
  maxDriftBps: 100,
  maxPositionPerSymbol: '100000',
  maxGrossExposure: '10000000',
  maxNetExposure: '10000000',
  maxDailyLoss: '999999',
  maxDrawdownPct: '0.99',
  staleMaxAgeMs: 5000,
};
const lvl = (p: string, q: string): OrderLevel => ({ price: price(p), qty: qty(q) });

function entryIntent(q: string): OrderIntent {
  const id = intentId('0190abcd-1234-7abc-89ab-0123456789ab');
  return {
    intentId: id,
    clientOrderId: encodeClientOrderId(id, 'paper'),
    strategyId: SID,
    venue: V,
    symbol: SYM,
    side: 'BUY',
    type: 'LIMIT',
    qty: qty(q),
    limitPrice: price('100'),
    timeInForce: 'GTC',
    reduceOnly: false,
    mode: 'paper',
    refPrice: price('100'),
    refSeq: 1n,
    createdAt: epochMs(T),
    expiresAt: epochMs(T + 10_000),
    source: { dedupeKey: 'entry', eventTime: epochMs(T), basedOnSeq: 1n, strength: 1 },
  };
}

function build() {
  const clock = { now: () => epochMs(T) };
  let mark = '100';
  const feed: FeedHealthPort = {
    getRefPrice: () => ({ mid: price(mark), at: epochMs(T) }),
    updateRefPrice: () => undefined,
    health: () => 'LIVE',
    fetchCandles: () => Promise.resolve([]),
  };
  const killSwitch = new KillSwitchService(); // ONE switch shared by monitor + engine + ingestor + coordinator
  const portfolio = new PortfolioStateService(
    { quoteAsset: 'USDT', startingCash: '100000' },
    new FeeLedgerService(),
  );
  const store = new InMemoryExecutionStore();
  const outbox = new InMemoryExecOutbox();
  const orders = new OrderBookService();
  const nonces = new NonceLedgerService();
  const monitor = new EquityMonitorService(portfolio, killSwitch, EQUITY_LIMITS);
  const sampler = new EquitySamplerService(portfolio, feed, clock, store, (s) => {
    monitor.onSample(s);
  });
  const ingestor = new FillIngestorService(store, killSwitch, orders, portfolio, sampler);
  const consumer = new ExecReportConsumerService(outbox, store, CTX, orders, portfolio, ingestor);
  const notify = () => consumer.pump().then(() => undefined);
  const paperCfg: PaperConfig = {
    seed: 1,
    takerBuffer: '0.05',
    fees: { makerBps: '1', takerBps: '10', feeCurrency: 'quote' },
    latency: { submitMs: [0, 0], eventMs: [0, 0] },
    insufficientDepthPolicy: 'partial_then_reject_rest',
    startingBalances: { USDT: '100000', BTC: '100' }, // adapter holds the inventory the bot is long
  };
  const adapter = new PaperExchangeAdapter(clock, outbox, notify, paperCfg, V);
  const sizer = new PositionSizerService(clock, {
    baseNotional: '1000',
    mode: 'paper',
    filters: FILTERS,
    randomBytes: (n) => new Uint8Array(n).fill(3),
  });
  const engine = new RiskEngineService(
    clock,
    {
      key: KEY,
      limits: RISK_LIMITS,
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
  const coord = new HaltCoordinatorService(
    clock,
    killSwitch,
    gate,
    portfolio,
    engine,
    sizer,
    feed,
    FILTERS,
  );
  return {
    clock,
    killSwitch,
    portfolio,
    sampler,
    coord,
    orders,
    adapter,
    setMark: (m: string) => {
      mark = m;
    },
  };
}

describe('integrated drawdown → HALTING → FLATTENING → flat (real adapter, real fill)', () => {
  it('flattens a long to flat through a real fill and reaches HALTED with a clean book', async () => {
    const ctx = build();
    // The book the flatten SELL will cross: a deep bid at the (post-drop) mark.
    ctx.adapter.ingestBook(SYM, [lvl('40', '1000')], [lvl('40.01', '1000')]);

    // Establish the long position and the peak-equity high-water mark at mark 100.
    ctx.portfolio.applyFill(entryIntent('100'), {
      venue: V,
      symbol: SYM,
      venueTradeId: 'entry',
      clientOrderId: entryIntent('100').clientOrderId,
      price: price('100'),
      qty: qty('100'),
      fee: null,
      liquidity: 'taker',
      venueTimestamp: epochMs(T),
      source: 'paper',
    });
    await ctx.sampler.sample(); // equity 100000 ⇒ peak 100000, no trip
    expect(ctx.killSwitch.state()).toBe('RUNNING');

    // Mark drops 60%: equity = 90000 cash + 100×40 = 94000 ⇒ 6% drawdown ≥ 5% cap ⇒ trip + flatten.
    ctx.setMark('40');
    await ctx.sampler.sample();
    expect(ctx.killSwitch.state()).toBe('HALTING'); // monitor engaged with flatten

    await ctx.coord.tick(epochMs(T)); // no open orders ⇒ cancels confirmed ⇒ FLATTENING
    expect(ctx.killSwitch.state()).toBe('FLATTENING');

    await ctx.coord.tick(epochMs(T)); // fires the reduce-only flatten; it crosses the bid and FILLS
    // The flatten order ran to terminal FILLED, and the SELL took the position to flat.
    const afterFill = ctx.portfolio.snapshot();
    expect(afterFill.positions.size).toBe(0); // flat
    expect(ctx.orders.all().every((o) => o.state === 'FILLED')).toBe(true);
    const flatten = ctx.orders.all().find((o) => o.state === 'FILLED');
    expect(flatten).toBeDefined();

    await ctx.coord.tick(epochMs(T)); // observes flat ⇒ ALL_FLAT ⇒ HALTED
    expect(ctx.killSwitch.state()).toBe('HALTED');

    // Clean flat: no residual position, no phantom open order, no reserved exposure.
    const end = ctx.portfolio.snapshot();
    expect(end.positions.size).toBe(0);
    expect(end.openOrders).toHaveLength(0);
    expect(end.inFlightIntents).toHaveLength(0);
  });
});
