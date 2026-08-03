import { describe, it, expect } from 'vitest';
// @ts-expect-error scripts/** live outside the tsconfig graph (see tsconfig.eslint.json's include
// list) — both sweep modules are stdlib-only .mjs with no declaration file. Same bridge
// alarms.spec.ts and alert-history.spec.ts use.
import * as sweepModule from '../../../../scripts/loop-sweep.mjs';
// @ts-expect-error same graph boundary as above.
import * as coreModule from '../../../../scripts/loop-sweep-core.mjs';

// DELIVERABLE A (task #87) — the promotion-evidence ATOMIC TUPLE.
//
// The defect: research/loop/STATUS.md recorded a promotion window that advanced while the closed
// round-trip count stayed flat. Resolved during planning as a TRANSCRIPTION DESYNC — the window and
// the count were read at different moments and paired in prose; the true pairings were each
// self-consistent. The fix is an atomicity guarantee: every field of the tuple below is read from a
// SINGLE `promtool query instant` call against the seven `agentic_promotion_*` gauges that
// promotion-metrics.service.ts's tick() sets synchronously off ONE PromotionReadinessService.
// evaluate() call — so a pass can no longer pair a fresh field with a stale one.
//
// This is a MEASUREMENT/disclosure surface (never a defect signal), so it fails OPEN: a read failure
// becomes ONE annotation, never an alarm. The one rule that is NOT soft is that every field voids
// TOGETHER — a partially-populated tuple is exactly the failure mode being fixed, reproduced in a new
// place, so these cases pin that a void read is reported as void and never as a partial pass.

interface Annotation {
  kind: string;
  probe?: string;
  venue?: string;
  detail: string;
}
interface Alarm {
  kind: string;
  venue?: string;
  detail: string;
}
interface SweepResult {
  deltas: Record<string, unknown> | null;
  alarms: Alarm[];
  annotations: Annotation[];
}
interface PromProbe {
  ok: boolean;
  value?: {
    roundTrips?: number;
    winRate?: number;
    netPnlUsd?: number;
    llmCostUsd?: number;
    windowDays?: number;
    ready?: number;
    blockedByReason?: Record<string, number>;
  };
  error?: string;
}
interface Core {
  computeSweep: (input: { prev: unknown; cur: unknown }) => SweepResult;
  classifyPromotionEvidence: (probe: unknown) => { annotations: Annotation[] };
  PROMOTION_BLOCKED_REASONS: string[];
  VENUES: [string, string];
}
interface SweepModule {
  parseNamedPromSeries: (res: { ok: boolean; value?: string; error?: string }) => {
    ok: boolean;
    value?: { name: string; labels: Record<string, string>; value: number }[];
    error?: string;
  };
  buildPromotionEvidenceProbe: (res: { ok: boolean; value?: string; error?: string }) => PromProbe;
  PROMOTION_EVIDENCE_METRIC_NAMES: string[];
}
const core = coreModule as unknown as Core;
const sweep = sweepModule as unknown as SweepModule;
const { computeSweep, classifyPromotionEvidence, PROMOTION_BLOCKED_REASONS, VENUES } = core;
const { parseNamedPromSeries, buildPromotionEvidenceProbe, PROMOTION_EVIDENCE_METRIC_NAMES } =
  sweep;

const kinds = (xs: { kind: string }[]): string[] => xs.map((x) => x.kind);

// The exact closed 8-member union at ports/trading/promotion.ts:194-202 — pinned here so a future
// edit to that union that is not mirrored into loop-sweep-core.mjs's PROMOTION_BLOCKED_REASONS (and
// this literal) fails a test rather than silently under-checking the tuple.
const EXPECTED_REASONS = [
  'NO_STATS_SOURCE',
  'UNRESOLVED_FILL',
  'UNCONVERTIBLE_FEE_ASSET',
  'INSUFFICIENT_ROUND_TRIPS',
  'NON_POSITIVE_NET_PNL',
  'INSUFFICIENT_WINDOW',
  'FUNDING_DATA_MISSING',
  'BELOW_PASSIVE_BENCHMARK',
];

function promLine(name: string, value: number, labels?: Record<string, string>): string {
  const labelPart = labels
    ? `{${Object.entries(labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(',')}}`
    : '';
  return `${name}${labelPart} => ${value} @[1785258935.402]`;
}

// A full, internally-consistent tuple exactly as promtool would render one instant read of all
// seven `agentic_promotion_*` series in a single call.
function fullTupleText(over: { blocked?: Record<string, number>; omit?: string[] } = {}): string {
  const blockedValues: Record<string, number> = Object.fromEntries(
    EXPECTED_REASONS.map((r) => [r, 0]),
  );
  Object.assign(blockedValues, over.blocked ?? {});
  const omit = new Set(over.omit ?? []);
  const lines = [
    !omit.has('agentic_promotion_round_trips') && promLine('agentic_promotion_round_trips', 34),
    !omit.has('agentic_promotion_win_rate') && promLine('agentic_promotion_win_rate', 0.62),
    !omit.has('agentic_promotion_net_pnl_usd') && promLine('agentic_promotion_net_pnl_usd', 12.34),
    !omit.has('agentic_promotion_llm_cost_usd') && promLine('agentic_promotion_llm_cost_usd', 0.87),
    !omit.has('agentic_promotion_window_days') && promLine('agentic_promotion_window_days', 7.329),
    !omit.has('agentic_promotion_ready') && promLine('agentic_promotion_ready', 0),
    ...EXPECTED_REASONS.filter((r) => !omit.has(`reason:${r}`)).map((r) =>
      promLine('agentic_promotion_blocked', blockedValues[r]!, { reason: r }),
    ),
  ].filter((l): l is string => typeof l === 'string');
  return lines.join('\n');
}

describe('PROMOTION_BLOCKED_REASONS is the exact closed 8-member union', () => {
  it('matches ports/trading/promotion.ts:194-202 verbatim', () => {
    expect(PROMOTION_BLOCKED_REASONS).toEqual(EXPECTED_REASONS);
  });
});

describe('one promtool call names every field — parseNamedPromSeries / buildPromotionEvidenceProbe', () => {
  it('names every metric queried, matching PROMOTION_EVIDENCE_METRIC_NAMES', () => {
    expect(PROMOTION_EVIDENCE_METRIC_NAMES).toContain('agentic_promotion_round_trips');
    expect(PROMOTION_EVIDENCE_METRIC_NAMES).toContain('agentic_promotion_blocked');
    expect(PROMOTION_EVIDENCE_METRIC_NAMES).toHaveLength(7);
  });

  it('recovers the metric NAME as well as its labels and value from one query’s output', () => {
    const res = { ok: true, value: fullTupleText() };
    const parsed = parseNamedPromSeries(res);
    expect(parsed.ok).toBe(true);
    const names = (parsed.value ?? []).map((s) => s.name);
    expect(new Set(names)).toEqual(
      new Set([
        'agentic_promotion_blocked',
        ...PROMOTION_EVIDENCE_METRIC_NAMES.filter((n) => n !== 'agentic_promotion_blocked'),
      ]),
    );
    const blockedRows = (parsed.value ?? []).filter((s) => s.name === 'agentic_promotion_blocked');
    expect(blockedRows).toHaveLength(8);
    expect(blockedRows.every((r) => typeof r.labels.reason === 'string')).toBe(true);
  });

  it('assembles the full tuple shape from one instant read', () => {
    const probe = buildPromotionEvidenceProbe({ ok: true, value: fullTupleText() });
    expect(probe.ok).toBe(true);
    expect(probe.value?.roundTrips).toBe(34);
    expect(probe.value?.winRate).toBe(0.62);
    expect(probe.value?.netPnlUsd).toBe(12.34);
    expect(probe.value?.llmCostUsd).toBe(0.87);
    expect(probe.value?.windowDays).toBe(7.329);
    expect(probe.value?.ready).toBe(0);
    expect(Object.keys(probe.value?.blockedByReason ?? {})).toHaveLength(8);
  });

  it('passes a transport failure straight through', () => {
    expect(buildPromotionEvidenceProbe({ ok: false, error: 'docker exec failed' })).toEqual({
      ok: false,
      error: 'docker exec failed',
    });
  });
});

describe('classifyPromotionEvidence — a complete tuple reads as ONE annotation, never an alarm', () => {
  it('emits the whole tuple in one annotation, never as an alarm', () => {
    const probe = buildPromotionEvidenceProbe({ ok: true, value: fullTupleText() });
    const { annotations } = classifyPromotionEvidence(probe);
    expect(kinds(annotations)).toEqual(['promotion_evidence']);
    const [note] = annotations;
    expect(note?.detail).toContain('windowDays=7.329');
    expect(note?.detail).toContain('roundTrips=34');
    expect(note?.detail).toContain('netPnlUsd=12.34');
    expect(note?.detail).toContain('llmCostUsd=0.87');
    expect(note?.detail).toContain('winRate=0.62');
    expect(note?.detail).toContain('ready=false');
    expect(note?.detail).toContain('reasons=[none]');
  });

  it('names the blocking reasons currently set to 1', () => {
    const probe = buildPromotionEvidenceProbe({
      ok: true,
      value: fullTupleText({ blocked: { INSUFFICIENT_ROUND_TRIPS: 1, INSUFFICIENT_WINDOW: 1 } }),
    });
    const { annotations } = classifyPromotionEvidence(probe);
    expect(annotations[0]?.detail).toContain(
      'reasons=[INSUFFICIENT_ROUND_TRIPS, INSUFFICIENT_WINDOW]',
    );
  });

  it('reads ready=1 as true', () => {
    const probe = buildPromotionEvidenceProbe({
      ok: true,
      value: fullTupleText().replace(
        'agentic_promotion_ready => 0',
        'agentic_promotion_ready => 1',
      ),
    });
    const { annotations } = classifyPromotionEvidence(probe);
    expect(annotations[0]?.detail).toContain('ready=true');
  });
});

describe('classifyPromotionEvidence — an INCOMPLETE tuple voids WHOLESALE, never partially', () => {
  it('voids the whole tuple when one scalar gauge is missing, and reports NO partial reading', () => {
    const probe = buildPromotionEvidenceProbe({
      ok: true,
      value: fullTupleText({ omit: ['agentic_promotion_window_days'] }),
    });
    const { annotations } = classifyPromotionEvidence(probe);
    expect(kinds(annotations)).toEqual(['promotion_evidence_void']);
    expect(annotations[0]?.detail).toContain('windowDays');
    expect(annotations[0]?.detail).toContain('INCOMPLETE');
    // The task #87 property: no field of the (still fully computable) tuple leaks through.
    expect(annotations[0]?.detail).not.toContain('roundTrips=34');
  });

  it('voids the whole tuple when one blocked-reason label is missing', () => {
    const probe = buildPromotionEvidenceProbe({
      ok: true,
      value: fullTupleText({ omit: ['reason:FUNDING_DATA_MISSING'] }),
    });
    const { annotations } = classifyPromotionEvidence(probe);
    expect(kinds(annotations)).toEqual(['promotion_evidence_void']);
    expect(annotations[0]?.detail).toContain('FUNDING_DATA_MISSING');
  });

  it('voids on a transport failure, naming the error', () => {
    const { annotations } = classifyPromotionEvidence({ ok: false, error: 'docker exec failed' });
    expect(kinds(annotations)).toEqual(['promotion_evidence_void']);
    expect(annotations[0]?.detail).toContain('docker exec failed');
  });

  it('voids when the probe is absent entirely', () => {
    for (const absent of [undefined, null]) {
      const { annotations } = classifyPromotionEvidence(absent);
      expect(kinds(annotations)).toEqual(['promotion_evidence_void']);
    }
  });

  it('never throws, and a thrown classifier still reports VOID by name', () => {
    const hostile: unknown[] = [
      42,
      'nonsense',
      [],
      { ok: true, value: 7 },
      {
        ok: true,
        get value(): never {
          throw new Error('exploding getter');
        },
      },
    ];
    for (const input of hostile) {
      let out: { annotations: Annotation[] } | null = null;
      expect(() => {
        out = classifyPromotionEvidence(input);
      }).not.toThrow();
      expect(kinds(out!.annotations)).toEqual(['promotion_evidence_void']);
    }
  });
});

describe('the tuple is wired into computeSweep as an ANNOTATION, and can never become an alarm', () => {
  function appWith(probe: unknown): Record<string, unknown> {
    const reconcile: Record<string, unknown> = {};
    for (const venue of VENUES) reconcile[venue] = { ok: true, value: { count: 10 } };
    return {
      bootId: 'boot-A',
      containerHealthy: true,
      restartCount: 0,
      startedAt: new Date(1_000_000).toISOString(),
      probes: {
        decides: { ok: true, value: { count: 10, latestCreatedAtMs: 1_000_000 } },
        reconcile,
        killSwitch: { ok: true, value: { state: 'RUNNING' } },
        promotionEvidence: probe,
      },
    };
  }

  it('reaches computeSweep’s annotations as `promotion_evidence`', () => {
    const probe = buildPromotionEvidenceProbe({ ok: true, value: fullTupleText() });
    const { alarms, annotations } = computeSweep({
      prev: null,
      cur: { sweptAtMs: 10_000_000, app: appWith(probe) },
    });
    expect(kinds(annotations)).toContain('promotion_evidence');
    expect(alarms.map((a) => a.kind)).not.toContain('promotion_evidence');
    expect(alarms.map((a) => a.kind)).not.toContain('promotion_evidence_void');
  });

  it('a void read still reaches computeSweep, as an annotation, never an alarm', () => {
    const { alarms, annotations } = computeSweep({
      prev: null,
      cur: { sweptAtMs: 10_000_000, app: appWith({ ok: false, error: 'docker exec failed' }) },
    });
    expect(kinds(annotations)).toContain('promotion_evidence_void');
    expect(alarms.map((a) => a.kind)).not.toContain('promotion_evidence_void');
  });
});
