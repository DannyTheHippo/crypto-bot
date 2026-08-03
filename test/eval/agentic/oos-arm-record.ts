// Out-of-sample SESSION arm — record + seal. Preregistered in
// research/studies/oos-session-arm-2026-08-03.md § Deliverable B.
//
// Appends one line per offered row to research/oos-arm/decisions-YYYY-MM-DD.jsonl (committed,
// matching the research/candidates/*.jsonl convention — .gitignore:44,52 covers
// test/eval/agentic/data/*.jsonl and research/candidates/**, NOT research/oos-arm/, confirmed before
// this file was written). The live lane's own action is NEVER written here — it is joined at score
// time only, off a different source, so this record can never become a channel carrying the
// comparator's answer to the thing being compared. ALLOWED_RECORD_KEYS below is what a spec asserts
// against, not just a convention in prose.
//
// Sealing writes ONE row to the append-only `experiments` table (family='oos-arm-seal', distinct
// from whatever family a scorer later reads, so honest-N counts only scored reads) via
// test/backtest/experiment-log.ts's existing logTrials — reused, not forked, so this module inherits
// its DB_SUITE_ALLOW_RESET/`_test`-suffix gate and its "never fail the caller" posture (a sealing
// side channel must not fail a decide batch, same rationale logTrials' own header states for
// backtest trials). `created_at` is DB-authored (schema default `defaultNow()`,
// src/database/schemas/trading/trading.schema.ts:585) and is never a column logTrials' INSERT
// statement accepts from the caller — see this file's own spec asserting ExperimentRow carries no
// timestamp field at all.

import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SymbolId } from '../../../src/domain/common/types/ids';
import { splitSymbol } from '../../../src/domain/venue/types/symbol';
import type { AgentDirectives } from '../../../src/ports/strategy/agentic-strategy';
import type { CapabilitiesSource } from '../../../src/features/strategy/agentic/entry-rate-floor';
// Peer-owned, READ-ONLY imports (never edited): corpusManifest/CorpusRow reuse the SAME
// row-order-pinned hash construction the FLAT-corpus replay engine already uses (see
// computeRowSetHash below), and logTrials/paramsHash/datasetHash/ExperimentRow are the SAME
// append-only `experiments` writer the backtest research lane already uses — reused rather than a
// second hand-rolled INSERT, per this study's "route through existing primitives, do not fork" rule.
import { corpusManifest, type CorpusRow } from './playbook-space-replay';
import {
  logTrials,
  paramsHash,
  datasetHash,
  type ExperimentRow,
} from '../../backtest/experiment-log';

export const OOS_ARM_DIR = join(process.cwd(), 'research', 'oos-arm');

export function decisionsFilePath(dateIso: string, dir: string = OOS_ARM_DIR): string {
  return join(dir, `decisions-${dateIso}.jsonl`);
}

export interface DecisionHashes {
  readonly systemPromptSha256: string;
  readonly playbookContentSha256: string;
  readonly toolSchemaSha256: string;
  readonly agentPromptBlobSha: string;
}

export interface DecisionRecord {
  readonly rowId: string;
  readonly eventTime: number;
  readonly venue: string;
  readonly symbol: string;
  readonly base: string;
  readonly playbookVersion: number | null;
  readonly hashes: DecisionHashes;
  readonly agentPromptCommitSha: string;
  readonly capsSource: CapabilitiesSource;
  readonly schemaValid: boolean;
  readonly action: string | null;
  readonly directives: AgentDirectives | null;
}

/**
 * Whitelist enforced by a spec, not just a convention: nothing outside this set may ever be written
 * to the JSONL, and in particular no key resembling the live lane's own action (§ header).
 */
export const ALLOWED_RECORD_KEYS: readonly string[] = [
  'rowId',
  'eventTime',
  'venue',
  'symbol',
  'base',
  'playbookVersion',
  'hashes',
  'agentPromptCommitSha',
  'capsSource',
  'schemaValid',
  'action',
  'directives',
];

export function buildDecisionRecord(args: {
  readonly rowId: string;
  readonly symbol: string;
  readonly eventTime: number;
  readonly venue: string;
  readonly playbookVersion: number | null;
  readonly hashes: DecisionHashes;
  readonly agentPromptCommitSha: string;
  readonly capsSource: CapabilitiesSource;
  readonly result: {
    readonly ok: boolean;
    readonly action?: string;
    readonly plan?: AgentDirectives;
  };
}): DecisionRecord {
  const { base } = splitSymbol(args.symbol as SymbolId);
  return {
    rowId: args.rowId,
    eventTime: args.eventTime,
    venue: args.venue,
    symbol: args.symbol,
    base,
    playbookVersion: args.playbookVersion,
    hashes: args.hashes,
    agentPromptCommitSha: args.agentPromptCommitSha,
    capsSource: args.capsSource,
    schemaValid: args.result.ok,
    action: args.result.action ?? null,
    directives: args.result.plan ?? null,
  };
}

export function appendDecisionRecords(filePath: string, records: readonly DecisionRecord[]): void {
  if (records.length === 0) return;
  mkdirSync(dirname(filePath), { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  appendFileSync(filePath, lines, 'utf8');
}

/**
 * Sha256 over the concatenated payloads, in the given row order — reuses corpusManifest's exact
 * hash construction (id + ' ' + inputPayload + ' ') rather than reimplementing it, the same
 * "row order is pinned explicitly" discipline the pre-registration cites (an unpinned order among
 * event_time ties already broke a fingerprint check once in this program —
 * research/studies/corpus-fingerprint-drift-correction-2026-08-03.md). `eventTime`/`recordedAction`
 * are unused by corpusManifest's hash (only `id`+`inputPayload` are hashed, per that function's own
 * body) — the sentinel values below keep this reuse type-safe without this module ever holding the
 * live lane's action.
 */
export function computeRowSetHash(
  rows: readonly { readonly id: string; readonly symbol: string; readonly inputPayload: string }[],
): string {
  const asCorpusRows: CorpusRow[] = rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    eventTime: 0,
    recordedAction: '',
    inputPayload: r.inputPayload,
  }));
  return corpusManifest(asCorpusRows).payloadSha256;
}

// ── seal ─────────────────────────────────────────────────────────────────────────────────────────

export const OOS_ARM_SEAL_FAMILY = 'oos-arm-seal';

export interface SealWindow {
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly rowIdsInOrder: readonly string[];
  readonly payloadSha256: string;
}

/**
 * Seals ONE batch's window BEFORE it is scored — a missing seal VOIDs a later read (VOID condition
 * 5: "No seal, no score"). Fire-and-forget by construction: logTrials is a silent no-op when
 * DATABASE_URL/the reset gate is closed (offline/CI decide runs never touch a DB), and never throws
 * into this caller — a sealing side channel must not fail a decide batch, mirroring
 * test/backtest/experiment-log.ts's own header rationale for logTrials.
 */
export async function sealBatch(window: SealWindow): Promise<void> {
  const row: ExperimentRow = {
    family: OOS_ARM_SEAL_FAMILY,
    paramsHash: paramsHash({ windowStart: window.windowStart, windowEnd: window.windowEnd }),
    // ExperimentRow's DatasetKey is corpus-shaped (symbol/interval/rowCount/firstTs/lastTs) — this
    // seal is not a single-symbol OHLCV dataset, so `symbol`/`interval` carry sentinel values; the
    // hash is still unique per (row set, window), which is all a seal needs to distinguish batches.
    datasetHash: datasetHash({
      symbol: 'oos-arm',
      interval: 'n/a',
      rowCount: window.rowIdsInOrder.length,
      firstTs: window.windowStart,
      lastTs: window.windowEnd,
    }),
    source: 'study',
    label: `oos-arm ${window.rowIdsInOrder.length} rows`,
    metrics: {
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      rowIds: window.rowIdsInOrder,
      payloadSha256: window.payloadSha256,
    },
  };
  await logTrials([row]);
}
