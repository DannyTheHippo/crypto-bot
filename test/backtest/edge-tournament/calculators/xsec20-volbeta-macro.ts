import Decimal from 'decimal.js';
import {
  EFFECTIVE_BOOK_USD,
  MACRO_BLACKOUT_AFTER_MS,
  MACRO_BLACKOUT_BEFORE_MS,
  MACRO_REDUCED_DURATION_MS,
  MACRO_REDUCED_EXPOSURE_FRACTION,
  REPORTING_SEGMENTS,
} from '../constants';
import { simulateXsec } from '../xsec-core';
import type { DailySeries, MacroEvent, TrialResult } from '../types';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export function loadMacroEventsFromJson(
  raw: readonly { name: string; atMs: number }[],
): MacroEvent[] {
  return raw
    .filter((e) => /FOMC|CPI/i.test(e.name))
    .map((e) => ({
      name: e.name,
      atMs: e.atMs,
      kind: /CPI/i.test(e.name) ? 'CPI' : 'FOMC',
    }));
}

export function macroExposureScale(ts: number, events: readonly MacroEvent[]): string {
  for (const ev of events) {
    const start = ev.atMs - MACRO_BLACKOUT_BEFORE_MS;
    const end = ev.atMs + MACRO_BLACKOUT_AFTER_MS;
    if (ts >= start && ts <= end) return '0';
    const reducedEnd = end + MACRO_REDUCED_DURATION_MS;
    if (ts > end && ts <= reducedEnd) return MACRO_REDUCED_EXPOSURE_FRACTION;
  }
  return '1';
}

export function runXsec20VolbetaMacro(
  bySymbol: ReadonlyMap<string, DailySeries>,
  macroEvents: readonly MacroEvent[],
): TrialResult {
  return simulateXsec(bySymbol, {
    trialId: 'xsec20-volbeta-macro',
    weightMode: 'volbeta',
    rankMode: 'raw',
    macroEvents,
  });
}

export function segmentTouchesMacroBlackout(
  segmentStartMs: number,
  segmentEndMs: number,
  events: readonly MacroEvent[],
): boolean {
  for (const ev of events) {
    const start = ev.atMs - MACRO_BLACKOUT_BEFORE_MS;
    const end = ev.atMs + MACRO_BLACKOUT_AFTER_MS;
    if (segmentEndMs > start && segmentStartMs < end) return true;
  }
  return false;
}

export { REPORTING_SEGMENTS, EFFECTIVE_BOOK_USD };
