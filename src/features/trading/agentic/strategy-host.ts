import { Injectable, Inject, Logger } from '@nestjs/common';
import type { StrategyId, SymbolId, EpochMs } from '../../../domain/types/ids';
import { epochMs } from '../../../domain/types/ids';
import type {
  CandleEvent,
  TickerEvent,
  OrderBookSnapshotEvent,
} from '../../../domain/types/market-events';
import type { MarketEvent } from '../../../domain/types/market-events';
import type { ExecReport } from '../../../domain/types/exec-report';
import type { Signal } from '../../../domain/types/signal';
import type { StrategyPortfolioView } from '../../../domain/types/portfolio';
import type { MarketStreamPort, FeedHealthPort } from '../../../ports/market-data';
import { MARKET_STREAM, FEED_HEALTH } from '../../../ports/market-data';
import type { StrategyHostPort, SignalSinkPort } from '../../../ports/strategy';
import { SIGNAL_SINK } from '../../../ports/strategy';
import type { StrategyState } from '../../../ports/strategy';
import type {
  AgentDecisionInput,
  AgentMarketSnapshot,
  AsyncStrategy,
  SymbolConstraints,
} from '../../../ports/agentic-strategy';
import { StrategyRegistry } from './strategy-registry';

// Consecutive decide() timeouts/rejections before auto-DRAINING the agentic strategy.
const MAX_CONSECUTIVE_TIMEOUTS = 3;
// Bound on the exec/fill reports folded forward for the next idle decide (oldest dropped past this).
const MAX_PENDING_EXEC = 100;
// Default B5 entry cap (see AgenticHostOptions.maxEntriesPerDay) — matches AGENTIC_MAX_ENTRIES_PER_DAY's
// config-schema default.
const DEFAULT_MAX_ENTRIES_PER_DAY = 12;

// Risk-reducing signal kinds: allowed while DRAINING. EXIT_SHORT (covering a short) reduces risk like
// EXIT_LONG; ENTER_SHORT (opening a short) ADDS risk and is intentionally excluded.
const RISK_REDUCING = new Set<Signal['kind']>([
  'EXIT_LONG',
  'EXIT_SHORT',
  'FLATTEN',
  'CANCEL_OPEN',
]);

// UTC calendar day derived from a wall-clock ms timestamp — the B5 entry cap's rollover key.
function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// A mailbox item with a priority weight.
// Priority order (high→low): execReports(3) > closedCandles(2) > trades(1) > book/ticker(0)
interface MailboxItem {
  kind: 'candle' | 'ticker' | 'book' | 'exec';
  priority: number;
  event: CandleEvent | TickerEvent | OrderBookSnapshotEvent | ExecReport;
}

// Per-strategy runtime state kept by the host.
interface StrategyRuntime {
  mailbox: MailboxItem[];
  // Per-symbol candle history (bounded at warmup.bars + 1).
  candleHistory: Map<string, CandleEvent[]>;
  // Per-symbol last ticker.
  tickers: Map<string, TickerEvent>;
  // Per-symbol last book snapshot.
  books: Map<string, OrderBookSnapshotEvent>;
  // eventTime of the last candle-triggered decide actually kicked off (cadence gate).
  lastDecideEventTime: EpochMs;
  // True while a decide() call is in flight: new triggers conflate (fold state, skip the call).
  busy: boolean;
  // Consecutive decide() timeouts/rejections; ≥ MAX_CONSECUTIVE_TIMEOUTS auto-DRAINs.
  consecutiveTimeouts: number;
  // Exec/fill reports seen while busy (or between decides), delivered to the next idle decide.
  pendingExecReports: ExecReport[];
  // Consecutive failed AUTO-drain recovery probes; drives the doubling cooldown backoff.
  drainFailures: number;
  // While AUTO-DRAINING: no probe decide fires before this wall-clock timestamp.
  cooldownUntilMs: number;
  // B5 entry cap: UTC day key the counter below is scoped to (nowFn()-derived, not eventTime).
  entryDayKey: string;
  // Count of entry-kind signals (ENTER_LONG/ENTER_SHORT) emitted so far this UTC day.
  entryCount: number;
  // Dedupes the cap-reached warn to once per day-key rather than once per dropped entry.
  entryCapWarned: boolean;
}

// Constructor options for the agentic-only host. All optional — defaults preserve prior behavior.
export interface AgenticHostOptions {
  readonly agentTimeoutMs?: number; // wall-clock backstop per decide; default 30_000
  readonly minDecisionIntervalMs?: number; // min eventTime gap between candle-triggered decides; default 0
  readonly portfolioFor?: (id: StrategyId) => StrategyPortfolioView; // live per-strategy book
  readonly nowFn?: () => number; // wall-clock seam for cooldown math; default Date.now
  readonly drainCooldownBaseMs?: number; // first AUTO-drain recovery cooldown; default 30_000
  readonly drainCooldownMaxMs?: number; // cap on the doubling recovery cooldown; default 900_000
  readonly tradingHalted?: () => boolean; // kill-switch: true suppresses ALL decides; default () => false
  readonly constraintsFor?: (symbol: SymbolId) => SymbolConstraints | undefined; // per-symbol exchange limits for onInit
  readonly maxEntriesPerDay?: number; // B5: entry-kind signals allowed per strategy per UTC day; default 12
}

@Injectable()
export class StrategyHost implements StrategyHostPort {
  private readonly runtimes = new Map<StrategyId, StrategyRuntime>();
  // Signal channel: signals produced during ACTIVE/DRAINING are pushed here.
  private readonly signalQueue: Signal[] = [];
  private signalDone = false;
  private signalResolvers: Array<(value: IteratorResult<Signal>) => void> = [];

  // Agentic lane: wall-clock budget for a single decide() call. The shared consume/drain loop NEVER
  // awaits the agent — this timer is the only thing bounding a slow LLM call, and a late result is
  // dropped (and would be rejected EXPIRED downstream anyway: latency is a fail-safe, not a hazard).
  private readonly agentTimeoutMs: number;
  // Min eventTime gap between candle-triggered decides (cadence gate); exec triggers bypass it.
  private readonly minDecisionIntervalMs: number;
  // Live per-strategy portfolio lookup; falls back to an empty view when not wired.
  private readonly portfolioFor?: (id: StrategyId) => StrategyPortfolioView;
  // Wall-clock seam for cooldown math; overridden in tests to avoid real timers.
  private readonly nowFn: () => number;
  private readonly drainCooldownBaseMs: number;
  private readonly drainCooldownMaxMs: number;
  // Kill-switch: while true, no strategy decides (state still folds) regardless of lifecycle.
  private readonly tradingHalted: () => boolean;
  // Per-symbol exchange constraints handed to onInit; undefined when not wired (composition seam).
  private readonly constraintsFor?: (symbol: SymbolId) => SymbolConstraints | undefined;
  // B5: entry-kind signals (ENTER_LONG/ENTER_SHORT) allowed per strategy per UTC day.
  private readonly maxEntriesPerDay: number;
  private readonly log = new Logger(StrategyHost.name);

  constructor(
    @Inject(MARKET_STREAM) private readonly marketStream: MarketStreamPort,
    @Inject(FEED_HEALTH) private readonly feedHealth: FeedHealthPort,
    @Inject(SIGNAL_SINK) private readonly signalSink: SignalSinkPort,
    private readonly registry: StrategyRegistry,
    opts?: AgenticHostOptions,
  ) {
    this.agentTimeoutMs = opts?.agentTimeoutMs ?? 30_000;
    this.minDecisionIntervalMs = opts?.minDecisionIntervalMs ?? 0;
    this.portfolioFor = opts?.portfolioFor;
    this.nowFn = opts?.nowFn ?? Date.now;
    this.drainCooldownBaseMs = opts?.drainCooldownBaseMs ?? 30_000;
    this.drainCooldownMaxMs = opts?.drainCooldownMaxMs ?? 900_000;
    this.tradingHalted = opts?.tradingHalted ?? ((): boolean => false);
    this.constraintsFor = opts?.constraintsFor;
    this.maxEntriesPerDay = opts?.maxEntriesPerDay ?? DEFAULT_MAX_ENTRIES_PER_DAY;
  }

  async start(): Promise<void> {
    // Walk all strategies in LOADING; run warmup then transition to ACTIVE.
    for (const { id, lifecycle } of this.registry.states()) {
      if (lifecycle !== 'LOADING') continue;
      await this.initStrategy(id);
    }

    // Consume market events in the background.
    void this.consumeEvents();
  }

  stop(): Promise<void> {
    // Drain all ACTIVE strategies.
    for (const { id, lifecycle } of this.registry.states()) {
      if (lifecycle === 'ACTIVE') {
        const strategy = this.registry.getStrategy(id);
        if (strategy) strategy.onStop();
        this.registry.setLifecycle(id, 'HALTED');
      }
    }
    this.signalDone = true;
    // Wake any waiting consumer.
    for (const resolve of this.signalResolvers) {
      resolve({ value: undefined, done: true });
    }
    this.signalResolvers = [];
    return Promise.resolve();
  }

  signals(): AsyncIterable<Signal> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<Signal> => ({
        next: (): Promise<IteratorResult<Signal>> => {
          if (this.signalQueue.length > 0) {
            return Promise.resolve({ value: this.signalQueue.shift()!, done: false });
          }
          if (this.signalDone) {
            return Promise.resolve({ value: undefined as unknown as Signal, done: true });
          }
          return new Promise<IteratorResult<Signal>>((resolve) => {
            this.signalResolvers.push(resolve);
          });
        },
      }),
    };
  }

  private async initStrategy(id: StrategyId): Promise<void> {
    const strategy = this.registry.getStrategy(id);
    if (!strategy) return;

    const runtime: StrategyRuntime = {
      mailbox: [],
      candleHistory: new Map(),
      tickers: new Map(),
      books: new Map(),
      lastDecideEventTime: epochMs(0),
      busy: false,
      consecutiveTimeouts: 0,
      pendingExecReports: [],
      drainFailures: 0,
      cooldownUntilMs: 0,
      entryDayKey: utcDayKey(this.nowFn()),
      entryCount: 0,
      entryCapWarned: false,
    };
    this.runtimes.set(id, runtime);

    // Transition to WARMUP.
    this.registry.setLifecycle(id, 'WARMUP');

    const spec = strategy.subscriptions;
    const symbolConstraints = new Map<SymbolId, SymbolConstraints>();
    for (const symbol of spec.symbols) {
      const constraints = this.constraintsFor?.(symbol);
      if (constraints) symbolConstraints.set(symbol, constraints);
    }

    // Call onInit with empty warmup map (history populated via candles during warmup).
    strategy.onInit({
      params: {},
      warmupCandles: new Map(),
      symbolConstraints,
    });

    // Replay historical candles for warmup (signals discarded). The agentic lane warms HISTORY
    // only — it has no sync handler and makes no network calls during warmup.
    const { interval, bars } = strategy.warmup;
    for (const symbol of spec.symbols) {
      let candles: CandleEvent[] = [];
      try {
        candles = [...(await this.feedHealth.fetchCandles(spec.venue, symbol, interval, bars))];
      } catch {
        // Warmup backfill failure is non-fatal: strategy proceeds with empty history.
      }
      const hist = runtime.candleHistory.get(symbol) ?? [];
      for (const c of candles) {
        hist.push(c);
        if (hist.length > bars + 1) hist.shift();
      }
      runtime.candleHistory.set(symbol, hist);
    }

    this.registry.setLifecycle(id, 'ACTIVE');
  }

  private async consumeEvents(): Promise<void> {
    const sub = this.registry.states()[0];
    if (!sub) return;
    const strategy = this.registry.getStrategy(sub.id);
    if (!strategy) return;

    const stream = this.marketStream.subscribe(strategy.subscriptions);
    for await (const event of stream) {
      this.routeEvent(event);
      this.drainMailboxes();
    }

    this.signalDone = true;
    for (const resolve of this.signalResolvers) {
      resolve({ value: undefined, done: true });
    }
    this.signalResolvers = [];
  }

  private routeEvent(event: MarketEvent): void {
    for (const [id, runtime] of this.runtimes) {
      const lifecycle = this.registry.getLifecycle(id);
      if (!lifecycle || lifecycle === 'HALTED' || lifecycle === 'UNLOADED') continue;

      switch (event.kind) {
        case 'CANDLE':
          runtime.mailbox.push({ kind: 'candle', priority: 2, event });
          break;
        case 'TICKER':
          // Conflate: replace any existing ticker for this symbol.
          const tickIdx = runtime.mailbox.findLastIndex(
            (m) => m.kind === 'ticker' && (m.event as TickerEvent).symbol === event.symbol,
          );
          if (tickIdx >= 0) {
            runtime.mailbox.splice(tickIdx, 1);
          }
          runtime.mailbox.push({ kind: 'ticker', priority: 0, event });
          break;
        case 'ORDER_BOOK_SNAPSHOT':
          const bookIdx = runtime.mailbox.findLastIndex(
            (m) => m.kind === 'book' && (m.event as OrderBookSnapshotEvent).symbol === event.symbol,
          );
          if (bookIdx >= 0) {
            runtime.mailbox.splice(bookIdx, 1);
          }
          runtime.mailbox.push({ kind: 'book', priority: 0, event });
          break;
        case 'TRADE':
          // Trades not individually dispatched to strategies in this implementation.
          break;
      }
    }
  }

  enqueueExecReport(stratId: StrategyId, report: ExecReport): void {
    const runtime = this.runtimes.get(stratId);
    if (!runtime) return;
    runtime.mailbox.push({ kind: 'exec', priority: 3, event: report });
  }

  private drainMailboxes(): void {
    for (const [id, runtime] of this.runtimes) {
      const lifecycle = this.registry.getLifecycle(id);
      if (!lifecycle || lifecycle === 'HALTED' || lifecycle === 'UNLOADED') continue;

      // Sort by descending priority before processing.
      runtime.mailbox.sort((a, b) => b.priority - a.priority);

      const items = runtime.mailbox.splice(0);
      for (const item of items) {
        this.processItem(id, runtime, item, lifecycle);
        if (this.registry.getLifecycle(id) === 'HALTED') break;
      }
    }
  }

  // Folds the event into host state, then — if ACTIVE/DRAINING and not already busy — snapshots
  // state and kicks off a non-blocking decide(). While busy, the trigger is conflated: state is kept,
  // the call is skipped. NEVER awaits — head-of-line blocking of market data is forbidden here.
  private processItem(
    id: StrategyId,
    runtime: StrategyRuntime,
    item: MailboxItem,
    lifecycle: StrategyState['lifecycle'],
  ): void {
    const strategy = this.registry.getStrategy(id);
    if (!strategy) return;

    switch (item.kind) {
      case 'candle': {
        const e = item.event as CandleEvent;
        // Partial candles never enter history and are never a trigger — history must contain
        // only closed candles.
        if (!e.closed) return;
        const hist = runtime.candleHistory.get(e.symbol) ?? [];
        hist.push(e);
        if (hist.length > strategy.warmup.bars + 1) hist.shift();
        runtime.candleHistory.set(e.symbol, hist);
        break;
      }
      case 'ticker':
        runtime.tickers.set((item.event as TickerEvent).symbol, item.event as TickerEvent);
        return; // ticker/book fold state only — never a trigger
      case 'book':
        runtime.books.set(
          (item.event as OrderBookSnapshotEvent).symbol,
          item.event as OrderBookSnapshotEvent,
        );
        return;
      case 'exec': {
        runtime.pendingExecReports.push(item.event as ExecReport);
        if (runtime.pendingExecReports.length > MAX_PENDING_EXEC)
          runtime.pendingExecReports.shift();
        break;
      }
    }

    // Kill-switch: state stays warm, but no LLM spend while trading is halted — regardless of
    // lifecycle. Checked after folding so a resumed strategy still sees continuous history.
    if (this.tradingHalted()) return;

    // No decisions during WARMUP (state still building) or while a call is already in flight.
    if (lifecycle === 'WARMUP' || runtime.busy) return;

    // AUTO-DRAINING (3-strike auto-drain, not an operator disable()): decides are suppressed until
    // the cooldown elapses, then exactly one probe decide is let through (busy=true, set synchronously
    // in runDecide, blocks any further trigger until it settles). OPERATOR drains are untouched here —
    // they keep deciding at cadence per the existing risk-reducing filter, and never auto-recover.
    if (lifecycle === 'DRAINING' && this.registry.getDrainReason(id) === 'AUTO') {
      if (this.nowFn() < runtime.cooldownUntilMs) return;
    }

    // Candle triggers respect the cadence gate; exec triggers bypass it (rare, high-value fill
    // awareness) and never advance the clock.
    if (
      item.kind === 'candle' &&
      item.event.eventTime - runtime.lastDecideEventTime < this.minDecisionIntervalMs
    ) {
      return;
    }

    const input: AgentDecisionInput = {
      strategyId: id,
      trigger: this.triggerFor(item),
      snapshot: this.buildSnapshot(id, runtime, item.event.eventTime),
    };
    if (item.kind === 'candle') runtime.lastDecideEventTime = item.event.eventTime;
    this.runDecide(id, strategy, runtime, input);
  }

  // Map a mailbox item to the typed decision trigger.
  private triggerFor(item: MailboxItem): AgentDecisionInput['trigger'] {
    switch (item.kind) {
      case 'candle':
        return { kind: 'candle', event: item.event as CandleEvent };
      case 'ticker':
        return { kind: 'ticker', event: item.event as TickerEvent };
      case 'book':
        return { kind: 'book', event: item.event as OrderBookSnapshotEvent };
      case 'exec':
        return { kind: 'exec', event: item.event as ExecReport };
    }
  }

  // Materialize an immutable snapshot at CALL TIME (containers copied; events are immutable value
  // objects). A decision that resolves after the host mutates its maps still sees this exact state —
  // no post-await race. Drains the folded exec reports into the snapshot (delivered once).
  private buildSnapshot(
    id: StrategyId,
    runtime: StrategyRuntime,
    eventTime: EpochMs,
  ): AgentMarketSnapshot {
    const candles = new Map<SymbolId, readonly CandleEvent[]>();
    for (const [sym, hist] of runtime.candleHistory) candles.set(sym as SymbolId, [...hist]);
    const tickers = new Map<SymbolId, TickerEvent>();
    for (const [sym, t] of runtime.tickers) tickers.set(sym as SymbolId, t);
    const books = new Map<SymbolId, OrderBookSnapshotEvent>();
    for (const [sym, b] of runtime.books) books.set(sym as SymbolId, b);
    // Folded exec reports are delivered to the decide that STARTS now; if that decide times out they
    // are not re-folded for the next one. Acceptable: this is fill-AWARENESS only and fully downstream
    // of Risk (no order ever depends on it) — a follow-up could re-fold on timeout if needed.
    const execReports = [...runtime.pendingExecReports];
    runtime.pendingExecReports = [];
    return {
      eventTime,
      candles,
      tickers,
      books,
      execReports,
      portfolio: this.portfolioFor?.(id) ?? {
        strategyId: id,
        positions: new Map(),
        openOrders: [],
      },
    };
  }

  // Fire-and-forget decide() with a wall-clock timeout. `settled` (closure-local per call) makes the
  // timeout and the resolution mutually exclusive, so a call that times out can never later flip
  // `busy`/`consecutiveTimeouts` or emit stale signals once a fresh call has taken over.
  private runDecide(
    id: StrategyId,
    strategy: AsyncStrategy,
    runtime: StrategyRuntime,
    input: AgentDecisionInput,
  ): void {
    runtime.busy = true;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.onDecideFailure(id, runtime);
    }, this.agentTimeoutMs);

    void strategy
      .decide(input)
      .then((signals) => {
        if (settled) return; // timed out already → drop the late result (would be EXPIRED anyway)
        settled = true;
        clearTimeout(timer);
        runtime.consecutiveTimeouts = 0;
        runtime.busy = false;
        const lifecycle = this.registry.getLifecycle(id);
        if (lifecycle && lifecycle !== 'HALTED' && lifecycle !== 'UNLOADED') {
          // Emit BEFORE recovering lifecycle: a probe decide fired while still DRAINING, so its own
          // signals still pass through the DRAINING risk-reducing filter, same as any other DRAINING
          // decide — proving the lane healthy does not retroactively trust its output.
          this.emitSignals(id, runtime, lifecycle, signals);
        }
        // Any successful decide while AUTO-DRAINING proves the lane healthy: restore ACTIVE. OPERATOR
        // drains never auto-recover — they end only via an explicit operator action, so a decide
        // succeeding mid-OPERATOR-drain must not flip lifecycle.
        if (lifecycle === 'DRAINING' && this.registry.getDrainReason(id) === 'AUTO') {
          runtime.drainFailures = 0;
          runtime.cooldownUntilMs = 0;
          this.registry.setLifecycle(id, 'ACTIVE');
        }
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.onDecideFailure(id, runtime); // a rejection is treated as a failed call (fail-safe)
      });
  }

  // A timed-out or rejected decide(): count it. Three shapes:
  //  - a failed AUTO-drain recovery probe: stay DRAINING, double the cooldown (capped);
  //  - the strike that crosses MAX_CONSECUTIVE_TIMEOUTS from ACTIVE: auto-DRAIN, arm the first cooldown;
  //  - anything else (below the cap, or already OPERATOR-DRAINING): just count it, no transition.
  private onDecideFailure(id: StrategyId, runtime: StrategyRuntime): void {
    runtime.consecutiveTimeouts += 1;
    runtime.busy = false;
    const lifecycle = this.registry.getLifecycle(id);

    if (lifecycle === 'DRAINING' && this.registry.getDrainReason(id) === 'AUTO') {
      runtime.drainFailures += 1;
      const backoff = this.drainCooldownBaseMs * 2 ** runtime.drainFailures;
      runtime.cooldownUntilMs = this.nowFn() + Math.min(backoff, this.drainCooldownMaxMs);
      return;
    }

    if (lifecycle === 'ACTIVE' && runtime.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
      runtime.drainFailures = 0;
      runtime.cooldownUntilMs = this.nowFn() + this.drainCooldownBaseMs;
      this.registry.setLifecycle(id, 'DRAINING', 'AUTO');
    }
  }

  // Shared emit tail for BOTH lanes: discard during WARMUP, keep only risk-reducing kinds while
  // DRAINING, apply the B5 entry cap to entry-kind signals (kill-switch/lifecycle-independent — it
  // binds whenever an entry would otherwise be emitted, ACTIVE or DRAINING alike), then route each
  // surviving signal through the Risk chokepoint (recordSignal) and the local signal channel. The
  // agentic lane reuses this verbatim so its signals cannot bypass Risk.
  private emitSignals(
    id: StrategyId,
    runtime: StrategyRuntime,
    lifecycle: StrategyState['lifecycle'],
    signals: Signal[],
  ): void {
    if (lifecycle === 'WARMUP') return;
    for (const sig of signals) {
      if (lifecycle === 'DRAINING' && !RISK_REDUCING.has(sig.kind)) continue;
      // Entry-kind signals are exactly RISK_REDUCING's complement (ENTER_LONG/ENTER_SHORT) — reused
      // here rather than duplicating a second kind-set that could drift out of sync with it.
      if (!RISK_REDUCING.has(sig.kind) && !this.admitEntry(id, runtime)) continue;
      void this.signalSink.recordSignal(sig);
      this.pushSignal(sig);
    }
  }

  // B5 deterministic entry cap: counts entry-kind signals per strategy against a UTC day derived
  // from nowFn() (wall-clock, not eventTime) and rejects once maxEntriesPerDay is reached. Resets on
  // day rollover. Dropping is silent to the caller (signal just never reaches Risk); a rate-limited
  // warn (once per day-key) surfaces the first drop.
  private admitEntry(id: StrategyId, runtime: StrategyRuntime): boolean {
    const today = utcDayKey(this.nowFn());
    if (runtime.entryDayKey !== today) {
      runtime.entryDayKey = today;
      runtime.entryCount = 0;
      runtime.entryCapWarned = false;
    }
    if (runtime.entryCount >= this.maxEntriesPerDay) {
      if (!runtime.entryCapWarned) {
        this.log.warn(
          `strategy ${id}: daily entry cap (${this.maxEntriesPerDay}) reached for ${today} — dropping further entries`,
        );
        runtime.entryCapWarned = true;
      }
      return false;
    }
    runtime.entryCount += 1;
    return true;
  }

  private pushSignal(sig: Signal): void {
    if (this.signalResolvers.length > 0) {
      const resolve = this.signalResolvers.shift()!;
      resolve({ value: sig, done: false });
    } else {
      this.signalQueue.push(sig);
    }
  }
}
