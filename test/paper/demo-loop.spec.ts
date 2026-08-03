import { describe, it, expect } from 'vitest';
// Offline proof of the testnet/demo trading path that has never been integration-tested: a Signal
// flows through the REAL SignalSink → SignalGateway → PositionSizer → RiskEngine (mode='testnet') →
// ExecutionGate → CcxtExchangeAdapter (over a FAKE ccxt client, no network) and rests on the venue;
// then the DemoFillPoller sweeps fetchMyTrades, matches the fill to the local order by venue order id,
// and lands it in the portfolio. This guards the two things that silently break the demo run: (1) mode
// threading — a 'paper'-stamped intent under testnet authority is rejected MODE_MISMATCH before it
// ever reaches the venue; here intent.mode='testnet' matches the gate's effective mode, so the order
// is placed; (2) fill matching — ccxt puts the VENUE order id in trade.order, so fills are matched by
// venueOrderId, not the cb-prefixed clientOrderId.
import { PortfolioStateService } from '../../src/features/trading/execution/portfolio-state.service';
import { FeeLedgerService } from '../../src/features/trading/execution/fee-ledger.service';
import { EquitySamplerService } from '../../src/features/trading/execution/equity-sampler.service';
import { EquityMonitorService } from '../../src/features/trading/execution/equity-monitor.service';
import { InMemoryExecutionStore } from '../../src/features/trading/execution/in-memory-store';
import { InMemoryExecOutbox } from '../../src/features/trading/execution/in-memory-outbox';
import { OrderBookService } from '../../src/features/trading/execution/order-book.service';
import { NonceLedgerService } from '../../src/features/trading/execution/nonce-ledger.service';
import { FillIngestorService } from '../../src/features/trading/execution/fill-ingestor.service';
import { ExecutionGateService } from '../../src/features/trading/execution/execution-gate.service';
import { DemoFillPollerService } from '../../src/features/trading/execution/demo-fill-poller.service';
import { AlgoStopRecoveryService } from '../../src/features/trading/execution/algo-stop-recovery.service';
import { SignalSinkService } from '../../src/features/trading/execution/signal-sink.service';
import { CcxtExchangeAdapter } from '../../src/features/venue/exchange/ccxt-exchange.adapter';
import type {
  CcxtOrderClient,
  CcxtOrder,
  CcxtTrade,
  CcxtBalances,
} from '../../src/features/venue/exchange/ccxt-order-client';
import { KillSwitchService } from '../../src/features/trading/risk/kill-switch.service';
import { RateBucketsService } from '../../src/features/trading/risk/rate-buckets.service';
import { PositionSizerService } from '../../src/features/trading/risk/position-sizer.service';
import { RiskEngineService } from '../../src/features/trading/risk/risk-engine.service';
import { SignalGatewayService } from '../../src/features/trading/risk/signal-gateway.service';
import type { ModeControlPort } from '../../src/ports/trading/mode-control';
import type { ExecRunContext } from '../../src/ports/trading/execution';
import type { SymbolFilters } from '../../src/domain/trading/risk/evaluate';
import type { PartialRiskLimits } from '../../src/domain/trading/risk/limits';
import type { FeedHealthPort } from '../../src/ports/venue/market-data';
import type { Signal } from '../../src/domain/strategy/types/signal';
import { price } from '../../src/domain/common/types/money';
import {
  venueId,
  symbolId,
  strategyId,
  epochMs,
  decodeClientOrderId,
} from '../../src/domain/common/types/ids';

const T = 1_700_000_000_000;
const V = venueId('binance');
const SYM = symbolId('BTC/USDT');
const SID = strategyId('ema-1');
const KEY = Buffer.alloc(32, 7);
const VENUE_OID = 'binance-order-9001';
const CTX: ExecRunContext = { mode: 'testnet', runId: 'run', bootId: 'boot' };
const FILTERS = new Map<string, SymbolFilters>([
  [String(SYM), { tickSize: '0.01', stepSize: '0.00001', minQty: '0.00001', minNotional: '5' }],
]);
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
const randomBytes = (n: number): Uint8Array => new Uint8Array(n).fill(3);

// A resting ccxt venue: createOrder accepts and rests (status open); fetchMyTrades returns a full
// fill once an order has been placed, with trade.order = the venue order id (Binance has no
// clientOrderId on myTrades — the very condition the poller's venueOrderId matching handles).
class FakeRestingVenue implements CcxtOrderClient {
  private placed: { amount: string; price?: string }[] = [];
  createOrder(
    _s: string,
    _t: string,
    _side: string,
    amount: string,
    price: string | undefined,
  ): Promise<CcxtOrder> {
    this.placed.push({ amount, price });
    return Promise.resolve({ id: VENUE_OID, status: 'open', amount, filled: '0' });
  }
  fetchMyTrades(): Promise<CcxtTrade[]> {
    return Promise.resolve(
      this.placed.map((o, i) => ({
        id: `trade-${i}`,
        order: VENUE_OID,
        timestamp: T + 1,
        price: o.price ?? '100',
        amount: o.amount,
        side: 'buy',
        takerOrMaker: 'maker',
        fee: { cost: '0.1', currency: 'USDT' },
      })),
    );
  }
  cancelOrder(): Promise<CcxtOrder> {
    return Promise.resolve({ id: VENUE_OID, status: 'canceled' });
  }
  fetchOrder(): Promise<CcxtOrder> {
    return Promise.resolve({ id: VENUE_OID, status: 'open' });
  }
  fetchOpenOrders(): Promise<CcxtOrder[]> {
    return Promise.resolve([]);
  }
  fetchBalance(): Promise<CcxtBalances> {
    return Promise.resolve({});
  }
  sapiGetAccountApiRestrictions(): Promise<Record<string, unknown>> {
    return Promise.resolve({ enableWithdrawals: false, enableSpotAndMarginTrading: true });
  }
}

function build() {
  const clock = { now: () => epochMs(T) };
  const feed: FeedHealthPort = {
    getRefPrice: () => ({ mid: price('100'), at: epochMs(T) }),
    updateRefPrice: () => undefined,
    health: () => 'LIVE',
    fetchCandles: () => Promise.resolve([]),
  };
  const killSwitch = new KillSwitchService();
  const portfolio = new PortfolioStateService(
    { quoteAsset: 'USDT', startingCash: '100000' },
    new FeeLedgerService(),
  );
  const store = new InMemoryExecutionStore();
  const outbox = new InMemoryExecOutbox();
  void outbox;
  const orders = new OrderBookService();
  const nonces = new NonceLedgerService();
  const monitor = new EquityMonitorService(portfolio, killSwitch, {
    maxDailyLoss: '999999',
    maxDrawdownPct: '0.99',
  });
  const sampler = new EquitySamplerService(portfolio, feed, clock, store, (s) => {
    monitor.onSample(s);
  });
  const ingestor = new FillIngestorService(store, killSwitch, orders, portfolio, sampler);
  const venue = new FakeRestingVenue();
  const adapter = new CcxtExchangeAdapter(venue, V, true);
  const modeControl: ModeControlPort = {
    resolveMode: () => ({ effective: 'testnet', requested: 'testnet', downgrades: [] }),
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
  const sizer = new PositionSizerService(clock, {
    baseNotional: '1000',
    mode: 'testnet',
    filters: FILTERS,
    randomBytes,
  });
  const engine = new RiskEngineService(
    clock,
    {
      key: KEY,
      limits: RISK_LIMITS,
      limitsVersion: 'v1',
      mode: 'testnet',
      filters: FILTERS,
      randomBytes,
    },
    feed,
    killSwitch,
    new RateBucketsService(clock),
    { record: () => undefined },
  );
  const gateway = new SignalGatewayService(clock, killSwitch, sizer, engine);
  const sink = new SignalSinkService(gateway, portfolio, gate);
  const recovery = new AlgoStopRecoveryService(clock, adapter, store, orders, portfolio, ingestor);
  const poller = new DemoFillPollerService(clock, adapter, orders, ingestor, recovery);
  return { portfolio, orders, sink, poller, killSwitch };
}

const signal = (): Signal => ({
  strategyId: SID,
  venue: V,
  symbol: SYM,
  kind: 'ENTER_LONG',
  strength: 1,
  refPrice: price('100'),
  basedOnSeq: 1n,
  eventTime: epochMs(T),
  ttlMs: 120_000,
  dedupeKey: 'k1',
  reason: 'golden',
});

describe('demo/testnet loop: Signal → testnet order → fill poll → portfolio (no network)', () => {
  it('places a testnet order (no MODE_MISMATCH) and the polled fill lands in the portfolio', async () => {
    const ctx = build();

    // Drive the REAL Strategy→Risk→Execution path: SignalSink → gateway (TTL/dedupe/kill) → sizer →
    // engine (mode testnet) → gate → CcxtExchangeAdapter → the fake venue (rests the order).
    await ctx.sink.recordSignal(signal());

    // Mode threading proof: a testnet intent under testnet authority reached the venue and ACKED
    // (a MODE_MISMATCH would have returned REJECTED before any order was created).
    const placed = ctx.orders.all()[0];
    expect(placed).toBeDefined();
    expect(placed?.state).toBe('ACKED');
    expect(placed?.venueOrderId).toBe(VENUE_OID);
    expect(decodeClientOrderId(placed!.clientOrderId).mode).toBe('testnet'); // cb t … prefix

    // No position yet — the order only rests on the venue.
    expect(ctx.portfolio.snapshot().positions.size).toBe(0);

    // The venue filled the resting order; the poller discovers it via fetchMyTrades and ingests it.
    ctx.poller.init();
    const result = await ctx.poller.poll(V, [SYM]);
    expect(result.ingested).toBe(1);

    const snap = ctx.portfolio.snapshot();
    const pos = [...snap.positions.values()][0];
    expect(pos).toBeDefined();
    expect(pos!.signedQty.toFixed()).toBe('10'); // baseNotional 1000 / price 100
    expect(pos!.avgEntry.toFixed()).toBe('100');
    expect(snap.openOrders).toHaveLength(0); // order ran to FILLED and retired
    expect(snap.inFlightIntents).toHaveLength(0);
    expect(ctx.killSwitch.state()).toBe('RUNNING'); // no spurious halt
  });
});
