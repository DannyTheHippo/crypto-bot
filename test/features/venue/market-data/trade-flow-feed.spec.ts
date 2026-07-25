import { describe, it, expect } from 'vitest';
import {
  TradeFlowFeedService,
  type TradeFlowRestSource,
} from '../../../../src/features/venue/market-data/trade-flow-feed.service';
import type { ClockPort } from '../../../../src/ports/common/clock';
import { symbolId, epochMs } from '../../../../src/domain/common/types/ids';

const SYM = symbolId('BTC/USDT');

function mutableClock(start = 1_000_000): { clock: ClockPort; set: (t: number) => void } {
  let t = start;
  return { clock: { now: () => epochMs(t) }, set: (n) => (t = n) };
}

// A raw Binance kline row: [openTime, open, high, low, close, volume, closeTime, quoteVolume,
// numTrades, takerBuyBaseVolume, takerBuyQuoteVolume, ignore] — every numeric field a venue string.
function klineRow(volume: string, takerBuyBaseVolume: string, openTime = 0): unknown[] {
  return klineRowWithClose('100.5', volume, takerBuyBaseVolume, openTime);
}

// X5: close-price-parameterized sibling of klineRow above, for divergence tests that need the price
// to actually move across bars (klineRow's fixed '100.5' close is fine for cvd/barImbalance-only
// fixtures, but divergence compares first-vs-last close over the window).
function klineRowWithClose(
  close: string,
  volume: string,
  takerBuyBaseVolume: string,
  openTime = 0,
): unknown[] {
  return [
    openTime,
    '100',
    '101',
    '99',
    close,
    volume,
    openTime + 899_999,
    '0',
    10,
    takerBuyBaseVolume,
    '0',
    '0',
  ];
}

function fixtureSource(rows: unknown[][]): TradeFlowRestSource & { calledArgs: unknown[][] } {
  const calledArgs: unknown[][] = [];
  return {
    calledArgs,
    fetchRawKlines: (symbol, interval, limit) => {
      calledArgs.push([symbol, interval, limit]);
      return Promise.resolve(rows);
    },
  };
}

describe('TradeFlowFeedService', () => {
  it('computes exact CVD + barImbalance over the last N CLOSED bars, dropping the still-forming last row', async () => {
    const { clock } = mutableClock();
    // 3 closed bars + 1 still-forming (dropped): volumes 100/200/50/999, taker-buy 60/50/50/999.
    // Deltas: bar1 60-40=+20, bar2 50-150=-100, bar3 50-0=+50. CVD = 20-100+50 = -30.
    // barImbalance is the LAST counted bar's: 50/50 = 1.
    const rows = [
      klineRow('100', '60', 0),
      klineRow('200', '50', 900_000),
      klineRow('50', '50', 1_800_000),
      klineRow('999', '999', 2_700_000), // still-forming, dropped
    ];
    const source = fixtureSource(rows);
    const svc = new TradeFlowFeedService(source, {
      symbols: [SYM],
      interval: '15m',
      lookbackBars: 3,
      pollIntervalMs: 60_000,
      clock,
    });

    await svc.pollAll();
    const snap = svc.latest(SYM);

    expect(snap).not.toBeNull();
    expect(snap!.cvd).toBe(-30);
    expect(snap!.barImbalance).toBe(1);
    expect(snap!.lookbackBars).toBe(3);
    expect(snap!.asOf).toBe(1_000_000);
    expect(source.calledArgs).toEqual([['BTCUSDT', '15m', 5]]);
  });

  it('answers null for a symbol that has never been polled', () => {
    const { clock } = mutableClock();
    const svc = new TradeFlowFeedService(fixtureSource([]), {
      symbols: [SYM],
      interval: '15m',
      lookbackBars: 20,
      pollIntervalMs: 60_000,
      clock,
    });

    expect(svc.latest(SYM)).toBeNull();
  });

  it('treats a snapshot older than 2x the poll interval as stale (null), never serving outdated data', async () => {
    const { clock, set } = mutableClock(1_000_000);
    const rows = [klineRow('100', '60', 0), klineRow('999', '999', 900_000)];
    const svc = new TradeFlowFeedService(fixtureSource(rows), {
      symbols: [SYM],
      interval: '15m',
      lookbackBars: 1,
      pollIntervalMs: 60_000,
      clock,
    });

    await svc.pollAll();
    expect(svc.latest(SYM)).not.toBeNull();

    set(1_000_000 + 60_000 * 2);
    expect(svc.latest(SYM)).not.toBeNull();

    set(1_000_000 + 60_000 * 2 + 1);
    expect(svc.latest(SYM)).toBeNull();
  });

  it('a poll failure logs and continues (never throws), incrementing the error counter and leaving latest() null', async () => {
    const { clock } = mutableClock();
    const warnings: string[] = [];
    const source: TradeFlowRestSource = {
      fetchRawKlines: () => Promise.reject(new Error('klines fetch failed')),
    };
    const svc = new TradeFlowFeedService(source, {
      symbols: [SYM],
      interval: '15m',
      lookbackBars: 20,
      pollIntervalMs: 60_000,
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
    const rows = [klineRow('100', '60', 0), klineRow('999', '999', 900_000)];
    const source: TradeFlowRestSource = {
      fetchRawKlines: () => (fail ? Promise.reject(new Error('down')) : Promise.resolve(rows)),
    };
    const svc = new TradeFlowFeedService(source, {
      symbols: [SYM],
      interval: '15m',
      lookbackBars: 20,
      pollIntervalMs: 60_000,
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

  it('answers null (never a garbage snapshot) when there are no closed rows at all', async () => {
    const { clock } = mutableClock();
    // Only the still-forming row — dropped, leaving zero closed bars.
    const svc = new TradeFlowFeedService(fixtureSource([klineRow('999', '999', 0)]), {
      symbols: [SYM],
      interval: '15m',
      lookbackBars: 20,
      pollIntervalMs: 60_000,
      clock,
    });

    await svc.pollAll();
    expect(svc.latest(SYM)).toBeNull();
  });

  // X5 (tf2): per-bar cvdDeltas series + divergence flag.
  describe('cvdDeltas + divergence (X5)', () => {
    it('reports per-bar cvdDeltas oldest-first over the trailing window, and null divergence when price and CVD move the same direction', async () => {
      const { clock } = mutableClock();
      // Price rises 100->102; CVD also rises (deltas +10, +20) — no divergence.
      const rows = [
        klineRowWithClose('100', '100', '55', 0), // delta = 55-45=+10
        klineRowWithClose('102', '100', '60', 900_000), // delta = 60-40=+20
        klineRowWithClose('999', '999', '999', 1_800_000), // still-forming, dropped
      ];
      const svc = new TradeFlowFeedService(fixtureSource(rows), {
        symbols: [SYM],
        interval: '15m',
        lookbackBars: 20,
        pollIntervalMs: 60_000,
        clock,
      });

      await svc.pollAll();
      const snap = svc.latest(SYM);

      expect(snap).not.toBeNull();
      expect(snap!.cvdDeltas).toEqual([10, 20]);
      expect(snap!.divergence).toBeNull();
    });

    it('flags bullish_divergence when price FALLS over the window while CVD RISES', async () => {
      const { clock } = mutableClock();
      const rows = [
        klineRowWithClose('100', '100', '30', 0), // delta = 30-70=-40
        klineRowWithClose('95', '100', '80', 900_000), // delta = 80-20=+60
        klineRowWithClose('999', '999', '999', 1_800_000), // still-forming, dropped
      ];
      const svc = new TradeFlowFeedService(fixtureSource(rows), {
        symbols: [SYM],
        interval: '15m',
        lookbackBars: 20,
        pollIntervalMs: 60_000,
        clock,
      });

      await svc.pollAll();
      const snap = svc.latest(SYM);

      expect(snap).not.toBeNull();
      expect(snap!.divergence).toBe('bullish_divergence');
    });

    it('flags bearish_divergence when price RISES over the window while CVD FALLS', async () => {
      const { clock } = mutableClock();
      const rows = [
        klineRowWithClose('100', '100', '20', 0), // delta = 20-80=-60
        klineRowWithClose('105', '100', '45', 900_000), // delta = 45-55=-10
        klineRowWithClose('999', '999', '999', 1_800_000), // still-forming, dropped
      ];
      const svc = new TradeFlowFeedService(fixtureSource(rows), {
        symbols: [SYM],
        interval: '15m',
        lookbackBars: 20,
        pollIntervalMs: 60_000,
        clock,
      });

      await svc.pollAll();
      const snap = svc.latest(SYM);

      expect(snap).not.toBeNull();
      expect(snap!.divergence).toBe('bearish_divergence');
    });

    it('caps the divergence window at 8 bars even when lookbackBars is wider, and null divergence with fewer than 2 usable bars', async () => {
      const { clock } = mutableClock();
      const svc = new TradeFlowFeedService(
        fixtureSource([
          klineRowWithClose('100', '100', '60', 0),
          klineRowWithClose('999', '999', '999', 900_000), // still-forming, dropped
        ]),
        {
          symbols: [SYM],
          interval: '15m',
          lookbackBars: 20,
          pollIntervalMs: 60_000,
          clock,
        },
      );

      await svc.pollAll();
      const snap = svc.latest(SYM);

      expect(snap).not.toBeNull();
      expect(snap!.cvdDeltas).toEqual([20]);
      expect(snap!.divergence).toBeNull();
    });
  });
});
