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

## 2026-07-30 — Pass 49 addendum c (RECONSTRUCTED by Pass 50: three commits shipped and deployed, and left no entry)

**Window:** 2026-07-30T18:25Z → 22:19Z. **This entry was NOT written by the session it describes.**
Pass 50 reconstructed it on 2026-07-31 from commits, diffs, the loop records that session DID
update, and the digest its own deploy produced. Written so the window has a covering record and the
unrecorded-pass detector has an answer rather than a permanent annotation.

**What happened, plainly:** a session shipped `c23ab3a`, `61d6b6c` and `8d39363`, deployed the last
of them to production (boot `54cdb77a`, 22:18:08Z), and updated `STATUS.md`, `verdicts.md`,
`watches.md` and the follow-on study — but appended **nothing** to `LOG.md`. `git log -- LOG.md`
confirms it positively: the file's newest touch is `d0d91c7`, Pass 49's own records commit. This is
the second unrecorded-session occurrence in three days.

### What the three commits did

**`c23ab3a` — the decision-history ring was mostly noise.** The ring fed the model 30 rows with no
filter on `action`; of 405 sampled lines **382 carried `action:'error'`** — rows stamped for calls
that never reached the model at all. `PRE_CALL_DECIDE_RATIONALE_TAGS` and
`isModelAuthoredDecision()` were added to `decide-rationale.ts` to exclude them, keeping
`plan_authoritative_close:` rows because those are real decisions the system overrode.
`MAX_DECISION_HISTORY` 30 → 12. The tool schemas were unified for cache-breakpoint stability, and
the commit is explicit that the JSON got BIGGER and this is **not** a token saving.

**`61d6b6c` — the authoring pass, and a retired objective wearing a different name.**
`scripts/loop-authoring.mjs` + `loop-authoring-core.mjs` (1,280 lines) and a `loop:authoring` script:
the loop can now draft candidate playbooks itself. The finding worth keeping: the ANTI-RATCHET
objective retired in Pass 49 was fenced behind three `[RETIRED]` markers, and an X7 `postMortems`
paragraph **outside every fence** relabelled the same objective and told the model to treat a
rank-filter relaxation "as a strong prompt to act." The first implementation passed all four marker
assertions and still leaked it into the assembled prompt. It was caught only by scanning the
generated output — a fence that checks its source and not its product is not a fence.

**`8d39363` — three of six keys were not batch-invariant, and one would have been a correctness
bug.** Batch-invariant payload keys were hoisted behind a cache breakpoint. `liquidation` was
dropped from the plan because `LiquidationFeedPort.latest(symbol)` prunes a per-symbol buffer —
it measured 100% identical across 16 live waves only because those windows were quiet, and hoisting
it **would have attributed one symbol's liquidation cascade to the whole batch** the first time a
real one hit. `trackRecord` was 0% identical in 10 of 10 waves. Measured saving ~210-230 tok/symbol
against the ~839 the plan projected, and the commit retracts the larger figure itself: structural
invariance and incidental agreement are not the same thing. It also corrected `c23ab3a`'s own
headline — the 382-of-405 sample was taken DURING the provider outage; across the healthy week the
noise share is **13.2%**, so the ring trim is roughly cost-FLAT, not halved.

### What that session recorded elsewhere, which binds later passes

`verdicts.md` gained two entries — the preserved authoring prompt's dead-input paragraphs are NOT
trimmed (a falsifiable draft-scan check replaces the trim), and **PLAN STEP 14 IS NOT CLOSED**, its
closure argument failing on three measured counts including that the live `maxHoldBars` reads 48 on
5 of 6 declarations while nothing in this program has ever measured h=48. `watches.md` gained the
WATCH-V4-1 re-derivation (a second `adopt_non_adoptable` at 19:00:30Z; "stays 0" replaced by
"transient AND explained") and the WATCH-V4-10 structural finding that boot recovery excludes
algo-rail orders from `portfolio.openOrders`, so after any boot no reconciliation pass can fold a
perp algo stop terminal whatever the venue reports.

### What cannot be reconstructed, and one thing that was left wrong

Gone: whether this was one session or several, interactive or autonomous, and every rejected
alternative not already narrated in a commit body. Also absent is any independent artifact that the
claimed gates ran — there is no CI here, so the gate counts (3,166 → 3,217 → 3,232 tests) are the
author's own prose. Noted, not disputed: Pass 50 re-ran the full gate on the resulting tree and
found it green.

Left wrong and fixed by Pass 50: `STATUS.md`'s "Current order & status" still read `HEAD = live
build 61d6b6c`, boot `f30074f2` — **the state before that session's own deploy**. The pointer the
next pass reads first was stale in the same commit that made it stale.

---

## 2026-07-31 — Pass 50 (five defects on one rail, and the instrument that could not see any of them)

**Window:** 2026-07-31T00:07Z → 08:05Z. Lease taken 00:07:25Z (`9bf2dbae343a1910`). **The host slept
~7.5h mid-pass**; the 2h lease expired underneath the pass and a re-probe at 07:41:39Z broke a stale
lease carrying **its own label** and re-acquired as `504746bf0b6db4aa`. No other pass was live, and
the lease behaved exactly as documented — it is time-based and cannot detect a live holder. Recorded
because a future reader seeing two nonces for one pass deserves the reason.

**Sweep 00:07:32Z: 0 alarms**, one annotation (`ReconciliationMismatch`, warning, fired and resolved
in-window). §3's incident gate therefore did not bind, and the pass selected its own work.

### The book

| metric | Pass 49 (17:15Z) | this pass (07:50Z) |
| --- | --- | --- |
| closed round trips | 32 | **34** |
| net-of-cost | −$41.8850 | **−$44.2337** |
| win rate | 0.1875 | **0.2059** |
| LLM cost | $17.8605 | **$19.3709** |
| trade-anchored window | 6.966 / 14 d | **7.329 / 14 d** |
| `agentic_promotion_ready` | 0 | **0** |

Two trips closed overnight, one of them a winner. Realized PnL moved **−$0.82** and LLM spend
**+$0.99** — so the net-of-cost loss this window is mostly the cost of asking. `equity_usdt`
4976.77, kill switch RUNNING, RSS well inside WATCH-V3-1. **The lane is funded and trading:** real
model decides 669 → **722** lifetime.

### Pass type: defect repair. The improvement was crowded out entirely, and this is the second such pass

Six defects found, six fixed and shipped, one commit each — the playbook's "a pass that finds five
defects fixes five defects" applied literally. No candidate or promotion work was attempted. Per §4
that obliges a recommendation rather than a repeat, and it is in § Flagged below.

### 1. Five un-journaled cancels on one rail — WATCH-V4-10 root-caused, and the earlier suspect refuted

`59df4c9`, `a2d7d33`. The HYPE/USDT:USDT stop has now been `ACKED` ~11h across 3+ boots against a
flat book. Pass 49 suspected an undefined `entry` read after `clearPlan()`; **that is refuted** —
both live call sites snapshot `stopEntry` first.

The real shape is two mechanisms with one root. `reconcileOrphanedAlgoStop` **did** reach its
`fetchOpenAlgoOrders` call for HYPE on every bar — every guard between `decide()` and it is
satisfied — but its no-plan branch emitted nothing on any of its four outcomes, so "never matched"
and "matched, and the cancel threw into a bare `catch {}`" were indistinguishable **by
construction**. Meanwhile the BTC/USDT:USDT stop from 19:00:09Z **was** cancelled at the venue at
22:45Z by `drift_cancel` and is still non-terminal locally, because no algo-rail cancel was ever
journaled on any path. One rail: a cancel that never happens, and a cancel that happens and is never
recorded.

**Why it is money-path and not housekeeping:** a stale non-terminal algo order keeps its intent in
`inFlightIntents`, and `driveFlattening` marks a symbol BUSY off exactly that set. The HALT path is
simultaneously the producer of the stranding (`cancelRestingAlgoStops` cancels and journals nothing)
and its victim — `allFlat` never becomes true for that symbol, so **a HALT cannot complete for it
until the next boot**. Four such registrations were live when the pass started.

Fixed: every exit of the orphan reconciler now carries a label (12 → 15, zero-pre-seeded, the array
now derived from a `satisfies Record<AgentVenueStopEvent, true>` map so a sixteenth cannot miss the
seed), including `orphan_cancel_failed` — the label that makes a zero on `orphan_cancel` readable.
All five cancel sites now journal through the pre-existing `onAlgoStopGone` seam, which folds the
local row terminal by **appending** `algo-hist:CANCELED` — no UPDATE, no DELETE, rule 6 intact.

**The review earned its keep here.** The first implementation `await`ed that fold inline — between a
stop cancel and the exit signal built from it, and inside a reconcile path running on a **2s**
non-LLM budget whose overrun drops the bar and trips auto-DRAIN — against venue reads with **no
configured ccxt timeout** (10s default, per call). It declared FAILS OPEN and honoured that for
throws but not for latency. All five calls are now `void`, and a test pins that a rejecting seam
still emits the EXIT signal, so a reintroduced `await` fails loudly rather than silently re-breaking
the contract P7f fix 5 exists for.

**Stated so no later pass misreads it: this is prevention and measurement, not a heal.** The four
stranded rows will not terminalize — their cancels predate the seam. What ships is the ability to
say which failure is live: `orphan_scan` above zero with both cancel counters at zero means the scan
runs and never matches.

### 2. A truncated tool call and a rejected one were the same journal row

`daf8dbe`, `f9ed0ea`. Ten of 37 `decisions: expected array, received undefined` rejections in the
trailing 14 days carry `output_tokens` of **exactly 4096** — `AGENTIC_MAX_TOKENS`. Adaptive thinking
eats the whole output budget before any tool argument is written, the block arrives `{}`, and zod
reports a missing field. Both causes stamped `schema_rejected:`, so the journal could not measure
how often the lane loses a whole batch to truncation. `truncated_max_tokens:` already existed for
the no-block case and now covers the empty-block case on both paths — including the batch
`!toolBlock` branch, because batch is the deployed shape and leaving it out would have under-counted
truncations on the only path that runs.

Two review catches: the re-tag moves rows between `agent_decide_total{outcome}` buckets, which is
now declared and pinned by the `schema_rejected → hold` case the outcome-tag spec was missing; and
the replay harness carried a comment asserting parity with production that this change made false,
so the harness was taught the same rule rather than left silently disagreeing with live.

### 3. Two research harnesses that had been answering a different question than production

`f9ed0ea`, `3f215aa`. Both off the production gate, so both rotted unseen.

**A red spec nobody ran.** `agentic-replay.spec.ts` pinned `caps.leverage` at `'2'` while `.env.app`
has pinned `'5'` since the 2026-07-27 owner decision. That commit moved the harness fixture and its
own message required it — "or backtests answer a different question than production" — but missed
this assertion. The harness scores candidates that get promoted to the live lane, so the divergence
meant candidates scored against a sizing constraint the venue no longer enforces.

**A test run that rewrote a committed study.** `vitest run test/backtest/` silently overwrote
`research/studies/carry-study-2026-07-10.md`, 124 lines each way. That file is the evidence behind a
**settled** NO-GO. The rewrite replaced published evidence with weaker evidence: funding rows per
symbol **3250 → 31**, V 1.7369730 → 1.0255109, SR0\* 3.5943 → 2.7618, cells with ≤1 holdout episode
18 → 81. Under a green test run, invisibly; it was caught only by reading `git status`. The write is
now opt-in behind `CARRY_STUDY_WRITE=1` — fails CLOSED for writing, never for testing.

**And the collapse itself is a separate, still-open defect.** `fetchExtended()` in
`test/backtest/fetch-data.mjs` defaults `targetBars` to 200 — its own header calls that a smoke
fetch — and has **no `existsSync` guard**, so it overwrites a full-history cache with a smoke-sized
one. The cache proves it: `funding-{BTC,ETH,SOL,XRP}` are dated Jul 27 with 31 rows over 10 days
while `funding-{AVAX,DOGE,LINK}` are untouched from Jul 12 with 3250 rows over three years. Any
carry-adjacent measurement taken today runs on ~1% of its intended data.

### 4. The rail had no alert, and a dashboard that coloured nothing

`d2ab9fa`. `agentic_venue_stop_total` had **zero** alert rules, so `orphan_cancel_failed` — the exact
recurrence signature of the 11h stranding — could fire every bar forever and reach nobody, this
loop's sweep included. `AgenticOrphanStopCancelFailing` fires on more than one failure in 30m (a
single one is a venue blip the next bar retries; two means the same order failed on consecutive
bars). **Severity `warning` deliberately:** the counter was zero-seeded minutes earlier, and only
`critical` becomes a blocking sweep alarm — handing an unbaselined counter that power on day one
risks wedging every future pass on a threshold nobody has validated. The rule states what would
justify promotion.

A companion rule for the quieter failure — `orphan_scan` climbing while both cancel counters stay
flat — was **considered and rejected as premature**: that is also the healthy steady state for every
symbol with no stranded order. Separating them needs venue-side algo-order age against tracked
positions, which does not exist yet.

The dashboard's orange override never matched anything it was written for: its prefix alternatives
end in `_` followed by `\b`, and `_` is a word character, so the boundary never asserts. Verified
programmatically against all fifteen labels rather than by eye.

### Gates, deploy, soak

`format:check` ✓ · `lint` ✓ · `lint:md` 0 errors ✓ · `typecheck` ✓ · `build` ✓ · `test`
**3249 passed / 179 files** ✓ · `test:livegate` **55/55** ✓. Each commit additionally passed the
pre-commit hook. `test:cov` is red at HEAD and was **not** caused by this pass —
`reconciliation.service.ts`, `unknown-resolver.service.ts` and `position-sizer.service.ts` are the
sub-100% files under the two 100% globs and none was touched; `halt-coordinator.service.ts` is
100/100/100/100.

Deploy 07:47:51Z, `GIT_SHA=3f215aa`, `build_info{git_sha="3f215aa"}` confirmed on the running
process, `RestartCount` 0, healthy. Prometheus force-recreated (rules file changed): **22 rules
across 5 groups, 0 firing**, `AgenticOrphanStopCancelFailing` loaded `health: ok`. All 15
venue-stop labels zero-pre-seeded on **both** venues (30 children) — the exhaustiveness pin works on
the live process, not just in the type-checker.

**One honest caveat on the soak.** The 07:45:59Z pre-deploy sweep was VOID by its own controls: the
container had restarted 16s earlier as the host came back from sleep, so `bootId`, the rules probe
and the alert history all failed. That is duty cycle, not a defect, but it means this pass's
pre-deploy baseline is thinner than usual and the post-deploy read below is the load-bearing one.

### Soak addendum — the new instrument produced its first reading, and it discriminates

First decide bar after the deploy (08:00Z bar, read 08:01:13Z, boot `ae5df10b`):

```text
orphan_scan=16  orphan_readopt=4  orphan_cancel=0  orphan_cancel_failed=0  reconcile_error=0
```

on `binanceusdm`; `binance` reads 0 throughout, which is correct — the path is perp-only.

**WATCH-V4-11's expected-positive HOLDS on its first read.** 16 scans is one per perp symbol in the
universe on a single bar, so the no-active-plan reconcile path demonstrably executes; before this
pass that fact was unobservable.

**And it answers WATCH-V4-10's open question, which two passes could not.** The reading is
`orphan_scan` > 0 with **both** cancel counters at 0 and no `reconcile_error` — so the branch does
not throw, and case (d) is out. It runs and matches nothing. Crucially, `orphan_readopt=4` in the
same bar proves `fetchOpenAlgoOrders` **is** returning live algo orders and they **are** resolving to
our ids — four resting stops on positioned symbols were re-adopted. So the venue read works; it
simply does not return the HYPE stop.

**The most probable reading, stated with its alternative rather than as a conclusion:** the HYPE
`STOP_MARKET` is **gone at the venue and stranded only in our book** — which is the benign half of
the pair `watches.md` said was unanswerable from any scheduled read. The alternative it does not
fully exclude is an id-resolution mismatch specific to that one order, placed a day earlier by an
older build. The 4 readopts weigh heavily against that but do not kill it.

**The one probe that settles it** is a keyed `fetchAlgoOrderStatus(cbt019fb31cb7c97ea0a8dfa5462d3d3764,
HYPE/USDT:USDT)` — the primitive already exists on the adapter and has no scheduled caller. That is
the next pass's cheapest high-value action, and if it returns CANCELED/EXPIRED then the remaining
work on V4-10 is a fold of four stale local rows, not a venue problem.

### WATCH lines

V3-1 holds. V4-1 holds on its re-derived clause — the 19:00:30Z `adopt_non_adoptable` is transient
and explained (two binance `STOP_LOSS_LIMIT` ACKs 19-28s before the sweep), and the alert's 5 firing
samples are the `for: 0m` rule staying hot ~5 min after one event, not a sustained fault. V4-2 holds
(zero `fill_overflow` ever). V4-4 holds. V4-7 holds. **V4-10 is root-caused and instrumented but
NOT closed** — the stranded rows persist by design of the fix. New **WATCH-V4-11** (algo-rail
observability) and **WATCH-V4-12** (truncation tagging) in `watches.md`.

### Flagged / next pass

1. **The improvement was crowded out for the second consecutive pass, and the recommendation is not
   "try harder next time".** Five of six defects this pass were _invisible failures_ — a counter
   never emitted, a cancel never journaled, a study silently rewritten, a spec nobody runs, an alert
   that does not exist. The loop keeps finding these because nothing runs between passes that would.
   The cheapest structural fix is to put the off-gate harnesses (`test/backtest`, `test/eval`) on a
   scheduled run whose failure is surfaced by `loop:sweep`, so a rotted harness costs minutes
   instead of days. That is one commit and it is the highest-leverage thing available.
2. **`fetchExtended()`'s 200-bar default with no `existsSync` guard** — named in §3, not fixed
   (different file, different fix). It will keep truncating caches silently.
3. **`AGENTIC_PLAYBOOK_AB_PCT=40` still routes nothing.** Inherited from Pass 49 and untouched: mint
   a v11 candidate against `inverted` (`loop:authoring` now exists to draft one) or set the knob to
   0 and say so. This is the profitability decision this pass did not get to.
4. **The unresolved question underneath all of it.** Net-of-cost is −$44.23 over 34 trips at a 0.206
   win rate, and `verdicts.md` holds that entries measure significantly negative and worse than a
   random-bar placebo. This pass spent its whole budget making the lane *observable*, which was
   worth doing, and moved the edge not at all. An owner call remains open on whether a lane that
   provably cannot pass its own gate should keep accruing ~$1/day of evidence.

## 2026-07-31 — Pass 51 (78% of spot orders were rejected for a week, and the record named the wrong cause three times)

**Window:** 2026-07-31T08:04Z → 09:45Z. Lease `3df441c7653e14bd`, taken 08:04:35Z, no collision.

**Sweep 08:04:43Z: 0 alarms**, one annotation (`short_interval`, 645s gap — Pass 50's soak sweep was
11 minutes earlier). §3's incident gate did not bind, so the pass selected its own work. The four
checks the scheduled task mandates independently of the sweep were all green: `kill_switch_state`
RUNNING, clean-stamp 44s old, `agentic_budget_remaining_usd` $1.9708 of $3, real decides on the
current boot (newest 08:00:30Z), and `agent_client_latch_cause` zero on all three causes.

### The book

| metric | Pass 50 (07:50Z) | this pass (08:13Z) |
| --- | --- | --- |
| closed round trips | 34 | 34 |
| net-of-cost | −$41.8850 → −$44.2337 | **−$44.2755376844** |
| win rate | 0.2059 | 0.2059 |
| LLM cost | $19.3709 | **$19.4127467** |
| trade-anchored window | 7.329 / 14 d | 7.329 / 14 d |
| `agentic_promotion_ready` | 0 | 0 |

`equity_usdt` 4975.74, kill switch RUNNING, RSS 768 MiB — inside WATCH-V3-1's ~900 MiB bound but
the highest reading recorded; worth watching, not yet a signal.

### Pass type: defect repair. Third consecutive pass with no chosen improvement

Six commits, six defects, one commit each. §4 says a pass whose defect work crowds out the
improvement on consecutive passes must recommend what to change about the system rather than repeat
itself — that recommendation is in § Flagged.

### 1. Both spot protective legs fought over the same balance, and one always lost

`f5abf8a`. **binance spot: 156 submits, 122 `InsufficientFunds` rejects over 7 days — 78%.
binanceusdm: 135 submits, 3 rejects.** Every one of the 122 was a `reduce_only` SELL on SOL/USDT,
ZEC/USDT or AAVE/USDT. This had been running for a week and nothing in the loop treated it as a
defect, because a rejected order is not an alarm and the reject rate is not on any dashboard.

On spot, `manageVenueTp`'s `'vtp'` and `manageVenueStopSpot`'s `'vsl'` each size to 100% of the
position, and `reduceOnly` is DROPPED on spot (gated to the perp venue in the ccxt adapter), so both
are plain sells competing for the same free base. The two loops are role-scoped and blind to each
other by construction. In-flight suppression is one bar, so the loser re-attempted every 30 minutes.

The DB shows the contention directly: **the losing leg ACKs in the same second the winning leg goes
terminal.** SOL rested a TP from 07-23 23:45 to 07-24 11:45 while the stop rejected 18 times; the
stop ACKed at 11:45:03, the same second, and the TP then rejected 32 times until 07-25 03:46.

Root cause is a rule that was documented and never built: `.env.app` and `environment.config.ts` both
asserted that "a per-symbol rule (perp rests both legs, spot rests TP-only) replaces it in the
strategy lane (workstream #10)". `venueStopEnabled` is a single global boolean. Two comments
described a lane that did not exist — the same defect class this loop has now hit five times.

Spot rests the TP only. **FAILS OPEN:** when nothing rests, stand down, set `venueStopResting` false,
place nothing — the bar-close software stop stays armed. Deliberately the opposite of the naive
reading, because the placement was guaranteed to be rejected and a false belief that a venue stop
rests is the actual hazard. **Manage-only, not skip:** the already-resting path still scans,
confirms, drift-manages and cancels a legacy `'vsl'`. Early-returning would have re-created exactly
the stranded resting order WATCH-V4-10 spent the previous pass root-causing.

**The review overturned the first rationale, and that is worth recording.** The choice was initially
argued on "a spot `STOP_LOSS_LIMIT` can trigger into a thin book and fail to fill". Refuted: all four
spot stops that ever reached their trigger filled at or inside it, zero partials, within 1.3bps. The
78% was also misattributed to the stop leg alone — it is the COMBINED rate; per role it is vtp 86.6%
(97/112) and vsl 58.5% (24/41), and both are artifacts of the contention itself, so neither predicts
the post-fix rate. The surviving justification is narrower and is what the code now says: resting a
venue stop stands the software stop DOWN, so keeping it trades one control for one control.

Blast radius at deploy was nil — zero non-terminal `binance` orders existed, and the four open spot
positions are sub-dollar dust.

### 2. The cache fetcher could shrink a full-history series, and the recorded cause was wrong

`279713e`. Pass 50 named this defect and blamed `fetchExtended()`'s `targetBars` default of 200.
**That attribution is measurably wrong and would have shipped a non-fix.** The damage carries the
`targetBars=1000` signature — 1000 bars / 10.42d / 31 funding rows at 8h settlement, 62 at 4h,
observed exactly. 200 would give 2.08d and ~7 rows, a signature present nowhere on disk.

The real defect is that `fetchExtended` writes both caches unconditionally while its sibling guards
with `existsSync`. The decisive proof is a file that SURVIVED: `ohlcv-BTCUSDTUSDT-1h.json` is intact
at 26000 bars while `funding-BTCUSDTUSDT.json` sits at 31 rows — same symbol, same run. The OHLCV
write went to a tf-bearing filename and spared the 1h series; only the tf-less `funding-<SYMBOL>.json`,
whose span is secretly `targetBars × INTERVAL_MS[tf]`, collided.

`writeCacheNoShrink` now fronts both writes, FAILING CLOSED FOR WRITING. `targetBars` is required and
validated — which closes the maximal-damage case that was never the default at all: `Number('abc')`
is NaN, `bars.length < NaN` is false, the paging loop never runs, and an EMPTY array lands on a full
cache. Also corrected a committed truncation trigger in `bounds-calibration/run.mjs` that would have
truncated four still-intact 70080-bar series.

### 3. An annotation that promised disclosure was gated behind the liveness floor

`6cb028d`. `no_real_decides_in_window` documents itself as "visible every pass, for exactly as long
as it is true", but its push sat inside the `!intervalTooShort` branch, so on any sweep under 30
minutes after the previous one it was silent — including when a dead LLM lane was true. Three sweeps
ran on 07-31 at 07:45, 07:53 and 08:04 (gaps 478s and 645s), so across that 19-minute span the
reading was never evaluated once. The annotation now fires whenever it is true; the two genuine
delta-starvation ALARMS stay behind the floor, which is where they belong.

### 4. The scan journal dropped the two flags that make the menu auditable

`e75d78c`. `universe_scan` serialized `{symbol, rank, score}` while `RankedSymbol` already carries
`pinned` and `active`. **The active menu holds 14 symbols, not 8** — 8 ranked plus 6 pinned — and at
the most recent recompute the fresh top-8 was 7 perp and 1 spot while the per-venue floor did NOT
fire, because pins had already lifted spot's post-merge count above it. The playbook asks every pass
to confirm neither venue is starved of menu slots; that check was not answerable from either
instrument. It is now answerable from the journal.

Two changes were considered and rejected: altering the floor to evaluate pre-pin changes
consults-per-wake and therefore spend against the $3/day breaker, and widening the
`agentic_active_menu` gauge cannot work because 4 of the 8 ranked symbols are simultaneously pinned —
a single-valued `reason` label cannot represent them and a multi-valued one breaks the Grafana panel.

### 5. Three claims in the playbook that the code contradicts

`767688d`. The venue-floor paragraph said the floor tests the "fresh top-8" and the menu "may
transiently exceed 8 by ≤2" — both false; the pin path is unbounded by construction and the live menu
is 14. The cost sentence derives ~$2.40/day from menu-8 without saying the derivation is at
`menuSize`, not live cardinality, while `isActive()` gates spend directly. And the `probe_failed`
citation "~L182-220" was stale for the **third** time on the same sentence; replaced with a
shape-anchored reference that cannot rot. The §3 alarm list itself was verified EXACT against the
code, both directions, and is unchanged.

### 6. `test:cov` had been red for six days, and nothing on the green path ran it

`400c08e`. Shipped during the soak rather than deferred. 3249/3249 tests passed the whole time —
every failure was a threshold. **Three** failing scopes, not the two on record: global `functions`
89.92%, plus the risk and execution 100% globs. Red since `651aa2a` on 2026-07-25 across five
commits, four of them `fix(...)` that each added a branch without its test.

The global failure was a measurement-scope error, not missing tests: untested ops entrypoints under
`scripts/` sat in the denominator because the coverage `exclude` listed `src/database/**` and stopped.
Four entrypoints are now excluded BY NAME — deliberately not a blanket `scripts/**`, which would also
have dropped the four `*-core.mjs` files that are genuinely test-driven at 92-100%.

14 new tests close the real gaps, none removed (3253 → 3267). `reconcileTerminalFor`'s
`rejected`/`expired`/`closed` arms had never executed; `closed` is written twice so the inline
fail-closed claim about the reducer's cumQty guard is finally verified.

**Four branches are annotated `/* v8 ignore next */` rather than tested, and two of those four were
not pre-authorized when the work was scoped.** An annotation makes a number green without adding
verification, so this is disclosed rather than buried: each carries a checkable reachability argument
and they are worth spot-checking. (`istanbul ignore` would have been inert here — this repo's
coverage provider is v8, which the first proposal got wrong.)

**The structural cause is NOT fixed and is the more important half.** `pnpm test` and `pnpm checks`
still omit `--coverage`, so the mandated 100% globs stay advisory on the green path. Putting
`test:cov` on the completion gate is a live candidate, blocked on nothing but a decision.

### What the evidence actually says about profitability — the most important finding of this pass

The −$44.2755 decomposes, reproduced independently from raw DB rows against a read-only replica of
`walkRoundTrips` that matched every promotion gauge to the digit:

| term | amount | share |
| --- | --- | --- |
| realized | −21.7646871 | 49.16% |
| LLM | −19.4127467 | 43.85% |
| fees | −2.8584132944 | 6.46% |
| funding | −0.23969059 | 0.54% |

**Gross trading is negative (−$24.8628), so cutting LLM spend to zero can never make net-of-cost
positive.** LLM is a tax on a losing edge, not the cause of the loss. The exchange account is down
only $24.886 from peak — 44% of the headline loss never touches the venue.

**And the window, not the trip count, is now the binding constraint.** Trips are 34 against a floor of
30. `windowStart` pins to the first closed round trip at 2026-07-23T18:00:26Z (verified against the
DB: first post-epoch fill 2026-07-23T15:45:22Z), so the 14-day floor cannot be met before
**2026-08-06T18:00Z** no matter what happens. For `promotion_ready` to be 1 then, net-of-cost must
cross zero by then: **+$56.90 to +$63.88 over 6.4 days, i.e. +5.7% to +6.4% on the $1000 effective
book** — about +$2.48 to +$2.79 per trip against a trailing −$0.7207. **The gate is not reachable on
this edge**, and it gets ~$3/day harder every day the breaker is spent.

LLM pace is AT the breaker and is not a boot artifact: hourly spend on 07-31 was flat 0.048–0.153/h
across 00:00–07:00Z, all pre-dating the 07:47Z boot, extrapolating to $3.06/day whole-day or $2.93/day
off pre-boot hours only. Only **5.4% of wakes consult** (205 of 3798 gate outcomes in 24h), and of
those only 21 are the organic schedule — 116 are `forced_move` and 48 `forced_fallback`. **The timing
knobs, not the model, set the bill.**

### Corrections to the record

Five claims died this pass, four of them the loop's own:

- The cache truncation is NOT the `targetBars=200` default (STATUS and Pass 50's entry both said so).
- The 78% spot reject rate is NOT the stop leg's rate; it is the combined rate across both legs.
- A spot `STOP_LOSS_LIMIT` does NOT fail to fill — 4/4 filled within 1.3bps of trigger.
- `agentic_active_menu`=14 is NOT a leaking gauge (my own first hypothesis). The gauge resets
  correctly; the menu genuinely holds 14 and the doc's ≤10 bound was the wrong artifact.
- The `reconciliation.service.ts:818` guard is NOT a money-path polarity hazard. It is a scoping
  pre-filter; every trade passing it is independently re-resolved, and an inversion fails surfaced.

### Gates and soak

`format:check`, `lint:md`, `lint`, `typecheck`, `build` green on every commit. `pnpm test` **3267
passed / 179 files** (from 3249: +4 on the spot fix — anti-strand, fail-open pin, role-mixing,
double-rest invariant — plus one vacuous test restored to discriminating, and +14 on the coverage
repair). `test:livegate` 55 passed — untouched. `eval:agentic` 53 passed / 16 skipped, at baseline.
`test:cov` exits 0 for the first time since 2026-07-25.

The suite count was verified by measurement, not arithmetic: stashing the two coverage spec files and
re-running gave 3253 against 3267 with them, confirming +14 added and none lost.

Deployed `f5abf8a` at 09:27:23Z, `build_info{git_sha}` confirmed on the running process,
`RestartCount` 0, healthy, kill switch RUNNING, all 30 `agentic_venue_stop_total` children
zero-pre-seeded on both venues.

**Soak verdict: no regression, and the fix is NOT yet confirmed. Both halves matter.**

Sweep at 09:52:43Z on boot `58e3ee87`: **0 alarms**, one annotation (`boot_changed`, expected after a
redeploy). 22 Prometheus rules loaded, 0 firing. Real decides flowing (728 lifetime, newest
09:30:28Z). No fatal, no error. The two gauges that read 0 at boot both recovered:
`reconciliation_last_success_timestamp_seconds` 63s old and `agentic_budget_remaining_usd` $1.8883.

**But the expected observable for the spot fix could not be exercised, and the obvious reading of the
data is a trap.** `InsufficientFunds` since deploy is 0 — and it was ALSO 0 for the six hours BEFORE
the deploy, against 32 in the prior 24h. The last spot position closed at 01:54Z, so there is no
position to protect, neither leg is being placed, and the contention cannot recur either way. Under
§C.9 that post-deploy zero is a **VOID NEGATIVE READ**, not evidence. The fix is verified by tests and
by the review, not yet by production. WATCH-V4-13 below carries the real check.

A 35th round trip closed during the soak: net-of-cost **−$42.3358** (from −$44.2755), realized
+$1.94, equity 4978.33. One trip is n=1 and does not move the reachability arithmetic above.

**New this boot, not chased:** 2 warns of the shape `anthropic api: symbol <SYM> missing from` for
KAITO/USDT:USDT and UNI/USDT:USDT — the model omitting symbols from a batch response. Not an alarm,
first appearance, recorded for the next pass rather than investigated at the end of this one.

### Flagged

**Three items are hook-blocked, not deferred by choice.** A global PreToolUse hook blocks all `.env*`
edits and this was an unattended run, so no agent could approve one. Exact proposed diffs:

- `.env.app:153` — `# venue-resting protective stop (spot: STOP_LOSS_LIMIT; perp: STOP_MARKET algo
  rail)` is now FALSE for spot. Proposed: `(perp: STOP_MARKET algo rail; spot: manages/cancels a
  legacy resting order only — never places one, since f5abf8a)`. Note `.env.app:150` needs NO change:
  its "a per-symbol rule (perp rests both legs, spot rests TP-only) lives in the strategy lane now"
  became TRUE with this commit.
- `.env.app:159` — `AGENTIC_PLAYBOOK_AB_PCT=40` routes NOTHING and has since v9 was superseded. Proven
  this pass: active version is 10, the only row above it is v11 `source='promotion'` which
  `CANDIDATE_SOURCES` excludes, and all 109 sonnet decides since v10 activation carry
  `playbook_version=10` with zero exceptions. **Decision: set it to 0** — the board should not
  advertise a 40% split that is empirically 0/100. Minting a v12 candidate instead was considered and
  rejected: at ~22.9 projected trips a 60/40 split gives ~9 candidate trips across ~8 symbols, so the
  evaluator's paired-trip floor is unreachable inside the window and it would fail closed anyway,
  while putting 40% of the one pooled number under an unvalidated playbook during the exact 6.4 days
  it must swing +$57. Revisit only once the spot exit path has a measured trip rate. Note
  `maxVersion()` is 11, so the next mint is v12, not v11.
- **The owner question this pass sharpens rather than answers.** `verdicts.md` already records that
  entries are worse than a random-bar placebo. This pass adds the arithmetic: the gate needs +5.7% to
  +6.4% on the book in 6.4 days against a trailing −$0.72/trip, and ~$3/day of evidence spend makes it
  harder daily. Whether a lane that provably cannot pass its own gate should keep accruing that spend
  is unchanged as an owner call — but it is now quantified.

**`test:cov` was RED at HEAD for six days and is now GREEN** — see § 6 below. It is listed here only
because the mechanism is a standing hazard rather than a one-off: `pnpm test` and `pnpm checks` omit
`--coverage`, so the mandated 100% globs remain advisory on the green path even now. Nothing stops
the next branch-without-a-test from landing the same way.

**WATCH-V4-10 is unchanged and its named next action did NOT happen.** STATUS named a keyed
`fetchAlgoOrderStatus(cbt019fb31cb7c97ea0a8dfa5462d3d3764, HYPE/USDT:USDT)` as the cheapest
high-value action. It was dispatched as one of seven parallel investigations and that agent died
without returning a result. Six of seven returned; this is a partial fan-out and is reported as such
rather than quietly dropped. The venue-truth read remains the closure condition.

### The §4 recommendation, owed after three consecutive repair passes

Passes 49, 50 and 51 all shipped defect repair and no chosen improvement — five, six and five defects
respectively. The pattern is not bad luck and the fix is not "try harder to pick an improvement".

Every defect this pass found was **invisible by construction**: a 78% order-reject rate that no alarm
watches, an annotation gated behind the floor that hid it, a journal that dropped the fields needed to
audit it, a cache that shrank silently, and a coverage gate that has not run on the green path for six
days. The loop keeps finding these because it is the only thing that looks, and it looks by hand.

The recommendation is therefore backlog #54, promoted to the next pass's chosen improvement: put the
off-gate harnesses and the reject/rank/coverage counters on something that surfaces its own failure
through `loop:sweep`. Specifically, the cheapest high-leverage instrument this pass can name is an
alarm on **venue order-reject rate by venue** — a 78% reject rate sustained for a week should not
require a pass to go looking for it in `order_events`.

### Next-pass candidates

1. **WATCH-V4-13** (below): confirm the spot fix on the first real spot entry. This is the only
   outstanding verification of a shipped money-path change.
2. The keyed `fetchAlgoOrderStatus` venue-truth read that did not happen — closes WATCH-V4-10.
3. Put `test:cov` on `pnpm checks` so the 100% globs stop being advisory — the structural cause
   `400c08e` did not fix.
4. Reject-rate alarm (§4 recommendation above).
5. The `anthropic api: symbol <SYM> missing from` warn — first appearance, unexplained.

## 2026-07-31 — Pass 52 (three instruments the loop never had, and the bar it gates on was never derived)

**Window:** 2026-07-31T09:52Z → 12:34Z. **RECONSTRUCTED by Pass 53**, not recorded by the session
itself — being owner-directed rather than scheduled, it wrote no `**Window:**` line, and one missing
line blanks the WHOLE sweep-coverage verdict by construction (`classifyUnrecordedSweeps` treats any
unparseable entry as making every gap unattributable). Bounds are evidence, not memory: first and
last digests of the session, `sweep-2026-07-31T09-52-43-609Z.json` → `sweep-2026-07-31T12-34-11-885Z`
(the post-deploy soak), bracketing the nine commits `b28e54b` 12:19:11Z … `c78d193` 12:32:07Z.

**Owner-directed session, not a scheduled pass.** Seven commits `b28e54b` … `fd4e389`. Full gate
green: format/lint/lint:md/typecheck/build, **3384 tests / 183 files** (from 3267/179), livegate
55/55, `eval:agentic` 62 passed, `test:db` 4 passed, `test:cov` 94.22/88.05/92.82/95.61 against
90/85/90/90. First pass in four that is not only defect repair.

### What shipped

**Three instruments (`f60c79a`).** `loop:forward-return` measures REALISED entry forward return and
closes WATCH-PLAYBOOK-V10-1's instrument gap — `inverted` shipped on a replay prediction and nothing
checked it. It needs no new data: `agent_decisions` is already a dense 15m price grid. **One premise
correction that would have silently corrupted it:** `trigger_kind='exec'` rows are NOT bar-aligned
(an ExecReport's eventTime is a fill time), so both queries filter to candle triggers and the core
independently refuses off-grid rows. First reading: v10 **UNDERPOWERED at n=4/clusters=4**, which is
the expected output. Plus a per-venue reject alarm (backlog 55) and an off-gate harness monitor
(backlog 54) — both closed.

**Four defects.** The 2026-07-10 incident configuration was still in CI, disarmed by one assertion,
with `drizzle-adapters.spec.ts` carrying no wall at all (`b28e54b`). A REJECTED algo stop normalized
to UNKNOWN — the one status `recoverIntent` never folds (`c3a7253`). Forward return walked array
indices, so the 60-hour outage made h=24 a different horizon (`df58436`). The registry gate opened on
scratch DBs and closed on production, which is why `loop:authoring` had never minted and could not
have (`633f901`).

**The deployment bar gained a chronological-halves clause and the authoring pass a once-per-UTC-day
ceiling (`0ee5947`)**, both pre-registered before the code.

### Three recorded claims that turned out to be wrong

1. **WATCH-V4-10's root cause.** The breach was real; the recorded cause was not. Reconciliation axis
   1 is regular-rail BY CONSTRUCTION and `fetchOrder` on an algo coid throws `-1102`, so the
   recorded fix would have minted permanent `adopt_query_failure` noise every 30s while folding
   nothing. Venue truth: REJECTED / "Reduce only reject", fired 4m08s after flat, no spawned order.
2. **The break-even floor was never derived.** +13.0/+24.2 enter the repo fully formed in `7b3e977`
   with no operands; "BEST achievable cost structure" is defined nowhere and every later citation is
   circular — one points at the Moonshot HTTP-200 verdict. Measured demo cost is **9.29 bps/round
   trip**. No verdict moves (gap 111–126, not 115–130), but the h=1 inversion bullet now reads +7.6
   net rather than −3.1 and is amended.
3. **The research bar is CLUSTER-limited, not n-limited.** At h=1/4 it is unreachable at ANY cluster
   count — the best mean ever observed is below the fee floor and `mean > floor` is α-free and
   n-free. h=8/24 need 64–219 clusters against a 40-symbol universe.

### Two things left open on purpose

**The alarm fires and was not tuned.** `venue_reject_rate_high [binance]` 16/20 = 80% is a TRUE
finding — every submit in the window predates the fix, and the alarm correctly refuses to call an
unrefuted 80% clean. It self-clears. STATUS carries a do-not-investigate banner.

**Family B is blocked.** `assertDesignMatchesCorpus` fails CLOSED and the on-disk corpus hashes
`030367ba…` against the `f1dd13c6…` every artifact records. Payload bytes match the live DB 386/386,
so the cause is unpinned row order among `event_time` ties. **The hash was deliberately NOT
re-pinned** — that would discard which corpus the published results belong to. The choice between a
deterministically re-ordered corpus and accepting the 20 cells as recorded-but-unreproducible is
open.

### Method note

Nine parallel agents over disjoint file scopes. **Three agents corrected load-bearing claims the
orchestrator passed down as established** (the algo-stop root cause, the corpus one-bar premise, the
`horizonDependent` definition), and two caught bugs the orchestrator's own spec would have created —
an API-key check placed after the day-slot claim, and `Number(null) === 0` reading as 1970 and
PROCEEDING in a gate declared fail-closed. Also learned: the husky pre-commit hook validates the
WHOLE repo, so no commit can land while any peer has the tree mid-edit.

**Deploy is DUE** — HEAD is seven commits ahead of live `f5abf8a` and this time the delta is runtime.

_(Pass 53 note: that deploy DID happen at 12:33Z, and the commit count above is off — `b28e54b`…`fd4e389`
is eight commits, nine counting the `c78d193` docs commit, not seven.)_

## 2026-07-31 — Pass 53 (a position that could not be exited, and the 45 minutes nobody could have seen)

**Window:** 2026-07-31T16:07Z → 17:15Z. Lease `195186b5400588b5`, taken 16:07:30Z, no collision.
Pass type: **DEFECT INVESTIGATION** — forced by §3, two named alarms. Live build at pass start
`c78d193` (deployed by Pass 52 at 12:33Z, after that pass wrote its STATUS; the "A DEPLOY IS DUE"
banner was already stale when it was read).

### Headline

| metric | now | at Pass 52 |
| --- | --- | --- |
| closed round trips | **37** | 35 |
| net-of-cost PnL | **−$40.7534** | −$42.3358 |
| LLM cost (epoch) | $20.598 | $19.41 |
| trade-anchored window | 7.891 / 14 days | 7.329 |
| win rate | 27.03% | — |
| `agentic_promotion_ready` | 0 | 0 |
| `equity_usdt` | 4981.69 | 4978.33 |
| day budget left at 16:07Z | $0.786 of $3 | $0.978 |

**WATCH-V3-1 holds.** RSS 752.4 MiB (788,971,520 B) at 3.6h into the `93e21a99` boot — _below_ Pass
52's 763 MiB reading, against the ~673 MiB paper reference and the ~900 MiB defect line. Not a climb.

### The alarm that mattered

`loop:sweep` fired `venue_reject_rate_high` on BOTH venues. `binance` 16/20 is the known pre-`f5abf8a`
window (unchanged, all 20 submits predate the fix; still clears itself). **`binanceusdm` 12/20 = 60%
was new, and it is a real trading-path defect.** Full forensics:
`research/loop/incidents/2026-07-31-perp-exit-band-rejects.md`.

Between 13:00:36Z and 13:06:10Z the app made 13 attempts to exit a 70.3 KAITO/USDT:USDT long. Twelve
were terminal-rejected `BadRequest -4024 "Limit price can't be lower than X"`; the thirteenth
stranded (`SUBMIT_AMBIGUOUS` → `QUERY_NOT_FOUND` → `STRANDED_NEW_NEVER_LANDED` at 13:11:14).

**The cause is a frame mismatch, not a pricing bug.** `market-streams.module.ts:77-79` builds market
data against `FEED_ENV=live` while orders execute against `SANDBOX_ENV=demo`. Binance `-4024` is the
`PERCENT_PRICE` SELL lower bound evaluated against **the venue's own mark**, and the demo perp book
was stalled 5.7% above the live tape (demo 5m volume 281–300 vs production 223k–644k). Reconstructed
to six decimals off testnet `markPriceKlines`: mark 1.124900 × `multiplierDown` 0.9500 = 1.068655 —
the exact floor returned at 13:01:09, 13:01:39 and 13:04:40. **Our reference price was itself below
the floor on all 12 attempts** (shortfall 10.6–39.4 bps), so `EXIT_CROSS_BUFFER_BPS=25` was 40–70% of
each shortfall but removing it prevents **zero** rejects. There is no venue price-band clamp anywhere
on the order path: `SymbolFilters` carries only tick/step/minQty/minNotional, `PERCENT_PRICE` appears
nowhere in `src/`, and `evaluate.ts:174-194` measures deviation against **our own** `refMid`.

**The cost was not the rejects.** The first attempt was a `plan exit: stop`, so `cancelFirstEligible`
cancelled the resting `STOP_MARKET` at 13:00:38.029 — two seconds after the signal and _before_ the
replacement was known to be accepted — and `clearPlan()` dropped the plan stop. The position carried
no venue stop and no plan stop until 13:45:34: **45 minutes**. A second, independent gap: the stranded
order held `inFlightSymbols`, which suppressed the 1s protective backstop entirely from 13:06:40 to
13:11:14. A third: `protective_exits_total` counts FIRES, not fills, so it read a healthy `12` while
nothing exited, and the retry cooldown stamps on fire — hence 30s forever, no backoff, no cap.

**Mitigating, and it cuts both ways:** the cancelled stop's trigger (1.0797) was priced off the LIVE
feed and could never have fired against a demo mark of 1.1249. The protection lost was already
notional on this venue split.

### What shipped

1. **`VenueTerminalRejectBurst`** (`observability/alerts.rules.yml`) — `sum by (code)
   (increase(orders_rejected_total{stage="exchange"}[15m])) >= 3`, `for: 5m`, **`severity: warning`**.
   Warning is load-bearing: the sweep promotes only `critical` to a blocking alarm, and a critical here
   would wedge §3 on a self-resolving condition. Threshold checked against both known reject axes — the
   13:00Z hour spikes to 12 (fires); the spot `InsufficientFunds` bleed runs a measured 2/hour (does
   not). Fails OPEN. `WATCH-V4-14`.
2. **The reconcile guard stopped shouting.** 214 warns/3.6h of "reconcile pass still in flight" is
   expected behaviour confirmed by three verifiers: one pass costs ~38.6s p50 (binance 22.04 +
   binanceusdm 16.62, n=479 over 4h) against a 30s timer, so the measured gap between COMPLETED passes
   is 60.00s p50 / 90.46s max over 239 intervals. Demoted to `debug`; visibility stays in
   `reconciliation_runs_total{result="skipped"}`, which `ReconcilerStalled` deliberately excludes
   (`a03b35d`). Also corrected `trading-runtime.module.ts`, which called 30s the cadence — it is the
   timer period, and mismatch-detection latency is ~60s.
3. **The sweep can audit its own coverage again.** Pass 52 left no `**Window:**` line (owner-directed
   session), and ONE unparseable entry blanks the WHOLE verdict by construction. Reconstructed from
   evidence — first/last digest of that session bracketing its nine commits. Its non-vacuity test then
   failed honestly, because the reconstruction closed the gap it was exercising; the `4 ×
   PASS_WINDOW_END_TOLERANCE_MS` bound was arbitrary and its premise ("a 3×/day cadence always leaves
   hours between passes") is false once passes run back-to-back. Tightened to the **derived** bound: a
   midpoint orphan escapes iff gap > 2 × tolerance. Still a real guard — it fails if entries ever close
   to within an hour.

### WATCH-V4-12 — first reading, expected-positive CONFIRMED

The `submit_portfolio` warns are two unrelated failures with opposite verdicts. The "payload failed
schema validation" class is **output-budget truncation**, correctly re-tagged. Measured:

| tag | rows (boot) | `output_tokens` (boot) | rows (14d) | at exactly 4096 |
| --- | --- | --- | --- | --- |
| `truncated_max_tokens:` | 7 | min = max = **4096** | 11 | 7 |
| `schema_rejected:` | 8 | 168 – **358** | 137 | 12 |

Every measurable `truncated_max_tokens:` row carries exactly 4096; **zero sit "well below 4096", so
the named defect outcome did not occur.** Disclosed rather than counted: 4 of the 11 carry NULL
`output_tokens` (usage is recorded on a batch's first symbol only) — unreadable, not contradicted.

**The obvious response was refuted and must not be re-proposed.** Raising `AGENTIC_MAX_TOKENS` to
12288 is adversarial to the one budget currently ~30% from tripping (the $3/day USD breaker, not the
token/day cap), and the batch HTTP budget is 75s against a projected ~83–91s at that ceiling — an
abort THROWS rather than soft-holding, and three strikes auto-DRAIN the lane. The stated fallback
(`thinking: {budget_tokens}`) is a 400 on this model, and 400 is in `FATAL_STATUSES` — an immediate
latch. The in-contract lever is `output_config: {effort: …}`, which appears nowhere in
`anthropic-agent-client.ts`, so the lane pays for default thinking depth. Cost-negative and reversible;
that is the experiment to run, not the ceiling raise.

### Gates, deploy, soak

`format:check` ✓ · `lint` ✓ · `lint:md` 0 errors ✓ · `typecheck` ✓ · `test` **3384/3384, 183 files** ✓
· `build` ✓ · `test:livegate` **55/55** ✓. Deployed `35042cc`, `build_info{git_sha}` confirmed,
new bootId `4753ef53`, `RestartCount` 0, healthy. Prometheus force-recreated (the rules file changed):
**23 rules loaded**, 0 unhealthy, `VenueTerminalRejectBurst` present, none firing. Kill switch RUNNING.

**A trap worth recording.** `promtool check rules /etc/prometheus/alerts.rules.yml` FAILED mid-pass
with "line 448: found unexpected end of stream", which reads exactly like a corrupt rules file. It was
not. A host-side rewrite of a **single-file bind mount** leaves the container's path pointing at a
dangling inode — the committed bytes parsed cleanly (22 rules) and all 22 running rules were healthy
throughout. Validate an edit by `docker cp`-ing it in and checking the copy; a check against the
mounted path after a host edit is VOID.

### Not done, and why — stated as a blocker, not a priority

**The `-4024` repair itself did not ship.** This is a blocked state, not a scheduling choice. The
leading sub-fix ("retain the plan-stop registry row until the exit is accepted") was **refuted on
evidence**: `manageVenueStop` is gated on `this.activePlan`, not the registry, so retention re-arms
nothing, and it would additionally disable the `orphan_readopt` recovery path and make the stand-down
defer to a stop that does not exist. The two correct seams (defer the algo-stop cancel until the exit
ACKs; or a plan-independent re-arm) both require first resolving the margin/base-lock rationale at
`agentic.strategy.ts:1434-1438`, and the root cause sits behind a `FEED_ENV` choice with a very wide
blast radius. Shipping a half-understood lifecycle change on the protective-exit path is the specific
thing this repo's rules forbid. The exact proposed diffs, the refutation, and the two corrections
(`-4023` not `-4025`; prefer a `markPrice × multiplierDown` bound over parsing the venue's error
string) are in the incident note.

**CANDIDATE was not run and today's authoring slot is still UNSPENT** — the incident gate took the
pass. Worth flagging loudly: `loop:authoring` has **never minted, 0 `playbook-authoring-attempt` rows
lifetime**, because the registry gate `633f901` fixed in Pass 52 made it impossible. That fix is
therefore **unverified**, and `WATCH-DEPLOY-HALVES-1` sits at SAMPLE ZERO for the same reason. The
first authoring run is the highest-value single action available to the next pass.

**One investigation returned nothing.** The fourth agent (RSS trajectory + menu-composition/pin-leak
audit) died on its structured-output contract after 52 tool calls. RSS was re-read directly and holds;
**the pin-leak question — whether any of the 14 active-menu symbols is pinned with no open position
and no resting order — is UNREAD**, and an unread check is not a passing one.

### Next-pass candidates

1. `loop:authoring` — unspent slot, unverified `633f901`, SAMPLE-ZERO watch. First.
2. Quantify the demo/live divergence across all 37 closed round trips. The divergence is **episodic,
   not a standing offset** (3 bps apart at this trip's entry, 21 bps at its partial exit, 572 bps
   during the stall), so "demo PnL is fictional" is NOT supported by this incident — but how much
   recorded PnL is attributable to decoupling is unmeasured, and it conditions the whole promotion
   scoreboard. Worth more than any single fix above.
3. The `-4024` repair, via one of the two correct seams.
4. The pin-leak audit the failed agent owed.
5. `output_config: {effort: …}` as a cost-negative truncation experiment.
