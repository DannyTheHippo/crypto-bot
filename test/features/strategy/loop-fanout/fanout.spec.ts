import { describe, it, expect } from 'vitest';
// @ts-expect-error scripts/** live outside the tsconfig graph (see tsconfig.eslint.json's include
// list) — loop-fanout-core.mjs is a stdlib-only .mjs with no declaration file. Same bridge the
// loop-pass-lock / loop-sweep specs use for their pure cores.
import * as fanoutModule from '../../../../scripts/loop-fanout-core.mjs';

interface NormalizedScope {
  ok: boolean;
  segments?: string[];
  isSubtree?: boolean;
  normalized?: string;
  reason?: string;
}
interface Violation {
  kind: 'reserved' | 'overlap';
  detail: string;
  [key: string]: unknown;
}
interface FanoutCore {
  ORCHESTRATOR_OWNED: string[];
  normalizeScope: (raw: string) => NormalizedScope;
  scopesOverlap: (a: string, b: string) => boolean;
  classifyLanes: (lanes: Array<{ name: string; scopes: string[] }>) => {
    ok: boolean;
    violations: Violation[];
  };
  classifyFanoutCompletion: (
    declared: string[],
    returned: string[],
  ) => { status: 'complete' | 'partial' | 'extra'; missing: string[]; extra: string[] };
}
const {
  ORCHESTRATOR_OWNED,
  normalizeScope,
  scopesOverlap,
  classifyLanes,
  classifyFanoutCompletion,
} = fanoutModule as unknown as FanoutCore;

describe('loop-fanout core — normalizeScope', () => {
  it('collapses "." and duplicate slashes and drops a trailing subtree marker into isSubtree', () => {
    const a = normalizeScope('./src//features/strategy/');
    expect(a).toEqual({
      ok: true,
      segments: ['src', 'features', 'strategy'],
      isSubtree: true,
      normalized: 'src/features/strategy/',
    });
  });

  it('resolves ".." within the scope', () => {
    expect(normalizeScope('src/features/../domain/common/types/money.ts')).toEqual({
      ok: true,
      segments: ['src', 'domain', 'common', 'types', 'money.ts'],
      isSubtree: false,
      normalized: 'src/domain/common/types/money.ts',
    });
  });

  it('a bare "." names the whole repo and is forced to isSubtree so it overlaps everything', () => {
    expect(normalizeScope('.')).toEqual({
      ok: true,
      segments: [],
      isSubtree: true,
      normalized: '',
    });
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a non-string', 123 as unknown as string],
    ['".." escaping above the root', '../outside'],
    ['an absolute path', '/etc/passwd'],
    ['an absolute repo path', '/Users/whoever/crypto-bot/src/foo.ts'],
  ])('%s fails to normalize', (_name, raw) => {
    const result = normalizeScope(raw);
    expect(result.ok).toBe(false);
  });
});

describe('loop-fanout core — scopesOverlap', () => {
  it('containment: a subtree scope overlaps a file inside it, in both argument orders', () => {
    expect(scopesOverlap('src/features/strategy/', 'src/features/strategy/agentic/policy.ts')).toBe(
      true,
    );
    expect(scopesOverlap('src/features/strategy/agentic/policy.ts', 'src/features/strategy/')).toBe(
      true,
    );
  });

  it('sibling subtrees at the same depth do not overlap', () => {
    expect(scopesOverlap('src/features/trading/', 'src/features/strategy/')).toBe(false);
  });

  it('identical scopes always overlap, subtree or not', () => {
    expect(scopesOverlap('package.json', 'package.json')).toBe(true);
    expect(scopesOverlap('src/features/strategy/', 'src/features/strategy/')).toBe(true);
  });

  it('trailing slash is the ONLY containment signal — an exact-file scope naming a directory does not imply containment', () => {
    // 'scripts' with no trailing slash names exactly that path, not everything under it — no globs.
    expect(scopesOverlap('scripts', 'scripts/loop-fanout.mjs')).toBe(false);
    expect(scopesOverlap('scripts/', 'scripts/loop-fanout.mjs')).toBe(true);
  });

  it('an unnormalizable scope on either side classifies as an overlap — fail CLOSED', () => {
    expect(scopesOverlap('/absolute/path', 'scripts/loop-fanout.mjs')).toBe(true);
    expect(scopesOverlap('scripts/loop-fanout.mjs', '../escapes-root')).toBe(true);
    expect(scopesOverlap('', 'scripts/loop-fanout.mjs')).toBe(true);
  });
});

describe('loop-fanout core — classifyLanes refuses every ORCHESTRATOR_OWNED member', () => {
  it.each(ORCHESTRATOR_OWNED.map((p) => [p]))('a lane claiming "%s" is refused', (reservedPath) => {
    const verdict = classifyLanes([{ name: 'lane-a', scopes: [reservedPath] }]);
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.some((v) => v.kind === 'reserved')).toBe(true);
  });

  it('accepts a roster of genuinely disjoint, non-reserved scopes', () => {
    const verdict = classifyLanes([
      { name: 'lane-a', scopes: ['scripts/loop-fanout-core.mjs'] },
      { name: 'lane-b', scopes: ['scripts/loop-fanout.mjs'] },
      { name: 'lane-c', scopes: ['test/features/strategy/loop-fanout/'] },
    ]);
    expect(verdict).toEqual({ ok: true, violations: [] });
  });

  it('flags a pairwise overlap between two different lanes', () => {
    const verdict = classifyLanes([
      { name: 'lane-a', scopes: ['src/features/strategy/'] },
      { name: 'lane-b', scopes: ['src/features/strategy/agentic/policy.ts'] },
    ]);
    expect(verdict.ok).toBe(false);
    expect(
      verdict.violations.some(
        (v) => v.kind === 'overlap' && v.laneA === 'lane-a' && v.laneB === 'lane-b',
      ),
    ).toBe(true);
  });

  it('never throws on a malformed lane entry (missing name/scopes)', () => {
    expect(() =>
      classifyLanes([
        {} as unknown as { name: string; scopes: string[] },
        { name: 'lane-b', scopes: [] },
      ]),
    ).not.toThrow();
  });
});

describe('loop-fanout core — classifyFanoutCompletion', () => {
  it('complete: every declared lane returned, nothing extra', () => {
    expect(classifyFanoutCompletion(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual({
      status: 'complete',
      missing: [],
      extra: [],
    });
  });

  it('partial: a declared lane never returned', () => {
    expect(classifyFanoutCompletion(['a', 'b', 'c'], ['a', 'c'])).toEqual({
      status: 'partial',
      missing: ['b'],
      extra: [],
    });
  });

  it('extra-return: everything declared returned, plus a name nobody declared', () => {
    expect(classifyFanoutCompletion(['a', 'b'], ['a', 'b', 'z'])).toEqual({
      status: 'extra',
      missing: [],
      extra: ['z'],
    });
  });

  it('partial wins priority when both missing and extra are present', () => {
    expect(classifyFanoutCompletion(['a', 'b'], ['a', 'z'])).toEqual({
      status: 'partial',
      missing: ['b'],
      extra: ['z'],
    });
  });
});
