-- Decision-trail (signals, risk_decisions) intent_id is a SOFT reference, not a foreign key.
-- The §2 Strategy→Risk→Execution ordering makes an FK to order_intents unsatisfiable: RiskEngine
-- journals every verdict — REJECTED intents never reach the gate's saveIntent (no order_intents row
-- ever exists), and APPROVED/RESIZED are journaled before saveIntent commits the FK target. The rows
-- are analysis artifacts; intent_id stays a value for offline joins. Drop the FKs (idempotent).
ALTER TABLE "risk_decisions" DROP CONSTRAINT IF EXISTS "risk_decisions_intent_id_order_intents_intent_id_fk";--> statement-breakpoint
ALTER TABLE "signals" DROP CONSTRAINT IF EXISTS "signals_intent_id_order_intents_intent_id_fk";
