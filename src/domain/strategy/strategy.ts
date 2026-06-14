import type {
  CandleEvent,
  TickerEvent,
  OrderBookSnapshotEvent,
  CandleInterval,
  ChannelHealth,
} from '../types/market-events';
import type { ExecReport } from '../types/exec-report';
import type { Signal } from '../types/signal';
import type { StrategyPortfolioView } from '../types/portfolio';
import type { StrategyId, SymbolId } from '../types/ids';
import type { Price, Qty } from '../types/money';
import type { SubscriptionSpec } from '../types/subscription';

// ── MarketView ────────────────────────────────────────────────────────────────
//
// Read-only, host-assembled snapshot presented to every strategy handler.
// eventTime is the ONLY clock a strategy ever sees — wall time is forbidden.
// random() returns deterministic values from a per-strategy seeded PRNG so
// full-session replay produces byte-identical signals.

export interface MarketView {
  readonly eventTime: number;
  candles(symbol: SymbolId, interval: CandleInterval, n: number): readonly CandleEvent[];
  lastTicker(symbol: SymbolId): TickerEvent | undefined;
  book(symbol: SymbolId): OrderBookSnapshotEvent | undefined;
  feed(symbol: SymbolId, channel: string): ChannelHealth;
  readonly portfolio: StrategyPortfolioView;
  random(): number;
}

// ── StrategyInitContext ───────────────────────────────────────────────────────
//
// Passed once to Strategy.onInit; contains validated params plus per-symbol
// exchange constraints needed for order-hint construction.

export interface SymbolConstraints {
  readonly tickSize: Price;
  readonly lotStep: Qty;
  readonly minNotional: Price;
}

export interface StrategyInitContext {
  readonly params: Readonly<Record<string, unknown>>;
  readonly warmupCandles: ReadonlyMap<SymbolId, readonly CandleEvent[]>;
  readonly symbolConstraints: ReadonlyMap<SymbolId, SymbolConstraints>;
}

// ── Strategy ─────────────────────────────────────────────────────────────────
//
// All handlers are SYNCHRONOUS — Promise return is a type error (the union
// excludes Promise). Domain purity is enforced by the lint zone: no @nestjs/*,
// no Date, no Math.random, no process, no network inside any implementation.

export interface Strategy {
  readonly id: StrategyId;
  readonly subscriptions: SubscriptionSpec;
  readonly warmup: { readonly interval: CandleInterval; readonly bars: number };
  onInit(ctx: StrategyInitContext): void;
  onCandle(e: CandleEvent, view: MarketView): Signal[];
  onTick(e: TickerEvent, view: MarketView): Signal[];
  onOrderBook(e: OrderBookSnapshotEvent, view: MarketView): Signal[];
  onExecReport(r: ExecReport, view: MarketView): Signal[];
  onStop(): void;
}
