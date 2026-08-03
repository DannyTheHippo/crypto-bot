import { Global, Module } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { PERP_VENUE, SPOT_VENUE } from '../../../domain/venue/types/venue-map';
import type { VenueEnvironment } from '../../../ports/common/app-config';
import { venuePrivateUrlCrossCheckOk } from '../../../shared/venue-safety/venue-url-crosscheck';
import {
  KEY_PROBE,
  type KeyProbePort,
  type KeyProbeResult,
} from '../../../ports/trading/mode-control';
import { venueId, type VenueId } from '../../../domain/common/types/ids';
import { KeyProbeService } from '../../venue/exchange/key-probe.service';
import { buildOrderClient, resolveSandbox, venuePrivateUrl } from './exchange-adapters.module';

// v3 spec §1.3/§7.1: gate-(c) KEY_PROBE, bound globally by the composition root (ModeControl
// consumes it). GET /sapi/v1/account/apiRestrictions is ACCOUNT-wide — one Binance API key, one
// response — so KeyProbeService.probeAll() (owned by #9) already derives BOTH venues' verdicts from
// a SINGLE credentialed client built against the spot venue; this module's only job is to build that
// one client the same way app.module.ts's retired KeyProbeModule built its single-venue probe.
// Paper uses a forced-invalid probe (paper never trades live, so keysValid stays false on every
// venue ⇒ live unreachable). Under test/ci configMode is forced paper, so no real client/probe is
// constructed in CI. keyFingerprint is a hex digest — never the raw key.
const INVALID_RESULT: KeyProbeResult = {
  keysValid: false,
  withdrawalsEnabled: true,
  spotEnabled: false,
  futuresEnabled: false,
  marginEnabled: true,
  keyFingerprint: 'none',
  urlCrossCheckOk: false,
};

export function invalidKeyProbe(venues: readonly VenueId[]): KeyProbePort {
  return {
    probeAll: () => Promise.resolve(new Map(venues.map((v) => [v, INVALID_RESULT] as const))),
  };
}

// Live gate (c)'s URL conjunct, decided ONCE here: BOTH credentialed rails' effective private base
// URLs must resolve to the booted environment's own hosts. AND across venues because the
// account-wide probe's verdict is shared by both venue entries — a mismatch on either rail must not
// be masked by the other. Config-only (no venue round trip), so re-probing cannot make it stale.
// FAILS CLOSED: any unrecognised host/venue/URL yields false, which forces keysValid false on both
// surfaces (see shared/venue-safety/venue-url-crosscheck.ts for the failure-direction rationale).
export function resolveUrlCrossCheck(environment: VenueEnvironment): boolean {
  return [SPOT_VENUE, PERP_VENUE].every((venue) =>
    venuePrivateUrlCrossCheckOk(venue, venuePrivateUrl(venue, environment), environment),
  );
}

@Global()
@Module({
  providers: [
    {
      provide: KEY_PROBE,
      useFactory: (config: TypedConfigService): KeyProbePort => {
        const mode = config.mode.configMode;
        const venues = config.venues.map((v) => venueId(v.id));
        if (mode === 'paper') return invalidKeyProbe(venues);
        const isLive = mode === 'live';
        const sandbox = resolveSandbox(config);
        const apiKey = isLive ? (config.liveSecrets.liveApiKey ?? '') : sandbox.apiKey;
        const secret = isLive ? (config.liveSecrets.liveApiSecret ?? '') : sandbox.secret;
        const environment: VenueEnvironment = isLive ? 'live' : sandbox.environment;
        const client = buildOrderClient(SPOT_VENUE, environment, apiKey, secret);
        const keyFingerprint = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
        return new KeyProbeService(client, {
          keyFingerprint,
          requireRestrictions: isLive,
          urlCrossCheckOk: resolveUrlCrossCheck(environment),
        });
      },
      inject: [TypedConfigService],
    },
  ],
  exports: [KEY_PROBE],
})
export class KeyProbeModule {}
