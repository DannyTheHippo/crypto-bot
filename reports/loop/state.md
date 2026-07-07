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
| 7   | Per-playbook-version net-PnL attribution (query/panel)                                                                                                                                                                                                                                           | 2     | M      | pending — suggested shape (Pass 2): app-side sampler exporting `agentic_version_net_pnl_usd{version}` gauges (promotion-metrics pattern; Grafana has no postgres datasource, so a DB-join panel is not directly renderable)                                                                                                                                                                                                                                                                                                                        |
| 8   | Cross-field boot validation: `AGENTIC_WARMUP_BARS >= PRESCREEN_VOL_LONG_BARS/BREAKOUT_LOOKBACK` (zod superRefine; undersized warmup silently no-ops the cost floor via permanent fail-open)                                                                                                      | 1     | S      | DONE 2026-07-06 Pass 1 (deployed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 9   | prescreen.ts: route non-positive/NaN-producing candle values to `insufficient_data` (total fail-open guarantee; today NaN comparisons fall through to quiet=skip)                                                                                                                                | 1     | S      | DONE 2026-07-06 Pass 1 (deployed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 10  | Tune `AGENTIC_PRESCREEN_BREAKOUT_PCT` (0.005) tighter (toward 0.002-0.003) and/or revisit `BREAKOUT_LOOKBACK_BARS` (20) toward the 50–70% skip target                                                                                                                                            | 1     | S      | RE-SCOPED 2026-07-07 Pass 3 with measured data: `agentic_prescreen_total` reason breakdown (shipped this pass) shows `breakout_proximity` drives 37/51 (~73%) of `called` outcomes vs `position_open` 14/51 (~27%) — the ORIGINAL wording (tune VOL_RATIO/BREAKOUT_PCT) was right, `position_open`'s early-return was a red herring the pass caught via advisor consult before shipping the wrong fix. Skip rate 13/64≈20.3%, still under 50-70% target. Re-verify against a few more days of data before picking an exact new BREAKOUT_PCT value. |
| 11  | Reflection model back to Opus? Only with per-model pricing at read time (llm_usage/agent_decisions carry model columns) — flat 3/15 must stay honest                                                                                                                                             | 2     | M      | pending (deferred by owner 2026-07-06)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 12  | Let `evaluatePrescreen`'s quiet-detection apply while a position is open (drop the unconditional `position_open` early-return, `prescreen.ts:87-89`), gated on a derived `protectiveExitActive` flag so behavior is unchanged whenever `PROTECT_STOP_LOSS_PCT`/`PROTECT_TRAILING_PCT` are both 0 | 1     | M      | pending, LOWER PRIORITY after Pass 3's data (`position_open` is only ~27% of `called`, `breakout_proximity` ~73% — #10 is the bigger lever); full design in `reports/loop/LOG.md` Pass 3 "Deferred candidate" entry — PnL-side cadence tradeoff, not a free correctness fix, argue honestly when picked up                                                                                                                                                                                                                                         |

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
- **55 stale open orders on the demo venue** (2026-07-07): boot recovery seeded 55 open orders
  (boot 10c8af0c) — rest-forever GTC entries accumulated across prior boots, locking demo quote
  balance venue-side. W2.1 (entry TTL + CANCEL_OPEN) prevents new accumulation; the EXISTING 55
  need a one-time cleanup (venue-side cancel sweep or demo account reset) — owner action or an
  explicitly authorized pass.
- **Uncommitted Grafana dashboard edit** (predates Pass 3, still open): working tree has had an
  uncommitted `observability/grafana/dashboards/crypto-bot.json` diff (reformatted JSON + a
  promotion-readiness panel description/mapping change) since before this pass started — not
  authored by any loop pass. Pass 3 stashed/restored it intact around its own commit rather than
  touching or discarding it (dirty-tree rule). Owner should check whether the edit was intentional
  and commit or discard it directly.
