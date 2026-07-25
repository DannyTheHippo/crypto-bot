import { describe, it, expect } from 'vitest';
import { invalidKeyProbe } from '../../../src/features/trading/composition/key-probe.module';
import { venueId } from '../../../src/domain/types/ids';

describe('invalidKeyProbe (paper-mode KEY_PROBE default)', () => {
  it('reports keysValid:false for every configured venue', async () => {
    const probe = invalidKeyProbe([venueId('binance'), venueId('binanceusdm')]);
    const result = await probe.probeAll();

    expect(result.size).toBe(2);
    expect(result.get(venueId('binance'))?.keysValid).toBe(false);
    expect(result.get(venueId('binanceusdm'))?.keysValid).toBe(false);
  });

  it('reports withdrawalsEnabled:true and marginEnabled:true (fail-closed raw flags)', async () => {
    const probe = invalidKeyProbe([venueId('binance')]);
    const result = await probe.probeAll();

    const entry = result.get(venueId('binance'));
    expect(entry?.withdrawalsEnabled).toBe(true);
    expect(entry?.marginEnabled).toBe(true);
    expect(entry?.urlCrossCheckOk).toBe(false);
  });

  it('produces an empty map when no venues are configured', async () => {
    const result = await invalidKeyProbe([]).probeAll();
    expect(result.size).toBe(0);
  });
});
