import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The registry connection gate in scripts/log-eval-experiment.mjs — the one thing standing between a
// scored authoring pass and `public.experiments`. It is asserted rather than reviewed because both of
// its failure modes are silent in the pass's own output:
//
//  - Closed too hard: stage 6 cannot log, so classifyMintGate blocks on "the scored variants were not
//    ALL logged", and `pnpm loop:authoring` can NEVER mint. That was the state until this spec existed
//    — the gate opened on a `_test`-suffixed database while the registry it writes is the PRODUCTION
//    public.experiments table (schema comment § experiments; hardened in
//    drizzle/0001_v3_append_only_hardening.sql; already written over plain DATABASE_URL by
//    scripts/playbook-candidate.mjs). It opened on exactly the wrong targets and closed on the right one.
//  - Open too easily: an append-only table takes rows back from nobody.
//
// Driven as a SUBPROCESS against the real script rather than by importing a predicate: the gate's
// value is the observable refusal at the real call site, and an exported helper can drift from the
// call site while both still pass. The "open" cases point --scorecard at a path that does not exist,
// so passing the gate is proven by the script reaching the NEXT failure — no database is contacted.
//
// Plain .mjs because it drives scripts/*.mjs, which sit outside the tsconfig project — same reason as
// loop-authoring-core.spec.mjs.

const REPO_ROOT = process.cwd();
const SCRIPT = join(REPO_ROOT, 'scripts', 'log-eval-experiment.mjs');
const MISSING_SCORECARD = join(REPO_ROOT, 'test', '__no_such_scorecard__.json');

const REFUSAL = 'refusing to write';
const PAST_THE_GATE = 'could not read --scorecard';

// Explicit env rather than {...process.env, ...}: an ambient REGISTRY_DATABASE_URL or
// DB_SUITE_ALLOW_RESET in the developer's shell would otherwise decide these assertions.
function runGate(env) {
  return spawnSync(
    process.execPath,
    [SCRIPT, '--scorecard', MISSING_SCORECARD, '--family', 'f', '--source', 'loop', '--label', 'l'],
    { cwd: REPO_ROOT, env: { PATH: process.env['PATH'] ?? '', ...env }, encoding: 'utf8' },
  );
}

const PROD_URL = 'postgres://cryptobot:secret@127.0.0.1:5432/cryptobot';
const TEST_URL = 'postgres://cryptobot:secret@127.0.0.1:5432/cryptobot_test';

describe('log-eval-experiment registry gate', () => {
  it('refuses when REGISTRY_DATABASE_URL is unset', () => {
    const res = runGate({});
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain(REFUSAL);
  });

  it('refuses a non-_test database with no REGISTRY_ALLOW_PRODUCTION_DB', () => {
    const res = runGate({ REGISTRY_DATABASE_URL: PROD_URL });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain(REFUSAL);
    expect(res.stderr).toContain('REGISTRY_ALLOW_PRODUCTION_DB');
  });

  it('opens on a non-_test database WITH REGISTRY_ALLOW_PRODUCTION_DB=1', () => {
    const res = runGate({ REGISTRY_DATABASE_URL: PROD_URL, REGISTRY_ALLOW_PRODUCTION_DB: '1' });
    expect(res.stderr).not.toContain(REFUSAL);
    expect(res.stderr).toContain(PAST_THE_GATE);
  });

  it('opens on a _test-suffixed database with neither flag set', () => {
    const res = runGate({ REGISTRY_DATABASE_URL: TEST_URL });
    expect(res.stderr).not.toContain(REFUSAL);
    expect(res.stderr).toContain(PAST_THE_GATE);
  });

  // THE REGRESSION TEST. DB_SUITE_ALLOW_RESET used to be a second route through this gate. Its
  // documented meaning is the opposite — it lets READ-ONLY suites acknowledge a production
  // DATABASE_URL and "must never double as a license to reset one" (test/db/destructive-guard.ts) —
  // and setting it in an app env to reach this write would un-skip suites that INSERT into this very
  // append-only table and lock against the live single-writer interlock. Without this case, restoring
  // that disjunct is an invisible revert: every other test here still passes.
  it('stays CLOSED on a non-_test database when only DB_SUITE_ALLOW_RESET=1 is set', () => {
    const res = runGate({ REGISTRY_DATABASE_URL: PROD_URL, DB_SUITE_ALLOW_RESET: '1' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain(REFUSAL);
    expect(res.stderr).not.toContain(PAST_THE_GATE);
  });

  it('names the new variable and no longer names the old one in its refusal', () => {
    const res = runGate({ REGISTRY_DATABASE_URL: PROD_URL });
    expect(res.stderr).toContain('REGISTRY_ALLOW_PRODUCTION_DB');
    expect(res.stderr).not.toContain('DB_SUITE_ALLOW_RESET');
  });
});

// The couplings above are only broken while no production code READS the flag. A single new reader
// under src/ or scripts/ re-links an app env to the destructive-suite gate, which is how the original
// defect arrived; this catches it at the file level rather than case by case.
//
// Full-line comments are excluded from the scan on purpose, and the predicate is "reads it" rather
// than "mentions it": scripts/log-eval-experiment.mjs deliberately names the flag in prose to record
// WHY it must never gate that write, and a future reader grepping the token should land on exactly
// that explanation. Only full-line comments are stripped — a trailing comment still counts as an
// offender, so no code line can hide behind one, and no string literal can be mistaken for a comment.
describe('DB_SUITE_ALLOW_RESET stays a test-only flag', () => {
  const SOURCE_DIRS = ['src', 'scripts'];

  function sourceFiles(dir) {
    const out = [];
    for (const entry of readdirSync(join(REPO_ROOT, dir), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      if (!/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) continue;
      out.push(join(entry.parentPath, entry.name));
    }
    return out;
  }

  function codeLines(file) {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
      });
  }

  it('is read by no source file under src/ or scripts/', () => {
    const offenders = [];
    for (const dir of SOURCE_DIRS) {
      for (const file of sourceFiles(dir)) {
        if (codeLines(file).some((line) => line.includes('DB_SUITE_ALLOW_RESET'))) {
          offenders.push(file.slice(REPO_ROOT.length + 1));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // Guards the exclusion above: the scan must still see the code of the very file that mentions the
  // flag in prose, or "no reader" would be a statement about an unread file.
  it('still scans the code of the script that mentions the flag in prose', () => {
    const script = join(REPO_ROOT, 'scripts', 'log-eval-experiment.mjs');
    expect(readFileSync(script, 'utf8')).toContain('DB_SUITE_ALLOW_RESET');
    expect(codeLines(script).some((l) => l.includes('REGISTRY_ALLOW_PRODUCTION_DB'))).toBe(true);
  });

  it('scans a non-empty file set (a broken walk would pass the assertion above vacuously)', () => {
    for (const dir of SOURCE_DIRS) expect(sourceFiles(dir).length).toBeGreaterThan(0);
  });
});
