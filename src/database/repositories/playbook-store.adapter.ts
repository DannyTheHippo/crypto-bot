import { Logger } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PlaybookProvider } from '../../ports/agentic-strategy';
import type * as schema from '../schemas/trading';
import {
  PlaybookVersionRepository,
  type PlaybookVersionDbRow,
} from './playbook-version.repository';

// The seed shape is injected by the composition root (SEED_PLAYBOOK, exported from
// agentic-strategy.module.ts) rather than imported directly: persistence and agentic-strategy are
// sibling `modules/*` zones under eslint-plugin-boundaries (a module may only import its own
// moduleName — see eslint.config.mjs § boundaries/dependencies), so the value crosses the wall via
// constructor injection, not a cross-module import.
export interface PlaybookSeed {
  readonly version: number;
  readonly content: string;
}

export interface PlaybookVersionEntry {
  readonly version: number;
  readonly content: string;
  readonly source: 'seed' | 'reflection' | 'promotion';
  readonly parentVersion: number | null;
  readonly createdAt: number;
}

// current()'s resolution outcome — `source` here is HOW the active version was resolved (pin /
// promotion / seed), distinct from PlaybookVersionEntry.source (the row's own DB source column).
interface ResolvedPlaybook {
  readonly version: number;
  readonly content: string;
  readonly source: 'pin' | 'promotion' | 'seed';
}

function toEntry(row: PlaybookVersionDbRow): PlaybookVersionEntry {
  return {
    version: row.version,
    content: row.content,
    source: row.source,
    parentVersion: row.parentVersion,
    createdAt: row.createdAt.getTime(),
  };
}

// Composition-root binding for PLAYBOOK_PROVIDER (DB-backed). Resolution order for current():
//   1. pinVersion (if provided and its row exists) — operator override, e.g. AGENTIC_PLAYBOOK_PIN.
//   2. the newest source='promotion' row's parentVersion target (a promotion row POINTS AT the
//      version it promotes; it never carries the active content itself).
//   3. the seed row (`seed.version`), lazily inserted on first call if absent.
// Resolution runs ONCE per process and is cached — "Active version resolution at boot" (design
// plan): a promotion written by a separate `playbook:promote` run only takes effect for THIS
// process on its next restart. The one exception is an IN-PROCESS promotion append (auto-promotion,
// G4b): append() drops the cache when it writes a 'promotion' row, so the next current() re-resolves
// live — this same adapter instance backs both the decide reads and the reflection writes.
export class PlaybookStoreAdapter implements PlaybookProvider {
  private readonly repo: PlaybookVersionRepository;
  private readonly log = new Logger('PlaybookStore');
  private resolvedPromise: Promise<ResolvedPlaybook> | null = null;

  constructor(
    db: NodePgDatabase<typeof schema>,
    private readonly seed: PlaybookSeed,
    private readonly pinVersion?: number,
  ) {
    this.repo = new PlaybookVersionRepository(db);
  }

  current(): Promise<ResolvedPlaybook> {
    if (this.resolvedPromise === null) {
      this.resolvedPromise = this.resolve().catch((err: unknown) => {
        this.resolvedPromise = null; // let a transient failure be retried on the next call
        throw err;
      });
    }
    return this.resolvedPromise;
  }

  private async resolve(): Promise<ResolvedPlaybook> {
    if (this.pinVersion !== undefined) {
      const pinned = await this.repo.findByVersion(this.pinVersion);
      if (pinned !== null) {
        return { version: pinned.version, content: pinned.content, source: 'pin' };
      }
      this.log.warn(
        `AGENTIC_PLAYBOOK_PIN=${this.pinVersion} not found; falling through to promotion/seed resolution`,
      );
    }
    const promoted = await this.repo.findLatestBySource('promotion');
    if (promoted !== null && promoted.parentVersion !== null) {
      const target = await this.repo.findByVersion(promoted.parentVersion);
      if (target !== null) {
        return { version: target.version, content: target.content, source: 'promotion' };
      }
      this.log.warn(
        `promotion row (version ${promoted.version}) points at missing parentVersion=${promoted.parentVersion}; falling through to seed`,
      );
    }
    return this.ensureSeed();
  }

  private async ensureSeed(): Promise<ResolvedPlaybook> {
    const existing = await this.repo.findByVersion(this.seed.version);
    if (existing !== null) {
      return { version: existing.version, content: existing.content, source: 'seed' };
    }
    try {
      await this.repo.insert({
        version: this.seed.version,
        content: this.seed.content,
        source: 'seed',
      });
    } catch (err) {
      // Tolerate a concurrent seed race (unique violation on `version`) — re-read below rather
      // than treating it as fatal.
      this.log.debug(`seed insert raced (tolerated): ${String(err)}`);
    }
    const row = await this.repo.findByVersion(this.seed.version);
    if (row === null) {
      throw new Error(`playbook store: unable to resolve or seed version ${this.seed.version}`);
    }
    return { version: row.version, content: row.content, source: 'seed' };
  }

  // Single-writer lane (only the reflection/promotion services call append; their own scheduling
  // never overlaps two calls concurrently — see G4a/G4b), so a plain max+1 read-then-insert is
  // sufficient; no transaction-level lock is taken. The new row is INACTIVE by definition — it
  // only becomes the active version via a later 'promotion' row or an operator pin (see resolve()).
  // For source='promotion', `content` is a promotion rationale/audit note, not the active
  // content — resolve() reads `parentVersion`'s row for that.
  async append(
    content: string,
    source: 'reflection' | 'promotion',
    parentVersion: number,
  ): Promise<{ version: number }> {
    const next = (await this.repo.maxVersion()) + 1;
    await this.repo.insert({ version: next, content, source, parentVersion });
    // A 'promotion' row changes which version resolve() would pick; drop the cached resolution so the
    // next current() re-resolves and the promotion takes effect live (auto-promotion, G4b). A
    // 'reflection' append mints an INACTIVE candidate that never alters resolution — leave the cache.
    if (source === 'promotion') this.resolvedPromise = null;
    return { version: next };
  }

  async listVersions(limit: number): Promise<readonly PlaybookVersionEntry[]> {
    const rows = await this.repo.listVersions(limit);
    return rows.map(toEntry);
  }
}
