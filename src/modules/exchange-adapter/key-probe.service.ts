import { Inject, Injectable } from '@nestjs/common';
import type { KeyProbePort, KeyProbeResult } from '../../ports/mode-control';
import { CCXT_ORDER_CLIENT, type CcxtOrderClient } from './ccxt-order-client';

export const KEY_PROBE_CONFIG = Symbol('KEY_PROBE_CONFIG');

export interface KeyProbeConfig {
  readonly keyFingerprint: string; // hex digest of the key, minted at the composition root — NEVER the raw key
  // live: an unprobeable restriction set ⇒ refuse (keysValid:false); testnet (no sapi) ⇒ degrade to canTrade.
  readonly requireRestrictions: boolean;
}

// §10c key-restriction probe. Returns RAW flags from Binance GET /sapi/v1/account/apiRestrictions;
// the probe-local keysValid is advisory — ModeControl.refreshKeyProbe independently recomputes the
// authoritative verdict from this snapshot (auditor S5), so a buggy/compromised probe cannot grant
// live. Withdrawals-enabled is the cardinal refusal (§10c: refused outright, never warned).
// NOTE: the Binance field names (enableWithdrawals / enableSpotAndMarginTrading / enableMargin /
// enableFutures) and the testnet NotSupported degradation must be confirmed against a real response
// during the out-of-session testnet RUN; urlCrossCheckOk is finalized in the composition-root wiring.
@Injectable()
export class KeyProbeService implements KeyProbePort {
  constructor(
    @Inject(CCXT_ORDER_CLIENT) private readonly client: CcxtOrderClient,
    @Inject(KEY_PROBE_CONFIG) private readonly cfg: KeyProbeConfig,
  ) {}

  async probe(): Promise<KeyProbeResult> {
    try {
      const r = await this.client.sapiGetAccountApiRestrictions();
      const withdrawalsEnabled = r['enableWithdrawals'] === true;
      const spotEnabled = r['enableSpotAndMarginTrading'] === true;
      const marginOrFutures = r['enableMargin'] === true || r['enableFutures'] === true;
      const keysValid = !withdrawalsEnabled && spotEnabled && !marginOrFutures;
      return { keysValid, withdrawalsEnabled, spotEnabled, marginOrFutures, keyFingerprint: this.cfg.keyFingerprint, urlCrossCheckOk: true };
    } catch {
      // Spot Testnet exposes no sapi (NotSupported); a network/permission error lands here too.
      if (this.cfg.requireRestrictions) {
        // Live: cannot confirm withdrawals are disabled ⇒ refuse (fail closed).
        return { keysValid: false, withdrawalsEnabled: true, spotEnabled: false, marginOrFutures: false, keyFingerprint: this.cfg.keyFingerprint, urlCrossCheckOk: true };
      }
      // Testnet: degrade to canTrade — the env/url gate carries the wall here, no real funds at risk.
      return { keysValid: true, withdrawalsEnabled: false, spotEnabled: true, marginOrFutures: false, keyFingerprint: this.cfg.keyFingerprint, urlCrossCheckOk: true };
    }
  }
}
