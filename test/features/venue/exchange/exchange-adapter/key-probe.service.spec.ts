import { describe, it, expect, vi } from 'vitest';
import { KeyProbeService } from '../../../src/features/trading/exchange/key-probe.service';
import type { CcxtOrderClient } from '../../../src/features/trading/exchange/ccxt-order-client';
import { venueId } from '../../../src/domain/types/ids';

const SPOT = venueId('binance');
const PERP = venueId('binanceusdm');

// A client whose only relevant method is the apiRestrictions probe; other methods are unused here.
function clientReturning(restrictions: Record<string, unknown>): CcxtOrderClient {
  return stubClient({ sapiGetAccountApiRestrictions: vi.fn().mockResolvedValue(restrictions) });
}
function clientThrowing(): CcxtOrderClient {
  return stubClient({
    sapiGetAccountApiRestrictions: vi.fn().mockRejectedValue(new Error('NotSupported')),
  });
}
function stubClient(over: Partial<CcxtOrderClient>): CcxtOrderClient {
  return {
    createOrder: vi.fn(),
    cancelOrder: vi.fn(),
    fetchOrder: vi.fn(),
    fetchOpenOrders: vi.fn(),
    fetchBalance: vi.fn(),
    fetchMyTrades: vi.fn(),
    sapiGetAccountApiRestrictions: vi.fn().mockResolvedValue({}),
    ...over,
  };
}

const FP = 'fp-abc';
const probeWith = (client: CcxtOrderClient, requireRestrictions = false) =>
  new KeyProbeService(client, { keyFingerprint: FP, requireRestrictions });

// v3 §7.1: one account, two surfaces — probeAll() makes ONE network call (apiRestrictions is
// account-wide) and derives BOTH venues' verdicts from it via the per-surface recompute.
describe('KeyProbeService.probeAll — v3 §7.1 per-venue recompute', () => {
  it('a withdrawals-disabled, spot+futures-enabled, no-margin key is valid on BOTH venues', async () => {
    const r = await probeWith(
      clientReturning({
        enableWithdrawals: false,
        enableSpotAndMarginTrading: true,
        enableMargin: false,
        enableFutures: true,
      }),
    ).probeAll();
    expect(r.get(SPOT)).toEqual({
      keysValid: true,
      withdrawalsEnabled: false,
      spotEnabled: true,
      futuresEnabled: true,
      marginEnabled: false,
      keyFingerprint: FP,
      urlCrossCheckOk: true,
    });
    expect(r.get(PERP)).toEqual({
      keysValid: true,
      withdrawalsEnabled: false,
      spotEnabled: true,
      futuresEnabled: true,
      marginEnabled: false,
      keyFingerprint: FP,
      urlCrossCheckOk: true,
    });
  });

  it('a withdrawals-ENABLED key is invalid on both venues (cardinal refusal) with the flag surfaced', async () => {
    const r = await probeWith(
      clientReturning({
        enableWithdrawals: true,
        enableSpotAndMarginTrading: true,
        enableMargin: false,
        enableFutures: true,
      }),
    ).probeAll();
    expect(r.get(SPOT)?.keysValid).toBe(false);
    expect(r.get(PERP)?.keysValid).toBe(false);
    expect(r.get(SPOT)?.withdrawalsEnabled).toBe(true);
  });

  it('a key without spot trading is invalid on the spot venue only (perp unaffected)', async () => {
    const r = await probeWith(
      clientReturning({
        enableWithdrawals: false,
        enableSpotAndMarginTrading: false,
        enableMargin: false,
        enableFutures: true,
      }),
    ).probeAll();
    expect(r.get(SPOT)?.keysValid).toBe(false);
    expect(r.get(PERP)?.keysValid).toBe(true);
  });

  it('a key without futures trading is invalid on the perp venue only (spot unaffected)', async () => {
    const r = await probeWith(
      clientReturning({
        enableWithdrawals: false,
        enableSpotAndMarginTrading: true,
        enableMargin: false,
        enableFutures: false,
      }),
    ).probeAll();
    expect(r.get(SPOT)?.keysValid).toBe(true);
    expect(r.get(PERP)?.keysValid).toBe(false);
  });

  // §7.3 new row 8: the perp futures-requirement must not weaken the spot margin prohibition —
  // margin (cross-margin borrow) invalidates BOTH venues even though futures is separately enabled.
  it('a margin-enabled key is invalid on BOTH venues regardless of futures being enabled', async () => {
    const r = await probeWith(
      clientReturning({
        enableWithdrawals: false,
        enableSpotAndMarginTrading: true,
        enableMargin: true,
        enableFutures: true,
      }),
    ).probeAll();
    expect(r.get(SPOT)).toMatchObject({ keysValid: false, marginEnabled: true });
    expect(r.get(PERP)).toMatchObject({ keysValid: false, marginEnabled: true });
  });

  it('an unprobeable restriction set (testnet NotSupported) degrades to valid on both venues when restrictions are NOT required', async () => {
    const r = await probeWith(clientThrowing(), false).probeAll();
    expect(r.get(SPOT)).toMatchObject({ keysValid: true, spotEnabled: true, keyFingerprint: FP });
    expect(r.get(PERP)).toMatchObject({
      keysValid: true,
      futuresEnabled: true,
      keyFingerprint: FP,
    });
  });

  it('an unprobeable restriction set REFUSES (fail-closed) on BOTH venues when restrictions ARE required (live)', async () => {
    const r = await probeWith(clientThrowing(), true).probeAll();
    expect(r.get(SPOT)).toMatchObject({ keysValid: false, withdrawalsEnabled: true });
    expect(r.get(PERP)).toMatchObject({ keysValid: false, withdrawalsEnabled: true });
  });
});
