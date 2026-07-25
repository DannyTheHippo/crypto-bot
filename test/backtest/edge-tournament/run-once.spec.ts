// Env-gated one-shot: EDGE_TOURNAMENT_RUN=1 vitest run test/backtest/edge-tournament/run-once.spec.ts
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { MANIFEST_PATH } from './manifest';
import { runEdgeTournament } from './run-tournament';

const enabled = process.env.EDGE_TOURNAMENT_RUN === '1';

describe.skipIf(!enabled)('edge-tournament live run', () => {
  it('runs six frozen trials against cached public data and writes scorecards', () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true);
    const out = runEdgeTournament();
    expect(out.results.length).toBeGreaterThanOrEqual(4);
    expect(out.ranked.length).toBe(out.results.length);
    // Winner may be null — that is a valid research outcome.
    expect(out.dataProbes.ohlcv_universe_ge_8).toBe(true);
  });
});
