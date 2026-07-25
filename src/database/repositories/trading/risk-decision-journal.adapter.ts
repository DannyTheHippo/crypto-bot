import { Logger } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { RiskJournalPort } from '../../../ports/trading/risk';
import type { ExecRunContext } from '../../../ports/trading/execution';
import type { RiskDecision } from '../../../domain/trading/types/risk-decision';
import type * as schema from '../../schemas/trading';
import { RiskDecisionRepository, type RiskDecisionInsert } from './risk-decision.repository';

// Composition-root binding for RISK_JOURNAL: persists every risk verdict to risk_decisions for
// offline analysis (§5/§8). RiskJournalPort.record is SYNC — and risk-engine.service.ts treats the
// journal call as preceding release — so this adapter inserts fire-and-forget. That is a CONSCIOUS
// relaxation of "never released before journaling" for the DB path: the intent may proceed before the
// row is durable. Acceptable because the row is an analysis/audit artifact, not a safety interlock
// (the order_events journal — written synchronously in ExecutionGate's write-ahead path — is the
// durability guarantee that actually gates network side effects). A failed insert is logged, never
// thrown, so journaling can never break the trading path.
export class RiskDecisionJournalAdapter implements RiskJournalPort {
  private readonly repo: RiskDecisionRepository;
  private readonly log = new Logger('RiskDecisionJournal');

  constructor(
    db: NodePgDatabase<typeof schema>,
    private readonly ctx: ExecRunContext,
  ) {
    this.repo = new RiskDecisionRepository(db);
  }

  record(decision: RiskDecision): void {
    void this.repo.insert(this.toInsert(decision)).catch((err: unknown) => {
      this.log.error(`risk_decisions insert failed: ${String(err)}`);
    });
  }

  private toInsert(decision: RiskDecision): RiskDecisionInsert {
    const base = { mode: this.ctx.mode, runId: this.ctx.runId, bootId: this.ctx.bootId };
    if (decision.verdict === 'REJECTED') {
      // No proof on a rejection: snapshotSeq falls back to the intent's basis seq; limits/inputs hash
      // are not minted for a veto.
      return {
        ...base,
        intentId: decision.intent.intentId,
        verdict: 'REJECTED',
        reasons: [...decision.reasons],
        limitsVersion: '',
        snapshotSeq: decision.intent.refSeq,
        inputsHash: '',
      };
    }
    const { intent, proof } = decision.approved;
    return {
      ...base,
      intentId: intent.intentId,
      verdict: decision.verdict,
      reasons: decision.verdict === 'RESIZED' ? [...decision.reasons] : [],
      limitsVersion: proof.limitsVersion,
      snapshotSeq: proof.snapshotSeq,
      inputsHash: proof.intentHash,
    };
  }
}
