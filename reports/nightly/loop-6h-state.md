# Larger-window P&L loop — state (2026-06-14 → 06-15)

**Goal:** increase P&L to **≥ +1% over a larger (6-hour) window** — where any real EMA-cross edge can rise above the 1-hour noise that dominated the prior hourly loop. **2 runs:** run 1 = window start (now); run 2 = **+6 h** measurement. +1% is the aspirational target, **report honestly** if not met.
**No git commits.** Changes (if any) accumulate in the `paper` working tree atop tonight's avgEntry fix + the prior loop's 4 improvements.

## Window
- **Start:** 2026-06-14T22:57Z, boot `49c355d4`, **equity = 5000.00** (clean reset). Target at +6h: **equity ≥ 5050** (+1%).
- **End / measure:** ~2026-06-15T04:57Z (run 2 fires via one-shot cron at 06:56 local).

## Run 2 (+6h) — EXACT procedure for the fired agent
1. **MEASURE FIRST — do NOT reset before measuring.** Scrape /metrics + query Postgres for current equity, realized_pnl, fills, signals, open/in-flight, PRECISION_OVERFLOW, errors. Compute **window P&L = (equity − 5000)/5000**. Report honestly whether ≥ +1% (this is the deliverable — driven by the strategy/market over 6h, not by forcing).
2. Analyze the 6h of trading (fill rate, signal→fill conversion, any errors/rejections).
3. THEN, optionally, apply ONE safe gate-green improvement if the 6h data reveals a genuine one (see backlog below + guardrails). +1% is NOT a gate; never weaken a guard or overfit.
4. Gate (clean .env-free cwd — see prior loop-state.md for the exact command), then redeploy `docker compose down -v && docker compose up --build -d`. This is the FINAL run — after recording, STOP (one-shot cron auto-deletes; no further scheduling).
5. Record below + PushNotification the honest window P&L outcome.

## Run 1 — 2026-06-14T22:57Z (now)
**Action: window start + clean reset; NO code change applied (honest — none was warranted).**

Ran an exhaustive 13-agent audit workflow (7 subsystem lenses → 6 unique candidates → adversarial verification of each). **All 6 were refuted (recommended=false):**
- **Marketable LIMIT pricing** (strategy) — RISKY: live mid is unavailable to the candles-only strategy (inert/no-op), and the real fix wires live data into signal prices, breaking the **byte-identical replay-determinism invariant**.
- **TTL reaper for stale GTC resting orders** — RISKY: real bug (expired resting orders are never cancelled), but the P&L sign is an **unverified directional bet** (cancelling forgoes mean-reversion fills too) + a new periodic driver in a 100%-coverage glob.
- **E2/E3 exposure-clamp PRECISION_OVERFLOW** (`src/domain/risk/evaluate.ts:209`) — NO_REAL_VALUE: a genuine latent bug (same class as tonight's avgEntry fix — `makeQty()` wraps a non-terminating `headroom.div(price)` before `roundToStep`, throwing uncaught), safe + gate-green to fix, **but unreachable** under the shipped enter-when-flat strategy (gross exposure never approaches the 1 M cap) → zero P&L impact. **Deferred (verified safe; revisit only if the strategy pyramids or the exposure cap tightens).**
- **unknown-resolver fill-matching** (`unknown-resolver.service.ts:271`) — RISKY: real testnet matching bug, but the proposed fix **breaks the default paper mode** (the matcher is correct for paper, broken for testnet); needs a mode-aware fix (cross-cutting, not gate-green as scoped).
- **Risk staleness book-health gate** (`risk-engine.service.ts:83`) — RISKY: would **loosen a deliberate, design-documented hard safety gate** ("never add risk on stale data"; design-plan §P1) — forbidden.
- **Paper maker fee 1 vs 10 bps** (`app.module.ts:336`) — VENUE_CONSTRAINT: real factual typo, safe, but **paper-only** — the demo/testnet path uses real venue fees, so zero effect on the measured window. **Deferred (paper-mode accounting honesty).**

**Conclusion:** the bot is healthy and correct; there is **no safe, gate-green code change that increases the testnet bot's P&L**. The genuine lever for "+1% over a larger window" is **time** (the 6-hour window itself), not code. Two real latent bugs (E2/E3 overflow; paper fee) are documented above as a verified backlog — **not applied** this run because neither serves the P&L-over-window goal nor affects the measured window, and bundling out-of-scope changes would muddy the honest result.

**Tree state:** unchanged from the prior loop's run 4 (gate-green, 844 passed) — the 4 prior improvements (fill-fee, poller-watermark, NO_POSITION, signals_rejected_total) + tonight's avgEntry fix are all deployed in boot `49c355d4`.

## Run 2 — 2026-06-15T04:56Z (one-shot cron — FINAL, measurement)

**WINDOW P&L = (4994.25 − 5000) / 5000 = −0.115%** → did **NOT** reach +1% (slightly negative). Honest result.

**Measurement (boot 49c355d4, up 6h — window intact, no restart):** equity 4994.25, peak 5000 (never exceeded start), cash 4993.76, realized_pnl ema-1 −2.96, drawdown 0.115%, open/in-flight 5/5 (bounded), healthy, /health/ready ok (testnet+RUNNING+db up), p99 29.9ms.

**6h trading analysis:** fills **59**, orders 51 (**46 FILLED + 5 PARTIALLY_FILLED** → high fill rate, excellent signal→fill conversion), signals 56 (51 APPROVED, 3 SIZING_REJECTED:BELOW_MINIMUM, 1 SIZING_REJECTED:NO_POSITION, 1 risk-REJECTED), risk 51 APPROVED/1 REJECTED. **PRECISION_OVERFLOW = 0** over 59 fills (avgEntry fix robust at scale); **0 warn/error logs**. Run-3 + run-4 improvements verified live: `signals_rejected_total{SIZING_REJECTED,NO_POSITION}=1`, `{…,BELOW_MINIMUM}=3`; the rejections are all correct venue behavior (dust / no-position exits), accurately labeled.

**Change applied: NONE — and that is the honest, correct outcome.** The 6h data reveals no safe, gate-green P&L lever: the bot is correct, fully filling (refuting the audit's top fill-rate hypothesis empirically), and every prior fix is working. The −0.115% is the EMA-cross strategy's genuine performance over 6h of BTC/USDT testnet noise after fees on 59 fills — not a correctness, fill-rate, or accounting defect. Reaching +1% would require real strategy edge (overfitting — barred) or risk-scaling (barred); real venue fees can't be cut by a safe code change. Per the guardrails ("never weaken a guard or overfit to manufacture P&L; report honestly"), no change was forced. Bot left running as-is (boot 49c355d4, all 5 fixes deployed).

---

## Loop complete — larger-window result (2/2 runs)

**The larger window did not reveal hidden edge: 6h P&L = −0.115%** (vs the hourly loop's per-run noise of ±<0.02%). Trading more (59 fills over 6h, high fill rate) did not turn the EMA-cross strategy profitable — it is roughly **break-even-minus-fees**, the expected result for a simple moving-average-cross strategy on a random-walk-like testnet market with no exploitable edge. **+1% was not achieved and is not reachable by any safe code change** — it is a strategy-edge / research problem, not an infrastructure one.

**What IS solid (validated over a 6h, 59-fill window):** the bot's infrastructure is correct and robust — zero overflow, zero errors, high fill rate, bounded open-order/in-flight, accurate accounting and rejection labeling. Tonight's avgEntry PRECISION_OVERFLOW fix + the prior loop's four improvements all hold at scale. To actually pursue +1%, the next step is strategy/edge research (a different EMA regime with a tested hypothesis, an alternative signal, or maker-rebate capture) — explicitly out of scope here because it requires backtested evidence, not a 1-shot code tweak, and would otherwise be overfitting.

**Deferred verified backlog (from the run-1 audit; NOT applied — out of scope / no window effect):** E2/E3 `evaluate.ts:209` PRECISION_OVERFLOW (safe, but unreachable under the enter-when-flat strategy); paper makerBps 1→10 typo (`app.module.ts:336`, paper-only). Both are real, safe to fix, and worth doing if/when the strategy changes — surfaced for the user to decide.

No git commits; all changes remain in the `paper` working tree (gate-green, 844 tests).
