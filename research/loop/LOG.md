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

## 2026-07-30 — Pass 48 (four alarms that could not fire, and the account funded itself mid-pass)

**Window:** 2026-07-30T07:45Z → 11:10Z. Lease `93440505ff45f0f3`. The lock **broke a stale lease**
("pass 47b research: loop-as-decider", 721 min old) — that session took the lease at ~19:44Z on 07-29
and never released it. Two sweeps ran on 07-29 (16:07Z scheduled, 19:33/19:46Z) that left **no LOG
entry at all**. The loop has no detector for its own unrecorded passes; noted as a finding, not fixed.

**Sweep at open:** 1 alarm — `AgentClientFatalLatch` (critical, firing since 07-29T13:00:25Z), the
known unfunded-account condition. Annotations: `AgenticNoSuccessfulDecideSustained` (warning) and
`no_real_decides_in_window` — Δ1920 raw `agent_decisions` rows against **Δ0 real model decides**,
Pass 47's new probe doing exactly its job.

**Pass type:** defect investigation, forced by §3, then owner-directed work. Five parallel
investigations plus adversarial verification of every claim (20 agents).

### THE HEADLINE, and it was not the plan: the account was funded mid-pass

At 07:45Z the 400s were live and confirmed from the container log (28 latches / 27 expiries on boot
`1d68a57c`, 100% `credit balance too low`, newest 07:45:18Z). By the post-deploy check the lane was
**alive**: first real decide **2026-07-30T09:01:01Z** (45.6s, full thesis), first proposes 09:15:31Z
(`open_long` ZEC spot + perp), 597 lifetime real decides against 575 in the morning, 6 fills in 24h,
`open_orders` 3 per venue where it was 0, $0.60 of the $3 breaker spent. Credit landed between 07:45Z
and 09:01Z and **the lane self-healed with no redeploy**. That closes the one clause of WATCH-V4-5
that could never be tested without credit — the funded-resumption path is now proven live.

**The scoreboard moved for the first time since 07-27, and the direction matters more than the
motion:** 29 closed trips (was 28), window **6.71 of 14 days** (was 4.30), net-of-cost **−$41.1723**
(was −$39.6370). One trip advanced the window 2.4 days and cost $1.54. That is precisely what
`verdicts.md` predicts: every additional trip on the present entry signal moves the trip count toward
the bar while moving net-of-cost away from it.

### Four defects shipped, all four measurement lies, two of them CRITICAL alerts that could not fire

**1. `8002888` — six passes investigated one unfunded account because the alarm could not say so.**
Owner directive, verbatim: _"lack of trading is because of the anthropic api account being unfunded.
this should not have to turn into investigations on each pass."_ The cause was structural:
`AgentClientFatalLatch` is `critical`, `loop:sweep` promotes every firing critical to a blocking
alarm, and §3 makes any alarm force a defect investigation. A permanent owner-blocked fact wedged
every pass. `classifyLatchCause` now reads the provider's own error body — 401/403 ⇒ `auth`, 400 +
`invalid_request_error` + `/credit balance/i` ⇒ `insufficient_credit`, everything else ⇒ `other` —
and the alert splits, with the known cause landing at `warning`. **Fails CLOSED**: only a positive
match demotes. Review found three defects in the first cut, each in the new guard's own failure
direction: the `and`-shaped expr collapsed to empty when the cause series was absent (silencing the
critical over a dead lane — the void-read disease reintroduced in the alert that catches a dead
lane; now `unless`); the banner keyed on an instant gauge measuring `avg_over_time` **0.836** over
24h, so one sweep in five would print nothing over the exact condition it announces (now a 6h
`max_over_time`); and the `cause=` tag was model-spoofable into **false reassurance** (now anchored
to the emitted string).

**2. `a03b35d` — the two critical alerts guarding hard rule 6 could not fire.**
`ReconciliationHalt` selects `{result="halt"}`, a child that was never seeded — measured live, the
selector returned an EMPTY vector against a positive control returning three series. A prom-client
child born lazily sits at its first value forever, so `increase()` reads 0: demonstrated on a live
sibling reading **1** with `increase([24h])` = **0**. Precision, because the first draft overstated
it: the alert is not dead in general (it fired 9 consecutive evaluations on 07-26) — what is
invisible is a halt whose child receives exactly ONE increment, and WATCH-V4-2 records that
`FILL_OVERFLOW` is precisely that. `ReconcilerStalled` used `result!="error"`, which includes the
re-entrancy `skipped` child — the counter that RISES when passes stop completing. Measured: old
selector 27.95, of which skip alone 10.26; narrowed selector 18.46 on a healthy reconciler.

**3. `e1ce4e1` — the loop's memory was its largest fixed cost.** Owner directive: _"clean up log.md
and state.md … you can find a better way to keep the loop hydrated."_ state.md 1,932 lines + LOG.md
5,886, read three times a day. Split by one question — what must a pass read before it can act:
`STATUS.md` (152 lines, capped 200) always; `charter.md` / `verdicts.md` / `watches.md` on demand;
archives for the rest. **Nothing deleted, proven two ways**: 50/50 moved blocks byte-identical in
their destinations, and every non-blank source line present in the new set. The actual fix is the
rotation rule in §6 — a one-off compaction just re-grows.

**4. `e091ba5` — seven more instruments whose zero nobody could read**, enumerating the siblings of a
known class. Review caught this commit committing the very defect it removes, twice:
`agentic_venue_stop_total` was seeded over both venues while the only writer passed no venue and
always resolved `'unknown'` (live: the sole three series were `venue="unknown"`), so it fabricated 24
dead children **and the new spec pinned the inversion**; fixed at the writer, and `onVenueTp` had the
identical defect. `playbook_validator_rejections_total` was seeded at an unreachable pair.

### Gates, deploy, soak

Gates green at every commit: `format:check`, `lint`, `lint:md` 0 errors, `typecheck`, `build`,
`test` **3205/3205 across 176 files** (3147 at pass start), `test:livegate` **55/55**,
`promtool check rules` SUCCESS 23 rules. Deployed 11:02:19Z, boot `4a43ac63`, `RestartCount` 0,
`GIT_SHA=e091ba5` — `build_info{git_sha="e091ba5"}` confirmed; Prometheus force-recreated (rules
changed) → 23 loaded, 0 firing. **Soak: 0 alarms.** Verified live rather than inferred: every seeded
child publishing a true zero, including `reconciliation_runs_total{result="halt"}` on both venues;
`kill_switch_state` RUNNING; `agentic_consult_gate_total` now exports all six outcomes (three
before). The new banner correctly stays SILENT — the lane is not latched. Worth recording: the prose
banner in STATUS.md went stale within 90 minutes of being written, while the metric-driven banner
self-corrected. That is the "what wrote it" discipline paying out on the same day it was written.

### Research: loop-as-decider — NO-GO, with a positive recommendation

Owner-queued 2026-07-29, answered by a dedicated opus pass. **Verdict NO-GO on loop-originated
trading, live and demo, on evidentiary not mechanical grounds.** Free inference is a COST lever, and
the gate's own arithmetic bounds it: LLM spend is 68.3 bps/trip of an ~183 bps/trip deficit, so it
removes **37% of the requirement and 0% of its cause** — the residual gap is the 115–130 bps
`verdicts.md` already binds. For a loop decider to be anything else, its entries would have to beat
the production decider by **≥115 bps/trip**, against an incumbent measuring ~100 bps BELOW a
martingale; the one measured decider swap in this repo moved ~10 bps on a proxy. Two corrections to
the first-pass read: the promotion gate **is** decider-blind structurally (`fillsForMode` has no
decider predicate, unlike the existing replay exclusion) even though the data is decider-attributable
via `prompt_hash`; and a subscription decider **does not route around the funding blocker** — the
study's `aggregateVerdict` returns `INCOMPLETE` unless both declared models run, so it adds a
prerequisite in front of it. **Recommendation: fund the ~$110 frozen 12-arm replay study, not the
trading lane** — it is pre-registered, frozen, and decisive in both directions.

### Flagged / next pass

1. **The scheduler does NOT double-fire** — checked: `0 2,10,18 * * *` with 414s jitter, one fire per
   slot. Pass 47's open recommendation is closed. The 07-28 collisions came from interactive sessions
   overlapping scheduled ones, which the lease binds only if they call it.
2. **Two passes on 07-29 left no LOG entry**, and one left a lease dangling 12h. The loop cannot
   detect its own unrecorded passes; a sweep annotation comparing the newest digest against the
   newest LOG entry would close it. Not built this pass.
3. **A research agent wrote to the working tree** despite a read-only instruction (it was dispatched
   as `general-purpose`, which carries Write). Two out-of-scope files were reverted, copies
   quarantined. Read-only research must be dispatched to an agent type without write tools.
4. **`agent_last_success_timestamp_seconds` is now the single best lane-liveness read** — it caught
   the resumption within one scrape of the deploy, from the durable ledger, with no dependence on
   whether the client had tried yet.
5. **The funding question the owner now faces is not "is it funded" but "should the lane spend it"** —
   `verdicts.md` says the present entry signal cannot clear the gate, and Pass 48's research names the
   study as the better use of the next $110.
