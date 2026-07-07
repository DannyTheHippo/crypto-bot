-- W1.3 (2026-07-07 approved plan): persist the rendered market-context JSON each decide sent to
-- the model — candles/ticker/book/indicators/position/recentDecisions, structurally WITHOUT the
-- playbook block or system prompt (agent-prompt.ts buildMarketPayload takes no playbook input) —
-- so prompt variants can be replayed/scored offline against real decision inputs. Nullable: error
-- and prescreen quiet-hold rows carry no payload. Plain additive column on an insert-only analytics
-- table — the append-only REVOKE/trigger hardening in 0001_append_only_hardening.sql is scoped to
-- audit_log/order_events only (CLAUDE.md rule 6) and is untouched here. Hand-authored (not
-- drizzle-kit generate) for the same 0000-only-snapshot reason as 0003/0004.

ALTER TABLE "agent_decisions" ADD COLUMN "input_payload" text;
