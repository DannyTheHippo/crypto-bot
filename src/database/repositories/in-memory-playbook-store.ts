import { Injectable, Logger } from '@nestjs/common';
import type { PlaybookProvider } from '../../ports/agentic-strategy';
import type { PlaybookSeed, PlaybookVersionEntry } from './playbook-store.adapter';

// current()'s resolution outcome — `source` here is HOW the active version was resolved (pin /
// promotion / seed), distinct from PlaybookVersionEntry.source (the row's own source field).
// Mirrors PlaybookStoreAdapter's own (unexported) ResolvedPlaybook shape.
interface ResolvedPlaybook {
  readonly version: number;
  readonly content: string;
  readonly source: 'pin' | 'promotion' | 'seed';
}

// In-process PLAYBOOK_PROVIDER default (DB-less paper/test substrate) — mirrors
// PlaybookStoreAdapter's resolution/append/listVersions semantics exactly (see its header
// comment) so reflection/promotion code runs identically against either backing. Ring-capped at
// MAX_VERSIONS: the OLDEST row is evicted first when the cap is exceeded (version numbering stays
// monotonic across evictions — only the row, not the counter, is dropped).
@Injectable()
export class InMemoryPlaybookStore implements PlaybookProvider {
  private static readonly MAX_VERSIONS = 50;

  private readonly log = new Logger('InMemoryPlaybookStore');
  private readonly rows: PlaybookVersionEntry[] = [];
  private nextVersion: number;
  private resolvedPromise: Promise<ResolvedPlaybook> | null = null;

  constructor(
    private readonly seed: PlaybookSeed,
    private readonly pinVersion?: number,
  ) {
    this.rows.push({
      version: seed.version,
      content: seed.content,
      source: 'seed',
      parentVersion: null,
      createdAt: Date.now(),
    });
    this.nextVersion = seed.version + 1;
  }

  current(): Promise<ResolvedPlaybook> {
    if (this.resolvedPromise === null) {
      // resolve() is synchronous and can throw (e.g. an unresolvable seed) — wrap it so a failure
      // surfaces as a rejected promise, matching PlaybookStoreAdapter's async contract, rather than
      // escaping current() as a synchronous throw.
      try {
        this.resolvedPromise = Promise.resolve(this.resolve());
      } catch (err) {
        this.resolvedPromise = Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    return this.resolvedPromise;
  }

  private resolve(): ResolvedPlaybook {
    if (this.pinVersion !== undefined) {
      const pinned = this.findByVersion(this.pinVersion);
      if (pinned !== undefined) {
        return { version: pinned.version, content: pinned.content, source: 'pin' };
      }
      this.log.warn(
        `AGENTIC_PLAYBOOK_PIN=${this.pinVersion} not found; falling through to promotion/seed resolution`,
      );
    }
    const promoted = this.latestBySource('promotion');
    if (promoted !== undefined && promoted.parentVersion !== null) {
      const target = this.findByVersion(promoted.parentVersion);
      if (target !== undefined) {
        return { version: target.version, content: target.content, source: 'promotion' };
      }
      this.log.warn(
        `promotion row (version ${promoted.version}) points at missing parentVersion=${promoted.parentVersion}; falling through to seed`,
      );
    }
    const seedRow = this.findByVersion(this.seed.version);
    if (seedRow === undefined) {
      throw new Error(`playbook store: unable to resolve seed version ${this.seed.version}`);
    }
    return { version: seedRow.version, content: seedRow.content, source: 'seed' };
  }

  private findByVersion(version: number): PlaybookVersionEntry | undefined {
    return this.rows.find((r) => r.version === version);
  }

  private latestBySource(source: 'reflection' | 'promotion'): PlaybookVersionEntry | undefined {
    let latest: PlaybookVersionEntry | undefined;
    for (const row of this.rows) {
      if (row.source === source && (latest === undefined || row.version > latest.version)) {
        latest = row;
      }
    }
    return latest;
  }

  append(
    content: string,
    source: 'reflection' | 'promotion',
    parentVersion: number,
  ): Promise<{ version: number }> {
    const version = this.nextVersion;
    this.nextVersion += 1;
    this.rows.push({ version, content, source, parentVersion, createdAt: Date.now() });
    // Mirror PlaybookStoreAdapter: a 'promotion' append re-points resolution, so drop the cache to
    // re-resolve live on the next current(); a 'reflection' candidate is INACTIVE and leaves it.
    if (source === 'promotion') this.resolvedPromise = null;
    if (this.rows.length > InMemoryPlaybookStore.MAX_VERSIONS) {
      // Evict the oldest NON-seed row. The seed row (always index 0 — never pushed again after the
      // constructor) is resolve()'s last-resort fallback; evicting it would leave current()
      // unresolvable whenever no pin/promotion exists.
      const evictIdx = this.rows.findIndex((r) => r.source !== 'seed');
      if (evictIdx !== -1) this.rows.splice(evictIdx, 1);
    }
    return Promise.resolve({ version });
  }

  listVersions(limit: number): Promise<readonly PlaybookVersionEntry[]> {
    const sorted = [...this.rows].sort((a, b) => b.version - a.version);
    return Promise.resolve(sorted.slice(0, limit));
  }
}
