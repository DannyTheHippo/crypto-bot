import type { VenueConfig } from '../common/app-config';
import type { VenueId, SymbolId } from '../../domain/common/types/ids';

// v3 spec §1.3: VENUE_REGISTRY is the composition root's per-venue fact table (composition builds
// it purely from TypedConfigService — no network, no adapters). The token + descriptor shape live
// here (ports zone) rather than in the composition module file itself so features-zone consumers
// (e.g. ReconciliationService, DemoFillPollerService — eslint-plugin-boundaries's features→ports
// allow, never features→app) can inject it without a boundaries violation; composition-root files
// (app zone) bind the concretion in venue-registry.module.ts.
export const VENUE_REGISTRY = Symbol('VENUE_REGISTRY');

export interface VenueRuntimeDescriptor {
  readonly venue: VenueId;
  readonly config: VenueConfig;
  readonly symbols: readonly SymbolId[];
  readonly capitalShare: string;
  readonly perpCapable: boolean;
}
