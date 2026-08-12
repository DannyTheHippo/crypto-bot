import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
// @ts-expect-error scripts/** live outside the tsconfig graph (see tsconfig.eslint.json's include
// list) — the pure sweep core is a stdlib-only .mjs with no declaration file. Same bridge
// venue-reject-rate.spec.ts uses.
import * as coreModule from '../../../../scripts/loop-sweep-core.mjs';

// DELIVERABLE B — five DB integrity invariants (W1, I1, I2, I4, W3). All five are ALARMS and fail
// CLOSED — each guards a named corruption mode where an unreadable answer is itself the finding,
// matching classifyVenueRejectRates' own fail-CLOSED argument (the opposite direction from
// Deliverable A's measurement/veto-only tuple, which fails OPEN). Exactly one branch is not CLOSED:
// W1's incomparable-id-space annotation, for pairs that are unaskable rather than unanswered. These
// cases pin: each check firing on a genuine violation, staying silent on a clean read, and — the
// property every one of these shares with venue-reject-rate — treating an unreadable probe as an
// ALARM rather than a quiet pass.

interface Alarm {
  kind: string;
  detail: string;
}
interface Verdict {
  alarms: Alarm[];
  annotations?: Alarm[];
}
interface Core {
  classifyFillOrdering: (probe: unknown) => { alarms: Alarm[]; annotations: Alarm[] };
  classifyFillIngestLag: (probe: unknown) => { annotations: Alarm[] };
  classifyUnresolvedFillIntents: (probe: unknown) => Verdict;
  classifyCumQtyMismatch: (probe: unknown) => Verdict;
  classifyUnconvertibleFillFees: (probe: unknown) => Verdict;
  classifyConfigSnapshotDrift: (probe: unknown) => Verdict;
  computeSweep: (input: { prev: unknown; cur: unknown }) => {
    alarms: Alarm[];
    annotations: Alarm[];
  };
  VENUES: [string, string];
}
const core = coreModule as unknown as Core;
const {
  classifyFillOrdering,
  classifyFillIngestLag,
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
    const { alarms, annotations } = classifyFillOrdering(
      ok({ violations: 0, compared: 510, incomparable: 0, checked: 528 }),
    );
    expect(alarms).toEqual([]);
    expect(annotations).toEqual([]);
  });

  it('fires when the sequence the walk receives is not venue execution order', () => {
    const { alarms } = classifyFillOrdering(
      ok({ violations: 3, compared: 240, incomparable: 0, checked: 250 }),
    );
    expect(kinds(alarms)).toEqual(['fill_ordering_violation']);
    expect(alarms[0]?.detail).toContain('3 of 240');
    // The keys the CONSUMER orders by — the detail must describe the sequence the walk actually
    // receives, never the ingestion order no consumer reads.
    expect(alarms[0]?.detail).toContain('venue_timestamp, fill_id');
    expect(alarms[0]?.detail).toContain('venue execution order');
  });

  it('fails CLOSED on every unreadable shape', () => {
    const bad: unknown[] = [
      undefined,
      null,
      { ok: false, error: 'psql exited 1' },
      ok({ violations: -1, compared: 240, incomparable: 0, checked: 250 }),
      ok({ violations: 260, compared: 240, incomparable: 0, checked: 250 }),
      ok({ violations: Number.NaN, compared: 240, incomparable: 0, checked: 250 }),
      ok({ violations: 3, compared: 240, incomparable: 0, checked: '250' }),
      // compared + incomparable can never exceed the rows read.
      ok({ violations: 0, compared: 240, incomparable: 20, checked: 250 }),
      ok({ violations: 0, compared: 240, checked: 250 }),
    ];
    for (const probe of bad) {
      const { alarms } = classifyFillOrdering(probe);
      expect(kinds(alarms), JSON.stringify(probe)).toEqual(['fill_ordering_unreadable']);
    }
  });

  // Paper mints 'paper-trade-N' off a counter that restarts at 1 each reboot
  // (trading.schema.ts:129-136), so those pairs are unorderable in principle. Alarming on them would
  // raise a blocking §3 defect no pass could ever answer.
  it('DISCLOSES incomparable id spaces as an annotation and raises no alarm', () => {
    const { alarms, annotations } = classifyFillOrdering(
      ok({ violations: 0, compared: 200, incomparable: 40, checked: 250 }),
    );
    expect(alarms).toEqual([]);
    expect(kinds(annotations)).toEqual(['fill_ordering_incomparable']);
    expect(annotations[0]?.detail).toContain('40 of 250');
    expect(annotations[0]?.detail).toContain('paper-trade-N');
  });

  // Weakened coverage annotates; ZERO coverage is a different finding. Without this the alarm list
  // reads clean while W1 proves nothing at all, and §3 gates on alarms only.
  it('ALARMS when NO pair was comparable — a disabled control is not a quiet one', () => {
    const { alarms, annotations } = classifyFillOrdering(
      ok({ violations: 0, compared: 0, incomparable: 12, checked: 13 }),
    );
    expect(kinds(alarms)).toEqual(['fill_ordering_void']);
    expect(alarms[0]?.detail).toContain('proved nothing');
    expect(annotations).toEqual([]);
  });

  it('does NOT read a young journal of singleton groups as a disabled control', () => {
    const { alarms, annotations } = classifyFillOrdering(
      ok({ violations: 0, compared: 0, incomparable: 0, checked: 5 }),
    );
    expect(alarms).toEqual([]);
    expect(annotations).toEqual([]);
  });

  it('still ALARMS on a violation found alongside incomparable pairs — a weakened control does not discard a positive finding', () => {
    const { alarms, annotations } = classifyFillOrdering(
      ok({ violations: 2, compared: 200, incomparable: 40, checked: 250 }),
    );
    expect(kinds(alarms)).toEqual(['fill_ordering_violation']);
    expect(kinds(annotations)).toEqual(['fill_ordering_incomparable']);
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

// The ingest-lag disclosure: a DIFFERENT question from W1, and deliberately not a gate. A late
// arrival cannot mis-order the walk (fillsForMode sorts by venue_timestamp, fill_id) — it only makes
// an already-published round-trip output non-reproducible from the earlier row set.
describe('classifyFillIngestLag — retroactive arrivals, annotation only', () => {
  const LOOKBACK_MS = 12 * 60 * 60 * 1000;

  it('says nothing when every fill in the window arrived in venue_timestamp order', () => {
    const { annotations } = classifyFillIngestLag(
      ok({ retroactive: 0, checked: 13, windowMs: LOOKBACK_MS }),
    );
    expect(annotations).toEqual([]);
  });

  it('annotates a retroactive arrival and explicitly disclaims any walk-corruption claim', () => {
    const { annotations } = classifyFillIngestLag(
      ok({ retroactive: 1, checked: 13, windowMs: LOOKBACK_MS }),
    );
    expect(kinds(annotations)).toEqual(['fill_ingest_lag']);
    expect(annotations[0]?.detail).toContain('1 of 13');
    expect(annotations[0]?.detail).toContain('12h');
    expect(annotations[0]?.detail).toContain('NOT a walk-corruption claim');
    expect(annotations[0]?.detail).toContain('venue_timestamp, fill_id');
  });

  it('fails OPEN on every shape it owns — a named probe failure, never an alarm and never a silent pass', () => {
    const bad: unknown[] = [
      undefined,
      null,
      // ok:true shapes the generic probe-failure loop cannot see, so this classifier must own them.
      ok(undefined),
      ok({ retroactive: -1, checked: 13 }),
      ok({ retroactive: 20, checked: 13 }),
      ok({ retroactive: Number.NaN, checked: 13 }),
    ];
    for (const probe of bad) {
      const verdict = classifyFillIngestLag(probe) as unknown as Verdict;
      expect(kinds(verdict.annotations!), JSON.stringify(probe)).toEqual(['probe_failed']);
      expect(verdict.alarms).toBeUndefined();
    }
  });

  // A probe that RAN and failed is already named once by computeApp's generic probe_failed loop —
  // a second identical annotation is duplication, not disclosure. computeSweep pins the single copy.
  it('stays silent on a failed read, which the generic probe-failure loop already names', () => {
    const { annotations } = classifyFillIngestLag({ ok: false, error: 'psql exited 1' });
    expect(annotations).toEqual([]);
  });

  it('never throws', () => {
    const hostile = {
      ok: true,
      get value(): never {
        throw new Error('boom');
      },
    };
    let out: { annotations: Alarm[] } | null = null;
    expect(() => {
      out = classifyFillIngestLag(hostile);
    }).not.toThrow();
    expect(kinds(out!.annotations)).toEqual(['probe_failed']);
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

  it('alarms when config_snapshots has never been written', () => {
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

  // The writer being wired alongside this deliverable stores the FULL canonical AppConfig, NESTED
  // (agentic.promotionDustNotional / agentic.promotionEvidenceEpoch — see app-config.ts:128, :189),
  // not the flat two-knob shape above. These pin the reader against that real shape.
  describe('the nested AppConfig shape the writer actually produces', () => {
    function nestedSnapshot(over: Record<string, unknown> = {}): unknown {
      return ok({
        total: 1,
        rawConfig: JSON.stringify({
          agentic: {
            promotionDustNotional: '5',
            promotionEvidenceEpoch: '2026-07-21T11:21:00Z',
          },
        }),
        runningDustNotional: '5',
        runningEvidenceEpoch: '2026-07-21T11:21:00Z',
        ...over,
      });
    }

    it('resolves both knobs from a nested payload and stays silent on a clean match', () => {
      expect(classifyConfigSnapshotDrift(nestedSnapshot()).alarms).toEqual([]);
    });

    it('fires config_snapshot_drift on a nested dust-notional drift', () => {
      const { alarms } = classifyConfigSnapshotDrift(nestedSnapshot({ runningDustNotional: '7' }));
      expect(kinds(alarms)).toEqual(['config_snapshot_drift']);
      expect(alarms[0]?.detail).toContain('PROMOTION_DUST_NOTIONAL');
    });

    it('fires config_snapshot_drift on a nested evidence-epoch drift', () => {
      const { alarms } = classifyConfigSnapshotDrift(
        nestedSnapshot({ runningEvidenceEpoch: '2026-07-22T00:00:00Z' }),
      );
      expect(kinds(alarms)).toEqual(['config_snapshot_drift']);
      expect(alarms[0]?.detail).toContain('PROMOTION_EVIDENCE_EPOCH');
    });

    it('still yields config_snapshot_shape_unknown when NEITHER the flat nor the nested spelling is present', () => {
      const { alarms } = classifyConfigSnapshotDrift(
        snapshot({ rawConfig: JSON.stringify({ agentic: { someOtherKnob: true } }) }),
      );
      expect(kinds(alarms)).toEqual(['config_snapshot_shape_unknown']);
    });
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
        // Clean ingest-lag read: the disclosure is unconditional, so an absent probe would add a
        // probe_failed annotation to every case below.
        fillIngestLag: ok({ retroactive: 0, checked: 10, windowMs: 12 * 60 * 60 * 1000 }),
        ...probes,
      },
    };
  }

  it('a fill-ordering violation reaches computeSweep’s alarms', () => {
    const { alarms } = computeSweep({
      prev: null,
      cur: {
        sweptAtMs: 10_000_000,
        app: appWith({
          fillOrdering: ok({ violations: 1, compared: 8, incomparable: 0, checked: 10 }),
        }),
      },
    });
    expect(kinds(alarms)).toContain('fill_ordering_violation');
  });

  it('an incomparable id space reaches computeSweep’s ANNOTATIONS and never its alarms', () => {
    const { alarms, annotations } = computeSweep({
      prev: null,
      cur: {
        sweptAtMs: 10_000_000,
        app: appWith({
          fillOrdering: ok({ violations: 0, compared: 6, incomparable: 2, checked: 10 }),
        }),
      },
    });
    expect(kinds(annotations)).toContain('fill_ordering_incomparable');
    expect(kinds(alarms)).not.toContain('fill_ordering_incomparable');
    expect(kinds(alarms)).not.toContain('fill_ordering_violation');
  });

  it('an ABSENT ingest-lag probe annotates rather than vanishing from the digest', () => {
    const app = appWith({
      fillOrdering: ok({ violations: 0, compared: 8, incomparable: 0, checked: 10 }),
    });
    delete (app.probes as Record<string, unknown>).fillIngestLag;
    const { alarms, annotations } = computeSweep({
      prev: null,
      cur: { sweptAtMs: 10_000_000, app },
    });
    expect(annotations.some((a) => a.detail.includes('retroactive fill arrivals'))).toBe(true);
    expect(kinds(alarms)).not.toContain('fill_ordering_violation');
  });

  it('a FAILED ingest-lag read is named exactly once, not twice', () => {
    const { alarms, annotations } = computeSweep({
      prev: null,
      cur: {
        sweptAtMs: 10_000_000,
        app: appWith({
          fillOrdering: ok({ violations: 0, compared: 8, incomparable: 0, checked: 10 }),
          fillIngestLag: { ok: false, error: 'psql exited 1' },
        }),
      },
    });
    const mine = annotations.filter((a) => (a as { probe?: string }).probe === 'fillIngestLag');
    expect(mine).toHaveLength(1);
    expect(mine[0]?.detail).toContain('psql exited 1');
    expect(kinds(alarms)).not.toContain('fill_ingest_lag');
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

  it('declares all five as ALARMS that fail CLOSED, and names the single carve-out', () => {
    expect(source).toContain('All five are ALARMS and fail CLOSED');
    expect(source).toContain('EXACTLY ONE branch across the five is not CLOSED');
  });

  it('records why I3 and I5 are explicitly NOT alarms, so a later pass cannot "helpfully" promote them', () => {
    expect(source).toContain('EXPLICITLY NOT ALARMS');
    expect(source).toContain('I3 (recomputing the round-trip walk');
    expect(source).toContain('I5 (equity reconciliation) carries a BUILT-IN frame residual');
  });

  it('W1 states the ordering it actually checks, and records the venue_trade_id assumption', () => {
    expect(source).toContain('venue_timestamp, fill_id');
    expect(source).toContain('WHY venue_trade_id IS THE PROXY');
    expect(source).toContain('ASSUMPTION, recorded so a later venue that breaks it');
  });

  it('W1 names its one non-CLOSED branch and why paper ids are unaskable rather than unanswered', () => {
    expect(source).toContain('THE ONE NON-CLOSED BRANCH');
    expect(source).toContain('paper-trade-N');
    expect(source).toContain('unaskable');
  });

  it('W1 separates a WEAKENED control from a disabled one, and records the partition defect', () => {
    expect(source).toContain('WEAKENED IS NOT DISABLED');
    expect(source).toContain('partitions by (strategy_id, symbol, mode, venue)');
  });

  it('W1 records that the epoch is the only clearing lever and what clearing it costs', () => {
    expect(source).toContain('COUPLING a later pass must not reach for casually');
  });

  it('W3 records the writer/reader fail-open/fail-closed asymmetry, not guessed', () => {
    expect(source).toContain('writeConfigSnapshot');
    expect(source).toContain('declared FAIL OPEN');
    expect(source).toContain('deliberately asymmetric with the writer');
  });
});

// Nothing exercised the probe SQL itself, which is how W1 spent nine days asserting an ordering no
// consumer reads: every unit above feeds the classifier a hand-written count pair, so the query
// could sort by any key at all and still pass. This gates the one property that cannot be checked
// from either file alone — the sweep must read fills in the SAME order the producer hands them to
// walkRoundTrips.
describe('the W1 probe reads fills in the producer’s own order', () => {
  const runner = readFileSync(join(process.cwd(), 'scripts', 'loop-sweep.mjs'), 'utf8');
  const repository = readFileSync(
    join(
      process.cwd(),
      'src',
      'database',
      'repositories',
      'trading',
      'promotion-stats.repository.ts',
    ),
    'utf8',
  );

  it('PromotionStatsRepository still orders the walk’s input by venueTimestamp then fillId', () => {
    expect(repository).toContain(
      'orderBy(asc(schema.fills.venueTimestamp), asc(schema.fills.fillId))',
    );
  });

  // The W1 probe body only — the ingest-lag probe beside it reads arrival order deliberately, so a
  // whole-file assertion would be satisfied by the wrong query.
  const w1Probe = runner.slice(
    runner.indexOf('probes.fillOrdering = '),
    runner.indexOf('probes.fillIngestLag = '),
  );

  it('the sweep’s fill-ordering probe partitions by the full id-space and orders by the producer’s two keys', () => {
    expect(w1Probe.length).toBeGreaterThan(0);
    // The full partition, not a prefix of it: dropping mode/venue lets a foreign-mode row between
    // two same-id-space fills turn a real inversion into two merely-`incomparable` pairs.
    expect(w1Probe).toContain('partition by i.strategy_id, f.symbol, f.mode, f.venue');
    expect(w1Probe).toContain('order by f.venue_timestamp, f.fill_id');
  });

  it('the sweep’s fill-ordering probe reads NO other ordering key — ingestion order is not the walk’s input', () => {
    // Without the length guard an anchor rename collapses the slice to '' and this certifies the
    // opposite of what it claims.
    expect(w1Probe.length).toBeGreaterThan(0);
    expect(w1Probe).not.toContain('ingested_at');
  });

  it('the sweep’s fill-ordering probe is bounded by the evidence epoch, and refuses an ambiguous one', () => {
    expect(w1Probe.length).toBeGreaterThan(0);
    expect(w1Probe).toContain('venue_timestamp >=');
    // The app's own zod refinement shape (environment.config.ts:526-534) — a bare Date.parse accepts
    // a date-only epoch and silently resolves it to midnight UTC.
    expect(w1Probe).toContain('\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}');
  });
});
