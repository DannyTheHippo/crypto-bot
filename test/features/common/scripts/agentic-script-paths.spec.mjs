import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// REGRESSION, 2026-07-28. Three operator CLIs resolved the agentic lane under
// `features/trading/agentic` — a path that has NEVER existed; the lane lives under
// `features/strategy/agentic` (.claude/CLAUDE.md § Project layout). Each script then hit its own
// freshness check and printed "run pnpm build first" before exiting 1, on EVERY invocation, including
// immediately after a successful build. `pnpm playbook:candidate` was therefore dead: the mint path
// the learning loop depends on could not run at all, and the error message blamed the build.
//
// Why a string check and not an integration run: these scripts fetch, spend money, or write to the
// live DB. What actually broke was a hardcoded path spelling, and that is exactly what this pins —
// against the real directory listing, so a future re-layout fails here rather than in an operator's
// hands at 3am.
//
// Plain .mjs because it reads scripts/*.mjs, which sit outside the tsconfig project (see
// eslint.config.mjs's scripts/** ignore) — same reason as arm-ceremony.spec.mjs.

const REPO_ROOT = process.cwd();
const AGENTIC_SRC = join(REPO_ROOT, 'src', 'features', 'strategy', 'agentic');

const SCRIPTS = [
  { file: 'playbook-candidate.mjs', module: 'playbook-validator' },
  { file: 'backtest-agentic.mjs', module: 'agentic-strategy.module' },
  { file: 'replay-agentic.mjs', module: 'agentic-strategy.module' },
];

describe('agentic lane path resolution in operator scripts', () => {
  it('the agentic lane is under features/strategy, not features/trading', () => {
    expect(existsSync(AGENTIC_SRC)).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'src', 'features', 'trading', 'agentic'))).toBe(false);
  });

  for (const { file, module } of SCRIPTS) {
    it(`${file} resolves ${module} under strategy/agentic and names a module that exists`, () => {
      const source = readFileSync(join(REPO_ROOT, 'scripts', file), 'utf8');

      // The path is built with path.join(..., 'strategy', 'agentic', '<module>.js'), so assert on the
      // segments as they appear in source rather than on a joined string.
      expect(source).toContain("'strategy',");
      expect(source).toContain(`'${module}.js',`);

      // The bug was a path pointing at nothing. Pin the target against the real listing so a rename
      // of the module (not just the directory) also trips this.
      const present = readdirSync(AGENTIC_SRC);
      expect(present).toContain(`${module}.ts`);
    });

    it(`${file} does not reference the stale trading/agentic path`, () => {
      const source = readFileSync(join(REPO_ROOT, 'scripts', file), 'utf8');
      // Only the path-segment form is forbidden — prose mentioning trading is fine, and the fix
      // comments in these files deliberately name the old spelling.
      const staleSegments = /'trading',\s*\n\s*'agentic',/;
      expect(staleSegments.test(source)).toBe(false);
    });
  }
});
