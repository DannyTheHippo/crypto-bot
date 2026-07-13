#!/usr/bin/env node
// Backlog #25: administratively terminalize stale unresolved-terminal `orders` rows that keep
// `hasUnresolvedOrders()` true for their mode and would refuse live arming someday. Target class:
// the 2026-07-10 wipe-remediation fixture rows (mode='live' ACKED + mode='paper' NEW) — synthetic
// rows pinned by append-only order_events FKs, with no venue truth to reconcile against.
//
// Safety model:
//   - DRY-RUN BY DEFAULT: prints the candidate rows and exits; `--apply` executes.
//   - NEVER touches mode='testnet' rows — the running demo app owns them (its reconciler holds
//     venue truth); non-terminal testnet rows are listed as SKIPPED, never mutated.
//   - BLAST-RADIUS CLAMP (review should-fix): `--apply` refuses when the apply set exceeds
//     MAX_APPLY_ROWS or contains a state outside the expected fixture profile — a paper process
//     with a GENUINELY open order must never be terminalized out from under its reducer. Inspect
//     the dry-run and extend the script deliberately if the fixture population ever grows.
//   - Each applied row, in ONE transaction: (1) INSERT an order_events audit row (append-only —
//     INSERT is the legal operation; the 0001 trigger blocks UPDATE/DELETE) with
//     dedupeKey 'ops:fixture-resolution', idempotent via the (order_id, dedupe_key) unique index;
//     (2) UPDATE orders SET state='CANCELED', terminal_at=now WHERE terminal_at IS NULL. The
//     direct UPDATE bypasses the reducer deliberately: these rows have no legal venue-truth event
//     to fold (the venue never saw them), and no running process loads foreign-mode rows
//     (findOpenByMode filters by mode).
//
// Usage: DATABASE_URL=postgres://... node scripts/resolve-stale-orders.mjs [--apply]

import pg from 'pg';
import { pathToFileURL } from 'node:url';

const { Pool } = pg;

// The apply set is expected to be exactly the two 2026-07-10 fixture rows; anything larger or
// shaped differently is NOT this script's business (review should-fix: blast-radius clamp).
export const MAX_APPLY_ROWS = 2;
const EXPECTED_STATES = new Set(['ACKED', 'NEW', 'SUBMIT_UNKNOWN', 'CANCEL_UNKNOWN']);

function log(msg) {
  console.log(`resolve-stale-orders: ${msg}`);
}
function fail(msg) {
  console.error(`resolve-stale-orders: ${msg}`);
}

// Split the unresolved rows into the untouchable testnet set and the live/paper apply set.
export function partitionRows(rows) {
  return {
    testnetRows: rows.filter((r) => r.mode === 'testnet'),
    applyRows: rows.filter((r) => r.mode === 'live' || r.mode === 'paper'),
  };
}

// Throws unless the apply set matches the expected fixture profile (count + states).
export function assertApplySetSafe(applyRows) {
  if (applyRows.length > MAX_APPLY_ROWS) {
    throw new Error(
      `apply set has ${applyRows.length} rows — expected at most ${MAX_APPLY_ROWS} (the 2026-07-10 fixtures). ` +
        'Inspect the dry-run output; if the population legitimately grew, extend the script deliberately.',
    );
  }
  for (const r of applyRows) {
    if (!EXPECTED_STATES.has(r.state)) {
      throw new Error(
        `apply set contains an unexpected state '${r.state}' (intent=${r.intent_id}) — a genuinely ` +
          'open order must never be administratively terminalized. Resolve it manually.',
      );
    }
  }
}

// One row, one transaction: audit event INSERT (idempotent) + guarded orders UPDATE.
export async function resolveRow(client, row, now) {
  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO public.order_events
         (order_id, dedupe_key, event_type, payload, seq, mode, run_id, boot_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (order_id, dedupe_key) DO NOTHING`,
      [
        row.intent_id,
        'ops:fixture-resolution',
        'OPS_FIXTURE_RESOLVED',
        JSON.stringify({
          priorState: row.state,
          reason:
            '2026-07-10 wipe-remediation fixture; administrative terminalization (backlog #25)',
          script: 'resolve-stale-orders',
        }),
        // seq is app-supplied epoch-ms (drizzle-execution-store convention); raw pg cannot
        // serialize a BigInt param, so the decimal string carries it losslessly.
        String(now),
        row.mode,
        'ops-manual',
        'ops-manual',
      ],
    );
    await client.query(
      `UPDATE public.orders
          SET state = 'CANCELED', terminal_at = $2, updated_at = now()
        WHERE intent_id = $1 AND terminal_at IS NULL`,
      [row.intent_id, now],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

export async function main(argv, poolFactory = (url) => new Pool({ connectionString: url })) {
  const apply = argv.includes('--apply');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    fail('DATABASE_URL is required (no default — this script mutates the production orders table)');
    return 1;
  }

  const pool = poolFactory(databaseUrl);
  try {
    const { rows } = await pool.query(
      `SELECT intent_id, client_order_id, mode, state
         FROM public.orders
        WHERE terminal_at IS NULL
        ORDER BY mode, intent_id`,
    );
    if (rows.length === 0) {
      log('no unresolved-terminal rows — nothing to do');
      return 0;
    }

    const { testnetRows, applyRows } = partitionRows(rows);
    for (const r of rows) {
      const disposition = r.mode === 'testnet' ? 'SKIP (testnet — app-owned)' : 'RESOLVE';
      log(
        `${disposition}: mode=${r.mode} state=${r.state} intent=${r.intent_id} coid=${r.client_order_id}`,
      );
    }
    if (testnetRows.length > 0) {
      log(
        `${testnetRows.length} non-terminal testnet row(s) left untouched — the running app's reconciler owns them`,
      );
    }
    if (applyRows.length === 0) {
      log('no live/paper rows to resolve');
      return 0;
    }
    if (!apply) {
      log(`DRY-RUN: would resolve ${applyRows.length} row(s); re-run with --apply to execute`);
      return 0;
    }

    assertApplySetSafe(applyRows);

    const client = await pool.connect();
    try {
      for (const r of applyRows) {
        await resolveRow(client, r, Date.now());
        log(`resolved: mode=${r.mode} intent=${r.intent_id} (${r.state} -> CANCELED)`);
      }
    } finally {
      client.release();
    }

    const { rows: post } = await pool.query(
      `SELECT count(*)::int AS unresolved FROM public.orders WHERE terminal_at IS NULL AND mode <> 'testnet'`,
    );
    log(`post-check: ${post[0].unresolved} non-testnet unresolved-terminal row(s) remain`);
    return 0;
  } finally {
    await pool.end();
  }
}

// Only auto-run when executed directly — importing this module (the unit spec) must never open a
// DB connection.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      fail(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
