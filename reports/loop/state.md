# Daily profitability loop — state

Playbook: `docs/planning/daily-profitability-loop.md` · Spec: `docs/specs/2026-07-06-profitability-design.md`

## Current stage

**Stage 1 — cost floor, DEPLOYED 2026-07-06** (soak pending confirmation; Stage-1 exit criterion:
≥3 consecutive days ≤$1/day LLM spend, round trips ≥2/day, no EXPIRED/starved-exit regressions).
Stage 0 verified same day: promotion gauges recovered post-restart (23 RTs, net −$14.72, LLM
$11.53, window 1.83d) and the readiness walk pools cycles across (strategyId, symbol) with a
mode-only fill filter — pre-multi-symbol evidence counts.

## Last pass

**Pass 2, 2026-07-06** (owner-triggered; LOG.md has Passes 0–2). Snapshot at Pass 2: readiness 26
round trips, net −$15.97, ready=0; equity ~4997.7; 2 symbols (agentic-1 BTC/USDT, agentic-2
ETH/USDT), playbook seed v1. **Post-Pass-2 update (~22:15): key blocker RESOLVED — lane LIVE on
Sonnet** (see resolved flag below; first window: 3 decides, 1 proposed, first `skipped_quiet`,
~1.7¢/decide). Empty-pass counter: 1 of 2 (Pass 2 shipped no code — stale-backlog pruning only);
counter resets naturally now that live data unblocks #10. Tree committed through `501208a`; a
loop pass must never commit changes it didn't author.

## Backlog (ranked; re-rank each pass)

| #   | Item                                                                                                                                                                                        | Stage | Effort | Status                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Verify `agentic_promotion_*` gauges recover post-restart and count pre-multi-symbol round trips (strategyId `agentic` → `agentic-1`/`-2`)                                                   | 0     | S      | DONE 2026-07-06 (verified live)                                                                                                                                                                                                                                                                 |
| 2   | Verify Grafana "Agentic lane (LLM)" panels render $/day spend + net-of-cost PnL                                                                                                             | 0     | S      | DONE 2026-07-06 Pass 1 (API render check: 55 panels, rows 80/89/90/130/142 present)                                                                                                                                                                                                             |
| 3   | `STRATEGY_INTERVAL` 5m → 15m + fix false `AGENTIC_MAX_CALLS_PER_DAY` comment (compose + .env.example)                                                                                       | 1     | S      | DONE 2026-07-06 (deployed)                                                                                                                                                                                                                                                                      |
| 4   | Deterministic pre-screen gate ahead of LLM call (`AGENTIC_PRESCREEN_*`, counter, fail-open)                                                                                                 | 1     | M      | DONE 2026-07-06 (deployed; reviewer-approved, 4 should-fix applied: digest excludes model='prescreen', skips kept out of recentDecisions ring, latency null, ordering test)                                                                                                                     |
| 5   | Fix scoring biases in `counterfactual-scoring.ts` (FLAT-on-fall rewarded; open PnL excluded)                                                                                                | 2     | S      | CLOSED-STALE 2026-07-06 Pass 2: both already fixed since the 07-04 analysis — exposure-based isHit (F2, counterfactual-scoring.ts:113-124) is an exact complement split, and the open-at-end exclusion is deliberate/documented (`openAtEnd`) with reflection fed by realized venue round trips |
| 6   | Inject order-book depth into prompt (`agent-prompt.ts:146-148`), token-budgeted                                                                                                             | 2     | S      | CLOSED-STALE 2026-07-06 Pass 2: prompt v3 (d41b35f) landed `buildOrderBookBlock` — top-of-book levels, spread bps, imbalance ratio already rendered                                                                                                                                             |
| 7   | Per-playbook-version net-PnL attribution (query/panel)                                                                                                                                      | 2     | M      | pending — suggested shape (Pass 2): app-side sampler exporting `agentic_version_net_pnl_usd{version}` gauges (promotion-metrics pattern; Grafana has no postgres datasource, so a DB-join panel is not directly renderable)                                                                     |
| 8   | Cross-field boot validation: `AGENTIC_WARMUP_BARS >= PRESCREEN_VOL_LONG_BARS/BREAKOUT_LOOKBACK` (zod superRefine; undersized warmup silently no-ops the cost floor via permanent fail-open) | 1     | S      | DONE 2026-07-06 Pass 1 (deployed)                                                                                                                                                                                                                                                               |
| 9   | prescreen.ts: route non-positive/NaN-producing candle values to `insufficient_data` (total fail-open guarantee; today NaN comparisons fall through to quiet=skip)                           | 1     | S      | DONE 2026-07-06 Pass 1 (deployed)                                                                                                                                                                                                                                                               |
| 10  | Watch first prescreen skip-rate days; tune VOL_RATIO/BREAKOUT_PCT against the counter toward the 50–70% skip target                                                                         | 1     | S      | pending (needs live data)                                                                                                                                                                                                                                                                       |
| 11  | Reflection model back to Opus? Only with per-model pricing at read time (llm_usage/agent_decisions carry model columns) — flat 3/15 must stay honest                                        | 2     | M      | pending (deferred by owner 2026-07-06)                                                                                                                                                                                                                                                          |

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
  round trip only at exactly-zero signed qty; touches realized-PnL accounting — needs owner call.
