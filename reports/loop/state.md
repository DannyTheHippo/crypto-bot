# Daily profitability loop — state

Playbook (durable procedure): `docs/planning/daily-profitability-loop.md`

## Strategic frame

The mutable strategy the playbook deliberately does not embed. Passes update stage status here;
when the owner approves a new spec, replace the pointer (and archive the old spec) — the playbook
never changes for strategy evolution.

- **Active spec:** `docs/specs/2026-07-06-profitability-design.md` (owner-approved 2026-07-06).
- **Goal:** real live profitability at **$1k–$5k capital** (owner, 2026-07-06). Objective
  function: net-of-cost PnL = `realizedPnl − fees − llmCostUsd`.
- **Active frame (owner decisions 2026-07-10, this session):** the LLM agentic lane is the
  program centerpiece — it trades AND self-learns. The daily loop (a Claude session on
  subscription, ~zero marginal cost) is the heavyweight researcher driving that self-learning:
  **"LLM proposes, backtest disposes."** Playbook v2 (`docs/planning/daily-profitability-loop.md`,
  this session) codifies the pipeline: draft candidate playbooks IN-SESSION → score offline
  (`AGENTIC_CANDIDATE_PLAYBOOK_FILE` recorded-payload live-compare eval, ≤$20/gate) → log EVERY
  scored variant (winner and losers) to the append-only experiments registry (migration 0009,
  `test/backtest/experiment-log.ts`) → inject champion-beaters via `pnpm playbook:candidate` →
  live 25% A/B (`AGENTIC_PLAYBOOK_AB_PCT`) + attributed auto-promotion decide. Loop cadence
  re-specced to **2-4 passes/day** (playbook v2). The funding-carry sub-plan is resolved NO-GO
  (see § Flagged) and is NOT part of this active frame.
- **Stage ladder + exit criteria (condensed from the active spec):**
  1. **Cost floor** — LLM spend ≤$1/day for ≥3 consecutive days AND round trips ≥2/day AND no
     `EXPIRED`/starved-exit regressions.
  2. **Learning-loop edge** — ≥2 playbook promotions with version-attributed PnL AND rolling-7d
     net-of-cost PnL ≥0. **Stage 2 status (2026-07-10, this session):** still the active stage; the
     learning loop was repaired twice this session-day on the playbook-validator denylist (`f0c5e14`
     then `8ca1997`, by the loop, Pass 13) and once more on the reflection trigger/retry path
     (`21c9b2d` — retry-with-feedback + additive trigger rollback + reset-robust alerts, backlog #31,
     shipped this session, not a loop pass). ~~Live MINT confirmation (a reflection resolving to
     `minted`/`no_change` rather than `validator_reject`/`transport_error`) is still PENDING the next
     reflection firing.~~ **MINT CONFIRMED 2026-07-11 Pass 16:** reflection fired 04:45Z on
     agentic-4 and **minted playbook v2** (INACTIVE, awaiting promotion; changelog: raised the
     entry bar after all three realized round trips closed net-negative) — outcomes
     `attempt_started=1, minted=1`, zero rejects/aborts; the Pass-12→13→14 fix chain is fully
     live-verified. A/B serving verified same day (2 decides journaled `playbook_version=2` within
     ~2.25h of the mint, AB_PCT=25 confirmed in-container). **The live Stage-2 watch is now v2's
     attributed verdict:** `AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES=10` — a PROMOTION pass
     becomes eligible once `agentic_version_round_trips{version="2"}` approaches 10; CANDIDATE
     passes stay ineligible (§3(a)) while v2 sits unresolved in A/B. **UPDATE Pass 21
     (2026-07-13): v2 provably abstains (0 entries in 17 FLAT consults since mint) — its clock
     will not start; expected resolution is the 168h candidate lapse at 2026-07-18 04:45:29Z,
     after which reflection may mint v3 (see backlog #39 for why v3 likely repeats the
     pattern and the proposed mint-time entry-rate floor).** **UPDATE 2026-07-13 (Pass 22 +
     owner session): abstention hardened to 0 entries in 49 decides since mint; #39 shipped
     (`b9dddc2`) — `AGENTIC_ABSTAIN_LAPSE_DECIDES=15` retro-applies to v2, so the NEXT
     reflection trigger lapses it immediately (no 07-18 wait) and mints v3 through the new
     entry-rate floor; watch for `minted` or `abstain_reject`.** NB the 20:26Z wipe reset the
     reflection trip counters to 0 and Pass 14
     (`3e5773f`) lowered `AGENTIC_REFLECTION_EVERY_N_TRADES` 5→2 (the counter is PER STRATEGY;
     the 5-symbol widening had silently slowed lane cadence ~5×) — reflection now fires on the
     first strategy to close 2 fresh trips.
  3. **Earned-live** — pass the coded promotion gate (`PromotionReadinessService`: ≥30 closed demo
     round trips, net-of-cost > 0, ≥14d window), then the unchanged human four-gate arming
     ceremony. Nothing automates live.
- **Settled owner decisions (not re-openable by a pass; argue in "Flagged for human review"
  instead):** ~~no shorts/futures/margin~~; ~~no third symbol until the Stage-2 exit criterion
  holds~~; no return to 1m/5m DECIDE cadence. _("No prompt caching" pruned 2026-07-07 — the cache is
  verified working and now priced honestly, W4/W13.)_
  - **REOPENED 2026-07-13 (owner, Profitability Push II plan approval): shorts on futures DEMO.**
    The struck "no shorts/futures/margin" line is superseded for the DEMO stack only — owner
    confirmed the existing `BINANCE_DEMO_*` keys are long+short futures-demo-capable and approved
    Phase 8 (perp demo venue + plan-mode shorts, `PERP_LEVERAGE_CAP=1` unchanged). Live money,
    margin above 1×, and the four live gates + arming ceremony are untouched — the live flip
    remains the sole human checkpoint.
    **Venue-path probe PASSED 2026-07-13 (read-only, scratchpad):** pinned ccxt 4.5.58
    `binanceusdm.enableDemoTrading(true)` swaps URLs to `demo-fapi.binance.com` and the existing
    demo keys authenticate — fetchBalance OK (futures demo wallet $5,000 USDT), fetchOpenOrders OK,
    fetchPositions OK. **Chosen path: real futures-demo venue** (venue-grade fills/fees/funding);
    the PaperPerpAdapter fallback and any ccxt bump are unnecessary.
  - **REOPENED 2026-07-10 (owner, this session): symbol set widens.** The struck "no third symbol"
    line above is superseded — symbols widen from BTC/ETH to **BTC, ETH, SOL, XRP, LINK at 15m**.
    Projected cost ~$2.2–2.5/day, under the unchanged `AGENTIC_DAILY_COST_STOP_USD=$5/day` breaker.
    Fallback: drop LINK on sustained >$3/day spend or on attribution starvation (too few closed
    trips per symbol to attribute PnL). "No 1m/5m DECIDE cadence" REMAINS settled, unchanged by this
    decision.
  - **UN-SETTLED 2026-07-08 (owner learning-system mandate, "improve aggressively" session):** the
    "no model below/other-than Sonnet-5" and "≤$1/day" framings are lifted. Reflection now runs on
    Opus-4.8 (1–4 calls/day); the decide model stays Sonnet-5 **until the offline replay harness can
    measure a change at $0** (a daily-loop experiment, W15, not a blind flip); the cost ceiling is
    now the `AGENTIC_DAILY_COST_STOP_USD=$5/day` breaker (expected true spend, updated 2026-07-10 for
    the 5-symbol widening above: ~$2.2–2.5/day).
- **Budgets (restated 2026-07-10):** `AGENTIC_DAILY_COST_STOP_USD=$5/day` runtime breaker
  (unchanged); **≤$20/gate** for offline candidate-playbook evals (playbook v2 §3(a),
  `AGENTIC_CANDIDATE_PLAYBOOK_FILE` live-compare, ~2 API calls/replayed row — cap row count to stay
  under budget).
- **Pre-authorizations (owner):**
  - (2026-07-07) IF net-of-cost > 0 AND round trips ≥ 30 before the 14-day window fills,
    `MIN_WINDOW_DAYS` 14→10 (`promotion-readiness.service.ts`) may be applied with owner sign-off in
    the pass report. ≥30-trips and positive-net are NOT relaxable.
  - (2026-07-08) **Sizing escalation:** `SIZER_EQUITY_FRACTION` 0.02→0.05 may be applied once the
    trailing 15-trip mean net PnL/trip ≥ $0 on BOTH `agentic-1` and `agentic-2` (the exact metric
    the expectancy ladder computes), with owner sign-off recorded. The reduction-only expectancy
    ladder (now ON) auto-brakes if expectancy reverts. Sizing stays 0.02 until the trigger fires.
    **APPLIED 2026-07-13 (owner session, Profitability Push II Phase 1):** the 15-trip trigger is
    superseded by direct owner approval of the plan (`~/.claude/plans/humming-sprouting-crab.md`,
    accepted 2026-07-13) whose Phase 1 explicitly applies 0.05. Rationale: at ~$100/entry the
    net-of-cost objective (`realizedPnl − fees − llmCostUsd`) is structurally unreachable against
    ~$1.5–2.5/day LLM spend; the expectancy ladder remains the auto-brake (negative trailing
    expectancy cuts strength to 0.4× ≈ today's $100 sizing, self-releasing on recovery), so worst
    case ≈ status quo. Re-derivation memo: § Sizing re-derivation 2026-07-13 below.
  - (2026-07-08) **Evidence epoch SET:** `PROMOTION_EVIDENCE_EPOCH=2026-07-08T09:52:35Z` (a
    flat-position instant). The gate now evaluates round trips / LLM cost / window from this instant
    — the −$18.99 all-time experimentation hole is visible in Grafana but no longer gates promotion.
    ~~Moving the epoch again is an owner decision.~~ Superseded by the 2026-07-12 delegation below;
    moved to the wipe instant 2026-07-10, then to `2026-07-12T08:30:00Z` (Pass 18 addendum).
- **OWNER DECISION 2026-07-12 (this session, verbatim: "No owner decisions; this is your domain
  and the aim of these passes is profitability. Just do what you have to."):** demo-stack
  measurement and configuration decisions previously routed as owner proposals — evidence-epoch
  declarations included, and the named pre-authorizations above once their stated trigger
  conditions are met — are **loop-domain**: a pass decides, applies, and records the decision +
  rationale in LOG.md/state.md instead of flagging and waiting. This extends the 2026-07-10
  decisions (ungated redeploy, loop drives the program); decision (3) is UNCHANGED — the four live
  gates, the bootId arming ceremony, and the live-money flip remain the sole human checkpoint, and
  the playbook §4 MUST-NOT boundaries (risk/execution/OMS semantics, live gates, append-only
  tables, secrets) are structural rails, not preferences — delegation does not relax them.
  First application: the epoch move below, same session.
- **Sizing re-derivation 2026-07-13 (owner session, Profitability Push II Phase 1 — the
  re-derivation the 0.05 pre-authorization required):** live equity $4,991 (promtool
  `equity_usdt`, peak $5,000). Per-entry worst case = 0.05 × $4,991 × strength(≤1.0) ≈ **$249.6**;
  worst-case concurrent gross at 5 symbols all-long ≈ **$1,248 ≈ 25.0% of equity**. Cap check
  (deployed values, all ≥4× headroom required):
  - `RISK_MAX_ORDER_NOTIONAL=100000` → per-order $250 → **400×**. OK.
  - `RISK_MAX_GROSS_EXPOSURE=1000000` / `RISK_MAX_NET_EXPOSURE=1000000` → $1,248 → **800×**. OK.
  - `RISK_MAX_DAILY_LOSS=5000` / `RISK_MAX_DRAWDOWN_PCT=0.2` → kill thresholds, equity-scale;
    worst full-cycle plan loss ≈ $1,248 × 5% max SL ≈ $62 ≪ both. OK.
  - `RISK_MAX_POSITION_PER_SYMBOL=1000` (base qty) → **binding cap**: XRP at $1.08 ⇒ $250 ≈ 231
    base ⇒ **4.3×** — passes, but sub-$1 XRP would drop under 4×, and a sub-$0.50 addition in the
    Phase-7 universe expansion would be VETOED at entry ($250 at $0.10 = 2,500 base > cap).
    Phase-7 selection must either avoid sub-$0.50 symbols or raise this cap with its own memo.
  - Spot affordability clamp (95% free quote): 5 × $250 = $1,248 ≪ ~$4,991 free USDT. OK.
  - Expectancy-ladder interaction: ladder ON (reduction-only, trailing 15-trip mean ≤ −$0.10 ⇒
    strength ×0.4 ≈ $100 ≈ pre-change sizing, self-releasing; 8-trip data floor applies on the
    fresh 2026-07-12 epoch window). The escalation is therefore brake-protected by construction.
  - Shipped `22af50d` (boot 8b7927c3) together with `ENTRY_ORDER_TYPE=LIMIT_MAKER` (post-only
    entries — pins the maker fee plan-mode entries were already resting for; per-intent LIMIT
    fallback when the price would cross). **WATCH (Phase 1):** first post-deploy entry must
    journal as `LIMIT_MAKER` with notional ≈ $250 (ladder-braked ≈ $100 is also PASS while
    trailing expectancy is negative); a venue-reject storm on post-only entries (would-cross
    rejections) = flip back to LIMIT and record.
- **Venue-resting take-profit SHIPPED + ENABLED 2026-07-13 (owner session, Push II Phase 2):**
  plan-mode longs now rest their TP at the venue (reduce-only LIMIT GTC at the exact TP price,
  maker-priced via the new `RISK_MAX_PASSIVE_EXIT_BAND_BPS=1200` passive lane) instead of bar-close
  detection + IOC taker crossing; executor bar-close stop stays the only stop (OCO deferred — ccxt
  4.5.58 has no unified spot OCO). Evidence for the change: bounds study
  (`reports/loop/bounds-calibration-2026-07-13.md`) measured **+23.1bps/trade** close-vs-touch at
  tp=2%/sl=0.5%/hold=64 (N=26, descriptive). Safety package shipped with it: S3 protective-stop
  busy-set no longer disabled by a resting SELL (+ SELL-scoped cancel-first fire), `cancelSide`
  scoping on CANCEL_OPEN (stale sweep now BUY-scoped), per-(strategy,symbol) serialized signal
  sink. Adversarially reviewed (two workflow rounds, 4 lenses, every serious finding
  double-verified): 8 confirmed findings ALL fixed same-session — unscoped sweep cancel, in-flight
  duplicate-TP window, qty reconciliation, tp-race IOC collision (observed + in-flight arms),
  tick-bias drift churn (tick-aware expectation via DEFAULT_FILTERS), passive-band × kill-switch
  flatten interaction (`!flattenClamp` — the shorts-hard-gate finding, closed BEFORE Phase 8),
  sink pair-atomicity comment, orphaned-SELL cancel on external flatten. Gate: 1798 unit / 41
  livegate / 14+1 paper / 15 eval, all static green. **WATCH (Phase 2):** (1) first plan entry
  fill must journal a resting SELL at exactly entry×(1+tpPct) — `agentic_venue_tp_total{event}`
  counters start moving (`placed`, then `skipped_existing` on managed bars); (2) first
  `venue_tp_filled` journal row must show a maker fee in the fee ledger at the exact TP price;
  (3) `tp_race_hold`/`qty_cancel`/`drift_cancel` should stay rare — a churn of `drift_cancel` on
  XRP means the tick-aware drift fix missed a case (re-check venueTpTickSize threading); (4) an
  `orphan_cancel` spike = external flattens are racing the lane. Backlog seed: sink cross-signal
  pair atomicity (protective fire vs concurrent TP re-place — self-healing TERMINAL_REJECT today).
- **Information channels SHIPPED + ENABLED 2026-07-13 (owner session, Push II Phase 3):** two new
  treatment-arm payload blocks — trade-flow/CVD (taker aggressor imbalance + rolling 20-bar CVD,
  raw-klines REST poll bypassing ccxt's parseOHLCV which drops taker volume; tag `tf1`) and
  positioning (market-wide futures global long/short account ratio via the raw
  `fapiDataGetGlobalLongShortAccountRatio` endpoint; tag `pos1`). Both ride the ONE existing
  info-context A/B (`AGENTIC_DERIVATIVES_AB_PCT=30`) — **the treatment bundle composition changed
  2026-07-13** (now derivatives + crossSymbol + tradeFlow + positioning; control strips all four);
  attribute the info-A/B verdict to the bundle-from-now. Liquidation-order flow deliberately NOT
  shipped (market-wide feed is WS-only `!forceOrder@arr`; ccxt REST forceOrders is private
  per-account) — backlog seed if the WS plumbing is ever justified. HTF context verified already
  present (h1/h4 EMA/RSI base blocks) — nothing added. Cached system prefix untouched
  (flag-gated sentences only; PROMPT_TEMPLATE_VERSION unchanged). Reviewer APPROVE (risk LOW;
  1 should-fix applied: sibling-bar recovery tests for both feeds). **WATCH (Phase 3):**
  treatment-arm `input_payload` rows must show `tradeFlow` + `positioning` blocks (control rows
  none of the four); the two feeds' warn-log rate stays near zero; decide latency unchanged
  (feeds are pre-polled, not on the hot path).
- **Mint-time candidate-vs-champion expectancy backtest SHIPPED + ENABLED 2026-07-13 (owner
  session, Push II Phase 4 — the learning accelerant):** every reflection draft that clears the
  entry-rate floor is now ALSO replayed head-to-head against the champion over the newest 60
  recorded rows (`AGENTIC_MINT_BACKTEST_ROWS=60`; schema default 0=off), each `long`+plan decision
  simulated with pure plan-executor semantics over the row's own sparse forward-close path
  (per-symbol grouped — #37 discipline; honest approximation: decide-cadence closes, not intra-bar
  series). Candidate trailing champion's mean net bps/trip by >10bps (`_MARGIN_BPS` — a noise
  HANDICAP: candidate ≥ champion − margin passes) with ≥3 simulated trips both arms ⇒ the existing
  bounded retry-with-feedback, then `expectancy_reject` + trigger rollback. Fail-open everywhere
  (disabled/young corpus/budget/thin sample/throw — veto-only, mint never blocked by a measurement
  failure). Champion replays cached across the retry within one run (halves retry cost; identical
  corpus keeps the comparison honest). ~$0.7–1.4/mint at 60 rows; reserves through the shared
  DailyLlmBudget (133 calls happy-path incl. floor ≈ 19% of the 700/day cap — reviewer-sized,
  fail-safe on exhaustion). Reviewer APPROVE, 4 should-fixes applied (throw fail-open wrap,
  champion-replay cache, margin-doc inversion in 5 places, budget sizing note). Verdict priors now
  arrive in HOURS at mint instead of weeks of live A/B trips — the live A/B remains the
  confirmatory stage, unchanged. **WATCH (Phase 4):** next reflection trigger logs
  `mint-backtest: candidate Xbps/trip vs champion Ybps/trip` — outcome `minted` (journaled with
  the prior) or `expectancy_reject` (rollback, next trip retries); a `mint-backtest skipped`
  warn-storm = budget sizing needs the sub-budget follow-up. Backlog seed: outer `run failed`
  catch in runReflection records no outcome and does not roll back (pre-existing, hit only by
  malformed journal data — near-unreachable with Postgres NUMERIC closes).
- **Portfolio consult ENABLED 2026-07-13 (owner session, Push II Phase 5 complete):** the lane's
  up-to-5 per-bar decide calls now coalesce into ONE `submit_portfolio` Anthropic call
  (`AGENTIC_PORTFOLIO_CONSULT=true`, window 3000ms; `pf1` promptHash tag; `consult_id` — migration
  0011 — groups a batch's journal rows; usage on the first-arrived symbol only, absent-vs-zero
  preserved). Enable-gate opus review REQUEST CHANGES → all findings resolved: post-200 schema
  failures now SOFT-HOLD the whole batch (the throw would have struck all 5 strategies toward a
  correlated lane-wide auto-DRAIN — the single-symbol path soft-holds these modes; comments
  claiming otherwise corrected), boot assertion refuses window/timeout configs whose floor-
  inclusive worst case exceeds the host backstop, refusal-path consultId pinned. Rollback = flip
  the flag (byte-identical legacy chain by construction, test-pinned). Expected effects: decide
  CALL COUNT drops toward ≤1 per bar-window (budget headroom vs the 700/day cap), native
  cross-symbol reasoning replaces the bolt-on ranking block, ~1.5–2.5× dollar savings (cache was
  already working). **WATCH (Phase 5):** (1) `consult_id` non-null on new multi-symbol-bar rows,
  shared within a bar; (2) per-day decide calls drop vs the pre-enable baseline; (3) a
  batch-holding warn-storm ('holding all') = API-overload burst — fine unless persistent; (4)
  strike/DRAIN counters must NOT correlate across all 5 strategies (that pattern = the soft-hold
  regressed). Known accepted quirks: 1-symbol batches wait the full 3s window (latency, not
  correctness); the info-context A/B arm is read once per batch at flush time.
- **Perp venue + plan-mode shorts BUILT (flag-off) 2026-07-13 (owner session, Push II Phase 8):**
  futures-DEMO venue (`VENUES` id `binanceusdm` env `demo` — authenticated ccxt binanceusdm +
  enableDemoTrading, swap-url guard fail-closed; SymbolId IS the ccxt id, no translation shim) and
  plan-mode shorts (`AGENTIC_SHORTS_ENABLED`, PLAN_SHORTS_TOOL with required `plan.direction`, tag
  `p4`; executor/venue-TP/protective/PnL arms mirrored; constructor guard: shorts require planMode
  AND a perp venue — spot+shorts throws). EVERYTHING commented-out/false in compose — the spot
  deployment is byte-identical; enabling is a SECOND deployment (own env), a separate decision.
  Two adversarial review rounds (double-verified findings, ALL fixed + test-pinned): direction-
  blind kill-switch flatten hint (a SHORT's cover now prices ABOVE mark — convergence no longer
  depends on the band clamp), shorts×portfolio-batching structurally broken (strict
  submit_portfolio cannot emit plan.direction ⇒ construction now refuses the combination loudly;
  PORTFOLIO_SHORTS_TOOL is the backlog seed), fail-open direction guard on shorts-off clients,
  outgoing-plan resting-entry orphan on clear/flip, tick-direction drift reference, x1/p4 tag
  design. Also fixed IN PASSING (pre-existing): protective-exit's blanket BUY-blocks rule would
  have frozen a SHORT's stop behind its own resting cover. Perp DEFAULT_FILTERS rows are LIVE
  fapi exchangeInfo figures fetched 2026-07-13 in-session (a round-2 reviewer flagged the comment
  as unverified off a stale brief — refuted: the fetch happened; minNotional 50/20, tick 0.10/0.01).
  Gate: 1898 unit / 41 livegate / 14+1 paper, statics green. **DEPLOY CHECKLIST (before the perp
  deployment ever arms, contested finding honored):** pin venue-side leverage=1 + isolated margin
  mode explicitly at adapter init (account defaults are NOT trusted), re-run the arm preconditions,
  and start with ONE symbol.
- **Thinking-on decide study VERDICT 2026-07-13 (owner session, Push II Phase 6; 50 rows, ~$1.3):**
  claude-sonnet-5 with ADAPTIVE thinking (effort medium; Claude 5 API rejects budgeted
  `thinking.enabled` — the harness's `AGENTIC_EVAL_THINKING_BUDGET` knob maps to
  adaptive+output_config.effort, forced tool_choice retained, no auto-tool confound): schema-valid
  100%, plan-sanity 100%, hold-agreement 89.8%, **forward proxy +12.0bps vs the recorded
  thinking-off champion's −57.5bps on the same window**, propose ratio 4× (4 vs 1 — thinking makes
  the model ACT more), cost $0.0174/decide ≈ 1.9× champion. NO FLIP by the pre-registered criteria
  (propose ratio + cost bars fail), and propose-N of 4-vs-1 is noise-dominated — but the direction
  (thinking proposes pointed right while the champion's pointed wrong, with perfect tool
  discipline) makes this the strongest single lever surfaced by the model program. **PROPOSAL
  (backlog seed, do NOT stack now):** a live thinking A/B arm (AGENTIC_THINKING_AB_PCT, adaptive
  low/medium) AFTER the info-context A/B resolves — one measured channel at a time. Side-note the
  study surfaced: the CURRENT champion's own recent proposes carry a −57.5bps forward proxy — the
  reflection loop's new expectancy backtest (Phase 4) now exists precisely to mint better than
  this.
- **E2 decide-model comparison VERDICT 2026-07-13 (owner session, Push II Phase 6; corpus 331
  rows, 50 replayed per candidate, ~$2.5 total of the ≤$20 gate):** **NO FLIP — claude-sonnet-5
  stays decide champion** under the harness's pre-registered criteria.
  `claude-haiku-4-5-20251001`: schema-valid 1.0, plan-sanity 1.0, forward proxy +2.5bps, cost
  $0.0058/decide (53% of champion — misses the ≤50% bar), but hold-agreement 75.5% (<85%) and
  propose ratio 3× (outside [0.5,1.5]; N=3 proposes — noise-dominated). Re-test haiku at corpus
  ≥600 rows: cheaper AND more-proposing with sane plans is the one profile worth revisiting.
  `claude-opus-4-8`: 0 proposes in 50 rows at 3.1× champion cost — decisively rejected for decide.
  Scorecard JSON archived in the session scratchpad; harness `test/eval/agentic/
  candidate-model-eval.spec.ts` (read-only vs prod DB via DB_SUITE_ALLOW_RESET=1, verified).

## Current stage

**Stage 2 — learning-loop edge, DEPLOYED 2026-07-08** (aggressive-improvement session; boot
47a66bba). Stage 1 (cost floor) is CLOSED: true spend ~$0.77/day well under the $5 breaker, skip
rate ~70–83%. The lane's problem was never cost — it was that the edge was absent and the
edge-creating machinery was broken. The forensics that reframed the program:

- **Learning loop was silently DEAD 4 days**: the ONE reflection candidate ever minted was killed
  by the polarity-blind banned-word validator (`playbook_validator_rejections_total{banned_token=
"true"}=1`; playbook stuck at v1 seed). `llm_usage` had 1 row.
- **Entry decisions had NO measurable edge**: `long` decides averaged ≈0 to −3bps next-bar forward
  return at EVERY confidence bucket vs a 20bps fee hurdle (calibration over 928 `agent_decisions`).
- **R:R inverted**: avg win +$0.06 vs avg loss −$0.21 (payoff 0.29:1) — the plan gate floored only
  the take-profit side, never the stop.

**Stage-2 shape = a four-stage learning funnel** whose speed is no longer bounded by live trade
throughput: reflection (Opus-4.8, rich calibration/attribution/regime diagnostics) → offline
replay scoring at $0 (harness `pnpm eval:agentic`; needs ≥200 `input_payload` rows, now accruing via
W6 — NB the harness itself was RED from the 2026-07-07 W2.4 cache work until Pass 10 fixed a stale
system-prompt assertion, `1f90ff6`; it is NOT in the gated `test` suite so no gate caught it — run
`pnpm eval:agentic` when validating a candidate) → 25% live A/B attribution → attributed
auto-promotion (candidate's own net/trip must beat champion).
Stage-2 exit criterion (unchanged): ≥2 playbook promotions with version-attributed PnL AND
rolling-7d net-of-cost ≥0.

Scoreboard at deploy (epoch just set → reads from 0): 0 RT, $0 net, window 0d, ready=0. The
pre-epoch cumulative was 32 RT / net −$18.99 (of which LLM $14.11), preserved in Grafana history
but no longer gating. Boot proof: expectancy ladder logged ACTIVE; boot recovery seeded 3 orders
(was 63 — W7 terminal_at backfill stamped 62 FILLED and 1 CANCELED, leaving only the two
CANCEL_UNKNOWN and one PARTIALLY_FILLED that reconciliation owns).

**Pass 9 (2026-07-08 ~10:23Z) soak-verification:** boot 47a66bba clean at ~29 min — 4 decides all
`hold`, 0 EXPIRED, 0 errors, reconcile healthy (47 mismatch / 0 halt / 0 error), cache working,
~$2/day decide-side projected (under the $5 breaker), kill switch RUNNING. Learning-loop outputs
(first `minted` reflection, `agentic_playbook_info{version}`>1, RT/R:R accrual) are still PENDING —
too early (reflection series not yet emitted, playbook v1). The Stage-2 exit evidence lands on the
first pass with a full day of decides behind it.

**Pass 10 (2026-07-08 ~11:31Z) — root-caused WHY the Stage-2 signal is absent, ship-nothing.** Same
continuous boot 47a66bba (RestartCount=0), now ~1h37m in. Still 4 decides all `hold` (0 new LLM
decides in 68 min — prescreen skip 71%, cost floor working), 0 fills, 0 proposes, 0 RT, portfolio
static across 390 heartbeats. **DURABLE FINDING (record so no future pass re-derives it): the entire
Stage-2 learning funnel is gated on closed round trips.** Reflection AND the attributed promotion
evaluator fire SOLELY via `onClosedTrade` (`reflection.service.ts:370`; `app.module.ts:1330–1334`);
there is **no wall-clock/cron trigger**. The DB seed (`seedTriggerState`) already primes
`tradesSinceLastAttempt`≈32 with `lastAttemptAt=0`, so the loop would fire on the **next** closed
trade regardless of `EVERY_N_TRADES=5` — meaning the ONLY thing gating all of Stage 2 is **zero new
trades** (100% hold). This is correct-by-design (reflection consumes closed-trade evidence; nothing
to chew without a trade), so continuing to soak yields no Stage-2 signal, though the soak keeps
independent stability value. A wall-clock reflection trigger was evaluated and rejected on the merits
(re-chews the same 32 trips → `NO_CHANGE` hash guard / hallucination; doesn't fix the no-trade
blocker). Consequence for the exit criterion: at the current trade rate, ≥2 attributed promotions is
unreachable in a reasonable window — see the §Flagged cost-floor-vs-throughput recommendation.

**Pass 10 addendum (owner-directed, ~14:00Z): 0-trade VERIFIED CORRECT.** Owner asked to skip
redeploy only if the no-trade state is correct. It is, on four lines of evidence: (1) propose plumbing
is functional — the offline eval (`pnpm eval:agentic`, once un-bricked, see below) drives a scripted
`long`→`flat` round trip through the real prompt/client/executor pipeline (`roundTrips===1`); (2)
holds are model-driven (0 proposes + 0 rejections, no gate suppression); (3) the v1 seed playbook
explicitly prescribes holding in choppy/low-edge regimes and only entering when the move clears ~20bps
fees; (4) documented edge ≈0 to −3bps vs the 20bps hurdle ⇒ holding is profit-maximizing. So the stall
is a strategy/regime question, not a bug — no redeploy. **Also fixed a real issue found en route:**
`pnpm eval:agentic` was RED since the 2026-07-07 cache work (stale system-prompt assertion; `1f90ff6`,
test-only) — the $0 replay harness Stage-2 leans on was broken and no gate caught it (not in the gated
`test` suite). Now 15 passed. Full gates green (build/lint/typecheck/1463 unit/eval). App soak
untouched (fix is test-only). Scope: "correct" answers **Q1 (is 0-trade a defect? no)** — it does NOT
close **Q2 (is the model too passive?)**, which stays n=4-unresolvable under #29; the redeploy
condition keys on Q1. Owner SQL to confirm the 4 holds' `rationale` + indicator snapshot is in LOG.md.
**Empty-pass counter RESET to 0** — the addendum shipped `1f90ff6`, a real improvement, so the
two-empty streak is broken; the cost-floor-vs-throughput recommendation now stands on its own merits,
not on the two-empty rule.

**Pass 11 (2026-07-08 ~16:07Z) — #29 answered at n=11, blocker is confirmed owner-strategic.** Same
boot `47a66bba`, ~6h13m in. Decides grew 4→**11, still 100% hold**; crucially all 11 prescreen
`called` bars were the higher-signal classes (`breakout_proximity` 7 + `vol_expansion` 4) and the
model held on every one, with **0 proposes + 0 rejections**. That resolves the #29 structural
question: holds are model-driven (gate not implicated). Loosening the prescreen (option b) surfaces
MORE ≈0-to-−3bps bars against the 20bps fee hurdle — even if some traded they are −EV and cannot move
net-of-cost to ≥0, so (b) cannot reach the Stage-2 exit (**strongly indicated**; the owner-SQL on the
hold rationales is the last confirmer, flagged not run). The Stage-2 blocker is **edge/cold-start in a
genuinely low-edge market**, which no autonomous pass can fix within settled constraints — the
throughput-vs-cost-floor decision is squarely the owner's (see §Flagged). Shipped a docs-only guard
(`pnpm eval:agentic` now an every-pass §2.6 harness-health probe + §6.4 lint:md gate) and flagged the
CI step (#30); no redeploy.

**Pass 12 (2026-07-09 ~16:31Z) — lane BROKE OUT of 100% hold; reflection-abort bug found + fixed,
redeployed.** A whole-stack recreate at 17:47Z 07-08 (owner/host event, same `bac974c` image — no
app-code commit since `e67e956`) put boot `f75b6dfc` up ~22.7h, the first full-day window. It flipped
the picture Passes 9–11 held: the model now **proposes** (`agent_decide_total`: proposed=6, hold=30,
error=1 ⇒ 81% hold, not 100%), `signals_rejected_total` still empty ⇒ #29 trigger (a) "too passive"
is retired by evidence, (b) gate never implicated. The lane closed **4 round trips (1W/3L)**, gate
net-of-cost **−$2.02** since epoch (realized −$2.32 both symbols; equity −$0.58, dd 0.077%, fully
trade-explained — no unexplained drawdown). Cost ~$1.47/day (under the $5 breaker); prescreen skip
65.7% (in the 50–70% band). **Root finding:** reflection triggered for the first time and **aborted** —
`agentic_reflection_outcomes_total{attempt_started=1, transport_error=1}`, log `reflection: transport
error: This operation was aborted` (02:14Z). Cause: reflection runs Opus-4.8 + adaptive thinking over
a large prompt but read the 30s **decide** timeout (`AGENTIC_TIMEOUT_MS`); it can't answer in 30s, so
every attempt aborts, consumes the trigger (6h cooldown + 5 trips) + a budget call, and the playbook
stays at the net-negative `v1` seed (v1: 36 all-time RT, −$6.07). The whole Stage-2 learning funnel
was structurally unable to complete — NOT throughput-starved (throughput is now flowing). **Fixed
`ef325f6`:** separate `AGENTIC_REFLECTION_TIMEOUT_MS` (default 240s), never falls back to the 30s
decide timeout; decide path keeps 30s. Redeployed to boot `3d6bc0d7`, clean. **Verification boundary:
the fix's live confirmation (an attempt resolving to `minted`/`no_change`/`validator_reject` instead
of `transport_error`) is PENDING — reflection fires ~1/5h and a 15–30 min soak can't observe it; first
confirmation lands on a future pass.** Reconciler healthy (2699 mismatch passes, 0 halt/0 error).

**Pass 13 (2026-07-10 ~17:00Z) — Pass-12 fix CONFIRMED working; next-stage blocker found + fixed,
redeployed.** The owner edge-program session landed A–E + B3 + feeds (all flag-gated OFF) and deployed
boot `ddfd3ce3` at 12:45Z (not a loop pass). Prometheus retained the prior boot's series, so the
discriminator is answerable: `agentic_reflection_outcomes_total{attempt_started=2, validator_reject=2}`
at 12:30Z ⇒ **reflection now COMPLETES (Pass-12 timeout fix works — no `transport_error`) but every
completed candidate is killed by the banned-word validator** (`banned_token="true"`=2), pinning the
playbook at the net-negative v1 seed (43 RT, −$5.35). Root cause: `validatePlaybook`'s substring
denylist false-positives on benign trading prose; W2's prompt-only remedy is empirically falsified (the
prompt warns the sequences, Opus emits them anyway). **Fixed `f0c5e14`:** concept-precise
word-boundary/phrase denylist (benign prose passes; every injection/exfil/non-spot concept still
hard-blocks; uniform shared read+write matcher) + a bounded `token` metric label + `bannedToken` result
so the exact concept is observable on the next rejection. Reviewer (opus) APPROVE after one fix round.
Redeployed to boot `17:03:47Z`, clean. **Stage-2 status unchanged pending the first live post-fix
reflection: does a reflection now `minted`/`no_change` (playbook advances past v1)?** — the last
untested link in the learning funnel. The funnel now completes reflection AND no longer discards benign
candidates; whether the minted candidates then earn A/B-attributed promotion is the remaining Stage-2
exit question.

## Last pass

**Pass 22, 2026-07-13** (scheduled run, ~08:08–09:15Z) — **SHIP the winsorized deflation
variance port (`1042930`, ultracode re-dispatch item 3): `trial-registry.ts`'s raw `variance()`
fed V to `expectedMaxSharpe`, letting thin-sample outlier cells set the DSR benchmark (the
07-10 carry study's SR0\*=140.41 from 10/178 cells with |SR|>10) — `winsorizedVariance`
(clip |SR|≤3) now backs both production call sites (carry study, edge-diagnostic scan) + 4
pinning tests; the 07-10 NO-GO verdict is unaffected; the ~07-24 carry re-test runs honest
and should write a NEW dated report (the validation rerun's rewrite of
`carry-study-2026-07-10.md` was deliberately restored — dated artifacts keep their era's
method).** Evidence sweep clean on boot `24cdd185` (7.75h): 0 errors/EXPIRED/HALT, reconcile
clean, kill switch RUNNING, duty cycle **100%/24h**, prescreen skip 66.7% (in band), corpus
306; scoreboard RT=9 (ALL v1, all losses), net −$5.92, LLM $2.67, window 0.493d — window
semantics verified correct against `promotion-readiness.service.ts` (closes-to-closes), NOT a
bug; cost $2.3/day pro-rated ⇒ **Pass 21's cost watch RESOLVED** (LINK-drop pre-auth does not
fire). Reflection: no attempt this boot (trips 8/9 were first-close-after-boot seed-race
primes; agentic-2 sat 3/2). **Mid-pass, an owner session committed + deployed the work found
uncommitted in the tree at pass start** (#39 entry-rate floor + abstain lapse `b9dddc2`,
arm-hardening `e75db49`, boot `19f677b3` clean) — this pass had pre-verified gates green over
that dirty tree, touched none of its files, and ruled out deploys until it landed; zero
overlap. Pass type MAINTENANCE (CANDIDATE blocked, PROMOTION ineligible: v2 0 trips, v1 9<10).
Gates full green (backtest 28, 1765 unit, eval 15). No deploy (test-only). Backup
`cryptobot-20260713T085958Z.sql.gz`. Empty-pass counter 0. Full detail in LOG.md.

**Pass 21, 2026-07-13** (scheduled run, ~00:08–00:50Z) — **SHIP the AB_PCT correction
(`d538ce1`, 50→25) + gate repair (`230196a`): v2 provably cannot convert serving share into
evidence — since its mint it entered on 0 of 17 FLAT-state consults (v1: 16/57, 28%;
P≈0.4% under v1's rate), so the 50% share bought zero candidate evidence while halving the
champion entry stream that feeds the symmetric promotion floor, trade-gated reflection, and
the info-context A/B.** v2's verdict can now come ONLY via the 168h lapse (2026-07-18
04:45:29Z); lapse deliberately kept — a v3 minted from 7/7-loss evidence would rationally
abstain too. **New structural flag (design work): the learning loop measures candidates
only through trips, but honest all-loss evidence mints abstainers that starve their own
measurement; promoting an abstainer would freeze trade-gated reflection — cheapest fix is
an offline entry-rate floor at mint time (§3(a) machinery exists), queued as backlog #39.**
Also repaired lint+format found RED at HEAD (fetch-fng.mjs eslint crash; two unformatted
sweep files — non-price-sweep session leftovers). Evidence sweep otherwise clean on boot
`defffcb1`: 0 errors, reconcile 345/1/0, kill switch RUNNING; scoreboard RT=7 (ALL v1, all
LOSSES), net −$4.27, LLM $1.85 (~$2.8/day; this-boot pro-rate $3.9/day — cost watch armed,
LINK-drop pre-auth keys on SUSTAINED >$3), equity $4,992.24 (dd 0.155%, trade-explained).
Reflection empty-counter explained by design (first-close-after-boot primes but cannot fire:
the trigger check runs synchronously before the async DB seed lands); agentic-1/-2/-5 primed
2/2 — next close fires the attempt, EXPECT `skipped_unresolved_candidate`. **Corpus 252 —
≥200 crossed; E2 already ran (ultracode session, Haiku ≠ flip): E2 watch RETIRED.** Duty
cycle 70.4%/24h (owner acted on the availability flag). Gates full green (1742 unit, eval
15), deployed boot `24cdd185` 00:23Z env-only, recovery clean, AB_PCT=25 verified
in-container. Backup `cryptobot-20260713T002423Z.sql.gz`. Empty-pass counter 0. Full detail
in LOG.md.

**Pass 20, 2026-07-12** (scheduled run, ~14:04–15:10Z) — **SHIP the plan-mode restart fix
(`6e95542`): the in-memory `activePlan` dies on every container recreate and the documented
"model issues a fresh plan" self-heal NEVER EXISTED — no signal to the model (the prompt
promises it won't be re-asked while a plan is active), 'long' means "open a NEW long", and
the client dropped any plan outside long-from-FLAT. Live proof on boot `bcb9f691`: 3 of 5
longs (BTC/ETH/LINK, opened before the Pass-19-addendum 12:14Z recreate) were bare — 24/24
position_open consults returned plain hold, positions ran without model-set TP/maxHoldBars
(~$0.011/bar/symbol burn; a 5-position recreate projects past the $5/day breaker).** Fix:
`AgentPositionSummary.managedPlan` (plan-mode+LONG only) rendered into the payload; prompt +
tool-description re-arm instructions; client accepts hold/long+plan while LONG through the
same fee/RR floors, NO signal emitted; `PLAN_TEMPLATE_VERSION` p1→p2 (honest promptHash flip;
A/B unaffected — both arms share the prompt). +10 tests (1691 unit), reviewer (opus) APPROVE
no-must-fix, eval 15, deployed boot `c0afee82` 14:42:46Z. **Re-arm CONFIRMED LIVE the first
bar (14:45Z), 2/2:** the deploy itself bared XRP/SOL; both payloads carried
`"managedPlan":false` and both models returned hold+plan with explicit narration
("Re-attaching a managed plan since managedPlan is false…"); at 15:00Z all four positions
ran `plan-executor` deterministic holds ($0 bars — executor takeover verified), and the gate's
first sample read **RT=3 / v1=3** (today's closes counted correctly on the unfrozen layer —
`cc72a10` verified on live data). Mid-pass live events: at 14:15Z
(old boot) the model itself flattened the 3 bare longs — **first 3 post-epoch round trips**
on the unfrozen layer, all v1; reflection counters now 1/2 on agentic-1/-2/-5 (**next close
on any of them fires the first post-epoch reflection**); BTC/ETH re-entered fresh at 14:45Z
(plan-priced ACKED entries). v2 still ZERO entries (7 post-epoch decides, all hold) — verdict
clock unstarted. Corpus 172/200 (E2 likely eligible ~next pass). Backup
`cryptobot-20260712T144330Z.sql.gz`. Empty-pass counter 0. Full detail in LOG.md.

**Pass 19, 2026-07-12** (owner-triggered, ~11:35–12:20Z) — **SHIP symbol-aware offline scoring
(`5da2630`): the recorded-payload scoring harness grouped rows by (version, promptHash) with NO
symbol, so the 5-symbol corpus interleaved instruments and every scorecard in the multi-symbol
era was cross-symbol noise (BTC→LINK close transitions scored as −99.99% "returns"); then v2
finally scored honestly — n=34, v2 ≥ v1 on every measure, stays in A/B.** Fix: `symbol` joins
`ScoringRow`+groupKey (one card per instrument), new `combineScorecards()` portfolio aggregate,
env-tunable eval timeout (`AGENTIC_EVAL_TIMEOUT_MS`), +3 unit tests incl. the interleave defect
pin; also removed a NUL byte embedded in the source (it made grep read the file as binary —
the chronic flaky-grep explanation). Reflection digests were never affected (P7 strategy-scoped
rows); auto-promotion uses the fills-walk, unaffected. Gates full green (1681 unit, eval 15),
deployed boot `950963f0` ~11:56Z, 12:00Z-bar soak clean. **v2 offline verdict (registry id 128,
sonnet-5, all 5 symbols, ~$0.85 out-of-band):** h1 hit 0.483 vs 0.448, h4 0.643 vs 0.500, toy
equity 1.000 vs 0.9905 — v2's raised entry bar skipped v1's losing trade, exactly its mint
rationale; toy-grade/n-small ⇒ **patience justified, no pin, no manual promote; the live A/B
verdict remains the decider** (id 127 = the n=2 pre-fix run, logged INVALID for honest-N).
Live lane meanwhile: first post-epoch entries are on — LINK 4.98 (10:02Z, 3 partials folded
FILLED = first live validation of `b00c886`'s D1 fix) and ETH 0.0221 (11:47Z); v2 still has
ZERO entries in A/B (8 hold/2 flat of 10 decides) so its 10-trip clock hasn't started. Corpus
135/200. New #37: E2's forward-proxy shares the cross-symbol flaw — **CLOSED same pass**
(addendum, owner-directed "fix the flaws": `2f546f3` per-symbol digest + weighted recombine +
single-instrument contract on all three positional digests; E2 safe to run at 200 rows).
Backup `cryptobot-20260712T115914Z.sql.gz`. Empty-pass counter 0. Full detail in LOG.md.

**Pass 18, 2026-07-12** (scheduled run, ~08:08–09:35Z, paused 08:10–09:05Z while the
owner-directed OMS session below ran) — **SHIP evidence-epoch threading (`cc72a10`): the
promotion-walk straddle "phase shift" is NOT count-preserving — under entry-size drift it
freezes a symbol group permanently, and only the GATE was epoch-bounded, so the owner's
proposed epoch move would have left v2's A/B attribution, the auto-promotion evaluator, and
reflection evidence/trigger seeds frozen.** Findings: ETH's walk froze 00:15Z 07-11 (leading
exit-only SELL 0.0249 + drifting entry sizes ⇒ signedQty never re-enters dust; 2 real ETH
trips absorbed, incl. today's 07:45:08Z close) — with XRP (phase-shifted) and LINK (#35 scar)
that is up to 3 of 5 symbols not accruing walk evidence; explained + conservative ⇒ NOT the §7
stop. Checked: the frozen ETH trip was v1-attributed (v2 lost nothing yet); v2's 10 A/B
decides are 8 hold / 2 flat, ZERO entries ⇒ its 10-trip verdict clock hasn't started
(by-design stricter entries). Shipped: all three epoch-blind consumers now share the gate's
`PROMOTION_EVIDENCE_EPOCH` (`fillsForMode(mode, epochMs)`), +5 regression tests incl. the
live ETH-freeze scenario; behavior unchanged until the epoch moves (DB row-zero = wipe).
Gates full green (1678 unit, eval 15), deployed boot `d5942b9b` 09:23:36Z, soak clean.
**ADDENDUM (~09:35–10:00Z): the epoch move was APPLIED same pass** — the owner delegated the
decision class this session ("no owner decisions; this is your domain", § Strategic frame):
`PROMOTION_EVIDENCE_EPOCH=2026-07-12T08:30:00Z` (a verified flat instant — lane flat since
07:45:08Z, 0 open orders) live on boot `9ff1eb40`, compose-only change. Reset verified on the
first sample: gate RT/net/LLM/window all 0, ready=0, `agentic_version_round_trips` EMPTY
(phantoms gone), kill switch RUNNING — **gate + A/B attribution + auto-promotion + reflection
evidence all count from one clean window; the Stage-2 measurement layer is fully unfrozen for
the first time since the 07-10 wipe.** Recorded costs: 7 gate RTs / −$4.34 / 1.4d window
forfeited; reflection priming reset by the recreate (agentic-1 was 2/2 — deliberately traded
away: it would have chewed frozen phantom-cycle evidence; re-arms on 2 fresh post-epoch trips
per strategy). **Standing watches now: reflection fires on the first strategy to close 2
post-epoch trips; v2's 10-trip A/B verdict clock starts at v2's first filled entry; E2 corpus
119/200.** Backup `cryptobot-20260712T092530Z.sql.gz`. Empty-pass counter 0. Ops gotcha
recorded in LOG.md: post-reboot `docker logs --since` is broken across the rotated segment
(negative grep evidence void; use `--tail N` under the segment size). Full detail in LOG.md.

**Owner-directed pass, 2026-07-12 (~08:05–09:05Z, same session as Pass 17)** — **"fix second
flag" executed: #35 root-caused to three composing recovery defects and FIXED (`b00c886`),
reviewer (opus) APPROVE no-must-fix, full gates green (1673 unit / 41 livegate / 11 paper / 15
eval), deployed boot `fc6ceedb` 08:44Z — the stranded RECONCILE_REQUIRED LINK order healed on
the FIRST boot** (journal-verified: cum 1.67→5.65, FILLED, terminal_at stamped, `boot:cum-rebuild`
event appended; **unresolved testnet orders now 0** — live-arming blocker class cleared).
Defects: (D1) poller folded same-poll partials from a stale snapshot; (D2) nothing ever rebuilt
cum from the fill journal (mis-fold unrecoverable → TTL sweep + resolver froze a venue-FILLED
order); (D3) boot recovery dropped the persisted intent, so recovered-order fills skipped
portfolio application — the 6.9-LINK phantom is OUR unapplied fill (foreign-traffic hypothesis
retracted), ~$55 still unmanaged in the wallet. D3's fix also closes #26's E1-clamp gap.
**Owner residual: the historical scar — epoch-move proposal in § Flagged.** Host-availability
flag explicitly deferred by owner ("ignore for now"). Full detail in LOG.md.

**Pass 17, 2026-07-12** (scheduled run, ~07:16–08:00Z — the missed 00:00Z slot firing on login
catch-up) — **~10h host-dark outage (21:25→07:16Z) auto-recovered by Pass 15's restart policy
(first live save); shipped the honest-cost + duty-cycle dashboard (#19 closed); found and
flagged the promotion-walk LINK freeze (#35).** Root cause of the outage established from host
evidence: the MacBook slept through the evening (pmset log), rebooted 21:27Z, sat at the login
screen ~10h — **lane duty cycle 8.0%/24h, 52.5%/48h**; the 07-11 16:00Z and 07-12 00:00Z
scheduled passes never ran. Recovery clean on boot `21bef45a`: portfolio exact, reconcile 0
halt/0 error, kill switch RUNNING, 0 EXPIRED; the SOL trailing stop fired on the FIRST tick
(−1.9% gap-through — outages convert trails to gap losses), and at 07:30Z the model flattened
BTC/XRP/LINK (all filled), holding only ETH. Scoreboard: RT=7 (+2 of the 4 closes — see #35
for why XRP/LINK didn't count), net −$4.27, LLM $1.56 (window 1.41d), ready=0; v2 A/B serving
~26% (9/34 decides) with **0 of 10 attributed trips**; corpus 114 payload rows (E2 ~3+ days
out at duty-cycle-diluted rate). Pass type MAINTENANCE (PROMOTION ineligible, CANDIDATE
blocked): shipped the dashboard change (cache-aware cost ×3 panels, per-model token split,
duty-cycle stat; grafana hot-reload API-verified, no app redeploy), gates full green (1666
unit, eval 15), backup `cryptobot-20260712T072738Z.sql.gz`. **Watches: agentic-1 primed 2/2 —
its next closed trip fires reflection; if that mints v3 while v2 is unresolved, check whether
the newest-candidate slot shadows v2's A/B evidence.** Empty-pass counter 0. Full detail in
LOG.md.

**Pass 16, 2026-07-11** (scheduled run, ~08:08–08:50Z) — **FIRST LIVE MINT: reflection minted
playbook v2 at 04:45Z** (agentic-4, `attempt_started=1, minted=1`, zero rejects/aborts — the
Pass-12/13/14 fix chain fully live-verified; first-mint watch RESOLVED POSITIVE). A/B serving
verified in the journal (2 decides on v2 vs 11 on v1 since mint; AB_PCT=25 in-container);
v2's attributed verdict needs 10 trips (`AGENTIC_AUTO_PROMOTE_MIN_ATTRIBUTED_TRADES`) — the
new standing watch is `agentic_version_round_trips{version="2"}` → PROMOTION pass near 10.
**CANDIDATE work (a/b scoring) is BLOCKED by §3(a) while v2 sits unresolved in A/B.**
Pass type MAINTENANCE, shipped two commits, both deployed: **`b1b9455`** (#28 CLOSED —
`model` label on token/decide counters, decide + reflection paths, shipped the same day the
first Opus reflection fired) and **`5ff5594`** (boot playbook-info stamp read the A/B-routed
current() — the first post-mint boot stamped `agentic_playbook_info{version="2"}` while
active is v1, corrupting §2.3's promotion signal; new unrouted `active()` read, live-verified
on boot `4a1e7fc3` which landed in a routed bucket and still stamped v1). Scoreboard: RT=5,
net −$2.66, LLM $1.13 (~$2.3/day, inside projection), ready=0; 33 hold / 11 proposed, 0
rejections, equity $4,996.15 (dd 0.077%, trade-explained); reconcile 0 halt / 0 error; corpus
90 payload rows (E2 ~a day out). Gates full green ×2 (1666 unit, eval 15), backup
`cryptobot-20260711T082114Z.sql.gz`. Empty-pass counter 0. Full detail in LOG.md.

**Pass 15, 2026-07-11** (scheduled run, ~00:05–00:40Z) — **SHIP the outage-class fix after a
host reboot took the whole stack down.** The host Mac rebooted ~23:28Z; all four containers
had `RestartPolicy=no`, so the stack stayed dark **43 min** (23:28:02Z→00:11:07Z) with two
real longs (BTC ~$40, ETH ~$45) unmanaged — protective exits run in-process. This pass found
it, **shipped `e4542fb`** (`restart: unless-stopped` on all four services, compose-only,
§3 priority-1 availability defect), and recovered the stack: boot `fab516c9` 00:11:07Z clean
(recovery 1 order seeded / 0 degraded, portfolio exact, reconciliation clean, kill switch
RUNNING, 0 errors/EXPIRED), lane trading again 3 min later (LINK maker fill 00:14Z).
Prometheus TSDB survived; scoreboard DB-consistent: **RT=1 first fully post-epoch trip**
(Pass-14's XRP long closed 23:15Z, ≈−$0.13 net — straddle bound fading as documented),
net-of-cost −$1.11, LLM $0.461/3.9h ≈ $2.9/day pro-rated (watch: LINK-drop fallback is
SUSTAINED >$3/day). Reflection still not fired (llm_usage 0 rows) — first-mint watch open;
N=2 makes it imminent. **Corpus 29 payload rows → candidate scoring
(`candidates/2026-07-10/{a,b}`) ELIGIBLE next pass** (kept out of this pass by the
one-pass-type rule). Gates full green (1659 unit, eval 15), backup
`cryptobot-20260711T001840Z.sql.gz` taken. FYI-only: restart policy depends on Docker
Desktop starting at login (owner-side setting). Empty-pass counter 0. Full detail in LOG.md.

**Pass 14, 2026-07-10** (scheduled run, ~21:22–21:55Z) — **SHIP a learning-cadence compensation;
first scheduled pass after the wipe + incident-follow-up redeploys.** Evidence clean on boot
`e3e19aa0` (28 min at pass start): 0 errors, reconcile 68/68 clean, kill switch RUNNING, 0
EXPIRED, eval:agentic green, equity $4,996.5 (dd 0.069%, trade-explained). Model flattened the
wipe-surviving ETH/XRP longs (2 RT losses in-memory) then opened a fresh XRP long at 21:33Z —
the first position whose ENTRY fill is post-epoch/DB-visible (its close is the first trip that
can score on the gate). **Durable finding: scoreboard RT=0 vs in-memory 2 RT is the documented
promotion-walk STRADDLE BOUND** (both trips opened pre-epoch; exit-only cycles can't form —
conservative, self-fading, NOT the §7 trust-breach condition; no epoch move recommended — a new
XRP long is open, moving it would mint a new straddle). **Shipped `3e5773f` (MAINTENANCE,
config-only):** `AGENTIC_REFLECTION_EVERY_N_TRADES` 5→2 — the trigger counts trips PER STRATEGY
(P7 single-instrument digests), so the 5-symbol widening had silently slowed lane-level
reflection cadence ~5×; N=2 restores the owner's calibrated trips-to-trigger; 6h cooldown +
$5/day breaker unchanged. Gates full green (1659 unit), redeployed boot `c0e2ef7a` 21:34:57Z,
env verified in-container, soak clean. Backup `cryptobot-20260710T213524Z.sql.gz` taken (§5
standing duty). Corpus at pass end: 7 payload rows — candidate scoring (`candidates/2026-07-10/
{a,b}`, needs ≥10–20) likely eligible NEXT pass; E2 at ≥200 still days out. Next-pass
candidates: score a/b; **#28 model label BEFORE the first Opus reflection fires** (N=2 makes it
near); E2; #32. Empty-pass counter 0. Full detail in LOG.md.

**Owner session, 2026-07-10 (~17:30–21:50Z) — self-learning platform shipped; 12 commits
(`3c1adc7`..HEAD), every increment gates-green, deployed, soaked.** Shipped: reflection
retry-with-feedback + additive trigger rollback + reset-robust alerts (`21c9b2d`, backlog #31,
reviewer must-fix applied and live-verified); append-only `experiments` registry (migration
0009, honest cumulative-N ledger); loop candidate-injection path (`pnpm playbook:candidate`,
A/B routes `loop-candidate` rows); `pnpm eval:candidates` offline decide-model comparison;
carry study NO-GO 0/126 (`979de5e` — perp wiring + carry lane skipped per gate; `-2022`
classifier regression pin shipped); derivatives feed ENABLED (promptHash `+d1` epoch
2026-07-10T18:42Z, hash flip verified in `agent_decisions`); universe widened to 5 symbols
(BTC/ETH/SOL/XRP/LINK @15m, `agentic-1..5` all ACTIVE, calls cap 500→700); template backend
conventions + committed `openapi.json` freshness gate; docs truth pass + loop playbook v2
(2–4 passes/day pass-typed operation). Final sweep at HEAD: build/lint/lint:md/typecheck/
format green, 1659 unit, 41 livegate, 11 paper, 15 eval, 17+1 backtest, 50 db; tree clean.
**Scoreboard at close:** 11 RT since epoch, net-of-cost −$2.51 (LLM $1.95), playbook v1,
equity $4,996.79, kill switch RUNNING, reconciler clean; first post-fix reflection outcome
still PENDING (trade-gated). **Incident (honesty):** ~7 min app downtime 19:05–19:12Z — the
5-symbol deploy ran `up -d` without `build`, so the old image lacked the new DEFAULT_FILTERS
rows and the boot-loud guard exited 1; fixed by rebuild; lesson recorded in the playbook's
deploy step (always `build` when src/ changed). **Commit-history note:** the reports/archive
deletions + `nighly` rename landed in `3c1adc7` (pre-staged index swept into the first
commit) though `ea10621`'s message describes them — content correct, attribution off by one
commit. **E2 handoff — SUPERSEDED by the 2026-07-10 ~22:00Z incident pass (see the LOG entry below
this one): the 196-row corpus was LOST in the DB wipe; rows re-accrue (~hours-to-days at the
5-symbol rate). Once ≥200 again, run E2 with the SAFE recipe ONLY:** export ONLY the needed
vars (never `set -a; . .env` — TRADING_MODE leaks break unrelated suites), single spec FILE
path FIRST and flags AFTER the path (a flag before the path made pnpm/vitest run the ENTIRE
suite — the incident's root cause), `DB_SUITE_ALLOW_RESET=1` with the production URL is
legitimate ONLY for the read-only eval specs (`pnpm eval:candidates` invokes exactly one file
— safe); NEVER run `test:db` or an unscoped vitest with that env (the destructive suite now
hard-refuses non-`_test` databases regardless, commit pending this pass). Flip `AGENTIC_MODEL`
in docker-compose.yml only on ALL-pass parity; reflection stays Opus.

**Pass 13, 2026-07-10** (scheduled run, ~16:30–17:20Z) — **SHIP a correctness fix on the
LEARNING-critical path; the direct successor to Pass 12.** First loop pass since Pass 12; between
passes the owner edge-program session (plan `open-replicated-platypus`: workstreams A–E + B3 shorts +
free feeds, all flag-gated OFF) landed on `main` and owner-deployed at 12:45Z (boot `ddfd3ce3`).
**Discriminator answered (advisor-directed):** Prometheus (up 47h) retained the prior boot's series, so
the 10:45Z reflection attempt is readable — `agentic_reflection_outcomes_total{attempt_started=2,
validator_reject=2}`. So Pass 12's timeout fix WORKS (reflection completes, no `transport_error`) but
every completed candidate is now killed by the banned-word validator (`banned_token="true"`=2) — the
same class that first killed the loop. Root cause: `validatePlaybook`'s substring denylist
false-positives on benign trading prose ("marginal"→`margin`, "leverage the trend"→`leverage`, "act as
support"→`act as`); W2's "fix it in the prompt" premise is empirically falsified (the prompt warned the
sequences; Opus emitted them anyway). Exact token unrecoverable (`llm_usage` stores only token counts),
but the fix is safety-preserving regardless of which token hit. **Shipped `f0c5e14`** (7 files,
+212/−67): concept-precise word-boundary/phrase denylist (benign passes; injection/exfil/non-spot still
hard-blocks; uniform read+write) + a bounded `token` metric label so the exact concept is observable on
the next rejection + prompt warned-list reconciled. Reviewer (opus) APPROVE after one fix round (2
must-fix coverage regressions I introduced — `withdraw` multi-qualifier, `leverage` directive forms —
fixed + pinned by regression tests). Gates: build/lint/typecheck, 1638 unit (+18), eval:agentic 15.
Redeployed to boot `17:03:47Z`, clean; ~16-min soak clean (0 error/EXPIRED, decides flowing).
**Verification boundary:** the validator no longer false-positives on benign prose (TESTED); the live
MINT confirmation is PENDING (reflection trade-gated, ~1/5h — a soak cannot observe it). Deferred the
owner-mandated funding-carry backtest to a future pass — the learning-loop bug outranked it (§3.1).
Empty-pass counter 0. Full detail in LOG.md.

**Pass 12, 2026-07-09** (scheduled run, ~16:00–16:50Z) — **SHIP a correctness fix on the
learning-critical path; agentic-lane, gates-green, redeployed.** The lane finally traded (4 RT, 1W/3L,
gate net-of-cost **−$2.02** since epoch) and reflection finally triggered — and **died on a 30s timeout
abort** (`transport error: This operation was aborted`). Root cause: reflection runs Opus-4.8 +
adaptive thinking but read the 30s decide timeout `AGENTIC_TIMEOUT_MS`; it can't answer in 30s, so
every attempt aborts and consumes the trigger, leaving the playbook stuck at the net-negative `v1`
seed. This is a **playbook §3 priority-1 correctness bug** on the ONLY machinery that can move
net-of-cost toward ≥0 within settled constraints — it outranks all backlog items. **Shipped `ef325f6`
(9 files, +116/−4):** separate `AGENTIC_REFLECTION_TIMEOUT_MS` (default 240s, never falls back to the
decide timeout); decide path keeps its 30s fail-fast; +2 regression tests encoding the bug. Gates
green (build/lint/typecheck, 1465 unit+livegate, eval:agentic 15). Redeployed to boot `3d6bc0d7`
(clean; playbook v1 seed, expectancy ladder ACTIVE). **Verification boundary (advisor): the soak
CANNOT confirm reflection now completes** — it fires ~1/5h; the fix removed the 30s-abort blocker,
first live `minted`/`no_change` confirmation is PENDING on a future pass. Evidence otherwise clean: 0
HALT/EXPIRED/kill-switch, reconciler healthy (0 halt/0 error), kill switch RUNNING. #29 trigger (a)
retired by evidence (model now proposes: 6/37). Empty-pass counter stays 0. New backlog #31 (transient-
error trigger rollback), #32 (stream the reflection call — durable fix behind the timeout bump). Full
detail in LOG.md.

**Pass 11, 2026-07-08** (scheduled run, ~16:07Z) — **SHIP one in-bounds process improvement; #29
resolved to a conclusion.** Same continuous boot `47a66bba` (`RestartCount=0`, up ~6h13m, no
redeploy). Evidence clean: **11 decides, ALL hold** (up from n=4), 0 proposes / 0 rejections
(`signals_rejected_total` empty) / 0 fills / 0 RT; prescreen 39/50 quiet (78%), all 11 `called` bars
were higher-signal (`breakout_proximity` 7 + `vol_expansion` 4) yet all held; reconcile 753 mismatch
/ **0 halt / 0 error**; logs 0 error/warn/HALT/EXPIRED; cost $0.189 since epoch (DB gauge = hand-priced
tokens exactly, ≈$0.72/day), kill switch RUNNING, equity 4996.73 static. **#29 resolved (structural):**
holds are model-driven (0 proposes + 0 rejections ⇒ trigger b not firing, gate not implicated).
Option (b) prescreen-loosening can't reach the Stage-2 exit — it surfaces more −EV (≈0-to-−3bps vs
20bps) bars, not net-≥0 (**strongly indicated**; owner-SQL on hold rationales is the last confirmer).
Blocker is edge/cold-start = owner-strategic (Pass 10 flag now firmed). **Shipped:** `pnpm eval:agentic`
wired into the playbook as an every-pass §2.6 harness-health probe (+ §6.4 lint:md gate, §5.1
ship-gate), docs/, verified green incl. under CI env — the loop's own guard against the Pass-10
silent-breakage class. **Flagged #30** (the CI-step systemic fix) with exact diff — `ci.yml` is
owner-territory, unverifiable from a no-push pass.
No redeploy (docs-only). Empty-pass counter stays 0. Full detail in LOG.md.

**Pass 10, 2026-07-08** (scheduled run, ~11:31Z) — **SHIP NOTHING, learning loop throughput-starved.**
Same continuous boot 47a66bba (RestartCount=0), ~1h37m in — no redeploy since Pass 9. Evidence clean:
still 4 decides all `hold` (0 new in 68 min, prescreen skip 71% = cost floor working), 0 fills / 0
proposes / 0 RT, portfolio static across 390 heartbeats, reconcile 201 mismatch / **0 halt / 0 error**,
logs 0 error/warn/HALT/EXPIRED, cost $0.069 since epoch (DB gauge matches hand-priced tokens exactly),
kill switch RUNNING. **Root-caused the missing Stage-2 signal:** the whole learning funnel (reflection
plus the promotion evaluator) is trade-gated via `onClosedTrade` with no wall-clock path, and the DB
seed already primes the trigger — so the sole blocker is **zero new closed trips**, not the threshold
or a bug. No correctness bug; 100%-hold still n=4-unresolvable (0 proposes + 0 rejections ⇒ model-driven,
R:R floors not implicated). Rejected a wall-clock reflection trigger on the merits (would churn
`NO_CHANGE` over stale evidence). **Empty-pass counter 2 of 2** → carried the mandated §3 cadence/scope
recommendation (cost-floor vs learning-throughput; see Flagged). Advisor consulted, corrected an
over-rotation toward building the trigger. Full detail in LOG.md.

**Pass 9, 2026-07-08** (scheduled run, ~10:23Z) — **SHIP NOTHING, soak-verification.** Fired ~30 min
behind the owner session's `bac974c`/boot-47a66bba deploy (provenance settled: git commit times +
`docker inspect` RestartCount=0 + logs opening at the boot marker ⇒ owner deploy, no unexplained
recreate). Evidence clean: 4 decides all `hold`, 0 propose/fill/RT, **0 EXPIRED**, reconcile healthy
(47 mismatch / 0 halt / 0 error), cache working, ~$2/day decide-side projected under the $5 breaker,
kill switch RUNNING, equity flat (dd 0.065%). No correctness bug; no Stage-2 learning-loop signal yet
(reflection hasn't run, playbook v1). Shipped nothing by design — the only autonomous items (W12
logging, #28 model-label) need an app redeploy that would reset the owner's fresh continuous-uptime
soak of a 51-file rebuild; forcing that = the change the playbook warns against (advisor concurred).
**Empty-pass counter 1 of 2** — a schedule collision with a manual deploy, NOT backlog exhaustion.
New watches: 100%-hold trigger (below) and backlog #28. Full detail in LOG.md.

**Aggressive-improvement session, 2026-07-08** (owner-directed, `/goal` "improve aggressively —
challenge/change ANYTHING"; approved plan `investigate-this-repo-end-to-end-structured-reef.md`).
Commit `bac974c` (51 files, +2451/−162). Deployed boot 47a66bba; reviewer (opus) APPROVED, no
must-fix. Gate green: build/lint/typecheck, 1463 unit+livegate, 11 paper, 41 livegate, 44 db.
Shipped 9 work-items (W1–W7, W10, W13, W14): reflection revival (banned-word prompt collision fixed,
`agentic_reflection_outcomes_total` telemetry, cache parsing, Opus-4.8 tier); reflection evidence
upgrade (calibration/regime digests); attributed auto-promotion evaluator with A/B live at 25% and
expectancy ladder ON; plan-gate R:R floors, exit-TTL race fix, flat/hold disambiguation; true-spend
accounting (per-model and cache pricing, migration 0006) with owner evidence epoch; terminal_at OMS
stamping and backfill (migration 0007; boot reseed 63→3 verified live); inputPayload sampling.
DEFERRED (owner-gated): W11 sub-bar plan-stop enforcement (modifies the §S3 ProtectiveExitService —
an unresolved owner question, see Flagged). Follow-ups noted: W12 operational event logging, W15
offline `eval:candidates` runner wiring, W9 Grafana panels for the new series. Full detail in LOG.md.

**Pass 8, 2026-07-07** (scheduled run, ~18:05–19:15). Two S observability improvements, both
verified live; no money-path files. (1) **Alert hygiene** `a25389a`: `ReconciliationHalt`
critical pages the kill-switch-engaging classes by name; class-blind `ReconciliationMismatch`
downgraded to warning (was firing 24/7 critical on the foreign-order steady state — alert-fatigue
risk); `AgentClientFatalLatch` critical on `error_fatal > 0` closes #20 (fires for exactly the
latch lifetime). (2) **Cache-token series** `f5221b9` (#13): `agent_tokens_total{kind=
"cache_read"/"cache_creation"}`; fields were parsed but persisted NOWHERE before this.
**#13 VERDICT same pass: cache WORKS** — 2775-token prefix written once, read 3× in the first
soak window ⇒ KEEP, no revert; but flat 3/15 accounting undercounts true spend (~1.5× this
window) → flagged owner decision on folding cache economics into the promotion cost formula
(backlog #27). Gates 1416 unit green; prometheus recreated (TSDB survived — 3rd verified time),
app boot dcf7e4c2 18:26 clean (63 seeded / 3 registered / 0 degraded); soak green (84 reconcile
passes 0 errors, decides both bars, no EXPIRED). Scoreboard: 30 RT (**≥30 threshold MET first
time**), net −$17.94, window 2.75d. Ops gotcha in project memory: single-file bind mounts go
stale after atomic-rename edits — recreate the consuming container. New: #27.

**Pass 7, 2026-07-07** (owner-triggered, same session as Pass 6: owner authorized the flagged
OMS fix package). **Reconciliation is ALIVE again.** Shipped `f5ce2c0` (all four package items:
reducer VENUE_CANCELED/VENUE_EXPIRED arms in CANCEL_PENDING/CANCEL_UNKNOWN + CANCEL_ACK terminal
no-op; reconcile per-order TransitionError isolation; gate folds CANCEL_ACK inline on REST cancel
success with fills-win guards both paths + summary-symbol fallback; boot recovery registers
venue-confirmed recovered orders in the portfolio open set) and `378f88b` (ReconcilerStalled
re-keyed to pass COMPLETION — foreign resting orders on the shared demo wallet make per-pass
mismatches the healthy steady state, so last-clean-age would false-fire forever). Reviewer
APPROVE-WITH-MUST-FIX, must-fix applied (guard the throw-path fold against a racing full fill) +
regression test. Gates: 1411 unit, 41 livegate, 11 paper, 43 db, build/lint/typecheck. Deployed
16:26 boot 28dc56a2: 61 rows seeded, 4 registered open, 1 degraded — **first reconcile pass
adopted the stranded order and retired it (self-heal confirmed, open_orders 4→3)**; zero pass
errors since, all passes complete; lane deciding (16:30 bar: 1 proposed, 1 quiet skip, ≈0.9¢);
ReconcilerStalled verified inactive live. Bonus finding: prom image's anonymous volume preserves
TSDB across compose recreates — history survived, #22 downgraded. New: the 57 zombies are
`SUBMIT_UNKNOWN` (never-confirmed-landing), deliberately NOT auto-healed → #25; continuous
foreign-order ReconciliationMismatch firing → #24. RESTART HAZARD LIFTED.

**Pass 6, 2026-07-07** (scheduled run, ~15:15–16:10). Two findings. (1) **Reconciliation is DEAD
since 14:45:32** — the first live CANCEL_OPEN (entry-TTL sweep cancelling the 13:45 plan entry)
stranded an order in CANCEL_PENDING because nothing acks cancels on the demo venue (only the
paper adapter emits CANCEL_ACK), and every 30s reconcile pass since throws
`VENUE_CANCELED in CANCEL_PENDING` and aborts whole — trades/balances axes included. Fix package
(reducer arms + per-order guard + gate folds ack on REST success + boot-recovery portfolio
seeding) is OWNER territory — exact diffs in LOG.md Pass 6. **RESTART HAZARD: recreating the app
container before the fix lands makes the stuck order permanently unresolvable and poisons live
arming via hasUnresolvedOrders()** — do not redeploy the app until the fix ships (deploying the
fix itself is fine IF it includes reducer arms + portfolio seeding: the first reconcile pass then
self-heals everything, 57 zombies included). (2) **All Prometheus alert rules were dead since
first boot** (alerts.rules.yml never mounted; empty rule_files glob is not an error) — FIXED this
pass (`239edf0`): mount added, ReconcilerStalled + ReconcilePassErrors rules added, hot-loaded via
cp+SIGHUP (no recreate — no TSDB volume), all three reconciliation alerts verified firing against
the live incident. Gates green (1400 unit). App container deliberately untouched. Stage-1 note:
first sub-$1/day reading (≈$0.33/day pro-rated, 2.2h sample) and first in-band skip rate (3/6).
Backlog #21 answered negatively: the sweep structurally cannot see boot-recovered orders (they
never enter the portfolio open set); the 57 stale orders are venue-dead journal residue, not live
balance locks (174 clean passes would have HALTed UNKNOWN_OURS otherwise).

**Pass 5, 2026-07-07** (scheduled run, ~12:40–13:50). Found and fixed a trading-path correctness
bug the same pass: the first AGENTIC_PLAN_MODE boot (de36fa2d) got HTTP 400 on its FIRST decide —
Anthropic strict tool use rejects `minimum`/`maximum` in tool schemas, and `PLAN_TOOL` carried
them on all five plan fields — which FATAL-latched `AnthropicAgentClient` to degraded and killed
the lane from 12:15 until the 13:18 fix deploy (zero LLM calls in between; plan mode had never
completed a single call before this fix). Fix `d54b3bf` (reviewer-approved, live-API-verified at
every step): new `PLAN_BOUNDS` single source renders the ranges into the tool descriptions and
feeds the zod gate; allowlist regression test over every strict tool schema. Gates green (1400
unit), 30-min soak green on boot b61908ba: **first live `submit_plan` decide proposed at the
13:45 bar (1585 in/170 out ≈ 0.7¢) and its plan-priced resting entry reached Execution**
(openOrders=1). New flags: latch observability gap (#20), recovered-orders sweep coverage
unverified (#21). Stage-1 note: 2026-07-07 cost data has a ~1h lane outage hole (12:15–13:18).

**Pass 4, 2026-07-07** (owner-triggered "aggressive refactors" session; plan approved with
governance changes — see the 2026-07-07 approved plan and LOG.md Pass 4 entry). Shipped 15 commits
across four waves: Wave 1 (warmup 340 revives always-null h1/h4 HTF, breakout prescreen 0.0025,
reflection 12h, thinking:disabled on decides, bestBid entry hints, USD cost circuit breaker, noop
decide-outcome label, input_payload persistence [migration 0005], per-playbook-version net-PnL
gauges), Wave 2 (CANCEL_OPEN routing + AGENTIC_ENTRY_TTL_BARS stale-entry sweep and dust-tolerant
round-trip metrics — both reviewer-approved with one must-fix applied; offline replay/A-B harness;
candle trim 50→30 template v4; prompt-cache experiment), Wave 3 (AGENTIC_PLAN_MODE plan-based
trading, flag OFF pending offline A/B + owner enable), Wave 4 (playbook A/B routing + expectancy
ladder, flags OFF; zero-LLM executor parameter sweep). Full gates green: build/lint/typecheck,
1397 unit, 43 db, 11 paper, 41 livegate. W2.6 cross-symbol context deferred to backlog. Boot
recovery on redeploy seeded 57 stale open orders — the new entry-TTL sweep clears them organically.

**Pass 3, 2026-07-06/07** (scheduled run; session forced into Plan Mode, plan approved same
session — see LOG.md for the process note). Shipped: `agentic_prescreen_total` now labeled by
`PrescreenReason`, plus a playbook doc fix (`docker exec` → `docker compose exec`, the former is a
hard global permission deny in this environment). Gates green (1324 unit + lint/typecheck/build),
deployed, ~7h47m soak clean. **Key finding: the reason breakdown shows `breakout_proximity`
dominates `called` (37 of 51, ~73%), not `position_open` (14 of 51, ~27%)** — inverts this pass's
working hypothesis and redirects backlog #10 (see below). Snapshot at Pass 3 soak-end: readiness 28
round trips, net −$17.02, LLM cost $13.52, window 2.16d, ready=0; equity ~4997.94; skip rate 13/64 ≈
20.3% (up from 12.5%, still under the 50-70% target); cost ~$2.98/day pro-rated (still ~3x the
Stage-1 ≤$1/day exit criterion). Tree committed through `bd4a548`; a loop pass must never commit
changes it didn't author (the pre-existing dirty `observability/grafana/dashboards/crypto-bot.json`
diff predates Pass 3, was stashed/restored intact around the commit, and remains uncommitted and
unowned by any pass — owner should check whether it was intentional).

**Pass 2, 2026-07-06** (owner-triggered; LOG.md has Passes 0–2). Snapshot at Pass 2: readiness 26
round trips, net −$15.97, ready=0; equity ~4997.7; 2 symbols (agentic-1 BTC/USDT, agentic-2
ETH/USDT), playbook seed v1. **Post-Pass-2 update (~22:15): key blocker RESOLVED — lane LIVE on
Sonnet** (see resolved flag below; first window: 3 decides, 1 proposed, first `skipped_quiet`,
~1.7¢/decide). Empty-pass counter: 1 of 2 (Pass 2 shipped no code — stale-backlog pruning only);
counter resets naturally now that live data unblocks #10.

## Backlog (ranked; re-rank each pass)

**2026-07-08 session closed these:** #11 (reflection model) — Opus-4.8 with mandatory per-model
pricing (W13); #16 (A/B enable + attributed auto-promote) — live at 25% + evaluator shipped (W5); #27
(true-spend accounting + cache columns + gate-formula fold) — DONE (W4/W13, owner-approved
epoch). PARTIAL: #17 (cross-symbol/self-track-record) — the regime + own-track-record evidence now
reaches REFLECTION (W14); the decide-prompt version waits on the offline harness. OPEN follow-ups
(not this session): W12 operational event logging, W15 `eval:candidates` runner, W9 Grafana panels
for the new series, #24 (foreign-order mismatch class split — still owner/OMS territory), #25 (the
2 CANCEL_UNKNOWN zombies — now the ONLY unstamped-terminal residue after W7's backfill; reconciliation
owns them).

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Stage | Effort | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Verify `agentic_promotion_*` gauges recover post-restart and count pre-multi-symbol round trips (strategyId `agentic` → `agentic-1`/`-2`)                                                                                                                                                                                                                                                                                                                                                                                                    | 0     | S      | DONE 2026-07-06 (verified live)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2   | Verify Grafana "Agentic lane (LLM)" panels render $/day spend + net-of-cost PnL                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 0     | S      | DONE 2026-07-06 Pass 1 (API render check: 55 panels, rows 80/89/90/130/142 present)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3   | `STRATEGY_INTERVAL` 5m → 15m + fix false `AGENTIC_MAX_CALLS_PER_DAY` comment (compose + .env.example)                                                                                                                                                                                                                                                                                                                                                                                                                                        | 1     | S      | DONE 2026-07-06 (deployed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | Deterministic pre-screen gate ahead of LLM call (`AGENTIC_PRESCREEN_*`, counter, fail-open)                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 1     | M      | DONE 2026-07-06 (deployed; reviewer-approved, 4 should-fix applied: digest excludes model='prescreen', skips kept out of recentDecisions ring, latency null, ordering test)                                                                                                                                                                                                                                                                                                                                                                        |
| 5   | Fix scoring biases in `counterfactual-scoring.ts` (FLAT-on-fall rewarded; open PnL excluded)                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 2     | S      | CLOSED-STALE 2026-07-06 Pass 2: both already fixed since the 07-04 analysis — exposure-based isHit (F2, counterfactual-scoring.ts:113-124) is an exact complement split, and the open-at-end exclusion is deliberate/documented (`openAtEnd`) with reflection fed by realized venue round trips                                                                                                                                                                                                                                                    |
| 6   | Inject order-book depth into prompt (`agent-prompt.ts:146-148`), token-budgeted                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2     | S      | CLOSED-STALE 2026-07-06 Pass 2: prompt v3 (d41b35f) landed `buildOrderBookBlock` — top-of-book levels, spread bps, imbalance ratio already rendered                                                                                                                                                                                                                                                                                                                                                                                                |
| 7   | Per-playbook-version net-PnL attribution (query/panel)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 2     | M      | DONE 2026-07-07 Pass 4 (`agentic_version_net_pnl_usd{version}` + `agentic_version_round_trips{version}` sampler shipped; Grafana panel pending — blocked on the unowned dirty dashboard JSON, see backlog #19)                                                                                                                                                                                                                                                                                                                                     |
| 8   | Cross-field boot validation: `AGENTIC_WARMUP_BARS >= PRESCREEN_VOL_LONG_BARS/BREAKOUT_LOOKBACK` (zod superRefine; undersized warmup silently no-ops the cost floor via permanent fail-open)                                                                                                                                                                                                                                                                                                                                                  | 1     | S      | DONE 2026-07-06 Pass 1 (deployed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 9   | prescreen.ts: route non-positive/NaN-producing candle values to `insufficient_data` (total fail-open guarantee; today NaN comparisons fall through to quiet=skip)                                                                                                                                                                                                                                                                                                                                                                            | 1     | S      | DONE 2026-07-06 Pass 1 (deployed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 10  | Tune `AGENTIC_PRESCREEN_BREAKOUT_PCT` (0.005) tighter (toward 0.002-0.003) and/or revisit `BREAKOUT_LOOKBACK_BARS` (20) toward the 50–70% skip target                                                                                                                                                                                                                                                                                                                                                                                        | 1     | S      | RE-SCOPED 2026-07-07 Pass 3 with measured data: `agentic_prescreen_total` reason breakdown (shipped this pass) shows `breakout_proximity` drives 37/51 (~73%) of `called` outcomes vs `position_open` 14/51 (~27%) — the ORIGINAL wording (tune VOL_RATIO/BREAKOUT_PCT) was right, `position_open`'s early-return was a red herring the pass caught via advisor consult before shipping the wrong fix. Skip rate 13/64≈20.3%, still under 50-70% target. Re-verify against a few more days of data before picking an exact new BREAKOUT_PCT value. |
| 11  | Reflection model back to Opus? Only with per-model pricing at read time (llm_usage/agent_decisions carry model columns) — flat 3/15 must stay honest                                                                                                                                                                                                                                                                                                                                                                                         | 2     | M      | pending (deferred by owner 2026-07-06)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 12  | Let `evaluatePrescreen`'s quiet-detection apply while a position is open (drop the unconditional `position_open` early-return, `prescreen.ts:87-89`), gated on a derived `protectiveExitActive` flag so behavior is unchanged whenever `PROTECT_STOP_LOSS_PCT`/`PROTECT_TRAILING_PCT` are both 0                                                                                                                                                                                                                                             | 1     | M      | pending, LOWER PRIORITY after Pass 3's data (`position_open` is only ~27% of `called`, `breakout_proximity` ~73% — #10 is the bigger lever); NOTE 2026-07-07: AGENTIC_PLAN_MODE (once enabled) supersedes this entirely — plan-managed bars skip the LLM while long                                                                                                                                                                                                                                                                                |
| 13  | Verify the prompt-cache experiment (W2.4): `cache_read_input_tokens` > 0 within a day of decides, else revert the cache_control blocks (falsifiability commitment)                                                                                                                                                                                                                                                                                                                                                                           | 1     | S      | METRIC SHIPPED 2026-07-07 Pass 8 (`f5221b9`): `agent_tokens_total{kind="cache_read"/"cache_creation"}`, forwarded only when the response carries the fields (absent ≠ confirmed-zero). Pass-5's "DB usage columns" assumption was WRONG — the client parsed the fields but NOTHING persisted them (no DB column, no metric); no SQL can read the past. VERDICT DUE next pass: cache_read absent-or-0 after a day of decides ⇒ revert the cache_control blocks (agentic-lane, autonomous)                                                           |
| 14  | Measure post-Pass-4 skip rate + $/day at breakout 0.0025 and thinking-off; re-tune toward 50-70% skip / ≤$1/day                                                                                                                                                                                                                                                                                                                                                                                                                              | 1     | S      | pending (Stage-1 exit measurement continues)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15  | ~~AGENTIC_PLAN_MODE enable-gate~~ ENABLED by owner 2026-07-07 (offline-A/B pre-check waived by owner decision; the recorded-input harness + executor param sweep remain the POST-hoc validators — run them once ≥200 input_payload rows accrue and report divergence)                                                                                                                                                                                                                                                                        | 2     | M      | ENABLED 2026-07-07; VERIFIED LIVE by Pass 5 (first `submit_plan` decide + plan-priced entry at the 13:45 bar, after fixing the 400 that had latched the lane). Post-hoc validation still pending row accrual                                                                                                                                                                                                                                                                                                                                       |
| 16  | Flag-enable decisions once attribution accrues: AGENTIC_PLAYBOOK_AB_PCT (candidate evidence pre-promotion) and AGENTIC_EXPECTANCY_LADDER; AGENTIC_AUTO_PROMOTE_MIN_TRADES 30→20 only after ≥1 clean attributed promotion                                                                                                                                                                                                                                                                                                                     | 2     | S      | pending                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 17  | W2.6 cross-symbol + self-track-record prompt block (≤300 tok, validated via the offline harness)                                                                                                                                                                                                                                                                                                                                                                                                                                             | 2     | S      | pending (deferred from Pass 4 — file-scope conflict with plan-mode work)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 18  | W4.4 seeds: per-hour/session expectancy gating; bounded knob-learning channel for reflection (needs validator design); fee-tier/BNB-discount paper modeling (live-prep); trade-flow snapshot widening                                                                                                                                                                                                                                                                                                                                        | 2+    | M-L    | seeds (each needs data or design first)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 19  | Grafana panels for the new series (cache tokens, `outcome="noop"` split — per-version panels shipped by owner in `ba488ec`)                                                                                                                                                                                                                                                                                                                                                                                                                  | 1     | S      | DONE 2026-07-12 Pass 17: shipped in the dashboard JSON — all three cost panels made cache-aware (reads 0.1×, 1h-TTL writes 2× the input price; they had kept the pre-W4/W13 undercount), token panel split by model/kind (post-#28), new lane duty-cycle (24h/48h) stat; grafana hot-reload live-verified via API                                                                                                                                                                                                                                  |
| 20  | Degraded-latch observability: `agent_client_degraded` gauge (or alert on `agent_decide_total{outcome="error_fatal"} > 0`) + Grafana alert — a FATAL latch currently emits one warn line and the lane silently dies (cost ~1h dead air on 2026-07-07)                                                                                                                                                                                                                                                                                         | 1     | S      | DONE 2026-07-07 Pass 8 (`a25389a`): `AgentClientFatalLatch` critical on `sum(agent_decide_total{outcome="error_fatal"}) > 0` — fires for exactly the latch's lifetime (counter resets on the recreate that clears it). Verified loaded + correctly inactive live                                                                                                                                                                                                                                                                                   |
| 21  | Verify the entry-TTL sweep actually covers boot-RECOVERED open orders: boot b61908ba re-seeded 57 stale orders and no CANCEL_OPEN fired during the Pass-5 soak — Pass 4's "sweep clears them organically" assumption is unverified; recovered orders may lack sweep-eligible tracking                                                                                                                                                                                                                                                        | 1     | S      | ANSWERED-NEGATIVE 2026-07-07 Pass 6: structurally impossible — boot recovery seeds only the order book, recovered orders never enter the portfolio open set the sweep reads (`boot-recovery.service.ts:52-53`). Fix = portfolio seeding, item 4 of the Pass-6 flagged OMS package (owner). Also: the 57 are venue-dead journal residue, not live balance locks                                                                                                                                                                                     |
| 22  | Prometheus TSDB named volume (`prometheus_data:/prometheus`) — today the TSDB lives in the container layer; any recreate wipes all metrics history (forced Pass 6 to hot-load rules via cp+SIGHUP instead of `up -d prometheus`). One-time history loss at migration; coordinate with owner                                                                                                                                                                                                                                                  | 1     | S      | DOWNGRADED 2026-07-07 Pass 7: the prom image's anonymous volume at /prometheus is preserved by compose recreation (history survived two recreates, verified). A named volume still protects against `down -v`/`--renew-anon-volumes`; low priority                                                                                                                                                                                                                                                                                                 |
| 23  | OMS cancel-ack fix package (reducer VENUE_CANCELED/VENUE_EXPIRED arms in CANCEL_PENDING/CANCEL_UNKNOWN; reconcile per-order fold guard; gate folds CANCEL_ACK on REST success; boot-recovery portfolio seeding) — reconciliation is DEAD until this ships; every stale-entry cancel reproduces                                                                                                                                                                                                                                               | 1     | M      | DONE 2026-07-07 Pass 7 (owner authorized): `f5ce2c0`, reviewer-approved with must-fix applied, full gates incl. livegate/paper/db, deployed boot 28dc56a2, self-heal verified live (stranded order adopted+retired on the first pass; zero pass errors since). Also resolves #21's fix half                                                                                                                                                                                                                                                        |
| 24  | Split `reconciliation_mismatch_total` by mismatch class (foreign / adopted-terminal / sweep-failure / would-halt) so ReconciliationMismatch can alert quiet-by-default: the shared demo wallet's ~4 foreign resting orders fire the alert continuously today (WARN-and-ignore class, same counter as halt classes)                                                                                                                                                                                                                           | 1     | S      | pending — app-side label is OWNER territory (reconciliation.service.ts is OMS, outside the scoped exceptions). INTERIM shipped 2026-07-07 Pass 8 (`a25389a`): `ReconciliationHalt` critical on `reconciliation_runs_total{result="halt"}` (the kill-switch-engaging classes, by name), `ReconciliationMismatch` downgraded to warning (was a 24/7 critical page). Restore critical on the split counter when the owner ships the label                                                                                                             |
| 25  | Resolve the ~57 `SUBMIT_UNKNOWN` zombie rows (never-confirmed-landing orders from pre-07-07 boots): venue-dead (no UNKNOWN_OURS halts across 174+ clean passes) but they keep `hasUnresolvedOrders()` true, which refuses live arming someday. Needs a journaled one-time resolution (e.g. recovery-time fetchOrder sweep folding QUERY_NOT_FOUND_EXPIRED), owner-authorized — touches OMS recovery semantics                                                                                                                                | 1     | M      | pending (owner decision; enumerate first: `SELECT state, count(*) FROM orders WHERE terminal_at IS NULL GROUP BY state;`)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 26  | Recovered resting orders don't count into Risk's E1 in-flight exposure clamp (intents aren't persisted, `evaluate.ts:171` iterates inFlightIntents only) — reviewer nice-to-have from the Pass-7 review; pre-existing, partially mitigated by the TTL sweep now seeing recovered orders                                                                                                                                                                                                                                                      | 2     | M      | DONE 2026-07-12 (owner-directed, `b00c886`, #35 D3): intents were persisted all along (order_intents write-ahead) — recovery just never rehydrated them; loadOpenOrders now returns the full OrderIntent and boot recovery re-registers it, so E1 sees recovered exposure                                                                                                                                                                                                                                                                          |
| 27  | True-spend cost accounting: persist cache_read/cache_creation tokens to `agent_decisions` (nullable analytics columns — scoped migration exception, mandatory reviewer) + journal plumbing, and fold cache economics (0.3 read / 6.0 1h-write $/MTok) into the $/day reads; changing the promotion gate's `llmCostUsd` formula is stricter-but-different ⇒ OWNER sign-off (flagged Pass 8)                                                                                                                                                   | 1     | M      | pending (new, seeded by Pass 8's cache verdict: flat 3/15 undercounted true spend ~1.5× in the first measured window; columns+plumbing autonomous, gate formula owner-gated)                                                                                                                                                                                                                                                                                                                                                                       |
| 28  | `model` label on token/decide metrics: `agent_tokens_total` / `agent_decide_total` carry no `model` label, so once Opus reflection fires its tokens comingle with Sonnet decides in the `kind` buckets and Prometheus can't split per-model $/day. DB gauge `agentic_promotion_llm_cost_usd` is the intended per-model read (§2.3) ⇒ observability convenience gap, not a defect. Add a `model` label to the token/decide counters (observability, agentic-lane, autonomous)                                                                 | 1     | S      | DONE 2026-07-11 Pass 16 (`b1b9455`): `model` label on both counters — decide path tags the config model via MetricsWrappingAgentClient, reflection tags cfg.model; shipped the same day the first Opus reflection fired (04:45Z), before its tokens could accumulate unlabeled                                                                                                                                                                                                                                                                     |
| 29  | **100%-hold watch** (Pass 9 saw 4/4 `hold`, n too small to conclude): re-check next pass with a full day of decides. Trigger (a) `agent_decide_total{outcome="hold"}` ~100% + `fills_total`=0 + 0 proposes after a day ⇒ model too passive (prompt/prescreen). Trigger (b) proposes appear but `signals_rejected_total` climbs with fills=0 ⇒ W3 plan-gate R:R floors (SL≥fee, TP/SL≥1.5) over-rejecting — a Stage-2-blocking regression as "quiet market". Now: 0 proposes+0 rejections ⇒ holds are model-driven, floors NOT yet implicated | 2     | S      | RESOLVED (structural) 2026-07-08 Pass 11: n=11, 0 proposes + 0 rejections ⇒ holds model-driven (gate not implicated, n-independent). Option (b) prescreen-loosening can't reach the Stage-2 exit — it surfaces more −EV (≈0-to-−3bps vs 20bps) bars, not net-≥0 (strongly indicated; all 11 higher-signal `called` bars held corroborates; owner-SQL on hold rationales is the last confirmer). Blocker = edge/cold-start (owner-strategic), not a bug. Re-open on proposes-with-rejections or fills                                               |

| 30 | Gate `pnpm eval:agentic`: the $0 offline replay harness (Stage-2 candidate scoring) sat RED ~1 day (stale system-prompt assertion, fixed `1f90ff6`) because `ci.yml` never runs `test/eval` — add its non-live specs (all but the two `EVAL_LIVE`-guarded files) to a gate/CI job so it cannot silently re-break | 1 | S | FLAGGED 2026-07-08 Pass 11 — the CI step is owner-territory (`ci.yml` outside §4 MAY, unverifiable from a no-push pass); exact one-line diff in LOG.md Pass 11. INTERIM shipped same pass: `pnpm eval:agentic` wired into playbook §2.6 as an every-pass harness-health probe (loop-local guard, verified green incl. under CI env). Both networked eval specs self-skip without `EVAL_LIVE`/`DATABASE_URL`, so the CI step needs no env |

| 31 | Reflection trigger consumed on transient error: `runReflection` resets `tradesSinceLastAttempt`/`lastAttemptAt` at `reflection.service.ts:480` BEFORE the fetch, so a transport/http/malformed error (post-line-480) consumes the trigger + a budget call and waits the full 6h cooldown + 5 trips to retry. Pass 12's timeout fix makes the timeout case rare, but any transient error still strands the loop. Roll back both counters on transport/http/malformed exits (guard re-entrancy via the existing `inFlight` flag) so a transient failure retries on the next closed trip | 2 | S | DONE 2026-07-10 (owner session, `21c9b2d`): additive rollback on transport/http/malformed/no_tool_block/schema_fail AND final validator_reject, plus ONE bounded retry-with-feedback (full assistant-content echo incl. thinking blocks — continuation contract live-verified against claude-opus-4-8); reset-robust `AgenticReflectionNeverMinted` alert added |

| 32 | Stream the reflection LLM call (SSE) instead of a single non-streaming POST: removes the arbitrary wall-clock timeout ceiling entirely (the durable fix behind Pass 12's `AGENTIC_REFLECTION_TIMEOUT_MS` bump — a fixed timeout is still a guess about Opus worst-case). Advisor backlog seed. Agentic-lane, `reflection.service.ts` fetch body + envelope parsing | 2 | M | pending (new, Pass 12 2026-07-09) |

| 33 | Playbook-validator concept precision: the substring denylist (`lower.includes`) false-rejected benign trading prose ("marginal"→`margin`, "leverage the trend"→`leverage`, "act as support"→`act as`), killing every completed reflection candidate (2/2 `validator_reject` live) and pinning the playbook at v1. Root successor to Pass 12's timeout fix. Agentic-lane + observability | 2 | M | DONE 2026-07-10 Pass 13 (`f0c5e14`): word-boundary/concept-phrase `BANNED_PATTERNS` (uniform read+write), bounded `token` metric label + `bannedToken` result. Reviewer-approved (2 must-fix coverage regressions found + fixed + pinned). WATCH: first live post-fix reflection outcome must be `minted`/`no_change`, not `validator_reject` |

| 34 | Funding-carry $0 offline backtest study (owner-mandated carry sub-plan, the pivotal GO/NO-GO gate before any paper-carry build): fetch `--funding` history + perp OHLCV for BTC/ETH (`test/backtest/fetch-data.mjs`, network, sandbox-disabled), build a delta-neutral carry P&L study (net = Σ funding − 4-fill round-trip fees − basis convergence), sweep hold length, report per-window net bps + worst window. Attach each ~8h funding event to its SINGLE bar (never broadcast per-bar — ~32× overcount → false GO). State carry policy up front (unconditional-hold "carry beta" vs funding-threshold-gated entry). `test/backtest/`, off the production gate | 2 | M | DONE 2026-07-10 (owner session, `979de5e`): ran as `reports/loop/carry-study-2026-07-10.md` — NO-GO 0/126 cells (conditional-harvest design, per-event funding accounting per this row's spec, N=178 deflation union with PRIOR_TRIALS); carry build skipped per the pre-declared gate; `test/backtest/carry/` is the standing re-test harness |

| 35 | Promotion-walk LINK freeze + stuck RECONCILE_REQUIRED order (found Pass 17; root-caused same day): THREE composing recovery defects — (D1) demo-fill-poller folded same-poll partials from a stale snapshot (journal shows non-monotone FILL cums 1.99/1.99/1.67, orders-row cum regressed), (D2) no code path rebuilt cum from the fill journal so the mis-fold was unrecoverable (TTL sweep "cancelled" the venue-FILLED order → resolver froze it RECONCILE_REQUIRED, live-arming blocker), (D3) boot recovery restored orders WITHOUT their persisted write-ahead intent so recovered-order fills skipped portfolio application — the 6.9-LINK fill (00:14Z 07-11) never moved position/cash: THAT is the walk phantom (+6.92 = 6.9 unapplied + fold residue); Pass 17's foreign-traffic hypothesis RETRACTED. NOT a shared-wallet artifact | 2 | M | FIXED 2026-07-12 owner-directed (`b00c886`, reviewer APPROVE no-must-fix, 1673 unit/41 livegate/11 paper/15 eval green): poller folds from the live book record; boot recovery rebuilds cum from SUM(fills) journaled+idempotent (live-verified: first boot healed the stuck order 1.67→5.65 FILLED, terminal_at stamped, unresolved testnet orders now 0); intents rehydrated at recovery (also closes #26's E1 gap). RESIDUAL (owner): the historical 6.9-LINK scar — ~$55 unmanaged in the wallet, LINK walk still frozen — cleanest fix is an epoch move at the next flat instant (see § Flagged); WATCH unchanged: gate-RT vs in-memory gap growing beyond the explained classes = §7 stop condition |

| 36 | Evidence-epoch asymmetry (found Pass 18, the follow-through on #35's epoch-move residual): only `promotion-readiness.service.ts` passed `PROMOTION_EVIDENCE_EPOCH` to `fillsForMode` — `version-attribution-metrics.service.ts` (v2's A/B gauges), `promotion-evaluator.ts` (attributed auto-promotion), and `round-trip-evidence.reader.ts` (reflection evidence + trigger seeds) walked ALL fills unbounded, so an epoch move would have unfrozen the gate ONLY and left the Stage-2 learning measurement layer frozen. Companion finding: the straddle "phase shift" is NOT count-preserving — with drifting entry sizes the group never re-enters dust (live: ETH frozen 00:15Z 07-11, 2 real trips absorbed; agentic-2's reflection seed read 0 where truth is 1) | 2 | S | DONE 2026-07-12 Pass 18 (`cc72a10`): all three consumers thread the gate's epoch (validated-config sourced; absent ⇒ all-time); +5 regression tests incl. the live ETH-freeze scenario; deployed boot `d5942b9b`. Epoch declaration APPLIED same day (Pass 18 addendum, owner delegation): `2026-07-12T08:30:00Z` live on boot `9ff1eb40`, reset verified — gate + attribution + evaluator + reflection all on one clean window; ETH/XRP/LINK freezes erased |

| 37 | E2 forward-proxy cross-symbol pollution (found Pass 19, same class as the `scoreRows` defect `5da2630` fixed): `candidate-model-eval.spec.ts`'s `forwardProxyBps` feeds ALL recorded rows (5 symbols interleaved) into `summarizeRecentDecisionOutcomes`, whose positional forward returns assume a single instrument's price path — the champion-vs-candidate model comparison's forward metric would be noise. Fix is spec-side only: group `ScoringRow`s by symbol, digest each group, combine as the entry-count-weighted mean. MUST land before E2 first runs (corpus ≥200 `input_payload` rows; 135 at Pass 19) | 2 | S | DONE 2026-07-12 Pass 19 addendum (`2f546f3`, owner-directed "fix the flaws"): per-symbol digest + entry-count-weighted recombine (also fixes the cross-symbol exposure-walk misclassification); single-instrument caller contract now stated on all three positional digest docstrings; landed well before the corpus reaches 200 (135). candidates/ added to .prettierignore (artifact byte-exactness) |

| 38 | Plan-mode restart defect (found Pass 20): `activePlan` is in-memory; every container recreate stranded plan-managed longs as bare positions — the documented "model issues a fresh plan" self-heal had no implementation (no prompt signal, 'long' = NEW long, client dropped plans outside long-from-FLAT). Bare positions lose model-set TP/maxHoldBars (only protective backstops remain) and bill every bar (~$0.011/bar/symbol; recreate with 5 open positions projects past the $5/day breaker). Loop deploys 1–3×/day made this recurring | 2 | M | DONE 2026-07-12 Pass 20 (`6e95542`): `managedPlan` position field + prompt/tool re-arm instructions + client hold/long+plan acceptance while LONG through the unchanged fee/RR floors (no signal emitted; FLAT never arms); PLAN_TEMPLATE_VERSION p1→p2. Reviewer APPROVE no-must-fix, 1691 unit, eval 15. Live-verified first bar post-deploy: 2/2 bare positions (XRP/SOL) re-armed with explicit model narration |

| 39 | Candidate abstention deadlock (found Pass 21, structural): the promotion framework measures candidates ONLY through their own attributed trips, but reflection minted from all-loss evidence rationally raises the entry bar — v2 entered 0 of 17 FLAT consults since mint (P≈0.4% under v1's 28% rate), so its 10-trip verdict clock never starts and resolution comes only via the 168h lapse; the next mint from the same evidence will repeat the pattern. Promoting an abstainer is NOT the fix — reflection is trade-gated, so a never-trading champion freezes the whole learning loop. Cheapest real fix: an offline entry-rate floor at mint time — replay every reflection mint against the recorded corpus (§3(a) scoring machinery exists) and reject candidates whose entry conditions fire ~never BEFORE they occupy the A/B slot; alternatives (per-opportunity attribution; accept weekly lapse churn) analyzed in LOG.md Pass 21 | 2 | M | DONE 2026-07-13 (owner session): mint-time entry-rate floor (`entry-rate-floor.ts` — 12 newest FLAT-consult payloads replayed with the DECIDE model, ~$0.15/mint budget-reserved; failure → existing retry-with-feedback → `abstain_reject`+rollback; fail-open on young corpus/budget/transport — reviewer should-fix applied: successful consults gate the veto) PLUS live-abstention lapse (`AGENTIC_ABSTAIN_LAPSE_DECIDES=15`: ≥15 attributed decides with 0 entries ⇒ immediate lapse — retro-applies to v2 on the next reflection trigger, no 07-18 wait). Reviewer APPROVE no-must-fix; 1765 unit; deployed. WATCH: next reflection trigger logs 'provably abstains live' → v3 mints through the floor — expect `minted` (tradeable v3) or `abstain_reject` (floor caught another abstainer) |

## Flagged for human review (open)

- **RESEARCH HANDOFF + SHIP 2026-07-12 (owner-directed session, not a loop pass) — read
  `reports/loop/autonomy-profitability-research-2026-07-12.md` before the next pass's §3
  selection.** A 12-agent evidence sweep + live probes + adversarial review produced the cited
  roadmap AND the session shipped the **self-learning engine v2** package (all gates green,
  deployed): (1) reflection + promotion-evaluator now read the unrouted `active()` — closes the
  ~25% A/B contamination of revision basis/parentVersion/champion identity; (2) reflection gained
  an unresolved-candidate guard (pre-budget, trigger-preserving, 720h lapse via
  `AGENTIC_CANDIDATE_LAPSE_HOURS`) — EXPECT `skipped_unresolved_candidate` reflection outcomes
  while v2 sits in A/B, that is the fix working, NOT a regression (resolves Pass 17's shadowing
  watch in the safe direction); (3) promotion is now statistically honest — SYMMETRIC attributed
  floors (champion needs ≥10 in-window trips too) + Mann–Whitney PoS ≥ `AGENTIC_PROMOTE_MIN_POS`
  (0.70) — so v2's verdict also waits on champion v1 reaching 10 post-epoch trips (slower,
  honest); (4) NEW playbook `knobs:` line channel (tighten-only minConfidence/minRr/
  minEdgeMultiple, validated at mint+read, enforced deterministically on NEW entries only,
  documented to reflection) — the loop's first parametric learning degrees of freedom; (5)
  symbol-agnostic cached prefix (constraints moved to payload; templates v4→v5/p2→p3 — promptHash
  flips, WATCH `cache_read_input_tokens` finally rising); (6) eval Opus price table fixed
  ($15/$75→$5/$25; deployed gate map was already correct). Also verified: demo fees are REAL and
  exactly 10bps flat per leg (maker=taker ⇒ fee levers cannot move demo PnL; live-parity only).
  Owner-side ask in the report: always-on host (duty cycle 8–36% throttles everything).
  SAME-SESSION ADDENDUM: two follow-ups already shipped by delegated implementers (gates green,
  deployed) — plan persistence (`agent_decisions.plan_json`, migration 0010, reviewer APPROVE;
  fresh entries AND re-arms journal the accepted plan verbatim; the real-settlement replay
  unlock) and the one-command arm ceremony (`pnpm arm`; `--disarm` needs no secret by design).
  Remaining top loop follow-ups from the report: prompt-block A/B mechanism (the derivatives
  block is ON unmeasured), $0 plan-param sweep over the real corpus (plan_json now accrues the
  needed rows natively), backtest-extension for 4h/1d (offline only), remaining Phase-4
  live-arming gaps (ARM_PRECONDITIONS stub, zombie sweep #25, ACKED fixture row, risk-limit
  sizing for $1k–5k).
  CONTINUATION (~22:00Z): plan-persistence + v5-cache watches both RESOLVED POSITIVE (10
  `plan_json` rows; `cache_read` 6,392 on a 37-min boot). **Cross-symbol relative-strength
  context SHIPPED + deployed ON** (the search's strongest family fed to the lane as context;
  `+xs1` tag; rides the derivatives control arm as ONE information-context A/B — the standing
  A/B verdict now measures the info bundle jointly). **NON-price sweep DONE
  (`reports/loop/nonprice-sweep-2026-07-12.md`): funding contrarian at 1h is the program's
  strongest frontier ever** — 492 cells, 0 honest survivors, but 25 pass all gates except
  deflation (price search had zero such cells); top cell LINK Sharpe 3.07 walk-forward-consistent,
  ~97% price-timing not carry. **Second-holdout validation RAN SAME SESSION — VERDICT: KILLED**
  (do NOT redo): on a non-overlapping 2023-10→2024-06 bull window 134/150 frontier cells died,
  all three top cells flipped negative (LINK 3.07→−0.96, BTC 2.87→−1.56, XRP 2.61→−0.00);
  parameter grids are isolated spikes, not plateaus. Regime beta, not signal — the deflation
  gate's refusal was independently confirmed correct. Consequence: BOTH cheap non-price series
  are now honestly dead as directional signals; the remaining edge channels are the LIVE
  information-feed A/B (derivatives+cross-symbol bundle, verdict at ≥30 matched RT/arm) and
  event/news-class information with no fetchable history. Same session: AB_PCT 25→50 +
  candidate lapse 720h→168h deployed (v2 had 0 attributed trips in 36h — evidence rate doubled,
  stall bounded).

- **ULTRACODE SESSION 2026-07-12 (~19:30–21:30Z) — THE DEFINITIVE PROFITABILITY FINDING + most of
  the roadmap shipped. Read `reports/loop/multi-strategy-search-2026-07-12.md`.** A self-contained
  honest edge search — **4,562 backtests** (8 families: trend/momentum/mean-reversion/volatility/
  cross-sectional, long AND short, 5 symbols, 15m–1d, 6 fee levels 0→20bps, no-lookahead fills,
  winsorized deflated-Sharpe + walk-forward gating) — found **ZERO survivors at any fee level
  including 0bps** (single-cell 4,092 / portfolio 150 / cross-sectional 320). **LOAD-BEARING
  CONCLUSION, binding on all future passes: simple price-based strategy is empty on this universe,
  so the LLM lane (OHLCV+indicators) cannot profit by reading price better — its only possible edge
  is information the price series does NOT contain (news/events/derivatives positioning). Do NOT
  re-run price-TA edge searches; that answer is settled.** Two nuggets: shorts add value (every
  frontier cell is long-short — owner's instinct confirmed); the frontier is long-short daily
  cross-sectional momentum on perps (Sharpe 1.12, +45% holdout, survives 3.6bps perp-maker) but
  still fails honest gating — the single best systematic direction if the owner ever wants one, but
  forward-test-only. The live question is now whether ANY information feed adds attributed
  net-of-cost edge — the **derivatives-block A/B (`AGENTIC_DERIVATIVES_AB_PCT=30`, deployed boot
  `e3c54c07`)** now measures it. WATCH: attributed delta at ≥30 matched RT/arm is the first real
  information-edge verdict; a null result there is strong evidence the whole approach cannot reach
  live-green, and the honest posture is to keep the demo lane learning cheaply and NOT risk live
  capital. Also shipped this session (`dd93eda`→HEAD, all gates green): the offline LLM-in-loop
  backtest engine (`pnpm backtest:agentic`, live smoke ran) + the reusable multi-strategy sweep
  harness (`test/backtest/multi-strategy/`), live-corpus plan-param sweep, OHLCV-degradation
  pre-check (93.3% fair-proxy — an OHLCV-only backtest faithfully predicts live decides), E2 model
  eval (Haiku does not flip Sonnet). plan_json + cache_read watches from the earlier addendum both
  RESOLVED POSITIVE (5/5 non-null plans; cache_read 0→15,980). **Re-dispatch as loop items
  (live-arming prep, NOT blocking — the gate is far from green): (1) real ARM_PRECONDITIONS provider
  replacing the always-true stub in `mode-control.module.ts` + an `x-arming-token` transport guard
  — DONE 2026-07-13 (owner session, `e75db49`, deployed boot `19f677b3`);
  (2) journaled zombie/ACKED-fixture resolution (`scripts/resolve-stale-orders.mjs`, dry-run-first)
  — still open, the last live-arming-prep item;
  (3) port the winsorized-deflation fix into production `test/backtest/stats.ts` (low priority) —
  DONE 2026-07-13 Pass 22 (`1042930`).**

- **AVAILABILITY 2026-07-12 (Pass 17) — the host sleeps; duty cycle is now the program's
  binding constraint.** The stack runs on the owner's MacBook: `pmset -g log` shows battery
  clamshell-sleep cycles through 07-11, a reboot at 21:27Z, then ~10h at the login screen —
  lane duty cycle **8.0% over 24h, 52.5% over 48h** (`count_over_time(up[24h])/5760`; now a
  dashboard stat). Everything Stage 2 needs — trips, v2's A/B verdict, reflection cadence, E2
  corpus, and the loop's own scheduled passes (16:00Z and 00:00Z both silently missed) — is
  throttled by dark time, while `window_days` keeps counting and protective exits go unmanaged
  in every dark stretch (the SOL trail fired 10h late → −1.9% gap loss instead of a tight
  trail). Pass 15's restart policy worked (first live save this morning: stack auto-recovered
  at 07:16Z on login), but it only acts once Docker Desktop is running. Owner options, rising
  effort: (1) keep the Mac awake on AC (`caffeinate`/pmset/Amphetamine) + auto-login; (2) move
  the compose stack to an always-on host (Mac mini / small VPS — compose is portable, §5
  backups cover the DB); (3) accept the duty cycle and deflate all per-day rates when reading
  evidence. No in-repo fix exists; recommend (1) as the cheap immediate step.
- **MEASUREMENT 2026-07-12 (Pass 17; mechanism FIXED same day owner-directed, `b00c886` — see
  #35) — promotion-walk undercount, one frozen symbol + PROPOSAL: epoch move.** Gate RT added
  +2 where +4 closed: BTC/SOL clean, XRP phase-shifted (epoch-straddle class, count-preserving),
  LINK frozen. Root cause was three recovery defects (#35, all fixed + live-verified; the
  foreign-traffic hypothesis is retracted — the 6.9 LINK is OUR unapplied recovered-order fill,
  still sitting unmanaged in the demo wallet, ~$55). **What only the owner can resolve: the
  historical scar.** The 6.9 fill is journaled+deduped so the portfolio will never
  retroactively hold it, and the walk's LINK group stays frozen at a +6.92 phantom (LINK trips
  never accrue on the gate). PROPOSAL: declare a new `PROMOTION_EVIDENCE_EPOCH` at the next
  flat-position instant — erases the LINK phantom AND the XRP phase-shift in one move; cost =
  the currently-open ETH trip won't count (conservative) and the gate restarts from RT 0 (7 RT
  / −$4.3 forfeited — nowhere near the 30 floor). A loop pass can detect and propose the exact
  flat timestamp; the declaration is owner-only. Alternative (venue-side manual LINK sell)
  cleans the wallet but leaves the walk frozen.
  **UPDATE Pass 18 (same day) — proposal SHARPENED and made fully effective; ready to apply:**
  (1) the freeze is worse than Pass 17 knew: ETH froze too (00:15Z 07-11 — the "phase shift"
  is permanent under entry-size drift, NOT count-preserving; 2 real ETH trips absorbed), so up
  to 3 of 5 symbols accrue no walk evidence; (2) `cc72a10` fixed the epoch asymmetry (#36) —
  the epoch previously bounded ONLY the gate, so the move would NOT have unfrozen v2's A/B
  attribution, the auto-promotion evaluator, or reflection evidence/seeds; now one declaration
  unfreezes all four consumers at once; (3) **concrete value: `PROMOTION_EVIDENCE_EPOCH=
  2026-07-12T08:30:00Z`** — the lane is verified flat from 07:45:08Z (last fill lane-wide, 0
  open orders), so this instant stays valid whenever applied; (4) cost corrected: the "open
  ETH trip" caveat is obsolete (ETH closed 07:45:08Z and was frozen out anyway) — the forfeit
  is exactly the 7 counted RTs / −$4.34 over a 1.4d window. Apply = one docker-compose.yml env
  edit (+ `.env.example` sync) + `docker compose up -d app`.
  **RESOLVED — APPLIED 2026-07-12 Pass 18 addendum** under the same-session owner delegation
  ("no owner decisions; this is your domain" — § Strategic frame): epoch moved to
  `2026-07-12T08:30:00Z`, boot `9ff1eb40` clean, reset live-verified (gate RT/net/cost/window
  all 0, `agentic_version_round_trips` empty — phantoms gone, all four walk consumers on one
  clean window). Residual: the 6.9-LINK wallet scar is wallet hygiene only, invisible to all
  walks post-move.
- **FYI 2026-07-11 (Pass 15) — host-reboot outage class closed at the compose layer, one
  owner-side dependency remains.** The ~23:28Z host reboot left the stack down 43 min because
  no service had a restart policy; `e4542fb` ships `restart: unless-stopped` on all four.
  Residual dependency the loop cannot fix: the policy only acts when the Docker daemon itself
  comes back after a reboot — keep Docker Desktop's "start at sign-in" enabled (it did start
  today). Revert = four compose lines.
- **INCIDENT 2026-07-10 ~20:26Z — production DB schema dropped by a runaway test invocation
  (self-inflicted, remediated same session; full account in LOG.md).** Lost: all local history
  pre-20:26Z (promotion ledger 11 RT/−$2.52, the ~196-row E2 corpus, pre-wipe
  orders/fills/llm_usage/audit rows). Survived: demo-venue balances/positions (source of truth),
  the app's in-memory portfolio (never restarted), all code + reports. Remediation
  (owner-approved): synthetic residue deleted; 3 fixture orders remain pinned by append-only
  `order_events` FKs (paper/live modes — inert for testnet; the live-mode ACKED row must be
  resolved before any far-future live arming); audit_log/order_events carry 9+4 fixture rows as
  a permanent append-only scar. Durable fix shipped: `test/db/persistence.spec.ts` hard-refuses
  destructive setup on any non-`_test` database regardless of `DB_SUITE_ALLOW_RESET`
  (throw-verified both directions). **Both owner decisions RESOLVED same session
  (owner-directed follow-up pass):** (1) `PROMOTION_EVIDENCE_EPOCH=2026-07-10T20:26:00Z`
  deployed and verified in the container; (2) `scripts/db-backup.sh` shipped (gzip pg_dump,
  keep-14 retention, `backups/` gitignored) with the first real backup taken — running it is a
  standing loop §5 duty (once per pass is cheap at ~28K/dump). Measurement fixes shipped in the
  same pass: durable scorecard files (`AGENTIC_EVAL_SCORECARD_FILE`), malformed-row tolerance
  in scoring, and the pinned `pnpm eval:playbook` entry point. Post-restart recovery was clean
  (reconciliation 3/3 clean, portfolio restored exactly, no UNKNOWN_OURS HALT).

- **CARRY TRACK RESOLVED 2026-07-10 (this session) — NO-GO, verdict supersedes the carry-sub-plan
  bullets below.** The funding-carry offline study ran (`reports/loop/carry-study-2026-07-10.md`,
  commit `979de5e`): **0/126 cells** clear the GO bar (best cells carry 2–5 holdout episodes vs the
  ≥8 floor; nothing clears tStat>3 or WF-positive-every-segment). Per the program's pre-declared
  contingency, the perp-venue wiring and the carry lane are **NOT built** — quoting the shipping
  commit verbatim: "only the -2022 classifier rule ships." The study harness
  (`test/backtest/carry/`) is the standing re-test: re-run on a materially-shifted funding regime or
  on a ~14-day cadence, whichever comes first (a loop maintenance-pass duty, playbook v2 §3(c)).
  This resolves — but does not delete — the three 2026-07-10 § Flagged bullets below that pointed at
  the carry sub-plan as live work; each is now annotated resolved-by-study in place.
- ~~**OWNER ACTION 2026-07-10 — update the scheduled loop routine to 2-4 passes/day.**~~ DONE
  2026-07-10 same session (owner-directed): the `daily-profitability-loop` scheduled routine now
  fires 3x/day (cron `0 2,10,18 * * *` local, 8h spacing — inside the playbook-v2 2-4 band); its
  prompt was refreshed for the pass-type model, the `docker compose exec` fix (plain `docker exec`
  is permission-denied), the build-before-up deploy rule, and the standing reflection/E2 watches.
- **FYI — out-of-band API contract verification spend ~$0.2 this session** (5 minimal `/v1/messages`
  calls from the app container, same pattern as the 2026-07-07 Pass-5 precedent below): real spend
  on the lane's API key that bypasses `DailyLlmBudget` accounting, incurred verifying the
  `21c9b2d` reflection retry-with-feedback fix (backlog #31) live against `claude-opus-4-8`.
  Deliberate, small, logged here for cost honesty — consistent with the Pass-5 precedent's own
  logging rationale.
- **OWNER DECISIONS 2026-07-10 (supersede this program's owner-proposal posture).** (1) **No owner
  gate on redeploy** — validated-better versions are always committed AND deployed (demo/paper
  stack) autonomously; "better" still means the unchanged ship criterion (gates green +
  out-of-sample / net-of-cost evidence + playbook §5 soak), only the human sign-off on the
  redeploy itself is removed. (2) **The daily loop (or equivalent automated process) drives the
  program** — carry sub-plan progression, feed A/B enablement, candidate iteration are loop work,
  not owner proposals. (3) **The ONLY human touch is the live-money flip** — the four live gates,
  bootId arming ceremony, and promotion gate are unchanged and remain the sole owner checkpoint.
  (4) **BINANCE_DEMO_\* keys cover futures-demo (demo-fapi) testing** — B3 runs against the demo
  environment with existing keys, no new testnet keys. Loop mandate accordingly: pick up the carry
  sub-plan (design → $0 offline funding-carry backtest on the spine → paper build behind
  PERP_VENUE_ENABLED with the B3-tracked wiring requirements → demo soak), enable-and-A/B the
  derivatives/sentiment feeds with net-of-cost attribution (+d1/+s1 promptHash tags), and deploy
  each green increment. **RESOLVED-BY-STUDY 2026-07-10 (this session), carry clause only:** the
  offline funding-carry backtest ran (`979de5e`, NO-GO 0/126) — the paper-build/demo-soak steps of
  this mandate do NOT proceed; see the CARRY TRACK RESOLVED bullet above. The feed-A/B and
  ungated-redeploy/loop-driven clauses of this decision are unaffected and remain live.
- ~~**FUNDING-CARRY CONVERGENCE STUB 2026-07-10 — prerequisites landed; the loop owns the sub-plan
  (build gated on its own offline validation).**~~ **RESOLVED-BY-STUDY 2026-07-10 (this session):**
  the sub-plan's own gate (offline validation before any build) fired NO-GO — `979de5e`, see the
  CARRY TRACK RESOLVED bullet above. None of this bullet's "deliberately NOT built here" items
  (two-legged position intent, carry entry/unwind gate, the backtest study itself) proceed to
  build; the prerequisites below stay landed and available for the next regime-shift re-test.
  Original text preserved for provenance: Delta-neutral carry (long spot + short
  equal-notional perp, earning funding with no directional call — the diagnostic-recommended
  lever) can now be designed
  on: `PaperPerpAdapter` + `funding_events` append-only accounting (b078f64), perp Risk sizing
  caps + short protective-exit + the unconsumed `expectedFundingBpsPerHold` sizing hook (6a94bc4),
  live funding/OI/basis via the derivatives feed (d76e639, flag), and funding-aware backtesting on
  the rebuilt spine (`test/backtest/funding.ts`, b30ed05, with `fetchFundingRateHistory` caching in
  `fetch-data.mjs`). Deliberately NOT built here: the two-legged position/`linkedGroupId` intent
  question, the carry entry/unwind gate (funding meaningfully positive net of fees; regime-flip
  exit), and the funding-carry backtest study — each belongs to the sub-plan, which must also
  carry the B3-tracked wiring requirements (guard-on-resolved-URL, mandatory boot config, OMS
  reduceOnly terminalization) before any adapter wiring — PLUS the INT-B3 shorts requirements
  (reviewer + security-auditor, both approve): before wiring `shortsEnabled`, widen
  `AgentDecisionMeta.action` AND `AgentPositionSummary.side` + the strategy bookkeeping chain
  (`trackClosedTrade`/`lastPositionSide`/`heldDuring`) to carry short state — until then the
  client casts at the port boundary and a wired short would corrupt journal/calibration rows; add
  a fail-loud runtime guard at the persistence boundary while wiring, then remove cast + guard
  together with the widenings. Sequencing note: carry validation (backtest over cached funding
  history) is runnable offline at $0 before any build decision.
- **EDGE DIAGNOSTIC 2026-07-10 — NO-GO; escalation: fund the carry path, drop the directional
  candidate** (`reports/loop/edge-diagnostic-2026-07-10.md`). 52 selection-corrected buckets
  (BTC/ETH × 15m–1d and 5 volatile alts × 15m, seed rule + expected-move filter k∈{1..3}): zero
  seams. Quantified gap: best qualified bucket (BTC 4h) holds +10.2bps/RT out-of-sample over 61 RT
  but deflated Sharpe 0.152 vs the 0.95 bar — an order of magnitude short; every 15m bucket
  (incl. all five volatile alts) loses 12–13bps/RT net. This extends the 2026-06-15 study's
  verdict to >1h timeframes AND to the volatile-symbol lever: the seed-rule directional edge does
  not clear the ~20bps fee wall anywhere tested. CONSEQUENCE (per the approved program's gate):
  C2/C3 candidate work (higher-timeframe/new-symbol playbook) is SKIPPED — building it would
  monetize noise. RECOMMENDED owner-gated lever, in order: (1) **delta-neutral funding carry
  (workstream E)** — the one strategy needing no directional call; its prerequisites landed this
  program (perp adapter b078f64, derivatives feed d76e639, funding-aware backtest b30ed05) and B2
  risk extension is in flight; (2) enable the derivatives/sentiment prompt feeds (flagged, $0) for
  LLM context — cheap, but expect no fee-clearing miracle; (3) fee-tier/BNB remains weak (prior:
  0/64 even @7.5bps). Directional shorts stay unfunded (52 prior short trials failed).
  **RESOLVED-BY-STUDY 2026-07-10 (this session), lever (1) only:** the recommended escalation to
  delta-neutral funding carry was itself tested and is NO-GO (`979de5e`, see the CARRY TRACK
  RESOLVED bullet above) — lever (1) is dead, not merely deferred. Levers (2) (derivatives/sentiment
  prompt feeds) and (3) (fee-tier/BNB, already weak) are unaffected by this update.
- **OWNER DECISION 2026-07-10 — edge question OPENED; consolidated edge program authorized and
  underway** (plan `open-replicated-platypus`, session-approved). Scope locked by owner: **A**
  backtest/validation spine rebuilt from `5a17615` (landed with this bullet's commit — supersedes the
  harness-retirement note of 2026-07-03; the pure strategy lane stays retired), then the offline edge
  diagnostic (timeframe >1h + volatile-symbol screens, out-of-sample, selection-corrected); **B**
  paper-first perp adapter (`binanceusdm` swap, local liq model, `funding_events`, shorts route to
  perp only); **C** free derivatives/sentiment feeds (flagged OFF) + diagnostic-gated prompt features
  and v2 candidate (INACTIVE, auto-promote pinned human-only); **D** `ENTRY_ORDER_TYPE` maker-entry
  flag (default LIMIT, unchanged); **E** funding-carry converges after A+B+C as its own gated
  sub-plan. Commit-per-green-gate; testnet keys arrive mid-run; LLM offline validation capped
  ~$10–20/gate; rails KEPT (four live gates, promotion gate, decimal money, append-only tables) —
  nothing flips live without owner sign-off. This RESOLVES the Pass-10/11 owner-decision request
  below: the chosen lever is this new owner-scope edge program (not (a) accept-slow-accrual alone,
  not (b) prescreen loosening).
- **RECOMMENDATION — cost-floor vs learning-throughput** (2026-07-08 Pass 10, playbook §3 mandate on
  two consecutive empty passes): every Stage-2 stage (reflection → INACTIVE candidate → 25% A/B →
  attributed auto-promotion) is downstream of closed round trips (all trade-gated via `onClosedTrade`,
  no wall-clock path). At the current trade rate (Stage-1 cost floor skipping ~71%, 15m cadence, plus
  quiet-market 100% holds), the exit criterion **≥2 attributed promotions + rolling-7d net ≥0 is
  unreachable in a reasonable window.** Owner decision requested among: (a) **accept slow accrual**
  (cheapest; Stage 2 may take weeks); (b) **raise trade opportunity within settled constraints** —
  loosen prescreen sensitivity toward the low end of the skip band so more decides reach the model
  and more trips close (NB no 3rd symbol / no 1m-5m are settled-off); (c) **first confirm 100%-hold is
  passivity** via the #29 full-day check before touching anything.
  **UPDATE 2026-07-08 Pass 11 — (c) done; (b) strongly indicated dead.** Structural finding
  (n-independent): at n=11 (all hold) 0 proposes + 0 rejections ⇒ holds are model-driven, no gate
  suppression. Decisive argument against (b), also sample-size-independent: loosening the prescreen
  only surfaces MORE ≈0-to-−3bps bars vs the 20bps fee hurdle — even if some traded they are −EV and
  cannot move net-of-cost to ≥0 (the Stage-2 exit), so (b) spends more LLM without advancing the exit.
  Corroboration (n=11, weaker): all 11 higher-signal `called` bars still held. The one un-run confirmer
  is the owner-SQL on the holds' `rationale`/`input_payload` (flagged Pass 10); until it runs, treat
  "(b) dead" as strongly indicated, not proven. The live remaining choices are **(a) accept slow
  accrual** OR a NEW owner-scope lever that adds real edge without a settled-off constraint (e.g. a
  different signal source / a change to the seed-playbook entry criteria), which only the owner can
  authorize. Pass recommendation: **(a)** unless the owner wants to open the edge question — a pass
  cannot manufacture edge within current constraints.
  **UPDATE 2026-07-09 Pass 12 — throughput is no longer strictly starved.** Boot `f75b6dfc`'s full-day
  window closed **4 round trips** and the model **proposed** (6/37 decides) — so the "learning loop is
  throughput-starved" half of this flag is partly overtaken by events. BUT the loop still couldn't
  learn, for a different reason: the one reflection that triggered aborted on a 30s timeout (fixed this
  pass, `ef325f6`). Once reflection actually completes (pending confirmation), the live question narrows
  to exactly (a)-vs-edge: can the reflection loop turn the v1 seed's −EV entries (4 RT, net −$2.02) into
  net-≥0, or is the owner-scope edge lever still needed? That answer needs ≥1 completed reflection +
  its A/B attribution — which the timeout fix now makes reachable. Recommendation stands at **(a) accept
  slow accrual** and watch the first post-fix reflection outcome before any scope change.
  - **Sub-option, FLAGGED NOT RECOMMENDED — wall-clock reflection trigger** (`AGENTIC_REFLECTION_MAX_IDLE_MS`):
    lets reflection fire without new trades, BUT with no new closed trips it re-processes the same 32
    historical trips → almost certainly hits the `NO_CHANGE` hash guard (`reflection.service.ts:638`)
    or invents a revision off stale evidence. Does NOT unblock learning; only spends Opus. Only worth
    it paired with a `closedSinceLastReflection == 0` skip gate. Owner call.

- **True-spend cost accounting** (2026-07-07 Pass 8): the cache is verified working
  (`f5221b9` made it measurable; first window: 2775-token prefix, 3 reads) — a net SAVING vs an
  uncached prompt, but the flat 3/15 `llmCostUsd` in the promotion gate and every $/day read
  prices only `input/output`, undercounting true billing (~1.5× in the creation-heavy first
  window; cache reads bill at 0.3, 1h-TTL writes at 6.0 $/MTok). Decision requested: bless
  folding cache economics into the promotion cost formula (stricter, honest-cost direction) via
  backlog #27 — the analytics columns + journal plumbing halves are autonomous, the gate-formula
  change is not. Until then, Stage-1's ≤$1/day should be sanity-checked against the Prometheus
  cache series, not just the DB gauge.
- **FYI — `ReconciliationMismatch` now pages at warning** (2026-07-07 Pass 8, `a25389a`): it was
  firing 24/7 at critical on the shared wallet's foreign-order steady state. Halting classes
  still page critical via the new `ReconciliationHalt` (+ `KillSwitchEngaged`). Interim until
  #24's class split; revert trivially if you prefer the noise.

- ~~**BLOCKER — ANTHROPIC_API_KEY** (2026-07-06)~~ — RESOLVED 2026-07-06 ~22:15: owner re-added the
  key to `.env` (the slimmed rewrite had dropped the line); container recreated,
  `agent_client_info{kind="anthropic"}`, first live window confirmed — 3 Sonnet decides
  (1 proposed, 0 rejections), 12.6k in/0.8k out tokens (~1.7¢/decide), and the FIRST production
  `skipped_quiet` prescreen save. Projected ~$1.0–1.6/day at the 50–70% skip target → backlog #10
  (threshold tuning) is now the live lever; Stage-1 exit-criterion measurement starts with the
  next daily pass.

- ~~**Marketable exits** (2026-07-05)~~ — CLOSED 2026-07-06 Pass 1: `position-sizer.service.ts:72,139`
  confirms reduce-only exits cross the spread by `EXIT_CROSS_BUFFER_BPS` (P1 f9ba515).
- **Dust-threshold round-trip accounting** (2026-07-05): `portfolio-state.service.ts` records a
  round trip only at exactly-zero signed qty; touches realized-PnL accounting — RESOLVED
  2026-07-07: owner approved a metrics-only fix (W2.2 of the approved plan) — round-trip metrics
  emit at residual notional ≤ PROMOTION_DUST_NOTIONAL; position/cash semantics untouched.
- **55–57 stale open orders on the demo venue** (2026-07-07, re-diagnosed by Passes 6–7): NOT
  venue-open resting GTC entries after all — Pass 6 established the venue no longer lists them
  (our-prefix venue orders absent locally would HALT UNKNOWN_OURS; 174+ clean passes say no), and
  Pass 7's boot data shows they persist as `SUBMIT_UNKNOWN` rows (61 seeded, only 4 in
  venue-confirmed states). So: no locked demo balance, no venue cleanup needed — they are journal
  residue that keeps `hasUnresolvedOrders()` true and will refuse live arming someday. Resolution
  is backlog #25 (journaled one-time sweep, owner-authorized).
- ~~**Uncommitted Grafana dashboard edit** (predates Pass 3)~~ — CLOSED 2026-07-07: owner took
  ownership and committed it (`ba488ec`, then restructure `c7865df`); tree clean at Pass 5 start.
- ~~**Latch observability gap** (2026-07-07 Pass 5)~~ — RESOLVED 2026-07-07 Pass 8: backlog #20
  shipped (`a25389a`, `AgentClientFatalLatch` critical alert); a future latch pages instead of
  dying silently.
- **Out-of-band verification spend** (2026-07-07 Pass 5): ~5 minimal /v1/messages calls (~$0.02)
  were sent from inside the app container to reproduce and verify the 400 fix — real spend on the
  lane's API key that bypasses DailyLlmBudget accounting. Deliberate, tiny, and logged here for
  cost honesty.

- ~~**RECONCILIATION DEAD + RESTART HAZARD** (2026-07-07 Pass 6)~~ — RESOLVED 2026-07-07 Pass 7:
  owner authorized the fix package same day; `f5ce2c0` shipped (reviewer-approved, full gates),
  deployed 16:26 boot 28dc56a2. Self-heal verified live: boot degraded the stranded order to a
  now-portfolio-visible CANCEL_UNKNOWN and the FIRST reconcile pass adopted venue truth and
  retired it; zero pass errors since, all axes running. Restart hazard lifted — recovered
  venue-confirmed orders now register in the portfolio open set, so reconciliation and the TTL
  sweep both see them. Residue split into #24 (foreign-order alert noise) and #25 (the 57
  `SUBMIT_UNKNOWN` zombies — NOT auto-healed by design, still block future live arming).

- **Alerting was dead since first boot** (2026-07-07 Pass 6, FIXED same pass): alerts.rules.yml
  was never mounted into the prometheus container — `rule_files` glob matched nothing, zero rule
  groups loaded, every Phase-10 alert inert since the stack was built. Fixed in `239edf0` (mount +
  2 new reconciler rules). Pass 7 closed the residue: the compose mount is now exercised (two
  prometheus recreates load 9/9 rules from it) and TSDB history survived both (anonymous volume).
  Pass 7 also re-keyed ReconcilerStalled to pass-completion (`378f88b`) after live soak showed
  the clean-pass variant false-fires forever on the shared wallet's foreign resting orders.
  Remaining known noise: ReconciliationMismatch fires continuously on that same foreign-order
  steady state until #24 splits the counter by class — MITIGATED 2026-07-07 Pass 8 (`a25389a`):
  downgraded to warning; halting classes page via the new `ReconciliationHalt` critical rule.
