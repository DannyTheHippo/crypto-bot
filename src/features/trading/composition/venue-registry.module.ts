import { Global, Module } from '@nestjs/common';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import type { VenueConfig } from '../../../ports/app-config';
import { VENUE_REGISTRY, type VenueRuntimeDescriptor } from '../../../ports/venue-registry';
import { venueId, symbolId, type VenueId } from '../../../domain/types/ids';
import { venueForSymbol, PERP_VENUE, SPOT_VENUE } from '../../../domain/types/venue-map';

// v3 spec §1.3: VENUE_REGISTRY is the composition root's per-venue fact table — built purely from
// TypedConfigService (no network, no adapters), and every other composition module reads it instead
// of `config.venues[0]` (the retired `primaryVenue()`/`feedVenueConfig()` pattern). Data, not a DI
// scope: one flat module graph, one map. Token + descriptor shape live in ports/venue-registry.ts
// (re-exported here for existing import sites) — see that file's header for why.
export { VENUE_REGISTRY, type VenueRuntimeDescriptor };

function isTestEnv(): boolean {
  return (
    process.env['NODE_ENV'] === 'test' ||
    process.env['NODE_ENV'] === 'ci' ||
    Boolean(process.env['CI'])
  );
}

// v3 §3.2: VENUES defaults to empty under test/ci (config.module.ts's AppConfigModule deliberately
// skips process.env/env-file reads there — a real boot always configures VENUES, enforced by
// environment.config.ts's own non-empty refusal outside test/ci). Every hermetic spec that compiles
// the real AppModule (openapi-snapshot, health, metrics-interval, this module's own boot spec, …)
// still needs a WORKING venue graph — VenueRoutingExchangeAdapter (exchange-adapters.module.ts)
// fails CLOSED on an empty port map by design, a real boot must never silently trade nowhere.
// Falls back to a single spot venue owning every configured symbol ONLY when config.venues is empty
// AND under test/ci — mirrors the retired single-venue primaryVenue()'s own `?? 'binance'` default;
// never reachable on a real deploy (VENUES is mandatory there, so config.venues is never empty
// outside this test/ci carve-out).
function resolveVenueConfigs(config: TypedConfigService): readonly VenueConfig[] {
  if (config.venues.length > 0) return config.venues;
  return isTestEnv() ? [{ id: SPOT_VENUE, environment: 'paper' }] : config.venues;
}

export function buildVenueRegistry(
  config: TypedConfigService,
): ReadonlyMap<VenueId, VenueRuntimeDescriptor> {
  const symbolIds = config.strategy.symbols.map((s) => symbolId(s));
  const registry = new Map<VenueId, VenueRuntimeDescriptor>();
  for (const venueConfig of resolveVenueConfigs(config)) {
    const venue = venueId(venueConfig.id);
    const symbols = symbolIds.filter((s) => venueForSymbol(s) === venue);
    registry.set(venue, {
      venue,
      config: venueConfig,
      symbols,
      capitalShare: config.venueCapitalSplit[venueConfig.id] ?? '0',
      perpCapable: venueConfig.id === PERP_VENUE,
    });
  }
  return registry;
}

@Global()
@Module({
  providers: [
    {
      provide: VENUE_REGISTRY,
      useFactory: buildVenueRegistry,
      inject: [TypedConfigService],
    },
  ],
  exports: [VENUE_REGISTRY],
})
export class VenueRegistryModule {}
