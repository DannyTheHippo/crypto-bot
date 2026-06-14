// §6.3 query-loop backoff schedule for the `*_UNKNOWN` states: fetchOrder at 250ms / 500ms /
// 1s / 2s / 4s ±20% jitter. Pure: the jitter sample is an input (a deterministic [0,1) draw the
// caller takes from its seeded PRNG), so the whole schedule replays byte-identically in tests.
// After MAX_QUERY_ATTEMPTS inconclusive attempts the order freezes to RECONCILE_REQUIRED; any
// unknown unresolved longer than UNKNOWN_KILL_AFTER_MS escalates to the global kill switch.

export const QUERY_BACKOFF_MS: readonly number[] = [250, 500, 1000, 2000, 4000];
export const MAX_QUERY_ATTEMPTS = QUERY_BACKOFF_MS.length; // 5
export const UNKNOWN_KILL_AFTER_MS = 60_000;

// attempt is 1-based: the delay BEFORE the Nth fetch. jitter01 ∈ [0,1) maps to a ±20% factor
// (0.5 ⇒ exactly the base delay). Out-of-range attempts clamp to the last bucket so the cadence
// never runs faster than the schedule even if a caller miscounts.
export function queryBackoffMs(attempt: number, jitter01: number): number {
  const idx = Math.min(Math.max(Math.trunc(attempt), 1), QUERY_BACKOFF_MS.length) - 1;
  const base = QUERY_BACKOFF_MS[idx]!;
  const factor = 0.8 + jitter01 * 0.4; // [0.8, 1.2)
  return Math.round(base * factor);
}
