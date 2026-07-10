# Session Handoff — 2026-07-10

Plan: `~/.claude/plans/users-danielhendrich-claude-plans-open-replicated-platypus.md`
("Consolidated edge program — validation spine, perp, feeds, cost"). Read it first — this file
tracks execution state against its `## Todo Steps` DAG, not the design itself.

## Completed

- **#1 P0** `20c2ff9` — colon-form perp symbol parsing fix (`src/domain/types/symbol.ts`,
  `src/domain/risk/round-trips.ts`).
- **tooling** `4ffd668` — shield repo-glob tools from `.claude` agent worktrees.
- **#2 A1 / INT-A** `b30ed05` — validation spine re-fit from `5a17615` (`BarStrategy` port,
  decimal settlement, funding) under `test/backtest/`.
- **#3 B1 / INT-B1** `b078f64` — `PaperPerpAdapter` (binanceusdm swap), local liq model,
  `funding_events` migration, sandbox-guarded boot assertion.
- **#7/#8/#9 INT-A/INT-B1/INT-C1** merged in commit order per plan.
- **#12/#13 A2 / A2-gate** `5acc94a` — edge diagnostic (52 buckets, BTC/ETH×{15m,1h,4h,1d} +
  5 alts×15m, k∈{1,1.5,2,3}). Verdict **NO-GO**, 0/52 seams
  (`reports/loop/edge-diagnostic-2026-07-10.md`). Best qualified bucket BTC-4h: +10.2bps/RT
  holdout, DSR 0.152 vs 0.95 bar.
- **#21 ESC** `97b777e` — escalation recorded: recommend funding-carry (E) as the no-directional-
  call lever; derivatives/sentiment feed enablement second; fee-tier/BNB weak per prior 0/64.
- **C1** `d76e639` (+ `b4cb980` worktree snapshot) — derivatives feed (funding/OI/basis), flagged
  OFF, merged via INT-C1.
- **DELETED (no-go skip, correct per plan §A2-gate)**: C2 (expected-move/regime prompt features),
  C3 (v2 candidate playbook), C-validate, C-package. Do not resurrect unless a future A2-class
  diagnostic returns GO.
- **#5 C4 / #10 INT-C4** `06dc777` — sentiment feed (CryptoPanic), flagged OFF; reviewer-approved
  (should-fix applied: per-field headline caps). MERGED at HEAD.
- **#11 INT-D1** `bbf3508` — ENTRY_ORDER_TYPE flag; security-auditor approve; reviewer should-fix
  applied: adapter no longer forwards timeInForce for LIMIT_MAKER (Binance -1106). MERGED at HEAD;
  venue acceptance of postOnly-only params still needs verification in a testnet pass before the
  knob is ever enabled (carried into B3 app-side wiring below).
- **#14 INT-B2** `6a94bc4` — perp risk extension; reviewer+auditor approve after fixes (freeMargin
  branch coverage; flip drops cooldown stamp). Also closed a PRE-EXISTING execution coverage hole
  (reconciliation.service.ts:212 rethrow) — `test:cov` is fully green for the first time since
  f5ce2c0. MERGED at HEAD.
- **#20 E** `8e3a4bb` — funding-carry convergence stub recorded in state.md § Flagged (docs-only,
  not built).
- **#15 B3 (partial)** `2e23404` / `e5b5d35` — shorts capability (flag-gated OFF) + a demo-futures
  swap smoke test landed and merged. App-side wiring (guard-on-resolved-URL, mandatory boot config,
  OMS reduceOnly terminalization, LIMIT_MAKER venue acceptance) and the full testnet order-lifecycle
  pass are still open — see In Progress / Open below.
- `f0c5e14` — playbook validator concept-precise denylist fix (reflection candidates were
  false-rejecting on benign trading prose); landed and deployed. Superseded by a further refinement
  at `8ca1997` (current `main` tip as of this session) — see Test Status for what that covers.

## In Progress / Open

**PROGRAM COMPLETE except B3 app-side wiring and the funding-carry build.** Per owner decision
2026-07-10 (`96f9d46`): no redeploy gate — commit+deploy whenever validated-better; the daily loop
drives the program; human touch is the live-mode flip only.

- **#15 B3 remainder** — the shorts/demo-smoke half landed (`e5b5d35`, smoke 4/4 live against
  `demo-fapi.binance.com` with the existing `BINANCE_DEMO_*` keys); the app-side wiring
  (guard-on-resolved-URL, mandatory boot config, OMS reduceOnly terminalization) remains. NOT
  key-blocked: owner decision 2026-07-10 (`96f9d46`) states B3 runs against the demo environment
  with existing `BINANCE_DEMO_*` keys — no separate Futures Testnet credentials are needed.
- **Funding-carry (E) program build** — the convergence stub (`8e3a4bb`) is docs-only; the actual
  carry strategy/sizing per plan §E has not been built. Open per the approved 2026-07-10 edge
  program plan (see header).
- **#22 FINAL** — full sweep run 2026-07-10 post-`8e3a4bb`: build/lint/lint:md/typecheck/format,
  test 1572, eval 15+3skip, livegate 41, paper 11, db 44skip (owner-runnable), **test:cov green**,
  backtest 10+1skip; tree clean at that point. Formally closes when B3 remainder and the carry
  build both land — re-run the sweep at that time rather than trusting this stale count.

## Open Decisions

- None outstanding from the owner's side — A2-gate no-go was itself the owner-facing decision
  point and #21 ESC already recorded the recommended lever (funding carry). B3 needs no owner
  input: `BINANCE_DEMO_*` covers demo-fapi per the 2026-07-10 owner decision (`96f9d46`).

## Traps

- **Background implementers stop at ~25 tool calls with zero edits** on large scaffold tasks (hit
  twice on C4). Symptom: worktree either never gets meaningful diffs or the subagent silently
  stops mid-plan. Mitigation: if a worktree already exists from a prior attempt, `SendMessage`-
  resume it rather than re-dispatching fresh (re-dispatch only if the worktree was auto-cleaned).
  Keep the prompt scoped tightly to one file-set at a time rather than the full C4 shape.
- **Worktrees can base off stale commits.** `agent-a5d625c66dab3e055` (D1) still sits at `eb3d64a`,
  10 commits behind `main`. Always `git log` the worktree before merging; use branch-commit +
  3-way merge on the five shared surfaces, never blind stash-pop (would silently clobber concurrent
  edits to `environment.config.ts` / `.env.example` / `docker-compose.yml` / `package.json` /
  `venue-urls.ts`).
- **`test:db` is owner-skipped by design** (one-liner in `test/db/persistence.spec.ts` header) —
  do not treat its absence from a gate run as a regression.
- Compacted/context-pressured subagents have previously reported undone work as done — spot-check
  claimed artifacts (diff, test output) before trusting a completion claim, especially for anything
  dispatched as a long-running background worktree agent.

## Next Steps

1. Execute the B3 remainder with the existing `BINANCE_DEMO_*` keys (no new credentials needed;
   LIMIT_MAKER venue acceptance already verified by the 4/4 demo smoke): app-side wiring —
   guard-on-resolved-URL, mandatory boot config, OMS reduceOnly terminalization — gated
   `reviewer` + `security-auditor`. Closes #15.
2. Build the funding-carry (E) strategy/sizing per plan §E on top of the docs-only stub (`8e3a4bb`);
   closes #20.
3. Run #22 FINAL once the B3 remainder and #20 are both closed: full gate including
   `pnpm eval:agentic`, `pnpm test:livegate`, `pnpm test:paper`, `pnpm test:db`, `pnpm backtest`.

## Test Status

Last known-green full sweep was #22 FINAL, run 2026-07-10 post-`8e3a4bb` (see Completed above).
`main` has since advanced past that sweep — shorts capability + demo-futures swap smoke
(`2e23404`/`e5b5d35`) and two playbook-validator denylist fixes (`f0c5e14`, `8ca1997`) landed after
it. Re-run the full sweep before closing #22 rather than trusting the stale count.

Validation recipe (env quirk, not a project-discovery script): sandboxed bash spuriously fails
`tsc`/redirects — run all validation with the sandbox disabled, via
`export PATH=<nvm-node-24.4.1-bin>:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0` then
`corepack pnpm --dir "<repo>" <script>`. `<scripts.*>` names: `build`, `lint`, `typecheck`,
`format` (`format:check`), `test`, `coverage` (`test:cov`) — from `project-discovery.json`; plan-
specific additions (`lint:md`, `eval:agentic`, `test:livegate`, `test:paper`, `test:db`,
`backtest`) are not in the discovery cache, use as named in the plan's Verification section.
Targeted specs: `pnpm --dir <repo> exec vitest run <path>`.

## Key Files

- `~/.claude/plans/users-danielhendrich-claude-plans-open-replicated-platypus.md` — source-of-
  truth plan with full `## Todo Steps` DAG.
- `reports/loop/state.md` — `## Flagged for human review (open)` has two new bullets this session:
  the program-authorization bullet and the NO-GO escalation bullet (~lines 379-408 as of this
  session; content duplicated in ESC commit `97b777e`). Never edit the aligned backlog table
  (MD060 constraint).
- `reports/loop/edge-diagnostic-2026-07-10.md` — full 52-bucket diagnostic, verdict NO-GO.
- `.claude/worktrees/` — empty; B2/D1/C4 worktrees were merged and cleaned up this session.
- Five shared surfaces (reconcile only at INT steps): `environment.config.ts`, `.env.example`,
  `docker-compose.yml`, `package.json`, `src/features/trading/market-data/venue-urls.ts` (+spec).

## Process Notes (carried from plan, do not relitigate)

- Commit-per-green-gate authorized this session; no pushes/remote writes.
- Money-path increments (P0-adjacent, B, D) require `reviewer` → `security-auditor` before their
  gate commit.
- Nothing flips live from this plan — every increment stays paper/demo behind its own gate.
