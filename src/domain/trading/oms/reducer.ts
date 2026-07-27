import Decimal from 'decimal.js';
import type { ClientOrderId, SymbolId } from '../../common/types/ids';

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

// Single source of truth for "the order will never transition again" (was hand-synced across
// execution-gate/fill-ingestor/unknown-resolver/exec-report-consumer — W7 collapsed the copies).
export const TERMINAL_ORDER_STATES: ReadonlySet<OrderState> = new Set([
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
]);

export interface OrderRecord {
  readonly clientOrderId: ClientOrderId;
  readonly state: OrderState;
  readonly qty: Decimal;
  readonly cumQty: Decimal;
  readonly stepSize: string;
  readonly venueOrderId?: string;
  readonly attempt: number;
  readonly cancelWanted: boolean;
  // Which market this order belongs to. Carried so a consumer holding only an OrderRecord can tell
  // WHICH VENUE it is on (venueForSymbol) — `venueOrderId` alone cannot: that id is unique only per
  // venue (order.repository.ts's findByVenueOrderId is venue-scoped for exactly this reason), so a
  // book-wide index keyed on it can hand a perp trade a spot order. Optional because it is not part
  // of the state machine and every pre-existing record/test predates it; consumers MUST treat
  // `undefined` as "venue unknown" and fall back to a venue-scoped source, never as a match.
  readonly symbol?: SymbolId;
}

export type OrderEvent =
  | { type: 'SUBMIT_SENT' }
  | { type: 'ACK'; venueOrderId: string }
  // Defect A commit-1 (REJECT venue-reason persistence, 2026-07-16): code/message are additive and
  // OPTIONAL — reduce() below switches on rec.state + event.type only, never these fields, so a
  // REJECT with or without them reduces identically. Populated at the two sites that know a venue
  // reason (execution-gate.service.ts's onPlaceError from AdapterError; exec-report-consumer.service
  // .ts's REJECT report if the report carries one); every other REJECT site (unknown-resolver's
  // query-rejected fold) stays bare, same as before.
  | { type: 'REJECT'; code?: string; message?: string }
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
  | { type: 'QUERY_INCONCLUSIVE' }
  // 2026-07-27 defect fix: RECONCILE_REQUIRED had no mechanism to ever leave — no HTTP route
  // supplies the "operator evidence" the old comment promised, so one order reaching it disabled
  // kill-switch auto-resume forever. Emitted only by the resolver's bounded, rate-limited re-query
  // pass (unknown-resolver.service.ts's reconcileFrozen) on a DEFINITIVE venue-confirmed terminal —
  // never from placing/cancelling anything.
  | { type: 'RECONCILE_ADOPT_TERMINAL'; terminal: 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED' };

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
  symbol?: SymbolId,
): OrderRecord {
  return {
    clientOrderId,
    state: 'NEW',
    qty,
    cumQty: new Decimal(0),
    stepSize,
    attempt: 0,
    cancelWanted: false,
    symbol,
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
        // Venue truth adopted by reconciliation confirms the cancel we asked for — outside paper
        // there is no user stream, so no CANCEL_ACK exec report ever arrives and the reconcile
        // sweep is the channel that terminates a cancel-in-flight order (2026-07-07: this pair
        // being illegal stranded one order and aborted every reconcile pass for an hour).
        case 'VENUE_CANCELED':
          return { ...rec, state: 'CANCELED' };
        case 'VENUE_EXPIRED':
          return { ...rec, state: 'EXPIRED' };
        default:
          throw new TransitionError(rec.state, event.type);
      }

    case 'CANCEL_UNKNOWN':
      switch (event.type) {
        case 'FILL':
          return withFill(rec, event.cumQty, 'CANCEL_UNKNOWN');
        case 'CANCEL_ACK':
          return { ...rec, state: 'CANCELED' }; // query resolved: canceled
        // Same reconcile-channel adoption as CANCEL_PENDING: crash recovery degrades a pending
        // cancel to CANCEL_UNKNOWN, and a recovered order has no in-flight intent for the query
        // loop — reconciliation's venue truth is the only resolver left.
        case 'VENUE_CANCELED':
          return { ...rec, state: 'CANCELED' };
        case 'VENUE_EXPIRED':
          return { ...rec, state: 'EXPIRED' };
        case 'QUERY_NOT_FOUND':
          return { ...rec, state: 'RECONCILE_REQUIRED' }; // an order we hold an ack for cannot vanish
        case 'QUERY_INCONCLUSIVE':
          return { ...rec, state: 'RECONCILE_REQUIRED' };
        default:
          throw new TransitionError(rec.state, event.type);
      }

    case 'RECONCILE_REQUIRED':
      // Frozen: fills are still ingested (facts). RECONCILE_ADOPT_TERMINAL is the one other
      // exit — a re-query pass's DEFINITIVE venue terminal; everything else still awaits it.
      if (event.type === 'FILL') return withFill(rec, event.cumQty, 'RECONCILE_REQUIRED');
      if (event.type === 'RECONCILE_ADOPT_TERMINAL') {
        // FAIL CLOSED: a venue "filled" claim our own fill journal does not corroborate (cumQty
        // short of qty) must never fabricate a completed order — adoption refuses and the state
        // stays frozen for the next pass rather than silently completing a possibly-partial order.
        if (event.terminal === 'FILLED' && rec.cumQty.lt(rec.qty)) {
          throw new TransitionError(rec.state, event.type);
        }
        return { ...rec, state: event.terminal };
      }
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
    // A duplicate of the same terminal is a no-op; a contradicting terminal freezes. CANCEL_ACK on
    // CANCELED is the two-channel case: the gate folds the REST cancel success inline while the
    // paper outbox also delivers a CANCEL_ACK report — a second confirmation of the same cancel.
    if (
      (event.type === 'VENUE_CANCELED' && rec.state === 'CANCELED') ||
      (event.type === 'CANCEL_ACK' && rec.state === 'CANCELED') ||
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
