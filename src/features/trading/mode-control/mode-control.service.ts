import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CLOCK, type ClockPort } from '../../../ports/common/clock';
import {
  MODE_AUDIT,
  KEY_PROBE,
  MODE_CONTROL_CONFIG,
  ARM_PRECONDITIONS,
  ModeViolationError,
  type ModeControlPort,
  type ModeControlConfig,
  type ArmPreconditionsPort,
  type ArmRequest,
  type ArmResult,
  type ArmFailureReason,
  type ModeAuditPort,
  type KeyProbeResult,
  type KeyProbePort,
} from '../../../ports/trading/mode-control';
import { KILL_SWITCH, type KillSwitchPort } from '../../../ports/trading/risk';
import {
  INITIAL_ARMING,
  reduceArming,
  type ArmingState,
  type ArmFailure,
  type ArmingDeps,
} from '../../../domain/trading/mode/arming';
import {
  resolveMode,
  type ModeResolutionVector,
  type ModeResolution,
} from '../../../domain/trading/mode/resolution';
import type { TradingMode } from '../../../domain/trading/types/mode';
import { venueId, type VenueId } from '../../../domain/common/types/ids';
import { verifyArmingHmac } from './hmac';

// v3 §7.1: local venue-id copies (same idiom as key-probe.service.ts and position-sizer.service.ts —
// a shared venue-map module is deletion-list follow-up work, not this workstream's).
const SPOT_VENUE_ID = venueId('binance');
const PERP_VENUE_ID = venueId('binanceusdm');

// Maps the domain's five ArmFailure values onto the port's four ArmFailureReason values.
// BOOTID_MISMATCH → HMAC_MISMATCH: both indicate a proof that cannot be accepted; leaking
// which half failed would give an attacker a timing/oracle advantage.
// NO_CHALLENGE → PRECONDITION: the challenge slot is empty — a precondition for confirming.
const FAILURE_MAP: Record<ArmFailure, ArmFailureReason> = {
  TTL_EXPIRED: 'TTL_EXPIRED',
  REPLAY: 'REPLAY',
  HMAC_MISMATCH: 'HMAC_MISMATCH',
  BOOTID_MISMATCH: 'HMAC_MISMATCH',
  NO_CHALLENGE: 'PRECONDITION',
};

@Injectable()
export class ModeControlService implements ModeControlPort {
  private arming: ArmingState = INITIAL_ARMING;
  // v3 §7.2: gate (c) is now per-venue, both — the whole probeAll() snapshot, not a single result.
  private lastProbe: ReadonlyMap<VenueId, KeyProbeResult> | undefined;
  // Built once: the empty-string fallback only matters under test/ci (armingSecret undefined),
  // where the CONFIRM precondition refuses before the secret is ever used to verify a proof.
  private readonly armingDeps: ArmingDeps;

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(KEY_PROBE) private readonly keyProbe: KeyProbePort,
    @Inject(KILL_SWITCH) private readonly killSwitch: KillSwitchPort,
    @Inject(MODE_AUDIT) private readonly audit: ModeAuditPort,
    @Inject(ARM_PRECONDITIONS) private readonly preconditions: ArmPreconditionsPort,
    @Inject(MODE_CONTROL_CONFIG) private readonly cfg: ModeControlConfig,
  ) {
    this.armingDeps = { armingSecret: this.cfg.armingSecret ?? '', verifyHmac: verifyArmingHmac };
  }

  // Lazily enforces TTL on every public method call — no cron dependency.
  private tick(): void {
    const result = reduceArming(
      this.arming,
      { type: 'TICK', nowMs: this.clock.now() },
      this.armingDeps,
    );
    this.arming = result.state;
    if (result.effect === 'KILL_SWITCH_ENGAGE') {
      this.killSwitch.engage('ARMED_TTL_EXPIRED', false);
      this.audit.record({ type: 'disarmed', trigger: 'TTL' });
    }
  }

  resolveMode(): ModeResolution {
    this.tick();
    const vector: ModeResolutionVector = {
      requested: this.cfg.requested,
      envFlagLive: this.cfg.requested === 'live',
      armed: this.arming.kind === 'ARMED',
      keysValid: this.keysValid(),
      limitsComplete: this.cfg.limitsComplete,
      testnetKeysValid: this.keysValid(),
    };
    return resolveMode(vector);
  }

  // v3 §7.1/§7.2: the authoritative AND-aggregate over BOTH venues, recomputed here from the raw
  // per-venue flags — NEVER from either probe entry's own keysValid (auditor S5, carried into v3).
  // A missing venue entry (probe never run, or a probe implementation that dropped a venue) fails
  // CLOSED rather than vacuously passing over an empty/partial map.
  private keysValid(): boolean {
    const probe = this.lastProbe;
    if (probe === undefined) return false;
    const spot = probe.get(SPOT_VENUE_ID);
    const perp = probe.get(PERP_VENUE_ID);
    if (spot === undefined || perp === undefined) return false;
    return (
      this.venueKeysValid(spot, spot.spotEnabled) && this.venueKeysValid(perp, perp.futuresEnabled)
    );
  }

  // §7.1: withdrawals-disabled and margin-forbidden bind on every surface; surfaceEnabled carries
  // the venue-specific requirement (spotEnabled for spot, futuresEnabled for perp) — the perp
  // futures-requirement never weakens the spot margin prohibition or vice versa.
  private venueKeysValid(r: KeyProbeResult, surfaceEnabled: boolean): boolean {
    return !r.withdrawalsEnabled && surfaceEnabled && !r.marginEnabled && r.urlCrossCheckOk;
  }

  // §10b captured-token defence: the challenge and the verified HMAC bind to the process's OWN
  // bootId (cfg.bootId), NOT the client-supplied req.bootId. A token minted for a prior boot
  // therefore fails the HMAC against the new process's bootId after a restart — req.bootId is the
  // operator's (advisory) assertion of which instance they target, never the binding authority.
  armLive(req: ArmRequest): ArmResult {
    if (req.step === 'REQUEST') {
      this.tick();
      const challengeId = randomUUID();
      const result = reduceArming(
        this.arming,
        { type: 'REQUEST', challengeId, bootId: this.cfg.bootId, nowMs: this.clock.now() },
        this.armingDeps,
      );
      this.arming = result.state;
      this.audit.record({ type: 'arm_requested', bootId: this.cfg.bootId, challengeId });
      return { ok: true, challengeId };
    }

    // CONFIRM step. No tick() here: the CONFIRM reducer reports challenge TTL precisely
    // (TTL_EXPIRED), whereas a pre-tick would silently expire it to DISARMED and collapse the
    // signal to NO_CHALLENGE. The 8h ARMED expiry is enforced at REQUEST time and per-submission
    // resolveMode(), so a fresh REQUEST→CONFIRM flow always sees a current state.
    const nowMs = this.clock.now();

    // Preconditions checked before advancing the state machine. Gate (c) key validation stays OFF
    // this list deliberately (carried v2 design, re-verified for v3): the ArmingState transition
    // (REQUEST→CONFIRM→ARMED) and the derived EFFECTIVE mode are independent axes — the sacred 2⁴
    // matrix (test/livegate/live-gate-matrix.spec.ts) exercises `armed` and `keys` independently and
    // asserts `resolveMode().effective` for every combination, so CONFIRM itself must keep succeeding
    // on bad keys; resolveMode()'s keysValid() AND-gate (both venues) is what actually keeps effective
    // at 'paper'. The ArmingController still awaits refreshKeyProbe() immediately before CONFIRM
    // (§7.2 "at CONFIRM, fresh probe") so any resolveMode() call right after arming sees current data.
    if (
      !this.preconditions.check().ok ||
      this.killSwitch.state() !== 'RUNNING' ||
      this.cfg.armingSecret === undefined
    ) {
      this.audit.record({ type: 'arm_failed', reason: 'PRECONDITION' });
      return { ok: false, reason: 'PRECONDITION' };
    }

    const result = reduceArming(
      this.arming,
      { type: 'CONFIRM', hmacHex: req.hmacHex, bootId: this.cfg.bootId, nowMs },
      this.armingDeps,
    );
    this.arming = result.state;

    if (result.failure !== undefined) {
      const reason = FAILURE_MAP[result.failure];
      this.audit.record({ type: 'arm_failed', reason });
      return { ok: false, reason };
    }

    this.audit.record({ type: 'arm_confirmed', bootId: this.cfg.bootId });
    return { ok: true };
  }

  disarm(trigger: Parameters<ModeControlPort['disarm']>[0]): void {
    const result = reduceArming(this.arming, { type: 'DISARM', trigger }, this.armingDeps);
    this.arming = result.state;
    this.audit.record({ type: 'disarmed', trigger });
  }

  // Boot-authority check only. The effective-vs-stamp downgrade check (MODE_MISMATCH) is the
  // execution gate's responsibility in P8d — this method guards the static config authority.
  assertCanTrade(intentMode: TradingMode, intentId?: string): void {
    if (intentMode === 'live' && this.cfg.requested !== 'live') {
      this.audit.record({
        type: 'live_order_refused',
        intentId: intentId ?? '-',
        code: 'NOT_LIVE_AUTHORITY',
      });
      throw new ModeViolationError('NOT_LIVE_AUTHORITY', 'Live orders require live boot authority');
    }
  }

  // v3 §7.2: probes BOTH venues, audits each venue's raw restriction snapshot as its own row, then
  // recomputes the AND-aggregate (never trusting either entry's own keysValid — §10c / auditor S5).
  // ANY venue going invalid while ARMED disarms — "either-fails" (carried, now per-venue).
  async refreshKeyProbe(): Promise<void> {
    const probeMap = await this.keyProbe.probeAll();
    this.lastProbe = probeMap;
    for (const [venue, r] of probeMap) {
      this.audit.record({
        type: 'key_check',
        venue,
        withdrawalsEnabled: r.withdrawalsEnabled,
        spotEnabled: r.spotEnabled,
        futuresEnabled: r.futuresEnabled,
        marginEnabled: r.marginEnabled,
        urlCrossCheckOk: r.urlCrossCheckOk,
      });
    }
    if (!this.keysValid() && this.arming.kind === 'ARMED') {
      this.disarm('KEY_PROBE_FAILURE');
      this.killSwitch.engage('KEY_PROBE_FAILURE', false);
    }
  }
}
