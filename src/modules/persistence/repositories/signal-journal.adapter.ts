import { Logger } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SignalJournalPort } from '../../../ports/strategy';
import type { ExecRunContext } from '../../../ports/execution';
import type { Signal } from '../../../domain/types/signal';
import type * as schema from '../schema';
import { SignalRepository, type SignalInsert } from './signal.repository';

// Composition-root binding for SIGNAL_JOURNAL: persists every routed signal (with its gateway outcome
// and resulting intentId) to the signals table for offline strategy analysis (§8 decision trail).
// Fire-and-forget — SignalJournalPort.record is sync and this is an analysis artifact, never a safety
// interlock; a failed insert is logged, never thrown, so journaling can never break the signal path.
export class SignalJournalAdapter implements SignalJournalPort {
  private readonly repo: SignalRepository;
  private readonly log = new Logger('SignalJournal');

  constructor(
    db: NodePgDatabase<typeof schema>,
    private readonly ctx: ExecRunContext,
  ) {
    this.repo = new SignalRepository(db);
  }

  record(signal: Signal, outcome: string, intentId?: string): void {
    const row: SignalInsert = {
      // No signalId on the domain Signal; the (dedupeKey, eventTime) pair identifies a routed instance.
      signalId: `${signal.dedupeKey}:${String(signal.eventTime)}`,
      strategyId: signal.strategyId,
      venue: signal.venue,
      symbol: signal.symbol,
      kind: signal.kind,
      strength: String(signal.strength),
      limitPriceHint: signal.limitPriceHint?.toFixed(),
      refPrice: signal.refPrice.toFixed(),
      basedOnSeq: signal.basedOnSeq,
      eventTime: signal.eventTime,
      ttlMs: signal.ttlMs,
      dedupeKey: signal.dedupeKey,
      reason: signal.reason,
      outcome,
      intentId,
      mode: this.ctx.mode,
      runId: this.ctx.runId,
      bootId: this.ctx.bootId,
    };
    void this.repo.insert(row).catch((err: unknown) => {
      this.log.error(`signals insert failed: ${String(err)}`);
    });
  }
}
