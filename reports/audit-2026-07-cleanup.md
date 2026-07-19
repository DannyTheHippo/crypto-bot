# Adversarial Bug Audit — Round-8 Cleanup (2026-07-18/19)

Plan step W4 (`~/.claude/plans/let-s-make-the-bot-app-synthetic-quail.md`), executed as a
multi-agent workflow: 8 parallel finder dimensions (money/decimal, OMS lifecycle, risk caps,
agentic v2, exchange adapter + ws architecture, DB/evidence integrity, config refusal, and a
dedicated pass over the same-day W3 seam-rewiring diff), each finding then adversarially
verified by two independent refuters (reproduction lens + context lens) before any fix.
Confirmed = zero refutations from both lenses; plausible-but-unconfirmed findings were
recorded, never fixed blind. 20 raw findings across two passes (the first `find:agentic`
run died on a transport error; the resumed run completed the dimension and incidentally
re-verified wave-1 fixes against the fixed tree).

## Confirmed and fixed

| Sev | Area | Defect | Fix |
| --- | --- | --- | --- |
| critical | agentic v2 | `buildProposalFromTradeDecision` never set `AgentDirectives.direction`; absent means `long`, so every perp short's between-consult protection was INVERTED (plan stop seeded on the profit side, `EXIT_LONG` emitted for shorts, venue stop mis-sided) | opens pin `direction` from the action (`open_short` → `short`); adjust inherits from the prior plan; regression spec asserts `plan.direction` on both open actions |
| critical | OMS | reconciliation trade axis dead on the ccxt venue path — venue trades carry the numeric venue order id, not our `cb` coid, so every own fill was skipped as foreign; missed-fill backfill AND the `FILL_FOR_UNKNOWN_ORDER` halt could never fire on testnet/live | two-tier venue-order-id resolution (in-memory `byVenueId` index per the demo-fill-poller precedent → `cb`-prefix fallback → durable-store check); ours-but-lost now HALTs (fail closed), genuinely foreign activity is ignored with a log |
| major | OMS | unknown-resolver `backfillFills` compared venue order ids against our coid — a `SUBMIT_UNKNOWN` order that actually filled could not rebuild `cumQty` and froze to `RECONCILE_REQUIRED` (false freeze) | matches on the pending order's own `venueOrderId` alongside the coid; regression spec drives a venue-shaped fill to `FILLED` with no freeze |
| major | risk | per-symbol fraction headroom counted only the filled position — stacking unfilled same-symbol entries bypassed the cap; gross/net caps ignored resting/in-flight order notional across symbols | reserved-exposure accounting over `inFlightIntents` (reduce-only excluded), deliberately over-reserving on partial fills (fail closed); sign-correct net accounting for shorts |
| major | money | funding accrual re-added the inclusive cursor-boundary row every hourly poll (~8x inflation of the payload funding line; durable path and promotion gate were safe) | `accruedThroughMs` cursor — only strictly-newer rows accrue and count in the ingest metric |
| major | promotion | gate failed OPEN on known-missing funding data: `fundingDataMissing` was evidence-only while `netPnl` silently omitted funding cost — a net-paying lane could earn a false live permit | `FUNDING_DATA_MISSING` is now a blocking reason (permission gate fails CLOSED) |
| major | config | `AGENTIC_REFLECTION_MODEL` ≠ decide model with NO per-model price map priced reflection at flat decide rates — LLM cost under-count inside the earned-live gate | boot refusal (superRefine) when the reflection model lacks a price entry; shipped lanes already price `claude-opus-4-8`, unaffected |
| major | config | `AGENTIC_VENUE_TP`+`AGENTIC_VENUE_STOP` simultaneous-enable refusal failed OPEN on empty `VENUES` — the shipped spot shape | empty/unset `VENUES` now counts as spot (fail closed); perp both-enabled shape still accepted; the defect-pinning test was inverted |
| major | config | `z.coerce.boolean()` on `AGENTIC_CROSS_SYMBOL_ENABLED` — the documented off-value `'false'` silently enabled the feature | strict enum-transform idiom; whole-schema sweep confirmed it was the only occurrence; no shipped value changes effect |
| major | ws | resubscribe recovery serialized through one global 350ms queue — synchronized multi-stream drops (observed live every ~10 min on the 24-symbol universe) caused universe-wide STALE_DATA blackouts scaling linearly with subscription count | 4 token-bucket lanes at 1000ms per-lane pacing (4 msg/s aggregate, 20% under the venue's 5 msg/s 1008 cliff); jitter only on already-positive waits; `ceil(M/4)` recovery rounds proven by fake-timer specs |
| minor | ws | silent-stall watchdog excluded `book`/`trade` channels — a silently dead book subscription never recovered client-side | watchdog now covers every registered channel at the same threshold |
| minor | config | `EXIT_CROSS_BUFFER_BPS` bounded only against the hardcoded default band, not the operator-tunable `RISK_MAX_BAND_BPS` | cross-field superRefine refusal at construction (boundary-inclusive) |
| minor | config | `PROMOTION_EVIDENCE_EPOCH` accepted any `Date.parse`-able string — a date-only value silently meant midnight UTC | strict full ISO-8601 UTC instant with time component + `Z`; shipped epochs unaffected |
| minor | agentic v2 | same-side scale-in re-nulled the plan `entryPrice` — a delayed maker scale-in fill left stop/TP anchored to the pre-scale-in average entry forever | `pendingScaleInQty` baseline; re-anchors to post-fill `avgEntry` when the add fills |
| minor | analytics | `computeBasketBtcBeta` injected gap-spanning outlier returns on sparse stored series | per-bar returns gated on exact timestamp contiguity (median-interval inference) |
| minor | promotion | epoch straddle-bound comment claimed a completeness it did not have | comment corrected to state the flat-instant operational precondition; deeper port change declined as scope expansion (failure direction is under-count — safe side) |
| minor | observability | schema-validation rejection of a model tool payload logged no cause (live perp occurrence 2026-07-18 19:30Z undiagnosable) | warn now carries the zod issue list + truncated payload echo at all four rejection sites |

## Accepted risk (recorded, not fixed)

- All 24 symbols x 4 channels share ONE ccxt ws connection; a single stalled core channel
  forces a connection-wide close and full resubscribe (now recovered in ~24s by the lane
  scheduler, self-healing, observed benign in soak). Full connection sharding is deferred to
  the perp-universe widening step (X2), where subscription count grows again. WATCH: forced
  reconnects + recovery duration on the rebuilt Ops dashboard.

## Plausible, unconfirmed (not fixed — evidence recorded)

- `demo-fill-poller` watermark race on an order acked mid-poll (one verifier refuted, one
  transport-died; re-verification against the fixed tree returned mixed). The two-tier
  reconciliation fix above now provides the independent backstop this scenario lacked.
- `feeAmount()` rejects negative venue fees (maker rebates) — refuted in wave 1 (rebates not
  achievable on the demo fee tier), resurfaced plausible in wave 2. Revisit at the live flip
  alongside the BNB fee-discount note.

## Refuted (examples)

`venue_payment_id` dedupe collapse (String(undefined) case unreachable), candle interval
mislabeling (single-interval deployment), `barsElapsed` advanced by exec triggers (guard
exists), `wsUserStream` capability misadvertised (consumer checks the generator, not the
flag). Full verdicts with per-lens reasoning: workflow journal (session artifacts).

## Validation

Post-fix consolidated gate, run by the orchestrator on the merged tree: `build` /
`typecheck` / `lint` (0 errors) / `format:check` clean; `test` 142 files, 2440/2440;
`test:livegate` 41/41. Every confirmed fix carries a regression test that fails on the
pre-fix code.
