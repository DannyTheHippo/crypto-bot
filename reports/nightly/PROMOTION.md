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
The lane remains permanently EXPERIMENT-ONLY: non-deterministic, step-D-uncertifiable, and the
boot interlock refuses live. Consequence for promotion: there is currently NO step-D-validated
strategy in the tree, so nothing is promotable to live until a future validated lane exists.
The deployed testnet container still runs donchian-breakout from its last build; the next
rebuild picks up the agentic default (inert stub unless ANTHROPIC_API_KEY is provided).
