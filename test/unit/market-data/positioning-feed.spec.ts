import { describe, it, expect } from 'vitest';
import {
  PositioningFeedService,
  type PositioningRestSource,
} from '../../../src/features/trading/market-data/positioning-feed.service';
import type { ClockPort } from '../../../src/ports/clock';
import { symbolId, epochMs } from '../../../src/domain/types/ids';

const SYM = symbolId('BTC/USDT');

function mutableClock(start = 1_000_000): { clock: ClockPort; set: (t: number) => void } {
  let t = start;
  return { clock: { now: () => epochMs(t) }, set: (n) => (t = n) };
}

function fixtureSource(
  rows: Array<{
    longAccount?: string | number;
    shortAccount?: string | number;
    longShortRatio?: string | number;
    timestamp?: number;
  }>,
): PositioningRestSource & { calledArgs: unknown[][] } {
  const calledArgs: unknown[][] = [];
  return {
    calledArgs,
    fetchRawLongShortRatio: (symbol, period, limit) => {
      calledArgs.push([symbol, period, limit]);
      return Promise.resolve(rows);
    },
  };
}

describe('PositioningFeedService', () => {
  it('parses a fixture long/short-ratio payload into a snapshot, using the LAST (most recent) row and translating the spot symbol to the venue futures market id', async () => {
    const { clock } = mutableClock();
    const source = fixtureSource([
      { longAccount: '0.5', shortAccount: '0.5', longShortRatio: '1.0', timestamp: 1 },
      { longAccount: '0.4558', shortAccount: '0.5442', longShortRatio: '0.8376', timestamp: 2 },
    ]);
    const svc = new PositioningFeedService(source, {
      symbols: [SYM],
      ratioPeriod: '15m',
      pollIntervalMs: 300_000,
      clock,
    });

    await svc.pollAll();
    const snap = svc.latest(SYM);

    expect(snap).not.toBeNull();
    expect(snap!.longShortRatio).toBe(0.8376);
    expect(snap!.longAccountPct).toBe(45.58);
    expect(snap!.shortAccountPct).toBe(54.42);
    expect(snap!.asOf).toBe(1_000_000);
    expect(source.calledArgs).toEqual([['BTCUSDT', '15m', 1]]);
  });

  it('answers null for a symbol that has never been polled', () => {
    const { clock } = mutableClock();
    const svc = new PositioningFeedService(fixtureSource([]), {
      symbols: [SYM],
      ratioPeriod: '15m',
      pollIntervalMs: 300_000,
      clock,
    });

    expect(svc.latest(SYM)).toBeNull();
  });

  it('treats a snapshot older than 2x the poll interval as stale (null), never serving outdated data', async () => {
    const { clock, set } = mutableClock(1_000_000);
    const source = fixtureSource([
      { longAccount: '0.5', shortAccount: '0.5', longShortRatio: '1' },
    ]);
    const svc = new PositioningFeedService(source, {
      symbols: [SYM],
      ratioPeriod: '15m',
      pollIntervalMs: 300_000,
      clock,
    });

    await svc.pollAll();
    expect(svc.latest(SYM)).not.toBeNull();

    set(1_000_000 + 300_000 * 2);
    expect(svc.latest(SYM)).not.toBeNull();

    set(1_000_000 + 300_000 * 2 + 1);
    expect(svc.latest(SYM)).toBeNull();
  });

  it('a poll failure logs and continues (never throws), incrementing the error counter and leaving latest() null', async () => {
    const { clock } = mutableClock();
    const warnings: string[] = [];
    const source: PositioningRestSource = {
      fetchRawLongShortRatio: () => Promise.reject(new Error('ratio fetch failed')),
    };
    const svc = new PositioningFeedService(source, {
      symbols: [SYM],
      ratioPeriod: '15m',
      pollIntervalMs: 300_000,
      clock,
      logger: { warn: (m) => warnings.push(m) },
    });

    await expect(svc.pollAll()).resolves.toBeUndefined();
    expect(svc.latest(SYM)).toBeNull();
    expect(svc.pollErrorCount()).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(svc.lastSuccessfulPollAt()).toBeNull();
  });

  it('a subsequent successful poll after a failure clears the outage (sibling-feed recovery bar)', async () => {
    const { clock } = mutableClock();
    let fail = true;
    const source: PositioningRestSource = {
      fetchRawLongShortRatio: () =>
        fail
          ? Promise.reject(new Error('down'))
          : Promise.resolve([
              { longAccount: '0.6', shortAccount: '0.4', longShortRatio: '1.5', timestamp: 1 },
            ]),
    };
    const svc = new PositioningFeedService(source, {
      symbols: [SYM],
      ratioPeriod: '15m',
      pollIntervalMs: 300_000,
      clock,
    });

    await svc.pollAll();
    expect(svc.latest(SYM)).toBeNull();
    expect(svc.pollErrorCount()).toBe(1);

    fail = false;
    await svc.pollAll();
    expect(svc.latest(SYM)).not.toBeNull();
    expect(svc.lastSuccessfulPollAt()).not.toBeNull();
  });

  it('discards a response missing longShortRatio rather than caching a partial/garbage snapshot', async () => {
    const { clock } = mutableClock();
    const source = fixtureSource([{ longAccount: '0.5', shortAccount: '0.5' }]);
    const svc = new PositioningFeedService(source, {
      symbols: [SYM],
      ratioPeriod: '15m',
      pollIntervalMs: 300_000,
      clock,
    });

    await svc.pollAll();

    expect(svc.latest(SYM)).toBeNull();
  });

  it('discards an empty response array', async () => {
    const { clock } = mutableClock();
    const svc = new PositioningFeedService(fixtureSource([]), {
      symbols: [SYM],
      ratioPeriod: '15m',
      pollIntervalMs: 300_000,
      clock,
    });

    await svc.pollAll();

    expect(svc.latest(SYM)).toBeNull();
  });
});
