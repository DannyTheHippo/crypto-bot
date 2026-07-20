import { Inject, Injectable } from '@nestjs/common';
import type { KeyProbePort, KeyProbeResult } from '../../../ports/mode-control';
import { venueId, type VenueId } from '../../../domain/types/ids';
import { CCXT_ORDER_CLIENT, type CcxtOrderClient } from './ccxt-order-client';

export const KEY_PROBE_CONFIG = Symbol('KEY_PROBE_CONFIG');

export interface KeyProbeConfig {
  readonly keyFingerprint: string; // hex digest of the key, minted at the composition root — NEVER the raw key
  // live: an unprobeable restriction set ⇒ refuse (keysValid:false); testnet (no sapi) ⇒ degrade to canTrade.
  readonly requireRestrictions: boolean;
}

// v3 §7.1: local venue-id copies (same idiom as position-sizer.service.ts's PERP_VENUE_ID and
// reconcile.ts's ALGO_RAIL_VENUE_ID — a shared venue-map module is deletion-list follow-up work,
// not this workstream's).
const SPOT_VENUE_ID = venueId('binance');
const PERP_VENUE_ID = venueId('binanceusdm');

type RawRestrictions = Omit<KeyProbeResult, 'keysValid'>;

// §10c key-restriction probe, v3 §7.1 per-venue edition. GET /sapi/v1/account/apiRestrictions is
// ACCOUNT-wide (one Binance API key, one response) — enableSpotAndMarginTrading/enableFutures cover
// BOTH surfaces this account can trade in a single round trip, so probeAll() makes ONE network call
// and derives both venues' verdicts from it. Each entry's keysValid is advisory only — ModeControl.
// refreshKeyProbe independently recomputes the authoritative per-venue verdict from the raw flags
// (auditor S5, carried into v3), so a buggy/compromised probe cannot grant live. Withdrawals-enabled
// is the cardinal refusal on both surfaces (§10c: refused outright, never warned); cross-margin
// borrow (enableMargin) is likewise forbidden on both surfaces regardless of which one is otherwise
// valid (§7.1: the perp futures-requirement never weakens the spot margin prohibition).
// NOTE: the Binance field names and the testnet NotSupported degradation must be confirmed against a
// real response during the out-of-session testnet RUN; urlCrossCheckOk is finalized in the
// composition-root wiring (both entries share the stubbed-true value pending that wiring).
@Injectable()
export class KeyProbeService implements KeyProbePort {
  constructor(
    @Inject(CCXT_ORDER_CLIENT) private readonly client: CcxtOrderClient,
    @Inject(KEY_PROBE_CONFIG) private readonly cfg: KeyProbeConfig,
  ) {}

  async probeAll(): Promise<ReadonlyMap<VenueId, KeyProbeResult>> {
    const raw = await this.fetchRestrictions();
    const result = new Map<VenueId, KeyProbeResult>();
    result.set(SPOT_VENUE_ID, this.recompute(raw, raw.spotEnabled));
    result.set(PERP_VENUE_ID, this.recompute(raw, raw.futuresEnabled));
    return result;
  }

  // §7.1: spot surface gates on spotEnabled, perp surface gates on futuresEnabled — surfaceEnabled
  // carries whichever applies; withdrawals-disabled and margin-forbidden bind on BOTH surfaces.
  private recompute(raw: RawRestrictions, surfaceEnabled: boolean): KeyProbeResult {
    const keysValid =
      !raw.withdrawalsEnabled && surfaceEnabled && !raw.marginEnabled && raw.urlCrossCheckOk;
    return { ...raw, keysValid };
  }

  private async fetchRestrictions(): Promise<RawRestrictions> {
    try {
      const r = await this.client.sapiGetAccountApiRestrictions();
      return {
        withdrawalsEnabled: r['enableWithdrawals'] === true,
        spotEnabled: r['enableSpotAndMarginTrading'] === true,
        futuresEnabled: r['enableFutures'] === true,
        marginEnabled: r['enableMargin'] === true,
        keyFingerprint: this.cfg.keyFingerprint,
        urlCrossCheckOk: true,
      };
    } catch {
      // Spot Testnet exposes no sapi (NotSupported); a network/permission error lands here too.
      if (this.cfg.requireRestrictions) {
        // Live: cannot confirm withdrawals are disabled ⇒ refuse (fail closed), both surfaces.
        return {
          withdrawalsEnabled: true,
          spotEnabled: false,
          futuresEnabled: false,
          marginEnabled: false,
          keyFingerprint: this.cfg.keyFingerprint,
          urlCrossCheckOk: true,
        };
      }
      // Testnet: degrade to canTrade — the env/url gate carries the wall here, no real funds at risk.
      return {
        withdrawalsEnabled: false,
        spotEnabled: true,
        futuresEnabled: true,
        marginEnabled: false,
        keyFingerprint: this.cfg.keyFingerprint,
        urlCrossCheckOk: true,
      };
    }
  }
}
