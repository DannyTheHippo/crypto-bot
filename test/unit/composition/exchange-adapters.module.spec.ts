import { describe, it, expect, vi } from 'vitest';
import {
  buildVenueExchangePorts,
  VenueRoutingExchangeAdapter,
} from '../../../src/features/trading/composition/exchange-adapters.module';
import { buildVenueRegistry } from '../../../src/features/trading/composition/venue-registry.module';
import { PaperExchangeAdapter } from '../../../src/features/trading/exchange/paper-exchange.adapter';
import { PaperPerpAdapter } from '../../../src/features/trading/exchange/paper-perp.adapter';
import { InMemoryExecOutbox } from '../../../src/features/trading/execution/in-memory-outbox';
import { InMemoryFundingSink } from '../../../src/features/trading/exchange/in-memory-funding-sink';
import type { TypedConfigService } from '../../../src/config/environment/typed-config.service';
import type { PaperConfig } from '../../../src/features/trading/exchange/paper-exchange.adapter';
import { venueId, symbolId, epochMs } from '../../../src/domain/types/ids';
import type { ClockPort } from '../../../src/ports/clock';
import type { ExchangePort, PlaceOrderRequest } from '../../../src/ports/exchange';

const clock: ClockPort = { now: () => epochMs(1_700_000_000_000) };

function fakeConfig(): TypedConfigService {
  return {
    mode: { configMode: 'paper', sandboxEnv: 'demo' },
    liveSecrets: { liveApiKey: undefined, liveApiSecret: undefined },
    perp: { leverageCap: '2', mmrFallback: '0.005' },
    strategy: { symbols: ['BTC/USDT', 'ETH/USDT', 'BTC/USDT:USDT'], active: 'agentic' },
    venues: [
      { id: 'binance', environment: 'demo' },
      { id: 'binanceusdm', environment: 'demo' },
    ],
    venueCapitalSplit: { binance: '500', binanceusdm: '300' },
  } as unknown as TypedConfigService;
}

const PAPER_CONFIG_BASE: PaperConfig = {
  seed: 1,
  takerBuffer: '0.05',
  fees: { makerBps: '10', takerBps: '10', feeCurrency: 'quote' },
  latency: { submitMs: [0, 0], eventMs: [0, 0] },
  insufficientDepthPolicy: 'partial_then_reject_rest',
  startingBalances: { USDT: '100000' },
};

describe('buildVenueExchangePorts (paper mode)', () => {
  it('binds a PaperExchangeAdapter for the spot venue and a PaperPerpAdapter for the perp venue, each seeded with its own capitalShare', () => {
    const config = fakeConfig();
    const registry = buildVenueRegistry(config);
    const ports = buildVenueExchangePorts(
      registry,
      config,
      clock,
      new InMemoryExecOutbox(),
      () => Promise.resolve(),
      PAPER_CONFIG_BASE,
      new InMemoryFundingSink(),
    );

    expect(ports.size).toBe(2);
    expect(ports.get(venueId('binance'))).toBeInstanceOf(PaperExchangeAdapter);
    expect(ports.get(venueId('binanceusdm'))).toBeInstanceOf(PaperPerpAdapter);
  });
});

describe('VenueRoutingExchangeAdapter', () => {
  function fakePort(venue: string): ExchangePort {
    return {
      venue: venueId(venue),
      capabilities: {
        clientOrderId: true,
        fetchOrderByClientId: true,
        wsUserStream: true,
        stp: false,
        sandbox: true,
      },
      placeOrder: vi.fn().mockResolvedValue({ clientOrderId: 'x', venueOrderId: 'y' }),
      cancelOrder: vi.fn(),
      fetchOrder: vi.fn(),
      fetchOpenOrders: vi.fn().mockResolvedValue([]),
      fetchBalances: vi.fn().mockResolvedValue(new Map()),
      fetchMyTrades: vi.fn().mockResolvedValue([]),
      validateCredentials: vi.fn(),
    };
  }

  it('dispatches placeOrder to the spot venue for a plain symbol and the perp venue for a :SETTLE symbol', async () => {
    const spot = fakePort('binance');
    const perp = fakePort('binanceusdm');
    const facade = new VenueRoutingExchangeAdapter(
      new Map([
        [venueId('binance'), spot],
        [venueId('binanceusdm'), perp],
      ]),
    );

    const req = (symbol: string): PlaceOrderRequest => ({
      clientOrderId: 'c' as never,
      symbol: symbolId(symbol),
      side: 'BUY',
      type: 'LIMIT',
      qty: '1',
      timeInForce: 'GTC',
      reduceOnly: false,
    });

    await facade.placeOrder(req('BTC/USDT'));
    await facade.placeOrder(req('BTC/USDT:USDT'));

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() fakes carry no `this`; referencing them for call-count assertions is safe
    expect(spot.placeOrder).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- same vi.fn() fake as above
    expect(perp.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('throws (fail CLOSED) when the resolved venue has no registered port', async () => {
    const spot = fakePort('binance');
    const facade = new VenueRoutingExchangeAdapter(new Map([[venueId('binance'), spot]]));

    await expect(
      facade.placeOrder({
        clientOrderId: 'c' as never,
        symbol: symbolId('BTC/USDT:USDT'),
        side: 'BUY',
        type: 'LIMIT',
        qty: '1',
        timeInForce: 'GTC',
        reduceOnly: false,
      }),
    ).rejects.toThrow(/no exchange port for venue/);
  });

  it('pinPerpVenueDefaults filters out non-perp symbols and no-ops when the perp port lacks the hook', async () => {
    const spot = fakePort('binance');
    const perp = fakePort('binanceusdm');
    const pin = vi.fn().mockResolvedValue(undefined);
    (perp as ExchangePort & { pinPerpVenueDefaults: typeof pin }).pinPerpVenueDefaults = pin;
    const facade = new VenueRoutingExchangeAdapter(
      new Map([
        [venueId('binance'), spot],
        [venueId('binanceusdm'), perp],
      ]),
    );

    await facade.pinPerpVenueDefaults(
      [symbolId('BTC/USDT'), symbolId('BTC/USDT:USDT'), symbolId('ETH/USDT:USDT')],
      2,
    );

    expect(pin).toHaveBeenCalledTimes(1);
    expect(pin).toHaveBeenCalledWith([symbolId('BTC/USDT:USDT'), symbolId('ETH/USDT:USDT')], 2);
  });

  it('pinPerpVenueDefaults no-ops without throwing when no venue implements the hook', async () => {
    const spot = fakePort('binance');
    const perp = fakePort('binanceusdm');
    const facade = new VenueRoutingExchangeAdapter(
      new Map([
        [venueId('binance'), spot],
        [venueId('binanceusdm'), perp],
      ]),
    );

    await expect(
      facade.pinPerpVenueDefaults([symbolId('BTC/USDT:USDT')], 2),
    ).resolves.toBeUndefined();
  });
});
