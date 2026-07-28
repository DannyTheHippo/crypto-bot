#!/usr/bin/env node
// Pass-concurrency guard — `pnpm loop:lock ["<label>"]`, `pnpm loop:unlock <nonce>`,
// `pnpm loop:lock status`. All decision logic lives in loop-pass-lock-core.mjs (unit-tested on the
// production gate); this file is the IO shell.
//
// Written for the 2026-07-28 incident (state.md § Flagged): two scheduled passes ran concurrently in
// the SAME working tree. Both edited the same files, one committed the other's in-flight work twice,
// and a gate run caught the test count moving 3009 -> 3011 mid-verification because writes were still
// landing. No work was lost that time, but nothing structural prevented it, and the resulting failure
// would have been attributed to the wrong cause — a half-finished tree from another session is
// indistinguishable from a defect in your own change.
//
// HONEST LIMITS, stated because a guard trusted beyond its evidence is worse than none:
//   1. It is a TIME-based lease, not a liveness check. A pass is a Claude session, not a process this
//      script can watch — the node process here exits immediately, so its pid would prove nothing. A
//      crashed pass holds the lease until STALE_MINUTES expires it.
//   2. It only binds passes that CALL it. A session that never runs `loop:lock` is unaffected — which
//      is exactly what happened on 2026-07-28, when the colliding session predated the lock.
// Fail direction (fail OPEN) and the one deliberate exception are documented in the core's header.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STALE_MINUTES,
  classifyAcquire,
  classifyLock,
  classifyRelease,
  parseArgs,
} from './loop-pass-lock-core.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOCK_FILE = join(SCRIPT_DIR, '..', 'research', 'loop', '.pass.lock');

function readRaw() {
  if (!existsSync(LOCK_FILE)) return null;
  try {
    return readFileSync(LOCK_FILE, 'utf8');
  } catch {
    return null;
  }
}

function write(lock, { exclusive }) {
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  // 'wx' fails when the file already exists, closing the check-then-create race between two passes
  // launched in the same instant — the one shape a scheduler can actually produce.
  writeFileSync(LOCK_FILE, `${JSON.stringify(lock)}\n`, exclusive ? { flag: 'wx' } : undefined);
}

function refuse(holder) {
  console.error(
    `loop-pass-lock: REFUSED — a pass is already running in this working tree.\n` +
      `  label:     ${holder.label}\n` +
      `  startedAt: ${holder.startedAt} (${holder.ageMinutes} min ago)\n` +
      `Do not run a second pass against the same tree: concurrent edits land inside each other's\n` +
      `gate runs. End this pass and record the collision. Do NOT run loop:unlock — you do not hold\n` +
      `this lease. It expires on its own after ${STALE_MINUTES} min.`,
  );
  process.exit(1);
}

function acquire(label) {
  const decision = classifyAcquire(readRaw(), Date.now());
  if (!decision.acquire) refuse(decision.holder);
  if (decision.breaking) {
    console.log(
      `loop-pass-lock: breaking a stale lease (label=${decision.breaking.label}, ` +
        `${decision.breaking.ageMinutes} min old >= ${STALE_MINUTES}) — the holder never released it.`,
    );
  }
  const lock = {
    label,
    startedAt: new Date().toISOString(),
    nonce: randomBytes(8).toString('hex'),
  };
  const fresh = !existsSync(LOCK_FILE);
  try {
    write(lock, { exclusive: fresh });
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      // Lost the create race: re-read and let the winner hold it.
      const again = classifyAcquire(readRaw(), Date.now());
      if (!again.acquire) refuse(again.holder);
      write(lock, { exclusive: false });
    } else {
      throw err;
    }
  }
  console.log(`loop-pass-lock: acquired (label=${lock.label}, startedAt=${lock.startedAt})`);
  console.log(
    `loop-pass-lock: nonce=${lock.nonce}  → release with: pnpm loop:unlock ${lock.nonce}`,
  );
}

function release(nonce) {
  const decision = classifyRelease(readRaw(), Date.now(), nonce);
  if (!decision.release) {
    console.error(`loop-pass-lock: NOT released — ${decision.reason}`);
    process.exit(1);
  }
  if (existsSync(LOCK_FILE)) rmSync(LOCK_FILE);
  console.log(`loop-pass-lock: released (${decision.reason})`);
}

function status() {
  const held = classifyLock(readRaw(), Date.now());
  if (held.state === 'free') {
    console.log('loop-pass-lock: free');
    return;
  }
  if (held.state === 'corrupt') {
    // Never print "free" for a file that exists but cannot be read — that hides the corruption from
    // the one diagnostic an operator reaches for. Acquire still fails open past it.
    console.log(`loop-pass-lock: CORRUPT (${held.reason}) — acquire will ignore it`);
    console.log(`  raw: ${JSON.stringify(readRaw())}`);
    return;
  }
  console.log(
    `loop-pass-lock: ${held.state.toUpperCase()} label=${held.label} startedAt=${held.startedAt} ` +
      `age=${held.ageMinutes}min`,
  );
}

const parsed = parseArgs(process.argv.slice(2));
if ('error' in parsed) {
  console.error(`loop-pass-lock: ${parsed.error}`);
  process.exit(2);
} else if (parsed.command === 'release') {
  release(parsed.nonce);
} else if (parsed.command === 'status') {
  status();
} else {
  acquire(parsed.label);
}
