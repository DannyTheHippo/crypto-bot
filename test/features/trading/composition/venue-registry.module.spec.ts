import { describe, it, expect } from 'vitest';
import { buildVenueRegistry } from '../../../../src/features/trading/composition/venue-registry.module';
import type { TypedConfigService } from '../../../../src/config/environment/typed-config.service';

function fakeConfig(overrides: {
  venues: readonly { id: string; environment: string }[];
  symbols: readonly string[];
  venueCapitalSplit: Readonly<Record<string, string>>;
}): TypedConfigService {
  return {
    venues: overrides.venues,
    strategy: { symbols: overrides.symbols },
    venueCapitalSplit: overrides.venueCapitalSplit,
  } as unknown as TypedConfigService;
}

describe('buildVenueRegistry', () => {
  it('partitions symbols by venue and carries capitalShare/perpCapable', () => {
    const config = fakeConfig({
      venues: [
        { id: 'binance', environment: 'demo' },
        { id: 'binanceusdm', environment: 'demo' },
      ],
      symbols: ['BTC/USDT', 'ETH/USDT', 'BTC/USDT:USDT', 'SOL/USDT:USDT'],
      venueCapitalSplit: { binance: '500', binanceusdm: '500' },
    });

    const registry = buildVenueRegistry(config);

    expect(registry.size).toBe(2);
    const spot = registry.get('binance' as never);
    const perp = registry.get('binanceusdm' as never);
    expect(spot?.symbols).toEqual(['BTC/USDT', 'ETH/USDT']);
    expect(spot?.perpCapable).toBe(false);
    expect(spot?.capitalShare).toBe('500');
    expect(perp?.symbols).toEqual(['BTC/USDT:USDT', 'SOL/USDT:USDT']);
    expect(perp?.perpCapable).toBe(true);
    expect(perp?.capitalShare).toBe('500');
  });

  it('defaults a missing capitalShare entry to "0" rather than throwing', () => {
    const config = fakeConfig({
      venues: [{ id: 'binance', environment: 'demo' }],
      symbols: ['BTC/USDT'],
      venueCapitalSplit: {},
    });

    const registry = buildVenueRegistry(config);

    expect(registry.get('binance' as never)?.capitalShare).toBe('0');
  });

  // v3 §3.2: VENUES defaults to empty under test/ci (a real boot always configures it —
  // environment.config.ts refuses an empty VENUES outside test/ci). VenueRoutingExchangeAdapter
  // (exchange-adapters.module.ts) fails CLOSED on an empty port map by design, so buildVenueRegistry
  // falls back to a single spot venue owning every configured symbol under this NODE_ENV=test run —
  // never reachable on a real deploy — so every hermetic spec that boots the real AppModule still
  // gets a working (if minimal) venue graph. See resolveVenueConfigs' own comment.
  it('falls back to a single spot venue under test/ci when no venues are configured (never empty)', () => {
    const config = fakeConfig({ venues: [], symbols: ['BTC/USDT'], venueCapitalSplit: {} });

    const registry = buildVenueRegistry(config);

    expect(registry.size).toBe(1);
    const spot = registry.get('binance' as never);
    expect(spot?.symbols).toEqual(['BTC/USDT']);
    expect(spot?.perpCapable).toBe(false);
  });
});
