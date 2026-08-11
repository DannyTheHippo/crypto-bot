#!/usr/bin/env node
// Out-of-sample SESSION arm — VOID-4 (blindness) transcript CHECK, the I/O shell. Reads a dispatched
// decide-leg subagent's own transcript from Claude Code harness session storage, runs it through the
// pure classifier (loop-oos-transcript-core.mjs), and appends a small ATTESTATION record to
// research/oos-arm/attestations.jsonl. Mirrors the shell/core split loop-oos-arm.mjs uses for the same
// study: this file makes no judgement about the data beyond "did the read succeed" — the core owns
// every classification.
//
// CRITICAL: this tool NEVER copies or moves the transcript. research/studies/oos-session-arm-2026-08-03.md's
// 2026-08-10 amendment § 4 requires the dispatched subagent's own transcript to be "never summarized,
// redacted, or regenerated" — it is the VOID-4 artifact itself, and stays exactly where the harness
// wrote it. The attestation this shell writes is an ADDITION that records the CHECK and pins the
// transcript's bytes by sha256; it is never a substitute for the artifact, and reading it in place
// (rather than copying it into the repo) is a hard constraint, not a convenience — copying the
// transcript into the repo has been attempted and refused by the host permission gate twice (Pass 67,
// Pass 68).
//
// FAILURE DIRECTION — fails CLOSED, inherited from the core (see that file's header): a missing
// transcript is a FATAL naming the path tried, never a silent skip, and the process exit code reflects
// the blindness verdict (0 clean, 1 violated) so a caller scripting this into a pass can gate on it.

import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import {
  extractToolCalls,
  classifyBlindness,
  buildAttestation,
} from './loop-oos-transcript-core.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const DEFAULT_OUT = join(REPO_ROOT, 'research', 'oos-arm', 'attestations.jsonl');

/** The same slug transform the Claude Code harness applies to a project's absolute repo path when
 * naming its `~/.claude/projects/<slug>/` directory — every non-alphanumeric character becomes `-`.
 * Verified 2026-08-11 against this repo's own live session directory (`ls ~/.claude/projects/`),
 * because a guessed transform that happened to look plausible is exactly how a void-4 check would
 * silently read the wrong (or no) transcript. */
export function projectSlug(repoRootAbsolutePath) {
  return String(repoRootAbsolutePath).replace(/[^a-zA-Z0-9]/g, '-');
}

/** Strips the username-bearing home-directory prefix off a project slug before it is ever written to
 * the (git-tracked) attestation record — see loop-oos-transcript-core.mjs's `buildAttestation`
 * docstring, schemaVersion 2. `repoRoot` always lives under `home`, so `projectSlug(home)` is exactly
 * the leading segment `projectSlug(repoRoot)` shares with it (e.g. `projectSlug('/Users/<user>')`);
 * removing that shared prefix removes the username without touching the rest of the slug, which
 * carries no username. Returns the slug unchanged (never throws, never fabricates a path) if it does
 * not start with that prefix — i.e. there was no home-slug prefix to strip. `pathBase` is a separate,
 * independently computed field (see `main` below) and does not reflect this function's outcome. */
export function stripHomeSlugPrefix(slug, home) {
  const homeSlug = projectSlug(home);
  return slug.startsWith(homeSlug) ? slug.slice(homeSlug.length).replace(/^-+/, '') : slug;
}

export function transcriptPathFor({ repoRoot = REPO_ROOT, sessionId, agentId, home = homedir() }) {
  const slug = projectSlug(repoRoot);
  return join(home, '.claude', 'projects', slug, sessionId, 'subagents', `agent-${agentId}.jsonl`);
}

export function metaPathFor({ repoRoot = REPO_ROOT, sessionId, agentId, home = homedir() }) {
  const slug = projectSlug(repoRoot);
  return join(
    home,
    '.claude',
    'projects',
    slug,
    sessionId,
    'subagents',
    `agent-${agentId}.meta.json`,
  );
}

/** Argv parser. Unknown `--options` are rejected rather than ignored — a mistyped flag that silently
 * no-ops would leave the intended input unset and let a required check fall through unexercised, which
 * is the wrong kind of silent for a fail-closed gate. `--allow` is repeatable and accumulates. There is
 * no `--allow-dir`: `Bash` is an unconditional violation now (see `classifyBlindness`'s `disallowed_tool`
 * rule), so there is no directory prefix left to configure. */
export function parseArgs(argv) {
  const out = { allow: [], dryRun: false, out: DEFAULT_OUT, rows: undefined };
  const singleValued = {
    '--agent': 'agent',
    '--session': 'session',
    '--pass': 'pass',
    '--firing': 'firing',
    '--rows': 'rows',
    '--out': 'out',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (arg === '--allow') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return { error: '--allow requires a value' };
      out.allow.push(next);
      i++;
      continue;
    }
    const key = singleValued[arg];
    if (key !== undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return { error: `${arg} requires a value` };
      out[key] = next;
      i++;
      continue;
    }
    return { error: `unknown option "${arg}"` };
  }
  for (const required of ['agent', 'session', 'pass', 'firing']) {
    if (!out[required]) return { error: `--${required} is required` };
  }
  if (out.allow.length === 0) {
    return { error: '--allow is required (at least one offered-surface file)' };
  }
  if (out.firing !== '1' && out.firing !== '2') {
    return { error: `--firing must be 1 or 2, got "${out.firing}"` };
  }
  return out;
}

/** The sibling `agent-<agentId>.meta.json`, or `{agentType:null, model:null}` on any absence/parse
 * failure — this is an ANNOTATION, not a gate: the blindness verdict never depends on it. */
function readMeta(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      agentType: typeof parsed.agentType === 'string' ? parsed.agentType : null,
      model: typeof parsed.model === 'string' ? parsed.model : null,
    };
  } catch {
    return { agentType: null, model: null };
  }
}

function summaryLines({ agentId, transcriptBytes, sha256, toolCallCount, verdict }) {
  const lines = [
    `agent:          ${agentId}`,
    `transcriptBytes: ${transcriptBytes}`,
    `sha256(first16): ${sha256.slice(0, 16)}`,
    `toolCalls:       ${toolCallCount}`,
  ];
  if (verdict.clean) {
    lines.push('VOID-4 CHECK: CLEAN — no tool call read outside the offered surface');
  } else {
    lines.push(`VOID-4 CHECK: VIOLATED (${verdict.violations.length})`);
    for (const v of verdict.violations) {
      lines.push(`  line ${v.lineIndex} ${v.name ?? ''} [${v.reason}] ${v.detail}`);
    }
  }
  return lines;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`loop-oos-transcript: FATAL ${args.error}\n`);
    process.exitCode = 1;
    return;
  }

  const home = homedir();
  const transcriptPath = transcriptPathFor({ sessionId: args.session, agentId: args.agent, home });
  if (!existsSync(transcriptPath)) {
    process.stderr.write(
      `loop-oos-transcript: FATAL transcript not found at ${transcriptPath} — this tool reads the ` +
        'harness-owned subagent transcript IN PLACE and never regenerates or fabricates one\n',
    );
    process.exitCode = 1;
    return;
  }

  const raw = readFileSync(transcriptPath); // raw Buffer — sha256 is over BYTES, not the decoded string
  const transcriptSha256 = createHash('sha256').update(raw).digest('hex');
  const transcriptBytes = raw.length;
  const text = raw.toString('utf8');

  const meta = readMeta(metaPathFor({ sessionId: args.session, agentId: args.agent, home }));

  const { toolCalls, lineCount, unparseableLines, unknownBlocks } = extractToolCalls(text);
  const verdict = classifyBlindness({
    toolCalls,
    unparseableLines,
    unknownBlocks,
    allowedPaths: args.allow,
  });

  const rowIds =
    args.rows === undefined
      ? null
      : args.rows
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

  // The written record must carry no absolute host path or username (rules/code-hygiene.md § Secrets
  // and paths — this appends to a git-tracked file). `transcriptPath` is always constructed under
  // `home` by `transcriptPathFor`, so this is the live branch; the `not-under-home` arm exists so a
  // future caller can never regress into silently emitting an absolute path instead.
  const underHome = transcriptPath === home || transcriptPath.startsWith(home + sep);
  const transcriptPathFromHome = underHome
    ? join(
        '.claude',
        'projects',
        stripHomeSlugPrefix(projectSlug(REPO_ROOT), home),
        args.session,
        'subagents',
        `agent-${args.agent}.jsonl`,
      )
    : null;
  const pathBase = underHome ? 'home' : 'not-under-home';

  const attestation = buildAttestation({
    passLabel: args.pass,
    firing: Number(args.firing),
    agentId: args.agent,
    sessionId: args.session,
    agentType: meta.agentType,
    model: meta.model,
    transcriptPathFromHome,
    pathBase,
    projectSlugSuffix: basename(REPO_ROOT),
    transcriptSha256,
    transcriptBytes,
    lineCount,
    toolCallCount: toolCalls.length,
    allowedFiles: args.allow.map((p) => basename(p)),
    allowedBase: '<session-scratch>',
    blindnessClean: verdict.clean,
    violations: verdict.violations,
    capturedAtIso: new Date().toISOString(),
    rowIds,
  });

  for (const line of summaryLines({
    agentId: args.agent,
    transcriptBytes,
    sha256: transcriptSha256,
    toolCallCount: toolCalls.length,
    verdict,
  })) {
    process.stdout.write(`${line}\n`);
  }

  if (!args.dryRun) {
    mkdirSync(dirname(args.out), { recursive: true });
    // APPEND ONLY — never rewrite an existing line. One JSON line, `\n`-terminated, no trailing spaces.
    appendFileSync(args.out, `${JSON.stringify(attestation)}\n`);
  }

  process.exitCode = verdict.clean ? 0 : 1;
}

// CLI entry-point guard, same idiom as loop-oos-arm.mjs: an `import` (a future spec suite importing
// the helpers above) must not fire a blocking transcript read as an import side effect.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
