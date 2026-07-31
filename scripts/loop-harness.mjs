#!/usr/bin/env node
// OFF-GATE HARNESS RUNNER — the invocation that actually executes the suites `pnpm test` deliberately
// does not, and records the verdicts where `pnpm loop:sweep` can read them.
//
// WHY THIS IS A SEPARATE PROCESS FROM THE SWEEP. `pnpm loop:sweep` runs 3x/day as a fast read-only
// health pass; a vitest run inside it would make the health sweep hostage to a test suite's runtime
// and to its exit code. So the split is: this script RUNS and WRITES, the sweep READS. The sweep's
// share of the cost is one file read, and the classifier that judges the artifact
// (classifyHarnessRuns, loop-sweep-core.mjs) is pure and clock-free.
//
// WHY IT EXISTS AT ALL (backlog 54). test/eval and test/backtest are off the production gate, so
// their failures are invisible by construction — the loop's own words after three passes that shipped
// only defect repairs. On 2026-07-31 the counterfactual-scoring horizon fix broke `eval:agentic` and a
// test/features/strategy/eval spec, and both were found only because a human ran them by hand.
// `pnpm eval:agentic` was hand-verified green in Pass 51 the same way. This automates that hand-check.
//
// FAILURE DIRECTION — FAILS OPEN. This script exits 0 even when a monitored suite FAILS: a red
// harness is a finding to be disclosed in the next digest, not a reason to break whatever invoked the
// monitor. It exits non-zero only if it cannot WRITE THE ARTIFACT, because an unwritten artifact is
// the one outcome that would leave the sweep with nothing to report — and even then the sweep
// degrades loudly (`harness_never_run` / `harness_stale`, never silence).
//
// NOT A REPLACEMENT FOR THE PRODUCTION GATE. Nothing here promotes these suites onto `pnpm test`;
// root CLAUDE.md keeps them off it deliberately. This only makes their result impossible to lose.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HARNESS_ARTIFACT_NAME, MONITORED_HARNESSES } from './loop-sweep-core.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const DIGESTS_DIR = join(REPO_ROOT, 'research', 'loop', 'digests');

// vitest is invoked through its own module entry under the CURRENT node binary rather than through a
// package manager. Going via `pnpm exec` would re-resolve the toolchain in a fresh shell, and this
// repo's fnm hook is documented to hang non-interactive shells that do that — a monitor that hangs is
// strictly worse than no monitor.
const VITEST_ENTRY = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

// Per-suite wall-clock ceiling. A wedged suite must not park the monitor forever: spawnSync kills it
// at the bound and the run is recorded as a FAILURE with the timeout named, which is the honest
// verdict — a suite that did not finish did not pass.
const HARNESS_TIMEOUT_MS = 15 * 60 * 1000;

// The vitest tail line worth keeping ("Tests  170 passed (170)"), reduced to one line so the artifact
// stays small and the digest annotation stays readable. Deliberately tolerant: if none of these
// markers appear the summary is simply empty and the ok/exitCode pair still carries the verdict — a
// parser that cannot find its line must not invent one.
function summarise(stdout, stderr) {
  const text = `${stdout || ''}\n${stderr || ''}`;
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\[[0-9;]*m/g, '').trim())
    .filter((l) => l !== '');
  const tests = lines.filter((l) => /^Tests\s+/.test(l)).pop();
  const files = lines.filter((l) => /^Test Files\s+/.test(l)).pop();
  return [files, tests].filter(Boolean).join(' · ').slice(0, 300);
}

function runOne(harness) {
  const startedAtMs = Date.now();
  const res = spawnSync(process.execPath, [VITEST_ENTRY, ...harness.args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: HARNESS_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    // CI=1 keeps vitest non-interactive and non-watching. The monitor must never leave a watcher
    // running behind it.
    env: { ...process.env, CI: '1' },
  });
  const finishedAtMs = Date.now();
  const timedOut = res.error && res.error.code === 'ETIMEDOUT';
  // `ok` is exit-code 0 AND a clean spawn. A spawn that never produced an exit status (binary
  // missing, killed) is NOT a pass — the absence of a failure signal is not a success signal.
  const ok = !res.error && res.status === 0;
  return {
    label: harness.label,
    startedAtMs,
    finishedAtMs,
    durationMs: finishedAtMs - startedAtMs,
    ok,
    exitCode: Number.isFinite(res.status) ? res.status : null,
    summary: timedOut
      ? `TIMED OUT after ${HARNESS_TIMEOUT_MS / 60000}min`
      : res.error
        ? `spawn failed: ${res.error.message}`
        : summarise(res.stdout, res.stderr),
  };
}

export function runHarnesses(harnesses = MONITORED_HARNESSES) {
  const runs = {};
  for (const h of harnesses) {
    process.stderr.write(`loop-harness: running ${h.id} (${h.label}) …\n`);
    const run = runOne(h);
    runs[h.id] = run;
    process.stderr.write(
      `loop-harness: ${h.id} ${run.ok ? 'PASS' : 'FAIL'} in ${(run.durationMs / 1000).toFixed(1)}s` +
        `${run.summary ? ` — ${run.summary}` : ''}\n`,
    );
  }
  return { schema: 1, writtenAtMs: Date.now(), runs };
}

// Path containment mirrors writeUnderDigests in loop-sweep.mjs: the artifact name is a constant, but
// the guard stays so a future edit cannot turn it into a traversal.
export function writeArtifact(artifact, dir = DIGESTS_DIR, name = HARNESS_ARTIFACT_NAME) {
  const target = resolve(dir, name);
  if (dirname(target) !== resolve(dir))
    throw new Error(`refusing to write outside ${dir}: ${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, JSON.stringify(artifact, null, 2));
  return target;
}

function main() {
  const artifact = runHarnesses();
  const path = writeArtifact(artifact);
  const failed = Object.entries(artifact.runs).filter(([, r]) => !r.ok);
  process.stderr.write(
    `loop-harness: wrote ${path} — ${Object.keys(artifact.runs).length} harness(es), ` +
      `${failed.length} failing${failed.length > 0 ? ` (${failed.map(([id]) => id).join(', ')})` : ''}\n`,
  );
  // Deliberately exit 0 on a failing harness — see the FAILS OPEN note in the header. The next
  // `pnpm loop:sweep` reports it as a `harness_failed` annotation, which is the disclosure path.
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    // Only an unwritable artifact (or a crash of this script itself) reaches here — a failing suite
    // is data, captured above.
    process.stderr.write(
      `loop-harness: FATAL ${err instanceof Error ? err.stack : String(err)}\n` +
        'loop-harness: no artifact written — the next sweep will report harness_never_run/harness_stale\n',
    );
    process.exitCode = 1;
  }
}
