# Promotion artifact — `paper` → `main`

> **Description only.** The remote is off-limits. This artifact is read by a human who decides any
> live promotion manually. The automation never pushes and never promotes to live.

## Status: `paper` → `main` MERGE of the edge-search program (`paper` @ `eaf5668`)

This merge is **NOT research-only** — unlike prior nightly passes, it ships `src/` and config changes plus a
deployed **UNVALIDATED experimental strategy** on the demo/testnet bot. It is promoted to `main` deliberately as
a labeled experiment. **Live promotion is still NOT recommended** (see below): no validated edge exists, and the
active demo strategy is explicitly unvalidated.

## What this merge contains (`main` @ `8231bcc` → `paper` @ `eaf5668`, 5 commits)

Research/ops commits (prior passes, folded in):

- `7691586` — backtest harness generalized to any `Strategy`; mean-reversion hypothesis closed (research only).
- `c284fcf` — nightly evidence records. `abf978c` — server port 3000 → 3100. `374c71c` — prettier format.

Edge-search program commit (`eaf5668`) — the substantive change:

- **Validation tooling** (`test/backtest/`, off the production gate): step-D harness — deflated Sharpe, t-stat,
  MinBTL, walk-forward, purged CV (Bailey & López de Prado). `stats.ts`, `walk-forward.ts`, `cv.ts`, indicators,
  trial registry, study specs.
- **Production short plumbing** (`src/`): `signal.ts` `ENTER_SHORT`/`EXIT_SHORT` kinds; exhaustive sizer
  `orderForKind`; **directional E3 net-exposure headroom** in `evaluate.ts` (risk-**tightening**: a net-short book
  can no longer breach −maxNet; byte-identical for BUY/long); `strategy-host.ts` `EXIT_SHORT` in the risk-reducing
  set; halt-coordinator covers a short during FLATTENING. `OrderIntent.side` stays `BUY|SELL` — **no Execution /
  RiskApprovedIntent / HMAC signature widening.**
- **Promoted experiment** (`src/domain/strategy/donchian-breakout.strategy.ts`): pure, replay-deterministic
  Donchian breakout, wired behind a new **`ACTIVE_STRATEGY`** env switch in `app.module.ts` (**default
  `ema-cross`**, the validated baseline).
- **Demo deploy config** (`docker-compose.yml`): `ACTIVE_STRATEGY=donchian-breakout`, `STRATEGY_INTERVAL=1h`,
  `DONCHIAN_ENTRY=55`, `DONCHIAN_EXIT=20` — the characterized best-of-breed `55/20 @ 1h` (backtest SR −0.045).
  `.env.example` documents all env vars (incl. `HOST`, `ACTIVE_STRATEGY`, `DONCHIAN_*`) with `ema-cross` default.

## Current validated-edge status

**No validated edge exists — confirmed across every form tested.** EMA-cross (160-config), z-score mean-reversion
(48-config), the pre-registered long battery (Donchian/dual-momentum/vol-regime/ADX-regime, 64 trials), maker /
market-making, and the short battery (52 trials) **all FAIL** the step-D gate (cumulative N=324; 0/64 long
profitable at VIP0 fees, 13/64 only at zero fees → the strategies, not costs). The demo bot runs the
**UNVALIDATED** Donchian breakout `55/20 @ 1h` as a **labeled experiment, demo/testnet only**. Live promotion is
**NOT recommended**: no statistically validated profitable edge to promote, and the active strategy is unvalidated.

## Guardrails / live-gate integrity (adversarially audited before this merge)

A 6-dimension pre-merge audit of the full `main..eaf5668` diff confirmed the live-safety boundary is intact:

- **The four live gates are UNTOUCHED at code level** — env-flag/mode resolution (`resolution.ts` unchanged;
  invalid/missing `TRADING_MODE` ⇒ paper; `NODE_ENV=test/ci` forces paper), the bootId-bound HMAC arming interlock,
  the validated-keys/withdrawals-disabled probe, and the complete-risk-limits check are all byte-equivalent
  (changes around them are prettier reflow). `ACTIVE_STRATEGY` only selects which strategy the registry enables —
  strictly **downstream** of mode resolution; it cannot bypass the gates. A donchian signal in live would still
  require full live authority + a `RiskApprovedIntent`.
- **`src/domain` purity + strategy boundaries intact**; **money paths stay `decimal.js`/branded** (no float leak);
  **`audit_log`/`order_events` append-only triggers untouched**; reconciliation still HALTs without auto-flatten;
  **no secrets, no absolute paths, no leftover artifacts.**
- The directional E3 change is **strictly risk-tightening** (and value-identical for the long path).
- The Docker image **DOES change** this time (`src/` changed); it is **NOT** functionally identical to the
  last-good image — it carries the short plumbing and the Donchian strategy. The deployed config runs the
  unvalidated experiment on the demo venue, which is paper-safe by construction (no `TRADING_MODE`/`VENUES`/live
  creds in compose ⇒ degrades to paper).

## Open / deferred items (do NOT promote to live until addressed)

- **No validated edge** — the blocking reason against any live promotion.
- **Latent (non-deployed) short-cover bug:** the halt-coordinator's FLATTEN marketable-price hint is hardcoded
  below mark (correct for a SELL/long-flatten, but a BUY/short-cover rests rather than crossing except via the
  PRICE_BAND clamp). **Unreachable in the deployed config** — no strategy emits `ENTER_SHORT` and the spot venue
  is long/flat by construction — but must be fixed (derive hint direction from side) before any short-emitting
  strategy or a margin/futures venue is enabled. Shorts are research-only / live execution DEFERRED.
- **Pre-existing reconciler finding:** the periodic 30 s venue-truth reconciliation pass is silently not
  completing on the demo account (`reconTs=0`, `reconciliation_runs_total` empty). Order-level fill reconciliation
  works and no drift/HALT occurred, but the venue-drift safety sweep is not actively confirming truth. Top backlog
  item; a live promotion must wait until it is fixed and verified.

## Evidence

- Gate on `eaf5668`: build + lint + typecheck + format:check + `test:cov` 860 (all 100% coverage globs hold:
  risk/oms/mode/execution/mode-control) + `test:paper` 9 + backtest 37 — green from a clean `.env`-free cwd.
- Demo soak: the promoted Donchian ran a full autonomous round-trip on the 1m deploy (`ENTER_LONG` BUY 0.0015 @
  66648.43 → `EXIT_LONG` SELL 0.00149 @ 66717.98, realized_pnl +0.0042 net — one trade, not the edge), then was
  redeployed at the corrected `55/20 @ 1h`; `/health/ready` 200, killSwitch RUNNING, zero error/warn.

## 2026-07-03 — Agentic-only refactor (repo state; NOT yet deployed)

Owner-directed refactor: the deterministic strategy lane (ema-cross, donchian-breakout), its
tests (incl. replay-determinism), and the test/backtest research harness were removed; the
agentic LLM lane is now the only strategy lane and the repo default (ACTIVE_STRATEGY=agentic).
The lane is non-deterministic and step-D-uncertifiable, and the boot interlock refuses live
unless the earned-live promotion gate is met (see the 2026-07-06 section below — this
superseded the original "permanently EXPERIMENT-ONLY" stance). Consequence for promotion:
nothing is promotable until the earned-live criteria are met; criteria tracking is live.
The deployed testnet container still runs donchian-breakout from its last build; the next
rebuild picks up the agentic default (inert stub unless ANTHROPIC_API_KEY is provided).

## 2026-07-06 — Earned-live promotion gate (supersedes "permanently EXPERIMENT-ONLY")

The 2026-07-03 stance above — the agentic lane is permanently EXPERIMENT-ONLY, never promoted to
live — is **superseded by owner decision**. Live access is now **earned**, not permanently barred:
the lane still starts non-deterministic and step-D-uncertifiable (an LLM call is not
replay-deterministic and cannot pass the retired step-D battery), but it can now accumulate
data-driven demo evidence that unlocks a live attempt.

**Exact criteria (computed by `PromotionReadinessService`, `src/modules/mode-control/`,
`PromotionReadinessPort.evaluate()` behind the `PROMOTION_READINESS` token):**

- `>= 30` closed demo (testnet) round trips, walked per `(strategyId, symbol)` from ordered fills
  (a cycle closes when residual notional drops below the configured dust threshold).
- Positive **net-of-cost PnL** over the evidence window: `realizedPnl − fees − llmCostUsd > 0`.
  `llmCostUsd` prices summed decide + reflection tokens (`agent_decisions` + `llm_usage`) at
  `AGENTIC_TOKEN_PRICE_INPUT_PER_MTOK=3` / `AGENTIC_TOKEN_PRICE_OUTPUT_PER_MTOK=15` USD per
  million tokens. The pricing is flat across models, so the operator rule is: if
  `AGENTIC_REFLECTION_MODEL` (or `AGENTIC_MODEL`) is pinned to a pricier model, raise BOTH
  `AGENTIC_TOKEN_PRICE_*` knobs to the pricier model's rates — over-counting the cheaper path's
  cost is the fail-closed direction; under-counting would flatter the gate. (Per-row `model`
  columns exist on both tables, so exact per-model pricing is retrofittable at read time.)
- Evidence window `>= 14` days, measured as the span between the first and last closed round trip.
- Any unresolved fill (fills row with no attributable `order_intents` join) or an unconvertible
  fee asset forces `permitted=false` regardless of the numeric checks (fail-closed, not silently
  ignored).

**Fail-closed semantics:** `assertAgenticLaneNotLive` calls `evaluate()` on every live boot
attempt and refuses the boot unless `permitted=true`. Absence of the `PROMOTION_READINESS` port,
a DB error, or any of the reasons above (`NO_STATS_SOURCE`, `UNRESOLVED_FILL`,
`UNCONVERTIBLE_FEE_ASSET`, `INSUFFICIENT_ROUND_TRIPS`, `NON_POSITIVE_NET_PNL`,
`INSUFFICIENT_WINDOW`) all resolve to **not permitted** — there is no default-open path.

**Unchanged deployment ceremony on top:** a permitted verdict only means the lane is _eligible_ to
attempt arming. The four live gates (env flag + bootId-bound interlock + validated keys with
withdrawals disabled + complete risk limits), the `NODE_ENV=test/ci` override, and the human
`paper` → `main` merge described earlier in this file are entirely unchanged. Nothing here
automates a live promotion — a human still decides and arms manually.

**Evidence an operator can run directly (read-only):**

SQL over the same tables the port reads (adjust the demo-mode filter/window as needed):

```sql
-- Closed-cycle inputs: ordered fills for the testnet (demo) mode, joined to order_intents
-- for strategyId/side, oldest→newest.
SELECT f.executed_at, f.symbol, oi.strategy_id, oi.side, f.qty, f.price, f.fee, f.fee_asset
FROM fills f
LEFT JOIN order_intents oi ON oi.id = f.intent_id
WHERE f.mode = 'testnet'
ORDER BY f.executed_at ASC;

-- LLM token totals across both call sites (decide + reflection).
SELECT
  SUM(input_tokens)  AS decide_input_tokens,
  SUM(output_tokens) AS decide_output_tokens
FROM agent_decisions;

SELECT
  SUM(input_tokens)  AS reflection_input_tokens,
  SUM(output_tokens) AS reflection_output_tokens
FROM llm_usage;
```

`promtool` queries against the new gauges (`src/modules/observability/promotion-metrics.service.ts`,
sampled on its own 5-minute interval — `evaluate()` runs full-table scans, deliberately kept off
the 5s sampling loop):

```
agentic_promotion_round_trips
agentic_promotion_net_pnl_usd
agentic_promotion_llm_cost_usd
agentic_promotion_window_days
agentic_promotion_ready         # 1 = permitted, 0 = not permitted
```

Dashboard: the "Agentic lane (LLM)" row in `observability/grafana/dashboards/crypto-bot.json`
carries panels for all five (net-of-cost PnL, readiness, round trips vs the 30 threshold,
evidence window vs the 14-day threshold).

## 2026-07-06b — Evidence-quality pass (reconciliation fixed; learning loop live; protective backstop)

Same-day follow-up shipping the levers that make the earned-live evidence trustworthy and the
learning loop real:

- **Reconciliation now actually confirms venue truth.** The 30s sweep had silently thrown on EVERY
  pass since the demo went up (symbol-less `fetchOpenOrders()` throw swallowed by the driver's empty
  catch — `reconciliations` had ZERO rows ever). Fixed: per-symbol open-order sweep, a
  `result="error"` accounting path (a failing pass can never be silent again), and the balances axis
  disabled on the shared demo wallet only. First CLEAN rows verified live within minutes of deploy.
  This closes the prior "top backlog item" blocking any live promotion (see the 2026-06-15 section).
- **The reflection loop had NEVER fired** (llm_usage empty, playbook stuck at seed v1 after 21 round
  trips): its trade counters reset on every redeploy. Now seeded from DB truth (closed trips since
  the last reflection row), the cooldown runs 24h on the demo (compose), and reflection evidence
  gains realized venue round trips (fills-walked, net-of-fee, with decide-vs-fill slippage) clearly
  distinguished from the t+1 close-price proxies. The auto-promotion count is floored by the DB
  total, so redeploys no longer starve the ≥30 gate either.
- **Bot-side protective exits** (`PROTECT_STOP_LOSS_PCT`/`PROTECT_TRAILING_PCT`) backstop every long
  through the full risk path even when the LLM is dark — improving the risk-adjusted quality of the
  round trips the evidence window accrues.
- **Multi-symbol** (`TRADING_SYMBOLS`, one instance per symbol) multiplies evidence accrual; the
  readiness walk already counts per (strategyId, symbol) and needs no change.
- Cost-honesty guard: `AGENTIC_MODEL`'s schema default now matches the 3/15 token-price defaults
  (Sonnet-5), and the flat-pricing operator rule above governs any pricier
  `AGENTIC_REFLECTION_MODEL` pin.
