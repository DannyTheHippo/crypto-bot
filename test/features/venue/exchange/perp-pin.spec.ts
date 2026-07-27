import { describe, it, expect, vi } from 'vitest';
import type { Exchange } from 'ccxt';
import {
  RealCcxtOrderClient,
  type CcxtOrderClient,
} from '../../../../src/features/venue/exchange/ccxt-order-client';
import { CcxtExchangeAdapter } from '../../../../src/features/venue/exchange/ccxt-exchange.adapter';
import { venueId, symbolId } from '../../../../src/domain/common/types/ids';

// Backlog #51 (Phase-8 perp deploy checklist): venue-side isolated-margin + leverage pinning,
// fail-closed. Dormant on the current spot deployment — the adapter gates by venue.
describe('perp venue pinning (#51)', () => {
  function fakeExchange(over: Partial<Record<'setMarginMode' | 'setLeverage', unknown>> = {}): {
    exchange: Exchange;
    setMarginMode: ReturnType<typeof vi.fn>;
    setLeverage: ReturnType<typeof vi.fn>;
  } {
    const setMarginMode = vi.fn().mockResolvedValue({});
    const setLeverage = vi.fn().mockResolvedValue({});
    const exchange = {
      setMarginMode: over.setMarginMode ?? setMarginMode,
      setLeverage: over.setLeverage ?? setLeverage,
    } as unknown as Exchange;
    return { exchange, setMarginMode, setLeverage };
  }

  it('pins isolated margin then leverage per symbol', async () => {
    const { exchange, setMarginMode, setLeverage } = fakeExchange();
    const client = new RealCcxtOrderClient(exchange);
    await client.pinPerpVenueDefaults(['BTC/USDT:USDT', 'ETH/USDT:USDT'], 1);
    expect(setMarginMode.mock.calls).toEqual([
      ['isolated', 'BTC/USDT:USDT'],
      ['isolated', 'ETH/USDT:USDT'],
    ]);
    expect(setLeverage.mock.calls).toEqual([
      [1, 'BTC/USDT:USDT'],
      [1, 'ETH/USDT:USDT'],
    ]);
  });

  it('tolerates the already-set idempotency responses (-4046 / not modified) as success', async () => {
    const { exchange } = fakeExchange({
      setMarginMode: vi
        .fn()
        .mockRejectedValue(
          new Error('binanceusdm {"code":-4046,"msg":"No need to change margin type."}'),
        ),
      setLeverage: vi.fn().mockRejectedValue(new Error('leverage not modified')),
    });
    const client = new RealCcxtOrderClient(exchange);
    await expect(client.pinPerpVenueDefaults(['BTC/USDT:USDT'], 1)).resolves.toBeUndefined();
  });

  it('tolerates -4067 (open orders block margin change) only when venue already reports isolated', async () => {
    const setMarginMode = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'binanceusdm {"code":-4067,"msg":"Position side cannot be changed if there exists open orders."}',
        ),
      );
    const setLeverage = vi.fn().mockResolvedValue({});
    const fetchPositions = vi
      .fn()
      .mockResolvedValue([
        { symbol: 'BTC/USDT:USDT', marginMode: 'isolated', info: { marginType: 'isolated' } },
      ]);
    const exchange = { setMarginMode, setLeverage, fetchPositions } as unknown as Exchange;
    const client = new RealCcxtOrderClient(exchange);
    await expect(client.pinPerpVenueDefaults(['BTC/USDT:USDT'], 1)).resolves.toBeUndefined();
    expect(setLeverage).toHaveBeenCalledWith(1, 'BTC/USDT:USDT');
  });

  it('still fail-closes on -4067 when margin cannot be verified as isolated', async () => {
    const setMarginMode = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'binanceusdm {"code":-4067,"msg":"Position side cannot be changed if there exists open orders."}',
        ),
      );
    const setLeverage = vi.fn().mockResolvedValue({});
    const fetchPositions = vi
      .fn()
      .mockResolvedValue([
        { symbol: 'BTC/USDT:USDT', marginMode: 'cross', info: { marginType: 'cross' } },
      ]);
    const exchange = { setMarginMode, setLeverage, fetchPositions } as unknown as Exchange;
    const client = new RealCcxtOrderClient(exchange);
    await expect(client.pinPerpVenueDefaults(['BTC/USDT:USDT'], 1)).rejects.toThrow(
      /setMarginMode.*fail-closed/,
    );
    expect(setLeverage).not.toHaveBeenCalled();
  });

  // 2026-07-27 boot halt: KAITO/USDT:USDT was FLAT but carried a resting algo-rail STOP_MARKET, so
  // the venue refused setMarginMode with -4067 while fetchPositions returned nothing (it drops
  // zero-size rows). "Cannot tell" was read as "not isolated" and the pin flattened the book over a
  // symbol the venue already had on isolated margin.
  it('tolerates -4067 on a FLAT symbol by falling back to the v2 position-risk endpoint, which returns zero-size rows', async () => {
    const setMarginMode = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'binanceusdm {"code":-4067,"msg":"Position side cannot be changed if there exists open orders."}',
        ),
      );
    const setLeverage = vi.fn().mockResolvedValue({});
    const fetchPositions = vi.fn().mockResolvedValue([]); // flat ⇒ ccxt yields no row at all
    const fapiPrivateV2GetPositionRisk = vi
      .fn()
      .mockResolvedValue([{ symbol: 'KAITOUSDT', marginType: 'isolated' }]);
    const market = vi.fn().mockReturnValue({ id: 'KAITOUSDT' });
    const exchange = {
      setMarginMode,
      setLeverage,
      fetchPositions,
      fapiPrivateV2GetPositionRisk,
      market,
    } as unknown as Exchange;
    const client = new RealCcxtOrderClient(exchange);
    await expect(client.pinPerpVenueDefaults(['KAITO/USDT:USDT'], 5)).resolves.toBeUndefined();
    expect(fapiPrivateV2GetPositionRisk).toHaveBeenCalledWith({ symbol: 'KAITOUSDT' });
    expect(setLeverage).toHaveBeenCalledWith(5, 'KAITO/USDT:USDT');
  });

  it('still fail-closes on a FLAT symbol the fallback reports as cross — the fallback widens visibility, never tolerance', async () => {
    const setMarginMode = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'binanceusdm {"code":-4067,"msg":"Position side cannot be changed if there exists open orders."}',
        ),
      );
    const setLeverage = vi.fn().mockResolvedValue({});
    const exchange = {
      setMarginMode,
      setLeverage,
      fetchPositions: vi.fn().mockResolvedValue([]),
      fapiPrivateV2GetPositionRisk: vi
        .fn()
        .mockResolvedValue([{ symbol: 'KAITOUSDT', marginType: 'cross' }]),
      market: vi.fn().mockReturnValue({ id: 'KAITOUSDT' }),
    } as unknown as Exchange;
    const client = new RealCcxtOrderClient(exchange);
    await expect(client.pinPerpVenueDefaults(['KAITO/USDT:USDT'], 5)).rejects.toThrow(
      /setMarginMode.*fail-closed/,
    );
    expect(setLeverage).not.toHaveBeenCalled();
  });

  it('a venue without the fallback endpoint keeps the old fail-closed behaviour on an unverifiable -4067', async () => {
    const setMarginMode = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'binanceusdm {"code":-4067,"msg":"Position side cannot be changed if there exists open orders."}',
        ),
      );
    const exchange = {
      setMarginMode,
      setLeverage: vi.fn().mockResolvedValue({}),
      fetchPositions: vi.fn().mockResolvedValue([]),
    } as unknown as Exchange;
    const client = new RealCcxtOrderClient(exchange);
    await expect(client.pinPerpVenueDefaults(['KAITO/USDT:USDT'], 5)).rejects.toThrow(
      /setMarginMode.*fail-closed/,
    );
  });

  it('throws fail-closed on any other venue error', async () => {
    const { exchange } = fakeExchange({
      setMarginMode: vi.fn().mockRejectedValue(new Error('binanceusdm 403 forbidden')),
    });
    const client = new RealCcxtOrderClient(exchange);
    await expect(client.pinPerpVenueDefaults(['BTC/USDT:USDT'], 1)).rejects.toThrow(
      /setMarginMode.*fail-closed/,
    );
  });

  it('rejects a non-integer or sub-1 leverage fail-closed (a fractional PERP_LEVERAGE_CAP must never floor to 0 silently)', async () => {
    const { exchange } = fakeExchange();
    const client = new RealCcxtOrderClient(exchange);
    await expect(client.pinPerpVenueDefaults(['BTC/USDT:USDT'], 0)).rejects.toThrow(/fail-closed/);
    await expect(client.pinPerpVenueDefaults(['BTC/USDT:USDT'], 1.5)).rejects.toThrow(
      /fail-closed/,
    );
  });

  it('the adapter no-ops on a spot venue and delegates on binanceusdm; a perp client without the hook throws', async () => {
    const pin = vi.fn().mockResolvedValue(undefined);
    const clientWithPin = { pinPerpVenueDefaults: pin } as unknown as CcxtOrderClient;

    const spot = new CcxtExchangeAdapter(clientWithPin, venueId('binance'), true);
    await spot.pinPerpVenueDefaults([symbolId('BTC/USDT')], 1);
    expect(pin).not.toHaveBeenCalled();

    const perp = new CcxtExchangeAdapter(clientWithPin, venueId('binanceusdm'), true);
    await perp.pinPerpVenueDefaults([symbolId('BTC/USDT:USDT')], 1);
    expect(pin).toHaveBeenCalledWith(['BTC/USDT:USDT'], 1);

    const bare = new CcxtExchangeAdapter({} as CcxtOrderClient, venueId('binanceusdm'), true);
    await expect(bare.pinPerpVenueDefaults([symbolId('BTC/USDT:USDT')], 1)).rejects.toThrow(
      /fail-closed/,
    );
  });
});
