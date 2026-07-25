import { describe, it, expect } from 'vitest';
import {
  perpSymbols,
  tradeFlowSymbols,
  combinedSymbols,
} from '../../../../src/features/trading/composition/context-feeds.module';
import { buildVenueRegistry } from '../../../../src/features/trading/composition/venue-registry.module';
import type { TypedConfigService } from '../../../../src/config/environment/typed-config.service';

function fakeConfig(symbols: readonly string[]): TypedConfigService {
  return {
    venues: [
      { id: 'binance', environment: 'demo' },
      { id: 'binanceusdm', environment: 'demo' },
    ],
    strategy: { symbols },
    venueCapitalSplit: { binance: '500', binanceusdm: '500' },
  } as unknown as TypedConfigService;
}

describe('context-feeds symbol partitioning', () => {
  const registry = buildVenueRegistry(
    fakeConfig([
      'BTC/USDT',
      'ETH/USDT',
      'HYPE/USDT',
      'KAITO/USDT',
      'BTC/USDT:USDT',
      'SOL/USDT:USDT',
    ]),
  );

  it('perpSymbols returns only the perp venue symbol subset', () => {
    expect(perpSymbols(registry)).toEqual(['BTC/USDT:USDT', 'SOL/USDT:USDT']);
  });

  it('tradeFlowSymbols returns the spot subset minus the HYPE/KAITO skip list', () => {
    expect(tradeFlowSymbols(registry)).toEqual(['BTC/USDT', 'ETH/USDT']);
  });

  it('combinedSymbols returns every symbol across both venues', () => {
    expect(combinedSymbols(registry).sort()).toEqual(
      ['BTC/USDT', 'ETH/USDT', 'HYPE/USDT', 'KAITO/USDT', 'BTC/USDT:USDT', 'SOL/USDT:USDT'].sort(),
    );
  });

  it('perpSymbols is empty when no perp venue is configured', () => {
    const spotOnlyConfig = {
      venues: [{ id: 'binance', environment: 'demo' }],
      strategy: { symbols: ['BTC/USDT'] },
      venueCapitalSplit: { binance: '500' },
    } as unknown as TypedConfigService;
    expect(perpSymbols(buildVenueRegistry(spotOnlyConfig))).toEqual([]);
  });
});
