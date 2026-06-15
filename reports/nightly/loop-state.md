# Nightly improvement loop — state (2026-06-14)

**Cron job:** `755fa2d8` (hourly at :07, session-only). **Cap: 4 runs total.** After run 4: `CronDelete 755fa2d8` and stop.
**Goal:** monitor+analyze trading activity, apply source improvements to raise P&L. +1% is **aspirational, not a gate**.
**Reset policy (user-confirmed):** `docker compose down -v` then `docker compose up --build -d` each run — the `-v` volume wipe is explicitly authorized; tonight's evidence is preserved in git (`reports/nightly/`); migrations auto-run on boot (`PersistenceModule.onModuleInit`).
**No git commits.** Changes accumulate in the working tree on branch `paper`.

## Runs completed: 4 (of 4) — LOOP COMPLETE (cron 755fa2d8 deleted)

## EXACT gate command (use this — do NOT run `pnpm test` from repo root)

The local `.env` injects `DATABASE_URL=...@postgres:5432/...` (docker-internal host, unreachable from the host),
which breaks 3 DB-health unit tests (`/health/ready` → 503) — a local artifact, NOT a real failure (CI has no `.env`).
Run the suite from an empty `.env`-free cwd pointing vitest at the repo:

```bash
PROJ="/Users/danielhendrich/Work/Work/1 - OctopusTech/1 - Projects/1 - Octopus/crypto-bot"
cd "$PROJ" && pnpm build && pnpm lint && pnpm typecheck            # these don't load .env
CLEAN=$(mktemp -d) && cd "$CLEAN" \
  && TRADING_MODE=paper "$PROJ/node_modules/.bin/vitest" run --root "$PROJ" --config "$PROJ/vitest.config.ts" test/unit test/livegate \
  && TRADING_MODE=paper "$PROJ/node_modules/.bin/vitest" run --passWithNoTests --root "$PROJ" --config "$PROJ/vitest.config.ts" test/paper
```
All must be green. `format:check` is pre-existing repo-wide red (hand-style debt) — out of scope; format only touched files.
Run all docker/test commands sandbox-disabled (the bash sandbox spuriously fails tsc/redirects and blocks the docker socket).

## Guardrails (CLAUDE.md hard rules — non-negotiable)

1. Money is never a float: decimal.js + branded types, exact-string tests (no `toBeCloseTo`), no parseFloat/Number on money paths.
2. Strategy → Risk → Execution → Adapter. Never bypass Risk, never widen Execution's RiskApprovedIntent signature, never disable boundaries zones.
3. Paper is default; live is gated. Never weaken the four live gates or the NODE_ENV=test override.
4. `src/domain` stays pure (no @nestjs/*, ccxt, Date.now, process.env).
5. OMS: never blind-resubmit; persist intent before network; unknown >60s ⇒ kill switch.
6. `audit_log`/`order_events` append-only — never UPDATE/DELETE/relax triggers. Reconciliation mismatch HALTs.
7. No secrets in code/logs/fixtures.
- **Never weaken a guard or overfit to manufacture P&L.** If a change can't go gate-green, revert it and report honestly.

## Improvement backlog (analyze, then pick ONE per run)

- **[LEAD] `SIZING_REJECTED:BELOW_MINIMUM` (10×+ in logs)** — orders rejected below venue `minNotional`, so the bot places almost nothing → ~zero P&L upside. Investigate `BASE_NOTIONAL` / position-sizer config vs Binance testnet `minNotional` (~$5–10 for BTC/USDT). Raising configured order notional (or honoring venue minNotional in sizing) would unblock trading. Correctness/throughput win, directly enables P&L. **A bot that can't place orders has zero P&L.**
- `DemoFillPollerService.since` never advances (re-fetches all post-boot trades; inefficient; also the poison-message recovery gap).
- `src/domain/paper/fill.ts:25` fee `base.mul(feeBps).div(10_000)` — same un-rounded class as tonight's avgEntry fix (latent; paper path).
- Strategy/parameter tuning (ema-cross periods, etc.) — LAST resort, high overfitting risk on 1h testnet noise; only with a clear correctness rationale.

## Baseline (pre-loop, boot cba63e28, before any loop reset)

equity 4421.54 (peak 5500), fills(db) 18, open_orders 0, in_flight 0, PRECISION_OVERFLOW 0 (tonight's fix deployed), realized_pnl ema-1 ≈ -0.136. Note: equity below the 5000 start and 5500 peak — net negative over the bot's life, partly from the ingestion stall. SIZING_REJECTED suggests the strategy rarely trades.

---

## Run log

### Run 1 — 2026-06-14T17:37Z (live session)

**Analysis (pre-reset, boot cba63e28):** equity 4421.54 (start 5000, peak 5500), DB fills 18, open_orders/in_flight 0, PRECISION_OVERFLOW 0 (tonight's avgEntry fix holding). risk_decisions: 5/5 APPROVED; signals: 5 (3 golden / 2 death EMA cross), all approved — NO SIZING_REJECTED persisted (the plan's 10× was a pre-redeploy log artifact). The 5000→4421 drop is **stall-induced accounting drift** (buys deducted cash; the offsetting sells' fills never ingested during the poison-message stall), not realized loss (realized_pnl ≈ −0.136) — and it is wiped by the reset.

**Change applied:** `src/domain/paper/fill.ts` — wrapped the simulated-fee `base×feeBps÷10000` in `roundToMoneyPrecision` (+ regression test in `test/unit/paper/fill.spec.ts`). Same PRECISION_OVERFLOW class as tonight's avgEntry fix (a >18-dp fee threw at the `feeAmount` mint for high-precision inputs). **Honest scope:** this is the paper-fill path — testnet ingests venue-provided fees, so it is *testnet-invisible this window*; it's a correctness/stability hardening (prevents a latent crash class), NOT a P&L driver.

**Why not a P&L-positive testnet change:** the strategy (ema-cross) is fixed; raising `BASE_NOTIONAL` only scales risk (not edge); a sizing/exit change can't beat the venue minNotional; poller-`since` carries fill-dropping regression risk too high for an unattended loop. No safe, gate-green, edge-improving testnet change was available — consistent with the confirmed "aspirational, report honestly" directive.

**Gate:** build+lint+typecheck PASS; test+coverage exit 0, **839 passed** (no threshold violation); test:paper 9 passed.

**Reset + redeploy:** `docker compose down -v` + `up --build -d` (volumes wiped, user-authorized). Fresh boot c5ebde10: migrations applied, BootRecovery seeded 0, **equity reset 4421→5000**, peak 5000, open_orders/in_flight 0, fills 0, PRECISION_OVERFLOW 0, /health/ready ok (testnet+RUNNING+db up), healthy in ~5s.

**P&L verdict:** +1% NOT achieved as a code-driven delta — not achievable/honest this iteration (the change is testnet-invisible; the 4421→5000 is a reset artifact, not earned P&L). Clean 5000 baseline established; bot healthy and trading-capable with both crash-class fixes deployed. Next run will have ~1h of fresh trading to measure.

### Run 2 — 2026-06-14T20:27Z (cron 755fa2d8)

**Analysis (pre-reset, boot c5ebde10, ~44 min of fresh trading from 5000):** equity **4999.44** (−0.56 = −0.011%, peak 5000), realized_pnl ema-1 −0.2416, fills 12, open_orders/in_flight 2/2 (bounded), signals 7/7 APPROVED, risk_decisions 7/7 APPROVED (reasons []), **PRECISION_OVERFLOW 0, SIZING_REJECTED 0**, no warn/error logs. The bot trades correctly post-fix — equity flat, P&L is fee/spread noise. SIZING_REJECTED confirmed a pre-fix artifact (not occurring with clean operation). No correctness defect causing P&L loss.

**Change applied:** `src/modules/execution/demo-fill-poller.service.ts` — advance the sweep watermark (`this.since`) to the newest trade timestamp seen each poll (+3 tests in `demo-fill-poller.spec.ts`). Previously `since` was anchored at boot and never advanced, so every 10s poll re-fetched ALL post-boot trades (correct via venueTradeId dedupe, but unbounded work growth + a growing API response each cycle). **Provably non-skipping:** `fetchMyTrades(since)` returns all trades ts ≥ since, so every trade ≤ maxTs was already in this fetch; the boundary trade re-fetches inclusively and dedupes; the watermark (≤ now) can't outrun an own fill (future ts). Testnet-relevant throughput/robustness win (the running poller path).

**Honest scope:** efficiency/robustness, NOT a direct P&L driver. Chose it over the alternatives because: SIZING_REJECTED isn't occurring (nothing to fix); raising BASE_NOTIONAL only scales risk; strategy tuning is overfitting (barred). No safe edge-improving change exists on 1h testnet — consistent with "aspirational, report honestly".

**Gate:** build+lint+typecheck PASS; test+coverage exit 0, **842 passed** (no threshold violation — modules/execution 100% glob holds with the new branch); test:paper 9.

**Reset + redeploy:** `down -v` + `up --build -d`. Fresh boot f5fea808: migrations applied, BootRecovery seeded 0, equity 5000, peak 5000, open_orders/in_flight 0, fills 0, PRECISION_OVERFLOW 0, /health/ready ok (testnet+RUNNING+db up), healthy in ~15s.

**P&L verdict:** +1% NOT achieved — and honestly not achievable as a code delta this window. Prior boot's 1h P&L was −0.011% (noise). The change improves poll throughput/robustness, not trading edge. Bot healthy on a clean 5000 baseline with all three hardening fixes (avgEntry, fill-fee, poller-watermark) deployed.

### Run 3 — 2026-06-14T21:27Z (cron 755fa2d8)

**Analysis (pre-reset, boot f5fea808, ~54 min from 5000):** equity **5000.36 (+0.0072%)**, peak 5000.70, realized_pnl ema-1 −0.297, fills 10, open/in-flight 3/3 (bounded), p99 25.7ms, **PRECISION_OVERFLOW 0**, no errors. Slightly up this hour (noise). **New finding:** `SIZING_REJECTED:BELOW_MINIMUM` IS occurring — 2× on EXIT_LONG (death-cross) signals (`signals.intent_id IS NULL`). Inspected the sizer: exits size to the attributed position; `rawQty.lte(0)` (exit with no/dust long) rejects. This is **correct** behavior — an exit with no position is a strategy no-op, and a genuine sub-$5 dust position can't be placed on the venue (minNotional). NOT a fixable P&L defect; relaxing it would violate the venue constraint or risk-bypass.

**Change applied:** `src/ports/risk.ts` + `src/modules/risk/position-sizer.service.ts` — split the conflated reject reason: an exit with no attributed position now returns **`NO_POSITION`** (was mislabeled `BELOW_MINIMUM`); genuine sub-minQty/minNotional sizes keep `BELOW_MINIMUM`. Flows to `signals.outcome` as `SIZING_REJECTED:NO_POSITION` via the generic `${status}:${reason}` builder. **Behavior-preserving** — the order is rejected either way; only the recorded reason changes. Serves the "monitor+analyze" goal (accurate diagnostics: "flat, nothing to exit" vs "dust below venue min"). NOT a P&L driver.

**Why not a P&L-positive change:** the bot is healthy and trading correctly; the 3 prior hardening fixes hold; the only live "issue" (exit rejects) is correct venue behavior, not a defect. Raising BASE_NOTIONAL scales risk; strategy tuning is overfitting (barred). No safe edge-improving change exists — honest per the directive.

**Gate:** build+lint+typecheck PASS (typecheck confirms no exhaustive-switch broke on the widened union); test+coverage exit 0, **842 passed** (risk 100% globs hold — NO_POSITION branch covered); test:paper 9.

**Reset + redeploy:** `down -v` + `up --build -d`. Fresh boot 26d59e20: migrations applied, BootRecovery seeded 0, equity 5000, cash 5000, positions [], open/in-flight 0, PRECISION_OVERFLOW 0, /health/ready ok, healthy in ~10s.

**P&L verdict:** +1% NOT achieved — prior hour was +0.0072% (noise). The change is diagnostic accuracy, not trading edge; no honest +1% code delta exists on a healthy 1h-testnet bot. Four improvements now deployed (avgEntry fix, fill-fee rounding, poller-watermark, NO_POSITION reason).

### Run 4 — 2026-06-14T22:28Z (cron 755fa2d8 — FINAL)

**Analysis (pre-reset, boot 26d59e20, ~55 min from 5000):** equity **4999.93 (−0.0014%, ~flat)**, peak 5001.18, **realized_pnl ema-1 +0.424 (positive this hour)**, fills 7, open/in-flight 0/0, p99 32ms, **PRECISION_OVERFLOW 0**, no errors. signals: 7 APPROVED + **1 `SIZING_REJECTED:NO_POSITION`** — run-3's reason refinement is **verified live in production** (the exit-with-no-position is now correctly labeled, not the old misleading `BELOW_MINIMUM`).

**Change applied:** `src/modules/execution/signal-sink.service.ts` + `src/app.module.ts` — added a Prometheus counter **`signals_rejected_total{stage,reason}`** incremented on every front-door rejection (gateway: KILL_SWITCH/EXPIRED/DUPLICATE; sizer: BELOW_MINIMUM/NO_REF_PRICE/NO_POSITION). These were previously journaled only to the `signals` table — invisible to Prometheus/Grafana (the risk-engine and execution-gate stages already had counters; the front door did not). Additive, behavior-preserving, self-registering counter (same pattern as the 10 existing ones, no PrometheusModule-scope dependency). +2 tests (inc on reject, no-inc on DECIDED). Directly serves the "monitor+analyze trading activity" goal.

**Gate:** build+lint+typecheck PASS; test+coverage exit 0, **844 passed** (modules/execution 100% glob holds with the new `?.inc` branch; no metric double-registration); test:paper 9. (Note: the targeted spec run from the repo root showed the known 3 DB-health `.env` 503 failures — re-confirmed green from the clean .env-free cwd; not caused by this change.)

**Reset + redeploy:** `down -v` + `up --build -d`. Fresh boot a7fa0321: migrations applied, equity 5000, open/in-flight 0, PRECISION_OVERFLOW 0, /health/ready ok. **`signals_rejected_total` confirmed exposed in /metrics.**

**P&L verdict:** +1% NOT achieved — prior hour was −0.0014% equity / +0.424 realized (noise). No honest +1% code delta exists on a healthy 1h-testnet bot; forcing one would require scaling risk or overfitting (both barred). The change is observability, not edge.

---

## Loop complete — summary (4/4 runs)

Cron `755fa2d8` deleted after run 4. The loop shipped **four** gate-green improvements (no commits; all in the `paper` working tree atop tonight's avgEntry PRECISION_OVERFLOW fix):

1. **Run 1** — `paper/fill.ts` simulated-fee rounding (PRECISION_OVERFLOW hardening, same class as avgEntry).
2. **Run 2** — `demo-fill-poller.ts` sweep-watermark advancement (bounded re-fetch; throughput/robustness).
3. **Run 3** — `NO_POSITION` reject reason (separates no-op exits from venue dust; verified live in run 4).
4. **Run 4** — `signals_rejected_total` Prometheus counter (front-door rejection observability).

**Honest P&L outcome:** every run's 1-hour testnet P&L was noise (|Δ| < 0.02% equity); **+1% was never achieved and is not achievable as a code delta on a 1h testnet window** — the bot is healthy and correctly priced, and the legitimate, safe improvements available were correctness/throughput/observability, which protect P&L (prevent stalls, enable analysis) rather than manufacture it. No risk guard was weakened; no strategy parameter was overfit. Each run reset the DB to a clean 5000 baseline via the user-authorized `down -v`; all evidence is git-preserved in `reports/nightly/`.
