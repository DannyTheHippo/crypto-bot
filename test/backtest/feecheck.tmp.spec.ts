import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Decimal from 'decimal.js';
import { prepare, runBacktest, type Bar } from './harness';
import { EmaCrossStrategy } from '../../src/domain/strategy/ema-cross.strategy';
import { applyFillToPosition, FLAT, type PositionState } from '../../src/domain/oms/position';
import { setupDecimal, price, roundToStep } from '../../src/domain/types/money';
import { strategyId, venueId, symbolId } from '../../src/domain/types/ids';
import type { MarketView } from '../../src/domain/strategy/strategy';
import type { CandleInterval } from '../../src/domain/types/market-events';

setupDecimal();
const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');

describe('FEE LENS — fill-count / no-short / flat-skip integrity on real data', () => {
  it('replays harness logic and asserts fee is charged on exactly each executed fill, never short, never on flat-exit', () => {
    const interval: CandleInterval = '1h';
    const file = join(DATA, `BTCUSDT-${interval}.json`);
    if (!existsSync(file)) { console.log('no data'); return; }
    const bars = JSON.parse(readFileSync(file, 'utf8')) as Bar[];
    const prep = prepare(bars, interval);

    const V = venueId('binance'); const SYM = symbolId('BTC/USDT');
    const STUB = {} as MarketView;
    const strat = new EmaCrossStrategy(strategyId('bt'), { fast: 9, slow: 21, symbol: SYM, venue: V, ttlMs: 30000, interval });
    strat.onInit({ params: {}, warmupCandles: new Map(), symbolConstraints: new Map() });

    const baseNotional = new Decimal(1000);
    const feeRate = new Decimal(10).div(10000);
    let pos: PositionState = FLAT;
    let manualFeeFills = 0;
    let manualFees = new Decimal(0);
    let everShort = false;
    let signalsSeen = 0;
    let buyFills = 0, sellFills = 0;
    let skippedExitNoPos = 0;

    const { events, opens } = prep;
    for (let i = 0; i < events.length; i++) {
      const sigs = strat.onCandle(events[i], STUB);
      for (const s of sigs) {
        signalsSeen++;
        const fillPrice = opens[i + 1];
        if (fillPrice === undefined) continue;
        const side: 'BUY' | 'SELL' = s.kind === 'ENTER_LONG' ? 'BUY' : 'SELL';
        const rawQty = side === 'BUY' ? baseNotional.div(fillPrice) : pos.signedQty.abs();
        const q = roundToStep(rawQty, '0.00001', 'down');
        if (q.lte(0)) { if (side === 'SELL') skippedExitNoPos++; continue; }
        if (q.lt(new Decimal('0.00001')) || q.mul(fillPrice).lt(new Decimal('5'))) continue;
        const feeQuote = fillPrice.mul(q).mul(feeRate);
        manualFees = manualFees.add(feeQuote);
        manualFeeFills++;
        if (side === 'BUY') buyFills++; else sellFills++;
        pos = applyFillToPosition(pos, side, q, fillPrice, feeQuote);
        if (pos.signedQty.lt(0)) everShort = true;
      }
    }
    const r10 = runBacktest(prep, { fast: 9, slow: 21, interval }, { feeBps: 10 });
    console.log(`INTEGRITY signals=${signalsSeen} feeFills=${manualFeeFills} buy=${buyFills} sell=${sellFills} skippedFlatExit=${skippedExitNoPos} everShort=${everShort}`);
    console.log(`INTEGRITY manualFees=${manualFees.toFixed(8)} harnessFees=${r10.feesPaid.toFixed(8)} harnessFills=${r10.fills}`);
    expect(everShort).toBe(false);                       // EMA-cross never opens a short; no flip path
    expect(manualFeeFills).toBe(r10.fills);              // fee charged once per executed fill
    expect(manualFees.toNumber()).toBeCloseTo(r10.feesPaid, 6);
    expect(buyFills).toBe(sellFills + (pos.signedQty.gt(0) ? 1 : 0)); // alternating; at most 1 open buy unmatched
  });
});
