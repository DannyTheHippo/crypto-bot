import { describe, it, expect, vi } from 'vitest';
import {
  UniverseScannerService,
  deriveScanMetrics,
  type ScanMetrics,
} from '../../../../src/features/strategy/agentic/universe-scanner.service';
import type { CandleEvent } from '../../../../src/domain/venue/types/market-events';
import { price, qty } from '../../../../src/domain/common/types/money';
import { venueId, symbolId, epochMs } from '../../../../src/domain/common/types/ids';

const T = 1_700_000_000_000; // arbitrary fixed instant, well inside a UTC calendar day
const DAY_MS = 24 * 60 * 60 * 1000;
const V = venueId('binance');

function candle(opts: {
  index: number;
  close: string;
  high?: string;
  low?: string;
  volume?: string;
}): CandleEvent {
  const t = T + opts.index * 900_000; // 15m bars
  return {
    kind: 'CANDLE',
    venue: V,
    symbol: symbolId('BTC/USDT'),
    channel: 'candle:15m',
    seq: BigInt(opts.index + 1),
    eventTime: epochMs(t),
    ingestTime: epochMs(t + 1),
    interval: '15m',
    openTime: epochMs(t),
    closeTime: epochMs(t + 900_000),
    open: price(opts.close),
    high: price(opts.high ?? opts.close),
    low: price(opts.low ?? opts.close),
    close: price(opts.close),
    volume: qty(opts.volume ?? '1'),
    closed: true,
  };
}

// Metrics whose volume rank and ATR rank both equal `rank` exactly (strictly decreasing in rank,
// no ties) — lets every ranking/hysteresis test assert an exact expected combined score (rank^2)
// without depending on tie-break behavior.
function rankedMetrics(rank: number): ScanMetrics {
  return { quoteVolume24h: 1000 - rank, atrPct: 0.1 - rank * 0.0001 };
}

describe('deriveScanMetrics', () => {
  it('returns null while warmup is short of ATR_PERIOD+1 (14+1=15) bars', () => {
    const candles = Array.from({ length: 14 }, (_, i) => candle({ index: i, close: '100' }));
    expect(deriveScanMetrics(candles)).toBeNull();
  });

  it('derives quoteVolume24h as the sum of close*volume over the last 96 bars, and atrPct=0 on flat candles', () => {
    // 100 flat 15m bars (> the 96-bar quote-volume window and the 15-bar ATR warmup), constant
    // close=100 volume=2 => every bar contributes 200 quote volume; flat high=low=close => ATR=0.
    const candles = Array.from({ length: 100 }, (_, i) =>
      candle({ index: i, close: '100', volume: '2' }),
    );
    const metrics = deriveScanMetrics(candles);
    expect(metrics).not.toBeNull();
    expect(metrics!.atrPct).toBe(0);
    // Window is the last 96 bars only (not all 100) — an exact value (100*2 per bar, no rounding
    // involved), so this is exact equality, not toBeCloseTo (banned for money-shaped assertions;
    // this figure is a reference-grade ranking number, but the exact-value convention still applies
    // cleanly here since the fixture produces no floating-point remainder).
    expect(metrics!.quoteVolume24h).toBe(96 * 100 * 2);
  });

  it('derives a positive atrPct from true-range volatility', () => {
    const candles = Array.from({ length: 20 }, (_, i) =>
      candle({ index: i, close: '100', high: '105', low: '95' }),
    );
    const metrics = deriveScanMetrics(candles);
    expect(metrics).not.toBeNull();
    expect(metrics!.atrPct).toBeGreaterThan(0);
  });
});

describe('UniverseScannerService', () => {
  it('ranking determinism: fixed fixture volumes/ATRs produce the exact expected menu (score = volumeRank * atrRank, lower is better)', () => {
    const basket = ['A/USDT', 'B/USDT', 'C/USDT', 'D/USDT'];
    const scanner = new UniverseScannerService({ basket, menuSize: 2 });

    // Volume order (descending): A(400) B(300) C(200) D(100) -> volumeRank A1 B2 C3 D4.
    // ATR order (descending):    D(.04) C(.03) B(.02) A(.01) -> atrRank    A4 B3 C2 D1.
    // score = volumeRank * atrRank: A=1*4=4, B=2*3=6, C=3*2=6, D=4*1=4.
    scanner.recordMetrics('A/USDT', { quoteVolume24h: 400, atrPct: 0.01 });
    scanner.recordMetrics('B/USDT', { quoteVolume24h: 300, atrPct: 0.02 });
    scanner.recordMetrics('C/USDT', { quoteVolume24h: 200, atrPct: 0.03 });
    scanner.recordMetrics('D/USDT', { quoteVolume24h: 100, atrPct: 0.04 });
    scanner.recompute(T);

    const ranking = scanner.ranking();
    const byScore = [...ranking].sort(
      (a, b) => a.score - b.score || a.symbol.localeCompare(b.symbol),
    );
    // A and D both score 4 (alphabetical tie-break ahead of the score-6 pair); B and C both score 6.
    expect(byScore.map((r) => r.symbol)).toEqual(['A/USDT', 'D/USDT', 'B/USDT', 'C/USDT']);
    expect(byScore.map((r) => r.score)).toEqual([4, 4, 6, 6]);

    // menuSize=2 -> the top 2 by combined rank are active: A/USDT and D/USDT (both score 4).
    expect([...scanner.activeMenu()].sort()).toEqual(['A/USDT', 'D/USDT']);
    expect(scanner.isActive('A/USDT')).toBe(true);
    expect(scanner.isActive('D/USDT')).toBe(true);
    expect(scanner.isActive('B/USDT')).toBe(false);
    expect(scanner.isActive('C/USDT')).toBe(false);
  });

  it('W1: recompute() reports the fresh active menu and menu churn via the optional metrics hook', () => {
    const setActiveMenu = vi.fn<(symbols: readonly string[]) => void>();
    const recordMenuChurn = vi.fn<(menuIn: number, menuOut: number) => void>();
    const basket = ['A/USDT', 'B/USDT', 'C/USDT'];
    const scanner = new UniverseScannerService({
      basket,
      menuSize: 2,
      metrics: { setActiveMenu, recordMenuChurn },
    });
    scanner.recordMetrics('A/USDT', rankedMetrics(1));
    scanner.recordMetrics('B/USDT', rankedMetrics(2));
    scanner.recordMetrics('C/USDT', rankedMetrics(3));
    scanner.recompute(T); // boot: previousActive is empty, so A/B "enter" (menuIn=2, menuOut=0)

    expect(setActiveMenu).toHaveBeenCalledTimes(1);
    expect([...setActiveMenu.mock.calls[0]![0]].sort()).toEqual(['A/USDT', 'B/USDT']);
    expect(recordMenuChurn).toHaveBeenCalledWith(2, 0);

    // Day 2: C swaps ahead of B -> B rotates out (below hysteresisRank default 12? no — basket is
    // only 3 symbols, so B falls to rank 3, still within the default hysteresis(12) band and stays
    // active via hysteresis; C is freshly promoted). menuIn=[C], menuOut=[] (B retained, not out).
    scanner.recordMetrics('B/USDT', rankedMetrics(3));
    scanner.recordMetrics('C/USDT', rankedMetrics(2));
    scanner.recompute(T + DAY_MS);
    expect(recordMenuChurn).toHaveBeenCalledWith(1, 0);
  });

  it('a scanner with no metrics hook configured never calls anything (NOOP default)', () => {
    const scanner = new UniverseScannerService({ basket: ['A/USDT'], menuSize: 1 });
    scanner.recordMetrics('A/USDT', rankedMetrics(1));
    expect(() => scanner.recompute(T)).not.toThrow();
  });

  it('hysteresis: a rank-13 incumbent stays active (within the rank-18 band); a rank-19 incumbent rotates out', () => {
    const basket = Array.from({ length: 20 }, (_, i) => `S${String(i + 1).padStart(2, '0')}/USDT`);
    // Explicit hysteresisRank: 18 decouples this scenario (testing the general hysteresis mechanic)
    // from the v3 default value — see the dedicated "hysteresis default is 12" test below.
    const scanner = new UniverseScannerService({ basket, menuSize: 12, hysteresisRank: 18 });

    // Day 1 (boot): symbol Si ranks exactly i on both axes -> active menu = S01..S12.
    basket.forEach((symbol, i) => scanner.recordMetrics(symbol, rankedMetrics(i + 1)));
    scanner.recompute(T);
    expect([...scanner.activeMenu()].sort()).toEqual(
      basket.slice(0, 12).sort((a, b) => a.localeCompare(b)),
    );

    // Day 2: S12 (previously active, was rank 12) and S13 (previously inactive, was rank 13) swap
    // ranks — S12 now ranks 13th, S13 now ranks 12th. S06 (previously active, rank 6) and S19
    // (previously inactive, rank 19) swap the other direction — S06 now ranks 19th (below the
    // hysteresis band), S19 now ranks 6th.
    const day2 = T + DAY_MS;
    const rankOf = new Map<string, number>(basket.map((s, i) => [s, i + 1]));
    rankOf.set('S12/USDT', 13);
    rankOf.set('S13/USDT', 12);
    rankOf.set('S06/USDT', 19);
    rankOf.set('S19/USDT', 6);
    for (const [symbol, rank] of rankOf) {
      scanner.recordMetrics(symbol, rankedMetrics(rank));
    }
    scanner.recompute(day2);

    const ranking = scanner.ranking();
    const rankOfSymbol = (s: string): number => ranking.find((r) => r.symbol === s)!.rank;
    expect(rankOfSymbol('S12/USDT')).toBe(13);
    expect(rankOfSymbol('S06/USDT')).toBe(19);

    // Hysteresis retains the rank-13 incumbent (S12 stays active despite falling out of the fresh
    // top 12) but drops the rank-19 incumbent (S06 falls below the rank-18 band).
    expect(scanner.isActive('S12/USDT')).toBe(true);
    expect(scanner.isActive('S06/USDT')).toBe(false);
    // The fresh top-12 promotions (S13 at rank 12, S19 at rank 6) are active.
    expect(scanner.isActive('S13/USDT')).toBe(true);
    expect(scanner.isActive('S19/USDT')).toBe(true);
  });

  it('v3 §5.3: the hysteresis default is 12 (not v2 18) — a rank-12 incumbent stays active, a rank-13 incumbent rotates out', () => {
    const basket = Array.from({ length: 20 }, (_, i) => `S${String(i + 1).padStart(2, '0')}/USDT`);
    const scanner = new UniverseScannerService({ basket, menuSize: 8 });

    // Boot: S01..S08 active.
    basket.forEach((symbol, i) => scanner.recordMetrics(symbol, rankedMetrics(i + 1)));
    scanner.recompute(T);
    expect([...scanner.activeMenu()].sort()).toEqual(basket.slice(0, 8).sort());

    // Day 2: S08 (incumbent, was rank 8) and S12 swap into rank 12; S02 (incumbent) and S13 swap
    // into rank 13.
    const rankOf = new Map<string, number>(basket.map((s, i) => [s, i + 1]));
    rankOf.set('S08/USDT', 12);
    rankOf.set('S12/USDT', 8);
    rankOf.set('S02/USDT', 13);
    rankOf.set('S13/USDT', 2);
    for (const [symbol, rank] of rankOf) {
      scanner.recordMetrics(symbol, rankedMetrics(rank));
    }
    scanner.recompute(T + DAY_MS);

    expect(scanner.isActive('S08/USDT')).toBe(true); // rank 12 <= default hysteresis 12: retained
    expect(scanner.isActive('S02/USDT')).toBe(false); // rank 13 > default hysteresis 12: rotates out
  });

  it("v3 §5.3 venue floor: promotes the perp venue's best-ranked non-active symbol when fewer than 2 perp symbols made the active set (fail OPEN toward coverage)", () => {
    // 6 spot + 3 perp; menuSize=4 ranks every spot symbol ahead of every perp symbol, so the fresh
    // top-4 (and the whole active set, before the floor) would otherwise hold zero perp symbols.
    const spot = [
      'SPOT1/USDT',
      'SPOT2/USDT',
      'SPOT3/USDT',
      'SPOT4/USDT',
      'SPOT5/USDT',
      'SPOT6/USDT',
    ];
    const perp = ['PERP1/USDT:USDT', 'PERP2/USDT:USDT', 'PERP3/USDT:USDT'];
    const basket = [...spot, ...perp];
    const scanner = new UniverseScannerService({ basket, menuSize: 4, hysteresisRank: 0 });

    spot.forEach((s, i) => scanner.recordMetrics(s, rankedMetrics(i + 1)));
    perp.forEach((s, i) => scanner.recordMetrics(s, rankedMetrics(spot.length + i + 1)));
    scanner.recompute(T);

    // The fresh top-4 is all-spot; the venue floor promotes the two best-ranked perp symbols
    // (PERP1, PERP2) on top of it — menu transiently exceeds menuSize by 2, same overflow class as
    // pin/hysteresis, never evicting a spot symbol the ranking already selected.
    expect([...scanner.activeMenu()].sort()).toEqual(
      [
        'SPOT1/USDT',
        'SPOT2/USDT',
        'SPOT3/USDT',
        'SPOT4/USDT',
        'PERP1/USDT:USDT',
        'PERP2/USDT:USDT',
      ].sort(),
    );
    expect(scanner.isActive('PERP3/USDT:USDT')).toBe(false);
  });

  it('v3 §5.3 venue floor: a no-op when the basket has fewer than 2 perp symbols total (floor is unattainable, never throws)', () => {
    const basket = ['SPOT1/USDT', 'SPOT2/USDT', 'SPOT3/USDT', 'PERP1/USDT:USDT'];
    const scanner = new UniverseScannerService({ basket, menuSize: 1 });
    basket.forEach((s, i) => scanner.recordMetrics(s, rankedMetrics(i + 1)));
    expect(() => scanner.recompute(T)).not.toThrow();
    // Only one perp symbol exists in the whole basket — the floor cannot reach 2, so it promotes
    // that lone perp symbol (the only available candidate) and stops there.
    expect(scanner.isActive('PERP1/USDT:USDT')).toBe(true);
  });

  it('positioned/resting-order pinning: a symbol at the worst rank stays active when isPinned returns true, overriding both the menu size and the hysteresis band', () => {
    const basket = ['P/USDT', 'Q/USDT', 'R/USDT'];
    const scanner = new UniverseScannerService({
      basket,
      menuSize: 1,
      hysteresisRank: 1,
      isPinned: (symbol) => symbol === 'R/USDT',
    });
    scanner.recordMetrics('P/USDT', rankedMetrics(1));
    scanner.recordMetrics('Q/USDT', rankedMetrics(2));
    scanner.recordMetrics('R/USDT', rankedMetrics(3)); // worst rank, would never qualify otherwise
    scanner.recompute(T);

    expect(scanner.isActive('P/USDT')).toBe(true); // top menuSize=1
    expect(scanner.isActive('Q/USDT')).toBe(false); // outside menuSize and outside hysteresisRank=1
    expect(scanner.isActive('R/USDT')).toBe(true); // pinned overrides everything
  });

  it('a caller absent from isPinned (default) never pins anything — no-pins is the safe default', () => {
    const scanner = new UniverseScannerService({ basket: ['A/USDT', 'B/USDT'], menuSize: 1 });
    scanner.recordMetrics('A/USDT', rankedMetrics(1));
    scanner.recordMetrics('B/USDT', rankedMetrics(2));
    scanner.recompute(T);
    expect(scanner.isActive('B/USDT')).toBe(false);
  });

  it('menu size clamps to basket size when configured larger than the basket', () => {
    const basket = ['A/USDT', 'B/USDT', 'C/USDT'];
    const scanner = new UniverseScannerService({ basket, menuSize: 10 });
    basket.forEach((s, i) => scanner.recordMetrics(s, rankedMetrics(i + 1)));
    scanner.recompute(T);
    expect([...scanner.activeMenu()].sort()).toEqual([...basket].sort());
  });

  it('before any recompute, every basket symbol is active (safe default)', () => {
    const scanner = new UniverseScannerService({ basket: ['A/USDT', 'B/USDT'], menuSize: 1 });
    expect(scanner.isActive('A/USDT')).toBe(true);
    expect(scanner.isActive('B/USDT')).toBe(true);
    expect([...scanner.activeMenu()].sort()).toEqual(['A/USDT', 'B/USDT']);
  });

  it('recompute triggers: the first maybeRecompute always recomputes (boot), a same-UTC-day call does not, and the next UTC day does', () => {
    const log = vi.fn();
    const scanner = new UniverseScannerService({
      basket: ['A/USDT', 'B/USDT'],
      menuSize: 1,
      logger: { log },
    });
    scanner.recordMetrics('A/USDT', rankedMetrics(1));
    scanner.recordMetrics('B/USDT', rankedMetrics(2));

    scanner.maybeRecompute(T); // boot recompute
    expect(log).toHaveBeenCalledTimes(1);

    scanner.maybeRecompute(T + 60_000); // same day, no recompute
    expect(log).toHaveBeenCalledTimes(1);

    scanner.maybeRecompute(T + DAY_MS); // next UTC day, recomputes
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('maybeRecompute reports whether it actually recomputed', () => {
    const scanner = new UniverseScannerService({ basket: ['A/USDT'], menuSize: 1 });
    scanner.recordMetrics('A/USDT', rankedMetrics(1));
    expect(scanner.maybeRecompute(T)).toBe(true); // boot
    expect(scanner.maybeRecompute(T + 1_000)).toBe(false); // same day
    expect(scanner.maybeRecompute(T + DAY_MS)).toBe(true); // next day
  });

  it('recordCandles is a no-op while a symbol has not warmed up, so it can never win a menu slot on absent data', () => {
    const scanner = new UniverseScannerService({ basket: ['A/USDT', 'B/USDT'], menuSize: 1 });
    const shortHistory = Array.from({ length: 5 }, (_, i) => candle({ index: i, close: '100' }));
    scanner.recordCandles('A/USDT', shortHistory);
    scanner.recordMetrics('B/USDT', rankedMetrics(1));
    scanner.recompute(T);

    expect(scanner.isActive('B/USDT')).toBe(true);
    const aRank = scanner.ranking().find((r) => r.symbol === 'A/USDT');
    expect(aRank?.score).toBe(Number.POSITIVE_INFINITY);
    expect(aRank?.quoteVolume24h).toBeNull();
  });

  it('recordCandles feeds a warmed-up symbol into the ranking via the real candle-derivation path', () => {
    const scanner = new UniverseScannerService({ basket: ['A/USDT', 'B/USDT'], menuSize: 1 });
    const warmHistory = Array.from({ length: 20 }, (_, i) =>
      candle({ index: i, close: '100', high: '105', low: '95', volume: '10' }),
    );
    scanner.recordCandles('A/USDT', warmHistory);
    scanner.recordMetrics('B/USDT', rankedMetrics(1));
    scanner.recompute(T);

    const aRank = scanner.ranking().find((r) => r.symbol === 'A/USDT');
    expect(aRank?.quoteVolume24h).toBeGreaterThan(0);
    expect(aRank?.score).not.toBe(Number.POSITIVE_INFINITY);
  });

  it('quorum guard: recompute() with zero metrics recorded stays everything-active, does not stamp the day key (a same-day maybeRecompute keeps retrying), and logs universe_scan_skipped', () => {
    const log = vi.fn();
    const basket = ['A/USDT', 'B/USDT', 'C/USDT'];
    const scanner = new UniverseScannerService({ basket, menuSize: 2, logger: { log } });

    scanner.recompute(T); // zero metrics recorded -> below quorum (min(menuSize=2, basket=3)=2)
    expect(scanner.activeMenu()).toEqual(basket);
    expect(scanner.isActive('A/USDT')).toBe(true);
    expect(scanner.isActive('B/USDT')).toBe(true);
    expect(scanner.isActive('C/USDT')).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      event: 'universe_scan_skipped',
      reason: 'metrics_below_quorum',
      scored: 0,
      quorum: 2,
    });

    // Same UTC day, but no day key was ever stamped (the skip path leaves it untouched) -> a
    // same-day maybeRecompute keeps retrying instead of no-op'ing until tomorrow.
    expect(scanner.maybeRecompute(T + 500)).toBe(true);
    expect(log).toHaveBeenCalledTimes(2);
    expect(scanner.activeMenu()).toEqual(basket); // still the safe everything-active default

    // Quorum reached (2 of 3 scored) -> the same-day retry now performs a real recompute.
    scanner.recordMetrics('A/USDT', rankedMetrics(1));
    scanner.recordMetrics('B/USDT', rankedMetrics(2));
    expect(scanner.maybeRecompute(T + 1000)).toBe(true);
    expect(log).toHaveBeenCalledTimes(3);
    const thirdLog = JSON.parse(log.mock.calls[2]![0] as string) as { event: string };
    expect(thirdLog.event).toBe('universe_scan');
    expect(scanner.isActive('A/USDT')).toBe(true);
    expect(scanner.isActive('B/USDT')).toBe(true);
    expect(scanner.isActive('C/USDT')).toBe(false);
  });

  // Pass 44 (2026-07-28). The quorum guard only demands `menuSize` scored symbols before stamping
  // the UTC day, so the first scan of a boot freezes whatever partial warmup it saw until 00:00Z
  // the next day. Live: nine minutes after a redeploy the scan stamped the day with 11 of 40 scored
  // and locked ETH out of the menu — and out of the book/trades channel tier, which keys off
  // isActive() — for the rest of the day. Every redeploy re-armed it (the day key is in-memory).
  describe('partial-warmup correction', () => {
    // 10 symbols, menuSize 2: quorum is 2, so a 2-of-10 warmup stamps the day exactly as production
    // did. The 90% coverage bar is ceil(10 × 0.9) = 9.
    const basket = Array.from({ length: 10 }, (_, i) => `S${i}/USDT`);

    it('re-ranks once when the basket actually warms up, replacing the menu the partial scan chose', () => {
      const log = vi.fn();
      const scanner = new UniverseScannerService({ basket, menuSize: 2, logger: { log } });

      // Warmup step 1: only the two worst symbols in the eventual ranking have reported.
      scanner.recordMetrics('S8/USDT', rankedMetrics(9));
      scanner.recordMetrics('S9/USDT', rankedMetrics(10));
      expect(scanner.maybeRecompute(T)).toBe(true);
      expect([...scanner.activeMenu()].sort()).toEqual(['S8/USDT', 'S9/USDT']);

      // Coverage improves but is still short of the 9-symbol bar — the ranking stays frozen.
      for (const i of [0, 1, 2, 3, 4, 5]) scanner.recordMetrics(`S${i}/USDT`, rankedMetrics(i + 1));
      expect(scanner.maybeRecompute(T + 60_000)).toBe(false);
      expect([...scanner.activeMenu()].sort()).toEqual(['S8/USDT', 'S9/USDT']);

      // 9 of 10 scored: the correction fires and the genuinely top-ranked symbols take the menu.
      scanner.recordMetrics('S6/USDT', rankedMetrics(7));
      expect(scanner.maybeRecompute(T + 120_000)).toBe(true);
      expect([...scanner.activeMenu()].sort()).toEqual(['S0/USDT', 'S1/USDT']);
      expect(scanner.isActive('S8/USDT')).toBe(false);
    });

    it('keeps repairing until the applied ranking has seen the whole basket, then stops for the day', () => {
      const scanner = new UniverseScannerService({ basket, menuSize: 2 });
      scanner.recordMetrics('S8/USDT', rankedMetrics(9));
      scanner.recordMetrics('S9/USDT', rankedMetrics(10));
      scanner.maybeRecompute(T);
      for (const i of [0, 1, 2, 3, 4, 5, 6])
        scanner.recordMetrics(`S${i}/USDT`, rankedMetrics(i + 1));
      expect(scanner.maybeRecompute(T + 60_000)).toBe(true); // repair #1, at the 9-of-10 bar

      // The last symbol warms up after the bar was already crossed. Stopping at the first repair
      // would freeze it out until 00:00Z — the same lockout, just narrower. It ranks #1 here, so a
      // scanner that ignored it would be consulting a demonstrably worse menu all day.
      scanner.recordMetrics('S7/USDT', { quoteVolume24h: 10_000, atrPct: 0.9 });
      expect(scanner.maybeRecompute(T + 120_000)).toBe(true); // repair #2, at full coverage
      expect(scanner.isActive('S7/USDT')).toBe(true);

      // Applied ranking has now seen all 10 — nothing left to repair, so the loop goes quiet even
      // though maybeRecompute keeps being called every 15s.
      expect(scanner.maybeRecompute(T + 180_000)).toBe(false);
      expect(scanner.maybeRecompute(T + 240_000)).toBe(false);

      expect(scanner.maybeRecompute(T + DAY_MS)).toBe(true); // next UTC day: normal daily cadence
    });

    // Reviewer finding, 2026-07-28: the first version of this repair triggered on "coverage grew AND
    // is now >= the bar", which also fires on a day whose ranking was never partial — letting an
    // irrelevant symbol warming up at the bottom of the basket evict a top-ranked incumbent the v3
    // §5.3 hysteresis band exists to hold. The repair must only touch a ranking that was itself
    // stamped below the bar.
    it('never re-ranks a day that was stamped at full coverage, so the hysteresis band survives', () => {
      const scanner = new UniverseScannerService({ basket, menuSize: 2 });
      // Day 1: 9 of 10 scored — at the bar, so this stamp is NOT partial.
      for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8])
        scanner.recordMetrics(`S${i}/USDT`, rankedMetrics(i + 1));
      scanner.maybeRecompute(T);
      expect([...scanner.activeMenu()].sort()).toEqual(['S0/USDT', 'S1/USDT']);

      // Day 2: S1 slips to rank 3, S2 takes its place. Hysteresis retains S1 (rank 3 <= band 12).
      scanner.recordMetrics('S1/USDT', rankedMetrics(3));
      scanner.recordMetrics('S2/USDT', rankedMetrics(2));
      scanner.maybeRecompute(T + DAY_MS);
      expect(scanner.isActive('S1/USDT')).toBe(true);

      // Later that day the final symbol warms up and ranks LAST — no bearing on the menu at all.
      scanner.recordMetrics('S9/USDT', rankedMetrics(10));
      expect(scanner.maybeRecompute(T + DAY_MS + 60_000)).toBe(false);
      expect(scanner.isActive('S1/USDT')).toBe(true); // the incumbent is still held by the band
    });

    it('the correction does not carry incumbents over: hysteresis is a day-to-day anti-flap device, not a warmup artifact preserver', () => {
      const scanner = new UniverseScannerService({ basket, menuSize: 2 });
      scanner.recordMetrics('S8/USDT', rankedMetrics(9));
      scanner.recordMetrics('S9/USDT', rankedMetrics(10));
      scanner.maybeRecompute(T);

      // S8 lands at rank 9 under full coverage — inside the default rank-12 hysteresis band, so a
      // retaining re-rank would keep it and grow the consulted set past the menu the $3/day breaker
      // is sized for.
      for (const i of [0, 1, 2, 3, 4, 5, 6])
        scanner.recordMetrics(`S${i}/USDT`, rankedMetrics(i + 1));
      scanner.maybeRecompute(T + 60_000);

      const s8Rank = scanner.ranking().find((r) => r.symbol === 'S8/USDT')?.rank ?? 0;
      expect(s8Rank).toBeGreaterThan(2); // outside the fresh menu
      expect(s8Rank).toBeLessThanOrEqual(12); // but inside the band a retaining re-rank would honour
      expect(scanner.isActive('S8/USDT')).toBe(false);
      expect(scanner.activeMenu()).toHaveLength(2);
    });

    it('a symbol pinned by an open position survives the correction even though it is outside the fresh menu', () => {
      const scanner = new UniverseScannerService({
        basket,
        menuSize: 2,
        isPinned: (s) => s === 'S9/USDT',
      });
      scanner.recordMetrics('S8/USDT', rankedMetrics(9));
      scanner.recordMetrics('S9/USDT', rankedMetrics(10));
      scanner.maybeRecompute(T);
      for (const i of [0, 1, 2, 3, 4, 5, 6])
        scanner.recordMetrics(`S${i}/USDT`, rankedMetrics(i + 1));
      scanner.maybeRecompute(T + 60_000);

      expect(scanner.isActive('S9/USDT')).toBe(true); // pinned: a position never loses its consult
      expect(scanner.isActive('S8/USDT')).toBe(false); // merely an incumbent: rotates out
    });

    it('the scan journal states coverage outright and flags the corrective re-rank', () => {
      const log = vi.fn();
      const scanner = new UniverseScannerService({ basket, menuSize: 2, logger: { log } });
      scanner.recordMetrics('S8/USDT', rankedMetrics(9));
      scanner.recordMetrics('S9/USDT', rankedMetrics(10));
      scanner.maybeRecompute(T);
      const first = JSON.parse(log.mock.calls[0]![0] as string) as Record<string, unknown>;
      expect(first).toMatchObject({ scored: 2, basket: 10, corrective: false });

      for (const i of [0, 1, 2, 3, 4, 5, 6])
        scanner.recordMetrics(`S${i}/USDT`, rankedMetrics(i + 1));
      scanner.maybeRecompute(T + 60_000);
      const second = JSON.parse(log.mock.calls[1]![0] as string) as Record<string, unknown>;
      expect(second).toMatchObject({ scored: 9, basket: 10, corrective: true });
    });

    it('never fires when the basket cannot reach the coverage bar, leaving the pre-fix behaviour exactly as it was (fails toward the status quo, never worse)', () => {
      const scanner = new UniverseScannerService({ basket, menuSize: 2 });
      scanner.recordMetrics('S8/USDT', rankedMetrics(9));
      scanner.recordMetrics('S9/USDT', rankedMetrics(10));
      scanner.maybeRecompute(T);
      // 8 of 10 scored — one short of the bar, forever.
      for (const i of [0, 1, 2, 3, 4, 5]) scanner.recordMetrics(`S${i}/USDT`, rankedMetrics(i + 1));
      expect(scanner.maybeRecompute(T + 60_000)).toBe(false);
      expect([...scanner.activeMenu()].sort()).toEqual(['S8/USDT', 'S9/USDT']);
    });
  });

  it('quorum guard: partial metrics below quorum (1 of 2 required) skips the same way and logs the scored/quorum counts', () => {
    const log = vi.fn();
    const basket = ['A/USDT', 'B/USDT', 'C/USDT'];
    const scanner = new UniverseScannerService({ basket, menuSize: 2, logger: { log } });
    scanner.recordMetrics('A/USDT', rankedMetrics(1)); // 1 scored, quorum is 2

    scanner.recompute(T);

    expect(scanner.activeMenu()).toEqual(basket);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      event: 'universe_scan_skipped',
      reason: 'metrics_below_quorum',
      scored: 1,
      quorum: 2,
    });
  });
});
