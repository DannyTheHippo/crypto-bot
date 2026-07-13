// Strategy-validation statistics — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// The step-D standard that certifies a "winner": deflated Sharpe ratio (DSR), t-statistic, and
// minimum backtest length (MinBTL). Implements the estimators from:
//   - Bailey & López de Prado (2012), "The Sharpe Ratio Efficient Frontier" (PSR).
//   - Bailey & López de Prado (2014), "The Deflated Sharpe Ratio: Correcting for Selection Bias,
//     Backtest Overfitting and Non-Normality" (DSR + expected-max-Sharpe / False Strategy Theorem).
//   - Bailey, Borwein, López de Prado, Zhu (2014), "Pseudo-Mathematics and Financial
//     Charlatanism: ... Minimum Backtest Length" (MinBTL).
//
// PER-TRADE-RETURN CONVENTION throughout. We never annualize: the research program mixes four
// heterogeneous candle intervals (1h/15m/5m/1m), so a per-period annualization factor would be
// inconsistent across studies. Every estimator below works on the raw per-round-trip return series
// (BtResult.tradeReturns). MinBTL is therefore expressed in NUMBER OF TRADES, and the
// periods-per-year factor cancels cleanly out of the formula (see minBTL).
//
// No JS stdlib normal CDF / inverse-CDF exists, so both are implemented here (Φ via an
// Abramowitz-Stegun erf; Φ⁻¹ via Acklam's rational approximation + one Halley refinement).

export const EULER_MASCHERONI = 0.5772156649015328606; // γ — appears in the expected-max-Sharpe formula

// ── Standard normal CDF Φ(x) ────────────────────────────────────────────────
//
// Φ(x) = ½(1 + erf(x/√2)). erf via Abramowitz & Stegun 7.1.26 (max abs error ~1.5e-7), which is
// ample for a 0.95 DSR threshold — the gate decisions here are never within 1e-7 of the boundary.
// CAVEAT: A&S 7.1.26 has good ABSOLUTE but poor RELATIVE error in the far tail (|x| ≳ 5); do not
// reuse this normalCdf to compute small tail p-values directly. The gate only evaluates Φ in
// [0.95, 0.999], where absolute accuracy is what matters.
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  // A&S 7.1.26 constants
  const p = 0.3275911;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// Standard normal PDF φ(x) — used only by the Halley refinement step in normalInv.
function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// ── Inverse standard normal CDF Φ⁻¹(p) ──────────────────────────────────────
//
// Acklam's algorithm (rational approximation, relative error < 1.15e-9 before refinement),
// followed by one Halley step that drives the residual to near machine precision. Domain (0,1):
// p<=0 -> -Inf, p>=1 -> +Inf (callers must keep p strictly interior — guarded in expectedMaxZ).
export function normalInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  // Acklam coefficients
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let x: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  // One Halley refinement step: e = Φ(x) - p ; u = e / φ(x) ; x -= u / (1 + x·u/2)
  const e = normalCdf(x) - p;
  const u = e / normalPdf(x);
  x = x - u / (1 + (x * u) / 2);
  return x;
}

// ── Sharpe statistics on a return series (per-trade) ─────────────────────────
//
// sr = mean / std with the POPULATION std (÷n, the MLE). The (n−1) finite-sample correction lives
// in the PSR variance term, not in the SR point estimate. skew/kurt are the standard biased sample
// moments; kurt is NON-EXCESS (a normal has kurt = 3), matching the PSR formula's ((kurt−1)/4) term.
export interface SharpeStats {
  readonly n: number;
  readonly mean: number;
  readonly std: number;
  readonly sr: number; // per-trade Sharpe ratio (excess-of-zero: benchmark return assumed 0)
  readonly skew: number; // γ3
  readonly kurt: number; // γ4, non-excess
}

export function sharpeStats(returns: readonly number[]): SharpeStats {
  const n = returns.length;
  if (n === 0) return { n: 0, mean: 0, std: 0, sr: 0, skew: 0, kurt: 0 };
  let sum = 0;
  for (const r of returns) sum += r;
  const mean = sum / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const r of returns) {
    const d = r - mean;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  const std = Math.sqrt(m2);
  const sr = std > 0 ? mean / std : 0;
  const skew = std > 0 ? m3 / Math.pow(std, 3) : 0;
  const kurt = std > 0 ? m4 / (m2 * m2) : 3; // non-excess; a normal => 3
  return { n, mean, std, sr, skew, kurt };
}

// t-statistic of the mean return: t = SR·√n (= mean / (std/√n)). Per the plan's convention.
export function tStat(s: SharpeStats): number {
  return s.sr * Math.sqrt(s.n);
}

// ── Expected maximum Sharpe of N trials (False Strategy Theorem) ─────────────
//
// Under the null that all N trials have true SR = 0 and the trial SRs are ~N(0, V), the EXPECTED
// MAXIMUM of the N estimated Sharpe ratios is √V·E[max Z_N], with
//   E[max Z_N] ≈ (1−γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e))     (Bailey & López de Prado 2014, eq. for SR0*)
// This is the benchmark a single observed SR must beat to not be the best of N coin-flips.
export function expectedMaxZ(N: number): number {
  const n = Math.max(2, N); // Φ⁻¹(1−1/1)=Φ⁻¹(0)=−∞; require at least 2 trials
  const g = EULER_MASCHERONI;
  return (1 - g) * normalInv(1 - 1 / n) + g * normalInv(1 - 1 / (n * Math.E));
}

export function expectedMaxSharpe(V: number, N: number): number {
  return Math.sqrt(Math.max(0, V)) * expectedMaxZ(N);
}

// ── Winsorized cross-trial SR variance (the V fed to expectedMaxSharpe) ──────
//
// V estimates the trial-SR dispersion under the null, but a thin-sample trial with a degenerate SR
// estimate (a handful of trades, near-zero std) can carry |SR| in the tens and dominate the raw
// variance — the 2026-07-10 carry study hit exactly this degeneracy (SR0* = 140.41 driven by 10 of
// 178 cells with |SR| > 10), making the DSR benchmark unpassable for every honest cell. Clipping the
// trial SRs to |SR| ≤ cap before estimating V bounds each trial's leverage on the benchmark while
// leaving N (the multiple-testing breadth) untouched. Ported from the 2026-07-12 multi-strategy
// engine (test/backtest/multi-strategy/engine.mjs, deflationBenchmark). Sample variance (÷(n−1)),
// matching trial-registry.ts's raw variance(); n < 2 ⇒ 0, same as there.
export function winsorizedVariance(xs: readonly number[], cap = 3): number {
  if (xs.length < 2) return 0;
  const clipped = xs.map((x) => Math.max(-cap, Math.min(cap, x)));
  const m = clipped.reduce((a, b) => a + b, 0) / clipped.length;
  return clipped.reduce((a, b) => a + (b - m) * (b - m), 0) / (clipped.length - 1);
}

// ── Probabilistic Sharpe Ratio PSR(sr0) ──────────────────────────────────────
//
// Probability that the true SR exceeds the benchmark sr0, given the observed SR and the
// non-normality (skew/kurt) of the return series (Bailey & López de Prado 2012):
//   PSR(sr0) = Φ( (SR̂ − sr0)·√(n−1) / √(1 − γ3·SR̂ + ((γ4−1)/4)·SR̂²) )
// The denominator is the std of the SR estimator. It is positive for well-behaved series, but the
// variance term can leave its valid domain (≤ 0) under large positive skew with a high SR — the
// EXACT overfit profile this gate exists to reject. FAIL-CLOSED there: return 0 (so DSR < 0.95) rather
// than clamping the denominator (which would explode the z-argument to PSR→1, a false ACCEPT). For a
// certifier the only safe direction out of the formula's domain is to refuse to certify.
export function psr(s: SharpeStats, sr0: number): number {
  if (s.n < 2) return 0;
  const variance = 1 - s.skew * s.sr + ((s.kurt - 1) / 4) * s.sr * s.sr;
  if (!(variance > 0)) return 0;
  return normalCdf(((s.sr - sr0) * Math.sqrt(s.n - 1)) / Math.sqrt(variance));
}

// Deflated Sharpe Ratio: PSR evaluated at the False-Strategy-Theorem benchmark SR0* = E[max SR of
// N trials]. DSR > 0.95 ⇒ the observed SR is significant AFTER correcting for selection across the
// whole research program (V = variance of the N trial SRs, N = total trial count).
export function deflatedSharpe(s: SharpeStats, V: number, N: number): number {
  return psr(s, expectedMaxSharpe(V, N));
}

// ── Minimum Backtest Length (in TRADES) ──────────────────────────────────────
//
// The number of (per-trade) observations a strategy must have to make its observed SR distinguishable
// from the luckiest of N random strategies. Standard form is MinBTL_years = E[maxZ_N]² / SR_annual²;
// expressing everything per-trade, the periods-per-year factor cancels and MinBTL is in trades:
//   MinBTL = (E[max Z_N] / SR̂)²
// Gate uses trades ≥ MinBTL. Returns +Inf for sr ≤ 0 (a non-positive edge is never long enough).
export function minBTL(N: number, sr: number): number {
  if (!(sr > 0)) return Infinity;
  const z = expectedMaxZ(N);
  return (z / sr) * (z / sr);
}

// ── The 4-part step-D gate ───────────────────────────────────────────────────
//
// A candidate is a validated "winner" only if ALL FOUR hold:
//   1. tStat > minTStat (default 3.0)        — the mean return is robustly non-zero
//   2. DSR > minDsr (default 0.95)           — significant after multiple-testing deflation
//   3. trades ≥ MinBTL                       — the sample is long enough for the claimed SR
//   4. walk-forward OOS positive every seg   — survives chronological out-of-sample on every split
//
// NOTE on (1) vs (3): since this study sets trades = n (one return per round-trip), condition 3 is
// trades ≥ (E[maxZ_N]/SR)² ⇔ SR·√trades ≥ E[maxZ_N] ⇔ tStat ≥ E[maxZ_N]. For the current program
// (N=208 ⇒ E[maxZ_N]≈2.78 < minTStat 3.0) condition 1 STRICTLY IMPLIES condition 3 — MinBTL adds no
// rejection power here (the gate is conservative, never wrong). The relation FLIPS if N grows enough
// that E[maxZ_N] > minTStat (then MinBTL becomes the binding length constraint), so keep both.
export interface GateThresholds {
  readonly minTStat: number;
  readonly minDsr: number;
}
export const DEFAULT_GATE: GateThresholds = { minTStat: 3.0, minDsr: 0.95 };

export interface GateInput {
  readonly stats: SharpeStats;
  readonly V: number; // cross-trial SR variance (research program)
  readonly N: number; // total trial count (research program)
  readonly trades: number; // realized round-trips for this candidate
  readonly wfSegmentsPositive: boolean; // WF OOS PnL > 0 in EVERY segment
}
export interface GateResult {
  readonly tStat: number;
  readonly tStatPass: boolean;
  readonly dsr: number;
  readonly dsrPass: boolean;
  readonly minBTL: number;
  readonly trades: number;
  readonly lengthPass: boolean;
  readonly wfPass: boolean;
  readonly pass: boolean;
}

export function evaluateGate(
  input: GateInput,
  thresholds: GateThresholds = DEFAULT_GATE,
): GateResult {
  const t = tStat(input.stats);
  const dsr = deflatedSharpe(input.stats, input.V, input.N);
  const mbtl = minBTL(input.N, input.stats.sr);
  const tStatPass = t > thresholds.minTStat;
  const dsrPass = dsr > thresholds.minDsr;
  const lengthPass = input.trades >= mbtl;
  const wfPass = input.wfSegmentsPositive;
  return {
    tStat: t,
    tStatPass,
    dsr,
    dsrPass,
    minBTL: mbtl,
    trades: input.trades,
    lengthPass,
    wfPass,
    pass: tStatPass && dsrPass && lengthPass && wfPass,
  };
}
