import { Inject, Injectable } from '@nestjs/common';
import { EXECUTION_STORE, type ExecutionStorePort } from '../../../ports/execution';
import { reduce } from '../../../domain/oms/reducer';
import { recoveryEventFor, isUnresolved } from '../../../domain/oms/recovery';
import type { ClientOrderId } from '../../../domain/types/ids';
import { OrderBookService } from './order-book.service';

// §6.1 crash recovery. On startup the OrderBook is rebuilt from the durable order_events journal;
// this service then degrades every in-flight order to its *_UNKNOWN counterpart (I1 — never to an
// optimistic state) so the query loop + a reconciliation pass establish venue truth before
// anything trades. The caller (composition root) runs recoverOnBoot → reconcile → resolver.tick,
// and `hasUnresolvedOrders` is the predicate ModeControl reads to refuse live arming (§6.1/§8).
@Injectable()
export class CrashRecoveryService {
  constructor(
    @Inject(EXECUTION_STORE) private readonly store: ExecutionStorePort,
    private readonly orders: OrderBookService,
  ) {}

  // Degrade in-flight orders; returns the degraded clientOrderIds. Journal-before-commit (I1),
  // committing only what the journal accepts so a re-run after a partial recovery is idempotent.
  async recoverOnBoot(): Promise<ClientOrderId[]> {
    const degraded: ClientOrderId[] = [];
    for (const rec of this.orders.all()) {
      const event = recoveryEventFor(rec.state);
      if (event === undefined) continue;
      const next = reduce(rec, event);
      const { applied } = await this.store.appendOrderEvent({
        clientOrderId: rec.clientOrderId,
        dedupeKey: `recover:${event.type}`,
        event,
        derivedState: next.state,
        cumQty: next.cumQty.toFixed(),
      });
      if (!applied) continue;
      this.orders.commit(next);
      degraded.push(rec.clientOrderId);
    }
    return degraded;
  }

  // True while any order is *_UNKNOWN or frozen at RECONCILE_REQUIRED — the state of real money is
  // in doubt, so live arming is refused.
  hasUnresolvedOrders(): boolean {
    return this.orders.all().some((rec) => isUnresolved(rec.state));
  }
}
