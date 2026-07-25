import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PlaybookAbRoutingProvider,
  ValidatingPlaybookProvider,
} from '../../../../src/features/trading/composition/agentic-bridge.module';
import type { AgentMetricsRecorder } from '../../../../src/features/common/observability/agent-metrics-recorder.service';

const VALID_CANDIDATE = [
  '## regime notes',
  'candidate notes',
  '## entry rules',
  'e',
  '## exit rules',
  'x',
  '## mistakes to avoid',
  'm',
].join('\n');

interface VersionRow {
  version: number;
  content: string;
  source: 'seed' | 'reflection' | 'promotion';
  parentVersion: number | null;
  createdAt: number;
}

function storeFake(versions: VersionRow[]) {
  return {
    current: vi.fn().mockResolvedValue({ version: 1, content: 'ACTIVE', source: 'seed' as const }),
    append: vi.fn(),
    listVersions: vi.fn().mockResolvedValue(versions),
  };
}

function row(version: number, source: VersionRow['source'], content = VALID_CANDIDATE): VersionRow {
  return { version, content, source, parentVersion: 1, createdAt: 0 };
}

// Bucket = floor(Date.now()/60_000) % 100. Pin the clock so bucket === 5 for deterministic tests.
const BUCKET_5_MS = (100 * 1000 + 5) * 60_000;

// Untyped return (like storeFake above) rather than an explicit VersionRewardSource annotation —
// the interface declares rewardsByVersion with method syntax, which trips
// @typescript-eslint/unbound-method on the expect(...).toHaveBeenCalled() assertions below;
// structural typing still satisfies PlaybookAbRoutingProvider's constructor param either way.
function rewardSourceFake(rewards: Record<number, { netPnlUsd: string; trips: number }>) {
  const map = new Map(
    Object.entries(rewards).map(([version, sample]) => [Number(version), sample]),
  );
  return { rewardsByVersion: vi.fn().mockResolvedValue(map) };
}

// Deterministic seedable uniform PRNG (mulberry32) — stands in for the production Math.random
// default so #46's "same seed -> same choice" and aggregate-favoring assertions never flake.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('PlaybookAbRoutingProvider (W4.1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BUCKET_5_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pct=0 (default) always serves ACTIVE and never reads listVersions', async () => {
    const store = storeFake([row(2, 'reflection')]);
    const provider = new PlaybookAbRoutingProvider(store, 0);

    const served = await provider.current();

    expect(served.version).toBe(1);
    expect(store.listVersions).not.toHaveBeenCalled();
  });

  it('routes to the newest INACTIVE reflection candidate when the bucket falls inside pct', async () => {
    const store = storeFake([row(2, 'reflection'), row(3, 'reflection')]);
    const provider = new PlaybookAbRoutingProvider(store, 10); // bucket 5 < 10 → route

    const served = await provider.current();

    expect(served.version).toBe(3); // newest candidate wins
    expect(served.content).toBe(VALID_CANDIDATE);
  });

  it('serves ACTIVE when the bucket falls outside pct', async () => {
    const store = storeFake([row(2, 'reflection')]);
    const provider = new PlaybookAbRoutingProvider(store, 3); // bucket 5 >= 3 → active

    const served = await provider.current();

    expect(served.version).toBe(1);
  });

  it('serves ACTIVE when no newer reflection candidate exists (promotions/seeds never route)', async () => {
    const store = storeFake([row(2, 'promotion'), row(0, 'reflection')]);
    const provider = new PlaybookAbRoutingProvider(store, 50);

    const served = await provider.current();

    expect(served.version).toBe(1);
  });

  it('falls back to ACTIVE when the candidate content fails structural validation', async () => {
    const store = storeFake([row(2, 'reflection', '## regime notes\nonly one section')]);
    const provider = new PlaybookAbRoutingProvider(store, 50);

    const served = await provider.current();

    expect(served.version).toBe(1);
  });

  // Regression (2026-07-11 boot e7d94350): the boot info stamp read current() and landed in a
  // candidate bucket, so agentic_playbook_info reported the INACTIVE candidate as active.
  it('active() serves ACTIVE even when the bucket falls inside pct and a candidate exists', async () => {
    const store = storeFake([row(2, 'reflection')]);
    const provider = new PlaybookAbRoutingProvider(store, 10); // bucket 5 < 10 → current() routes

    const routed = await provider.current();
    const active = await provider.active();

    expect(routed.version).toBe(2); // sanity: this bucket really does route
    expect(active.version).toBe(1);
    expect(active.source).toBe('seed');
  });
});

describe('ValidatingPlaybookProvider active() forwarding', () => {
  const recorderFake = () =>
    ({ recordValidatorRejection: vi.fn() }) as unknown as AgentMetricsRecorder;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BUCKET_5_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Valid-content store: 'ACTIVE' (storeFake's content) would trip the validator and mask what
  // these tests assert — forwarding, not the seed fallback.
  function validStoreFake(versions: VersionRow[]) {
    return {
      current: vi
        .fn()
        .mockResolvedValue({ version: 1, content: VALID_CANDIDATE, source: 'seed' as const }),
      append: vi.fn(),
      listVersions: vi.fn().mockResolvedValue(versions),
    };
  }

  it('forwards active() through the routing chain so the boot read bypasses A/B', async () => {
    const store = validStoreFake([row(2, 'reflection')]);
    const chained = new PlaybookAbRoutingProvider(store, 10); // bucket 5 < 10 → current() routes
    const provider = new ValidatingPlaybookProvider(chained, recorderFake());

    const routed = await provider.current();
    const active = await provider.active();

    expect(routed.version).toBe(2); // sanity: this bucket really does route
    expect(active.version).toBe(1);
    expect(active.content).toBe(VALID_CANDIDATE);
  });

  it('active() falls back to inner.current() when the inner chain has no routing layer', async () => {
    const store = validStoreFake([]);
    const provider = new ValidatingPlaybookProvider(store, recorderFake());

    const active = await provider.active();

    expect(active.version).toBe(1);
    expect(store.current).toHaveBeenCalled();
  });

  it('active() applies the same validation/seed fallback as current()', async () => {
    const rejectionSpy = vi.fn();
    const recorder = { recordValidatorRejection: rejectionSpy } as unknown as AgentMetricsRecorder;
    const store = {
      current: vi.fn().mockResolvedValue({
        version: 7,
        content: 'not a valid playbook',
        source: 'seed' as const,
      }),
      append: vi.fn(),
      listVersions: vi.fn().mockResolvedValue([]),
    };
    const provider = new ValidatingPlaybookProvider(store, recorder);

    const active = await provider.active();

    expect(active.source).toBe('seed');
    expect(active.version).not.toBe(7);
    expect(rejectionSpy).toHaveBeenCalled();
  });
});

describe('PlaybookAbRoutingProvider Thompson sampling (#46)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BUCKET_5_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('0 candidates: serves ACTIVE, identical to pre-#46, even with a reward source bound', async () => {
    const store = storeFake([]);
    const rewardSource = rewardSourceFake({});
    const provider = new PlaybookAbRoutingProvider(store, 50, {}, rewardSource, mulberry32(1));

    const served = await provider.current();

    expect(served.version).toBe(1);
    expect(rewardSource.rewardsByVersion).not.toHaveBeenCalled();
  });

  it('1 candidate: serves it via the cold-start fallback (byte-identical to newest-wins)', async () => {
    const store = storeFake([row(2, 'reflection')]);
    // High trip counts — Thompson would gladly activate on reward, but candidates.length < 2
    // short-circuits before rewardsByVersion() is even read.
    const rewardSource = rewardSourceFake({ 2: { netPnlUsd: '50', trips: 10 } });
    const provider = new PlaybookAbRoutingProvider(store, 50, {}, rewardSource, mulberry32(1));

    const served = await provider.current();

    expect(served.version).toBe(2);
    expect(rewardSource.rewardsByVersion).not.toHaveBeenCalled();
  });

  it('2 candidates, neither clears K trips: newest-wins fallback (behavior-preserving)', async () => {
    const store = storeFake([row(2, 'reflection'), row(3, 'reflection')]);
    // Both below THOMPSON_MIN_TRIPS (3) — Thompson stays a no-op regardless of the reward gap.
    const rewardSource = rewardSourceFake({
      2: { netPnlUsd: '500', trips: 2 },
      3: { netPnlUsd: '-500', trips: 2 },
    });
    const provider = new PlaybookAbRoutingProvider(store, 50, {}, rewardSource, mulberry32(1));

    const served = await provider.current();

    expect(served.version).toBe(3); // newest, not the higher-reward-but-ineligible version 2
  });

  it('reward-source read rejects: fails OPEN to newest-wins, never throws out of current()', async () => {
    // >=2 candidates so the reward read is reached; a DB blip rejects it. The router must degrade to
    // newest-wins (the class-doc fallback promise), not propagate — a throw would degrade the whole
    // consult to an error journal row. Reward reads are measurement, not a safety veto → fail OPEN.
    const store = storeFake([row(2, 'reflection'), row(3, 'reflection')]);
    const throwingRewardSource = {
      rewardsByVersion: vi.fn().mockRejectedValue(new Error('db blip')),
    };
    const provider = new PlaybookAbRoutingProvider(
      store,
      50,
      {},
      throwingRewardSource,
      mulberry32(1),
    );

    const served = await provider.current();

    expect(throwingRewardSource.rewardsByVersion).toHaveBeenCalledTimes(1);
    expect(served.version).toBe(3); // newest-wins fallback, no throw
  });

  it('2+ candidates each clearing K trips: Thompson picks the argmax Gaussian draw for the seed', async () => {
    const store = storeFake([row(2, 'reflection'), row(3, 'reflection')]);
    const rewardSource = rewardSourceFake({
      2: { netPnlUsd: '15', trips: 3 }, // mean 5
      3: { netPnlUsd: '24', trips: 3 }, // mean 8
    });
    const rng = mulberry32(7);
    const provider = new PlaybookAbRoutingProvider(store, 50, {}, rewardSource, rng);

    const served = await provider.current();

    expect(rewardSource.rewardsByVersion).toHaveBeenCalledTimes(1);
    expect([2, 3]).toContain(served.version); // a real Thompson draw, not always the newest

    // Aggregate over many seeds: the higher-mean version (3) wins more often than the lower-mean
    // version (2), but exploration still lets the lower-mean version win sometimes — proving this
    // is a stochastic draw, not disguised newest-wins/argmax-mean.
    let higherMeanWins = 0;
    let lowerMeanWins = 0;
    for (let seed = 0; seed < 60; seed += 1) {
      const seededStore = storeFake([row(2, 'reflection'), row(3, 'reflection')]);
      const seededProvider = new PlaybookAbRoutingProvider(
        seededStore,
        50,
        {},
        rewardSourceFake({
          2: { netPnlUsd: '15', trips: 3 },
          3: { netPnlUsd: '24', trips: 3 },
        }),
        mulberry32(seed),
      );
      const outcome = await seededProvider.current();
      if (outcome.version === 3) higherMeanWins += 1;
      else if (outcome.version === 2) lowerMeanWins += 1;
    }

    expect(higherMeanWins + lowerMeanWins).toBe(60);
    expect(higherMeanWins).toBeGreaterThan(lowerMeanWins); // favored in aggregate
    expect(lowerMeanWins).toBeGreaterThan(0); // exploration still occurs
  });

  it('determinism: the same seed always produces the same choice', async () => {
    const rewards = {
      2: { netPnlUsd: '15', trips: 3 },
      3: { netPnlUsd: '24', trips: 3 },
    };
    const runOnce = async () => {
      const store = storeFake([row(2, 'reflection'), row(3, 'reflection')]);
      const provider = new PlaybookAbRoutingProvider(
        store,
        50,
        {},
        rewardSourceFake(rewards),
        mulberry32(42),
      );
      return provider.current();
    };

    const first = await runOnce();
    const second = await runOnce();

    expect(second.version).toBe(first.version);
  });
});
