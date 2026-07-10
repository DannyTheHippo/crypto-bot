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

## In Progress / Open

**PROGRAM COMPLETE except B3.** Everything below landed after the handoff above was first written:

- **#5 C4 / #10 INT-C4** `06dc777` — sentiment feed (CryptoPanic), flagged OFF; reviewer-approved
  (should-fix applied: per-field headline caps). Third dispatch with C1-as-template worked.
- **#11 INT-D1** `bbf3508` — ENTRY_ORDER_TYPE flag; security-auditor approve; reviewer should-fix
  applied: adapter no longer forwards timeInForce for LIMIT_MAKER (Binance -1106); venue acceptance
  of postOnly-only params MUST be verified in B3's testnet pass before the knob is ever enabled.
- **#14 INT-B2** `6a94bc4` — perp risk extension; reviewer+auditor approve after fixes (freeMargin
  branch coverage; flip drops cooldown stamp). Also closed a PRE-EXISTING execution coverage hole
  (reconciliation.service.ts:212 rethrow) — `test:cov` is fully green for the first time since
  f5ce2c0.
- **#20 E** `8e3a4bb` — funding-carry convergence stub recorded in state.md § Flagged.
- **#15 B3** — STILL BLOCKED on owner Binance Futures Testnet keys (withdrawals-disabled).
  Task #15's description carries all wiring requirements (guard-on-resolved-URL, mandatory boot
  config, OMS reduceOnly terminalization, LIMIT_MAKER venue acceptance).
- **#22 FINAL** — full sweep run 2026-07-10 post-`8e3a4bb`: build/lint/lint:md/typecheck/format,
  test 1572, eval 15+3skip, livegate 41, paper 11, db 44skip (owner-runnable), **test:cov green**,
  backtest 10+1skip; tree clean. Formally closes when B3 lands.

## Open Decisions

- None outstanding from the owner's side this session — A2-gate no-go was itself the owner-facing
  decision point and #21 ESC already recorded the recommended lever (funding carry). Next owner
  input needed is Futures Testnet keys (unblocks #15) — not a design decision.

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

1. Dispatch `reviewer` + `security-auditor` on the B2 worktree (`.claude/worktrees/agent-
   a238a483b2c0b529d`, base `b078f64`) against the three carried requirements above; on approval,
   run money-path gate, merge to `main`, commit (`feat(risk): perp risk extension...` per plan
   INT/B2 commit message), close task #14.
2. Reconcile the D1 worktree (`.claude/worktrees/agent-a5d625c66dab3e055`, base `eb3d64a`) forward
   onto current `main` via branch-commit + 3-way merge on the five shared surfaces; run standard
   gate; commit; close #11.
3. Re-dispatch or resume C4 (news/sentiment feed) using the merged C1 derivatives-feed diff
   (`d76e639`) as the structural template; keep dispatch prompt scoped to avoid the ~25-tool-call
   ceiling; close #5 then #10 (INT-C4).
4. Once #14 lands, write the E funding-carry convergence stub per plan §E (docs-only, no build);
   close #20.
5. When owner supplies Futures Testnet keys: execute #15 (B3 — shorts mapping + testnet swap
   lifecycle smoke), gated `reviewer` + `security-auditor`.
6. Run #22 FINAL once #11, #15, #20 are all closed: full gate including `pnpm eval:agentic`,
   `pnpm test:livegate`, `pnpm test:paper`, `pnpm test:db`, `pnpm backtest`.

## Test Status

Last known-green gate was at each merged commit's own INT step (A1/B1/C1 all passed their
respective `<scripts.build/lint/typecheck/test>` + workstream-specific suites per the plan's
Verification section — money-path commits additionally ran `test:livegate`/`test:paper`/`test:db`,
backtest commits ran `pnpm backtest`). No gate has been run against the current `main` tip
(`97b777e`) as a fresh full sweep this session — do that before #22 in any case, but especially
before merging B2/D1 since they were validated only in-worktree.

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
- `.claude/worktrees/agent-a238a483b2c0b529d` — B2 worktree, COMPLETE, base `b078f64`, awaiting
  gate+merge (#14).
- `.claude/worktrees/agent-a5d625c66dab3e055` — D1 worktree, STALE base `eb3d64a`, needs forward
  reconciliation (#11).
- Five shared surfaces (reconcile only at INT steps): `environment.config.ts`, `.env.example`,
  `docker-compose.yml`, `package.json`, `src/features/trading/market-data/venue-urls.ts` (+spec).

## Process Notes (carried from plan, do not relitigate)

- Commit-per-green-gate authorized this session; no pushes/remote writes.
- Money-path increments (P0-adjacent, B, D) require `reviewer` → `security-auditor` before their
  gate commit.
- Nothing flips live from this plan — every increment stays paper/demo behind its own gate.
