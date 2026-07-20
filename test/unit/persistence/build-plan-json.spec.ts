import { describe, it, expect } from 'vitest';
import {
  buildPlanJson,
  readPlanJson,
} from '../../../src/database/repositories/agent-decision-journal.adapter';
import type { AgentDirectives } from '../../../src/ports/agentic-strategy';

// XA4 (A0 activation bundle): before this fix, plan_json was written ONLY when a plan object was
// present — so v2 holds (the overwhelming majority of decisions) dropped their model-chosen
// nextConsultBars and A0 found plan_json empty on every v2 row. buildPlanJson now captures the
// portfolio schedule regardless of whether a directive set is present.
const DIRECTIVES: AgentDirectives = {
  direction: 'long',
  sizeFraction: '0.1',
  entryStyle: 'maker',
  entryOffsetBps: -10,
  entryValidityBars: 4,
  stopLossPct: '0.02',
  takeProfitPct: '0.05',
  maxHoldBars: 96,
  thesis: 'breakout retest holding',
};

describe('buildPlanJson (XA4 durable decision capture)', () => {
  it('a hold that carried a schedule persists {nextConsultBars} on its own (the pre-XA4 gap)', () => {
    expect(buildPlanJson(null, 8)).toEqual({ nextConsultBars: 8 });
  });

  it('a plan merges the schedule into the directive set', () => {
    expect(buildPlanJson(DIRECTIVES, 12)).toEqual({ ...DIRECTIVES, nextConsultBars: 12 });
  });

  it('a plan without a schedule persists the directives verbatim', () => {
    expect(buildPlanJson(DIRECTIVES, null)).toEqual(DIRECTIVES);
  });

  it('a bare hold with neither directives nor a schedule stays null', () => {
    expect(buildPlanJson(null, null)).toBeNull();
  });

  it('nextConsultBars of 0 is not treated as absent (explicit != null, not falsy)', () => {
    // Bounds forbid 0 today, but the merge must key on presence, not truthiness — a future bound
    // change or a legacy row must never silently drop a 0.
    expect(buildPlanJson(null, 0)).toEqual({ nextConsultBars: 0 });
  });
});

describe('readPlanJson (XA4 read-side coercion)', () => {
  it('a schedule-only row reads back as null (never mistaken for a directive plan)', () => {
    expect(readPlanJson({ nextConsultBars: 8 })).toBeNull();
  });

  it('a directive plan passes through verbatim, merged schedule intact (I1b behavior preserved)', () => {
    const stored = buildPlanJson(DIRECTIVES, 12);
    expect(readPlanJson(stored)).toEqual({ ...DIRECTIVES, nextConsultBars: 12 });
  });

  it('null stays null', () => {
    expect(readPlanJson(null)).toBeNull();
  });
});
