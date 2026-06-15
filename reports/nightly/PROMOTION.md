# Promotion artifact — `paper` → `main`

> **Description only.** The remote is off-limits and `main` is the protected baseline branch.
> This is **never pushed and never merged** by the automation. A human reads it and promotes manually.

## Status: NOTHING TO PROMOTE TONIGHT (research-only night; production behavior unchanged)

Tonight's pass (`2026-06-15`, tag `paper-2026-06-15`, `paper` @ `7691586`) shipped **research tooling only** — ZERO
`src/` changes. The deployed bot runs the **same** EMA-cross strategy as before. There is no production behavior change
to promote to live.

## ⚠️ Branch-model divergence — needs a human decision (cannot be auto-resolved)

The repo has drifted from the documented `paper`-integration model and this is the most important item for the human:

- **`main` (`8231bcc`, = `origin/main`) is now the SUPERSET.** Commit `409340c` consolidated onto `main` all 5 prior
  nightly fixes (avgEntry overflow, fill-fee rounding, poller watermark, NO_POSITION reason, signals_rejected_total) +
  the backtest harness + research artifacts. The user has been committing directly to `main` and pushing to `origin`.
- **`paper` was STALE** (only the avgEntry fix; missing the harness + the other 4 fixes). Guardrail 3 forbids the
  automation from touching `main`, so tonight's work was branched off `main` (read-only on main; the superset is the
  correct base) and the LOCAL `paper` branch was advanced to `7691586` (= `main` + tonight's research). `paper` and the
  `paper-YYYY-MM-DD` tags remain local and unpushed by design.
- **Decision needed:** because the human is already merging nightly work directly into `main`, the `paper → main`
  promotion gate is effectively being bypassed upstream. Either (a) keep committing to `main` directly and treat `paper`
  as a throwaway integration mirror, or (b) resume the documented flow (work lands on `paper`, human promotes `paper →
main`). The automation will follow whichever, but it will never push or touch `main` regardless.

## Accumulated diff since the last live state (`main` @ `8231bcc`)

`paper` @ `7691586` adds, relative to `main`:

- `test/backtest/harness.ts` — generalized to drive any `Strategy` via a factory (was EMA-hardcoded).
- `test/backtest/mean-reversion.strategy.ts`, `test/backtest/mean-reversion.study.spec.ts` — new mean-reversion
  hypothesis + OOS study.
- `test/backtest/study.spec.ts` — EMA study refactored to the factory (reproduces `backtest-study.md` byte-identically).
- `reports/nightly/meanrev-study.md`, `reports/nightly/nightly-2026-06-15.md` — research report + audit trail.
- removed `test/backtest/feecheck.tmp.spec.ts` (scratch).

**All in `test/backtest/` (off the production typecheck/lint gate) + `reports/`. No `src/`, no config, no migration, no
dependency change.** The Docker image (built from `src/` only; `test/` is `.dockerignore`d) is functionally identical to
the last-good image.

## Current validated-edge status

**No validated edge exists.** EMA-cross was proven edgeless (160-config OOS study). Tonight closed the plain
short-horizon z-score mean-reversion hypothesis (0/48 positive-both OOS; 6/48 at zero fees → the strategy, not costs).
The bot trades EMA-cross 3/5 on 1m as a break-even-minus-fees baseline. Promotion to live is **NOT recommended on PnL
grounds** — there is no statistically validated profitable edge to promote. The reusable asset built tonight (a
strategy-agnostic backtest harness) is what advances the search.

## Evidence / risk notes

- Gate green on `7691586`: build + lint + typecheck + 844 unit/livegate + 9 paper (clean `.env`-free cwd,
  `TRADING_MODE=paper`). Cold-start redeploy HEALTHY (see `nightly-2026-06-15.md` §7–8 and the ledger row).
- Guardrails intact: no `src/` change, no risk-limit/gate weakening, no append-only-trigger change, no secrets. The
  paper/live gate and risk limits are untouched.
- **Consecutive HEALTHY nightly deploys: 2** (`paper-2026-06-14`, `paper-2026-06-15`). Tonight: cold-start redeploy,
  7-sample ~18 min soak PASS — up, `RestartCount=0`, `/health/ready` 200, live round-trip filled/retired clean, 0 errors,
  `reconciliation_mismatch=0`.
- **Open safety finding (pre-existing, do NOT promote to live until addressed):** the periodic 30 s venue-truth
  reconciliation pass is silently not completing on testnet (`reconTs=0`, `reconciliation_runs_total` empty) — a swallowed
  `fetchOpenOrders`/`fetchBalance` throw. Present in `paper-2026-06-14` too. Order-level fill reconciliation works and no
  drift/HALT occurred, but the venue-drift safety sweep is not actively confirming truth. This is the top backlog item;
  a live promotion should wait until it is fixed and verified.
