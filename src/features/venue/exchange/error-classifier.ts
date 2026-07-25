import {
  BaseError,
  AuthenticationError,
  PermissionDenied,
  AccountSuspended,
  InvalidOrder,
  OrderNotFound,
  DuplicateOrderId,
  OrderImmediatelyFillable,
  OrderNotFillable,
  BadSymbol,
  BadRequest,
  InsufficientFunds,
  NotSupported,
  OperationRejected,
  OnMaintenance,
  DDoSProtection,
  RateLimitExceeded,
  InvalidNonce,
} from 'ccxt';
import { AdapterError, type AdapterErrorClass } from '../../../ports/venue/exchange';

// §6.3 error classification (adapter-owned). The OMS decides the reducer event from the
// AdapterErrorClass alone — never by re-inspecting a raw ccxt class — so this map is the
// single seam between ccxt's hierarchy and the OMS. ccxt has restructured its error tree
// between versions; the rules below are snapshot-tested against the pinned ccxt so an
// unnoticed remap (e.g. RateLimitExceeded silently demoted from retryable) is caught before
// it converts query-first into blind-retry.

// Two ccxt classes are "special" in §6.3 — DuplicateOrderId (implicit ack ⇒ query path, the
// original is open) and OrderNotFound on cancel (already closed ⇒ query final state). Both
// route through the query loop, which is exactly OUTCOME_AMBIGUOUS at this seam (never a
// blind retry, never a terminal). Their specific ccxt name is preserved in `code` so a call
// site MAY special-case them, but errorClass alone is safe. Crucially they are subclasses of
// InvalidOrder (→ TERMINAL_REJECT), so they MUST be matched before their parent.

type ErrorCtor = new (...args: never[]) => BaseError;

interface ClassifyRule {
  readonly ctor: ErrorCtor;
  readonly errorClass: AdapterErrorClass;
}

// Ordered most-specific → least-specific: the first `instanceof` match wins. Subtypes whose
// classification differs from an ancestor's are listed before that ancestor. Anything not
// matched here falls through to OUTCOME_AMBIGUOUS — the safe default (§6.3).
const RULES: readonly ClassifyRule[] = [
  // AUTH_FATAL — broken credentials mid-run is an incident; subclasses before the parent.
  { ctor: PermissionDenied, errorClass: 'AUTH_FATAL' },
  { ctor: AccountSuspended, errorClass: 'AUTH_FATAL' },
  { ctor: AuthenticationError, errorClass: 'AUTH_FATAL' },

  // InvalidOrder family — the two special subtypes route to the query loop (ambiguous),
  // every other InvalidOrder is a terminal reject. Special subtypes MUST precede InvalidOrder.
  { ctor: DuplicateOrderId, errorClass: 'OUTCOME_AMBIGUOUS' },
  { ctor: OrderNotFound, errorClass: 'OUTCOME_AMBIGUOUS' },
  { ctor: OrderImmediatelyFillable, errorClass: 'TERMINAL_REJECT' },
  { ctor: OrderNotFillable, errorClass: 'TERMINAL_REJECT' },
  { ctor: InvalidOrder, errorClass: 'TERMINAL_REJECT' },

  // Other non-transient ExchangeError leaves — no retry. BadSymbol before BadRequest (parent).
  { ctor: BadSymbol, errorClass: 'TERMINAL_REJECT' },
  { ctor: BadRequest, errorClass: 'TERMINAL_REJECT' },
  { ctor: InsufficientFunds, errorClass: 'TERMINAL_REJECT' },
  { ctor: NotSupported, errorClass: 'TERMINAL_REJECT' },
  { ctor: OperationRejected, errorClass: 'TERMINAL_REJECT' },

  // Maintenance — pause the venue (subclass of ExchangeNotAvailable; must precede it so it is
  // not swept up as a generic ambiguous network error).
  { ctor: OnMaintenance, errorClass: 'MAINTENANCE' },

  // Edge-rejected transient classes — documented not-executed, safe to back off and retry.
  // All are subclasses of NetworkError, whose generic form is ambiguous (see fall-through).
  { ctor: DDoSProtection, errorClass: 'TRANSPORT_RETRYABLE' },
  { ctor: RateLimitExceeded, errorClass: 'TRANSPORT_RETRYABLE' },
  { ctor: InvalidNonce, errorClass: 'TRANSPORT_RETRYABLE' },
];

// The ccxt class name an error resolves to, for the `code` field and audit. Unknown / non-ccxt
// errors report their own constructor name (or 'UNKNOWN').
function errorCode(err: unknown): string {
  if (err instanceof BaseError) return err.constructor.name;
  if (err instanceof Error && err.constructor.name.length > 0) return err.constructor.name;
  return 'UNKNOWN';
}

// Classify any thrown value. Generic NetworkError / RequestTimeout / ExchangeNotAvailable /
// BadResponse / CancelPending / bare ExchangeError / non-ccxt throwables all resolve here to
// OUTCOME_AMBIGUOUS: the write may have landed, so never blind-retry and never assume terminal.
export function classifyCcxtError(err: unknown): { errorClass: AdapterErrorClass; code: string } {
  const code = errorCode(err);
  for (const rule of RULES) {
    if (err instanceof rule.ctor) return { errorClass: rule.errorClass, code };
  }
  return { errorClass: 'OUTCOME_AMBIGUOUS', code };
}

// Wrap a thrown ccxt error as the typed AdapterError the OMS reasons over. An AdapterError is
// passed through unchanged (already classified) so re-wrapping at a higher layer is idempotent.
export function toAdapterError(err: unknown): AdapterError {
  if (err instanceof AdapterError) return err;
  const { errorClass, code } = classifyCcxtError(err);
  const message = err instanceof Error ? err.message : String(err);
  return new AdapterError(errorClass, code, message);
}
