import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { JournalRepository } from './journal.repository';
import type * as schema from '../../schemas/trading';
import type { KillSwitchAuditEntry, KillSwitchAuditPort } from '../../../ports/trading/risk';

// M2: composition-root binding for KILL_SWITCH_AUDIT — persists every engage()/resume() to
// audit_log's hash chain via the same JournalRepository.append path DrizzleModeAudit uses
// (drizzle-mode-audit.ts), under a NEW 'kill_switch' category alongside the existing 'key_check'
// rows. Fire-and-forget (record returns void; KillSwitchService never awaits) — a rejected append
// is swallowed here AND KillSwitchService's own recordAudit() wraps the call in try/catch, so
// neither an async rejection nor a synchronous throw from this port can break the kill switch.
export class DrizzleKillSwitchAudit implements KillSwitchAuditPort {
  private readonly journal: JournalRepository;

  constructor(db: NodePgDatabase<typeof schema>) {
    this.journal = new JournalRepository(db);
  }

  record(entry: KillSwitchAuditEntry): void {
    this.journal
      .append({ actor: 'kill-switch', category: 'kill_switch', payload: entry })
      .catch(() => undefined);
  }
}
