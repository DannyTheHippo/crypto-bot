// Research-side experiment logging — NOT part of the Nest app (no @nestjs/*, no drizzle schema
// import: this module must stay importable from a fully offline `pnpm backtest` run). Best-effort
// persistence of trial results to the `experiments` table (drizzle/0009_experiments.sql /
// src/database/schemas/trading/trading.schema.ts's experiments export) so the deflated-Sharpe
// multiple-testing count (N, see trial-registry.ts's header) is honest across sessions rather than
// reset per-process.
//
// logTrials() is the only function that touches the network; it is gated by the SAME
// DB_SUITE_ALLOW_RESET / `_test`-suffix rule as test/db/*.spec.ts (persistence.spec.ts) and is a
// SILENT no-op whenever that gate is closed — a CI/offline `pnpm backtest` run must be
// byte-equivalent whether or not DATABASE_URL happens to be set in the shell. It also NEVER throws
// into the caller: any pg failure is caught and logged via console.warn, since a logging side
// channel must not fail a research run.
import * as crypto from 'node:crypto';
import { Pool } from 'pg';
import { PRIOR_TRIALS, loadBars } from './trial-registry';

// ── canonical hashing ────────────────────────────────────────────────────────
// Stable-key-order JSON, the same shape as src/domain/risk/canonical.ts's sortedKeys /
// src/database/journal-hash.ts's canonicalPayload — reimplemented locally rather than imported so
// this research module has zero dependency on src/database (Nest-owned, per CLAUDE.md rule 4's
// "strategy lane" impurity boundary spirit) or decimal.js (params/dataset keys here are plain
// numbers/strings, never money).
function sortedKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortedKeys);
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src).sort()) out[k] = sortedKeys(src[k]);
  return out;
}

function sha256Hex(canonical: string): string {
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function paramsHash(params: Record<string, unknown>): string {
  return sha256Hex(JSON.stringify(sortedKeys(params)));
}

export interface DatasetKey {
  readonly symbol: string;
  readonly interval: string;
  readonly rowCount: number;
  readonly firstTs: number;
  readonly lastTs: number;
}

export function datasetHash(key: DatasetKey): string {
  return sha256Hex(JSON.stringify(sortedKeys({ ...key })));
}

// ── row shape (mirrors ExperimentInsert in experiment.repository.ts) ─────────

export interface ExperimentRow {
  readonly family: string;
  readonly paramsHash: string;
  readonly datasetHash: string;
  readonly source: 'loop' | 'reflection' | 'human' | 'study';
  readonly label?: string;
  readonly metrics?: Record<string, unknown>;
}

// ── PRIOR_TRIAL_ROWS ──────────────────────────────────────────────────────────
// Maps every PRIOR_TRIALS entry (trial-registry.ts's 52-bucket SeedEntryStrategy grid) to an
// insertable experiments row, for the one-time backfill in test/db/experiment-registry.spec.ts.
// kMultiple is parsed out of TrialSpec.label (`${symbol}-${interval}-k${k}`, see
// trial-registry.ts's seedEntryTrials) since TrialSpec itself only exposes the compiled `make`
// closure, not the raw config. maxHoldBars is re-declared here (20) rather than imported: it
// mirrors trial-registry.ts's private SEED_ENTRY_MAX_HOLD_BARS, which that module does not export.
const SEED_ENTRY_MAX_HOLD_BARS = 20;

function parseKMultiple(label: string): number {
  const m = /-k([\d.]+)$/.exec(label);
  if (!m) throw new Error(`PRIOR_TRIAL_ROWS: cannot parse kMultiple from label "${label}"`);
  return Number(m[1]);
}

export function PRIOR_TRIAL_ROWS(): ExperimentRow[] {
  const barsCache = new Map<string, ReturnType<typeof loadBars>>();
  const rows: ExperimentRow[] = [];
  for (const spec of PRIOR_TRIALS) {
    const cacheKey = `${spec.symbol}:${spec.interval}`;
    let bars = barsCache.get(cacheKey);
    if (bars === undefined) {
      bars = loadBars(spec.interval, spec.symbol);
      barsCache.set(cacheKey, bars);
    }
    if (!bars || bars.length === 0) {
      // Data file missing/empty for this bucket — skip rather than fabricate a dataset hash; the
      // DB backfill spec's N-consistency check surfaces the gap.
      continue;
    }
    const firstBar = bars[0]!;
    const lastBar = bars[bars.length - 1]!;
    rows.push({
      family: spec.cls,
      paramsHash: paramsHash({
        maxHoldBars: SEED_ENTRY_MAX_HOLD_BARS,
        kMultiple: parseKMultiple(spec.label),
      }),
      datasetHash: datasetHash({
        symbol: spec.symbol,
        interval: spec.interval,
        rowCount: bars.length,
        firstTs: firstBar[0]!,
        lastTs: lastBar[0]!,
      }),
      source: 'human',
      label: spec.label,
    });
  }
  return rows;
}

// ── logTrials ─────────────────────────────────────────────────────────────────

function dbNameEndsWithTest(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/^\//, '').endsWith('_test');
  } catch {
    return false;
  }
}

function gateOpen(dbUrl: string | undefined): dbUrl is string {
  if (!dbUrl) return false;
  return process.env['DB_SUITE_ALLOW_RESET'] === '1' || dbNameEndsWithTest(dbUrl);
}

export async function logTrials(rows: readonly ExperimentRow[]): Promise<void> {
  if (rows.length === 0) return;
  const dbUrl = process.env['DATABASE_URL'];
  if (!gateOpen(dbUrl)) return; // silent no-op — offline/CI runs never touch a DB
  let pool: Pool | undefined;
  try {
    pool = new Pool({ connectionString: dbUrl });
    const valuesSql: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    for (const r of rows) {
      valuesSql.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
      params.push(
        r.family,
        r.paramsHash,
        r.datasetHash,
        r.source,
        r.label ?? null,
        r.metrics ? JSON.stringify(r.metrics) : null,
      );
    }
    await pool.query(
      `INSERT INTO experiments (family, params_hash, dataset_hash, source, label, metrics)
       VALUES ${valuesSql.join(', ')}`,
      params,
    );
  } catch (err) {
    // A logging side channel must never fail a research run.
    console.warn(
      'experiment-log: logTrials failed (non-fatal)',
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
}
