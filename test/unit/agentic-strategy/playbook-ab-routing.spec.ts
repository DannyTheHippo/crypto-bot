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
});
