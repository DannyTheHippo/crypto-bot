import { describe, it, expect } from 'vitest';
import { NonceLedgerService } from '../../../src/modules/execution/nonce-ledger.service';
import { epochMs } from '../../../src/domain/types/ids';

const ms = (n: number) => epochMs(n);

describe('NonceLedgerService', () => {
  it('reports a fresh nonce as unseen, then seen after record (replay)', () => {
    const led = new NonceLedgerService();
    expect(led.has('n1', ms(1000))).toBe(false);
    led.record('n1', ms(1000), 2000);
    expect(led.has('n1', ms(1500))).toBe(true); // within TTL → replay
    expect(led.size()).toBe(1);
  });

  it('evicts a nonce past its TTL so a post-expiry check is unseen (EXPIRED owns it)', () => {
    const led = new NonceLedgerService();
    led.record('n1', ms(1000), 2000); // expires at 3000
    expect(led.has('n1', ms(3001))).toBe(false); // evicted
    expect(led.size()).toBe(0);
  });

  it('eviction at exact expiry boundary removes the nonce (≤ now)', () => {
    const led = new NonceLedgerService();
    led.record('n1', ms(1000), 2000); // expires at 3000
    expect(led.has('n1', ms(3000))).toBe(false);
  });
});
