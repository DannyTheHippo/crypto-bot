import { Global, Module } from '@nestjs/common';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { VENUE_REGISTRY, type VenueRuntimeDescriptor } from '../../../ports/venue-registry';
import { venueId, symbolId, type VenueId } from '../../../domain/types/ids';
import { venueForSymbol, PERP_VENUE } from '../../../domain/types/venue-map';

// v3 spec §1.3: VENUE_REGISTRY is the composition root's per-venue fact table — built purely from
// TypedConfigService (no network, no adapters), and every other composition module reads it instead
// of `config.venues[0]` (the retired `primaryVenue()`/`feedVenueConfig()` pattern). Data, not a DI
// scope: one flat module graph, one map. Token + descriptor shape live in ports/venue-registry.ts
// (re-exported here for existing import sites) — see that file's header for why.
export { VENUE_REGISTRY, type VenueRuntimeDescriptor };

export function buildVenueRegistry(
  config: TypedConfigService,
): ReadonlyMap<VenueId, VenueRuntimeDescriptor> {
  const symbolIds = config.strategy.symbols.map((s) => symbolId(s));
  const registry = new Map<VenueId, VenueRuntimeDescriptor>();
  for (const venueConfig of config.venues) {
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
