// Pure decision core for the pass-concurrency lease (scripts/loop-pass-lock.mjs is the thin IO
// wrapper). Split out for the same reason loop-sweep-core.mjs is: the
// interesting behaviour is the classification, and a guard shipped without tests is a guard nobody
// has checked. Every function here is pure — no fs, no clock, no process.
//
// FAILURE DIRECTION, and it is the whole design: this lease is a COORDINATION HINT on a
// single-writer working tree, not a safety interlock. It therefore fails OPEN — every state this
// core cannot read with confidence (absent, unparseable, missing/!ISO timestamp, or stamped in the
// future beyond clock-skew tolerance) classifies as acquirable, and every lease older than
// STALE_MINUTES breaks automatically. Nothing here can wedge the loop shut for longer than the
// lease. The ONE thing it refuses to do is delete a lease it cannot prove it owns (see
// classifyRelease): silently breaking a live holder's lease is the exact failure the lock exists to
// prevent, and refusing costs nothing because the lease expires on its own.

export const STALE_MINUTES = 120;
// The stack runs on a MacBook that sleeps and gets its clock corrected on resume; the playbook opens
// with `date -u` precisely because unanchored clocks have already cost this project a chase. A lease
// stamped slightly ahead of now is ordinary skew and is honoured; one stamped far ahead is not
// evidence of anything and must not outlive its own staleness window.
export const CLOCK_SKEW_TOLERANCE_MINUTES = 5;
export const VERBS = ['acquire', 'release', 'status'];
export const DEFAULT_LABEL = 'pass';

/**
 * Classify the raw lock-file contents against the current instant.
 * @returns {{state:'free'}|{state:'corrupt',reason:string}|{state:'held'|'stale',label:string,startedAt:string,nonce:string|undefined,ageMinutes:number}}
 */
export function classifyLock(raw, nowMs) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { state: 'free' };
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return { state: 'corrupt', reason: 'unparseable JSON' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { state: 'corrupt', reason: 'not a JSON object' };
  }
  if (typeof parsed.startedAt !== 'string') {
    return { state: 'corrupt', reason: 'missing startedAt' };
  }
  const startedMs = Date.parse(parsed.startedAt);
  if (!Number.isFinite(startedMs)) {
    return { state: 'corrupt', reason: `unparseable startedAt "${parsed.startedAt}"` };
  }
  const ageMinutes = Math.round((nowMs - startedMs) / 60_000);
  if (ageMinutes < -CLOCK_SKEW_TOLERANCE_MINUTES) {
    // Future-dated beyond skew. Treating this as a live lease would wedge every later pass for
    // (skew + STALE_MINUTES), because a negative age is always below the staleness bound — the
    // stale-break branch could never fire. Fail OPEN instead, and name the cause.
    return { state: 'corrupt', reason: `startedAt is ${-ageMinutes} min in the future` };
  }
  const common = {
    label: typeof parsed.label === 'string' ? parsed.label : DEFAULT_LABEL,
    startedAt: parsed.startedAt,
    nonce: typeof parsed.nonce === 'string' ? parsed.nonce : undefined,
    ageMinutes,
  };
  return ageMinutes >= STALE_MINUTES ? { state: 'stale', ...common } : { state: 'held', ...common };
}

/**
 * Should `acquire` take the lease?
 * @returns {{acquire:true,breaking:null|object}|{acquire:false,holder:object}}
 */
export function classifyAcquire(raw, nowMs) {
  const held = classifyLock(raw, nowMs);
  if (held.state === 'held') return { acquire: false, holder: held };
  if (held.state === 'stale') return { acquire: true, breaking: held };
  return { acquire: true, breaking: null };
}

/**
 * Should `release` delete the lease? Ownership is proved by the nonce printed at acquire time — the
 * lease is stateless, so the nonce is the only proof a later invocation can carry.
 *
 * This is the gate that stops the guard defeating itself: playbook §6 runs for EVERY pass including
 * one that was refused at §1, and an unconditional delete would let that refused pass free the live
 * holder's lease and re-enable the very concurrency it just detected.
 * @returns {{release:boolean,reason:string}}
 */
export function classifyRelease(raw, nowMs, nonce) {
  const held = classifyLock(raw, nowMs);
  if (held.state === 'free') return { release: false, reason: 'no lock file' };
  if (held.state === 'corrupt') {
    // Unreadable: acquire already ignores it, so clearing it is safe and stops it lingering.
    return { release: true, reason: `clearing unreadable lock (${held.reason})` };
  }
  if (held.state === 'stale') {
    return { release: true, reason: `lease already expired (${held.ageMinutes} min old)` };
  }
  if (held.nonce === undefined) {
    // Pre-nonce lease (or a hand-written one): nothing to prove ownership against. Honour the
    // release rather than stranding a lock no invocation could ever free.
    return { release: true, reason: 'lease carries no nonce — nothing to verify against' };
  }
  if (nonce === undefined || nonce === '') {
    return {
      release: false,
      reason: `lease is held by ${held.label} and no nonce was supplied — pass the nonce printed at acquire time`,
    };
  }
  if (nonce !== held.nonce) {
    return {
      release: false,
      reason: `nonce does not match the lease held by ${held.label} (started ${held.startedAt})`,
    };
  }
  return { release: true, reason: 'nonce matches' };
}

function editDistanceAtMostOne(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [shortStr, longStr] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < shortStr.length && j < longStr.length) {
    if (shortStr[i] === longStr[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (shortStr.length === longStr.length) i += 1;
    j += 1;
  }
  return edits + (longStr.length - j) + (shortStr.length - i) <= 1;
}

/**
 * Parse argv into a command. A bare first token is a LABEL (so `pnpm loop:lock "pass 44"` works),
 * but a token that merely looks like a mistyped verb is rejected rather than silently becoming a
 * label — otherwise `loop:lock relase` takes a fresh 120-minute lease while reporting "acquired",
 * and the operator's intent and the tool's report diverge with no error.
 * @returns {{command:'acquire',label:string}|{command:'release',nonce:string|undefined}|{command:'status'}|{error:string}}
 */
export function parseArgs(argv) {
  const [first, ...rest] = argv;
  if (first === undefined) return { command: 'acquire', label: DEFAULT_LABEL };
  if (first === 'status') return { command: 'status' };
  if (first === 'release') return { command: 'release', nonce: rest[0] };
  if (first === 'acquire') {
    return { command: 'acquire', label: rest.join(' ') || DEFAULT_LABEL };
  }
  if (first.startsWith('-')) {
    return { error: `unknown option "${first}" — expected one of: ${VERBS.join(', ')}` };
  }
  const nearMiss = VERBS.find((v) => editDistanceAtMostOne(first.toLowerCase(), v));
  if (nearMiss !== undefined) {
    return {
      error: `"${first}" looks like a typo for "${nearMiss}" — refusing to treat it as a label`,
    };
  }
  return { command: 'acquire', label: [first, ...rest].join(' ') };
}
