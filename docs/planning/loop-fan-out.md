# Loop fan-out — lane template, worked examples, and the refutations

Companion to `docs/planning/daily-profitability-loop.md` §4.6, which is the binding procedure. This
file holds the lane-declaration template, worked `declare`/`join` examples, and the two refutations
so a future pass does not re-derive either one from scratch.

## Why this exists

Both recorded fan-out incidents in this loop's history were **detected and honestly reported** — the
gap is not detection. The gap is that nothing recorded what lanes were **declared** before dispatch,
so a partial fan-out reads identically to a complete one and no later pass could falsify a completion
claim. `scripts/loop-fanout.mjs` (pure decision core in `scripts/loop-fanout-core.mjs`, unit-tested at
`test/features/strategy/loop-fanout/fanout.spec.ts`) gives a fan-out a declared denominator
(`classifyFanoutCompletion`) and a pre-flight collision check (`classifyLanes`) against a reserved
set of orchestrator-owned paths.

## Lane declaration template

A declaration is a JSON array, one object per lane:

```json
[
  { "name": "lane-scope-audit", "scopes": ["research/loop/incidents/"] },
  { "name": "lane-fee-truth", "scopes": ["research/studies/"] }
]
```

- `name` — a short, stable identifier used again at `join`. Not `ORCHESTRATOR_OWNED`-checked (it is
  a label, not a path).
- `scopes` — one or more paths the lane is authorized to write (or, for a §3 read-only lane, the
  paths it is expected to read/report on). A trailing `/` means "this subtree"; without one the
  scope names exactly that one path, never its children — deliberately not globs (see the core
  module's header for the fail-direction argument).

Write it to a scratch file (never a tracked path — the manifest itself must not become a shared-file
race) and declare:

```bash
corepack pnpm --dir <repo> loop:fanout declare --file "$TMPDIR/lanes.json"
```

`declare` classifies the roster against two things before writing anything:

1. **Pairwise overlap** between any two lanes' scopes (`scopesOverlap`, path-prefix containment).
2. **The `ORCHESTRATOR_OWNED` reserved set** (`scripts/loop-fanout-core.mjs`'s `ORCHESTRATOR_OWNED`
   export is the authoritative list — re-verify against that file before citing it elsewhere, per
   this repo's own verify-before-cite standing rule): the four loop files, `package.json`,
   `.env.app`, the `observability/` configs, and the toolchain configs.

A conflict **exits non-zero and writes nothing** — a shell caller cannot pipe past a `declare`
failure and mistake it for a clean roster. A clean roster is written to
`research/loop/digests/.fanout.json` (gitignored via the existing `research/loop/digests/` rule — no
separate `.gitignore` line was needed; `git check-ignore` already resolves this exact path).

## Worked example: a refused overlap

```bash
$ node scripts/loop-fanout.mjs declare --file overlap.json
loop-fanout: REFUSED — 1 declaration conflict(s). Re-scope and re-declare; nothing was dispatched or written.
  - lane "lane-a" scope "src/features/strategy/" overlaps lane "lane-b" scope "src/features/strategy/agentic/policy.ts"
```

## Worked example: declare, then join with a straggler

```bash
$ node scripts/loop-fanout.mjs declare --file clean.json
loop-fanout: declared 3 lane(s): lane-a, lane-b, lane-c

# ... lanes dispatch; lane-b never returns ...

$ node scripts/loop-fanout.mjs join lane-a lane-c
loop-fanout: DISCLOSURE — 1 of 3 declared lane(s) did NOT return: lane-b. Copy-paste into the pass
report before claiming this fan-out complete.
```

`join` **always exits 0** — it is a reporting step, not a gate, and the whole point of it is that a
partial return must never be blocked from disclosure. The printed line is written into the LOG.md
entry verbatim; a pass that omits it is not entitled to claim the fan-out complete (§4.6).

## The two refutations

### 1. Per-agent git worktrees — REFUTED, already tried here

`.claude/worktrees/` exists in this repo and is empty. It left a permanent scar: `vitest.config.ts`
excludes `**/.claude/**` from the test glob (`:8-10`), and three sibling tools got the same treatment
in commit `4ffd668` (2026-07-10, "shield repo-glob tools from .claude agent worktrees") —
`.markdownlint-cli2.jsonc`, `.prettierignore`, and `eslint.config.mjs` all gained an exclude for the
same reason: without them, eslint crashed on project-less files inside a worktree copy, markdownlint
re-linted archived copies, prettier re-checked everything under the copy, and vitest's positional
test-path filters matched the copies too — five times the intended test count. Those are the exact
same four tools the pre-commit hook runs on every commit, so a worktree-per-agent scheme would have
to re-solve this exclusion problem for every future tool that walks the repo tree, not just the four
already patched.

Two further costs, verified against this repo rather than assumed: `node_modules` is 432 MB and is
not shared by `git worktree` — each worktree pays that cost again in full. And the disqualifier: this
stack runs **one** Postgres instance. N worktrees do not get N databases; they get N resets of the
same one, which is what makes worktrees look safer than they are — the isolation is cosmetic at the
filesystem layer while the one resource every lane actually contends over (the DB) stays exactly as
shared as a single working tree.

### 2. A retry wrapper as code — structurally impossible

A node script cannot dispatch, observe, or kill a Claude sub-agent — there is no process boundary a
script can hold a handle to. It can only run after the fact, against whatever artifacts a lane chose
to leave behind. The retry policy in §4.6 (one re-dispatch per lane: decomposed for a silent death,
contract-free for an output-contract failure; a stall stopped before the join rather than left
running) is therefore procedure the orchestrating pass follows by hand, not a mechanism this repo
could ship as a script. `scripts/loop-fanout.mjs` records the declaration and the disclosure; it does
not and cannot supervise the lanes themselves.
