import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { KillSwitchService } from '../../../../src/features/trading/risk/kill-switch.service';
import type { OpsEvent, OpsEventPort } from '../../../../src/ports/common/observability';
import type { KillSwitchAuditEntry, KillSwitchAuditPort } from '../../../../src/ports/trading/risk';
import { AUDIT_INITIAL_PREV_HASH, computeAuditHash } from '../../../../src/database/journal-hash';

// M2: mimics JournalRepository.append's hash chain (src/database/repositories/trading/
// journal.repository.ts) in memory, so these specs prove KillSwitchService's audit calls actually
// chain correctly end to end without a live Postgres (that durability guarantee is test:db's job).
interface FakeAuditRow {
  readonly actor: string;
  readonly category: string;
  readonly payload: unknown;
  readonly prevHash: string;
  readonly hash: string;
}

class FakeJournal {
  readonly rows: FakeAuditRow[] = [];

  append(entry: { actor: string; category: string; payload: unknown }): void {
    const prevHash =
      this.rows.length > 0 ? this.rows[this.rows.length - 1]!.hash : AUDIT_INITIAL_PREV_HASH;
    const hash = computeAuditHash(entry.payload, prevHash);
    this.rows.push({ ...entry, prevHash, hash });
  }
}

function auditPortOver(journal: FakeJournal): KillSwitchAuditPort {
  return {
    record: (entry: KillSwitchAuditEntry) =>
      journal.append({ actor: 'kill-switch', category: 'kill_switch', payload: entry }),
  };
}

describe('KillSwitchService', () => {
  it('starts RUNNING and engages to HALTING carrying reason + flatten flag', () => {
    const ks = new KillSwitchService();
    expect(ks.state()).toBe('RUNNING');
    ks.engage('drawdown', true);
    expect(ks.state()).toBe('HALTING');
    expect(ks.reason()).toBe('drawdown');
  });

  // 2026-07-19: engage() went a full day with zero log signal at the source — a level-50 (error)
  // line on every call is the one place a HALT can never be silent, regardless of caller.
  it('engage() logs level-50 (error) with the reason string, every call', () => {
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const ks = new KillSwitchService();
    ks.engage('FILL_FOR_UNKNOWN_ORDER', false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain('FILL_FOR_UNKNOWN_ORDER');
    errorSpy.mockRestore();
  });

  it('progresses through cancel-confirmed → FLATTENING → all-flat → HALTED, then RESUME', () => {
    const ks = new KillSwitchService();
    ks.engage('manual', true);
    ks.dispatch({ type: 'CANCELS_CONFIRMED' });
    expect(ks.state()).toBe('FLATTENING');
    ks.dispatch({ type: 'ALL_FLAT' });
    expect(ks.state()).toBe('HALTED');
    ks.dispatch({ type: 'RESUME' });
    expect(ks.state()).toBe('RUNNING');
  });

  // Backlog #52: dispatch() is the single choke point for every state-set — emits killswitch.
  // transition on each genuine transition, and skips an event the reducer ignores in its current
  // state (RESUME while RUNNING below).
  it('emits ops-event killswitch.transition{from,to,reason} on every genuine transition, skipping no-op events', () => {
    const opsEvents: OpsEvent[] = [];
    const opsEventLogger: OpsEventPort = { emit: (e) => opsEvents.push(e) };
    const ks = new KillSwitchService(opsEventLogger);
    ks.engage('drawdown', true); // RUNNING → HALTING
    ks.dispatch({ type: 'RESUME' }); // ignored by the reducer while HALTING — no transition
    ks.dispatch({ type: 'CANCELS_CONFIRMED' }); // HALTING → FLATTENING (flattenRequested)
    expect(opsEvents).toEqual([
      { event: 'killswitch.transition', from: 'RUNNING', to: 'HALTING', reason: 'drawdown' },
      { event: 'killswitch.transition', from: 'HALTING', to: 'FLATTENING', reason: 'drawdown' },
    ]);
  });

  // M2: a 45h production halt produced zero audit_log rows (docs/runbook.md's operator
  // instructions to consult "the append-only audit trail" were false in practice) — engage() and
  // resume() must each durably record their transition via the KILL_SWITCH_AUDIT port.
  it('engage() appends exactly one audit_log row, category kill_switch, with the expected payload shape', () => {
    const journal = new FakeJournal();
    const ks = new KillSwitchService(undefined, auditPortOver(journal));
    ks.engage('drawdown', true);
    expect(journal.rows).toHaveLength(1);
    const row = journal.rows[0]!;
    expect(row.actor).toBe('kill-switch');
    expect(row.category).toBe('kill_switch');
    const payload = row.payload as KillSwitchAuditEntry;
    expect(payload.reason).toBe('drawdown');
    expect(payload.flatten).toBe(true);
    expect(payload.priorState).toBe('RUNNING');
    expect(payload.newState).toBe('HALTING');
    expect(typeof payload.timestamp).toBe('string');
  });

  it('resume() appends exactly one audit_log row, category kill_switch, with the expected payload shape', () => {
    const journal = new FakeJournal();
    const ks = new KillSwitchService(undefined, auditPortOver(journal));
    ks.engage('drawdown', false);
    ks.dispatch({ type: 'CANCELS_CONFIRMED' }); // HALTING → HALTED (flatten was false)
    journal.rows.length = 0; // isolate resume()'s own append from engage()'s
    ks.resume();
    expect(journal.rows).toHaveLength(1);
    const row = journal.rows[0]!;
    expect(row.category).toBe('kill_switch');
    const payload = row.payload as KillSwitchAuditEntry;
    expect(payload.reason).toBe('drawdown');
    expect(payload.flatten).toBe(false);
    expect(payload.priorState).toBe('HALTED');
    expect(payload.newState).toBe('RUNNING');
  });

  it('hash chain links correctly across an engage → resume pair', () => {
    const journal = new FakeJournal();
    const ks = new KillSwitchService(undefined, auditPortOver(journal));
    ks.engage('drawdown', false);
    ks.dispatch({ type: 'CANCELS_CONFIRMED' });
    ks.resume();
    expect(journal.rows).toHaveLength(2);
    const [engageRow, resumeRow] = journal.rows;
    expect(engageRow!.prevHash).toBe(AUDIT_INITIAL_PREV_HASH);
    expect(engageRow!.hash).toBe(computeAuditHash(engageRow!.payload, AUDIT_INITIAL_PREV_HASH));
    expect(resumeRow!.prevHash).toBe(engageRow!.hash);
    expect(resumeRow!.hash).toBe(computeAuditHash(resumeRow!.payload, engageRow!.hash));
  });

  // Fail-OPEN contract (kill-switch.service.ts's recordAudit header comment): the audit write is a
  // side-channel, never a control-flow input — a throwing audit port must never prevent the
  // reducer transition it is merely recording.
  it('still engages when the audit port throws synchronously', () => {
    const throwingAudit: KillSwitchAuditPort = {
      record: () => {
        throw new Error('audit sink unavailable');
      },
    };
    const ks = new KillSwitchService(undefined, throwingAudit);
    expect(() => ks.engage('drawdown', true)).not.toThrow();
    expect(ks.state()).toBe('HALTING');
  });

  it('still resumes when the audit port throws synchronously', () => {
    const throwingAudit: KillSwitchAuditPort = {
      record: () => {
        throw new Error('audit sink unavailable');
      },
    };
    const ks = new KillSwitchService(undefined, throwingAudit);
    ks.engage('drawdown', false);
    ks.dispatch({ type: 'CANCELS_CONFIRMED' });
    expect(() => ks.resume()).not.toThrow();
    expect(ks.state()).toBe('RUNNING');
  });
});
