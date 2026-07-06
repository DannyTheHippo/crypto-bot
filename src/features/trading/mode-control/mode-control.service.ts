import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CLOCK, type ClockPort } from '../../../ports/clock';
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
} from '../../../ports/mode-control';
import { KILL_SWITCH, type KillSwitchPort } from '../../../ports/risk';
import {
  INITIAL_ARMING,
  reduceArming,
  type ArmingState,
  type ArmFailure,
  type ArmingDeps,
} from '../../../domain/mode/arming';
import {
  resolveMode,
  type ModeResolutionVector,
  type ModeResolution,
} from '../../../domain/mode/resolution';
import type { TradingMode } from '../../../domain/types/mode';
import { verifyArmingHmac } from './hmac';

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
  private lastProbe: KeyProbeResult | undefined;
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
      keysValid: this.lastProbe?.keysValid ?? false,
      limitsComplete: this.cfg.limitsComplete,
      testnetKeysValid: this.lastProbe?.keysValid ?? false,
    };
    return resolveMode(vector);
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

    // Preconditions checked before advancing the state machine.
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

  async refreshKeyProbe(): Promise<void> {
    const r = await this.keyProbe.probe();
    // §10c / auditor S5: do NOT trust the probe's own keysValid — recompute the authoritative
    // verdict here from the restriction snapshot. Withdrawals-enabled is refused outright (never
    // warned); spot must be on; margin/futures absent; the venue URL must cross-check. A buggy or
    // compromised probe reporting keysValid:true while withdrawals are enabled cannot grant live.
    const keysValid =
      !r.withdrawalsEnabled && r.spotEnabled && !r.marginOrFutures && r.urlCrossCheckOk;
    this.lastProbe = { ...r, keysValid };
    this.audit.record({
      type: 'key_check',
      withdrawalsEnabled: r.withdrawalsEnabled,
      spotEnabled: r.spotEnabled,
      marginOrFutures: r.marginOrFutures,
      urlCrossCheckOk: r.urlCrossCheckOk,
    });
    if (!keysValid && this.arming.kind === 'ARMED') {
      this.disarm('KEY_PROBE_FAILURE');
      this.killSwitch.engage('KEY_PROBE_FAILURE', false);
    }
  }
}
