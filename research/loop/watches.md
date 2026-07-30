<!-- Created 2026-07-30 (Pass 48). Full text of every open WATCH line and every open flagged item,
     moved or copied VERBATIM from research/loop/state.md. Nothing was edited. -->

# WATCH lines and flagged items — full text

**Read a line here when `STATUS.md`'s one-line index is not enough** — when you need the exact
expected-positive signature, the named defect outcome, or the deadline. Every WATCH carries all
three by change-discipline (playbook §4).

Provenance, stated because it decides where to look for the rest of a story:

- WATCH paragraphs that sit INSIDE a larger decision record were **copied** here verbatim. The
  record itself is intact in `archive/state-2026-07-30.md`, so no narrative was cut in half; the
  source record is named under each heading.
- The § Flagged entries were **moved**: the open ones and the section's policy header are here, the
  resolved and superseded ones are in `archive/state-2026-07-30.md` § Flagged … resolved.
- The pre-v3 WATCH sets (WATCH-XA1 / X2 / XA6 / XA7-spot / X7-X8 / X9 / Y2-Y3 / Y4) describe the
  BUILD that led here and are historical record, not standing checks against the current build
  (playbook § WATCH lines a pass must check). Their full text stayed with their decision records in
  `archive/state-2026-07-30.md`.

## Open WATCH lines

### WATCH-V3-1 — spot heap slope (2026-07-21; source: § Strategic frame, "v3 BUILD COMPLETE" record)

WATCH-V3-1: spot heap slope on the demo soak (paper plateau 673 MiB is the
  reference; a demo-mode sustained climb past ~900 MiB before the soak ends is a defect signal).

### WATCH-V4-1 — clean-stamp liveness (Pass 40, 2026-07-27; source: the "RECOVERY RE-DISARMED AND RE-ARMED" record)

  **WATCH-V4-1 (clean-stamp liveness).** Expected-positive: the gauge's age stays under ~2 min at
  every pass, `reconciliation_mismatch_total{class="adopt_non_adoptable"}` stays 0, and no order sits
  non-terminal while its `fills` sum equals its `qty`. Named defect outcome: the age exceeds 30 min
  again (the sweep now says so out loud) ⇒ a THIRD starvation cause exists — root-cause it before any
  other work, checking `sum(fills.qty)` against `orders.cum_qty` for non-terminal orders first, since
  that is the shape twice running. Deadline: next pass confirms the first ≥12h window with the stamp
  never stale.

### WATCH-V4-2 — FILL_OVERFLOW is one-shot by construction (Pass 40, 2026-07-27; same record)

  **WATCH-V4-2 (FILL_OVERFLOW is one-shot by construction).** Expected-positive:
  `reconciliation_mismatch_total{class="fill_overflow"}` stays 0. Named defect outcome: any non-zero
  reading is a book HALT that will NOT re-fire and is NOT repaired by restart — capture the
  `FILL_OVERFLOW:{symbol}` reason from `audit_log` immediately (the container log is the only other
  copy, and the sweep truncates its messages to 48 chars). Its likeliest cause — the unqualified
  trade index — was fixed the same pass (`9d69d91`), so a fire now means a genuinely new shape.

### WATCH-V4-3 — redeploy safety (Pass 40, 2026-07-27; source: the "REDEPLOY IS NO LONGER A COIN FLIP" record)

  **WATCH-V4-3 (redeploy safety).** Expected-positive: every future redeploy that happens while a
  perp symbol carries a resting stop boots to `kill_switch_state{state="RUNNING"}` with no
  `perp pin:` line in the boot log. Named defect outcome: another `START_TRADING_FAILED` at boot ⇒
  the pin has a THIRD unverifiable shape — probe the venue for that symbol before editing the guard,
  and do not widen the tolerance without positive proof of `isolated`, which is the whole point of
  the gate. Standing operational note surfaced by this incident: a `flatten=true` halt CANCELS
  resting protective orders first, so a wedged FLATTENING state leaves open positions with no
  venue-side protection — an unsafe resting state, not a safe one.

### WATCH-V4-4 — attribution correctness (Pass 40, 2026-07-27; source: the "TRADE-ATTRIBUTION FAMILY CLOSED" record)

  **WATCH-V4-4 (attribution correctness).** Expected-positive: `fills` rows always carry the
  clientOrderId of an order on the SAME venue as the fill, no `FILL_FOR_UNKNOWN_ORDER` halt fires on
  an order younger than the pass that halted it, and `sum(fills.qty)` per order equals
  `orders.cum_qty` for every terminal order. Named defect outcome: any of those three breaking means
  the index or the fold has a shape none of the four fixes covers — do not patch the symptom;
  re-derive which tier resolved the trade first.

### WATCH-V4-6 — an order reaching `NEW` via `QUERY_NOT_FOUND` can never become terminal (Pass 44, 2026-07-28)

This one is simultaneously an open WATCH and an open flagged defect; the full § Flagged entry is
here rather than duplicated below.

- **OPEN DEFECT — WATCH-V4-6: AN ORDER THAT REACHES `NEW` VIA `QUERY_NOT_FOUND` CAN NEVER BECOME
  TERMINAL (Pass 44, 2026-07-28).** Four orders have sat non-terminal since 2026-07-24, each with the
  identical event chain and nothing after it: `SUBMIT_SENT → SUBMIT_AMBIGUOUS → QUERY_NOT_FOUND`
  (`ZEC/USDT:USDT`, `SOL/USDT:USDT`, `KAITO/USDT:USDT`, `NEAR/USDT:USDT`).
  Root cause, read from code not inferred: `SUBMIT_UNKNOWN + QUERY_NOT_FOUND → NEW` is deliberate
  ("resubmit-eligible, same clientOrderId (TTL live)", `reducer.ts:194-195`) and its TTL-lapsed
  sibling `QUERY_NOT_FOUND_EXPIRED → CANCELED` exists — but the TTL is evaluated **only at query
  time** (`unknown-resolver.service.ts:310-315`), ~7s after submit, when it is obviously still live.
  The resolver then drops the order from `pending` with the comment _"NEW is resubmit-eligible;
  resubmit orchestration is a follow-up"_. That follow-up was never built, so nothing re-queries the
  order, nothing expires it, and nothing resubmits it.
  **Live impact today is nil, and that is measured:** `open_orders{venue}`=0 both venues,
  `in_flight_intents`=0, `venue_capital_headroom_usdt{binanceusdm}`=500 (full, so no phantom reserve),
  `reconciliation_mismatch_total` has no series across the whole 4 days these rows have existed, and
  the clean stamp is fresh. The portfolio view correctly excludes never-ACKed orders.
  **Why Pass 44 did not fix it:** the repair is the missing capability the code itself names — TTL
  re-examination plus a venue re-query before terminalizing (never blind; hard rule 5). That is new
  OMS money-path orchestration, not a line change. `NEW + CANCEL_REQUESTED → CANCELED` ("never sent,
  local-only", `reducer.ts:153`) is already the right terminal transition, so no reducer change is
  needed — the missing piece is the sweep that decides when to emit it.
  **Expected-positive:** the count of orders in a non-terminal state with no in-flight intent stays at
  these 4 and does not grow. **Named defect outcome:** it grows ⇒ the ambiguous-submit path is
  producing zombies at a rate that will eventually meet a book-wide non-terminal scan, which is
  exactly the shape that starved the clean stamp twice in Pass 40 (`adopt_non_adoptable`). Check
  `sum(fills.qty)` vs `orders.cum_qty` for non-terminal orders first, as WATCH-V4-1 already says.

### WATCH-V4-7 — the sweep can see across passes (Pass 45, 2026-07-29; source: the "AN OUTAGE THAT WAS OVER BEFORE ANYONE LOOKED" record)

  **WATCH-V4-7 (the sweep can see across passes).** Expected-positive: every pass's digest carries an
  `alerts fired+resolved in the last 12h` line and a warn-scan span at/above the alert lookback, and any
  Prometheus rule that fires between passes appears in exactly one of the two alert lists. Named defect
  outcome: an incident is later found in the container log or the DB that appeared in NEITHER list ⇒ the
  ALERTS series is not the complete record this assumes — check `alert_window_partial` for that pass
  first, since a scrape hole explains it without any code being wrong. **Open sub-item RESOLVED BY
  DELETION 2026-07-29** — there is no collector daemon left to hold stale code (see the record below).

## Flagged for human review (open)

> **This section is for defects that CANNOT be fixed without crossing the §4 MUST-NOT rails — owner
> capability limits only. It is not a defect queue.** Owner ruling 2026-07-27, verbatim: "do not
> defer defects … those must get fixed immediately if possible"; the daily loop is a profitability
> engine, not a bug tracker. Pass 40 initially parked four defects here citing the
> one-money-path-item-per-pass limit, was corrected, and fixed all four in the same pass. That limit
> governs chosen IMPROVEMENTS only and never licenses a deferral — now stated outright in playbook §4
> (§ DEFECTS ARE NEVER DEFERRED).

- **BOTH PROVIDER ACCOUNTS ARE UNFUNDED — the single blocker on the entire program (Passes 42/43,
  2026-07-28).** Anthropic returns `400 invalid_request_error: "Your credit balance is too low"`
  (exhausted mid-run at 21:16Z on 07-27); Moonshot returns `429 suspended — insufficient balance`.
  Consequences: the champion cannot trade at all (the lane latches, correctly, and journals named
  `client_latched` degrades), AND the frozen playbook-space replay — the one study that could answer
  whether ANY playbook text clears the +13.0 bps bar — cannot run. Purchasing credit is a financial
  action, outside what an automated pass may do; this is a capability limit, not a policy gate.
  **On resumption nothing needs redeploying or re-deciding:** the lane self-heals within 30 min of
  credit landing (`FATAL_LATCH_COOLDOWN_MS`, and that is a tested property — see WATCH-V4-5), and the
  study's corpus, 12 arms, metric and bar are all committed and frozen.
  **Read alongside Pass 41's diagnosis before funding, because they interact:** entries are
  significantly negative and worse than a random-bar placebo, so resuming spends ~$2.6/day
  accumulating evidence for a gate the current entry signal provably cannot pass. Whether that is
  worth doing is a decision about what this project is FOR — surfaced by Pass 41, restated by 42, and
  now unavoidable rather than deferrable. The loop does not decide it and has not assumed either answer.

- **OPEN DEFECT — WATCH-V4-6 (`QUERY_NOT_FOUND` terminalization, Pass 44, 2026-07-28):** full text
  above under § Open WATCH lines, kept there so the WATCH and the defect cannot drift apart.

- **TWO SCHEDULED PASSES RAN CONCURRENTLY IN ONE WORKING TREE (2026-07-28, Pass 42 + Pass 43;
  RECURRED live during Pass 44).** Pass 44 observed it from inside: commits `8a15ad0` (08:18:21Z) and
  `b5eee27` (08:23:03Z) landed on `main` from another session mid-pass. No damage — neither touched
  Pass 44's files, and both changed `test/eval`, which the production gate glob excludes — but it is
  now three recorded occurrences. **Loop-side mitigation SHIPPED (`6369c0b`): `pnpm loop:lock` /
  `pnpm loop:unlock <nonce>`, playbook §1 step 3 and §6 step 4.** Honest limits, because the guard
  must not be trusted past its evidence: it is a 120-min time lease (not a liveness check — a pass is
  a session, not a watchable process), and **it only binds passes that CALL it**, which is exactly why
  it did not prevent the Pass 44 collision. A refusal is evidence of overlap; a clean acquire is not
  proof of its absence. **The scheduler config that lets two passes co-fire remains owner-owned and
  open.**
  Original occurrence (Pass 42/43): both sessions edited the same files; one committed the other's
  in-flight work twice (`ee4ddf3`, `7fa5ba8`) and caught the test count moving 3009 → 3011
  mid-verification because writes were still landing. No work was lost, but nothing structural
  prevented it — a concurrent pass can land a half-finished tree inside another's gate run, and the
  resulting failure would be attributed to the wrong cause.
  Standing procedure for any pass that sees this: assess damage before trusting a gate result — which
  files the foreign commits touched, whether they intersect this pass's own, and whether they fall
  inside the production gate glob. Pass 44 did exactly that and could then stand behind its 3054-test
  run; a pass that skips it cannot.

- **SHARED-ORG RATE-LIMIT — RECURRING; owner action requested (Pass 35, 2026-07-20; first
  recorded X9 same day).** The trading app and interactive/orchestration sessions share ONE
  Anthropic org budget; heavy fleet windows 429 the app's consults. Recurrences beyond the
  recorded 11:00Z incident: perp 12:30:27Z ×4 + 14:15:39Z ×1, spot 15:15:30Z ×8 — every burst
  inside an owner-session orchestration window (RETRYABLE error decisions in agent_decisions;
  app self-heals next bar). Harmless at 0 entries; once trading resumes each burst is a missed
  decision on live bars. Structural fix is owner-side: **a dedicated Anthropic key/org for the
  trading app** (secrets = §4 MUST-NOT for the loop). Interim: scheduled passes run fleet-free
  during trading hours (Pass 35 did); heavy orchestration ideally avoids active-menu bar
  boundaries. Also still open at the owner: the CryptoPanic key (X4 sentiment enable).

- **AVAILABILITY (Pass 17, 2026-07-12; updated Pass 23; REGRESSED Pass 25):** the stack runs on the
  owner's MacBook; host sleep throttles everything (worst measured: 8%/24h duty cycle; the SOL trail
  fired 10h late → gap loss). Pass 23 read **100%/24h for two consecutive days**, but **Pass 25
  observed a fresh ~6h host-sleep gap mid-pass (~01:00–07:20Z 07-15)** — the app cycled several short
  boots and the loop pass itself stalled ~6h between commit and deploy. The 100%/24h improvement did
  NOT hold. Standing ask unchanged and now re-evidenced: keep the Mac awake on AC + auto-login (or
  move the stack to an always-on host; compose is portable, §5 backups cover the DB). Residual
  dependency: Docker Desktop "start at sign-in" (restart policy `e4542fb` only acts once the daemon
  is up).

- **6.9-LINK wallet scar (~$55):** historical unapplied recovered-order fill (pre-`b00c886`),
  journaled+deduped so no walk sees it post-epoch; venue-side manual sell is optional wallet
  hygiene only.

## Resolved WATCH lines — closed, kept, not deleted

### WATCH-V4-5 — the latch is observable and self-healing (RESOLVED Pass 45, 2026-07-29)

  **WATCH-V4-5 (the latch is observable and self-healing).** Expected-positive, in three parts:
  `agent_client_latched` reads 0 whenever the lane is making calls and 1 within one scrape of a
  suppressed call, with `AgentClientFatalLatch` following it in both directions; ZERO
  `action='hold'`-with-empty-rationale rows ever appear again; and once a provider is funded the lane
  resumes within 30 min with NO redeploy. Named defect outcome: a latch that outlives its cooldown
  without a fresh `error_fatal` means the expiry path is not being reached — read `latchRationale`'s warn
  line (`latch expired … resuming calls`) before touching the state machine; and an
  `AgentClientFatalLatch` that will not clear after recovery means the gauge is being set from a stale
  outcome, which is a `recordDecide` bug, not an alert-tuning problem. **Status at hand-off: the
  NEGATIVE direction is live-verified (gauge 0, alert inactive, `health=ok`, 20/20 rules loaded on boot
  `464c608b`); the POSITIVE direction is UNPROVEN on this build** — the accounts are unfunded but bar
  counters reset on the 07:30Z redeploy, so the first consult attempt was up to 2h out. Deadline: the
  next pass confirms it from a sweep, and must not infer it from the unit tests.
  **RESOLVED — POSITIVE DIRECTION PROVEN (Pass 45, 2026-07-29).** No new mechanism was needed: boot
  `899d4a09` ran unbroken for 22h with no redeploy to reset the bar counters, so the fallback clock
  finally elapsed and the unfunded account drove the fatal path repeatedly. All three clauses confirmed
  from LIVE state, explicitly not from the unit tests: (1) `agent_client_latched`=1 while calls are
  suppressed, `AgentClientFatalLatch` inactive on the 07:30Z boot and firing since 10:45:25Z — both
  directions observed; (2) **ZERO `action='hold'`-with-empty-rationale rows since the fix deployed** —
  135 such rows exist but the newest is 2026-07-28T01:15:18Z, ~6h before `ee4ddf3` booted, and the same
  condition now produces 197 named `client_latched:` degrades at `action='error'` instead; (3) the latch
  expires and resumes with NO redeploy — 8 expiries on one boot at `RestartCount` 0. Only the
  funded-resumption clause ("resumes within 30 min of credit landing") stays untested, and it cannot be
  tested without credit; the load-bearing half — self-heal rather than wedge-until-recreate — is done.
  The starvation analysis Pass 44 wrote remains correct and still applies to any pass that deploys: a
  redeploy pushes the first fallback consult 2h out. It was simply not binding on a boot left alone.

### WATCH-V4-8 — a redeploy must not be able to erase a standing outage (RESOLVED Pass 47, 2026-07-29)

**WATCH-V4-8 (a redeploy must not be able to erase a standing outage).** Expected-positive: after any
redeploy, the pass can still tell within its 15-30 min soak whether the lane is actually calling the
model — not merely that `agent_client_latched` reads 0 on a boot too young to have tried. Named defect
outcome: a pass reports a clean lane inside the ~2h post-deploy window and the next pass finds the
latch alert firing again with no intervening change ⇒ the soak signed off on a dead lane, and the
signal needs to survive process restarts. **The fix shape is already proven twice in this repo:** seed
the gauge from the durable ledger at boot, exactly as `f2d74b6` did for the cost breaker (which handed
every redeploy a fresh full $3 until it read the token ledgers) and as
`reconciliation_last_success_timestamp_seconds` does for reconcile liveness. Concretely, an
`agent_last_success_timestamp_seconds` seeded at boot from `agent_decisions` would have read ~34h stale
throughout this pass, on every boot, with no dependence on whether the lane had tried yet. **NOT shipped
this pass** and the reason is specific, not a priority call: its fix touches
`src/features/common/observability/metrics.service.ts` and `observability/alerts.rules.yml`, both
rewritten ~50 min earlier by a concurrent unleased session (`af67acf`) whose own deploy soak was still
running — a rules-file edit additionally requires a Prometheus `--force-recreate`. Deadline: next pass
with an uncontended tree.
**RESOLVED — Pass 47, 2026-07-29, commit `446e1da`.** The tree was uncontended and the fix shipped as
specified: `agent_last_success_timestamp_seconds` is seeded at boot from `agent_decisions`, so it reads
the TRUE age on the first scrape of every boot. Confirmed from LIVE state, not from unit tests — on the
minutes-old boot `1d68a57c` the gauge read `2026-07-27T20:15:31.331Z`, **38.80h stale, in the same
scrape where `agent_client_latched` read 0**, and `AgenticNoSuccessfulDecideSustained` fired at
11:04:25Z on an 8-minute-old boot. Three design points worth keeping, each of which review changed:
(a) the success predicate is **structural** — `prompt_hash <> '' AND latency_ms IS NOT NULL AND
strategy_id NOT LIKE 'replay-%'`, two columns written together and only by code that already parsed a
response body — so scheduled skips, latched suppressions and thrown errors are excluded by the shape of
the write path rather than by a list of rationale strings someone has to remember; review narrowed it
further to exclude post-200 degrades, which is why the lifetime count reads 575 and not 660.
(b) **severity `warning`, deliberately**: `loop:sweep` promotes only `critical` to the blocking alarm and
§3 blocks improvement work until alarms clear, so a critical would wedge every future pass on a
condition no pass can fix — it lands as `prometheus_alert_firing_nonblocking` and sweep alarms stayed 0.
(c) **`for: 5m`, not the soak length** — the sweep reads only rules already in state `firing`, so a `for:`
equal to the playbook's 15-min MINIMUM soak would still be `pending` when the soak-ending sweep runs,
invisible on the very pass that shipped it. A firing after a long host sleep is the expected recurring
case, not an edge; suppressing it by gating on `process_start_time` would reintroduce exactly the
boot-scoped blindness this rule removes.

### WATCH-V3-2 — market-stream loop errors after the v3 soak defects (expected-positive CONFIRMED 2026-07-21)

**WATCH-V3-2:** expected-positive = loop-error rate ~0 and
  `market_stream_forced_reconnects_total` flat over ≥1h with journal every bar on both venues;
  defect outcome = waves persist past the first hour ⇒ the candle threshold was not the (only)
  initiator — reopen with a raw demo-ws probe before touching anything else. Owner-session soak
  wakeups own the check; resolution before the lift-readiness call.

Amended the same day after soak defect #2:

**WATCH-V3-2 (amended):** expected-positive = loop-error rate ~0 on BOTH venues over
  the next hour+, forced-reconnect counters flat, journal every bar; the original defect-outcome
  clause stands for any residual waves.

### WATCH-V3-3 — schema-degrade rate (defect outcome FIRED, then RESOLVED 2026-07-22)

  **WATCH-V3-3 (schema-degrade rate) — DEFECT OUTCOME FIRED + RESOLVED 2026-07-22.** The trigger
  was "≥2 more whole-payload events or a sustained >5% element rate ⇒ a root-cause pass on the
  tool-contract prompt/schema (and meter the degrade path)." Both conditions hit: the offline
  head-to-head measured a sustained ~31–38% propose-attempt schema-failure rate (both models),
  and the live sweep found 5 whole-payload + 41 element + 11 missing-symbol degrades since
  cutover. Root cause (both the root-cause pass AND the metering, as the trigger prescribed):
  the JSON tool schema advertised only `action` as required while zod's `requireTradeDirectives`
  demanded six open_* fields, four never stated required in model-facing text; thesis >300 chars
  rejected; `decisions` string-encoding accepted-then-dropped. FIX SHIPPED (gate green, 2712
  tests): prompt/tool hardening + the degrade path is now METERED
  (`agentic_schema_rejections_total{kind}` counter + `schema_rejected:` journal rationale — the
  "no metric/rationale marker" gap this WATCH named is closed). Historical prior: this was the
  same defect class as WATCH-X2-era degrade guidance. Deploy of the fix + a hardened-contract
  re-baseline is the remaining loop step (I commit + deploy — loop-domain per the 2026-07-22
  gate-override grant; the live-money flip is the only human gate).
