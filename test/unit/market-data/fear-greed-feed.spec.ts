import { describe, it, expect } from 'vitest';
import {
  FearGreedFeedService,
  type FearGreedHttpSource,
} from '../../../src/features/trading/market-data/fear-greed-feed.service';
import type { ClockPort } from '../../../src/ports/clock';
import { epochMs } from '../../../src/domain/types/ids';

function mutableClock(start = 1_000_000): { clock: ClockPort; set: (t: number) => void } {
  let t = start;
  return { clock: { now: () => epochMs(t) }, set: (n) => (t = n) };
}

// A fixture double implementing the minimal fetch-shaped surface the service needs — no network.
// Returns an alternative.me-shaped payload by default (data: [{ value, value_classification,
// timestamp }], unix-SECONDS timestamps, newest-first per the venue's own convention — the service
// itself sorts rather than trusting this order, see fear-greed-feed.service.ts's own comment).
function fixtureSource(overrides: { raw?: unknown; fail?: boolean } = {}): FearGreedHttpSource {
  return {
    fetchIndex: () => {
      if (overrides.fail) return Promise.reject(new Error('alternative.me fetch failed'));
      return Promise.resolve(
        overrides.raw ?? {
          data: [{ value: '50', value_classification: 'Neutral', timestamp: String(1_000) }],
        },
      );
    },
  };
}

describe('FearGreedFeedService', () => {
  it('parses a single-row fixture payload into a snapshot', async () => {
    const { clock } = mutableClock(1_000_000 + 1_000_000);
    const source = fixtureSource({
      raw: { data: [{ value: '72', value_classification: 'Greed', timestamp: '1000' }] },
    });
    const svc = new FearGreedFeedService(source, { pollIntervalMs: 21_600_000, clock });

    await svc.poll();
    const snap = svc.latest();

    expect(snap).not.toBeNull();
    expect(snap!.value).toBe(72);
    expect(snap!.classification).toBe('Greed');
    expect(snap!.trend).toBeNull(); // single row — no trend computable
  });

  it("parses trend from the history array regardless of the venue's own row order (newest-first here), never assuming the ordering", async () => {
    const now = 10_000_000;
    const { clock } = mutableClock(now);
    // Newest-first (venue's typical order): today=80 (greed), 2 days ago=20 (extreme fear).
    const source = fixtureSource({
      raw: {
        data: [
          { value: '80', value_classification: 'Extreme Greed', timestamp: String(now / 1000) },
          {
            value: '20',
            value_classification: 'Extreme Fear',
            timestamp: String(now / 1000 - 172_800),
          },
        ],
      },
    });
    const svc = new FearGreedFeedService(source, { pollIntervalMs: 21_600_000, clock });

    await svc.poll();
    const snap = svc.latest();

    expect(snap).not.toBeNull();
    expect(snap!.value).toBe(80); // the newest row by TIMESTAMP, not array position
    expect(snap!.trend).toBe('rising'); // 20 -> 80 over the window
  });

  it('reports a falling trend when the index moved toward fear over the window', async () => {
    const now = 10_000_000;
    const { clock } = mutableClock(now);
    const source = fixtureSource({
      raw: {
        data: [
          { value: '30', value_classification: 'Fear', timestamp: String(now / 1000) },
          { value: '70', value_classification: 'Greed', timestamp: String(now / 1000 - 86_400) },
        ],
      },
    });
    const svc = new FearGreedFeedService(source, { pollIntervalMs: 21_600_000, clock });

    await svc.poll();
    expect(svc.latest()!.trend).toBe('falling');
  });

  it('omits the snapshot entirely (never a garbage/partial one) when the newest row is stale (>48h old) — the source itself has gone quiet', async () => {
    const now = 100_000_000;
    const { clock } = mutableClock(now);
    const staleTs = Math.floor((now - 49 * 60 * 60 * 1000) / 1000); // 49h old
    const source = fixtureSource({
      raw: { data: [{ value: '50', value_classification: 'Neutral', timestamp: String(staleTs) }] },
    });
    const svc = new FearGreedFeedService(source, { pollIntervalMs: 21_600_000, clock });

    await svc.poll();
    expect(svc.latest()).toBeNull();
  });

  it('renders a value exactly 48h old (boundary — still fresh)', async () => {
    const now = 100_000_000;
    const { clock } = mutableClock(now);
    const boundaryTs = Math.floor((now - 48 * 60 * 60 * 1000) / 1000);
    const source = fixtureSource({
      raw: {
        data: [{ value: '50', value_classification: 'Neutral', timestamp: String(boundaryTs) }],
      },
    });
    const svc = new FearGreedFeedService(source, { pollIntervalMs: 21_600_000, clock });

    await svc.poll();
    expect(svc.latest()).not.toBeNull();
  });

  it('degrades to no snapshot (never throws) when the response shape is unknown/untrusted', async () => {
    const { clock } = mutableClock();
    const svc = new FearGreedFeedService(fixtureSource({ raw: { unexpected: true } }), {
      pollIntervalMs: 21_600_000,
      clock,
    });

    await expect(svc.poll()).resolves.toBeUndefined();
    expect(svc.latest()).toBeNull();
  });

  it('skips an individual row missing value/classification/timestamp rather than discarding usable rows', async () => {
    const now = 10_000_000;
    const { clock } = mutableClock(now);
    const source = fixtureSource({
      raw: {
        data: [
          { value: '60', value_classification: 'Greed', timestamp: String(now / 1000) },
          { value_classification: 'Fear', timestamp: String(now / 1000 - 86_400) }, // missing value
        ],
      },
    });
    const svc = new FearGreedFeedService(source, { pollIntervalMs: 21_600_000, clock });

    await svc.poll();
    const snap = svc.latest();

    expect(snap).not.toBeNull();
    expect(snap!.value).toBe(60);
    expect(snap!.trend).toBeNull(); // only 1 usable row after the bad one is dropped
  });

  it('answers null before any successful poll has landed', () => {
    const { clock } = mutableClock();
    const svc = new FearGreedFeedService(fixtureSource(), { pollIntervalMs: 21_600_000, clock });

    expect(svc.latest()).toBeNull();
  });

  it('treats a snapshot older than 2x the poll interval as stale (null), never serving outdated data', async () => {
    const { clock, set } = mutableClock(1_000_000);
    const svc = new FearGreedFeedService(
      fixtureSource({
        raw: { data: [{ value: '50', value_classification: 'Neutral', timestamp: '1000' }] },
      }),
      { pollIntervalMs: 60_000, clock },
    );

    await svc.poll();
    expect(svc.latest()).not.toBeNull();

    set(1_000_000 + 60_000 * 2);
    expect(svc.latest()).not.toBeNull();

    set(1_000_000 + 60_000 * 2 + 1);
    expect(svc.latest()).toBeNull();
  });

  it('an outage (fetch failure) logs and continues (never throws), incrementing the error counter and leaving latest() null', async () => {
    const { clock } = mutableClock();
    const warnings: string[] = [];
    const svc = new FearGreedFeedService(fixtureSource({ fail: true }), {
      pollIntervalMs: 21_600_000,
      clock,
      logger: { warn: (m) => warnings.push(m) },
    });

    await expect(svc.poll()).resolves.toBeUndefined();
    expect(svc.latest()).toBeNull();
    expect(svc.pollErrorCount()).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(svc.lastSuccessfulPollAt()).toBeNull();
  });

  it('a subsequent successful poll after a failure clears the outage', async () => {
    const now = 10_000_000;
    const { clock } = mutableClock(now);
    let fail = true;
    const source: FearGreedHttpSource = {
      fetchIndex: () =>
        fail
          ? Promise.reject(new Error('down'))
          : Promise.resolve({
              data: [
                { value: '55', value_classification: 'Neutral', timestamp: String(now / 1000) },
              ],
            }),
    };
    const svc = new FearGreedFeedService(source, { pollIntervalMs: 21_600_000, clock });

    await svc.poll();
    expect(svc.latest()).toBeNull();
    expect(svc.pollErrorCount()).toBe(1);

    fail = false;
    await svc.poll();
    expect(svc.latest()).not.toBeNull();
    expect(svc.lastSuccessfulPollAt()).not.toBeNull();
  });
});
