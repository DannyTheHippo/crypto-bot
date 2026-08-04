<!-- Created 2026-07-30 (Pass 48) by the state.md hot/cold split. Hard cap: 200 lines. -->

# Loop STATUS — what is true right now

**Read this file at the start of every pass. It is the only loop file a pass MUST read.** Everything else is looked up on demand; § Index says which
file answers which question. Last updated **Pass 60, 2026-08-04**. Hard cap 200 lines — anything longer belongs in the file that owns it, with a
pointer here.

## ⛔ THE BAR EVERY STUDY IS SCORED AGAINST WAS NEVER DERIVED — AND IT IS WRONG IN BOTH DIRECTIONS

> **Derived Pass 60 from measured operands** at **48 trips / 10.85 d / $83.2531 mean one-way notional**, anchor 2026-08-03T16:07Z: fees **8.6718
> bps/trip**, slippage **−0.3317** (sign-flipped from the recorded +0.333, and indistinguishable from zero) ⇒ **GROSS bar +8.3619 bps, cluster CI95
> [6.2010, 10.7616], n=48 / 12 base-asset clusters — EVIDENCE**; LLM amortized **+70.44 bps** ⇒ **ALL-IN ≈ +78.80 bps**. So the asserted **+13.0 sits
> ABOVE the gross CI's upper bound** (~4.6 bps too high as a venue-cost bar) and **~66 bps BELOW** the all-in question it was used to answer; **+24.2
> is UNDERIVABLE** — no live book (all 295 fills `mode='testnet'`), no authoritative live schedule in the repo. Gap from realised gross **−69.90
> bps/trip** to the all-in bar is **148.70 bps/trip**, WIDER than the recorded 111–130, and **neither half may be quoted alone**. **SUPERSEDED FORWARD
> ONLY** — no completed study is re-adjudicated and the three code constants are UNCHANGED. `verdicts.md` § Addendum 2026-08-04;
> `studies/break-even-bar-derivation-2026-08-04.md`.

## ⛔ THE LLM BILL IS THE DOMINANT PER-TRIP COST — AND "TRADE LESS TO SAVE MONEY" IS REFUTED

> **$0.5871/trip.** Two independently built instruments agree **to the digit**, differing only by one declared denominator (all-fill notional ÷ 2 vs
> closed-cycle-member notional ⇒ +69.5 vs +70.44 bps). In dollars, where the denominator cancels: **$28.77 LLM against $3.54 of fees paid over the same
> window = 8.13×**, and LLM is **45% of the −$63.53 net-of-cost deficit** (as-of 2026-08-03T22:12Z). **The marginal cost of one more trip is ≈ $0** —
> **518 cadence-only consults spent $17.81, 61.9% of the bill, with no trade attached.** Only **per-trip notional and the timing knobs** move the
> ratio; a cost argument against trading MORE is wrong. `studies/llm-cost-attribution-2026-08-04.md`.

## ⚠ `loop:sweep` REPORTS 2 alarms post-deploy — one frozen, one NEW

> **`venue_reject_rate_high [binance]` — 16/20 = 80.0%. Do not investigate, do not tune.** All 20 submits predate `f5abf8a`; all 16 rejects are one
> `reduce_only SELL ZEC/USDT` retried half-hourly. **Do not lower the threshold** (binanceusdm 4/186, Wilson 99.9% UB 8.45%, spec-pinned). **Its
> recorded clearing path is UNREACHABLE** — it will not clear on a spot entry, it **ages out ~2026-08-07T01:45Z** into
> `venue_reject_rate_undetermined`, which is silence, not health. Newest binance submit **2026-07-31T01:45:02Z**. **`cost_breaker_proximity` is NEW
> Pass 60** — spend **$2.72 against the $3.00/day breaker (~90%)**; the lane self-paces to almost exactly the cap, so this is the recorded cost shape
> becoming an alarm every pass must triage, not a new leak.

## ⚠ Standing cautions — bodies live elsewhere; these are the facts, follow the pointer

> **THE LANE IS WORSE THAN DOING NOTHING, BY A WIDER MARGIN THAN RECORDED.** The 28-asset basket **−2.175%** over the Pass-57 window **reproduces (−2.2150%)**, but the
> exposure term was never measured: at the measured time-weighted gross exposure (**$235.05** Pass-57 window, **$204.44** now) **beta is only ≈ −$5.21, NOT ≈ −$37** — the
> strategy owns **≈$43.33 of the $48.54** and **≈$62 of the current $63.53**. `BELOW_PASSIVE_BENCHMARK` is also **logically entailed** by `NON_POSITIVE_NET_PNL` whenever
> the basket falls, so it has never blocked anything the older clause did not; and the recorded dispersion pair _"worst −11.15%, best +17.19%"_ **reproduces on no bar
> pair — do not re-quote it**. `studies/passive-benchmark-truth-2026-08-04.md`.
>
> **THE MICROSTRUCTURE SEARCH IS A NULL, AND THE STANDING VERDICT IS NOT LOCALIZED.** 64 pre-registered cells, **all 64 POWERED**; 7 cleared power + a Bonferroni interval
> excluding zero and **all 7 failed the placebo** (family-wise **p = 0.3781**). Two independent undercuts: microprice and depth imbalance point in **OPPOSITE** directions
> at h=1, and a measured **anchor-lag confound** — features are read a median **28.3 s** after the anchoring bar close, artifact ceiling **~9.1 bps** against observed
> 9.7–10.7. **The freeze is git-attested**: `c48085e` carries the prereg with Results EMPTY, so `git diff c48085e` IS the results.
> `studies/payload-microstructure-prereg-2026-08-04.md`.
>
> **`entryVwap` IS BUY-SIDE ONLY ⇒ the anchor is the COVER price on every SHORT trip**; biases Arm2/Arm3, **not fixed on purpose** (`studies/frame-audit-2026-08-03.md`).
> **THE HORIZON GRID FLATTERS EVERY RESULT — re-read any prior finding before quoting it** (`verdicts.md`; `learning-capacity-2026-07-31.md`). **TWO LIVE BEHAVIOUR
> CHANGES SHIPPED 2026-07-30, NEITHER CREDITABLE ALONE** — v10 `inverted` (**never quote +47.6 as an edge**) and `AGENTIC_PLAN_AUTHORITATIVE_EXITS`, same boot, no control
> arm. **THE LLM LANE IS FUNDED — do not investigate a latch** (any cause but `insufficient_credit` IS an incident). **`POSITION_DRIFT` HAS NEVER HALTED THIS SYSTEM** —
> all 18 `RECONCILE_MISMATCH` halts in 32,579 `audit_log` rows are `UNKNOWN_OURS_OPEN`, and a `streak>=2` debounce (`1ff1fc7`) means a halt needs two CONSECUTIVE
> divergent passes (`watches.md` § WATCH-V4-1). **The through-line has now held FIVE passes** (`config_snapshots`, `fee_ledger`, Pass 58's alarm text, Pass 59's
> `error_class` label, Pass 60's dead perp trades axis): _a surface reporting health it never established._

## Current order & status

- **Deployed `00bdec6`** — `build_info{git_sha="00bdec6"}` confirmed, boot `f0f33fcd-7a08-45c8-922c-0e998aa41b7e`, `RestartCount` 0, `kill_switch_state{state="RUNNING"}`,
  migrations applied, **0 kill-switch engagements**. **HEAD is `0bbccbf`, ONE COMMIT PAST the deployed image** — a test-only eval-fixture change, so tip and running
  binary do **not** match. **Gate at close:** format/lint/lint:md/typecheck/build clean; **`test` 195 files / 3724 passed**; `test:livegate` **55/55**; `test:cov` green;
  `eval:agentic` 95; `backtest` 80. Redeploy carve-outs (re-seeded `agentic_venue_stop_total`, reset RSS, zero clean-stamp and budget gauges, ~15 min of legitimately zero
  decides = **bar phase, not a stall**) and the promtool trap: playbook §5.3, `LOG.md` § Pass 59.
- **THE PERP TRADES AXIS IS FIXED, DEPLOYED AND CONFIRMED LIVE** — `binanceusdm` checked **93 trades in 2 passes** against **ZERO across all 19,587 lifetime passes**
  before. **Pinned ccxt 4.5.58 derives the dead window CLIENT-SIDE** (`binance.js:8253-8266`: `endTime = min(since + 7d, now)` when `since !== undefined` AND `now − since ≥ 7d`
  AND `market['linear']`), so `since = 0` requested 1970-01-01..08 and returned EMPTY **with no throw** — which is why no `sweep_failure` was ever recorded, and why
  `checkpoint=0` was a permanent deadlock. Fix: a **6-day lookback floor**, deliberately inside the 7-day cap. **The fill-backfill and the `FILL_FOR_UNKNOWN_ORDER`
  detector are LIVE on perp for the first time**; the soak recorded no engagement. Probe evidence and the boundary trap (defect #139): `LOG.md` § Pass 60.
- **The book, ONE `evaluate()` sample post-deploy (2026-08-04):** `windowDays=10.9688, roundTrips=49, netPnlUsd=−63.6882, llmCostUsd=28.8563, winRate=0.2449,
  ready=false`, reasons `[NON_POSITIVE_NET_PNL, INSUFFICIENT_WINDOW, BELOW_PASSIVE_BENCHMARK]`. **Never quote these from separate reads, and never quote a book figure
  without its as-of instant** — an uncapped read is unreproducible by construction (two runs four minutes apart returned `llmCostUsd` 28.7683 and 28.8563). Gross alone ≈
  **−$34.83**, so **zero LLM spend still leaves the book negative**. **The promotion gate stays unreachable and the WINDOW binds**: 49 trips against a floor of 30, but
  **10.9688 of 14 days** ⇒ ~**3.03 days** still to run from that sample.
- **Six re-derivations moved the record.** **EXIT-ATTRIBUTION RESTATED**: the ENTRIES verdict is UNMOVED and strengthened, but the **Arm2−Arm1 margin's sign flips (+29.7
  → −34.3 bps)** on the frozen population and **the fee defect ALONE would have cleared clause 1's ≥30 bps condition the published run missed by 0.3 bps** (fees-only:
  +40.4) — amendment dated ahead of the **2026-08-10** verdict, frozen spec unedited, **backlog #105 discharged**. **`13.29%` is VERIFIED** (`corpus-v4-flat.jsonl`'s
  **78/587**, a data file not a sentence; the v10 lane now enters at **3.87%, 21/543**); **`n=64` is STALENESS, not error**; the fee floor restates **9.2947 → 8.6476
  bps**; the `×2` leg conversion is **NOT an aggregation error** — the finding is dispersion (1 of 49 trips within 1 bps of the blend).
  `studies/exit-attribution-restated-2026-08-03.md`, `census-2026-08-03.md`, `entry-rate-denominator-2026-08-03.md`.
- **THE FILTER-DRIFT GUARD FIRED ON ITS FIRST LIVE BOOT AND CAUGHT A REAL 10× ERROR** — `FIL/USDT tickSize table=0.001 venue=0.0001`; **that symbol is refused until the
  table is fixed** (defect #146). A guard firing on its first boot is the guard working, not a regression. **THE TWO SURVIVING LEVERS ARE ENABLED 2026-08-04 on owner
  instruction** — `AGENTIC_OUTPUT_EFFORT=medium` (L1, the $0.61/day truncation leak; the "$0 offline review" precondition was REPLACED with reasons, not waived —
  `redesign-scoreboard-2026-08-04.md` § Amendment: a $0 review of an API request param is vacuous by construction) and `AGENTIC_WAKE_MOVE_PCT=0.012` (L4). Both watches
  run per § 3.1/§ 3.4; first read after TWO full UTC days (~2026-08-06); detail in **WATCH-V4-12** below. **THE PIN-SET LEAK IS STILL OPEN AND WAS NOT REACHED** for a second pass — ≈$0.33/day; repair withdrawn; **sound route = a durable
  round-trip-cycle reader** (`LOG.md` § Pass 58).
- **THE SPOT LANE IS SEVERELY SUPPRESSED, AND THE OBVIOUS EXPLANATION IS HALF WRONG.** `sideEligibility` is **prompt payload, not a code gate**. Spot has **14 lifetime
  `open_long` and zero `open_short`, ever**; under v10 it is 0 entries on 191 consults, P(0) ≈ 3.8e-4 — **confounded with v10**. `verdicts.md`'s _"Do not propose cost
  work as a profitability lever"_ still BINDS, **re-scoped Pass 60 to fees and book-level inference only — the BAR itself is now out of its scope**. Backlog 58,
  expectancy-framed.
- **WATCH-PLAYBOOK-V10-1 IS RESTATED IN TWO TIERS (2026-08-04); the FIRED-POWERED Pass-59 reading STANDS — do not re-derive it. ROLLBACK REMAINS REFUSED**:
  `AGENTIC_PLAYBOOK_PIN=8` re-arms v9+v10, activates Thompson sampling for the first time ever, and silently cancels the daily-minting override. **The sweep's
  adverse-selection annotation is FALSE for this metric** — text fix STILL not shipped. Full clause: the WATCH row below.
- **NOTHING HERE CAN CURRENTLY BE SHOWN TO LEARN — the mechanism is DIVISION, not suppression.** Only v1 (n=28,k=13) and v2 (n=18,k=11) of eight versions ever reached
  n≥12 AND k≥5, both the oldest; **OWNER DECISION OWED: daily minting and powered evidence are mutually exclusive** (`candidate-routing-override-2026-07-31.md`). **Corpus
  v4 (587 rows) + OHLCV RESTORED Pass 54**; **`arm-sweep-v1` closed the arm space Pass 55** (both arms 0 entries in 30 rows, a sizing-gate refusal). **THE SUCCESS/STOP
  CRITERIA ARE ADOPTED** (owner 2026-08-01: `1C, 2A, 3A, 4A`) — § 6/§ 7 ENACT, window closes **2026-08-31**, S3's −$200 / $150 triggers LIVE, **G1 re-cut to h = 16** but
  its FEASIBILITY figure is a **bound [+45.0, +92.6] @K=20, not a point**, **Q4 = A did NOT rebut § 10**, and **S3 WILL LIKELY DECIDE THIS FIRST** (−$200 lands
  **~2026-08-27**, and does not extend the window). **G4 and G5 both shipped — no clause is decorative.**
- **TWO PROCESS MISSES THIS PASS, recorded rather than smoothed.** (1) **`test:cov` was RED at HEAD from this pass's own `6029d72`**, found by A/B revert — five uncovered
  branches across three files, not the two first surveyed; now green, three residual branches carrying written `v8 ignore` proofs. (2) **`eval:agentic` broke on the
  prompt-surface deploy and was caught AFTER the deploy, not before** — it sits in this plan's own step-2 gate and was not run beforehand. Both in full: `LOG.md` § Pass
  60.
- **Settled, and repeatedly rediscovered — read the pointer before re-investigating** (`LOG.md` §§ Pass 58–59). `config_snapshots` HAS a writer (`118132c`; writer fails
  OPEN, reader fails CLOSED — **WATCH-V4-16**); `llm_usage` is **vestigial by design** and `llmCostUsd` is CORRECT, so **do not drop those 69 rows** (inside the epoch,
  removing them loosens a permission gate); the playbook documents **all 22 alarm kinds** (`7e1306c`) and **`loop-sweep-specs` IS on the production gate** (`6149861`);
  **`loop:authoring`: an API-shape failure burns the whole UTC day**; **FAMILY B IS NOT BLOCKED**; the decide-model A/B (`3958c8c`) is **NOT a working A/B**, so
  **`AGENTIC_MODEL_AB_PCT` stays 0**.
- **COLLISION #6 (Pass 58)** — an owner-directed INTERACTIVE session ran inside Pass 58's lease and took the number `57`: the lease binds only callers. **Stage only files
  the pass authored — `git add -A` would have committed its in-flight work.** **`loop:fanout declare` OVERWRITES A LIVE ROSTER** with no refusal and no versioning;
  declare ONCE per pass, or join first. **Last pass:** Pass 60, 2026-08-04 (`LOG.md`). Cadence 3×/day; take the lease before any edit, release it last — it is 2h and
  time-based, so a pass spanning a host sleep finds its own lease expired.

## Open WATCH lines — one line each; full text in `watches.md`

| id | expected-positive | status at Pass 59 unless the row says otherwise |
| --- | --- | --- |
| WATCH-V3-1 | app RSS holds under ~900 MiB (host-paper plateau ~673 MiB is the reference) | holds — **but the slope ACCELERATED Pass 59**: 4.0 MiB/h over 09:52→16:07, then 14.6 MiB/h to 800.8 MiB by 18:44 local. Redeploy reset it to 335 MiB. Re-read the slope, not just the level |
| WATCH-V4-1 | clean-stamp age under ~2 min, and every `adopt_non_adoptable` occurrence is transient AND explained by an ACK in the preceding pass interval | holds — Pass 59's 14:00:57Z occurrence passes BOTH clauses (next binanceusdm pass 14:01:48Z CLEAN; two binanceusdm `LIMIT_MAKER` ACKs at 14:00:29Z/14:00:43Z inside the preceding interval). **Its halt-class sentence was CORRECTED Pass 59** — see the standing caution above |
| WATCH-V4-2 | `reconciliation_mismatch_total{class="fill_overflow"}` stays 0 — one-shot by construction | holds — zero ever |
| WATCH-V4-3 | a redeploy with a resting perp stop boots to RUNNING with no `perp pin:` line | holds |
| WATCH-V4-4 | `fills` rows carry a same-venue clientOrderId and sum to `orders.cum_qty` on every terminal order | holds — **and is no longer hand-checked**: the I2 sweep invariant (2026-08-03) compares `cum_qty` to summed fills in exact SQL `NUMERIC` on every terminal order, every pass, failing CLOSED. 439 terminal orders, 0 mismatches |
| WATCH-V4-7 | every digest carries an alerts-fired-and-resolved line and a warn-scan span at or above the alert lookback | holds |
| WATCH-V4-9 | every replay-driven measurement reports `capsSource: 'recorded'` on 100% of rows | holds — standing check on the mint-time gates |
| WATCH-V4-11 | `orphan_scan` > 0 on a boot with a flat perp bar, and every resolved algo-rail cancel appends `algo-hist:CANCELED` to `order_events` | **RE-READ Pass 58 — expected-positive CONFIRMED again**: `orphan_scan=2843 readopt=1 cancel=0 cancel_failed=0` on binanceusdm before the redeploy. Re-seeded to 0 by each redeploy, so it re-reads on the next flat perp bar |
| WATCH-V4-12 | truncation degrades carry `truncated_max_tokens:` with `output_tokens` == 4096, not `schema_rejected:` | holds (Pass 53 confirmed; 8 more this boot, all pinned at exactly 4096). **Pass 59 PRICED IT: $0.6148/day = 20.5% of the breaker, 30.2% of decide spend, ~11 symbol-decides/day, all paid and discarded — running since 2026-07-23.** The named lever `output_config:{effort}` is now WIRED, flag-off (`ea68379`), awaiting a separate enable + $0 offline review. **Both alternatives stay refuted**: `budget_tokens` 400s on sonnet-5, raising `AGENTIC_MAX_TOKENS` breaks the 75s batch budget |
| WATCH-V4-14 | a terminal-reject burst of ≥3 in 15m surfaces as a `prometheus_alert_firing_nonblocking` annotation naming `VenueTerminalRejectBurst` in the FIRST sweep after it, and agrees with the sweep's own rate alarm | **NEW Pass 53, UNFIRED.** Named defect outcomes: it fires on the 2/hour spot bleed (threshold mis-derived); or a burst occurs and it stays silent (`for: 5m` outliving a ~5m burst is the specific risk); or it lands as an ALARM, meaning severity drifted to `critical` and §3 is now wedgeable. **An unfired alert is not a passing one** — if nothing rejects by 2026-08-07, record it as UNTESTED |
| WATCH-V4-13 | on the FIRST spot entry after `f5abf8a`, `agentic_venue_stop_total{venue="binance",event="stood_down"}` increments, `{venue="binance",event="placed"}` stays 0, and NO `InsufficientFunds` on a spot `reduce_only` SELL | **STILL VOID at Pass 58 — and now known to be STRUCTURALLY STARVED, not merely quiet.** All binance stop counters 0; zero binance submits of any kind for 3d 7h; 191 spot consults → 0 entries. This watch cannot be answered until the spot-suppression question (backlog 58) is settled — record it as BLOCKED-ON-EVIDENCE, not as holding |
| WATCH-PLAN-AUTHORITY-1 | `plan_authoritative_close:` holds at ~the historical close rate AND the exit mix shifts toward venue stop/TP/max_hold | **FIRED.** Baseline −108.1 bps/trip at 17.4% hit; revert if positions storm to `max_hold` worse than that |
| WATCH-PLAYBOOK-V10-1 | live entry forward return under v10 lands above `champion_v8`'s replayed −12.7/−36.3/−32.7/−70.1 bps | **RESTATED 2026-08-04 in two tiers (`watches.md` amendment); the FIRED-POWERED Pass-59 reading STANDS — do not re-derive.** Tier 1 (v10-live vs v8-live: h=1 −24.3, h=4 **+52.0**, h=8 **+16.2**, h=24 −31.2) is **CAPPED UNDERPOWERED FOREVER** — v8 is n=8/k=5 and accrues no new entries, so it carries NO deadline. Tier 2 is adjudicable NOW: market-neutral v10 excludes zero at h=4/h=8, and the raw live v10 cell does too (−45.3 [−122.0, −0.3], −52.8 [−134.9, −1.5]); **h=1 and h=24 straddle zero and are not adverse**. Filled-vs-unfilled re-reads at NOFILL n≥12 (~2026-08-09). **ROLLBACK REFUSED** — see § Current order |
| WATCH-DEPLOY-HALVES-1 | the first authoring run under the amended bar reports a `halvesVerdict` at h=24 with a non-null `halvesSplitAtMs`, THE SAME for every arm | **NEW Pass 52, SAMPLE ZERO.** Named defects: every candidate `UNDETERMINED` (clause decorative) or a per-arm `halvesSplitAtMs` (split not shared). The frozen recorded-incumbent path reads UNDETERMINED by construction and that is accepted, not a defect. **An unrun check is not a passing one** |
| WATCH-V4-16 | **NEW Pass 58.** Every boot leaves exactly ONE `config_snapshots` row per config hash; an unchanged redeploy BUMPS `activated_at` on the existing row rather than inserting a second; `config_snapshot_missing` stays cleared | **FIRST READING GREEN** — 1 row, `dust 5`, `epoch 2026-07-21T11:21:00Z`, no `db`/`bootId`/`gitSha`. Named defect outcomes: duplicate rows per hash ⇒ wrong upsert target; `activated_at` NOT moving on an unchanged redeploy ⇒ `onConflictDoUpdate` not firing; `config_snapshot_drift` ⇒ either real drift or the nested key walk mis-resolving; the alarm RETURNING ⇒ the fail-open writer is failing silently — read the app log for `config snapshot write failed`, do not rebuild the writer |
| WATCH-V4-17 | **NEW Pass 58.** No symbol carrying an in-flight entry intent is absent from `agentic_active_menu` at a recompute | **UNFIRED.** Named defect outcome: an `off_menu` hold journalled for a symbol that has an in-flight intent — i.e. the pre-existing gap `548376c` closed has reappeared. Note the exposure window is up to a full UTC day, because `isPinned` is only evaluated inside `recompute()` |
| WATCH-V4-15 | `stale_venue_open` appears on an ordinary in-sweep cancel and does NOT halt, while a coid still venue-open past `driftPasses` consecutive passes DOES halt with its id in `reconciliations.detail` | **NEW Pass 56, UNFIRED.** Named defect outcomes: it never fires at all (the second tier is resolving at the book tier every time, so the durable arm is dead code in production); or it fires and never clears, meaning the streak reset is not matching coids and a benign race is walking toward a halt; or a genuine orphan escalates and the halt string still lacks the id. **It is deliberately actionable**, so a stuck one starves the clean stamp and blocks auto-resume — that is the intended fail direction, not a defect |

Resolved WATCH lines (V3-2, V3-3, V4-5, V4-6, V4-8, **V4-10 moved out Pass 54**) are kept in full in `watches.md` § Resolved — closed, not deleted; do not re-open one without new evidence.

## Open defects (Pass 60) — BUGS, so deliberately NOT backlog rows

Per `charter.md` (owner decision 2026-07-16) the backlog is **improvements only**: a defect is fixed in the pass that finds it, or — when it exceeds
the §4 rails — goes to § Flagged. **These eight are neither.** Found late in a pass whose defect budget was already spent, and **none is owner-gated**,
they are the next pass's fix queue. **IDs are as supplied by the lanes that found them; they do NOT continue the 48–58 backlog sequence.**

| # | Defect | Why it matters |
| --- | --- | --- |
| 139 | `ADOPT_CLOSED_LOOKBACK_MS` sits **exactly** on the ccxt 7-day boundary | zero headroom; clock skew truncates the newest trades — the trap the 6-day floor was chosen to avoid |
| 140 | The OOS arm's pre-registration would **VOID on correct behaviour** — its `[4%, 40%]` floor is above the incumbent's own **3.87%** entry rate — and its `p0` is stale | **BLOCKS STARTING THE ARM.** A prereg that voids when the system behaves normally measures nothing |
| 141 | Passive-benchmark price lookup has **no staleness bound**, and a **46.5 h** journal gap sits inside the window | an endpoint landing in the gap anchors to a price up to two days away and still returns a finite, non-sentinel number on a fail-CLOSED gate input |
| 142 | `claude-opus-4-8` is **unpriced** | the live arming gate runs on an upper bound — **$4.47, 15.5% of book LLM cost** — via the fail-closed max-of-configured fallback |
| 143 | Promotion evidence is **NOT reproducible**: `fundingNetForMode` filters `funding_time` with no `created_at` predicate against a ~37 min ingest lag | re-running the gate against history returns a different `netPnl` than the gate returned. **Direction FLATTERS the book** — the wrong way for a permission gate |
| 144 | The **anchor-lag confound applies to EVERY forward-return reading**, WATCH-V10-1 included | features read a median 28.3 s after the anchoring bar close; the ~9.1 bps artifact ceiling sits inside several quoted effect sizes |
| 145 | Two payload blocks carry **no information** — `liquidation` degenerate on all 94 entries, derivatives-v2 fields 0/94 | paid prompt bytes with zero conditioning value on every consult |
| 146 | `FIL/USDT` tick drift — `tickSize table=0.001 venue=0.0001` | a real **10×** error; the symbol is refused by the filter-drift guard until the table is fixed |

## Backlog (open — improvements ONLY, never bugs; conventions in `charter.md`)

| # | Item | Stage | Effort | Status / next check |
| --- | --- | --- | --- | --- |
| 48 | Weekly vol-ranked symbol rotation (universe-study follow-on) | 2 | M | DESIGN-GATED: the 5→8 sequencing gate is OBE (40 symbols + vol×ATR scanner + menu-8); residual = the rotation-vs-promotion-walk attribution design |
| 56 | Put `test:cov` on `pnpm checks` | 2 | S | **Proved again Pass 60**: `6029d72` shipped five uncovered branches and only an A/B revert found them. One line, once the `v8 ignore` annotations are spot-checked |
| 57 | Measure how much recorded PnL is attributable to demo/live price decoupling | — | — | **CLOSED 2026-08-03 with a measured answer.** Artifact **+21.0 bps/trip**, cluster CI **[+1.4, +39.8]**, n=38 of 46, 12 clusters. **Excludes zero and FLATTERS the demo book** ⇒ decoupling **cannot** be what makes the book negative. Full body: `studies/frame-audit-2026-08-03.md` |
| 58 | Retire or re-scope the spot half of the universe | 1 | M | 191 spot consults → **0** entries under v10 (P(0) ≈ 3.8e-4); **14 lifetime spot `open_long`, zero `open_short` ever**; spot realized PnL **−$8.01 over 7 lifetime entries**. **Justify on EXPECTANCY, never on cost.** Confounded with v10 `inverted` — needs that controlled or a two-step enable. Three remedies: `LOG.md` § Pass 58 |

Rows **54/55** moved in full to `charter.md` § Backlog closed ledger; rows **18/44/45/47** retired OBSOLETE 2026-07-30. **Do not re-open one because its gate has cleared** — the question is answered.

## Flagged for human review (open) — owner capability limits only, full text in `watches.md`

- **THE OWNER DECISION THIS PROGRAM TURNS ON** — the gate CANNOT be passed, by arithmetic: an arm must post +20.9/+26.4/+33.8/+81.4 bps, the bar is
  **CLUSTER-limited**, unreachable at h=1/4 at ANY cluster count, universe **28 BASES not 40 strings**. `success-exit-2026-07-31.md` — "STOP with extra
  steps" unrebutted. **And the bar those figures are scored against was itself never derived** — see the top banner.
- **FAMILY B: DECIDED NO RUN 2026-08-04** (owner delegated the go/no-go; `studies/family-b-disposition-2026-08-04.md`) — the live forward-return watch,
  POWERED on v10, superseded it as the deployment's falsification instrument, and no branch of the $22 outcome could change a decision this program can
  still take. #50 closed SUPERSEDED, #64 MOOT; § 5 of the record preserves the run procedure. **THE OOS SESSION ARM HAS NEVER RUN — prereg REPAIRED by
  amendment 08-04** (was defect #140: stale p0, a VOID band above the incumbent's own rate); still awaits the owner-side hourly trigger its § Cadence
  names. `studies/oos-session-arm-2026-08-03.md`.
- **ONE `.env.app` edit hook-blocked** — `:153` spot/`STOP_LOSS_LIMIT` FALSE since `f5abf8a`. **`:159` `AGENTIC_PLAYBOOK_AB_PCT=40` must NOT be
  zeroed** — that cancels the owner's daily-minting override. **The daily mint has produced ZERO candidates in 3 days** (one row, id 16, 08-01).
  **Both provider accounts** — Anthropic funded 07-30 (re-verified 08-03), Moonshot presumed suspended.
- **Concurrent passes in one tree — SIX occurrences**, the last an owner-directed INTERACTIVE session `loop:lock` never saw: the lease binds only
  callers, and scheduler/session co-firing is owner-owned. **A pass can also end without releasing its lease** — Pass 56's was 46.6h stale.
- **Availability** — the stack runs on the owner's MacBook; host sleep throttles everything. **Shared-org rate limit**; the CryptoPanic key (X4
  sentiment) is also still open. **6.9-LINK wallet scar (~$55)** — journaled and deduped post-epoch; a manual sell is optional hygiene only.

## Index — every loop file, and when to read it

| file | read it when |
| --- | --- |
| `STATUS.md` (this file) | always, first, at the start of every pass |
| `charter.md` | deciding whether a change is loop-domain or needs the owner; before firing a pre-authorization; before disputing a settled decision |
| `verdicts.md` | before proposing work in an area it covers — the entry signal, exit rules, cost levers, the derived break-even bar (§ Addendum 2026-08-04), decide-model choice, price TA, non-price channels, the promotion benchmark, the live playbook lineage |
| `watches.md` | checking a WATCH's exact expected-positive or named defect outcome; reading an open flagged item in full |
| `LOG.md` | appending this pass's entry (newest last); reading the last five passes |
| `archive/state-2026-07-30.md` | a line here or in `watches.md` points there for the record behind it — v3 build/cutover, soak defects, per-pass decision records |
| `archive/LOG-through-pass-47.md` | a pass entry older than the five kept in `LOG.md`; Pass 60 rotated Pass 55 out |
| `state.md` | never for content — a stub kept because commit messages, `docs/runbook.md` and the scheduled task reference the path by name |
| `digests/` | `loop:sweep` writes its digest here; rehydration reads the newest |
| `incidents/` | a named incident note written by an earlier pass |

**Maintenance rule (playbook §6 — a one-off compaction just re-grows).** Each pass appends to `LOG.md` and updates THIS file; past five entries the oldest rotates VERBATIM to `archive/LOG-through-pass-47.md`. **Nothing is ever deleted from a loop file — only moved, with a pointer left behind.** Outgrown a few lines? Move the body out. (P53: backlog 54/55 → `charter.md`, promtool trap → playbook §5. P54: WATCH-V4-10 → `watches.md`. P58: Family B correction → its own study; dust-pin and spot-suppression bodies → `LOG.md` § Pass 58. **P60: the perp-axis banner RETIRED — the defect is fixed — and the alarm banner re-derived; the six standing cautions folded to four blocks; the bar / LLM-cost / passive-benchmark / microstructure bodies left in their studies and cited here. Prose now wraps wider than the old ~100 columns — ~150 in the banners, ~170 in § Standing cautions and § Current order — which is where about a third of the reclaimed space came from; the rest is real compression.**)
