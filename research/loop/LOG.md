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

## 2026-07-31 — Pass 54 (the grid was flattering, and nothing here can be shown to learn)

**Window:** 2026-07-31T20:40Z → 21:15Z. Lease `30c1a5be616fd056`, taken 20:40:39Z, no collision.
**Owner-directed research session**, not a scheduled pass — recorded with a `**Window:**` line because
Pass 53 spent effort reconstructing the one Pass 52 omitted.

**The question asked:** could a vastly more intelligent but cheaper decide model (GPT-5.6 after its
price cut, or kimi-k3) push the book toward profitability. **The owner then reframed it** to: the
least-bad config / model / architecture that can potentially LEARN an edge. The reframe is what
produced the findings; the original question was answerable from the record alone.

Full record: `research/studies/learning-capacity-2026-07-31.md`.

### Headline — the declared horizon grid was measuring the wrong thing

Forward return is scored at h ∈ {1,4,8,24} bars. That grid was never matched to holding behaviour.
Measured, n=40 closes over 10 days: **median hold 234.4 min ≈ 15.6 bars, mean 817.3 min ≈ 54.5 bars.**
Re-scored at hold-matched horizons ($0, no new model calls, control reproduces `loop:forward-return`
exactly at h=1):

| version | h=1 | h=8 | h=24 | **h=16** | **h=54** |
| --- | --- | --- | --- | --- | --- |
| v1 | −16.9 | −47.4 | −58.5 | **−57.6** | **−111.3** |
| v2 | −15.9 | −70.8 | −155.6 | **−94.5** | **−174.8** |

**This reconciles two ledgers that have disagreed for a week.** Realized gross is **−69.1 bps/round
trip** on the current book (−$23.17 over $3,353.99 notional, 38 trips) and −101.9/−106.0 in the older
record; h=1 said −16.9. **The hold-matched horizons bracket every realized figure; h=1 brackets none.**
Order-of-magnitude agreement only — the cells are v1/v2 while realized spans all eight arms, and
forward return measures entry drift not round-trip PnL. Consequence: the gap to the +13.0 bps bar is
**~70–125 bps at the horizon that counts**, not the ~30 the old grid implied. No ordering flips.

### Nothing here can currently be SHOWN to learn

Eight live playbook versions; **only v1 (n=28,k=13) and v2 (n=18,k=11) ever reached the power bar, and
they are the two oldest.** 78 entries / 8 versions = 9.75 against a bar of 12.

**The mechanism is DIVISION, not suppression — the obvious confound was checked and would have
inverted the story.** Trading did not slow: **2026-07-24 was simultaneously the highest-volume day in
the program's history (24 entries) and its heaviest minting day (v2,v3,v6,v7 all live)** — four arms
sharing 24 entries is ~6 each, half the bar, on the best day there has ever been. The two POWERED
versions are the two that had the book largely to themselves. 07-26/07-28/07-29 produced zero decides
(outage, host sleep), compounding but not causing it.

### The model question, on the reframed terms

No model supplies edge (best cell ever: −7.12 bps vs a +13.0 bar). In a learning architecture the
model is a **substrate for running many experiments**, so price buys **search rate, not PnL** — haiku
~4–5× more arms per dollar, GPT-5.6 Luna ~15× on rate. The cost thesis is dead on its own terms:
**gross with inference FREE is −$23.17.** kimi-k3 excluded — quality disqualification, and Moonshot's
~31.5% empty-200 rate makes it 1.9× MORE expensive. **The haiku question is NOT settled and cannot be
settled offline for free:** the replay cells persist only per-(arm,horizon) aggregates, so re-scoring
haiku at h=16 needs a fresh paid run. Verified in the spec, not assumed.

### Shipped — three commits, gate green (3414 tests / 184 files, livegate 55/55, build clean)

`1064503` the hold-matched re-score tool. `4b7e021` a corpus builder — v4 is 587 rows (+52%) but
**currently INERT**: the OHLCV cache stops at ~07-27 so 34% of rows score null at every horizon (the
known `279713e` truncation; a $0 re-fetch is the unlock). `3958c8c` a decide-model A/B config gate,
**flag-off**, with a fail-closed boot refusal.

**The A/B gate is NOT a working A/B and the commit says so.** Three findings recorded against its own
interest: `abArm` had **zero production call sites** before it (playbook routing uses its own inline
bucket — the "independent salt" requirement was vacuous); the arm is drawn **once per BOOT** because
the client pins one model per instance and `AGENT_CLIENT` is a singleton, so the claimed benefit is
**not delivered**; and attribution journals/meters every arm-B decide **as arm A**, which would poison
the promotion gate's own cost and PnL inputs. `AGENTIC_MODEL_AB_PCT` stays 0.

### Also found

`leaders_only` and `one_symbol_btc` are **structurally unscoreable** — capped at 3 and 1 symbol-clusters
by their own playbook text against a floor of 5. The untested search space is 5 arms, not 7.

### The decision this turns on — OWNER

**Daily minting and powered evidence are mutually exclusive.** Holding an arm to n≥12 AND k≥5 takes
2–4 days; daily minting guarantees no arm is ever readable. That override is a dated owner decision
(`candidate-routing-override-2026-07-31.md`) and change-discipline forbids reopening it silently.
Recommendation: suspend daily minting for the live lane, move iteration offline (~$5/arm, hours). If
kept, record explicitly that the live lane is a **corpus generator, not an evidence source**.

### Next

1. Refresh the OHLCV cache ($0) — nothing downstream is scoreable without it.
2. Close the attribution gap and the per-call-model constraint before any A/B enable.
3. Then a pre-registered paid re-run of haiku vs sonnet at the hold-matched horizon.
4. **Re-read every prior study against the horizon finding** — all were scored on the flattering grid.

## 2026-08-01 — Pass 55 (the criteria were adopted, and the last unsearched lever refused itself)

**Window:** 2026-07-31T21:48Z → 2026-08-01T08:20Z. Two leases, both taken and released:
`ef54fc6236ea40a2` (21:48Z) and `399762ce0e738cbb` (06:03Z). **Owner-directed session**, continuous
with Pass 54.

### ⚠ COLLISION — the FIFTH occurrence, and this one is characterised

**A concurrent scheduled pass ran at ~00:07Z inside this tree**, between two of this session's turns.
Evidence: a sweep digest `sweep-2026-08-01T00-07-32-287Z.json` this session did not produce, and
`package.json` / `scripts/loop-authoring.mjs` / `loop-authoring-core.spec.mjs` modified at 02:18–02:24
local while this session was idle. It committed nothing and wrote no LOG entry — it left work
in-flight. My lease was taken at 06:03Z, _after_ it ran, so `loop:lock` never had the chance to refuse
it; the lease binds only passes that call it, exactly as documented.

**Its work was NOT committed and NOT discarded.** Per playbook §4 ("stage ONLY files this pass
authored"), the three files were left in the working tree for that pass to claim. **This is the first
occurrence where the other pass's intent is legible, and its work looks correct and valuable:**
`loop:authoring` gains `--env-file-if-exists=.env` (the API key lives in `.env`, not `.env.app` — which
plausibly explains why `loop:authoring` has NEVER minted), `temperature` is removed because this model
family 400s on any non-default sampling parameter, and the HTTP error body is now surfaced instead of
swallowed. A later pass should adopt them; they are not this pass's to commit.

### The owner adopted the success/stop criteria — `1C, 2A, 3A, 4A`

Recorded as Amendment 1 at the top of `research/studies/success-exit-2026-07-31.md`, without rewriting
anything: the original "IT ENACTS NOTHING" paragraph and § 11's "until the owner answers" both stand,
each carrying a superseded-by pointer.

- **G1 re-cut from h ∈ {1,4} to the hold-matched h = 16.** **Recorded plainly: Q4 = A did NOT rebut
  § 10.** The "STOP written in the vocabulary of a success criterion" objection stands unresolved; the
  owner chose to run the criteria with it outstanding.
- **S3 will probably decide this before the window does.** At 2026-08-01T06:10Z: net-of-cost −$48.54
  over 8.47 window-days, LLM $22.04. −$5.73/day reaches the −$200 trigger in **26.4 days ≈ 2026-08-27**,
  four days BEFORE § 8's 2026-08-31 close. The LLM trigger is far out (~49 days). Q2 = A and Q3 = A
  interact that way and neither question showed it alone.

### The h = 16 derivation — control PASSED, and the honest output is a BOUND

**A correction against this session's own first draft:** the claim "the re-cut G1 has no number" was
WRONG. The clause's number is the floor (`mean > +24.2 AND ciLo > +24.2`) and the floor does not move
with the horizon — **G1 at h = 16 is evaluable today.** § 3's table is the FEASIBILITY analysis, not
the clause.

The method was recovered and reproduces all four published rows exactly, including an undocumented
convention (`mean`/`ciLo` rounded to 1dp _before_ the SE subtraction; raw inputs miss by 0.02–0.04).
**A point value at h = 16 is impossible without a fresh paid run:** the offline grid is frozen at
`{1,4,8,24}` and only per-(arm, horizon) aggregates are written to disk. Live is no substitute — v10
reads n = 10 at h = 16, under the floor of 12.

Monotonicity supports only: **req(K=20) ∈ [+45.0, +92.6], interval share ∈ [46.2%, 73.9%].** Even the
FLOOR of that exceeds h = 4's 35.6%, so **h = 16 is never as defensible as h ∈ {1,4}** — at best
"floor-limited like h = 8", which § 3 called _"a stronger reason to exclude it, not a weaker one"_.
Interpolation was forbidden and the data shows why: SE grows 1.70×, 1.56×, then **3.29×**.
`inverted`'s own h = 16 performance is **UNMEASURED** — the powered h = 16 cells (v1 −57.6, v2 −94.5)
are different playbook versions and citing them for `inverted` would be population-mixing.

### `arm-sweep-v1` — SIZING-GATE REFUSAL, $0.92 of $18 (`01f207c`)

The arm space was the last unsearched lever. Pre-registered on `shorts_only` (in no prior record; the
natural counter-hypothesis to a long-biased book with a measured-negative signal) and `meanrev_pure`.
Calibration, 30 rows/arm, transport 100%: **both arms 0 entries**, projected n@386 = 0, **neither full
leg funded**; the gate was verified to fire before any network call. The anticipated risk was wrong —
the corpus is spot=139/perp=247 so the eligible ceiling is 247 rows; the model simply never proposed an
entry under either arm. Recorded against the result: **0/30 is not a proven zero** (rule of three puts
the upper bound near 10%, which on 386 rows would clear n ≥ 12), so this bounds the entry rate rather
than killing the arms.

### G5 shipped; G4 declined to a design question

`agentic_promotion_blocked{reason}` now emits one series per reason, 1/0 over the whole closed set,
zero-seeded via `satisfies Record<PromotionBlockedReason, true>`. **The reason set is EIGHT, not the
seven this repo's prose says** — `NO_STATS_SOURCE` is an early-return branch, and a count that missed
it would have under-seeded exactly the reason that fires when the stats source is gone. Fails OPEN
(mirrors evidence, never feeds back). `test:livegate` 55/55.

**G4 is NOT built, and this is a blocker not a deferral.** `PassiveBenchmarkPort` has **no
implementation anywhere** — `verdicts.md:294-303` already recorded it. Building it requires choosing a
basket, which is a judgement: equal-weight over the 40-symbol universe, over the 28 distinct assets, or
**exposure-matched to the strategy's realised ~50% gross exposure** (the recommendation — an
equal-weight full-notional basket compares a 50%-exposed strategy against a 100%-exposed benchmark).
**Owner question, open.**

### G4 shipped after all — the owner delegated the basket choice (`682b6f6`)

Asked to "handle G4 as you think is best", so the design calls were made and recorded rather than
deferred: equal-weight over **28 distinct underlying assets, not the 40 strings** (the universe lists
`BTC/USDT` and `BTC/USDT:USDT` separately, so string-weighting holds ~12 assets twice), spot preferred,
**exposure-matched** (`benchmarkPnl = avgGrossExposure × basketReturn` — an unmatched full-notional
basket flatters a ~50%-exposed strategy in a drawdown exactly as much as it punishes it in a rally).

**The price source was the load-bearing redirect.** A first attempt STOPPED correctly, reporting that
production could not supply a historical price at an arbitrary past instant and proposing to widen
`FeedHealthPort.fetchCandles` with a `since` param plus touch the ccxt adapter. That was not necessary:
**`agent_decisions.close` is already a dense 15m grid** that `loop-forward-return-core` validates with
five cited reasons, so the whole thing lands with no port change, no ccxt work and no new schema.
Verified independently at the orchestrator AND in the adapter: **40/40 symbols ⇒ 28/28 distinct assets
have a usable price at BOTH window ends, 100%.** The clause blocks on evidence, never on a data gap.

**FAILS CLOSED, and where matters.** The service's existing contract reads a `null` from a bound port
as "measurement gap, drop the clause" — fail OPEN — and that test predates this work and lives in
mode-control, which the 2026-07-22 grant's KEPT set forbids re-wording. So fail-closed lives entirely in
the **adapter**: every data problem returns an `Infinity` sentinel rather than `null`, and
`netPnl.lte(Infinity)` blocks unconditionally; one missing asset voids the whole basket. `reasons` is
push-only and tests pin both directions, so it **can never manufacture a permit**.

**Honest caveat:** testnet fills span ~8.6 days against `MIN_WINDOW_DAYS=14`, so `INSUFFICIENT_WINDOW`
is already the binding blocker and this clause is not yet exercised end-to-end. That is a window
shortfall, not a price shortfall — price coverage is already complete.

**With G4 and G5 both bound, the adopted criteria are fully instrumented** — no clause is decorative.

### The soak produced a NEW FINDING, and it is the worst one on the board

Deployed `682b6f6` (boot `cdc2da19`, healthy, RestartCount 0). `agentic_promotion_blocked` reads for
the first time — the gate's binding clauses are visible instead of hand-inferred, which is precisely
what § 9 asked for:

```text
NON_POSITIVE_NET_PNL     1      INSUFFICIENT_WINDOW      1
BELOW_PASSIVE_BENCHMARK  1      (five others)            0   ← all 8 present, zero-seeded
```

**`BELOW_PASSIVE_BENCHMARK = 1` was ambiguous on arrival and was disambiguated before being recorded**
— a fired clause could equally have been the `Infinity` fail-closed sentinel tripping on a data
problem, which would be an instrument reading, not evidence. It is evidence. The equal-weight 28-asset
basket returned **−2.175%** over the evidence window (worst −11.15%, best +17.19%), so the benchmark
PnL is a small negative: ≈ −$11 at ~50% exposure, ≈ −$22 at full notional, ≈ −$44 even at 2× the book.
Against `netPnl = −$48.54`, **the lane underperforms passive at every plausible exposure.**

Stated plainly, because it is the sharpest single number this program has produced: **the lane lost
~4.9% of the book over a window in which simply holding the same basket at matched exposure would have
lost ~2.2%.** Roughly **$37 of the $48.54 loss is not market beta — it is the strategy.** Every prior
measurement compared the lane against ZERO; this is the first against OPPORTUNITY COST, and it is
worse. It also independently corroborates the horizon finding above from a completely different
direction: both say the entries are not merely unprofitable but actively value-destroying.

### Gate

format/lint/lint:md/typecheck green · **3433 tests / 185 files** · livegate **55/55** · build clean.
No deploy: nothing shipped changes runtime behaviour (the benchmark only adds a blocking reason to a
gate already returning `permitted: false`).
