import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import type { Counter } from 'prom-client';
// §S3 end-to-end: a long position, a price dump past the stop threshold, one ProtectiveExitService
// tick — and the resulting EXIT_LONG must travel the FULL chokepoint (SignalSink → gateway → sizer
// → risk engine → execution gate → PaperExchangeAdapter) and FILL to flat as a marketable IOC.
// Mirrors paper-loop.spec.ts's directly-constructed harness (deterministic, no Nest, no DB).
import { PortfolioStateService } from '../../src/features/trading/execution/portfolio-state.service';
import { FeeLedgerService } from '../../src/features/trading/execution/fee-ledger.service';
import { NonceLedgerService } from '../../src/features/trading/execution/nonce-ledger.service';
import { OrderBookService } from '../../src/features/trading/execution/order-book.service';
import { EquitySamplerService } from '../../src/features/trading/execution/equity-sampler.service';
import { FillIngestorService } from '../../src/features/trading/execution/fill-ingestor.service';
import { ExecReportConsumerService } from '../../src/features/trading/execution/exec-report-consumer.service';
import { ExecutionGateService } from '../../src/features/trading/execution/execution-gate.service';
import type { ModeControlPort } from '../../src/ports/trading/mode-control';
import { SignalSinkService } from '../../src/features/trading/execution/signal-sink.service';
import { InMemoryExecOutbox } from '../../src/features/trading/execution/in-memory-outbox';
import { InMemoryExecutionStore } from '../../src/features/trading/execution/in-memory-store';
import {
  PaperExchangeAdapter,
  type PaperConfig,
} from '../../src/features/venue/exchange/paper-exchange.adapter';
import { KillSwitchService } from '../../src/features/trading/risk/kill-switch.service';
import { RateBucketsService } from '../../src/features/trading/risk/rate-buckets.service';
import { CrossingRegistryService } from '../../src/features/trading/risk/crossing-registry.service';
import { PositionSizerService } from '../../src/features/trading/risk/position-sizer.service';
import { RiskEngineService } from '../../src/features/trading/risk/risk-engine.service';
import { SignalGatewayService } from '../../src/features/trading/risk/signal-gateway.service';
import { ProtectiveExitService } from '../../src/features/trading/risk/protective-exit.service';
import type { ProtectiveExitConfig } from '../../src/ports/trading/risk';
import type { ExecRunContext } from '../../src/ports/trading/execution';
import type { SymbolFilters } from '../../src/domain/trading/risk/evaluate';
import type { PartialRiskLimits } from '../../src/domain/trading/risk/limits';
import type { Signal } from '../../src/domain/strategy/types/signal';
import type { FeedHealthPort } from '../../src/ports/venue/market-data';
import type { OrderLevel } from '../../src/domain/venue/types/market-events';
import { price, qty } from '../../src/domain/common/types/money';
import { strategyId, venueId, symbolId, epochMs } from '../../src/domain/common/types/ids';

const T = 1_700_000_000_000;
const SID = strategyId('agentic-1');
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
  const clock = { now: () => epochMs(T) };
  let s = 1 >>> 0;
  const randomBytes = (n: number) => {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      a[i] = s & 0xff;
    }
    return a;
  };
  // ONE mutable ref-price shared by the risk engine and the protective service — dropping it is the
  // "price dump" the backstop must react to.
  const mid = { value: '100' };
  const feed: FeedHealthPort = {
    getRefPrice: () => ({ mid: price(mid.value), at: epochMs(T) }),
    updateRefPrice: () => undefined,
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
  // Journal probe: captures every signal outcome (APPROVED/REJECTED:<reason>/EXPIRED:<reason>…) so
  // a silent front-door rejection is assertable instead of invisible.
  const signalOutcomes: string[] = [];
  const sink = new SignalSinkService(gateway, portfolio, gate, {
    record: (_signal, outcome) => void signalOutcomes.push(outcome),
  });
  const counter = { inc: vi.fn() } as unknown as Counter<string>;
  const protectCfg: ProtectiveExitConfig = {
    stopLossPct: '0.02',
    trailingPct: '0',
    cooldownMs: 30_000,
    filters: FILTERS,
    planStopWatchEnabled: false,
    planStopForceBps: 30,
  };
  const protective = new ProtectiveExitService(
    clock,
    killSwitch,
    feed,
    portfolio,
    sink,
    protectCfg,
    counter,
  );
  return { adapter, sink, orders, portfolio, store, protective, counter, mid, signalOutcomes };
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

describe('protective exit (paper end-to-end)', () => {
  it('a stop-loss breach fires an EXIT_LONG through the full risk path and fills to flat as IOC', async () => {
    const loop = buildLoop();

    // Enter long 10 BTC @ 100 through the normal path.
    loop.adapter.ingestBook(SYM, [lvl('99', '50')], [lvl('100', '50')]);
    await loop.sink.recordSignal(enterLong());
    expect([...loop.portfolio.snapshot().positions.values()][0]!.signedQty.toFixed()).toBe('10');

    // Price dumps 3% below entry (stop is 2%). Book follows so the crossed IOC can fill.
    loop.mid.value = '97';
    loop.adapter.ingestBook(SYM, [lvl('96.99', '50')], [lvl('97.01', '50')]);
    await loop.protective.tick(epochMs(T));

    // Position force-closed to exactly flat via a marketable IOC SELL.
    expect(loop.signalOutcomes.at(-1)).toBe('APPROVED');
    expect(loop.portfolio.snapshot().positions.size).toBe(0);
    const exitIntent = [...loop.store.intents.values()]
      .map((r) => r.intent)
      .find((i) => i.side === 'SELL');
    expect(exitIntent).toBeDefined();
    expect(exitIntent!.timeInForce).toBe('IOC');
    const exitOrder = loop.orders.all().find((o) => o.clientOrderId === exitIntent!.clientOrderId);
    expect(exitOrder!.state).toBe('FILLED');
    // Filled by crossing to the bid — exact string, never a float.
    const exitFill = [...loop.store.fills.values()].find(
      (f) => f.clientOrderId === exitIntent!.clientOrderId,
    );
    expect(exitFill!.price.toFixed()).toBe('96.99');
    expect(new Decimal(exitFill!.qty.toFixed()).toFixed()).toBe('10');
    expect(
      (loop.counter.inc as ReturnType<typeof vi.fn>).mock.calls.some(
        (c) => (c[0] as { reason: string }).reason === 'STOP_LOSS',
      ),
    ).toBe(true);
  });

  it('no trigger, no orders: a tick above both thresholds leaves the position untouched', async () => {
    const loop = buildLoop();
    loop.adapter.ingestBook(SYM, [lvl('99', '50')], [lvl('100', '50')]);
    await loop.sink.recordSignal(enterLong());

    loop.mid.value = '99.5'; // −0.5%, above the 2% stop
    await loop.protective.tick(epochMs(T));

    expect([...loop.portfolio.snapshot().positions.values()][0]!.signedQty.toFixed()).toBe('10');
    expect([...loop.store.intents.values()].some((r) => r.intent.side === 'SELL')).toBe(false);
    expect((loop.counter.inc as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
