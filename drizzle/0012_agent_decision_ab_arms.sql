-- Push 3 P8a-prep: explicit A/B arm journaling. anthropic-agent-client.ts's prepareDecideContext
-- resolves the info-context and thinking arms via abArm (ab-assignment.ts) but, until now, the only
-- way to recover which arm a journaled decide row landed in was to reverse-engineer prompt_hash
-- (test/backtest/ab-cells/run.mjs's payload/hash-forward-computation heuristics) — brittle, and
-- blind to the batched-consult (submit_portfolio) rows the heuristics don't model. These two columns
-- store the arm truth directly, stamped by the client at journal-write time.
-- info_arm / thinking_arm store the TREATMENT truth per axis (true = treatment), NOT the internal
-- infoContextControlArm/thinkingArm booleans' own polarity: infoContextControlArm is CONTROL-truth
-- (true = bundle withheld), so info_arm is its negation; thinkingArm already carries treatment truth
-- (true = adaptive) and passes through unchanged — see anthropic-agent-client.ts's write sites.
-- Nullable: NULL means pre-migration row (unknown arm, same as an absent prompt_hash tag) — the cell
-- script falls back to its existing payload/hash inference for these. Plain additive column on the
-- same insert-only analytics table as 0005/0010/0011 (append-only REVOKE/trigger hardening in
-- 0001_append_only_hardening.sql is scoped to audit_log/order_events only, CLAUDE.md rule 6).
-- Hand-authored (not drizzle-kit generate) for the same 0000-only-snapshot reason as 0003/0004/0005/
-- 0010/0011.

ALTER TABLE "agent_decisions" ADD COLUMN IF NOT EXISTS "info_arm" boolean;
ALTER TABLE "agent_decisions" ADD COLUMN IF NOT EXISTS "thinking_arm" boolean;
