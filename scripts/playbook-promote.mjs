#!/usr/bin/env node
// Governed playbook promotion (§G4b) — `pnpm playbook:promote <version>`. Inserts a
// source='promotion' row pointing at <version>; PlaybookStoreAdapter.resolve() picks up the
// newest promotion row's parentVersion target on the NEXT process boot (see its header comment).
// This script never touches a running process, and auto-promotion is deliberately NOT implemented
// here — see src/features/trading/agentic/README.md for the evidence gate that gaits it.

import pg from 'pg';
import { resolveActiveVersion, mapUniqueViolation } from './lib/playbook-shared.mjs';

const { Pool } = pg;

function usageError(message) {
  console.error(`playbook:promote: ${message}`);
  console.error('usage: pnpm playbook:promote <version>');
  process.exitCode = 1;
}

async function main() {
  const versionArg = process.argv[2];
  const version = Number(versionArg);
  if (!versionArg || !Number.isInteger(version) || version <= 0) {
    usageError(`invalid version argument ${JSON.stringify(versionArg ?? '(missing)')}`);
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      'playbook:promote: DATABASE_URL is required — this is an operator action against the real DB, no default.',
    );
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query(
      'SELECT version, content, source, parent_version FROM public.agent_playbook_versions ORDER BY version',
    );
    const target = rows.find((r) => r.version === version);
    if (!target) {
      const available = rows.map((r) => r.version).join(', ') || '(none)';
      console.error(`playbook:promote: version ${version} does not exist. Available: ${available}`);
      process.exitCode = 1;
      return;
    }

    const active = resolveActiveVersion(rows, process.env.AGENTIC_PLAYBOOK_PIN);
    if (active === version) {
      console.warn(
        `playbook:promote: version ${version} already resolves as active; proceeding anyway.`,
      );
    }

    const nextVersion = Math.max(...rows.map((r) => r.version)) + 1;
    // A 'promotion' row carries a rationale/audit note, not the active content — resolve() reads
    // parentVersion's own row for that (see PlaybookStoreAdapter.append's jsdoc).
    const auditNote = `promoted version ${version} via playbook:promote on ${new Date().toISOString()}`;
    try {
      await pool.query(
        `INSERT INTO public.agent_playbook_versions (version, content, source, parent_version)
         VALUES ($1, $2, 'promotion', $3)`,
        [nextVersion, auditNote, version],
      );
    } catch (err) {
      const mapped = mapUniqueViolation(err, 'playbook:promote');
      if (mapped) {
        console.error(mapped);
        process.exitCode = 1;
        return;
      }
      throw err;
    }

    console.log(
      `playbook:promote: version ${version} will become active on next boot (promotion row ${nextVersion} recorded). ` +
        `Pin via AGENTIC_PLAYBOOK_PIN=${version} to force it immediately, or to refuse drift.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(
    `playbook:promote: unexpected error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
});
