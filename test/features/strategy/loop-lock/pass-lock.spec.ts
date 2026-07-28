import { describe, it, expect } from 'vitest';
// @ts-expect-error scripts/** live outside the tsconfig graph (see tsconfig.eslint.json's include
// list) — loop-pass-lock-core.mjs is a stdlib-only .mjs with no declaration file. Same bridge the
// loop-sweep specs use for their pure core.
import * as lockModule from '../../../../scripts/loop-pass-lock-core.mjs';

interface Lease {
  state: 'free' | 'held' | 'stale' | 'corrupt';
  reason?: string;
  label?: string;
  startedAt?: string;
  nonce?: string;
  ageMinutes?: number;
}
interface LockCore {
  STALE_MINUTES: number;
  DEFAULT_LABEL: string;
  classifyLock: (raw: string | null, nowMs: number) => Lease;
  classifyAcquire: (
    raw: string | null,
    nowMs: number,
  ) => { acquire: boolean; breaking?: Lease | null; holder?: Lease };
  classifyRelease: (
    raw: string | null,
    nowMs: number,
    nonce: string | undefined,
  ) => { release: boolean; reason: string };
  parseArgs: (argv: string[]) => {
    command?: 'acquire' | 'release' | 'status';
    label?: string;
    nonce?: string;
    error?: string;
  };
}
const { STALE_MINUTES, DEFAULT_LABEL, classifyLock, classifyAcquire, classifyRelease, parseArgs } =
  lockModule as unknown as LockCore;

const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const MIN = 60_000;

function lock(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    label: 'pass 44',
    startedAt: new Date(NOW - 10 * MIN).toISOString(),
    nonce: 'abc123',
    ...overrides,
  });
}

describe('loop-pass-lock core — classifyLock', () => {
  it('an absent or blank lock is free', () => {
    expect(classifyLock(null, NOW)).toEqual({ state: 'free' });
    expect(classifyLock('', NOW)).toEqual({ state: 'free' });
    expect(classifyLock('   \n', NOW)).toEqual({ state: 'free' });
  });

  it('a fresh lease is HELD, with its age in minutes', () => {
    const held = classifyLock(lock(), NOW);
    expect(held.state).toBe('held');
    expect(held.label).toBe('pass 44');
    expect(held.ageMinutes).toBe(10);
    expect(held.nonce).toBe('abc123');
  });

  it('a lease at or past the staleness bound is STALE, never HELD', () => {
    const startedAt = new Date(NOW - STALE_MINUTES * MIN).toISOString();
    expect(classifyLock(lock({ startedAt }), NOW).state).toBe('stale');
    const justUnder = new Date(NOW - (STALE_MINUTES - 1) * MIN).toISOString();
    expect(classifyLock(lock({ startedAt: justUnder }), NOW).state).toBe('held');
  });

  // Fail-open cases: every shape the core cannot read with confidence must classify as acquirable,
  // because the alternative is a lock file nothing can clear wedging the whole loop.
  it.each([
    ['unparseable JSON', 'not json at all'],
    ['a JSON non-object', '"a string"'],
    ['a missing startedAt', JSON.stringify({ label: 'x' })],
    ['a non-ISO startedAt', JSON.stringify({ startedAt: 'yesterday' })],
  ])('%s is CORRUPT, not a live lease', (_name, raw) => {
    expect(classifyLock(raw, NOW).state).toBe('corrupt');
    expect(classifyAcquire(raw, NOW).acquire).toBe(true);
  });

  // The declared failure direction is fail OPEN. A future-dated stamp is the one input that could
  // silently invert it: a negative age is always below the staleness bound, so the stale-break
  // branch can never fire and every later pass is refused for (skew + STALE_MINUTES).
  it('a stamp far in the future is CORRUPT and still acquirable, so a corrected host clock cannot wedge the loop', () => {
    const raw = lock({ startedAt: new Date(NOW + 30 * 24 * 60 * MIN).toISOString() });
    const held = classifyLock(raw, NOW);
    expect(held.state).toBe('corrupt');
    expect(held.reason).toContain('in the future');
    expect(classifyAcquire(raw, NOW).acquire).toBe(true);
  });

  it('a stamp a couple of minutes ahead is ordinary clock skew and is still honoured', () => {
    const raw = lock({ startedAt: new Date(NOW + 2 * MIN).toISOString() });
    expect(classifyLock(raw, NOW).state).toBe('held');
    expect(classifyAcquire(raw, NOW).acquire).toBe(false);
  });
});

describe('loop-pass-lock core — classifyAcquire', () => {
  it('refuses while a lease is live, and reports the holder', () => {
    const decision = classifyAcquire(lock(), NOW);
    expect(decision.acquire).toBe(false);
    expect(decision.holder?.label).toBe('pass 44');
  });

  it('breaks an expired lease and says so, rather than refusing forever', () => {
    const raw = lock({ startedAt: new Date(NOW - (STALE_MINUTES + 5) * MIN).toISOString() });
    const decision = classifyAcquire(raw, NOW);
    expect(decision.acquire).toBe(true);
    expect(decision.breaking?.ageMinutes).toBe(STALE_MINUTES + 5);
  });
});

// The guard's own worst failure mode, and the reason release is nonce-gated: playbook §6 ("every
// pass, even empty ones") runs for a pass that was REFUSED at §1. An unconditional delete would let
// that refused pass free the live holder's lease and re-enable the concurrency it just detected.
describe('loop-pass-lock core — classifyRelease refuses to free a lease it cannot prove it owns', () => {
  it('a refused pass, holding no nonce, cannot release the live holder', () => {
    const decision = classifyRelease(lock(), NOW, undefined);
    expect(decision.release).toBe(false);
    expect(decision.reason).toContain('no nonce was supplied');
  });

  it('a wrong nonce cannot release the live holder either', () => {
    const decision = classifyRelease(lock(), NOW, 'deadbeef');
    expect(decision.release).toBe(false);
    expect(decision.reason).toContain('does not match');
  });

  it('the holder, with its own nonce, releases', () => {
    expect(classifyRelease(lock(), NOW, 'abc123')).toEqual({
      release: true,
      reason: 'nonce matches',
    });
  });

  it('an expired lease releases without a nonce — it is no longer protecting anyone', () => {
    const raw = lock({ startedAt: new Date(NOW - (STALE_MINUTES + 1) * MIN).toISOString() });
    expect(classifyRelease(raw, NOW, undefined).release).toBe(true);
  });

  it('an unreadable lock file is cleared rather than left to linger', () => {
    expect(classifyRelease('garbage', NOW, undefined).release).toBe(true);
  });

  it('a nonce-less lease releases, so a pre-nonce lock can never be stranded', () => {
    const raw = JSON.stringify({ label: 'old', startedAt: new Date(NOW - MIN).toISOString() });
    expect(classifyRelease(raw, NOW, undefined).release).toBe(true);
  });

  it('an absent lock is a no-op, not a failure', () => {
    expect(classifyRelease(null, NOW, undefined)).toEqual({
      release: false,
      reason: 'no lock file',
    });
  });
});

describe('loop-pass-lock core — parseArgs', () => {
  it('maps the three verbs and the bare-label form', () => {
    expect(parseArgs([])).toEqual({ command: 'acquire', label: DEFAULT_LABEL });
    expect(parseArgs(['status'])).toEqual({ command: 'status' });
    expect(parseArgs(['release'])).toEqual({ command: 'release', nonce: undefined });
    expect(parseArgs(['release', 'abc123'])).toEqual({ command: 'release', nonce: 'abc123' });
    expect(parseArgs(['pass', '44'])).toEqual({ command: 'acquire', label: 'pass 44' });
    expect(parseArgs(['acquire', 'pass', '44'])).toEqual({ command: 'acquire', label: 'pass 44' });
  });

  // A mistyped verb silently becoming a label is how `loop:lock relase` took a fresh 120-minute
  // lease while printing "acquired" — the operator's intent and the tool's report diverging with no
  // error is worse than a hard failure.
  it.each([['relase'], ['releas'], ['statu'], ['acquir'], ['Release']])(
    'rejects "%s" as a typo instead of taking a lease under a garbage label',
    (token) => {
      const parsed = parseArgs([token]);
      expect(parsed.error).toContain('looks like a typo');
    },
  );

  it('rejects anything option-shaped', () => {
    expect(parseArgs(['--help']).error).toContain('unknown option');
    expect(parseArgs(['-f']).error).toContain('unknown option');
  });

  it('still accepts a genuine label that is nowhere near a verb', () => {
    expect(parseArgs(['pass-44-rescan'])).toEqual({
      command: 'acquire',
      label: 'pass-44-rescan',
    });
  });
});
