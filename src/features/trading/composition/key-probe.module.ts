import { Global, Module } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { SPOT_VENUE } from '../../../domain/venue/types/venue-map';
import {
  KEY_PROBE,
  type KeyProbePort,
  type KeyProbeResult,
} from '../../../ports/trading/mode-control';
import { venueId, type VenueId } from '../../../domain/common/types/ids';
import { KeyProbeService } from '../../venue/exchange/key-probe.service';
import { buildOrderClient, resolveSandbox } from './exchange-adapters.module';

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
        const client = buildOrderClient(
          SPOT_VENUE,
          isLive ? 'live' : sandbox.environment,
          apiKey,
          secret,
        );
        const keyFingerprint = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
        return new KeyProbeService(client, { keyFingerprint, requireRestrictions: isLive });
      },
      inject: [TypedConfigService],
    },
  ],
  exports: [KEY_PROBE],
})
export class KeyProbeModule {}
