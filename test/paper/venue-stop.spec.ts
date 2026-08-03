import { describe, it, expect } from 'vitest';
// AGENTIC_VENUE_STOP paper-lane proof (spot).
//
// DESIGN ADJUSTMENT (forced by existing flow, discovered building this spec): unlike
// AGENTIC_VENUE_TP's plain-LIMIT resting order, PaperExchangeAdapter.placeOrder REJECTS every
// trigger order outright — `if (req.triggerPrice !== undefined) throw new AdapterError
// ('TERMINAL_REJECT', 'UNSUPPORTED_ORDER_TYPE', ...)` (paper-exchange.adapter.ts, Push 3 P7a). That
// method's own comment explains why: the real venue's STOP_LOSS_LIMIT only enters the book once its
// trigger is touched, and this adapter's fill engine has no trigger-watching mechanism — silently
// treating a trigger order as an always-resting plain LIMIT would misrepresent that and corrupt
// paper P&L/behavior tests, so P7a chose to fail closed instead of mis-simulate. That decision
// predates this task and is out of P7d's scope to change (a paper-side trigger-watch engine is a
// separate, sizable build). The practical consequence at the time: a RESTING_STOP signal (spot
// manageVenueStop's own would-be placement, exitStyle 'RESTING_STOP' + triggerPriceHint) could never
// actually rest in THIS harness — it TERMINAL_REJECTed at submission every time, so the
// "entry → stop rests → intra-bar breach fills → FLAT" and "cancel-first clears a resting vsl"
// scenarios this file was drafted to prove end-to-end were not expressible here. 2026-07-31 fix:
// spot no longer places a STOP_LOSS_LIMIT at all (manageVenueStopSpot manages an already-resting one
// only — see its own header comment, agentic.strategy.ts), retiring the placement scenario for a
// second, independent reason. Drift/qty reconciliation of a pre-existing resting 'vsl', its
// position_closed orphan cleanup in both directions (stop-fills-cancels-TP and TP-fills-cancels-
// stop), the bar-close force-band stand-down/force-fire pair, and restart re-arm remain
// unit-covered instead, against a directly-constructed AgenticStrategy (no paper-adapter boundary
// involved) — test/features/strategy/agentic/venue-stop-lifecycle.spec.ts's SPOT describe block.
// The role-scoped CANCEL_OPEN cancelRole mechanism itself (SignalSinkService.cancelOpenForSignal) is
// type-agnostic — it resolves a resting order's role off its OWN persisted intent's dedupeKey,
// never off order type — and is already proven end-to-end for both roles by venue-tp.spec.ts's own
// "CANCEL_OPEN with cancelRole only cancels a role-matching resting order" case; there is no
// additional paper-lane surface specific to 'vsl' to prove beyond what that test already covers
// structurally (a fabricated "as-if-resting" vsl fixture here — since no real one can ever exist in
// this harness — would test a scenario paper can never actually produce, not a real behavior).
//
// What THIS file proves instead: the documented fail-closed boundary itself, as a regression pin —
// if PaperExchangeAdapter ever silently started accepting/mis-simulating trigger orders, this test
// would catch that drift. It also proves the position is left untouched (still LONG, no partial
// state) by the rejected submission — a REJECTED order must never silently mutate the attributed
// position.
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
import { PositionSizerService } from '../../src/features/trading/risk/position-sizer.service';
import { RiskEngineService } from '../../src/features/trading/risk/risk-engine.service';
import { SignalGatewayService } from '../../src/features/trading/risk/signal-gateway.service';
import type { ExecRunContext } from '../../src/ports/trading/execution';
import type { SymbolFilters } from '../../src/domain/trading/risk/evaluate';
import type { PartialRiskLimits } from '../../src/domain/trading/risk/limits';
import type { Signal } from '../../src/domain/strategy/types/signal';
import type { FeedHealthPort } from '../../src/ports/venue/market-data';
import type { OrderLevel } from '../../src/domain/venue/types/market-events';
import { price, qty } from '../../src/domain/common/types/money';
import { strategyId, venueId, symbolId, epochMs } from '../../src/domain/common/types/ids';

const T = 1_700_000_000_000;
const SID = strategyId('agentic-venue-stop');
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
  const feed: FeedHealthPort = {
    getRefPrice: () => ({ mid: price(mid.value), at: epochMs(nowMs) }),
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
  const sink = new SignalSinkService(
    gateway,
    portfolio,
    gate,
    { record: (_signal, outcome) => void signalOutcomes.push(outcome) },
    undefined,
    store,
  );
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

// Mirrors agentic.strategy.ts's manageVenueStop "placed" branch (spot): reduce-only EXIT_LONG,
// exitStyle RESTING_STOP, triggerPriceHint = entry × (1 − stopLossPct) — here hardcoded to '98'
// (entry 100, 2% stop) since this harness never runs the strategy's own venueStopPrice computation.
function restingStop(triggerStr: string, seq: number): Signal {
  return {
    strategyId: SID,
    venue: VEN,
    symbol: SYM,
    kind: 'EXIT_LONG',
    strength: 1,
    exitStyle: 'RESTING_STOP',
    triggerPriceHint: price(triggerStr),
    refPrice: price('100'),
    basedOnSeq: BigInt(seq),
    eventTime: epochMs(T + seq),
    ttlMs: 10_000,
    dedupeKey: `venue_stop_place:${seq}`,
    reason: 'venue stop: resting protective stop placed',
  };
}

describe('AGENTIC_VENUE_STOP: venue-resting protective stop (paper end-to-end, spot)', () => {
  it('PositionSizerService builds a real STOP_LOSS_LIMIT intent (risk-approved) from the RESTING_STOP signal, and PaperExchangeAdapter fails closed on it (documented P7a boundary — trigger orders are unsupported in paper simulation)', async () => {
    const loop = buildLoop();
    loop.adapter.ingestBook(SYM, [lvl('99', '50')], [lvl('100', '50')]);
    await loop.sink.recordSignal(enterLong());
    expect([...loop.portfolio.snapshot().positions.values()][0]!.signedQty.toFixed()).toBe('10');

    loop.advance(2_000);
    await loop.sink.recordSignal(restingStop('98', 2));

    // Risk APPROVED the intent (sized correctly — proves the sizer/risk-band path this signal
    // exercises, position-sizer.service.ts's isRestingStopExit branch and domain/trading/risk/evaluate.ts's
    // T1-T3 trigger-order gates, both Push 3 P7b), but the SUBMIT itself terminal-rejects at the
    // adapter boundary — the outcome recorded by SignalSinkService is still 'APPROVED' (that outcome
    // reflects the RISK verdict, not the eventual venue result; see execution-gate.service.ts's own
    // SUBMITTED/REJECTED/UNKNOWN taxonomy for where the venue result actually lands).
    expect(loop.signalOutcomes).toEqual(['APPROVED', 'APPROVED']);

    const restingIntent = [...loop.store.intents.values()]
      .map((r) => r.intent)
      .find((i) => i.side === 'SELL')!;
    expect(restingIntent.type).toBe('STOP_LOSS_LIMIT');
    expect(restingIntent.triggerPrice!.toFixed()).toBe('98');
    // 98 × (1 − 0.005) = 97.51 exactly (PositionSizerService's own stopLimitBufferBps default 50).
    expect(restingIntent.limitPrice!.toFixed()).toBe('97.51');
    expect(restingIntent.timeInForce).toBe('GTC'); // would rest, never IOC — a real venue's own rail

    const rec = loop.orders.all().find((o) => o.clientOrderId === restingIntent.clientOrderId)!;
    expect(rec.state).toBe('REJECTED'); // TERMINAL_REJECT — never reaches ACKED in this harness
    expect(loop.portfolio.snapshot().openOrders).toHaveLength(0); // nothing rests
    // The REJECT must never mutate the attributed position — still exactly the entry fill's 10 BTC.
    expect([...loop.portfolio.snapshot().positions.values()][0]!.signedQty.toFixed()).toBe('10');
  });
});
