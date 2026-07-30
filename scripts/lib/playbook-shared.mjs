// Shared helpers for the operator/loop CLIs against public.agent_playbook_versions
// (playbook-promote.mjs, playbook-candidate.mjs, loop-authoring.mjs). Kept dependency-free (no pg
// import here) so every caller owns its own Pool lifecycle.

// Mirrors PlaybookStoreAdapter.resolve()'s precedence (pin > newest promotion's parentVersion >
// seed) closely enough for an operator "is this already active?" hint — not authoritative; the
// running process resolves this itself, independently, at boot.
export function resolveActiveVersion(rows, pinEnv) {
  const pin = pinEnv ? Number(pinEnv) : undefined;
  if (pin !== undefined && rows.some((r) => r.version === pin)) return pin;

  const newestPromotion = rows
    .filter((r) => r.source === 'promotion')
    .sort((a, b) => b.version - a.version)[0];
  if (newestPromotion && rows.some((r) => r.version === newestPromotion.parent_version)) {
    return newestPromotion.parent_version;
  }

  // Seed fallback. The runtime does NOT take the first seed row: PlaybookStoreAdapter.ensureSeed()
  // looks up `seed.version` SPECIFICALLY, and the composition root binds SEED_PLAYBOOK_V3, whose
  // version is bumped ABOVE every prior row at each cutover precisely so ensureSeed inserts a fresh
  // one (agentic-strategy.module.ts documents that rule for 1→2, 6 and 7→8). The NEWEST seed row is
  // therefore the deployed seed; the FIRST one is whichever retired cutover happened to land lowest.
  //
  // Verified against the live table on 2026-07-30 — seed rows at versions 1, 2, 6 and 8, no
  // 'promotion' row, AGENTIC_PLAYBOOK_PIN empty — where the old first-match returned 1 while the
  // running process resolved 8. Every candidate this CLI minted would have recorded
  // parent_version=1 into an append-only table that cannot be corrected afterwards.
  return rows.filter((r) => r.source === 'seed').sort((a, b) => b.version - a.version)[0]?.version;
}

// A playbook version's LIFETIME decide/entry counts — the SQL form of
// AgentDecisionJournalPort.versionEntryStats (agent-decision.repository.ts#countVersionEntryStats):
// real-LLM rows only, entries are the two OPEN actions. Returns undefined on any failure, which every
// caller must read as "no evidence" rather than as a measured zero — playbook-candidate's abstention
// lapse and loop-authoring's evidence digest both depend on that distinction.
export async function readVersionEntryStats(pool, version, scriptName) {
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS decides,
              count(*) FILTER (WHERE action IN ('open_long', 'open_short'))::int AS entries
         FROM public.agent_decisions
        WHERE playbook_version = $1 AND model LIKE 'claude%'`,
      [version],
    );
    const row = rows[0];
    if (!row) return undefined;
    return { decides: row.decides ?? 0, entries: row.entries ?? 0 };
  } catch (err) {
    console.warn(
      `${scriptName}: versionEntryStats read failed for v${version} (treated as NO evidence): ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

// Maps a Postgres unique-violation (23505) on agent_playbook_versions into the operator-facing
// message string, or returns null for any other error (caller rethrows in that case). `scriptName`
// is the CLI's own log prefix (e.g. 'playbook:promote', 'playbook:candidate') so the message reads
// consistently with the rest of that script's output.
export function mapUniqueViolation(err, scriptName) {
  if (err?.code !== '23505') return null;
  if (err.constraint === 'agent_playbook_versions_promotion_per_day_uidx') {
    return `${scriptName}: a promotion has already landed today — promotion is limited to once per UTC day.`;
  }
  return `${scriptName}: version collision on constraint ${err.constraint ?? 'unknown'} (likely a concurrent reflection append) — retry.`;
}
