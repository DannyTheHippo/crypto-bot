import type { OrderState, OrderEvent } from './reducer';

// §6.1 crash recovery (invariant I1): on startup, in-flight states degrade to their *_UNKNOWN
// counterpart — never to an optimistic state — and a full reconciliation pass then resolves them.
// SUBMITTING may or may not have reached the venue ⇒ SUBMIT_UNKNOWN (query-before-resubmit, never a
// blind resubmit on the deterministic id). CANCEL_PENDING's cancel may or may not have landed ⇒
// CANCEL_UNKNOWN. Every other state is already durable truth and is left untouched. The mapping
// reuses the normal reducer events so recovery flows through the same audited transitions.
export function recoveryEventFor(state: OrderState): OrderEvent | undefined {
  switch (state) {
    case 'SUBMITTING': return { type: 'SUBMIT_AMBIGUOUS' };
    case 'CANCEL_PENDING': return { type: 'CANCEL_REJECT_UNKNOWN' };
    default: return undefined;
  }
}

// Live arming is refused while any order is unresolved (§6.1): a *_UNKNOWN or a frozen
// RECONCILE_REQUIRED means the state of real money is in doubt.
const UNRESOLVED: ReadonlySet<OrderState> = new Set(['SUBMIT_UNKNOWN', 'CANCEL_UNKNOWN', 'RECONCILE_REQUIRED']);

export function isUnresolved(state: OrderState): boolean {
  return UNRESOLVED.has(state);
}
