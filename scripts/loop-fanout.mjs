#!/usr/bin/env node
// Fan-out declaration IO shell — `pnpm loop:fanout declare --file <lanes.json>`,
// `pnpm loop:fanout join <lane-name> [<lane-name> ...]`. All decision logic lives in
// loop-fanout-core.mjs (unit-tested on the production gate); this file is fs/argv plumbing only.
//
// Written for the declared-denominator gap: a partial fan-out currently reads identically to a
// complete one, because nothing records which lanes were DECLARED before dispatch. `declare` fixes
// that by writing the roster up front and refusing (non-zero exit) on any overlap or reserved-path
// claim; `join` is the reporting step at the end, printing a copy-pasteable disclosure of any lane
// that did not return — see docs/planning/daily-profitability-loop.md §4.6 for the procedure this
// implements.
//
// Manifest at research/loop/digests/.fanout.json — gitignored via the existing
// `research/loop/digests/` rule (verified: `git check-ignore` already resolves this exact path, so no
// separate .gitignore line was needed). It is scoped to ONE active fan-out per pass: `declare`
// overwrites unconditionally, which is safe only because the pass-lock (`loop:lock`, §1 step 3) already
// guarantees a single pass holds this working tree at a time — this manifest is not itself a second
// lock.
//
// FAIL DIRECTION: `declare` fails CLOSED (non-zero exit on any violation — a shell caller cannot
// pipe past it) because it is a pre-flight gate on dispatch that has not happened yet. `join` fails
// OPEN (always exits 0) because it runs AFTER the lanes already ran — it is a reporting step, not a
// gate, and the whole point is that a partial return must never block the disclosure that names it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyFanoutCompletion, classifyLanes } from './loop-fanout-core.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MANIFEST_FILE = join(SCRIPT_DIR, '..', 'research', 'loop', 'digests', '.fanout.json');

function usageError(message) {
  console.error(`loop-fanout: ${message}`);
  console.error(
    'usage: node scripts/loop-fanout.mjs declare --file <lanes.json>\n' +
      '       node scripts/loop-fanout.mjs join <lane-name> [<lane-name> ...]',
  );
  process.exitCode = 2;
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    out[arg.slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

function readManifest() {
  if (!existsSync(MANIFEST_FILE)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function declare(argv) {
  const flags = parseFlags(argv);
  if (!flags.file) {
    usageError('declare requires --file <lanes.json>');
    return;
  }
  let lanes;
  try {
    lanes = JSON.parse(readFileSync(flags.file, 'utf8'));
  } catch (err) {
    usageError(`could not read/parse --file "${flags.file}": ${err.message}`);
    return;
  }
  if (!Array.isArray(lanes) || lanes.length === 0) {
    usageError(`--file "${flags.file}" must contain a non-empty JSON array of {name, scopes}`);
    return;
  }

  const verdict = classifyLanes(lanes);
  if (!verdict.ok) {
    console.error(
      `loop-fanout: REFUSED — ${verdict.violations.length} declaration conflict(s). Re-scope and ` +
        're-declare; nothing was dispatched or written.',
    );
    for (const v of verdict.violations) console.error(`  - ${v.detail}`);
    process.exitCode = 1;
    return;
  }

  const manifest = {
    declaredAt: new Date().toISOString(),
    lanes: lanes.map((l) => ({ name: l.name, scopes: l.scopes })),
  };
  mkdirSync(dirname(MANIFEST_FILE), { recursive: true });
  writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `loop-fanout: declared ${manifest.lanes.length} lane(s): ${manifest.lanes.map((l) => l.name).join(', ')}`,
  );
}

function join_(argv) {
  const returned = argv.filter((a) => !a.startsWith('--'));
  const manifest = readManifest();
  if (!manifest || !Array.isArray(manifest.lanes) || manifest.lanes.length === 0) {
    // Reporting-only and it stays that way even here: no manifest to join against is disclosed, not
    // gated — a pass that never declared (or whose manifest went missing) must not be blocked at the
    // one step whose entire job is to make partial returns visible.
    console.log(
      'loop-fanout: no declared manifest found at research/loop/digests/.fanout.json — nothing to ' +
        'join against; this fan-out either never declared or the manifest is gone.',
    );
    return;
  }
  const declaredNames = manifest.lanes.map((l) => l.name);
  const verdict = classifyFanoutCompletion(declaredNames, returned);
  if (verdict.status === 'complete') {
    console.log(
      `loop-fanout: COMPLETE — all ${declaredNames.length} declared lane(s) returned (${declaredNames.join(', ')}).`,
    );
  } else {
    if (verdict.missing.length > 0) {
      console.log(
        `loop-fanout: DISCLOSURE — ${verdict.missing.length} of ${declaredNames.length} declared lane(s) ` +
          `did NOT return: ${verdict.missing.join(', ')}. Copy-paste into the pass report before claiming ` +
          'this fan-out complete.',
      );
    }
    if (verdict.extra.length > 0) {
      console.log(
        `loop-fanout: NOTE — ${verdict.extra.length} lane name(s) returned that were never declared: ` +
          `${verdict.extra.join(', ')}.`,
      );
    }
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'declare') {
  declare(rest);
} else if (command === 'join') {
  join_(rest);
} else {
  usageError(`unknown command "${command ?? ''}" — expected "declare" or "join"`);
}
