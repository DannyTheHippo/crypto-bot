import { describe, it, expect, vi } from 'vitest';
import { KeyProbeService } from '../../../src/modules/exchange-adapter/key-probe.service';
import type { CcxtOrderClient } from '../../../src/modules/exchange-adapter/ccxt-order-client';

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

describe('KeyProbeService', () => {
  it('a withdrawals-disabled, spot-enabled, no-margin/futures key is valid', async () => {
    const r = await probeWith(
      clientReturning({
        enableWithdrawals: false,
        enableSpotAndMarginTrading: true,
        enableMargin: false,
        enableFutures: false,
      }),
    ).probe();
    expect(r).toEqual({
      keysValid: true,
      withdrawalsEnabled: false,
      spotEnabled: true,
      marginOrFutures: false,
      keyFingerprint: FP,
      urlCrossCheckOk: true,
    });
  });

  it('a withdrawals-ENABLED key is invalid (cardinal refusal) with the flag surfaced', async () => {
    const r = await probeWith(
      clientReturning({
        enableWithdrawals: true,
        enableSpotAndMarginTrading: true,
        enableMargin: false,
        enableFutures: false,
      }),
    ).probe();
    expect(r.keysValid).toBe(false);
    expect(r.withdrawalsEnabled).toBe(true);
  });

  it('a key without spot trading is invalid', async () => {
    const r = await probeWith(
      clientReturning({
        enableWithdrawals: false,
        enableSpotAndMarginTrading: false,
        enableMargin: false,
        enableFutures: false,
      }),
    ).probe();
    expect(r.keysValid).toBe(false);
    expect(r.spotEnabled).toBe(false);
  });

  it('a margin- or futures-enabled key is invalid (marginOrFutures flagged)', async () => {
    const margin = await probeWith(
      clientReturning({
        enableWithdrawals: false,
        enableSpotAndMarginTrading: true,
        enableMargin: true,
        enableFutures: false,
      }),
    ).probe();
    expect(margin).toMatchObject({ keysValid: false, marginOrFutures: true });
    const futures = await probeWith(
      clientReturning({
        enableWithdrawals: false,
        enableSpotAndMarginTrading: true,
        enableMargin: false,
        enableFutures: true,
      }),
    ).probe();
    expect(futures).toMatchObject({ keysValid: false, marginOrFutures: true });
  });

  it('an unprobeable restriction set (testnet NotSupported) degrades to valid when restrictions are NOT required', async () => {
    const r = await probeWith(clientThrowing(), false).probe();
    expect(r).toMatchObject({
      keysValid: true,
      withdrawalsEnabled: false,
      spotEnabled: true,
      keyFingerprint: FP,
    });
  });

  it('an unprobeable restriction set REFUSES (fail-closed) when restrictions ARE required (live)', async () => {
    const r = await probeWith(clientThrowing(), true).probe();
    expect(r).toMatchObject({ keysValid: false, withdrawalsEnabled: true, keyFingerprint: FP });
  });
});
