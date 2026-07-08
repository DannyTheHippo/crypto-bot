-- W7: one-time backfill for terminal_at (never stamped pre-fix — DrizzleExecutionStore.appendOrderEvent
-- only passed venueOrderId, never terminalAt, into OrderRepository.updateState's extras), which left
-- findOpenByMode's isNull(terminal_at) matching every row ever written and BootRecovery re-seeding every
-- terminal order as open on each boot; orders is a plain mutable table (no append-only trigger — Hard
-- Rule 6 covers only audit_log/order_events), so this UPDATE is safe. terminal_at is bigint epoch-ms
-- (mirrors DrizzleExecutionStore's Date.now() stamping), so updated_at (timestamptz) is cast via
-- EXTRACT(EPOCH ...); it is an approximation of terminal time for these pre-fix rows (the exact
-- terminal timestamp was never persisted).
UPDATE orders SET terminal_at = (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint
WHERE state IN ('FILLED','CANCELED','REJECTED','EXPIRED') AND terminal_at IS NULL;
