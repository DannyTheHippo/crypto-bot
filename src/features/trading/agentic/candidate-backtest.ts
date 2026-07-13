import Decimal from 'decimal.js';
import type { AgentDecisionRow, AgentPlan, AgentUsage } from '../../../ports/agentic-strategy';
import { buildPlaybookBlock, buildSystemPrompt } from './agent-prompt';
import { evaluatePlan } from './plan-executor';
import { DEFAULT_FLOOR_PROFILE, replayPlanRow, type PlanReplayResult } from './entry-rate-floor';

// Mint-time candidate-vs-champion OFFLINE EXPECTANCY BACKTEST — the learning accelerant this module
// exists for: instead of waiting weeks for a live A/B trip count, replay BOTH the draft candidate and
// the current champion playbook against the same recorded rows and simulate what each 'long' plan
// would have done, giving reflection.service.ts a verdict prior in hours. One stage further along the
// entry-rate floor's own pipeline (entry-rate-floor.ts): the floor asks "does this playbook ever
// enter", this module asks "when it enters, is it actually profitable relative to the champion".
//
// FORWARD-CANDLE APPROXIMATION (prominent by design — read before trusting a number this module
// produces): there is no in-process candle-history source available to a reflection-time replay (no
// journal/adapter here exposes OHLC beyond what agent_decisions itself recorded). Rather than add a
// new network fetcher, the forward path a simulated plan walks is built from the RECORDED ROWS
// THEMSELVES — each row's own `close`, grouped by symbol and ordered by event time. Since decides land
// roughly one per ~15m bar while the lane is active, this is a SPARSE, decide-cadence forward path,
// not the strategy's true intra-bar candle series — a plan's stop/take-profit may have touched and
// reverted between two consecutive recorded closes without ever showing up here. Rows with too few
// forward points for their own plan's maxHoldBars are marked unsimulatable and excluded (see
// simulateLongRoundTrip) rather than extrapolated. Treat every bps figure this module returns as a
// coarse, decide-cadence-resolution estimate — directionally useful for a candidate-vs-champion
// COMPARISON (both arms suffer the same approximation), never a precise expectancy.

// Round-trip fee fraction subtracted from every simulated exit — matches CLAUDE.md's own
// round-trip-cost convention used elsewhere in this lane (reflection.service.ts's
// REFLECTION_ROUND_TRIP_FEE_BPS = 20bps is the PROMPT's stated cost; this backtest's own maker+taker
// pairing nets to the same 20bps = 0.0020 fraction the task spec pins directly).
const ROUND_TRIP_FEE_FRACTION = new Decimal('0.0020');

// A row needs at least this share of its own plan's maxHoldBars worth of forward closes before its
// simulated outcome is trusted — below it, the sparse recorded-row forward path (see this file's
// header comment) is too short to tell a real stop/TP/max-hold outcome apart from a window that
// simply ran out of recorded data.
const MIN_FORWARD_COVERAGE = 0.25;

export interface CandidateBacktestConfig {
  readonly apiKey: string;
  // The DECIDE model — see entry-rate-floor.ts's EntryRateFloorConfig.model comment.
  readonly model: string;
  readonly baseUrl?: string;
  readonly timeoutMs: number;
  readonly candidatePlaybook: string;
  readonly championPlaybook: string;
  readonly minEdgeMultiple: string;
  readonly minRr: string;
}

export interface CandidateBacktestArmResult {
  readonly consults: number;
  readonly entries: number;
  readonly simulatedRoundTrips: number;
  // 'long' entries excluded from the expectancy math — no plan on the response, or too few forward
  // closes for the row's own plan.maxHoldBars (see MIN_FORWARD_COVERAGE) — counted, never guessed at.
  readonly unsimulatableEntries: number;
  // 0 when simulatedRoundTrips is 0 (never NaN — a callers' margin comparison must stay a plain
  // number even on an empty sample; the min-trips gate upstream is what actually protects against
  // judging on a thin sample).
  readonly meanNetBps: number;
  readonly totalNetBps: number;
  readonly usages: readonly AgentUsage[];
}

export type CandidateBacktestResult =
  | {
      readonly candidate: CandidateBacktestArmResult;
      readonly champion: CandidateBacktestArmResult;
      // Rows where both arms produced a parseable action and the two actions differ — a cheap
      // additional signal alongside the expectancy numbers (a candidate that mostly agrees with the
      // champion but rarely disagrees is a much smaller behavioral change than the bps gap alone
      // suggests).
      readonly divergentDecisions: number;
      // Per-row champion replay results, same order as the input rows — returned so the caller can
      // cache them across a retry: the champion arm is invariant within one reflection attempt
      // (same playbook, same rows), so re-replaying it on the retry draft would burn rows-many
      // identical API calls for identical numbers (reviewer finding).
      readonly championReplays: readonly PlanReplayResult[];
    }
  | { readonly skipped: string };

// #37 lesson (never mix symbols' candles): groups `rows` by symbol, preserving each symbol's own
// relative oldest→newest order (the caller's rows are already oldest→newest lane-wide per
// AgentDecisionJournalPort.recent's ordering contract, so a stable per-symbol filter keeps that
// order), then indexes every row's id to the closes of the LATER rows of the SAME symbol only.
function buildForwardCloseIndex(
  rows: readonly AgentDecisionRow[],
): ReadonlyMap<string, readonly string[]> {
  const bySymbol = new Map<string, AgentDecisionRow[]>();
  for (const row of rows) {
    const key = String(row.symbol);
    const list = bySymbol.get(key);
    if (list) list.push(row);
    else bySymbol.set(key, [row]);
  }
  const index = new Map<string, readonly string[]>();
  for (const symbolRows of bySymbol.values()) {
    for (let i = 0; i < symbolRows.length; i++) {
      index.set(
        symbolRows[i]!.id,
        symbolRows.slice(i + 1).map((r) => r.close!),
      );
    }
  }
  return index;
}

// Walks plan-executor's own evaluatePlan bar-by-bar over `forwardCloses` (entry assumed filled at
// `entryClose`, the row's own decision close — this backtest never models the resting-entry window),
// stopping at the first stop/take_profit/max_hold exit. If maxHoldBars worth of forward data isn't
// available but MIN_FORWARD_COVERAGE's floor is cleared, the walk uses whatever forward closes exist
// and falls back to the LAST available close as an approximate exit (the sparse path ran out before
// evaluatePlan ever fired an exit of its own) — never fabricates data beyond what was recorded.
// Returns null (unsimulatable) below MIN_FORWARD_COVERAGE.
export function simulateLongRoundTrip(
  entryClose: string,
  plan: AgentPlan,
  forwardCloses: readonly string[],
): { readonly netBps: number } | null {
  const minPoints = Math.ceil(plan.maxHoldBars * MIN_FORWARD_COVERAGE);
  if (forwardCloses.length < minPoints) return null;

  const walkLen = Math.min(forwardCloses.length, plan.maxHoldBars);
  let exitClose = forwardCloses[walkLen - 1]!;
  for (let barsElapsed = 1; barsElapsed <= walkLen; barsElapsed++) {
    const closePrice = forwardCloses[barsElapsed - 1]!;
    const action = evaluatePlan({
      state: { plan, entryPrice: entryClose, planStartedBar: 0, barsElapsed },
      closePrice,
      positionSide: 'LONG',
      hasRestingEntry: false,
    });
    if (action.type === 'exit') {
      exitClose = closePrice;
      break;
    }
  }

  const netFraction = new Decimal(exitClose)
    .div(entryClose)
    .minus(1)
    .minus(ROUND_TRIP_FEE_FRACTION);
  return { netBps: netFraction.mul(10_000).toNumber() };
}

interface ArmAccumulator {
  consults: number;
  entries: number;
  simulatedRoundTrips: number;
  unsimulatableEntries: number;
  totalNetBps: number;
  usages: AgentUsage[];
}

function newArmAccumulator(): ArmAccumulator {
  return {
    consults: 0,
    entries: 0,
    simulatedRoundTrips: 0,
    unsimulatableEntries: 0,
    totalNetBps: 0,
    usages: [],
  };
}

function accumulateArm(
  acc: ArmAccumulator,
  result: PlanReplayResult,
  row: AgentDecisionRow,
  forwardCloses: ReadonlyMap<string, readonly string[]>,
): void {
  if (result.usage) acc.usages.push(result.usage);
  if (!result.ok) return;
  acc.consults += 1;
  if (result.action !== 'long') return;
  acc.entries += 1;
  if (!result.plan) {
    acc.unsimulatableEntries += 1;
    return;
  }
  const sim = simulateLongRoundTrip(row.close!, result.plan, forwardCloses.get(row.id) ?? []);
  if (sim === null) {
    acc.unsimulatableEntries += 1;
    return;
  }
  acc.simulatedRoundTrips += 1;
  acc.totalNetBps += sim.netBps;
}

function finalizeArm(acc: ArmAccumulator): CandidateBacktestArmResult {
  return {
    consults: acc.consults,
    entries: acc.entries,
    simulatedRoundTrips: acc.simulatedRoundTrips,
    unsimulatableEntries: acc.unsimulatableEntries,
    meanNetBps: acc.simulatedRoundTrips > 0 ? acc.totalNetBps / acc.simulatedRoundTrips : 0,
    totalNetBps: acc.totalNetBps,
    usages: acc.usages,
  };
}

// Replays `rows` (recorded AgentDecisionRow rows, newest-N, ALREADY filtered by the caller to
// non-null close/inputPayload and a real ('claude'-prefixed) model, regardless of action — unlike the
// entry-rate floor's FLAT-only filter, this backtest wants the full decision mix) against BOTH the
// candidate and champion playbook, row-by-row (candidate then champion per row, so a per-row
// divergence compare needs no extra bookkeeping), sequentially — same small-batch, degrade-not-abort
// convention as measureEntryRate. Never throws.
export async function runCandidateBacktest(
  cfg: CandidateBacktestConfig,
  rows: readonly AgentDecisionRow[],
  fetchFn: typeof fetch,
  // Same-order per-row champion replays from a prior invocation on the SAME rows (a retry within
  // one reflection attempt) — skips the champion arm's API calls entirely. Ignored unless the
  // length matches rows (a mismatch means the corpus changed and the cache is unusable).
  cachedChampionReplays?: readonly PlanReplayResult[],
): Promise<CandidateBacktestResult> {
  if (rows.length === 0) {
    return { skipped: 'no rows to replay' };
  }

  const systemPrompt = buildSystemPrompt(DEFAULT_FLOOR_PROFILE, {
    planMode: true,
    minEdgeMultiple: cfg.minEdgeMultiple,
    minRr: cfg.minRr,
  });
  const candidateBlock = buildPlaybookBlock(cfg.candidatePlaybook);
  const championBlock = buildPlaybookBlock(cfg.championPlaybook);
  const forwardCloses = buildForwardCloseIndex(rows);
  const reuseChampion =
    cachedChampionReplays !== undefined && cachedChampionReplays.length === rows.length;

  const candidateArm = newArmAccumulator();
  const championArm = newArmAccumulator();
  const championReplays: PlanReplayResult[] = [];
  let divergentDecisions = 0;

  for (const [i, row] of rows.entries()) {
    const candidateResult = await replayPlanRow(
      cfg,
      systemPrompt,
      candidateBlock,
      row.inputPayload!,
      fetchFn,
    );
    const championResult = reuseChampion
      ? cachedChampionReplays[i]!
      : await replayPlanRow(cfg, systemPrompt, championBlock, row.inputPayload!, fetchFn);
    championReplays.push(championResult);
    accumulateArm(candidateArm, candidateResult, row, forwardCloses);
    accumulateArm(championArm, championResult, row, forwardCloses);
    if (
      candidateResult.ok &&
      championResult.ok &&
      candidateResult.action !== championResult.action
    ) {
      divergentDecisions += 1;
    }
  }

  return {
    candidate: finalizeArm(candidateArm),
    champion: finalizeArm(championArm),
    divergentDecisions,
    championReplays,
  };
}
