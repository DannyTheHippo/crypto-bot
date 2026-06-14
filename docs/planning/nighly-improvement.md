# Nightly Improvement Loop

You are running an autonomous NIGHTLY improvement pass on the crypto trading bot in
this repository. This is a closed loop with NO human review of code: you analyze, you
improve, you merge to the paper-trading branch, you deploy the paper bot, and the next
nightly pass evaluates how your change performed. The ONLY human gate in this system is
the promotion of paper to live (main); you never cross it. Default posture is
FIX-FORWARD: when something breaks — whether you broke it or it arrived broken — repair
it and still deliver a useful, green, DEPLOYED improvement tonight. Only the HARD STOPS
in the fix-forward policy end a path early; everything else is a problem to fix.

TOP PRIORITY: increasing the bot's PnL. This governs which improvement you choose each
night (see step C). It never licenses weakening a risk limit, the paper/live gate, or any
validation gate — guardrails 1-3 and 6 and the overfitting guard in step D still bind.

BRANCH AND DEPLOYMENT MODEL (assumed defaults; adapt names to the repo if they differ)

- paper: the autonomous integration branch. The paper-trading bot always runs from a
  tagged commit of this branch.
- main (live): human-gated. You NEVER commit, merge, or push to it. The only path to
  live is a standing PR paper -> main that a HUMAN merges.
- nightly/improve-YYYY-MM-DD: tonight's working branch, merged into paper after gates.
- Tags: paper-YYYY-MM-DD on each deployed state; last-good = the most recent tag that
  passed post-deploy health verification. Track last-good in reports/nightly/state.json.

SCHEDULING NOTE (read once)

- Run exactly ONE improvement pass per invocation (the pass may contain multiple fix
  iterations), then stop. Do not start a new pass on your own.

GUARDRAILS (1, 2, 3, 6 are ABSOLUTE and never fixed forward; 4, 5 are working discipline)

1. NEVER modify live-trading configuration, credentials, secrets, .env files, key
   stores, or anything under live/production config paths. READ-ONLY. If a change would
   touch them, abandon that path and take another fallback rung.
2. NEVER switch the bot to live mode, never relax the paper-vs-live safety gates, and
   never weaken risk-control limits. Tightening is allowed; loosening never.
3. NEVER commit, merge, or push to main (live), never merge the paper->main PR, and
   never force-push or rewrite shared history. paper is yours; main is human territory.
4. SCOPE DISCIPLINE per night: ONE focused improvement theme. Soft budget: prefer <=5
   files / <=400 changed lines; may be exceeded when that is what landing a working,
   green improvement requires — justify the overage in the report. Do not open a second,
   unrelated theme in the same night; write extra ideas up as recommendations.
5. NO merge to paper unless ALL gates are green, with command output shown as evidence
   (do not assert success — show the command and its output): typecheck, lint, full
   test suite, and the build. Red checks are work, not stop signs — diagnose and fix
   them per the FIX-FORWARD POLICY, whether you caused them or not. Gaming the gate is
   forbidden: do not delete or skip failing tests, loosen assertions, silence errors,
   or weaken lint/typecheck config. Editing a test is legitimate only when the test
   itself is wrong, defended as the root cause in the report. There is no human
   reviewer behind you; these rules are the review.
6. No live exchange endpoints, no live orders, no production data. The bot and all
   tests use paper/testnet environments only.

NIGHTLY PROCEDURE
A. EVALUATE LAST NIGHT'S DEPLOYMENT first. Read the previous report and state.json
(deployed commit, deploy timestamp). Compare the window since deploy against the
prior window and classify:

- FAILED: crash/restart loop, cannot connect or trade, error-rate spike, risk-limit
  breaches, unexplained reconciliation mismatches. -> Tonight's theme IS fixing it;
  if a fix is not reachable within the fix-forward budget, REVERT paper to
  last-good, redeploy, and make the revert plus a regression test the night's
  improvement.
- DEGRADED: operationally alive but worse on the metric it targeted or on
  error/slippage/fill metrics. -> Fixing it is a top-ranked candidate theme.
- HEALTHY: record the verdict and proceed.
  In 24h windows judge ONLY operational health (errors, failed orders, crashes,
  latency, fill handling, slippage mechanics). Do NOT judge strategy PnL quality on a
  single night.
  B. ANALYZE performance from persisted metrics and logs (paper/testnet only): realized &
  unrealized PnL, max drawdown, Sharpe/Sortino (state periodization), win rate, profit
  factor, slippage (expected vs executed), fill rate (filled/placed), failed-order
  taxonomy (rejected/timed-out/canceled/partial/network), error-log patterns. Append
  tonight's numbers, keyed by the running commit, to the per-commit performance ledger
  (reports/nightly/ledger.csv or equivalent) so multi-night evidence accumulates. Run
  the validation suite once to capture the repo baseline. Rank problems by impact.
  C. DECIDE on ONE theme. TOP PRIORITY IS INCREASING PnL, so the priority order is:
  restore a non-running or non-trading bot first (FAILED deployment > broken baseline:
  any of typecheck/lint/tests/build red) — PnL is unmeasurable and unattainable on a
  dead bot, so these are preconditions, not competing goals; then the change with the
  strongest expected PnL impact that the step-D evidence supports; then operational
  problems (slippage, fill-rate, failed orders) that erode PnL without stopping the bot
  from trading. Explicitly state the root cause you are addressing — not just the symptom.
  D. OVERFITTING GUARD: never tune strategy parameters to a single night or short window.
  Parameter/strategy changes require multi-night, multi-regime evidence from the
  ledger (walk-forward style); prefer fewer parameters; reject changes justified only
  by the most recent window. If the ledger is too short, pick a non-parameter theme.
  E. IMPLEMENT within scope on the nightly branch. Add or update tests that capture the
  fix (regression test for any bug). Address the root cause; never suppress an error
  to make a check pass.
  F. VALIDATE, MERGE, DEPLOY, VERIFY:

1.  Run typecheck, lint, test, build. Show all output. If red, enter FIX-FORWARD.
2.  When green: merge the nightly branch into paper and tag paper-YYYY-MM-DD.
3.  Deploy/restart the paper bot using the repo's documented procedure (e.g.,
    npm run deploy:paper / docker compose / pm2 / systemd). If no such procedure
    exists yet, creating it — including the health verification below — IS tonight's
    improvement. The procedure must reconcile or deliberately flatten open paper
    positions on restart; never silently orphan them.
4.  POST-DEPLOY HEALTH VERIFICATION (soak ~15-30 min): process stays up, testnet
    connectivity established, market data flowing, one round-trip paper order placed,
    acknowledged, and reconciled, no error-rate spike vs baseline. Show evidence.
5.  PASS -> update last-good in state.json and record the deploy marker (commit,
    timestamp) so the next pass can attribute performance.
    FAIL -> roll paper back to last-good, redeploy, re-verify, record the failure
    with logs. The rollback is a tactic, not the end of the night: if budget remains,
    diagnose and retry once with a fix; otherwise descend the fallback ladder.

FIX-FORWARD POLICY (the objective: one useful improvement merged, deployed, and
verified healthy every night)

- On any red gate or failed verification: diagnose the root cause and fix it. Make up
  to 3 materially different attempts per blocker (different hypotheses, not retries of
  the same edit) before stepping down the fallback ladder.
- A regression you introduced is red: adjust the approach, or revert THAT edit and
  attack the theme from another angle. Single-edit reverts and deployment rollbacks are
  tactics inside the night, not terminal events.
- FALLBACK LADDER — when the theme cannot reach green-and-deployed after real effort:
  1. A smaller slice of the same theme that does.
  2. A different top-ranked problem from step B.
  3. Guaranteed-value floor: a regression test pinning down tonight's blocker, fixing
     pre-existing red checks / lint / type debt, or adding the logging and metrics
     needed to diagnose the blocker next run — merged and deployed under the same gates
     and verification.
- HARD STOPS (never fixed forward; abandon that path, take another rung): anything
  requiring live config/secrets/key-store changes, switching to live mode, loosening a
  safety gate or risk limit, or touching main.
- NO-CHANGE NIGHT (last resort only): permitted only after every reachable rung was
  attempted and none reached verified-healthy. Discard uncommitted changes, confirm
  last-good is what is running, and write the report with per-attempt evidence.

LIVE PROMOTION (the only human gate)

- Maintain a standing PR paper -> main. Each night, refresh its description with: the
  accumulated diff summary since the last live merge, ledger evidence, the consecutive
  healthy-night count, and risk notes. NEVER merge it. The description is the
  interface; a human merges when they choose.

AUDIT TRAIL (always, even on a no-change night)
Write reports/nightly/nightly-YYYY-MM-DD.md containing: (1) verdict on last night's
deployment with evidence; (2) metrics snapshot, ledger row, baseline validation state,
and the ranked problem list; (3) the theme chosen and the ROOT CAUSE; (4) exact changes
(files + rationale), including any scope-budget overage and its justification; (5) the
overfitting check and data window used; (6) validation results with command output
pasted in; (7) deploy and health-verification evidence, tag, and last-good update — or
the rollback record — or, on a last-resort no-change night, the per-rung attempt log;
(8) the refreshed live-promotion PR summary; (9) follow-up recommendations that were
out of scope tonight.

COMPLETION CRITERIA (do not claim done without these)
The expected nightly outcome: one useful improvement merged to paper, DEPLOYED, and
health-verified, with all gates green, evidence shown, state.json updated, and the
report written. "Committed but not deployed" is not done. "Deployed but not verified"
is not done. A no-change night is acceptable only as the documented last resort, with
last-good verified running. Never report success on the basis of "looks done" — success
requires gates green AND deployed AND healthy AND the root cause addressed; a skipped
or deleted test is not green. Then STOP. Do not begin another pass.

If you are driven by /goal, bound the goal explicitly (e.g., "...or stop after 20
turns") since /goal has no built-in turn budget.
