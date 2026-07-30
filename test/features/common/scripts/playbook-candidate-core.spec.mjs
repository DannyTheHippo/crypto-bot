import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ABSTAIN_LAPSE_DECIDES,
  PERP_VENUE_ID,
  classifyCandidateGate,
  classifyContentChange,
  deriveValidationOpts,
  findBlockingCandidate,
  intEnv,
  needsAbstentionEvidence,
  parseArgs,
} from '../../../../scripts/playbook-candidate-core.mjs';
import { validatePlaybook } from '../../../../src/features/strategy/agentic/playbook-validator';
import { PERP_VENUE } from '../../../../src/domain/venue/types/venue-map';

// REGRESSION, 2026-07-30. `agent_playbook_versions.source` read reflection 4 / seed 4 /
// loop-candidate ZERO: the loop→lane authoring channel had never been used once, and two defects in
// scripts/playbook-candidate.mjs are why.
//
//  1. It called validatePlaybook(content) with no opts, i.e. spot-strict, while the runtime read
//     path passes {shortsAllowed: true, leverageAllowed: true} (agentic-bridge.module.ts's
//     PLAYBOOK_PROVIDER_OVERRIDE factory → PlaybookAbRoutingProvider + ValidatingPlaybookProvider).
//     The CLI therefore rejected perp-legal prose the live lane serves — including the phrasing of
//     the deployed v3 seed itself ("the 5x leverage cap").
//  2. Its unresolved-candidate filter carried no age predicate while the runtime's does
//     (reflection.service.ts), so one candidate nobody promotes blocked every mint forever. Live at
//     the time of writing: v9, minted 2026-07-27, unresolved.
//
// Plain .mjs because it imports scripts/*.mjs, which sit outside the tsconfig project (see
// eslint.config.mjs's scripts/** ignore) — same reason as arm-ceremony.spec.mjs.

function playbook(entryRules) {
  return [
    '## regime notes',
    'Perp is two-sided: a breakdown is as tradable as a breakout on the same 15m structure read.',
    '',
    '## entry rules',
    entryRules,
    '',
    '## exit rules',
    'Trail the stop as new structure forms in your favor; funding accrues every 8 hours while held.',
    '',
    '## mistakes to avoid',
    'Do not size a thin setup like a conviction one; the cap exists to be earned, not defaulted to.',
  ].join('\n');
}

// One fixture per capability-tagged pattern family. The leverage one is the deployed v3 seed's own
// phrasing ("the 5x leverage cap"), i.e. the ACTIVE playbook the runtime serves would have been
// rejected by this CLI.
const PERP_LEGAL_PLAYBOOK = playbook(
  'Take a confirmed structure break with a failed retest; the 5x leverage cap is reserved for setups where structure, funding and open interest all agree.',
);
const SHORTS_ONLY_PLAYBOOK = playbook(
  'Sell short a confirmed structure break with a failed retest, sized smaller than a trend-follow entry.',
);

const HOUR_MS = 3_600_000;
const NOW_MS = Date.parse('2026-07-30T12:00:00Z');

function candidate(overrides = {}) {
  return {
    version: 9,
    source: 'reflection',
    created_at: new Date(NOW_MS - 72 * HOUR_MS),
    ...overrides,
  };
}

describe('playbook-candidate capability opts mirror the runtime read path', () => {
  it('pins the perp venue id against the domain constant it duplicates', () => {
    expect(PERP_VENUE_ID).toBe(PERP_VENUE);
  });

  it.each([
    ['leverage', PERP_LEGAL_PLAYBOOK],
    ['sell short', SHORTS_ONLY_PLAYBOOK],
  ])(
    'rejects perp-legal prose on the "%s" family under the old no-opts (spot-strict) call — the defect',
    (bannedToken, playbook) => {
      expect(validatePlaybook(playbook)).toMatchObject({ ok: false, bannedToken });
    },
  );

  it('accepts the same prose with the opts derived from a perp-capable VENUES', () => {
    const { opts, derivedFrom } = deriveValidationOpts(
      '[{"id":"binance","environment":"demo"},{"id":"binanceusdm","environment":"demo"}]',
    );
    expect(opts).toEqual({ shortsAllowed: true, leverageAllowed: true });
    expect(derivedFrom).toContain(PERP_VENUE_ID);
    expect(validatePlaybook(PERP_LEGAL_PLAYBOOK, opts)).toEqual({ ok: true });
    expect(validatePlaybook(SHORTS_ONLY_PLAYBOOK, opts)).toEqual({ ok: true });
  });

  it('stays spot-strict when VENUES declares only spot venues', () => {
    const { opts } = deriveValidationOpts('[{"id":"binance","environment":"demo"}]');
    expect(opts).toEqual({ shortsAllowed: false, leverageAllowed: false });
    expect(validatePlaybook(PERP_LEGAL_PLAYBOOK, opts).ok).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['not JSON', 'binance,binanceusdm'],
    ['not an array', '{"id":"binance"}'],
    ['an empty array', '[]'],
  ])('fails OPEN to the runtime pair when VENUES is %s', (_label, raw) => {
    // Stricter-than-runtime is the failure this whole file exists to stop; the read path
    // re-validates the same bytes, so an unreadable VENUES must not reintroduce it.
    expect(deriveValidationOpts(raw).opts).toEqual({ shortsAllowed: true, leverageAllowed: true });
  });
});

describe('playbook-candidate unresolved-candidate gate', () => {
  const rows = [
    { version: 8, source: 'seed' },
    { version: 9, source: 'reflection' },
    { version: 3, source: 'reflection' },
  ];

  it('finds the newest routable candidate above active and ignores rows at or below it', () => {
    expect(findBlockingCandidate(rows, 8)?.version).toBe(9);
    expect(findBlockingCandidate(rows, 9)).toBeUndefined();
    expect(findBlockingCandidate([{ version: 10, source: 'promotion' }], 8)).toBeUndefined();
  });

  it('mints freely when nothing blocks', () => {
    expect(
      classifyCandidateGate({ blocking: undefined, nowMs: NOW_MS, lapseMs: 336 * HOUR_MS }).proceed,
    ).toBe(true);
  });

  it('still refuses while the lapse has NOT elapsed', () => {
    const gate = classifyCandidateGate({
      blocking: candidate(),
      nowMs: NOW_MS,
      lapseMs: 336 * HOUR_MS,
    });
    expect(gate.proceed).toBe(false);
    expect(gate.reason).toContain('72h < lapse 336h');
    expect(gate.reason).toContain('--supersede');
  });

  it('mints once the lapse HAS elapsed — the deadlock exit the script lacked', () => {
    const gate = classifyCandidateGate({
      blocking: candidate({ created_at: new Date(NOW_MS - 400 * HOUR_MS) }),
      nowMs: NOW_MS,
      lapseMs: 336 * HOUR_MS,
    });
    expect(gate).toMatchObject({ proceed: true, lapse: 'age' });
  });

  it('lapses early on proven live abstention', () => {
    const gate = classifyCandidateGate({
      blocking: candidate(),
      nowMs: NOW_MS,
      lapseMs: 336 * HOUR_MS,
      stats: { decides: DEFAULT_ABSTAIN_LAPSE_DECIDES, entries: 0 },
    });
    expect(gate).toMatchObject({ proceed: true, lapse: 'abstention' });
  });

  it.each([
    ['the candidate has traded', { decides: 61, entries: 6 }],
    ['the evidence is too thin', { decides: 3, entries: 0 }],
    ['the evidence read failed', undefined],
  ])('does NOT lapse on abstention when %s', (_label, stats) => {
    // Fails toward preserving the candidate: an absent or failing measurement must never authorise
    // a destructive orphaning. {decides: 61, entries: 6} is live v9 on 2026-07-30.
    expect(
      classifyCandidateGate({
        blocking: candidate(),
        nowMs: NOW_MS,
        lapseMs: 336 * HOUR_MS,
        stats,
      }).proceed,
    ).toBe(false);
  });

  it('refuses rather than guessing when the blocking row has no readable created_at', () => {
    const gate = classifyCandidateGate({
      blocking: candidate({ created_at: 'not-a-date' }),
      nowMs: NOW_MS,
      lapseMs: 336 * HOUR_MS,
    });
    expect(gate.proceed).toBe(false);
    expect(gate.reason).toContain('created_at');
  });

  it('--supersede overrides the refusal and is reported as a supersession', () => {
    const gate = classifyCandidateGate({
      blocking: candidate(),
      nowMs: NOW_MS,
      lapseMs: 336 * HOUR_MS,
      supersede: true,
    });
    expect(gate).toMatchObject({ proceed: true, lapse: 'supersede' });
    expect(gate.blocking.version).toBe(9);
  });

  it('only pays for the abstention query when its answer can change the outcome', () => {
    const base = { nowMs: NOW_MS, lapseMs: 336 * HOUR_MS };
    expect(needsAbstentionEvidence({ ...base, blocking: candidate() })).toBe(true);
    expect(needsAbstentionEvidence({ ...base, blocking: undefined })).toBe(false);
    expect(needsAbstentionEvidence({ ...base, blocking: candidate(), supersede: true })).toBe(
      false,
    );
    expect(
      needsAbstentionEvidence({ ...base, blocking: candidate(), abstainLapseDecides: 0 }),
    ).toBe(false);
    expect(
      needsAbstentionEvidence({
        ...base,
        blocking: candidate({ created_at: new Date(NOW_MS - 400 * HOUR_MS) }),
      }),
    ).toBe(false);
  });
});

describe('playbook-candidate no-change and argv handling', () => {
  it('flags a byte-identical candidate and passes a changed one', () => {
    expect(classifyContentChange('same', 'same').changed).toBe(false);
    expect(classifyContentChange('same', 'other').changed).toBe(true);
  });

  it('cannot fire when the active content is unavailable', () => {
    expect(classifyContentChange('candidate', undefined)).toMatchObject({
      changed: true,
      activeSha: null,
    });
  });

  it('parses the candidate file, --metrics and --supersede', () => {
    expect(parseArgs(['cand.md', '--metrics', 'sc.json', '--supersede'])).toEqual({
      candidateFile: 'cand.md',
      metricsFile: 'sc.json',
      supersede: true,
    });
    expect(parseArgs(['cand.md'])).toEqual({
      candidateFile: 'cand.md',
      metricsFile: undefined,
      supersede: false,
    });
  });

  it.each([
    [[], 'missing <candidate-file>'],
    [['cand.md', '--supersed'], 'unknown option'],
    [['cand.md', '--metrics'], '--metrics requires'],
    [['cand.md', '--metrics', '--supersede'], '--metrics requires'],
    [['a.md', 'b.md'], 'unexpected extra argument'],
  ])('rejects %j rather than silently ignoring it', (argv, fragment) => {
    // A mistyped --supersede that became a no-op would report a refusal the operator believes they
    // already overrode.
    expect(parseArgs(argv).error).toContain(fragment);
  });

  it('falls back to the runtime default for a blank or non-numeric lapse env', () => {
    expect(intEnv('336', 720)).toBe(336);
    expect(intEnv('', 720)).toBe(720);
    expect(intEnv(undefined, 720)).toBe(720);
    expect(intEnv('soon', 720)).toBe(720);
  });
});
