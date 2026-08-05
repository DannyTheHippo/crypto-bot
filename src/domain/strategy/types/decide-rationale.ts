// WATCH-V4-8 (2026-07-29): the rationale tags stamped by the decide branches that REACHED the model
// and came back with nothing usable. Every post-200 degrade in anthropic-agent-client.ts (schema
// rejection, malformed envelope, refusal, truncation, capability violation) returns `signals: []`
// carrying promptHash + latencyMs — the same round-trip evidence an accepted decision carries — so
// "a response body was parsed" is strictly weaker than "a decide was produced". Measured on the live
// journal 2026-07-29: of the 660 rows matching the hash/latency pair alone, 85 (12.9%) were
// schema_rejected holds. That mode already happens at scale — anthropic-agent-client.ts's own H5
// comment records 19 of 57 live rejections coming from two payload-completeness shapes — and a
// tightened bound or schema could push EVERY consult into it, leaving the lane reaching Risk with
// nothing while agent_last_success_timestamp_seconds stayed permanently fresh: the same green board
// over a dead lane the gauge exists to abolish.
//
// This lives in domain because the two halves that must never disagree sit in rings that cannot
// import each other: the runtime stamp (features/trading/composition/trading-runtime.module.ts) and
// the boot seed's SQL predicate (database/repositories/trading/promotion-stats.repository.ts). One
// list, both readers — congruence by construction rather than by comment.
export const DEGRADED_DECIDE_RATIONALE_TAGS = [
  'schema_rejected:',
  'envelope_malformed:',
  'model_refusal:',
  'truncated_max_tokens:',
  'no_tool_use:',
  'capability_violation:',
  // Pass 64 (2026-08-05): an empty/absent tool-input payload under a non-max_tokens stop, split out
  // of schema_rejected: so the two live boot e423875b batches that motivated this pass — different
  // root causes sharing one tag — become separately queryable. Still a "reached the model, came back
  // with nothing usable" degrade, so it MUST stay in this list (isDegradedDecideRationale excludes
  // it from WATCH-V4-8's liveness stamp exactly like the other six).
  'empty_tool_input:',
] as const;

// Absent rationale ⇒ NOT degraded. Every client branch that answers with an unusable body now stamps
// one of the tags above (the batch refusal was the last decision-less one, closed alongside this),
// so the only proposals left carrying round-trip evidence without a decision come from fakes and
// stubs, which never reach the model at all and are excluded by the missing promptHash/latencyMs.
export function isDegradedDecideRationale(rationale: string | undefined): boolean {
  return (
    rationale !== undefined && DEGRADED_DECIDE_RATIONALE_TAGS.some((t) => rationale.startsWith(t))
  );
}

// The tags stamped by the branches that short-circuit BEFORE any model call is made: the client's
// own FATAL latch (anthropic-agent-client.ts's latchRationale), the active-menu gate and the daily
// LLM-budget gate (batching-agent-client.ts, agent-budget.ts). Deliberately a SEPARATE list from
// DEGRADED_DECIDE_RATIONALE_TAGS above rather than an extension of it: those tags mean "reached the
// model, came back with nothing usable" and feed WATCH-V4-8's liveness signal, which a no-call
// short-circuit must never contaminate.
//
// trading-runtime.module.ts's outcomeForProposal reads the same three prefixes, but maps each to a
// DISTINCT metric label ('client_latched' / 'off_menu' / 'budget_blocked'), so it keeps its own
// ordered branch instead of a set-membership test — a shared list would not express that mapping.
export const PRE_CALL_DECIDE_RATIONALE_TAGS = [
  'client_latched:',
  'off_menu:',
  'budget_exhausted:',
] as const;

// True only when the MODEL itself authored this decision. Two exclusions, both non-decisions: the
// 'error' action (the client's own named degrade for a call that never happened — see
// AnthropicAgentClient.latchedDecision) and any rationale carrying a degrade or pre-call tag above.
//
// 'plan_authoritative_close:' (anthropic-agent-client.ts) is a member of NEITHER list on purpose:
// that consult reached the model and came back with a perfectly valid decision the SYSTEM then
// overrode, so it stays model-authored here — the same reasoning that keeps it out of the degrade
// list. Callers that trim what is fed back to the model (agentic.strategy.ts's decision ring) must
// keep those rows.
export function isModelAuthoredDecision(action: string, rationale: string | undefined): boolean {
  if (action === 'error') return false;
  if (isDegradedDecideRationale(rationale)) return false;
  return (
    rationale === undefined || !PRE_CALL_DECIDE_RATIONALE_TAGS.some((t) => rationale.startsWith(t))
  );
}
