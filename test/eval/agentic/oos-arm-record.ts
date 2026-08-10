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
// from whatever family a scorer later reads, so honest-N counts only scored reads) via a DIRECT
// parameterized INSERT, modelled on `claimTodaysSlot` (scripts/loop-authoring.mjs:326-334) — the
// same append-only table, the same INSERT-then-trust-the-row shape. This module used to route through
// test/backtest/experiment-log.ts's `logTrials`, reused rather than forked; that reuse was the defect.
// `logTrials` is gated by `DB_SUITE_ALLOW_RESET=1` OR a `_test`-suffixed connection string and is a
// SILENT no-op otherwise — correct for *its* callers (an offline `pnpm backtest` run must be
// byte-equivalent whether or not DATABASE_URL happens to be set), but wrong for a seal: this module's
// only production caller is the live decide leg, writing against the live `DATABASE_URL`, which the
// old gate refused every time. The arm could decide for weeks and this table would never carry a row,
// so every scorer read UNSTARTED forever (`oos_arm_unstarted` — "no sealed window exists yet") no
// matter how much real decide work happened. `created_at` is DB-authored (schema default
// `defaultNow()`, src/database/schemas/trading/trading.schema.ts:585) and is never a column this
// INSERT accepts from the caller — see this file's own spec asserting the seal window carries no
// timestamp field at all.
//
// FAILURE DIRECTION, changed with this rewrite: sealBatch now FAILS CLOSED, not open. A missing
// DATABASE_URL, a failed INSERT, or a failed read-back all THROW — the caller (the decide-leg pass
// step) must not treat an unconfirmed seal as done, because VOID condition 5 ("no seal, no score")
// makes an unsealed window worthless and a silently-swallowed failure is indistinguishable from a
// clean seal to everything downstream. This inverts the old "a sealing side channel must not fail a
// decide batch" posture on purpose: that posture is right for a *measurement* (logTrials logs a
// research trial nobody's correctness depends on) and wrong for *evidence a read was fixed before the
// look* (this seal). The read-back is a SECOND round trip, deliberately not just trusting the INSERT's
// own `RETURNING` — a caller who cannot independently re-confirm the row exists has no better evidence
// than the caller who never checked.

import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';
import type { SymbolId } from '../../../src/domain/common/types/ids';
import { splitSymbol } from '../../../src/domain/venue/types/symbol';
import type { AgentDirectives } from '../../../src/ports/strategy/agentic-strategy';
import type { CapabilitiesSource } from '../../../src/features/strategy/agentic/entry-rate-floor';
// Peer-owned, READ-ONLY imports (never edited): corpusManifest/CorpusRow reuse the SAME
// row-order-pinned hash construction the FLAT-corpus replay engine already uses (see
// computeRowSetHash below); paramsHash/datasetHash are this study's registered hash construction,
// unchanged by the sealBatch rewrite above — only the INSERT primitive they used to feed changed.
import { corpusManifest, type CorpusRow } from './playbook-space-replay';
import { paramsHash, datasetHash } from '../../backtest/experiment-log';

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
  // Sealed live baseline (pre-registration § 1 of the 2026-08-04 amendment: "the baseline `L` is the
  // live lane's own recorded entry rate on exactly the rows in that read's sealed window"). Computed
  // by the PARENT (the decide-leg pass step, § v of the 2026-08-10 amendment) off the registered
  // denominator — entries (open_long + open_short) ÷ FLAT-marker candle rows, non-replay — over
  // exactly this window's rows, and carried into the seal so it is fixed BEFORE the read is scored,
  // the same discipline that already binds windowStart/windowEnd/rowIdsInOrder. Required (not
  // optional): a seal that cannot state its own baseline is not evidence the window was fixed with a
  // comparator attached, and a missing baseline would force the scorer to guess rather than annotate.
  readonly liveFlatRows: number;
  readonly liveEntryCount: number;
}

/**
 * Seals ONE batch's window BEFORE it is scored — a missing seal VOIDs a later read (VOID condition
 * 5: "No seal, no score"). FAILS CLOSED (module header): a missing `connectionString`, a failed
 * INSERT, or a failed read-back all THROW rather than swallowing into a silent no-op — the caller
 * must not treat an unconfirmed seal as done. Modelled on `claimTodaysSlot`
 * (scripts/loop-authoring.mjs:326-334): a direct parameterized INSERT into `public.experiments`,
 * `RETURNING id`, followed by an independent read-back keyed on that id. `pool.end()` runs in
 * `finally` so a thrown failure still releases the connection.
 */
export async function sealBatch(
  window: SealWindow,
  connectionString: string | undefined = process.env['DATABASE_URL'],
): Promise<void> {
  if (!connectionString) {
    throw new Error(
      'oos-arm-record: sealBatch refuses to seal without a DATABASE_URL — VOID condition 5 ("no ' +
        'seal, no score") means an unsealed window must never be silently treated as sealed. This ' +
        'used to route through logTrials, which silently no-ops without DB_SUITE_ALLOW_RESET or a ' +
        '`_test`-suffixed URL; that gate is exactly what let the arm read UNSTARTED forever even ' +
        'after real decides accrued in production.',
    );
  }
  const computedParamsHash = paramsHash({
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
  });
  // DatasetKey is corpus-shaped (symbol/interval/rowCount/firstTs/lastTs) — this seal is not a
  // single-symbol OHLCV dataset, so `symbol`/`interval` carry sentinel values; the hash is still
  // unique per (row set, window), which is all a seal needs to distinguish batches.
  const computedDatasetHash = datasetHash({
    symbol: 'oos-arm',
    interval: 'n/a',
    rowCount: window.rowIdsInOrder.length,
    firstTs: window.windowStart,
    lastTs: window.windowEnd,
  });
  const label = `oos-arm ${window.rowIdsInOrder.length} rows`;
  const metrics = {
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    rowIds: window.rowIdsInOrder,
    payloadSha256: window.payloadSha256,
    liveFlatRows: window.liveFlatRows,
    liveEntryCount: window.liveEntryCount,
  };

  const pool = new Pool({ connectionString });
  try {
    const insertResult = await pool.query<{ id: string }>(
      `INSERT INTO public.experiments (family, params_hash, dataset_hash, source, label, metrics)
       VALUES ($1, $2, $3, 'study', $4, $5)
       RETURNING id::text AS id`,
      [
        OOS_ARM_SEAL_FAMILY,
        computedParamsHash,
        computedDatasetHash,
        label,
        JSON.stringify(metrics),
      ],
    );
    const insertedId = insertResult.rows[0]?.id;
    if (!insertedId) {
      throw new Error(
        `oos-arm-record: sealBatch INSERT returned no id (family=${OOS_ARM_SEAL_FAMILY}, ` +
          `paramsHash=${computedParamsHash}) — a seal with no confirmed row id cannot be trusted`,
      );
    }
    // Independent read-back, not just trusting the INSERT's own RETURNING — a caller who cannot
    // re-confirm the row exists has no better evidence than a caller who never checked.
    const readBack = await pool.query<{ id: string }>(
      'SELECT id::text AS id FROM public.experiments WHERE id = $1 AND family = $2',
      [insertedId, OOS_ARM_SEAL_FAMILY],
    );
    if (readBack.rows.length !== 1) {
      throw new Error(
        `oos-arm-record: sealBatch read-back found no row at id=${insertedId} ` +
          `family=${OOS_ARM_SEAL_FAMILY} immediately after insert — a seal that cannot be read back ` +
          'is not a seal',
      );
    }
  } finally {
    await pool.end();
  }
}
