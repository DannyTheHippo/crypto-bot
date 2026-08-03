import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
// @ts-expect-error scripts/** live outside the tsconfig graph (see tsconfig.eslint.json's include
// list) — the pure sweep core is a stdlib-only .mjs with no declaration file. Same bridge
// venue-reject-rate.spec.ts uses.
import * as coreModule from '../../../../scripts/loop-sweep-core.mjs';

// DELIVERABLE B — five DB integrity invariants (W1, I1, I2, I4, W3). None of these existed before
// this pass. All five are ALARMS and fail CLOSED — each guards a named corruption mode where an
// unreadable answer is itself the finding, matching classifyVenueRejectRates' own fail-CLOSED
// argument (the opposite direction from Deliverable A's measurement/veto-only tuple, which fails
// OPEN). These cases pin: each check firing on a genuine violation, staying silent on a clean read,
// and — the property every one of these shares with venue-reject-rate — treating an unreadable
// probe as an ALARM rather than a quiet pass.

interface Alarm {
  kind: string;
  detail: string;
}
interface Verdict {
  alarms: Alarm[];
}
interface Core {
  classifyFillOrdering: (probe: unknown) => Verdict;
  classifyUnresolvedFillIntents: (probe: unknown) => Verdict;
  classifyCumQtyMismatch: (probe: unknown) => Verdict;
  classifyUnconvertibleFillFees: (probe: unknown) => Verdict;
  classifyConfigSnapshotDrift: (probe: unknown) => Verdict;
  computeSweep: (input: { prev: unknown; cur: unknown }) => { alarms: Alarm[] };
  VENUES: [string, string];
}
const core = coreModule as unknown as Core;
const {
  classifyFillOrdering,
  classifyUnresolvedFillIntents,
  classifyCumQtyMismatch,
  classifyUnconvertibleFillFees,
  classifyConfigSnapshotDrift,
  computeSweep,
  VENUES,
} = core;

const kinds = (xs: { kind: string }[]): string[] => xs.map((x) => x.kind);
const ok = (value: unknown): unknown => ({ ok: true, value });

describe('classifyFillOrdering — W1, the load-bearing invariant', () => {
  it('stays silent on a clean read', () => {
    const { alarms } = classifyFillOrdering(ok({ violations: 0, checked: 250 }));
    expect(alarms).toEqual([]);
  });

  it('fires when a fill reads out of venue_timestamp order within its (strategy_id, symbol) group', () => {
    const { alarms } = classifyFillOrdering(ok({ violations: 3, checked: 250 }));
    expect(kinds(alarms)).toEqual(['fill_ordering_violation']);
    expect(alarms[0]?.detail).toContain('3 of 250');
    expect(alarms[0]?.detail).toContain('walkRoundTrips');
  });

  it('fails CLOSED on every unreadable shape', () => {
    const bad: unknown[] = [
      undefined,
      null,
      { ok: false, error: 'psql exited 1' },
      ok({ violations: -1, checked: 250 }),
      ok({ violations: 260, checked: 250 }),
      ok({ violations: Number.NaN, checked: 250 }),
      ok({ violations: 3, checked: '250' }),
    ];
    for (const probe of bad) {
      const { alarms } = classifyFillOrdering(probe);
      expect(kinds(alarms), JSON.stringify(probe)).toEqual(['fill_ordering_unreadable']);
    }
  });

  it('never throws', () => {
    const hostile = {
      ok: true,
      get value(): never {
        throw new Error('boom');
      },
    };
    let out: Verdict | null = null;
    expect(() => {
      out = classifyFillOrdering(hostile);
    }).not.toThrow();
    expect(kinds(out!.alarms)).toEqual(['fill_ordering_unreadable']);
  });
});

describe('classifyUnresolvedFillIntents — I1', () => {
  it('stays silent when every fill resolves to an intent', () => {
    expect(classifyUnresolvedFillIntents(ok({ count: 0 })).alarms).toEqual([]);
  });

  it('fires on any NULL intent_id, naming the UNRESOLVED_FILL consequence', () => {
    const { alarms } = classifyUnresolvedFillIntents(ok({ count: 5 }));
    expect(kinds(alarms)).toEqual(['unresolved_fill_intent']);
    expect(alarms[0]?.detail).toContain('5 fills');
    expect(alarms[0]?.detail).toContain('UNRESOLVED_FILL');
  });

  it('fails CLOSED on every unreadable shape', () => {
    const bad: unknown[] = [
      undefined,
      { ok: false, error: 'psql exited 1' },
      ok({ count: -1 }),
      ok({ count: 'five' }),
      ok({}),
    ];
    for (const probe of bad) {
      expect(kinds(classifyUnresolvedFillIntents(probe).alarms)).toEqual([
        'unresolved_fill_intent_unreadable',
      ]);
    }
  });
});

describe('classifyCumQtyMismatch — I2, a money-equality check (WATCH-V4-4)', () => {
  it('stays silent when every terminal order’s cum_qty matches its fills exactly', () => {
    expect(classifyCumQtyMismatch(ok({ mismatches: 0, checked: 439 })).alarms).toEqual([]);
  });

  it('fires on a mismatch, citing WATCH-V4-4', () => {
    const { alarms } = classifyCumQtyMismatch(ok({ mismatches: 2, checked: 439 }));
    expect(kinds(alarms)).toEqual(['cum_qty_mismatch']);
    expect(alarms[0]?.detail).toContain('2 of 439');
    expect(alarms[0]?.detail).toContain('WATCH-V4-4');
  });

  it('fails CLOSED on every unreadable shape', () => {
    const bad: unknown[] = [
      null,
      { ok: false, error: 'psql exited 1' },
      ok({ mismatches: 5, checked: 3 }),
      ok({ mismatches: Number.NaN, checked: 3 }),
    ];
    for (const probe of bad) {
      expect(kinds(classifyCumQtyMismatch(probe).alarms)).toEqual(['cum_qty_mismatch_unreadable']);
    }
  });
});

describe('classifyUnconvertibleFillFees — I4', () => {
  it('stays silent when every fill’s fee is priceable', () => {
    expect(classifyUnconvertibleFillFees(ok({ violations: 0, checked: 300 })).alarms).toEqual([]);
  });

  it('fires on a null fee or an asset that is neither the base nor the quote', () => {
    const { alarms } = classifyUnconvertibleFillFees(ok({ violations: 7, checked: 300 }));
    expect(kinds(alarms)).toEqual(['unconvertible_fill_fee']);
    expect(alarms[0]?.detail).toContain('7 of 300');
  });

  it('fails CLOSED on every unreadable shape', () => {
    const bad: unknown[] = [
      undefined,
      { ok: false, error: 'psql exited 1' },
      ok({ violations: 10, checked: 3 }),
    ];
    for (const probe of bad) {
      expect(kinds(classifyUnconvertibleFillFees(probe).alarms)).toEqual([
        'unconvertible_fill_fee_unreadable',
      ]);
    }
  });
});

describe('classifyConfigSnapshotDrift — W3', () => {
  function snapshot(over: Record<string, unknown> = {}): unknown {
    return ok({
      total: 1,
      rawConfig: JSON.stringify({
        PROMOTION_DUST_NOTIONAL: '5',
        PROMOTION_EVIDENCE_EPOCH: '2026-07-21T11:21:00Z',
      }),
      runningDustNotional: '5',
      runningEvidenceEpoch: '2026-07-21T11:21:00Z',
      ...over,
    });
  }

  it('alarms when config_snapshots has never been written — the verified live state today', () => {
    const { alarms } = classifyConfigSnapshotDrift(ok({ total: 0, rawConfig: '' }));
    expect(kinds(alarms)).toEqual(['config_snapshot_missing']);
    expect(alarms[0]?.detail).toContain('ConfigSnapshotRepository');
    expect(alarms[0]?.detail).toContain('never');
  });

  it('stays silent when the running config matches the newest snapshot exactly', () => {
    expect(classifyConfigSnapshotDrift(snapshot()).alarms).toEqual([]);
  });

  it('treats differently-formatted but numerically-equal dust notionals as a match (money rule)', () => {
    const { alarms } = classifyConfigSnapshotDrift(
      snapshot({
        rawConfig: JSON.stringify({
          PROMOTION_DUST_NOTIONAL: '5.0',
          PROMOTION_EVIDENCE_EPOCH: '2026-07-21T11:21:00Z',
        }),
      }),
    );
    expect(alarms).toEqual([]);
  });

  it('fires on a dust-notional drift', () => {
    const { alarms } = classifyConfigSnapshotDrift(snapshot({ runningDustNotional: '7' }));
    expect(kinds(alarms)).toEqual(['config_snapshot_drift']);
    expect(alarms[0]?.detail).toContain('PROMOTION_DUST_NOTIONAL');
  });

  it('fires on an evidence-epoch drift', () => {
    const { alarms } = classifyConfigSnapshotDrift(
      snapshot({ runningEvidenceEpoch: '2026-07-22T00:00:00Z' }),
    );
    expect(kinds(alarms)).toEqual(['config_snapshot_drift']);
    expect(alarms[0]?.detail).toContain('PROMOTION_EVIDENCE_EPOCH');
  });

  it('names an unparseable config column rather than treating it as absent or clean', () => {
    const { alarms } = classifyConfigSnapshotDrift(snapshot({ rawConfig: '{{{ not json' }));
    expect(kinds(alarms)).toEqual(['config_snapshot_unreadable']);
  });

  it('names an unrecognised snapshot shape rather than guessing a key spelling', () => {
    const { alarms } = classifyConfigSnapshotDrift(
      snapshot({ rawConfig: JSON.stringify({ someOtherKey: true }) }),
    );
    expect(kinds(alarms)).toEqual(['config_snapshot_shape_unknown']);
  });

  it('fails CLOSED when the running env could not be resolved', () => {
    const { alarms } = classifyConfigSnapshotDrift(snapshot({ runningDustNotional: null }));
    expect(kinds(alarms)).toEqual(['config_snapshot_unreadable']);
  });

  it('fails CLOSED on every unreadable/absent probe shape', () => {
    const bad: unknown[] = [undefined, null, { ok: false, error: 'psql exited 1' }];
    for (const probe of bad) {
      expect(kinds(classifyConfigSnapshotDrift(probe).alarms)).toEqual([
        'config_snapshot_unreadable',
      ]);
    }
  });

  it('never throws', () => {
    const hostile = {
      ok: true,
      get value(): never {
        throw new Error('boom');
      },
    };
    let out: Verdict | null = null;
    expect(() => {
      out = classifyConfigSnapshotDrift(hostile);
    }).not.toThrow();
    expect(kinds(out!.alarms)).toEqual(['config_snapshot_unreadable']);
  });
});

describe('all five invariants reach computeSweep’s alarm list, indistinguishable from any other alarm', () => {
  function appWith(probes: Record<string, unknown>): Record<string, unknown> {
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
        ...probes,
      },
    };
  }

  it('a fill-ordering violation reaches computeSweep’s alarms', () => {
    const { alarms } = computeSweep({
      prev: null,
      cur: {
        sweptAtMs: 10_000_000,
        app: appWith({ fillOrdering: ok({ violations: 1, checked: 10 }) }),
      },
    });
    expect(kinds(alarms)).toContain('fill_ordering_violation');
  });

  it('is NOT suppressed by an unhealthy container — durable Postgres state stays true either way', () => {
    const app = appWith({ unresolvedFillIntents: ok({ count: 4 }) });
    app.containerHealthy = false;
    const { alarms } = computeSweep({ prev: null, cur: { sweptAtMs: 10_000_000, app } });
    expect(kinds(alarms)).toContain('unresolved_fill_intent');
  });
});

describe('the fail direction is declared in source, for each of the five invariants', () => {
  const source = readFileSync(join(process.cwd(), 'scripts', 'loop-sweep-core.mjs'), 'utf8');

  it('declares all five as ALARMS that fail CLOSED', () => {
    expect(source).toContain('All five are ALARMS and fail CLOSED');
  });

  it('records why I3 and I5 are explicitly NOT alarms, so a later pass cannot "helpfully" promote them', () => {
    expect(source).toContain('EXPLICITLY NOT ALARMS');
    expect(source).toContain('I3 (recomputing the round-trip walk');
    expect(source).toContain('I5 (equity reconciliation) carries a BUILT-IN frame residual');
  });

  it('W1 cites fills’ missing append-only trigger as the concrete corruption mode', () => {
    expect(source).toContain('0001_v3_append_only_hardening.sql hardens exactly five tables');
    expect(source).toContain('fills is created UNTRIGGERED');
  });

  it('W3 records that config_snapshots is verified but has never been written, not guessed', () => {
    expect(source).toContain('ZERO call sites');
    expect(source).toContain('The table is therefore ALWAYS EMPTY');
  });
});
