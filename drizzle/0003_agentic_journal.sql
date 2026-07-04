-- Agentic-lane persistence: decision journal + versioned playbook store, backing the
-- AGENT_DECISION_JOURNAL and PLAYBOOK_PROVIDER ports (src/ports/agentic-strategy.ts). Both tables
-- are PLAIN insert-only rows — the append-only REVOKE/trigger hardening in
-- 0001_append_only_hardening.sql is scoped to audit_log/order_events only (CLAUDE.md rule 6).
-- Enum-shaped columns (action, source) are TS-level only ($type<>() in trading.schema.ts), no DB
-- CHECK constraint — matches the repo's existing convention for signals.kind / risk_decisions.verdict
-- (see 0000_initial.sql).
-- Hand-authored (not drizzle-kit generate): the 0000-only snapshot in drizzle/meta/ means a fresh
-- generate would emit spurious DDL against 0001/0002's changes (see those migrations' headers).

CREATE TABLE "agent_decisions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agent_decisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"strategy_id" text NOT NULL,
	"symbol" text NOT NULL,
	"venue" text NOT NULL,
	"trigger_kind" text NOT NULL,
	"based_on_seq" bigint NOT NULL,
	"event_time" bigint NOT NULL,
	"model" text NOT NULL,
	"action" text NOT NULL,
	"confidence" double precision,
	"rationale" text NOT NULL,
	"ref_price" numeric(38, 18),
	"close" numeric(38, 18),
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"playbook_version" integer,
	"prompt_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_playbook_versions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agent_playbook_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"source" text NOT NULL,
	"parent_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_decisions_strategy_event_idx" ON "agent_decisions" USING btree ("strategy_id","event_time");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_playbook_versions_version_uidx" ON "agent_playbook_versions" USING btree ("version");--> statement-breakpoint
-- At most one 'promotion' row may land per UTC calendar day (one promotion/day cadence, §G4b).
CREATE UNIQUE INDEX "agent_playbook_versions_promotion_per_day_uidx" ON "agent_playbook_versions" USING btree ((("created_at" at time zone 'utc')::date)) WHERE "source" = 'promotion';
