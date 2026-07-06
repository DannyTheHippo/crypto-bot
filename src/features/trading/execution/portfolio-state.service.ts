import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { price } from '../../../domain/types/money';
import { splitSymbol } from '../../../domain/types/symbol';
import { positionKey } from '../../../domain/risk/evaluate';
import { FLAT, type PositionState } from '../../../domain/oms/position';
import { applyFillToPortfolio } from '../../../domain/oms/portfolio-fill';
import type { OrderIntent } from '../../../domain/types/order-intent';
import type { FillRecord } from '../../../domain/types/exec-report';
import type {
  Position,
  PortfolioSnapshot,
  StrategyPortfolioView,
  OpenOrderSummary,
  AssetBalance,
} from '../../../domain/types/portfolio';
import type { StrategyId, ClientOrderId } from '../../../domain/types/ids';
import {
  PORTFOLIO_CONFIG,
  type PortfolioConfig,
  type PortfolioViewPort,
} from '../../../ports/execution';
import { FeeLedgerService } from './fee-ledger.service';

interface OpenOrderRec {
  readonly summary: OpenOrderSummary;
  readonly strategyId: StrategyId;
}

// Summary of one applyFill fold, consumed by the fill ingestor to emit round-trip profitability
// metrics. closedToFlat mirrors the position-delete check; roundTripRealizedPnl is the realized PnL
// of the just-closed round trip (net of quote fees), or null when the fill did not close to flat.
export interface FillApplication {
  readonly closedToFlat: boolean;
  readonly roundTripRealizedPnl: Decimal | null;
}

// Canonical in-memory portfolio (§2.4): per-strategy virtual sub-account positions, a single
// quote-cash balance (v1 single-quote), and the equity/peak/sod that Risk's C1/C2 read. Fills
// fold through the pure applyFillToPortfolio; third-asset fees are routed to the fee ledger.
// The DB is the durable write-ahead log behind this (Execution holds the runtime truth).
@Injectable()
export class PortfolioStateService implements PortfolioViewPort {
  private readonly positions = new Map<string, Position>();
  private readonly inFlight = new Map<string, OrderIntent>();
  private readonly openOrders = new Map<string, OpenOrderRec>();
  private readonly quoteAsset: string;
  private readonly startingCash: Decimal;
  private cash: Decimal;
  private equityValue: Decimal;
  // Unrealized PnL of the current book, refreshed by recordEquity (the sampler owns the marks). Held
  // separately from equity so the snapshot can surface it directly without re-deriving from marks.
  private unrealizedValue: Decimal;
  private peak: Decimal;
  private sodUtc: Decimal;
  private seq = 1n;

  constructor(
    @Inject(PORTFOLIO_CONFIG) cfg: PortfolioConfig,
    private readonly fees: FeeLedgerService,
  ) {
    this.quoteAsset = cfg.quoteAsset;
    this.startingCash = new Decimal(cfg.startingCash);
    this.cash = this.startingCash;
    this.equityValue = this.cash;
    this.unrealizedValue = new Decimal(0);
    this.peak = this.cash;
    this.sodUtc = this.cash;
  }

  // Fold one realized fill into positions + quote cash + fee ledger (§6.6). Returns a summary the
  // fill ingestor turns into round-trip profitability metrics.
  applyFill(intent: OrderIntent, fill: FillRecord): FillApplication {
    const key = positionKey(intent.strategyId, intent.venue, intent.symbol);
    const prior: PositionState = this.positions.get(key) ?? FLAT;
    const { base, quote } = splitSymbol(intent.symbol);
    const result = applyFillToPortfolio(prior, {
      side: intent.side,
      fillQty: fill.qty,
      fillPrice: fill.price,
      fee: fill.fee ? { ccy: fill.fee.ccy, amount: fill.fee.amount } : null,
      baseAsset: base,
      quoteAsset: quote,
    });

    // Same check as the delete below: whatever the fold considers flat is a completed round trip.
    // Spot long/flat never flips, so "round trip" == the position reaching flat (CLAUDE.md §4).
    const closedToFlat = result.position.signedQty.isZero();
    if (closedToFlat) {
      this.positions.delete(key);
    } else {
      this.positions.set(key, {
        strategyId: intent.strategyId,
        venue: intent.venue,
        symbol: intent.symbol,
        signedQty: result.position.signedQty,
        avgEntry: price(result.position.avgEntry),
        realizedPnl: result.position.realizedPnl,
      });
    }
    this.cash = this.cash.add(result.cashDelta);
    if (result.feeLedger) this.fees.add(result.feeLedger.asset, result.feeLedger.amount);
    this.seq += 1n;

    // At the flat transition realizedPnl carries the full round-trip PnL (net of quote fees); the
    // position is deleted above, so the next open starts fresh from FLAT with realizedPnl = 0.
    return {
      closedToFlat,
      roundTripRealizedPnl: closedToFlat ? result.position.realizedPnl : null,
    };
  }

  addInFlight(intent: OrderIntent): void {
    this.inFlight.set(intent.clientOrderId, intent);
  }

  clearInFlight(clientOrderId: ClientOrderId): void {
    this.inFlight.delete(clientOrderId);
  }

  inFlightIntent(clientOrderId: ClientOrderId): OrderIntent | undefined {
    return this.inFlight.get(clientOrderId);
  }

  openOrder(strategyId: StrategyId, summary: OpenOrderSummary): void {
    this.openOrders.set(summary.clientOrderId, { summary, strategyId });
  }

  closeOrder(clientOrderId: ClientOrderId): void {
    this.openOrders.delete(clientOrderId);
  }

  // Equity and unrealized PnL are computed by the EquitySampler (it owns marks); this records the
  // result and ratchets the peak.
  recordEquity(equity: Decimal, unrealized: Decimal): void {
    this.equityValue = equity;
    this.unrealizedValue = unrealized;
    if (equity.gt(this.peak)) this.peak = equity;
  }

  // §5 daily-loss anchor: at the UTC day rollover the start-of-day equity is re-set to the
  // current equity (the monitor detects the rollover and drives this). The peak is NOT reset —
  // drawdown is measured against the all-time high-water mark, not per-day.
  anchorStartOfDay(equity: Decimal): void {
    this.sodUtc = equity;
  }

  cashBalance(): Decimal {
    return this.cash;
  }

  sodEquity(): Decimal {
    return this.sodUtc;
  }

  peakEquity(): Decimal {
    return this.peak;
  }

  livePositions(): readonly Position[] {
    return [...this.positions.values()];
  }

  // Restore in-memory state from a persisted snapshot. seq is run-local and not persisted.
  restoreFromSnapshot(snap: {
    cash: Decimal;
    equity: Decimal;
    peak: Decimal;
    sodEquity: Decimal;
    positions: readonly Position[];
  }): void {
    this.cash = snap.cash;
    this.equityValue = snap.equity;
    this.peak = snap.peak;
    this.sodUtc = snap.sodEquity;
    this.positions.clear();
    for (const p of snap.positions) {
      this.positions.set(positionKey(p.strategyId, p.venue, p.symbol), p);
    }
  }

  snapshot(): PortfolioSnapshot {
    return {
      positions: new Map(this.positions),
      balances: this.deriveBalances(),
      openOrders: [...this.openOrders.values()].map((o) => o.summary),
      inFlightIntents: [...this.inFlight.values()],
      equity: this.equityValue,
      unrealized: this.unrealizedValue,
      startingCash: this.startingCash,
      peakEquity: this.peak,
      sodEquityUtc: this.sodUtc,
      reconcileStatus: 'CLEAN',
      snapshotSeq: this.seq,
    };
  }

  forStrategy(strategyId: StrategyId): StrategyPortfolioView {
    const positions = new Map<string, Position>();
    for (const [k, p] of this.positions) {
      if (p.strategyId === strategyId) positions.set(k, p);
    }
    const openOrders = [...this.openOrders.values()]
      .filter((o) => o.strategyId === strategyId)
      .map((o) => o.summary);
    return { strategyId, positions, openOrders };
  }

  // Derived balances: quote cash plus net base holdings aggregated across sub-accounts. Locks
  // live in the venue adapter, not here, so locked is 0 at this layer.
  private deriveBalances(): ReadonlyMap<string, AssetBalance> {
    const balances = new Map<string, AssetBalance>();
    balances.set(this.quoteAsset, { free: this.cash, locked: new Decimal(0) });
    for (const p of this.positions.values()) {
      const { base } = splitSymbol(p.symbol);
      const prev = balances.get(base)?.free ?? new Decimal(0);
      balances.set(base, { free: prev.add(p.signedQty), locked: new Decimal(0) });
    }
    return balances;
  }
}
