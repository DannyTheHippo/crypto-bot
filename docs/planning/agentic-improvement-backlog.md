# Agentic lane — improvement backlog

Ranked findings from the profitability/observability review of the agentic LLM lane
(`src/modules/agentic-strategy/`). The lane is the sole strategy lane and permanently
EXPERIMENT-ONLY (paper/testnet; `assertAgenticLaneNotLive` refuses any live boot — CLAUDE.md rule 4).
Every item here touches research metrics, reflection-prompt material, cost/noise throttles, demo
cadence, or ops dashboards — never a live gate, the order path (Strategy → Risk → Execution), or the
money-precision rules (CLAUDE.md rules 1–3, 5–7 remain intact).

## Disposition

`APPLY` items shipped in this changeset; `Backlog` items are deferred with the stated reason.

| #    | Finding                                               | Location                              | Impact                  | Effort | Disposition |
| ---- | ----------------------------------------------------- | ------------------------------------- | ----------------------- | ------ | ----------- |
| F1   | Reflection blind to per-decision forward outcomes     | `reflection.service.ts:215-228`       | decision quality + loop | M      | **APPLIED** |
| F2   | `hold` scored without position context                | `counterfactual-scoring.ts:98-110`    | eval rigor              | M      | **APPLIED** |
| F7   | 7-day reflection cooldown hard constant               | `reflection.service.ts:20,263`        | iteration speed         | S      | **APPLIED** |
| DASH | No single/agentic/cost Grafana view                   | `observability/grafana/dashboards/*`  | observability + cost    | M      | **APPLIED** |
| E    | Demo slow-cadence + inert-stub barely visible         | `docker-compose.yml`, `app.module.ts` | demo usability          | S      | **APPLIED** |
| F3   | No champion-vs-candidate scorecard CLI                | `compare()` test-only                 | promotion loop          | M      | Backlog     |
| F4   | `recentDecisions` outcome duplicated in decide prompt | `agent-prompt.ts:139-158`             | token cost              | S      | Backlog     |
| F5   | 50 full-precision candles per call                    | `agent-prompt.ts:128-137`             | token cost              | S      | Backlog     |
| F6   | No prompt caching                                     | `anthropic-agent-client.ts:333`       | token cost              | S      | Backlog     |
| F9   | `NaN%` priceMove when a decide has no candle          | `agentic.strategy.ts:141,284`         | prompt quality          | S      | Backlog     |

## Applied in this changeset

- **F2 — position-aware scoring.** `counterfactual-scoring.ts` now annotates each decision with the
  exposure it RESULTS IN (long/flat state machine, the same one `computeToyEquity` walks) and scores
  hit-rate/calibration off that exposure: resulting-LONG hits iff `fwd > 0`, resulting-FLAT hits iff
  `fwd <= 0`. A `hold` that maintains a LONG position riding a rise is now a hit (previously scored as
  flat, i.e. a miss). An approved convention change — the affected spec assertions flip accordingly.
- **F1 — forward-outcome digest.** `summarizeRecentDecisionOutcomes()` (pure, in
  `counterfactual-scoring.ts`, reusing F2's exposure walk + the t+1 forward return) buckets recent
  decisions into entries/exits/held-long/stayed-flat + a confidence split at 0.5, each with count and
  mean t+1 forward return. `reflection.service.ts` folds the digest into the reflection user message
  and adds one system-prompt sentence pointing the model at it for systematic-error detection, keeping
  the thin-data / no-false-confidence framing.
- **F7 — tunable reflection cooldown.** The 7-day floor became the DEFAULT of
  `AGENTIC_REFLECTION_COOLDOWN_MS` (floored at 0), threaded through `app-config.schema.ts` →
  `agenticEnv` → `createReflectionService`. Default unchanged, so existing deployments behave
  identically; it is a cost/noise throttle, never a safety gate.
- **DASH — one consolidated dashboard.** `observability/grafana/dashboards/crypto-bot.json` is now the
  single dashboard (the other three JSONs were removed), row-sectioned Overview / PnL & equity /
  Execution quality / Risk & safety / **Agentic lane (LLM)**. The agentic section surfaces client
  status (LIVE vs INERT), active playbook, decide-outcome rate, decide latency, token rate, validator
  rejections, and **API token cost** — a cumulative-USD stat and a $/hr timeseries computed in PromQL
  from `agent_tokens_total{kind}` × editable `price_in_per_mtok` / `price_out_per_mtok` textbox
  template variables. Reflection-path tokens also feed `agent_tokens_total`, so the cost view is
  complete.
- **E — demo trades promptly + visibly.** `docker-compose.yml` `STRATEGY_INTERVAL` 15m → 5m (first
  decision ≤5 min post-boot; 288 decisions/day stays under the 500/day cap). New `agent_client_info`
  gauge + `AgentMetricsRecorder.setClientInfo()`, set at boot from the bound client kind
  (`StubAgentClient` → `stub`, else `anthropic`), plus a loud boot `warn` when the inert stub is
  active. `.env.example` documents that `ANTHROPIC_API_KEY` activates the live lane.

## Backlog (deferred, with reason)

- **F3 — champion-vs-candidate scorecard CLI.** `compare()` exists but is test-only. Deferred: the
  toy scorecards are statistically indistinguishable from noise below ~30 matched closed trades, so a
  CLI would invite premature promotion decisions. Revisit once trade volume supports it.
- **F4 — duplicated recent-decision outcome in the decide prompt.** `agent-prompt.ts` carries the
  outcome in two forms; deduping saves tokens. Deferred: the dual form is currently tested and the
  saving is sub-threshold — bundle with F5/F6 under a live-eval token pass.
- **F5 — 50 full-precision candles per call.** Trimming precision/count cuts input tokens. Deferred:
  needs a live-eval to confirm decision quality is unaffected before shrinking the context.
- **F6 — no prompt caching.** Caching the static prompt prefix cuts input cost. Deferred: at current
  cadence the cache-eligible prefix is below the caching threshold, so it is a no-op today.
- **F9 — `NaN%` priceMove when a decide has no candle.** A cosmetic prompt-quality bug when a decide
  fires without a fresh candle. Deferred: low impact, no correctness effect; fold into the next
  prompt-quality pass.
