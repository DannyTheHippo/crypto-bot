import { describe, it, expect } from 'vitest';
import { EquitySamplerService } from '../../../src/modules/execution/equity-sampler.service';
import { PortfolioStateService } from '../../../src/modules/execution/portfolio-state.service';
import { FeeLedgerService } from '../../../src/modules/execution/fee-ledger.service';
import { InMemoryExecutionStore } from '../../../src/modules/execution/in-memory-store';
import { makeIntent, makeFill, fixedClock, fixedFeed } from './helpers';
import { price, qty } from '../../../src/domain/types/money';

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
});
