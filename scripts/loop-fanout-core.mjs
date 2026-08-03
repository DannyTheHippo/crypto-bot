// Pure decision core for fan-out declaration and lane discipline (scripts/loop-fanout.mjs is the thin
// IO wrapper). Same split as loop-pass-lock-core.mjs and loop-sweep-core.mjs, for the same reason: a
// guard shipped without tests is a guard nobody has checked. Every function here is pure — no fs, no
// clock, no process.
//
// WHY THIS EXISTS: both recorded fan-out incidents so far were DETECTED and honestly reported — the
// gap is not detection, it is that nothing records what lanes were DECLARED, so a partial fan-out
// reads identically to a complete one and no later pass can falsify a completion claim. This module
// gives a fan-out a declared denominator (classifyFanoutCompletion) and a pre-flight collision check
// (classifyLanes) so two lanes cannot silently race the same file.
//
// FAILURE DIRECTION — CLOSED, deliberately the OPPOSITE of loop-pass-lock-core.mjs's fail-OPEN lease.
// State the asymmetry because it is the whole design, not an inconsistency to reconcile: a false
// positive in the pass-lock wedges the loop shut for up to STALE_MINUTES (120 min) because nothing else
// can free it. A false positive here — a scope this module refuses that was actually fine — costs one
// re-scope, paid immediately by the orchestrator that is about to dispatch anyway. The costs are not
// symmetric, so the fail directions are not either: every scope this core cannot read with confidence
// (malformed, unnormalizable, an absolute path it cannot map onto the repo tree) classifies as an
// OVERLAP, never as clear.

// The four loop files a pass reads at rehydration and writes at report time (daily-profitability-loop.md
// §1/§6) — two concurrent writers here corrupt the watermark every delta in loop-sweep-core.mjs is
// computed against, and nothing before this module wrote that down anywhere an orchestrator reads.
const LOOP_STATE_FILES = [
  'research/loop/STATUS.md',
  'research/loop/LOG.md',
  'research/loop/verdicts.md',
  'research/loop/watches.md',
];

// Deploy-knob and secrets-template surface (root CLAUDE.md's Configuration table) — a lane editing
// either mid-fan-out changes what a SIBLING lane's already-running process or already-declared scope
// means, not just its own files.
const DEPLOY_KNOB_FILES = ['package.json', '.env.app'];

// observability/ configs (verified live against the repo, 2026-08-03): the two flat rule/scrape files
// loop-sweep depends on for its promAlerts/promRules probes, plus the grafana/ subtree (dashboards +
// provisioning) as one reserved unit — new files land under grafana/ routinely (a new dashboard, a new
// datasource), and reserving the two files it already has would silently stop covering the next one.
const OBSERVABILITY_FILES = [
  'observability/alerts.rules.yml',
  'observability/prometheus.yml',
  'observability/grafana/',
];

// Toolchain configs — the NASTIEST race and the reason the reserved set is not just "the loop files":
// agent A editing eslint.config.mjs silently changes what agent B's leaf-scoped `pnpm lint` MEANS
// mid-flight. B's later green is then not evidence of anything, because the rules it was checked
// against are not the rules that existed when B started. Same argument for tsconfig*/prettier/
// markdownlint — every one of these is read by the validation step every lane is told to trust.
const TOOLCHAIN_CONFIG_FILES = [
  'tsconfig.json',
  'tsconfig.build.json',
  'tsconfig.eslint.json',
  'eslint.config.mjs',
  '.prettierrc',
  '.prettierignore',
  '.markdownlint-cli2.jsonc',
];

// The reserved set no lane may claim, in any pass. Not a lane's job to avoid these by convention — a
// declaration that touches one is REFUSED (see classifyLanes), because a convention that is only
// "usually" followed is exactly the shape that produced the two incidents this module answers.
export const ORCHESTRATOR_OWNED = [
  ...LOOP_STATE_FILES,
  ...DEPLOY_KNOB_FILES,
  ...OBSERVABILITY_FILES,
  ...TOOLCHAIN_CONFIG_FILES,
];

/**
 * Normalize a declared scope into comparable segments. Deliberately NOT globs — see the module header
 * for why: a glob buys nothing here and costs a fail-direction argument (is an unmatched glob an
 * overlap or not?). A trailing '/' is the ONLY containment signal ("this subtree"); without it a scope
 * names exactly one path, even when that path happens to be a directory on disk.
 *
 * Handles '.'/'..' segments and duplicate slashes by walking segments in order. An absolute path is
 * refused rather than guessed: this core has no repo-root parameter (staying clock/fs/env-free like its
 * siblings), so it cannot verify an absolute path maps onto THIS repo tree at all — silently assuming
 * it does would be the exact "guessed intent" this whole module exists to remove.
 * @returns {{ok:true,segments:string[],isSubtree:boolean,normalized:string}|{ok:false,reason:string}}
 */
export function normalizeScope(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'scope is not a string' };
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'empty scope' };
  if (trimmed.startsWith('/')) {
    return {
      ok: false,
      reason: `absolute path "${raw}" — cannot verify it maps onto this repo tree without a repo root, so it is refused rather than guessed`,
    };
  }
  const isSubtree = trimmed.endsWith('/');
  const rawSegments = trimmed.split('/').filter((s) => s.length > 0);
  const segments = [];
  for (const seg of rawSegments) {
    if (seg === '.') continue;
    if (seg === '..') {
      if (segments.length === 0) {
        return { ok: false, reason: `".." escapes above the repo root in "${raw}"` };
      }
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  if (segments.length === 0) {
    // Every segment was '.'/'..'-collapsed away (e.g. raw was '.', './', 'a/..') — this names the
    // WHOLE repo. Forced isSubtree:true so it correctly overlaps with every other scope below: a lane
    // that declares "the whole tree" is not a bug in this function, it is a lane claiming everything.
    return { ok: true, segments: [], isSubtree: true, normalized: '' };
  }
  return {
    ok: true,
    segments,
    isSubtree,
    normalized: segments.join('/') + (isSubtree ? '/' : ''),
  };
}

function isPrefix(shortSegments, longSegments) {
  return shortSegments.every((seg, i) => longSegments[i] === seg);
}

/**
 * Path-prefix containment between two declared scopes. Fails CLOSED: either side failing to normalize
 * (malformed, unnormalizable, absolute) makes the pair an overlap — the one thing this core refuses to
 * do is call an unreadable scope safe.
 * @returns {boolean}
 */
export function scopesOverlap(a, b) {
  const na = normalizeScope(a);
  const nb = normalizeScope(b);
  if (!na.ok || !nb.ok) return true;
  if (na.segments.length === nb.segments.length) {
    return isPrefix(na.segments, nb.segments); // equal-length prefix check IS the equality check
  }
  const [shorter, longer] = na.segments.length < nb.segments.length ? [na, nb] : [nb, na];
  // An exact-file scope (no trailing slash) never implies containment over a longer path, even one
  // that shares its name — that would be sniffing the filesystem for what the string LOOKS like, which
  // is exactly the glob-shaped ambiguity this module was built to avoid.
  if (!shorter.isSubtree) return false;
  return isPrefix(shorter.segments, longer.segments);
}

/**
 * Classify a declared lane roster against pairwise overlap AND the ORCHESTRATOR_OWNED reserved set.
 * lanes: [{ name: string, scopes: string[] }, ...]. Never throws — a malformed lane entry (missing
 * name/scopes) is walked defensively rather than crashing the declare step it is supposed to protect.
 * @returns {{ok:boolean,violations:Array<{kind:'reserved'|'overlap',detail:string,[key:string]:unknown}>}}
 */
export function classifyLanes(lanes) {
  const violations = [];
  const safeLanes = Array.isArray(lanes) ? lanes : [];

  for (const lane of safeLanes) {
    const name = lane && typeof lane.name === 'string' ? lane.name : '(unnamed lane)';
    const scopes = Array.isArray(lane && lane.scopes) ? lane.scopes : [];
    for (const scope of scopes) {
      for (const reserved of ORCHESTRATOR_OWNED) {
        if (scopesOverlap(scope, reserved)) {
          violations.push({
            kind: 'reserved',
            lane: name,
            scope,
            reserved,
            detail: `lane "${name}" scope "${scope}" claims ORCHESTRATOR_OWNED path "${reserved}" — the orchestrator exclusively owns this file; no lane may declare it`,
          });
        }
      }
    }
  }

  for (let i = 0; i < safeLanes.length; i++) {
    for (let j = i + 1; j < safeLanes.length; j++) {
      const laneA = safeLanes[i];
      const laneB = safeLanes[j];
      const nameA = laneA && typeof laneA.name === 'string' ? laneA.name : `(lane ${i})`;
      const nameB = laneB && typeof laneB.name === 'string' ? laneB.name : `(lane ${j})`;
      const scopesA = Array.isArray(laneA && laneA.scopes) ? laneA.scopes : [];
      const scopesB = Array.isArray(laneB && laneB.scopes) ? laneB.scopes : [];
      for (const scopeA of scopesA) {
        for (const scopeB of scopesB) {
          if (scopesOverlap(scopeA, scopeB)) {
            violations.push({
              kind: 'overlap',
              laneA: nameA,
              laneB: nameB,
              scopeA,
              scopeB,
              detail: `lane "${nameA}" scope "${scopeA}" overlaps lane "${nameB}" scope "${scopeB}"`,
            });
          }
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Declared lanes vs. what actually reported back at join. Marginal on its own — it is one Set-diff —
 * and it is honest to say so: it earns its place only because it rides a manifest (classifyLanes'
 * input) that has to exist anyway for the collision check above, and because a bare Set-diff is what
 * turns a partial fan-out claim into something a LATER pass can falsify instead of trusting prose.
 * @returns {{status:'complete'|'partial'|'extra',missing:string[],extra:string[]}}
 */
export function classifyFanoutCompletion(declared, returned) {
  const declaredSet = new Set(
    (Array.isArray(declared) ? declared : []).filter((n) => typeof n === 'string'),
  );
  const returnedSet = new Set(
    (Array.isArray(returned) ? returned : []).filter((n) => typeof n === 'string'),
  );
  const missing = [...declaredSet].filter((n) => !returnedSet.has(n));
  const extra = [...returnedSet].filter((n) => !declaredSet.has(n));
  const status = missing.length > 0 ? 'partial' : extra.length > 0 ? 'extra' : 'complete';
  return { status, missing, extra };
}
