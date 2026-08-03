-- fills: re-key the §6.6 idempotency index as (mode, venue, symbol, venue_trade_id).
--
-- venue_trade_id is unique only within the venue that MINTED it, and the paper adapter mints its
-- own ids ('paper-trade-N') off a counter that restarts at 1 on every reboot — while paper, testnet
-- and live all share ONE database. A DB-backed paper restart therefore re-presents trade ids a
-- previous run already stored: the same (venue, symbol, venue_trade_id) carrying a DIFFERENT
-- price/qty, which DrizzleExecutionStore.saveFill classifies as a payload conflict and
-- fill-ingestor.service.ts escalates to a FILL_PAYLOAD_CONFLICT kill switch — or, on a coincidentally
-- identical payload, drops a real fill silently. Adding mode to the key segregates the three
-- deployment environments exactly as positions' own (mode, strategy_id, venue, symbol) PK does.
--
-- fills is NOT append-only-hardened (0001 covers audit_log / order_events / funding_events /
-- funding_payments / experiments only), so this is a plain index swap — no trigger or REVOKE is
-- touched, and no row is read, written or moved. Cost: one index rebuild on a table whose only
-- writer is an ON CONFLICT DO NOTHING insert.
--
-- Deliberately NOT generated verbatim by drizzle-kit: `drizzle-kit generate` also emitted a
-- DROP/CREATE of agent_playbook_versions_promotion_per_day_uidx, whose stored expression differs
-- from 0000_v3_initial.sql's only in how the newer kit renders the parentheses
-- (`(("created_at" at time zone 'utc')::date)` vs the same string with one more wrap — 0000 already
-- emitted the double-wrapped form). Recreating it would drop the one-promotion-per-UTC-day
-- uniqueness guard for the duration of a rebuild to change nothing. The 0002 snapshot keeps the
-- newer rendering so the churn does not resurface on the next generate.

DROP INDEX "fills_venue_symbol_trade_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "fills_mode_venue_symbol_trade_uidx" ON "fills" USING btree ("mode","venue","symbol","venue_trade_id");
