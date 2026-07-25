import type { ModeAuditPort, ModeAuditEvent } from '../../ports/mode-control';
import { JournalRepository } from './journal.repository';
import { ModeTransitionRepository } from './mode-transition.repository';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../schemas/trading';

// DrizzleModeAudit: fire-and-forget (record returns void; callers never await).
// Every event → audit_log hash chain. Mode-transition events → mode_transitions table too.
// Rejections are swallowed per the ModeAuditPort contract (failures must not propagate).
export class DrizzleModeAudit implements ModeAuditPort {
  private readonly journal: JournalRepository;
  private readonly transitions: ModeTransitionRepository;

  constructor(
    db: NodePgDatabase<typeof schema>,
    private readonly bootId: string,
  ) {
    this.journal = new JournalRepository(db);
    this.transitions = new ModeTransitionRepository(db);
  }

  record(event: ModeAuditEvent): void {
    this.persist(event).catch(() => undefined);
  }

  private async persist(event: ModeAuditEvent): Promise<void> {
    await this.journal.append({
      actor: 'mode-control',
      category: event.type,
      payload: event,
    });

    // Write a mode_transitions row for events that represent a from→to mode shift.
    switch (event.type) {
      case 'boot_resolution':
        await this.transitions.insert({
          fromMode: event.requested,
          toMode: event.effective,
          actor: 'boot',
          evidence: { downgrades: event.downgrades, bootId: event.bootId },
          bootId: this.bootId,
        });
        break;
      case 'arm_confirmed':
        await this.transitions.insert({
          fromMode: 'paper',
          toMode: 'live',
          actor: 'operator',
          evidence: { bootId: event.bootId },
          bootId: this.bootId,
        });
        break;
      case 'disarmed':
        await this.transitions.insert({
          fromMode: 'live',
          toMode: 'paper',
          actor: event.trigger,
          evidence: { trigger: event.trigger },
          bootId: this.bootId,
        });
        break;
      case 'downgrade':
        await this.transitions.insert({
          fromMode: 'live',
          toMode: 'paper',
          actor: 'downgrade',
          evidence: { failedPrecondition: event.failedPrecondition },
          bootId: this.bootId,
        });
        break;
      default:
        break;
    }
  }
}
