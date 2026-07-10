// N2.3: PlaybookAbRoutingProvider's CANDIDATE_SOURCES set (app.module.ts) — 'loop-candidate' rows
// (scripts/playbook-candidate.mjs, the loop-side injection path) route exactly like 'reflection'
// rows. Complements playbook-ab-routing.spec.ts (pct/bucket/validation-gate mechanics, unchanged by
// this task) with source-selection coverage specifically.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaybookAbRoutingProvider } from '../../../src/app.module';

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
  source: 'seed' | 'reflection' | 'promotion' | 'loop-candidate';
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

describe('PlaybookAbRoutingProvider — CANDIDATE_SOURCES (N2.3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BUCKET_5_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('routes to a loop-candidate row when the bucket falls inside pct', async () => {
    const store = storeFake([row(2, 'loop-candidate')]);
    const provider = new PlaybookAbRoutingProvider(store, 10); // bucket 5 < 10 → route

    const served = await provider.current();

    expect(served.version).toBe(2);
    expect(served.content).toBe(VALID_CANDIDATE);
  });

  it('still routes to a reflection row (unchanged behavior)', async () => {
    const store = storeFake([row(2, 'reflection')]);
    const provider = new PlaybookAbRoutingProvider(store, 10);

    const served = await provider.current();

    expect(served.version).toBe(2);
  });

  it('never routes to a promotion row', async () => {
    const store = storeFake([row(2, 'promotion')]);
    const provider = new PlaybookAbRoutingProvider(store, 50);

    const served = await provider.current();

    expect(served.version).toBe(1); // falls back to ACTIVE
  });

  it('never routes to a seed row', async () => {
    const store = storeFake([row(2, 'seed')]);
    const provider = new PlaybookAbRoutingProvider(store, 50);

    const served = await provider.current();

    expect(served.version).toBe(1);
  });

  it('newest wins when both a reflection and a loop-candidate row exist above active', async () => {
    const store = storeFake([row(2, 'reflection'), row(3, 'loop-candidate')]);
    const provider = new PlaybookAbRoutingProvider(store, 50);

    const served = await provider.current();

    expect(served.version).toBe(3);
  });

  it('newest wins the other way round too (loop-candidate older than reflection)', async () => {
    const store = storeFake([row(2, 'loop-candidate'), row(3, 'reflection')]);
    const provider = new PlaybookAbRoutingProvider(store, 50);

    const served = await provider.current();

    expect(served.version).toBe(3);
  });
});
