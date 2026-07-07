# Daily profitability loop — state

Playbook (durable procedure): `docs/planning/daily-profitability-loop.md`

## Strategic frame

The mutable strategy the playbook deliberately does not embed. Passes update stage status here;
when the owner approves a new spec, replace the pointer (and archive the old spec) — the playbook
never changes for strategy evolution.

- **Active spec:** `docs/specs/2026-07-06-profitability-design.md` (owner-approved 2026-07-06).
- **Goal:** real live profitability at **$1k–$5k capital** (owner, 2026-07-06). Objective
  function: net-of-cost PnL = `realizedPnl − fees − llmCostUsd`.
- **Stage ladder + exit criteria (condensed from the active spec):**
  1. **Cost floor** — LLM spend ≤$1/day for ≥3 consecutive days AND round trips ≥2/day AND no
     `EXPIRED`/starved-exit regressions.
  2. **Learning-loop edge** — ≥2 playbook promotions with version-attributed PnL AND rolling-7d
     net-of-cost PnL ≥0.
  3. **Earned-live** — pass the coded promotion gate (`PromotionReadinessService`: ≥30 closed demo
     round trips, net-of-cost > 0, ≥14d window), then the unchanged human four-gate arming
     ceremony. Nothing automates live.
- **Settled owner decisions (not re-openable by a pass; argue in "Flagged for human review"
  instead):** no shorts/futures/margin; no third symbol until the Stage-2 exit criterion holds;
  no model below Sonnet-5; no return to 1m/5m cadence. _("No prompt caching" pruned 2026-07-07 by
  owner decision — its factual grounds were stale; the falsifiable cache experiment (W2.4 of the
  2026-07-07 approved plan) is authorized and reverts if `cache_read_input_tokens` stays 0.)_
- **Pre-authorization (owner, 2026-07-07):** IF net-of-cost > 0 AND round trips ≥ 30 before the
  14-day window fills, `MIN_WINDOW_DAYS` 14→10 (`promotion-readiness.service.ts:15`) may be
  applied with the owner sign-off recorded in the pass report. The ≥30-trips and positive-net
  thresholds are NOT relaxable.

## Current stage

**Stage 1 — cost floor, DEPLOYED 2026-07-06** (soak pending confirmation; Stage-1 exit criterion:
≥3 consecutive days ≤$1/day LLM spend, round trips ≥2/day, no EXPIRED/starved-exit regressions).
Stage 0 verified same day: promotion gauges recovered post-restart (23 RTs, net −$14.72, LLM
$11.53, window 1.83d) and the readiness walk pools cycles across (strategyId, symbol) with a
mode-only fill filter — pre-multi-symbol evidence counts.

## Last pass

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

| #   | Item                                                                                                                                                                                                                                                                                             | Stage | Effort | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Verify `agentic_promotion_*` gauges recover post-restart and count pre-multi-symbol round trips (strategyId `agentic` → `agentic-1`/`-2`)                                                                                                                                                        | 0     | S      | DONE 2026-07-06 (verified live)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2   | Verify Grafana "Agentic lane (LLM)" panels render $/day spend + net-of-cost PnL                                                                                                                                                                                                                  | 0     | S      | DONE 2026-07-06 Pass 1 (API render check: 55 panels, rows 80/89/90/130/142 present)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3   | `STRATEGY_INTERVAL` 5m → 15m + fix false `AGENTIC_MAX_CALLS_PER_DAY` comment (compose + .env.example)                                                                                                                                                                                            | 1     | S      | DONE 2026-07-06 (deployed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | Deterministic pre-screen gate ahead of LLM call (`AGENTIC_PRESCREEN_*`, counter, fail-open)                                                                                                                                                                                                      | 1     | M      | DONE 2026-07-06 (deployed; reviewer-approved, 4 should-fix applied: digest excludes model='prescreen', skips kept out of recentDecisions ring, latency null, ordering test)                                                                                                                                                                                                                                                                                                                                                                        |
| 5   | Fix scoring biases in `counterfactual-scoring.ts` (FLAT-on-fall rewarded; open PnL excluded)                                                                                                                                                                                                     | 2     | S      | CLOSED-STALE 2026-07-06 Pass 2: both already fixed since the 07-04 analysis — exposure-based isHit (F2, counterfactual-scoring.ts:113-124) is an exact complement split, and the open-at-end exclusion is deliberate/documented (`openAtEnd`) with reflection fed by realized venue round trips                                                                                                                                                                                                                                                    |
| 6   | Inject order-book depth into prompt (`agent-prompt.ts:146-148`), token-budgeted                                                                                                                                                                                                                  | 2     | S      | CLOSED-STALE 2026-07-06 Pass 2: prompt v3 (d41b35f) landed `buildOrderBookBlock` — top-of-book levels, spread bps, imbalance ratio already rendered                                                                                                                                                                                                                                                                                                                                                                                                |
| 7   | Per-playbook-version net-PnL attribution (query/panel)                                                                                                                                                                                                                                           | 2     | M      | DONE 2026-07-07 Pass 4 (`agentic_version_net_pnl_usd{version}` + `agentic_version_round_trips{version}` sampler shipped; Grafana panel pending — blocked on the unowned dirty dashboard JSON, see backlog #19)                                                                                                                                                                                                                                                                                                                                     |
| 8   | Cross-field boot validation: `AGENTIC_WARMUP_BARS >= PRESCREEN_VOL_LONG_BARS/BREAKOUT_LOOKBACK` (zod superRefine; undersized warmup silently no-ops the cost floor via permanent fail-open)                                                                                                      | 1     | S      | DONE 2026-07-06 Pass 1 (deployed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 9   | prescreen.ts: route non-positive/NaN-producing candle values to `insufficient_data` (total fail-open guarantee; today NaN comparisons fall through to quiet=skip)                                                                                                                                | 1     | S      | DONE 2026-07-06 Pass 1 (deployed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 10  | Tune `AGENTIC_PRESCREEN_BREAKOUT_PCT` (0.005) tighter (toward 0.002-0.003) and/or revisit `BREAKOUT_LOOKBACK_BARS` (20) toward the 50–70% skip target                                                                                                                                            | 1     | S      | RE-SCOPED 2026-07-07 Pass 3 with measured data: `agentic_prescreen_total` reason breakdown (shipped this pass) shows `breakout_proximity` drives 37/51 (~73%) of `called` outcomes vs `position_open` 14/51 (~27%) — the ORIGINAL wording (tune VOL_RATIO/BREAKOUT_PCT) was right, `position_open`'s early-return was a red herring the pass caught via advisor consult before shipping the wrong fix. Skip rate 13/64≈20.3%, still under 50-70% target. Re-verify against a few more days of data before picking an exact new BREAKOUT_PCT value. |
| 11  | Reflection model back to Opus? Only with per-model pricing at read time (llm_usage/agent_decisions carry model columns) — flat 3/15 must stay honest                                                                                                                                             | 2     | M      | pending (deferred by owner 2026-07-06)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 12  | Let `evaluatePrescreen`'s quiet-detection apply while a position is open (drop the unconditional `position_open` early-return, `prescreen.ts:87-89`), gated on a derived `protectiveExitActive` flag so behavior is unchanged whenever `PROTECT_STOP_LOSS_PCT`/`PROTECT_TRAILING_PCT` are both 0 | 1     | M      | pending, LOWER PRIORITY after Pass 3's data (`position_open` is only ~27% of `called`, `breakout_proximity` ~73% — #10 is the bigger lever); NOTE 2026-07-07: AGENTIC_PLAN_MODE (once enabled) supersedes this entirely — plan-managed bars skip the LLM while long                                                                                                                                                                                                                                                                                |
| 13  | Verify the prompt-cache experiment (W2.4): `cache_read_input_tokens` > 0 within a day of decides, else revert the cache_control blocks (falsifiability commitment)                                                                                                                               | 1     | S      | pending; Pass 5 note: no cache token series exists in Prometheus — verification needs the DB usage columns (emit SQL for owner) or a small metrics addition first. Decide clock effectively restarted 13:18 2026-07-07 (lane was dead before)                                                                                                                                                                                                                                                                                                      |
| 14  | Measure post-Pass-4 skip rate + $/day at breakout 0.0025 and thinking-off; re-tune toward 50-70% skip / ≤$1/day                                                                                                                                                                                  | 1     | S      | pending (Stage-1 exit measurement continues)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15  | ~~AGENTIC_PLAN_MODE enable-gate~~ ENABLED by owner 2026-07-07 (offline-A/B pre-check waived by owner decision; the recorded-input harness + executor param sweep remain the POST-hoc validators — run them once ≥200 input_payload rows accrue and report divergence)                            | 2     | M      | ENABLED 2026-07-07; VERIFIED LIVE by Pass 5 (first `submit_plan` decide + plan-priced entry at the 13:45 bar, after fixing the 400 that had latched the lane). Post-hoc validation still pending row accrual                                                                                                                                                                                                                                                                                                                                       |
| 16  | Flag-enable decisions once attribution accrues: AGENTIC_PLAYBOOK_AB_PCT (candidate evidence pre-promotion) and AGENTIC_EXPECTANCY_LADDER; AGENTIC_AUTO_PROMOTE_MIN_TRADES 30→20 only after ≥1 clean attributed promotion                                                                         | 2     | S      | pending                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 17  | W2.6 cross-symbol + self-track-record prompt block (≤300 tok, validated via the offline harness)                                                                                                                                                                                                 | 2     | S      | pending (deferred from Pass 4 — file-scope conflict with plan-mode work)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 18  | W4.4 seeds: per-hour/session expectancy gating; bounded knob-learning channel for reflection (needs validator design); fee-tier/BNB-discount paper modeling (live-prep); trade-flow snapshot widening                                                                                            | 2+    | M-L    | seeds (each needs data or design first)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 19  | Grafana panels for the new series (cache tokens, `outcome="noop"` split — per-version panels shipped by owner in `ba488ec`)                                                                                                                                                                      | 1     | S      | UNBLOCKED 2026-07-07 Pass 5: owner took ownership of the dashboard (`ba488ec`, `c7865df`) — tree clean, remaining panels can ship in a normal pass                                                                                                                                                                                                                                                                                                                                                                                                 |
| 20  | Degraded-latch observability: `agent_client_degraded` gauge (or alert on `agent_decide_total{outcome="error_fatal"} > 0`) + Grafana alert — a FATAL latch currently emits one warn line and the lane silently dies (cost ~1h dead air on 2026-07-07)                                             | 1     | S      | pending (seeded by Pass 5's incident)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 21  | Verify the entry-TTL sweep actually covers boot-RECOVERED open orders: boot b61908ba re-seeded 57 stale orders and no CANCEL_OPEN fired during the Pass-5 soak — Pass 4's "sweep clears them organically" assumption is unverified; recovered orders may lack sweep-eligible tracking            | 1     | S      | pending (watch next pass; if not swept, propose venue-side one-time cleanup to owner)                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Flagged for human review (open)

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
- **55–57 stale open orders on the demo venue** (2026-07-07, updated by Pass 5): rest-forever GTC
  entries accumulated across prior boots, locking demo quote balance venue-side; every boot
  recovery re-seeds them (57 on boots de36fa2d and b61908ba). W2.1 (entry TTL + CANCEL_OPEN)
  prevents NEW accumulation, but Pass 5 observed no CANCEL_OPEN on the recovered set during its
  soak — whether the sweep covers boot-recovered orders is unverified (backlog #21). If it does
  not, the one-time cleanup (venue-side cancel sweep or demo account reset) remains owner action
  or an explicitly authorized pass.
- ~~**Uncommitted Grafana dashboard edit** (predates Pass 3)~~ — CLOSED 2026-07-07: owner took
  ownership and committed it (`ba488ec`, then restructure `c7865df`); tree clean at Pass 5 start.
- **Latch observability gap** (2026-07-07 Pass 5): a FATAL API error latches the agent client to
  degraded with a single warn line — the lane silently makes zero LLM calls until the next
  container recreate (cost ~1h dead air today). Backlog #20 proposes the gauge/alert; needs no
  owner decision to implement, listed here for visibility of the risk until it ships.
- **Out-of-band verification spend** (2026-07-07 Pass 5): ~5 minimal /v1/messages calls (~$0.02)
  were sent from inside the app container to reproduce and verify the 400 fix — real spend on the
  lane's API key that bypasses DailyLlmBudget accounting. Deliberate, tiny, and logged here for
  cost honesty.
