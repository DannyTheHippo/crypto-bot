import { describe, expect, it, vi } from 'vitest';
import { epochMs, symbolId, venueId } from '../../../../src/domain/common/types/ids';
import { price, qty } from '../../../../src/domain/common/types/money';
import { EdgeCohortPinState } from '../../../../src/features/strategy/agentic/edge-cohort-pin-state';
import {
  rankResidualCohort,
  ResidualVolbetaEdgePolicy,
  trailingReturn,
  type DailyCloseSeries,
} from '../../../../src/features/strategy/agentic/residual-volbeta-edge-policy';
import type { FeedHealthPort } from '../../../../src/ports/venue/market-data';
import type { CandleEvent } from '../../../../src/domain/venue/types/market-events';

const DAY = 86_400_000;
const START = Date.parse('2024-01-01T00:00:00.000Z');
const VENUE = venueId('binanceusdm');

function seriesFromCloses(closes: number[]): DailyCloseSeries {
  return {
    timestamps: closes.map((_, i) => START + i * DAY),
    closes,
  };
}

/** Geometric path so residual ranking tracks excess return vs BTC cleanly. */
function geo(n: number, start: number, dailyRet: number): number[] {
  const out: number[] = [start];
  for (let i = 1; i < n; i += 1) out.push(out[i - 1]! * (1 + dailyRet));
  return out;
}

function mkBars(dailyRet: number, symbol: string): CandleEvent[] {
  const closes = geo(100, 100, dailyRet);
  return closes.map((c, i) => {
    const t = epochMs(START + i * DAY);
    const px = price(String(c));
    return {
      kind: 'CANDLE',
      venue: VENUE,
      symbol: symbolId(symbol),
      eventTime: t,
      channel: 'candles',
      seq: BigInt(i),
      ingestTime: t,
      interval: '1d' as const,
      openTime: t,
      closeTime: epochMs(Number(t) + DAY - 1),
      open: px,
      high: px,
      low: px,
      close: px,
      volume: qty('1'),
      closed: true,
    } as unknown as CandleEvent;
  });
}

describe('residual ranking helpers', () => {
  it('computes trailing return over lookback', () => {
    const closes = [100, 110];
    const ret = trailingReturn(closes, 1, 1);
    expect(ret).not.toBeNull();
    expect(ret! > 0).toBe(true);
    expect(ret! < 0.2).toBe(true);
  });

  it('ranks residual cohort long top-2 / short bottom-2', () => {
    const n = 100;
    const bySymbol = new Map<string, DailyCloseSeries>([
      ['BTC/USDT:USDT', seriesFromCloses(geo(n, 100, 0.001))],
      ['HOT/USDT:USDT', seriesFromCloses(geo(n, 100, 0.01))],
      ['WARM/USDT:USDT', seriesFromCloses(geo(n, 100, 0.005))],
      ['COLD/USDT:USDT', seriesFromCloses(geo(n, 100, 0.0005))],
      ['FROZEN/USDT:USDT', seriesFromCloses(geo(n, 100, -0.005))],
    ]);
    const ranked = rankResidualCohort(bySymbol);
    expect(ranked).not.toBeNull();
    expect(ranked!.longs).toHaveLength(2);
    expect(ranked!.shorts).toHaveLength(2);
    expect(ranked!.members).toHaveLength(4);
    expect(new Set([...ranked!.longs, ...ranked!.shorts]).size).toBe(4);
    expect(ranked!.longs).toContain('HOT/USDT:USDT');
    expect(ranked!.shorts).toContain('FROZEN/USDT:USDT');
  });
});

describe('ResidualVolbetaEdgePolicy', () => {
  it('stays inactive until refresh succeeds', () => {
    const pin = new EdgeCohortPinState();
    const feed: FeedHealthPort = {
      health: () => 'LIVE',
      getRefPrice: () => undefined,
      updateRefPrice: () => undefined,
      fetchCandles: vi.fn(() => Promise.resolve([] as CandleEvent[])),
    };
    const policy = new ResidualVolbetaEdgePolicy({
      feedHealth: feed,
      symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
      now: () => epochMs(START),
      pinState: pin,
      logger: { warn: () => undefined },
    });
    const snap = policy.snapshot({
      symbol: symbolId('BTC/USDT:USDT'),
      eventTime: epochMs(START),
    });
    expect(snap.active).toBe(false);
  });

  it('activates after successful refresh with eligible series', async () => {
    const pin = new EdgeCohortPinState();
    const feed: FeedHealthPort = {
      health: () => 'LIVE',
      getRefPrice: () => undefined,
      updateRefPrice: () => undefined,
      fetchCandles: vi.fn((_v, sym) => {
        const s = String(sym);
        if (s.startsWith('BTC')) return Promise.resolve(mkBars(0.001, s));
        if (s.startsWith('ETH')) return Promise.resolve(mkBars(0.008, s));
        if (s.startsWith('SOL')) return Promise.resolve(mkBars(0.005, s));
        if (s.startsWith('XRP')) return Promise.resolve(mkBars(0.0004, s));
        return Promise.resolve(mkBars(-0.004, s));
      }),
    };

    const policy = new ResidualVolbetaEdgePolicy({
      feedHealth: feed,
      symbols: [
        'BTC/USDT:USDT',
        'ETH/USDT:USDT',
        'SOL/USDT:USDT',
        'XRP/USDT:USDT',
        'ZEC/USDT:USDT',
      ],
      now: () => epochMs(START + 100 * DAY),
      pinState: pin,
      logger: { warn: () => undefined, log: () => undefined },
    });
    await policy.refresh();
    const eth = policy.snapshot({
      symbol: symbolId('ETH/USDT:USDT'),
      eventTime: epochMs(START + 100 * DAY),
    });
    expect(eth.active).toBe(true);
    if (eth.active) {
      expect(eth.familyId).toBe('residual20-volbeta');
      expect(eth.maxSizeFraction).toBe('0.10');
      expect(eth.cohort.members.length).toBe(4);
      expect(pin.symbols().length).toBe(4);
    }
  });
});
