-- W1.3 follow-on: persist the accepted plan-mode trade plan (AgentProposal.plan — entryOffsetBps/
-- stopLossPct/takeProfitPct/entryValidityBars/maxHoldBars, verbatim, no money-path conversion) on
-- the decision row that carried it, so the real settlement backtest harness can replay a plan
-- decision instead of only ever seeing it in-memory (agentic.strategy.ts's activePlan, lost on
-- restart). jsonb (not text, unlike input_payload) because there is no playbook-leak concern here
-- — a plan is 5 scalar fields, not model-composed prose — and jsonb lets a later replay query
-- index/project into it directly. Nullable: every 'flat'/'hold'-without-plan/error row, and every
-- pre-this-migration row, carries no plan. Plain additive column on the same insert-only analytics
-- table as 0005_agent_decision_input_payload.sql — the append-only REVOKE/trigger hardening in
-- 0001_append_only_hardening.sql is scoped to audit_log/order_events only (CLAUDE.md rule 6) and is
-- untouched here. Hand-authored (not drizzle-kit generate) for the same 0000-only-snapshot reason as
-- 0003/0004/0005.

ALTER TABLE "agent_decisions" ADD COLUMN "plan_json" jsonb;
