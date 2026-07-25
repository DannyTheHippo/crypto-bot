import Decimal from 'decimal.js';
import type { AgentDecisionRow } from '../../../ports/agentic-strategy';

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

// `symbol` is declared as plain string (AgentDecisionRow's branded SymbolId is assignable to it)
// because grouping is the ONLY thing it drives here — no money/venue call is keyed off it. Without
// it, rows from different instruments interleave into one group and forwardReturn()/computeToyEquity()
// read a DIFFERENT symbol's close/refPrice as row i's future price path (observed 2026-07-12: a
// 5-symbol recorded corpus scored BTC→LINK transitions as −99.99% "forward returns").
export type ScoringRow = Pick<
  AgentDecisionRow,
  | 'eventTime'
  | 'action'
  | 'confidence'
  | 'refPrice'
  | 'close'
  | 'playbookVersion'
  | 'promptHash'
  | 'model'
> & { readonly symbol: string };

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
  /** Single instrument for a scoreRows() group; a '+'-joined list for combineScorecards() output. */
  readonly symbol: string;
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
//
// SHORT is a genuine third state, distinct from FLAT: 'open_short' is its own action literal at the
// port level (v3 §2/§9: ScoringRow.action, Pick'd off AgentDecisionRow, carries ONLY the rich-tool-
// contract vocabulary now — the legacy 'long'/'flat' literals a pre-v3 journal could carry are
// unreachable, the fresh v3 agent_decisions column never persists them).
type Exposure = 'LONG' | 'SHORT' | 'FLAT';

// Walks the SAME position state machine as computeToyEquity below (kept in lockstep — both read the
// same action vocabulary) and tags each row with the exposure held AFTER its action is applied,
// returned parallel to the input (same length, same order). v2/v3 'open_long'/'open_short' while
// FLAT open LONG/SHORT, 'close' closes either side to FLAT, 'adjust' leaves the position unchanged
// by design (Design § New tool contract: "the clock enforces the model's intent, not a risk gate" —
// it never re-sides a position). A same-side 'open_*' while ALREADY in that side (scale-in) and an
// opposite-side 'open_*' while positioned (no accidental flip, journal-visible hold per the client's
// own same-side/opposite-side rule) both leave the position unchanged, exactly like the client
// itself. 'hold'/'error' are always no-ops. Runs within a single group's own chronological
// subsequence, exactly as its callers do.
function annotateResultingExposure(rows: readonly ScoringRow[]): readonly Exposure[] {
  const exposures: Exposure[] = [];
  let position: Exposure = 'FLAT';
  for (const row of rows) {
    switch (row.action) {
      case 'open_long':
        if (position === 'FLAT') position = 'LONG';
        break;
      case 'open_short':
        if (position === 'FLAT') position = 'SHORT';
        break;
      case 'close':
        if (position !== 'FLAT') position = 'FLAT';
        break;
      // 'adjust': position unchanged by design. 'hold'/'error': no-op.
      default:
        break;
    }
    exposures.push(position);
  }
  return exposures;
}

// Hit convention (exposure-based; an APPROVED change from the earlier action-based convention — see
// the F2 finding in the improvement report). Scored against the resulting exposure so a hold that
// maintains a position is judged on the exposure it carries, not miscounted as flat:
//   - resulting LONG is a hit iff the forward return is STRICTLY positive (fwd > 0): being long
//     paid off. A flat forward return (fwd === 0) is a miss (no edge captured).
//   - resulting SHORT (P4) is a hit iff the forward return is STRICTLY negative (fwd < 0): being
//     short paid off — the exact mirror of the LONG branch, split at the same zero boundary.
//   - resulting FLAT is a hit iff the forward return is non-positive (fwd <= 0): staying out of a
//     market that fell — or went nowhere — avoided a loss. A strictly positive forward return means
//     flat missed a gain, scored as a miss.
// The three branches are an exact complement split at zero for LONG/FLAT (no overlap, no gap); SHORT
// overlaps FLAT's boundary at fwd === 0 (both miss) by construction — a zero move never "pays off"
// either side of a real position.
function isHit(exposure: Exposure, fwd: number): boolean {
  if (exposure === 'LONG') return fwd > 0;
  if (exposure === 'SHORT') return fwd < 0;
  return fwd <= 0;
}

// Directional edge for calibration: the same "did this exposure pay off" intuition as isHit above,
// expressed as a continuous signed quantity instead of a boolean — resulting LONG uses the raw
// forward return (positive = paid off); resulting SHORT (P4) and resulting FLAT both use the
// NEGATED forward return (a short profits from a decline, a decline avoided while flat also reads
// positive here — same formula, different reason). Used only for calibration's continuous mean,
// never for a hit/miss threshold, so the zero-boundary asymmetry in isHit above does not apply here.
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

// Toy net-of-fee equity across BOTH sides. Mirrors
// AnthropicAgentClient's own signal-mapping state machine: 'hold'/'error'/'adjust' never change
// position; a same-side open while already in that side, or a 'close' while already FLAT, is a
// no-op; an opposite-side 'open_*' while positioned is ALSO a no-op (no accidental flip, same
// journal-visible-hold rule as annotateResultingExposure above — this toy walk never re-sides a
// position on its own). Fills happen at the NEXT row's refPrice — a next-bar proxy, since these rows
// record no true "open" and a decision made ON row i's close cannot realistically execute at that
// same close (zero-latency, look-ahead). A decision with no next row (the group's last row) never
// fills — it is simply dropped, never opened. Every fill is haircut against the position (a LONG
// buy/SHORT sell-to-open pays the adverse side, the closing leg receives the adverse side) and the
// taker fee is charged on BOTH legs, applied together as a single multiplier at the point a round
// trip closes. A position still open (LONG or SHORT) at the end of the group's rows is NEVER marked
// to market here — it contributes nothing to finalEquity, realized or unrealized; only completed
// round trips count (see openAtEnd).
function computeToyEquity(rows: readonly ScoringRow[]): ToyEquityResult {
  let equity = new Decimal(1);
  let position: 'FLAT' | 'LONG' | 'SHORT' = 'FLAT';
  let entryEffectivePrice: Decimal | null = null;
  let roundTrips = 0;

  const haircutUp = (price: Decimal): Decimal =>
    price.times(new Decimal(1).plus(TOY_ADVERSE_HAIRCUT_BPS.div(BPS_DIVISOR)));
  const haircutDown = (price: Decimal): Decimal =>
    price.times(new Decimal(1).minus(TOY_ADVERSE_HAIRCUT_BPS.div(BPS_DIVISOR)));

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.action === 'hold' || row.action === 'error' || row.action === 'adjust') continue;
    const nextRow = rows[i + 1];
    if (!nextRow || nextRow.refPrice === null) continue;
    const rawFill = new Decimal(nextRow.refPrice);

    if (row.action === 'open_long' && position === 'FLAT') {
      // Opening a LONG pays the adverse (higher) side of the haircut.
      entryEffectivePrice = haircutUp(rawFill);
      position = 'LONG';
    } else if (row.action === 'open_short' && position === 'FLAT') {
      // Opening a SHORT (sell-to-open) receives the adverse (lower) side — mirror of a LONG entry.
      entryEffectivePrice = haircutDown(rawFill);
      position = 'SHORT';
    } else if (row.action === 'close' && position !== 'FLAT') {
      const closingLong = position === 'LONG';
      // Closing a LONG (sell-to-close) receives the adverse side; closing a SHORT (buy-to-close)
      // pays it — the exact mirror of each side's own entry haircut above.
      const exitEffectivePrice = closingLong ? haircutDown(rawFill) : haircutUp(rawFill);
      const feeFactor = new Decimal(1).minus(TOY_TAKER_FEE_BPS.div(BPS_DIVISOR));
      // LONG profits when exit > entry (exit/entry); SHORT profits when exit < entry (entry/exit) —
      // the ratio is inverted so a favorable move always multiplies equity UP regardless of side.
      const grossMultiplier = closingLong
        ? exitEffectivePrice.div(entryEffectivePrice!)
        : entryEffectivePrice!.div(exitEffectivePrice);
      equity = equity.times(grossMultiplier).times(feeFactor).times(feeFactor);
      position = 'FLAT';
      entryEffectivePrice = null;
      roundTrips++;
    }
    // Same-side open while already in that side, opposite-side open while positioned, 'close'
    // while already FLAT: no-op, same as the real client.
  }

  return { finalEquity: equity.toNumber(), roundTrips, openAtEnd: position !== 'FLAT' };
}

function groupKey(row: ScoringRow): string {
  return `${row.playbookVersion ?? 'null'} ${row.promptHash} ${row.symbol}`;
}

/**
 * Scores an ordered (oldest→newest) journal-shaped row sequence into one Scorecard per distinct
 * (playbookVersion, promptHash, symbol) triple — a version whose rows span multiple promptHashes
 * (e.g. a promotion boundary, or two variants replayed and concatenated) is split per hash, one
 * Scorecard each, and a multi-instrument corpus is split per symbol: forward returns, the long/flat
 * exposure state machine, and toy-equity fills are only meaningful along ONE instrument's price
 * path (before symbol joined the key, a 5-symbol journal scored cross-symbol close transitions as
 * returns). Forward returns/hit-rate/calibration/toy-equity are all computed WITHIN each group's
 * own chronological subsequence (grouping happens first, stably preserving each row's relative
 * order) — never across a different variant's or instrument's price path, even when groups are
 * interleaved in the input. Use combineScorecards() to aggregate one variant's per-symbol cards.
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
    symbol: groupRows[0]!.symbol,
    rowCount: groupRows.length,
    horizonStats: computeHorizonStats(groupRows),
    calibration: computeCalibration(groupRows),
    toyEquity: computeToyEquity(groupRows),
  }));
}

/**
 * Aggregates one variant's per-symbol Scorecards (same playbookVersion + promptHash, distinct
 * symbols) into a single portfolio-level card so compare() can keep judging one card per side.
 * Refuses mixed variants — combining across different (version, hash) pairs would silently average
 * two different prompts. Aggregation rules, all evidence-preserving: horizon sample/hit counts sum
 * (hit rate recomputed from the sums); calibration buckets recombine count-weighted; toy equity is
 * the PRODUCT of per-symbol final equities (each sleeve compounds its own NAV from 1 — the
 * equal-notional-sleeves toy portfolio convention) with round trips summed and openAtEnd true when
 * any sleeve ends open.
 *
 * TOY RESEARCH METRIC — see this module's header comment.
 */
export function combineScorecards(cards: readonly Scorecard[]): Scorecard {
  if (cards.length === 0) {
    throw new Error('combineScorecards: no scorecards to combine');
  }
  const first = cards[0]!;
  for (const card of cards) {
    if (card.playbookVersion !== first.playbookVersion || card.promptHash !== first.promptHash) {
      throw new Error(
        'combineScorecards refuses to combine scorecards from different (playbookVersion, ' +
          `promptHash) variants: got (${String(first.playbookVersion)}, ${first.promptHash}) and ` +
          `(${String(card.playbookVersion)}, ${card.promptHash}) — aggregate one variant's ` +
          'per-symbol cards only.',
      );
    }
  }

  const horizonStats: HorizonStats[] = FORWARD_RETURN_HORIZONS.map((horizon) => {
    let sampleCount = 0;
    let hitCount = 0;
    for (const card of cards) {
      const stat = card.horizonStats.find((s) => s.horizon === horizon);
      if (!stat) continue;
      sampleCount += stat.sampleCount;
      hitCount += stat.hitCount;
    }
    return {
      horizon,
      sampleCount,
      hitCount,
      hitRate: sampleCount === 0 ? null : hitCount / sampleCount,
    };
  });

  const calibration: CalibrationBucket[] = Array.from(
    { length: CALIBRATION_BUCKET_COUNT },
    (_, idx) => {
      let count = 0;
      let weightedSum = 0;
      for (const card of cards) {
        const bucket = card.calibration.find((b) => b.bucketIndex === idx);
        if (!bucket || bucket.sampleCount === 0 || bucket.meanForwardReturn === null) continue;
        count += bucket.sampleCount;
        weightedSum += bucket.meanForwardReturn * bucket.sampleCount;
      }
      return {
        bucketIndex: idx,
        lowerBound: idx / CALIBRATION_BUCKET_COUNT,
        upperBound: (idx + 1) / CALIBRATION_BUCKET_COUNT,
        sampleCount: count,
        meanForwardReturn: count === 0 ? null : weightedSum / count,
      };
    },
  );

  return {
    playbookVersion: first.playbookVersion,
    promptHash: first.promptHash,
    symbol: cards
      .map((c) => c.symbol)
      .sort()
      .join('+'),
    rowCount: cards.reduce((sum, c) => sum + c.rowCount, 0),
    horizonStats,
    calibration,
    toyEquity: {
      finalEquity: cards.reduce((prod, c) => prod * c.toyEquity.finalEquity, 1),
      roundTrips: cards.reduce((sum, c) => sum + c.toyEquity.roundTrips, 0),
      openAtEnd: cards.some((c) => c.toyEquity.openAtEnd),
    },
  };
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
  readonly shortEntries: DecisionOutcomeBucket; // opened a short (FLAT→SHORT)
  readonly exits: DecisionOutcomeBucket; // closed a long (LONG→FLAT)
  readonly shortExits: DecisionOutcomeBucket; // closed a short (SHORT→FLAT)
  readonly heldLong: DecisionOutcomeBucket; // maintained a long (hold, or long while already LONG)
  // P4b (#37/5da2630 defect class — mislabeled exposure): maintained a short (open_short, adjust, or
  // hold while already SHORT) — the exact SHORT mirror of heldLong, split out of the stayedFlat
  // catch-all it used to fall into (see this function's docstring).
  readonly heldShort: DecisionOutcomeBucket;
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
 * (it is the actual decision journal in order), not grouped per playbook/prompt. That makes it the
 * CALLER's contract to pass a single instrument's rows (reflection passes P7 strategy-scoped rows;
 * candidate-model-eval groups per symbol first, #37): a mixed-symbol window corrupts both the
 * forward returns and the exposure walk, exactly the scoreRows defect 5da2630 fixed.
 *
 * Prescreen quiet-HOLD rows (model === 'prescreen') stay in the sequence for the exposure walk and
 * forward-return adjacency (they are real, chronologically ordered decisions), but are excluded from
 * bucketing: they are FLAT-by-construction (the gate only skips when already flat — see
 * evaluatePrescreenGate in agentic.strategy.ts), so counting them would flood stayedFlat with
 * hand-picked quiet periods rather than genuine model HOLDs.
 *
 * P4b: this function's bucket set predates the v2 SHORT exposure (see annotateResultingExposure's
 * own comment) — a resulting SHORT row used to fall into `stayedFlat` below (the `else` catch-all),
 * same as FLAT, mislabeling every held/entered-short outcome as a flat one. `heldShort` now mirrors
 * `heldLong` exactly (hold, adjust, or open_short/short while already SHORT); `stayedFlat` stays the
 * catch-all for genuine FLAT rows only. Additive follow-up (same mislabel class): FLAT→open_short
 * rows used to fall into `heldShort` (they resulted in SHORT, but never entered one from FLAT) and
 * close-from-SHORT rows used to fall into `stayedFlat` (they resulted in FLAT, but arrived there by
 * closing a short, not by staying out). `shortEntries`/`shortExits` now give both their own buckets,
 * mirroring `entries`/`exits` exactly.
 *
 * TOY RESEARCH METRIC — see this module's header comment and the F1 digest header above.
 */
export function summarizeRecentDecisionOutcomes(
  rows: readonly ScoringRow[],
): DecisionOutcomeDigest {
  const exposures = annotateResultingExposure(rows);
  const entries: MutableBucket = { count: 0, sum: 0 };
  const shortEntries: MutableBucket = { count: 0, sum: 0 };
  const exits: MutableBucket = { count: 0, sum: 0 };
  const shortExits: MutableBucket = { count: 0, sum: 0 };
  const heldLong: MutableBucket = { count: 0, sum: 0 };
  const heldShort: MutableBucket = { count: 0, sum: 0 };
  const stayedFlat: MutableBucket = { count: 0, sum: 0 };
  const lowLong: MutableBucket = { count: 0, sum: 0 };
  const highLong: MutableBucket = { count: 0, sum: 0 };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.action === 'error' || row.model === 'prescreen') continue;
    const fwd = forwardReturn(rows, i, 1); // t+1: the most immediate, least confounded outcome
    if (fwd === null) continue;
    const resulting = exposures[i]!;
    const prev: Exposure = i === 0 ? 'FLAT' : exposures[i - 1]!;

    // RAW forward return in every bucket below (sign correction stays consumer-side, matching
    // directionalEdge's own convention above — never negate inside the digest).
    if (row.action === 'open_long' && prev === 'FLAT') addToBucket(entries, fwd);
    else if (row.action === 'open_short' && prev === 'FLAT') addToBucket(shortEntries, fwd);
    else if (row.action === 'close' && prev === 'LONG') addToBucket(exits, fwd);
    else if (row.action === 'close' && prev === 'SHORT') addToBucket(shortExits, fwd);
    else if (resulting === 'LONG') addToBucket(heldLong, fwd);
    else if (resulting === 'SHORT') addToBucket(heldShort, fwd);
    else addToBucket(stayedFlat, fwd);

    if (row.action === 'open_long' && row.confidence !== null) {
      addToBucket(row.confidence < 0.5 ? lowLong : highLong, fwd);
    }
  }

  return {
    entries: finalizeBucket(entries),
    shortEntries: finalizeBucket(shortEntries),
    exits: finalizeBucket(exits),
    shortExits: finalizeBucket(shortExits),
    heldLong: finalizeBucket(heldLong),
    heldShort: finalizeBucket(heldShort),
    stayedFlat: finalizeBucket(stayedFlat),
    confidence: { lowLong: finalizeBucket(lowLong), highLong: finalizeBucket(highLong) },
  };
}

// ── Calibration + regime digests for the reflection loop (W14) ──────────────
//
// The F1 digest above buckets recent decisions by WHAT they did; these two buckets by the model's
// own STATED confidence and by realized-volatility regime, so a systematic miscalibration (e.g.
// 'long' entries showing no positive edge at any confidence level) is visible to the reflection
// model as a table, not something a human has to compute by hand from agent_decisions. Same t+1,
// close-price-proxy, TOY RESEARCH METRIC caveats as this module's header comment.

const CALIBRATION_MIN_SAMPLE = 3;
const CONFIDENCE_BUCKET_WIDTH = 0.2;
const CONFIDENCE_BUCKET_COUNT = 5; // 0.0-0.2, 0.2-0.4, 0.4-0.6, 0.6-0.8, 0.8-1.0
// v3 §2/§9: every non-'error' action literal ScoringRow.action can carry (the port's now-narrowed
// action union minus 'error', which summarizeCalibration/summarizeRegimeSplit both filter out before
// ever keying a bucket by row.action) — 'error' is deliberately excluded, not just unused, so the
// Map<CalibratedAction, …> lookups below type-check against exactly what reaches them post-filter.
// The legacy 'long'/'flat' literals are gone (unreachable — see ScoringRow's own comment).
const CALIBRATED_ACTIONS = ['open_long', 'open_short', 'close', 'adjust', 'hold'] as const;
type CalibratedAction = (typeof CALIBRATED_ACTIONS)[number];

export interface CalibrationCell {
  readonly action: CalibratedAction;
  readonly confidenceLowerBound: number; // inclusive
  readonly confidenceUpperBound: number; // exclusive, except the top bucket (inclusive of 1)
  readonly count: number;
  readonly meanForwardReturnBps: number;
}

// Compact — only buckets with count >= CALIBRATION_MIN_SAMPLE are present (empty/thin buckets are
// omitted entirely rather than emitted as null noise; see this section's header comment).
export type CalibrationDigest = readonly CalibrationCell[];

function confidenceBucketIndex(confidence: number): number {
  const clamped = Math.min(1, Math.max(0, confidence));
  return Math.min(CONFIDENCE_BUCKET_COUNT - 1, Math.floor(clamped / CONFIDENCE_BUCKET_WIDTH));
}

/**
 * Buckets rows by (action × stated-confidence bucket) and reports count + mean t+1 forward return
 * in bps for every bucket that clears CALIBRATION_MIN_SAMPLE. Unlike computeCalibration's
 * exposure-based "directional edge" above, this reports the RAW forward return per action — 'long'
 * decisions that lose money read as a negative mean here regardless of confidence, which is exactly
 * the systematic-miscalibration signal the reflection prompt needs to see.
 *
 * Positional forward returns: rows MUST share one instrument (caller's contract — see
 * summarizeRecentDecisionOutcomes' docstring; same #37/5da2630 defect class otherwise).
 *
 * TOY RESEARCH METRIC — see this module's header comment.
 */
export function summarizeCalibration(rows: readonly ScoringRow[]): CalibrationDigest {
  const sums = new Map<string, { sum: number; count: number }>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.action === 'error' || row.confidence === null) continue;
    const fwd = forwardReturn(rows, i, CALIBRATION_HORIZON);
    if (fwd === null) continue;
    const key = `${row.action}:${confidenceBucketIndex(row.confidence)}`;
    const bucket = sums.get(key) ?? { sum: 0, count: 0 };
    bucket.sum += fwd * 10000;
    bucket.count += 1;
    sums.set(key, bucket);
  }
  const cells: CalibrationCell[] = [];
  for (const action of CALIBRATED_ACTIONS) {
    for (let idx = 0; idx < CONFIDENCE_BUCKET_COUNT; idx++) {
      const bucket = sums.get(`${action}:${idx}`);
      if (!bucket || bucket.count < CALIBRATION_MIN_SAMPLE) continue;
      cells.push({
        action,
        confidenceLowerBound: idx * CONFIDENCE_BUCKET_WIDTH,
        confidenceUpperBound: (idx + 1) * CONFIDENCE_BUCKET_WIDTH,
        count: bucket.count,
        meanForwardReturnBps: bucket.sum / bucket.count,
      });
    }
  }
  return cells;
}

// Trailing-window realized-volatility proxy — no candle table is available here (same constraint
// forwardReturn's own comment notes), so a rolling stdev of the journal's own `close` field is the
// only regime signal on hand. 10 closes is this module's first such window (no existing convention
// to reuse).
const VOLATILITY_WINDOW = 10;

// stdev of the `window` closes ending at (and including) row i; null until `window` closes are
// available (start of the group) or any close in the window is unrecorded.
function trailingStdev(rows: readonly ScoringRow[], i: number, window: number): number | null {
  const start = i - window + 1;
  if (start < 0) return null;
  const closes: number[] = [];
  for (let k = start; k <= i; k++) {
    const c = rows[k]!.close;
    if (c === null) return null;
    closes.push(toIndicatorFloat(c));
  }
  const mean = closes.reduce((sum, v) => sum + v, 0) / closes.length;
  const variance = closes.reduce((sum, v) => sum + (v - mean) ** 2, 0) / closes.length;
  return Math.sqrt(variance);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export interface RegimeActionStats {
  readonly action: CalibratedAction;
  readonly count: number;
  readonly meanForwardReturnBps: number;
}

export interface RegimeSplitDigest {
  readonly quiet: readonly RegimeActionStats[]; // trailing stdev <= median
  readonly active: readonly RegimeActionStats[]; // trailing stdev > median
}

/**
 * Splits the SAME per-action t+1 forward-return stats as summarizeCalibration above by
 * realized-volatility regime: each row's trailing VOLATILITY_WINDOW-close stdev is computed, the
 * median across all rows with a defined stdev splits the window into 'quiet' (<= median) and
 * 'active' (> median), and each half reports count + mean forward return in bps per action. Rows
 * without VOLATILITY_WINDOW prior closes in their own group (or with an undefined t+1 forward
 * return) are excluded from both halves — never silently placed in a default regime.
 *
 * Positional forward returns AND trailing stdevs: rows MUST share one instrument (caller's
 * contract — see summarizeRecentDecisionOutcomes' docstring; same #37/5da2630 defect class
 * otherwise).
 *
 * TOY RESEARCH METRIC — see this module's header comment.
 */
export function summarizeRegimeSplit(rows: readonly ScoringRow[]): RegimeSplitDigest {
  const stdevs = rows.map((_, i) => trailingStdev(rows, i, VOLATILITY_WINDOW));
  const definedStdevs = stdevs.filter((s): s is number => s !== null);
  if (definedStdevs.length === 0) return { quiet: [], active: [] };
  const splitPoint = median(definedStdevs);

  const quietSums = new Map<CalibratedAction, { sum: number; count: number }>();
  const activeSums = new Map<CalibratedAction, { sum: number; count: number }>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.action === 'error') continue;
    const stdev = stdevs[i];
    if (stdev === null || stdev === undefined) continue;
    const fwd = forwardReturn(rows, i, CALIBRATION_HORIZON);
    if (fwd === null) continue;
    const target = stdev <= splitPoint ? quietSums : activeSums;
    const bucket = target.get(row.action) ?? { sum: 0, count: 0 };
    bucket.sum += fwd * 10000;
    bucket.count += 1;
    target.set(row.action, bucket);
  }

  const finalize = (
    sums: Map<CalibratedAction, { sum: number; count: number }>,
  ): RegimeActionStats[] =>
    CALIBRATED_ACTIONS.flatMap((action) => {
      const bucket = sums.get(action);
      return bucket
        ? [{ action, count: bucket.count, meanForwardReturnBps: bucket.sum / bucket.count }]
        : [];
    });

  return { quiet: finalize(quietSums), active: finalize(activeSums) };
}

// ── Not-taken-option regret digest (P4, Design § Learning & measurement stack) ──────────────────
//
// Expanded counterfactual learning: scores the option the model DIDN'T take, mechanically, from
// forward candles — multiplying the learning signal per real bar at zero LLM cost. Two shapes:
//   - "declined entry": a 'hold' that resulted in FLAT (the model chose to stay out — not a hold
//     that merely maintains an existing position, which is already covered by summarizeRecentDecision
//     Outcomes' heldLong bucket). The only counterfactual this Pick'd ScoringRow shape can score
//     without a `direction`/payload field is "what if this had opened a LONG instead" — the SAME
//     assumption computeCalibration/directionalEdge's FLAT branch already makes throughout this file
//     (a decline is scored against the LONG side it declined). A short entry the model declined is
//     invisible here for the same reason legacy short positions are invisible to annotateResultingExposure.
//   - "delayed exit": an 'adjust' that resulted in a still-open LONG/SHORT (v2's 'adjust' only ever
//     fires while positioned in the real client — see B1/agentic.strategy.ts — so this is the normal
//     case, not a corrupt-data guard). The counterfactual is "what if this had closed instead" — the
//     delay's cost/earn IS exactly the forward move the still-open position rode.
// Both reduce to directionalEdge(exposure, fwd): declined entry uses the FLAT branch (a run-up after
// declining reads as a NEGATIVE regret — the flat choice left money on the table, mirroring
// directionalEdge(FLAT, fwd) = -fwd exactly); delayed exit uses the row's own resulting LONG/SHORT
// branch (a loss after the delay reads negative — the delay cost money; a gain reads positive — the
// delay paid). Horizon: CALIBRATION_HORIZON (t+1) only, NOT the full FORWARD_RETURN_HORIZONS set —
// this file's own established precedent for per-decision (as opposed to per-Scorecard aggregate)
// digests, see CALIBRATION_HORIZON's and the F1 digest's own "most immediate, least confounded"
// comments above; a compact per-decision digest, not a 3x-horizon line explosion.
//
// Positional forward returns: rows MUST share one instrument (same #37/5da2630 caller contract as
// summarizeRecentDecisionOutcomes/summarizeCalibration above).
//
// Exported as a pure function only — wiring this into the reflection prompt digest is a separate
// step (P3); this module just makes it importable and independently tested.
//
// TOY RESEARCH METRIC — see this module's header comment.

export interface RegretLine {
  readonly eventTime: number;
  readonly kind: 'declined_entry' | 'delayed_exit';
  // Signed, bps. Negative = the recorded choice (staying flat / delaying the exit) cost the model
  // money relative to the not-taken option; positive = the choice was directionally right anyway.
  readonly regretBps: number;
}

export interface RegretBucket {
  readonly count: number;
  readonly meanRegretBps: number | null; // null when count === 0
}

export interface RegretDigest {
  readonly lines: readonly RegretLine[];
  readonly declinedEntry: RegretBucket;
  readonly delayedExit: RegretBucket;
}

export function scoreNotTakenOptions(rows: readonly ScoringRow[]): RegretDigest {
  const exposures = annotateResultingExposure(rows);
  const lines: RegretLine[] = [];
  const declined: MutableBucket = { count: 0, sum: 0 };
  const delayed: MutableBucket = { count: 0, sum: 0 };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const resulting = exposures[i]!;
    const isDeclinedEntry = row.action === 'hold' && resulting === 'FLAT';
    const isDelayedExit = row.action === 'adjust' && resulting !== 'FLAT';
    if (!isDeclinedEntry && !isDelayedExit) continue;

    const fwd = forwardReturn(rows, i, CALIBRATION_HORIZON);
    if (fwd === null) continue;

    const regretBps = directionalEdge(isDeclinedEntry ? 'FLAT' : resulting, fwd) * 10000;
    lines.push({
      eventTime: row.eventTime,
      kind: isDeclinedEntry ? 'declined_entry' : 'delayed_exit',
      regretBps,
    });
    addToBucket(isDeclinedEntry ? declined : delayed, regretBps);
  }

  return {
    lines,
    declinedEntry: finalizeRegretBucket(declined),
    delayedExit: finalizeRegretBucket(delayed),
  };
}

function finalizeRegretBucket(bucket: MutableBucket): RegretBucket {
  return {
    count: bucket.count,
    meanRegretBps: bucket.count === 0 ? null : bucket.sum / bucket.count,
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
