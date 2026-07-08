-- W4+W13 (2026-07-08 approved plan): true-spend LLM cost accounting. Anthropic's response envelope
-- carries cache_read_input_tokens/cache_creation_input_tokens (W2.4's cache-token series,
-- ports/agentic-strategy.ts AgentUsage) alongside input/output tokens, but neither agent_decisions
-- (decide path) nor llm_usage (reflection path) persisted them — undercounting true spend ~1.5x
-- (cache reads price at ~0.1x input, 1h-TTL writes at ~2x input, both were $0 in the promotion
-- gate's cost math). Nullable: pre-W4 rows and error/quiet-hold rows that never called the client
-- carry no cache usage. PLAIN additive columns on insert-only analytics tables — the append-only
-- REVOKE/trigger hardening in 0001_append_only_hardening.sql is scoped to audit_log/order_events
-- only (CLAUDE.md rule 6) and is untouched here. Hand-authored (not drizzle-kit generate) for the
-- same 0000-only-snapshot reason as 0003/0004/0005.

ALTER TABLE "agent_decisions" ADD COLUMN "cache_read_input_tokens" integer;
ALTER TABLE "agent_decisions" ADD COLUMN "cache_creation_input_tokens" integer;
ALTER TABLE "llm_usage" ADD COLUMN "cache_read_input_tokens" integer;
ALTER TABLE "llm_usage" ADD COLUMN "cache_creation_input_tokens" integer;
