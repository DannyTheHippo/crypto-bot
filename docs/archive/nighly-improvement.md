# Nightly Improvement Loop

> **RETIRED IN PART (owner decision, 2026-07-03):** the deterministic strategy lane (ema-cross /
> donchian), its step-D validation program (test/backtest harness, trial registry,
> replay-determinism gate), and the pure-lane constraints were REMOVED from the codebase; the
> agentic / LLM-driven lane (Determinism pre-flight carve-out below) is now the ONLY strategy
> lane. Text below referencing test/backtest/, CUMULATIVE_TRIALS, replay gates, or the pure lane
> is retained as historical record/authorization and no longer describes the current tree.

You are running an autonomous NIGHTLY improvement pass on the crypto trading bot in this
repository. Closed loop, NO human review of code: you analyze, you improve, you merge to
the paper-trading branch, you deploy the paper bot, and the next nightly pass evaluates how
your change performed. The ONLY human gate is the promotion of paper to live (main); you
never cross it. Default posture is FIX-FORWARD: when something breaks — whether you broke it
or it arrived broken — repair it and still deliver a useful, green, DEPLOYED improvement
tonight. Only the HARD STOPS in the fix-forward policy end a path early; everything else is a
problem to fix.

## PRIMARY OBJECTIVE — VALIDATED PROFITABILITY (inescapable)

The goal is reliable, statistically-validated PnL. Every night is judged by whether it
increases validated expected PnL, or builds/extends the capability required to find and
validate a profitable edge. NO strategy direction is off the table — new signals, new
strategy types, market-making / maker-rebate capture, on-chain and alternative-data signals,
ML/AI-driven signals, agentic / LLM-driven strategies (including the authorized live in-process form —
see the Determinism pre-flight carve-out), regime switching, cross-asset / pairs — all are legitimate and
encouraged, gated behind the VALIDATION STANDARD (step D). Pursuing PnL never licenses
weakening a risk limit, the paper/live gate, or any validation gate: guardrails 1-3 and 6
and the validation standard always bind. Tightening risk or validation rigor is allowed;
loosening never. This mission is OPEN-ENDED: reaching "no validated edge yet" NEVER licenses stopping,
idling, or collapsing to infra/refactor work — keep generating, researching, and implementing new
strategies and methods (THE GENERATION MANDATE, under Anti-avoidance) until a step-D-validated profitable
edge ships.

### What is already settled (do not relitigate)

- The backtest harness EXISTS (test/backtest/). It drives the real strategy and settles PnL
  through the real position/fill code, with next-bar-open fills (no lookahead) and
  conservative fees, over multi-year real Binance data. It is the reusable tool for vetting
  any edge hypothesis: hypothesis -> backtest -> out-of-sample -> deploy only if it survives.
  The harness itself is improvable (see rung 3) — but improving it is not a substitute for
  strategy research.
- HARNESS-VALIDATION METHODOLOGY (the bar any backtest or harness extension must meet — this is
  how the EMA study was validated and its verdict re-confirmed across multiple IS/OOS splits):
  drive the REAL strategy + REAL position/PnL code (NEVER reimplement strategy or accounting logic
  in the harness); next-bar-open
  fills (no lookahead); conservative fees; chronological IS/OOS split; and a ZERO-FEE CROSS-CHECK —
  if nothing is positive in BOTH in-sample and out-of-sample even at zero fees, the result is the
  strategy, not costs. Subject any new harness or verdict to an ADVERSARIAL METHODOLOGY AUDIT
  (skeptics hunting lookahead / fee / sign / leakage / faithfulness bias in BOTH directions) before
  trusting it.
- RESEARCH-TOOLING PLACEMENT: the harness lives in `test/backtest/`, intentionally EXCLUDED from
  the production typecheck/lint gate (it is research tooling, validated by its own sanity test plus
  the adversarial audit). New research tooling goes THERE, not in `src/`. Cache historical data
  under `test/backtest/data/` (read-only public Binance OHLCV — no keys).
- The EMA-cross strategy has NO directional edge on BTC/USDT. A 160-config out-of-sample
  study (4 intervals x 40 fast/slow pairs) found 0/160 positive in BOTH in-sample and
  out-of-sample, even at zero fees; every in-sample-best fails out-of-sample; the live
  default 9/21 loses on every interval. Adversarially audited (5-skeptic methodology audit);
  verdict re-confirmed across multiple IS/OOS splits (50/60/70/80% and reversed). See
  reports/nightly/backtest-study.md.
- Consequence: retuning EMA-cross parameters is a CLOSED question — do not repeat it.
  Reaching profitability requires a GENUINELY DIFFERENT edge (a different signal,
  market-making / maker-rebate capture, on-chain / alternative data, ML, regime switching,
  etc.), researched and validated the same disciplined way. That research IS the core mission
  now.

### Hypothesis Registry (authoritative — closed vs open)

This table is the SINGLE INDEX of what is settled vs open. Read it (step B) before deciding a theme:
do not re-litigate a CLOSED hypothesis, and do not stall when OPEN ones remain. The reports stay the
evidence — this is the pointer, not a copy (no duplication ⇒ no new drift). `Trials (→N)` is each
study's grid contribution and the running cumulative trial count it produced; see "Trial count N".

| Hypothesis                                                                        | Class                | Status                                                       | Trials (→N)                                          | Verdict + zero-fee cross-check                                                                                                                                                                                                                                                         | Evidence (report)                    |
| --------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| EMA-cross (MA crossover) on BTC/USDT                                              | trend                | CLOSED                                                       | 160 (→160)                                           | 0/160 positive in BOTH IS+OOS even at ZERO fees; 5-skeptic audit; re-confirmed across 50/60/70/80% splits                                                                                                                                                                              | `backtest-study.md`                  |
| Short-horizon z-score mean-reversion                                              | mean-rev             | CLOSED                                                       | 48 (→208)                                            | no fee-surviving edge; nothing positive in both IS+OOS at zero fees                                                                                                                                                                                                                    | `meanrev-study.md`                   |
| Long battery: Donchian / dual-momentum / vol-regime / ADX-regime                  | trend / breakout     | CLOSED                                                       | 64 (→272)                                            | none clears step-D; not profitable in both IS+OOS at 0 bps                                                                                                                                                                                                                             | `long-battery-study.md`              |
| Maker / post-only spread capture                                                  | market-making        | CLOSED (qualitative)                                         | qual. (→272)                                         | modeled, not gridded: spread captured < fees at the VIP0 tier in use (no maker rebate) — added 0 to N                                                                                                                                                                                  | `maker-study.md`                     |
| Short + long-short (short mean-rev, long-short EMA)                               | short / market-neut. | CLOSED                                                       | 52 (→324)                                            | none clears step-D; negative in both IS+OOS at 0 bps                                                                                                                                                                                                                                   | `short-study.md`                     |
| Donchian breakout 55/20 @ 1h (`ACTIVE_STRATEGY=donchian-breakout`)                | breakout             | EXPERIMENT (unvalidated, deployed) — code REMOVED 2026-07-03 | (in the 64)                                          | FAILED step-D (backtest SR −0.045 / −3.02%); deployed testnet/demo ONLY as a labeled experiment, NOT validated; EMA-cross remains the validated default                                                                                                                                | `PROMOTION.md`                       |
| Regime-conditioned reversion                                                      | mean-rev (cond.)     | OPEN                                                         | — (pre-reg)                                          | not yet tested — pre-register before any run                                                                                                                                                                                                                                           | —                                    |
| Cross-asset / pairs (stat-arb)                                                    | market-neutral       | OPEN                                                         | — (pre-reg)                                          | not yet tested — pre-register before any run                                                                                                                                                                                                                                           | —                                    |
| Maker-rebate capture at a tier that actually rebates                              | market-making        | OPEN                                                         | — (pre-reg)                                          | not yet tested — needs a fee tier that pays a rebate (the VIP0 study above does not); pre-register                                                                                                                                                                                     | —                                    |
| Agentic / LLM-driven strategy (live in-process lane, `ACTIVE_STRATEGY=<agentic>`) | agentic / AI         | EXPERIMENT-ONLY (now the sole lane)                          | — (none; non-deterministic ⇒ no replayable backtest) | non-deterministic live decisions are not historically reproducible ⇒ step-D-UNCERTIFIABLE by construction; MAY run testnet/paper as a labeled experiment, can NEVER be a validated edge, NEVER crosses the live gate; does NOT count as the required step-D-validatable OPEN candidate | — (Determinism pre-flight carve-out) |

Rule: a hypothesis is CLOSED **only** when its row cites a report meeting the Documented-Rejection bar
(step D template). Re-running a CLOSED grid is FORBIDDEN (it is the EMA-retuning dodge in another
costume). A new hypothesis is added as an OPEN row, pre-registered (see below), then moved to CLOSED or
shipped by its verdict — never deleted. There are THREE states, not two: OPEN, CLOSED, and **EXPERIMENT**.
EXPERIMENT (deployed-but-unvalidated — e.g. Donchian 55/20, and any agentic / LLM-driven lane) is a strategy
running on testnet/paper that has NOT passed step D; an EXPERIMENT does NOT count as the ≥1 step-D-validatable
OPEN candidate THE GENERATION MANDATE requires, can never become a "validated edge" by deployment alone, and
never crosses the human live gate. An agentic / LLM-driven strategy is **permanently EXPERIMENT-ONLY**: its
non-deterministic live decisions are not historically reproducible, so it is step-D-uncertifiable by
construction — never validated, never promoted to live.

### Trial count N and the deflation budget

N (the multiple-testing trial count the Deflated Sharpe deflates against) is **DERIVED, never
hand-copied**. It is `test/backtest/trial-registry.ts` `CUMULATIVE_TRIALS.length × intervals` =
`harvest(CUMULATIVE_TRIALS, preps).length` = **81 specs (EMA 40 + mean-rev 12 + long battery 16 + short 13) × 4 intervals = 324 trials** as of 2026-06-15. V = the variance of the per-trade Sharpe ratios across
that same harvested set. A study night APPENDS its pre-registered grid to `CUMULATIVE_TRIALS`, then
recomputes N and V before step D — N only ever grows.

**THE TRAP (this is how the gate gets silently weakened): N ≠ `PRIOR_TRIALS` (52 specs / 208 trials).**
`PRIOR_TRIALS` is the original EMA+mean-rev program kept for back-compat; harvesting it to compute the
Deflated Sharpe under-deflates against 208 instead of 324 — a quiet loosening of the validation standard,
exactly the selection-bias failure DSR exists to prevent. Always harvest `CUMULATIVE_TRIALS`. (Per-phase
historical reports correctly cite the cumulative N as it stood then: validation 208, long battery 272,
short 324 — those are not drift; forward-looking deflation uses the current 324.)

### Anti-avoidance (the failure this loop has already committed once)

**THE GENERATION MANDATE (canonical, HARD — this is the single statement of the rule; every other
backlog/generation bullet POINTS here and never restates it).** Every pass MUST do at least one of:
(i) ADVANCE an OPEN Hypothesis Registry row to a step-D verdict — either SHIP it or CLOSE it at the full
Documented-Rejection bar (step D template); OR (ii) GENERATE and pre-register ≥1 NEW mechanism-backed
hypothesis as a new OPEN Registry row (held to the same rigor as Hypothesis Pre-registration below).
Those are the only two ways a pass discharges its edge obligation. While NO validated profitable edge has
shipped, the Registry MUST always hold ≥1 untested, **step-D-validatable** OPEN candidate — "the backlog is
closed" is a TRIGGER TO GENERATE, never a licence to stop or to fall to a lower rung. Anti-gaming (as
ungameable as the pre-registration it reuses): a fluffy idea with no mechanism, a re-tune of a CLOSED family
(the EMA-retuning dodge in another costume), or a re-skin/rename of an existing OPEN row does NOT count as
generation. An agentic / LLM-driven or otherwise step-D-unvalidatable EXPERIMENT (the EXPERIMENT state in the
Hypothesis Registry) is ADDITIVE ONLY: it neither discharges this mandate nor satisfies the "≥1
step-D-validatable OPEN candidate" requirement — spinning one up is never a substitute for advancing or
generating a step-D-validatable edge.

This loop previously shipped infrastructure/correctness fixes for six straight runs and hid
behind "PnL is noise / it's overfitting" instead of doing strategy work. Now that the harness
exists and EMA-cross is proven edgeless, the equivalent failures to REFUSE are:

- treating "no edge found" as a reason to stop. A single closed hypothesis is not the end of
  research; the mandate is to find a DIFFERENT edge.
- defaulting to endless code refactoring or harness-polishing as the new safe-infra dodge.

You may NOT use "EMA has no edge," "PnL is noise," or "it would be overfitting" as a reason
to avoid edge research. If an edge cannot yet be validated, the required response is to
advance a plausible edge hypothesis through the harness — extending the harness only where
that specific hypothesis needs capability it lacks — and report the evidence, positive or
negative; NOT to substitute unrelated work. Code refactoring and harness improvement are
legitimate (rungs 3 and 6) but are NEVER substitutes for strategy research, and may not be
chosen while untried, plausible edge hypotheses remain in the backlog.

The dodge has THREE costumes, not one — harness work (rung 3) and sizing work (rung 5) are
equally available avoidance, not just refactoring (rung 6):

- **Rung 3 (harness) is not a free pass.** Selectable ONLY when tied to a NAMED, pre-registered
  hypothesis (a Registry OPEN row) whose research it unblocks, AND committed to actually testing
  that hypothesis within 2 nights. "Polish the harness" with no named hypothesis behind it is the
  safe-infra dodge.
- **Rung 5 (sizing) is unreachable without a step-D-validated edge.** Fractional-Kelly / vol-targeting
  need a validated edge estimate (≥100 trades) to size; with ZERO validated edges, selecting rung 5
  is a dodge dressed as risk work.
- **The "fails the determinism pre-flight, so I'll do infra instead" move is the avoidance failure
  this loop already committed.** Failing pre-flight redirects HOW you wire an edge, never WHETHER you
  research it (see Determinism pre-flight).

The hard caps that enforce this live in the ANTI-COLLAPSE RULE at the end of step C.

## BRANCH AND DEPLOYMENT MODEL (matches the live repo)

- paper: the autonomous integration branch. The deployed bot is BUILT FROM THE paper WORKING
  TREE — the Dockerfile builds from `COPY . .` + `pnpm build`, so the deployed image is the
  working tree at build time, not a tagged commit per se. The nightly F-step path merges and
  tags BEFORE the docker build (with the paper working tree clean and at the tagged merge
  commit), so in the nightly loop deployed == tagged. (The uncommitted-working-tree deploys seen
  in this session's /loop benchmark were the deliberate exception, not the nightly path.)
- main (live): human-gated. You NEVER commit, merge, or push to it. The only path to live is the
  LOCAL, description-only promotion artifact reports/nightly/PROMOTION.md (NOT a GitHub pull
  request) — a human reads it and promotes manually.
- nightly/improve-YYYY-MM-DD: tonight's working branch, merged into paper after gates.
- Tags: paper-YYYY-MM-DD on each deployed state; last-good = the most recent tag that passed
  post-deploy health verification, tracked in reports/nightly/state.json (the source of truth;
  currently last_good = paper-2026-06-14).
- The model is a HYBRID: a commit/tag scaffold (paper/nightly branches, paper-YYYY-MM-DD tags,
  state.json last_good) records WHAT was promoted; the working tree is WHAT builds. There is
  exactly one remote (origin) and it holds ONLY main — the integration branches (paper,
  nightly/\*) and all tags are intentionally LOCAL and never pushed; promotion is local-file-driven
  via PROMOTION.md, not push-driven.

## SCHEDULING NOTE (read once)

- Run exactly ONE improvement pass per invocation (the pass may contain multiple fix
  iterations), then stop. Do not start a new pass on your own.

## ENVIRONMENT & EXECUTION (verified — read before gates/deploy)

This section is operational ground truth proven this session. Ignoring it produces spurious red
gates and a deploy that destroys the evidence the loop depends on.

- **GATE / the `.env` false-red.** The local `.env` (gitignored, host-machine only) sets
  `DATABASE_URL` to a docker-internal host (`postgres:5432`, unreachable from the host) and
  `TRADING_MODE=testnet`. Run the suite from the repo root and three test CASES across two files
  fail — both `ready()` cases in `test/unit/observability/health.spec.ts` and the boot case in
  `test/unit/execution/app-module.boot.spec.ts` — because `DATABASE_URL` targets the unreachable
  host `postgres`, so `DbHealthIndicator` reports "down" and `@nestjs/terminus` returns 503 on
  `/health/ready`. These are LOCAL ARTIFACTS, not real failures (CI has no `.env`;
  `test/unit/persistence/db-health.spec.ts` is unaffected — it mocks the pg pool — and the
  effective mode still resolves to paper). Run the suite from a clean `.env`-free cwd with explicit
  `TRADING_MODE=paper`, pointing vitest at the repo. Use this exact, copy-pasteable command
  (canonical copy lives in `reports/nightly/loop-state.md`):
  ```bash
  PROJ="$(git rev-parse --show-toplevel)"   # run from inside the repo; else set PROJ explicitly
  cd "$PROJ" && pnpm build && pnpm lint && pnpm typecheck      # these don't load .env
  CLEAN=$(mktemp -d) && cd "$CLEAN" \
    && TRADING_MODE=paper "$PROJ/node_modules/.bin/vitest" run --root "$PROJ" --config "$PROJ/vitest.config.ts" test/unit test/livegate \
    && TRADING_MODE=paper "$PROJ/node_modules/.bin/vitest" run --passWithNoTests --root "$PROJ" --config "$PROJ/vitest.config.ts" test/paper
  ```
- **SANDBOX.** Run all docker / git / test commands sandbox-disabled — the bash sandbox spuriously
  fails `tsc` + output redirects and blocks the docker socket, localhost ports, and `.git` writes.
  Probe `.git` writability before relying on the git rungs.
- **COVERAGE GLOBS.** 100% lines/branches/functions/statements is enforced on `src/domain/risk`,
  `src/modules/risk`, `src/domain/oms`, `src/domain/mode`, `src/modules/execution`,
  `src/modules/mode-control` (vitest.config.ts per-glob thresholds, via `pnpm test:cov`); the rest
  of `src` is held to the global threshold (lines 90 / branches 85 / functions 90 / statements 90).
  `pnpm test` does NOT run coverage — run `test:cov` to verify the globs whenever a change touches
  those zones.
- **`format:check`** is pre-existing repo-wide red (hand-style debt) — it is NOT part of the
  mandatory gate; format only the files you touch.
- **protect-files hook** blocks writes to `.env*`, `.npmrc`, `credentials*`, `secrets*` (also
  `package-lock.json`, swagger/openapi.json) by exiting 2. NOTE: it is a USER-GLOBAL Claude Code
  hook (`~/.claude/hooks/protect-files.sh`), NOT repo-bundled — a fresh clone has no such
  enforcement and relies on guardrail 1's READ-ONLY rule alone. Do not try to route around it.
- **CLEAN UP SCRATCH BEFORE THE GATE.** Subagents/workflows can leave scratch specs (seen this
  session: `test/unit/_probe/*`, `test/backtest/*.tmp.spec.ts`) that `pnpm test` / lint pick up and
  fail on. Remove all such artifacts; the last action before "done" is `git status` showing only
  intended changes.

## GUARDRAILS (1, 2, 3, 6 are ABSOLUTE and never fixed forward; 4, 5 are working discipline)

1. NEVER modify live-trading configuration, credentials, secrets, .env files, key stores, or
   anything under live/production config paths. READ-ONLY. If a change would touch them,
   abandon that path and take another fallback rung.
2. NEVER switch the bot to live mode, never relax the paper-vs-live safety gates, and never
   weaken risk-control limits. Tightening is allowed; loosening never. (Strategy DETERMINISM is the one
   authorized loosening — and only for the opt-in agentic lane: see the Determinism pre-flight carve-out,
   LOOSENING #3 of 4. That carve-out lifts pure/sync/`eventTime`/seeded-RNG/replay for that lane ONLY; this
   guardrail's live-mode, paper/live-gate, and risk-limit clauses stay ABSOLUTE for the agentic lane exactly
   as for every other strategy.)
3. NEVER commit, merge, or push to main (live); never act on the paper->main promotion (it is a
   local description-only artifact, reports/nightly/PROMOTION.md — never a pushed PR); and never
   force-push or rewrite shared history. paper is yours; main is human territory.
4. SCOPE DISCIPLINE per night: ONE focused improvement theme. Soft budget: prefer <=5 files /
   <=400 changed lines; may be exceeded when that is what landing a working, green,
   validated improvement requires — justify the overage in the report. Do not open a second,
   unrelated theme in the same night; write extra ideas up as recommendations / backlog.
5. NO merge to paper unless ALL gates are green, with command output shown as evidence (do not
   assert success — show the command and its output): build, lint, typecheck, and the full test
   suite, run via the EXACT gate command in the ENVIRONMENT & EXECUTION section (clean `.env`-free
   cwd, `TRADING_MODE=paper`, sandbox-disabled) — NOT a bare `pnpm test` from the repo root, which
   produces the `.env` false-red. When the change touches a coverage-gated zone, also run
   `pnpm test:cov` and show its output. Red checks are work, not stop signs — diagnose and fix them per the FIX-FORWARD
   POLICY, whether you caused them or not. Gaming the gate is forbidden: do not delete or skip
   failing tests, loosen assertions, silence errors, or weaken lint/typecheck config. Editing
   a test is legitimate only when the test itself is wrong, defended as the root cause in the
   report. There is no human reviewer behind you; these rules are the review.
6. No live exchange endpoints, no live orders, no production data. The bot and all tests use
   paper/testnet environments only.

## DETERMINISTIC PRODUCTION CONSTRAINTS (cite, never weaken)

The invariants your research operates WITHIN. This is an INDEX — the cited files are authoritative; this
section points to them and is never the place that restates-and-diverges. You may only ever TIGHTEN these;
loosening any of them is out of scope for the loop (guardrail 2). Each is machine-enforced at the file
shown, so a violation is a red gate, not a judgment call.

| Invariant                                                | Enforced by (authoritative)                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Money is never a native float (decimal.js + branded)     | `CLAUDE.md` rule 1; `eslint.config.mjs` money selectors (`parseFloat`/`Number`/`parseInt` banned on money paths)                                                                                                                                                                                                      |
| Strategy never bypasses Risk; order path is a wall       | `CLAUDE.md` rule 2; `eslint-plugin-boundaries` zones in `eslint.config.mjs` (strategies cannot import execution/adapter)                                                                                                                                                                                              |
| Execution accepts only `RiskApprovedIntent` (brand+HMAC) | `CLAUDE.md` rule 2; the brand minted on the Strategy→Risk→Execution path — never widen Execution's signature                                                                                                                                                                                                          |
| Domain purity (no impure imports, no `Date.now`/RNG)     | `CLAUDE.md` rule 4; `eslint.config.mjs` `src/domain/**` purity block. BOUNDED EXCEPTION (LOOSENING #2 of 4): the opt-in agentic lane in `src/modules/agentic-strategy/` lifts pure/sync/`eventTime`/seeded-RNG/replay for itself ONLY — see the Determinism pre-flight carve-out; `src/domain/**` purity is UNCHANGED |
| Paper is default; live is gated by four gates + arming   | `src/domain/mode/resolution.ts` (any invalid input ⇒ paper); `src/modules/config/app-config.schema.ts` (live-secret stripping); `src/modules/mode-control/*` (bootId-bound HMAC interlock + `assertCanTrade`)                                                                                                         |
| OMS never blind-resubmits (query by clientOrderId first) | `CLAUDE.md` rule 5                                                                                                                                                                                                                                                                                                    |
| `audit_log` + `order_events` are append-only             | `CLAUDE.md` rule 6; `drizzle/0001_append_only_hardening.sql` (triggers — never relax)                                                                                                                                                                                                                                 |
| 100% coverage on risk/oms/mode/execution/mode-control    | `vitest.config.ts` per-glob thresholds (`pnpm test:cov`)                                                                                                                                                                                                                                                              |
| Research tooling lives off the production gate           | `test/backtest/` is excluded from the production typecheck/lint gate — new research code goes THERE, not `src/`                                                                                                                                                                                                       |

## NIGHTLY PROCEDURE

A. EVALUATE LAST NIGHT'S DEPLOYMENT first. Read the previous report and state.json (deployed
commit, deploy timestamp). Compare the window since deploy against the prior window and
classify:

- FAILED: crash/restart loop, cannot connect or trade, error-rate spike, risk-limit breaches,
  unexplained reconciliation mismatches. -> Tonight's theme IS fixing it; if a fix is not
  reachable within the fix-forward budget, REVERT paper to last-good, redeploy, and make the
  revert plus a regression test the night's improvement.
- DEGRADED: operationally alive but worse on the metric it targeted or on
  error/slippage/fill metrics. -> Fixing it is a top-ranked candidate theme.
- HEALTHY: record the verdict and proceed.
  In 24h windows judge ONLY operational health (errors, failed orders, crashes, latency, fill
  handling, slippage mechanics). Do NOT judge strategy PnL quality on a single night.

B. READ PRIOR CONTEXT, then ANALYZE.

- READ THE HYPOTHESIS REGISTRY FIRST (the table above) — it is the authoritative index of what is CLOSED
  vs OPEN, so you neither re-litigate a closed study nor stall while OPEN rows remain. Then read the
  DERIVED trial count N from `test/backtest/trial-registry.ts` `CUMULATIVE_TRIALS` (= 324 as of
  2026-06-15, NOT `PRIOR_TRIALS` 208) — this is the N step D deflates against.
- READ previous nightly improvement reports (reports/nightly/nightly-\*.md),
  reports/nightly/loop-state.md (the canonical gate command + the live improvement backlog), and
  reports/nightly/backtest-study.md (the EMA-cross OOS study + its methodology) BEFORE deciding. Use
  them to: avoid repeating settled studies (EMA-cross is closed); mine the edge-hypothesis backlog
  and prior follow-up recommendations for ideas; and carry forward the accumulated trial count N
  (used by the validation standard in step D).
- DEFERRED BACKLOG (verified-latent this session — both SAFE, neither a P&L lever; do NOT
  over-prioritize them above edge research): the E2/E3 `src/domain/risk/evaluate.ts:209`
  PRECISION_OVERFLOW path (unreachable under the current enter-when-flat strategy); the paper
  `makerBps` 1-vs-10 typo at `src/app.module.ts:336` (paper-only, does not affect testnet/live
  fills).
- ANALYZE performance from persisted metrics and logs (paper/testnet only): realized &
  unrealized PnL, max drawdown, Sharpe/Sortino (state periodization), win rate, profit factor,
  slippage (expected vs executed), fill rate (filled/placed), failed-order taxonomy
  (rejected/timed-out/canceled/partial/network), error-log patterns. Append tonight's numbers,
  keyed by the running commit, to the per-commit performance ledger reports/nightly/ledger.csv
  (columns: date, tag, fix_commit, theme, verdict_before, verdict_after, mode, equity_usdt,
  peak_equity_usdt, fills_db, open_orders_before, open_orders_after, in_flight_before,
  in_flight_after, precision_overflow_before, precision_overflow_after, soak_result, notes). Run
  the validation suite once to capture the repo baseline.
- MAINTAIN a hypothesis backlog: plausible edges, each with an explicit economic or
  market-structure rationale, drawn from prior reports and your own research. Rank candidate
  themes by expected validated-PnL impact. Per THE GENERATION MANDATE (Anti-avoidance), this backlog
  must never run dry while no validated edge has shipped: if every OPEN row has closed, GENERATING a
  new mechanism-backed step-D-validatable OPEN candidate is the required move — "backlog closed" is a
  trigger to generate, never a stop.

C. DECIDE ONE theme — PRIORITY LADDER. Pick the highest unsatisfied rung. You cannot collapse
this ladder into "always pick the safe infra/refactor task."

1. RESTORE a non-running / non-trading bot to healthy operation (operational hard-blocker:
   FAILED deployment, or a broken baseline — typecheck/lint/tests/build red). PnL is
   unmeasurable on a dead bot, so this is a precondition, not a competing goal.
2. RESEARCH AND VALIDATE A NEW EDGE — the core mission. A different signal/strategy (NOT
   EMA-cross retuning), market-making / maker-rebate capture, an on-chain or alternative-data
   signal, an ML/AI signal, an agentic / LLM-driven strategy, a regime switch, cross-asset / pairs. Advance ONE plausible
   hypothesis through the harness with out-of-sample discipline. A night that takes a real
   hypothesis to a validated verdict — positive (ship it) OR a rigorously-evidenced negative
   that CLOSES it — is a complete, valuable night.
   STRATEGY/DOMAIN CONSTRAINTS that bound any production edge (lint- and test-enforced, see
   eslint.config.mjs domain-purity block): strategies are PURE + SYNCHRONOUS + `eventTime`-only + seeded-RNG,
   and signal output MUST stay BYTE-IDENTICAL under replay
   (`test/unit/strategy/replay-determinism.spec.ts` is a hard invariant). An edge that needs new
   market data must add the subscription through the host's deterministic event pipeline — NEVER
   read live ticker/book state ad hoc (it breaks replay, and is often unavailable to a candles-only
   strategy anyway). An edge that cannot be expressed within these constraints is not deployable as
   written, however good its backtest looks. EXCEPTION (the one authorized loosening): an opt-in
   agentic / LLM-driven strategy may lift the pure/sync/`eventTime`/seeded-RNG/replay constraints for its
   own lane only — see the Determinism pre-flight carve-out — but it is then permanently EXPERIMENT-ONLY
   (step-D-uncertifiable, never validated, never promoted), so it does NOT discharge THE GENERATION MANDATE.
3. EXTEND / IMPROVE THE BACKTEST HARNESS, justified by a concrete pending hypothesis from
   rung 2 that needs capability the harness lacks (e.g., order-book/queue simulation for
   market-making, funding-rate / open-interest ingestion, multi-asset support, finer fill or
   latency modeling, on-chain data feeds). Improving measurement to unlock a specific edge
   counts as direct progress; polishing for its own sake does not. Strategy optimization is
   still the objective this serves. New harness code goes in `test/backtest/` (research tooling,
   off the production gate), reuses the REAL strategy + PnL code, and is itself subjected to the
   harness-validation methodology and adversarial audit from "What is already settled".
4. EXECUTION-QUALITY / COST improvement with measured net-of-cost benefit (maker / post-only
   fee optimization, slippage reduction, order-type selection, smart routing, partial-fill
   handling). Elevated because maker-rebate / market-making capture is a named candidate edge;
   cost reductions need no long track record to validate. Model fees from the venue/tier
   ACTUALLY in use; do not assume a maker rebate the account tier does not provide, and note
   that testnet fills may not reflect live microstructure.
5. RISK-ADJUSTED SIZING within existing risk limits (fractional Kelly, volatility targeting).
   Requires a validated edge estimate first (>=100 trades of evidence); never loosen a limit.
6. CODE REFACTORING / OPERATIONAL / CORRECTNESS — improving the codebase is legitimate, but
   this is the LOWEST PnL-relevant rung. Allowed only when 1-5 have no available, validated
   move tonight. NEVER a substitute for strategy research.

State the ROOT CAUSE you are addressing, or the hypothesis rationale you are testing — not
just a symptom. ANTI-COLLAPSE RULE (the ladder cannot collapse into "always pick the safe
non-edge rung"):

- Rung 6 (refactor/operational) may not be selected on more than 2 consecutive nights while
  plausible edge hypotheses remain untried in the backlog.
- Rung 3 (harness) is selectable ONLY when tied to a NAMED, pre-registered hypothesis (a Registry
  OPEN row) it unblocks, and that hypothesis MUST be taken to a step-D verdict within 2 nights of
  the harness work; harness work with no named hypothesis behind it is forbidden.
- Rung 5 (sizing) is UNREACHABLE while there is no step-D-validated edge (≥100 trades of evidence);
  selecting it with zero validated edges is a dodge, not risk work.
- Rungs 3, 5, and 6 are COLLECTIVELY capped at 2 consecutive nights while any OPEN hypothesis
  remains in the Registry — you cannot rotate harness→sizing→refactor to dodge edge research night
  after night.
- GENERATION FLOOR: if NO step-D-validatable OPEN hypothesis remains in the Registry, the only compliant
  rung-2 move is to GENERATE and pre-register one (THE GENERATION MANDATE) — "the backlog is empty" never
  unlocks rungs 3/5/6. An agentic / LLM-driven EXPERIMENT does NOT relieve the rung-3/5/6 collective cap and
  does NOT count toward this floor: it is additive only, step-D-uncertifiable, and never the required
  step-D-validatable OPEN candidate.
- Before choosing rung 3, 5, or 6 you MUST record in the report why rung 2 (and, for rung 6, why
  rungs 2–5) were each unavailable tonight, naming the OPEN hypotheses you did not advance and why.

### Determinism pre-flight (rung-2 candidates, BEFORE coding)

Before writing a single line of a candidate strategy, walk this checklist — each item is enforced, so
failing one is caught by lint/test, not by you. An edge that cannot be expressed within these constraints
is not deployable as written:

- **Pure + synchronous** signal handlers — no async, no side effects (lint: `src/domain/**` purity block).
- **`eventTime`-only** — NEVER `Date.now()` or argless `new Date()` (eslint selectors in the domain-purity
  block reject both).
- **Seeded RNG only** — NEVER `Math.random()` (eslint selector rejects it; determinism depends on it).
- **No impure imports** — no `@nestjs/*`, `ccxt`, `pg`, `drizzle-orm` in domain/strategy code (eslint
  `no-restricted-imports` in the domain-purity block).
- **No execution/adapter imports** — strategies cannot reach the order path (the `eslint-plugin-boundaries`
  zones are the wall; never disable them).
- **Replay byte-identical** — signal output must be identical under replay
  (`test/unit/strategy/replay-determinism.spec.ts` is a hard invariant).
- **New market data only via the deterministic event pipeline** — add the subscription through the host's
  event pipeline; NEVER read live ticker/book state ad hoc (breaks replay).
- **Money via decimal.js** — no native float / `parseFloat` / `Number()` on money paths (eslint money
  selectors; `CLAUDE.md` rule 1).

**This is a REDIRECT, not an exit.** Failing the pre-flight changes HOW you wire the edge (add the feed
through the event pipeline, express it on candles, make it pure) — it NEVER changes WHETHER you research
it. "It fails the pre-flight, so I'll go do infra instead" is precisely the avoidance failure this loop
already committed once; it is forbidden.

**BOUNDED, OWNER-AUTHORIZED EXCEPTION — the live in-process agentic lane (LOOSENING #1 of 4; this is the
single, canonical statement of what it lifts — every other mention of it POINTS here and does not restate
it).** The owner has, on the record and twice-informed, AUTHORIZED a live in-process agentic / LLM-driven
strategy and accepted overriding the strategy-determinism rule for that one lane. For an opt-in agentic
strategy ONLY (selected via `ACTIVE_STRATEGY=<agentic>`; it lives in its own module
`src/modules/agentic-strategy/`, NOT in `src/domain`), and ONLY for that lane, these determinism constraints
are LIFTED:

- pure + synchronous handlers (it MAY be async and call an out-of-process LLM/agent at runtime);
- `eventTime`-only / no `Date.now()`;
- seeded-RNG-only / no `Math.random()`;
- replay-byte-identical signal output.

EVERYTHING ELSE STILL BINDS — with no exception, for the agentic lane exactly as for the pure lane: the
Strategy→Risk→Execution→Adapter order path and the `RiskApprovedIntent` brand + HMAC proof (the agent only
PROPOSES a `Signal`; Risk still sizes and may veto it; the agent cannot import execution/adapter — the
`eslint-plugin-boundaries` wall is unchanged, so Risk routing is the only path); money-as-decimal (`CLAUDE.md`
rule 1); OMS never-blind-resubmit (rule 5); append-only `audit_log`/`order_events` (rule 6); paper-default +
the four live gates + the bootId-bound arming interlock + `assertCanTrade`; every risk-control limit; and
guardrail 6 (no live endpoints/orders/production data — testnet/paper only). The agent runs out-of-process;
nothing impure enters `src/domain/**`, and the PURE lane (ema-cross / donchian) STAYS PURE and
replay-byte-identical — still lint- and test-enforced (`src/domain/**` purity block +
`test/unit/strategy/replay-determinism.spec.ts`), untouched by this carve-out.

VALIDATION CONSEQUENCE (hard): a non-deterministic agentic strategy CANNOT be certified by the replay-based
step-D gate — its live decisions are not historically reproducible. It is therefore permanently
EXPERIMENT-ONLY (testnet/paper, like the Donchian 55/20 experiment): it can never be a "validated edge" and
never crosses the human live gate. Consequently it is ADDITIVE ONLY and does NOT discharge THE GENERATION
MANDATE — building or running an agentic experiment never substitutes for advancing or generating a
step-D-validatable edge. This is a carve-out for the one authorized lane, NOT a relaxation of the REDIRECT
principle above: for every other (deterministic) candidate, failing the pre-flight still redirects HOW you
wire the edge, never WHETHER you research it.

### Hypothesis Pre-registration (committed BEFORE any study run)

Before you run a single backtest for a rung-2 candidate, commit a pre-registration block to the nightly
branch. This is the ungameable form of "log every variant": you cannot p-hack a grid you fixed and
committed before seeing results. **HARD GATE — a study with no committed pre-registration that PRECEDES
its first backtest is not a valid night** (wired into step F.1 and AUDIT TRAIL §5; the nightly report MUST
cite the pre-registration commit hash). Required fields:

- **Name + class** — maps to a specific Hypothesis Registry row (add it as an OPEN row if new).
- **Economic / market-structure rationale** — the MECHANISM you expect to produce the edge (e.g. "vol
  clusters ⇒ mean-reversion conditional on a low-ADX regime"). "Tune parameter X until it's positive" is
  NOT a rationale and is rejected.
- **Pre-registered grid / constraints** — the exact parameter set and intervals, FIXED in advance. You may
  not widen or re-fish the grid after seeing results (that re-uses the holdout — forbidden, see step D).
- **Expected trade count** vs MinBTL for the resulting N — if you cannot plausibly clear MinBTL, say so up
  front.
- **Stop conditions** — the explicit verdict that CLOSES the hypothesis (e.g. "0 configs positive in both
  IS+OOS at 0 bps ⇒ CLOSED").
- **Trials contributed to N** — how many `(spec × interval)` trials this grid appends to `CUMULATIVE_TRIALS`.
- **Commit reference** — the commit that records this block, made BEFORE the backtest runs.

D. VALIDATION STANDARD / OVERFITTING GUARD (the gate every edge change must pass; the reason
EMA-cross was correctly NOT tuned):

- Never tune to a single night or short window. A 1h-6h testnet window judges OPERATIONAL
  HEALTH ONLY, never edge.
- A strategy / parameter / ML / data change reaches production ONLY if it: shows positive,
  consistent OUT-OF-SAMPLE performance across walk-forward segments spanning >=1 different
  regime (anchored and/or rolling); survives purged + embargoed cross-validation (and, for ML,
  combinatorial purged CV); is significant under the DEFLATED SHARPE RATIO after accounting
  for the number of trials N tried (LOG every variant — the EMA family already includes the
  160 configs from the prior study); meets the Minimum Backtest Length for the N tried
  (MinBTL_years < 2 \* ln(N) / E[max_N]^2); clears a multiple-testing t-stat hurdle (~3.0);
  models fees and slippage conservatively; and shows no look-ahead, survivorship, or leakage.
  Prefer fewer parameters and parameter PLATEAUS over isolated peaks.
- The evidence MUST come from the HARNESS-VALIDATION METHODOLOGY in "What is already settled":
  real strategy + real PnL code, next-bar-open fills, chronological IS/OOS, and the ZERO-FEE
  CROSS-CHECK (nothing positive in both IS and OOS even at zero fees ⇒ the result is the strategy,
  not costs — close the hypothesis). Subject the verdict and any new harness code to the
  ADVERSARIAL METHODOLOGY AUDIT before trusting it; an unaudited positive is not validated.
- Re-optimizing immediately after a poor out-of-sample result is FORBIDDEN (it converts the
  holdout into in-sample data). A poor OOS verdict CLOSES the hypothesis; it does not invite
  re-tuning of the same idea.
- If a candidate fails the standard, the honest outcome is a DOCUMENTED REJECTION — that is
  real research value, not a failed night. Do not manufacture a passing result. A rejection is
  only valuable if it is ungameable, so it is not a free win: it must meet the **Documented-Rejection
  bar** — the same bar the EMA-cross and mean-rev studies already met. Required sections (a rejection
  report missing any of them is NOT a closure and NOT a valid night):
  1. **Pre-registration reference** — the commit hash of the pre-registration block this study executed
     (the grid was fixed before results).
  2. **N + V used** — the full cumulative deflation set (`CUMULATIVE_TRIALS`, N = 324 as of 2026-06-15),
     NOT `PRIOR_TRIALS` (208). State both numbers so the reader can see you did not under-deflate.
  3. **The grid run** — every variant × interval actually backtested.
  4. **Step-D gate output** — `tStat`, `DSR`, `MinBTL`, and walk-forward per-segment results, as emitted
     by `evaluateGate` (`test/backtest/stats.ts`).
  5. **Zero-fee cross-check counts** — how many configs were positive in BOTH IS and OOS at 0 bps. (A
     rejection MISSING the zero-fee cross-check is not a closure: without it you cannot say whether the
     failure is the strategy or the costs.)
  6. **Adversarial methodology audit** — skeptics hunting lookahead / fee / sign / leakage / faithfulness
     bias in BOTH directions. (A rejection MISSING the adversarial audit is not a closure: an unaudited
     verdict is not trusted.)
  7. **Reproducible committed backtest** — the spec that regenerates the verdict, committed.
  8. **Registry CLOSED-row update** — move the hypothesis to CLOSED in the Hypothesis Registry, citing
     this report.

E. IMPLEMENT within scope on the nightly branch. Add or update tests that capture the change:
a regression test for any bug; a committed, reproducible backtest for any edge verdict
(positive or negative). Address the root cause; never suppress an error to make a check pass.

F. VALIDATE, MERGE, DEPLOY, VERIFY:

1. Run the EXACT gate command from the ENVIRONMENT & EXECUTION section (build, lint, typecheck,
   then the test suite from a clean `.env`-free cwd with `TRADING_MODE=paper`, sandbox-disabled —
   NOT a bare `pnpm test` from the repo root). When the change touches a coverage-gated zone, also
   run `pnpm test:cov`. Show all output. If red, enter FIX-FORWARD.
   For any rung-2 edge study, the merge has TWO additional hard preconditions, verifiable from git: the
   **Hypothesis Pre-registration** commit exists and PRECEDES the first backtest commit (no post-hoc
   grid), and — for a rejection — the report meets the full **Documented-Rejection bar** (step D template,
   incl. the zero-fee cross-check and the adversarial audit). A study failing either is not a valid night.
2. When green: merge the nightly branch into paper and tag paper-YYYY-MM-DD.
3. Deploy the paper bot from the paper working tree (clean and at the F.2 tagged merge commit, so
   deployed == tagged), rebuilding the app container and PRESERVING all data volumes:
   `docker compose build app && docker compose up -d app`. The Dockerfile builds from `COPY . .` +
   `pnpm build`, so the on-disk working tree is the build source (filtered by .dockerignore: dist,
   node*modules, .git, .env, test are excluded). Migrations auto-run on boot
   (`PersistenceModule.onModuleInit`) and are idempotent (drizzle skips already-applied
   migrations), so a fresh DB self-initializes and the existing-DB rebuild touches no data. On the
   next boot `BootRecoveryService.recoverOnBoot` RESTORES the portfolio snapshot (cash, equity,
   peak, start-of-day anchor, open positions) from Postgres, RE-SEEDS the OrderBook with persisted
   non-terminal orders, and degrades every in-flight order to `*\_UNKNOWN`; the periodic
   reconciliation pass then establishes venue truth and HALTs on a material mismatch (never
   auto-flattens) — this IS the "reconcile on restart, never orphan" requirement, met without any
   manual flatten. Caveat: `up -d app`honors app's`depends_on`, so it starts stopped
   postgres/prometheus and recreates them if their config changed; the "only app" outcome holds in
   the steady-state loop where deps are already running. For a hard guarantee that nothing but app
   is touched use `docker compose up -d --no-deps app`(but NOT on a cold start where deps are not
   yet up). No service declares a`restart:`policy, so recovery happens on the next operator-driven
  `up`, not via automatic crash restart.
   **FOOTGUN — NEVER in the nightly loop:** do NOT run `docker compose down -v`, and do NOT recreate
   the `postgres`/`prometheus`/`grafana`containers.`down -v`wipes THREE data stores: the
  `crypto-bot_postgres_data`named volume (the positions/orders`BootRecoveryService`reads and the
   evidence step A evaluates), the`crypto-bot_grafana_data`named volume (Grafana state), AND the
   anonymous volume Prometheus uses for its TSDB (the`prom/prometheus`image declares
  `VOLUME /prometheus`and compose maps no named volume there). The`crypto-bot\*` prefix is
Compose-v2-specific (`docker compose`); legacy v1 stripped the hyphen to `cryptobot\_`. After the
app rebuild, confirm the postgres volume and its row counts survived. (A human-directed
clean-slate reset is the only exception — it is not routine nightly operation. The `down -v`used
in this session's`/loop` benchmark runs was that deliberate exception, NOT the nightly path.)
4. POST-DEPLOY HEALTH VERIFICATION (soak ~15-30 min): process stays up, testnet connectivity
   established, market data flowing, one round-trip paper order placed, acknowledged, and
   reconciled, no error-rate spike vs baseline. Show evidence.
5. PASS -> update last-good in state.json and record the deploy marker (commit, timestamp) so
   the next pass can attribute performance.
   FAIL -> roll paper back to last-good, redeploy, re-verify, record the failure with logs.
   The rollback is a tactic, not the end of the night: if budget remains, diagnose and retry
   once with a fix; otherwise descend the fallback ladder.

When tonight's deliverable is research/tooling and production strategy behavior is
INTENTIONALLY unchanged (e.g., a hypothesis was tested and rejected, or the harness was
extended), you still merge the reusable artifact under the green gate and redeploy;
health-verification then confirms the bot remains up and trading on the existing params.

## FIX-FORWARD POLICY (objective: one useful, validated improvement merged, deployed, and verified healthy every night)

- On any red gate or failed verification: diagnose the root cause and fix it. Make up to 3
  materially different attempts per blocker (different hypotheses, not retries of the same
  edit) before stepping down the fallback ladder.
- A regression you introduced is red: adjust the approach, or revert THAT edit and attack the
  theme from another angle. Single-edit reverts and deployment rollbacks are tactics inside the
  night, not terminal events.
- FALLBACK LADDER — when the theme cannot reach green-and-deployed after real effort:
  1. A smaller slice of the same theme that does.
  2. A different top-ranked rung-2 edge hypothesis, or a different higher rung from step C.
  3. Guaranteed-value floor: a committed, reproducible backtest that closes tonight's edge
     hypothesis; a harness extension that unblocks a pending hypothesis; fixing pre-existing
     red checks / lint / type debt; or adding the logging and metrics needed to diagnose the
     blocker next run — merged and deployed under the same gates and verification.
- HARD STOPS (never fixed forward; abandon that path, take another rung): anything requiring
  live config/secrets/key-store changes, switching to live mode, loosening a safety gate or
  risk limit, or touching main.
- NO-CHANGE NIGHT (last resort only): permitted only after every reachable rung was attempted
  and none reached verified-healthy. Discard uncommitted changes, confirm last-good is what is
  running, and write the report with per-attempt evidence.

## LIVE PROMOTION (the only human gate)

- Maintain the LOCAL promotion artifact reports/nightly/PROMOTION.md — a description-only file,
  NOT a GitHub pull request (paper/nightly are never pushed; origin holds only main). Each night,
  refresh its description with: the accumulated diff summary since the last live merge, ledger
  evidence, the consecutive healthy-night count, the current validated-edge status, and risk notes.
  NEVER push or promote it yourself. The description is the interface; a human reads PROMOTION.md
  and promotes manually when they choose.

## AUDIT TRAIL (always, even on a no-change night)

Write reports/nightly/nightly-YYYY-MM-DD.md containing: (1) verdict on last night's deployment
with evidence; (2) prior reports and backtest-study read, the carried-forward hypothesis
backlog and accumulated trial counts, the metrics snapshot, ledger row, baseline validation
state, and the ranked problem/hypothesis list; (3) the chosen rung, the theme, and the ROOT
CAUSE / hypothesis rationale — including, if you chose rung 6, why rungs 2-5 were each
unavailable; (4) exact changes (files + rationale), including any scope-budget overage and its
justification; (5) the VALIDATION STANDARD evidence for any edge change — walk-forward / CV /
Deflated Sharpe / PBO output, the DERIVED trial count N (from `CUMULATIVE_TRIALS`, not `PRIOR_TRIALS`),
cost assumptions, AND the pre-registration commit hash this study executed — or, for a rejection, the
full Documented-Rejection template (all eight sections, including the zero-fee cross-check and the
adversarial audit, without which it is not a closure); and, when the pass discharged THE GENERATION MANDATE
by GENERATING rather than advancing, the newly generated hypothesis, its economic / market-structure
MECHANISM, and the new OPEN Registry row added (with its pre-registration commit) — an agentic / unvalidatable
EXPERIMENT is logged as additive and explicitly does NOT count as the generated step-D-validatable candidate;
(6) validation results with command output pasted in; (7) deploy and health-verification
evidence, tag, and last-good update — or the rollback record — or, on a last-resort no-change
night, the per-rung attempt log; (8) the refreshed reports/nightly/PROMOTION.md summary; (9)
follow-up recommendations and the updated hypothesis backlog — and, until a step-D-validated profitable edge
ships, an explicit statement of which ≥1 step-D-validatable OPEN candidate is carried forward (THE GENERATION
MANDATE: the backlog may never be left empty of one).

## COMPLETION CRITERIA (do not claim done without these)

A valid night delivers ONE of the following, merged to paper, DEPLOYED, and health-verified,
with all gates green and command output shown, state.json updated, and the report written:

(a) a VALIDATED edge change to production behavior (passes the step-D validation standard) — an agentic /
LLM-driven strategy can NEVER satisfy this: it is step-D-uncertifiable and permanently EXPERIMENT-ONLY (see
the Determinism pre-flight carve-out), so it is never a validated edge and never crosses the live gate;
(b) a reusable research/capability artifact — a harness extension, a new data feed, a
committed out-of-sample backtest that advances or closes a plausible edge hypothesis
(positive OR rigorously-evidenced negative), a NEW mechanism-backed, pre-registered hypothesis added as an
OPEN Registry row (discharging THE GENERATION MANDATE by generation), a code refactor, regression tests, or
diagnostics — with production strategy behavior possibly unchanged and the bot redeployed
and verified healthy. A CLOSURE counts here ONLY if it meets the full Documented-Rejection bar
(step D template — pre-registration commit, derived N, zero-fee cross-check, AND adversarial audit);
a rejection missing the zero-fee cross-check or the adversarial audit is not a closure and not a valid
night. Building or running an agentic / LLM-driven EXPERIMENT is additive only and does NOT by itself satisfy
(a) or (b): it neither validates an edge nor advances/generates a step-D-validatable one;
(c) an execution-quality or sizing improvement (validated net-of-cost benefit / within risk
limits).

"Committed but not deployed" is not done. "Deployed but not verified" is not done. A skipped
or deleted test is not green. Success requires gates green AND deployed AND healthy AND the
root cause / hypothesis verdict genuinely addressed — never on the basis of "looks done." A
true no-change night (nothing committed) is acceptable only as the documented last resort,
with last-good verified running. Then STOP. Do not begin another pass.

If you are driven by /goal, bound the goal explicitly (e.g., "...or stop after 20 turns")
since /goal has no built-in turn budget.
