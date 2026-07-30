import { describe, it, expect } from 'vitest';
import { resolveActiveVersion } from '../../../../scripts/lib/playbook-shared.mjs';
import { SEED_PLAYBOOK_V3 } from '../../../../src/features/strategy/agentic/agentic-strategy.module';

// REGRESSION, 2026-07-30. resolveActiveVersion's seed fallback took the FIRST seed row by version
// while PlaybookStoreAdapter.ensureSeed() looks up SEED_PLAYBOOK_V3.version SPECIFICALLY. Those
// agree on a clean database and diverge the moment a retired cutover's seed row survives at a lower
// version — which is exactly the live state.
//
// Live `agent_playbook_versions` on 2026-07-30 (queried, not assumed):
//   v1 seed · v2 seed · v3 reflection(parent 2) · v4 reflection(parent 2) · v6 seed ·
//   v7 reflection(parent 6) · v8 seed · v9 reflection(parent 8)
// No 'promotion' row, AGENTIC_PLAYBOOK_PIN empty. So the CLI resolved active=1 while the running
// process resolved active=8, and every candidate playbook:candidate minted would have recorded
// parent_version=1 — into an append-only table, unfixable after the fact.
const LIVE_ROWS = [
  { version: 1, source: 'seed', parent_version: null },
  { version: 2, source: 'seed', parent_version: null },
  { version: 3, source: 'reflection', parent_version: 2 },
  { version: 4, source: 'reflection', parent_version: 2 },
  { version: 6, source: 'seed', parent_version: null },
  { version: 7, source: 'reflection', parent_version: 6 },
  { version: 8, source: 'seed', parent_version: null },
  { version: 9, source: 'reflection', parent_version: 8 },
];

describe('resolveActiveVersion mirrors PlaybookStoreAdapter.resolve()', () => {
  it('resolves the live row set to the seed the runtime actually serves', () => {
    // Pinned against the constant the composition root binds, so a seed bump that forgets this
    // helper fails here rather than in a permanently-wrong parent_version.
    expect(resolveActiveVersion(LIVE_ROWS, undefined)).toBe(SEED_PLAYBOOK_V3.version);
    expect(resolveActiveVersion(LIVE_ROWS, undefined)).toBe(8);
  });

  it('prefers an existing pin over everything else', () => {
    expect(resolveActiveVersion(LIVE_ROWS, '6')).toBe(6);
  });

  it('ignores a pin naming a version that does not exist', () => {
    expect(resolveActiveVersion(LIVE_ROWS, '99')).toBe(8);
  });

  it("follows the newest promotion row's parent, ahead of any seed", () => {
    const rows = [...LIVE_ROWS, { version: 10, source: 'promotion', parent_version: 9 }];
    expect(resolveActiveVersion(rows, undefined)).toBe(9);
  });

  it('falls through to the seed when a promotion points at a missing parent', () => {
    const rows = [...LIVE_ROWS, { version: 10, source: 'promotion', parent_version: 42 }];
    expect(resolveActiveVersion(rows, undefined)).toBe(8);
  });

  it('resolves nothing when no seed row exists at all', () => {
    expect(
      resolveActiveVersion([{ version: 3, source: 'reflection', parent_version: 2 }], undefined),
    ).toBeUndefined();
  });
});
