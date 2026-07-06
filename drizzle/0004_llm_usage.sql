-- LLM token-usage persistence for the reflection path (P2a), backing the LlmUsageSink port
-- (ports/agentic-strategy.ts). agent_decisions.input_tokens/output_tokens already persists the
-- decide-path's own per-call tokens; this table's CURRENT writers are the reflection loop only, so a
-- later net-of-cost PnL computation can UNION decide-path tokens from agent_decisions with
-- reflection-path tokens from here without double counting. PLAIN insert-only row — the append-only
-- REVOKE/trigger hardening in 0001_append_only_hardening.sql is scoped to audit_log/order_events only
-- (CLAUDE.md rule 6). kind is TS-level only ($type<>() in trading.schema.ts), no DB CHECK — matches
-- the repo's existing convention for signals.kind / risk_decisions.verdict / agent_decisions.action.
-- Hand-authored (not drizzle-kit generate): the 0000-only snapshot in drizzle/meta/ means a fresh
-- generate would emit spurious DDL against 0001/0002/0003's changes (see those migrations' headers).

CREATE TABLE "llm_usage" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "llm_usage_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"mode" text NOT NULL,
	"strategy_id" text,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
