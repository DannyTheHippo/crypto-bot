import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { FeeLedgerService } from '../../../src/features/trading/execution/fee-ledger.service';

describe('FeeLedgerService', () => {
  it('accumulates per asset and totals; unknown asset is zero', () => {
    const led = new FeeLedgerService();
    led.add('BNB', new Decimal('0.5'));
    led.add('BNB', new Decimal('0.25'));
    led.add('USDT', new Decimal('1'));
    expect(led.total('BNB').toFixed()).toBe('0.75');
    expect(led.total('USDT').toFixed()).toBe('1');
    expect(led.total('ETH').toFixed()).toBe('0');
    expect([...led.all().keys()].sort()).toEqual(['BNB', 'USDT']);
  });
});
