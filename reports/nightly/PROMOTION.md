# Promotion artifact — `paper` → `main`

> **Description only.** The remote is off-limits and `main` is the protected baseline branch.
> This PR is **never pushed and never merged** by the automation. A human promotes manually.

## Proposed PR

- **Title:** `fix(oms): round non-terminating weighted-average entry to money precision`
- **Source:** `paper` @ `95a6af0` (tag `paper-2026-06-14`)
- **Target:** `main` @ `214eb7d` (untouched baseline)
- **Fix commit:** `34bf2b1` on `nightly/improve-2026-06-14`, merged `--no-ff` into `paper`.

## Summary

The add-to-position branch of `applyFillToPosition` computes a weighted-average entry by dividing quote by base. Under the production `Decimal` config (`precision: 40`) that quotient is usually non-terminating (>18 dp), and minting it as a `Price` at `PortfolioStateService.applyFill` threw `MoneyError[PRECISION_OVERFLOW]`, stalling the testnet/demo fill poller: fills stopped ingesting, `open_orders`/`in_flight_intents` climbed unbounded, equity froze at 4421.54.

Fix: round the internal cost-basis average HALF_EVEN to the money type's 18-dp ceiling via a new `roundToMoneyPrecision` helper (`domain/types/money.ts`), conforming to the money contract without distorting the average (sub-1e-18 residual, below any venue tick).

## Diff (5 files, +171/-14)

```
src/domain/oms/position.ts                  |  13 +++-   (wrap the increasing-branch division)
src/domain/types/money.ts                   |  11 +++    (roundToMoneyPrecision helper)
test/unit/domain/money.spec.ts              |  24 ++++   (helper unit tests, incl. HALF_EVEN)
test/unit/execution/portfolio-state.spec.ts | 114 +++    (regression: add overflow + reduce path)
test/unit/oms/position.spec.ts              |  23 +++    (pure non-terminating-average case)
```

## Evidence

- **Regression (proof):** RED `MoneyError[PRECISION_OVERFLOW]: value has 35 decimal places (max 18)` → GREEN `avgEntry = 63999.255940594059405941` (exact, 18 dp).
- **Gate:** `build` + `lint` + `typecheck` + `test` (838) + `test:paper` (9) + `test:livegate` + `test:cov` (exit 0; `domain/oms` + `modules/execution` 100% globs hold). `format:check` is pre-existing repo-wide red (hand-style debt) and out of scope — only touched files were formatted.
- **Deployed & soaked (testnet):** healthy, `RestartCount=0`, `/health/ready` 200, `open_orders`/`in_flight_intents` 14→0 and bounded, PRECISION_OVERFLOW 15→0. A live add-to-position fill ingested during the soak with `avg_entry` rounded to 18 dp (`63954.062744127923286833`) and persisted cleanly.

## Risk / guardrails

- Pure-domain change; honors money invariants (decimal.js, exact strings, no `parseFloat`/`Number` on money paths).
- Strategy→Risk→Execution→Adapter path unchanged; no gate weakened; no append-only trigger touched.
- `main` baseline untouched; tag `paper-2026-06-14` marks the promotable state.
