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
// gives for candidate routing. The classification behind that refusal (and the lapse that bounds
// it) lives in playbook-candidate-core.mjs, which also states both gates' failure directions; this
// file is the IO shell.

import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  resolveActiveVersion,
  mapUniqueViolation,
  readVersionEntryStats,
} from './lib/playbook-shared.mjs';
import {
  DEFAULT_ABSTAIN_LAPSE_DECIDES,
  DEFAULT_CANDIDATE_LAPSE_HOURS,
  classifyCandidateGate,
  classifyContentChange,
  deriveValidationOpts,
  findBlockingCandidate,
  intEnv,
  needsAbstentionEvidence,
  parseArgs,
} from './playbook-candidate-core.mjs';

const { Pool } = pg;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function usageError(message) {
  console.error(`playbook:candidate: ${message}`);
  console.error(
    'usage: node scripts/playbook-candidate.mjs <candidate-file> [--metrics <scorecard.json>] [--supersede]',
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
    // 'strategy', not 'trading' — the agentic lane lives under features/strategy/agentic (see
    // .claude/CLAUDE.md § Project layout). The stale 'trading' spelling made this resolve to a path
    // that has never existed, so the freshness check below reported "run pnpm build first" on every
    // invocation including immediately after a successful build.
    'strategy',
    'agentic',
    'playbook-validator.js',
  );
  const srcPath = path.join(
    SCRIPT_DIR,
    '..',
    'src',
    'features',
    // 'strategy', not 'trading' — the agentic lane lives under features/strategy/agentic (see
    // .claude/CLAUDE.md § Project layout). The stale 'trading' spelling made this resolve to a path
    // that has never existed, so the freshness check below reported "run pnpm build first" on every
    // invocation including immediately after a successful build.
    'strategy',
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
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    usageError(parsed.error);
    return;
  }
  const { candidateFile, metricsFile, supersede } = parsed;

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

  // Capabilities must match what the runtime read path uses or this CLI rejects prose the lane
  // serves — see playbook-candidate-core.mjs's header for the failure direction.
  const { opts: validationOpts, derivedFrom } = deriveValidationOpts(process.env.VENUES);
  const validation = validatePlaybook(content, validationOpts);
  if (!validation.ok) {
    console.error(
      `playbook:candidate: candidate rejected: ${validation.reason}` +
        (validation.bannedToken ? ` (bannedToken=${validation.bannedToken})` : ''),
    );
    console.error(
      `playbook:candidate: validated with shortsAllowed=${validationOpts.shortsAllowed} ` +
        `leverageAllowed=${validationOpts.leverageAllowed}, derived from ${derivedFrom}.`,
    );
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query(
      'SELECT version, content, source, parent_version, created_at FROM public.agent_playbook_versions ORDER BY version',
    );
    const active = resolveActiveVersion(rows, process.env.AGENTIC_PLAYBOOK_PIN);
    if (active === undefined) {
      console.error(
        'playbook:candidate: could not resolve an active playbook version (no seed row found) — has the app booted at least once?',
      );
      process.exitCode = 1;
      return;
    }

    const change = classifyContentChange(content, rows.find((r) => r.version === active)?.content);
    if (!change.changed) {
      console.error(
        `playbook:candidate: candidate is byte-identical to the active playbook (version ${active}, ` +
          `sha256 ${change.candidateSha.slice(0, 12)}) — nothing to A/B, refusing to burn a version.`,
      );
      process.exitCode = 1;
      return;
    }

    const lapseMs =
      intEnv(process.env.AGENTIC_CANDIDATE_LAPSE_HOURS, DEFAULT_CANDIDATE_LAPSE_HOURS) * 3_600_000;
    const abstainLapseDecides = intEnv(
      process.env.AGENTIC_ABSTAIN_LAPSE_DECIDES,
      DEFAULT_ABSTAIN_LAPSE_DECIDES,
    );
    const blocking = findBlockingCandidate(rows, active);
    const nowMs = Date.now();
    const gateInput = { blocking, nowMs, lapseMs, abstainLapseDecides, supersede };
    const stats = needsAbstentionEvidence(gateInput)
      ? await readVersionEntryStats(pool, blocking.version, 'playbook:candidate')
      : undefined;
    const gate = classifyCandidateGate({ ...gateInput, stats });
    if (!gate.proceed) {
      console.error(`playbook:candidate: ${gate.reason}`);
      process.exitCode = 1;
      return;
    }
    if (gate.lapse === 'age') {
      console.warn(
        `playbook:candidate: candidate v${gate.blocking.version} lapsed after ${Math.round(gate.ageMs / 3_600_000)}h ` +
          'without resolving — minting over it (deliberate, logged orphaning; the row is retained).',
      );
    } else if (gate.lapse === 'abstention') {
      console.warn(
        `playbook:candidate: candidate v${gate.blocking.version} provably abstains live ` +
          `(${gate.stats.entries} entries in ${gate.stats.decides} lifetime attributed decides ≥ ${abstainLapseDecides}) — ` +
          'lapsing it early and minting over it.',
      );
    }

    // Pre-check via to_regclass rather than try/catch-ing the INSERT itself: a 42P01
    // (undefined_table) mid-transaction would abort the transaction, and the COMMIT below would then
    // silently no-op as a rollback — losing the playbook insert along with it. Hoisted above BEGIN
    // so --supersede can refuse BEFORE writing anything.
    const { rows: regRows } = await pool.query("SELECT to_regclass('public.experiments') AS reg");
    const experimentsExists = regRows[0]?.reg !== null;
    // --supersede's entire purpose is the RECORD (agent_playbook_versions is append-only historical
    // evidence, so an override that leaves no trace of what it overrode is worse than the deadlock
    // it relieves). Fails CLOSED: no registry, no override.
    if (gate.lapse === 'supersede' && !experimentsExists) {
      console.error(
        'playbook:candidate: --supersede cannot record the supersession — public.experiments does not exist. ' +
          'Refusing to orphan a candidate off the record; run migrations first.',
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

      // Supersession evidence, in the SAME transaction as the mint it authorises — a committed
      // orphaning with an uncommitted record is the one outcome this flag must never produce.
      if (gate.lapse === 'supersede') {
        await client.query(
          `INSERT INTO public.experiments (family, source, params_hash, dataset_hash, label, metrics)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            'playbook-supersede',
            'loop',
            change.candidateSha,
            `superseded:v${gate.blocking.version}`,
            `v${gate.blocking.version} (${gate.blocking.source}) superseded by v${nextVersion} via --supersede`,
            JSON.stringify({
              supersededVersion: gate.blocking.version,
              supersededSource: gate.blocking.source,
              supersededAgeHours: gate.ageMs === null ? null : Math.round(gate.ageMs / 3_600_000),
              lapseHours: Math.round(lapseMs / 3_600_000),
              newVersion: nextVersion,
              activeVersion: active,
            }),
          ],
        );
      }

      if (metricsJson !== undefined) {
        if (!experimentsExists) {
          console.warn(
            'playbook:candidate: public.experiments table does not exist yet — skipping the metrics row; the playbook candidate insert proceeds alone.',
          );
        } else {
          const datasetHash = datasetHashFromMetrics(metricsJson);
          await client.query(
            `INSERT INTO public.experiments (family, source, params_hash, dataset_hash, metrics)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              'playbook-candidate',
              'loop',
              change.candidateSha,
              datasetHash,
              JSON.stringify(metricsJson),
            ],
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
        `It will be picked up by the existing A/B routing, or promote it directly once vetted.` +
        (gate.lapse === 'supersede'
          ? ` Supersession of v${gate.blocking.version} recorded in public.experiments (family=playbook-supersede); no row was deleted.`
          : ''),
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
