// Pure decision core for the loop→lane playbook mint (scripts/playbook-candidate.mjs is the IO
// shell). Split out for the same reason loop-pass-lock-core.mjs is: the interesting behaviour is
// the classification, and a mint gate shipped without tests is a gate nobody has checked. Every
// function here is pure — no fs, no pg, no clock, no process (createHash is deterministic).
//
// FAILURE DIRECTIONS — two gates, opposite polarities, both previously implicit:
//
//  * deriveValidationOpts (capability mirror) fails OPEN. It exists solely so this CLI validates the
//    way the runtime read side does: agentic-bridge.module.ts's PLAYBOOK_PROVIDER_OVERRIDE factory
//    fixes {shortsAllowed, leverageAllowed} true for every v3 boot and threads that pair into both
//    PlaybookAbRoutingProvider and ValidatingPlaybookProvider. A CLI STRICTER than the runtime
//    rejects perp-legal prose the lane serves happily — that was the live defect (the active v3 seed
//    itself says "the 5x leverage cap", which trips the spot leverage pattern), and it closed the
//    only loop→lane authoring channel there is. Being looser is bounded: the read path re-validates
//    the same bytes, so the runtime is the actual boundary. An absent or unreadable VENUES therefore
//    falls back to the runtime's fixed-open pair, never to spot-strict.
//
//  * classifyCandidateGate (unresolved-candidate gate) fails CLOSED per invocation, but is
//    TIME-BOUNDED by construction. Minting over a live candidate orphans it below its attributed-trip
//    floor AND writes a parent_version into an append-only table that can never be corrected, so an
//    unresolved candidate refuses the mint. A permanently-closed gate is its own failure though —
//    that is the deadlock this repairs: the script's blocking filter carried no age predicate while
//    the runtime's did (reflection.service.ts), so v9 (minted 2026-07-27, unresolved) blocked every
//    `pnpm playbook:candidate` invocation with no expiry at all. The refusal now expires at
//    candidateLapseMs, lifts early on proven live abstention, and can be overridden by an explicit
//    --supersede that RECORDS the supersession. The abstention sub-read fails toward NOT lapsing:
//    absent or failed evidence must preserve the candidate, never authorise a destructive orphaning.

import { createHash } from 'node:crypto';

// Mirrors PERP_VENUE (src/domain/venue/types/venue-map.ts). scripts/** sits outside the tsconfig
// project, so the literal is duplicated rather than imported and pinned by a spec instead.
export const PERP_VENUE_ID = 'binanceusdm';

// The exact pair agentic-bridge.module.ts hands the validator on the read path.
const PERP_CAPABILITIES = { shortsAllowed: true, leverageAllowed: true };
const SPOT_CAPABILITIES = { shortsAllowed: false, leverageAllowed: false };

// Mirrors reflection.service.ts's own defaults so an invocation without the env file behaves like
// the runtime would with the same gap (.env.app sets 336h / 15 decides).
export const DEFAULT_CANDIDATE_LAPSE_HOURS = 720;
export const DEFAULT_ABSTAIN_LAPSE_DECIDES = 15;

// Sources PlaybookAbRoutingProvider treats as routable candidates above the active version.
const CANDIDATE_SOURCES = ['reflection', 'loop-candidate'];

function parseVenueIds(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const ids = parsed
    .map((v) => (v !== null && typeof v === 'object' ? v.id : undefined))
    .filter((id) => typeof id === 'string' && id !== '');
  return ids.length === 0 ? null : ids;
}

/**
 * Validator capabilities for the candidate about to be minted, derived from the VENUES env the
 * deployment boots with. Fails OPEN — see this file's header.
 * @returns {{opts:{shortsAllowed:boolean,leverageAllowed:boolean},derivedFrom:string}}
 */
export function deriveValidationOpts(venuesRaw) {
  const ids = parseVenueIds(venuesRaw);
  if (ids === null) {
    return {
      opts: { ...PERP_CAPABILITIES },
      derivedFrom: 'runtime default (VENUES unset or unreadable)',
    };
  }
  if (ids.includes(PERP_VENUE_ID)) {
    return { opts: { ...PERP_CAPABILITIES }, derivedFrom: `VENUES (${PERP_VENUE_ID} present)` };
  }
  return { opts: { ...SPOT_CAPABILITIES }, derivedFrom: `VENUES (spot only: ${ids.join(',')})` };
}

/** Newest routable candidate sitting above the active version, or undefined. */
export function findBlockingCandidate(rows, active) {
  let newest;
  for (const r of rows) {
    if (!(r.version > active)) continue;
    if (!CANDIDATE_SOURCES.includes(r.source)) continue;
    if (newest === undefined || r.version > newest.version) newest = r;
  }
  return newest;
}

function createdAtMs(row) {
  const raw = row?.created_at ?? row?.createdAt;
  if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? raw.getTime() : null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Is the abstention-lapse evidence read worth running? Only when a blocking candidate exists, the
 * operator has not superseded it, the age lapse has not already fired, and the lapse is enabled —
 * so the shell never pays for a query whose answer cannot change the outcome.
 */
export function needsAbstentionEvidence({
  blocking,
  nowMs,
  lapseMs,
  abstainLapseDecides = DEFAULT_ABSTAIN_LAPSE_DECIDES,
  supersede = false,
}) {
  if (blocking === undefined || blocking === null) return false;
  if (supersede) return false;
  if (abstainLapseDecides <= 0) return false;
  const created = createdAtMs(blocking);
  return created === null || nowMs - created < lapseMs;
}

/**
 * The unresolved-candidate gate. Fails CLOSED but time-bounded — see this file's header.
 * `stats` is the blocking candidate's lifetime {decides, entries}, or undefined when the evidence
 * could not be read (which must NOT lapse).
 * @returns {{proceed:true,lapse:null|'supersede'|'age'|'abstention',blocking?:object,ageMs?:number|null,stats?:object}
 *          |{proceed:false,blocking:object,ageMs:number|null,reason:string}}
 */
export function classifyCandidateGate({
  blocking,
  nowMs,
  lapseMs,
  abstainLapseDecides = DEFAULT_ABSTAIN_LAPSE_DECIDES,
  stats,
  supersede = false,
}) {
  if (blocking === undefined || blocking === null) return { proceed: true, lapse: null };

  const created = createdAtMs(blocking);
  const ageMs = created === null ? null : nowMs - created;
  const label = `v${blocking.version} (${blocking.source})`;

  if (supersede) return { proceed: true, lapse: 'supersede', blocking, ageMs };
  if (ageMs !== null && ageMs >= lapseMs) return { proceed: true, lapse: 'age', blocking, ageMs };

  // Live-abstention escape, ported from reflection.service.ts: a candidate with plenty of attributed
  // real decides and zero entries can never start its 10-trip verdict clock, so waiting out the age
  // window buys nothing. Requires POSITIVE evidence — undefined stats (table absent, query failed)
  // leaves the candidate protected.
  if (
    abstainLapseDecides > 0 &&
    stats !== undefined &&
    stats !== null &&
    stats.decides >= abstainLapseDecides &&
    stats.entries === 0
  ) {
    return { proceed: true, lapse: 'abstention', blocking, ageMs, stats };
  }

  if (ageMs === null) {
    return {
      proceed: false,
      blocking,
      ageMs,
      reason:
        `candidate ${label} has no readable created_at, so its lapse cannot be established — ` +
        'refusing rather than orphaning it on an unknown age (pass --supersede to override; the supersession is recorded).',
    };
  }
  return {
    proceed: false,
    blocking,
    ageMs,
    reason:
      `an unresolved candidate already exists at ${label}, age ${Math.round(ageMs / 3_600_000)}h ` +
      `< lapse ${Math.round(lapseMs / 3_600_000)}h (AGENTIC_CANDIDATE_LAPSE_HOURS) — promote it, ` +
      'wait for the lapse, or pass --supersede to override (the supersession is recorded, no row is deleted).',
  };
}

export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * A candidate byte-identical to the active playbook teaches the A/B router nothing and burns a
 * version number in an append-only table. Refuses only on PROVEN identity: when the active content
 * is unavailable the check cannot fire, which is the right direction for a duplicate-avoidance
 * nicety (it is not a safety gate — the mint is still an INACTIVE row).
 * @returns {{changed:boolean,candidateSha:string,activeSha:string|null}}
 */
export function classifyContentChange(candidateContent, activeContent) {
  const candidateSha = sha256Hex(candidateContent);
  if (typeof activeContent !== 'string') return { changed: true, candidateSha, activeSha: null };
  const activeSha = sha256Hex(activeContent);
  return { changed: candidateSha !== activeSha, candidateSha, activeSha };
}

/**
 * Parse argv. Unknown `--options` are rejected rather than ignored: a mistyped `--supersed` that
 * silently became a no-op would report a refusal the operator believes they overrode.
 * @returns {{candidateFile:string,metricsFile:string|undefined,supersede:boolean}|{error:string}}
 */
export function parseArgs(argv) {
  let candidateFile;
  let metricsFile;
  let supersede = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--supersede') {
      supersede = true;
      continue;
    }
    if (arg === '--metrics') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        return { error: '--metrics requires a scorecard file path' };
      }
      metricsFile = next;
      i++;
      continue;
    }
    if (arg.startsWith('-')) return { error: `unknown option "${arg}"` };
    if (candidateFile === undefined) {
      candidateFile = arg;
      continue;
    }
    return { error: `unexpected extra argument "${arg}"` };
  }
  if (candidateFile === undefined) return { error: 'missing <candidate-file> argument' };
  return { candidateFile, metricsFile, supersede };
}

/** Env integer with a fallback, matching reflection.service.ts's intEnv semantics. */
export function intEnv(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
