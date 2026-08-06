<!-- Created 2026-07-30 (Pass 48) by the state.md hot/cold split. Hard cap: 200 lines. -->

# Loop STATUS — what is true right now

**Read this file at the start of every pass. It is the only loop file a pass MUST read.** Everything else is looked up on demand; § Index says which file answers which question. Last updated
**Pass 65, 2026-08-06**. Hard cap 200 lines — anything longer belongs in the file that owns it, with a pointer here.

## ⛔ THE THREE STANDING ECONOMIC FINDINGS — headlines only; **bodies moved to their studies Pass 65 for the 200-line cap, nothing dropped**

> **1. THE BAR EVERY STUDY IS SCORED AGAINST WAS NEVER DERIVED AND IS WRONG IN BOTH DIRECTIONS.** **GROSS bar +8.3619 bps, CI95 [6.2010, 10.7616], n=48/12 clusters — EVIDENCE**; **ALL-IN ≈ +78.80**. The
> asserted **+13.0 sits ABOVE the gross CI's upper bound**; **+24.2 is UNDERIVABLE**. **SUPERSEDED FORWARD ONLY** — no completed study is re-adjudicated, the three code constants UNCHANGED.
> `verdicts.md` § Addendum 2026-08-04; `studies/break-even-bar-derivation-2026-08-04.md`.
> **2. THE LLM BILL IS THE DOMINANT PER-TRIP COST AND "TRADE LESS TO SAVE MONEY" IS REFUTED.** **$0.5871/trip**, **8.13× the fees**, **45% of the deficit**, and **the marginal cost of one more trip is
> ≈ $0** (518 cadence-only consults spent $17.81 with no trade attached). Only per-trip notional and the timing knobs move it. `studies/llm-cost-attribution-2026-08-04.md`.
> **3. THE LOSS IS A HIT-RATE DEFICIT, NOT AN EXIT PROBLEM, AND NO AVAILABLE LEVER CLOSES IT.** Winners are **1.40× LARGER** than losers ⇒ **the exit geometry is fine and every fix aimed at exit sizing is
> aimed at the wrong organ**. Break-even **41.65%** vs actual **24.00%**; all-in needs **57.8%**. Slippage is a **TAILWIND**; the loss is a broad bleed over 15 symbols with no tail to excise. **84% of
> gross loss exits via discretionary LLM closes — they SAVE ~124 bps/trip. Do not "fix" them.** **Sizing multiplies a negative edge; gross must cross zero before any cost lever is worth pulling.** Only
> the headline survives sampling error. **−77.21 bps notional-weighted does NOT reproduce the recorded −69.90 — never quote either without its anchor.** Bridge + splits: `LOG.md` § Pass 62.

## ⛔ THE SWEEP WAS BLIND TO 2155 HALTS, AND "POSITION_DRIFT HAS NEVER HALTED THIS SYSTEM" IS FALSE — FIXED Pass 65

> **2155 lifetime HALT rows across 8 boots, of which 2138 (99.2%) are POSITION_DRIFT** — TRUMP 1711, HYPE 329, ETH 98 — against 16 `UNKNOWN_OURS_OPEN` + 1 `FILL_FOR_UNKNOWN_ORDER`. **ZERO
> `reconcile_halt` alarms were ever raised for any of them**, because `loop-sweep-core.mjs` alarmed only on `latestResult === 'HALT'` and a halt followed by any CLEAN row is invisible to a one-row read.
> The old "all 18 halts are UNKNOWN_OURS_OPEN" line was TRUE WHEN WRITTEN and went stale silently: the kill-switch audit port shipped in `759e54b` at 2026-07-27T08:56:55Z, **66 s after the last TRUMP
> halt row**, so the 1725 halts of 07-26/27 predate the instrument. This boot recorded 427/427. Fix `069d40f` adds a boot-scoped count + `reconcile_halt_in_boot` / `_unreadable` (24 alarm kinds now).
> **An unresolved bootId annotates (`_boot_id_void`) rather than alarming** — otherwise every redeploy sweep raised two blocking alarms and wedged §3 on a routine step.

## ⚠ `venue_reject_rate_high [binance]` — frozen, ages out 2026-08-06T23:15Z

> **16/20 = 80.0%. Do not investigate, do not tune.** All 20 submits predate `f5abf8a`; all 16 rejects are one `reduce_only SELL ZEC/USDT` retried half-hourly; newest binance submit
> **2026-07-31T01:45:02Z**. **Do not lower the threshold** (binanceusdm 4/186, Wilson 99.9% UB 8.45%, spec-pinned). Most-recent-N with a 7-day recency bound, so it **cannot clear by dilution** — it
> breaches the 6-submit floor at **2026-08-06T23:15Z** and becomes `venue_reject_rate_undetermined`, which is **silence, not health**. **`cost_breaker_proximity` CLEARED at the UTC day roll**; the lane
> self-paces to almost exactly the cap, so expect it to re-fire late each UTC day — recorded cost shape, not a leak.

## ⛔ A FIFTH OF EVERY PORTFOLIO CONSULT WAS PAID FOR AND THROWN AWAY — FIXED Pass 64 (`fbb3800`)

> **48 whole-batch discards / 224 consults over 7 days = 21.4%** (a FLOOR — `increase()` under-counts a first-seen child), ~**$0.34/day**. **The two causes are NOT the same defect**: `output_tokens` 272 +
> non-`max_tokens` stop = the model emitting `decisions` as a JSON **string** (schema `strict:true` forbade it since `651aa2a`, so **no prompt fix was left**); `output_tokens` 4096 = real truncation. **No
> retry existed** — a 200 carrying an invalid payload never throws. **PnL sign is AMBIGUOUS — at 24% hit rate vs a 41.65% break-even, more recovered entries at a negative edge may worsen gross. Never
> quote this as a profitability gain.** WATCH-V4-20; body `LOG.md` § Pass 64.

## ⛔ L1 IS LIVE AND ITS PRIMARY SIGNATURE IS FALSIFIED — do not re-derive the wiring

> `AGENTIC_OUTPUT_EFFORT=medium` traced **end-to-end across seven hops**, verified in the compiled `dist` actually running, the container env, and the boot's `config_snapshots` row (`89848501`); live since
> **2026-08-04T08:00:23Z**. **Truncation fired anyway 16h later at exactly 4096 output tokens** — WATCH-V4-12's expected-positive is **NOT met with the lever live**. Open + UNVERIFIED: whether `effort` is
> honoured for this model, or whether the unconditional `thinking:{type:'adaptive'}` eats the budget ahead of tool JSON. **`stop_reason` is recorded NOWHERE** — journaling it is the cheapest instrument.

## ⚠ Standing cautions — bodies live elsewhere; these are the facts, follow the pointer

> **THE LANE IS WORSE THAN DOING NOTHING, BY A WIDER MARGIN THAN RECORDED** — the strategy owns **≈$62 of the deficit**, not the basket (beta ≈ −$5.21 at the measured $204.44 time-weighted gross
> exposure, NOT ≈ −$37); `BELOW_PASSIVE_BENCHMARK` is **logically entailed** by `NON_POSITIVE_NET_PNL`; the dispersion pair *"worst −11.15%, best +17.19%"* **reproduces on no bar pair — do not re-quote
> it**. `studies/passive-benchmark-truth-2026-08-04.md`.
>
> **THE MICROSTRUCTURE SEARCH IS A NULL, AND THE STANDING VERDICT IS NOT LOCALIZED** — 64 pre-registered cells, 7 cleared power and **all 7 failed the placebo** (family-wise **p = 0.3781**); microprice
> and depth imbalance point in **OPPOSITE** directions at h=1; a measured anchor-lag confound puts the artifact ceiling at ~9.1 bps against observed 9.7–10.7. **Git-attested freeze**: `c48085e` carries
> the prereg with Results EMPTY, so `git diff c48085e` IS the results. `studies/payload-microstructure-prereg-2026-08-04.md`.
>
> **`entryVwap` IS BUY-SIDE ONLY ⇒ the anchor is the COVER price on every SHORT trip**; biases Arm2/Arm3, **not fixed on purpose** (`studies/frame-audit-2026-08-03.md`). **THE HORIZON GRID FLATTERS EVERY
> RESULT — re-read any prior finding before quoting it** (`verdicts.md`). **TWO LIVE BEHAVIOUR CHANGES SHIPPED 2026-07-30, NEITHER CREDITABLE ALONE** — v10 `inverted` (**never quote +47.6 as an edge**) and
> `AGENTIC_PLAN_AUTHORITATIVE_EXITS`, same boot, no control arm. **THE LLM LANE IS FUNDED — do not investigate a latch** (any cause but `insufficient_credit` IS an incident).
> **`POSITION_DRIFT` HALTS THIS SYSTEM ROUTINELY — the old "has never halted" line is FALSIFIED (top banner: 2138 of 2155 lifetime halts).** The `streak>=2` debounce (`1ff1fc7`) works exactly as designed
> — P65 measured **429 position_drift mismatches − 427 halts = exactly 2 first-strike passes** — and a halt DOES engage the kill switch and suppress all trading (P65: two engagements, 7h07m HALTED, zero
> `SUBMIT_SENT`). **The through-line has now held ELEVEN passes** (`config_snapshots`, `fee_ledger`, P58's alarm text, P59's `error_class`, P60's dead perp axis, P61's liquidation feed, **and P65's five:
> the sweep blind to 2155 halts, a lane reporting ACTIVE while dead, `audit_log` blind by construction until 07-27, a healthcheck documented as "the final rung" that cannot fail, and an authoring runner
> that cannot print its own abort**): *a surface reporting health it never established.*

## ⛔ A HOST SUSPEND KILLED THE FEED FOR 6.25h AND NOTHING COULD RECOVER IT — FIXED Pass 65 (`7edd4a6`)

> **Pinned ccxt 4.5.58 memoises the REJECTED markets-load promise forever** (`Exchange.js:891-903` resets only `reloadingMarkets`; `marketsLoading` is cleared once, in the constructor `:135`). Every
> `watch*` starts `loadMarkets()` at reload=false, so ONE failed load makes every later call replay the rejection — **instant rejection, ZERO network I/O**. A suspend at 09:52Z drove 3 recreations, the
> last two INSIDE the outage; both wedged 6.25h (19,057 identical `fetch failed` lines, 91 dead channels, both venues). **`close()` is a NO-OP on a never-connected instance** (it iterates `clients`,
> which is empty) so it mints no `ExchangeClosedByUser` and never re-enters recreation — **222 watchdog fires, zero recreations.** Verified in-process, not network: `wget` to both exchangeInfo URLs from
> INSIDE the container returned REACHABLE. **A plain `docker compose restart app` clears it** (pure in-process state) — that is the emergency lever. **`ccxt-stream.adapter.ts:159`'s claim that the
> container healthcheck is "the final rung" is FALSE**: compose probes only `/health/live`, which stayed 200 through all 6.25h with `RestartCount` 0.

## ⛔ THE LANE CAN STOP BEING INVOKED ENTIRELY AND EVERY SURFACE STILL READS HEALTHY — instrumented Pass 65 (`e94c11e`)

> `StrategyHost.drainMailboxes()` has **exactly one caller**, inside the market-event `for await`: no candles ⇒ no drain ⇒ `decide()` never called. The gate did not refuse and did not park — **it was
> never reached**. Measured: gate counters frozen across two scrapes 151s apart while staleness advanced +150.0; `agent_decisions` = **1640 rows == 1640 gate outcomes**, 1:1, stopping dead at
> 09:45:31Z. Throughout, all 40 `strategy_lifecycle{state="ACTIVE"}`=1 and kill switch RUNNING. New **`agentic_last_gate_timestamp_seconds`** (SEEDED AT BOOT — a label-less prom-client gauge inits to 0,
> and `time()-0` would page CRITICAL 5 min into every boot and **wedge §3 on every redeploy**) + **`AgenticLaneNotTicking`** at 2700s = 3 bar periods. **45 min instead of 6h**, and it would also have
> caught the 5h45m gap of 08-05T17:15Z that fired no `AgenticLaneSilent` at all. Risk is unaffected: `risk-engine` stamps `ageMs` and vetoes intents on a stale mark.

## Current order & status

- **Deployed `5deaac5` (Pass 65), `build_info{git_sha="5deaac5"}` confirmed live**, boot `815e01b8`, `kill_switch_state{state="RUNNING"}`, `agent_client_latch_cause` all three 0. **SOAK PASS — post-deploy
  sweep reports 1 alarm, down from 82** (only the frozen `venue_reject_rate_high`, ages out 23:15Z); 91 staleness children, clean stamp fresh, **zero firing alerts**. **Gate at close:** format/lint/lint:md/typecheck/build clean; **`test` 199 files / 3922 passed** (baseline 199/3898); **`eval:agentic` 95 passed | 20 skipped**; **`test:cov` exit 0**
  (93.13/86.94/92.06/94.47 vs the 90/85/90/90 bar) — run because a review finding turned on it. Prometheus `--force-recreate`d (alerts.rules.yml is a single-file bind mount; plain `up -d` is a no-op).
- **BOTH ADVERSARIAL REVIEWS RETURNED MUST-FIX ON WORK THAT HAD ALREADY PASSED EVERY GATE — green gates are not evidence.** 199 files / 3898 tests were green at the moment the new alert would have paged
  critical on every boot. **One defect was the ORCHESTRATOR'S OWN**; the other three sat in the watchdog escalation, the one component whose lane early-stopped before self-review — including a `void`
  promise with no `.catch()` that would have **exited the trading process**. Four MUST-FIX bodies + all mutation evidence: `LOG.md` § Pass 65.
  **REDEPLOY CARVE-OUTS, now TIMED (sixth confirmation, Pass 65) — every one is a mid-boot artifact, NOT a defect:** `mode_info{effective="paper"}` at +39s → `testnet` by **+69s**; zero clean-stamp and
  zero budget gauge at +69s, both initialised by **+99s**; re-seeded `agentic_venue_stop_total`, reset RSS, ~15 min of legitimately zero decides (**bar phase, not a stall**), and a *critical*
  `ReconcilerStalled` for ~45s (4 samples, +3.3s to +48s). Promtool trap: playbook §5.3.
- **`BELOW_PASSIVE_BENCHMARK` FIRES ON A REAL COMPARISON — SETTLED.** `state="COMPUTED"` and the bar has now MOVED THREE TIMES (−1.6955 P63 → −1.2296 P64 → **−4.6574 P65**), so it is a live computation,
  not the `+Inf` refusal sentinel.
- **⚠ READ `studies/redesign-scoreboard-2026-08-04.md` BEFORE TOUCHING ANY COST LEVER.** It governs L1/L4, carries the dated S3 stop triggers, declares **L2 and L5 NULL before they ship** and **L3
  BLOCKED**, and holds the refusal list (never raise `SIZER_EQUITY_CAP` past 1000 or the $3/day breaker, never move `PROMOTION_EVIDENCE_EPOCH`, never touch the promotion gate or `MIN_WINDOW_DAYS`) plus
  the clause binding against its own author: **"cutting spend purely to postpone S3, while gross stays negative, is gerrymandering the stop."**
- **THE PERP TRADES AXIS IS FIXED, DEPLOYED AND CONFIRMED LIVE** — 93 trades in 2 passes against ZERO across all 19,587 lifetime passes before; pinned ccxt derives the dead window CLIENT-SIDE so
  `since = 0` returned EMPTY **with no throw**, which is why no `sweep_failure` recorded it. **The fill-backfill ENGAGED first at Pass 62.** Body: `archive/LOG-through-pass-47.md` § Pass 60.
- **The book, ONE `evaluate()` sample (2026-08-06T16:33:53Z):** `windowDays=13.6763003472, roundTrips=61, netPnlUsd=−72.7377983944, llmCostUsd=33.1938887, winRate=0.2622950820, ready=false`, reasons
  `[NON_POSITIVE_NET_PNL, INSUFFICIENT_WINDOW, BELOW_PASSIVE_BENCHMARK]`. **Never quote these from separate reads, and never quote a book figure without its as-of instant** — an uncapped read is
  unreproducible by construction, and `llmCostUsd` STILL has no `asOfMs` bound (#150). Gross alone ≈ **−$39**, so **zero LLM spend still leaves the book negative**. **The window stops binding tonight**
  (13.68 of 14 days) **and the gate still does not open** — `NON_POSITIVE_NET_PNL` is untouched by it. Passive bar moved a THIRD time, −4.6574; strategy is ~**$68.08 worse than doing nothing**.
- **Six re-derivations moved the record (Pass 60)** — ENTRIES verdict UNMOVED and strengthened; **Arm2−Arm1's sign FLIPS (+29.7 → −34.3 bps)**; **the fee defect ALONE would have cleared clause 1's
  ≥30 bps condition**; **`13.29%` VERIFIED**, **`n=64` is STALENESS not error**, the `×2` leg conversion is **NOT an aggregation error**. `studies/exit-attribution-restated-2026-08-03.md` + siblings.
- **THE FILTER-DRIFT GUARD FIRED ON ITS FIRST LIVE BOOT AND CAUGHT A REAL 10× ERROR** (`FIL/USDT tickSize`, FIXED P61 — isolated, not table drift). **THE TWO SURVIVING LEVERS ARE ENABLED 2026-08-04 on
  owner instruction** — `AGENTIC_OUTPUT_EFFORT=medium` (L1) and `AGENTIC_WAKE_MOVE_PCT=0.012` (L4). **⚠ L1's entry-rate rollback trigger is TRIPLY CONFOUNDED on this window** (`022b361`, P62's trade-flow
  fix, its prompt disclosure); **L1's PRIMARY signature — `truncated_max_tokens` → 0, output-token spend — is UNAFFECTED by payload content and stays the readable one.** **PIN-SET LEAK CLOSED P62.**
- **THE SPOT LANE IS SEVERELY SUPPRESSED, AND THE OBVIOUS EXPLANATION IS HALF WRONG.** `sideEligibility` is **prompt payload, not a code gate**. **14 lifetime `open_long`, zero `open_short` ever**; 0
  entries on 191 v10 consults, P(0) ≈ 3.8e-4 — **confounded with v10**. Spot is **−190.1 bps/trip on n=7**, 4× worse than perp, but **n=7 cannot distinguish that from noise**. **Justify any re-scope on
  EXPECTANCY, never on cost** — `verdicts.md`'s "do not propose cost work as a profitability lever" still BINDS. Backlog 58.
- **WATCH-PLAYBOOK-V10-1 IS RESTATED IN TWO TIERS; the FIRED-POWERED Pass-59 reading STANDS — do not re-derive it. ROLLBACK REMAINS REFUSED** (`AGENTIC_PLAYBOOK_PIN=8` re-arms v9+v10, activates Thompson
  sampling for the first time ever, and **silently cancels the daily-minting override**). The sweep's adverse-selection annotation was FALSE for this metric (fixed P61); the filled-vs-unfilled split on
  the same rows is the instrument that can show it.
- **NOTHING HERE CAN CURRENTLY BE SHOWN TO LEARN — the mechanism is DIVISION, not suppression.** Only v1 and v2 of eight versions ever reached n≥12 AND k≥5, both the oldest; **OWNER DECISION OWED: daily
  minting and powered evidence are mutually exclusive** (`candidate-routing-override-2026-07-31.md`). **THE SUCCESS/STOP CRITERIA ARE ADOPTED** (owner 2026-08-01: `1C, 2A, 3A, 4A`) — window closes
  **2026-08-31**, S3's −$200/$150 triggers LIVE, **G1 re-cut to h=16** with a FEASIBILITY **bound [+45.0, +92.6] @K=20, not a point**, and **S3 WILL LIKELY DECIDE THIS FIRST** (−$200 lands ~2026-08-27).
- **Process misses stay recorded, not smoothed** (`LOG.md` §§ 61–65). **The recurring one is the ORCHESTRATOR asserting what it has not checked** — P62 gave a lane a REFUTED fix direction; P63 relayed a
  peer's UNVERIFIED claim as fact and asserted a 46×-wrong latency figure that reached the code; **P65 briefed THREE wrong claims about the halt** (all falsified by lanes) **and authored the boot-transient
  alert defect outright.** Every one was caught by a lane or a reviewer, never by the orchestrator. **A claim inherited from another lane — or from the orchestrator — is evidence of nothing until this pass
  checks it.** Also: `pnpm --dir <repo> vitest …` fails EACCES; the working form is **`pnpm --dir <repo> exec vitest …`**.
- **Settled, and repeatedly rediscovered — read the pointer before re-investigating** (`LOG.md` §§ 58–59). `config_snapshots` HAS a writer (fails OPEN, reader CLOSED — **WATCH-V4-16**); `llm_usage` is
  **vestigial by design** and `llmCostUsd` CORRECT, so **do not drop those 69 rows**; the playbook documents **all 24 alarm kinds** and **`loop-sweep-specs` IS on the production gate**; **`loop:authoring`:
  an API-shape failure burns the whole UTC day — and so does a budget ABORT** (P65 proved it), so **`--dry-run` is free insurance but does NOT exercise the abort path**; **FAMILY B IS NOT BLOCKED**; the
  decide-model A/B is **NOT working**, so **`AGENTIC_MODEL_AB_PCT` stays 0**.
- **COLLISION #7 — the lease BINDS ONLY CALLERS**, so an interactive session's `b2f7f53` landed mid-pass unseen. **RUN `git log` AT REHYDRATION, not only before committing.** Standing: **stage only files
  the pass authored**; **`loop:fanout declare` OVERWRITES A LIVE ROSTER** — declare ONCE per pass or join first; **`node -e` is DENIED by the tool-hierarchy hook**; `pnpm --dir <repo> vitest` fails
  EACCES, use **`exec vitest`**. **AN EARLY-STOPPING LANE RETURNS AN INTERMEDIATE THOUGHT — P62 once, P63 twice, P64 once, PASS 65 THREE TIMES** (an implementer and BOTH follow-ups; one filed NO report
  at all). **CHECK ARTIFACTS, NEVER THE REPORT ALONE** — in every P65 case the artifacts were further along than the report, and the orchestrator verified by running its own mutations. **Last pass:**
  Pass 65, 2026-08-06. Cadence 3×/day; the 2h lease is time-based — mid-pass release-and-re-arm with a matching nonce is the sanctioned way to run past it (used P65 at 17:27Z).
- **THE PASS IS SERIAL-TAIL-BOUND, NOT FINDING-BOUND — LATENT defects are recorded with a named trigger, LIVE ones are fixed in-pass** (P64 option 2). Standing example: the derivatives-feed spot-ticker
  error counter is real but **INERT** (`AGENTIC_DERIVATIVES_V2_ENABLED` defaults false). **Trigger to ship: any enable of derivatives v2.** Also settled: `api.binance.com` is DELIBERATE (read-only
  context from production; orders stay sandboxed). **P65 RECOMMENDS TWO PROCESS CHANGES** — put `test:cov` on `pnpm checks` (backlog 56, proved a third time), and evaluate every new alert rule against a
  freshly-booted process before shipping (promtool validates syntax, not semantics; only a reviewer caught the boot-transient page). `LOG.md` § Pass 65.

## Open WATCH lines — one line each; full text in `watches.md`

| id | expected-positive | status at Pass 59 unless the row says otherwise |
| --- | --- | --- |
| WATCH-V3-1 | app RSS holds under ~900 MiB (host-paper plateau ~673 MiB is the reference) | **HOLDS** — 770 MiB at P65. The Pass-59 "ACCELERATED" reading is WITHDRAWN as an instrument artifact: `rssBytes` is a bare two-point subtraction and this host restarts ~25×/week, so a pair straddling the post-boot ramp manufactures a phantom slope (it did twice). **Control: the 49.7h boot of 2026-08-01 — +0.75 MiB/h, NEGATIVE trailing-24h slope, 801.3 MiB ceiling.** **Do not divide a straddling delta by the sweep gap** — use a range query past `RSS_WARMUP_GRACE_MS`. Body: `watches.md` |
| WATCH-V4-1 | clean-stamp age under ~2 min, and every `adopt_non_adoptable` occurrence is transient AND explained by an ACK in the preceding pass interval | holds — Pass 59's 14:00:57Z occurrence passes BOTH clauses (next binanceusdm pass 14:01:48Z CLEAN; two binanceusdm `LIMIT_MAKER` ACKs at 14:00:29Z/14:00:43Z inside the preceding interval). **Its halt-class sentence was CORRECTED Pass 59** — see the standing caution above |
| WATCH-V4-4 | `fills` rows carry a same-venue clientOrderId and sum to `orders.cum_qty` on every terminal order | holds — **and is no longer hand-checked**: the I2 sweep invariant (2026-08-03) compares `cum_qty` to summed fills in exact SQL `NUMERIC` on every terminal order, every pass, failing CLOSED. 439 terminal orders, 0 mismatches |
| WATCH-V4-21 | **NEW P65** (`7edd4a6`) — after a stream outage, `market_channel_staleness_seconds` returns to <60s WITHOUT a container restart, and `market-stream markets cache was wedged` appears at most once per 15s cooldown | **UNFIRED.** Named defects: staleness stays pinned while the log shows the reload firing ⇒ `loadMarkets(true)` does not re-enter `loadMarketsHelper` on this ccxt build; more than one `exchangeInfo` per cooldown ⇒ single-flight broken; a watchdog escalation with `staleClose` NOT incrementing ⇒ the additive-lever fix regressed. **`hasNoMarkets` reads `exchange.symbols.length` — re-verify if ccxt is bumped** |
| WATCH-V4-22 | **NEW P65** (`e94c11e`) — `agentic_last_gate_timestamp_seconds` is NON-ZERO within one scrape of every boot, and `AgenticLaneNotTicking` does NOT fire on a healthy redeploy | **FIRST READING MET at 17:39:41Z** — gauge = boot instant, age 35s, alert would not fire (unseeded it would have read 0 and paged CRITICAL 5 min in). Named defects: a 0 reading on any boot ⇒ the seed regressed; the alert firing on a healthy boot ⇒ 2700s is too tight against real bar phase; it NEVER firing through a genuine feed outage ⇒ the series is not wired to the gate |
| WATCH-V4-23 | **NEW P65** (`069d40f`) — a boot carrying HALT rows raises `reconcile_halt_in_boot` exactly once per venue, and a routine redeploy sweep raises NO `_unreadable` | **UNFIRED.** Named defects: both `reconcile_halt` and `_in_boot` on one episode ⇒ the `!latestIsHalt` guard broke; `_unreadable` on every redeploy ⇒ the unresolved-bootId annotation split regressed and §3 is wedged on a routine step; silence across a boot that DID halt ⇒ the bootId provenance check is rejecting a valid count |
| WATCH-V4-24 | **NEW P65** (`0e7b375`) — one symbol's `fetchMyTrades` throw no longer aborts the venue poll: surviving symbols still ingest, and `sinceByVenue` does NOT advance on a partial poll | **UNFIRED.** Named defects: a venue-fired stop fill arriving >15 min after its `venue_timestamp` ⇒ the healer is still starved; a watermark advancing while any symbol was skipped ⇒ the fill-loss path this guard exists to close is open. **The hold is unbounded by design** — see `LOG.md` § Pass 65 for the truncation ceilings it grows toward |
| WATCH-V4-11 | `orphan_scan` > 0 on a boot with a flat perp bar, and every resolved algo-rail cancel appends `algo-hist:CANCELED` to `order_events` | **RE-READ Pass 58 — expected-positive CONFIRMED again**: `orphan_scan=2843 readopt=1 cancel=0 cancel_failed=0` on binanceusdm before the redeploy. Re-seeded to 0 by each redeploy, so it re-reads on the next flat perp bar |
| WATCH-V4-12 | truncation degrades carry `truncated_max_tokens:` with `output_tokens` == 4096, not `schema_rejected:` | holds, all pinned at exactly 4096. **Priced: $0.6148/day = 20.5% of the breaker, 30.2% of decide spend, all paid and discarded, running since 2026-07-23.** L1 (`AGENTIC_OUTPUT_EFFORT=medium`) is LIVE and its expected-positive is **NOT met** (banner above). **Both alternatives stay refuted**: `budget_tokens` 400s on sonnet-5; raising `AGENTIC_MAX_TOKENS` breaks the 75s batch budget |
| WATCH-V4-14 | a terminal-reject burst of ≥3 in 15m surfaces as a `prometheus_alert_firing_nonblocking` annotation naming `VenueTerminalRejectBurst` in the FIRST sweep after it, and agrees with the sweep's own rate alarm | **UNFIRED — and the recorded deadline framing was WRONG, corrected Pass 63.** Rejects are NOT absent: **46 in 7 days**, newest 2026-08-03T22:00:58Z. Exactly ONE 15-min bucket ever reached the ≥3 threshold — **2026-07-31T13:00Z with 12** — and it PREDATES the rule. The rule IS loaded and healthy at severity `warning` (25 rules, 0 firing, 0 unhealthy), which is the GOOD outcome for its third clause (it cannot wedge §3). **Correct status: untriggered because no qualifying burst has occurred since deployment — NOT "untested because nothing rejects"** |
| WATCH-V4-18 | a restart re-arm over a position with resting protective orders reports `stop=…[resting-stop]` / `tp=…[resting-tp]`, never `[synthetic]`, and the re-armed `takeProfitPct` stops being exactly `0.02` | **MET — FIRST READING Pass 64, expected-positive CONFIRMED.** Of 6 `forced_rearm` consults only **ZEC** lacked model directives and hit the fallback; it tagged **`[resting-stop]`/`[resting-tp]`**, never `[synthetic]`, and both pcts (**3.5015% / 3.0002%**) reproduce from ZEC's own pre-boot resting orders. `agentic_rearm_fallback_total=1`; `orphan_readopt=6` confirms the re-adopt it depends on is running. **No TP at exactly 0.02 across any of the 6.** Third named defect (drift-cancel churn falling) is **INCONCLUSIVE on n=1 post-fix boot — not scored either way** |
| WATCH-V4-19 | no positioned symbol crosses a bar boundary with no protective stop resting; `placed` increments in the SAME bar as each `drift_cancel` | **MET on binanceusdm — FIRST READING Pass 64. 8/8 drift-cancels paired same-bar**, by `order_events` timestamps not totals: TP leg 4/4 (gaps **5–27 ms**), stop leg 4/4 (**0.25–0.50 s**, each journaling `algo-hist:CANCELED`). `placed`=5 = 4 replacements + 1 fresh KAITO scale-in. **The `sideCollateral` guard fired 0 of 4** — the compound path was the common case (n=4). **VOID/STARVATION on binance spot** as flagged: zero order activity of ANY kind since 2026-07-31T01:54Z, positive control returns real historical `InsufficientFunds` rows, so the zero is a real absence but proves nothing |
| WATCH-V4-20 | a rejected portfolio batch stops costing every symbol in it: `batch_stringified_recovered` increments on the first cleanly-stringified payload; `empty_tool_input:` rows carry an empty payload AND a non-`max_tokens` stop; every discard-stamped `nextConsultBars` is ≤ `AGENTIC_FALLBACK_CONSULT_BARS` | **NEW Pass 64 (`fbb3800`), UNFIRED.** Named defects: `batch_stringified_recovered` stays 0 while `{kind="batch"}` fires ⇒ the live shape is always malformed-inner (as boot `e423875b`'s own case was) and the salvage addresses a shape that does not occur; `empty_tool_input:` never fires ⇒ the split bought diagnosability nobody needed; a stamped value above the fallback ⇒ clamp not wired. **Both counters ZERO-SEED at boot, so a zero is a real absence.** Baseline (pre-fix boot): 1037 clean / 2 truncated / 1 schema_rejected. Deadline **2026-08-09** |
| WATCH-V4-13 | on the FIRST spot entry after `f5abf8a`, `agentic_venue_stop_total{venue="binance",event="stood_down"}` increments, `{venue="binance",event="placed"}` stays 0, and NO `InsufficientFunds` on a spot `reduce_only` SELL | **STILL VOID at Pass 58 — and now known to be STRUCTURALLY STARVED, not merely quiet.** All binance stop counters 0; zero binance submits of any kind for 3d 7h; 191 spot consults → 0 entries. This watch cannot be answered until the spot-suppression question (backlog 58) is settled — record it as BLOCKED-ON-EVIDENCE, not as holding |
| WATCH-PLAN-AUTHORITY-1 | `plan_authoritative_close:` holds at ~the historical close rate AND the exit mix shifts toward venue stop/TP/max_hold | **FIRED.** Baseline −108.1 bps/trip at 17.4% hit; revert if positions storm to `max_hold` worse than that |
| WATCH-PLAYBOOK-V10-1 | live entry forward return under v10 lands above `champion_v8`'s replayed −12.7/−36.3/−32.7/−70.1 bps | **RESTATED 2026-08-04 in two tiers (`watches.md` amendment); the FIRED-POWERED Pass-59 reading STANDS — do not re-derive.** Tier 1 (v10-live vs v8-live: h=1 −24.3, h=4 **+52.0**, h=8 **+16.2**, h=24 −31.2) is **CAPPED UNDERPOWERED FOREVER** — v8 is n=8/k=5 and accrues no new entries, so it carries NO deadline. Tier 2 is adjudicable NOW: market-neutral v10 excludes zero at h=4/h=8, and the raw live v10 cell does too (−45.3 [−122.0, −0.3], −52.8 [−134.9, −1.5]); **h=1 and h=24 straddle zero and are not adverse**. Filled-vs-unfilled re-reads at NOFILL n≥12 (~2026-08-09). **ROLLBACK REFUSED** — see § Current order |
| WATCH-DEPLOY-HALVES-1 | the first authoring run under the amended bar reports a `halvesVerdict` at h=24 with a non-null `halvesSplitAtMs`, THE SAME for every arm | **NEW Pass 52, SAMPLE ZERO.** Named defects: every candidate `UNDETERMINED` (clause decorative) or a per-arm `halvesSplitAtMs` (split not shared). The frozen recorded-incumbent path reads UNDETERMINED by construction and that is accepted, not a defect. **An unrun check is not a passing one** |
| WATCH-V4-16 | **NEW Pass 58.** Every boot leaves exactly ONE `config_snapshots` row per config hash; an unchanged redeploy BUMPS `activated_at` on the existing row rather than inserting a second; `config_snapshot_missing` stays cleared | **FIRST READING GREEN** — 1 row, `dust 5`, `epoch 2026-07-21T11:21:00Z`, no `db`/`bootId`/`gitSha`. Named defect outcomes: duplicate rows per hash ⇒ wrong upsert target; `activated_at` NOT moving on an unchanged redeploy ⇒ `onConflictDoUpdate` not firing; `config_snapshot_drift` ⇒ either real drift or the nested key walk mis-resolving; the alarm RETURNING ⇒ the fail-open writer is failing silently — read the app log for `config snapshot write failed`, do not rebuild the writer |
| WATCH-V4-17 | **NEW Pass 58.** No symbol carrying an in-flight entry intent is absent from `agentic_active_menu` at a recompute | **UNFIRED.** Named defect outcome: an `off_menu` hold journalled for a symbol that has an in-flight intent — i.e. the pre-existing gap `548376c` closed has reappeared. Note the exposure window is up to a full UTC day, because `isPinned` is only evaluated inside `recompute()` |
| WATCH-V4-15 | `stale_venue_open` appears on an ordinary in-sweep cancel and does NOT halt, while a coid still venue-open past `driftPasses` consecutive passes DOES halt with its id in `reconciliations.detail` | **FIRED FOR THE FIRST TIME Pass 62 — expected-positive CONFIRMED on the first tier.** `stale_venue_open:1` on binanceusdm at 2026-08-04T08:31:21Z, result MISMATCH **not HALT**, next pass CLEAN at 08:32:16Z. The durable second tier (a coid still venue-open past `driftPasses`) is STILL UNFIRED and stays the open half of this watch — do not read the first-tier confirmation as covering it |

Resolved WATCH lines (V3-2, V3-3, V4-5, V4-6, V4-8, **V4-10 moved out Pass 54**) are kept in full in `watches.md` § Resolved — closed, not deleted; do not re-open one without new evidence.

## Open defects — the three LIVE exit-path ones are now CONFIRMED CLOSED FROM OUTSIDE THE TEST SUITE (Pass 64 first readings)

**#147/#148/#149 SHIPPED `44792d9`, #150/#152 SHIPPED `37587f6`; WATCH-V4-18 and WATCH-V4-19 both read MET at Pass 64** — confirmed live, not merely deployed. Bodies + #151's evidence-based REFUSAL (not
a deferral) and its non-reproducing "25.2% / $7.72" figure: `watches.md` § Open defects #147–#152, `LOG.md` § Pass 63–64. **Do not "fix" #151's `evidence`-object bounds — adequate as-is.**
**STILL OPEN, seam named:** #149's CLOCK half — `maxHoldBars: 96`/`barsElapsed: 0` hardcoded because **no reachable port carries the position's open time**; the seam is a new optional
`AgenticStrategyDeps` closure in `trading-runtime.module.ts`. **NEW Pass 65:** 4 phantom `ACKED` local stop rows (UNI ×2, KAITO ×2, 2026-07-31) with no venue algo-rail counterpart — no exposure, but
nothing reconciles them (open-orders axis is regular-rail-only; the position axis does not read orders); clearing them means cancelling/terminalizing orders. Per-symbol fill watermarks: `LOG.md` § Pass 65.

## Backlog (open — improvements ONLY, never bugs; conventions in `charter.md`)

| # | Item | Stage | Effort | Status / next check |
| --- | --- | --- | --- | --- |
| 48 | Weekly vol-ranked symbol rotation (universe-study follow-on) | 2 | M | DESIGN-GATED: the 5→8 sequencing gate is OBE (40 symbols + vol×ATR scanner + menu-8); residual = the rotation-vs-promotion-walk attribution design |
| 56 | Put `test:cov` on `pnpm checks` | 2 | S | **Proved again Pass 60**: `6029d72` shipped five uncovered branches and only an A/B revert found them. One line, once the `v8 ignore` annotations are spot-checked |
| 58 | Retire or re-scope the spot half of the universe | 1 | M | 191 spot consults → **0** entries under v10 (P(0) ≈ 3.8e-4); **14 lifetime spot `open_long`, zero `open_short` ever**; spot realized PnL **−$8.01 over 7 lifetime entries**, and Pass 62 measures **−190.1 bps/trip mean on n=7 — 4× worse than perp, but n=7 is not a basis for a venue decision.** **Justify on EXPECTANCY, never on cost.** Confounded with v10 `inverted`. Remedies: `LOG.md` § Pass 58 |

Row **57 CLOSED 2026-08-03 with a measured answer** (decoupling artifact +21.0 bps/trip, CI [+1.4, +39.8] — it FLATTERS the demo book, so it cannot be what makes it negative; `studies/frame-audit-2026-08-03.md`). Rows **54/55** moved in full to `charter.md` § Backlog closed ledger; **18/44/45/47** retired OBSOLETE 2026-07-30. **Do not re-open one because its gate has cleared.**

## Flagged for human review (open) — owner capability limits only, full text in `watches.md`

- **THE OWNER DECISION THIS PROGRAM TURNS ON** — the gate CANNOT be passed, by arithmetic: an arm must post +20.9/+26.4/+33.8/+81.4 bps, the bar is **CLUSTER-limited**, unreachable at h=1/4 at ANY cluster
  count, universe **28 BASES not 40 strings** ("STOP with extra steps", unrebutted) — **and that bar was itself never derived** (top banner). **The mechanism: a 24% hit rate against a 41.65% gross
  break-even is what "cannot be passed" means.**
- **FAMILY B: DECIDED NO RUN 2026-08-04** (owner delegated the go/no-go) — superseded by the live forward-return watch, POWERED on v10. **THE OOS SESSION ARM HAS NEVER RUN — prereg REPAIRED 08-04**,
  awaiting the owner-side hourly trigger. `studies/family-b-disposition-2026-08-04.md`, `studies/oos-session-arm-2026-08-03.md`.
- **ONE `.env.app` edit hook-blocked** — `:153` spot/`STOP_LOSS_LIMIT` FALSE since `f5abf8a`. **`:159` `AGENTIC_PLAYBOOK_AB_PCT=40` must NOT be zeroed** (cancels the daily-minting override). **The daily
  mint has produced ZERO candidates in 6 days** — 08-04's three all REFUSED, and **08-06's run ABORTED on its $5 cap and logged NOTHING** (banner above). Anthropic funded, Moonshot presumed suspended.
- **Concurrent passes / lease** — **SEVEN** collisions; the lease **binds only callers** and **fails OPEN**, so a dead holder is undetectable: P56's was 46.6h stale and **P64's 2398 min stale with its
  whole report uncommitted in the tree** (recovered by P65 as `af22c6d`). Scheduler/session co-firing is owner-owned.
- **Availability** — the stack runs on the owner's MacBook; host sleep throttles everything and **a suspend is what triggered the P65 feed wedge**. **Shared-org rate limit**; the CryptoPanic key (X4) is
  still open. **6.9-LINK wallet scar (~$55)** — journaled and deduped post-epoch; a manual sell is optional hygiene only.

## Index — every loop file, and when to read it

**`STATUS.md`** (this file) always, first; **`LOG.md`** to append this pass and read the last five; **`watches.md`** for a WATCH's exact expected-positive / named defect outcome and open flagged items;
**`verdicts.md`** before proposing work in an area it covers; **`charter.md`** for loop-domain vs owner, pre-authorizations, settled decisions. **Full table — including the archives, the `state.md` stub,
`digests/` and `incidents/` — moved to `charter.md` § Loop file index (Pass 63, for the 200-line cap).**

**Maintenance rule (playbook §6 — a one-off compaction just re-grows).** Each pass appends to `LOG.md` and updates THIS file; past five entries the oldest rotates VERBATIM to `archive/LOG-through-pass-47.md`. **Nothing is ever deleted from a loop file — only moved, with a pointer left behind.** Outgrown a few lines? Move the body out. (P53: backlog 54/55 → `charter.md`, promtool trap → playbook §5. P54: WATCH-V4-10 → `watches.md`. P58: Family B correction → its own study. P60: perp-axis banner retired, six standing cautions folded to four. **P65: the three standing economic findings folded into ONE block with their bodies left in `studies/`; the Pass-64 consult-discard and L1 banners compressed to their facts; Pass 60's LOG entry rotated to archive and its two bullets re-pointed there. Prose wraps ~150–190 columns — that is where much of the reclaimed space comes from, the rest is real compression.**)
