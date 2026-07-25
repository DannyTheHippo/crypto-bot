import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectMetric, makeCounterProvider } from '@willsoto/nestjs-prometheus';
import type { Counter } from 'prom-client';
import { KILL_SWITCH, type KillSwitchPort } from '../../../ports/trading/risk';
import { RECOVERY_CONFIG, type RecoveryConfig } from '../../../ports/trading/execution';
import { OPS_EVENTS, type OpsEventPort } from '../../../ports/common/observability';
import type { KillSwitchState } from '../../../domain/trading/risk/kill-switch';
import type { EpochMs } from '../../../domain/common/types/ids';
import { ReconciliationService } from './reconciliation.service';
import { EquityMonitorService } from './equity-monitor.service';
import { CrashRecoveryService } from './crash-recovery.service';

// This service's own DEBOUNCE (§5, mirrors HaltCoordinatorService's own 2-pass CANCEL_TIMEOUT
// precedent): a resume dispatches only on the SECOND consecutive clean evaluation pass — never the
// first. Any non-clean pass (a still-unresolved cause, a state change away from HALTED/
// HALTED_DEGRADED, or the flag being off) resets the counter to 0.
const REQUIRED_CLEAN_PASSES = 2;
// Staleness bound on the last clean reconcile stamp. Fail CLOSED: a scheduler outage reads as NOT
// clean, never a permanently-stale true.
//
// SIZED OFF MEASURED PRODUCTION BEHAVIOUR, not the nominal cadence (2026-07-22 soak). The driver's
// interval is 30s, but a pass over the 40-symbol/2-venue basket takes ~60s with the venues serialized,
// so the re-entrancy guard skips every other tick: measured 57-58 completed passes per venue per hour
// against 62 skipped (119 ≈ the 120 ticks/hour), i.e. an EFFECTIVE cadence of ~62s, not 30s.
//
// This compounds with reconcile()'s asymmetric stamping, which credits a CLEAN verdict to the instant
// the pass STARTED (the earliest moment its observations can describe — see that method's comment). A
// pass starting at T and completing at T+60s therefore lands a stamp that is ALREADY ~60s old. The
// original 60_000 — chosen as "2× a 30s cadence" — would thus read stale almost immediately after
// every pass, leaving auto-resume fail-closed-INERT: safe, but never actually firing.
//
// 180s ≈ 3× the measured effective cadence: still a real staleness bound (a genuine reconcile outage
// ages out well inside it), but wide enough that normal timing does not permanently veto a resume.
// Re-derive this if the basket size, venue count, or pass duration changes materially.
const RECONCILE_FRESHNESS_MS = 180_000;

// The four halt causes this service knows how to positively confirm cleared, each keyed off the
// exact reason-string prefix KillSwitchService.reason() carries for that cause
// (kill-switch.service.ts callers: reconciliation.service.ts / unknown-resolver.service.ts /
// equity-monitor.service.ts). ANY OTHER reason (a manual admin engage(), UnknownResolverService's
// own QUERY_AUTH_FATAL:<code>, or any future cause) is UNRECOGNIZED — see allConditionsClear's own
// fail-closed default. Also doubles as the Prometheus/OpsEvent `reason` label.
type Cause =
  | 'reconcile_mismatch'
  | 'unknown_unresolved'
  | 'max_drawdown'
  | 'daily_loss'
  | 'unrecognized';

function classifyCause(reason: string): Cause {
  if (reason.startsWith('RECONCILE_MISMATCH')) return 'reconcile_mismatch';
  if (reason === 'UNKNOWN_UNRESOLVED_60S') return 'unknown_unresolved';
  if (reason === 'MAX_DRAWDOWN') return 'max_drawdown';
  if (reason === 'DAILY_LOSS') return 'daily_loss';
  return 'unrecognized';
}

// §12 recovery program. Owner-authorized 2026-07-22, fully informed: FULL auto-resume in all modes
// incl. live, chosen over the recommended mode-scoped option after the real-money risk (a live kill
// switch clearing without human review) was disclosed. Safety is preserved by per-cause
// condition-clearing + preconditions + debounce (never resume an unresolved cause) + full
// observability, NOT by a human gate. Disableable via RECOVERY_AUTO_RESUME_ENABLED.
//
// CURRENT OPERATIONAL REALITY (2026-07-22, security-review correction S1): the paragraph above is
// the AUTHORIZATION scope — the owner declined to have this artificially restricted to paper/testnet
// IN CODE. It is NOT a claim that auto-resume is presently active in every mode. The universal
// reconcile-clean precondition (ReconciliationService.cleanWithin/cleanAfter) can only ever read true
// where a reconcile cadence actually runs a fresh pass, and trading-runtime.module.ts's scheduled 30s
// reconcile() call is registered ONLY for mode === 'paper' || 'testnet' (~line 446) — live has none
// today. Consequently this service is fail-closed-INERT for every cause while running live right
// now: not via a mode check anywhere in this file, but as an emergent property of the missing live
// reconcile cadence (cleanWithin/cleanAfter permanently false there, so allConditionsClear always
// returns false). Wiring a live reconcile scheduler is a separate, larger change, deliberately NOT
// part of this diff — until it lands, a live HALT can only be cleared by a process restart.
//
// Wired into the SAME 1s tick cadence as HaltCoordinatorService/UnknownResolverService
// (trading-runtime.module.ts). While the kill switch is HALTED/HALTED_DEGRADED, every tick
// re-evaluates ALL FOUR generic conditions below UNCONDITIONALLY — never gated on which cause the
// CURRENT reason string names. This is deliberate: KillSwitchService.engage() overwrites
// `lastReason` on every call, even one the reducer ignores because the switch is already halted (see
// that method's own comment) — a later, unrelated engage() (e.g. a fresh RECONCILE_MISMATCH firing
// mid a DAILY_LOSS halt) would otherwise make a reason-keyed check skip re-verifying the ORIGINAL
// cause. Requiring every condition always, regardless of which reason currently reads, closes that
// race — strictly safer than branching, never resumes on fewer confirmations than the reason string
// alone would imply. `cause` is classified purely for the fail-closed "unrecognized reason ⇒ never
// resume" gate and for the observability label.
//
// Security-review fix (2026-07-22, M1 — resumes into an unresolved cause): the reconcile-clean check
// is NOT just "was there ever a clean pass within the freshness window" (cleanWithin alone) — a
// reconcile pass that ran clean BEFORE the halt engaged would still read "fresh" for up to
// RECONCILE_FRESHNESS_MS afterward, letting a RECONCILE_MISMATCH halt auto-resume in ~2 ticks without
// a SINGLE post-halt reconcile pass ever re-examining the diverged state. `haltedSinceAt` (tracked
// below, off observed reason() changes — see tick()'s own comment) is threaded into
// ReconciliationService.cleanAfter so the precondition is "a clean pass genuinely happened AFTER the
// currently-active problem was flagged", never merely "recently". Second-round fix (M1-residual):
// haltedSinceAt re-arms only on a reason-STRING change, but a same-cause re-halt re-engages a
// byte-identical RECONCILE_MISMATCH string — so a clean stamp between two dirty passes of the same
// drift would still pass cleanAfter. ReconciliationService.cleanIsLatest (added to allConditionsClear)
// closes it: the MOST RECENT pass must have closed clean, regardless of the reason string.
//
// FAIL CLOSED (declared per rules/code-hygiene.md's failure-direction convention): every check below
// is a permission/safety gate, not a measurement — an exception, a stale or pre-halt reconcile
// signal, an unresolved order, an unrecognized cause, or fewer than REQUIRED_CLEAN_PASSES consecutive
// clean evaluations all resolve to "stay halted", never to "resume anyway".
//
// resume() ≠ live authority: dispatching KillSwitchPort.resume() returns an ALREADY-AUTHORIZED
// mode's kill switch from HALTED/HALTED_DEGRADED to RUNNING within that SAME mode. It never touches
// the four live gates, the bootId-bound arming ceremony, PromotionReadinessService, or resolveMode()
// — those remain the sole path to real-money trading (CLAUDE.md rule 3, §10).
@Injectable()
export class RecoveryCoordinatorService {
  private readonly log = new Logger(RecoveryCoordinatorService.name);
  private cleanPasses = 0;
  // M1 fix: when the CURRENTLY-active problem was first observed — the instant reconcile-clean
  // freshness is measured against (see tick()'s own comment on why this is reason-change-keyed, not
  // a fixed halt-onset timestamp). undefined while RUNNING.
  private haltedSinceAt: EpochMs | undefined;
  private lastObservedReason: string | undefined;
  // EquityMonitorService.observationSeq() as of the last COUNTED clean pass. The debounce requires this
  // to advance between passes so two clean ticks are two independent equity observations — see the
  // guard in tick(). undefined whenever cleanPasses is 0.
  private lastCleanObsSeq: number | undefined;

  constructor(
    @Inject(KILL_SWITCH) private readonly killSwitch: KillSwitchPort,
    @Inject(RECOVERY_CONFIG) private readonly config: RecoveryConfig,
    private readonly reconciliation: ReconciliationService,
    private readonly equityMonitor: EquityMonitorService,
    private readonly crashRecovery: CrashRecoveryService,
    // Backlog #52 convention: diagnostic side-channel, never a control-flow input — @Optional so a
    // directly-constructed unit test keeps constructing without it.
    @Optional()
    @Inject(OPS_EVENTS)
    private readonly opsEvents?: OpsEventPort,
    @Optional()
    @InjectMetric('recovery_auto_resume_total')
    private readonly resumeCounter?: Counter<string>,
  ) {}

  // Synchronous by construction: every check below (hasUnresolvedOrders/cleanWithin/causeCleared) is
  // an in-memory read, deliberately never a fresh network call (see this class's own header comment
  // and reconciliation.service.ts's cleanWithin doc on why reconcile() itself is never called here).
  // The caller (trading-runtime.module.ts) still wraps this in Promise.resolve(...).catch(...), the
  // SAME fire-and-forget convention every other 1s-cadence tick uses.
  tick(now: EpochMs): void {
    if (!this.config.autoResumeEnabled) return; // flag off: exactly today's manual-only behavior
    const state = this.killSwitch.state();
    if (state === 'RUNNING') {
      this.cleanPasses = 0;
      this.haltedSinceAt = undefined; // episode over — the next halt starts a fresh freshness clock
      this.lastObservedReason = undefined;
      this.lastCleanObsSeq = undefined;
      return;
    }

    // M1 fix (security review): `haltedSinceAt` moves forward to `now` the first time this halt
    // episode is observed AND every time the reason changes thereafter. KillSwitchService.engage()
    // overwrites `lastReason` on EVERY call, even one the reducer ignores because the switch is
    // already halted (see that method's own comment) — a reason change while still HALTED/
    // HALTED_DEGRADED is this service's only signal that a FRESH problem was just flagged, and a
    // reconcile pass from before that moment can no longer positively confirm THIS problem cleared.
    // A stable, unchanged reason across passes (the SAME persisting issue) never bumps this.
    const reason = this.killSwitch.reason();
    if (this.haltedSinceAt === undefined || reason !== this.lastObservedReason) {
      this.haltedSinceAt = now;
      this.lastObservedReason = reason;
    }

    if (state !== 'HALTED' && state !== 'HALTED_DEGRADED') {
      this.cleanPasses = 0; // still draining (HALTING/FLATTENING) — not yet eligible to evaluate
      this.lastCleanObsSeq = undefined;
      return;
    }

    const cause = classifyCause(reason);
    if (!this.allConditionsClear(cause, now, this.haltedSinceAt)) {
      this.cleanPasses = 0;
      this.lastCleanObsSeq = undefined;
      return;
    }

    // DEBOUNCE INDEPENDENCE (security review, 2026-07-22): REQUIRED_CLEAN_PASSES only means anything if
    // consecutive clean passes are consecutive OBSERVATIONS. This service ticks at 1s but equity is
    // rewritten every 5s, so without this guard 4 of every 5 tick pairs would "confirm" the same sample
    // twice and the debounce would protect against nothing. Requiring the sequence to advance makes the
    // two passes genuinely independent. Fail CLOSED: a throwing counter resets the debounce entirely.
    let obsSeq: number;
    try {
      obsSeq = this.equityMonitor.observationSeq();
    } catch {
      this.cleanPasses = 0;
      this.lastCleanObsSeq = undefined;
      return;
    }
    if (this.cleanPasses > 0 && obsSeq === this.lastCleanObsSeq) return; // same sample — not independent
    this.lastCleanObsSeq = obsSeq;

    this.cleanPasses += 1;
    if (this.cleanPasses < REQUIRED_CLEAN_PASSES) return; // debounce: one clean pass is not enough

    this.cleanPasses = 0;
    this.lastCleanObsSeq = undefined;
    this.killSwitch.resume();
    this.emitObservability(state, cause);
  }

  private allConditionsClear(cause: Cause, now: EpochMs, haltedSinceAt: EpochMs): boolean {
    // Fail CLOSED: an unrecognized halt cause (manual admin engage, QUERY_AUTH_FATAL, or any future
    // cause this service was never taught to positively confirm cleared) NEVER auto-resumes, no
    // matter how healthy the four generic checks below look.
    if (cause === 'unrecognized') return false;

    // Universal precondition, ALL causes (mirrors arm-preconditions.module.ts:25-52's fail-closed
    // try/catch shape): a throw from any check below is "cannot positively confirm" — stay halted.
    try {
      if (this.crashRecovery.hasUnresolvedOrders()) return false;
    } catch {
      return false;
    }
    try {
      // All three required (M1 + M1-residual). cleanWithin is the staleness bound (never remove — a
      // healthy operation with no halt in progress still needs it); cleanAfter is the post-halt
      // freshness bound (a clean pass must have happened AFTER the currently-active problem was
      // flagged); cleanIsLatest is the no-re-dirty bound (the MOST RECENT pass closed clean). The
      // third closes a residual hole the first two miss: a same-cause re-halt re-engages a
      // byte-identical RECONCILE_MISMATCH reason, so haltedSinceAt (reason-change-keyed) never
      // re-arms, and a clean stamp predating the re-dirty still satisfies cleanWithin/cleanAfter (see
      // ReconciliationService.cleanIsLatest's own doc). None alone is sufficient.
      if (!this.reconciliation.cleanWithin(RECONCILE_FRESHNESS_MS, now)) return false;
      if (!this.reconciliation.cleanAfter(haltedSinceAt)) return false;
      if (!this.reconciliation.cleanIsLatest()) return false;
    } catch {
      return false;
    }
    // Checked unconditionally regardless of `cause` — see this class's own header comment on why.
    try {
      if (!this.equityMonitor.causeCleared('MAX_DRAWDOWN')) return false;
      if (!this.equityMonitor.causeCleared('DAILY_LOSS')) return false;
    } catch {
      return false;
    }
    return true;
  }

  private emitObservability(from: KillSwitchState, cause: Cause): void {
    // A resume must never be silent — three independent channels, per the recovery program's
    // observability mandate (this replaces the human's eyes for this decision).
    this.log.warn(
      `auto-resume: kill switch ${from} → RUNNING (cause=${cause}, RECOVERY_AUTO_RESUME_ENABLED=true)`,
    );
    try {
      this.resumeCounter?.inc({ reason: cause });
    } catch {
      /* metrics must never throw into a trading path */
    }
    try {
      // N4 (security review): a throwing observer must never propagate into the resume path — the
      // resume itself has already committed by the time this fires (see the counter's own guard,
      // same convention).
      this.opsEvents?.emit({ event: 'recovery.auto_resume', from, reason: cause });
    } catch {
      /* observability must never throw into a trading path */
    }
  }
}

// §8-style visibility mirror (RECON_MISMATCH_COUNTER/ORDERS_COUNTER's own convention: a counter
// defined next to its owning service, NOT in features/common/observability — execution cannot import
// that feature, eslint-plugin-boundaries' features/*/* wall). Registers to the default prom-client
// registry that /metrics scrapes; @Optional above so a directly-constructed unit test need not supply
// it.
export const RECOVERY_AUTO_RESUME_COUNTER = makeCounterProvider({
  name: 'recovery_auto_resume_total',
  help: 'Kill-switch auto-resumes dispatched by RecoveryCoordinatorService, by cause (owner-authorized recovery program, 2026-07-22)',
  labelNames: ['reason'] as const,
});
