import { Injectable } from '@nestjs/common';
import { reduce, type OrderRecord, type OrderEvent } from '../../../domain/oms/reducer';
import type { ClientOrderId } from '../../../domain/types/ids';

// Runtime cache of OrderRecords keyed by clientOrderId, shared by the gate (which creates
// and submits) and the report consumer (which folds fills/cancels). State is the pure
// reducer's output; this service is the in-memory projection of the durable order_events log.
@Injectable()
export class OrderBookService {
  private readonly orders = new Map<string, OrderRecord>();

  create(record: OrderRecord): void {
    this.orders.set(record.clientOrderId, record);
  }

  get(clientOrderId: ClientOrderId): OrderRecord | undefined {
    return this.orders.get(clientOrderId);
  }

  // Fold one event through the pure reducer and store the result. Throws if the order is
  // unknown (an event for an order we never created is a pipeline bug, not a venue fact).
  apply(clientOrderId: ClientOrderId, event: OrderEvent): OrderRecord {
    const rec = this.orders.get(clientOrderId);
    if (rec === undefined) throw new Error(`OrderBook.apply: unknown order ${clientOrderId}`);
    const next = reduce(rec, event);
    this.orders.set(clientOrderId, next);
    return next;
  }

  // Commit an already-reduced record (consumer pattern: reduce → persist-with-dedupe →
  // commit only if the journal accepted it, so a redelivered event never re-folds in memory).
  commit(record: OrderRecord): void {
    this.orders.set(record.clientOrderId, record);
  }

  // venueOrderId is metadata, not a state transition — recorded directly (e.g. when a fill
  // implicitly acked the order before the REST ack returned).
  setVenueOrderId(clientOrderId: ClientOrderId, venueOrderId: string): void {
    const rec = this.orders.get(clientOrderId);
    if (rec !== undefined && rec.venueOrderId === undefined) {
      this.orders.set(clientOrderId, { ...rec, venueOrderId });
    }
  }

  all(): readonly OrderRecord[] {
    return [...this.orders.values()];
  }
}
