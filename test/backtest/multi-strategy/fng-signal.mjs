// Fear & Greed signal families (Family B, 2026-07-12 non-price sweep). Daily sentiment index
// (alternative.me, fetch-fng.mjs), a single GLOBAL series applied per-symbol (each major is traded
// against the SAME market-wide sentiment reading — the index has no per-coin variant).
//
// No-lookahead alignment: both the F&G print and the daily OHLCV bar open time are 00:00 UTC, so an
// exact-timestamp Map lookup aligns F&G[day D] to bar[day D] directly — F&G[D] is known at/before
// bar D's own open (it prints AT 00:00 UTC, the bar's open instant), so it is certainly known by bar
// D's close. The engine's standard fill model (positions[t] decided from bar t's close, executed at
// bar t+1's open) then supplies exactly the "trade the next daily bar" lag the task brief calls for —
// no additional shift is applied here.
//
// Like funding (i)/(ii), the contrarian/momentum variants are inherently two-sided, so dir is fixed
// long-short (no long-only clamp variant).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

export function loadFng() {
  const path = join(DATA_DIR, 'fng.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return raw.map((r) => ({ timestamp: r.timestamp, value: Number(r.value) }));
}

// Align the F&G series to a bar array by exact 00:00 UTC timestamp match.
export function alignFngToBars(bars, fngRows) {
  const map = new Map(fngRows.map((r) => [r.timestamp, r.value]));
  return bars.map((b) => map.get(b.t) ?? null);
}

// Variant (i): contrarian direct. F&G <= lo -> long, >= hi -> short; hold to the opposite extreme
// ('reversion') or a fixed N-day hold.
export function fngContrarianPositions(bars, fng, { lo, hi, hold }) {
  const pos = new Array(bars.length).fill(null);
  let cur = 0;
  let heldFor = 0;
  for (let t = 0; t < bars.length; t += 1) {
    const v = fng[t];
    if (v === null) {
      pos[t] = null;
      continue;
    }
    if (hold === 'reversion') {
      if (v <= lo) cur = 1;
      else if (v >= hi) cur = -1;
      // else: hold whatever position is open until the opposite extreme is reached.
    } else {
      if (cur === 0 || heldFor >= hold) {
        if (v <= lo) cur = 1;
        else if (v >= hi) cur = -1;
        else cur = 0;
        heldFor = 0;
      } else {
        heldFor += 1;
      }
    }
    pos[t] = cur;
  }
  return pos;
}

// Variant (iii): F&G momentum — sign of the deltaN-day change, no absolute-level threshold.
export function fngMomentumPositions(bars, fng, { deltaN, hold }) {
  const pos = new Array(bars.length).fill(null);
  let cur = 0;
  let heldFor = 0;
  for (let t = 0; t < bars.length; t += 1) {
    const v = fng[t];
    const vPrev = t >= deltaN ? fng[t - deltaN] : null;
    if (v === null || vPrev === null) {
      pos[t] = null;
      continue;
    }
    const sign = v > vPrev ? 1 : v < vPrev ? -1 : 0;
    if (hold === 'reversion') {
      if (sign !== 0) cur = sign;
    } else {
      if (cur === 0 || heldFor >= hold) {
        cur = sign;
        heldFor = 0;
      } else {
        heldFor += 1;
      }
    }
    pos[t] = cur;
  }
  return pos;
}

// Variant (ii): regime-band gate applied to the pre-existing cross-sectional weight decision. Pass
// through the ranked weights unchanged while F&G is inside [bandLo, bandHi] at a rebalance point;
// force flat (all-zero weights) outside the band. rebalWeights is the caller's own list of
// {tIdx, weights} pairs (see fng-sweep.mjs's adaptation of cross-sectional.mjs's ranking loop).
export function gateWeights(weights, fngAtT, bandLo, bandHi) {
  if (fngAtT === null) return weights;
  return fngAtT >= bandLo && fngAtT <= bandHi ? weights : weights.map(() => 0);
}
