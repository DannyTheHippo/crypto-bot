import { describe, it, expect } from 'vitest';
// @ts-expect-error scripts/** live outside the tsconfig graph (see tsconfig.eslint.json's include
// list) — the pure sweep core is a stdlib-only .mjs with no declaration file. Same bridge
// pass-record-audit.spec.ts uses for classifyUnrecordedSweeps.
import * as coreModule from '../../../../scripts/loop-sweep-core.mjs';
// classifyPassRecordReadiness and parseLogPassEntries are re-exported by loop-sweep-core.mjs, but
// describePassRecordWarning and safeErrorText only ever lived in the stdlib-only split (see that
// file's header for why loop-pass-lock.mjs must import them from here, never through the sweep core).
// @ts-expect-error same bridge, same reason: stdlib-only .mjs with no declaration file.
import * as recordCoreModule from '../../../../scripts/loop-pass-record-core.mjs';

// This is the check that would have caught Pass 67 (placeholder end time) and Pass 68 (missing
// **Window:** line) AT lock-acquire/release time, before either got the chance to blank the whole
// classifyUnrecordedSweeps verdict silently. What this spec is really pinning is the same thing
// pass-record-audit.spec.ts pins for its sibling: the fail direction. The function must never throw,
// must never mistake an unreadable record for a clean one, and must name every offending pass so a
// reader knows the consequence (the audit above is suppressed), not just the symptom.

interface ReadinessResult {
  status: 'unreadable' | 'no_entries' | 'unparsed' | 'ok';
  unparsed?: { pass: number; window: string | null; heading: string }[];
  entries?: number;
  detail: string;
}
interface Core {
  classifyPassRecordReadiness: (input: { logText: unknown }) => ReadinessResult;
}
const { classifyPassRecordReadiness } = coreModule as unknown as Core;

interface WarningInput {
  readFailed: boolean;
  readErrorText: string;
  verdict: ReadinessResult | null;
}
interface WarningResult {
  warn: boolean;
  message: string;
}
interface RecordCore {
  describePassRecordWarning: (input: WarningInput) => WarningResult;
}
const { describePassRecordWarning } = recordCoreModule as unknown as RecordCore;

const TWO_ENTRY_LOG = [
  '# Daily profitability loop — pass log',
  '',
  '## 2026-08-10 — Pass 60 (a morning pass)',
  '',
  '**Window:** 08:00Z → 09:00Z. `date -u` first.',
  '',
  '## 2026-08-11 — Pass 62 (an afternoon pass)',
  '',
  '**Window:** 2026-08-11T12:00Z → 13:00Z. Lease `25798a2449a344ac`, tree uncontended.',
  '',
].join('\n');

describe('classifyPassRecordReadiness', () => {
  it('reads ok with the right entry count on a well-formed two-entry log', () => {
    const res = classifyPassRecordReadiness({ logText: TWO_ENTRY_LOG });
    expect(res.status).toBe('ok');
    expect(res.entries).toBe(2);
  });

  it('names the pass and carries window: null when the **Window:** line is missing entirely', () => {
    const heading = '## 2026-08-11 — Pass 68 (window line omitted)';
    const logText = [
      heading,
      '',
      'Sweep at pass start: `Alarms (0)`. No window line was written this pass.',
      '',
    ].join('\n');
    const res = classifyPassRecordReadiness({ logText });
    expect(res.status).toBe('unparsed');
    expect(res.unparsed).toEqual([{ pass: 68, window: null, heading }]);
    expect(res.detail).toContain('Pass 68');
  });

  it('carries the raw window text when the end is prose, not a timestamp', () => {
    const heading = '## 2026-08-11 — Pass 67 (placeholder end time)';
    const logText = [heading, '', '**Window:** 2026-08-11T00:07Z → in progress.', ''].join('\n');
    const res = classifyPassRecordReadiness({ logText });
    expect(res.status).toBe('unparsed');
    expect(res.unparsed).toEqual([
      { pass: 67, window: '2026-08-11T00:07Z → in progress.', heading },
    ]);
    expect(res.detail).toContain('Pass 67');
  });

  // The REAL string Pass 67 wrote, not a paraphrase (git 70be95d, research/loop/LOG.md). It looks
  // like a timestamp and is rejected only because WINDOW_ABS_STAMP_RE demands two digits after the
  // colon — the near-miss shape 'in progress.' above does not pin, since a looser regex would still
  // reject prose.
  it('rejects the REAL Pass 67 placeholder end time (→ 17:0xZ), not just a prose paraphrase', () => {
    const heading =
      '## 2026-08-10 — Pass 67 (the out-of-sample arm stopped being UNSTARTED, and the one owed enable is refused by its own precondition)';
    const logText = [
      heading,
      '',
      '**Window:** 2026-08-10T16:07Z → 17:0xZ. Lease `04fb519b02bec364` taken 16:07:41Z. `date -u` anchored',
      '',
    ].join('\n');
    const res = classifyPassRecordReadiness({ logText });
    expect(res.status).toBe('unparsed');
    expect(res.unparsed?.map((u) => u.pass)).toEqual([67]);
    expect(res.detail).toContain('Pass 67');
  });

  it('names every offender when multiple entries are unparsed', () => {
    const logText = [
      '## 2026-08-10 — Pass 67 (placeholder end time)',
      '',
      '**Window:** 2026-08-10T00:07Z → in progress.',
      '',
      '## 2026-08-11 — Pass 68 (window line omitted)',
      '',
      'No window line this pass.',
      '',
    ].join('\n');
    const res = classifyPassRecordReadiness({ logText });
    expect(res.status).toBe('unparsed');
    expect(res.unparsed?.map((u) => u.pass)).toEqual([67, 68]);
    expect(res.detail).toContain('Pass 67');
    expect(res.detail).toContain('Pass 68');
  });

  it('reads no_entries when the log parses but yields zero pass headings', () => {
    const res = classifyPassRecordReadiness({
      logText: '# Daily profitability loop — pass log\n\nNothing here matches the convention.\n',
    });
    expect(res.status).toBe('no_entries');
  });

  it('reads unreadable for non-string and empty/whitespace-only input', () => {
    for (const logText of [null, undefined, 42, {}, '', '   \n\t']) {
      const res = classifyPassRecordReadiness({ logText });
      expect(res.status).toBe('unreadable');
    }
  });

  it('never throws on hostile input', () => {
    for (const logText of [null, undefined, 0, [], { toString: () => 'x' }]) {
      expect(() => classifyPassRecordReadiness({ logText })).not.toThrow();
    }
    expect(() =>
      classifyPassRecordReadiness(undefined as unknown as { logText: unknown }),
    ).not.toThrow();
    expect(() =>
      classifyPassRecordReadiness(null as unknown as { logText: unknown }),
    ).not.toThrow();
  });

  // 2026-08-11 review, MUST-FIX B: `err instanceof Error ? err.message : String(err)` threw for both
  // shapes below, which is what let the catch handler itself escape uncaught — reproduced against the
  // shell in an isolated scratch tree, AFTER the lock file had already been written. Both must return
  // a verdict, never throw.
  it('returns a verdict instead of throwing when logText is a getter that throws a non-Error with a throwing toString', () => {
    const hostileNonError = {
      toString() {
        throw new Error('toString also throws');
      },
    };
    const input = {
      get logText(): never {
        // only-throw-error: the hostile shape under test IS a getter that throws a non-Error — that
        // is the exact escape this spec pins.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw hostileNonError;
      },
    };
    let res: ReadinessResult | undefined;
    expect(() => {
      res = classifyPassRecordReadiness(input);
    }).not.toThrow();
    expect(res?.status).toBe('unreadable');
  });

  it('returns a verdict instead of throwing when the input is a Proxy that throws (a Proxy) on property access', () => {
    const proxyInput = new Proxy(
      {},
      {
        get() {
          // only-throw-error: the hostile shape under test throws a Proxy (not an Error) on property
          // access — that is the exact escape this spec pins.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw new Proxy({}, { get: () => throwOnAccess() });
        },
      },
    );
    function throwOnAccess(): never {
      throw new Error('nested proxy access');
    }
    let res: ReadinessResult | undefined;
    expect(() => {
      res = classifyPassRecordReadiness(proxyInput as unknown as { logText: unknown });
    }).not.toThrow();
    expect(res?.status).toBe('unreadable');
  });

  // SHOULD-FIX 3: LOG.md's addendum convention produces two headings sharing the SAME pass number
  // (real examples in research/loop/archive/LOG-through-pass-47.md: '## 2026-07-29 — Pass 47 (...)'
  // and '## 2026-07-29 — Pass 47 addendum b (...)'), so a bare pass number cannot identify which of
  // the two is the offender — `heading` must.
  it('carries heading on an unparsed entry, distinguishing a same-pass-number addendum', () => {
    const originalHeading =
      '## 2026-07-29 — Pass 47 (four measurement lies, one of them the alarm that was supposed to catch the other three)';
    const addendumHeading =
      '## 2026-07-29 — Pass 47 addendum b (RECONSTRUCTED by Pass 49: it ran, it left no record, and what it decided is gone)';
    const logText = [
      originalHeading,
      '',
      '**Window:** 2026-07-29T09:15Z → in progress.',
      '',
      addendumHeading,
      '',
      '**Window:** 2026-07-29T16:07Z → 19:47Z.',
      '',
    ].join('\n');
    const res = classifyPassRecordReadiness({ logText });
    expect(res.status).toBe('unparsed');
    expect(res.unparsed).toEqual([
      { pass: 47, window: '2026-07-29T09:15Z → in progress.', heading: originalHeading },
    ]);
  });
});

describe('describePassRecordWarning', () => {
  it('does not warn on an ok verdict', () => {
    const res = describePassRecordWarning({
      readFailed: false,
      readErrorText: '',
      verdict: { status: 'ok', entries: 3, detail: '3 pass entries parsed cleanly' },
    });
    expect(res.warn).toBe(false);
  });

  it('warns and names the pass on an unparsed verdict', () => {
    const res = describePassRecordWarning({
      readFailed: false,
      readErrorText: '',
      verdict: {
        status: 'unparsed',
        unparsed: [{ pass: 67, window: '2026-08-11T00:07Z → 17:0xZ', heading: '## Pass 67' }],
        detail: '1 of 2 pass entries have a missing or unreadable **Window:** line (Pass 67)',
      },
    });
    expect(res.warn).toBe(true);
    expect(res.message).toContain('Pass 67');
  });

  it('warns on a read failure', () => {
    const res = describePassRecordWarning({
      readFailed: true,
      readErrorText: 'ENOENT: no such file or directory',
      verdict: null,
    });
    expect(res.warn).toBe(true);
    expect(res.message).toContain('ENOENT');
  });

  it('never puts an absolute host path in the message, on any branch', () => {
    const branches: WarningInput[] = [
      {
        readFailed: true,
        readErrorText: '/Users/someone/repo/research/loop/LOG.md ENOENT',
        verdict: null,
      },
      {
        readFailed: false,
        readErrorText: '',
        verdict: { status: 'no_entries', detail: 'no entries' },
      },
      {
        readFailed: false,
        readErrorText: '',
        verdict: { status: 'ok', entries: 1, detail: '1 pass entry parsed cleanly' },
      },
    ];
    for (const input of branches) {
      const res = describePassRecordWarning(input);
      expect(res.message).not.toContain('/Users/');
    }
  });
});
