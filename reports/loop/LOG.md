# Daily profitability loop — pass log

Append-only, newest last. One dated entry per pass (including empty passes), per
`docs/planning/daily-profitability-loop.md` §6: data window, headline metrics, decision +
rationale, diff summary, gate results, soak verdict, flagged items, next candidates.

---

## 2026-07-06 — Pass 0 (pipeline deploy, not a scheduled loop pass)

**Window:** design session + Stage 0/1 implementation, same day. **Baseline metrics:** readiness 23
round trips, net −$14.52→−$14.72, LLM $11.53, window 1.83d, ready=0; equity 4997.7.

**Shipped (agent-pipeline, owner-approved plan; reviewer verdict Approve, 0 must-fix; gates green
1318 unit + 41 livegate + lint/format/typecheck/build):**

- `STRATEGY_INTERVAL` 5m→15m; false `AGENTIC_MAX_CALLS_PER_DAY` comment corrected (5m config
  overran the 500 cap daily at 576 decides).
- `AGENTIC_REFLECTION_MODEL` opus→`claude-sonnet-5` (owner call: keeps flat 3/15 pricing honest).
- NEW deterministic prescreen gate (`src/features/trading/agentic/prescreen.ts`) ahead of every LLM
  call: position*open / vol_expansion (10/50 stdev ratio >1.3) / breakout proximity (0.5% of 20-bar
  extremes) consult; quiet skips journal an honest HOLD (model='prescreen', tokens/latency null,
  excluded from scoring digest + recentDecisions ring). 6 `AGENTIC_PRESCREEN*\*`knobs;`agentic_prescreen_total{outcome}` counter; Grafana panel 142. Fail-open throughout.
- 4 reviewer should-fix items applied same pass (digest exclusion, ring exclusion, latency null,
  ordering-regression test).

**Soak findings (the soak earned its keep twice):**

1. **HOST regression (found + fixed):** a compose edit had set `HOST: '127.0.0.1'` — container
   healthcheck green but Prometheus scrape + host port dead (`up==0`, 25 min of blind soak).
   Restored `HOST: '0.0.0.0'`, recreated, `up==1` verified. Lesson: config-file review must cover
   the whole file, not just flagged regions.
2. **OPEN — lane is INERT: no ANTHROPIC_API_KEY reaches the container.** Boot log: "agentic lane
   INERT: no ANTHROPIC_API_KEY — proposing nothing". `agent_client_info{kind="stub"}`. The key was
   delivered this morning (pre-rebuild container ran kind="anthropic"), and `.env` is
   sandbox-denied to agents — OWNER ACTION: verify `ANTHROPIC_API_KEY=<key>` exists non-empty in
   `.env` (note: `VAR=` empty or `VAR= # comment` is treated as UNSET by the config layer), then
   `docker compose up -d app`. Until then: no LLM calls, no trades, no evidence accrual (but $0
   spend; prescreen gate verified live — 2×`called` on position_open, 2 stub holds, 0 errors,
   0 EXPIRED).

**Next candidates:** backlog #2 (Grafana render check), #10 (skip-rate tuning once real decides
flow), #5-7 (Stage 2) blocked on Stage-1 exit criterion which is blocked on the key fix.
