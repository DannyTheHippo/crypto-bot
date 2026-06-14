import { Inject, Injectable } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { desc, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../persistence.tokens';
import * as schema from '../schema';
import { canonicalPayload, computeAuditHash, AUDIT_INITIAL_PREV_HASH } from '../journal-hash';
import { requireDb } from './persistence-guard';

export interface JournalEntry {
  actor: string;
  category: string;
  payload: unknown;
}

// Advisory lock key for serializing appends (arbitrary stable 64-bit value).
const AUDIT_ADVISORY_KEY = 7_534_902_811_923_456n;

@Injectable()
export class JournalRepository {
  constructor(
    @Inject(DRIZZLE_DB)
    private readonly db: NodePgDatabase<typeof schema> | null,
  ) {}

  // Appends an audit_log entry, computing the SHA-256 hash chain.
  // Serialized via pg_advisory_xact_lock so concurrent appends form a consistent chain.
  // payload stored as TEXT (canonical sorted-key JSON) so the chain is re-derivable
  // from stored bytes — JSONB would re-parse and lose key order / number formatting.
  async append(entry: JournalEntry): Promise<number> {
    return requireDb(this.db).transaction(async (tx) => {
      // Serialize all appends — the lock is held for the duration of this transaction.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUDIT_ADVISORY_KEY}::bigint)`);

      const lastRows = await tx
        .select({ seq: schema.auditLog.seq, hash: schema.auditLog.hash })
        .from(schema.auditLog)
        .orderBy(desc(schema.auditLog.seq))
        .limit(1);

      const prevHash = lastRows.length > 0 ? lastRows[0]!.hash : AUDIT_INITIAL_PREV_HASH;
      const canonical = canonicalPayload(entry.payload);
      const hash = computeAuditHash(entry.payload, prevHash);

      const inserted = await tx
        .insert(schema.auditLog)
        .values({
          actor: entry.actor,
          category: entry.category,
          payload: canonical,
          prevHash,
          hash,
        })
        .returning({ seq: schema.auditLog.seq });

      return inserted[0]!.seq;
    });
  }
}
