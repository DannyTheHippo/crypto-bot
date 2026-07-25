#!/usr/bin/env node
// Y3 pass-rehydration reader — `node scripts/loop-digests-since.mjs <ISO-8601>` (or `pnpm loop:digests
// <ISO>`). Prints every collector digest line with actualAt >= the given timestamp, newest LAST, across
// BOTH the hot digests dir and digests/archive/ (rotation moves old files there — a since read that
// stops at the hot dir would silently lose the older half of the window).
//
// This is the entry point a discrete pass rehydrates from instead of a raw 24h `docker logs` window —
// the raw-window model is exactly what made R8-7 invisible (loop-mechanism-learnings-2026-07.md §D).
// Output is one JSON line per row (the durable line, verbatim) so it pipes into jq.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filterSince } from './loop-collect-core.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const DIGESTS_DIR = join(REPO_ROOT, 'research', 'loop', 'digests');
const ARCHIVE_DIR = join(DIGESTS_DIR, 'archive');

function readJsonlLines(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const raw = readFileSync(join(dir, name), 'utf8');
    for (const rawLine of raw.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // A partially-written trailing line is skipped, never surfaced as an event.
      }
    }
  }
  return out;
}

function main() {
  const sinceIso = process.argv[2];
  if (!sinceIso || Number.isNaN(Date.parse(sinceIso))) {
    process.stderr.write(
      'usage: node scripts/loop-digests-since.mjs <ISO-8601-timestamp>\n' +
        '  e.g. node scripts/loop-digests-since.mjs 2026-07-20T00:00:00Z\n',
    );
    process.exit(1);
  }
  const all = [...readJsonlLines(DIGESTS_DIR), ...readJsonlLines(ARCHIVE_DIR)];
  const rows = filterSince(all, sinceIso);
  for (const row of rows) process.stdout.write(JSON.stringify(row) + '\n');
  process.stderr.write(`loop-digests: ${rows.length} line(s) since ${sinceIso}\n`);
}

main();
