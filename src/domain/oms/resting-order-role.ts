// Push 3 P7c: resting-order role classification off a signal's own dedupeKey lineage — a pure,
// I/O-free read of the SAME string the emitting strategy already stamps when it places the order
// (see AgenticStrategy.manageVenueTp's 'venue_tp_place'/'venue_tp_cancel' dedupeKeys; the future
// venue-stop lifecycle (P7d) mirrors it with 'venue_stop_*'). Every dedupeKey this codebase has ever
// emitted for a venue-TP order already carries the 'venue_tp_' marker, so legacy compatibility is
// free — there is no separate unprefixed-fallback path, the classifier is unconditionally
// applicable to every resting order this strategy has ever placed.
export type RestingOrderRole = 'vtp' | 'vsl' | 'unknown';

const VENUE_TP_MARKER = 'venue_tp_';
const VENUE_STOP_MARKER = 'venue_stop_'; // P7d: not yet emitted by any strategy path

export function roleForDedupeKey(dedupeKey: string): RestingOrderRole {
  if (dedupeKey.includes(VENUE_TP_MARKER)) return 'vtp';
  if (dedupeKey.includes(VENUE_STOP_MARKER)) return 'vsl';
  return 'unknown';
}
