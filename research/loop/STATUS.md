<!-- Created 2026-07-30 (Pass 48) by the state.md hot/cold split. Hard cap: 200 lines. -->

# Loop STATUS — what is true right now

**Read this file at the start of every pass. It is the only loop file a pass MUST read.** Everything else is looked up on demand; § Index says which file answers which question. Last updated
**Pass 63, 2026-08-04**. Hard cap 200 lines — anything longer belongs in the file that owns it, with a pointer here.

## ⛔ THE BAR EVERY STUDY IS SCORED AGAINST WAS NEVER DERIVED — AND IT IS WRONG IN BOTH DIRECTIONS

> **Derived Pass 60** at 48 trips / 10.85 d / $83.2531 mean one-way, anchor 2026-08-03T16:07Z: **GROSS bar +8.3619 bps, cluster CI95 [6.2010, 10.7616], n=48 / 12 clusters — EVIDENCE**; LLM amortized
> +70.44 ⇒ **ALL-IN ≈ +78.80 bps**. The asserted **+13.0 sits ABOVE the gross CI's upper bound** AND ~66 bps BELOW the all-in question it answered; **+24.2 is UNDERIVABLE** (no live book, no
> authoritative live schedule in-repo). **SUPERSEDED FORWARD ONLY** — no completed study is re-adjudicated and the three code constants are UNCHANGED. `verdicts.md` § Addendum 2026-08-04;
> `studies/break-even-bar-derivation-2026-08-04.md`.

## ⛔ THE LLM BILL IS THE DOMINANT PER-TRIP COST — AND "TRADE LESS TO SAVE MONEY" IS REFUTED

> **$0.5871/trip**, two independent instruments agreeing to the digit. **$28.77 LLM against $3.54 of fees over the same window = 8.13×**, and LLM is **45% of the deficit**. **The marginal cost of one more
> trip is ≈ $0** — **518 cadence-only consults spent $17.81, 61.9% of the bill, with no trade attached.** Only per-trip notional and the timing knobs move the ratio; **a cost argument against trading
> MORE is wrong**. `studies/llm-cost-attribution-2026-08-04.md`.

## ⛔ THE LOSS IS A HIT-RATE DEFICIT, NOT AN EXIT PROBLEM — AND NO AVAILABLE LEVER CLOSES IT

> **Answered Pass 62** over the 50 closed trips, `walkRoundTrips` mirrored as a recursive CTE in exact `NUMERIC(38,18)`. **Winners are 1.40× LARGER than losers** (+300.33 bps n=12 vs −214.35 bps n=38), so
> **the exit geometry is fine and every fix aimed at exit sizing is aimed at the wrong organ.** Break-even at that payoff is **41.65%**; actual **24.00%** (CI [12.2%, 35.8%], excludes break-even); the
> all-in bar needs **57.8%**. Bridge EXACT to 4dp: gross **−$31.98** − fees 3.64 − funding 0.81 − LLM 30.04 = **−66.4746** vs the gate's −66.474. **Slippage is a TAILWIND**; funding is 2.3%; the stop+TP
> bracket nets **+$0.905**; the loss is a broad bleed over 15 symbols with no tail to excise. **84% of gross loss exits via discretionary LLM closes — and they SAVE ~124 bps/trip vs letting the stop fire.
> Do not "fix" them.** **Sizing is the only lever on the cost bar and it multiplies a negative edge** (12× ⇒ bar 16.7 bps, loss ≈ −$390). **Gross must cross zero before any cost lever is worth pulling.**
> Only the headline survives sampling error — venue/exit/version splits are n=1–15. **−77.21 bps notional-weighted does NOT reproduce the recorded −69.90** (50 trips/$4,142.4 vs 48/$3,996.15
> @08-03T16:07Z); never quote either without its anchor. Second-order figures and the v1–v2-vs-v6–v10 split: `LOG.md` § Pass 62.

## ⚠ `loop:sweep` REPORTS 1 alarm — frozen, and its recorded age-out date was WRONG

> **`venue_reject_rate_high [binance]` — 16/20 = 80.0%. Do not investigate, do not tune.** All 20 submits predate `f5abf8a`; all 16 rejects are one `reduce_only SELL ZEC/USDT` retried half-hourly; newest
> binance submit **2026-07-31T01:45:02Z**. **Do not lower the threshold** (binanceusdm 4/186, Wilson 99.9% UB 8.45%, spec-pinned). The window is most-recent-N with a 7-day recency bound, so it **cannot
> clear by dilution** — it breaches the 6-submit floor at **2026-08-06T23:15Z** (re-derived Pass 61; the recorded `~2026-08-07T01:45Z` was wrong) and becomes `venue_reject_rate_undetermined`, which is
> **silence, not health**. **`cost_breaker_proximity` CLEARED at the UTC day roll** — it read $2.72/$3.00 at Pass 60. The lane self-paces to almost exactly the cap, so expect it to re-fire late each UTC
> day: recorded cost shape, not a leak.

## ⚠ TWO REDEPLOY CARVE-OUTS AND ONE REFUTED PREMISE — all first measured Pass 63

> **EVERY REDEPLOY FIRES A *CRITICAL* ALERT, AND IT IS NOT A DEFECT.** `ReconcilerStalled` fired **18:06:09Z–18:06:39Z, two samples, 8 s after the container started** and resolved on its own — the
> reconciler had simply not run yet on a fresh boot (measured from Prometheus' `ALERTS` series, positive control passing). **Record this before §3 forces the next pass to investigate its own deploy:** a
> resolved *critical* is normally a mandatory defect investigation. Same family as the zero clean-stamp / zero budget gauges.
>
> **`BELOW_PASSIVE_BENCHMARK` IS FIRING ON A REAL COMPARISON, NOT A REFUSAL — #152's recorded premise is REFUTED by the instrument built to test it.** First reading:
> `passive_benchmark_state{state="COMPUTED"} 1` (REFUSED 0, UNAVAILABLE 0), **FINITE** bar `passive_benchmark_pnl_usd = −1.695548852397436`, not the `+Inf` refusal sentinel — passive lost **$1.70** while
> the book lost **$69.28**, so it blocks because the strategy is **~$67.6 worse than doing nothing**. **Whether Pass 62 mis-read it or the state changed CANNOT be distinguished** — no history, the series
> is new. Do not re-assert either version without a second reading. `LOG.md` § Pass 63 soak.

## ⚠ Standing cautions — bodies live elsewhere; these are the facts, follow the pointer

> **THE LANE IS WORSE THAN DOING NOTHING, BY A WIDER MARGIN THAN RECORDED** — the strategy owns **≈$62 of the current $63.53**, not the basket (beta ≈ −$5.21 at the
> measured $204.44 time-weighted gross exposure, NOT ≈ −$37); `BELOW_PASSIVE_BENCHMARK` is **logically entailed** by `NON_POSITIVE_NET_PNL` and has never blocked anything
> the older clause did not; the dispersion pair *"worst −11.15%, best +17.19%"* **reproduces on no bar pair — do not re-quote it**.
> `studies/passive-benchmark-truth-2026-08-04.md`.
>
> **THE MICROSTRUCTURE SEARCH IS A NULL, AND THE STANDING VERDICT IS NOT LOCALIZED** — 64 pre-registered cells all POWERED, 7 cleared power and **all 7 failed the
> placebo** (family-wise **p = 0.3781**); microprice and depth imbalance point in **OPPOSITE** directions at h=1, and a measured anchor-lag confound puts the artifact
> ceiling at ~9.1 bps against observed 9.7–10.7. **Git-attested freeze**: `c48085e` carries the prereg with Results EMPTY, so `git diff c48085e` IS the results.
> `studies/payload-microstructure-prereg-2026-08-04.md`.
>
> **`entryVwap` IS BUY-SIDE ONLY ⇒ the anchor is the COVER price on every SHORT trip**; biases Arm2/Arm3, **not fixed on purpose** (`studies/frame-audit-2026-08-03.md`).
> **THE HORIZON GRID FLATTERS EVERY RESULT — re-read any prior finding before quoting it** (`verdicts.md`; `learning-capacity-2026-07-31.md`). **TWO LIVE BEHAVIOUR
> CHANGES SHIPPED 2026-07-30, NEITHER CREDITABLE ALONE** — v10 `inverted` (**never quote +47.6 as an edge**) and `AGENTIC_PLAN_AUTHORITATIVE_EXITS`, same boot, no control
> arm. **THE LLM LANE IS FUNDED — do not investigate a latch** (any cause but `insufficient_credit` IS an incident). **`POSITION_DRIFT` HAS NEVER HALTED THIS SYSTEM** —
> all 18 `RECONCILE_MISMATCH` halts in 32,579 `audit_log` rows are `UNKNOWN_OURS_OPEN`, and a `streak>=2` debounce (`1ff1fc7`) means a halt needs two CONSECUTIVE
> divergent passes (`watches.md` § WATCH-V4-1). **The through-line has now held SIX passes** (`config_snapshots`, `fee_ledger`, Pass 58's alarm text, Pass 59's
> `error_class` label, Pass 60's dead perp trades axis, **Pass 61's liquidation feed — which dropped every event it ever received**): *a surface reporting health it never established.*

## Current order & status

- **Deployed `37587f6` (Pass 63), `build_info{git_sha="37587f6"}` confirmed live**, `kill_switch_state{state="RUNNING"}`, `agent_client_latch_cause` all three children 0.
  **Gate at close:** format/lint/lint:md/typecheck/build clean; **`test` 197 files / 3832 passed** (baseline 3805, +27); **`eval:agentic` 95 passed | 20 skipped, run BEFORE
  the commits** — Pass 60's miss was running it after the deploy. Redeploy carve-outs (re-seeded `agentic_venue_stop_total`, reset RSS, zero clean-stamp and budget gauges,
  ~15 min of legitimately zero decides = **bar phase, not a stall**) and the promtool trap: playbook §5.3, `LOG.md` § Pass 59. **Carve-out re-confirmed a THIRD time Pass 63:
  a scrape within ~70s of boot reads `mode_info{effective="paper"}` — the safe default, taken BEFORE mode resolution runs. A mid-boot artifact, NOT a downgrade.**
- **⚠ READ `studies/redesign-scoreboard-2026-08-04.md` BEFORE TOUCHING ANY COST LEVER.** It governs L1/L4, carries the dated S3 stop triggers, declares **L2 and L5 NULL
  before they ship** and **L3 BLOCKED**, and holds the refusal list (never raise `SIZER_EQUITY_CAP` past 1000 or the $3/day breaker, never move `PROMOTION_EVIDENCE_EPOCH`,
  never touch the promotion gate or `MIN_WINDOW_DAYS`) plus the clause binding against its own author: **"cutting spend purely to postpone S3, while gross stays negative,
  is gerrymandering the stop."** It had **ZERO references across all 12 loop files** until Pass 61 — a prereg nobody can reach cannot bind anything.
- **THE PERP TRADES AXIS IS FIXED, DEPLOYED AND CONFIRMED LIVE** — 93 trades in 2 passes against ZERO across all 19,587 lifetime passes before; pinned ccxt derives the
  dead window CLIENT-SIDE so `since = 0` returned EMPTY **with no throw**, which is why no `sweep_failure` ever recorded it. Fix: a 6-day lookback floor inside the 7-day
  cap. **The fill-backfill ENGAGED for the first time Pass 62** — `backfilled_fill:6` at 08-04T06:57:50Z; the Pass-60 soak had recorded none. Body: `LOG.md` § Pass 60.
- **The book, ONE `evaluate()` sample (2026-08-04T08:07Z):** `windowDays=11.3571, roundTrips=50, netPnlUsd=−66.4741, llmCostUsd=30.0386, winRate=0.24, ready=false`,
  reasons `[NON_POSITIVE_NET_PNL, INSUFFICIENT_WINDOW, BELOW_PASSIVE_BENCHMARK]`. **Never quote these from separate reads, and never quote a book figure without its
  as-of instant** — an uncapped read is unreproducible by construction, and `llmCostUsd` STILL has no `asOfMs` bound (defect #150). Gross alone ≈ **−$36**, so **zero LLM
  spend still leaves the book negative**. **The gate stays unreachable and the WINDOW binds**: 50 trips against a floor of 30, but **11.36 of 14 days** ⇒ ~2.6 days to run.
- **Six re-derivations moved the record (Pass 60).** The ENTRIES verdict is UNMOVED and strengthened, but the **Arm2−Arm1 margin's sign flips (+29.7 → −34.3 bps)** and
  **the fee defect ALONE would have cleared clause 1's ≥30 bps condition** (fees-only +40.4) — amendment dated ahead of the **2026-08-10** verdict, **backlog #105
  discharged**. **`13.29%` is VERIFIED**; **`n=64` is STALENESS, not error**; the fee floor restates 9.2947 → 8.6476 bps; the `×2` leg conversion is **NOT an aggregation
  error** — the finding is dispersion. `studies/exit-attribution-restated-2026-08-03.md`, `census-2026-08-03.md`, `entry-rate-denominator-2026-08-03.md`.
- **THE FILTER-DRIFT GUARD FIRED ON ITS FIRST LIVE BOOT AND CAUGHT A REAL 10× ERROR** — `FIL/USDT tickSize table=0.001 venue=0.0001`, **FIXED Pass 61**; the audit found
  40/40 rows present and exactly ONE drift, so isolated, not table drift. A guard firing on its first boot is the guard working. **THE TWO SURVIVING LEVERS ARE ENABLED
  2026-08-04 on owner instruction** — `AGENTIC_OUTPUT_EFFORT=medium` (L1, the $0.61/day truncation leak; the "$0 offline review" precondition was REPLACED with reasons, not
  waived — a $0 review of an API request param is vacuous by construction) and `AGENTIC_WAKE_MOVE_PCT=0.012` (L4); first read after TWO full UTC days (~2026-08-06), detail in
  **WATCH-V4-12**. **⚠ L1's entry-rate rollback trigger is NOW TRIPLY CONFOUNDED on this window** — `022b361` (real liquidation data), and Pass 62's trade-flow fix (a
  block newly reaching 12 perp symbols) plus its prompt disclosure are all behaviour changes that can move entry rate. **L1's PRIMARY signature (`truncated_max_tokens` → 0,
  output-token spend) is UNAFFECTED by payload content and stays the readable one.** **THE PIN-SET LEAK IS CLOSED Pass 62** (`b26d18b`) — measured $0.27–$0.33/day.
- **THE SPOT LANE IS SEVERELY SUPPRESSED, AND THE OBVIOUS EXPLANATION IS HALF WRONG.** `sideEligibility` is **prompt payload, not a code gate**. Spot has **14 lifetime
  `open_long` and zero `open_short`, ever**; under v10 it is 0 entries on 191 consults, P(0) ≈ 3.8e-4 — **confounded with v10**. Pass 62 adds the expectancy figure the
  re-scope needs: spot is **−190.1 bps/trip mean over n=7**, 4× worse than perp, but **n=7 cannot distinguish that from noise**. `verdicts.md`'s *"Do not propose cost work
  as a profitability lever"* still BINDS (re-scoped Pass 60 to fees and book-level inference only). Backlog 58, expectancy-framed.
- **WATCH-PLAYBOOK-V10-1 IS RESTATED IN TWO TIERS; the FIRED-POWERED Pass-59 reading STANDS — do not re-derive it. ROLLBACK REMAINS REFUSED** (`AGENTIC_PLAYBOOK_PIN=8`
  re-arms v9+v10, activates Thompson sampling for the first time ever, and silently cancels the daily-minting override). **The sweep's adverse-selection annotation was
  FALSE for this metric and the text fix SHIPPED Pass 61** — that statistic cannot show adverse selection; the filled-vs-unfilled split on the same rows is the one that can.
- **NOTHING HERE CAN CURRENTLY BE SHOWN TO LEARN — the mechanism is DIVISION, not suppression.** Only v1 (n=28,k=13) and v2 (n=18,k=11) of eight versions ever reached
  n≥12 AND k≥5, both the oldest; **OWNER DECISION OWED: daily minting and powered evidence are mutually exclusive** (`candidate-routing-override-2026-07-31.md`). **Corpus
  v4 (587 rows) + OHLCV RESTORED Pass 54**; **`arm-sweep-v1` closed the arm space Pass 55** (both arms 0 entries in 30 rows, a sizing-gate refusal). **THE SUCCESS/STOP
  CRITERIA ARE ADOPTED** (owner 2026-08-01: `1C, 2A, 3A, 4A`) — window closes **2026-08-31**, S3's −$200 / $150 triggers LIVE, **G1 re-cut to h = 16** with a FEASIBILITY
  **bound [+45.0, +92.6] @K=20, not a point**, **Q4 = A did NOT rebut § 10**, and **S3 WILL LIKELY DECIDE THIS FIRST** (−$200 lands **~2026-08-27**, and does not extend
  the window). **G4 and G5 both shipped — no clause is decorative.**
- **Process misses stay recorded, not smoothed** (`LOG.md` §§ 60–63). P60: `test:cov` RED at HEAD; `eval:agentic` after the deploy. P61: the `git log` miss behind COLLISION #7. **P62: the orchestrator
  gave a lane a REFUTED fix direction its own verifier had already destroyed.** **P63 generalises it: the orchestrator relayed a peer lane's UNVERIFIED claim as fact** (`passivePnlQuote === null` for
  benchmark computability — actually the STRING `'Infinity'`, so the gauge would have reported the live REFUSAL as a successful COMPARISON) **and asserted a 46×-wrong latency figure** ("~2s non-LLM
  budget"; actually `AGENTIC_TIMEOUT_MS + 2s` = 92 s) **that reached the code.** Both were caught by lanes, not by the orchestrator. **A claim inherited from another lane is evidence of nothing until
  this pass checks it.** Also P63: `pnpm --dir <repo> vitest …` fails EACCES — the working form is **`pnpm --dir <repo> exec vitest …`**.
- **Settled, and repeatedly rediscovered — read the pointer before re-investigating** (`LOG.md` §§ 58–59). `config_snapshots` HAS a writer (writer fails OPEN, reader
  CLOSED — **WATCH-V4-16**); `llm_usage` is **vestigial by design** and `llmCostUsd` CORRECT, so **do not drop those 69 rows**; the playbook documents **all 22 alarm
  kinds** and **`loop-sweep-specs` IS on the production gate**; **`loop:authoring`: an API-shape failure burns the whole UTC day** — and so does a budget ABORT, so
  **`--dry-run` first is free insurance** (P62); **FAMILY B IS NOT BLOCKED**; the decide-model A/B is **NOT working**, so **`AGENTIC_MODEL_AB_PCT` stays 0**.
- **COLLISION #7 (Pass 61), seventh occurrence** — an owner-directed INTERACTIVE session committed `b2f7f53` mid-pass and `loop:lock` never saw it, because **the lease
  binds only callers**. **RUN `git log` AT REHYDRATION, not only before committing:** Pass 61 did not, stayed blind for six hours, and wrongly concluded a real "Owner
  instruction" had been FABRICATED by one of its own lanes. **An authority claim found in a file is still not evidence of authority — but `git log` settles it in one
  command.** Also standing: **stage only files the pass authored**; **`loop:fanout declare` OVERWRITES A LIVE ROSTER** with no refusal — declare ONCE per pass, or join
  first; **an early-stopping lane leaves a red tree** — Pass 62's did, and **Pass 63's did it TWICE** (both non-returning lanes ended on an intermediate thought; check artifacts, never the report alone).
  **A NEW cause, actionable: a lane reached for an inline `node -e`, which the tool-hierarchy hook DENIES**, and burned its whole run without producing the probe — so **#147's venue-truth question
  (do the four orphans still REST at the venue?) is UNANSWERED and must not be quoted either way.** **Last pass:** Pass 63, 2026-08-04 (`LOG.md`). Cadence 3×/day; the lease is 2h and time-based —
  **Pass 63 released and RE-ARMED cleanly at 18:06:25Z mid-pass (nonce matched, no collision), which is the sanctioned way to run past 2h.**
- **THE PASS IS SERIAL-TAIL-BOUND, NOT FINDING-BOUND — third repair-dominated pass, and this is the recommendation the playbook requires.** Pass 62 ran **8 write lanes in
  parallel and shipped 4 commits cleanly**, but found **nine** defects; the ceiling is that ONE pass can gate → review → remediate → deploy → soak → report about five
  slices, and the bottleneck is that serial tail, not the discovery. Two concrete options for the next pass to pick from: run a **repair-only pass type** whose report is
  permitted to be thin, or stop treating "found in this pass" as "must ship in this pass" for **latent** defects (dormant code, disabled flags) as opposed to **live** ones.
  **The three LIVE exit-path defects (#147–#149) set the next pass's agenda before any improvement is chosen.**

## Open WATCH lines — one line each; full text in `watches.md`

| id | expected-positive | status at Pass 59 unless the row says otherwise |
| --- | --- | --- |
| WATCH-V3-1 | app RSS holds under ~900 MiB (host-paper plateau ~673 MiB is the reference) | **HOLDS, and the Pass-59 "ACCELERATED" reading is WITHDRAWN — it was an instrument artifact.** `rssBytes` is a bare two-point subtraction with no rate normalisation, and this host restarts ~25×/week, so a sweep pair straddling the post-boot ramp manufactures a phantom slope. It did twice (Pass 59's 4.0→14.6 MiB/h; Pass 61's opening ~41 MiB/h). **Control: the 49.7h boot of 2026-08-01T07:55Z — +0.75 MiB/h over 47h, NEGATIVE trailing-24h slope, 801.3 MiB ceiling**, and Pass 61 re-confirmed +14.7 MiB over 6.4h (~2.3 MiB/h). Now annotated by `rss_delta_spans_warmup` (`RSS_WARMUP_GRACE_MS` 45min, fails OPEN). **Do not divide a straddling delta by the sweep gap** — read the slope from a Prometheus range query starting past the grace |
| WATCH-V4-1 | clean-stamp age under ~2 min, and every `adopt_non_adoptable` occurrence is transient AND explained by an ACK in the preceding pass interval | holds — Pass 59's 14:00:57Z occurrence passes BOTH clauses (next binanceusdm pass 14:01:48Z CLEAN; two binanceusdm `LIMIT_MAKER` ACKs at 14:00:29Z/14:00:43Z inside the preceding interval). **Its halt-class sentence was CORRECTED Pass 59** — see the standing caution above |
| WATCH-V4-2 | `reconciliation_mismatch_total{class="fill_overflow"}` stays 0 — one-shot by construction | holds — zero ever |
| WATCH-V4-3 | a redeploy with a resting perp stop boots to RUNNING with no `perp pin:` line | holds |
| WATCH-V4-4 | `fills` rows carry a same-venue clientOrderId and sum to `orders.cum_qty` on every terminal order | holds — **and is no longer hand-checked**: the I2 sweep invariant (2026-08-03) compares `cum_qty` to summed fills in exact SQL `NUMERIC` on every terminal order, every pass, failing CLOSED. 439 terminal orders, 0 mismatches |
| WATCH-V4-7 | every digest carries an alerts-fired-and-resolved line and a warn-scan span at or above the alert lookback | holds |
| WATCH-V4-9 | every replay-driven measurement reports `capsSource: 'recorded'` on 100% of rows | holds — standing check on the mint-time gates |
| WATCH-V4-11 | `orphan_scan` > 0 on a boot with a flat perp bar, and every resolved algo-rail cancel appends `algo-hist:CANCELED` to `order_events` | **RE-READ Pass 58 — expected-positive CONFIRMED again**: `orphan_scan=2843 readopt=1 cancel=0 cancel_failed=0` on binanceusdm before the redeploy. Re-seeded to 0 by each redeploy, so it re-reads on the next flat perp bar |
| WATCH-V4-12 | truncation degrades carry `truncated_max_tokens:` with `output_tokens` == 4096, not `schema_rejected:` | holds (Pass 53 confirmed; 8 more this boot, all pinned at exactly 4096). **Pass 59 PRICED IT: $0.6148/day = 20.5% of the breaker, 30.2% of decide spend, ~11 symbol-decides/day, all paid and discarded — running since 2026-07-23.** The named lever `output_config:{effort}` is now WIRED, flag-off (`ea68379`), awaiting a separate enable + $0 offline review. **Both alternatives stay refuted**: `budget_tokens` 400s on sonnet-5, raising `AGENTIC_MAX_TOKENS` breaks the 75s batch budget |
| WATCH-V4-14 | a terminal-reject burst of ≥3 in 15m surfaces as a `prometheus_alert_firing_nonblocking` annotation naming `VenueTerminalRejectBurst` in the FIRST sweep after it, and agrees with the sweep's own rate alarm | **UNFIRED — and the recorded deadline framing was WRONG, corrected Pass 63.** Rejects are NOT absent: **46 in 7 days**, newest 2026-08-03T22:00:58Z. Exactly ONE 15-min bucket ever reached the ≥3 threshold — **2026-07-31T13:00Z with 12** — and it PREDATES the rule. The rule IS loaded and healthy at severity `warning` (25 rules, 0 firing, 0 unhealthy), which is the GOOD outcome for its third clause (it cannot wedge §3). **Correct status: untriggered because no qualifying burst has occurred since deployment — NOT "untested because nothing rejects"** |
| WATCH-V4-18 | a restart re-arm over a position with resting protective orders reports `stop=…[resting-stop]` / `tp=…[resting-tp]`, never `[synthetic]`, and the re-armed `takeProfitPct` stops being exactly `0.02` | **NEW Pass 63 (#149 fix, `44792d9`), UNFIRED.** Named defects: all re-arms still `[synthetic]` ⇒ the perp registry re-adopt is not running (its only seeder with no active plan); a pct inside `DECISION_V2_BOUNDS` but outside the model's observed 0.012–0.04 ⇒ a stale order adopted (**known accepted residual** — premature exit, never unbounded loss); drift-cancel churn NOT falling ⇒ "#149 manufactures #148" is wrong. Deadline **2026-08-08** |
| WATCH-V4-19 | no positioned symbol crosses a bar boundary with no protective stop resting; `placed` increments in the SAME bar as each `drift_cancel` | **NEW Pass 63 (#148 fix, `44792d9`), UNFIRED.** The `'placed'` emission on the TP replace path was itself a must-fix — without it ~36% of TP placements were invisible. Named defects: `drift_cancel` without a same-bar placement (EXPECTED when the `sideCollateral` guard fires — **measure how often**; common ⇒ the fix misses its own live scenario); duplicate resting orders ⇒ in-flight suppression insufficient; spot `InsufficientFunds` ⇒ the guard's condition is wrong. **Cannot be exercised on binance spot — zero submits since 2026-07-31, so a zero there is starvation, not health.** Deadline **2026-08-08** |
| WATCH-V4-13 | on the FIRST spot entry after `f5abf8a`, `agentic_venue_stop_total{venue="binance",event="stood_down"}` increments, `{venue="binance",event="placed"}` stays 0, and NO `InsufficientFunds` on a spot `reduce_only` SELL | **STILL VOID at Pass 58 — and now known to be STRUCTURALLY STARVED, not merely quiet.** All binance stop counters 0; zero binance submits of any kind for 3d 7h; 191 spot consults → 0 entries. This watch cannot be answered until the spot-suppression question (backlog 58) is settled — record it as BLOCKED-ON-EVIDENCE, not as holding |
| WATCH-PLAN-AUTHORITY-1 | `plan_authoritative_close:` holds at ~the historical close rate AND the exit mix shifts toward venue stop/TP/max_hold | **FIRED.** Baseline −108.1 bps/trip at 17.4% hit; revert if positions storm to `max_hold` worse than that |
| WATCH-PLAYBOOK-V10-1 | live entry forward return under v10 lands above `champion_v8`'s replayed −12.7/−36.3/−32.7/−70.1 bps | **RESTATED 2026-08-04 in two tiers (`watches.md` amendment); the FIRED-POWERED Pass-59 reading STANDS — do not re-derive.** Tier 1 (v10-live vs v8-live: h=1 −24.3, h=4 **+52.0**, h=8 **+16.2**, h=24 −31.2) is **CAPPED UNDERPOWERED FOREVER** — v8 is n=8/k=5 and accrues no new entries, so it carries NO deadline. Tier 2 is adjudicable NOW: market-neutral v10 excludes zero at h=4/h=8, and the raw live v10 cell does too (−45.3 [−122.0, −0.3], −52.8 [−134.9, −1.5]); **h=1 and h=24 straddle zero and are not adverse**. Filled-vs-unfilled re-reads at NOFILL n≥12 (~2026-08-09). **ROLLBACK REFUSED** — see § Current order |
| WATCH-DEPLOY-HALVES-1 | the first authoring run under the amended bar reports a `halvesVerdict` at h=24 with a non-null `halvesSplitAtMs`, THE SAME for every arm | **NEW Pass 52, SAMPLE ZERO.** Named defects: every candidate `UNDETERMINED` (clause decorative) or a per-arm `halvesSplitAtMs` (split not shared). The frozen recorded-incumbent path reads UNDETERMINED by construction and that is accepted, not a defect. **An unrun check is not a passing one** |
| WATCH-V4-16 | **NEW Pass 58.** Every boot leaves exactly ONE `config_snapshots` row per config hash; an unchanged redeploy BUMPS `activated_at` on the existing row rather than inserting a second; `config_snapshot_missing` stays cleared | **FIRST READING GREEN** — 1 row, `dust 5`, `epoch 2026-07-21T11:21:00Z`, no `db`/`bootId`/`gitSha`. Named defect outcomes: duplicate rows per hash ⇒ wrong upsert target; `activated_at` NOT moving on an unchanged redeploy ⇒ `onConflictDoUpdate` not firing; `config_snapshot_drift` ⇒ either real drift or the nested key walk mis-resolving; the alarm RETURNING ⇒ the fail-open writer is failing silently — read the app log for `config snapshot write failed`, do not rebuild the writer |
| WATCH-V4-17 | **NEW Pass 58.** No symbol carrying an in-flight entry intent is absent from `agentic_active_menu` at a recompute | **UNFIRED.** Named defect outcome: an `off_menu` hold journalled for a symbol that has an in-flight intent — i.e. the pre-existing gap `548376c` closed has reappeared. Note the exposure window is up to a full UTC day, because `isPinned` is only evaluated inside `recompute()` |
| WATCH-V4-15 | `stale_venue_open` appears on an ordinary in-sweep cancel and does NOT halt, while a coid still venue-open past `driftPasses` consecutive passes DOES halt with its id in `reconciliations.detail` | **FIRED FOR THE FIRST TIME Pass 62 — expected-positive CONFIRMED on the first tier.** `stale_venue_open:1` on binanceusdm at 2026-08-04T08:31:21Z, result MISMATCH **not HALT**, next pass CLEAN at 08:32:16Z. The durable second tier (a coid still venue-open past `driftPasses`) is STILL UNFIRED and stays the open half of this watch — do not read the first-tier confirmation as covering it |

Resolved WATCH lines (V3-2, V3-3, V4-5, V4-6, V4-8, **V4-10 moved out Pass 54**) are kept in full in `watches.md` § Resolved — closed, not deleted; do not re-open one without new evidence.

## Open defects — the three LIVE exit-path ones are FIXED AND DEPLOYED (Pass 63); the measurement three are fixed except one deliberate refusal

**#147/#148/#149 SHIPPED `44792d9`, #150/#152 SHIPPED `37587f6`.** Pre-fix bodies stay in `watches.md` § Open defects #147–#152 as the record; the post-fix contracts are **WATCH-V4-18** (re-armed
geometry) and **WATCH-V4-19** (no bare bar after a drift/qty cancel). **#151 was REFUSED on evidence, not deferred** — re-anchoring the cost read to the window start moved ONE of `netPnl`'s FOUR terms
and would have erased $7.1553494 of inference while still counting $0.08740698 of fees and 9 fills over the same interval; it also moved both S3 arms later (1.37 d / 2.73 d) and would have broken
`loop:llm-attrib` permanently into `LAG_UNRESOLVED`. The **neutral repair shipped instead** (publish `llmCostSinceMs` beside `llmCostCountedThroughMs`) — **the published book did not move.** The
recorded **"25.2% / $7.72" figure does NOT reproduce: measured 23.35% / $7.1553494 of $30.6412913.** **STILL OPEN, seam named, not a priority argument:** #149's CLOCK half — `maxHoldBars: 96` and
`barsElapsed: 0` are still hardcoded because **no reachable port carries the position's open time** (`Position`, `PortfolioSnapshot`, `AgentPositionSummary` all lack a timestamp; `intentStore` is
narrowed to `loadIntentByClientOrderId` and a restart lost that coid); the seam is a new optional `AgenticStrategyDeps` closure wired in `trading-runtime.module.ts`, the `onAlgoStopGone` pattern.

## Backlog (open — improvements ONLY, never bugs; conventions in `charter.md`)

| # | Item | Stage | Effort | Status / next check |
| --- | --- | --- | --- | --- |
| 48 | Weekly vol-ranked symbol rotation (universe-study follow-on) | 2 | M | DESIGN-GATED: the 5→8 sequencing gate is OBE (40 symbols + vol×ATR scanner + menu-8); residual = the rotation-vs-promotion-walk attribution design |
| 56 | Put `test:cov` on `pnpm checks` | 2 | S | **Proved again Pass 60**: `6029d72` shipped five uncovered branches and only an A/B revert found them. One line, once the `v8 ignore` annotations are spot-checked |
| 58 | Retire or re-scope the spot half of the universe | 1 | M | 191 spot consults → **0** entries under v10 (P(0) ≈ 3.8e-4); **14 lifetime spot `open_long`, zero `open_short` ever**; spot realized PnL **−$8.01 over 7 lifetime entries**, and Pass 62 measures **−190.1 bps/trip mean on n=7 — 4× worse than perp, but n=7 is not a basis for a venue decision.** **Justify on EXPECTANCY, never on cost.** Confounded with v10 `inverted`. Remedies: `LOG.md` § Pass 58 |

Row **57 CLOSED 2026-08-03 with a measured answer** (decoupling artifact +21.0 bps/trip, CI [+1.4, +39.8] — it FLATTERS the demo book, so it cannot be what makes it negative; `studies/frame-audit-2026-08-03.md`). Rows **54/55** moved in full to `charter.md` § Backlog closed ledger; **18/44/45/47** retired OBSOLETE 2026-07-30. **Do not re-open one because its gate has cleared.**

## Flagged for human review (open) — owner capability limits only, full text in `watches.md`

- **THE OWNER DECISION THIS PROGRAM TURNS ON** — the gate CANNOT be passed, by arithmetic: an arm must post +20.9/+26.4/+33.8/+81.4 bps, the bar is **CLUSTER-limited**, unreachable at h=1/4 at ANY
  cluster count, universe **28 BASES not 40 strings** (`success-exit-2026-07-31.md`, "STOP with extra steps", unrebutted) — **and that bar was itself never derived** (top banner). **Pass 62's
  mechanism: a 24% hit rate against a 41.65% gross break-even is what "cannot be passed" means.**
- **FAMILY B: DECIDED NO RUN 2026-08-04** (owner delegated the go/no-go) — the live forward-return watch, POWERED on v10, superseded it; #50 SUPERSEDED, #64 MOOT, § 5 preserves the procedure. **THE OOS
  SESSION ARM HAS NEVER RUN — prereg REPAIRED 08-04**, awaiting the owner-side hourly trigger. `studies/family-b-disposition-2026-08-04.md`, `studies/oos-session-arm-2026-08-03.md`.
- **ONE `.env.app` edit hook-blocked** — `:153` spot/`STOP_LOSS_LIMIT` FALSE since `f5abf8a`. **`:159` `AGENTIC_PLAYBOOK_AB_PCT=40` must NOT be zeroed** (cancels the daily-minting override). **The daily
  mint has produced ZERO candidates in 4 days** (16 on 08-01; 17 slot + 18/19/20 scored 08-04, all REFUSED). Anthropic funded 07-30 (re-verified 08-03), Moonshot presumed suspended.
- **Concurrent passes in one tree — SEVEN occurrences**, the last an owner-directed INTERACTIVE session `loop:lock` never saw: the lease binds only callers, and scheduler/session co-firing is
  owner-owned. **A pass can also end without releasing its lease** — Pass 56's was 46.6h stale.
- **Availability** — the stack runs on the owner's MacBook; host sleep throttles everything. **Shared-org rate limit**; the CryptoPanic key (X4 sentiment) is still open. **6.9-LINK wallet scar (~$55)** — journaled and deduped post-epoch; a manual sell is optional hygiene only.

## Index — every loop file, and when to read it

**`STATUS.md`** (this file) always, first; **`LOG.md`** to append this pass and read the last five; **`watches.md`** for a WATCH's exact expected-positive / named defect outcome and open flagged items;
**`verdicts.md`** before proposing work in an area it covers; **`charter.md`** for loop-domain vs owner, pre-authorizations, settled decisions. **Full table — including the archives, the `state.md` stub,
`digests/` and `incidents/` — moved to `charter.md` § Loop file index (Pass 63, for the 200-line cap).**

**Maintenance rule (playbook §6 — a one-off compaction just re-grows).** Each pass appends to `LOG.md` and updates THIS file; past five entries the oldest rotates VERBATIM to `archive/LOG-through-pass-47.md`. **Nothing is ever deleted from a loop file — only moved, with a pointer left behind.** Outgrown a few lines? Move the body out. (P53: backlog 54/55 → `charter.md`, promtool trap → playbook §5. P54: WATCH-V4-10 → `watches.md`. P58: Family B correction → its own study; dust-pin and spot-suppression bodies → `LOG.md` § Pass 58. **P60: the perp-axis banner RETIRED — the defect is fixed — and the alarm banner re-derived; the six standing cautions folded to four blocks; the bar / LLM-cost / passive-benchmark / microstructure bodies left in their studies and cited here. Prose now wraps wider than the old ~100 columns — ~150 in the banners, ~170 in § Standing cautions and § Current order — which is where about a third of the reclaimed space came from; the rest is real compression.**)
