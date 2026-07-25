import Decimal from 'decimal.js';
import type { AgentDecisionRow } from '../../../ports/agentic-strategy';

// ── Decision post-mortem digest for the reflection loop (X7) ──────────────────
//
// Extends counterfactual-scoring.ts's pattern (mechanically scoring journal decisions from their
// own recorded close series) with two post-mortem shapes the reflection prompt reads:
//   - THESIS post-mortems (secondary): for each closed round trip whose ENTRY carried a thesis,
//     grade direction correctness, the exit path the directives implied (which of TP/SL the close
//     series touched first), and hold time vs the maxHoldBars intent.
//   - HOLD post-mortems (primary): with ~zero round trips so far, the SKIPPED entry is the dominant
//     PnL event in the journal, so grading declined-entry HOLDS is the main deliverable.
//
// TOY RESEARCH METRIC — identical caveats to counterfactual-scoring.ts's header: thin, noisy,
// close-price-proxy, never a promotion input, never step-D certification (the agentic lane is
// permanently EXPERIMENT-ONLY per CLAUDE.md rule 4). It exists to give the reflection model a rough,
// consistent yardstick and — for the hold post-mortems — the anti-ratchet counterweight evidence
// (missed-entry rate) the loop otherwise never sees, since it only ever observes realized losses.
//
// LOAD-BEARING POPULATION SPLIT: this module grades HOLD DECISIONS ONLY — a `hold`/`adjust` that
// resulted in a FLAT book (an entry the model DECLINED). It NEVER grades unfilled/rejected maker
// ORDERS as regret: that population is execution data, not decision data (an N=25 study found 5/6
// such misses were dodged losers — teaching the model to chase would reverse a validated finding).
// The split is structurally enforced here because this module only ever sees agent_decisions journal
// rows (decisions), never order/fill rows — there is no order population to leak in.
//
// Money-path note: close/refPrice arrive as decimal STRINGS already minted (>0) by money.ts's price()
// at journal-write time; Decimal→number here mirrors counterfactual-scoring.ts's own toIndicatorFloat
// (never Number()/parseFloat(), both lint-banned outside src/domain). This is not a money path — no
// Price/Qty is minted or moved; every figure is an indicator-grade research metric.

// The directive fields a thesis post-mortem reads off a row's persisted plan. Declared with `thesis?`
// and `direction?` optional so a legacy AgentPlan-shaped plan (which the port types AgentDecisionRow.
// plan as, and which lacks both) is structurally assignable — the runtime plan_json DOES carry thesis
// on v2 rows (see trading.schema.ts's plan_json $type, passed through verbatim by readPlanJson), so a
// thesis-bearing row reads its thesis here while a legacy/thesis-less row simply reads undefined and
// skips cleanly (never a throw, never a fabricated grade).
interface PostMortemDirectives {
  readonly stopLossPct: string;
  readonly takeProfitPct: string;
  readonly maxHoldBars: number;
  readonly direction?: 'long' | 'short';
  readonly thesis?: string;
}

// Same Pick'd-row-plus-plain-symbol shape as counterfactual-scoring.ts's ScoringRow (SymbolId is
// assignable to string; grouping/adjacency is the only thing symbol drives). `plan` is added for the
// thesis post-mortems — AgentDecisionRow.plan (AgentPlan | null | undefined) is assignable to
// `PostMortemDirectives | null | undefined` because every field this module requires is present on
// AgentPlan and the extras (thesis/direction) are optional.
export type PostMortemRow = Pick<
  AgentDecisionRow,
  'eventTime' | 'action' | 'refPrice' | 'close'
> & {
  readonly symbol: string;
  readonly plan?: PostMortemDirectives | null;
};

export interface DecisionPostMortemOptions {
  // Perp (shorts-capable) lane ⇒ a declined hold's would-be entry could have gone EITHER direction, so
  // a favorable move is |return|; spot (default) is long-only, so favorable is the long side only.
  // Threaded from ReflectionService.shortsEnabled at the call site (never read off a row's venue),
  // mirroring how reflection already threads shortsEnabled into its system prompt / validator gate.
  // Default false respects the N=25 dodged-losers finding — a spot lane never grades a decline it
  // could not have traded as a miss.
  readonly shortsEnabled?: boolean;
}

export interface ThesisPostMortemLine {
  readonly eventTime: number;
  readonly line: string;
}

export interface HoldPostMortemAggregate {
  readonly gradedHolds: number;
  readonly missedEntries: number;
  readonly correctHolds: number;
  readonly missedEntryRate: number | null; // missedEntries / gradedHolds; null when gradedHolds === 0
  readonly correctHoldRate: number | null; // correctHolds / gradedHolds; null when gradedHolds === 0
}

export interface HoldBucketStats {
  readonly bucket: string;
  readonly graded: number;
  readonly missedEntryRate: number;
  // Mean of the per-hold MAX FAVORABLE EXCURSION (the classification quantity — max, within the
  // horizon, of the tradeable-direction return), as a percent. Named for what it is so the model
  // never misreads a max excursion as a net/endpoint PnL.
  readonly meanFavorableExcursionPct: number;
}

export interface DecisionPostMortemDigest {
  readonly thesisPostMortems: readonly ThesisPostMortemLine[];
  readonly holdPostMortem: HoldPostMortemAggregate;
  readonly hourBuckets: readonly HoldBucketStats[]; // UTC hour-of-day, bucketed 0-5/6-11/12-17/18-23
  readonly dayTypeBuckets: readonly HoldBucketStats[]; // weekday vs weekend (UTC)
  // Present only when computable AND actionable (see buildAdvisory): entry rate < 1/day while
  // declined-entry holds were graded ⇒ a RECORDED rank-filter relaxation is warranted. Advisory-only,
  // so it fails OPEN — omitted whenever the entry rate can't be computed, never a mechanical change.
  readonly advisory?: string;
}

// The declined-hold replay horizon. A declined hold carries NO maxHoldBars directive (it opened
// nothing), so a single representative "would-be max hold" is used — 24 bars sits mid-range of the
// 16–64-bar window the program treats as a plausible hold length. A hold is graded only when this
// many same-instrument forward closes exist (else excluded, exactly as counterfactual-scoring drops
// rows within `horizon` bars of the group end).
const HOLD_POSTMORTEM_HORIZON_BARS = 24;
// A favorable excursion strictly above this (percent) within the horizon is a MISSED ENTRY; at or
// below it the hold was CORRECT (price went nowhere or against). 1% mirrors the anti-ratchet prompt's
// own ">1% within the would-be max-hold horizon" threshold in reflection.service.ts.
const MISSED_ENTRY_THRESHOLD_PCT = 1;
// Bound on the per-trade thesis lines emitted (most recent first-dropped), so the whole digest stays
// ≤ ~15 lines: ≤6 thesis + 1 hold aggregate + ≤4 hour + ≤2 day-type + ≤1 advisory.
const MAX_THESIS_LINES = 6;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toIndicatorFloat(decimalString: string): number {
  return new Decimal(decimalString).toNumber();
}

function fmtSignedPct(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

type Exposure = 'LONG' | 'SHORT' | 'FLAT';

// The exposure held AFTER each row's action is applied, parallel to the input (same length/order) —
// a local copy of counterfactual-scoring.ts's annotateResultingExposure (not exported there). v3
// §2/§9 vocabulary: 'open_long'/'open_short'/'close', and 'adjust'/'hold'/'error' as no-ops.
// Single-instrument caller contract (reflection passes P7 strategy-scoped rows), same as every
// counterfactual-scoring digest.
function annotateResultingExposure(rows: readonly PostMortemRow[]): Exposure[] {
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
      default:
        break;
    }
    exposures.push(position);
  }
  return exposures;
}

// One closed round trip reconstructed off the journal's own action field (rows oldest→newest), with
// the entry row's index/price/side/plan retained so a thesis post-mortem can replay the hold. Mirrors
// reconstructClosedTrades' pairing rules (open_*/close; adjust/hold/error never open or close; a
// same-side open while already open is ignored) but keeps the indices and the entry plan the
// service's own summary drops.
interface ReconstructedTrade {
  readonly entryIndex: number;
  readonly exitIndex: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly side: 'LONG' | 'SHORT';
  readonly plan: PostMortemDirectives | null;
}

function reconstructTrades(rows: readonly PostMortemRow[]): ReconstructedTrade[] {
  const trades: ReconstructedTrade[] = [];
  let open: {
    index: number;
    price: number;
    side: 'LONG' | 'SHORT';
    plan: PostMortemDirectives | null;
  } | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const priceStr = row.refPrice ?? row.close;
    if (!priceStr) continue;
    if (row.action === 'open_long' && open === null) {
      open = { index: i, price: toIndicatorFloat(priceStr), side: 'LONG', plan: row.plan ?? null };
    } else if (row.action === 'open_short' && open === null) {
      open = { index: i, price: toIndicatorFloat(priceStr), side: 'SHORT', plan: row.plan ?? null };
    } else if (row.action === 'close' && open !== null) {
      trades.push({
        entryIndex: open.index,
        exitIndex: i,
        entryPrice: open.price,
        exitPrice: toIndicatorFloat(priceStr),
        side: open.side,
        plan: open.plan,
      });
      open = null;
    }
  }
  return trades;
}

// Which directive level the close series between entry and exit touched FIRST — 'tp'/'sl', or 'none'
// when neither was reached (the position closed by max-hold or a manual/venue exit). Exit-path
// realism honesty note: journal rows carry only `close` (no intrabar high/low), so a venue TP that
// fills on TOUCH is approximated here by close-crossing — this UNDER-counts TP fills a real intrabar
// high would have hit; the executor's own STOP is a bar-close check natively (plan-executor.ts), so
// its close-crossing grade is exact. The row does not journal the actual exit reason, so this grades
// only what the directives + realized closes imply, and never tries to reconcile with the true exit.
function firstTouchedLevel(
  rows: readonly PostMortemRow[],
  trade: ReconstructedTrade,
): 'tp' | 'sl' | 'none' {
  const plan = trade.plan;
  if (!plan) return 'none';
  const entry = new Decimal(trade.entryPrice);
  const sl = new Decimal(plan.stopLossPct);
  const tp = new Decimal(plan.takeProfitPct);
  const long = trade.side === 'LONG';
  const stopPrice = long ? entry.mul(new Decimal(1).minus(sl)) : entry.mul(new Decimal(1).plus(sl));
  const takePrice = long ? entry.mul(new Decimal(1).plus(tp)) : entry.mul(new Decimal(1).minus(tp));
  for (let i = trade.entryIndex + 1; i <= trade.exitIndex; i++) {
    const closeStr = rows[i]!.close;
    if (closeStr === null) continue;
    const close = new Decimal(closeStr);
    // Stop is bar-close (long: close ≤ stop; short: close ≥ stop); take-profit is touch-approximated
    // by the same close crossing (long: close ≥ tp; short: close ≤ tp). Stop is checked first so a bar
    // that would satisfy both reads as the adverse outcome — the pessimistic, never-flattering choice.
    if (long ? close.lte(stopPrice) : close.gte(stopPrice)) return 'sl';
    if (long ? close.gte(takePrice) : close.lte(takePrice)) return 'tp';
  }
  return 'none';
}

// Compact, DETERMINISTIC per-trade line — every number is explicitly formatted (toFixed) so the
// pinned-string spec never flakes on Decimal→number float tails. Shape:
//   "<SIDE> dir=<ok|miss> exit=<tp|sl|none> hold=<held>/<maxHold>b pnl=<±X.X%>"
function renderThesisLine(rows: readonly PostMortemRow[], trade: ReconstructedTrade): string {
  const long = trade.side === 'LONG';
  const pnlPct = long
    ? ((trade.exitPrice - trade.entryPrice) / trade.entryPrice) * 100
    : ((trade.entryPrice - trade.exitPrice) / trade.entryPrice) * 100;
  const dir = pnlPct > 0 ? 'ok' : 'miss';
  const exit = firstTouchedLevel(rows, trade);
  const held = trade.exitIndex - trade.entryIndex;
  const maxHold = trade.plan?.maxHoldBars ?? 0;
  return `${trade.side} dir=${dir} exit=${exit} hold=${held}/${maxHold}b pnl=${fmtSignedPct(pnlPct)}`;
}

// One graded declined-entry hold: its UTC event time and its max favorable excursion (percent) over
// the horizon, plus whether that cleared the missed-entry threshold.
interface GradedHold {
  readonly eventTime: number;
  readonly favorableExcursionPct: number;
  readonly missedEntry: boolean;
}

// A hold is a declined entry iff it results in a FLAT book — action 'hold' OR 'adjust' (an
// adjust-noop on a flat book carries the same "declined to enter" meaning; grading only 'hold' would
// silently drop that population). Graded only when HOLD_POSTMORTEM_HORIZON_BARS forward closes exist.
function gradeHolds(rows: readonly PostMortemRow[], shortsEnabled: boolean): GradedHold[] {
  const exposures = annotateResultingExposure(rows);
  const graded: GradedHold[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const declinedEntry =
      (row.action === 'hold' || row.action === 'adjust') && exposures[i] === 'FLAT';
    if (!declinedEntry) continue;
    if (i + HOLD_POSTMORTEM_HORIZON_BARS >= rows.length) continue;
    const p0Str = row.close;
    if (p0Str === null) continue;
    const p0 = toIndicatorFloat(p0Str);
    let maxFavorable = Number.NEGATIVE_INFINITY;
    let complete = true;
    for (let k = i + 1; k <= i + HOLD_POSTMORTEM_HORIZON_BARS; k++) {
      const cStr = rows[k]!.close;
      if (cStr === null) {
        complete = false;
        break;
      }
      const ret = (toIndicatorFloat(cStr) - p0) / p0;
      // Spot is long-only (favorable = the long side); perp could have opened either way (favorable =
      // the better of the two directions, i.e. the absolute move).
      const favorable = shortsEnabled ? Math.abs(ret) : ret;
      if (favorable > maxFavorable) maxFavorable = favorable;
    }
    if (!complete) continue;
    const favorableExcursionPct = maxFavorable * 100;
    graded.push({
      eventTime: row.eventTime,
      favorableExcursionPct,
      missedEntry: favorableExcursionPct > MISSED_ENTRY_THRESHOLD_PCT,
    });
  }
  return graded;
}

function hourBucketLabel(eventTime: number): string {
  const hour = new Date(eventTime).getUTCHours();
  const lo = Math.floor(hour / 6) * 6;
  return `h${lo}-${lo + 5}`;
}

function dayTypeLabel(eventTime: number): string {
  const day = new Date(eventTime).getUTCDay();
  return day === 0 || day === 6 ? 'weekend' : 'weekday';
}

function bucketize(
  graded: readonly GradedHold[],
  label: (eventTime: number) => string,
): HoldBucketStats[] {
  const groups = new Map<string, { graded: number; missed: number; excursionSum: number }>();
  for (const g of graded) {
    const key = label(g.eventTime);
    const bucket = groups.get(key) ?? { graded: 0, missed: 0, excursionSum: 0 };
    bucket.graded += 1;
    if (g.missedEntry) bucket.missed += 1;
    bucket.excursionSum += g.favorableExcursionPct;
    groups.set(key, bucket);
  }
  return Array.from(groups.entries())
    .map(([bucket, s]) => ({
      bucket,
      graded: s.graded,
      missedEntryRate: s.missed / s.graded,
      meanFavorableExcursionPct: s.excursionSum / s.graded,
    }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
}

// Advisory (RECORDED playbook revision, never a silent mechanical change): only when the entry rate
// is genuinely computable (a real, positive time span AND ≥1 entry action) AND declined-entry holds
// were actually graded AND that entry rate is under one per day. Fails OPEN — any missing input
// omits the line rather than fabricating a rate from a degenerate span.
function buildAdvisory(
  rows: readonly PostMortemRow[],
  aggregate: HoldPostMortemAggregate,
): string | undefined {
  if (aggregate.gradedHolds === 0 || aggregate.missedEntryRate === null) return undefined;
  let entries = 0;
  for (const row of rows) {
    if (row.action === 'open_long' || row.action === 'open_short') {
      entries += 1;
    }
  }
  if (entries === 0) return undefined;
  const spanMs = rows[rows.length - 1]!.eventTime - rows[0]!.eventTime;
  if (spanMs <= 0) return undefined;
  const days = spanMs / MS_PER_DAY;
  const entriesPerDay = entries / days;
  if (entriesPerDay >= 1) return undefined;
  return (
    `entry rate ${entriesPerDay.toFixed(2)}/day is below 1/day while ` +
    `${(aggregate.missedEntryRate * 100).toFixed(0)}% of ${aggregate.gradedHolds} graded holds ` +
    'missed a >1% move — a rank-filter/entry-gate relaxation is warranted; record it in the changelog.'
  );
}

/**
 * Summarizes an oldest→newest, single-instrument decision window into thesis + hold post-mortems for
 * the reflection prompt. Single-instrument caller contract (same #37/5da2630 defect class as
 * counterfactual-scoring's digests — reflection passes P7 strategy-scoped rows).
 *
 * TOY RESEARCH METRIC — see this module's header comment. Never step-D certification, never a
 * promotion input at current trade rates.
 */
export function summarizeDecisionPostMortems(
  rows: readonly PostMortemRow[],
  opts: DecisionPostMortemOptions = {},
): DecisionPostMortemDigest {
  const shortsEnabled = opts.shortsEnabled ?? false;

  const thesisPostMortems: ThesisPostMortemLine[] = reconstructTrades(rows)
    .filter((trade) => trade.plan?.thesis !== undefined)
    .map((trade) => ({
      eventTime: rows[trade.entryIndex]!.eventTime,
      line: renderThesisLine(rows, trade),
    }))
    .slice(-MAX_THESIS_LINES);

  const graded = gradeHolds(rows, shortsEnabled);
  const missedEntries = graded.filter((g) => g.missedEntry).length;
  const gradedHolds = graded.length;
  const holdPostMortem: HoldPostMortemAggregate = {
    gradedHolds,
    missedEntries,
    correctHolds: gradedHolds - missedEntries,
    missedEntryRate: gradedHolds === 0 ? null : missedEntries / gradedHolds,
    correctHoldRate: gradedHolds === 0 ? null : (gradedHolds - missedEntries) / gradedHolds,
  };

  const advisory = buildAdvisory(rows, holdPostMortem);
  return {
    thesisPostMortems,
    holdPostMortem,
    hourBuckets: bucketize(graded, hourBucketLabel),
    dayTypeBuckets: bucketize(graded, dayTypeLabel),
    ...(advisory !== undefined ? { advisory } : {}),
  };
}
