#!/usr/bin/env node
// Loop-side playbook candidate injection (N2) —
// `node scripts/playbook-candidate.mjs <candidate-file> [--metrics <scorecard.json>]`.
// Mints an INACTIVE source='loop-candidate' row pointing at the currently-active version, gated by
// the SAME structural validator the runtime read-path uses (playbook-validator.ts) — loaded from its
// COMPILED dist output so this script never needs ts-node or the Nest DI graph.
// PlaybookAbRoutingProvider (app.module.ts) already treats 'loop-candidate' as a routable candidate
// source alongside 'reflection' — the newest one above the active version is picked up on its very
// next current() call (see that class's own header comment for the pct/UTC-minute routing).
//
// One-unresolved-candidate discipline: refuses to mint a second candidate (reflection OR
// loop-candidate source) above the active version until the existing one is promoted/lapses — the
// same "newest wins, only one live at a time" rationale PlaybookAbRoutingProvider's own comment
// gives for candidate routing.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resolveActiveVersion, mapUniqueViolation } from './lib/playbook-shared.mjs';

const { Pool } = pg;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function usageError(message) {
  console.error(`playbook:candidate: ${message}`);
  console.error(
    'usage: node scripts/playbook-candidate.mjs <candidate-file> [--metrics <scorecard.json>]',
  );
  process.exitCode = 1;
}

// Refuses stale/missing dist rather than silently validating against an out-of-date copy of
// playbook-validator.ts — this script has no build step of its own, unlike `pnpm build` + Nest's
// normal boot path.
function loadValidatePlaybook() {
  const distPath = path.join(
    SCRIPT_DIR,
    '..',
    'dist',
    'features',
    'trading',
    'agentic',
    'playbook-validator.js',
  );
  const srcPath = path.join(
    SCRIPT_DIR,
    '..',
    'src',
    'features',
    'trading',
    'agentic',
    'playbook-validator.ts',
  );
  if (!existsSync(distPath)) {
    console.error(
      `playbook:candidate: ${path.relative(process.cwd(), distPath)} not found — run pnpm build first.`,
    );
    process.exitCode = 1;
    return null;
  }
  const distMtimeMs = statSync(distPath).mtimeMs;
  const srcMtimeMs = existsSync(srcPath) ? statSync(srcPath).mtimeMs : 0;
  if (srcMtimeMs > distMtimeMs) {
    console.error(
      `playbook:candidate: ${path.relative(process.cwd(), distPath)} is older than its source — run pnpm build first.`,
    );
    process.exitCode = 1;
    return null;
  }
  const require = createRequire(import.meta.url);
  return require(distPath).validatePlaybook;
}

// scorecard.rowRange may be a string, a number, or a {from,to}-shaped object depending on the
// producing harness — stringify whatever shape shows up rather than assuming one.
function datasetHashFromMetrics(metricsJson) {
  const rowRange = metricsJson?.rowRange;
  if (rowRange === undefined || rowRange === null) return 'unknown';
  return typeof rowRange === 'string' ? rowRange : JSON.stringify(rowRange);
}

async function main() {
  const args = process.argv.slice(2);
  const candidateFile = args[0];
  let metricsFile;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--metrics') {
      metricsFile = args[i + 1];
      i++;
    }
  }
  if (!candidateFile) {
    usageError('missing <candidate-file> argument');
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      'playbook:candidate: DATABASE_URL is required — this is a loop action against the real DB, no default.',
    );
    process.exitCode = 1;
    return;
  }

  let content;
  try {
    content = readFileSync(candidateFile, 'utf8');
  } catch (err) {
    console.error(
      `playbook:candidate: could not read candidate file ${candidateFile}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  let metricsJson;
  if (metricsFile) {
    try {
      metricsJson = JSON.parse(readFileSync(metricsFile, 'utf8'));
    } catch (err) {
      console.error(
        `playbook:candidate: could not read/parse --metrics file ${metricsFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const validatePlaybook = loadValidatePlaybook();
  if (!validatePlaybook) return; // loadValidatePlaybook already printed the reason + set exitCode

  const validation = validatePlaybook(content);
  if (!validation.ok) {
    console.error(
      `playbook:candidate: candidate rejected: ${validation.reason}` +
        (validation.bannedToken ? ` (bannedToken=${validation.bannedToken})` : ''),
    );
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query(
      'SELECT version, content, source, parent_version FROM public.agent_playbook_versions ORDER BY version',
    );
    const active = resolveActiveVersion(rows, process.env.AGENTIC_PLAYBOOK_PIN);
    if (active === undefined) {
      console.error(
        'playbook:candidate: could not resolve an active playbook version (no seed row found) — has the app booted at least once?',
      );
      process.exitCode = 1;
      return;
    }

    const blocking = rows
      .filter(
        (r) => (r.source === 'reflection' || r.source === 'loop-candidate') && r.version > active,
      )
      .sort((a, b) => b.version - a.version)[0];
    if (blocking) {
      console.error(
        `playbook:candidate: an unresolved candidate already exists at version ${blocking.version} ` +
          `(source=${blocking.source}) — resolve it (promote or let it lapse) before minting another.`,
      );
      process.exitCode = 1;
      return;
    }

    const nextVersion = rows.reduce((max, r) => Math.max(max, r.version), 0) + 1;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO public.agent_playbook_versions (version, content, source, parent_version)
         VALUES ($1, $2, 'loop-candidate', $3)`,
        [nextVersion, content, active],
      );

      if (metricsJson !== undefined) {
        // Pre-check via to_regclass rather than try/catch-ing the INSERT itself: a 42P01
        // (undefined_table) mid-transaction would abort the transaction, and the COMMIT below would
        // then silently no-op as a rollback — losing the playbook insert along with it.
        const { rows: regRows } = await client.query(
          "SELECT to_regclass('public.experiments') AS reg",
        );
        if (regRows[0]?.reg === null) {
          console.warn(
            'playbook:candidate: public.experiments table does not exist yet — skipping the metrics row; the playbook candidate insert proceeds alone.',
          );
        } else {
          const paramsHash = createHash('sha256').update(content).digest('hex');
          const datasetHash = datasetHashFromMetrics(metricsJson);
          await client.query(
            `INSERT INTO public.experiments (family, source, params_hash, dataset_hash, metrics)
             VALUES ($1, $2, $3, $4, $5)`,
            ['playbook-candidate', 'loop', paramsHash, datasetHash, JSON.stringify(metricsJson)],
          );
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      const mapped = mapUniqueViolation(err, 'playbook:candidate');
      if (mapped) {
        console.error(mapped);
        process.exitCode = 1;
        return;
      }
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `playbook:candidate: version ${nextVersion} inserted as an INACTIVE loop-candidate (parent ${active}). ` +
        `It will be picked up by the existing A/B routing, or promote it directly once vetted.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(
    `playbook:candidate: unexpected error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
});
