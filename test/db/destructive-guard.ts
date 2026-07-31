/**
 * Shared guard for every test/db/*.spec.ts suite that can run destructive SQL (DROP SCHEMA,
 * pg_advisory_lock against the live single-writer key, etc.) against DATABASE_URL.
 *
 * Deliberately NOT a .spec.ts file: importing a Vitest spec file from another spec file re-runs
 * its top-level `describe`/`it` registration inside the importing file's collection phase (Vitest
 * scopes suite collection to whichever file is currently executing, not to the file the code was
 * defined in), silently duplicating the entire imported suite — including its beforeAll DROP
 * SCHEMA CASCADE — inside every file that imports it. Keeping the guard here, with no test
 * registration of its own, lets every *.spec.ts file import the same function safely.
 */

export function dbNameEndsWithTest(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/^\//, '').endsWith('_test');
  } catch {
    return false;
  }
}

// HARD SAFETY WALL, independent of every env flag (DB_SUITE_ALLOW_RESET, etc.): a destructive DB
// suite must be structurally impossible to aim at a non-_test database. DB_SUITE_ALLOW_RESET
// exists so READ-ONLY suites (test/eval) can acknowledge a production DATABASE_URL — it must
// never double as a license to reset or lock against one. Incident 2026-07-10: an accidental
// full-suite vitest invocation with ALLOW_RESET=1 + the production URL dropped the live
// `cryptobot` schema; this throw (not a skip — a skip would hide the misconfiguration) is the
// guarantee it cannot recur.
//
// Failure direction: this gate FAILS CLOSED — any name that does not end in _test (including an
// unparseable or ambiguous DATABASE_URL, which `new URL()` below throws on) aborts the suite
// loudly rather than proceeding, because the cost of a false negative here is irreversible data
// loss or a false safety signal on the live single-writer lock.
export function assertDestructiveTargetIsTestDb(url: string): void {
  if (dbNameEndsWithTest(url)) return;
  // Resolve the name for the message WITHOUT re-parsing: an unparseable URL already fell through
  // dbNameEndsWithTest's catch, and a second `new URL(url)` here would throw an opaque
  // `Invalid URL` TypeError instead of this refusal — still fail-closed, but it would tell the
  // reader nothing about which rule stopped them.
  let name: string;
  try {
    name = new URL(url).pathname.replace(/^\//, '');
  } catch {
    name = '<unparseable DATABASE_URL>';
  }
  throw new Error(
    `refuses to run a destructive DB suite against database "${name}": ` +
      'destructive DB suites only ever run against a database whose name ends in _test, ' +
      'regardless of DB_SUITE_ALLOW_RESET.',
  );
}
