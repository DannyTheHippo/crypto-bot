// ── Deterministic pre-screen gate ────────────────────────────────────────────
//
// Cost-floor gate consulted before every LLM call (agent-metrics-recorder.service.ts's
// AgentPrescreenOutcome / app-config.ts's agentic.prescreen* knobs are the wiring for this;
// this file is the pure decision function itself). A quiet, range-bound market should never burn
// a token spend on a call the agent was always going to pass on — but any doubt fails OPEN
// (consult the LLM) rather than silently skipping a call that might have mattered.
//
// Pure, dependency-free: no nest/ccxt/Date.now/process.env. Candle OHLC values are reference-grade
// floats (never money paths — no Price/Qty is minted or moved here), so plain number math is
// correct per CLAUDE.md rule 1.

export type PrescreenReason =
  | 'position_open'
  | 'vol_expansion'
  | 'breakout_proximity'
  | 'insufficient_data'
  | 'quiet';

export type PrescreenOutcome = 'called' | 'skipped_quiet' | 'failopen_error';

export interface PrescreenThresholds {
  readonly volShortBars: number;
  readonly volLongBars: number;
  readonly volRatio: number;
  readonly breakoutLookbackBars: number;
  readonly breakoutPct: number;
}

export interface PrescreenResult {
  readonly consult: boolean;
  readonly reason: PrescreenReason;
}

export interface PrescreenArgs {
  readonly closes: readonly number[];
  readonly highs: readonly number[];
  readonly lows: readonly number[];
  readonly positionOpen: boolean;
  readonly thresholds: PrescreenThresholds;
}

// Population stdev (divide by n, not n-1) of simple bar-over-bar returns close[i]/close[i-1] - 1
// over the given window — simple, not log, returns: consistent with the rest of the agentic
// prompt/indicator surface (agentic.strategy.ts's indicatorFloat-style plain-number math), and the
// two are indistinguishable at the small per-bar magnitudes this gate operates on.
function stdevOfReturns(closes: readonly number[], windowBars: number): number {
  const window = closes.slice(closes.length - windowBars);
  const returns: number[] = [];
  for (let i = 1; i < window.length; i++) {
    returns.push(window[i]! / window[i - 1]! - 1);
  }
  if (returns.length === 0) return 0;
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

function rollingMax(values: readonly number[], windowBars: number): number {
  const window = values.slice(values.length - windowBars);
  return Math.max(...window);
}

function rollingMin(values: readonly number[], windowBars: number): number {
  const window = values.slice(values.length - windowBars);
  return Math.min(...window);
}

function allFinite(values: readonly number[]): boolean {
  return values.every((v) => Number.isFinite(v));
}

// A zero/negative candle value never crashes here (NaN/Infinity comparisons just fall through to
// `false`, routing to the quiet/no-consult path below) — but that is fail-CLOSED, the opposite of
// this module's stated fail-open stance: a zero `hh` turns distToHigh into an unconditional
// Infinity (never <= breakoutPct), and a non-positive close feeding stdevOfReturns can produce NaN
// ratios that likewise never compare true. Folding this into the data-quality gate alongside
// allFinite ensures any non-positive value routes to insufficient_data (consult) instead.
function allPositive(values: readonly number[]): boolean {
  return values.every((v) => v > 0);
}

export function evaluatePrescreen(args: PrescreenArgs): PrescreenResult {
  const { closes, highs, lows, positionOpen, thresholds } = args;
  const { volShortBars, volLongBars, volRatio, breakoutLookbackBars, breakoutPct } = thresholds;

  if (positionOpen) {
    return { consult: true, reason: 'position_open' };
  }

  const longCloseWindow = closes.slice(closes.length - volLongBars);
  const breakoutHighWindow = highs.slice(highs.length - breakoutLookbackBars);
  const breakoutLowWindow = lows.slice(lows.length - breakoutLookbackBars);

  const hasEnoughData =
    closes.length >= volLongBars &&
    highs.length >= breakoutLookbackBars &&
    lows.length >= breakoutLookbackBars;

  if (
    !hasEnoughData ||
    !allFinite(longCloseWindow) ||
    !allFinite(breakoutHighWindow) ||
    !allFinite(breakoutLowWindow) ||
    !allPositive(longCloseWindow) ||
    !allPositive(breakoutHighWindow) ||
    !allPositive(breakoutLowWindow)
  ) {
    return { consult: true, reason: 'insufficient_data' };
  }

  const shortStdev = stdevOfReturns(closes, volShortBars);
  const longStdev = stdevOfReturns(closes, volLongBars);
  // Divide-by-zero guard: a dead-flat long window (longStdev === 0) with any short-window movement
  // at all is itself an expansion signal; both flat is genuinely quiet, not expansion.
  const isVolExpansion = longStdev === 0 ? shortStdev > 0 : shortStdev / longStdev > volRatio;

  if (isVolExpansion) {
    return { consult: true, reason: 'vol_expansion' };
  }

  const lastClose = closes[closes.length - 1]!;
  const highestHigh = rollingMax(breakoutHighWindow, breakoutLookbackBars);
  const lowestLow = rollingMin(breakoutLowWindow, breakoutLookbackBars);
  const distToHigh = Math.abs(highestHigh - lastClose) / highestHigh;
  const distToLow = Math.abs(lastClose - lowestLow) / lowestLow;

  if (distToHigh <= breakoutPct || distToLow <= breakoutPct) {
    return { consult: true, reason: 'breakout_proximity' };
  }

  return { consult: false, reason: 'quiet' };
}
