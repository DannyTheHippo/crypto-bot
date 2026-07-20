# Daily profitability loop — state

Playbook (durable procedure): `docs/planning/daily-profitability-loop.md`

This file holds CURRENT state only — strategic frame, stage, backlog, open flags, latest pass.
Per-pass history lives in `reports/loop/LOG.md` (every pass has a dated entry). Compacted
2026-07-13 (owner-directed housekeeping, see the LOG entry of that date): pruned blocks survive
in LOG.md and git history; every open item below was re-verified against code that day.

## Strategic frame

The mutable strategy the playbook deliberately does not embed. Passes update stage status here;
when the owner approves a new spec, replace the pointer (and archive the old spec) — the playbook
never changes for strategy evolution.

- **Active spec:** `docs/specs/2026-07-06-profitability-design.md` (owner-approved 2026-07-06).
- **Goal:** real live profitability at **$1k–$5k capital** (owner, 2026-07-06). Objective
  function: net-of-cost PnL = `realizedPnl − fees − llmCostUsd`.
- **Active frame (owner decisions 2026-07-10):** the LLM agentic lane is the program centerpiece —
  it trades AND self-learns. The daily loop (a Claude session on subscription, ~zero marginal
  cost) is the heavyweight researcher driving that self-learning: **"LLM proposes, backtest
  disposes."** Playbook v2 codifies the pipeline: draft candidate playbooks IN-SESSION → score
  offline (`AGENTIC_CANDIDATE_PLAYBOOK_FILE` recorded-payload live-compare eval, ≤$20/gate) → log
  EVERY scored variant (winner and losers) to the append-only experiments registry (migration
  0009, `test/backtest/experiment-log.ts`) → inject champion-beaters via `pnpm playbook:candidate`
  → live A/B (`AGENTIC_PLAYBOOK_AB_PCT`) + attributed auto-promotion decide. Cadence
  **2–4 passes/day**. The funding-carry sub-plan is resolved NO-GO (§ Standing verdicts).
- **Standing owner decisions 2026-07-10 (policy, still operative):** (1) no owner gate on redeploy
  — validated-better versions are committed AND deployed autonomously (demo/paper stack; ship
  criterion unchanged: gates green + out-of-sample/net-of-cost evidence + §5 soak); (2) the daily
  loop (or equivalent automated process) drives the program; (3) the ONLY human touch is the
  live-money flip — four live gates, bootId arming ceremony, promotion gate unchanged;
  (4) `BINANCE_DEMO_*` keys cover futures-demo (demo-fapi) testing.
- **OWNER DECISION 2026-07-12 (verbatim: "No owner decisions; this is your domain and the aim of
  these passes is profitability. Just do what you have to."):** demo-stack measurement and
  configuration decisions previously routed as owner proposals — evidence-epoch declarations
  included, and the named pre-authorizations below once their stated trigger conditions are met —
  are **loop-domain**: a pass decides, applies, and records the decision + rationale in
  LOG.md/state.md instead of flagging and waiting. This extends the 2026-07-10 decisions above;
  decision (3) is UNCHANGED — the live-money flip remains the sole human checkpoint, and the
  playbook §4 MUST-NOT boundaries (risk/execution/OMS semantics, live gates, append-only tables,
  secrets) are structural rails, not preferences — delegation does not relax them.
- **OWNER DECISION 2026-07-16 — bug-routing discipline (encoded in playbook §3):** the backlog,
  the loop, and similar mechanisms are NOT bug collectors — a bug found by a pass is FIXED in that
  pass; the backlog holds only improvements that move net-of-cost PnL or measurement trust. Fixes
  exceeding the §4 rails go to "Flagged for human review" as OPEN DEFECTS (evidence + exact diff),
  never to the backlog. Applied retroactively: #49 reclassified from backlog seed to § Flagged.
- **OWNER DECISIONS 2026-07-17 (interactive session; plan `should-we-not-just-elegant-locket`):**
  (1) **Full money-path delegation, encoded in playbook §4 — the ONLY owner gate in the program
  is the live-money flip.** Demo-lane risk/execution/OMS/adapter work — defect fixes AND new
  capability — is loop-domain under the standing discipline: mandatory adversarial reviewer
  dispatch, full gates + livegate/paper, deploy soak, decision record + WATCH, two-step enables
  for behavior-changing capability, never two money-path items per pass. The §4 MUST-NOT list
  shrinks to the live-flip/audit invariants (live gates + arming, append-only tables +
  money-table schema, secrets/redaction) — invariants on what a change may do, not gates on who
  approves it. Supersedes the 2026-07-07 scoped exceptions and the 2026-07-10 perp-venue
  owner-scope note. (2) Both § Flagged defects (perp phantom position; #49 atomicity) AUTHORIZED
  — sequenced, phantom first. (3) app-perp stays RUNNING until the fix deploys (containment
  holding per Pass 31). (4) Evidence gates re-affirmed exactly as pre-registered (promotion
  floors, factorial floor, shorts soak, watcher study) — no loosening; v2's runway is protected
  via config instead (lapse 168→336h, playbook A/B 25→40). (5) The 5→8 universe pre-auth is
  FIRED this session (see § Pre-authorizations).
- **Stage ladder + exit criteria (condensed from the active spec):**
  1. **Cost floor** — CLOSED 2026-07-08: true spend ~$0.77/day under the $5 breaker, skip rate
     70–83% (original criterion: ≤$1/day ×3 days + ≥2 RT/day + no EXPIRED regressions).
  2. **Learning-loop edge** — ACTIVE. Exit: ≥2 playbook promotions with version-attributed PnL
     AND rolling-7d net-of-cost ≥0. **Current status (Pass 26, 2026-07-15) — reflection loop ALIVE
     & HEALTHY on BOTH lanes, `c0d53bd` seed-race fix LIVE-VERIFIED:** SPOT playbook active v1, v2
     unresolved in A/B. **v2 is now PARTICIPATING and WINNING EARLY — 3/10 attributed trips (Pass 27;
     2/10 at Pass 26; 0/abstaining at Pass 24), net-of-cost +$1.09 vs champion v1 −$1.90 — so the
     abstention deadlock resolved NATURALLY.** The Pass-24 prediction ("the abstain-lapse
     `AGENTIC_ABSTAIN_LAPSE_DECIDES=15` mints v3 immediately") is **OBE**: the abstain-lapse condition
     is `decides≥15 && entries===0` (`reflection.service.ts:818`) and v2 now has `long` entries, so
     `entries===0` is false — the lapse is armed but doesn't fire. The BINDING guard is the **age-lapse**
     (`candidateLapseMs`, configured **168h**; boot log: `candidate v2 … still unresolved in A/B
     (age 99h < lapse 168h) — skipping mint, trigger preserved` ⇒ outcome `skipped_unresolved_candidate`,
     a healthy guard, NOT a defect). v2 minted 07-11 04:45Z ⇒ **mint-over at ~07-18 04:45Z unless it
     resolves via 10 attributed trips first.** `c0d53bd` verified: first close after boot `29e22ada`
     logged `trigger state seeded from DB … 17 closed trips lane-wide, 4 for this strategy` and fired
     the evaluation (no prime-but-fail). **PERP lane minted its OWN v2 (Pass 26, first live perp mint)**
     through the Phase-4 mint-backtest path (`attempt_started=1, minted=1`; separate DB/epoch;
     `minRr=2`/`minEdgeMultiple=2` changelog) — awaits its own 10-trip verdict.
     Reflection fires per strategy after 2 closed trips (`AGENTIC_REFLECTION_EVERY_N_TRADES=2`,
     `3e5773f`); NB the trigger check races the async DB seed on first-close-after-boot (primes
     but cannot fire — documented quirk, § Durable findings). PROMOTION pass eligibility:
     candidate needs ≥10 of its OWN attributed trips (symmetric — champion needs ≥10 in-window
     too); CANDIDATE passes stay blocked (§3(a)) while a candidate sits unresolved in A/B.
     **Update 2026-07-17 (owner session + Pass 32):** v2's runway re-protected — age-lapse 336h
     (mint-over ~07-25 04:45Z) + A/B 40% (`1a70a51`); the 07:45Z reflection attempt that bypassed
     the guard was the abstention-lapse WINDOW bug (v2's 4 longs beyond the recent-400 horizon
     post-5→8), fixed `cfb2ed3` with lifetime evidence — v2 now resolves on its 10-trip verdict
     or the 336h clock, nothing else mints over it.
  3. **Earned-live** — pass the coded promotion gate (`PromotionReadinessService`: ≥30 closed demo
     round trips, net-of-cost > 0, ≥14d window), then the unchanged human four-gate arming
     ceremony. Nothing automates live.
- **Settled owner decisions (not re-openable by a pass; argue in "Flagged for human review"
  instead):** no return to 1m/5m DECIDE cadence. Formerly settled, since REOPENED by owner:
  - **Shorts (2026-07-13, Push II plan approval): reopened for the DEMO stack only** — existing
    `BINANCE_DEMO_*` keys are futures-demo-capable (venue-path probe PASSED 2026-07-13: pinned
    ccxt 4.5.58 `binanceusdm.enableDemoTrading(true)` → `demo-fapi.binance.com`, auth + balance
    ($5,000 USDT) + orders + positions all OK; chosen path = real futures-demo venue, no
    PaperPerpAdapter, no ccxt bump). `PERP_LEVERAGE_CAP=1` unchanged. Live money, margin >1×, and
    the four live gates + arming ceremony untouched.
  - **Symbol set (2026-07-10): widened** BTC/ETH → **BTC, ETH, SOL, XRP, LINK at 15m**. Fallback:
    drop LINK on sustained >$3/day spend or attribution starvation. Further widening: see the 5→8
    pre-auth below.
  - **Models/cost (2026-07-08, "improve aggressively" mandate):** "Sonnet-5-only" and "≤$1/day"
    framings lifted. Reflection runs Opus-4.8; decide model changes ONLY via the $0 offline
    harness (never a blind flip); ceiling = `AGENTIC_DAILY_COST_STOP_USD=$5/day` breaker
    (expected true spend ~$2.2–2.5/day at 5 symbols).
- **Budgets:** `AGENTIC_DAILY_COST_STOP_USD=$5/day` runtime breaker; **≤$20/gate** for offline
  candidate evals (~2 API calls/replayed row — cap row count to stay under budget).
- **Pre-authorizations (owner; per the 2026-07-12 delegation a pass applies these itself once the
  trigger condition holds, recording the decision):**
  - (2026-07-07) IF net-of-cost > 0 AND round trips ≥ 30 before the 14-day window fills,
    `MIN_WINDOW_DAYS` 14→10 (`promotion-readiness.service.ts`). ≥30-trips and positive-net are
    NOT relaxable. UNFIRED.
  - (2026-07-08→13) **Sizing 0.05 APPLIED 2026-07-13** (`22af50d`, owner plan approval superseded
    the 15-trip trigger; full re-derivation memo in LOG.md 2026-07-13 owner session / git history
    of this file). Operative residuals: the expectancy ladder is the auto-brake (trailing 15-trip
    mean ≤ −$0.10 ⇒ strength ×0.4 ≈ $100, self-releasing; 8-trip data floor);
    `RISK_MAX_POSITION_PER_SYMBOL=1000` (base qty) is the **binding cap** — a sub-$0.50 symbol
    would be VETOED at entry, so universe expansion must avoid sub-$0.50 symbols or raise the cap
    with its own memo.
  - **Evidence epoch:** `PROMOTION_EVIDENCE_EPOCH=2026-07-12T08:30:00Z` (Pass 18 addendum, under
    the delegation; third epoch — 07-08 original, 07-10 wipe instant). Since `cc72a10` (#36) the
    epoch bounds ALL four consumers (gate, A/B attribution, promotion evaluator, reflection
    evidence/seeds). Declaring a new epoch = loop-domain; declare only at a verified flat instant.
  - **5→8 universe expansion (Push II close-out, owner-approved plan):** after a clean ≥2-day
    portfolio-consult soak (Phase-5 WATCH green), the loop may add **ZEC/AAVE/NEAR** per
    `reports/loop/universe-study-2026-07-13.md` — add the three DEFAULT_FILTERS rows from the
    report, re-derive gross exposure (8 × 0.05 ⇒ consider 0.04, record why), APPEND to
    TRADING_SYMBOLS, never reorder. **FIRED + APPLIED 2026-07-17 (owner session, `1a70a51`,
    spot boot `482d5ab1`):** Phase-5 consult WATCH resolved positive Pass 24; consult clean since
    the 07-13 enable (the 07-16 outage was market-data, not consult). Live demo-venue probe PASSED
    all three (TRADING; filters exactly match the study; ZEC $528.53 / AAVE $90.47 / NEAR $1.94 —
    all clear the $0.50 floor). Sizing 0.05→0.04 (8×0.04 ⇒ ~0.32 gross);
    `AGENTIC_MAX_CALLS_PER_DAY` 700→1100 (768 opportunities/day; breaker unchanged at $5).
    **WATCH:** first decides on ZEC/AAVE/NEAR post-warmup; daily spend ~$3.5–4 expected, breaker
    $5; no cap/notional entry vetoes on the new symbols; a sustained >$4.5/day = drop candidates
    per the study's fallback order. **Day-1 (Pass 32): decides GREEN all three** (ZEC 3 long
    proposes + open position with resting venue TP; AAVE/NEAR deciding), **zero risk vetoes**;
    spend ~$3.5–4.8/day (boot-cache-heavy window — not yet "sustained", re-measure); side effect:
    32 ws subscriptions crossed the venue 1008 burst cliff (Bug D, fixed `f9b7d56` — LOG.md).
    **Day-2 (Pass 33): spend re-measured ~$2.0–2.7/day — the day-1 band was boot-cache noise,
    fallback NOT armed; ZEC closed its first trip +$1.35 via the first-ever spot venue-TP fill.**

### Push II program (owner session 2026-07-13, plan `humming-sprouting-crab`) — 7/8 phases shipped, 5 live

All committed local with per-phase adversarial review; full detail in LOG.md 2026-07-13 entries
and the per-phase commits. Current per-phase state:

- **Phase 1 — LIMIT_MAKER entries + 0.05 sizing (`22af50d`), LIVE.** Post-only plan-priced
  entries with per-intent LIMIT fallback when the price would cross. WATCH RESOLVED POSITIVE
  (Pass 23): first entry journaled `LIMIT_MAKER` GTC, filled maker, notional in the ladder-braked
  band; no would-cross reject storm.
- **Phase 2 — venue-resting take-profit (`be2f4fa`), LIVE.** Plan-mode longs rest their TP at the
  venue (reduce-only LIMIT GTC at the exact TP price, maker-priced via
  `RISK_MAX_PASSIVE_EXIT_BAND_BPS=1200`); executor bar-close stop remains the only stop (spot OCO
  deferred → backlog #44). Evidence: +23.1bps/trade close-vs-touch
  (`reports/loop/bounds-calibration-2026-07-13.md`, N=26 descriptive). Shipped with the S3
  busy-set fix, BUY-scoped stale sweep (`cancelSide`), per-(strategy,symbol) serialized sink; 8
  adversarial-review findings all fixed same-session (list: LOG.md). **WATCH (Phase 2):**
  (1) placement RESOLVED POSITIVE (Pass 25: 15 `placed` under boot `695b6abf`, resting SELL at the
  plan TP); (2) first `venue_tp_filled` journal row (maker fee at exact TP price) still PENDING (0
  closes since boot); (3) **`qty_cancel` was NOT rare — it was the CHURN BUG, FIXED Pass 25
  (`debef0f`):** placed=15 / qty_cancel=14 / 0 skipped_existing because `manageVenueTp` compared the
  step-rounded resting qty against the raw full-precision `position.qty` (exact `.eq()`, structurally
  always false — LINK 12.03 vs 12.0396 etc.); now compares against `roundToStep(pos, step, 'down')`
  ⇒ steady-state `skipped_existing`. **Post-fix watch — Pass 26 PARTIAL POSITIVE:** under boot
  `29e22ada`, ZERO `venue_%` order_events this boot and the LINK venue TP (SELL LIMIT 12.03 @ 8.458 GTC,
  ACKED) rests stably with NO cancel/replace churn (`12.03 == roundToStep(12.0396, step, 'down')`);
  Pass 25's `qty_cancel=14` churn is GONE. **`skipped_existing`-climbs CONFIRMED Pass 28** (spot
  `placed=1, skipped_existing=2` — steady-state signature; watch CLOSED POSITIVE);
  (4) an `orphan_cancel` spike = external flattens racing the lane.
- **Phase 3 — trade-flow/CVD + positioning payload blocks (`045967c`), LIVE.** Tags `tf1`/`pos1`;
  both ride the ONE info-context A/B (`AGENTIC_DERIVATIVES_AB_PCT=30`). **Treatment bundle
  composition changed 2026-07-13** (derivatives + crossSymbol + tradeFlow + positioning; control
  strips all four) — attribute the info-A/B verdict to the bundle-from-now. WATCH RESOLVED
  POSITIVE (Pass 23): payloads split cleanly (17 treatment rows with both blocks, 6 control rows
  with none; zero feed warns). Liquidation flow deliberately not shipped → backlog #43.
- **Phase 4 — mint-time candidate-vs-champion expectancy backtest (`7c18b93`), LIVE.** Every
  reflection draft clearing the entry-rate floor is replayed head-to-head vs the champion over
  the newest 60 recorded rows (`AGENTIC_MINT_BACKTEST_ROWS=60`; per-symbol grouped, plan-executor
  semantics, decide-cadence closes). Candidate trailing champion's mean net bps/trip by >10bps
  (`_MARGIN_BPS` is a noise HANDICAP: candidate ≥ champion − margin passes) with ≥3 simulated
  trips both arms ⇒ bounded retry-with-feedback then `expectancy_reject` + trigger rollback.
  Fail-open everywhere (veto-only — mint never blocked by measurement failure); ~$0.7–1.4/mint
  through the shared DailyLlmBudget. **WATCH (Phase 4), PENDING:** next reflection trigger logs
  `mint-backtest: candidate Xbps/trip vs champion Ybps/trip` → outcome `minted` (journaled with
  the prior) or `expectancy_reject` (rollback, next trip retries); a `mint-backtest skipped`
  warn-storm = budget sizing needs the sub-budget follow-up (→ backlog #50 for the outer-catch
  gap).
- **Phase 5 — portfolio consult (`0015bab`+`46996aa`, enabled `1d33326`), LIVE.** Up-to-5 per-bar
  decide calls coalesce into ONE `submit_portfolio` call (`AGENTIC_PORTFOLIO_CONSULT=true`,
  window 3000ms, `pf1` tag, `consult_id` migration 0011; usage on first-arrived symbol,
  absent-vs-zero preserved). Enable-gate opus review findings all resolved (batch schema failures
  SOFT-HOLD — no correlated auto-DRAIN; boot assertion on window/timeout worst case; refusal-path
  consultId pinned). Rollback = flip the flag (byte-identical legacy chain, test-pinned).
  Expected: decide CALL COUNT → ≤1 per bar-window, native cross-symbol reasoning, ~1.5–2.5×
  dollar savings. **WATCH (Phase 5), PENDING — next pass's first check:** (1) `consult_id`
  non-null on new multi-symbol-bar rows, shared within a bar; (2) per-day decide calls drop vs
  the pre-enable baseline; (3) a batch-holding warn-storm ('holding all') = API-overload burst —
  fine unless persistent; (4) strike/DRAIN counters must NOT correlate across all 5 strategies
  (that pattern = the soft-hold regressed). Accepted quirks: 1-symbol batches wait the full 3s
  window; the info-A/B arm is read once per batch at flush time.
- **Phase 6 — model studies (thinking-on; E2 decide-model), DONE, both NO FLIP.** Binding
  conclusions in § Standing verdicts; follow-up seeded as backlog #42 (thinking A/B). Full
  scorecards: LOG.md 2026-07-13 + session scratchpad archive.
- **Phase 7 — universe study, DONE (report `reports/loop/universe-study-2026-07-13.md`);** flip
  deferred to post-soak → the 5→8 pre-auth above.
- **Phase 8 — perp-demo venue + plan-mode shorts (`34e4728`), BUILT flag-off, NOT deployed.**
  Everything commented-out/false in compose — the spot deployment is byte-identical; **enabling
  is a SECOND deployment (own env), a separate decision.** Constructor guards: shorts require
  planMode AND a perp venue (spot+shorts throws). **#41 SHIPPED 2026-07-13 build-out
  (`eff1d95`): the shorts+consult blocker is CLEARED** — PORTFOLIO_SHORTS_TOOL (pf2) carries
  plan.direction per element; boot now refuses only the legacy non-plan shorts + consult
  combination. Two adversarial review rounds, all findings fixed + test-pinned (incl. the
  pre-existing protective-exit BUY-block rule that would have frozen a SHORT's stop; list:
  LOG.md). Perp DEFAULT_FILTERS rows are live fapi exchangeInfo figures fetched 2026-07-13.
  **DEPLOY CHECKLIST (before the perp deployment ever arms):** the venue-side isolated+leverage
  pin now runs fail-closed at boot automatically (#51, `3252c1e` — needs an INTEGER
  `PERP_LEVERAGE_CAP`; a fractional cap kills the boot by design), re-run the arm preconditions,
  start with ONE symbol.

### Push 3 program (owner session 2026-07-13/14, plan `humming-sprouting-crab` v3) — COMPLETE, 2 lanes live

Owner-approved four fronts ("make it all first-class"): perp lane live + shorts ladder; full
stop-side architecture (watcher + venue-native trigger stops); factorial info×thinking
measurement; every free info channel built flag-off. All committed local, per-phase gates green,
TWO adversarial review rounds on the stop architecture (8 findings, all fixed + test-pinned).
Commit manifest: `3c8b1a1` (P0 studies), `39a43cd` (P1 A/B PRF), `8609722` (P2 stop watcher
flag-off), `c1be07f` (P3 perp compose profile), `3da8e4d` (P4 reduceOnly forwarding), `c0d53bd`
(P5 reflection seed race), `17b37b4` (P0c factorial cell script), `d7783de` (P6 five info
channels flag-off), `2046b31` (P7a/P7b venue trigger-order path), `7de96ba` (P7c resting-order
role identity), `4ce1fe0` (P8a-prep arm journaling), `830f556` (P7d venue-stop lifecycle
flag-off), `749c88b` (P7e review fix: perp small-position protection gap), `c50d4ac` (P7f review
fix: OMS algo-rail containment, 7 sub-fixes), `a6f0573` (P8a factorial ENABLE, spot), `359e4a7`
(P8d binanceusdm capability fix), `aca7fb1` (P8d perp L0 ENABLE). Decision records:

- **P0a stop-slippage study (`reports/loop/stop-slippage-2026-07-13.md`): watcher enable NOT
  JUSTIFIED at N=3** (mean total stop leak +3.2bps/exit vs the pre-registered −10bps bar; zero
  re-fires; worst +47bps; one exit favorable). `PLAN_STOP_WATCH_ENABLED` stays 'false'.
  **PRE-AUTH (loop-domain):** re-run the study once stop-exit N≥10; enable iff the criterion
  (mean worse than −10bps/exit OR any single event ≤ −100bps) is then met. CORRECTION to the
  Push II Phase-2 line "executor bar-close stop remains the only stop": the S3 1s protective
  backstop has been ARMED all along in compose (`PROTECT_STOP_LOSS_PCT=0.02`,
  `PROTECT_TRAILING_PCT=0.015` — the 2026-07-12 SOL trail event WAS S3 firing); the plan stop is
  bar-close, the 2%/1.5% backstop is intra-bar. This coheres with the small measured leak.
- **P0b entry fill-quality study (`reports/loop/entry-fill-quality-2026-07-13.md`):** maker-entry
  population is N=1 post-LIMIT_MAKER-deploy (filled maker in 0.13 bars). No guidance change
  supportable. **PRE-AUTH (loop-domain):** re-run once LIMIT_MAKER entry N≥15. Confirmed the #40
  stamp gap live: `first_fill_at` NULL on a FILLED order — the fills-table join is ground truth.
  **RE-RUN EXECUTED 2026-07-18 Pass 34 at N=25 (`reports/loop/entry-fill-quality-2026-07-18.md`,
  registry row 130): post-only maker entry VALIDATED** — fill rate 76%, median 0.13 bars; 6 misses
  priced at −353.5bps signed foregone (5/6 dodged losers; 5 were venue would-cross rejects) ⇒ no
  bounds change. Next re-run at N≈50 or on an entry-mechanic change; watch the would-cross reject
  share (20%). Pre-auth CONSUMED — future re-runs are ordinary data-gated maintenance.
- **P0d venue stop-capability probe (live on demo, orders placed far-from-market and cancelled;
  account left clean):** (1) spot `STOP_LOSS_LIMIT` is FULLY OMS-compatible — regular order rail,
  surfaces in fetchOpenOrders (unified type echoes 'limit' + stopPrice/triggerPrice; raw
  info.type STOP_LOSS_LIMIT), regular cancel, clientOrderId honored. (2) perp `STOP_MARKET` is
  created on the **ALGO/conditional rail** — response carries algoId/clientAlgoId/algoStatus;
  INVISIBLE to fetchOpenOrders/fetchOrder/cancelOrder (-2013/-2011); round-trip needs
  `fapiPrivateGetOpenAlgoOrders` / `fapiPrivateDeleteAlgoOrder({algoId})` (both exposed by pinned
  ccxt 4.5.58). reduceOnly STOP_MARKET is ACCEPTED with no position and is EXEMPT from the $50
  trigger-notional floor (-4164 binds only non-reduceOnly). OMS dedupe key on the algo rail =
  clientAlgoId. (3) `watchLiquidations`/`watchLiquidationsForSymbols` supported in pinned ccxt
  pro. P7 builds to these facts; the perp stop lifecycle must reconcile via the algo endpoints.
- **Factorial 2×2 pre-registration (info-context × thinking; owner approved superseding
  "one measured channel at a time" FOR THESE TWO ARMS, 2026-07-13):** arms assigned by
  independent keyed PRFs (`ab-assignment.ts`, salts 'info-ctx-v1'/'th-v1'; the old affine
  offsets shared one minute counter — the (info-control × thinking-on) cell was provably empty
  at 30/30). Cells recovered per-row (see prerequisite below). **Primary metric:** net-of-cost
  bps per closed trip per cell = (realizedPnl − fees − attributed LLM cost)/notional. **Evidence
  floor:** ≥15 closed trips per cell (60 total) or 30 calendar days, whichever first. **Adoption
  rule:** adopt a factor iff its main effect ≥ +10bps/trip net AND sign-consistent across both
  levels of the other factor. **Harm stop:** single interim peek at 8 trips/cell — any cell
  < −50bps/trip ⇒ that factor's pct → 0 immediately. **Interaction rule:** |interaction| >
  max(|main effects|) ⇒ extend to 25/cell before deciding. **Cost rule:** two daily-spend
  breaches of $4.50 ⇒ `AGENTIC_THINKING_AB_PCT` 50→30 (spot lane breaker stays $5). Exit-mechanic
  deploys mid-experiment shift all cells equally — record dates, do NOT reset the window.
  Verdict = loop judgment over `test/backtest/ab-cells/run.mjs` output; winners become always-on
  flags and both pcts → 0, restoring one-channel-at-a-time for future channels.
  **PREREQUISITE — SHIPPED (`4ce1fe0` P8a-prep):** migration 0012 adds nullable
  info_arm/thinking_arm; the client stamps treatment truth on every proposal path
  (info_arm = NOT infoContextControlArm, thinking_arm = thinkingArm) and the strategy journal
  persists them (NULL on quiet/prescreen rows). The cell script v2 prefers explicit arms (hash
  forensics fallback for pre-migration rows) and its trip-attribution join was FIXED — the v1 join
  keyed decide `event_time` (candle-OPEN) against intent `source_event_time` (candle-CLOSE) and
  attributed 0/12; the v2 ASOF join (mirrored from the promotion evaluator) attributes 11/12 live
  (the 12th has no preceding LLM decide). Early live signal: the info-treatment arm drives nearly
  all proposes (8.4% vs 1.9% propose rate).
- **P5 funnel fix shipped (`c0d53bd`):** the first close after every redeploy now evaluates the
  reflection trigger on the DB-seeded count (was: fire-and-forget seed ⇒ unseeded zero counters;
  a real starvation source given recreate frequency). Fail-open on seed errors preserved.
- **Post-factorial enable queue (one measured slot at a time resumes after the factorial
  verdict):** tr1 (decide-side track record) → d2 (spot-perp basis + OI delta + funding trend;
  single d1→d2 tag bump, FORBIDDEN mid-factorial) → lq1/bs1 (liquidations, book structure) →
  s1 (sentiment — CORRECTION: the s1 tag already existed, correctly gated on
  sentimentFeedEnabled; the plan's "attribution hole" premise was stale, so P6 added only the
  missing client-level tag tests, no second tag). All built flag-off in Push 3 P6. NOTE: the
  book-structure block deliberately does NOT ride the info-context A/B control arm (pure
  transform of data every payload already carries — nothing external to withhold; documented at
  its tag definition).
- **OCO REJECTED (decided, do not re-litigate):** spot orderList/OCO would make reconciliation/
  fills treat orderLists as alien objects. P7c's resting-order role identity (`7de96ba`) achieves
  the same TP/stop discrimination OMS-natively WITHOUT touching the frozen clientOrderId format:
  role = f(intent.source.dedupeKey) — `venue_tp_`/`venue_stop_` — resolved by clientOrderId via
  `ExecutionStorePort.loadIntentByClientOrderId` (the id encodes the intentId; the abandoned
  vtp:/vsl: id-prefix design would have broken the money-path CLIENT_ORDER_ID_RE that
  reconciliation/fill-ingestor depend on). Spot still cannot rest TP+stop TOGETHER (base
  double-lock — the P7f boot refusal enforces this); backlog #44 (spot OCO) is the only path to
  spot venue-side stop+TP, and it stays a seed.

#### Push 3 completion records (2026-07-14, this session)

- **P7c resting-order role identity (`7de96ba`), SHIPPED flag-neutral.** See the OCO note above for
  the design. restingOrderForRole scopes manageVenueTp to `vtp`; CANCEL_OPEN gained `cancelRole`
  (absent = side-only, byte-identical). 1390 specs green.
- **P7d venue-resting protective stop lifecycle (`830f556`), SHIPPED flag-off, then ENABLED on the
  perp lane (P8d).** manageVenueStop mirrors the TP lifecycle behind `AGENTIC_VENUE_STOP`: spot
  STOP_LOSS_LIMIT on the open-orders rail (role `vsl`), perp STOP_MARKET on the algo rail
  (reconciled via fetchOpenAlgoOrders; clientAlgoId dedupe). Registry `venueStopResting` flips true
  only on CONFIRMED-resting (never at emission); executor + watcher stand down behind it except
  beyond `PLAN_STOP_FORCE_BPS` (fail-safe backstop for a gapped venue stop). Restart re-arm
  registry-timing bug found + fixed in-build.
- **P7e/P7f adversarial money-path review (Workflow, 4 lenses × 2 refuters), 8 confirmed findings
  ALL FIXED + test-pinned.** Round 1 (`749c88b`): a reachable perp band lost BOTH protections —
  the sizer/evaluate rejected a reduce-only STOP_MARKET below minNotional (but Binance USD-M
  -4164 exempts reduce-only — the venue would take the stop the bot refused), AND the 1s watcher's
  isDust skip sat above its registry branch, blinding it in the same band. Fix: reduce-only PERP
  intents are minNotional-exempt in sizer + evaluate (spot keeps the gate); watcher consults the
  registry before the dust skip. Round 2 (`c50d4ac`, the program's deepest defects): the OMS
  execution layer was BLIND to the perp algo rail. 7 sub-fixes rooted in one rail-split
  (isAlgoRailIntent = triggerPrice + swap venue): (1) execution-gate no longer registers an algo
  order in the local open-orders set (was → false CANCEL_UNKNOWN → RECONCILE_REQUIRED freeze with
  held reserve); (2) unknown-resolver resolves algo SUBMIT_UNKNOWN via fetchOpenAlgoOrders — a
  match = ACK, ABSENCE PROVES NOTHING so the entry stays pending and the rule-5 60s kill-switch is
  the sole backstop (was: false not-found bypassed the watchdog); (3) reconciliation + boot-recovery
  skip algo intents; (4) BOOT REFUSES venue_tp+venue_stop both-true on any spot venue (base
  double-lock); (5) timed-out plan exit now emits its replacement crossed IOC (was: naked position);
  (6) transient store-failure during stop reconcile skips placement (was: duplicate stop); (7)
  halt-flatten + boot re-arm cancel/adopt a stranded perp algo stop.
- **P8a factorial ENABLE (`a6f0573`), LIVE on the spot lane 2026-07-14.** `AGENTIC_DERIVATIVES_AB_PCT`
  30→50, `AGENTIC_THINKING_AB_PCT` 0→50. Deploy verified: env in-container 50/50, migration 0012
  columns present, zero boot errors, app healthy; the pre-deploy 15:00 rows carry NULL arms (old
  code). Rollback = restore 30/0. **WATCH (P8a): (1) arm-stamping RESOLVED POSITIVE (Pass 24)** —
  arms stamp on exactly the rows that reached the LLM (5 non-null = the 5 prescreen `called` rows;
  the 30 NULL-arm rows are `skipped_quiet`, correctly NULL); cells beginning to fill (`f|t`=4,
  `t|t`=1). **Pass 26: cells filling well** — `f|f=9, f|t=14, t|f=18, t|t=17` (58 arm-stamped;
  282 null=`skipped_quiet`); (4) thinking distribution RESOLVED — 31/58 ≈ 53% (the Pass 24 all-on was
  small-N noise); (3) daily spend ≈$2.36/day < $4.50. **Still PENDING:** (2) `test/backtest/ab-cells/
  run.mjs` explicit-arm TRIP rows (cells are decide-counts, not the ≥15-trip evidence floor) as N grows.
  Harm-stop peek at 8 trips/cell.
  **Exit-mechanic mid-experiment deploys (pre-registration §: shift all cells equally, do NOT reset
  the window):** 2026-07-15 ~00:45Z — venue-exit qty-reconciliation churn fix (`debef0f`) deployed
  to BOTH lanes (spot boot `29e22ada`, perp new boot). Both boots reset the reflection prime;
  `c0d53bd` seed-race fix (live) keeps the first-close-after-boot trigger intact. 2026-07-17
  ~09:55Z — spot recreate (boot `482d5ab1`) carrying #49 atomic cancel-before-exit (`1b8d872`),
  the 5→8 expansion + sizing 0.04, and playbook A/B 25→40 + lapse 336h (`1a70a51`); all-cells-equal
  shift, window NOT reset (playbook-version mix shifts equally across cells — independent PRFs).
- **P8d perp L0 DEPLOYED + LIVE (`aca7fb1` config, `359e4a7` the unblock).** `docker compose
  --profile perp up`: app-perp on binanceusdm demo (demo-fapi, testnet mode), BTC/USDT:USDT only,
  LONGS-ONLY, full stop architecture ON (venue TP + venue STOP_MARKET on the algo rail + executor +
  S3; watcher off, matching spot), leverage 1 isolated (integer cap, fail-closed boot pin passed),
  $2/day breaker, own isolated Postgres (5433, fresh — 0012 applied, zero rows; spot DB intact at
  1202 decisions) + Prometheus (9091), port 3102. In WARMUP (340 bars ≈ 3.5 days to first decide).
  **DEPLOY-TIME BLOCKER FOUND + FIXED (`359e4a7`):** the first boot crash-looped —
  `binanceusdm does not support watchTicker`. Root cause: ccxt 4.5.58's binanceusdm.describe()
  UNDER-REPORTS its inherited pro-streaming capabilities (the `watch*` methods work — empirically
  verified against demo-fapi: ticker/OHLCV/book/trades all return live data — but `has.watch*`
  comes back undefined). buildCcxtExchange now patches the verified-true flags for binanceusdm only;
  pinned in the ccxt-bump regression suite. The P8 (2026-07-13) probe missed this — it verified
  REST auth/orders, not the WS streaming path; the L0 one-symbol boot gate caught it before any
  trade. **WATCH (P8d perp), PENDING — FIRST LIVE EXERCISE OF THE ALGO-RAIL STOP LIFECYCLE
  ANYWHERE:** (1) first perp entry places a resting STOP_MARKET visible via
  `fapiPrivateGetOpenAlgoOrders` (algoId populated, registry venueStopResting→true only then); (2)
  a venue-stop fill journals `venue_stop_filled`; (3) NO reconciliation mismatch/HALT on the new
  order type (rule 6 HALTs, never auto-flattens — a HALT here = the algo-rail containment missed a
  case, investigate before re-arm); (4) funding settlement rows appear; (5) zero cross-lane leakage
  (perp trips stay in postgres-perp; spot promotion gate/epoch unpolluted); (6) reflection fires on
  this lane's own fresh evidence after 2 closed trips. **(Pass 24: boot re-verified healthy — 1
  hold decide, leverage pin passed, equity $5,000, 0 errors; warmup, 0 trips ⇒ the algo-rail stop
  lifecycle is UNEXERCISED — all six items stay PENDING until the first perp entry ~3.5d out.)**
  **(Pass 26, 2026-07-15 — FIRST PERP TRADES landed early; warmup ended fast via 340-bar backfill.)**
  2 closed round trips (BUY LIMIT_MAKER entry → SELL LIMIT IOC exit; held ~11 and ~6 bars; both small
  losers, equity $5000→$4999.20), all ACK/FILL clean, **0 reconciliation mismatch/HALT/degraded** (item
  3 GREEN so far), zero cross-lane leakage (item 5 GREEN), and **item 6 GREEN — reflection minted v2 on
  this lane's own evidence.** **But items 1-2 surface FLAG 1 (NEW, see § Flagged): NO venue STOP_MARKET
  NOR venue TP was placed on either trip despite `AGENTIC_VENUE_STOP=true`+`AGENTIC_VENUE_TP=true` —
  both `agentic_venue_*` series absent, zero `manageVenue*`/algo lines in 24h logs. The algo-rail stop
  lifecycle is not merely unexercised, it appears NOT TO ENGAGE on perp** (spot's venue TP DOES place
  under the same flag ⇒ perp-specific). Positions had executor+S3 protection (not naked). **This BLOCKS
  the L0→L1 shorts pre-auth** until root-caused. `PERP_VENUE_ENABLED=false` is a RED HERRING (gates the
  unwired PaperPerpAdapter per `environment.config.ts:478`, not the real binanceusdm demo venue).
  **(Pass 28, 2026-07-16: root cause = adapter response-shape bug; layer-(a) containment SHIPPED
  `25563bc` and live-verified — the venue TP now RESTS on perp, so item 2's `venue_tp_filled` watch is
  live again; item 1 (resting STOP_MARKET) stays blocked on the owner-gated adapter fix — § Flagged.)**
  **(Pass 29, 2026-07-16: adapter fix `34bdddd` DEPLOYED — item 1 GREEN: STOP_MARKET placed, resting
  on the algo rail, reconcile-confirmed with registry stand-down; item 3 still green. Remaining:
  item 2 — a venue TP/stop FILL journaling correctly on the next closed trip; item 4 funding rows.)**
  **(Pass 30, 2026-07-17: item 2 = RED — the stop FIRED at the venue ~17:16Z 07-16 and its fill is
  INVISIBLE to the OMS ⇒ phantom local position, evidence lane corrupt since; full mechanism +
  owner-gated remedy in § Flagged. L0→L1 re-BLOCKED.)**

- **PERP SHORTS LADDER pre-auths (loop-domain; the ONLY human touch remains the live-money flip):**
  - **L0→L1 (shorts on the PERP lane):** after an L0 soak — ≥3 days clean AND ≥5 closed perp trips
    AND zero reconciliation mismatches AND the algo-rail stop lifecycle verified live (WATCH 1-3
    above green) — the loop may set `AGENTIC_SHORTS_ENABLED='true'` on app-perp (plan-mode shorts,
    pf2 tool). Portfolio consult stays OFF on the perp lane (single symbol; and the shorts+consult
    path wants its own soak). Leverage stays 1, isolated.
  - **Perp symbol expansion (L1→L2):** add a second perp symbol only after L1 shows ≥5 short trips
    clean; re-derive gross exposure first.
- **Watcher enable pre-auth (spot, unchanged from P0a):** re-run `test/backtest/stop-slippage`
  once spot stop-exit N≥10; enable `PLAN_STOP_WATCH_ENABLED` iff mean leak worse than −10bps/exit
  OR any event ≤ −100bps. The perp lane's venue stop already supersedes the watcher there.
- **Next-program seeds (backlog, not scheduled):** trailing-stop plan field (#45, wait for
  venue-TP+stop capture data), Thompson multi-candidate routing (#46), adaptive consult cadence
  (#47), weekly vol-ranked symbol rotation (#48), liquidation feed ENABLE (lq1 built flag-off, in
  the post-factorial queue), spot OCO (#44), SSE reflection streaming (#32), orders-timestamp
  stamps (#40).
- **Thompson routing (#46), adaptive cadence (#47), trailing-stop plan field (#45): deliberately
  EXCLUDED from Push 3** — the first two replace measurement machinery mid-experiment; any
  plan-schema/template change cannot ENABLE mid-factorial (build-only is fine). Not deferrals —
  scheduling decisions tied to the factorial window.

## Current stage

**Stage 2 — learning-loop edge** (deployed 2026-07-08; Stage 1 cost floor CLOSED — see ladder
above). The reframing forensics (2026-07-08, still the operative diagnosis):

- **Learning loop was silently DEAD 4 days**: the ONE reflection candidate ever minted was killed
  by the polarity-blind banned-word validator; playbook stuck at v1 seed.
- **Entry decisions had NO measurable edge**: `long` decides averaged ≈0 to −3bps next-bar forward
  return at EVERY confidence bucket vs a 20bps fee hurdle (calibration over 928 decisions).
- **R:R inverted**: avg win +$0.06 vs avg loss −$0.21 — the plan gate floored only the take-profit
  side, never the stop.

**Stage-2 shape = a four-stage learning funnel:** reflection (Opus-4.8, calibration/attribution/
regime diagnostics + mint-time entry-rate floor + expectancy backtest) → offline replay scoring at
$0 (`pnpm eval:agentic`; NOT in the gated `test` suite — the §2.6 every-pass probe guards it) →
live A/B attribution (25%) → attributed auto-promotion (symmetric 10-trip floors + Mann–Whitney
PoS ≥ 0.70). Exit criterion: ≥2 promotions with version-attributed PnL AND rolling-7d net-of-cost
≥0.

**Durable findings (do not re-derive; full context in LOG.md by date):**

- **The whole funnel is trade-gated** — reflection and the promotion evaluator fire SOLELY via
  `onClosedTrade`; there is no wall-clock trigger (rejected on the merits — it would re-chew
  stale evidence). No trades ⇒ no Stage-2 signal, by design. (Pass 10, 2026-07-08.)
- **First-close-after-boot seed race:** the trigger check runs synchronously before the async DB
  seed lands, so the first close per strategy after a recreate primes but cannot fire; the second
  fires. Every redeploy resets in-memory primes. (Pass 21, 2026-07-13.)
- **Row-count journal windows are volume-fragile:** `recent(N)` shrinks in wall-clock terms as
  the universe/journal volume grows — three live defects from one class (#39 abstain window;
  Bug C `cfb2ed3` abstention-lapse 400-row window; Bug E `309bbfc` attribution 2000-row window).
  Any consumer measuring PER-VERSION or lifetime evidence must read lifetime stats
  (`versionEntryStats`) or epoch-bounded versioned rows (`recentVersioned`), never a shared
  recent(N); recency windows remain correct only where recency IS the semantics (reflection's
  evidence corpus). (Pass 33, 2026-07-18.)
- **Epoch-straddle bound:** promotion-walk cycles straddling an epoch can freeze a symbol group
  under entry-size drift (not count-preserving). Fixed by threading the epoch through all four
  consumers (`cc72a10`) + the 07-12 epoch move; declare new epochs only at flat instants.
  (Passes 14/17/18.)
- **Holds are model-driven:** 0 proposes + 0 rejections ⇒ the gate is not implicated; prescreen
  loosening surfaces more −EV bars and cannot reach the Stage-2 exit. (Passes 10/11; #29.)
- **Reflection repair chain, fully live-verified:** 30s-timeout abort (`ef325f6`) → validator
  false-positives (`f0c5e14`) → cadence 5→2 per-strategy (`3e5773f`) → transient-error trigger
  rollback + retry-with-feedback (`21c9b2d`) → **first live mint Pass 16 (v2)** → abstention
  deadlock diagnosed (Pass 21, #39) → entry-rate floor + abstain lapse (`b9dddc2`).

## v2 contract cutover (2026-07-18) — decision record

**What changed:** the entire agentic lane moved from the boxed v1 signal-emitter to the v2 rich
decision contract (owner-approved plan, six-round interview 2026-07-17/18; plan file
`~/.claude/plans/let-s-make-the-bot-app-synthetic-quail.md`): model-owned sizeFraction sizing
(spot 0.15 / perp 0.50 caps), revisable exit directives + scale-ins/partial closes, portfolio
consult self-scheduling (wake-on-move 1.5%, fallback 16 bars; prescreen DELETED), thesis
persistence, always-on adaptive thinking (4096 tokens), $1k effective book (SIZER_EQUITY_CAP)
with book-scale breakers ($1.50/$0.75 per day) and risk envelope (gross/net 1200, order 500),
24-symbol spot basket with scanner-gated top-12 menu (filters live-probe-verified — 8 of 16
groundwork rows were wrong and corrected), perp shorts + 2x leverage cap + funding-PnL capture
(new `funding_payments` table, migration 0013), expert seed playbooks v2 per lane, reflection
reframed (v2 digest walk incl. SHORT sign-mirroring fix, weekly cadence, regret digest,
exec-quality digest), promotion entry-counting widened (`open_long`/`open_short`). Full gate
green at cutover: build/lint/typecheck clean, 2372/2372 tests, livegate 41/41.

**Why (evidence):** Pass-31 scoreboard — champion −$7.02 trading with $8.16 LLM cost over 20
trips; cost drag exceeded the trading loss and v1's clamps blocked conviction expression. At the
owner's ~$1k production-capital cap, v1 economics could never clear the promotion bar.

**Cutover mechanics:** local prod-like soak (owner directive) IS the cutover. GCP migration
DEFERRED (owner, 2026-07-18) — the local stack remains the deployment (host-sleep duty cycle
stays in force); if revived, lift-and-shift stack + DB with NO second epoch reset.

- Perp `PROMOTION_EVIDENCE_EPOCH=2026-07-18T15:36:14Z` — set at a log-verified FLAT instant.
- Spot epoch: PENDING FLAT (open work) — LINK ~$110 + AAVE ~$90 v1 leftovers re-armed under v2
  management; stamp the epoch + recreate at the first flat portfolio tick (epoch-straddle bound,
  Passes 14/17/18, forbids stamping now).
- Soak findings already fixed + regression-specced: liquidation-feed venue-listing prune
  (PEPE/SHIB have no same-named perp market — feed was in a 1s reconnect loop) and scanner
  quorum guard (boot scan raced warmup and froze an arbitrary alphabetical menu for the day).
- Funding poller's boot-time poll raced migration 0013 (fail-open, logged) — first hourly poll
  must succeed (WATCH-V2-5).

**WATCH (resolve each explicitly at next observation):**

- WATCH-V2-1: first 24h LLM cost within $1.50 (spot) / $0.75 (perp); breaker exhaustion mid-day
  = economize via prompt/cadence, never raise the breaker.
- WATCH-V2-2: consult-gate outcomes show `skipped_scheduled` dominating quiet bars; a
  consulted-every-bar storm = scheduler defect, fix before GCP.
- WATCH-V2-3: journal rows carry v2 actions + directives + thesis; any journal-guard
  dropped-row log or `error`-action storm = defect-class, fix before GCP.
- WATCH-V2-4: first quorum-met universe scan produces real scores (not null) and a stable menu
  under hysteresis; repeated `universe_scan_skipped` past ~4h of streaming = ingestion defect.
- WATCH-V2-5: perp funding poll succeeds on its first hourly cycle; rows accumulate with the
  documented sign convention.
- WATCH-V2-6: zero OMS unknown-outcome escalations, reconcile mismatches, or kill-switch
  engagements through the soak; ANY = halt the GCP move and fix first.
- WATCH-V2-7: **RESOLVED 2026-07-19** — spot `PROMOTION_EVIDENCE_EPOCH=2026-07-19T18:57:09Z`
  stamped at a log-verified dust-flat instant (LINK closed at its re-armed exit, all
  remaining positions < $5 dust, 0 open orders); spot container recreated on the stamped
  epoch, healthy. Perp epoch unchanged (2026-07-18T15:36:14Z). W5 closed CLEAN at the same
  cycle (owner threshold); W6 9-hour soak started ~19:00Z on the final round-8 build.

**Deferred/noted:** sentiment feed off (needs a CryptoPanic key — owner decision when desired);
thinking A/B factorial retired (always-on); basket-alpha + portfolio btcBeta unpopulated pending
a multi-symbol price-history store (honest omission, port comments); BNB fee discount = live-flip
prep (a ~25% spot fee cut demo cannot measure); exec-report → strategy fan-out has zero
production callers (fill-triggered consults arrive via a different path — exec-quality digest
stays fail-open-undefined until that seam is wired; deferred feature).

## Round-8 pre-cutover cleanup + W4 adversarial audit (2026-07-18/19) — decision record

**Owner decisions (rounds 7+8, 2026-07-18):** GCP revival UN-deferred (lift-and-shift, NO
epoch re-reset); full scanner-gated perp menu; alpha inputs wholesale (FnG+positioning,
CryptoPanic behind an owner key, aggTrades CVD); Opus reflection / Sonnet tactical; Grafana
rebuilt as ONE dashboard (dashboard-only alerting — no push channel, owner accepts the
unattended implication); cleanup at full depth (sweep + seam rewiring + adversarial audit);
ALL of it plus a few-hour clean soak BEFORE the GCP cutover. Plan file
`~/.claude/plans/let-s-make-the-bot-app-synthetic-quail.md` (round-7/8 sections).
**Resequenced (owner, 2026-07-19): GCP deploy + terraform are the ABSOLUTE LAST task** —
X2–X9 and R1–R3 land on the LOCAL stack first; host-sleep duty cycle stays in force until
the terminal lift.

**Landed 2026-07-18/19 (all gates green, 2440/2440 + livegate 41/41):** W1 Grafana
single-dashboard rebuild (6 rows / 95 panels, cross-lane Overview aggregates, RO Postgres
datasources `grafana_ro` on BOTH DBs — enforcement live-verified), W2 behavior-preserving
sweep (2 orphans removed, README/docs refreshed, 2 stale docs archived), W3 seam rewiring
(exec-quality fan-out via EXEC_QUALITY_SINK, price-history store → honest basket alpha +
btcBeta, app.module 6-module decomposition with the eslint app-zone pattern widened —
allow-rules untouched), W4 adversarial audit via 8 opus finders + 2-lens refutation:
**20 confirmed findings, ALL fixed with regression tests** — headline criticals: (1) v2
mapping omitted `AgentDirectives.direction` → every perp short's deterministic protection
was INVERTED; (2) reconciliation trade axis dead on the ccxt path (venue order id vs cb
coid) → missed-fill backfill and the FILL_FOR_UNKNOWN_ORDER halt could never fire live.
Full table: `reports/audit-2026-07-cleanup.md`.

**Accepted risk:** single shared ws connection per lane (connection-wide close on a stalled
core channel; recovery now ~24s via 4-lane paced scheduler). Sharding deferred to the perp
menu widening. **Plausible/unfixed:** fill-poller mid-poll ack race (reconciliation is now
the backstop); negative-fee (rebate) ingestion — revisit at the live flip with the BNB note.

**WATCH (round-8, resolve at next observations):**

- WATCH-R8-1: post-redeploy boot clean on the round-8 build; the four next-deploy metrics
  (budget remaining, active menu, menu churn, funding ingested) populate their panels.
- WATCH-R8-2: ws forced-reconnect frequency + recovery duration under the lane scheduler
  (expect burst recovery ≤ ~1/4 of pre-fix; no 1008 storms at 4 msg/s).
- WATCH-R8-3: perp funding payload line sane after the accrual dedupe (no monotonic
  inflation vs `funding_payments` rows).
- WATCH-R8-4: any schema-validation rejection now logs its zod issues + payload — diagnose
  the first occurrence (one undiagnosed perp instance 2026-07-18 19:30Z pre-fix).
- WATCH-R8-5: promotion evidence shows FUNDING_DATA_MISSING blocking on perp only until
  funding rows exist in-window — never on spot.
- WATCH-R8-6: **W5 soak finding (2026-07-19 ~11:00-12:00Z, defect-class, fix SHIPPED +
  DEPLOYED both lanes):** after the ~10h host sleep, the spot watchdog's `exchange.close()`
  remedy left the shared ccxt ws instance in a terminal `ExchangeClosedByUser` state —
  every re-watch threw for 50+ min (zero candles/consults) until a container restart. ccxt
  4.5.58 `close()` is NOT always recoverable by re-watch (falsifies the adapter's header
  assumption). Fix: exchange-recreation seam (factory injection, single-flight swap on
  closedByUser, herd still lane-paced; 3 regression specs, suite 2443/2443). Perp was
  unaffected (its close recovered). AAVE leftover closed pre-sleep (+$91 cash); spot epoch
  still waits on LINK only. **ESCALATION (2026-07-19 ~13:51Z): seam v1 recovered the wedge
  live (recreations fired + streams resumed) but under a venue penalty phase the
  watchdog-close→closedByUser→recreate cycle churned 36 recreations in ~35 min; wedged old
  instances retain live ws timers (close() rejects), so they never GC — spot OOM-crashed
  (JS heap) and Docker auto-restarted it (RestartCount=1, final safety rung worked). Seam
  v2 SHIPPED + DEPLOYED both lanes (escalating recreation cooldown 60s→10min ceiling with
  15-min-healthy reset, hard-dispose of stale ccxt clients/timers/sockets even on close()
  rejection, 10-per-rolling-hour cap failing LOUD level-50 to the healthcheck-restart rung,
  watchdog close cooldown confirmed already global; 7 recreation specs, market-data
  120/120, suite 2447/2447). W5 clean clock restarts at the v2 deploy; the next venue
  penalty phase or host sleep/wake is the live probe.**
- WATCH-R8-7: **W5 soak finding #2 (2026-07-19, root-caused ~17:00Z; fix SHIPPED + DEPLOYED
  ~17:10Z, LIVE-VERIFIED ~17:24Z — kill switch RUNNING sustained, reconcile passes CLEAN,
  consult outcomes + journal rows flowing again; suite 2452/2452):** the
  spot lane journaled ZERO decides all day — root cause: the W4 reconciliation fix's tier-2
  classification (durable-yes/memory-no ⇒ FILL_FOR_UNKNOWN_ORDER) lacked a terminal-state
  discriminator, so 8 HISTORICAL venue trades (TP fills executed server-side during the
  host sleep; orders terminal in the durable store, correctly absent from the rehydrated
  book) re-triggered `RECONCILE_MISMATCH` + kill-switch HALT on EVERY 30s pass
  (reconciliations table result=HALT), and the halt silently suppressed every decide.
  THREE stacked observability defects hid it: engage() logs nothing, strategy-host halt
  suppression logs nothing, /health/ready HARDCODES killSwitchState 'RUNNING'. Fix narrows
  classification (already-ingested fills skip; terminal-order unrecorded fills
  backfill-ingest; only NON-terminal lost state still HALTs — rule-6 fail-closed policy
  unchanged) + all three observability gaps. The wedge/venue-pressure saga (R8-6) was
  concurrent but separate; the candle/consumer pipeline was healthy throughout. Incidental
  latent hazard flagged during the (disproven) pipeline investigation, NOT fixed:
  `marketRaw()` multiplexes all supervised loops via `Promise.all(loops).then(finish,
  finish)` (ccxt-stream.adapter.ts ~:449) — one escaped throw from any single loop marks
  the ENTIRE merged iterator done while sibling loops keep pushing into an undrained
  buffer, silently. Harden when next in that file (loop-domain follow-up).
- WATCH-R8-8: **W6 cycle-1 soak finding (2026-07-20 ~03:00Z, defect-class, fix SHIPPED +
  DEPLOYED both lanes ~03:14Z):** the P3 weekly reflection trigger looped hot — its
  week-bucket check compared only `lastAttemptAt`, which non-consuming attempt exits
  (abstain_reject additive rollback, budget_exhausted, precondition aborts)
  restore/never-set; wired per-bar at I1b, every tick re-fired runReflection: **91 live
  Opus calls / ~$2.30 in 46 min** (01:15–02:01Z) against candidate v3's (business-correct)
  abstention lapse — 4 mint attempts, each burning ~20+ calls via the mint-floor replay AT
  the Opus reflection tier — then a dry warn-pair loop every ~2s after the daily cost stop
  capped spend at $2.48 (overshoot past the $1.50 breaker: mid-attempt replay calls fail
  OPEN by design, so an attempt started under budget finishes over it). Fix: the weekly
  path consumes its own week-bucket stamp ON FIRE (`lastWeeklyFireAt`) — at most one fire
  per UTC week regardless of outcome; trade-trigger retry-on-next-close semantics
  untouched; regression spec, suite 2453/2453. Watch next: the fresh boots may fire exactly
  ONE bounded weekly attempt (in-memory daily budget resets on restart — pre-existing),
  then weekly silence. A0 follow-ups: mint-floor replay pricing at the reflection tier
  (~$0.55/attempt), and `AGENTIC_REFLECTION_MODEL` is ALREADY honored live — X6 narrows to
  verification + budget framing.

**W6 cycle-1 verdict (2026-07-19 19:00Z → 2026-07-20 03:00Z):** clean EXCEPT R8-8.
Reconciliations 959/961 CLEAN, zero HALT (the R8-7 class dead over 8 continuous hours);
kill switch RUNNING throughout; both lanes journaled every 15m bar; spot: one batched
consult (01:00Z, 6 symbols, ~44k tokens) + 24 forced_fallback / 2 forced_move gate
outcomes; perp quiet ($0.18 epoch cost); equities/drawdown flat; ws seam absorbed venue
noise at warn level. Non-app events: owner Docker quit 21:01→21:08Z (clean reboots — an
unplanned restart probe, passed); daemon-side `docker logs --since` silently broken after
the Desktop restart (returns empty; per-line stamps correct — tail + pino-time filtering
adopted; hard Y2 requirement + a "never trust a negative read" Y1 exhibit); the original
W6 digest collector was a dud (1 line in 8h) — the replacement's hourly digests at
`reports/loop/digests/w6-digests.txt` are the record (both collector failures are Y1 data
points). **Clock restarted ~03:14Z at the R8-8 fix deploy.** **W6 CLOSED ~06:45Z by owner
directive** after ~3.5h of cycle 2, fully clean: reconciliations 414+415 CLEAN zero HALT,
reflection bounded to EXACTLY ONE weekly attempt (attempt_started=1/abstain_reject=1 —
R8-8 fix live-verified), kill switch RUNNING, only known watchdog forced-reconnect noise
(R8-2 class, recovering). Owner-screenshot review surfaced two Grafana defects, both fixed:
the Overview kill-switch tile always showed DEGRADED (`X{labels} or vector(0)` returns
BOTH series — the labelless 0 never matches; now `sum(X) or vector(0)`), and Age of Last
Decision read `event_time` (bar time, one bar stale) — now `created_at`. Routed to A0:
spot burns ~118% CPU / 1.5GiB RSS while trading-idle (24-symbol ws churn + watchdog
reconnect cycles), and the lane is ECONOMICALLY idle — one batched consult in 11h, zero
entries, window 0 days, promotion NOT READY on both lanes — the central A0 question.

## Daily-loop mechanism enhancement — Y series (owner, 2026-07-19) — decision record

**Owner directive:** add a pre-cutover task group that significantly enhances the daily-loop
mechanism itself, based on learnings from the long-horizon watching (W5/W6 soaks + the full
pass history). Program (plan file round-9 section is authoritative for specs): **Y1** learnings
harvest → `reports/loop/loop-mechanism-learnings-2026-07.md`; **Y2** deterministic health-sweep
tool (`pnpm loop:sweep` — watermark liveness deltas, named defect-class alarms, one transport
wrapper that the GCP lift re-points); **Y3** standing digest collector (the W6 hourly-digest
pattern promoted into the repo; passes rehydrate from digest history, not a raw 24h log
window); **Y4** playbook v3 (stale v2-era references fixed, INCIDENT-FIRST gate on any sweep
alarm, `date -u` forensics discipline, 2026-07-17 delegation reflected) + state.md/LOG.md
archive hygiene + scheduled-task re-enable under change-discipline.

**Grounding evidence:** WATCH-R8-7 suppressed every spot decide for ~a day behind green
surface signals — a pass reading a 24h log window with no liveness deltas could not see it;
WATCH-R8-6's wedge→OOM chain was caught live only by continuous session watching; the
playbook still cites retired artifacts (`agentic_prescreen_total`, expectancy-ladder
MAY-knobs, a $5/day breaker). Sequencing: disjoint from app code, interleaves with the
X series, MUST complete before X1-FINAL. Tasks #50–#53 mirror Y1–Y4; #47 (GCP lift) is
blocked on Y4.

## A0 deep resource analysis (2026-07-20) — decision record

**COMPLETE ~08:30Z** (6 analysts + xhigh synthesis, ~1.5M tokens; report
`reports/loop/a0-analysis-2026-07-20.md`, evidence `reports/loop/a0-evidence-2026-07-20/`;
amended specs live in the plan file). Headline verdict: **the bot is starved, not broken.**
Binding constraints, in order: (1) consult cadence ~1-3 wakes/day vs the 10-20 design
intent — at historical entry fractions (3.8-9%) the 30-trip gate needs 24-56 consults/day;
(2) an entry mandate that structurally never fires (AND-veto filter stack, fee anchoring,
one-way reflection selectivity ratchet, functionally long-only perp — 0 entries in 19 v2
consults); (3) uncapped Opus reflection sessions ($2.25-2.93 each, 78-133 calls) blowing
1.8-3.9 daily budgets and blacking out consults; (4) plan_json EMPTY on every v2 row
(nextConsultBars/thesis unauditable — X6-X8 would have been built on nothing); (5) the
promotion gate is a cumulative ratchet (no trailing window) so idle burn permanently
raises the bar — re-stamp is costless only while trips=0.

**Adopted (loop-domain):** NEW pre-X2 activation bundle **XA1-XA7** (tasks #54-#60):
scheduler verify+tune → budget reservation + reflection carve-out → entry-mandate revision
(modulate-don't-veto, perp shorts, A/B→0 with its own decision record at execution) →
durable decision capture → exit invariants + repeated-noop breaker → spot channel tiering
→ one-time per-lane epoch re-stamp at final pre-campaign config. **X order resequenced:**
X6/X7/X8 (instrumentation, re-scoped: X6 build→verify+harden, X8 narrowed to the digest
table with epoch-bounded reads) → X2 (staged 8/menu-4→16/menu-6, sharding, funding
acceptance position-conditioned) → X3/X4/X5 (verify-before-build vs live tf1/pos1 blocks)
→ X9 (WATCH set per the report). Breakers stay FIXED at $1.50/$0.75 (raise considered and
rejected). **Owner flags:** CryptoPanic key wanted NOW (only external dependency);
optional R1 pull-forward if entries stay ~0 for 5+ days post-XA1 (R sequencing stays
owner-owned). First-campaign attribution is confounded by design (bundle + revision +
re-stamps + X2 land within days) — accepted, recorded, do not read the first delta as
pure playbook alpha.

## XA activation bundle (A0 → 2026-07-20) — decision record

The A0 verdict was "starved, not broken." The XA bundle makes the bot trade-capable BEFORE the
X-series enriches it. Shipped, gated (build+lint+typecheck+test+livegate all green), and
deployed to both local lanes, one commit each:

- **XA1** (menu-scoped consult gate + coalescing fix + cadence floor): verification found THREE
  defects behind the 2026-07-20 01:00Z fallback wave — (1) off-menu idle symbols recorded
  forced_* outcomes and had their consult clock + wake baseline reset by the batching client's
  inert menu-hold (fixed: strategy-side menu gate, fail-open, fill/rearm bypass); (2) the menu-12
  wave FRAGMENTED into six API calls because the early-flush threshold was the full symbol count
  (24, unreachable) — now min(symbols, menu), window 3s→15s; (3) knobs: fallback 16→8, wake
  0.015→0.008, nextConsultBars cap 64→32. WATCH-XA1: ≥8 batched consults/day for 3 awake days at
  ≤$1.50.
- **XA2** (attempt-level budget reservation + reflection carve-out): tryReserveAttempt($0.75)
  pre-flight → journaled `budget_deferred`, trigger preserved (permission gate fails CLOSED on
  attempt START; mid-attempt fail-OPEN); AttemptScopedBudget hard session caps (≤15 calls /
  ≤$0.75) bound the W6 runaway shape; shared daily meter stays the truth.
- **XA3** (entry-mandate revision): **CRITICAL find — the P2 expert seeds NEVER went live.** Both
  seed const versions said 2, but a pre-existing v2 REFLECTION row shadowed them via ensureSeed,
  so both lanes ran an old reflection lineage the ENTIRE v2 era. Bumped to v4 (above every DB
  row); v4 active live-verified both lanes. Mandate edits: info blocks are size MODULATORS not
  veto gates, RSI 55-75 continuation entries valid, fee floor quantified (skip only sub-60bps),
  weekend/Asia reduce-size, evidence-pace expectation explicit, perp short accountability. Spot
  `AGENTIC_DERIVATIVES_AB_PCT` 50→0 (change-discipline: the control arm stripped half the consults
  of the info bundle that drove the 8.4% vs 1.9% propose split).
- **XA4** (durable decision capture): plan_json was written ONLY on directive rows, so every v2
  hold dropped its model-chosen nextConsultBars → A0's "empty plan_json" finding. buildPlanJson
  now persists `{nextConsultBars}` on bare holds; readPlanJson coerces the schedule-only shape to
  plan=null on read (directive rows verbatim, I1b intact). max_tokens truncation now named with
  output_tokens instead of a generic no-tool-block warn. VERIFIED not a gap: consult usage is on
  agent_decisions and the in-process $/day breaker meters both decide + reflection — A0's
  "llm_usage only reflection rows" was a query mis-read on my part, not a code defect.
- **XA5** (repeated-noop breaker): a positioned symbol emitting the same action with no
  position-state change ×6 is suppressed at the gate until the position changes (the Bug-B
  flat-loop signature — ~55 consults/15h); fill/re-arm override. cancel-before-close verified
  already present. CARRIED (honest deferral): the terminal-NEW order sweep and the two
  exec-latency alarms from the XA5 spec are OMS/adapter work folded into Y2's sweep tool.

**Remaining activation steps (NOT done — deliberately not rushed):** XA6 (spot stream-load
tiering — a careful change to the ccxt ws layer that OOM-crashed twice; must not be rushed under
context pressure) and XA7 (evidence-epoch re-stamp, specced to land AFTER XA6 so the promotion
clock starts on the final build). Then the X-series (X6/X7/X8 → X2 → X3/X4/X5 → X9), R1-R3, and
X1-FINAL (GCP) per the plan file. Owner action still open: CryptoPanic key (X4).
[SUPERSEDED same-day by the record below — XA6/XA7-spot/X6/X7/X8 shipped 2026-07-20 ~09:00-09:40Z.]

## XA6 + X6/X7/X8 + XA7-spot (2026-07-20 ~09:00-09:40Z) — decision record

All gated (build+lint+typecheck+full suite+livegate green at every commit), deployed, live-verified.

- **XA6 — spot stream-load reduction (c0a03bc, b41a00a, 12ec4d6).** Three cuts, all fail-OPEN to
  full subscription: (1) ws `trades` augmented only when the paper sim exists — on demo lanes the
  channel fed nothing (StrategyHost drops TRADE events; trade-flow/liquidation feeds poll their
  own sources): ~24 subscriptions gone. (2) Per-symbol channel tiering: `book`+`trades` loops PARK
  for lite (non-menu, unpinned) symbols — no watch call, deregistered from the watchdog stall map
  and feed-health ages (a parked channel must never force a connection-wide close() or read as a
  stale feed) — and resume ≤30s after promotion through the paced gate; on demotion, a paced
  fail-open venue-side unWatch drops the subscription (verified in pinned ccxt 4.5.58).
  `candles`+`ticker` stay for all 24 (VERIFY-BEFORE-BUILD: the scanner ranks off streamed candles,
  not ticker/REST — A0's REST-fallback suggestion was written against a wrong assumption; nothing
  to build). (3) The decisive cut: `options.watchOrderBookRate=1000` on the market-data exchange —
  the active menu's high-volume diff-depth streams at ccxt's 100ms default were the dominant load;
  book consumers here are a top-of-book mid + 5s/30s staleness health, so 1s depth is ample.
  **Acceptance: CPU 118% → 24-28% steady (target <60%, 3 samples 09:30Z); perp ~1%; 10-12 books
  parked per ranking; 0 unwatch failures; 0 watchdog force-closes; rankings populate.** RSS
  1.34GiB stable vs the <1GiB target — NEAR-MISS accepted: level not growth (the R8-6 precursor
  is growth), watched below. 24h criteria (zero 1008 mass-closes, reconnect ≤ R8-2 baseline) fold
  into WATCH-XA6.
- **X6 — reflection verification+hardening (c1f2c16).** Verified pre-existing: Opus tier knob,
  decideModel pin on floor replay/candidate backtest (A0's "Opus pricing" concern was already
  fixed), outcome counter `agentic_reflection_outcomes_total`. Added: the tier-assertion spec
  (draft bills reflection model, floor replays bill decide model — pinned off request bodies);
  ANTI-RATCHET objective in the reflection prompt (missed winners weigh equal to realized losses;
  ≤1 gate tightened per revision, named in changelog; leaders-only rules must justify ~2
  trips/day; flat week = failing week); 07-16→17 execution-bug window excluded from journal rows
  AND realized round trips (`outsideExecutionBugWindows` — carried from XA5's tagging
  requirement). Budget framing verified at XA2's capped shape (≤15 calls / ≤$0.75/attempt/lane,
  one fire/UTC-week ⇒ worst-case ~$1.50/week both lanes, inside breakers).
- **X7 — thesis + hold post-mortems (21ba218).** decision-postmortem.ts (pure,
  counterfactual-scoring pattern): thesis grades vs realized outcome with LIVE exit semantics
  (stop at bar close per plan-executor; TP as close-crossing proxy — journal rows carry no
  intrabar H/L, documented under-count); hold post-mortems replay 24 forward bars per flat-book
  hold, missed-entry = >1% max favorable excursion. POPULATION SPLIT enforced: only hold
  DECISIONS graded — unfilled/rejected maker ORDERS never regret (P0b N=25: 5/6 were dodged
  losers). UTC-hour + weekday/weekend expectancy buckets; fail-open advisory relaxation line at
  entry rate <1/day (routed through reflection as a recorded revision, never a silent change).
- **X8 — per-version net-PnL reflection table (62a0657).** version-pnl-digest.ts reuses
  promotion-evaluator's `attributeVersion` join verbatim; unattributed bucket for
  pre-stamp/legacy/missing-join trips (fails toward unknown, never misattribution); window
  semantics per the thrice-burned recent(N) class — trips ride the epoch-bounded
  REFLECTION_EVIDENCE read, decisions ride recentVersioned's cap-not-recency convention.
  Reflection prompt told to weigh the table when revising.
- **XA7-spot — evidence-epoch re-stamp (one-time).** `PROMOTION_EVIDENCE_EPOCH`
  2026-07-19T18:57:09Z → **2026-07-20T09:36:00Z** at final pre-campaign spot config (XA bundle +
  X6/X7/X8 all deployed on the same boot). Flatness at stamp: 0 open orders, DUST-FLAT — 7
  sub-minNotional residuals (largest ~$0.25), the same standard the original W5 stamp used.
  Honest note: the first flatness query filtered `mode='demo'` (wrong string; lane mode is
  `testnet`) and returned a false-clean empty — the Y1 §C.9 negative-read-void class, caught by
  re-reading without the filter. Prior epoch carried only idle-consult burn and 0 trips — reset
  is costless now, expensive once trading resumes. NOT a repeatable ratchet-escape; perp's single
  stamp lands immediately after X2 deploys.

**WATCH-XA6** (24h from 09:30Z): zero 1008 mass-close events; forced-reconnect rate ≤ R8-2
baseline; spot RSS TREND flat (level 1.34GiB accepted; >20% growth between sweeps without a
deploy = R8-6 precursor, investigate before anything else); no STALE_DATA veto storm on
active-menu symbols (1000ms depth vs the 5s veto leaves 5x margin — a storm = revert
watchOrderBookRate to 100 and record). **WATCH-XA7-spot**: the promotion scoreboard walks only
post-09:36Z evidence; any pre-stamp trip/spend appearing in the walk is a defect.
**WATCH-X7/X8**: the first reflection attempt on this build renders postMortems + versionPnl
blocks in its payload (verify at the next weekly fire or trade-pair trigger); versionPnl shows
all-unattributed until post-stamp trips close (expected, not a defect).

## X2 stage-1 + XA7-perp + Y2/Y3 loop tooling (2026-07-20 ~10:30-13:30Z) — decision record

All gated (full suite 2534→2553 + livegate green per commit), deployed, live-verified.

- **X2 stage 1 (30817a7)** — perp universe 1→8: BTC ETH SOL ZEC AAVE NEAR HYPE KAITO (universe
  study: mean|daily ret| × log(30d mean quote volume) on production fapi, $0.50 floor;
  crypto-native only — equity-tokenized perps like KORU/MSTR scored high but trading-hour gaps
  fight bar scheduling/staleness; stage-2 reserve TRUMP UNI BCH). Every symbol + filter
  keyed-probe-verified on demo-fapi (#54 pattern); BTC perp step corrected 0.001→0.0001 (demo is
  finer; 0.001 was a ~$110 sizing quantum on the $1k book). Menu-4, fraction 0.35, cost stop
  1.50, portfolio consults ON at the XA1 15s window. Seed v5 (menu-breadth: concentrate, don't
  spray) active — perp DB version ceiling checked (4) before deploy, the XA3 collision class.
  NEW fh1 funding-rate-history payload block (usable while flat). Prompt HONESTY fix: the perp
  prompt promised margin/liq-distance fields the payload never carried — now teaches
  first-principles 2x-cap liquidation reasoning; the real fields are a follow-up before stage 2.
  **Live acceptance: batched consult c819a810 covered exactly the menu-4; all 8 symbols journal
  every bar; perp CPU ~1.8% / RSS 385MiB (ceilings crushed); 4 books tier-parked.**
  **PRE-AUTH (UNFIRED): stage-2 flip (16 symbols / menu-6) may be applied after one clean 24h
  soak inside ceilings (CPU <250% combined, RSS <2GiB/lane, zero 1008 mass-closes, recreations
  under half the rolling cap).** Sharding re-acceptance memo: post-XA6 stage-1 is ~21 subs (vs
  the ~64 the deferral memo feared) — full-drop recovery ceil(21/4)×1s ≈ 6s; sharding stays
  deferred. Known stage-1 residuals: trade-flow REST poll fails for HYPE/KAITO (no spot klines —
  fail-open, 2 of 8 symbols without tf block); funding acceptance is position-conditioned
  within the first post-deploy week (WATCH below).
- **XA7-perp (9f1c8c6)** — epoch 2026-07-18T15:36:14Z → **2026-07-20T10:42:00Z** immediately
  after the X2 stage-1 deploy. Venue-flat KEYED-PROBE-verified (fetchOpenOrders empty,
  fetchPositions empty); the 07-17 OMS row cbt019f6e8... (BTC SELL LIMIT state=NEW) is
  venue-ABSENT (OrderNotFound) — **named debt: the XA5(b) terminal-NEW class confirmed live; the
  app-side sweep/heal did NOT clear it in 3 days.** Both lanes now stamped once each; XA7 CLOSED.
- **Y2 (0dad180) + Y3 (2e0c191)** — pnpm loop:sweep / loop:collect / loop:digests. Live
  acceptance: three sweeps — real per-lane deltas on matching bootIds, boot-change resets clean,
  cost breakers read per-lane ($1.50/$1.50 post-X2). The tool caught its own precision defect on
  run 2: zero_decides fired on a 3-minute gap → fixed with a 30-min liveness elapsed floor
  (short_interval annotation below it; unknown elapsed still alarms). Collector smoke: sentinel
  self-verify, 26 heartbeats at 2s cadence, clean SIGTERM. Note: sandboxed smoke runs overwrote
  the shared watermark with probe-failed lanes — harmless (watermark is a cache, not truth) but
  explains one no-baseline sweep at 13:23Z.
- **Feeds verify-before-build (read-only, pre-X3/X4/X5):** X3 narrows to Fear&Greed (new) +
  futures taker-volume folded into the EXISTING positioning poller (pos1→pos2; long/short ratio
  already live); X4 core CLOSE-OBE (CryptoPanic adapter exists, fail-open, key-redacted) with
  three real residuals (currency filter hardcoded BTC,ETH vs 24-basket; no keyless boot log; no
  dedupe-by-id); X5 narrows to divergence flag + per-bar CVD series on tf1→tf2. No feed block
  acts as a veto on the active prompt path (XA3 semantics hold).

**WATCH-X2** (stage-1, from 10:42Z): ≥1 closed perp trip/day once entries begin; funding
acceptance = within the first week a position held across a 00/08/16Z boundary lands a
funding_payments row inside one poll interval; the 3× spot batch-element schema-validation
soft-holds (submit_portfolio element failed — NEAR/USDT 12:20Z) stay rare (<5% of batch
elements; a growing rate = consult spend without decisions, defect-class). **WATCH-Y2/Y3**: the
first scheduled pass rehydrates from loop:digests and runs loop:sweep as its evidence sweep
(Y4 wires this); collector survives the next host sleep with an annotated gap.

## X9 — round-7 extension gate + records (2026-07-20 ~15:30Z)

Gate GREEN at f4be8fe: build+lint+typecheck+format:check, 151 files / 2594 tests, livegate
41/41; both lanes redeployed healthy, 0 error-level lines post-boot.

- **X3/X5 feeds + X4 residuals (face895; enable f4be8fe two-step).** Scoped by the
  verify-before-build gap analysis (recorded above). Fear&Greed feed live both lanes (fg1
  block; keyless; container→alternative.me verified, index 29 "Fear" at deploy); futures taker
  buy/sell volume folded into the EXISTING positioning poller (`fapiDataGetTakerlongshortRatio`
  verified in pinned ccxt; pos1→pos2); trade-flow divergence flag + per-bar CVD deltas
  (tf1→tf2); sentiment residuals (basket-derived currencies incl. perp form, keyless boot log
  line, dedupe-by-id) — the sentiment feed itself stays OFF pending the owner's CryptoPanic key
  AND a SENTIMENT_FEED_ENABLED flip (both required).
- **R1 replay harness (ddd03a1).** `pnpm replay:agentic` — v2 contract over historical candles,
  candidate-backtest fill model reused verbatim, decide-model pinned (R8-8 class), per-run USD
  cap aborts via pre-call reservation. Exclusions spec-proven: promotion stats / round trips /
  version digest / exec-quality BY CONSTRUCTION (no fills, playbookVersion:null); the
  llmTokenTotals and lane-wide journal reads BY FILTER (notLike 'replay-%'). Reflection synthetic source opt-in
  (default OFF) and always labeled. Dry-run smoke: 8 decisions at a $0.50 cap, clean abort.
  Replay runs remain owner/loop-triggered (~$30-80 at real scale).
- **Lane metric parity (owner directive 2026-07-20) — premise CORRECTED.** Audit verdict:
  emission was ALREADY fully mirrored (all families registered unconditionally in
  ObservabilityModule; perp emitted agentic_version_* all along — 15k samples/30d). The named
  gap was the DASHBOARD: version panels bound to prometheus-spot only. Fixed: perp twins (ids
  119/120) + a venue protective-order lifecycle pair BOTH lanes (121/122 — emitted by both,
  panelized by neither); owner committed the dashboard (5ef8c52). Genuinely one-lane by design:
  funding_payments_ingested_total (perp venue guard, correct). Transients (perp flat ⇒ no
  position gauges) self-heal.
- **Shared-org rate-limit hazard (operational, recorded for GCP-era too):** the 11:00Z hour
  produced 21 RETRYABLE error decisions (16 spot / 5 perp) — heavy orchestration sessions and
  the trading app share ONE Anthropic org budget; my session's agent fleet exhausted it and the
  app's consults 429'd for the hour, recovering on reset. Mitigation options (not applied):
  separate key/org for the app, or orchestration restraint during trading hours. R1 replay runs
  inherit this hazard — their budget caps bound spend, not org-limit pressure.
- **Backlog hygiene (A0 items):** #47/#48 CLOSED-OBE by the v2 contract; #53 folded into X6's
  outcome counter (shipped); #18 folded into X7's expectancy buckets (shipped); #45 (venue-stop
  drift re-verify) re-checked against v2 exit directives — covered by the venue-stop-lifecycle
  suite + the new venue TP/stop panels; the 07-17 stale-NEW OMS row remains the open
  terminal-NEW debt item (named at the XA7-perp record).
- **Confounded attribution note (deliberate):** the first campaign's results cannot be
  attributed to any single change — the XA bundle, seed v4/v5, epoch re-stamps, X2 widening,
  and the feed additions all landed within days. This is accepted by design: there was nothing
  to attribute before (0 trips); attribution discipline starts NOW via X8's per-version table
  and the fresh epochs.

**WATCH-X9** (the A0-mandated observables, first checkpoint at the next pass, then daily):
(1) batched consults/day per lane vs the 8-20 band + entries/day vs the ~2.14 trips/day
promotion pace, with the derived earliest-promotion date (alarm when it slips >2 days/pass);
(2) per-trip net-of-cost vs the ~$0.70-1.00 bar once trips exist; (3) cost/day decomposed
(batches × size × per-consult cost), overshoot ≤10%; (4) XA5 regression guards (exit-reject
streaks ≥3, fill→terminal latency > reconcile interval); (5) P0b maker re-run re-arms at N≥15
v2-era maker entries (20% would-cross tripwire); (6) funding drag on perp shorts post-X2;
(7) CPU/RSS vs the XA6/X2 ceilings (spot ~25%/1.34GiB, perp ~2%/385MiB baselines);
(8) reflection exactly-one-fire/UTC-week at the capped shape, now rendering postMortems +
versionPnl + (when enabled) synthetic blocks; (9) replay-attempt cost at the decide tier with
epoch-cost exclusion holding (llmTokenTotals unchanged by any replay run); (10) fg1 block
renders in the first post-enable consult payload (fail-open: absence after 24h = feed defect,
not market signal).

## Last pass

**Pass 34, 2026-07-18** (scheduled, ~08:07–08:40Z, **MAINTENANCE — P0b entry fill-quality
pre-auth re-run EXECUTED at N=25: maker discipline VALIDATED, no guidance change**) — sweep ALL
GREEN both lanes (0 errors, 0 HALT/mismatch/EXPIRED, harness probe green, host AC/awake).
**Attribution WATCH holding:** v1=23 / v2=3 / unknown=0 (=RT 26 ✓, no unknown regrowth).
Scoreboard: RT=26 (+0), net −$23.25, LLM $12.86, window 5.12d, ready=0; equity $4,986.17.
Spend: last-24h **$3.99** (< $4.50 bar, fallback NOT armed) but the since-boot 6h pace
annualizes ~$6.3/day on a 29% prescreen-skip morning (BTC breakout activity) — first full-UTC-day
>$4.50 would be breach 1-of-2 for the factorial cost rule; re-read next pass. **Live: same-bar
BTC maker entries BOTH lanes 07:45Z; perp trip 4 OPEN (0.001 @ 63960.4) and the stop architecture
engaged organically at 08:15:01–03Z — venue TP (64344.2) + STOP_MARKET (63954.8) both ACKED
within 3s of the bar (first non-probe engagement since Bug B); P8d WATCH item 2 (fill journaling)
is live-armed on this position — check FIRST next pass.** Spot holds LINK 13.27 @ 8.262 with
resting venue TP (8.386, drift-managed clean). Study: fill rate 76%, median 0.13 bars; 6 misses
= −353.5bps signed foregone (5/6 dodged losers) ⇒ post-only validated; report
`reports/loop/entry-fill-quality-2026-07-18.md`, registry row 130; P0a stop-slippage re-run
still gated (`plan exit: stop` N=7 < 10). L0→L1 soak day 1/3, 3/5 trips. CANDIDATE/PROMOTION
ineligible (v2 3/10 unresolved). Ship: docs + registry row only, no deploy. Full entry:
`reports/loop/LOG.md`.

**Pass 33, 2026-07-18** (scheduled, ~00:05–01:10Z, **MAINTENANCE — trading-path measurement bug
found + FIXED+SHIPPED (`309bbfc`)**) — **Bug E (both lanes): version attribution read the shared
`journal.recent(2000)` window; quiet NULL-version rows (419 of 624 rows on 07-17) shrank it to
~3.2 days post-5→8 — it already clipped the epoch by 5h15m (live signature: v1 22→18 attributed
trips in 6h, new `unknown`=5 bucket), and at ~620 rows/day the promotion evaluator's symmetric
10-trip floors were structurally unreachable (v2 could never hold >~5 in-window) — auto-promotion
starved, the A/B resolvable only by mint-over clock.** Third window-shrink-class instance (#39,
Bug C). Fix: optional `AgentDecisionJournalPort.recentVersioned(limit, sinceMs)` — versioned rows
only, epoch−24h bound, 20k cap; both consumers (promotion-evaluator + version-attribution
gauges) prefer it, fail direction unchanged ('unknown', never mis-attribute). Reviewer APPROVE
0 must-fix (3 nits applied); 2218 unit + 53 db + livegate + paper + eval green. Deployed BOTH
lanes ~00:36Z (spot `473d76fc`, perp `b1995dce` — perp folds in `f9b7d56`, Pass 32 carry DONE;
NB the perp image needs its own `--profile perp build app-perp`). Soak: post-fix sampler tick
v1=23 / v2=3 / unknown=0 (=RT 26 ✓). Sweep otherwise ALL GREEN: 0 errors/HALT/mismatch both
lanes; **first spot venue-TP FILL (Phase-2 WATCH 2 RESOLVED GREEN): ZEC TP filled 17:05Z, trip
closed +$1.35 — second green symbol**; Bug D soak positive (42s max staleness, 0 forced
reconnects, 7h/32 subs); spend day-2 re-measured **~$2.0–2.7/day** (day-1 band was boot-cache
noise; fallback NOT armed); perp 16:38Z boot's 1 proposal → LIMIT_MAKER rested 2 bars → TTL-
canceled cleanly; L0→L1 soak intact (3/5 trips, clean since 07-17 13:25Z). Spot RT=26 net
−$21.24 LLM $10.95 ready=0. CANDIDATE/PROMOTION ineligible (unchanged). Full entry:
`reports/loop/LOG.md`.

**Pass 32, 2026-07-17** (scheduled, ~16:07–17:50Z, **MAINTENANCE — two trading-path bugs found,
BOTH FIXED+SHIPPED**) — **Bug C (`cfb2ed3`, both lanes):** the live-abstention lapse measured
entries over `journal.recent(400)`; the 5→8 expansion shrank that window below v2's lifetime, so
the 07:45Z reflection declared the WINNING spot candidate (3/10, +$1.09) "provably abstaining"
and attempted a mint-over — only the Phase-4 expectancy reject (×2) saved it, and the fresh 336h
runway protection was silently bypassed (abstention path ignores age). Fix: lifetime
`versionEntryStats` per version (port + Drizzle + in-memory), fail-toward-not-lapsing; true
abstainers (perp v2: 23 decides/0 entries lifetime) still lapse. Reviewer APPROVE 0 must-fix; 2212
unit + 52 db + livegate + paper + eval green. **Bug D (`f9b7d56`, spot):** synchronized ws
resubscribe burst after any `exchange.close()` (watchdog fire or boot) trips Binance's >5 inbound
msgs/s limit ⇒ lockstep 1008 livelock — all 8 candle channels dead 16:44→17:31Z (~3 bars; S3 off
fresh ticker + resting venue TP kept positions protected) while ticker/trade/book flowed. Probes:
venue healthy (fresh raw WS 12 klines/40s); pinned-ccxt repro at 32 loops = candle 0/8 forever vs
1-loop ~2.5s. 20 subs (5 sym) sat under the cliff; 32 crossed it. Fix: global 350ms subscribe gate
(first-watch + first-after-error only; ~3 msg/s < 5; delayed-never-dropped) + rate-limited loop-
error logging (the error path was silent — same class as Bug A). Reviewer APPROVE 0 must-fix; 2214
tests. Soak: first clean 32-sub boot of the day — all candles fresh at +8 min, 0 reconnects.
Perp NOT redeployed for D (runs `cfb2ed3`; 4 subs, under the cliff) — fold in next perp deploy.
Sweep otherwise: spot RT=25 net −$22.49 LLM $10.24 ready=0; v1 22/−$13.23 vs v2 3/+$1.09; perp
heal SOAKING POSITIVE (351 consecutive CLEAN 13:23→16:18Z, book flat, RUNNING); 5→8 day-1 GREEN
(ZEC/AAVE/NEAR all deciding, ZEC 3 longs + position with resting TP, zero risk vetoes); spend
day-1 ~$3.5–4.8/day (upper band, boot-cache-heavy — re-measure before any fallback);
`adopt_non_adoptable=2` benign (reconcile raced 3 in-flight fills 11:49Z, self-cleared);
factorial 7 attributed trips ⇒ harm-stop peek not due. CANDIDATE/PROMOTION ineligible
(unchanged). Full entry: `reports/loop/LOG.md`.

**Pass 31, 2026-07-17** (scheduled, ~06:45–07:30Z, **MAINTENANCE — E2 decide-model re-test
EXECUTED: haiku-4.5 HOLD, sonnet-5 stays champion**) — clean sweep otherwise: 0 error/warn both
lanes, harness probe GREEN, watchdog (`c105e8a`) soak extends positive (staleness nominal, 0 forced
reconnects over 6h). Spot scoreboard: RT=20, net −$14.18, LLM $8.16, window 4.43d, ready=0; A/B
unchanged (v1 17 trips −$7.02 / v2 3 trips +$1.09) — **v2's 168h age-lapse lands ~07-18 04:45Z ⇒
expect a v3 mint attempt on the first spot close after it** (post-fix reflection-outcome watch arms
then). Perp Bug B containment verified holding (one phantom exit REJECT per bar, no new entries,
venue flat, cash unchanged; one transient SUBMIT_AMBIGUOUS self-resolved on the regular rail).
**E2 re-test** (pre-registered at corpus ≥600; 728 now): n=100 newest rows, ~$0.58 — HOLD, 3/6
criteria fail (schema 0.83, hold-agree 0.78 < 0.85, **forward proxy −27.9bps vs champion
+17.8bps**); passes only cost/plan-sanity/propose-ratio. The 07-12 "cheaper-and-more-proposing"
profile did NOT persist. Scorecard `candidates/e2-model-eval-2026-07-17.json`; registry row 129;
standing verdict updated (re-test trigger CONSUMED). P8a harm-stop peek not yet due (≈≤2
arm-stamped trips/cell vs the 8 threshold). CANDIDATE/PROMOTION ineligible (unchanged). Full
entry: `reports/loop/LOG.md`.

**Pass 30, 2026-07-17** (scheduled, ~00:05–01:15Z, **MAINTENANCE — two trading-path correctness
bugs found; one FIXED+SHIPPED (`c105e8a`), one owner-gated FLAGGED**) — **Bug A (spot): the candle
pipeline was silently DEAD 16:00Z 07-16 → 00:12Z 07-17 (~8.2h)** — ccxt watch* futures pend forever
on a server-side subscription drop; the supervised loops only act when the promise settles; nothing
exported channel age. Mitigated by restart (decides resumed 00:15Z bar), then shipped a stall
watchdog (force `exchange.close()` at 180s core-channel silence, fail-open, recovery contract
reviewer-verified against pinned ccxt source) + `market_channel_staleness_seconds` /
`market_stream_forced_reconnects_total` metrics + MarketChannelStale/MarketStreamReconnectStorm
alerts. Reviewer APPROVE 0 must-fix; 2,147 tests green; deployed SPOT-only. Outage cost ~−$4.5
realized (both stale positions exited on resume: XRP −2.3%, BTC −1.6%) ⇒ spot RT=20. **Bug B
(perp): the #54 venue stop FIRED at the venue ~17:16Z but its algo-rail fill is INVISIBLE to the
OMS ⇒ phantom local position, `skippedUnknown=1` every poll since, 29+ phantom exit rejects, no
HALT (no position reconciliation on perp; algo intents excluded from order-set reconcile by
design). P8d WATCH 2 RED; L0→L1 re-BLOCKED; evidence lane corrupt since 17:16Z; owner-gated
3-part remedy in § Flagged.** Perp lane deliberately left running (venue flat, exits all reject,
$2/day breaker bounds spend). CANDIDATE/PROMOTION ineligible (unchanged); E2 `eval:candidates`
deferred again on correctness priority. Full entry: `reports/loop/LOG.md`.

**Pass 29, 2026-07-16** (owner-directed `/goal` backlog execution, ~16:05–17:10Z) — **FIVE rows
closed: #54(b) `34bdddd`, #55 `dc98068`, #56 `2f8ed48`, #57 `015bc70`, #42 CLOSED-OBE.** Second
P0d-style probe found the flagged #54 diff was INSUFFICIENT (raw rows carry the venue market id
"BTCUSDT" — the unified-form filter could never match); the shipped adapter fix handles both response
shapes AND both symbol forms. Reviewer APPROVE 0 must-fix; full gates + livegate + paper green;
perp-only deploy (boot `803e9d0b`; spot/factorial untouched). **Soak: the ENTIRE perp stop
architecture verified live for the first time** — STOP_MARKET placed → ACKED → resting on the algo
rail (probe) → reconcile-confirmed (`skipped_existing`, registry stand-down engaged); TP
drift-cancel/re-place clean; zero errors/reconcile_error/DRAIN. P8d WATCH 1 GREEN; L0→L1 technical
blocker CLEARED (soak-count criteria still bind). Rows NOT taken, each per its stated gate:
rows #18/#43/#44/#45/#46/#47/#48/#49/#52/#53 (rationale: LOG.md Pass 29). Owner edits mid-session:
`ab-cells/run.mjs` (in-flight, untouched), dashboard var hide (folded into the report commit).
Full entry: `reports/loop/LOG.md`.

**Pass 28, 2026-07-16** (scheduled, ~14:44–16:00Z, **MAINTENANCE — #54 layer-(a) FIXED, SHIPPED,
LIVE-VERIFIED (`25563bc`)**) — host on AC 100% (Pass 27's soak blocker gone); harness probe GREEN; 0
HALT/mismatch/EXPIRED both lanes. **Probe overturned Pass 27's mechanism:** demo-fapi ACCEPTS
`fapiPrivateGetOpenAlgoOrders` and returns a BARE ARRAY — the throw is the adapter's `{orders}`
destructure (shape bug), not a venue rejection; owner-Q answered, venue-native stop CAN round-trip on
demo once the adapter parses the real shape (exact diff in LOG.md; owner-gated). Fix: try/catch @1309 +
`reconcile_error` metric + regression test; reviewer APPROVE 0 must-fix; gates green (2138 tests);
deployed app-perp ONLY (spot/factorial untouched; env parity vs the new `.env.app-perp` layout verified
pre-recreate; boot `302934d4`). **Soak: first-ever perp venue-TP intent ACKED+RESTING (SELL 0.001 @
65610.9), `reconcile_error=1`, decide survives, DRAINING=0.** Mid-pass owner commit `ab359e1` (env-file
refactor) landed hook-bypassed; normalized in `72eb968` (prettier 3.8.4 + MD060, token-identical, gates
re-verified). New seed #55 (AgenticStrategy NOOP_LOGGER). Spot scoreboard: RT=18 (no new trips), net
−$8.42 (LLM accrual $7.51, ≈$2.55/day), v2 A/B 3/10 +$1.09 vs v1 −$1.90. `debef0f` watch CLOSED
POSITIVE. CANDIDATE/PROMOTION ineligible (unchanged); E2 `eval:candidates` deferred again (correctness
outranked) — next-pass candidate #1. Full entry: `reports/loop/LOG.md`.

**Pass 27, 2026-07-16** (scheduled, sweep ~08:15Z, **report-only — FLAG 1 / #54 ROOT-CAUSED**) —
both apps healthy but freshly restarted ~57min ago on host wake (spot `dcbcc641`, perp `70155015`;
host on **battery 15%**, maintenance sleep — AVAILABILITY). Harness probe GREEN; 0
error/HALT/mismatch/EXPIRED both lanes. Spot scoreboard (epoch 07-12 08:30Z): **RT=18 (+1),
net-of-cost −$7.55 (improved from −$9.46), LLM $6.74, window 2.94d, ready=0**; equity $4994.5, dd
0.11%; LINK +$5.37 lone realized winner. **Positive:** spot A/B v2 now **3/10 trips, net +$1.09 vs
v1 −$1.90** (candidate winning early); E2 watch crossed (spot input_payload=623 ≥200, `eval:candidates`
runnable). Pass type MAINTENANCE report-only: **FLAG 1 (#54) fully root-caused** — uncaught
`fetchOpenAlgoOrders` throw in `manageVenueStopPerp` (agentic.strategy.ts:1309) on the demo venue
crashes `decide()` every managed perp bar ⇒ TP signal discarded (built and metric'd, never placed),
no venue stop, and auto-DRAIN (`strategy_lifecycle{DRAINING}=1` confirmed); perp-specific because spot
runs venueStop off (P7f double-lock). Fix flagged not shipped (adapter/venue owner-Q + can't soak on
battery). Full chain + exact remedy: § Flagged + LOG.md. CANDIDATE/PROMOTION ineligible (candidates
unresolved in A/B both lanes; v2 3/10). No new #49 evidence. Not an escalation day. Full entry:
`reports/loop/LOG.md`.

**Pass 26, 2026-07-15** (scheduled, sweep ~08:20Z, **report-only**) — both app boots fresh
(`29e22ada` spot / `88420be0` perp, ~55min into the Pass 25 `debef0f` redeploy), host awake, harness
probe GREEN, **0 error/HALT/mismatch/EXPIRED over 24h on both lanes**. Spot scoreboard (epoch 07-12
08:30Z): **RT=17 (+5), net-of-cost −$9.46, LLM $6.42, window 2.72d, ready=0**; equity $4993, dd 0.14%;
≈$2.36/day. Pass type MAINTENANCE report-only — no NEW trading-path bug, candidates unresolved in A/B
on BOTH lanes (CANDIDATE blocked), backlog gated, factorial forbids hot-path changes. **Positives:**
`c0d53bd` seed-race fix LIVE-VERIFIED (spot); reflection HEALTHY both lanes — spot
`skipped_unresolved_candidate` (v2 age 99h<168h age-lapse; abstention deadlock resolved naturally, v2
now 2/10 trips, the Pass-24 "abstain-lapse mints v3" prediction is OBE), **PERP minted its own v2**
(first live perp mint, mint-backtest path, healthy); `debef0f` PARTIAL positive (no venue-TP churn this
boot); P8a cells filling (`f|f=9/f|t=14/t|f=18/t|t=17`, thinking ~53% normalized). **2 NEW FLAGS:**
(1) **perp venue-stop/TP does not engage** (held longs 6–11 bars, `AGENTIC_VENUE_*`=true, placed
neither; blocks L0→L1 shorts — § Flagged + backlog #54); (2) **backlog #49 base double-lock now OBSERVED**
(3 self-healing LINK IOC-exit rejects/bar, venue-TP base-lock; latent protective-stop risk; local
rejects emit zero app-log). Not an escalation day (07-15 already shipped Pass 25). Full entry:
`reports/loop/LOG.md`.

**Pass 25, 2026-07-15** (report-only-in-hindsight was a fix pass) — **MAINTENANCE: venue-exit
qty-reconciliation CHURN BUG FIXED + deployed both lanes (`debef0f`).** `agentic_venue_tp_total`
placed=15 / qty_cancel=14 / 0 skipped_existing — `manageVenueTp` compared step-rounded resting qty vs
raw `position.qty` via exact `.eq()` (structurally always false); fix threads `DEFAULT_FILTERS.stepSize`
and compares `roundToStep(pos, step,'down')` at all 3 sites (spot TP + spot/perp stop). Reviewer APPROVE
0 must-fix; gates green (test 2137, 6 new regressions); spot boot `29e22ada`. Full entry:
`reports/loop/LOG.md`.

**Pass 24, 2026-07-14** (scheduled, report-only) — first scheduled pass after Push 3; factorial
arm-stamping + Phase-5 consult WATCHes RESOLVED POSITIVE, perp L0 healthy-in-warmup, reflection
dormancy root-caused (expected-pending, no defect). Full entry: `reports/loop/LOG.md`.

**Pass 23, 2026-07-13** (report-only) and everything since — state.md deep clean (`66c3fac`),
backlog build-out (boot `e44b6497` 19:34Z), and the **Push 3 owner program** (`3c8b1a1`..
`42a4158`): `reports/loop/LOG.md` + § Push 3 program above.

**Passes 2–22 and the owner-session summaries:** `reports/loop/LOG.md` (dated entries; state.md
stopped duplicating them 2026-07-13).

## Backlog (ranked; re-rank each pass)

Conventions: IDs are stable and never renumbered (LOG.md references them). **Re-verify a backlog
item against current code before implementing it** (Pass 2 precedent — inherited items go stale).
**Improvements ONLY — never bugs** (owner decision 2026-07-16, playbook §3 bug-routing
discipline): a defect is fixed in the pass that finds it, or — when it exceeds the §4 rails —
lives in § Flagged as an open defect until authorized. Open items first; the closed ledger keeps
one line per retired ID. After the 2026-07-13
owner-directed build-out (9 rows shipped — LOG.md entry of that date) every remaining open row is
condition- or data-gated: **#42-ENABLE** fires when the info-context A/B resolves; **#44/#45**
wait on venue-TP capture data; **#18/#46/#47/#48** wait on their stated data/sequencing gates;
**#43/#49/#52/#53** need a justification/design a pass should only pick up with new evidence.

### Open

| # | Item | Stage | Effort | Status / next check |
| --- | --- | --- | --- | --- |
| 18 | Per-hour/session expectancy gating (last residual of the W4.4 seeds — fee-tier/BNB dropped: demo fees flat 10bps, § Standing verdicts; trade-flow widening shipped Phase 3) | 2+ | M | seed — needs design + data (2026-07-13 build-out skip: 10 post-epoch trips ⇒ per-hour buckets are statistically empty) |
| 43 | Liquidation-order flow feed — market-wide is WS-only `!forceOrder@arr` (REST forceOrders is private per-account); needs WS plumbing justification | 2+ | L | seed (Push II Phase 3) |
| 44 | Spot OCO exits (fuse executor stop + venue TP into one venue-side pair) — needs demo `orderList/oco` support proof; ccxt 4.5.58 has no unified spot OCO | 2 | M | seed (Push II Phase 2); do not touch before the venue-TP watch resolves with capture data |
| 45 | Trailing-stop plan field — wait for venue-TP capture data (Phase-2 WATCH counters) before designing | 2 | M | seed (Push II) |
| 46 | Thompson multi-candidate A/B routing (replaces the newest-candidate-only slot) | 2+ | M | seed (Push II); blocked while the v2→v3 candidate cycle is mid-flight |
| 47 | Adaptive consult cadence (vary the 15m consult rhythm by regime) | 2 | M | seed (Push II); needs the Phase-5 consult baseline first |
| 48 | Weekly vol-ranked symbol rotation (universe-study follow-on) | 2 | M | seed (Push II Phase 7); sequenced behind the 5→8 expansion; needs a rotation-vs-promotion-walk attribution design |
| 52 | W12 operational event logging (structured ops events; 2026-07-08 follow-up, deferred since) | 1–2 | M | seed — needs design |
| 53 | Reflection-trigger observability — `evaluateTrigger` returns silently when trips-since-attempt < N or on cooldown, so a close that evaluated-but-did-not-fire leaves no metric/log (Pass 24 needed manual boot-timeline forensics to diagnose the 3-day dormancy) | 2 | S | seed — a `agentic_reflection_trigger_total{outcome=below_threshold\|cooldown\|inflight\|fired}` counter; touches the reflection hot path, do NOT enable mid-factorial without a confirmed defect |

### Closed ledger (provenance one-liners; detail in LOG.md by date)

- #1–#9 — 2026-07-06/07 foundation items (gauges, panels, 15m interval, prescreen gate + guards,
  warmup validation): all DONE and live-verified (LOG Passes 0–4).
- #10 — prescreen breakout tuning: CLOSED-OBE 2026-07-13 — 0.0025 shipped Pass 4; skip rate
  reached band (66.7% Pass 22, 80% Pass 23). Reopen only if skip falls below 50%.
- #11 — reflection model: DONE 2026-07-08 (W13) — Opus-4.8 live with per-model pricing.
- #12 — prescreen quiet-detection while position open: CLOSED-SUPERSEDED 2026-07-13 — plan mode
  (07-07) + portfolio consult (07-13) make plan-managed bars $0; the `position_open` early-return
  stands by design.
- #13 — prompt-cache verification: DONE 2026-07-07 Pass 8 (`f5221b9`) — verdict cache WORKS, kept.
- #14 — Stage-1 skip/$-day measurement: CLOSED 2026-07-08 — Stage 1 closed; absorbed into the §2
  sweep.
- #15 — plan-mode enable gate: DONE — enabled 07-07, live-verified Pass 5; post-hoc validators
  since ran (recorded-payload harness; plan-param sweep 07-12).
- #16 — A/B + ladder + promotion-floor enables: DONE 2026-07-08 (W4/W5) — A/B live (25% since
  Pass 21), ladder ON, legacy count-only promotion disabled, attributed floor 10 symmetric.
- #17 — cross-symbol + self-track-record block: CLOSED-PARTIAL 2026-07-12 — crossSymbol shipped
  to the decide prompt (`12e146d`); own-track-record reached reflection (W14); residual
  decide-side self-track-record parked behind the one-channel-at-a-time queue.
- #19 — Grafana panels for new series: DONE 2026-07-12 Pass 17 (cache-aware cost, per-model
  split, duty-cycle stat).
- #20 — degraded-latch alert: DONE 2026-07-07 Pass 8 (`a25389a`).
- #21 — TTL sweep vs boot-recovered orders: ANSWERED-NEGATIVE 2026-07-07 Pass 6; fix half landed
  via #23/#26.
- #23 — OMS cancel-ack package: DONE 2026-07-07 Pass 7 (`f5ce2c0`), self-heal live-verified.
- #26 — recovered orders in E1 clamp: DONE 2026-07-12 (`b00c886` D3) — intents rehydrated at
  recovery.
- #27 — true-spend cache accounting: DONE (W4/W13 + `f5221b9`) — cache tokens persisted, gate +
  $/day price per-model incl. cache, epoch owner-set.
- #28 — `model` label on token/decide counters: DONE 2026-07-11 Pass 16 (`b1b9455`).
- #29 — 100%-hold watch: RESOLVED (structural) 2026-07-08 Pass 11 — holds model-driven; reopen on
  proposes-with-rejections.
- #31 — reflection trigger consumed on transient error: DONE 2026-07-10 (`21c9b2d`).
- #33 — validator concept precision: DONE 2026-07-10 Pass 13 (`f0c5e14`); mint confirmed Pass 16.
- #34 — funding-carry study: DONE 2026-07-10 (`979de5e`) — NO-GO (§ Standing verdicts).
- #35 — LINK freeze / recovery defects D1–D3: FIXED 2026-07-12 (`b00c886`), live-verified.
- #36 — evidence-epoch asymmetry: DONE 2026-07-12 Pass 18 (`cc72a10`); epoch moved same day.
- #37 — E2 cross-symbol pollution: DONE 2026-07-12 Pass 19 addendum (`2f546f3`).
- #38 — plan-mode restart defect: DONE 2026-07-12 Pass 20 (`6e95542`), re-arm live-verified 2/2.
- #39 — candidate abstention deadlock: DONE 2026-07-13 (`b9dddc2`) — mint-time entry-rate floor +
  `AGENTIC_ABSTAIN_LAPSE_DECIDES=15`; WATCH lives in the Stage-2 ladder entry above.
- **2026-07-13 owner-directed build-out (LOG.md entry of that date; reviewer-gated, full gates
  1,940 unit / 41 livegate / 14+1 paper / 15 eval / 51 db):**
- #22 — prometheus named TSDB volume: DONE (`dafe9aa`); history NOT migrated (docker run
  permission-denied, boundary honored) — old anonymous volume `f8878188f136…` preserved for an
  optional owner-side copy; duty-cycle stats read low until 24h of fresh samples.
- #24 — mismatch class split: DONE (`e909664`) — 10-class taxonomy on the counter; alert excludes
  the benign classes; HALT semantics unchanged.
- #25 — stale fixture rows: DONE + **APPLIED** (`76d68a2`) — both wipe fixtures terminalized with
  audit events; post-check 0 non-testnet unresolved rows ⇒ `hasUnresolvedOrders()` false in every
  mode — live-arming-prep blocker class CLEARED.
- #30 — CI eval step: DONE (`dafe9aa`) — remote CI effect verifiable on the next push.
- #32 — reflection SSE: DONE (`7de8ea0`) — idle-gap + 3× cap timers; #31 retry echo pinned
  byte-equal; WATCH: the next live reflection is the first streamed one.
- #40 — order lifecycle timestamps: DONE (`e02217d`) — chokepoint stamps, COALESCE
  first-write-wins pinned on real Postgres; no historical backfill by design.
- #41 — PORTFOLIO_SHORTS_TOOL: DONE (`eff1d95`) — pf2 wire tool; **Phase-8's shorts+consult boot
  blocker cleared** (legacy non-plan shorts + consult still refuses); enablement remains its own
  deployment.
- #42 — thinking A/B enable: CLOSED-OBE 2026-07-16 Pass 29 — the P8a factorial (`a6f0573`) absorbed
  it (`AGENTIC_THINKING_AB_PCT=50` live-verified on the spot container + committed `.env.app`);
  verdict comes from the pre-registered factorial rules, not a separate channel slot.
- #49 — signal-sink pair atomicity: RECLASSIFIED 2026-07-16 (bug-routing policy) — a known latent
  DEFECT, not an improvement; lives in § Flagged awaiting the owner-gated money-path fix.
- #50 — runReflection outer catch: DONE (`7de8ea0`) — `run_failed` outcome + once-only rollback;
  settled outcomes never un-consumed.
- #51 — perp pin: DONE dormant (`3252c1e`) — fail-closed isolated+leverage pin on the perp boot
  path; **the Phase-8 deployment needs an INTEGER `PERP_LEVERAGE_CAP`** (fractional kills the
  boot by design); real-venue verification at that deployment's ceremony.
- #54 — perp venue-stop/TP (FLAG 1): CLOSED 2026-07-16 — layer (a) `25563bc` Pass 28 (throw
  containment, `reconcile_error` metric); layer (b) `34bdddd` Pass 29 (owner-directed): adapter
  parses the probe-proven bare-array response AND matches the venue market id ("BTCUSDT") the rows
  actually carry (second probe finding — the flagged one-line diff alone was insufficient).
  Full stop architecture live-verified 16:45–17:00Z: STOP_MARKET rests on the algo rail,
  reconcile-confirms (`skipped_existing`, registry stand-down), TP drift-cancel/re-place clean.
- #55 — AgenticStrategy NOOP_LOGGER: DONE 2026-07-16 Pass 29 (`dc98068`) — deps pass an
  id-prefixed TradingRuntime logger; all strategy warns now production-visible.
- #56 — Grafana credits stat: DONE 2026-07-16 Pass 29 (`2f8ed48`) — "Credits left (est., USD)"
  (baseline textbox pair − window spend) + "API spend (window, DB)" stacked in the API-cost block.
  Residual owner option: exact balance needs the Anthropic Admin API (separate admin key —
  deliberately not wired, rule 7); reopen only if the estimate proves insufficient.
- #57 — husky pnpm self-resolution: DONE 2026-07-16 Pass 29 (`015bc70`) — hook falls back to
  corepack; verified shim-free by its own commit and every commit since; shim memory retired.

## Flagged for human review (open)

- **OPEN DEFECT — PERP ALGO-STOP FILL INVISIBLE TO THE OMS ⇒ PHANTOM POSITION (Pass 30,
  2026-07-17; ACTIVE divergence since 2026-07-16 17:16Z; owner-gated money-path fix).** The #54
  stop architecture worked venue-side: the resting STOP_MARKET (trigger 64,348.6) FIRED ~17:16Z
  and closed the BTC 0.001 long at the venue. But the triggered algo order's spawned market order
  carries a venue-generated clientOrderId that `decodeClientOrderId` cannot map to an intent
  (fill-ingestor.service.ts:116-119) ⇒ the fill is never ingested (`fill poll: skippedUnknown=1`
  every ~10s since 17:16:07Z), the local book still holds the position, the stop intent stays
  ACKED forever, and the strategy submits a phantom SELL exit EVERY BAR (29+ SUBMIT_SENT→REJECT
  pairs since 17:30Z, raw_ack NULL, reason discarded). NO HALT fires because (a) P7f(3) correctly
  excludes algo intents from order-set reconciliation, and (b) NOTHING reconciles POSITIONS on the
  perp venue — the divergence class is structurally invisible. Evidence lane is corrupt from
  17:16Z (a real closed trip never closed locally; reflection/A/B starved). **Proposed remedy (3
  parts, all execution/OMS — outside §4 rails):** (1) `manageVenueStopPerp`'s reconcile: when a
  CONFIRMED-resting stop disappears from `fetchOpenAlgoOrders`, discriminate CANCELED vs TRIGGERED
  via `fapiPrivateGetAlgoHistoricalOrders({algoId})` and on TRIGGERED ingest the spawned order's
  fill through FillApplication (match by the algo response's orderId, not clientOrderId), journal
  `venue_stop_filled`, terminalize the intent; (2) fill-poll: an unmatched fill on a symbol with a
  live algo intent triggers the same algo-history lookup instead of skip-and-forget (today's
  skippedUnknown is a silent forever-loop); (3) systemic backstop: perp position reconciliation
  (`fetchPositions` vs local book) in the reconcile cycle — divergence is a HALTING mismatch class
  per rule 6. Also fold in: REJECT order_events journal a bare `{"type":"REJECT"}` — persist the
  venue error code/reason on the event payload (append-only-compatible: new rows only). Interim
  posture (deliberate): lane left running — venue account is flat, every phantom exit REJECTS so
  no money can move, and the $2/day breaker bounds the decide spend; do NOT let it open new
  positions before the fix (a real BUY would stack a live venue position under a phantom book) —
  if that risk is unacceptable, stop app-perp until the fix session. **P8d WATCH 2 = RED; L0→L1
  shorts pre-auth re-BLOCKED.** (Pass 31 posture check: containment HOLDING — one phantom exit
  REJECT per bar, no new entries — the phantom book itself blocks them, venue flat, cash
  unchanged; spend bounded by the $2/day breaker.)
  **FIX SHIPPED 2026-07-17 (`1ff1fc7`), BUT LIVE HEAL NOT YET CONFIRMED — the standing phantom
  persists; needs a keyed demo-venue probe next pass.** The 3-part remedy is coded, reviewed
  (4-lens adversarial, 2 must-fix + 1 should-fix all fixed), gates green (2190 tests + livegate +
  paper + eval), and DEPLOYED to app-perp (boot `c2b1043b`, healthy, no errors/HALT). ccxt
  correction applied: the flagged `fapiPrivateGetAlgoHistoricalOrders` does NOT exist in pinned
  4.5.58 — the adapter uses `fapiPrivateGetAllAlgoOrders` + `fapiPrivateGetAlgoOrder`. Extra
  review must-fixes folded in: the position axis is PERP-ONLY by config (`reconConfigFrom`, not
  method presence — spot would else spuriously HALT) and DEBOUNCED to 2 consecutive divergent
  passes (an ordinary stop fire flattens the venue ~10s before recovery heals the book; a
  single-pass HALT would fire on every stop); the spawnedOrderId-absent fallback matcher was
  REMOVED (exclusion-based ownership could fold a foreign fill). **SOAK RESULT (S6, honest):** the
  boot sweep left NO recovery warn and did NOT heal (local still `BTC/USDT:USDT 0.001@64577.6`),
  AND the armed position axis did NOT HALT. Both silences point to a LIVE demo-venue behavior the
  mocked unit tests can't reach and I couldn't pre-probe without keys (the #54 pattern):
  `fetchAlgoOrderStatus` returns undefined when no row matches the intent's clientAlgoId (row
  aged out / id mismatch ⇒ silent 'unknown', no heal), and `fetchPositions` most likely THROWS on
  the demo `fetchPositions` shape (⇒ silent `sweep_failure`, no HALT). Adapter code is structurally
  correct (delegations wired, both response shapes parsed) — the gap is real venue behavior.
  **NEXT PASS (needs live metrics/DB/keyed probe — all denied this session):** confirm via
  `reconciliation_mismatch_total{class=sweep_failure}` + the reconciliations row detail; P0d-style
  probe the demo-fapi `fapiPrivateGetAllAlgoOrders`/`fapiPrivateGetAlgoOrder`/`fetchPositions`
  actual shapes; fix the parse + regression-test; also verify the rehydrated in-flight intent is
  algo-classified (`hasLiveAlgoIntent`). Lane SAFE meanwhile (warmup ~3.5d, venue flat, no orders,
  $2/day breaker). **P8d WATCH 2 stays RED; L0→L1 stays BLOCKED until the heal is live-verified.**
  **SAME-DAY ADDENDUM (owner session ~12:30–13:00Z, keyed probe executed after all): BOTH
  hypotheses above were WRONG — and the "did not HALT" soak note too.** Probe + metrics truth:
  (1) **The axis DID HALT** — `kill_switch_state{HALTED_DEGRADED}=1`,
  `reconciliation_mismatch_total{class="position_drift"}` climbing every pass since ~1min after
  the `1ff1fc7` deploy; the engage line sat outside the soak grep windows and drift bumps are
  metric-only. The fail-closed backstop WORKS as designed. (2) `fetchPositions` round-trips CLEAN
  on demo (flat ⇒ `[]`, no throw). (3) The real no-heal cause: the fired stop's history row
  (`algoStatus=FINISHED`) carries the spawned order id as **`actualOrderId`** ('22141017991' —
  exactly the fill's own order id), not `orderId`; CANCELED rows carry `''`. Normalizer FIXED,
  live-shape regression-pinned, reviewer APPROVE 0 must-fix, gates green, deployed (boot
  `5403a8e0`). (4) That boot exposed the SECOND gap: recovery anchors only on LIVE in-flight algo
  intents, and the stop intent is now TERMINAL in the DB (0 intents rehydrated; a prior HALT's
  cancel path consumed it) ⇒ `recoverSymbol` returns 'none' without querying the venue ⇒ lane
  re-HALTed (correct, fail-closed). **Fix in flight (same session): DB-anchored recovery
  fallback** — persisted algo intents (incl. terminal) + late-fill application through the
  portfolio fill path, append-only event rows only. Heal target fill (probe-pinned): venueTradeId
  518032435 / order 22141017991 / SELL 0.001 @ 64181.4 / venueTs 1784222166363. Lane posture:
  HALTED = SAFE (kill switch refuses orders, venue flat, breaker bounds spend).
  **RESOLVED 2026-07-17 ~13:25Z (owner session) — PHANTOM HEALED, FULL CHAIN LIVE-VERIFIED (boot
  `051939bd`).** Three follow-up commits closed it: `333db28` (spawned order id lives in
  `actualOrderId` on demo — probe-proven, live-shape-pinned; reviewer APPROVE), `555cd48`
  (DB-anchored recovery — P7f(3) skips algo intents at boot so the in-flight anchor was
  structurally dead post-restart; anchor now = non-terminal order records + the P7c
  `loadIntentByClientOrderId` write-ahead row, discriminator `type==='STOP_MARKET'` because
  `order_intents` doesn't persist triggerPrice; reviewer APPROVE 0 must-fix, all 4 should-fixes
  landed incl. the halt-coordinator in-flight-leak guard and the once-per-poll anchor scan),
  `bd1cab2` (demo delivers algo timestamps as JSON STRINGS — the EpochMs mint threw, fail-open
  caught it exactly as declared, coercion + string-shape pin). **Live verification:**
  `fills_total` 0→1 (venueTradeId 518032435 ingested with exact strings 64181.4/0.001 + fee,
  under the stop's own coid); order row RECONCILE_REQUIRED→FILLED; `positions=[]` (book flat,
  equity=cash $4,998.77); FIRST reconcile pass `result="clean"`; `kill_switch_state{RUNNING}`.
  Interim-note correction: the drift axis HAD been HALTing the lane (HALTED_DEGRADED) between the
  first fix deploy and this resolution — the fail-closed backstop worked the whole time.
  **P8d WATCH 2 → GREEN** (the venue-stop fill is journaled and folded — retroactive but real).
  **L0→L1 shorts pre-auth: technical blockers ALL cleared — the ≥3-day / ≥5-closed-trips clean
  soak restarts from this boot; loop-domain to fire when met.** Evidence lane restored (3 closed
  perp trips on the book). **Pass 32 soak check: POSITIVE — 351 consecutive CLEAN reconcile
  passes 13:23:53→16:18Z, positions table empty (book flat), kill switch RUNNING, 0 mismatches.**
  Perp image note: RESOLVED Pass 33 (2026-07-18) — the Bug E redeploy (`309bbfc`, perp boot
  `b1995dce`) folded `f9b7d56` into the perp lane.
- **PERP VENUE-STOP (FLAG 1, #54) — RESOLVED 2026-07-16 (both layers shipped; Pass 29 closed it).**
  Layer (a) `25563bc` (throw containment + `reconcile_error`); layer (b) `34bdddd` (owner-directed
  `/goal` session): adapter parses the bare-array response AND matches the venue market id
  ("BTCUSDT") the rows actually carry — the second probe finding; the Pass-28 flagged diff alone
  would have left resting stops invisible to their own reconciler (duplicate-placement hazard).
  **Full stop architecture live-verified** (boot `803e9d0b`, 16:45–17:00Z): STOP_MARKET placed
  through the full OMS path, RESTING on the algo rail (probe-confirmed), reconcile-confirmed next
  bar (`skipped_existing`, registry `venueStopResting=true` ⇒ executor/S3 stand-down inside the
  force band); venue TP drift-cancel/re-place clean; `unknown-resolver`'s algo rail healed with the
  same fix. **Residual watch:** `reconcile_error` should now stay 0 (non-zero = NEW failure mode);
  `venue_stop_filled`/`venue_tp_filled` journal rows on the next closed perp trip = P8d WATCH 2.
  **L0→L1 shorts pre-auth:** technical blocker CLEARED; the soak criteria still bind (≥3 days clean,
  ≥5 closed perp trips, zero reconciliation mismatches, WATCH 2 green).
- **OPEN DEFECT — #49 signal-sink cross-signal pair atomicity (reclassified from the backlog
  2026-07-16 under the bug-routing policy; observed Pass 26, SPOT):** a resting venue-TP GTC locks
  the base qty a concurrent same-price marketable sell needs — 3 self-healing LINK IOC-exit
  TERMINAL_REJECTs (one/bar, `raw_ack`=null local refusal, ~0.0096 free vs 12.03 needed). Benign as
  observed (profit-take exits ≥ entry, position held), but LATENT: an S3/protective-stop fire on a
  TP-locked base is defeated unless the TP is cancelled FIRST — a cancel-before-fire ordering the
  signal sink does not guarantee today. Exceeds the signal-sink scope exception (CANCEL_OPEN routing
  only) ⇒ owner-gated money-path design: protective exits must atomically cancel the resting
  same-side venue order before (or with) the exit submission. Note: spot-only exposure — on perp the
  margin model has no base-lock, and the venue stop now rests server-side (#54 fixed); on spot the
  P7f double-lock forbids venue TP+stop together, so the executor/S3 stop is exactly the path the
  TP base-lock can defeat. **RESOLVED 2026-07-17 (owner session, `1b8d872`, spot boot
  `482d5ab1`).** Shipped design: compound signal — optional `cancelBeforeSubmit` on
  protective/managed exits; the signal sink cancels the resting same-side venue order (awaited to
  CANCEL_ACK) then submits the exit inside ONE per-key chain entry so nothing interleaves; cancel
  failure still submits the exit (fail OPEN for the protective action — venue rejects, next tick
  retries; reduce-only sizing bounds the race). 2-lens adversarial review, 1 should-fix found +
  fixed (the cancel-step journal row uses a `:cbe`-suffixed dedupeKey — same-PK collision was
  silently dropping the APPROVED+intentId row). **WATCH:** the next S3/protective or stop/max_hold
  exit against a resting TP journals `CANCEL_BEFORE_EXIT:<n>` then the gateway verdict on distinct
  rows, and the exit FILLS (no TERMINAL_REJECT insufficient-base loop); a `signals insert failed`
  ERROR on this path = the PK fix regressed.
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
- **`ReconciliationMismatch` severity — RESOLVED-STALE 2026-07-16:** the Pass-8 flag said "restore
  critical when #24's class split lands"; #24 landed (`e909664`) with a deliberate severity design
  the flag predates — benign classes excluded from the alert entirely, HALTING classes paging
  critical via `ReconciliationHalt`/`KillSwitchEngaged`, and the residual actionable-but-non-halting
  classes (sweep/query failures, non-adoptable statuses) at warning (rationale in
  `observability/alerts.rules.yml`'s own comment). Restoring critical here would over-page
  non-halting mismatches; the implemented design supersedes the interim note. No change.
- **CI gap:** RESOLVED 2026-07-13 build-out (`dafe9aa`, #30 shipped) — the remote CI effect is
  verifiable only on the next push to the remote (no-push rule); keep the §2.6 every-pass probe.

### Standing verdicts (binding evidence — passes must NOT re-derive these)

- **Price-TA edge search is settled EMPTY** (2026-07-12 ultracode session: 4,562 backtests, 8
  families, long+short, 15m–1d, fees 0→20bps — ZERO honest survivors at any fee level incl.
  0bps; `reports/loop/multi-strategy-search-2026-07-12.md`). The LLM lane cannot profit by
  reading price better; its only possible edge is information the price series does not contain.
  **Do NOT re-run price-TA edge searches.** (Frontier if ever wanted, forward-test-only:
  long-short daily cross-sectional momentum on perps.)
- **Funding-carry NO-GO** (0/126 cells, `reports/loop/carry-study-2026-07-10.md`; re-test harness
  `test/backtest/carry/`, ~14-day cadence — next due ~2026-07-24 under the winsorized benchmark,
  write a NEW dated report). **Funding-contrarian frontier KILLED on second holdout**
  (`reports/loop/nonprice-sweep-2026-07-12.md`; 134/150 frontier cells died, top cells flipped
  negative — regime beta, not signal; do not redo). Both cheap non-price series are dead as
  directional signals; remaining edge channels = the live info-context A/B and event/news-class
  information with no fetchable history.
- **Demo fees are REAL and exactly 10bps flat per leg, maker=taker** (verified 2026-07-12) ⇒ fee
  levers cannot move demo PnL; fee-tier/BNB work is live-parity prep only.
- **Decide model: claude-sonnet-5 stays champion — E2 re-test trigger CONSUMED 2026-07-17
  (Pass 31).** First run (07-12, n=50): haiku-4.5 fails hold-agreement + propose bars. Re-test at
  corpus ≥600 (728; n=100 newest rows, registry row 129, scorecard
  `candidates/e2-model-eval-2026-07-17.json`): HOLD decisively — schema-valid 0.83, hold-agree
  0.78 < 0.85, forward proxy −27.9bps vs champion +17.8bps; the "cheaper-and-more-proposing"
  profile did NOT persist (propose ratio 1.8→0.8, propose-agreement 0.2). No further scheduled
  re-test — revisit only on a material payload/regime change (e.g. post-factorial always-on info
  blocks). Opus-4.8 decisively rejected (07-13). **Thinking-on: NO FLIP** by pre-registered
  criteria but strongest lever surfaced → absorbed into the P8a factorial (#42 CLOSED-OBE). E2
  re-run recipe (env hygiene — the SAFE recipe): LOG.md 2026-07-10 ~22:00Z incident-pass entry.
- **Directional seed-rule edge clears fees nowhere ≤1d** (edge diagnostic 2026-07-10, 52
  selection-corrected buckets; `reports/loop/edge-diagnostic-2026-07-10.md`).

### Resolved (provenance index — detail in LOG.md by date and the named reports)

- Research handoff + self-learning engine v2 (2026-07-12):
  `reports/loop/autonomy-profitability-research-2026-07-12.md` — unrouted `active()` reads,
  unresolved-candidate guard, symmetric+PoS promotion, `knobs:` channel, symbol-agnostic cached
  prefix, plan persistence (migration 0010), `pnpm arm` ceremony. All shipped + live-verified.
- Ultracode multi-strategy session (2026-07-12): engine + sweep shipped
  (`pnpm backtest:agentic`, `test/backtest/multi-strategy/`); verdicts above; re-dispatch items
  all landed (arm-hardening `e75db49`; winsorized deflation `1042930`; #25 remains, see backlog).
- DB-wipe incident 2026-07-10 (self-inflicted, remediated): epoch reset + `scripts/db-backup.sh`
  (keep-14; §5 standing per-pass duty) + destructive-suite hard-refusal on non-`_test` DBs;
  2 fixture rows remain → backlog #25. Full account: LOG.md 2026-07-10.
- Evidence-epoch thread (Passes 14/17/18): resolved — epoch threading `cc72a10` + move to
  2026-07-12T08:30:00Z; current value lives in § Pre-authorizations.
- Host-reboot outage class (Pass 15): `restart: unless-stopped` on all four services
  (`e4542fb`); residual = the Docker-Desktop-at-login dependency (see AVAILABILITY).
- Cost-floor-vs-throughput decision thread (Passes 10–12): RESOLVED-OBE — the owner opened the
  edge question (2026-07-10 program) and throughput resumed; posture = accept accrual, learning
  machinery now complete.
- Reconciliation-dead + restart hazard (Pass 6→7), alerting-dead-since-first-boot (Pass 6),
  latch observability (Pass 8), marketable exits, dust-threshold accounting, stale-order
  re-diagnosis (→ #25), ANTHROPIC_API_KEY blocker, unowned Grafana diff: all resolved
  2026-07-06→08; one-line ledger only — detail in LOG.md Passes 5–8.
- Out-of-band API verification spend (2026-07-07 ~$0.02; 2026-07-10 ~$0.2): deliberate, logged
  for cost honesty; bypasses DailyLlmBudget accounting.
