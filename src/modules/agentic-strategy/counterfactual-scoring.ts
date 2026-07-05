import Decimal from 'decimal.js';
import type { AgentDecisionRow } from '../../ports/agentic-strategy';

// ── Offline counterfactual scorer ────────────────────────────────────────────
//
// Prompt-iteration tooling for the agentic (LLM) lane's decision journal — NOT PnL validation.
// Every exported metric here is a TOY RESEARCH METRIC: it is never step-D certification (the
// agentic lane is permanently EXPERIMENT-ONLY, async, and replay-uncertifiable — CLAUDE.md rule 4,
// ports/agentic-strategy.ts's own header), and it is never an auto-promotion input at current
// trade rates (agentic-strategy/README.md § "Auto-promotion is deferred" — promotion stays a
// human-pinned action until ≥30 matched closed trades/comparison window are available; a handful
// of toy-scored decisions is statistically indistinguishable from noise). Scorecards exist only to
// give a human reviewer a rough, consistent yardstick when comparing two playbook/prompt variants
// side by side.
//
// Money-path note: refPrice/close arrive here as decimal STRINGS already minted (and validated >0)
// by domain/types/money.ts's price() at journal-write time. Converting them to plain numbers for
// these indicator-grade research metrics mirrors reflection.service.ts's own `indicatorFloat`
// helper (Decimal→number, never Number()/parseFloat() — both banned by lint outside src/domain) —
// this file is not itself a money path (no Price/Qty is minted or moved here).

export type ScoringRow = Pick<
  AgentDecisionRow,
  'eventTime' | 'action' | 'confidence' | 'refPrice' | 'close' | 'playbookVersion' | 'promptHash'
>;

export const FORWARD_RETURN_HORIZONS = [1, 4, 24] as const;
export type ForwardReturnHorizon = (typeof FORWARD_RETURN_HORIZONS)[number];

export interface HorizonStats {
  readonly horizon: ForwardReturnHorizon;
  // Rows with a defined forward return at this horizon (excludes 'error' rows and rows within
  // `horizon` bars of the end of their group, which have no future close to measure against).
  readonly sampleCount: number;
  readonly hitCount: number;
  readonly hitRate: number | null; // null when sampleCount === 0
}

export interface CalibrationBucket {
  readonly bucketIndex: number; // 0..9, decile
  readonly lowerBound: number; // inclusive
  readonly upperBound: number; // exclusive, except bucket 9 (inclusive of confidence === 1)
  readonly sampleCount: number;
  // Mean "directional edge" at the t+1 horizon over rows in this bucket — see directionalEdge()
  // below for the resulting-exposure sign convention. null when sampleCount === 0.
  readonly meanForwardReturn: number | null;
}

export interface ToyEquityResult {
  readonly finalEquity: number; // multiplicative NAV, starts at 1; realized round trips only
  readonly roundTrips: number;
  // True when the group ends holding an open LONG position — that position's unrealized PnL is
  // excluded from finalEquity entirely (see computeToyEquity's header comment).
  readonly openAtEnd: boolean;
}

export interface Scorecard {
  readonly playbookVersion: number | null;
  readonly promptHash: string;
  readonly rowCount: number;
  readonly horizonStats: readonly HorizonStats[];
  readonly calibration: readonly CalibrationBucket[];
  readonly toyEquity: ToyEquityResult;
}

function toIndicatorFloat(decimalString: string): number {
  return new Decimal(decimalString).toNumber();
}

// Forward return of row i over `horizon` bars, computed from SUBSEQUENT rows' closes (no candle
// table exists here — decisions run at candle cadence, so row i+horizon's close is the only
// available proxy for "the price horizon bars later"). null when there's no row that far ahead in
// the SAME group's own chronological subsequence, or either endpoint's close is unrecorded.
function forwardReturn(rows: readonly ScoringRow[], i: number, horizon: number): number | null {
  const j = i + horizon;
  if (j >= rows.length) return null;
  const fromClose = rows[i]!.close;
  const toClose = rows[j]!.close;
  if (fromClose === null || toClose === null) return null;
  const from = toIndicatorFloat(fromClose);
  const to = toIndicatorFloat(toClose);
  return (to - from) / from;
}

// The position a decision RESULTS IN — the exposure actually carried into the forward window, which
// is what a forward return measures against. Scoring keys off this, not the raw action (F2): a
// 'hold' while already LONG is judged as the LONG exposure it maintains, not as flat.
type Exposure = 'LONG' | 'FLAT';

// Walks the same long/flat state machine as computeToyEquity below and tags each row with the
// exposure held AFTER its action is applied, returned parallel to the input (same length, same
// order). A 'long' while FLAT opens (→LONG); a 'flat' while LONG closes (→FLAT); 'hold'/'error' and
// no-op repeats ('long' while already LONG, 'flat' while already FLAT) leave the position unchanged.
// Runs within a single group's own chronological subsequence, exactly as its callers do.
function annotateResultingExposure(rows: readonly ScoringRow[]): readonly Exposure[] {
  const exposures: Exposure[] = [];
  let position: Exposure = 'FLAT';
  for (const row of rows) {
    if (row.action === 'long' && position === 'FLAT') position = 'LONG';
    else if (row.action === 'flat' && position === 'LONG') position = 'FLAT';
    exposures.push(position);
  }
  return exposures;
}

// Hit convention (exposure-based; an APPROVED change from the earlier action-based convention — see
// the F2 finding in the improvement report). Scored against the resulting exposure so a hold that
// maintains a position is judged on the exposure it carries, not miscounted as flat:
//   - resulting LONG is a hit iff the forward return is STRICTLY positive (fwd > 0): being long
//     paid off. A flat forward return (fwd === 0) is a miss (no edge captured).
//   - resulting FLAT is a hit iff the forward return is non-positive (fwd <= 0): staying out of a
//     market that fell — or went nowhere — avoided a loss. A strictly positive forward return means
//     flat missed a gain, scored as a miss.
// The two branches are an exact complement split at zero (no overlap, no gap).
function isHit(exposure: Exposure, fwd: number): boolean {
  return exposure === 'LONG' ? fwd > 0 : fwd <= 0;
}

// Directional edge for calibration: the same "did this exposure pay off" intuition as isHit above,
// expressed as a continuous signed quantity instead of a boolean — resulting LONG uses the raw
// forward return (positive = paid off); resulting FLAT uses the NEGATED forward return (a decline
// avoided also reads positive here). Used only for calibration's continuous mean, never for a
// hit/miss threshold, so the zero-boundary asymmetry in isHit above does not apply here.
function directionalEdge(exposure: Exposure, fwd: number): number {
  return exposure === 'LONG' ? fwd : -fwd;
}

function computeHorizonStats(rows: readonly ScoringRow[]): readonly HorizonStats[] {
  const exposures = annotateResultingExposure(rows);
  return FORWARD_RETURN_HORIZONS.map((horizon) => {
    let sampleCount = 0;
    let hitCount = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.action === 'error') continue;
      const fwd = forwardReturn(rows, i, horizon);
      if (fwd === null) continue;
      sampleCount++;
      if (isHit(exposures[i]!, fwd)) hitCount++;
    }
    return {
      horizon,
      sampleCount,
      hitCount,
      hitRate: sampleCount === 0 ? null : hitCount / sampleCount,
    };
  });
}

const CALIBRATION_BUCKET_COUNT = 10;
// Calibration is scored at the t+1 horizon only — the most immediate, least confounded consequence
// of a decision (t+4/t+24 mix in whatever happened on the intervening bars too).
const CALIBRATION_HORIZON: ForwardReturnHorizon = 1;

function bucketIndexFor(confidence: number): number {
  // Defensive clamp: the real client's decision schema already constrains confidence to [0, 1]
  // (anthropic-agent-client.ts's zod schema); this only guards against out-of-contract fixtures.
  const clamped = Math.min(1, Math.max(0, confidence));
  return Math.min(CALIBRATION_BUCKET_COUNT - 1, Math.floor(clamped * CALIBRATION_BUCKET_COUNT));
}

function computeCalibration(rows: readonly ScoringRow[]): readonly CalibrationBucket[] {
  const exposures = annotateResultingExposure(rows);
  const sums = Array.from({ length: CALIBRATION_BUCKET_COUNT }, () => ({ sum: 0, count: 0 }));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.action === 'error' || row.confidence === null) continue;
    const fwd = forwardReturn(rows, i, CALIBRATION_HORIZON);
    if (fwd === null) continue;
    const edge = directionalEdge(exposures[i]!, fwd);
    const bucket = sums[bucketIndexFor(row.confidence)]!;
    bucket.sum += edge;
    bucket.count += 1;
  }
  return sums.map((bucket, idx) => ({
    bucketIndex: idx,
    lowerBound: idx / CALIBRATION_BUCKET_COUNT,
    upperBound: (idx + 1) / CALIBRATION_BUCKET_COUNT,
    sampleCount: bucket.count,
    meanForwardReturn: bucket.count === 0 ? null : bucket.sum / bucket.count,
  }));
}

// Fixed, non-caller-tunable pessimistic assumptions so every scorecard in a comparison uses
// IDENTICAL rules regardless of what fee tier/profile actually produced the underlying rows.
// TOY_TAKER_FEE_BPS mirrors AnthropicAgentClient's illustrative DEFAULT_TRADING_PROFILE.takerBps;
// TOY_ADVERSE_HAIRCUT_BPS is the brief-specified 5 bps/side pessimistic slippage haircut.
const TOY_TAKER_FEE_BPS = new Decimal('10');
const TOY_ADVERSE_HAIRCUT_BPS = new Decimal('5');
const BPS_DIVISOR = new Decimal('10000');

// Toy net-of-fee equity, long/flat only (mirrors AnthropicAgentClient's own signal-mapping state
// machine: 'hold'/'error' never change position; a repeated 'long' while already LONG, or 'flat'
// while already FLAT, is a no-op). Fills happen at the NEXT row's refPrice — a next-bar proxy,
// since these rows record no true "open" and a decision made ON row i's close cannot realistically
// execute at that same close (zero-latency, look-ahead). A decision with no next row (the group's
// last row) never fills — it is simply dropped, never opened. Every fill is haircut against the
// position (buys pay more, sells receive less) and the taker fee is charged on BOTH legs, applied
// together as a single multiplier at the point a round trip closes. A position still open (LONG) at
// the end of the group's rows is NEVER marked to market here — it contributes nothing to
// finalEquity, realized or unrealized; only completed round trips count (see openAtEnd).
function computeToyEquity(rows: readonly ScoringRow[]): ToyEquityResult {
  let equity = new Decimal(1);
  let position: 'FLAT' | 'LONG' = 'FLAT';
  let entryEffectivePrice: Decimal | null = null;
  let roundTrips = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.action === 'hold' || row.action === 'error') continue;
    const nextRow = rows[i + 1];
    if (!nextRow || nextRow.refPrice === null) continue;
    const rawFill = new Decimal(nextRow.refPrice);

    if (row.action === 'long' && position === 'FLAT') {
      entryEffectivePrice = rawFill.times(
        new Decimal(1).plus(TOY_ADVERSE_HAIRCUT_BPS.div(BPS_DIVISOR)),
      );
      position = 'LONG';
    } else if (row.action === 'flat' && position === 'LONG') {
      const exitEffectivePrice = rawFill.times(
        new Decimal(1).minus(TOY_ADVERSE_HAIRCUT_BPS.div(BPS_DIVISOR)),
      );
      const feeFactor = new Decimal(1).minus(TOY_TAKER_FEE_BPS.div(BPS_DIVISOR));
      equity = equity
        .times(exitEffectivePrice.div(entryEffectivePrice!))
        .times(feeFactor)
        .times(feeFactor);
      position = 'FLAT';
      entryEffectivePrice = null;
      roundTrips++;
    }
    // 'long' while already LONG, or 'flat' while already FLAT: no-op, same as the real client.
  }

  return { finalEquity: equity.toNumber(), roundTrips, openAtEnd: position === 'LONG' };
}

function groupKey(row: ScoringRow): string {
  return `${row.playbookVersion ?? 'null'} ${row.promptHash}`;
}

/**
 * Scores an ordered (oldest→newest) journal-shaped row sequence into one Scorecard per distinct
 * (playbookVersion, promptHash) pair — a version whose rows span multiple promptHashes (e.g. a
 * promotion boundary, or two variants replayed and concatenated) is split per hash, one Scorecard
 * each. Forward returns/hit-rate/calibration/toy-equity are all computed WITHIN each group's own
 * chronological subsequence (grouping happens first, stably preserving each row's relative order)
 * — never across a different variant's price path, even when groups are interleaved in the input.
 *
 * TOY RESEARCH METRIC — see this module's header comment. Never step-D certification, never an
 * auto-promotion input at current trade rates.
 */
export function scoreRows(rows: readonly ScoringRow[]): readonly Scorecard[] {
  const groups = new Map<string, ScoringRow[]>();
  for (const row of rows) {
    const key = groupKey(row);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  return Array.from(groups.values()).map((groupRows) => ({
    playbookVersion: groupRows[0]!.playbookVersion,
    promptHash: groupRows[0]!.promptHash,
    rowCount: groupRows.length,
    horizonStats: computeHorizonStats(groupRows),
    calibration: computeCalibration(groupRows),
    toyEquity: computeToyEquity(groupRows),
  }));
}

// ── Forward-outcome digest for the reflection loop (F1) ──────────────────────
//
// A compact summary of how RECENT decisions turned out one bar later, so the reflection prompt can
// see post-decision price outcomes (previously it saw only closed round-trips + a hold count, never
// whether individual decisions were followed by favorable moves). TOY RESEARCH METRIC — same caveats
// as this module's header: thin, noisy, never a promotion input; it exists to help a model spot
// SYSTEMATIC error (e.g. entries that on average lose money at t+1), not to prove anything.

export interface DecisionOutcomeBucket {
  // Decisions in this bucket that HAVE a defined t+1 forward return (rows at the very end of the
  // window, with no next close to measure against, are excluded — so mean is always over `count`).
  readonly count: number;
  // Mean t+1 forward return over the bucket, as a PERCENT (0.1 → 10). null when count === 0.
  readonly meanForwardReturnPct: number | null;
}

export interface DecisionOutcomeDigest {
  readonly entries: DecisionOutcomeBucket; // opened a long (FLAT→LONG)
  readonly exits: DecisionOutcomeBucket; // closed a long (LONG→FLAT)
  readonly heldLong: DecisionOutcomeBucket; // maintained a long (hold, or long while already LONG)
  readonly stayedFlat: DecisionOutcomeBucket; // maintained flat (hold, or flat while already FLAT)
  readonly confidence: {
    readonly lowLong: DecisionOutcomeBucket; // 'long' decisions with confidence < 0.5
    readonly highLong: DecisionOutcomeBucket; // 'long' decisions with confidence >= 0.5
  };
}

interface MutableBucket {
  count: number;
  sum: number;
}

function addToBucket(bucket: MutableBucket, fwd: number): void {
  bucket.count += 1;
  bucket.sum += fwd;
}

function finalizeBucket(bucket: MutableBucket): DecisionOutcomeBucket {
  return {
    count: bucket.count,
    meanForwardReturnPct: bucket.count === 0 ? null : (bucket.sum / bucket.count) * 100,
  };
}

/**
 * Summarizes a recent oldest→newest decision window (the reflection lookback) into a DecisionOutcomeDigest,
 * reusing the same resulting-exposure state walk as the scorecards. Each non-'error' decision with a
 * defined t+1 forward return is bucketed by what it DID (entry / exit / held-long / stayed-flat) and,
 * for 'long' decisions, by confidence split at 0.5 — each bucket reporting its count and mean t+1
 * forward return. Unlike scoreRows, the whole window is treated as one continuous position sequence
 * (it is the actual decision journal in order), not grouped per playbook/prompt.
 *
 * TOY RESEARCH METRIC — see this module's header comment and the F1 digest header above.
 */
export function summarizeRecentDecisionOutcomes(
  rows: readonly ScoringRow[],
): DecisionOutcomeDigest {
  const exposures = annotateResultingExposure(rows);
  const entries: MutableBucket = { count: 0, sum: 0 };
  const exits: MutableBucket = { count: 0, sum: 0 };
  const heldLong: MutableBucket = { count: 0, sum: 0 };
  const stayedFlat: MutableBucket = { count: 0, sum: 0 };
  const lowLong: MutableBucket = { count: 0, sum: 0 };
  const highLong: MutableBucket = { count: 0, sum: 0 };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.action === 'error') continue;
    const fwd = forwardReturn(rows, i, 1); // t+1: the most immediate, least confounded outcome
    if (fwd === null) continue;
    const resulting = exposures[i]!;
    const prev: Exposure = i === 0 ? 'FLAT' : exposures[i - 1]!;

    if (row.action === 'long' && prev === 'FLAT') addToBucket(entries, fwd);
    else if (row.action === 'flat' && prev === 'LONG') addToBucket(exits, fwd);
    else if (resulting === 'LONG') addToBucket(heldLong, fwd);
    else addToBucket(stayedFlat, fwd);

    if (row.action === 'long' && row.confidence !== null) {
      addToBucket(row.confidence < 0.5 ? lowLong : highLong, fwd);
    }
  }

  return {
    entries: finalizeBucket(entries),
    exits: finalizeBucket(exits),
    heldLong: finalizeBucket(heldLong),
    stayedFlat: finalizeBucket(stayedFlat),
    confidence: { lowLong: finalizeBucket(lowLong), highLong: finalizeBucket(highLong) },
  };
}

export interface CompareOptions {
  // Required (and must be exactly `true`) to proceed — see compare()'s own comment for why.
  readonly assertSameTemplate?: boolean;
}

export interface HitRateDelta {
  readonly horizon: ForwardReturnHorizon;
  readonly championHitRate: number | null;
  readonly candidateHitRate: number | null;
  readonly delta: number | null; // candidateHitRate - championHitRate; null if either side is null
}

export interface ComparisonResult {
  readonly champion: Scorecard;
  readonly candidate: Scorecard;
  readonly finalEquityDelta: number; // candidate.toyEquity.finalEquity - champion's
  readonly hitRateDeltas: readonly HitRateDelta[];
}

/**
 * Compares two Scorecards produced by scoreRows(). Refuses by default: promptHash alone cannot
 * prove the two runs shared the same underlying prompt TEMPLATE, because playbook CONTENT is one
 * of the components folded into the hash (computePromptHash in agent-prompt.ts) — two different
 * playbooks under the same template version hash differently, and a stale/incompatible template
 * version could in principle collide on unrelated content. Only a caller that controlled BOTH runs
 * (e.g. an A/B harness that replayed the identical candle window through two known playbook
 * variants of one known template version) can actually vouch for template equality; that caller
 * must say so explicitly with `assertSameTemplate: true`. Without it, compare() throws rather than
 * silently comparing two scorecards that might not be comparable.
 *
 * TOY RESEARCH METRIC — see this module's header comment.
 */
export function compare(
  champion: Scorecard,
  candidate: Scorecard,
  opts: CompareOptions = {},
): ComparisonResult {
  if (opts.assertSameTemplate !== true) {
    throw new Error(
      'compare() refuses to compare two scorecards without assertSameTemplate: true — promptHash ' +
        'alone cannot prove the two runs shared the same prompt template (playbook content is one ' +
        'of the components folded into the hash), so only a caller that controlled both runs (e.g. ' +
        'an A/B harness replaying the same candle window through two known playbook variants) can ' +
        'vouch for template equality. Pass { assertSameTemplate: true } to proceed.',
    );
  }
  const candidateByHorizon = new Map(candidate.horizonStats.map((s) => [s.horizon, s]));
  const hitRateDeltas: HitRateDelta[] = champion.horizonStats.map((championStat) => {
    const candidateStat = candidateByHorizon.get(championStat.horizon);
    const candidateHitRate = candidateStat?.hitRate ?? null;
    const delta =
      championStat.hitRate === null || candidateHitRate === null
        ? null
        : candidateHitRate - championStat.hitRate;
    return {
      horizon: championStat.horizon,
      championHitRate: championStat.hitRate,
      candidateHitRate,
      delta,
    };
  });
  return {
    champion,
    candidate,
    finalEquityDelta: candidate.toyEquity.finalEquity - champion.toyEquity.finalEquity,
    hitRateDeltas,
  };
}
