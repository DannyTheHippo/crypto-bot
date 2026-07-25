import { describe, it, expect } from 'vitest';
import {
  deriveRegimeTags,
  renderSimilarSetups,
  MAX_SIMILAR_SETUPS,
  MAX_SIMILAR_SETUPS_CHARS,
} from '../../../../src/features/strategy/agentic/episodic-memory';
import type {
  AgentIndicators,
  RegimeTags,
  SimilarSetupRow,
} from '../../../../src/ports/strategy/agentic-strategy';
import type { EpochMs } from '../../../../src/domain/common/types/ids';

// A fully-formed indicator set; each case overrides only the fields it fingerprints on.
function indicators(over: Partial<AgentIndicators> = {}): AgentIndicators {
  return {
    lastClose: 100,
    emaFast: 100,
    emaSlow: 100,
    rsi14: 50,
    atr14: 1,
    ret1: 0,
    ret5: 0,
    ret20: 0,
    ...over,
  };
}

const EU_HOUR = Date.parse('2026-07-20T10:00:00Z'); // UTC hour 10 → eu
const ASIA_HOUR = Date.parse('2026-07-20T03:00:00Z'); // UTC hour 3 → asia
const US_HOUR = Date.parse('2026-07-20T18:00:00Z'); // UTC hour 18 → us

describe('deriveRegimeTags', () => {
  it('uptrend / high-vol / positive-funding / EU session', () => {
    expect(
      deriveRegimeTags({
        indicators: indicators({ emaFast: 101, emaSlow: 100, atr14: 2, lastClose: 100 }),
        fundingRate: 0.0001,
        eventTime: EU_HOUR,
      }),
    ).toEqual({ trend: 'up', vol: 'high', funding: 'positive', session: 'eu' });
  });

  it('downtrend / low-vol / negative-funding / Asia session', () => {
    expect(
      deriveRegimeTags({
        indicators: indicators({ emaFast: 99, emaSlow: 100, atr14: 0.4, lastClose: 100 }),
        fundingRate: -0.0001,
        eventTime: ASIA_HOUR,
      }),
    ).toEqual({ trend: 'down', vol: 'low', funding: 'negative', session: 'asia' });
  });

  it('flat trend / mid-vol / flat-funding / US session (near-zero EMA spread and funding round to flat)', () => {
    expect(
      deriveRegimeTags({
        indicators: indicators({ emaFast: 100.05, emaSlow: 100, atr14: 1, lastClose: 100 }),
        fundingRate: 0.000005,
        eventTime: US_HOUR,
      }),
    ).toEqual({ trend: 'flat', vol: 'mid', funding: 'flat', session: 'us' });
  });

  it('omits funding entirely when no derivatives rate is present (spot lane)', () => {
    const tags = deriveRegimeTags({
      indicators: indicators({ emaFast: 101, emaSlow: 100, atr14: 2 }),
      fundingRate: null,
      eventTime: EU_HOUR,
    });
    expect(tags).toEqual({ trend: 'up', vol: 'high', session: 'eu' });
    expect(tags).not.toHaveProperty('funding');
  });

  it('returns null when indicators are under warmup (no trend/vol fingerprint to key on)', () => {
    expect(
      deriveRegimeTags({ indicators: null, fundingRate: 0.0001, eventTime: EU_HOUR }),
    ).toBeNull();
  });

  it('returns null on a degenerate emaSlow (0) rather than dividing by zero', () => {
    expect(
      deriveRegimeTags({
        indicators: indicators({ emaFast: 1, emaSlow: 0 }),
        eventTime: EU_HOUR,
      }),
    ).toBeNull();
  });
});

function setup(over: Partial<SimilarSetupRow>): SimilarSetupRow {
  return {
    eventTime: 1 as EpochMs,
    synthetic: false,
    action: 'open_long',
    close: '100',
    priceMovePct: 1.5,
    ...over,
  };
}

const REGIME: RegimeTags = { trend: 'up', vol: 'high', funding: 'positive', session: 'eu' };

describe('renderSimilarSetups', () => {
  it('returns null for an empty retrieval (⇒ the caller omits the payload key)', () => {
    expect(renderSimilarSetups([], REGIME)).toBeNull();
  });

  it('labels replay-sourced entries with a "sim" prefix, live entries unprefixed', () => {
    const block = renderSimilarSetups(
      [
        setup({ synthetic: true, action: 'open_long' }),
        setup({ synthetic: false, action: 'hold' }),
      ],
      REGIME,
    );
    expect(block).toContain('sim open_long @ 100 → +1.50%');
    expect(block).toContain('hold @ 100 → +1.50%');
    expect(block).not.toContain('sim hold');
  });

  it('renders the regime fingerprint header including funding when present', () => {
    const block = renderSimilarSetups([setup({})], REGIME)!;
    expect(block).toContain('up/high-vol/positive-funding/eu');
  });

  it('omits funding from the header when the query regime carries none', () => {
    const block = renderSimilarSetups([setup({})], {
      trend: 'up',
      vol: 'high',
      session: 'eu',
    })!;
    expect(block).toContain('up/high-vol/eu');
    expect(block).not.toContain('funding');
  });

  it('renders a null forward move as n/a, never NaN', () => {
    const block = renderSimilarSetups([setup({ priceMovePct: null })], REGIME)!;
    expect(block).toContain('→ n/a');
    expect(block).not.toContain('NaN');
  });

  it('caps at MAX_SIMILAR_SETUPS entries and MAX_SIMILAR_SETUPS_CHARS characters', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      setup({ action: 'open_long', close: String(1000 + i) }),
    );
    const block = renderSimilarSetups(many, REGIME)!;
    // Only the first MAX_SIMILAR_SETUPS entries render (';' separates entries → count-1 separators).
    const entryCount = block.split(';').length;
    expect(entryCount).toBeLessThanOrEqual(MAX_SIMILAR_SETUPS);
    expect(block.length).toBeLessThanOrEqual(MAX_SIMILAR_SETUPS_CHARS);
  });
});
