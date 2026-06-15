import Decimal from 'decimal.js';
import type { ClientOrderId } from '../types/ids';

// Pure OMS state machine (§6.1). State is derived from the append-only order_events
// journal by folding this reducer; illegal (state, event) pairs throw (I7 — never a
// silent coercion). Invariants: I4 cumQty monotone non-decreasing and ≤ qty + one step;
// I5 unknown-is-a-state; fills win cancel races.

export type OrderState =
  | 'NEW'
  | 'SUBMITTING'
  | 'ACKED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'SUBMIT_UNKNOWN'
  | 'CANCEL_PENDING'
  | 'CANCEL_UNKNOWN'
  | 'RECONCILE_REQUIRED';

// Runtime allow-list for OrderState, kept in lock-step with the union by `satisfies`. Used to
// validate persisted state strings on the recovery read path (I7 — an unrecognized state is never
// silently coerced/trusted; the caller fails fast).
export const ORDER_STATES = [
  'NEW',
  'SUBMITTING',
  'ACKED',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
  'SUBMIT_UNKNOWN',
  'CANCEL_PENDING',
  'CANCEL_UNKNOWN',
  'RECONCILE_REQUIRED',
] as const satisfies readonly OrderState[];

export function isOrderState(s: string): s is OrderState {
  return (ORDER_STATES as readonly string[]).includes(s);
}

export interface OrderRecord {
  readonly clientOrderId: ClientOrderId;
  readonly state: OrderState;
  readonly qty: Decimal;
  readonly cumQty: Decimal;
  readonly stepSize: string;
  readonly venueOrderId?: string;
  readonly attempt: number;
  readonly cancelWanted: boolean;
}

export type OrderEvent =
  | { type: 'SUBMIT_SENT' }
  | { type: 'ACK'; venueOrderId: string }
  | { type: 'REJECT' }
  | { type: 'SUBMIT_FAILED_NOT_SENT' }
  | { type: 'SUBMIT_AMBIGUOUS' }
  | { type: 'FILL'; cumQty: Decimal }
  | { type: 'VENUE_CANCELED' }
  | { type: 'VENUE_EXPIRED' }
  | { type: 'CANCEL_REQUESTED' }
  | { type: 'CANCEL_ACK' }
  | { type: 'CANCEL_REJECT_UNKNOWN' }
  | { type: 'QUERY_NOT_FOUND' } // not found AND resubmit-eligible (intent TTL unexpired)
  | { type: 'QUERY_NOT_FOUND_EXPIRED' } // not found AND intent TTL expired ⇒ local cancel
  | { type: 'QUERY_INCONCLUSIVE' };

export class TransitionError extends Error {
  constructor(state: OrderState, eventType: OrderEvent['type']) {
    super(`Illegal OMS transition: ${eventType} in state ${state}`);
    this.name = 'TransitionError';
  }
}

const MAX_SUBMIT_ATTEMPTS = 3;

export function initialOrder(
  clientOrderId: ClientOrderId,
  qty: Decimal,
  stepSize: string,
): OrderRecord {
  return {
    clientOrderId,
    state: 'NEW',
    qty,
    cumQty: new Decimal(0),
    stepSize,
    attempt: 0,
    cancelWanted: false,
  };
}

// Apply a venue CUMULATIVE fill quantity. Returns the new cumQty + whether the order is
// fully filled (residual dust < stepSize counts as filled — venues round). A lower-than-
// current cumQty is a stale duplicate (dropped). cumQty beyond qty + one step is an I4
// money anomaly and throws.
type FillOutcome = { kind: 'stale' } | { kind: 'applied'; cumQty: Decimal; full: boolean };

function applyFill(rec: OrderRecord, newCum: Decimal): FillOutcome {
  if (newCum.lte(rec.cumQty)) return { kind: 'stale' };
  const step = new Decimal(rec.stepSize);
  if (newCum.gt(rec.qty.add(step))) {
    throw new TransitionError(rec.state, 'FILL'); // cumQty overflow — money anomaly
  }
  const residual = rec.qty.sub(newCum);
  return { kind: 'applied', cumQty: newCum, full: residual.lt(step) };
}

function withFill(rec: OrderRecord, newCum: Decimal, partialState: OrderState): OrderRecord {
  const out = applyFill(rec, newCum);
  if (out.kind === 'stale') return rec;
  return { ...rec, cumQty: out.cumQty, state: out.full ? 'FILLED' : partialState };
}

export function reduce(rec: OrderRecord, event: OrderEvent): OrderRecord {
  switch (rec.state) {
    case 'NEW':
      if (event.type === 'SUBMIT_SENT') return { ...rec, state: 'SUBMITTING' };
      if (event.type === 'CANCEL_REQUESTED') return { ...rec, state: 'CANCELED' }; // never sent, local-only
      throw new TransitionError(rec.state, event.type);

    case 'SUBMITTING':
      switch (event.type) {
        case 'ACK':
          return { ...rec, state: 'ACKED', venueOrderId: event.venueOrderId };
        case 'REJECT':
          return { ...rec, state: 'REJECTED' };
        case 'SUBMIT_FAILED_NOT_SENT': {
          const attempt = rec.attempt + 1;
          return attempt > MAX_SUBMIT_ATTEMPTS
            ? { ...rec, state: 'REJECTED', attempt }
            : { ...rec, state: 'NEW', attempt };
        }
        case 'SUBMIT_AMBIGUOUS':
          return { ...rec, state: 'SUBMIT_UNKNOWN' };
        case 'FILL':
          return withFill(rec, event.cumQty, 'PARTIALLY_FILLED'); // implicit ack: WS beat REST
        case 'VENUE_CANCELED':
          return { ...rec, state: 'CANCELED' };
        case 'VENUE_EXPIRED':
          return { ...rec, state: 'EXPIRED' };
        case 'CANCEL_REQUESTED':
          return { ...rec, cancelWanted: true }; // deferred until resolution
        default:
          throw new TransitionError(rec.state, event.type);
      }

    case 'SUBMIT_UNKNOWN':
      switch (event.type) {
        case 'ACK':
          return { ...rec, state: 'ACKED', venueOrderId: event.venueOrderId };
        case 'FILL':
          return withFill(rec, event.cumQty, 'PARTIALLY_FILLED');
        case 'VENUE_CANCELED':
          return { ...rec, state: 'CANCELED' };
        case 'VENUE_EXPIRED':
          return { ...rec, state: 'EXPIRED' };
        case 'REJECT':
          return { ...rec, state: 'REJECTED' };
        case 'QUERY_NOT_FOUND':
          return { ...rec, state: 'NEW' }; // resubmit-eligible, same clientOrderId (TTL live)
        case 'QUERY_NOT_FOUND_EXPIRED':
          return { ...rec, state: 'CANCELED' }; // never landed and the intent TTL lapsed — local cancel
        case 'QUERY_INCONCLUSIVE':
          return { ...rec, state: 'RECONCILE_REQUIRED' };
        default:
          throw new TransitionError(rec.state, event.type);
      }

    case 'ACKED':
    case 'PARTIALLY_FILLED':
      switch (event.type) {
        case 'FILL':
          return withFill(rec, event.cumQty, 'PARTIALLY_FILLED');
        case 'CANCEL_REQUESTED':
          return { ...rec, state: 'CANCEL_PENDING' };
        case 'VENUE_CANCELED':
          return { ...rec, state: 'CANCELED' };
        case 'VENUE_EXPIRED':
          return { ...rec, state: 'EXPIRED' };
        default:
          throw new TransitionError(rec.state, event.type);
      }

    case 'CANCEL_PENDING':
      switch (event.type) {
        case 'CANCEL_ACK':
          return { ...rec, state: 'CANCELED' };
        case 'FILL':
          return withFill(rec, event.cumQty, 'CANCEL_PENDING'); // fills win; keep waiting until terminal
        case 'CANCEL_REJECT_UNKNOWN':
          return { ...rec, state: 'CANCEL_UNKNOWN' };
        default:
          throw new TransitionError(rec.state, event.type);
      }

    case 'CANCEL_UNKNOWN':
      switch (event.type) {
        case 'FILL':
          return withFill(rec, event.cumQty, 'CANCEL_UNKNOWN');
        case 'CANCEL_ACK':
          return { ...rec, state: 'CANCELED' }; // query resolved: canceled
        case 'QUERY_NOT_FOUND':
          return { ...rec, state: 'RECONCILE_REQUIRED' }; // an order we hold an ack for cannot vanish
        case 'QUERY_INCONCLUSIVE':
          return { ...rec, state: 'RECONCILE_REQUIRED' };
        default:
          throw new TransitionError(rec.state, event.type);
      }

    case 'RECONCILE_REQUIRED':
      // Frozen: fills are still ingested (facts), everything else awaits operator evidence.
      if (event.type === 'FILL') return withFill(rec, event.cumQty, 'RECONCILE_REQUIRED');
      throw new TransitionError(rec.state, event.type);

    case 'FILLED':
    case 'CANCELED':
    case 'REJECTED':
    case 'EXPIRED':
      return reduceTerminal(rec, event);
  }
}

// Late cross-channel events on a terminal order. A late fill (new cumulative ≤ qty) is
// legal and absorbed; a CANCELED order whose late fills reach full qty is a contradiction
// → RECONCILE_REQUIRED. Stale duplicates are dropped. Anything else freezes for review.
function reduceTerminal(rec: OrderRecord, event: OrderEvent): OrderRecord {
  if (event.type !== 'FILL') {
    // A duplicate of the same terminal is a no-op; a contradicting terminal freezes.
    if (
      (event.type === 'VENUE_CANCELED' && rec.state === 'CANCELED') ||
      (event.type === 'VENUE_EXPIRED' && rec.state === 'EXPIRED') ||
      (event.type === 'REJECT' && rec.state === 'REJECTED')
    ) {
      return rec;
    }
    return { ...rec, state: 'RECONCILE_REQUIRED' };
  }
  const out = applyFill(rec, event.cumQty);
  if (out.kind === 'stale') return rec;
  if (rec.state === 'FILLED') return { ...rec, cumQty: out.cumQty }; // more fill detail, still filled
  // A non-FILLED terminal (CANCELED/EXPIRED/REJECTED) receiving real fills is a contradiction.
  return { ...rec, cumQty: out.cumQty, state: 'RECONCILE_REQUIRED' };
}
