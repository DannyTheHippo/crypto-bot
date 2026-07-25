import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { CrossSymbolContextService } from '../../../../src/features/strategy/agentic/cross-symbol-context';

const T0 = 1_000_000;
const STALE_MS = 90 * 60 * 1000; // the constructor default this suite exercises

describe('CrossSymbolContextService', () => {
  it('ranks the basket descending by trailing return (rank 1 = strongest)', () => {
    const svc = new CrossSymbolContextService();
    svc.record('BTC/USDT', new Decimal('0.05'), T0);
    svc.record('ETH/USDT', new Decimal('0.01'), T0);
    svc.record('XRP/USDT', new Decimal('-0.03'), T0);

    const eth = svc.rank('ETH/USDT', T0);

    expect(eth).toEqual({
      rank: 2,
      of: 3,
      ownReturnPct: '1',
      strongest: { symbol: 'BTC/USDT', returnPct: '5' },
      weakest: { symbol: 'XRP/USDT', returnPct: '-3' },
    });
  });

  it('returns null with fewer than two fresh symbols — a single symbol has no meaningful ranking', () => {
    const svc = new CrossSymbolContextService();
    svc.record('BTC/USDT', new Decimal('0.05'), T0);

    expect(svc.rank('BTC/USDT', T0)).toBeNull();
  });

  it('returns null when the asking symbol itself has no fresh entry', () => {
    const svc = new CrossSymbolContextService();
    svc.record('BTC/USDT', new Decimal('0.05'), T0);
    svc.record('ETH/USDT', new Decimal('0.01'), T0);

    expect(svc.rank('SOL/USDT', T0)).toBeNull();
  });

  it('excludes stale entries so a drained/halted instance cannot pollute the ranking', () => {
    const svc = new CrossSymbolContextService();
    svc.record('BTC/USDT', new Decimal('0.99'), T0); // will go stale
    svc.record('ETH/USDT', new Decimal('0.01'), T0 + STALE_MS + 1);
    svc.record('SOL/USDT', new Decimal('0.02'), T0 + STALE_MS + 1);

    const eth = svc.rank('ETH/USDT', T0 + STALE_MS + 1);

    // BTC's 99% figure is stale and excluded; SOL leads the fresh pair.
    expect(eth).toEqual({
      rank: 2,
      of: 2,
      ownReturnPct: '1',
      strongest: { symbol: 'SOL/USDT', returnPct: '2' },
      weakest: { symbol: 'ETH/USDT', returnPct: '1' },
    });
  });

  it('a re-record replaces the prior entry rather than accumulating', () => {
    const svc = new CrossSymbolContextService();
    svc.record('BTC/USDT', new Decimal('0.01'), T0);
    svc.record('ETH/USDT', new Decimal('0.02'), T0);
    svc.record('BTC/USDT', new Decimal('0.10'), T0 + 1);

    const btc = svc.rank('BTC/USDT', T0 + 1);

    expect(btc?.rank).toBe(1);
    expect(btc?.of).toBe(2);
    expect(btc?.ownReturnPct).toBe('10');
  });
});
