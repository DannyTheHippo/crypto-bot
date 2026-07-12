// Funding-conditioned directional signal families (Family A, 2026-07-12 non-price sweep). Perp-only:
// funding rate is a linear-swap-exclusive series (fetch-data.mjs's --funding flag), aligned to bars
// via engine.mjs's attachFundingToBars (one event -> one bar, never broadcast).
//
// Variants (i)/(ii) are inherently two-sided — a positive-funding regime signals SHORT (contrarian)
// or LONG (momentum), and the reverse for negative funding — so there is no meaningful "long-only
// clamp" the way strategies.mjs's clampLong exists for pure trend rules (whose short leg was an
// optional add-on, not the premise). dir is fixed long-short for (i)/(ii); variant (iii) (the gate)
// wraps an existing long/long-short-capable trend rule, so dir is swept there instead.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

export function loadFunding(symbolSafe) {
  const path = join(DATA_DIR, `funding-${symbolSafe}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return raw.map((r) => ({ timestamp: r.timestamp, fundingRate: Number(r.fundingRate) }));
}

// Binance perp funding settles ~3x/day (every 8h) -> annualize a mean per-event rate the same way
// reports/loop/carry-study-2026-07-10.md does (mean_per_8h_rate x 3 x 365).
const FUNDING_EVENTS_PER_YEAR = 3 * 365;

// Trailing smoothed annualized funding, known as of bar t (uses only events attached to bars 0..t —
// no lookahead). smoothN = number of trailing funding EVENTS to average (1, 3, or 9 per the
// pre-registered grid), not bars.
export function fundingSignalSeries(bars, fundingMap, smoothN) {
  const out = new Array(bars.length).fill(null);
  const history = [];
  for (let t = 0; t < bars.length; t += 1) {
    if (fundingMap.has(t)) history.push(fundingMap.get(t));
    if (history.length > 0) {
      const recent = history.slice(-smoothN);
      const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
      out[t] = mean * FUNDING_EVENTS_PER_YEAR;
    }
  }
  return out;
}

// Variants (i) contrarian (fade the crowded/paying side) and (ii) momentum (follow the sign).
// hold: 'flip' = state machine, stays until the signal decays back inside the [-T,T] band (mirrors
//       strategies.mjs's rsiReversion zero-crossing exit); N (8|24) = fixed-bar hold once entered,
//       ignore the signal until N bars elapse, then re-evaluate.
export function fundingPositions(bars, signal, { T, mode, hold }) {
  const pos = new Array(bars.length).fill(null);
  const enter = (s) => {
    if (mode === 'contrarian') return s > T ? -1 : s < -T ? 1 : 0;
    return s > T ? 1 : s < -T ? -1 : 0;
  };
  let cur = 0;
  let heldFor = 0;
  for (let t = 0; t < bars.length; t += 1) {
    const s = signal[t];
    if (s === null) {
      pos[t] = null;
      continue;
    }
    if (hold === 'flip') {
      const target = enter(s);
      if (target !== 0) cur = target;
      else if (Math.abs(s) <= T) cur = 0;
    } else {
      if (cur === 0 || heldFor >= hold) {
        cur = enter(s);
        heldFor = 0;
      } else {
        heldFor += 1;
      }
    }
    pos[t] = cur;
  }
  return pos;
}

// Variant (iii): veto a plain trend rule's entries when funding is against the position beyond T
// (crowded-side cost gate) — tests whether avoiding expensive-to-hold trend entries helps, as
// opposed to trading funding directionally by itself (variants i/ii).
export function fundingGatedTrend(basePositions, signal, T) {
  return basePositions.map((p, t) => {
    if (p === null || p === 0) return p;
    const s = signal[t];
    if (s === null) return p;
    if (p > 0 && s > T) return 0; // long vetoed: funding too positive (expensive to hold long)
    if (p < 0 && s < -T) return 0; // short vetoed: funding too negative (expensive to hold short)
    return p;
  });
}
