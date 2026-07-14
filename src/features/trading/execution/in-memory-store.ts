import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { ClientOrderId } from '../../../domain/types/ids';
import type { OrderIntent } from '../../../domain/types/order-intent';
import type { ApprovalProof } from '../../../domain/types/risk-decision';
import type { FillRecord } from '../../../domain/types/exec-report';
import type { Position } from '../../../domain/types/portfolio';
import type {
  ExecutionStorePort,
  PersistedOrderEvent,
  EquitySample,
  ReconciliationRow,
  RecoveredOpenOrder,
} from '../../../ports/execution';
import type { OrderRecord, OrderState } from '../../../domain/oms/reducer';

interface StoredOrder {
  state: OrderState;
  cumQty: string;
  venueOrderId?: string;
  intentId?: string;
}

// In-process EXECUTION_STORE default (DB-less paper, and the test substrate). Mirrors the
// write-ahead durability contract: intents/orders/events/fills/equity, with the same
// idempotency keys the DB enforces — (clientOrderId, dedupeKey) for events, (venue, symbol,
// venueTradeId) for fills. Inspection getters exist for tests to pin the write-ahead ordering.
@Injectable()
export class InMemoryExecutionStore implements ExecutionStorePort {
  readonly intents = new Map<string, { intent: OrderIntent; proof: ApprovalProof }>();
  readonly orders = new Map<string, StoredOrder>();
  readonly events: PersistedOrderEvent[] = [];
  readonly fills = new Map<string, FillRecord & { intentId: string }>();
  readonly equity: EquitySample[] = [];
  readonly reconciliations: ReconciliationRow[] = [];
  private readonly eventKeys = new Set<string>();
  private lastSample: EquitySample | null = null;
  private lastPositions: readonly Position[] = [];

  saveIntent(intent: OrderIntent, proof: ApprovalProof): Promise<void> {
    this.intents.set(intent.clientOrderId, { intent, proof });
    return Promise.resolve();
  }

  saveNewOrder(record: OrderRecord, intent: OrderIntent): Promise<void> {
    this.orders.set(record.clientOrderId, {
      state: record.state,
      cumQty: record.cumQty.toFixed(),
      intentId: intent.intentId,
    });
    return Promise.resolve();
  }

  appendOrderEvent(ev: PersistedOrderEvent): Promise<{ applied: boolean }> {
    const key = `${ev.clientOrderId}|${ev.dedupeKey}`;
    if (this.eventKeys.has(key)) return Promise.resolve({ applied: false });
    this.eventKeys.add(key);
    this.events.push(ev);
    const prev = this.orders.get(ev.clientOrderId);
    this.orders.set(ev.clientOrderId, {
      state: ev.derivedState,
      cumQty: ev.cumQty,
      venueOrderId: ev.venueOrderId ?? prev?.venueOrderId,
    });
    return Promise.resolve({ applied: true });
  }

  saveFill(fill: FillRecord, intentId: string): Promise<{ inserted: boolean; conflict: boolean }> {
    const key = `${fill.venue}|${fill.symbol}|${fill.venueTradeId}`;
    const existing = this.fills.get(key);
    if (existing !== undefined) {
      // Same tradeId, different price/qty is corruption (§6.6 I3); same payload is a benign dup.
      const conflict = !existing.price.eq(fill.price) || !existing.qty.eq(fill.qty);
      return Promise.resolve({ inserted: false, conflict });
    }
    this.fills.set(key, { ...fill, intentId });
    return Promise.resolve({ inserted: true, conflict: false });
  }

  savePortfolioSample(sample: EquitySample, positions: readonly Position[]): Promise<void> {
    this.equity.push(sample);
    this.lastSample = sample;
    this.lastPositions = [...positions];
    return Promise.resolve();
  }

  saveReconciliation(row: ReconciliationRow): Promise<void> {
    this.reconciliations.push(row);
    return Promise.resolve();
  }

  loadRecoverySnapshot(): Promise<{
    latest: EquitySample | null;
    sodEquity: string | null;
    positions: Position[];
  }> {
    return Promise.resolve({
      latest: this.lastSample,
      sodEquity: null,
      positions: [...this.lastPositions],
    });
  }

  loadOpenOrders(): Promise<RecoveredOpenOrder[]> {
    return Promise.resolve([]);
  }

  loadFilledQty(clientOrderId: ClientOrderId): Promise<string> {
    let total = new Decimal(0);
    for (const f of this.fills.values()) {
      if (f.clientOrderId === clientOrderId) total = total.add(f.qty);
    }
    return Promise.resolve(total.toFixed());
  }

  // Push 3 P7c: resting-order role resolution's read path — the `intents` map above already keys
  // the full OrderIntent (dedupeKey included) by clientOrderId from saveIntent, so this is a plain
  // lookup, no extra bookkeeping.
  loadIntentByClientOrderId(clientOrderId: ClientOrderId): Promise<OrderIntent | null> {
    return Promise.resolve(this.intents.get(clientOrderId)?.intent ?? null);
  }

  // ── Inspection (tests) ───────────────────────────────────────────────────────
  stateOf(clientOrderId: ClientOrderId): OrderState | undefined {
    return this.orders.get(clientOrderId)?.state;
  }
}
