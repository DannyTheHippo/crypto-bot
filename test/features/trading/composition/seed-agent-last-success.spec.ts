import { describe, it, expect } from 'vitest';
import { seedAgentLastSuccess } from '../../../../src/features/trading/composition/seed-agent-last-success';

// WATCH-V4-8: the boot seed is the whole point of the metric — an unseeded gauge is born at 0 on every
// redeploy, which is exactly how an 08:17Z restart laundered a 37h-dead lane into a green board.
// These pin the seed AND its fail-open direction: a measurement input must never refuse a boot.

const T0 = 1_785_183_331_000; // 2026-07-27T20:15:31Z — newest successful decide in the live journal
const NOW = 1_785_318_000_000; // 2026-07-29T09:40:00Z, i.e. 37.4h later

function fakes() {
  const seeded: number[] = [];
  const logged: string[] = [];
  const warned: string[] = [];
  return {
    recorder: {
      seedLastSuccessAt: (atMs: number) => {
        seeded.push(atMs);
      },
    },
    log: {
      log: (m: string) => {
        logged.push(m);
      },
      warn: (m: string) => {
        warned.push(m);
      },
    },
    seeded,
    logged,
    warned,
  };
}

describe('seedAgentLastSuccess (WATCH-V4-8 boot seed)', () => {
  it('stamps the durable journal instant and logs its age', async () => {
    const f = fakes();
    await seedAgentLastSuccess(
      f.recorder,
      f.log,
      { lastSuccessfulDecideAt: () => Promise.resolve(T0) },
      NOW,
    );
    expect(f.seeded).toEqual([T0]);
    expect(f.logged[0]).toContain('2026-07-27T20:15:31.000Z');
    expect(f.logged[0]).toContain('37.4h ago');
    expect(f.warned).toEqual([]);
  });

  it('leaves the gauge at 0 when the journal holds no completed round trip', async () => {
    const f = fakes();
    await seedAgentLastSuccess(
      f.recorder,
      f.log,
      { lastSuccessfulDecideAt: () => Promise.resolve(null) },
      NOW,
    );
    expect(f.seeded).toEqual([]);
    expect(f.warned).toEqual([]);
  });

  // test/ci and no-DB boots bind no stats port, and older fakes implement the interface without the
  // optional method — neither may throw on the boot path.
  it.each([
    ['no stats port', undefined],
    ['a stats port without the optional method', {}],
  ])('no-ops on %s', async (_label, stats) => {
    const f = fakes();
    await expect(
      seedAgentLastSuccess(f.recorder, f.log, stats as undefined, NOW),
    ).resolves.toBeUndefined();
    expect(f.seeded).toEqual([]);
    expect(f.warned).toEqual([]);
  });

  // Fail OPEN: a throwing query warns and returns. Delete the try/catch and this rejects, i.e. a DB
  // hiccup would take down startTrading over a measurement input.
  it('warns and resolves when the query throws — never refuses the boot', async () => {
    const f = fakes();
    await expect(
      seedAgentLastSuccess(
        f.recorder,
        f.log,
        { lastSuccessfulDecideAt: () => Promise.reject(new Error('connection terminated')) },
        NOW,
      ),
    ).resolves.toBeUndefined();
    expect(f.seeded).toEqual([]);
    expect(f.warned).toHaveLength(1);
    expect(f.warned[0]).toContain('connection terminated');
  });
});
