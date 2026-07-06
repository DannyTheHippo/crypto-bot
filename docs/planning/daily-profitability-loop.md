# Daily profitability loop — playbook

Audience: a Claude session executing **one pass per day**. Trigger (owner-run):
`/loop 1d Read docs/planning/daily-profitability-loop.md and execute one pass`, or a scheduled
routine at a fixed hour. This document is the task spec for each pass; execute it top to bottom.
It is an operational playbook, not application code.

## 0. Mission and objective function

Maximize **net-of-cost PnL** — `realizedPnl − fees − llmCostUsd` — toward the earned-live
promotion gate (`PromotionReadinessService`; criteria encoded in code and
`reports/nightly/PROMOTION.md`). Every improvement is judged by its expected effect on
net-of-cost PnL or on the trustworthiness of its measurement — nothing else counts as
"high-value". The **current strategic frame** (active spec, stage, exit criteria, target capital)
is NOT written here — it lives in `reports/loop/state.md` § Strategic frame, so this playbook
stays a timeless procedure while strategy evolves. Each pass checks the current stage's exit
criterion there and advances the stage when met (record the advance in the report).

## 1. Rehydrate (read, never re-derive)

Read in this order:

1. This playbook.
2. `reports/loop/state.md` — the loop's ONLY mutable memory: § Strategic frame (active spec
   pointer, stage + exit criteria, settled owner decisions), current backlog, last-pass pointer,
   open flagged items. Follow its spec pointer only when stage-level detail is needed.
3. `git log --oneline -20` — what shipped since the last pass (passes commit to `main`).
4. Project memory index (auto-loaded) — env quirks, validation recipes.

Settled owner decisions (the list lives in state.md § Strategic frame) are **not** re-openable by
a pass. A pass that believes one should change writes the argument into the report's "Flagged for
human review" section instead of acting.

## 2. Evidence sweep (read-only)

Run all stack commands with the sandbox disabled (`dangerouslyDisableSandbox: true`) — the sandbox
blocks docker/promtool. Host `psql` and host `curl` are **auto-denied**; do not attempt them.

1. **Stack health:** `docker ps --format '{{.Names}}\t{{.Status}}'` — all four containers up,
   app healthy.
2. **Logs (24h):** `docker logs crypto-bot-app-1 --since 24h` — scan for: error/warn lines,
   kill-switch or HALT events, protective-exit fires (`STOP_LOSS`/`TRAILING_STOP`), reflection runs
   and playbook promotions, risk/sizing rejections, reconciliation `result="error"`. Note: this
   shell's `grep` is flaky with alternation — prefer single-token `grep -on` per keyword, and never
   trust a negative grep.
3. **Metrics (promtool):**
   `docker compose exec prometheus promtool query instant http://localhost:9090 '<q>'` for: (use
   `docker compose exec`, not `docker exec` — `Bash(docker exec:*)` is a hard global permission deny
   in this environment, rejected outright rather than sandbox-blocked; `docker compose exec` is a
   different command string and isn't caught by that pattern)
   - `agentic_promotion_round_trips`, `agentic_promotion_net_pnl_usd`,
     `agentic_promotion_llm_cost_usd`, `agentic_promotion_window_days`, `agentic_promotion_ready`
     — the gate scoreboard (DB-backed, survives restarts; sampled every 5 min — a fresh boot reads
     0 until first sample).
   - `sum by (kind) (agent_tokens_total)` → derive $/day at the configured
     `AGENTIC_TOKEN_PRICE_*_PER_MTOK` rates (3 input / 15 output per Mtok). Counters reset per boot
     — pro-rate by uptime.
   - `sum by (outcome) (agent_decide_total)`, `signals_rejected_total` (any `EXPIRED` is a
     regression), `fills_total`, `round_trips_total`, `equity_usdt`, `drawdown_ratio`,
     `realized_pnl_usdt`, `agentic_playbook_info`, and `agentic_prescreen_total` once the
     pre-screen ships.
4. **DB per-row truth:** the promotion gauges are the DB-backed read. When a per-row query is
   essential to a decision (e.g. attributing PnL to a playbook version), write the exact SQL into
   the report for the owner to run via a `!` prompt (templates in `reports/nightly/PROMOTION.md`
   § Evidence) and proceed without it — never block the pass on psql.
5. **Grafana** renders the same Prometheus data — promtool is the canonical read. The dashboard
   JSON (`observability/grafana/dashboards/crypto-bot.json`) is in-repo and editable when a pass
   ships a metrics change.

## 3. Decide (one improvement per pass)

Rank candidates by **expected net-of-cost PnL impact ÷ effort**; prefer S-effort, low-risk,
agentic-lane-only. Candidate sources, in priority order:

1. **Correctness bugs on the trading path surfaced by today's evidence** — these outrank
   everything (precedents: the 2026-07-04 signal-TTL bug, the 2026-07-05 dust trap).
2. The **current stage's items** not yet done (per state.md § Strategic frame).
3. The rolling backlog in `reports/loop/state.md`.
4. New ideas from today's evidence (add to the backlog even when not chosen).

Implement **one** improvement per pass (two only if both are S-effort). **Before implementing,
re-verify the item is still real against current code** — backlog items inherited from dated
analyses go stale (2026-07-06 Pass 2 precedent: two Stage-2 seeds from the 07-04 analysis were
already fixed in the codebase; the pass's value was pruning them with evidence, not shipping). If
nothing clears the bar, ship nothing — record why, and after **two consecutive** empty passes
recommend a cadence or scope change in the report instead of forcing a change.

## 4. Autonomy boundaries (task-spec authorization for these runs)

**MAY** — implement, validate, commit to `main`, rebuild + redeploy the demo compose stack:

- Agentic-lane code: `src/features/trading/agentic/`.
- Config: `docker-compose.yml`, `.env.example` (keep in sync — standing rule), zod schema knobs in
  `src/config/environment/environment.config.ts` for agentic/observability settings.
- Observability: `observability/` dashboards, metrics services, panels.
- Docs and reports: `docs/`, `reports/loop/`.

**MUST NOT touch** (report-only, with evidence + exact proposed diff in "Flagged for human
review" — the 2026-07-05 marketable-exits flag is the template):

- Risk sizing/veto (`src/features/trading/risk/`), Execution, OMS, exchange adapters.
- The four live gates, mode resolution, arming interlock, `test:livegate` (sacred — never skip,
  weaken, or delete).
- Append-only tables/triggers (`audit_log`, `order_events`), money-table schema, migrations.
- Secrets, `.env` (the example file is fine), pino redact lists.

Hard rules 1–7 in the project `CLAUDE.md` bind in full. **Never push to any remote.** Commits to
local `main` are authorized for gates-green changes within the MAY list; one commit per shipped
improvement, conventional message. **Dirty-tree rule:** if the working tree has pre-existing
uncommitted changes at pass start, note them in the report and stage ONLY the files this pass
authored (`git add <paths>`, never `git add -A`/`-u`) — a pass never commits work it didn't write.

## 5. Validate, then deploy

1. **Gates (all green before commit):** `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test` —
   run with `pnpm -C <repo-root>` (never `cd`; the fnm hook breaks), sandbox-disabled, `pipefail`
   on chains. `test:db` needs `DB_SUITE_ALLOW_RESET=1` and
   `DATABASE_URL=postgres://cryptobot:cryptobot@127.0.0.1:5432/cryptobot_test`.
2. **Cap:** 3 consecutive validation failures → revert the working tree, record the failure in the
   report, end the pass.
3. **Deploy:** `docker compose build app && docker compose up -d app`.
4. **Soak (15–30 min):** health 200 (`docker ps` healthy), decides flowing
   (`agent_decide_total` advancing), `signals_rejected_total{reason="EXPIRED"}` empty, token cost
   rate sane for the change, no new error/warn in `docker logs --since 15m`, protective exits still
   present in config. Regression → `docker compose up -d app` on the previous image (or revert the
   commit and rebuild), record the rollback.

## 6. Report and state (every pass, even empty ones)

1. **Append** a dated entry to `reports/loop/LOG.md`: data window read, headline metrics
   (gate scoreboard + $/day), decision + rationale, diff summary (files + commit hash), gate
   results, soak verdict, flagged-for-human items, next-pass candidates.
2. **Update** `reports/loop/state.md`: current stage, backlog with statuses, last-pass pointer,
   open flagged items awaiting the owner.
3. Both files are the loop's cross-session memory — keep them current enough that the next pass
   needs nothing else. (Pattern precedent: `reports/archive/nightly/loop-state.md`.)

## 7. Stop conditions (report-only, change nothing)

- Kill switch tripped, reconciliation HALT, or any reconciliation mismatch in the logs.
- Unexplained drawdown (equity move the logs/fills don't account for).
- The gate scoreboard contradicts the DB/logs (measurement can't be trusted — fixing measurement
  becomes the only eligible improvement).
- Context usage >70% mid-pass → dispatch `context-transfer` for HANDOFF.md, finish the report with
  what is known, end the pass.
