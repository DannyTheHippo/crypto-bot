import { describe, it, expect } from 'vitest';
import {
  SentimentFeedService,
  type SentimentHttpSource,
} from '../../../../src/features/venue/market-data/sentiment-feed.service';
import type { ClockPort } from '../../../../src/ports/common/clock';
import { epochMs } from '../../../../src/domain/common/types/ids';

function mutableClock(start = 1_000_000): { clock: ClockPort; set: (t: number) => void } {
  let t = start;
  return { clock: { now: () => epochMs(t) }, set: (n) => (t = n) };
}

// A fixture double implementing the minimal fetch-shaped surface the service needs — no network,
// mirrors fixtureSource in derivatives-feed.spec.ts. Returns a CryptoPanic-shaped payload by
// default (results: [{ title, published_at, source: { domain } }]).
function fixtureSource(
  overrides: {
    raw?: unknown;
    fail?: boolean;
  } = {},
): SentimentHttpSource {
  return {
    fetchPosts: () => {
      if (overrides.fail) return Promise.reject(new Error('cryptopanic fetch failed'));
      return Promise.resolve(
        overrides.raw ?? {
          results: [
            {
              title: 'BTC breaks resistance',
              published_at: '2026-07-10T00:00:00Z',
              source: { domain: 'example.com' },
            },
          ],
        },
      );
    },
  };
}

describe('SentimentFeedService', () => {
  it('parses a fixture CryptoPanic payload into a snapshot with the rendered headlines', async () => {
    const { clock } = mutableClock();
    const source = fixtureSource({
      raw: {
        results: [
          {
            title: 'ETH rallies',
            published_at: '2026-07-10T01:00:00Z',
            source: { domain: 'coindesk.com' },
          },
        ],
      },
    });
    const svc = new SentimentFeedService(source, { pollIntervalMs: 60_000, clock });

    await svc.poll();
    const snap = svc.latest();

    expect(snap).not.toBeNull();
    expect(snap!.items).toEqual([
      { title: 'ETH rallies', source: 'coindesk.com', publishedAt: '2026-07-10T01:00:00Z' },
    ]);
    expect(snap!.asOf).toBe(1_000_000);
  });

  it('caps rendered headlines at 5 even when the response carries more', async () => {
    const { clock } = mutableClock();
    const results = Array.from({ length: 8 }, (_, i) => ({
      title: `headline ${i}`,
      published_at: '2026-07-10T00:00:00Z',
      source: { domain: 'example.com' },
    }));
    const svc = new SentimentFeedService(fixtureSource({ raw: { results } }), {
      pollIntervalMs: 60_000,
      clock,
    });

    await svc.poll();

    expect(svc.latest()!.items).toHaveLength(5);
  });

  it('truncates oversized headline fields (external text entering the prompt is length-bounded)', async () => {
    const { clock } = mutableClock();
    const results = [
      {
        title: 'T'.repeat(500),
        published_at: `2026-07-10T00:00:00Z${'x'.repeat(100)}`,
        source: { domain: `${'d'.repeat(100)}.com` },
      },
    ];
    const svc = new SentimentFeedService(fixtureSource({ raw: { results } }), {
      pollIntervalMs: 60_000,
      clock,
    });

    await svc.poll();

    const item = svc.latest()!.items[0]!;
    expect(item.title).toHaveLength(200);
    expect(item.source).toHaveLength(64);
    expect(item.publishedAt).toHaveLength(64);
  });

  it('degrades to an empty item list (never throws) when the response shape is unknown/untrusted', async () => {
    const { clock } = mutableClock();
    const svc = new SentimentFeedService(fixtureSource({ raw: { unexpected: true } }), {
      pollIntervalMs: 60_000,
      clock,
    });

    await expect(svc.poll()).resolves.toBeUndefined();
    expect(svc.latest()!.items).toEqual([]);
  });

  it('skips an individual entry missing title/published_at rather than discarding the whole snapshot', async () => {
    const { clock } = mutableClock();
    const source = fixtureSource({
      raw: {
        results: [
          {
            title: 'valid headline',
            published_at: '2026-07-10T00:00:00Z',
            source: { domain: 'x.com' },
          },
          { published_at: '2026-07-10T00:00:00Z' }, // missing title
        ],
      },
    });
    const svc = new SentimentFeedService(source, { pollIntervalMs: 60_000, clock });

    await svc.poll();

    expect(svc.latest()!.items).toEqual([
      { title: 'valid headline', source: 'x.com', publishedAt: '2026-07-10T00:00:00Z' },
    ]);
  });

  // X4 residual: dedupe-by-id across polls.
  describe('dedupe-by-id (X4 residual)', () => {
    it('drops a post whose id was already rendered on a PRIOR poll, even though this poll re-serves it', async () => {
      const { clock } = mutableClock();
      const post = (id: number, title: string) => ({
        id,
        title,
        published_at: '2026-07-10T00:00:00Z',
        source: { domain: 'x.com' },
      });
      let results = [post(1, 'first headline')];
      const svc = new SentimentFeedService(
        { fetchPosts: () => Promise.resolve({ results }) },
        { pollIntervalMs: 60_000, clock },
      );

      await svc.poll();
      expect(svc.latest()!.items).toEqual([
        { title: 'first headline', source: 'x.com', publishedAt: '2026-07-10T00:00:00Z' },
      ]);

      // Next poll re-serves the SAME post (id 1, CryptoPanic's own trailing-window behavior) plus one
      // genuinely new one (id 2) — only the new one should render.
      results = [post(1, 'first headline'), post(2, 'second headline')];
      await svc.poll();
      expect(svc.latest()!.items).toEqual([
        { title: 'second headline', source: 'x.com', publishedAt: '2026-07-10T00:00:00Z' },
      ]);
    });

    it('a post with no id field is never deduped — rendered every time it appears (fail open)', async () => {
      const { clock } = mutableClock();
      const results = [
        {
          title: 'no-id headline',
          published_at: '2026-07-10T00:00:00Z',
          source: { domain: 'x.com' },
        },
      ];
      const svc = new SentimentFeedService(
        { fetchPosts: () => Promise.resolve({ results }) },
        { pollIntervalMs: 60_000, clock },
      );

      await svc.poll();
      await svc.poll();

      expect(svc.latest()!.items).toEqual([
        { title: 'no-id headline', source: 'x.com', publishedAt: '2026-07-10T00:00:00Z' },
      ]);
    });

    it('within a SINGLE poll, two entries sharing the same id are deduped too (only the first is kept)', async () => {
      const { clock } = mutableClock();
      const results = [
        { id: 7, title: 'A', published_at: '2026-07-10T00:00:00Z', source: { domain: 'x.com' } },
        {
          id: 7,
          title: 'B (dup id)',
          published_at: '2026-07-10T00:00:00Z',
          source: { domain: 'x.com' },
        },
      ];
      const svc = new SentimentFeedService(
        { fetchPosts: () => Promise.resolve({ results }) },
        { pollIntervalMs: 60_000, clock },
      );

      await svc.poll();

      expect(svc.latest()!.items).toEqual([
        { title: 'A', source: 'x.com', publishedAt: '2026-07-10T00:00:00Z' },
      ]);
    });
  });

  it('answers null before any successful poll has landed', () => {
    const { clock } = mutableClock();
    const svc = new SentimentFeedService(fixtureSource(), { pollIntervalMs: 60_000, clock });

    expect(svc.latest()).toBeNull();
  });

  it('treats a snapshot older than 2x the poll interval as stale (null), never serving outdated data', async () => {
    const { clock, set } = mutableClock(1_000_000);
    const svc = new SentimentFeedService(fixtureSource(), { pollIntervalMs: 60_000, clock });

    await svc.poll();
    expect(svc.latest()).not.toBeNull();

    set(1_000_000 + 60_000 * 2); // exactly at the threshold — still fresh
    expect(svc.latest()).not.toBeNull();

    set(1_000_000 + 60_000 * 2 + 1); // just past the threshold — now stale
    expect(svc.latest()).toBeNull();
  });

  it('an outage (missing key upstream / fetch failure) logs and continues (never throws), incrementing the error counter and leaving latest() null', async () => {
    const { clock } = mutableClock();
    const warnings: string[] = [];
    const svc = new SentimentFeedService(fixtureSource({ fail: true }), {
      pollIntervalMs: 60_000,
      clock,
      logger: { warn: (m) => warnings.push(m) },
    });

    await expect(svc.poll()).resolves.toBeUndefined();
    expect(svc.latest()).toBeNull();
    expect(svc.pollErrorCount()).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(svc.lastSuccessfulPollAt()).toBeNull();
  });

  it('a subsequent successful poll after a failure clears the outage (latest() populated, lastSuccessfulPollAt set)', async () => {
    const { clock } = mutableClock(1_000_000);
    let fail = true;
    const source: SentimentHttpSource = {
      fetchPosts: () =>
        fail
          ? Promise.reject(new Error('down'))
          : Promise.resolve({
              results: [{ title: 'recovered', published_at: 't', source: { domain: 'x.com' } }],
            }),
    };
    const svc = new SentimentFeedService(source, { pollIntervalMs: 60_000, clock });

    await svc.poll();
    expect(svc.latest()).toBeNull();
    expect(svc.pollErrorCount()).toBe(1);

    fail = false;
    await svc.poll();
    expect(svc.latest()).not.toBeNull();
    expect(svc.lastSuccessfulPollAt()).toBe(1_000_000);
    expect(svc.pollErrorCount()).toBe(1); // unchanged — no new failure
  });
});
