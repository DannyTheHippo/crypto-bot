import { describe, it, expect } from 'vitest';
import { InMemoryPlaybookStore } from '../../../src/modules/persistence/repositories/in-memory-playbook-store';
import type { PlaybookSeed } from '../../../src/modules/persistence/repositories/playbook-store.adapter';

const SEED: PlaybookSeed = { version: 1, content: 'seed content' };

describe('InMemoryPlaybookStore', () => {
  it('resolves to the seed when no reflection/promotion rows exist', async () => {
    const store = new InMemoryPlaybookStore(SEED);
    await expect(store.current()).resolves.toEqual({
      version: 1,
      content: 'seed content',
      source: 'seed',
    });
  });

  it('a reflection append does not change active resolution (inactive by definition)', async () => {
    const store = new InMemoryPlaybookStore(SEED);
    const { version } = await store.append('reflection draft', 'reflection', 1);
    expect(version).toBe(2);
    // current() is boot-resolution: resolve once and cache, so call it only after all setup.
    await expect(store.current()).resolves.toEqual({
      version: 1,
      content: 'seed content',
      source: 'seed',
    });
  });

  it('a promotion row activates its parentVersion target, not its own content', async () => {
    const store = new InMemoryPlaybookStore(SEED);
    const { version: draftVersion } = await store.append('reflection draft', 'reflection', 1);
    expect(draftVersion).toBe(2);
    await store.append('promotion note', 'promotion', draftVersion);

    await expect(store.current()).resolves.toEqual({
      version: 2,
      content: 'reflection draft',
      source: 'promotion',
    });
  });

  it('re-resolves live after an in-process promotion append — current() is not frozen at its first call (G4b auto-promotion)', async () => {
    const store = new InMemoryPlaybookStore(SEED);
    // First read caches the seed resolution.
    await expect(store.current()).resolves.toMatchObject({ version: 1, source: 'seed' });

    // A reflection append is INACTIVE — it must NOT disturb the cached resolution.
    const { version: draftVersion } = await store.append('reflection draft', 'reflection', 1);
    await expect(store.current()).resolves.toMatchObject({ version: 1, source: 'seed' });

    // A promotion append drops the cache, so the NEXT current() re-resolves live — no restart needed.
    await store.append('promotion note', 'promotion', draftVersion);
    await expect(store.current()).resolves.toEqual({
      version: 2,
      content: 'reflection draft',
      source: 'promotion',
    });
  });

  it('pinVersion overrides promotion resolution when its row exists', async () => {
    const store = new InMemoryPlaybookStore(SEED, 1);
    const { version: draftVersion } = await store.append('reflection draft', 'reflection', 1);
    await store.append('promotion note', 'promotion', draftVersion);

    // Pinned to version 1 (seed) even though a promotion targets version 2.
    await expect(store.current()).resolves.toEqual({
      version: 1,
      content: 'seed content',
      source: 'pin',
    });
  });

  it('a missing pinned version falls through to promotion/seed resolution', async () => {
    const store = new InMemoryPlaybookStore(SEED, 999);
    await expect(store.current()).resolves.toEqual({
      version: 1,
      content: 'seed content',
      source: 'seed',
    });
  });

  it('rollback: pinning an earlier version overrides a later promotion', async () => {
    // Pin baked in at construction (boot-scoped, like the real adapter) — appends still land on
    // this same instance before the first current() call resolves and caches the outcome.
    const store = new InMemoryPlaybookStore(SEED, 2);
    const draftV2 = await store.append('draft v2', 'reflection', 1);
    expect(draftV2.version).toBe(2);
    const draftV3 = await store.append('draft v3', 'reflection', 1);
    await store.append('promotion of v3', 'promotion', draftV3.version);

    // Without the pin, the promotion of v3 would win; the pin rolls back to v2 instead.
    await expect(store.current()).resolves.toEqual({
      version: 2,
      content: 'draft v2',
      source: 'pin',
    });
  });

  it('promoting an earlier version rolls back active resolution: the newest promotion row wins regardless of its target version number', async () => {
    const store = new InMemoryPlaybookStore(SEED);
    await store.append('draft v2', 'reflection', 1);
    const draftV3 = await store.append('draft v3', 'reflection', 1);
    await store.append('promotion of v3', 'promotion', draftV3.version);
    // A later promotion targeting the seed (v1) is itself the newest promotion row, even though
    // its target version number (1) is lower than the previous promotion's target (draftV3).
    await store.append('promotion of v1 (rollback)', 'promotion', 1);

    await expect(store.current()).resolves.toEqual({
      version: 1,
      content: 'seed content',
      source: 'promotion',
    });
  });

  it('append version numbers are monotonic across sources', async () => {
    const store = new InMemoryPlaybookStore(SEED);
    const a = await store.append('draft a', 'reflection', 1);
    const b = await store.append('draft b', 'reflection', 1);
    const c = await store.append('promotion', 'promotion', b.version);
    expect([a.version, b.version, c.version]).toEqual([2, 3, 4]);
  });

  it('listVersions returns rows newest-first, respecting the limit', async () => {
    const store = new InMemoryPlaybookStore(SEED);
    await store.append('draft a', 'reflection', 1);
    await store.append('draft b', 'reflection', 1);

    const versions = await store.listVersions(2);
    expect(versions.map((v) => v.version)).toEqual([3, 2]);
  });

  it('ring buffer evicts the oldest NON-seed version once MAX_VERSIONS (50) is exceeded — the seed row is never evicted', async () => {
    const store = new InMemoryPlaybookStore(SEED);
    // Seed occupies version 1; append 50 more so the total (51) exceeds the 50 cap by one.
    for (let i = 0; i < 50; i++) {
      await store.append(`draft ${i}`, 'reflection', 1);
    }
    const all = await store.listVersions(100);
    expect(all).toHaveLength(50);
    // The seed row (version 1) is never evicted; the oldest non-seed row (version 2) is evicted
    // in its place.
    expect(all.map((v) => v.version)).toContain(1);
    expect(all.map((v) => v.version)).not.toContain(2);
    expect(Math.min(...all.map((v) => v.version))).toBe(1);
    expect(Math.max(...all.map((v) => v.version))).toBe(51);
  });

  it('the seed stays resolvable after 50+ appends with no pin/promotion, even though the ring evicted', async () => {
    const store = new InMemoryPlaybookStore(SEED);
    for (let i = 0; i < 60; i++) {
      await store.append(`draft ${i}`, 'reflection', 1);
    }
    await expect(store.current()).resolves.toEqual({
      version: 1,
      content: 'seed content',
      source: 'seed',
    });
  });

  it('a forced resolve failure (corrupted internal state) surfaces as a rejected promise, not a synchronous throw', async () => {
    const store = new InMemoryPlaybookStore(SEED);
    // Corrupt internal state directly (private field access via cast) to force resolve() into its
    // otherwise-unreachable failure path (no rows at all) — isolates the promise-contract fix from
    // the never-evict-the-seed fix above.
    (store as unknown as { rows: unknown[] }).rows.length = 0;

    let synchronousThrow = false;
    let pending: Promise<unknown> = Promise.resolve();
    try {
      pending = store.current();
    } catch {
      synchronousThrow = true;
    }
    expect(synchronousThrow).toBe(false);
    await expect(pending).rejects.toThrow(/unable to resolve seed version/);
  });
});
