import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { DEGRADED_DECIDE_RATIONALE_TAGS } from '../../../../src/domain/strategy/types/decide-rationale';

// DEGRADED_DECIDE_RATIONALE_TAGS has two hand-written mirrors that no code path can import it into:
// loop-sweep.mjs's realDecides probe (a stdlib-only .mjs outside the tsconfig graph) and the runbook
// SQL an operator pastes by hand. Both files carry a comment saying they must be edited alongside the
// constant — and on 2026-08-05 (Pass 64) a seventh tag was added to the constant and to neither
// mirror, which would have made every `empty_tool_input:` row count as a REAL model decide in the
// loop's own liveness probe. That is the green-board-over-a-dead-lane failure WATCH-V4-8 exists to
// abolish, reproduced inside the instrument that measures it.
//
// FAIL DIRECTION — CLOSED. A mirror that has drifted fails this spec rather than degrading quietly,
// because the whole point is that drift here is silent everywhere else: the TS-side readers
// (agent_last_success_timestamp_seconds, the boot seed) stay correct off the shared constant, so
// nothing else in the suite disagrees and the operator-facing instruments are the only thing wrong.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const MIRRORS = [
  {
    label: 'scripts/loop-sweep.mjs realDecides probe',
    path: join(REPO_ROOT, 'scripts', 'loop-sweep.mjs'),
  },
  { label: 'docs/runbook.md liveness SQL', path: join(REPO_ROOT, 'docs', 'runbook.md') },
];

describe('degraded-decide tag hand-mirrors', () => {
  for (const mirror of MIRRORS) {
    describe(mirror.label, () => {
      const source = readFileSync(mirror.path, 'utf8');

      it.each([...DEGRADED_DECIDE_RATIONALE_TAGS])('subtracts %s', (tag) => {
        expect(source).toContain(`starts_with(rationale, '${tag}')`);
      });

      // A tag REMOVED from the constant but left in a mirror is the inverse drift: the mirror would
      // subtract rows the TS readers now count, so the two instruments disagree in the other
      // direction. Counting the clauses catches that without a second enumeration to keep in sync.
      it('subtracts exactly the tags the constant declares, no more', () => {
        const clauses = source.match(/starts_with\(rationale, '[^']+'\)/g) ?? [];
        expect(clauses).toHaveLength(DEGRADED_DECIDE_RATIONALE_TAGS.length);
      });
    });
  }
});
