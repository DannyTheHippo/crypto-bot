import { describe, it, expect } from 'vitest';
// @ts-expect-error scripts/** live outside the tsconfig graph (see tsconfig.eslint.json's include
// list) — both are stdlib-only .mjs with no declaration files. Same bridge alert-history.spec.ts
// uses to reach renderMarkdown alongside the core.
import * as sweepModule from '../../../../scripts/loop-sweep.mjs';
// @ts-expect-error see above.
import * as coreModule from '../../../../scripts/loop-sweep-core.mjs';

// OFF-GATE HARNESS MONITOR (backlog 54). test/eval and test/backtest are deliberately OFF the
// production gate, so their failures are invisible by construction — three consecutive passes shipped
// only defect repairs and the loop's own verdict was "every defect found was invisible by
// construction". The 2026-07-31 session proved it twice: the counterfactual-scoring horizon fix broke
// eval:agentic AND a test/features/strategy/eval spec, and both were found only because a human ran
// them by hand.
//
// This monitor fails OPEN — annotations only, never an alarm, because a broken monitor must not block
// the pass it reports into. The property that actually matters, and that most of this spec is about,
// is the OTHER half: a STALE result must be its own named annotation and must be impossible to read
// as clean. "No run in 12 hours" and "last run passed" are different facts and the digest has to say
// which one it has. This repo's history is a series of void reads where an absence looked like health.

interface Annotation {
  kind: string;
  probe?: string;
  venue?: string;
  detail: string;
}
interface Harness {
  id: string;
  label: string;
  args: string[];
  onGate: boolean;
}
interface Core {
  classifyHarnessRuns: (input: {
    artifactText?: string | null;
    nowMs?: number | null;
    harnesses?: Harness[] | null;
  }) => { annotations: Annotation[] };
  MONITORED_HARNESSES: Harness[];
  HARNESS_RESULT_STALE_MS: number;
  HARNESS_ARTIFACT_NAME: string;
  EXPECTED_SWEEP_INTERVAL_MS: number;
}
interface Sweep {
  renderMarkdown: (input: {
    sweptIso: string;
    host: Record<string, unknown>;
    git: string | null;
    app: unknown;
    result: { deltas: null; alarms: unknown[]; annotations: Annotation[] };
  }) => string;
}
const core = coreModule as unknown as Core;
const sweep = sweepModule as unknown as Sweep;
const {
  classifyHarnessRuns,
  MONITORED_HARNESSES,
  HARNESS_RESULT_STALE_MS,
  EXPECTED_SWEEP_INTERVAL_MS,
} = core;

const NOW = 10_000_000_000;
const ONE: Harness[] = [
  { id: 'eval-agentic', label: 'pnpm eval:agentic (test/eval)', args: [], onGate: false },
];
const ON_GATE: Harness[] = [
  {
    id: 'loop-sweep-specs',
    label: 'loop-sweep specs (incl. forward-return.spec.ts)',
    args: [],
    onGate: true,
  },
];

function artifact(runs: Record<string, unknown>): string {
  return JSON.stringify({ schema: 1, writtenAtMs: NOW, runs });
}
function run(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: 'pnpm eval:agentic (test/eval)',
    startedAtMs: NOW - 60_000,
    finishedAtMs: NOW - 60_000,
    durationMs: 60_000,
    ok: true,
    exitCode: 0,
    summary: 'Test Files  12 passed (12) · Tests  180 passed (180)',
    ...over,
  };
}
const only = (
  input: { artifactText?: string | null; nowMs?: number | null },
  harnesses = ONE,
): Annotation => {
  const [first] = classifyHarnessRuns({ ...input, harnesses }).annotations;
  // Not defensive padding: returning nothing is the ONE outcome this classifier must never have,
  // so the helper every test funnels through is where that invariant is cheapest to enforce.
  if (!first) throw new Error('classifyHarnessRuns returned no annotation for a monitored harness');
  return first;
};

describe('the monitored set, and which of its members are actually off the production gate', () => {
  it('watches the loop-sweep specs (which carry forward-return.spec.ts) and eval:agentic', () => {
    const ids = MONITORED_HARNESSES.map((h) => h.id);
    expect(ids).toContain('loop-sweep-specs');
    expect(ids).toContain('eval-agentic');
    const sweepSpecs = MONITORED_HARNESSES.find((h) => h.id === 'loop-sweep-specs');
    // The peer's forward-return.spec.ts lives under this path — the monitored target is the
    // directory, so a new spec dropped beside it is covered without editing this list.
    expect(sweepSpecs?.args).toContain('test/features/strategy/loop-sweep');
    const evalAgentic = MONITORED_HARNESSES.find((h) => h.id === 'eval-agentic');
    expect(evalAgentic?.args).toContain('test/eval');
  });

  it('records loop-sweep-specs as ON the production gate, and the other two as OFF it', () => {
    // pnpm test == `vitest run test/features test/domain test/ports test/livegate` (package.json) —
    // test/features/strategy/loop-sweep is matched by the test/features positional, so this harness
    // is NOT off-gate the way the other two genuinely are.
    expect(MONITORED_HARNESSES.find((h) => h.id === 'loop-sweep-specs')?.onGate).toBe(true);
    expect(MONITORED_HARNESSES.find((h) => h.id === 'eval-agentic')?.onGate).toBe(false);
    expect(MONITORED_HARNESSES.find((h) => h.id === 'backtest')?.onGate).toBe(false);
  });

  it('also watches test/backtest — the other harness named in the finding', () => {
    expect(MONITORED_HARNESSES.find((h) => h.id === 'backtest')?.args).toContain('test/backtest');
  });

  it('emits exactly one annotation per monitored harness — there is no silent path', () => {
    // Every state below, including the fully-healthy one, produces a full set. Silence from this
    // check is not a thing it can do, which is what makes silence-equals-clean unavailable.
    const states: { artifactText: string | null; nowMs: number | null }[] = [
      { artifactText: artifact({}), nowMs: NOW },
      { artifactText: null, nowMs: NOW },
      { artifactText: '{{{ not json', nowMs: NOW },
      { artifactText: artifact({ 'eval-agentic': run() }), nowMs: NOW },
      { artifactText: artifact({ 'eval-agentic': run() }), nowMs: null },
    ];
    for (const s of states) {
      const { annotations } = classifyHarnessRuns(s);
      expect(annotations, JSON.stringify(s).slice(0, 60)).toHaveLength(MONITORED_HARNESSES.length);
      for (const a of annotations) expect(a.kind).toMatch(/^harness_/);
    }
  });
});

describe('fresh results', () => {
  it('reports a fresh PASS, carrying the suite’s own summary line', () => {
    const a = only({ artifactText: artifact({ 'eval-agentic': run() }), nowMs: NOW });
    expect(a.kind).toBe('harness_ok');
    expect(a.probe).toBe('eval-agentic');
    expect(a.detail).toContain('PASS');
    expect(a.detail).toContain('180 passed');
  });

  it('reports a fresh FAIL as an annotation, never an alarm, and says why nothing else will catch it', () => {
    const a = only({
      artifactText: artifact({ 'eval-agentic': run({ ok: false, exitCode: 1 }) }),
      nowMs: NOW,
    });
    expect(a.kind).toBe('harness_failed');
    expect(a.detail).toContain('FAIL');
    expect(a.detail).toContain('exit 1');
    expect(a.detail).toContain('OFF the production gate');
    // Fail-open contract: the classifier returns annotations only, so there is no path by which a
    // red off-gate suite blocks a pass.
    expect(Object.keys(classifyHarnessRuns({ artifactText: null, nowMs: NOW }))).toEqual([
      'annotations',
    ]);
  });

  it('states the true per-harness gate fact instead of one blanket claim — loop-sweep-specs IS on `pnpm test`', () => {
    const neverRun = only({ artifactText: null, nowMs: NOW }, ON_GATE);
    expect(neverRun.kind).toBe('harness_never_run');
    expect(neverRun.detail).toContain('ON the production gate');
    expect(neverRun.detail).not.toContain('OFF the production gate');

    const failed = only(
      {
        artifactText: artifact({ 'loop-sweep-specs': run({ ok: false, exitCode: 1 }) }),
        nowMs: NOW,
      },
      ON_GATE,
    );
    expect(failed.kind).toBe('harness_failed');
    expect(failed.detail).toContain('ON the production gate');
    expect(failed.detail).not.toContain('OFF the production gate');

    // eval-agentic (used throughout this file's other tests) genuinely IS off-gate, so its wording
    // is unchanged by this fix.
    const offGateFailed = only({
      artifactText: artifact({ 'eval-agentic': run({ ok: false, exitCode: 1 }) }),
      nowMs: NOW,
    });
    expect(offGateFailed.detail).toContain('OFF the production gate');
  });

  it('treats a result exactly at the freshness bound as fresh, and one millisecond past it as stale', () => {
    const at = only({
      artifactText: artifact({
        'eval-agentic': run({ finishedAtMs: NOW - HARNESS_RESULT_STALE_MS }),
      }),
      nowMs: NOW,
    });
    expect(at.kind).toBe('harness_ok');
    const past = only({
      artifactText: artifact({
        'eval-agentic': run({ finishedAtMs: NOW - HARNESS_RESULT_STALE_MS - 1 }),
      }),
      nowMs: NOW,
    });
    expect(past.kind).toBe('harness_stale');
  });

  it('sizes the freshness bound off the pass cadence, tolerating exactly one slipped run', () => {
    expect(HARNESS_RESULT_STALE_MS).toBe(1.5 * EXPECTED_SWEEP_INTERVAL_MS);
  });
});

describe('STALE is its own fact — the whole point of the mechanism', () => {
  it('names a stale PASS as stale and refuses to let its verdict stand as current evidence', () => {
    const a = only({
      artifactText: artifact({ 'eval-agentic': run({ finishedAtMs: NOW - 30 * 60 * 60 * 1000 }) }),
      nowMs: NOW,
    });
    expect(a.kind).toBe('harness_stale');
    // NOT harness_ok, even though the recorded verdict was a pass. This is the confusion the
    // mechanism exists to make impossible.
    expect(a.kind).not.toBe('harness_ok');
    expect(a.detail).toContain('STALE');
    expect(a.detail).toContain('30.0h ago');
    expect(a.detail).toContain('NOT a clean one');
  });

  it('is equally stale when the recorded verdict was a FAIL — age dominates the verdict', () => {
    const a = only({
      artifactText: artifact({
        'eval-agentic': run({ ok: false, finishedAtMs: NOW - 20 * 60 * 60 * 1000 }),
      }),
      nowMs: NOW,
    });
    expect(a.kind).toBe('harness_stale');
    expect(a.detail).toContain('FAIL');
  });

  it('treats a future-dated result as stale rather than fresh — skew is not freshness', () => {
    const a = only({
      artifactText: artifact({ 'eval-agentic': run({ finishedAtMs: NOW + 60 * 60 * 1000 }) }),
      nowMs: NOW,
    });
    expect(a.kind).toBe('harness_stale');
    expect(a.detail).toContain('FUTURE');
  });

  it('is rendered distinguishably from a clean pass in the digest a human actually reads', () => {
    const render = (annotations: Annotation[]): string =>
      sweep.renderMarkdown({
        sweptIso: '2026-07-31T12:00:00.000Z',
        host: { powerSource: 'AC', bootTime: null, uptime: null, errors: [] },
        git: 'abc1234',
        app: null,
        result: { deltas: null, alarms: [], annotations },
      });

    const clean = render(
      classifyHarnessRuns({
        artifactText: artifact({ 'eval-agentic': run() }),
        nowMs: NOW,
        harnesses: ONE,
      }).annotations,
    );
    const stale = render(
      classifyHarnessRuns({
        artifactText: artifact({
          'eval-agentic': run({ finishedAtMs: NOW - 40 * 60 * 60 * 1000 }),
        }),
        nowMs: NOW,
        harnesses: ONE,
      }).annotations,
    );

    expect(clean).toContain('harness_ok');
    expect(clean).not.toContain('harness_stale');
    expect(stale).toContain('harness_stale');
    expect(stale).not.toContain('harness_ok');
    // Not merely different kinds — the stale line states its age, so a reader skimming the digest
    // sees "40.0h ago" rather than a verdict word they would score as health.
    expect(stale).toContain('40.0h ago');
    expect(stale).toContain('NOT evidence about the current tree');
    expect(stale).not.toBe(clean);
  });
});

describe('absent and unreadable results, each by its own name', () => {
  it('names a never-run harness when the artifact is absent', () => {
    const a = only({ artifactText: null, nowMs: NOW });
    expect(a.kind).toBe('harness_never_run');
    expect(a.detail).toContain('artifact absent');
    expect(a.detail).toContain('pnpm loop:harness');
  });

  it('names a never-run harness when the artifact exists but omits it', () => {
    const a = only({ artifactText: artifact({ 'some-other-suite': run() }), nowMs: NOW });
    expect(a.kind).toBe('harness_never_run');
    expect(a.detail).toContain('NO recorded run');
  });

  it('names an unparseable artifact rather than treating it as absent or clean', () => {
    for (const bad of ['{{{ not json', '[]', '{"runs": 7}', '{"nope": true}']) {
      const a = only({ artifactText: bad, nowMs: NOW });
      expect(a.kind, bad).toBe('harness_result_unreadable');
    }
  });

  it('names a malformed entry — a verdict with no timestamp is not a verdict', () => {
    const cases: Record<string, unknown>[] = [
      { finishedAtMs: null },
      { finishedAtMs: 'yesterday' },
      { ok: 'true' },
      { ok: 1 },
    ];
    for (const over of cases) {
      const a = only({ artifactText: artifact({ 'eval-agentic': run(over) }), nowMs: NOW });
      expect(a.kind, JSON.stringify(over)).toBe('harness_result_unreadable');
      expect(a.detail).toContain('not a pass');
    }
  });

  it('refuses to call anything fresh when the sweep supplied no clock reading', () => {
    const a = only({ artifactText: artifact({ 'eval-agentic': run() }), nowMs: null });
    expect(a.kind).toBe('harness_result_unreadable');
    expect(a.detail).toContain('freshness UNKNOWN');
  });

  it('never throws, and a thrown monitor still reports itself by name', () => {
    const hostile: unknown[] = [undefined, 42, [], { artifactText: 5 }, { nowMs: 'now' }];
    for (const input of hostile) {
      expect(() => classifyHarnessRuns(input as never), JSON.stringify(input)).not.toThrow();
    }
    // The catch-all path: a harness list that explodes while being walked.
    const exploding = [
      {
        id: 'boom',
        get label(): never {
          throw new Error('exploding label');
        },
        args: [],
      },
    ] as unknown as Harness[];
    const { annotations } = classifyHarnessRuns({
      artifactText: null,
      nowMs: NOW,
      harnesses: exploding,
    });
    expect(annotations.map((a) => a.kind)).toEqual(['harness_monitor_failed']);
    expect(annotations[0]?.detail).toContain('void read, not a clean one');
  });
});
