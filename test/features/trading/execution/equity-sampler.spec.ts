import { describe, it, expect } from 'vitest';
import { EquitySamplerService } from '../../../../src/features/trading/execution/equity-sampler.service';
import { PortfolioStateService } from '../../../../src/features/trading/execution/portfolio-state.service';
import { FeeLedgerService } from '../../../../src/features/trading/execution/fee-ledger.service';
import { InMemoryExecutionStore } from '../../../../src/features/trading/execution/in-memory-store';
import { makeIntent, makeFill, fixedClock, fixedFeed, T } from './helpers';
import { price, qty } from '../../../../src/domain/common/types/money';
import { epochMs, symbolId } from '../../../../src/domain/common/types/ids';
import type { FeedHealthPort } from '../../../../src/ports/venue/market-data';

function make(feedMid = '110', refPresent = true) {
  const ps = new PortfolioStateService(
    { quoteAsset: 'USDT', startingCash: '100000' },
    new FeeLedgerService(),
  );
  const store = new InMemoryExecutionStore();
  const sampler = new EquitySamplerService(ps, fixedFeed(feedMid, refPresent), fixedClock(), store);
  return { ps, store, sampler };
}

describe('EquitySamplerService', () => {
  it('samples a flat book as cash with zero unrealized and persists it', async () => {
    const { store, sampler } = make();
    const s = await sampler.sample();
    expect(s.equity).toBe('100000');
    expect(s.unrealized).toBe('0');
    expect(s.cash).toBe('100000');
    expect(s.sessionDateUtc).toBe('2023-11-14');
    expect(store.equity).toHaveLength(1);
  });

  it('marks a long to market and ratchets peak equity', async () => {
    const { ps, sampler } = make('110');
    ps.applyFill(makeIntent({ side: 'BUY' }), makeFill({ qty: qty('1'), price: price('100') }));
    const s = await sampler.sample();
    expect(s.equity).toBe('100010'); // 99900 cash + 1 × 110 mark
    expect(s.unrealized).toBe('10'); // 1 × (110 − 100)
    expect(s.peak).toBe('100010');
    expect(ps.snapshot().peakEquity.toFixed()).toBe('100010');
  });

  it('values a position at average entry when no live mark exists (no fabricated PnL)', async () => {
    const { ps, sampler } = make('110', false); // feed returns no ref price
    ps.applyFill(makeIntent({ side: 'BUY' }), makeFill({ qty: qty('1'), price: price('100') }));
    const s = await sampler.sample();
    expect(s.equity).toBe('100000'); // 99900 + 1 × 100 entry
    expect(s.unrealized).toBe('0');
  });

  // The entry-price valuation above is correct and deliberately unchanged, but its zero unrealized
  // is indistinguishable from a genuinely flat position once it reaches the C1/C2 breakers and the
  // sizer's equity — so the sample carries the provenance. equity_curve.gap_annotation has existed
  // since 0000_v3_initial.sql and had no writer at all until this.
  describe('MARK_FALLBACK provenance (gap_annotation)', () => {
    it('names the unmarkable symbol and leaves the valuation byte-identical', async () => {
      const { ps, store, sampler } = make('110', false);
      ps.applyFill(makeIntent({ side: 'BUY' }), makeFill({ qty: qty('1'), price: price('100') }));
      const s = await sampler.sample();
      expect(s.gapAnnotation).toBe('MARK_FALLBACK:BTC/USDT');
      expect(store.equity[0]?.gapAnnotation).toBe('MARK_FALLBACK:BTC/USDT'); // persisted, not just returned
      // The numbers the C1/C2 monitors read are exactly what the un-annotated path produced.
      expect(s.equity).toBe('100000');
      expect(s.unrealized).toBe('0');
    });

    it('is absent when every position has a live mark', async () => {
      const { ps, sampler } = make('110');
      ps.applyFill(makeIntent({ side: 'BUY' }), makeFill({ qty: qty('1'), price: price('100') }));
      const s = await sampler.sample();
      expect(s.gapAnnotation).toBeUndefined();
    });

    it('is absent on a flat book (no position can be unmarkable)', async () => {
      const { sampler } = make('110', false);
      expect((await sampler.sample()).gapAnnotation).toBeUndefined();
    });

    it('names only the unmarked symbols, sorted, when the book is mixed', async () => {
      const marked = symbolId('ETH/USDT');
      const ps = new PortfolioStateService(
        { quoteAsset: 'USDT', startingCash: '100000' },
        new FeeLedgerService(),
      );
      const store = new InMemoryExecutionStore();
      // Per-symbol feed: only ETH/USDT has a mark, so BTC/USDT and SOL/USDT fall back to entry.
      const feed: FeedHealthPort = {
        getRefPrice: (symbol) =>
          symbol === marked ? { mid: price('110'), at: epochMs(T) } : undefined,
        updateRefPrice: () => undefined,
        health: () => 'LIVE',
        fetchCandles: () => Promise.resolve([]),
      };
      const sampler = new EquitySamplerService(ps, feed, fixedClock(), store);
      for (const symbol of [symbolId('SOL/USDT'), marked, symbolId('BTC/USDT')]) {
        ps.applyFill(
          makeIntent({ side: 'BUY', symbol }),
          makeFill({ symbol, qty: qty('1'), price: price('100') }),
        );
      }
      // Sorted, so the annotation is a function of WHICH symbols were unmarkable, not of iteration order.
      expect((await sampler.sample()).gapAnnotation).toBe('MARK_FALLBACK:BTC/USDT,SOL/USDT');
    });
  });
});
