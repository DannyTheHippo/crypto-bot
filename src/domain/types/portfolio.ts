import type Decimal from 'decimal.js';
import type { Price, Qty } from './money';
import type { StrategyId, VenueId, SymbolId, ClientOrderId } from './ids';
import type { OrderIntent } from './order-intent';

// ── Per-strategy, per-venue, per-symbol position ──────────────────────────────

export interface Position {
  readonly strategyId: StrategyId;
  readonly venue: VenueId;
  readonly symbol: SymbolId;
  readonly signedQty: Decimal;
  readonly avgEntry: Price;
  readonly realizedPnl: Decimal;
}

// ── Asset balance ─────────────────────────────────────────────────────────────

export interface AssetBalance {
  readonly free: Decimal;
  readonly locked: Decimal;
}

// ── Open order summary ────────────────────────────────────────────────────────

export interface OpenOrderSummary {
  readonly clientOrderId: ClientOrderId;
  readonly symbol: SymbolId;
  readonly side: 'BUY' | 'SELL';
  readonly qty: Qty;
  readonly limitPrice?: Price;
}

// ── PortfolioSnapshot ─────────────────────────────────────────────────────────

export interface PortfolioSnapshot {
  readonly positions: ReadonlyMap<string, Position>;
  readonly balances: ReadonlyMap<string, AssetBalance>;
  readonly openOrders: readonly OpenOrderSummary[];
  readonly inFlightIntents: readonly OrderIntent[];
  readonly equity: Decimal;
  // Unrealized PnL embedded in equity: Σ signedQty×(mark − avgEntry). Broken out for display.
  readonly unrealized: Decimal;
  // The seed baseline (PortfolioConfig.startingCash) — the denominator for return-since-inception.
  readonly startingCash: Decimal;
  readonly peakEquity: Decimal;
  readonly sodEquityUtc: Decimal;
  readonly reconcileStatus: 'CLEAN' | 'PENDING' | 'MISMATCH';
  readonly snapshotSeq: bigint;
}

// ── StrategyPortfolioView — own data only, no balances/equity ─────────────────

export interface StrategyPortfolioView {
  readonly strategyId: StrategyId;
  readonly positions: ReadonlyMap<string, Position>;
  readonly openOrders: readonly OpenOrderSummary[];
}
