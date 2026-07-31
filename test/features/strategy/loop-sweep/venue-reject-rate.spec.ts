import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
// @ts-expect-error scripts/** live outside the tsconfig graph (see tsconfig.eslint.json's include
// list) — the pure sweep core is a stdlib-only .mjs with no declaration file. Same bridge
// alarms.spec.ts and pass-record-audit.spec.ts use.
import * as coreModule from '../../../../scripts/loop-sweep-core.mjs';

// PER-VENUE ORDER-REJECT RATE (backlog 55). What this spec pins is not "a percentage is computed" —
// it is the FAIL DIRECTION and the separation between the two measured populations.
//
// The defect it exists for: binance spot ran 156 submits / 122 InsufficientFunds rejects over 7 days
// (78.2%) against binanceusdm's 127/3 (2.4%), for a WEEK, with no alarm anywhere. Every liveness
// counter in the sweep passed the entire time and was right to — the lane WAS deciding, the journal
// WAS moving, reconciliation WAS clean. Orders were being manufactured and thrown away and nothing
// asked whether the venue took them.
//
// This check fails CLOSED, which is the opposite of almost everything else in this file's neighbours:
// an unread acceptance rate is not an acceptable one. The tests below deliberately assert that every
// way the probe can fail to answer produces an ALARM, and that the ONE non-alarming degraded path
// (a determinate reading of thin volume) is annotated by name with its raw counts rather than being
// silently absent — the absence-reads-as-health trap this repo keeps rediscovering.

interface Alarm {
  kind: string;
  venue?: string;
  detail: string;
}
interface Annotation {
  kind: string;
  venue?: string;
  probe?: string;
  detail: string;
}
interface Verdict {
  alarms: Alarm[];
  annotations: Annotation[];
}
interface SweepResult {
  deltas: Record<string, unknown> | null;
  alarms: Alarm[];
  annotations: Annotation[];
}
interface Core {
  classifyVenueRejectRates: (probe: unknown) => Verdict;
  computeSweep: (input: { prev: unknown; cur: unknown }) => SweepResult;
  VENUES: [string, string];
  VENUE_REJECT_RATE_ALARM_THRESHOLD: number;
  VENUE_REJECT_MIN_SUBMITS: number;
  VENUE_REJECT_WINDOW_SUBMITS: number;
  VENUE_REJECT_WINDOW_MAX_AGE_MS: number;
}
const core = coreModule as unknown as Core;
const {
  classifyVenueRejectRates,
  computeSweep,
  VENUES,
  VENUE_REJECT_RATE_ALARM_THRESHOLD,
  VENUE_REJECT_MIN_SUBMITS,
  VENUE_REJECT_WINDOW_SUBMITS,
} = core;
const [SPOT, PERP] = VENUES;

// `unknown` values, not a {submits,rejects} pair: several tests deliberately feed shapes the probe
// should never produce (strings, negatives, missing keys) to pin the fail-closed direction.
function probe(byVenue: Record<string, unknown>): unknown {
  return { ok: true, value: { byVenue, errors: [] } };
}

const kinds = (xs: { kind: string }[]): string[] => xs.map((x) => x.kind);

describe('classifyVenueRejectRates — the alarm that would have caught the week-long spot defect', () => {
  it('fires on the pathological venue and stays silent on the healthy one, in the same reading', () => {
    // The live numbers, measured 2026-07-31 over the most recent 20 submits per venue.
    const { alarms, annotations } = classifyVenueRejectRates(
      probe({ [SPOT]: { submits: 20, rejects: 16 }, [PERP]: { submits: 20, rejects: 0 } }),
    );
    expect(alarms).toHaveLength(1);
    expect(alarms[0]?.kind).toBe('venue_reject_rate_high');
    expect(alarms[0]?.venue).toBe(SPOT);
    expect(alarms[0]?.detail).toContain('16/20');
    expect(alarms[0]?.detail).toContain('80.0%');
    // The healthy venue contributes nothing at all — not an alarm, not a hedge, not a note.
    expect(annotations).toEqual([]);
  });

  it('would have fired on DAY ONE of the real defect, which is the whole claim being made for it', () => {
    // 2026-07-23, the first day the defect was live: 9 rejects / 21 submits = 42.9%.
    const { alarms } = classifyVenueRejectRates(
      probe({ [SPOT]: { submits: 21, rejects: 9 }, [PERP]: { submits: 20, rejects: 0 } }),
    );
    expect(kinds(alarms)).toEqual(['venue_reject_rate_high']);
    expect(alarms[0]?.detail).toContain('42.9%');
  });

  it('does not fire on the healthy baseline the threshold was derived from', () => {
    // binanceusdm lifetime, 2026-07-31: 4 rejects / 186 submits = 2.15%.
    const { alarms } = classifyVenueRejectRates(
      probe({ [SPOT]: { submits: 186, rejects: 4 }, [PERP]: { submits: 186, rejects: 4 } }),
    );
    expect(alarms).toEqual([]);
  });

  it('does not fire at the Wilson 99.9% upper bound of the healthy baseline (8.45%)', () => {
    // The threshold is deliberately set ABOVE the highest rate the healthy venue's own data can
    // support, so a venue sitting at that ceiling must stay quiet. If this ever starts failing, the
    // threshold is making a claim its evidence no longer supports.
    const { alarms } = classifyVenueRejectRates(
      probe({ [SPOT]: { submits: 200, rejects: 17 }, [PERP]: { submits: 20, rejects: 0 } }),
    );
    expect(alarms).toEqual([]);
  });

  it('fires exactly AT the threshold and not one reject below it', () => {
    const at = classifyVenueRejectRates(
      probe({ [SPOT]: { submits: 20, rejects: 4 }, [PERP]: { submits: 20, rejects: 0 } }),
    );
    expect(kinds(at.alarms)).toEqual(['venue_reject_rate_high']);
    const below = classifyVenueRejectRates(
      probe({ [SPOT]: { submits: 20, rejects: 3 }, [PERP]: { submits: 20, rejects: 0 } }),
    );
    expect(below.alarms).toEqual([]);
    expect(4 / 20).toBe(VENUE_REJECT_RATE_ALARM_THRESHOLD);
  });

  it('alarms on BOTH venues when both are pathological — no venue masks its sibling', () => {
    const { alarms } = classifyVenueRejectRates(
      probe({ [SPOT]: { submits: 20, rejects: 16 }, [PERP]: { submits: 20, rejects: 12 } }),
    );
    expect(alarms.map((a) => a.venue)).toEqual([SPOT, PERP]);
  });
});

describe('classifyVenueRejectRates — thin volume is UNDETERMINED, never clean', () => {
  it('annotates below the denominator floor instead of alarming, and states the raw counts', () => {
    // 5 submits, ALL rejected. Not an alarm: 5 is below the floor, and at that denominator a single
    // unlucky reject is already 20%, so the sample cannot separate the two populations. But it is a
    // successful read of a small sample, so it must be VISIBLE.
    const { alarms, annotations } = classifyVenueRejectRates(
      probe({ [SPOT]: { submits: 5, rejects: 5 }, [PERP]: { submits: 20, rejects: 0 } }),
    );
    expect(alarms).toEqual([]);
    expect(kinds(annotations)).toEqual(['venue_reject_rate_undetermined']);
    expect(annotations[0]?.venue).toBe(SPOT);
    // The raw counts are in the text — a reader must be able to see 5/5 and judge for themselves.
    expect(annotations[0]?.detail).toContain('5/5');
    expect(annotations[0]?.detail).toContain('UNDETERMINED');
    // And it must never read as acceptable.
    expect(annotations[0]?.detail).not.toMatch(/\bclean\b/i);
  });

  it('a venue that submitted nothing at all is undetermined, not perfect', () => {
    const { alarms, annotations } = classifyVenueRejectRates(
      probe({ [SPOT]: { submits: 0, rejects: 0 }, [PERP]: { submits: 20, rejects: 0 } }),
    );
    expect(alarms).toEqual([]);
    expect(kinds(annotations)).toEqual(['venue_reject_rate_undetermined']);
  });

  it('judges normally at the floor itself', () => {
    // 2 of 6 = 33%, the smallest window in which a verdict is allowed at all.
    const { alarms } = classifyVenueRejectRates(
      probe({
        [SPOT]: { submits: VENUE_REJECT_MIN_SUBMITS, rejects: 2 },
        [PERP]: { submits: 20, rejects: 0 },
      }),
    );
    expect(kinds(alarms)).toEqual(['venue_reject_rate_high']);
    // One reject at the floor is below the threshold — the property the floor was chosen for.
    const one = classifyVenueRejectRates(
      probe({
        [SPOT]: { submits: VENUE_REJECT_MIN_SUBMITS, rejects: 1 },
        [PERP]: { submits: 20, rejects: 0 },
      }),
    );
    expect(one.alarms).toEqual([]);
  });
});

describe('classifyVenueRejectRates — FAILS CLOSED (a health probe, not a measurement)', () => {
  it('alarms when the probe failed outright', () => {
    const { alarms } = classifyVenueRejectRates({ ok: false, error: 'psql exited 1' });
    expect(kinds(alarms)).toEqual(['venue_reject_rate_unreadable']);
    expect(alarms[0]?.detail).toContain('psql exited 1');
    expect(alarms[0]?.detail).toContain('CLOSED');
  });

  it('alarms when the probe is absent entirely', () => {
    // The state a fixture (or a future edit that drops the probe from gather()) produces. An absent
    // acceptance rate is an unknown one.
    for (const absent of [undefined, null]) {
      const { alarms } = classifyVenueRejectRates(absent);
      expect(kinds(alarms)).toEqual(['venue_reject_rate_unreadable']);
    }
  });

  it('alarms when the payload carries no per-venue map', () => {
    const { alarms } = classifyVenueRejectRates({ ok: true, value: { byVenue: null } });
    expect(kinds(alarms)).toEqual(['venue_reject_rate_unreadable']);
  });

  it('alarms per-venue for a missing venue while still judging the sibling that answered', () => {
    const { alarms } = classifyVenueRejectRates(probe({ [PERP]: { submits: 20, rejects: 16 } }));
    expect(alarms).toHaveLength(2);
    expect(alarms[0]?.kind).toBe('venue_reject_rate_unreadable');
    expect(alarms[0]?.venue).toBe(SPOT);
    // The partial read is not discarded — the venue that DID answer is still judged on its evidence.
    expect(alarms[1]?.kind).toBe('venue_reject_rate_high');
    expect(alarms[1]?.venue).toBe(PERP);
  });

  it('alarms on every incoherent count pair rather than coercing it to a rate', () => {
    const incoherent: Record<string, unknown>[] = [
      { submits: 10, rejects: 12 }, // more rejects than submits
      { submits: -1, rejects: 0 },
      { submits: 10, rejects: -3 },
      { submits: Number.NaN, rejects: 0 },
      { submits: 10, rejects: Number.NaN },
      { submits: '20', rejects: '16' }, // strings: psql output that was never coerced
      {},
    ];
    for (const row of incoherent) {
      const { alarms } = classifyVenueRejectRates(
        probe({ [SPOT]: row, [PERP]: { submits: 20, rejects: 0 } }),
      );
      expect(kinds(alarms), JSON.stringify(row)).toEqual(['venue_reject_rate_unreadable']);
      expect(alarms[0]?.venue).toBe(SPOT);
    }
  });

  it('never throws, and turns its own failure into the fail-closed alarm', () => {
    // Labelled rather than JSON.stringify'd: the last case throws ON PROPERTY ACCESS, so serialising
    // it for an assertion message would detonate inside the test harness instead of inside the
    // classifier — which is precisely the hazard the case exists to prove the classifier survives.
    const hostile: [string, unknown][] = [
      ['a bare number', 42],
      ['a string', 'nonsense'],
      ['an array', []],
      ['ok:true with a scalar value', { ok: true, value: 7 }],
      [
        'a payload whose byVenue getter throws',
        {
          ok: true,
          value: {
            get byVenue(): never {
              throw new Error('exploding getter');
            },
          },
        },
      ],
    ];
    for (const [label, input] of hostile) {
      let out: Verdict | null = null;
      expect(() => {
        out = classifyVenueRejectRates(input);
      }, label).not.toThrow();
      // A classifier that cannot run is not a classifier that passed.
      expect(out!.alarms.length, label).toBeGreaterThan(0);
      expect(kinds(out!.alarms), label).toContain('venue_reject_rate_unreadable');
    }
  });
});

describe('venue reject rate — wired into the same alarm list as every other check', () => {
  function appWith(byVenue: Record<string, unknown>): Record<string, unknown> {
    const reconcile: Record<string, unknown> = {};
    for (const venue of VENUES) reconcile[venue] = { ok: true, value: { count: 200 } };
    return {
      bootId: 'boot-A',
      containerHealthy: true,
      restartCount: 0,
      startedAt: new Date(1_000_000).toISOString(),
      probes: {
        decides: { ok: true, value: { count: 100, latestCreatedAtMs: 1_000_000 } },
        reconcile,
        killSwitch: { ok: true, value: { state: 'RUNNING' } },
        orderRejects: probe(byVenue),
      },
    };
  }

  it('reaches computeSweep’s alarms, indistinguishable in handling from zero_decides', () => {
    const { alarms } = computeSweep({
      prev: null,
      cur: {
        sweptAtMs: 10_000_000,
        app: appWith({ [SPOT]: { submits: 20, rejects: 16 }, [PERP]: { submits: 20, rejects: 0 } }),
      },
    });
    const mine = alarms.filter((a) => a.kind === 'venue_reject_rate_high');
    expect(mine).toHaveLength(1);
    expect(mine[0]?.venue).toBe(SPOT);
  });

  it('is NOT suppressed by an unhealthy container — the journal rows stay true either way', () => {
    // Deliberately unlike the delta-starvation alarms, which need a proven-live process to mean
    // anything. This reads a durable append-only journal, and an unhealthy container is if anything
    // more reason to want the reading.
    const app = appWith({
      [SPOT]: { submits: 20, rejects: 16 },
      [PERP]: { submits: 20, rejects: 0 },
    });
    app.containerHealthy = false;
    const { alarms } = computeSweep({ prev: null, cur: { sweptAtMs: 10_000_000, app } });
    expect(kinds(alarms)).toContain('venue_reject_rate_high');
  });
});

describe('the threshold derivation is recorded, not just the number', () => {
  // A falsifiable-claim guard, in the spirit of the repo's verify-before-cite rule: the constant is
  // only defensible while the derivation sits next to it. If someone changes 0.2 to a taste-based
  // round number and deletes the arithmetic, this fails.
  // Resolved off cwd rather than import.meta.url: tsconfig.eslint.json's `module` setting forbids
  // the meta-property, and vitest always runs from the repo root.
  const source = readFileSync(join(process.cwd(), 'scripts', 'loop-sweep-core.mjs'), 'utf8');

  it('states the measured healthy baseline, the pathology, and the statistical ceiling', () => {
    expect(source).toContain('4 rejects / 186 submits lifetime = 2.15%');
    expect(source).toContain('122 / 156 over 7 days             = 78.2%');
    expect(source).toContain('Wilson one-sided 99.9% upper bound on 4/186 is 8.45%');
  });

  it('states why the denominator floor is where it is', () => {
    expect(source).toContain('ceil(0.2 * 6) = 2');
    expect(source).toContain('10.3% of the time');
  });

  it('states the window choice and its two measured reasons', () => {
    expect(source).toContain('5 spot submits in 12h');
    expect(source).toContain(
      `export const VENUE_REJECT_WINDOW_SUBMITS = ${VENUE_REJECT_WINDOW_SUBMITS}`,
    );
  });

  it('declares its fail direction explicitly, and contrasts it with the fail-open measurement', () => {
    expect(source).toContain('HEALTH ALARM, FAILS CLOSED');
    expect(source).toContain('measurement/veto-only gates fail OPEN, safety gates fail CLOSED');
  });
});
