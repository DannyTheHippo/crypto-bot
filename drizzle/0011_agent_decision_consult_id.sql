-- Push II Phase 5 follow-on: BatchingAgentClient (batching-agent-client.ts, flag
-- AGENTIC_PORTFOLIO_CONSULT) coalesces up to 5 per-symbol propose() calls into ONE
-- AnthropicAgentClient.proposeBatch call, and each symbol journals its own agent_decisions row
-- (recordJournalEntry) — nothing today lets cost/attribution analytics join the N rows born from
-- ONE batched call back together. consult_id is that join key: proposeBatch mints ONE id per
-- batch and stamps it on every resulting proposal (including degraded-to-hold elements — the row
-- still belongs to the batch); the single-symbol propose() path never sets it, so non-batched rows
-- stay byte-identical (NULL). Nullable, no index (analytics reads are offline, same posture as
-- input_payload/plan_json). Plain additive column on the same insert-only analytics table as
-- 0005_agent_decision_input_payload.sql / 0010_agent_decision_plan.sql — the append-only
-- REVOKE/trigger hardening in 0001_append_only_hardening.sql is scoped to audit_log/order_events
-- only (CLAUDE.md rule 6) and is untouched here. Hand-authored (not drizzle-kit generate) for the
-- same 0000-only-snapshot reason as 0003/0004/0005/0010.

ALTER TABLE "agent_decisions" ADD COLUMN IF NOT EXISTS "consult_id" text;
