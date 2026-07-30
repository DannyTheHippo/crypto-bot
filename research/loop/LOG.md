<!-- Moved 2026-07-24: reports/loop → research/loop (repo organization). Historical path refs inside remain as narrative. -->

# Daily profitability loop — pass log

Append-only, newest last. One dated entry per pass (including empty passes), per
`docs/planning/daily-profitability-loop.md` §6: data window, headline metrics, decision +
rationale, diff summary, gate results, soak verdict, flagged items, next candidates.

Rotation rule (2026-07-30, Pass 48): this file keeps only the **last five pass entries**. When a
sixth lands, the oldest rotates VERBATIM to `research/loop/archive/LOG-through-pass-47.md`, appended
at the end in chronological order — nothing is ever deleted. This replaces the former 30-day rule,
under which the file reached 5,886 lines and every pass paid to rehydrate from it. Entries older
than the five below are in that archive; older still is git history. Current state is
`research/loop/STATUS.md`, never this file.

---

## 2026-07-28 — Pass 43 (the concurrent pass that diagnosed the latch, reviewed its own fix, and shipped the hardening)

**Window:** 00:07Z → 07:50Z. `date -u` anchored first. **This is the pass whose work the entries above
credit as "a concurrent pass" — `ee4ddf3` and `7fa5ba8` are its commits, committed by the other session
after this one stalled mid-flight.** Two sessions ran the loop against ONE working tree tonight. That is
recorded here as a hazard, not a footnote: the tree was edited concurrently, and only the other
session's discipline (three consecutive full-gate runs, and noticing the test count move 3009 → 3011
mid-verification because this session's writes were still landing) kept it coherent. Nothing was lost,
but nothing guaranteed that.

### What this pass contributed that is not already recorded above

**The incident diagnosis, from the alert nobody was reading.** Sweep at pass start: `Alarms (0)`.
`AgentClientFatalLatch` had been firing critical since 21:16:25Z — 2h51m. Four independent counters
agreed the lane had made zero LLM calls: `agent_tokens_total` frozen at 203,835 since 20:20Z,
`agentic_promotion_llm_cost_usd` frozen at $16.197899, `agentic_budget_remaining_usd` frozen at
$0.9696084 straight through the UTC rollover, and 30 journal rows with an EMPTY rationale between
21:30:15Z and 00:00:43Z. The cause was one row: `FATAL (status 400) … "Your credit balance is too low
to access the Anthropic API"`.

**The near-miss worth naming.** Pass 42 hit this same credit wall two hours earlier — its study
pre-flight aborted on the identical error — and recorded the study as blocked without connecting it to
the production lane, writing "0 sweep alarms" in the same entry. One cause, two consequences, one seen.

### The adversarial review — 20 findings, 7 survived, and it broke my own fix twice

Four lenses over the working diff, every finding then attacked by an independent skeptic defaulting to
rejection. **CORRECTION to what this entry first said:** I reported "16 findings, 5 survived, the
safety-rails lens never returned" from a partial journal read while the run was still going. The final
tally is **4 lenses, 20 findings, 7 survived** — the safety-rails lens did return, and it was the lens
that caught the worst remaining defect (below). The earlier number is left visible here rather than
quietly overwritten, because "a lens did not report" was exactly the kind of claim that should not have
been made before the run finished.

Survivors, all fixed before commit:

- **The alert I wrote could not fire on the first latch of a container's life.**
  `increase(agent_decide_total{outcome="client_latched"}[2h])` reads 0 through it, because prom-client
  creates a label child lazily and a batched consult births the whole series in one tick — every sample
  in the range is then equal. That is the same first-sample-after-reset trap `alerts.rules.yml` already
  documents 35 lines below, and worst-case detection would have been ~4h: **worse than the 3h outage
  the fix was written for.** Replaced with a level gauge, `agent_client_latched`, set from the same
  outcome that drives the counter (1 on `client_latched` AND on `error_fatal`, since every FATAL in this
  codebase routes through `handleFailure` before being thrown — verified: `AgentProposeError` is
  constructed at exactly two sites, both in `attemptOnce`). Fires on the next scrape, clears on the
  next scrape, and depends on no consult cadence — which also dissolved three further findings about
  window-vs-knob coupling and host-sleep false-clears.
- **Promoting every firing rule to an alarm would have wedged the loop.** Measured before choosing:
  ≥1 rule was firing **58.4% of the last 7 days** and 59.2% of the last 24h, dominated by warnings the
  program knowingly runs through (ReconciliationMismatch 1135 of 1440 minutes; AgenticReflectionNeverMinted
  4084 min/7d, sticky by a 24h `max_over_time`). Since playbook §3 makes any alarm block all improvement
  work, that is ~6 passes in 10 blocked — and `EffectiveModeLive` is severity `info` and fires
  permanently once live is armed. Now critical blocks; warning/info annotate.
- **`ruleCount > 0` was not a positive control, and the proof was live.** See the durable finding below.
- **My own "zero rules is a probe failure" test was not load-bearing** — the pre-existing generic
  probe-failure loop satisfied it unchanged, and `parsePromRules`, the sole decider of whether an empty
  firing list is evidence or a void, had no test at all. Now exported and unit-tested against captured
  `/api/v1/rules` payload shapes (`test/features/strategy/loop-sweep/prom-rules.spec.ts`, 13 cases).
- Two claims in my own comments were **false and were corrected**: the expiry log said "allowing one
  probe call" when expiry actually releases suppression outright, and "at most two failed requests per
  hour" holds only in the deployed batched shape.

Refuted and deliberately NOT acted on: clear-on-success (a no-op — the latch is already null before a
probe runs), renew-on-release (harmful alone — it would suppress a recovered client), the Grafana panel
description (untouched file, 4 names already stale for six days), and a companion `error_fatal` rule
(the gauge covers it).

**The safety dimension, checked by hand AND then by the lens.** My own check: ~12 `action='error'`
rows/hour during a latch could corrupt a statistic. Measured, not argued — all 103 degraded rows since
21:00Z (56 `error` + 47 `hold`) carry `playbook_version IS NULL` and `input_payload IS NULL`, and
`countVersionEntryStats` (the abstention-lapse evidence base) filters `playbook_version = <v>`, so they
cannot reach it, before or after. The order path is untouched: a suppressed call returns `signals: []`,
so nothing reaches Risk at all, and a post-cooldown probe can at most produce a proposal Risk still
sizes and vetoes behind the unchanged kill switch and live gates. The lens independently traced all four
secret-bearing paths (log, journal rationale, metric label, sweep digest) and found no leak.

**But the lens also found a defect I had introduced and would have shipped — `354187e`.** My
`recordDecide` drove `agent_client_latched` to 0 on "any outcome that is not the latch", with a comment
asserting that reaching such an outcome "means a call completed". False for two of them: `off_menu` and
`budget_blocked` are returned by `BatchingAgentClient` BEFORE `inner.proposeBatch` is ever called, so
they never touch the client and prove nothing. An off-menu symbol or a budget-exhausted day would have
dropped the gauge to 0 while the client was still latched — clearing the critical alert and returning
the sweep to reporting no alarm. **The exact blindness this whole pass exists to remove, reintroduced
one layer up by the fix for it.** Now two explicit sets (latched / proves-a-round-trip-happened) with
everything else leaving the level untouched, so a NEW outcome added later is inert rather than silently
clearing a live alert. Both regressions verified load-bearing by restoring the else-branch.

Second late survivor, same commit: `parsePromRules` kept only `alertname`/`severity` per firing
instance, so two instances of a per-venue rule rendered as byte-identical alarms — a pass reading
`ReconciliationHalt` twice could not tell whether one venue or both were halted. Instances now carry
their distinguishing labels as `scope`, rendered `AlertName{venue=binanceusdm}`.

### A durable finding worth more than the fix: committed alerts had never loaded

The review's name-set control found it while being written. The running Prometheus was serving a rules
file predating **2026-07-22** — 16 alerting rules loaded against 20 committed — because the container
reads `alerts.rules.yml` from a read-only bind mount ONCE at process start, has no
`--web.enable-lifecycle`, and the documented deploy step recreates only `app`. The four alerts added on
07-27 specifically to catch a silent lane (`AgenticLaneSilent`, `AgenticBudgetExhausted`,
`ReconciliationNeverCleanSustained`, `ReconciliationSweepFailureSustained`) had therefore **never
evaluated once**. The pass that wrote them believed it had installed four backstops and had installed
nothing.

Correcting the overstatement rather than leaving it flattering: `AgenticLaneSilent` would **not** have
caught this outage — `agent_decide_total` kept incrementing throughout, which is exactly why every
surface looked healthy. The staleness is a real defect; that particular rule was not the miss.

Three consequences, all shipped: `loop:sweep` now fails its `promAlerts` probe and names any committed
alert the running Prometheus has not loaded (name sets only — Prometheus re-renders PromQL, so diffing
query text would false-positive on every multi-line rule); the deploy step in both
`docs/runbook.md` and playbook §5 now requires `docker compose up -d --force-recreate prometheus` after
touching that file, and says why a plain `up -d prometheus` is a no-op; and `docs/runbook.md` gained the
"Agentic lane silent" section that both alerts' `runbook:` annotation had been pointing at since before
it existed.

### One more defect, found by the pass's own post-deploy sweep — `13d94c9`

The sweep that verified `354187e` raised `cost_breaker_proximity — spend $3 >= 80% of $3` against a
container whose own boot log read `daily LLM budget seeded from durable spend … $0.0000 of $3 already
spent today`. `agentic_budget_remaining_usd` is only `set()` once the lane evaluates its budget, so a
fresh boot reads prom-client's default 0, and the sweep's `spend = breaker − remaining` renders that as
the entire breaker spent. **A false alarm on every deploy — which under §3 consumes the next pass, and
which teaches the reader to skip `cost_breaker_proximity`, the same habit that let the 07-27 outage stay
invisible.** Now annotated (`budget_gauge_uninitialised`) only for the genuinely ambiguous reading —
remaining exactly 0 inside a 5-minute init grace, mirroring `AgenticBudgetExhausted`'s own `for: 5m` on
the identical gauge. A 0 past the grace is a real exhaustion and still alarms; any non-zero remaining is
unaffected. Three cases pin all three directions. Live confirmation the fix is right for the right
reason, not by luck: the following sweep read `Alarms (0)` with the gauge having since populated to
**$3**, i.e. the unambiguous path, not the suppressed one.

### Diff, gates, deploy

Four commits: `ee4ddf3` (latch cooldown + named short-circuit + sweep alert consumption), `7fa5ba8`
(post-review hardening: level gauge, critical-only severity split, name-set control, `parsePromRules`
tests, runbook/playbook deploy step), `354187e` (the two late-review survivors), `13d94c9` (the
budget-gauge false alarm). Gates green at each: format:check, lint, lint:md, typecheck, build, **test
170 files / 3018 tests** (livegate 55), `eval:agentic` 21. Every regression verified load-bearing by
reverting its own fix — `FATAL_LATCH_COOLDOWN_MS = Infinity` fails both latch tests, restoring the
else-branch fails both gauge tests.

**`7fa5ba8` was committed but NOT deployed** when this pass resumed — the running Prometheus still held
the pre-review expr, which is the very class this pass had just fixed. Deploys: app +
`--force-recreate prometheus` at 07:30:10Z (boot `7c6b68d3`), then app again at **08:05:55Z, boot
`464c608b`**, the live build. Verified live, not assumed: 20/20 rules loaded and none unhealthy,
`AgentClientFatalLatch` expr `agent_client_latched == 1` with `health=ok`, gauge present, kill switch
RUNNING, both venues CLEAN, sweep `Alarms (0)` with the positive control passing (`prometheus rules: 20
loaded, 0 firing`). RSS 757 MiB — above the 673 MiB paper reference, well under the 900 MiB WATCH-V3-1
defect line, and consistent with the 747 MiB read on the previous boot rather than a new climb.

### Soak

Partial and honestly bounded. The gauge's **negative** direction is confirmed live (0 on a healthy
boot, alert inactive, rule `health=ok`). Its **positive** direction — gauge → 1 and the alert firing
within one scrape of a suppressed call — was NOT observed before this pass ended: the accounts are still
unfunded, but bar counters reset on each redeploy, so the first consult attempt is up to 2h out
(`AGENTIC_FALLBACK_CONSULT_BARS=8`), and this pass redeployed twice. A watcher polled the gauge, the
decide counter and firing alerts every 60s for **40 minutes (07:42Z→08:22Z, 40 readings, spanning the
08:05:55Z redeploy)** and recorded `latched=0, decide={}, firing=[]` on every one — `agent_decide_total`
had no series at all, i.e. the lane never attempted a consult, which the final sweep's `consult-gate by
outcome: {}` says independently. So the window is a clean negative: nothing exercised the latch, rather
than the latch being exercised and the gauge failing to move.

The equivalent cycle WAS validated on the previous build by the soak entries above (`error_fatal` 21 /
`client_latched` 34 over ~10h, the 30-min cooldown visible in the ratio). What is unproven is
specifically the gauge path added in `7fa5ba8` and corrected in `354187e`. Stated as unproven rather
than inferred from the unit tests — the previous soak entry's own lesson was that a green metric nothing
has exercised is not evidence, and that applies to my own fix too.

### Book state

Unchanged by any of this: 28 closed round trips, net **−$39.64**, `agentic_promotion_ready=0`, equity
~$4,978, 5 positions (4 spot dust residuals + SOL/USDT:USDT 0.64 @ 77.38 ≈ $50 notional), 4 resting
protective orders, kill switch RUNNING, both venues reconciling CLEAN. Four round trips closed DURING
the outage via resting venue orders and net-of-cost improved $1.36 over that window — n=4, noise, and
recorded only because it is the kind of number that gets over-read later.

WATCH-V4-1 through V4-4 all hold: clean-stamp age 88s at pass start, `adopt_non_adoptable` and
`fill_overflow` both absent from `reconciliation_mismatch_total`, zero cross-venue fills, no terminal
order whose `fills` sum diverges from `cum_qty`, and no `perp pin:` / `START_TRADING_FAILED` line across
two redeploys.

### This pass shipped zero profitability work, and that is now three passes in a row of repair

Playbook §4 names consecutive repair-dominated passes as the trigger for recommending a systemic change
rather than absorbing it quietly. The recommendation is not "loop faster": **the loop is currently
unable to do profitability work at all, for a reason no amount of process fixes.** Both provider
accounts are unfunded, so the champion cannot trade and the one study that could answer whether any
playbook variant clears +13.0 bps cannot run. Meanwhile Pass 41's diagnosis stands — entries are
significantly negative, worse than a random-bar placebo — so funding the account resumes spending
~$2.6/day accumulating evidence for a gate the current entry signal provably cannot pass.

Those two facts together make this an owner decision about what the project is FOR, not a loop
decision, and it is the same decision Pass 41 surfaced and Pass 42 restated. The honest framing: the
credit exhaustion did not create that decision, it just removed the option of deferring it.

### Flagged (owner-capability only)

- **Fund a provider account** — the sole blocker on both the live lane and the frozen playbook-space
  study. Purchasing credit is a financial action outside what an automated pass may do. The lane
  self-heals within 30 min of credit landing, with no redeploy, and that is now a tested property
  rather than a hope.
- The pre-existing shared-org Anthropic rate-limit item and the CryptoPanic key, both unchanged.

### Next-pass candidates

1. Close WATCH-V4-5 — confirm `agent_client_latched` → 1 and the alert firing on the first suppressed
   call after 07:30Z (free, needs only a sweep once the fallback gate has fired).
2. **Only one session may run this loop at a time.** Tonight two did, in one tree. Before the next
   scheduled pass, decide the mechanism (a lock file the playbook checks, or a scheduler change) — a
   concurrent pass that lands a half-finished tree into another's gate run is a defect waiting to be
   attributed to the wrong cause.
3. Everything else waits on funding.

## 2026-07-28 — Pass 44 (the whole day's menu was picked from a quarter of the basket)

**Window:** 08:14Z → 09:10Z. `date -u` first. Sweep at pass start: `Alarms (0)`, two annotations.
Entry boot `464c608b` (git `54e0e02`), exit boot `899d4a09` (git `6369c0b`). Book unchanged and not
trading: 28 closed round trips, net-of-cost **−$39.6370**, win rate 17.9%, window 4.30d,
`agentic_promotion_ready=0`, equity $4,978.17. `agentic_budget_remaining_usd` $3.00 — zero LLM spend,
because both provider accounts are still unfunded (§ Flagged, unchanged and still the only real
blocker on profitability).

Pass type: **MAINTENANCE**, and the improvement it chose is a money-path correctness fix — the
scanner that decides which symbols the lane is allowed to trade at all.

### The finding: `menuSize` was the quorum, and 8 is 20% of the basket

`UniverseScannerService` ranks the 40-symbol basket (24 spot + 16 perp) by 24h-quote-volume rank ×
ATR% rank and promotes the top 8 to the active menu. `isActive()` gates two separate things: which
symbols the LLM lane consults, and which symbols get the heavy book/trades ws channel tier. A
UTC-day-key guard makes the ranking idempotent within a day, and `recompute()` stamps that day key as
soon as a quorum of `menuSize` symbols have scoreable metrics.

The container's own journal, read at pass start:

```text
08:15:03Z  universe_scan  menuSize 8  scored 11 of 40  ranks 12-40 score:null
```

The stamp landed 9m08s after the 08:05:55Z redeploy, while the 340-bar REST OHLCV warmup was still
in flight for 29 of 40 symbols. Those 29 could not compete for a menu slot for the rest of the UTC
day — and could not get book depth either, since the tier resolver keys off the same `isActive()`.
Confirmed independently: `market_channel_staleness_seconds` showed **candle:15m on all 40 symbols but
book on exactly 13**, matching the 13-member menu.

Not a rare race. `lastRecomputedDayKey` is in-memory, so every redeploy re-arms it, and this loop
redeploys on most passes. The quorum guard's own comment names this exact failure ("stamping the day
key then would freeze an arbitrary alphabetical menu until the next UTC day") — it just set the bar
at a menu's worth instead of a basket's worth, so it caught the all-cold case and missed the
partially-warm one, which is the case that actually happens.

**What it cost, measured after the fix rather than argued:** at full coverage `ETH/USDT:USDT` ranks
**5th of 40**. On the 08:05Z boot it was unscored, rank 22 by alphabet, and off the menu all morning.
A genuine top-8 symbol was excluded from both consults and book depth because it had not finished
backfilling nine minutes after a deploy.

### The fix, and the two things review stopped it doing

`2c7a005`. A ranking stamped below 90% basket coverage is now _repairable_: it re-ranks as coverage
improves and stops once the applied ranking has seen the whole basket. Three gates, all failing
CLOSED toward the pre-fix frozen ranking — declining is always safe here, because a symbol carrying a
position, a resting order, or an edge-cohort membership is held on the menu by the pin path
regardless of what the scanner decides.

Adversarial review (two lenses, both returned "request changes") killed two versions of this:

- **The first version silently defeated the hysteresis band.** It triggered on "coverage grew AND is
  now ≥ bar", which also fires on a day that was never partial. The reviewer reproduced it: a symbol
  warming up at rank 40 evicts a rank-3 incumbent that the v3 §5.3 band exists to hold, losing that
  symbol its consult and its book tier until 00:00Z, for zero informational gain. Now the repair only
  touches a ranking that was itself stamped below the bar, and a test pins it.
- **A hard one-shot cap would have re-created the defect, narrower.** Stopping at the first repair
  above the bar freezes the residual 4-of-40 out for the day. The repair now continues to full
  coverage. Churn stays bounded because coverage is monotone (`metrics` is append-only, basket fixed).

Hysteresis is deliberately suppressed on a repair: it is a day-to-day anti-flap device, and retaining
incumbents would preserve the partial menu being corrected while growing the consulted set toward the
rank-12 band, against a $3/day breaker sized for menu-8.

**Soak — the fix verified live on boot `899d4a09`, not inferred from tests:**

| scan | time | `corrective` | coverage | menu churn |
| --- | --- | --- | --- | --- |
| 1 | 09:00:12Z | false | **27/40** | 14 in (the partial stamp — pre-fix, this froze until 00:00Z) |
| 2 | 09:00:42Z | **true** | **38/40** | ZEC/USDT:USDT in, TRUMP/USDT:USDT out |
| 3 | 09:01:27Z | **true** | **40/40** | none — the menu was already right |

Total churn for the whole repair: **one symbol swap**, inside 75 seconds, against a wrong menu for a
whole day. The resubscribe-herd worry that shaped the design did not materialise, and scan 3 shows
why — by full coverage the ranking had already converged, so the closing repair cost nothing.

### Second defect: a counter nobody had incremented was reading as a broken probe

`4c8a5ca`. `market_stream_forced_reconnects_total` is incremented only when the running total exceeds
the last sample. With zero forced reconnects that branch never runs, and prom-client only creates a
labeled child when it is touched — so a healthy lane exported **no series at all**. `loop:sweep`
queries `sum(...)`, got an empty instant vector, and annotated `probe_failed[wsRecreations]` on every
single sweep, including both of today's digests.

That is a permanent §C.9 negative-read void sitting on the one counter that caught **both**
2026-07-21 soak defects (the candle-watchdog storm and the futures depth-rate stall). The signal most
likely to matter next was the signal the sweep could not read, and it had been annotating itself as
broken for days without anyone acting on it — the same "alert nobody read" shape as Pass 43.

Each venue now publishes at its true zero on first sight. **Verified twice live:** the metric went
from no series to `{venue="binance"} 0` / `{venue="binanceusdm"} 0` within one sampling tick of the
deploy, and the post-deploy sweep's annotation list dropped from two entries to one — the
`probe_failed[wsRecreations]` line is gone. A first-sight total that is already non-zero lands on that
total exactly once; the zero seed adds nothing (own suite, since first sight happens once per init).

### Third: two sessions edited this working tree again, and this time from inside the pass

`6369c0b`. While this pass was running, **two commits it did not make landed on `main`** — `8a15ad0`
(08:18:21Z) and `b5eee27` (08:23:03Z). Same hazard as Pass 42/43, now observed live rather than
reconstructed. Damage assessment, done before trusting any gate result: neither commit touched any
file this pass owns, and both changed files under `test/eval`, which the production gate glob
(`test/features test/domain test/ports test/livegate`) excludes — so the 3054-test result is this
pass's own. `git status` showed no foreign uncommitted work at any point.

`pnpm loop:lock` / `pnpm loop:unlock <nonce>` now take and release a pass lease, wired into playbook
§1 step 3 and §6 step 4, with the decision logic in a pure core and a spec **on the production gate**
— the split the sibling loop-sweep/loop-collect tooling already uses. Writing those tests and taking
the review found three defects in the guard itself:

- **`release` had no ownership check, so the guard defeated itself along its own documented path.**
  Playbook §6 runs for every pass _including one refused at §1_; that pass would reach `loop:unlock`,
  delete the live holder's lease, and re-enable the collision it had just detected. Release is now
  nonce-gated, and refusing to delete costs nothing because the lease expires on its own.
- **A future-dated stamp inverted the declared failure direction.** A negative age is always below
  the staleness bound, so the stale-break branch could never fire — every later pass refused for
  (skew + 120 min). This stack runs on a MacBook whose clock is corrected on resume, which is why the
  playbook opens with `date -u` at all.
- **`loop:lock relase` took a fresh 120-minute lease while printing "acquired".** Typos within edit
  distance 1 of a verb, and anything option-shaped, now exit non-zero. Verified live.

Stated in the script header rather than implied: this is a time-based lease, not a liveness check,
and **it only binds passes that call it** — which is exactly why it did not prevent today's
collision, since the colliding session predates it. A refusal is evidence of overlap; a clean acquire
is not proof of its absence. The scheduler config that lets two passes co-fire is owner-owned and
stays flagged.

### Not fixed, and the blocker named honestly

**Four orders have been non-terminal since 2026-07-24, and nothing can ever terminalize them.** All
four (`ZEC/USDT:USDT`, `SOL/USDT:USDT`, `KAITO/USDT:USDT`, `NEAR/USDT:USDT`) carry the identical
event chain and nothing after it:

```text
SUBMIT_SENT → SUBMIT_AMBIGUOUS → QUERY_NOT_FOUND      (then nothing, for 4 days)
```

`SUBMIT_UNKNOWN + QUERY_NOT_FOUND → NEW` is deliberate — "resubmit-eligible, same clientOrderId (TTL
live)" — and the TTL-lapsed sibling `QUERY_NOT_FOUND_EXPIRED → CANCELED` exists. But the TTL is
evaluated **only at query time**, 7 seconds after submit, when it was obviously still live.
`unknown-resolver.service.ts:315` then drops the order from `pending` with the comment _"NEW is
resubmit-eligible; resubmit orchestration is a follow-up"_. That follow-up was never built, so the
order is resubmit-eligible forever and nothing resubmits it: a permanent non-terminal row.

Live impact today is nil, and that is measured, not assumed: `open_orders{venue}` = 0 on both venues,
`in_flight_intents` = 0, `venue_capital_headroom_usdt{binanceusdm}` = 500 (full — no phantom reserve),
`reconciliation_mismatch_total` has no series at all across the 4 days these rows have existed, and
the clean stamp is 98s old. The portfolio view correctly excludes never-ACKed orders.

**Why it is not fixed in this pass, without a priority argument:** the correct repair is the _missing
capability_ the code names — TTL re-examination plus a venue re-query before terminalizing (never
blind, hard rule 5). That is new orchestration on the OMS money path, and it is not a line to change.
Shipping it thinly, in the same pass that already shipped three reviewed fixes, is precisely the
"fix re-creating one layer up the failure it removed" pattern Pass 43 recorded twice. It goes to
§ Flagged with the evidence and the proposed remedy, not to the backlog. **New WATCH-V4-6 below.**

### Corrections to what state.md said at hand-off

Both were checkable and both were wrong; the next pass would have read them as truth:

- "5 positions (4 spot dust + SOL/USDT:USDT 0.64)" — there is **no** SOL perp position. `positions`
  holds 4 spot dust rows only. The SOL 0.64 was closed by a venue stop at 01:06:07Z today
  (`order_events`: `FILL cumQty=0.64 reason=venue_stop_filled:algoId=1000000147822464`).
- "under 4 resting protective orders" — there are **no** resting protective orders. Those 4 rows are
  the never-ACKed zombies above; the venue reports `open_orders_checked=0` on every reconcile.

### WATCH-V4-5 — still unproven, and the deploy rhythm is why

`agent_decide_total` has no series on either boot today and the consult gate reads
`{"skipped_scheduled": 40}`, so nothing has exercised the latch. Structural, not bad luck:
`AGENTIC_FALLBACK_CONSULT_BARS=8` (2h) runs off **in-memory** bar counters, so every redeploy pushes
the first fallback consult 2h out. Today's two deploys (08:05:55Z, 08:53:50Z) each reset it; the next
window is ~10:53Z. With 3 scheduled passes/day that each deploy, a lane whose only consult trigger is
the fallback schedule can be starved by the loop's own deploy cadence. Recorded as an observation,
not a defect — the reset is arguable design — but it is the reason V4-5's positive direction has now
survived two passes unverified, and it will keep surviving until either the counters persist across
boots or a pass verifies the latch without waiting on the fallback clock.

### Gates and deploy

`format:check` · `lint:md` · `lint` · `typecheck` · **`test` 3054 passed / 171 files** · `build` ·
`eval:agentic` (25 passed, 8 skipped) — all green before each commit. The test delta is exactly +36
over the 3018 baseline, matching the 36 tests added; verified by stashing the specs and re-running,
which also confirmed all 33 pre-existing tests in the touched files pass against the new source.
Deployed `docker compose up -d --build app` at 08:53:50Z → boot `899d4a09`, healthy in 7s,
RestartCount 0, no `perp pin:` line and no `START_TRADING_FAILED` (WATCH-V4-3 holds across a redeploy
made while 4 non-terminal perp order rows exist).

Soak (post-deploy sweep 09:02:14Z): **0 alarms**, one `boot_changed` annotation, 20/20 alert rules
loaded and 0 firing, kill switch RUNNING, reconcile CLEAN-only both venues (10/9), clean stamp 98s
old (WATCH-V4-1 expected-positive), RSS 751 MiB climbing to plateau from 337 MiB at boot — inside
WATCH-V3-1, well under the 900 MiB line. Only benign warns (the same three categories as pre-deploy).
Prometheus was NOT recreated: this pass did not touch `alerts.rules.yml` or `prometheus.yml`. The
Grafana dashboard description change picks up on Grafana's own provisioning poll; not forced.

### Next-pass candidates

1. **WATCH-V4-6 (below): build the QUERY_NOT_FOUND terminalization.** It is the one defect this pass
   found and did not fix, and the blocker is missing capability, not scope.
2. **Verify WATCH-V4-5's positive direction without waiting on the fallback clock** — three passes
   have now deferred it to "the next sweep" while every deploy resets the 2h counter. Either persist
   the bar counters across boots or find a trigger a pass can exercise directly.
3. **Re-read the menu economics now that the menu is chosen from full coverage.** The repair changed
   _which_ 8 symbols get consulted, not how many, but the pinned set (4 spot dust + 4 edge-cohort +
   floor) pushes the live consulted count to 14 — 1.75× the menu-8 the $3/day breaker was sized
   against. That arithmetic is worth re-deriving from spec §5.2 before funding lands, not after.
4. Everything else still waits on funding, and funding should still be read against Pass 41's ENTRIES
   verdict first.

---

## 2026-07-28/29 — Pass 45 (incident-first: an outage that was over before anyone looked)

**Window:** 2026-07-28T16:07Z → 2026-07-29T07:00Z (pass lease `7109445f81e18a20`, taken 16:07:14Z).
Boot `899d4a09` throughout (StartedAt 2026-07-28T08:53:50Z, RestartCount 0 — one unbroken 22h boot,
which is what made this pass's WATCH resolution possible).

**Headline:** kill switch RUNNING · reconcile clean stamp 47-99s old all pass (WATCH-V4-1 holds) ·
reconcile CLEAN-only both venues · fills 0 · **`agentic_budget_remaining_usd` = $3.00 of $3, i.e. the
lane spent NOTHING in 22h** · `agent_decide_total` = `error_fatal` 67 + `client_latched` 197, and
**zero successful decides on this boot** · `promotion_ready` has no series (0 closed round trips).
Net-of-cost PnL unchanged and still negative; the promotion gate did not move, and could not.

### The sweep fired one alarm, and the alarm was not the story

`prometheus_alert_firing` — `AgentClientFatalLatch` (critical), firing since 10:45:25Z. Root cause is
the already-flagged one, re-confirmed verbatim from the container log:
`400 invalid_request_error: "Your credit balance is too low to access the Anthropic API."`
Nine latch events, eight expiries, all on one boot. **Not a new finding and not fixable here** — see
§ Flagged; purchasing credit is a financial action outside what an automated pass may take.

The story is what the sweep could **not** show. Reading the container log directly rather than the
sweep's summary turned up a **49-minute demo-fapi outage, 09:22:36Z → 10:11:34Z**: 293 perp fill-poll
failures, 47 `reconcile sweep failure venue=binanceusdm axis=trades`, and a one-shot funding-ingest
failure on all 16 perp symbols — request timeouts and `502 Bad Gateway` from the venue's own nginx.
It fired `ReconciliationSweepFailureSustained` and `ReconciliationMismatch`, self-healed, and by the
16:07Z sweep had left **no trace in any surface the pass reads**: the alarm list showed the unrelated
latch, and the warn tail (3000 LINES ≈ under 2h at this stack's rate) had scrolled past all 340 lines.

Venue-side and over. The point is that a 3×/day consumer was structurally incapable of seeing it —
the same blindness class as the 45h outage of 07-25/27, one layer further in.

### Shipped — `b43777a` (loop tooling; no money path touched)

`loop:sweep` now also reads the rules file BACKWARDS. Prometheus keeps the synthetic `ALERTS` series
in its own TSDB, so the history was already there and cost one instant query nobody was making.

- `promAlertsSince` — alerts that fired in the last 12h (`1.5 × EXPECTED_SWEEP_INTERVAL_MS`) and are
  no longer firing. **Annotation-only by design:** a fixed lookback makes a derived alarm sticky for
  the whole window, and §3 blocks improvement work until an alarm clears — history never can. Sized
  off the design inter-pass gap, NOT the watermark, because the standing collector advances the
  watermark hourly and a watermark-sized window would be ~1h.
- **Two positive controls**, because an empty `ALERTS` window reads identically to a Prometheus
  serving no rules. The live rules probe is necessary but present-tense; scrape coverage over the
  window (via `up`, 2880 expected samples at 15s) is the retrospective half. Below 90% the window has
  holes. Positive findings still stand — only the negative weakens.
- History is captured **before** the live read, so an alert starting between the two round-trips is
  subtracted rather than announced as resolved.
- `ERROR_LOG_TAIL` 3000 → 20000 (~12h here), and the scan now discloses the span it actually covered
  instead of letting the count read as a whole-window verdict.

Verified live, twice: the sweep now names both resolved alerts and surfaces all 340 previously-hidden
warn lines, with coverage reading 2880/2880.

**The adversarial review earned its keep — three defects, all in the new guards' own fail directions,
all fixed before commit.** (1) The boot-reach suppression compared signed, so a tail reaching lines
OLDER than `StartedAt` — which docker produces on every in-place restart, since it does not truncate
the log — counted as "reaches boot" and silently killed the disclosure, worst exactly after a restart
storm. (2) A tail with no parseable timestamp was skipped rather than disclosed, leaving the digest
printing a confident `warn+ lines: 0` over a window of unknown depth. (3) The retrospective claim
rested on a present-tense control, reachable through the sweep's own advice to recreate the Prometheus
container — which is itself a hole in the history it then reads. That third one is why the coverage
probe exists at all; it was not in the original design.

### WATCH-V4-5 — POSITIVE DIRECTION PROVEN, closing an item Passes 43 and 44 both left open

Pass 44 wrote that a third pass "must not simply defer this to 'the next sweep' again". It did not
have to: the unfunded account drove the fatal path repeatedly across one 22h boot, which is exactly
the evidence the fallback clock kept denying. All three clauses confirmed from live state, not tests:

1. `agent_client_latched` = 1 while calls are suppressed, with `AgentClientFatalLatch` following it —
   inactive on the 07-28 07:30Z boot, firing since 10:45:25Z.
2. **Zero `action='hold'`-with-empty-rationale rows since the fix deployed.** 135 such rows exist; the
   newest is `2026-07-28T01:15:18Z`, ~6h before `ee4ddf3` booted. Every one predates the fix. Since
   then the same condition produces 197 named `client_latched:` degrades at `action='error'` instead.
3. **The latch expires and resumes with NO redeploy** — 8 expiries on one boot, `RestartCount` 0.

Unproven only in its funded-resumption clause ("the lane resumes within 30 min of credit landing"),
which cannot be tested without credit. The load-bearing half — that the latch self-heals rather than
wedging until a human recreates the container — is now demonstrated.

### Checked and NOT a finding

The warn stream is 65% one message: `reconcile pass still in flight — skipping this tick` (743 of
1135). It reads alarming and is not. The skip rate over the window is ~52% (743 of ~1440 30s ticks),
inside the healthy band a prior pass measured and documented in `reconciliation.service.ts:294-301`
(62 skips/hour against 57-58 completed passes/venue), it is already metered as
`reconciliation_runs_total{result="skipped"}`, and the coalescing is what keeps passes running
back-to-back. Demoting a deliberate "visible, never silent" decision on the money path to quiet the
sweep's top-5 would have been cosmetics at the cost of a real signal. Left alone.

### Gates and deploy

`format:check` · `lint:md` · `lint` (exit 0) · `typecheck` · **`test` 3082 passed / 172 files** ·
`build` · `test:livegate` 55 — all green before commit. Test delta +15 over the 3067 baseline,
matching the 15 cases added. No `eval:agentic` run: this pass touched no agentic-lane code.

**Deploy: none required, and none made.** The change is host-side loop tooling — the app image does
not run it, and `pnpm loop:sweep` picks it up on the next invocation (verified twice live). No
`alerts.rules.yml` / `prometheus.yml` edit, so no Prometheus recreate.

**One honest gap: the collector daemon (pid 64361, up 1d17h) still holds the OLD sweep code in
memory** and will keep writing pre-change hourly digests until restarted. `kill` is denied to this
session and SIGTERM is the collector's only stop path, so this pass could not restart it — and
starting a second collector would violate the single-writer discipline on the watermark, so it
deliberately did not. Impact is bounded: a PASS runs its own `loop:sweep` (playbook §2 — "the sweep
IS `loop:sweep`"), which is current. Only the hourly rehydration digests lag.

### Flagged / next-pass candidates

1. **Restart the collector daemon** (`pnpm loop:collect`, after SIGTERM to the old pid) so hourly
   digests carry the new probes. Needs a `kill` this session did not have.
2. **WATCH-V4-6 — the `QUERY_NOT_FOUND` terminalization.** Unchanged from Pass 44 and still the one
   defect with a real capability blocker. Re-checked this pass: still exactly 4 non-terminal orders
   from 2026-07-24, not growing — expected-positive holds.
3. **Both provider accounts remain unfunded.** Nothing in this program moves until that is resolved,
   and per Pass 41 it should be read against the ENTRIES verdict before funding, not after.
4. The menu-economics re-derivation from spec §5.2 (Pass 44's item 3) is still open and still cheap.

## 2026-07-29 — Pass 46 (a NOT NULL column that never measured anything, and a redeploy that erased an outage)

**Window:** 2026-07-29T07:37Z → 09:15Z (pass lease `1b42f3614efda993`, taken 07:37:22Z).
**Boots this window: four.** `899d4a09` (the 22h boot) → `f9dc22ef` at 08:17:56Z, deployed by a
CONCURRENT session, not this pass → `2ceaae5b` at 09:05:26Z (this pass's fix) → `f7a477f3` at
09:09:12Z (rebuild to restore build provenance).

### ⛔ Headline: the Anthropic account is not funded — that is why every LLM request fails

Re-confirmed live at 09:00Z, verbatim from the API:
`400 invalid_request_error: "Your credit balance is too low to access the Anthropic API."`

Nothing in the code is broken. The lane calls, receives a FATAL 400, latches for 30 minutes, retries,
receives the same 400, re-latches — which is correct behaviour against an unfunded account. The
Moonshot fallback is unfunded too (`429 suspended — insufficient balance`). **Zero LLM decides ⇒ zero
trades ⇒ zero promotion progress, continuously since 2026-07-27T21:16Z.** Adding credit is a financial
action no automated pass may take; it is the single owner action the whole program waits on. On
resumption nothing needs redeploying — the latch self-heals within 30 min of credit landing
(proven live, WATCH-V4-5).

Scoreboard, unmoved and unmovable while this holds: **28 of 30** closed round trips, net-of-cost
**−$39.6370**, win rate 0.179, LLM cost $16.1979, trade-anchored window **4.30 of 14 days**,
`agentic_promotion_ready` **0**. Champion playbook **v8**, +$6.77 over 5 trips — the only lineage
meaningfully positive at n>3; v2 alone is −$24.76 over 14 and accounts for most of the book's loss.

### The sweep went from one critical alarm to zero, and nothing was fixed

07:37Z: `AgentClientFatalLatch` (critical), firing since 07-28T10:45:25Z. 08:37Z: **Alarms (0)**.

Between them, a concurrent session redeployed. That reset `agent_client_latched` to 0, cleared the
alert, and wiped the boot-scoped `agent_decide_total` series entirely — `error_fatal 67` and
`client_latched 197` became **no series at all** (verified with a positive control: 88 series scraped,
19 `agent*` present, that one absent). The unfunded condition underneath was completely unchanged.

**A redeploy launders a persistent lane outage into a green board.** The blind window is bounded but
wide: `AGENTIC_FALLBACK_CONSULT_BARS=8` at 15m bars puts the first consult attempt — the only thing
that can re-latch — ~2h out, and `AgenticLaneSilent`'s 6h range selectors still see the previous boot's
samples, so neither guard fires. **The playbook's mandated 15-30 min post-deploy soak sits entirely
inside that window.** A pass could deploy, soak green, and sign off on a dead lane. The only surface
naming the outage at 08:37Z was Pass 45's day-old `prometheus_alert_resolved_critical` annotation —
shipped yesterday, earning its keep on its first full day. Recorded as **WATCH-V4-8**, with the fix
shape (seed a last-success timestamp from the durable ledger at boot, exactly as `f2d74b6` did for the
cost breaker and as `reconciliation_last_success_timestamp_seconds` already does). Not shipped — see
§ Not shipped, and why.

### Shipped — `c50db12`: an audit table whose measurement columns were all a literal zero

`reconciliations` carries four NOT NULL measurement columns. The only persisting store wrote `0` into
all four because `ReconciliationRow` never carried them. **23,973 rows since the v3 cutover, zero
non-zero values in any of the four, ever.**

What surfaced it was a contradiction, not a hunch: `duration_ms` read 0 while the same subsystem logged
**865** `reconcile pass still in flight — skipping this tick` warnings in 14h — which only happens when
passes overrun their tick — and the service's own comment says a pass issues "dozens of sequential REST
calls over ~60s". A pass cannot both take 0ms and overrun its tick.

It was worse than a dead field, because it had already been read as evidence. Pass 45's hand-off and
state.md both concluded _"there are no resting protective orders … the venue reports
`open_orders_checked=0` on every reconcile"_ — from a hardcoded constant. And the falsification goes
deeper than the constant: that axis sweeps the REGULAR rail via `fetchOpenOrders`, while protective/algo
stops live behind `fetchOpenAlgoOrders`, which it never calls — so **no value of that field is evidence
about protective orders**. The conclusion survives on independent gauges (`open_orders{venue}`=0,
`venue_capital_headroom_usdt`=500); the citation was void. Struck and corrected in state.md rather than
quietly rewritten, because it had already been inherited once.

**The adversarial review changed the fix, and that half matters more than the first.** Version one
threaded real counts and would still have written `balances_checked=0` forever **on the only
configuration that runs** — every configured venue is `demo`, so `venueReconConfig` turns `balanceAxis`
off on all of them. A disabled axis now writes `AXIS_NOT_RUN` (−1). The review also caught that the new
gate test asserted `tradesChecked` `toBe(0)`, which would have passed with the increment deleted, and
that the store dropped `ReconciliationRow.ts` entirely (the column's `now()` default stamped every row
at INSERT time) — the same defect class one field over. Both fixed before commit.

**Live-verified post-deploy**, which is the whole point:

| | before | after |
| --- | --- | --- |
| `duration_ms` | 0 on all 23,973 rows | 14,291-23,268 ms |
| `trades_checked` | 0 always | 458, then 7 |
| `balances_checked` | 0 always | −1 (`AXIS_NOT_RUN`) |
| `open_orders_checked` | 0 (constant) | 0 (now a _measured_ zero) |

Two venue passes at 14-23s each ≈ 37s against a 30s tick — the 865 skips are explained arithmetically
for the first time, and the field that explains them now exists.

**Gates:** format, lint, typecheck, **3092** unit+livegate, build, plus `test:db` 64/64 against live
Postgres. **Soak:** clean — 0 alarms, container healthy, `RestartCount` 0, kill switch RUNNING, both
venues CLEAN, 5 warn lines all benign.

### Also fixed: the build-provenance probe read `unknown` on its first real deploy

`af67acf` (shipped ~50 min earlier by the concurrent session) added a `running build:` probe so a pass
can tell which build is live. The Dockerfile takes `ARG GIT_SHA=unknown`, but the documented deploy
command — `docker compose build app`, playbook §5 step 3 — does not pass `--build-arg`. So the first
deploy following the documented procedure (mine) produced `running build: unknown`, defeating the
probe. Rebuilt with `--build-arg GIT_SHA=$(git rev-parse --short HEAD)`; now reads
`running build: c50db12`. **The deploy procedure in the playbook and runbook still omits the flag** —
left to the session that owns those files this morning, noted here so it is not lost.

### Not shipped, and why — a concurrent unleased session held the tree

I acquired the pass lease cleanly at 07:37:22Z. Between 08:16:55Z and 08:29:16Z another session landed
**`af67acf` and `f630f63` on `main`**, redeployed the app at 08:17:56Z, and force-recreated Prometheus
(20 → 21 rules). This is the **fourth** recorded concurrency occurrence and **the first with production
blast radius**: previous ones touched only `test/eval`, which the gate glob excludes, while these
rewrote `src/features/common/observability/**`, `src/config/**`, `observability/alerts.rules.yml` and
the sweep itself.

Damage assessment before trusting anything, per the standing procedure: zero file overlap with this
pass, and both commits were fully committed with a clean tree before my gate ran — so the 3092-test
result stands. **WATCH-V4-8's fix was not shipped for a specific reason, not a priority one:** it
touches `metrics.service.ts` and `alerts.rules.yml`, both rewritten 50 minutes earlier by that session
while its own deploy soak was still running, and a rules-file edit requires a Prometheus
`--force-recreate` that would have destroyed that soak. That is a blocked state with a named blocker.
**The scheduler config that lets two passes co-fire remains owner-owned and open** — it has now caused
four collisions and this one deployed twice under another pass's feet.

### Flagged / next pass

1. **THE ACCOUNT IS UNFUNDED.** Owner action. Everything else is downstream of it.
2. **WATCH-V4-8** — ship the durable last-success gauge on an uncontended tree.
3. **The deploy procedure omits `--build-arg GIT_SHA`** — playbook §5 step 3 and `docs/runbook.md`.
4. **WATCH-V4-6** — unchanged, still exactly 4 non-terminal orders from 07-24, not growing.
5. Provider failover is **not** reachable by config alone — `AnthropicAgentClientConfig` has an optional
   `baseUrl` honored at the fetch, but no production code path ever assigns it, and `MOONSHOT` /
   `AGENTIC_EVAL_*` appear nowhere in `src/**` (positive control: `ANTHROPIC_API_KEY` hits 6 files).
   Moot while both accounts are unfunded; recorded so the next pass does not re-derive it.

## 2026-07-29 — Pass 47 (four measurement lies, one of them the alarm that was supposed to catch the other three)

**Window:** 2026-07-29T09:15Z → 11:15Z. Lease `25798a2449a344ac` taken 09:15:21Z, tree uncontended.
Pass 46 released its lease at ~09:15Z, so this pass began **21 seconds after the previous one ended** —
back-to-back, not concurrent. Consequence recorded below.

**Sweep:** 0 alarms at open. Two annotations: `prometheus_alert_resolved_critical`
(`AgentClientFatalLatch`, 662 firing samples) and `short_interval` (gap 167s). Playbook §3 makes a
resolved critical a defect investigation anyway, which is where this pass started.

**Book — unchanged, independently re-derived from metrics rather than copied from Pass 46:**
`agentic_promotion_round_trips` 28, `agentic_promotion_net_pnl_usd` −39.6370,
`agentic_promotion_llm_cost_usd` 16.1979, `agentic_promotion_win_rate` 0.1786,
`agentic_promotion_window_days` 4.2953 of 14, `agentic_promotion_ready` 0. 0 fills this window.
Champion v8 remains the only meaningfully positive lineage (+$6.77/5 trips) against v2's −$24.76/14 —
n=5 is far under this loop's own "never act on a sub-n≥12 cell" bar, so it stays an observation.
`equity_usdt` 4978.17. RSS 711.5 MiB (WATCH-V3-1: under the 900 MiB line).

**Pass type:** defect investigation. No improvement work was eligible and that is not a scheduling
excuse — every open backlog row is DATA-GATED on closed trips that cannot accrue while the lane is
dead, and § Standing verdicts forecloses the rest (entry signal worse than a random-bar placebo; exit
sweeps closed; "do not propose cost work as a profitability lever"). The one unblocked lever is owner
funding. Stated plainly because the playbook asks for it: **this pass shipped no profitability work
because none exists that funding does not gate.**

### The four defects, all shipped

All four are the same disease at four sites: **a value supplied by its own writer as a constant, or a
counter that counts non-events, is indistinguishable from a measurement at every query, forever.**
Pass 44 recorded it for prom-client children; Pass 46 for a NOT NULL column. This pass found four more.

**1. Deploy provenance read `unknown` for anyone following the playbook** (owner-raised mid-pass).
The Dockerfile takes `GIT_SHA` as a build arg; the compose `build:` block declared no `args:`. So the
arg was reachable only via `docker compose build --build-arg` — the runbook's form. The playbook's §5
form supplied nothing, and the scheduled task's form (`up -d --build`) **cannot** supply it:
`docker compose up` rejects `--build-arg` outright ("unknown flag"), verified live. Every automated
deploy baked the literal `unknown`; the runbook path baked a real sha. That is why the metric read
`c50db12` today and the gap stayed invisible — Pass 46 happened to use the runbook form.
Compose now interpolates `${GIT_SHA:-unknown}`, the one mechanism both subcommands accept (proven
end-to-end on compose v5.3.1 with a throwaway image before any repo edit), and all four documented
deploy commands collapse to that form. **The actual driver was outside the repo** — the scheduled
task's own `SKILL.md` — and was fixed too, along with two other rots in it: it still told every pass
to rehydrate with `loop:digests`, which Pass 46 deleted, and it never mentioned the pass lease.
Two further defects fell out of the fix: `build_info` was resolved by **array order** (the identical
`boot_info` defect found 2026-07-29, one metric over — after a redeploy Prometheus serves both boots'
series and the probe took `[0]`), and `APP_GIT_SHA` now fails OPEN on a **malformed** value, not just
an absent one, because compose interpolates the deployer's ambient `GIT_SHA` and an over-long export
would have thrown in zod, crash-looped under `restart: unless-stopped`, and raised `restart_storm` —
an observability input blocking the deploy it exists to record. It degrades to `unknown` rather than
truncating, because a truncated string is indistinguishable from a real sha.

**2. `zero_decides` cannot fire on a dead lane — the most consequential finding.**
`probes.decides` is an unfiltered `select count(*) from agent_decisions`, but that table takes a row
per symbol per scheduled skip, where no model call happens. Measured over the 12h before the fix:

| hour (UTC) | all rows | scheduled skips | errors | REAL decides |
| ---------- | -------- | --------------- | ------ | ------------ |
| 08:00 | 160 | 154 | 6 | **0** |
| 07:00 | 160 | 153 | 7 | **0** |
| 06:00 | 160 | 147 | 13 | **0** |
| … every hour identical … | 160 | ~150 | ~13 | **0** |

160 rows/hour, every hour, zero real decides — through a lane dead since 2026-07-27T20:15:31Z.
`agentic_consult_gate_total` is incremented by `skipped_scheduled` the same way, so both halves of the
alarm's condition are permanently false. **The alarm the playbook names as the primary dead-lane
detector has never been able to fire on a dead lane.** The total is kept (it does detect a stalled
scheduler — the real 8.2h candle-stall class); a separate `realDecides` probe now counts genuine model
calls with the same structural predicate the app uses to seed its gauge, so the two cannot disagree.
Annotation only, never an alarm — reasoning under defect 3.

**3. WATCH-V4-8 — a redeploy launders a standing outage into a green board.** Queued by Pass 46 with
the deadline "next pass with an uncontended tree"; this was it. Reproduced live at pass open: with the
lane 34h dead, `agent_client_latched` 0, budget $3, 21 rules loaded / 0 firing, 0 sweep alarms.
`agent_last_success_timestamp_seconds` is now seeded at boot from `agent_decisions`, so it reads the
TRUE age on the first scrape of every boot. The success predicate is structural rather than a
rationale string match — `prompt_hash <> '' AND latency_ms IS NOT NULL AND strategy_id NOT LIKE
'replay-%'`, two columns written together and only by code that already parsed a response body — so
skips, latched suppressions and thrown errors are excluded by the shape of the write path. Review
narrowed it further (a post-200 degrade is not a decide either), which is why the lifetime count reads
575 and not the 660 the first predicate selected.
`AgenticNoSuccessfulDecideSustained` is **severity warning, deliberately**: `loop:sweep` promotes only
`critical` to the blocking alarm and §3 blocks improvement work until alarms clear, so a critical here
would wedge every future pass on a condition no pass can fix. `for: 5m` and not the soak length —
the sweep reads only rules already `firing`, so a `for:` equal to the playbook's 15-min MINIMUM soak
would still be `pending` when the soak-ending sweep runs, invisible on the very pass that shipped it.
9h threshold: the model self-schedules up to 32 bars × 15m = 8h, and the widest real decide gap with
the app actually running is 270min.

**4. Three counters whose zero was a void read.** `reconciliation_mismatch_total`,
`agentic_schema_rejections_total` and `agentic_capability_violations_total` were registered with
**zero children** — HELP/TYPE present, no series — so every query returned an empty vector, not a zero.
`reconciliation_mismatch_total{class="adopt_non_adoptable"}` and `{class="fill_overflow"}` are the
literal expected-positive signatures of WATCH-V4-1 and WATCH-V4-2: **successive passes have confirmed
both against an instrument that could not answer.** Both re-verified this pass directly against
`audit_log` (zero rows) — the verdicts stand, the citation never should have been made. All 13 mismatch
classes and 4 schema kinds are now seeded from their own type unions; the capability counter is seeded
at the single kind its call sites actually produce, verified by enumerating them, because a guessed
label would be a fabricated child — the same lie one level down. Pass 44 fixed exactly this on
`market_stream_forced_reconnects_total` and left three siblings.

### Gates, commits, deploy, soak

Gates green on the full tree: `format:check`, `lint:md` (0 errors), `lint`, `typecheck`,
**`test` 3147/3147 across 175 files**, `build`, **`test:livegate` 55/55**.
Commits: `1cb2253` (defects 1+2 — sweep tooling, compose, docs) and `446e1da` (defects 3+4 — app
metrics). **Two commits for four defects, not four**: defects 1/2 both rewrite
`scripts/loop-sweep{,-core}.mjs` and 3/4 both rewrite `agent-metrics-recorder.service.ts`, so a
four-way split needed per-hunk staging that could produce an intermediate commit failing its own spec.
The seams are where the files actually separate. Each defect got its own adversarial review regardless.
Deployed 11:03:17Z, boot `1d68a57c`, `RestartCount` 0, `GIT_SHA=446e1da` via the playbook's own
`up -d --build` form; Prometheus force-recreated (rules file changed) → **22 rules loaded**.

**Soak — every fix verified live, not inferred from tests:**

- `build_info{git_sha="446e1da"}`; digest reads `running build: 446e1da (working tree 446e1da)`.
- `agent_last_success_timestamp_seconds` = 1785183331.331 → **38.80h stale on a boot minutes old**,
  in the same scrape where `agent_client_latched` reads 0. The defect and its fix, side by side.
- **`AgenticNoSuccessfulDecideSustained` FIRING at 11:04:25Z on an 8-minute-old boot** — the signal
  that did not exist before this pass, since every other rule reads green on a fresh boot.
  It lands as `prometheus_alert_firing_nonblocking`, so **sweep alarms stayed 0** and §3 is not wedged:
  exactly the designed failure direction.
- 13 + 4 + 1 counter series now publishing true zeros.
- `kill_switch_state` RUNNING, reconciles CLEAN both venues, `ReconciliationNeverCleanSustained`
  self-cleared once the first post-boot reconcile landed, 0 loop errors, RSS 711.5 MiB.

### Standing WATCH lines, verified against DB truth (not against the metrics that were void)

WATCH-V4-1 holds (clean stamp 105s; no `adopt_non_adoptable` in `audit_log`). V4-2 holds (no
`FILL_OVERFLOW`). V4-3 holds (boot at `RestartCount` 0, kill switch RUNNING, no `perp pin:` line).
V4-4 holds (0 `cum_qty`-vs-fills mismatches; 197 perp fills → perp orders, 12 spot → spot orders,
**zero cross-venue folding**). V4-6 holds (still exactly the 4 non-terminal orders from 07-24,
`cum_qty` 0, not growing). V4-7 holds. **WATCH-V4-8 RESOLVED** — expected-positive confirmed live above.
Pass 46's `c50db12` confirmed in production: `duration_ms` 16–22s per venue pass (was a literal 0),
`balances_checked` −1 (AXIS_NOT_RUN); two venues ≈39s against a 30s tick, which explains the
"reconcile pass still in flight" warns arithmetically for the first time.

### Flagged / next pass

1. **Funding remains the only thing standing between this program and progress.** Unchanged and
   owner-only. Last real model decide 2026-07-27T20:15:31Z; the lane has now been dead ~39h.
2. **Back-to-back passes are a measurement problem, not just waste.** This pass started 21s after
   Pass 46 ended, which tripped the `short_interval` floor and **suppressed delta-starvation alarms
   for the whole pass**. Combined with defects 2 and 3, that made three independent mechanisms capable
   of hiding a dead lane from a single pass. Two are now fixed; the scheduling one is owner-owned
   (§ Flagged, the co-fire item). Recommend the 3×/day schedule be checked for double-firing.
3. **Owner research request, queued 2026-07-29:** whether the daily loop (or a similar
   subscription-based path) could call app endpoints to execute trades as the bot would — routing
   around the funding blocker entirely. Not started this pass. First constraint to design against:
   hard rule 2 forbids bypassing Risk, so the entry point must be the Signal boundary, not the order
   boundary, and the promotion-evidence question (whose decider is the gate measuring?) needs an
   answer before any such trades are allowed to count.
