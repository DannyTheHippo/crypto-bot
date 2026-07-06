# Daily profitability loop — state

Playbook: `docs/planning/daily-profitability-loop.md` · Spec: `docs/specs/2026-07-06-profitability-design.md`

## Current stage

**Stage 1 — cost floor, DEPLOYED 2026-07-06** (soak pending confirmation; Stage-1 exit criterion:
≥3 consecutive days ≤$1/day LLM spend, round trips ≥2/day, no EXPIRED/starved-exit regressions).
Stage 0 verified same day: promotion gauges recovered post-restart (23 RTs, net −$14.72, LLM
$11.53, window 1.83d) and the readiness walk pools cycles across (strategyId, symbol) with a
mode-only fill filter — pre-multi-symbol evidence counts.

## Last pass

None yet — loop not started. Baseline (2026-07-06, epic close): readiness 23 round trips, net
−$14.52 (LLM $11.33), window 1.8d, ready=0; app restarted 2026-07-06 with 2 symbols (agentic-1
BTC/USDT, agentic-2 ETH/USDT), playbook seed v1, equity 4998.25. NOTE: the P4–P8 epic work was
uncommitted at baseline — the owner commits manually; a loop pass must never commit changes it
didn't author.

## Backlog (ranked; re-rank each pass)

| #   | Item                                                                                                                                                                                        | Stage | Effort | Status                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Verify `agentic_promotion_*` gauges recover post-restart and count pre-multi-symbol round trips (strategyId `agentic` → `agentic-1`/`-2`)                                                   | 0     | S      | DONE 2026-07-06 (verified live)                                                                                                                                             |
| 2   | Verify Grafana "Agentic lane (LLM)" panels render $/day spend + net-of-cost PnL                                                                                                             | 0     | S      | metric names verified unchanged in JSON; render-check on next pass                                                                                                          |
| 3   | `STRATEGY_INTERVAL` 5m → 15m + fix false `AGENTIC_MAX_CALLS_PER_DAY` comment (compose + .env.example)                                                                                       | 1     | S      | DONE 2026-07-06 (deployed)                                                                                                                                                  |
| 4   | Deterministic pre-screen gate ahead of LLM call (`AGENTIC_PRESCREEN_*`, counter, fail-open)                                                                                                 | 1     | M      | DONE 2026-07-06 (deployed; reviewer-approved, 4 should-fix applied: digest excludes model='prescreen', skips kept out of recentDecisions ring, latency null, ordering test) |
| 5   | Fix scoring biases in `counterfactual-scoring.ts` (FLAT-on-fall rewarded; open PnL excluded)                                                                                                | 2     | S      | pending                                                                                                                                                                     |
| 6   | Inject order-book depth into prompt (`agent-prompt.ts:146-148`), token-budgeted                                                                                                             | 2     | S      | pending                                                                                                                                                                     |
| 7   | Per-playbook-version net-PnL attribution (query/panel)                                                                                                                                      | 2     | M      | pending                                                                                                                                                                     |
| 8   | Cross-field boot validation: `AGENTIC_WARMUP_BARS >= PRESCREEN_VOL_LONG_BARS/BREAKOUT_LOOKBACK` (zod superRefine; undersized warmup silently no-ops the cost floor via permanent fail-open) | 1     | S      | pending (review nice-to-have)                                                                                                                                               |
| 9   | prescreen.ts: route non-positive/NaN-producing candle values to `insufficient_data` (total fail-open guarantee; today NaN comparisons fall through to quiet=skip)                           | 1     | S      | pending (review nice-to-have)                                                                                                                                               |
| 10  | Watch first prescreen skip-rate days; tune VOL_RATIO/BREAKOUT_PCT against the counter toward the 50–70% skip target                                                                         | 1     | S      | pending (needs live data)                                                                                                                                                   |
| 11  | Reflection model back to Opus? Only with per-model pricing at read time (llm_usage/agent_decisions carry model columns) — flat 3/15 must stay honest                                        | 2     | M      | pending (deferred by owner 2026-07-06)                                                                                                                                      |

## Flagged for human review (open)

- **BLOCKER — ANTHROPIC_API_KEY not reaching the container (2026-07-06 redeploy):** lane INERT
  (stub client, no trades, no evidence accrual). Owner: verify the key is set non-empty in `.env`
  (empty `VAR=` or `VAR= # comment` counts as unset), then `docker compose up -d app`. Details in
  LOG.md Pass 0.

- **Marketable exits** (2026-07-05): passive `LIMIT GTC` exit pricing partial-fills into dust;
  money-path change — superseded in part by the P1 marketable IOC exits commit; verify closed and
  remove this flag on the first pass.
- **Dust-threshold round-trip accounting** (2026-07-05): `portfolio-state.service.ts` records a
  round trip only at exactly-zero signed qty; touches realized-PnL accounting — needs owner call.
