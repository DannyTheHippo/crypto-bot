import { describe, it, expect } from 'vitest';
// @ts-expect-error scripts/** live outside the tsconfig graph (see tsconfig.eslint.json's include
// list) — the pure sweep core is a stdlib-only .mjs with no declaration file. vitest/swc resolves it
// at runtime; this directive is the only bridge across the graph boundary the four-file deliverable
// allows (no 5th .d.ts, no tsconfig edit).
import * as coreModule from '../../../scripts/loop-sweep-core.mjs';

// loop-sweep-core.mjs is the PURE decision layer of the Y2 health sweep: given a prior watermark and
// this pass's probe results it derives {deltas, alarms, annotations} with no I/O. This spec pins the
// §C defect-class checks (loop-mechanism-learnings-2026-07.md) the core encodes — each alarm fires on
// its own signature and stays silent otherwise, probe failures degrade to named notes (never a crash,
// never a false pass), and a boot change resets deltas instead of fabricating negatives.

interface Alarm {
  kind: string;
  lane: string;
  detail: string;
}
interface Annotation {
  kind: string;
  lane?: string;
  probe?: string;
  detail: string;
}
interface SweepResult {
  deltas: Record<string, Record<string, number | null> | null>;
  alarms: Alarm[];
  annotations: Annotation[];
}
interface Core {
  computeSweep: (input: { prev: unknown; cur: unknown }) => SweepResult;
  EXPECTED_SWEEP_INTERVAL_MS: number;
}
const core = coreModule as unknown as Core;
const { computeSweep, EXPECTED_SWEEP_INTERVAL_MS } = core;

const WM_TIME = 10_000_000_000;

// Fixed-shape probe bag (not Record<string,...>) so noUncheckedIndexedAccess doesn't force every
// mutation site below through an `undefined` check — each field is a known, always-present key.
interface Probes {
  decides: { ok: boolean; value: { count: number; latestCreatedAtMs: number } };
  consultGate: { ok: boolean; value: { total: number } };
  fills: { ok: boolean; value: { count: number } };
  reconcile: { ok: boolean; value: { count: number; latestResult: string } };
  killSwitch: { ok: boolean; value: { state: string } };
  cost: { ok: boolean; value: { spendUsd: number } };
  wsRecreations: { ok: boolean; value: { count: number } };
  rss: { ok: boolean; value: { bytes: number } };
}
interface Lane {
  bootId: string;
  containerHealthy: boolean;
  restartCount: number;
  probes: Probes;
}

function baseProbes(): Probes {
  return {
    decides: { ok: true, value: { count: 100, latestCreatedAtMs: WM_TIME } },
    consultGate: { ok: true, value: { total: 50 } },
    fills: { ok: true, value: { count: 10 } },
    reconcile: { ok: true, value: { count: 200, latestResult: 'CLEAN' } },
    killSwitch: { ok: true, value: { state: 'RUNNING' } },
    cost: { ok: true, value: { spendUsd: 0.1 } },
    wsRecreations: { ok: true, value: { count: 2 } },
    rss: { ok: true, value: { bytes: 1000 } },
  };
}

function baseLane(): Lane {
  return { bootId: 'boot-A', containerHealthy: true, restartCount: 3, probes: baseProbes() };
}

// Watermark counters that MATCH baseProbes exactly — a test perturbs only the counter it exercises so
// deltas are zero everywhere else (isolating the one alarm under test).
function baseWatermark(): Record<string, unknown> {
  return {
    sweptAtMs: WM_TIME,
    lanes: {
      spot: {
        bootId: 'boot-A',
        restartCount: 3,
        counters: {
          decides: 100,
          consultGate: 50,
          fills: 10,
          reconcile: 200,
          wsRecreations: 2,
          rssBytes: 1000,
        },
      },
    },
  };
}

// A `cur` one design-interval after the watermark (well under the 2x host-sleep gap), single spot lane.
function curWith(lane: Lane): Record<string, unknown> {
  return { sweptAtMs: WM_TIME + EXPECTED_SWEEP_INTERVAL_MS, lanes: { spot: lane } };
}

function kinds(items: { kind: string }[]): string[] {
  return items.map((i) => i.kind);
}

describe('loop-sweep-core alarms', () => {
  it('is silent when the lane is healthy and every counter advanced', () => {
    const lane = baseLane();
    lane.probes.decides.value.count = 130;
    lane.probes.consultGate.value.total = 70;
    lane.probes.reconcile.value.count = 220;
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(lane) });
    expect(alarms).toEqual([]);
  });

  it('zero_decides fires when containers healthy but liveness counters are unchanged since watermark', () => {
    const lane = baseLane();
    // decides + consult-gate frozen; reconcile advances so journal_silence stays silent.
    lane.probes.reconcile.value.count = 220;
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(lane) });
    expect(kinds(alarms)).toContain('zero_decides');
    expect(kinds(alarms)).not.toContain('journal_silence');
  });

  it('does not fire zero_decides while the container is unhealthy (no green positive control)', () => {
    const lane = baseLane();
    lane.containerHealthy = false;
    lane.probes.reconcile.value.count = 220;
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(lane) });
    expect(kinds(alarms)).not.toContain('zero_decides');
  });

  it('journal_silence fires when the reconciliations journal produced no new rows while healthy', () => {
    const lane = baseLane();
    // reconcile frozen; decides advances so zero_decides stays silent.
    lane.probes.decides.value.count = 140;
    lane.probes.consultGate.value.total = 80;
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(lane) });
    expect(kinds(alarms)).toContain('journal_silence');
    expect(kinds(alarms)).not.toContain('zero_decides');
  });

  it('kill_switch_engaged fires on any non-RUNNING state', () => {
    const lane = baseLane();
    lane.probes.killSwitch.value.state = 'HALTED_DEGRADED';
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(lane) });
    const ks = alarms.find((a) => a.kind === 'kill_switch_engaged');
    expect(ks).toBeDefined();
    expect(ks?.detail).toContain('HALTED_DEGRADED');
  });

  it('reconcile_halt fires when the latest reconciliation verdict is HALT', () => {
    const lane = baseLane();
    lane.probes.reconcile.value.latestResult = 'HALT';
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(lane) });
    expect(kinds(alarms)).toContain('reconcile_halt');
  });

  it('cost_breaker_proximity fires at >=80% of the $1.50 spot breaker', () => {
    const lane = baseLane();
    lane.probes.cost.value.spendUsd = 1.2; // 80% of $1.50
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(lane) });
    expect(kinds(alarms)).toContain('cost_breaker_proximity');
  });

  it('cost_breaker_proximity uses the tighter $0.75 perp breaker on the perp lane', () => {
    const lane = baseLane();
    lane.probes.cost.value.spendUsd = 0.6; // 80% of $0.75, below the $1.50 spot threshold
    const cur = { sweptAtMs: WM_TIME + EXPECTED_SWEEP_INTERVAL_MS, lanes: { perp: lane } };
    const watermarkLanes = baseWatermark().lanes as Record<string, unknown>;
    const prev = { sweptAtMs: WM_TIME, lanes: { perp: watermarkLanes.spot } };
    const { alarms } = computeSweep({ prev, cur });
    const cb = alarms.find((a) => a.kind === 'cost_breaker_proximity');
    expect(cb).toBeDefined();
    expect(cb?.lane).toBe('perp');
  });

  it('restart_storm fires when RestartCount climbed more than once since the watermark', () => {
    const lane = baseLane();
    lane.restartCount = 5; // watermark was 3 => +2 restarts
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(lane) });
    expect(kinds(alarms)).toContain('restart_storm');
  });

  it('does not fire restart_storm on a single ordinary redeploy', () => {
    const lane = baseLane();
    lane.restartCount = 4; // +1
    const { alarms } = computeSweep({ prev: baseWatermark(), cur: curWith(lane) });
    expect(kinds(alarms)).not.toContain('restart_storm');
  });

  it('a failed probe becomes a named probe_failed note — never a pass, never a throw', () => {
    const lane = baseLane();
    (lane as { probes: unknown }).probes = {
      ...lane.probes,
      decides: { ok: false, error: 'psql exited 2: connection refused' },
    };
    let result!: SweepResult;
    expect(() => {
      result = computeSweep({ prev: baseWatermark(), cur: curWith(lane) });
    }).not.toThrow();
    const failed = result.annotations.find(
      (n) => n.kind === 'probe_failed' && n.probe === 'decides',
    );
    expect(failed).toBeDefined();
    // The frozen-counter alarm must NOT fire off an unreadable probe (delta is null, not zero).
    expect(kinds(result.alarms)).not.toContain('zero_decides');
    expect(result.deltas.spot?.decides).toBeNull();
  });

  it('a sweep gap beyond 2x the expected interval is a host-sleep ANNOTATION, not an alarm', () => {
    const lane = baseLane();
    lane.probes.reconcile.value.count = 220;
    lane.probes.decides.value.count = 140;
    lane.probes.consultGate.value.total = 80;
    const cur = {
      sweptAtMs: WM_TIME + 3 * EXPECTED_SWEEP_INTERVAL_MS, // > 2x gap
      lanes: { spot: lane },
    };
    const { alarms, annotations } = computeSweep({ prev: baseWatermark(), cur });
    expect(kinds(annotations)).toContain('host_sleep_suspected');
    expect(kinds(alarms)).not.toContain('host_sleep_suspected');
  });

  it('bootId mismatch resets deltas verbatim and never yields a negative delta', () => {
    const lane = baseLane();
    lane.bootId = 'boot-B'; // watermark was boot-A
    // Counters LOWER than the watermark — a cross-boot subtraction would go negative.
    lane.probes.decides.value.count = 5;
    lane.probes.consultGate.value.total = 1;
    lane.probes.reconcile.value.count = 3;
    const { deltas, annotations, alarms } = computeSweep({
      prev: baseWatermark(),
      cur: curWith(lane),
    });
    const reset = annotations.find((n) => n.kind === 'boot_changed');
    expect(reset?.detail).toBe('boot changed — deltas reset');
    expect(deltas.spot).toBeNull();
    // No delta-derived alarm may fire off a reset boot.
    expect(kinds(alarms)).not.toContain('zero_decides');
    expect(kinds(alarms)).not.toContain('journal_silence');
  });

  it('negative_read_void notes a zero durable counter while a sibling counter proves the stack answers', () => {
    const lane = baseLane();
    lane.probes.decides.value.count = 0; // empty read
    lane.probes.fills.value.count = 10; // positive control: the DB IS returning data
    const { annotations } = computeSweep({ prev: baseWatermark(), cur: curWith(lane) });
    const void_ = annotations.find((n) => n.kind === 'negative_read_void' && n.probe === 'decides');
    expect(void_).toBeDefined();
  });

  it('the first sweep (no watermark) reports no deltas and does not crash', () => {
    const lane = baseLane();
    const result = computeSweep({ prev: null, cur: curWith(lane) });
    expect(kinds(result.annotations)).toContain('no_watermark');
    expect(result.deltas.spot).toBeNull();
  });
});
