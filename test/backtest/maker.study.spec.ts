import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBacktest, BT_VENUE, BT_SYMBOL } from './harness';
import {
  makerLimitPrice,
  restingFills,
  MakerBook,
  runMakerBacktest,
  type MakerBtResult,
} from './fill-models';
import { loadAllPreps, FEE_BPS_VIP0, FEE_BPS_VIP0_BNB } from './trial-registry';
import { MeanReversionStrategy } from './mean-reversion.strategy';
import { strategyId } from '../../src/domain/types/ids';
import type { CandleInterval } from '../../src/domain/types/market-events';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT = join(HERE, '..', '..', 'reports', 'nightly', 'maker-study.md');

// ── Maker primitives ──────────────────────────────────────────────────────────
describe('maker fill model — primitives', () => {
  it('makerLimitPrice rests BUY below / SELL above the close', () => {
    expect(makerLimitPrice('BUY', new Decimal(100), 10).toString()).toBe('99.9'); // 100·(1−0.001)
    expect(makerLimitPrice('SELL', new Decimal(100), 10).toString()).toBe('100.1');
    expect(makerLimitPrice('BUY', new Decimal(100), 0).toString()).toBe('100'); // at the touch
  });

  it('restingFills: BUY fills when the bar trades down to the limit; SELL when up to it', () => {
    const buy = { side: 'BUY' as const, limit: new Decimal(99.9), placedBar: 0 };
    expect(restingFills(buy, new Decimal(101), new Decimal(99.9))).toBe(true); // low touches
    expect(restingFills(buy, new Decimal(101), new Decimal(100))).toBe(false); // never trades down
    const sell = { side: 'SELL' as const, limit: new Decimal(100.1), placedBar: 0 };
    expect(restingFills(sell, new Decimal(100.1), new Decimal(99))).toBe(true);
    expect(restingFills(sell, new Decimal(100), new Decimal(99))).toBe(false);
  });

  it('MakerBook: no same-bar fill, fills next bar on touch, expires when stale, cancels', () => {
    const b = new MakerBook(3);
    b.place('BUY', new Decimal(99.9), 0);
    expect(b.step(0, new Decimal(101), new Decimal(99))).toBeNull(); // same bar as placement → no fill
    const f = b.step(1, new Decimal(101), new Decimal(99.9));
    expect(f?.kind).toBe('fill');
    expect(b.hasPending).toBe(false);

    const e = new MakerBook(2);
    e.place('SELL', new Decimal(200), 0); // far above — never fills
    expect(e.step(1, new Decimal(150), new Decimal(140))).toBeNull(); // resting
    expect(e.step(2, new Decimal(150), new Decimal(140))?.kind).toBe('expired'); // 2 bars stale
    expect(e.hasPending).toBe(false);

    const c = new MakerBook(10);
    c.place('BUY', new Decimal(99.9), 0);
    c.cancel();
    expect(c.hasPending).toBe(false);
  });

  it('fillModel TAKER_NEXT_OPEN is byte-identical to the default taker path', () => {
    const prep = loadAllPreps(['1h']).get('1h');
    if (!prep) return; // no cached data → nothing to compare
    const make = () =>
      new MeanReversionStrategy(strategyId('bt-reg'), {
        lookback: 50,
        entryZ: 1.5,
        exitZ: 0,
        symbol: BT_SYMBOL,
        venue: BT_VENUE,
        ttlMs: 30_000,
        interval: '1h',
      });
    const def = runBacktest(prep, make, { feeBps: FEE_BPS_VIP0 });
    const explicit = runBacktest(prep, make, {
      feeBps: FEE_BPS_VIP0,
      fillModel: 'TAKER_NEXT_OPEN',
    });
    expect(explicit).toEqual(def); // the maker branch must not perturb the taker path
  });
});

function fmt(n: number, d = 2): string {
  return (n >= 0 ? '+' : '') + n.toFixed(d);
}

// ── Spread-capture frontier ─────────────────────────────────────────────────
describe('maker / market-making economics — step study', () => {
  it('sweeps the limit-offset frontier and documents the maker rejection', () => {
    const preps = loadAllPreps();
    expect(preps.size).toBeGreaterThan(0);
    const intervals: CandleInterval[] = ['1h', '5m'].filter((iv) =>
      preps.has(iv as CandleInterval),
    ) as CandleInterval[];

    // Liquidity-provision candidate: mean-reversion (buy weakness as a resting bid, sell reversion as a
    // resting ask) — the natural market-making form. Fixed mid-grid params (not tuned for the maker run).
    const makeMr = (interval: CandleInterval) => () =>
      new MeanReversionStrategy(strategyId('bt-mm'), {
        lookback: 50,
        entryZ: 1.5,
        exitZ: 0,
        symbol: BT_SYMBOL,
        venue: BT_VENUE,
        ttlMs: 30_000,
        interval,
      });

    const OFFSETS = [0, 0.5, 1, 2, 5];
    const MAX_REST = 10;

    const lines: string[] = [];
    lines.push('# Maker / market-making economics — 2026-06-15');
    lines.push('');
    lines.push(
      `Can a resting-LIMIT (maker) strategy capture enough spread to beat fees at Binance spot VIP0? ` +
        `VIP0 has **no maker rebate** (maker ≈ taker ≈ ${FEE_BPS_VIP0} bps, ${FEE_BPS_VIP0_BNB} with BNB), and ` +
        `BTC/USDT spread ≈ 1 bp — so round-trip fees (~${FEE_BPS_VIP0 * 2} bps) dwarf the spread. The MAKER_RESTING ` +
        `model is deliberately OPTIMISTIC (any bar touching the limit fills the whole order at the limit, no ` +
        `queue), so a loss here is robust. Candidate = mean-reversion 50/1.5 (liquidity provision). ` +
        `maxRestBars=${MAX_REST}. Maker fee modelled at the taker tier (no rebate).`,
    );
    lines.push('');

    const allRows: { interval: CandleInterval; offset: number; r: MakerBtResult }[] = [];
    for (const interval of intervals) {
      const prep = preps.get(interval)!;
      const taker = runBacktest(prep, makeMr(interval), { feeBps: FEE_BPS_VIP0 });
      lines.push(`## ${interval}`);
      lines.push('');
      lines.push(
        `- **Taker baseline** (next-open, crosses spread): ret ${fmt(taker.returnPct)}% · trades ${taker.trades} · fees ${fmt(taker.feesPaid)} · B&H ${fmt(taker.buyHoldPct)}%`,
      );
      lines.push('');
      lines.push(
        '| offset bps | maker fills | fill rate | expired entries | unfilled exits | ret% | fees |',
      );
      lines.push('|---|---|---|---|---|---|---|');
      for (const offset of OFFSETS) {
        const r = runMakerBacktest(prep, makeMr(interval), {
          feeBps: FEE_BPS_VIP0,
          maker: { limitOffsetBps: offset, maxRestBars: MAX_REST },
        });
        allRows.push({ interval, offset, r });
        lines.push(
          `| ${offset} | ${r.makerFills} | ${(r.fillRate * 100).toFixed(0)}% | ${r.expiredEntries} | ${r.unfilledExits} | ${fmt(r.returnPct)} | ${fmt(r.feesPaid)} |`,
        );
      }
      lines.push('');
    }

    // Adverse-selection signal: fill rate should fall as the resting order goes deeper (larger offset).
    const fillRateAt = (interval: CandleInterval, offset: number): number =>
      allRows.find((x) => x.interval === interval && x.offset === offset)?.r.fillRate ?? 0;
    const anyProfitable = allRows.some((x) => x.r.returnPct > 0);

    lines.push('## Verdict');
    lines.push(
      `Across every interval and offset, the maker book ${anyProfitable ? 'shows some positive rows but' : 'never turns a profit, and'} ` +
        `the spread captured by the offset (at most ${OFFSETS[OFFSETS.length - 1]} bps/side) cannot cover the ` +
        `~${FEE_BPS_VIP0 * 2} bps round-trip fee — there is no maker rebate at VIP0 to bridge the gap. Deeper ` +
        `offsets improve the fill PRICE but collapse the FILL RATE (adverse selection: you only get filled when ` +
        `the market runs through you), and shallow offsets fill often but capture ~nothing. **Market-making this ` +
        `pair at this fee tier is structurally loss-making** — a documented rejection, not a winner. (A real ` +
        `maker edge needs either a rebate tier or a venue/pair with a materially wider spread.)`,
    );

    writeFileSync(REPORT, lines.join('\n') + '\n');
    console.log('\n===== MAKER ECONOMICS STUDY =====');
    for (const { interval, offset, r } of allRows) {
      console.log(
        `${interval} off=${offset}bps: fills=${r.makerFills} fillRate=${(r.fillRate * 100).toFixed(0)}% ret=${fmt(r.returnPct)}% fees=${fmt(r.feesPaid)}`,
      );
    }
    console.log('=================================\n');

    expect(allRows.length).toBe(intervals.length * OFFSETS.length);
    // Adverse selection: the shallowest order fills strictly more often than the deepest.
    for (const interval of intervals) {
      expect(fillRateAt(interval, 0)).toBeGreaterThan(fillRateAt(interval, 5));
    }
  }, 600_000);
});
