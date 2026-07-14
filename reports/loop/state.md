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
- **Stage ladder + exit criteria (condensed from the active spec):**
  1. **Cost floor** — CLOSED 2026-07-08: true spend ~$0.77/day under the $5 breaker, skip rate
     70–83% (original criterion: ≤$1/day ×3 days + ≥2 RT/day + no EXPIRED regressions).
  2. **Learning-loop edge** — ACTIVE. Exit: ≥2 playbook promotions with version-attributed PnL
     AND rolling-7d net-of-cost ≥0. Current status (2026-07-13): playbook active v1; **v2 minted
     2026-07-11 04:45Z (first live mint — the Pass 12→13→14 repair chain verified)** but v2
     provably abstains (0 entries in 49 attributed decides since mint) so its 10-trip verdict
     clock never starts; #39 shipped `b9dddc2` — **the NEXT reflection trigger lapses v2
     immediately (`AGENTIC_ABSTAIN_LAPSE_DECIDES=15`, retro-applies) and mints v3 through the new
     mint-time entry-rate floor + expectancy backtest; WATCH for `minted` or
     `abstain_reject`/`expectancy_reject` (`validator_reject`/`transport_error` = new defect).**
     **Pass 24 root-cause (why it is still dormant, NO defect):** the reflection loop has not fired
     since the 07-11 mint because every boot since predates the `c0d53bd` seed-race fix and — by
     direct query — no single (strategy, boot) reached ≥2 closes across that window (max=1), which
     the pre-fix code needs to fire; the frequent short-lived redeploys reset the in-memory prime
     first. `c0d53bd` went live only today ~15:20Z on boot `695b6abf`, which has had zero closes. The
     abstain-lapse is confirmed armed (46 v2-attributed `claude` decides / 0 entries in the recent
     400 journal rows ≥ the 15 floor). **The first closed trip under boot `695b6abf` is the test** —
     it should seed the trigger, lapse v2, and mint v3.
     Reflection fires per strategy after 2 closed trips (`AGENTIC_REFLECTION_EVERY_N_TRADES=2`,
     `3e5773f`); NB the trigger check races the async DB seed on first-close-after-boot (primes
     but cannot fire — documented quirk, § Durable findings). PROMOTION pass eligibility:
     candidate needs ≥10 of its OWN attributed trips (symmetric — champion needs ≥10 in-window
     too); CANDIDATE passes stay blocked (§3(a)) while a candidate sits unresolved in A/B.
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
    TRADING_SYMBOLS, never reorder.

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
  adversarial-review findings all fixed same-session (list: LOG.md). **WATCH (Phase 2), PENDING:**
  (1) first plan entry fill must journal a resting SELL at exactly entry×(1+tpPct) —
  `agentic_venue_tp_total{event}` counters start moving (`placed`, then `skipped_existing` on
  managed bars); (2) first `venue_tp_filled` journal row must show a maker fee at the exact TP
  price; (3) `tp_race_hold`/`qty_cancel`/`drift_cancel` stay rare — `drift_cancel` churn on XRP
  means the tick-aware drift fix missed a case (re-check venueTpTickSize threading); (4) an
  `orphan_cancel` spike = external flattens racing the lane.
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
  `t|t`=1). **Still PENDING:** (2) `test/backtest/ab-cells/run.mjs` explicit-arm rows (explicit>0)
  as N grows; (3) daily spend < $4.50 (Pass 24: ≈$2.78/day, fine); (4) thinking distribution → ~50%
  (Pass 24: N=5 all-thinking-on, noise). Harm-stop peek at 8 trips/cell.
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

## Last pass

**Pass 24, 2026-07-14** (scheduled run, ~16:20–16:55Z) — **MAINTENANCE report-only: first
scheduled pass after Push 3 went live.** Two lanes healthy — spot boot `695b6abf` (factorial
`a6f0573`, ~15:20Z) + perp boot `51b685f1` (L0 `aca7fb1`, ~15:35Z). Sweep: 0 errors both lanes,
0 EXPIRED, kill switch RUNNING both, `up=1`; **reconciliation 179 clean / 0 mismatch under the
current spot boot** (the alarming `increase()[21h]` `sweep_failure` figure was a counter-reset
artifact across the day's boots — raw counters carry no mismatch series, no HALT). Spot
scoreboard (epoch 08:30Z 07-12): **RT=12 (was 10), net −$4.10 (was −$7.82, improved), LLM $5.45,
window 1.96d, ready=0**; equity $4,996.16, dd 0.08%. v1 attribution +$1.35/12 trips (gate net =
1.35 − 5.45 LLM; no §7 contradiction). Cost ≈$2.78/day — under the $4.50 thinking rule + $5
breaker. Prescreen 80% skip. Corpus 1,222 / **513 input_payload** (E2 ≥200 met; haiku re-test
wants ≥600). Perp: RT=0, 1 hold, equity $5,000, warmup, leverage pin passed. Harness probe green
(15). **WATCH verdicts:** P8a factorial arm-stamping RESOLVED POSITIVE (arms on exactly the 5
`called` rows; NULL on 20 quiet-skips; cells `f|t`=4/`t|t`=1; thinking N=5 all-on = noise, stays
watch); Phase-5 consult RESOLVED POSITIVE (`BatchingAgentClient`, `consult_id` present, 1-symbol
batches in the flat tape); P8d perp L0 healthy-in-warmup (algo-rail stop UNEXERCISED, PENDING);
Phase-2 venue-TP PENDING (exits predate the boot). **Reflection dormancy ROOT-CAUSED (no
defect):** today's 2 closes ran under boot `e44b6497` (pre-`c0d53bd` seed-race fix) and each hit
the first-close seed race; the fixed boot `695b6abf` has had zero closes ⇒ trigger not yet
evaluated under the fix. Both mechanisms primed for the next close: `c0d53bd` seed + abstain-lapse
(46 v2 decides / 0 entries in recent 400 ≥ 15 floor ⇒ lapse v2, mint v3). Shipped: LOG.md report +
these verdicts + backlog #53 + backups `cryptobot-20260714T165047Z.sql.gz` (+ perp). No `src/`
change (docs-only; lint:md green). Not an escalation day (07-14 shipped via owner Push 3).

**Pass 23, 2026-07-13** (report-only) and everything since — state.md deep clean (`66c3fac`),
backlog build-out (boot `e44b6497` 19:34Z), and the **Push 3 owner program** (`3c8b1a1`..
`42a4158`): `reports/loop/LOG.md` + § Push 3 program above.

**Passes 2–22 and the owner-session summaries:** `reports/loop/LOG.md` (dated entries; state.md
stopped duplicating them 2026-07-13).

## Backlog (ranked; re-rank each pass)

Conventions: IDs are stable and never renumbered (LOG.md references them). **Re-verify a backlog
item against current code before implementing it** (Pass 2 precedent — inherited items go stale).
Open items first; the closed ledger keeps one line per retired ID. After the 2026-07-13
owner-directed build-out (9 rows shipped — LOG.md entry of that date) every remaining open row is
condition- or data-gated: **#42-ENABLE** fires when the info-context A/B resolves; **#44/#45**
wait on venue-TP capture data; **#18/#46/#47/#48** wait on their stated data/sequencing gates;
**#43/#49/#52/#53** need a justification/design a pass should only pick up with new evidence.

### Open

| # | Item | Stage | Effort | Status / next check |
| --- | --- | --- | --- | --- |
| 18 | Per-hour/session expectancy gating (last residual of the W4.4 seeds — fee-tier/BNB dropped: demo fees flat 10bps, § Standing verdicts; trade-flow widening shipped Phase 3) | 2+ | M | seed — needs design + data (2026-07-13 build-out skip: 10 post-epoch trips ⇒ per-hour buckets are statistically empty) |
| 42 | ENABLE `AGENTIC_THINKING_AB_PCT` (mechanism SHIPPED `eff1d95` 2026-07-13: `+th1` tag, retry-identical threading, default 0 — byte-identical) — Phase-6 study: +12bps proxy, 4× propose, 1.9× cost | 2 | S | QUEUED behind the info-context A/B verdict — one measured channel at a time; enabling = one env flip |
| 43 | Liquidation-order flow feed — market-wide is WS-only `!forceOrder@arr` (REST forceOrders is private per-account); needs WS plumbing justification | 2+ | L | seed (Push II Phase 3) |
| 44 | Spot OCO exits (fuse executor stop + venue TP into one venue-side pair) — needs demo `orderList/oco` support proof; ccxt 4.5.58 has no unified spot OCO | 2 | M | seed (Push II Phase 2); do not touch before the venue-TP watch resolves with capture data |
| 45 | Trailing-stop plan field — wait for venue-TP capture data (Phase-2 WATCH counters) before designing | 2 | M | seed (Push II) |
| 46 | Thompson multi-candidate A/B routing (replaces the newest-candidate-only slot) | 2+ | M | seed (Push II); blocked while the v2→v3 candidate cycle is mid-flight |
| 47 | Adaptive consult cadence (vary the 15m consult rhythm by regime) | 2 | M | seed (Push II); needs the Phase-5 consult baseline first |
| 48 | Weekly vol-ranked symbol rotation (universe-study follow-on) | 2 | M | seed (Push II Phase 7); sequenced behind the 5→8 expansion; needs a rotation-vs-promotion-walk attribution design |
| 49 | Signal-sink cross-signal pair atomicity — protective fire vs concurrent TP re-place (self-healing TERMINAL_REJECT today). Exceeds the signal-sink scope exception (CANCEL_OPEN routing only) | 2 | M | seed — OWNER/reviewer-gated (Push II Phase 2); revisit with observed `tp_race_hold`/`orphan_cancel` data |
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
- #50 — runReflection outer catch: DONE (`7de8ea0`) — `run_failed` outcome + once-only rollback;
  settled outcomes never un-consumed.
- #51 — perp pin: DONE dormant (`3252c1e`) — fail-closed isolated+leverage pin on the perp boot
  path; **the Phase-8 deployment needs an INTEGER `PERP_LEVERAGE_CAP`** (fractional kills the
  boot by design); real-venue verification at that deployment's ceremony.

## Flagged for human review (open)

- **AVAILABILITY (Pass 17, 2026-07-12; updated Pass 23):** the stack runs on the owner's MacBook;
  host sleep throttles everything (worst measured: 8%/24h duty cycle; the SOL trail fired 10h
  late → gap loss). Owner acted — duty cycle has read **100%/24h for two consecutive days** —
  but the standing ask remains: keep the Mac awake on AC + auto-login (or move the stack to an
  always-on host; compose is portable, §5 backups cover the DB). Residual dependency: Docker
  Desktop "start at sign-in" (restart policy `e4542fb` only acts once the daemon is up).
- **6.9-LINK wallet scar (~$55):** historical unapplied recovered-order fill (pre-`b00c886`),
  journaled+deduped so no walk sees it post-epoch; venue-side manual sell is optional wallet
  hygiene only.
- **FYI — `ReconciliationMismatch` pages at warning** (interim since Pass 8 `a25389a`; restore
  critical when #24's class split lands).
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
- **Decide model: claude-sonnet-5 stays champion** (E2 2026-07-13: haiku-4.5 fails
  hold-agreement + propose bars — re-test at corpus ≥600 rows, cheaper-and-more-proposing is the
  one profile worth revisiting; opus-4.8 decisively rejected). **Thinking-on: NO FLIP** by
  pre-registered criteria but strongest lever surfaced → backlog #42. E2 re-run recipe (env
  hygiene — the SAFE recipe): LOG.md 2026-07-10 ~22:00Z incident-pass entry.
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
