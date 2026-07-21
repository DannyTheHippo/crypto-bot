import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PlaybookAbRoutingProvider,
  ValidatingPlaybookProvider,
} from '../../../src/features/trading/composition/agentic-bridge.module';
import type { AgentMetricsRecorder } from '../../../src/features/common/observability/agent-metrics-recorder.service';

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
