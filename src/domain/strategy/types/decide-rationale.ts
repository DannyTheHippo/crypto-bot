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
