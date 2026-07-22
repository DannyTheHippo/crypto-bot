import { describe, it, expect } from 'vitest';
import type { Counter } from 'prom-client';
import { RecoveryCoordinatorService } from '../../../src/features/trading/execution/recovery-coordinator.service';
import { KillSwitchService } from '../../../src/features/trading/risk/kill-switch.service';
import type { CrashRecoveryService } from '../../../src/features/trading/execution/crash-recovery.service';
import type { ReconciliationService } from '../../../src/features/trading/execution/reconciliation.service';
import type { EquityMonitorService } from '../../../src/features/trading/execution/equity-monitor.service';
import type { RecoveryConfig } from '../../../src/ports/execution';
import type { OpsEvent, OpsEventPort } from '../../../src/ports/observability';
import { epochMs } from '../../../src/domain/types/ids';

const T = epochMs(1_700_000_000_000);

interface BuildOpts {
  autoResumeEnabled?: boolean;
  unresolved?: boolean;
  // Maps to ReconciliationService.cleanWithin — the staleness bound.
  reconcileFresh?: boolean;
  // Maps to ReconciliationService.cleanAfter — the M1 post-halt-freshness bound. Defaults true so
  // every pre-existing "resumes..." test's intent (both dimensions healthy) is unaffected; the
  // dedicated M1 test below exercises this independently of reconcileFresh.
  reconcileAfterHalt?: boolean;
  // Maps to ReconciliationService.cleanIsLatest — the M1-residual no-re-dirty bound (the MOST RECENT
  // pass closed clean). Defaults true so pre-existing tests are unaffected; the dedicated M1-residual
  // test exercises it independently.
  reconcileIsLatest?: boolean;
  drawdownCleared?: boolean;
  dailyLossCleared?: boolean;
  // Pins EquityMonitorService.observationSeq() CONSTANT, i.e. every tick reads the SAME 5s-old equity
  // sample — the condition the debounce-independence guard exists to reject.
  freezeObservations?: boolean;
}

function build(opts: BuildOpts = {}) {
  const killSwitch = new KillSwitchService();
  const crashRecovery = {
    hasUnresolvedOrders: () => opts.unresolved ?? false,
  } as unknown as CrashRecoveryService;
  const reconciliation = {
    cleanWithin: () => opts.reconcileFresh ?? true,
    cleanAfter: () => opts.reconcileAfterHalt ?? true,
    cleanIsLatest: () => opts.reconcileIsLatest ?? true,
  } as unknown as ReconciliationService;
  // observationSeq advances on every read so consecutive ticks look like consecutive equity samples —
  // the default that keeps every pre-existing "resumes after 2 passes" test meaning what it always did.
  // The dedicated debounce-independence test below pins it CONSTANT to exercise the guard.
  let obsSeq = 0;
  const equityMonitor = {
    causeCleared: (cause: 'MAX_DRAWDOWN' | 'DAILY_LOSS') =>
      cause === 'MAX_DRAWDOWN' ? (opts.drawdownCleared ?? true) : (opts.dailyLossCleared ?? true),
    observationSeq: () => (opts.freezeObservations === true ? 1 : ++obsSeq),
  } as unknown as EquityMonitorService;
  const config: RecoveryConfig = { autoResumeEnabled: opts.autoResumeEnabled ?? true };
  const events: OpsEvent[] = [];
  const opsEvents: OpsEventPort = { emit: (e) => void events.push(e) };
  const counterCalls: Array<Record<string, string>> = [];
  const counter = {
    inc: (labels: Record<string, string>) => void counterCalls.push(labels),
  } as unknown as Counter<string>;
  const service = new RecoveryCoordinatorService(
    killSwitch,
    config,
    reconciliation,
    equityMonitor,
    crashRecovery,
    opsEvents,
    counter,
  );
  return { killSwitch, service, events, counterCalls };
}

// Drives the real reducer through HALTING → HALTED (or → FLATTENING → HALTED when the cause
// flattens), exactly the progression HaltCoordinatorService drives in production.
function haltFor(killSwitch: KillSwitchService, reason: string, flatten: boolean): void {
  killSwitch.engage(reason, flatten);
  killSwitch.confirmCancels();
  if (flatten) killSwitch.allFlat();
}

function haltDegradedFor(killSwitch: KillSwitchService, reason: string): void {
  killSwitch.engage(reason, false);
  killSwitch.cancelTimeout();
}

describe('RecoveryCoordinatorService (owner-authorized auto-resume, 2026-07-22)', () => {
  it('resumes a RECONCILE_MISMATCH halt after 2 consecutive clean passes, not after 1', () => {
    const { killSwitch, service } = build();
    haltFor(killSwitch, 'RECONCILE_MISMATCH:BALANCE_DRIFT:USDT', false);
    expect(killSwitch.state()).toBe('HALTED');

    service.tick(T);
    expect(killSwitch.state()).toBe('HALTED'); // 1 clean pass is not enough — debounce

    service.tick(T);
    expect(killSwitch.state()).toBe('RUNNING'); // 2nd consecutive clean pass resumes
  });

  // Security-review M1 (critical — resumes into an unresolved cause): cleanWithin ALONE cannot tell
  // a genuinely-post-halt clean pass apart from a stale PRE-halt one still inside the freshness
  // window — this is the exact exploit the review found (a RECONCILE_MISMATCH halt auto-resuming in
  // ~2s off a clean stamp that predates the halt, without a single fresh reconcile pass ever
  // re-examining the diverged state). cleanAfter closes it.
  it('M1: a RECONCILE_MISMATCH halt does NOT resume on a stale pre-halt clean stamp — only a clean pass genuinely AFTER the halt counts', () => {
    let afterHaltClean = false; // only a PRE-halt clean stamp exists: cleanWithin reads fresh, cleanAfter does not
    const killSwitch = new KillSwitchService();
    const crashRecovery = { hasUnresolvedOrders: () => false } as unknown as CrashRecoveryService;
    const reconciliation = {
      cleanWithin: () => true, // still "fresh" by the 60s window — exactly the trap M1 found
      cleanAfter: () => afterHaltClean,
      cleanIsLatest: () => true, // latest pass clean throughout — isolates the cleanAfter dimension
    } as unknown as ReconciliationService;
    let obsSeq = 0;
    const equityMonitor = {
      causeCleared: () => true,
      observationSeq: () => ++obsSeq,
    } as unknown as EquityMonitorService;
    const service = new RecoveryCoordinatorService(
      killSwitch,
      { autoResumeEnabled: true },
      reconciliation,
      equityMonitor,
      crashRecovery,
    );
    haltFor(killSwitch, 'RECONCILE_MISMATCH:BALANCE_DRIFT:USDT', false);

    // Many ticks pass with only the stale pre-halt clean stamp available — must never resume, no
    // matter how many passes accumulate (this is NOT a debounce-count problem, it's a freshness one).
    for (let i = 0; i < 10; i++) service.tick(T);
    expect(killSwitch.state()).toBe('HALTED');

    // A genuine post-halt clean reconcile pass completes.
    afterHaltClean = true;
    service.tick(T);
    expect(killSwitch.state()).toBe('HALTED'); // debounce: 1 post-halt clean pass is still not enough
    service.tick(T);
    expect(killSwitch.state()).toBe('RUNNING'); // 2nd consecutive post-halt clean pass resumes
  });

  // Security-review M1-residual (the first M1 fix's blind spot): a same-cause re-halt re-engages a
  // byte-identical RECONCILE_MISMATCH reason string, so haltedSinceAt (reason-change-keyed) never
  // re-arms — a clean stamp captured BETWEEN two dirty passes of the same drift still satisfies BOTH
  // cleanWithin (fresh) AND cleanAfter (after the un-re-armed haltedSinceAt). cleanIsLatest is the
  // backstop: while the MOST RECENT reconcile pass is dirty, the gate stays closed regardless.
  it('M1-residual: does NOT resume while the latest reconcile pass is dirty, even though cleanWithin+cleanAfter both still read true off the pre-re-dirty clean stamp', () => {
    let latestClean = false; // a fresh dirty pass has landed since the last clean stamp
    const killSwitch = new KillSwitchService();
    const crashRecovery = { hasUnresolvedOrders: () => false } as unknown as CrashRecoveryService;
    const reconciliation = {
      cleanWithin: () => true, // the pre-re-dirty clean stamp is still inside the 60s window
      cleanAfter: () => true, // ...and still reads "after" the (un-re-armed) haltedSinceAt — the trap
      cleanIsLatest: () => latestClean,
    } as unknown as ReconciliationService;
    let obsSeq = 0;
    const equityMonitor = {
      causeCleared: () => true,
      observationSeq: () => ++obsSeq,
    } as unknown as EquityMonitorService;
    const service = new RecoveryCoordinatorService(
      killSwitch,
      { autoResumeEnabled: true },
      reconciliation,
      equityMonitor,
      crashRecovery,
    );
    haltFor(killSwitch, 'RECONCILE_MISMATCH:BALANCE_DRIFT:USDT', false);

    // The latest reconcile pass is dirty (a re-drift after an earlier clean stamp) — must never
    // resume no matter how many ticks accumulate, despite cleanWithin AND cleanAfter both true.
    for (let i = 0; i < 10; i++) service.tick(T);
    expect(killSwitch.state()).toBe('HALTED');

    // A genuinely-latest clean reconcile pass finally completes.
    latestClean = true;
    service.tick(T);
    expect(killSwitch.state()).toBe('HALTED'); // debounce: 1 clean pass is still not enough
    service.tick(T);
    expect(killSwitch.state()).toBe('RUNNING'); // 2nd consecutive latest-clean pass resumes
  });

  it('resumes an UNKNOWN_UNRESOLVED_60S halt once hasUnresolvedOrders() reports clear', () => {
    const { killSwitch, service } = build();
    haltFor(killSwitch, 'UNKNOWN_UNRESOLVED_60S', false);

    service.tick(T);
    service.tick(T);
    expect(killSwitch.state()).toBe('RUNNING');
  });

  it('resumes a MAX_DRAWDOWN halt (flatten=true, → FLATTENING → HALTED) once drawdown clears', () => {
    const { killSwitch, service } = build({ drawdownCleared: true });
    haltFor(killSwitch, 'MAX_DRAWDOWN', true);
    expect(killSwitch.state()).toBe('HALTED');

    service.tick(T);
    service.tick(T);
    expect(killSwitch.state()).toBe('RUNNING');
  });

  it('resumes a DAILY_LOSS halt once the daily-loss cause clears', () => {
    const { killSwitch, service } = build({ dailyLossCleared: true });
    haltFor(killSwitch, 'DAILY_LOSS', false);

    service.tick(T);
    service.tick(T);
    expect(killSwitch.state()).toBe('RUNNING');
  });

  it('resumes from HALTED_DEGRADED (cancel-timeout path), not just HALTED', () => {
    const { killSwitch, service } = build();
    haltDegradedFor(killSwitch, 'RECONCILE_MISMATCH:FILL_FOR_UNKNOWN_ORDER');
    expect(killSwitch.state()).toBe('HALTED_DEGRADED');

    service.tick(T);
    service.tick(T);
    expect(killSwitch.state()).toBe('RUNNING');
  });

  it('stays halted (fail closed) when the SAME reason keeps reporting unresolved orders', () => {
    const { killSwitch, service } = build({ unresolved: true });
    haltFor(killSwitch, 'UNKNOWN_UNRESOLVED_60S', false);

    service.tick(T);
    service.tick(T);
    service.tick(T);
    expect(killSwitch.state()).toBe('HALTED');
  });

  it('stays halted (fail closed) when reconcile has no fresh clean pass to confirm', () => {
    const { killSwitch, service } = build({ reconcileFresh: false });
    haltFor(killSwitch, 'RECONCILE_MISMATCH:BALANCE_DRIFT:USDT', false);

    service.tick(T);
    service.tick(T);
    expect(killSwitch.state()).toBe('HALTED');
  });

  it('stays halted (fail closed) on a MAX_DRAWDOWN halt while drawdown is still tripped', () => {
    const { killSwitch, service } = build({ drawdownCleared: false });
    haltFor(killSwitch, 'MAX_DRAWDOWN', true);

    service.tick(T);
    service.tick(T);
    expect(killSwitch.state()).toBe('HALTED');
  });

  it('stays halted (fail closed) on a DAILY_LOSS halt while the daily-loss window has not reset', () => {
    const { killSwitch, service } = build({ dailyLossCleared: false });
    haltFor(killSwitch, 'DAILY_LOSS', false);

    service.tick(T);
    service.tick(T);
    expect(killSwitch.state()).toBe('HALTED');
  });

  // The reason-overwrite race guard: EVERY condition is checked on EVERY pass, unconditionally,
  // regardless of which reason string is currently stamped — never resumes on fewer confirmations
  // than the reason string alone would imply.
  it('stays halted on a RECONCILE_MISMATCH-reasoned halt while drawdown is independently still tripped', () => {
    const { killSwitch, service } = build({ drawdownCleared: false });
    haltFor(killSwitch, 'RECONCILE_MISMATCH:BALANCE_DRIFT:USDT', false);

    service.tick(T);
    service.tick(T);
    expect(killSwitch.state()).toBe('HALTED');
  });

  it('never resumes an unrecognized cause (e.g. QUERY_AUTH_FATAL) even when every generic check is clean', () => {
    const { killSwitch, service } = build();
    haltFor(killSwitch, 'QUERY_AUTH_FATAL:InvalidSignature', false);

    for (let i = 0; i < 5; i++) service.tick(T);
    expect(killSwitch.state()).toBe('HALTED');
  });

  it('does not resume when RECOVERY_AUTO_RESUME_ENABLED is false, no matter how many clean passes', () => {
    const { killSwitch, service } = build({ autoResumeEnabled: false });
    haltFor(killSwitch, 'RECONCILE_MISMATCH:BALANCE_DRIFT:USDT', false);

    for (let i = 0; i < 5; i++) service.tick(T);
    expect(killSwitch.state()).toBe('HALTED');
  });

  it('debounce resets on a dirty pass between two clean ones — resumes on the 4th tick, not the 3rd', () => {
    let unresolved = false;
    const killSwitch = new KillSwitchService();
    const crashRecovery = {
      hasUnresolvedOrders: () => unresolved,
    } as unknown as CrashRecoveryService;
    const reconciliation = {
      cleanWithin: () => true,
      cleanAfter: () => true,
      cleanIsLatest: () => true,
    } as unknown as ReconciliationService;
    let obsSeq = 0;
    const equityMonitor = {
      causeCleared: () => true,
      observationSeq: () => ++obsSeq,
    } as unknown as EquityMonitorService;
    const service = new RecoveryCoordinatorService(
      killSwitch,
      { autoResumeEnabled: true },
      reconciliation,
      equityMonitor,
      crashRecovery,
    );
    haltFor(killSwitch, 'UNKNOWN_UNRESOLVED_60S', false);

    service.tick(T); // clean pass 1
    unresolved = true;
    service.tick(T); // dirty pass — resets the debounce counter
    unresolved = false;
    service.tick(T); // clean pass 1 (again)
    expect(killSwitch.state()).toBe('HALTED');
    service.tick(T); // clean pass 2
    expect(killSwitch.state()).toBe('RUNNING');
  });

  // Security review 2026-07-22: this service ticks at 1s but EquitySamplerService rewrites equity every
  // 5s, so without an independence guard 4 of every 5 tick pairs "confirm" the SAME sample twice and
  // REQUIRED_CLEAN_PASSES protects against nothing.
  it('debounce independence: two clean ticks reading the SAME equity observation are not two confirmations', () => {
    let seq = 7; // frozen — the 5s sampler has not written a fresh equity value yet
    const killSwitch = new KillSwitchService();
    const crashRecovery = { hasUnresolvedOrders: () => false } as unknown as CrashRecoveryService;
    const reconciliation = {
      cleanWithin: () => true,
      cleanAfter: () => true,
      cleanIsLatest: () => true,
    } as unknown as ReconciliationService;
    const equityMonitor = {
      causeCleared: () => true,
      observationSeq: () => seq,
    } as unknown as EquityMonitorService;
    const service = new RecoveryCoordinatorService(
      killSwitch,
      { autoResumeEnabled: true },
      reconciliation,
      equityMonitor,
      crashRecovery,
    );
    haltFor(killSwitch, 'DAILY_LOSS', false);

    // Every generic condition reads clear, but the equity sample never changes — 10 ticks must not be
    // mistaken for 10 independent confirmations.
    for (let i = 0; i < 10; i++) service.tick(T);
    expect(killSwitch.state()).toBe('HALTED');

    seq = 8; // the sampler finally writes a genuinely fresh observation
    service.tick(T);
    expect(killSwitch.state()).toBe('RUNNING'); // now the second pass is independent
  });

  it('never evaluates while RUNNING/HALTING/FLATTENING — only HALTED/HALTED_DEGRADED', () => {
    const { killSwitch, service } = build();
    expect(killSwitch.state()).toBe('RUNNING');
    service.tick(T);
    expect(killSwitch.state()).toBe('RUNNING'); // no-op, never throws on a healthy switch
  });

  it('emits recovery.auto_resume + increments recovery_auto_resume_total{reason} + warn-logs, only on the resuming tick', () => {
    const { killSwitch, service, events, counterCalls } = build();
    haltFor(killSwitch, 'DAILY_LOSS', false);

    service.tick(T);
    expect(events).toHaveLength(0);
    expect(counterCalls).toHaveLength(0);

    service.tick(T);
    expect(killSwitch.state()).toBe('RUNNING');
    expect(events).toEqual([
      { event: 'recovery.auto_resume', from: 'HALTED', reason: 'daily_loss' },
    ]);
    expect(counterCalls).toEqual([{ reason: 'daily_loss' }]);
  });

  it('does not evaluate while still draining (HALTING, not yet settled) — resets debounce, never throws', () => {
    const { killSwitch, service } = build();
    killSwitch.engage('RECONCILE_MISMATCH:BALANCE_DRIFT:USDT', false); // → HALTING only, cancels not yet confirmed
    expect(killSwitch.state()).toBe('HALTING');
    expect(() => service.tick(T)).not.toThrow();
    expect(killSwitch.state()).toBe('HALTING'); // untouched — not yet HALTED/HALTED_DEGRADED
  });

  it('fail closed: a throwing hasUnresolvedOrders() stays halted and never propagates', () => {
    const killSwitch = new KillSwitchService();
    const crashRecovery = {
      hasUnresolvedOrders: () => {
        throw new Error('crash-recovery boom');
      },
    } as unknown as CrashRecoveryService;
    const reconciliation = {
      cleanWithin: () => true,
      cleanAfter: () => true,
      cleanIsLatest: () => true,
    } as unknown as ReconciliationService;
    let obsSeq = 0;
    const equityMonitor = {
      causeCleared: () => true,
      observationSeq: () => ++obsSeq,
    } as unknown as EquityMonitorService;
    const service = new RecoveryCoordinatorService(
      killSwitch,
      { autoResumeEnabled: true },
      reconciliation,
      equityMonitor,
      crashRecovery,
    );
    haltFor(killSwitch, 'UNKNOWN_UNRESOLVED_60S', false);

    expect(() => {
      service.tick(T);
      service.tick(T);
    }).not.toThrow();
    expect(killSwitch.state()).toBe('HALTED');
  });

  it('fail closed: a throwing cleanWithin/cleanAfter stays halted and never propagates', () => {
    const killSwitch = new KillSwitchService();
    const crashRecovery = { hasUnresolvedOrders: () => false } as unknown as CrashRecoveryService;
    const reconciliation = {
      cleanWithin: () => {
        throw new Error('reconciliation boom');
      },
      cleanAfter: () => true,
      cleanIsLatest: () => true,
    } as unknown as ReconciliationService;
    let obsSeq = 0;
    const equityMonitor = {
      causeCleared: () => true,
      observationSeq: () => ++obsSeq,
    } as unknown as EquityMonitorService;
    const service = new RecoveryCoordinatorService(
      killSwitch,
      { autoResumeEnabled: true },
      reconciliation,
      equityMonitor,
      crashRecovery,
    );
    haltFor(killSwitch, 'RECONCILE_MISMATCH:BALANCE_DRIFT:USDT', false);

    expect(() => {
      service.tick(T);
      service.tick(T);
    }).not.toThrow();
    expect(killSwitch.state()).toBe('HALTED');
  });

  it('fail closed: a throwing causeCleared stays halted and never propagates', () => {
    const killSwitch = new KillSwitchService();
    const crashRecovery = { hasUnresolvedOrders: () => false } as unknown as CrashRecoveryService;
    const reconciliation = {
      cleanWithin: () => true,
      cleanAfter: () => true,
      cleanIsLatest: () => true,
    } as unknown as ReconciliationService;
    const equityMonitor = {
      causeCleared: () => {
        throw new Error('equity-monitor boom');
      },
      observationSeq: () => 1,
    } as unknown as EquityMonitorService;
    const service = new RecoveryCoordinatorService(
      killSwitch,
      { autoResumeEnabled: true },
      reconciliation,
      equityMonitor,
      crashRecovery,
    );
    haltFor(killSwitch, 'DAILY_LOSS', false);

    expect(() => {
      service.tick(T);
      service.tick(T);
    }).not.toThrow();
    expect(killSwitch.state()).toBe('HALTED');
  });

  it('fail closed: a throwing observationSeq stays halted and never propagates', () => {
    const killSwitch = new KillSwitchService();
    const crashRecovery = { hasUnresolvedOrders: () => false } as unknown as CrashRecoveryService;
    const reconciliation = {
      cleanWithin: () => true,
      cleanAfter: () => true,
      cleanIsLatest: () => true,
    } as unknown as ReconciliationService;
    // Every other condition reads clear — only the debounce's independence input is broken. Losing the
    // ability to tell two observations apart must stop the resume, not wave it through.
    const equityMonitor = {
      causeCleared: () => true,
      observationSeq: () => {
        throw new Error('observation-seq boom');
      },
    } as unknown as EquityMonitorService;
    const service = new RecoveryCoordinatorService(
      killSwitch,
      { autoResumeEnabled: true },
      reconciliation,
      equityMonitor,
      crashRecovery,
    );
    haltFor(killSwitch, 'DAILY_LOSS', false);

    expect(() => {
      service.tick(T);
      service.tick(T);
      service.tick(T);
    }).not.toThrow();
    expect(killSwitch.state()).toBe('HALTED');
  });

  it('N4: a throwing OpsEventPort.emit does not prevent the resume or propagate out of tick()', () => {
    const killSwitch = new KillSwitchService();
    const crashRecovery = { hasUnresolvedOrders: () => false } as unknown as CrashRecoveryService;
    const reconciliation = {
      cleanWithin: () => true,
      cleanAfter: () => true,
      cleanIsLatest: () => true,
    } as unknown as ReconciliationService;
    let obsSeq = 0;
    const equityMonitor = {
      causeCleared: () => true,
      observationSeq: () => ++obsSeq,
    } as unknown as EquityMonitorService;
    const throwingOpsEvents: OpsEventPort = {
      emit: () => {
        throw new Error('observer boom');
      },
    };
    const service = new RecoveryCoordinatorService(
      killSwitch,
      { autoResumeEnabled: true },
      reconciliation,
      equityMonitor,
      crashRecovery,
      throwingOpsEvents,
    );
    haltFor(killSwitch, 'DAILY_LOSS', false);

    expect(() => {
      service.tick(T);
      service.tick(T);
    }).not.toThrow();
    expect(killSwitch.state()).toBe('RUNNING');
  });
});
