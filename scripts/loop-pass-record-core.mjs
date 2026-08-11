#!/usr/bin/env node
// Pass-record parsing + readiness — STDLIB-ONLY, ZERO IMPORTS. This is a hard property, not an
// accident: loop-pass-lock.mjs (the concurrency-lease shell) calls classifyPassRecordReadiness() from
// inside acquire()/release(), and ESM resolves every `import` before any module code runs — so an
// import here that itself imports a package (decimal.js, previously reached transitively through
// loop-sweep-core.mjs) can throw ERR_MODULE_NOT_FOUND before the lock shell's own try/catch is ever
// entered, wedging the lease in a tree with no node_modules (2026-08-11 adversarial review, MUST-FIX
// A — reproduced: `pnpm loop:unlock` died on the missing package and left the lock file in place, i.e.
// the lease was held but unreleased). A documentation-readiness check must never be able to do that.
// Never add an import to this file without moving loop-pass-lock.mjs's dependency off it too.
//
// Split out of loop-sweep-core.mjs on that same review: this file owns the parsing/readiness half,
// stdlib-only. loop-sweep-core.mjs (which does import decimal.js, for unrelated money-path checks)
// re-exports parseLogPassEntries and classifyPassRecordReadiness so existing importers
// (pass-record-audit.spec.ts, pass-record-readiness.spec.ts) are unaffected, and still owns
// classifyUnrecordedSweeps and the digest-name parsing it depends on.

// LOG.md's own conventions, read off the file rather than assumed: one `## <date> — Pass <n> (title)`
// heading per pass, where <date> is `2026-07-29` or the two-day `2026-07-28/29`, and the first
// `**Window:**` line under it carries the span. Sub-headings are `###` and never match.
const PASS_HEADING_RE = /^##\s+(\d{4}-\d{2}-\d{2})(?:\/\d{1,2})?\s+—\s+Pass\s+(\d+)\b/;
const WINDOW_LINE_RE = /^\*\*Window:\*\*\s*(.+)$/;
// Both stamp shapes the retained entries actually use — fully qualified, or bare `HH:MMZ` inheriting
// the date to its left. ANCHORED on purpose: an unanchored match would happily lift a time out of the
// prose that trails the window on the same line and call it the pass boundary.
const WINDOW_ABS_STAMP_RE = /^\s*(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})Z/;
const WINDOW_TIME_ONLY_RE = /^\s*(\d{2}):(\d{2})Z/;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseWindowSide(text, defaultDate) {
  const abs = WINDOW_ABS_STAMP_RE.exec(text);
  if (abs) {
    const ms = Date.parse(`${abs[1]}T${abs[2]}:${abs[3]}:00Z`);
    return Number.isFinite(ms) ? ms : null;
  }
  const rel = WINDOW_TIME_ONLY_RE.exec(text);
  if (!rel) return null;
  const ms = Date.parse(`${defaultDate}T${rel[1]}:${rel[2]}:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

// Either both bounds parse or the entry counts as UNPARSED — a half-read window would silently shrink
// a pass's coverage and manufacture the exact false accusation this detector must not make. Ends that
// are prose ('→ in progress', archived Pass 43) take that path by construction.
function parsePassWindow(raw, headingDate) {
  const sides = String(raw).split('→');
  if (sides.length < 2) return { startMs: null, endMs: null };
  const startMs = parseWindowSide(sides[0], headingDate);
  if (!Number.isFinite(startMs)) return { startMs: null, endMs: null };
  const startDate = new Date(startMs).toISOString().slice(0, 10);
  let endMs = parseWindowSide(sides[1], startDate);
  if (!Number.isFinite(endMs)) return { startMs: null, endMs: null };
  // A bare end time earlier than the start is the next calendar day — the overnight pass the
  // `## 2026-07-28/29 — Pass 45` heading shape exists for (16:07Z → 07:00Z).
  if (endMs < startMs) endMs += DAY_MS;
  return { startMs, endMs };
}

export function parseLogPassEntries(logText) {
  if (typeof logText !== 'string') return [];
  const entries = [];
  let cur = null;
  for (const line of logText.split('\n')) {
    const heading = PASS_HEADING_RE.exec(line);
    if (heading) {
      cur = {
        heading: line.trim(),
        pass: Number(heading[2]),
        date: heading[1],
        window: null,
        startMs: null,
        endMs: null,
      };
      entries.push(cur);
      continue;
    }
    if (!cur || cur.window !== null) continue;
    const window = WINDOW_LINE_RE.exec(line);
    if (!window) continue;
    cur.window = window[1].trim();
    const span = parsePassWindow(window[1], cur.date);
    cur.startMs = span.startMs;
    cur.endMs = span.endMs;
  }
  return entries;
}

// Never throws, for any input — see safeErrorText's own comment for why `String(err)` alone is not
// safe here (2026-08-11 review, MUST-FIX B: a non-Error whose toString throws, and a Proxy that
// throws on property access, both escaped the previous `err instanceof Error ? err.message :
// String(err)` and turned a caught exception into an uncaught one, AFTER loop-pass-lock.mjs's caller
// had already written the lock file).
export function safeErrorText(err) {
  try {
    if (typeof err?.message === 'string') return err.message;
  } catch {
    // Reading `.message` itself threw (a hostile getter/Proxy) — fall through to the blind stringify.
  }
  try {
    return String(err);
  } catch {
    // `String(err)` invokes toString/Symbol.toPrimitive, which can itself throw — this is the
    // MUST-FIX B path. A fixed literal is the only stringify that cannot fail.
    return 'unstringifiable error';
  }
}

// ── pass-record readiness: can the audit above even attempt a verdict? ─────────────────────────────
// Written for a 2-recurrence class (root CLAUDE.md's own "an anomaly seen twice gets a root-cause fix"
// rule, not another careful-writing resolution): Pass 67 wrote a literal placeholder end time into its
// **Window:** line, and Pass 68 omitted the line entirely. Both times classifyUnrecordedSweeps did
// exactly what its own comment above says it will do — blanked the WHOLE verdict to
// `pass_record_audit_undetermined` — and both times the loss was discovered only later, by reading a
// sweep annotation, not at write time when a pass could still fix its own entry. This is the mechanical
// check that catches it at lock-acquire/release time instead (see loop-pass-lock.mjs).
//
// Deliberately a THIN wrapper reusing parseLogPassEntries rather than a second parser: re-deriving the
// window-readable predicate here would let the two checks drift, which is exactly how a differently-
// written duplicate could miss the placeholder-text shape (Pass 67) that parseLogPassEntries already
// classifies as unparseable.
//
// FAIL DIRECTION — measurement/veto-only, and NEVER throws: every branch, including a caught exception,
// returns one of the four statuses below rather than propagating. The caller (loop-pass-lock.mjs, a
// lease acquire/release) must never be blocked by a broken reading of this check — see its own wiring
// comment for why.
export function classifyPassRecordReadiness(input) {
  try {
    // Read defensively rather than destructuring in the parameter list: destructuring an undefined/
    // null argument throws BEFORE this try block runs, and "never throws for any input" covers the
    // whole call, not just a well-formed `{ logText }`.
    const logText = input && typeof input === 'object' ? input.logText : undefined;
    if (typeof logText !== 'string' || logText.trim() === '') {
      return {
        status: 'unreadable',
        detail: 'LOG.md text was not a string, or was empty/whitespace-only',
      };
    }
    const entries = parseLogPassEntries(logText);
    if (entries.length === 0) {
      return {
        status: 'no_entries',
        detail: 'no `## <date> — Pass <n>` entries parsed out of LOG.md',
      };
    }
    // window is null when the **Window:** line is missing entirely, or the raw (unparseable) text when
    // the line is present but its span did not parse — parseLogPassEntries already draws exactly that
    // distinction (cur.window stays null until a WINDOW_LINE_RE match sets it). `heading` is carried
    // too: LOG.md's addendum convention produces two headings sharing the SAME pass number (e.g. a
    // "Pass 47" entry and a "Pass 47 addendum b" entry), so a bare pass number cannot identify which
    // heading is the offender.
    const unparsed = entries
      .filter((e) => !Number.isFinite(e.startMs) || !Number.isFinite(e.endMs))
      .map((e) => ({ pass: e.pass, window: e.window, heading: e.heading }));
    if (unparsed.length > 0) {
      const names = unparsed.map((u) => `Pass ${u.pass}`).join(', ');
      return {
        status: 'unparsed',
        unparsed,
        detail:
          `${unparsed.length} of ${entries.length} pass entr${unparsed.length === 1 ? 'y has' : 'ies have'} ` +
          `a missing or unreadable **Window:** line (${names}) — this suppresses the WHOLE ` +
          'unrecorded-sweep audit (classifyUnrecordedSweeps) for every retained entry, not just these',
      };
    }
    return {
      status: 'ok',
      entries: entries.length,
      detail: `${entries.length} pass entr${entries.length === 1 ? 'y' : 'ies'} parsed cleanly`,
    };
  } catch (err) {
    return {
      status: 'unreadable',
      detail: `pass-record readiness check threw and produced no verdict: ${safeErrorText(err)}`,
    };
  }
}

// rules/code-hygiene.md § Secrets and paths' enumerated set — matched and redacted rather than
// merely avoided-by-construction, because the read-failure text this feeds (a Node fs error's
// `.message`) embeds the absolute path it was given (`readFileSync(LOG_FILE, ...)`'s own ENOENT/
// EACCES message includes LOG_FILE verbatim) — dropping the `${LOG_FILE}` template interpolation
// alone would NOT have closed this, since the leak also arrives via readErrorText.
const HOST_PATH_RE = /(\/Users\/|\/home\/|\/root\/|~\/)\S*/g;
function redactHostPaths(text) {
  return typeof text === 'string' ? text.replace(HOST_PATH_RE, '<path>') : text;
}

// Pure decision the lock shell's warnOnPassRecordReadiness() delegates to, so a polarity inversion
// (warn on `ok`, silent on `unparsed`) is catchable by a unit test rather than only observable by
// reading console output from the shell (2026-08-11 review, SHOULD-FIX 2 — before this, no test
// imported loop-pass-lock.mjs at all and it did not appear in the coverage report).
//
// The message never carries an absolute host path (SHOULD-FIX 1): this loop quotes command output
// verbatim into tracked markdown, so a `/Users/<name>/...` path in a warning would land a host path
// and username in git. `research/loop/LOG.md` is the fixed repo-relative name the lock shell reads;
// redactHostPaths above scrubs the OTHER source, the underlying fs error text.
export function describePassRecordWarning({ readFailed, readErrorText, verdict }) {
  if (readFailed) {
    return {
      warn: true,
      message:
        'loop-pass-lock: pass-record readiness check COULD NOT read research/loop/LOG.md ' +
        `(${redactHostPaths(readErrorText) || 'unknown error'}) — the check did not run, this is not a clean result`,
    };
  }
  if (!verdict || typeof verdict.status !== 'string' || verdict.status !== 'ok') {
    const status = verdict && typeof verdict.status === 'string' ? verdict.status : 'unreadable';
    const detail =
      verdict && typeof verdict.detail === 'string' ? verdict.detail : 'no verdict produced';
    return {
      warn: true,
      message: `loop-pass-lock: pass-record readiness ${status} — ${redactHostPaths(detail)}`,
    };
  }
  return { warn: false, message: '' };
}
