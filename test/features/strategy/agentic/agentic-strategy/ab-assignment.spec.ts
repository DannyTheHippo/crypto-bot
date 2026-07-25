import { describe, it, expect } from 'vitest';
import { abArm } from '../../../src/features/trading/agentic/ab-assignment';

const MINUTE_DOMAIN = 100_000;

function marginalRate(salt: string, pct: number, n: number): number {
  let hits = 0;
  for (let m = 0; m < n; m++) if (abArm(m, salt, pct)) hits++;
  return hits / n;
}

describe('abArm', () => {
  describe('golden values (pins the FNV-1a PRF against refactors)', () => {
    // Computed once from the implementation itself and pinned here — any change to the hash
    // constants, the salt:minute keying, or the modulo comparison flips one of these.
    it.each([
      [0, 'info-ctx-v1', 30, false],
      [70, 'info-ctx-v1', 30, false],
      [100, 'info-ctx-v1', 30, true],
      [0, 'th-v1', 50, true],
      [27, 'th-v1', 50, false],
      [12345, 'th-v1', 50, true],
    ])('abArm(%i, %s, %i) === %s', (minute, salt, pct, expected) => {
      expect(abArm(minute, salt, pct)).toBe(expected);
    });
  });

  describe('marginal distribution', () => {
    it.each([
      ['info-ctx-v1', 30],
      ['info-ctx-v1', 50],
      ['th-v1', 30],
      ['th-v1', 50],
    ])('%s at pct=%i hits within pct±1.5 over minutes [0, 100000)', (salt, pct) => {
      const rate = marginalRate(salt, pct, MINUTE_DOMAIN) * 100;
      expect(rate).toBeGreaterThan(pct - 1.5);
      expect(rate).toBeLessThan(pct + 1.5);
    });
  });

  describe('independence across salts (the property the old shared-counter-plus-offset scheme lacked)', () => {
    function jointCells(pctInfo: number, pctThinking: number, n: number) {
      let both = 0;
      let infoOnly = 0;
      let thinkingOnly = 0;
      let neither = 0;
      for (let m = 0; m < n; m++) {
        const info = abArm(m, 'info-ctx-v1', pctInfo);
        const thinking = abArm(m, 'th-v1', pctThinking);
        if (info && thinking) both++;
        else if (info) infoOnly++;
        else if (thinking) thinkingOnly++;
        else neither++;
      }
      return { both, infoOnly, thinkingOnly, neither };
    }

    it('30/30: joint hit-rate matches the product of marginals within ±2pp', () => {
      const marginalInfo = marginalRate('info-ctx-v1', 30, MINUTE_DOMAIN);
      const marginalThinking = marginalRate('th-v1', 30, MINUTE_DOMAIN);
      const { both } = jointCells(30, 30, MINUTE_DOMAIN);
      const jointRate = (both / MINUTE_DOMAIN) * 100;
      const productRate = marginalInfo * marginalThinking * 100;
      expect(Math.abs(jointRate - productRate)).toBeLessThan(2.0);
    });

    it('30/30: the (info-context NON-control & thinking-hit) cell — EMPTY under the retired shared-counter scheme (residues [63,92]∩[27,56]=∅) — is populated and near its independence-implied rate', () => {
      let count = 0;
      for (let m = 0; m < MINUTE_DOMAIN; m++) {
        const infoNonControl = !abArm(m, 'info-ctx-v1', 30);
        const thinkingHit = abArm(m, 'th-v1', 30);
        if (infoNonControl && thinkingHit) count++;
      }
      expect(count).toBeGreaterThan(0);
      const rate = (count / MINUTE_DOMAIN) * 100;
      expect(Math.abs(rate - 0.7 * 0.3 * 100)).toBeLessThan(2.0);
    });

    it('50/50: all four joint cells land within 25%±2pp', () => {
      const { both, infoOnly, thinkingOnly, neither } = jointCells(50, 50, MINUTE_DOMAIN);
      for (const count of [both, infoOnly, thinkingOnly, neither]) {
        const rate = (count / MINUTE_DOMAIN) * 100;
        expect(Math.abs(rate - 25)).toBeLessThan(2.0);
      }
    });
  });

  describe('boundary pct values', () => {
    it('pct=0 is false for every minute tested, before any hashing (cheap short-circuit)', () => {
      for (let m = 0; m < 1000; m++) expect(abArm(m, 'info-ctx-v1', 0)).toBe(false);
    });

    it('negative pct is false for every minute tested', () => {
      for (let m = 0; m < 1000; m++) expect(abArm(m, 'info-ctx-v1', -10)).toBe(false);
    });

    it('pct=100 is true for every minute tested', () => {
      for (let m = 0; m < 1000; m++) expect(abArm(m, 'info-ctx-v1', 100)).toBe(true);
    });
  });
});
