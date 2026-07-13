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
  planMode AND a perp venue (spot+shorts throws); **boot refuses shorts+portfolio-consult** (the
  strict portfolio tool has no direction field) → backlog #41 is the unblock. Two adversarial
  review rounds, all findings fixed + test-pinned (incl. the pre-existing protective-exit
  BUY-block rule that would have frozen a SHORT's stop; list: LOG.md). Perp DEFAULT_FILTERS rows
  are live fapi exchangeInfo figures fetched 2026-07-13. **DEPLOY CHECKLIST (before the perp
  deployment ever arms):** pin venue-side leverage=1 + isolated margin mode explicitly at adapter
  init (account defaults NOT trusted), re-run the arm preconditions, start with ONE symbol
  (+ backlog #51).

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

**Pass 23, 2026-07-13** (scheduled run, ~16:05–17:45Z) — **MAINTENANCE report-only: Push-II
Phase-1 and Phase-3 watches RESOLVED POSITIVE; orders-timestamp analytics gap flagged (#40);
nothing shipped in src/ (owner session actively landing Phase 8 + consult-enable mid-pass).**
Evidence sweep on boot `09c6bcaa` (Phase-4 image, 13:40Z): 0 errors, 0 EXPIRED, reconcile
**308/0/0 (first zero-foreign-mismatch sweep)**, kill switch RUNNING, duty cycle 100%/24h.
Scoreboard: RT=10 (all v1, all losses; champion v1 now AT the symmetric 10-trip floor), net
−$7.82, LLM $3.74, window 0.90d; equity $4,990.45 (dd 0.19%, trade-explained — RT #10 = the
LIMIT_MAKER-watch LINK trip, −$0.66%+fees). Cost epoch-average $2.83/day (burst ~$3.7/day
09→16Z was 5-open-position consult load; flat-market boot rate ~$1.6/day) — **cost watch armed,
not firing**. Prescreen 80% skip (above band; flat tape, n=50, no knob change). Corpus 373.
Harness probe green (15). Phase-2 (venue TP) and Phase-4/#39 (v2 lapse → v3 mint) watches
PENDING — no reflection attempt all day (`llm_usage` 0 rows; the 11:45:34Z close hit the
first-close-after-boot seed race, and the 17:09Z recreate re-reset primes). Pass-start dirty
tree (22 files, Phase-8 WIP) honored: no builds/deploys/recreates all pass; mid-pass the owner
landed `34e4728` (perp venue + shorts, flag-off) / `46996aa` / `1d33326` (portfolio consult
ON) / `d2e7601` (close-out) and deployed boot `f9c2b321` 17:09Z (banner shows
`BatchingAgentClient`; no `submit_portfolio` yet at pass end — **Phase-5 WATCH is next pass's
first check**). Gates full green at post-land HEAD (build/lint/typecheck/**1904 unit** + eval
15). Backup `cryptobot-20260713T172335Z.sql.gz`. Process note: plan-mode interrupt mid-pass
(plan approved same session — Pass 3 precedent). Empty-pass counter 0 (day shipped via Passes
21/22 + owner session; this pass ships report+watch-verdicts only). Full detail in LOG.md.

**Passes 2–22 and the owner-session summaries:** `reports/loop/LOG.md` (dated entries; state.md
stopped duplicating them 2026-07-13).

## Backlog (ranked; re-rank each pass)

Conventions: IDs are stable and never renumbered (LOG.md references them). **Re-verify a backlog
item against current code before implementing it** (Pass 2 precedent — inherited items go stale).
Open items first; the closed ledger keeps one line per retired ID. Current top of the queue:
**#41** (unblocks Phase-8 enablement), **#25** (last live-arming-prep item), **#42** (queued
behind the info-context A/B verdict).

### Open

| # | Item | Stage | Effort | Status / next check |
| --- | --- | --- | --- | --- |
| 18 | Per-hour/session expectancy gating (last residual of the W4.4 seeds — fee-tier/BNB dropped: demo fees flat 10bps, § Standing verdicts; trade-flow widening shipped Phase 3) | 2+ | M | seed — needs design + data |
| 22 | Named prometheus TSDB volume (`prometheus_data:/prometheus`) — verified 2026-07-13 still absent; anon volume survives recreates but not `down -v` | 1 | S | open, low priority; one compose line + one recreate |
| 24 | Split `reconciliation_mismatch_total` by mismatch class (foreign / adopted-terminal / sweep-failure / would-halt) so the alert can page critical again — verified 2026-07-13 still class-blind (`reconciliation.service.ts:51`) | 1 | S | open — OWNER/OMS territory; urgency reduced (current boot: 0 foreign mismatches) but split still right for halt-class visibility |
| 25 | Resolve the 2 remaining unresolved-terminal fixture rows (live-mode ACKED + paper NEW, 2026-07-10 wipe remediation) that keep `hasUnresolvedOrders()` true outside testnet — the 57 SUBMIT_UNKNOWN zombies are healed history (`b00c886`+W7; testnet unresolved = 0, verified Pass 23) | 1 | M | open — LAST live-arming-prep item; vehicle `scripts/resolve-stale-orders.mjs`, dry-run-first; touches OMS rows ⇒ reviewer-gated |
| 30 | CI step for `pnpm eval:agentic` non-live specs — verified 2026-07-13 `ci.yml` still has no eval step; exact one-line diff in LOG.md Pass 11; interim §2.6 every-pass probe holds | 1 | S | open — OWNER territory (ci.yml, no-push rule) |
| 32 | Stream the reflection LLM call (SSE) — removes the wall-clock timeout ceiling behind `AGENTIC_REFLECTION_TIMEOUT_MS`; verified 2026-07-13 still a single non-streaming POST | 2 | M | open — agentic-lane, autonomous |
| 40 | Stamp `orders.submitted_at`/`acked_at`/`first_fill_at` at their OMS state-gate transitions (+ best-effort backfill from `order_events`) — NULL on all rows today; `updateState` accepts them, no caller passes, nothing reads them (`terminal_at` IS stamped, W7). Analytics/latency-audit gap, not a trading defect | 2 | S | open — OWNER/OMS territory (found Pass 23) |
| 41 | PORTFOLIO_SHORTS_TOOL — direction field for batched shorts. **Load-bearing:** boot refuses `AGENTIC_SHORTS_ENABLED` + `AGENTIC_PORTFOLIO_CONSULT` (strict portfolio tool has no direction field), so Phase-8 enablement is blocked on this while consult is ON | 2 | M | open — agentic-lane (Push II seed) |
| 42 | `AGENTIC_THINKING_AB_PCT` live adaptive-thinking A/B arm (low/medium effort) — Phase-6 study: +12bps proxy, 4× propose, 1.9× cost, no-flip but strongest lever surfaced | 2 | M | QUEUED behind the info-context A/B verdict — one measured channel at a time |
| 43 | Liquidation-order flow feed — market-wide is WS-only `!forceOrder@arr` (REST forceOrders is private per-account); needs WS plumbing justification | 2+ | L | seed (Push II Phase 3) |
| 44 | Spot OCO exits (fuse executor stop + venue TP into one venue-side pair) — needs demo `orderList/oco` support proof; ccxt 4.5.58 has no unified spot OCO | 2 | M | seed (Push II Phase 2) |
| 45 | Trailing-stop plan field — wait for venue-TP capture data (Phase-2 WATCH counters) before designing | 2 | M | seed (Push II) |
| 46 | Thompson multi-candidate A/B routing (replaces the newest-candidate-only slot) | 2+ | M | seed (Push II) |
| 47 | Adaptive consult cadence (vary the 15m consult rhythm by regime) | 2 | M | seed (Push II) |
| 48 | Weekly vol-ranked symbol rotation (universe-study follow-on) | 2 | M | seed (Push II Phase 7) |
| 49 | Signal-sink cross-signal pair atomicity — protective fire vs concurrent TP re-place (self-healing TERMINAL_REJECT today). Exceeds the signal-sink scope exception (CANCEL_OPEN routing only) | 2 | M | seed — OWNER/reviewer-gated (Push II Phase 2) |
| 50 | `runReflection` outer 'run failed' catch records no outcome and does not roll back the trigger — near-unreachable (malformed journal data only) | 2 | S | seed (Push II Phase 4) |
| 51 | Perp deploy pinning — venue-side leverage=1 + isolated margin at adapter init, arm-precondition re-run, one-symbol start (the Phase-8 deploy checklist) | 2 | S | travels with #41/Phase-8 enablement — OWNER-scoped |
| 52 | W12 operational event logging (structured ops events; 2026-07-08 follow-up, deferred since) | 1–2 | M | seed — needs design |

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
- **CI gap:** backlog #30 (eval specs in ci.yml) — owner-territory; exact diff in LOG.md Pass 11.

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
