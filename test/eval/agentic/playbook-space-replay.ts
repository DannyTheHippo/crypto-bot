// Playbook-space replay ENGINE — preregistered in
// research/studies/playbook-space-replay-2026-07-28.md. Not a test file (the call site is
// playbook-space-replay.spec.ts); see fixtures.ts's own header for why Vitest never picks this up.
//
// THE QUESTION: the learning loop's entire mechanism is search over PLAYBOOK TEXT — reflection
// drafts a revision, the A/B routes traffic, the promotion gate keeps the winner. So "runtime
// learning will find profitability" is exactly the claim that somewhere in playbook space there is a
// text whose entries clear the fee. This replays a deliberately wide span of twelve playbooks —
// including the two the live objective structurally forbids (trade-almost-never, inverted) — against
// the same recorded FLAT market states that produced the -16.9 bps ENTRIES verdict, scored on the
// identical metric, against a bar frozen before the first call.
//
// FAILURE DIRECTION: this is a measurement harness that gates nothing and can authorise nothing. It
// fails LOUD and CLOSED on a broken precondition (corpus hash mismatch, scorer sanity failure, an arm
// the live validator would reject) rather than emitting a number that looks like evidence. The USD
// meter is the one exception in spirit: it fails closed on ATTEMPT START (never begins a call that
// could cross the cap), mirroring AttemptScopedBudget's own posture (agent-budget.ts:126) after the
// 2026-07-20 Opus runaway spent $2.48 against a $1.50 stop.
//
// This module makes paid network calls. It is research, OFF the production test gate.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import Decimal from 'decimal.js';
import {
  buildPlaybookBlock,
  buildSystemPrompt,
} from '../../../src/features/strategy/agentic/agent-prompt';
import {
  DEFAULT_FLOOR_PROFILE,
  replayPlanRow,
  type PlanReplayCallConfig,
} from '../../../src/features/strategy/agentic/entry-rate-floor';
import { validatePlaybook } from '../../../src/features/strategy/agentic/playbook-validator';
import { PLAYBOOK_ARMS, type PlaybookArm } from './playbook-space-arms';

// Repo-root-relative, matching this codebase's own research-harness convention
// (test/backtest/edge-tournament/run-tournament.ts) — `import.meta` is unavailable under the
// tsconfig module setting these files compile with.
const DATA = join(process.cwd(), 'test', 'eval', 'agentic', 'data');
const CANDLES = join(process.cwd(), 'test', 'backtest', 'data');

// ── frozen constants (preregistration § The bar / § Budget) ──────────────────────────────────────
export const HORIZONS = [1, 4, 8, 24] as const;
/** Required gross edge per trip at demo fees — state.md standing verdict. */
export const REQUIRED_EDGE_BPS = 13.0;

/**
 * The MODEL AXIS, declared up front (Amendment 4).
 *
 * The study originally held the decide model fixed at the champion and treated other models as
 * separate trials. That answered "can THIS lane become profitable". The question actually being
 * asked is **which lane is best and can any of them become profitable** — so the model is a
 * first-class factor, and the family the correction protects is (models x arms x horizons), not
 * (arms x horizons).
 *
 * Declared here, before any result exists, because a denominator chosen after seeing which models
 * were run is not a correction at all. Each model is executed as its own process (one result file
 * each) purely for operational convenience; the STATISTICS are joint, and `aggregateVerdict` below
 * is what actually decides.
 */
export const MODEL_AXIS = ['claude-sonnet-5', 'kimi-k3'] as const;

/** state.md: "Never act on a sub-n>=12 cell" — the horizon study's n=11 cell reversed at n=84. */
export const MIN_ENTRIES = 12;

/** models x arms x horizons if every arm ran on every model. Reported for comparison only. */
export const FULL_DESIGN_CELLS = MODEL_AXIS.length * PLAYBOOK_ARMS.length * HORIZONS.length;

// ── Amendment 5: the REDUCED design, and the rule that sizes it ──────────────────────────────────
/**
 * FROZEN ARM PRIORITY — the order in which arms enter the edge tier, fixed before any per-call cost
 * was measured and before any arm was scored.
 *
 * Why an ORDER rather than a chosen subset: the funded budget ($100 Anthropic — of which the live lane
 * is the first claim — and $15 Moonshot) does not buy twelve arms on two models, so the arm COUNT has
 * to fall out of a measured per-call cost. Freezing the order now makes the count the only free
 * parameter, which removes every opportunity to pick arms once something is known about them. That is
 * the whole point of pre-registration and precisely the discipline runs 1 and 2 lacked.
 *
 * The ranking is on prior and on EXPECTED POWER — both computable before any call:
 *
 *   1-2   the arms the MODEL AXIS is compared on: the live status quo, and the only arm carrying a
 *         positive-prior lead. If the two models differ, these are where it shows.
 *   3-6   distinct hypotheses whose entry rates should clear MIN_ENTRIES at full row depth.
 *   7-9   further lineage and filter variants.
 *   10-12 arms a PRE-RUN power calculation says cannot produce a powered cell on this corpus:
 *         `high_conviction_only` fires roughly 1 in 20 (expected n approximately 19 — marginal),
 *         `trade_almost_never` is built to abstain, and `one_symbol_btc` is capped by the ~15 BTC rows
 *         the corpus holds. They rank last because paying for them buys an UNDERPOWERED verdict, not
 *         because of anything observed. The lever tier below still covers all three.
 */
export const ARM_PRIORITY = [
  'champion_v8',
  'inverted',
  'minimal',
  'momentum_pure',
  'meanrev_pure',
  'shorts_only',
  'candidate_v9',
  'seed_v1',
  'leaders_only',
  'high_conviction_only',
  'trade_almost_never',
  'one_symbol_btc',
] as const;

/**
 * The LEVER tier: every arm, few rows, and **no edge test whatsoever**.
 *
 * Pre-registration weakness 6 is that playbook prose may be a blunt instrument — an arm told "only
 * enter on strongest confluence" may not actually become more selective. That is a question about
 * ENTRY RATE and DECISION CHANGE, which are proportions: 60 rows pin a proportion to about +/-6
 * points, while pinning a 29 bps-SD return mean needs hundreds. So the cheap question gets the cheap
 * design, and the expensive question gets the rows.
 *
 * Because this tier tests no hypothesis against the bar, it contributes NOTHING to the Bonferroni
 * family. That exclusion is only honest as long as it is never scored for edge, so `verdictFor` is
 * never called on it and the results file marks the tier explicitly.
 */
export const LEVER_PROBE_ROWS = 60;

/**
 * The lever tier is a DIAGNOSTIC and must never outbid the study.
 *
 * Twelve arms x 60 rows is 720 calls — more than the edge tier itself once a call costs the live-path
 * figure, at which point the cheap question would consume most of the budget and starve the expensive
 * one. So it is capped at a share of the lead budget and its row count shrinks to fit; below
 * MIN_LEVER_ROWS a proportion is too wide to be worth anything (30 rows is about +/-9 points) and the
 * tier is dropped entirely rather than run as decoration.
 */
export const LEVER_TIER_BUDGET_SHARE = 0.2;
export const MIN_LEVER_ROWS = 30;

/** Ceilings, so the sizing rule cannot run away if a measured cost comes back implausibly cheap. */
export const MAX_SHARED_EDGE_ARMS = 4;
export const MAX_LEAD_ONLY_EDGE_ARMS = 5;

/** Rows in the calibration probe — enough to measure a per-call cost, cheap enough to be disposable. */
export const CALIBRATION_ROWS = 40;

/**
 * The row floor below which no cell can be powered, so no budget is worth spending.
 *
 * At the corpus's own entry rate (roughly 16-20%: 61 entries over 386 recorded FLAT rows, and 20.5%
 * measured in the 2026-07-30 calibration) MIN_ENTRIES=12 needs about 60-75 rows. 150 is that with
 * margin for an arm more selective than the champion — below it the study buys UNDERPOWERED cells,
 * which is worse than buying nothing because they look like results.
 */
export const MIN_EDGE_ROWS = 150;

/**
 * BUDGET ALLOCATION (owner funded 2026-07-30: Anthropic $100, Moonshot $15).
 *
 * These are the study's allocations, deliberately NOT the account balances.
 *
 * The Anthropic account pays for the LIVE LANE as well as this study, and the lane has first claim:
 * measured decide-path spend over the six days with data is **$1.86/day mean, $3.63 worst day**
 * (`agent_decisions`, 282 calls at $0.039668/call). Allocating $35 to the study leaves $65 of lane
 * runway — about 35 days at the mean rate, 18 at the worst. A study that starves the bot it is
 * studying is not a saving.
 *
 * Moonshot runs no lane, so its whole balance is available; $13 of $15 leaves a margin so a metering
 * error cannot hard-stop the account mid-run — which is the failure that cost three hours on
 * 2026-07-28.
 */
export const LEAD_STUDY_BUDGET_USD = 35;
export const FOLLOW_STUDY_BUDGET_USD = 13;

export interface StudyDesign {
  /** Arms edge-tested on EVERY model in MODEL_AXIS — the model comparison runs on exactly these. */
  readonly sharedEdgeArms: number;
  /** Extra arms edge-tested on MODEL_AXIS[0] only, funded by the larger Anthropic budget. */
  readonly leadModelOnlyEdgeArms: number;
  /** Rows in the edge tier. Cut ARMS before ROWS — see `sizeDesign`. */
  readonly edgeRows: number;
  /** Rows in the lever tier, or 0 when the budget could not fund a usable one. */
  readonly leverRows: number;
  readonly measured: {
    readonly leadUsdPerCall: number;
    readonly followUsdPerCall: number;
    readonly leadEdgeBudgetUsd: number;
    readonly followBudgetUsd: number;
    readonly leverTierUsd: number;
  };
  /** Pins the design to the exact corpus it was sized for. */
  readonly corpusSha256: string;
}

/**
 * Sizes the reduced design from MEASURED per-call cost. Declared as a rule, evaluated after the
 * calibration probe and before the first edge call, so the family is fixed before any hypothesis is
 * tested but after the only unknown that constrains it.
 *
 * **CUT ARMS BEFORE ROWS.** This is the load-bearing decision of Amendment 5 and it is worth stating
 * because the intuitive move is the wrong one. Cost is rows x arms; power is a function of rows alone
 * (entries per cell); the Bonferroni family is a function of arms alone. So:
 *
 *   - halving ROWS raises the mean an arm must post to pass, by 1/sqrt(n) — on this corpus, from about
 *     26 bps to about 33 bps, and it pushes the low-entry-rate arms below MIN_ENTRIES so they can only
 *     return UNDERPOWERED;
 *   - halving ARMS costs coverage of playbook space but SHRINKS the family, which raises alpha and
 *     makes each surviving cell very slightly easier to clear.
 *
 * Same money, opposite effect on sensitivity. So arms absorb the budget first and rows are held at
 * full depth.
 *
 * **The one case where rows must give way** (owner direction, 2026-07-30: *"if the funding is not
 * enough for full row depth: use less rows"*). The owner's question is *which lane is best*, which only
 * the model axis answers — so one shared arm on both models outranks extra depth on one. If the follow
 * model's budget cannot buy a single arm at full depth, the rule reduces ROW DEPTH to the most the axis
 * can afford, uniformly across the whole edge tier so every cross-arm and cross-model comparison stays
 * on identical rows.
 *
 * Fails CLOSED below MIN_EDGE_ROWS: at that point no cell can be powered, and underpowered cells are
 * worse than no cells because they look like results.
 */
export function sizeDesign(input: {
  /** The row depth to use if the axis can afford it — normally the whole corpus. */
  readonly edgeRows: number;
  readonly leadUsdPerCall: number;
  readonly followUsdPerCall: number;
  /** Anthropic dollars allocated to this study — NOT the account balance; the lane has first claim. */
  readonly leadStudyBudgetUsd: number;
  readonly followBudgetUsd: number;
  readonly corpusSha256: string;
}): StudyDesign {
  // Refuse at construction rather than fail open per-stage: a zero budget or a zero measured cost
  // would otherwise divide its way to a nonsense design that still looks like a plan.
  for (const [name, value] of [
    ['edgeRows', input.edgeRows],
    ['leadUsdPerCall', input.leadUsdPerCall],
    ['followUsdPerCall', input.followUsdPerCall],
    ['leadStudyBudgetUsd', input.leadStudyBudgetUsd],
    ['followBudgetUsd', input.followBudgetUsd],
  ] as const) {
    if (!(value > 0) || !Number.isFinite(value)) {
      throw new Error(`sizeDesign: ${name} must be a positive finite number, got ${value}`);
    }
  }
  // Stage 0 — the LEVER tier takes at most its declared share, and shrinks or vanishes rather than
  // crowding out the edge tier it is only a diagnostic for.
  const leverBudgetUsd = input.leadStudyBudgetUsd * LEVER_TIER_BUDGET_SHARE;
  const affordableLeverRows = Math.floor(
    leverBudgetUsd / (ARM_PRIORITY.length * input.leadUsdPerCall),
  );
  const leverRows =
    Math.min(LEVER_PROBE_ROWS, affordableLeverRows) >= MIN_LEVER_ROWS
      ? Math.min(LEVER_PROBE_ROWS, affordableLeverRows)
      : 0;
  const leverTierUsd = ARM_PRIORITY.length * leverRows * input.leadUsdPerCall;
  const leadEdgeBudgetUsd = input.leadStudyBudgetUsd - leverTierUsd;
  // Stage 1 — ROW DEPTH. Full depth unless one shared arm on the follow model does not fit, in which
  // case the axis (the owner's actual question) outranks the extra rows.
  const followCallsAffordable = Math.floor(input.followBudgetUsd / input.followUsdPerCall);
  const leadCallsAffordable = Math.floor(leadEdgeBudgetUsd / input.leadUsdPerCall);
  const edgeRows = Math.min(input.edgeRows, followCallsAffordable, leadCallsAffordable);
  if (edgeRows < MIN_EDGE_ROWS) {
    throw new Error(
      `sizeDesign: the model axis affords only ${edgeRows} rows (follow: ` +
        `$${input.followBudgetUsd.toFixed(2)} at $${input.followUsdPerCall.toFixed(5)}/call; lead ` +
        `edge budget $${leadEdgeBudgetUsd.toFixed(2)} at $${input.leadUsdPerCall.toFixed(5)}/call), ` +
        `below the ${MIN_EDGE_ROWS}-row floor where no cell can reach MIN_ENTRIES=${MIN_ENTRIES}. ` +
        `Raise a budget or re-scope — do not run a study that can only return UNDERPOWERED.`,
    );
  }
  // Stage 2 — ARMS. Whatever depth was fixed above, the remaining budget buys arms off the frozen
  // priority order.
  const costPerArm = (usdPerCall: number): number => edgeRows * usdPerCall;
  const sharedEdgeArms = Math.min(
    MAX_SHARED_EDGE_ARMS,
    Math.floor(input.followBudgetUsd / costPerArm(input.followUsdPerCall)),
  );
  const leadCapacityArms = Math.floor(leadEdgeBudgetUsd / costPerArm(input.leadUsdPerCall));
  const leadModelOnlyEdgeArms = Math.max(
    0,
    Math.min(MAX_LEAD_ONLY_EDGE_ARMS, leadCapacityArms - sharedEdgeArms),
  );
  return {
    sharedEdgeArms,
    leadModelOnlyEdgeArms,
    edgeRows,
    leverRows,
    measured: {
      leadUsdPerCall: input.leadUsdPerCall,
      followUsdPerCall: input.followUsdPerCall,
      leadEdgeBudgetUsd,
      followBudgetUsd: input.followBudgetUsd,
      leverTierUsd,
    },
    corpusSha256: input.corpusSha256,
  };
}

/**
 * The family the correction protects: shared arms on every model, plus the lead-only arms once.
 *
 * The lever tier is absent by construction (it tests nothing against the bar), and so is every arm
 * below the funded prefix — an untested arm is not a suppressed test.
 */
export function bonferroniCells(d: StudyDesign): number {
  return (
    MODEL_AXIS.length * d.sharedEdgeArms * HORIZONS.length +
    d.leadModelOnlyEdgeArms * HORIZONS.length
  );
}

export function alphaFor(d: StudyDesign): number {
  return 0.05 / bonferroniCells(d);
}

/** The frozen PREFIX of ARM_PRIORITY this model edge-tests. Never a chosen subset. */
export function edgeArmsFor(model: string, d: StudyDesign): readonly string[] {
  const count =
    model === MODEL_AXIS[0] ? d.sharedEdgeArms + d.leadModelOnlyEdgeArms : d.sharedEdgeArms;
  return ARM_PRIORITY.slice(0, count);
}

/**
 * ARM_PRIORITY must name every arm exactly once. A typo would silently shorten the priority list and
 * quietly drop an arm out of the study — the kind of defect that only shows up as a missing row in a
 * results table nobody cross-checks.
 */
export function assertArmPriorityCoversEveryArm(): void {
  const armNames = new Set(PLAYBOOK_ARMS.map((a) => a.name));
  const priority = new Set<string>(ARM_PRIORITY);
  if (priority.size !== ARM_PRIORITY.length) {
    throw new Error('ARM_PRIORITY contains a duplicate');
  }
  const missing = [...armNames].filter((n) => !priority.has(n));
  const unknown = [...priority].filter((n) => !armNames.has(n));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `ARM_PRIORITY does not match PLAYBOOK_ARMS — missing: [${missing.join(', ')}], ` +
        `unknown: [${unknown.join(', ')}]`,
    );
  }
}

/**
 * The sized design is written to disk by the calibration step and READ by the edge run, rather than
 * recomputed inside it.
 *
 * The point is ordering, not convenience: a design file that exists before the first edge call is
 * evidence the family was fixed before any hypothesis was tested. Re-deriving the sizing inside the
 * scoring run would leave no trace distinguishing "sized from measured cost" from "sized after seeing
 * which cells looked good", and those two are the difference between a pre-registration and a story.
 */
export const DESIGN_FILE = join(
  process.cwd(),
  'research',
  'candidates',
  'playbook-space-design.json',
);

export function writeDesign(d: StudyDesign, file = DESIGN_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(d, null, 2), 'utf8');
}

export function loadDesign(file = DESIGN_FILE): StudyDesign {
  if (!existsSync(file)) {
    throw new Error(
      `no sized design at ${file} — run the calibration probe first ` +
        `(PLAYBOOK_SPACE_CALIBRATE=1). The edge run refuses to size its own family.`,
    );
  }
  return JSON.parse(readFileSync(file, 'utf8')) as StudyDesign;
}

/**
 * A design sized against a different corpus is void: the row count it budgeted for and the entry
 * counts it assumed both belong to that corpus. Fails CLOSED — a measurement whose provenance does
 * not match the corpus in front of it must never be silently accepted as evidence.
 *
 * There is no legacy/pre-tie-break arm here. An earlier pass of this function briefly carried one,
 * reasoning that pre-2026-08 designs recorded a different, unrecoverable corpus ordering — that
 * reasoning was wrong (research/studies/corpus-fingerprint-drift-correction-2026-08-03.md):
 * `corpusManifest`'s separator is a genuine NUL byte, and every pre-2026-08 design's recorded hash
 * reproduces from the real corpus exactly, via the real `corpusManifest`. There was never a second
 * hash to route to, so a mismatch here is always the generic case.
 */
export function assertDesignMatchesCorpus(d: StudyDesign, payloadSha256: string): void {
  if (d.corpusSha256 === payloadSha256) return;
  throw new Error(
    `design was sized for corpus ${d.corpusSha256.slice(0, 12)} but this corpus is ` +
      `${payloadSha256.slice(0, 12)} — re-run calibration; the design does not transfer.`,
  );
}
const N_BOOT = 20_000;
const N_PLACEBO = 5_000;

/** USD per 1M tokens. */
export interface TokenRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Sonnet-5 list rates as configured in .env.app. */
const RATES: TokenRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 };

/**
 * haiku-4-5 list rates — $1/$5 per Mtok (repo reference: the AGENTIC_TOKEN_PRICES_JSON example in
 * candidate-model-eval.spec.ts's header), with the provider's standard cache multipliers on the
 * input rate (read 0.1x, write 1.25x).
 */
const HAIKU_RATES: TokenRates = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

export const MODEL_RATES: Readonly<Record<string, TokenRates>> = {
  'claude-sonnet-5': RATES,
  'claude-haiku-4-5': HAIKU_RATES,
};

/**
 * Fails CLOSED on an unpriced model. A meter that priced an unknown model at zero would never bind
 * its cap — the exact posture the 2026-07-20 Opus runaway punished. A caller that deliberately
 * meters an Anthropic-compatible surface at sonnet rates (the kimi leg) passes `rates` explicitly.
 */
export function ratesFor(model: string): TokenRates {
  const r = MODEL_RATES[model];
  if (r === undefined) {
    throw new Error(`ratesFor: no token rates for model ${model} — refusing to meter it at zero`);
  }
  return r;
}

// Deterministic PRNG — Date.now()/Math.random() would make a run unreproducible, and every statistic
// below is a resampling statistic whose value depends on the stream.
function makeRand(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const mean = (a: readonly number[]): number =>
  a.length === 0 ? Number.NaN : a.reduce((s, x) => s + x, 0) / a.length;

// ── corpus ───────────────────────────────────────────────────────────────────────────────────────
export interface CorpusRow {
  readonly id: string;
  readonly symbol: string;
  readonly eventTime: number;
  readonly recordedAction: string;
  readonly inputPayload: string;
}

interface RawCorpusRow {
  readonly id: number | string;
  readonly symbol: string;
  readonly event_time: number | string;
  readonly action: string;
  readonly input_payload: string;
}

/**
 * A FORWARD GUARD, not a fix for drift that happened — none did
 * (research/studies/corpus-fingerprint-drift-correction-2026-08-03.md). The corpus has 81 distinct
 * `event_time` values shared by 305 of its 386 rows (a "tie group"), so any FUTURE re-dump that
 * doesn't preserve today's exact row order is a real risk: ~10^117 orderings are consistent with
 * `ORDER BY event_time` alone, and each would change `corpusManifest`'s hash even though every row and
 * every payload byte were identical. This sort makes two loads of the SAME rows produce the SAME
 * order — and therefore the SAME hash — regardless of what order they arrive in off the wire or disk,
 * closing that risk before it can produce a real mismatch.
 *
 * This lives HERE, in `loadCorpus`, not inside `corpusManifest`. Sorting only inside the manifest
 * would make the HASH order-invariant while `strideSample` and the chronological-halves `eventTime`
 * vector — both of which read `rows` directly, never the manifest — stayed order-dependent. That
 * would let two runs agree "same corpus" while actually scoring different subsamples: a worse, silent
 * failure than a loud hash mismatch. Sorting in `loadCorpus` makes the hash and the sampling agree by
 * construction.
 *
 * Comparator: (eventTime ASC, id ASC) with id compared NUMERICALLY. Corpus ids are numeric strings
 * (bigint ids from agent_decisions, serialised to string); an id that fails to parse would make this
 * sort itself undefined and therefore not reproducible — exactly the failure this guard exists to
 * prevent — so it FAILS CLOSED rather than degrading to a string comparison that would quietly
 * reintroduce the risk.
 */
function sortCorpusRows(rows: readonly CorpusRow[]): readonly CorpusRow[] {
  return [...rows].sort((a, b) => {
    if (a.eventTime !== b.eventTime) return a.eventTime - b.eventTime;
    const aId = Number(a.id);
    const bId = Number(b.id);
    if (!Number.isFinite(aId) || !Number.isFinite(bId)) {
      throw new Error(
        `loadCorpus: non-numeric row id in tie-break (a=${a.id}, b=${b.id}) — refusing to sort with ` +
          `an undefined order, which would make the manifest hash unreproducible again.`,
      );
    }
    return aId - bId;
  });
}

export function loadCorpus(file = join(DATA, 'corpus-v3-flat.jsonl')): readonly CorpusRow[] {
  if (!existsSync(file)) throw new Error(`corpus not found: ${file}`);
  const rows = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RawCorpusRow)
    .map((r) => ({
      id: String(r.id),
      symbol: r.symbol,
      eventTime: Number(r.event_time),
      recordedAction: r.action,
      inputPayload: r.input_payload,
    }));
  return sortCorpusRows(rows);
}

/** Row ids in order plus a hash over the payloads — a run whose manifest differs is void. */
export function corpusManifest(rows: readonly CorpusRow[]): {
  readonly rows: number;
  readonly symbols: number;
  readonly firstEventTime: number;
  readonly lastEventTime: number;
  readonly payloadSha256: string;
} {
  const h = createHash('sha256');
  for (const r of rows) h.update(r.id).update(' ').update(r.inputPayload).update(' ');
  return {
    rows: rows.length,
    symbols: new Set(rows.map((r) => r.symbol)).size,
    firstEventTime: rows[0]?.eventTime ?? 0,
    lastEventTime: rows[rows.length - 1]?.eventTime ?? 0,
    payloadSha256: h.digest('hex'),
  };
}

// ── candles + the metric ─────────────────────────────────────────────────────────────────────────
interface Series {
  readonly ts: readonly number[];
  readonly close: readonly number[];
}

export function loadSeries(symbols: Iterable<string>): ReadonlyMap<string, Series> {
  const out = new Map<string, Series>();
  for (const sym of new Set(symbols)) {
    const p = join(CANDLES, `ohlcv-${sym.replace(/[/:]/g, '')}-15m.json`);
    if (!existsSync(p)) continue;
    const rows = JSON.parse(readFileSync(p, 'utf8')) as (readonly (number | string)[])[];
    out.set(sym, {
      ts: rows.map((r) => Number(r[0])),
      close: rows.map((r) => Number(r[4])),
    });
  }
  return out;
}

/**
 * Forward return in bps from the bar at/after `ts`, `h` bars ahead, signed by `dir`. Byte-for-byte
 * the metric that produced -16.9 bps (test/backtest/inversion-test.mjs's fwdBps).
 *
 * Indexing is STRICTLY within one symbol's own series — the #37 defect (interleaving symbols, scoring
 * BTC->LINK transitions as -99.99%) is never repeated. Returns null when the row has fewer than `h`
 * forward bars, the same open-at-end exclusion the original applied.
 */
export function fwdBps(
  series: ReadonlyMap<string, Series>,
  symbol: string,
  ts: number,
  h: number,
  dir: 1 | -1,
): number | null {
  const s = series.get(symbol);
  if (!s) return null;
  const i = s.ts.findIndex((t) => t >= ts);
  if (i < 0 || i + h >= s.ts.length) return null;
  const c0 = s.close[i]!;
  const c1 = s.close[i + h]!;
  if (!(c0 > 0) || !(c1 > 0)) return null;
  return dir * ((c1 - c0) / c0) * 10_000;
}

// ── statistics ───────────────────────────────────────────────────────────────────────────────────
export interface Observation {
  readonly symbol: string;
  readonly bps: number;
  /**
   * The entry row's event time. REQUIRED, and it is the whole implementation cost of the deployment
   * bar's chronological-halves clause: the time was previously dropped at the one line that built
   * this object, so a CALENDAR split — the only split two different arms can share — was not
   * computable from a cell's own inputs (halves-clause record § 3.4).
   */
  readonly eventTime: number;
}

export interface CellStats {
  readonly n: number;
  readonly clusters: number;
  readonly mean: number;
  readonly ciLo: number;
  readonly ciHi: number;
  /** One-sided bootstrap p against the +13.0 bps null (share of draws at or below the bar). */
  readonly pVsBar: number;
  readonly placeboP: number;
  /**
   * INDEX-split halves: the midpoint of THIS cell's own observation vector.
   *
   * Chronological per arm (the vector is built in row order and the corpus is chronological), which
   * is exactly what the research bar's clause 5 needs — it compares one arm against the CONSTANT
   * +13.0 bps and no cross-arm comparability is required. They are frozen clauses of a
   * pre-registered bar and must never be redefined. They are ALSO unusable for any BETWEEN-arm
   * comparison: each arm splits at its own entry count, and the same arm's split moves between
   * horizons whenever a forward return is unavailable (halves-clause record § 3.1-3.3).
   */
  readonly firstHalf: number;
  readonly secondHalf: number;
  /**
   * TIME-split halves against a shared split instant, and the ONLY halves a between-arm comparison
   * may read. `NaN`/0 when `computeCell` was called without a `splitAtMs` — an honest "not measured",
   * which the deployment bar reads as UNDETERMINED rather than as a failure.
   */
  readonly firstHalfAt: number;
  readonly secondHalfAt: number;
  readonly nFirstHalfAt: number;
  readonly nSecondHalfAt: number;
  readonly trimmed: number;
}

/**
 * CLUSTER bootstrap: resamples SYMBOLS, not observations. Multiple entries on one symbol within hours
 * are not independent, and a row-level bootstrap would overstate confidence — the stricter choice is
 * the correct one for a gate that could authorise spending money.
 */
function clusterBootstrap(obs: readonly Observation[], rand: () => number): number[] {
  const bySymbol = new Map<string, number[]>();
  for (const o of obs) {
    const list = bySymbol.get(o.symbol);
    if (list) list.push(o.bps);
    else bySymbol.set(o.symbol, [o.bps]);
  }
  const clusters = [...bySymbol.values()];
  const draws: number[] = [];
  for (let b = 0; b < N_BOOT; b += 1) {
    let sum = 0;
    let count = 0;
    for (let k = 0; k < clusters.length; k += 1) {
      const pick = clusters[(rand() * clusters.length) | 0]!;
      for (const v of pick) {
        sum += v;
        count += 1;
      }
    }
    if (count > 0) draws.push(sum / count);
  }
  draws.sort((a, b) => a - b);
  return draws;
}

/**
 * Random-bar placebo: keeps each entry's symbol and side, replaces its BAR with a random bar from
 * that same symbol's own series. Selection-invariant by construction — which is exactly why the
 * original ENTRIES finding survived the schema-filter defect, and why any survivor here must clear it
 * too. Returns the share of placebo draws whose mean is at least as good as observed.
 */
function placeboP(
  entries: readonly { symbol: string; dir: 1 | -1 }[],
  series: ReadonlyMap<string, Series>,
  h: number,
  observedMean: number,
  rand: () => number,
): number {
  let atLeastAsGood = 0;
  let draws = 0;
  for (let p = 0; p < N_PLACEBO; p += 1) {
    const vals: number[] = [];
    for (const e of entries) {
      const s = series.get(e.symbol);
      if (!s) continue;
      const i = (rand() * Math.max(1, s.ts.length - h - 1)) | 0;
      const c0 = s.close[i]!;
      const c1 = s.close[i + h]!;
      if (c0 > 0 && c1 > 0) vals.push(e.dir * ((c1 - c0) / c0) * 10_000);
    }
    if (vals.length === 0) continue;
    draws += 1;
    if (mean(vals) >= observedMean) atLeastAsGood += 1;
  }
  return draws === 0 ? 1 : atLeastAsGood / draws;
}

/**
 * `splitAtMs` is OPTIONAL and touches nothing that existed before it.
 *
 * When it is absent every pre-existing field is computed byte-identically — the argument is read
 * only after the resampling statistics are finished, so it cannot perturb the PRNG stream, and the
 * four `*At` fields it feeds read `NaN`/0. That guarantee is what lets a frozen, pre-registered
 * research bar and a newly-added deployment clause share one function, and it is asserted directly
 * in the spec rather than left as a claim.
 */
export function computeCell(
  obs: readonly Observation[],
  entries: readonly { symbol: string; dir: 1 | -1 }[],
  series: ReadonlyMap<string, Series>,
  h: number,
  seed: number,
  splitAtMs?: number,
): CellStats {
  const rand = makeRand(seed);
  const bps = obs.map((o) => o.bps);
  const m = mean(bps);
  const draws = clusterBootstrap(obs, rand);
  const half = Math.floor(bps.length / 2);
  const sorted = [...bps].sort((a, b) => a - b);
  // Calendar assignment, both sides of a SHARED instant: strictly before is early, everything else
  // is late (record § 4 definition 3). No RNG, no sorting of the vector, no dependence on this
  // arm's own entry count — that independence is the entire reason the field exists.
  const earlyAt: number[] = [];
  const lateAt: number[] = [];
  if (splitAtMs !== undefined) {
    for (const o of obs) (o.eventTime < splitAtMs ? earlyAt : lateAt).push(o.bps);
  }
  return {
    n: bps.length,
    clusters: new Set(obs.map((o) => o.symbol)).size,
    mean: m,
    ciLo: draws[Math.floor(0.025 * draws.length)] ?? Number.NaN,
    ciHi: draws[Math.floor(0.975 * draws.length)] ?? Number.NaN,
    pVsBar:
      draws.length === 0 ? 1 : draws.filter((d) => d <= REQUIRED_EDGE_BPS).length / draws.length,
    placeboP: placeboP(entries, series, h, m, rand),
    firstHalf: mean(bps.slice(0, half)),
    secondHalf: mean(bps.slice(half)),
    firstHalfAt: mean(earlyAt),
    secondHalfAt: mean(lateAt),
    nFirstHalfAt: earlyAt.length,
    nSecondHalfAt: lateAt.length,
    trimmed: sorted.length > 2 ? mean(sorted.slice(1, -1)) : Number.NaN,
  };
}

/**
 * The run's ONE split instant: the median `eventTime` of the COMMON row set — the rows every arm
 * answered, not any arm's entries.
 *
 * Sorted ascending, `T` is the time at index `floor(|C| / 2)`; for even `|C|` that is the upper of
 * the two central times (record § 4 definition 2). Arm-independent, horizon-independent, and
 * computed before any comparison is read. Returns `undefined` for an empty common set, which
 * propagates as an honest UNDETERMINED rather than a fabricated boundary.
 */
export function commonRowsSplitAtMs(
  perArm: ReadonlyMap<string, readonly ArmRowResult[]>,
): number | undefined {
  const lists = [...perArm.values()];
  if (lists.length === 0) return undefined;
  const timeById = new Map<string, number>();
  for (const list of lists) for (const r of list) timeById.set(r.rowId, r.eventTime);
  // The intersection, computed here rather than assumed: truncateToCommonRows already guarantees it,
  // but a split instant that silently followed one arm's row set would be the arm-relative boundary
  // this whole clause exists to avoid.
  let common = new Set<string>(lists[0]!.map((r) => r.rowId));
  for (const list of lists.slice(1)) {
    const ids = new Set(list.map((r) => r.rowId));
    common = new Set([...common].filter((id) => ids.has(id)));
  }
  if (common.size === 0) return undefined;
  const times = [...common].map((id) => timeById.get(id)!).sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

export type Verdict = 'PASS' | 'UNDERPOWERED' | 'FAIL';

/**
 * Every clause of the frozen bar. UNDERPOWERED is neither a pass nor a fail — see § the bar.
 *
 * `alpha` is a parameter rather than a module constant because Amendment 5 makes the family a function
 * of the funded design. The two clauses that DO NOT depend on it — `mean > 13.0` and a 95% CI lower
 * bound above 13.0 — are unchanged by any budget decision, which is deliberate: shrinking the family
 * relaxes the significance clauses and nothing else, so the economic requirement cannot be argued down
 * by running fewer arms.
 */
export function verdictFor(
  s: CellStats,
  alpha: number,
): { verdict: Verdict; failedClause: string | null } {
  if (s.n < MIN_ENTRIES)
    return { verdict: 'UNDERPOWERED', failedClause: `n=${s.n} < ${MIN_ENTRIES}` };
  if (!(s.mean > REQUIRED_EDGE_BPS)) return { verdict: 'FAIL', failedClause: 'mean <= bar' };
  if (!(s.ciLo > REQUIRED_EDGE_BPS))
    return { verdict: 'FAIL', failedClause: 'CI lower bound <= bar' };
  if (!(s.pVsBar < alpha)) return { verdict: 'FAIL', failedClause: 'p vs bar >= alpha' };
  if (!(s.placeboP < alpha)) return { verdict: 'FAIL', failedClause: 'placebo p >= alpha' };
  if (!(s.firstHalf > REQUIRED_EDGE_BPS && s.secondHalf > REQUIRED_EDGE_BPS)) {
    return { verdict: 'FAIL', failedClause: 'a chronological half <= bar' };
  }
  if (!(s.trimmed > REQUIRED_EDGE_BPS))
    return { verdict: 'FAIL', failedClause: 'trimmed mean <= bar' };
  return { verdict: 'PASS', failedClause: null };
}

// ── the joint verdict across the model axis ──────────────────────────────────────────────────────
export interface LaneCell {
  readonly model: string;
  readonly arm: string;
  readonly h: number;
  readonly n: number;
  readonly mean: number;
  readonly ciLo: number;
  readonly verdict: string;
  /**
   * The TIME-split halves of `CellStats`, carried here because `compareToIncumbent` consumes
   * `LaneCell` and the clause is not expressible without them.
   *
   * OPTIONAL because a cell can legitimately not have them: a comparator read from a frozen artifact
   * never will (§ 6.2). Absent reads as UNDETERMINED. These are NEVER the index-split
   * `firstHalf`/`secondHalf` — those are deliberately not declared here, and the different names are
   * the first of two barriers against substituting them (the second is in
   * `loadRecordedIncumbentCells`).
   */
  readonly firstHalfAt?: number;
  readonly secondHalfAt?: number;
  readonly nFirstHalfAt?: number;
  readonly nSecondHalfAt?: number;
}

export interface JointVerdict {
  readonly modelsRun: readonly string[];
  readonly modelsDeclared: readonly string[];
  readonly complete: boolean;
  readonly cellsScored: number;
  readonly cellsDeclared: number;
  readonly passes: readonly LaneCell[];
  /** Highest mean among cells that are POWERED (n >= MIN_ENTRIES), pass or fail. */
  readonly bestPowered: LaneCell | null;
  readonly verdict: 'SURVIVOR' | 'NO_SURVIVOR' | 'INCOMPLETE';
}

/**
 * Decides the study across ALL models at once — the only reading that answers "which lane is best".
 *
 * Two properties worth stating because they are easy to get wrong:
 *
 * 1. **A missing model makes the verdict INCOMPLETE, never NO_SURVIVOR.** If only one model ran, the
 *    honest statement is "the others are untested", not "nothing works". Declaring NO_SURVIVOR off a
 *    partial axis is the same error as reading a rate-limited run as a finding.
 * 2. **`bestPowered` is reported separately from `passes`, and ranking is NOT a pass.** The best lane
 *    among a field of failures is still a failure; the bar is absolute (+13.0 bps), not relative. It
 *    is surfaced only so "which is best" has a defensible answer even when the answer is "all of them
 *    lose, this one loses least".
 */
function summariseCells(all: readonly LaneCell[]): {
  readonly passes: readonly LaneCell[];
  readonly bestPowered: LaneCell | null;
} {
  const powered = all.filter((c) => c.n >= MIN_ENTRIES);
  return {
    passes: all.filter((c) => c.verdict === 'PASS'),
    bestPowered:
      powered.length === 0
        ? null
        : powered.reduce((best, c) => (c.mean > best.mean ? c : best), powered[0]!),
  };
}

export function aggregateVerdict(
  perModelCells: ReadonlyMap<string, readonly LaneCell[]>,
  design: StudyDesign,
): JointVerdict {
  const modelsRun = [...perModelCells.keys()].sort();
  const all = [...perModelCells.values()].flat();
  const { passes, bestPowered } = summariseCells(all);
  const complete = MODEL_AXIS.every((m) => perModelCells.has(m));
  return {
    modelsRun,
    modelsDeclared: [...MODEL_AXIS],
    complete,
    cellsScored: all.length,
    cellsDeclared: bonferroniCells(design),
    passes,
    bestPowered,
    verdict: !complete ? 'INCOMPLETE' : passes.length > 0 ? 'SURVIVOR' : 'NO_SURVIVOR',
  };
}

// ── the scorer sanity gate ───────────────────────────────────────────────────────────────────────
/**
 * Scores a row set by its OWN recorded entry actions and returns the mean forward return.
 *
 * It deliberately does NOT ask the champion_v9 arm to reproduce those entries: the recorded entries
 * are a mixture over ~9 playbook versions, so a single-playbook replay reproducing them is neither
 * expected nor required, and demanding it would be a mis-specified check of exactly the kind this
 * program already made once (`lo_all`, horizon study Amendment 3).
 */
export function scoreRecordedEntries(
  rows: readonly CorpusRow[],
  series: ReadonlyMap<string, Series>,
  h: number,
): { readonly n: number; readonly meanBps: number } {
  const vals: number[] = [];
  for (const r of rows) {
    const dir =
      r.recordedAction === 'open_long' ? 1 : r.recordedAction === 'open_short' ? -1 : null;
    if (dir === null) continue;
    const v = fwdBps(series, r.symbol, r.eventTime, h, dir);
    if (v !== null) vals.push(v);
  }
  return { n: vals.length, meanBps: mean(vals) };
}

interface RawEntryRow {
  readonly id: number | string;
  readonly symbol: string;
  readonly event_time: number | string;
  readonly action: string;
}

/**
 * EVERY recorded entry — no payload, model or FLAT filter — which is the population
 * `test/backtest/inversion-test.mjs` scores. Loaded from its own dump so the two harnesses can be
 * compared on an IDENTICAL row set.
 *
 * Why this exists as a separate loader, recorded because the first attempt got it wrong: the study
 * corpus is deliberately FLAT-only (an arm cannot open from a non-flat state), so it is a strict
 * SUBSET of the entry population and its mean LEGALLY differs — measured -16.23 bps at n=60 against
 * the population's -16.9 at n=61. Gating the scorer on the -16.9 constant therefore failed, and the
 * failure was in the assertion, not the arithmetic: exactly the mis-specification this program
 * already made once (`lo_all`, horizon study Amendment 3, where a legitimate fee drag was flagged
 * SANITY-FAIL). Agreement between two independent implementations ON THE SAME ROWS is the check that
 * actually validates arithmetic; equality with a number computed on a different population is not.
 *
 * The live stack also keeps journaling, so the entry population grows: 63 entries at the inversion
 * test's first run, 64 by this dump. Both files are point-in-time dumps and the manifest hash is what
 * pins a run to its data.
 */
export function loadRecordedEntries(
  file = join(DATA, 'recorded-entries-v3.jsonl'),
): readonly CorpusRow[] {
  if (!existsSync(file)) throw new Error(`recorded entries not found: ${file}`);
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RawEntryRow)
    .map((r) => ({
      id: String(r.id),
      symbol: r.symbol,
      eventTime: Number(r.event_time),
      recordedAction: r.action,
      inputPayload: '',
    }));
}

// ── arms ─────────────────────────────────────────────────────────────────────────────────────────
interface LineagePlaybook {
  readonly version: number;
  readonly content: string;
}

export function resolveArms(
  file = join(DATA, 'playbooks-lineage.json'),
): readonly { readonly arm: PlaybookArm; readonly content: string }[] {
  const lineage = JSON.parse(readFileSync(file, 'utf8')) as readonly LineagePlaybook[];
  return PLAYBOOK_ARMS.map((arm) => {
    if (arm.source.kind === 'literal') {
      if (arm.content === undefined) throw new Error(`arm ${arm.name}: literal arm has no content`);
      return { arm, content: arm.content };
    }
    const version = arm.source.version;
    const found = lineage.find((p) => p.version === version);
    if (!found) throw new Error(`arm ${arm.name}: playbook version ${version} not in ${file}`);
    return { arm, content: found.content };
  });
}

/**
 * Restricts a resolved arm set to `names`, in ARM_PRIORITY order, throwing on any name that is not an
 * arm. Order matters: the first arm is the champion the decision-change count is measured against, and
 * chunk-major execution means arm order also decides which arms survive a budget abort.
 */
export function selectArms(
  arms: readonly { readonly arm: PlaybookArm; readonly content: string }[],
  names: readonly string[],
): readonly { readonly arm: PlaybookArm; readonly content: string }[] {
  const byName = new Map(arms.map((a) => [a.arm.name, a]));
  return names.map((n) => {
    const found = byName.get(n);
    if (!found) throw new Error(`selectArms: no arm named ${n}`);
    return found;
  });
}

/**
 * Evenly-spaced sample of `k` rows spanning the WHOLE corpus window, not the first `k`.
 *
 * The corpus is chronological, so a head slice is one contiguous market slice — 60 consecutive rows
 * covers roughly a day of a 6.35-day window. For the lever tier (an entry-rate proportion) and for the
 * calibration probe (a per-call cost that tracks payload size) a spanning sample is what makes the
 * measurement representative of the full run. Deterministic: no PRNG, so the sample reproduces.
 */
export function strideSample<T>(rows: readonly T[], k: number): readonly T[] {
  if (k >= rows.length) return rows;
  if (k <= 0) return [];
  const step = rows.length / k;
  return Array.from({ length: k }, (_, i) => rows[Math.floor(i * step)]!);
}

/**
 * An arm the live validator would REJECT is not a reachable point in playbook space, so scoring it
 * would answer a question about a system that cannot exist. Load-bearing, not hygiene — throws.
 */
export function assertArmsAreReachable(
  arms: readonly { readonly arm: PlaybookArm; readonly content: string }[],
): void {
  for (const { arm, content } of arms) {
    const v = validatePlaybook(content, { shortsAllowed: true, leverageAllowed: true });
    if (!v.ok) {
      throw new Error(`arm ${arm.name} is unreachable — live validator rejects it: ${v.reason}`);
    }
  }
}

// ── the USD meter ────────────────────────────────────────────────────────────────────────────────
/**
 * Fails CLOSED on attempt start: never begins a call that could cross the cap. Mirrors
 * AttemptScopedBudget (agent-budget.ts:126) — the posture exists because the 2026-07-20 Opus runaway
 * spent $2.48 against a $1.50 stop with nothing gating the attempt.
 */
export class UsdMeter {
  private spent = new Decimal(0);
  private calls = 0;

  constructor(
    private readonly capUsd: Decimal,
    /** Conservative per-call reservation, so the cap binds BEFORE the call, not after. */
    private readonly reserveUsd: Decimal,
    private readonly rates: TokenRates = RATES,
  ) {}

  /**
   * `units` reserves for a whole indivisible group of calls up front — an N-voter swarm row must be
   * affordable in full before its first call, because a row that runs out of budget after 1 of 3
   * votes cannot reach a majority and would silently record a `hold` that no voter cast.
   */
  canSpend(units = 1): boolean {
    return this.spent.plus(this.reserveUsd.mul(units)).lte(this.capUsd);
  }

  record(usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }): void {
    this.calls += 1;
    if (!usage) return;
    this.spent = this.spent
      .plus(new Decimal(usage.inputTokens).div(1_000_000).mul(this.rates.input))
      .plus(new Decimal(usage.outputTokens).div(1_000_000).mul(this.rates.output))
      .plus(new Decimal(usage.cacheReadInputTokens ?? 0).div(1_000_000).mul(this.rates.cacheRead))
      .plus(
        new Decimal(usage.cacheCreationInputTokens ?? 0).div(1_000_000).mul(this.rates.cacheWrite),
      );
  }

  snapshot(): { readonly calls: number; readonly usd: string } {
    return { calls: this.calls, usd: this.spent.toFixed(4) };
  }
}

// ── transport instrumentation + retry ────────────────────────────────────────────────────────────
/**
 * Why this exists (2026-07-28, run 1 VOID): the first full run made all 4,632 calls, reported
 * `aborted=false`, wrote a clean NO_SURVIVOR table — and was worthless. Only ~500 calls carried any
 * `usage`, and the $7.50 spend against a $75 estimate gave it away: roughly 87% of calls failed at the
 * HTTP layer before the model ever ran, almost certainly 429s at concurrency 6.
 *
 * `replayPlanRow` collapses EVERY failure to `{ok:false}` by design (a bad row must never kill the
 * caller), which is correct for its own use but means a rate-limited run is indistinguishable from a
 * run where the model simply held. The harness therefore instruments the fetch layer, where the
 * distinction still exists, rather than changing production code.
 *
 * Fails OPEN per call — a transport error still degrades to `{ok:false}` exactly as before. The
 * protection against acting on a broken run is the completion-rate precondition, not this wrapper.
 */
export interface TransportStats {
  attempts: number;
  /** Responses that were BOTH 2xx and carried a body — see emptyBody. */
  ok: number;
  rateLimited: number;
  serverError: number;
  otherHttp: number;
  networkError: number;
  retries: number;
  /**
   * HTTP 200 with a zero-length body.
   *
   * Measured on Moonshot's Anthropic-compatible surface 2026-07-30: roughly 30-45% of otherwise
   * identical requests come back 200 with nothing in them, and it is NON-DETERMINISTIC — the same
   * corpus row returned an empty body on one run and 2,365 bytes on the next. `res.json()` then throws,
   * `replayPlanRow` collapses that to `{ok:false}` with no usage, and the calibration reads it as
   * transport failure (55-72.5%, below the 90% floor). Counted separately because "the provider
   * answered with nothing" is a different fact from "the model declined", and only one of them is a
   * finding.
   */
  emptyBody: number;
  /** Set once a body identifies an unrecoverable billing/permission state — see BILLING_STOP_RE. */
  billingStop: string | null;
}

/**
 * A 429 does not always mean "slow down".
 *
 * Moonshot answers an out-of-balance account with **HTTP 429**: `"Your account ... is suspended due
 * to insufficient balance, please recharge"`. Retrying that with exponential backoff is not
 * politeness, it is an infinite loop against a wall — the kimi leg spent **three hours** doing
 * exactly that on 2026-07-28 before anyone looked, because 429 was hardcoded as retryable.
 *
 * So retryability is decided by the BODY, not the status alone. Matching is on the durable words
 * these providers actually use; a miss costs the old behaviour (bounded retries), never a false stop.
 */
const BILLING_STOP_RE =
  /insufficient balance|suspended due to|credit balance is too low|billing|quota exceeded|payment required|recharge your account/i;

export function newTransportStats(): TransportStats {
  return {
    attempts: 0,
    ok: 0,
    rateLimited: 0,
    serverError: 0,
    otherHttp: 0,
    networkError: 0,
    retries: 0,
    emptyBody: 0,
    billingStop: null,
  };
}

/**
 * An empty 200 is retried after a SHORT fixed delay, not the exponential 429 backoff: it is not a
 * rate-limit signal and there is nothing to back off from. Deterministic, so a run reproduces.
 */
const EMPTY_BODY_RETRY_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wraps `fetch` with status accounting and bounded retry on 429/5xx, honouring `retry-after` when the
 * server sends it. Backoff is deterministic (no jitter) so a run stays reproducible.
 */
export function instrumentedFetch(
  stats: TransportStats,
  inner: typeof fetch = fetch,
  maxRetries = 5,
  baseDelayMs = 2_000,
): typeof fetch {
  // Parameters<typeof fetch> rather than RequestInfo: the DOM lib is not in this tsconfig's lib set,
  // so RequestInfo is not a declared name here — deriving from fetch keeps the wrapper exactly
  // assignable to what it wraps.
  return async (...args: Parameters<typeof fetch>): Promise<Response> => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      stats.attempts += 1;
      try {
        const res = await inner(...args);
        if (res.status === 429 || res.status >= 500) {
          if (res.status === 429) stats.rateLimited += 1;
          else stats.serverError += 1;
          // Read the body BEFORE deciding to retry: a 429 whose text says "insufficient balance" is
          // a wall, not a queue. Clone so the caller still gets an unconsumed body.
          if (stats.billingStop === null) {
            try {
              const body = await res.clone().text();
              if (BILLING_STOP_RE.test(body)) stats.billingStop = body.slice(0, 200);
            } catch {
              // Unreadable body — fall through to the ordinary retry path.
            }
          }
          if (stats.billingStop !== null) return res;
          if (attempt === maxRetries) return res;
          const retryAfter = Number(res.headers.get('retry-after') ?? '0');
          const waitMs = retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * Math.pow(2, attempt);
          stats.retries += 1;
          await sleep(waitMs);
          continue;
        }
        if (res.ok) {
          // A 200 with no body is a failure wearing a success code. Detected here, where the
          // distinction still exists — `replayPlanRow` collapses the resulting `res.json()` throw into
          // the same `{ok:false}` as a model that declined, and that conflation is what made the kimi
          // calibration unreadable.
          let bodyLength = -1;
          try {
            bodyLength = (await res.clone().text()).length;
          } catch {
            // Unreadable clone — fall through and let the caller deal with the original response.
          }
          if (bodyLength === 0) {
            stats.emptyBody += 1;
            if (attempt === maxRetries) return res;
            stats.retries += 1;
            await sleep(EMPTY_BODY_RETRY_MS);
            continue;
          }
          stats.ok += 1;
        } else stats.otherHttp += 1;
        return res;
      } catch (err) {
        lastError = err;
        stats.networkError += 1;
        if (attempt === maxRetries) throw err;
        stats.retries += 1;
        await sleep(baseDelayMs * Math.pow(2, attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('instrumentedFetch: exhausted');
  };
}

/**
 * ONE cheap call before committing to thousands, so a run cannot burn an hour discovering that the
 * account was never able to pay for it.
 *
 * Why (2026-07-28): runs 1 and 2 were both VOID because the Anthropic credit balance ran out
 * mid-run — the API answers `400 invalid_request_error: "Your credit balance is too low"`, which
 * `replayPlanRow` collapses to `{ok:false}` like any other failure. Run 1 therefore produced a
 * complete-looking NO_SURVIVOR table off a ~13% completion rate. The pre-flight verified the KEY
 * existed but never that it could SPEND, which is the check that actually mattered.
 *
 * Fails CLOSED: any non-2xx aborts the run before the first paid call. `max_tokens: 1` keeps the
 * probe's own cost negligible.
 */
export async function preflightCanSpend(
  apiKey: string,
  model: string,
  baseUrl = 'https://api.anthropic.com',
  rawFetch: typeof fetch = fetch,
): Promise<{ readonly ok: boolean; readonly status: number; readonly detail: string }> {
  const res = await rawFetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ok' }],
    }),
  });
  if (res.ok) return { ok: true, status: res.status, detail: '' };
  // The error BODY carries the cause and never credentials (same reasoning as
  // anthropic-agent-client.ts's attemptOnce, which embeds it for exactly this diagnosability).
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    detail = '[unreadable body]';
  }
  return { ok: false, status: res.status, detail };
}

/**
 * The precondition that would have caught run 1 automatically — but it has to measure the RIGHT
 * thing, and the first version did not.
 *
 * TRANSPORT failure and SCHEMA failure are different events that `replayPlanRow` collapses into the
 * same `{ok:false}`:
 *
 *   - **transport failure** — no HTTP 200, or a body that is not a parseable Anthropic envelope. The
 *     model never ran. A run full of these measures nothing and MUST be voided (run 1, 2026-07-28).
 *   - **schema failure** — the model answered and its answer did not satisfy the decision contract.
 *     That is genuine, informative model behaviour and must NEVER void a run.
 *
 * Conflating them is not hypothetical. kimi-k3's measured schema-valid rate is **0.71** (state.md,
 * 2026-07-22 head-to-head: "kimi's mode is thesis >300 chars"), so a naive 90% parsed-rate floor
 * would void an otherwise perfect kimi run for the sole reason that kimi writes long theses —
 * discarding a real measurement because the model has a style.
 *
 * The discriminator is `usage`: `replayPlanRow` populates it whenever the response envelope itself
 * parsed and only then, so `hadUsage` means exactly "the transport worked and the model answered".
 *
 * Fails CLOSED on transport; schema rate is reported and never gates.
 */
export const MIN_TRANSPORT_RATE = 0.9;

export interface CompletionStats {
  /** Calls where the model answered at all (HTTP 200 + parseable envelope). */
  readonly transported: number;
  /** Calls that produced a contract-valid decision. */
  readonly parsed: number;
  readonly total: number;
  /** transported / total — the VOID guard. */
  readonly transportRate: number;
  /** parsed / transported — reported, never gating; this is model behaviour, not harness health. */
  readonly schemaRate: number;
}

export function completionStats(
  perArm: ReadonlyMap<string, readonly ArmRowResult[]>,
): CompletionStats {
  let transported = 0;
  let parsed = 0;
  let total = 0;
  for (const list of perArm.values()) {
    for (const r of list) {
      // Counts CALLS, not rows. The `?? ` fallbacks make a single-call row (`calls` absent) score
      // exactly as it did before multi-voter rows existed, so the frozen arms' figures are unmoved.
      total += r.calls ?? 1;
      transported += r.transportedCalls ?? (r.hadUsage ? 1 : 0);
      parsed += r.parsedCalls ?? (r.ok ? 1 : 0);
    }
  }
  return {
    transported,
    parsed,
    total,
    transportRate: total === 0 ? 0 : transported / total,
    schemaRate: transported === 0 ? 0 : parsed / transported,
  };
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────────
export interface ArmRowResult {
  readonly rowId: string;
  readonly symbol: string;
  readonly eventTime: number;
  /** A contract-valid decision was parsed. */
  readonly ok: boolean;
  /**
   * The model answered at all — `replayPlanRow` returns `usage` iff the response envelope parsed, so
   * this separates "the API refused us" from "the model replied and broke the schema". Without it the
   * two are indistinguishable, which is what made run 1 look like a finding.
   */
  readonly hadUsage: boolean;
  readonly action?: string;
  /**
   * 'recorded' when the call presented the capabilities the LIVE system recorded on that row.
   *
   * Anything else means the replay described a different account to the model than live did, and the
   * 2026-07-30 defect proved that is not cosmetic: a hardcoded `venueFreeCash: '0'` cut the entry rate
   * from 18.2% to 4.5% on identical rows. The study therefore requires 'recorded' for every row.
   */
  readonly capsSource?: string;
  /**
   * Call-level accounting, present only on multi-voter (swarm) rows.
   *
   * A swarm row is N calls, so row-level `ok`/`hadUsage` would hide a third of the transport
   * failures behind whichever voter did answer. The transport floor is a statement about CALLS, so
   * the counts it reads have to be counts of calls.
   */
  readonly calls?: number;
  readonly transportedCalls?: number;
  readonly parsedCalls?: number;
  /** Each voter's parsed action, in call order; a voter that did not parse contributes nothing. */
  readonly votes?: readonly string[];
}

export interface RunOptions extends PlanReplayCallConfig {
  readonly rowsPerChunk: number;
  readonly concurrency: number;
  readonly capUsd: string;
  readonly reservePerCallUsd: string;
  /** Token rates the meter prices this run at. Defaults to sonnet-5 list rates. */
  readonly rates?: TokenRates;
  /** Voters per row. 1 (default) is the single-call shape every frozen arm ran under. */
  readonly votesPerRow?: number;
  /**
   * Per-arm override of `votesPerRow`, keyed by arm name.
   *
   * A swarm arm and its single-call control must run in the SAME chunk-major pass — guard 6 exists
   * so a budget abort truncates every arm at the same row — and they differ only in voter count, so
   * the voter count has to be an arm-level property rather than a run-level one.
   */
  readonly votesPerArm?: Readonly<Record<string, number>>;
  readonly onProgress?: (msg: string) => void;
}

export interface RunResult {
  /** Already truncated to the common row set — see truncateToCommonRows. */
  readonly perArm: ReadonlyMap<string, readonly ArmRowResult[]>;
  readonly rowsAttempted: number;
  /** Rows covered by EVERY arm. The only row count a cross-arm comparison may be built on. */
  readonly rowsCovered: number;
  readonly aborted: boolean;
  readonly meter: { readonly calls: number; readonly usd: string };
  readonly transport: TransportStats;
  readonly completion: CompletionStats;
  /**
   * Rows replayed with capabilities the live system did NOT record. Must be 0: a non-zero count means
   * the replay described a different account to the model than live did, which is the 2026-07-30
   * `venueFreeCash: '0'` defect and is worth 4x the entry rate.
   */
  readonly unfaithfulCapsRows: number;
  /** True when the run may NOT be published as a verdict — see MIN_TRANSPORT_RATE. */
  readonly voided: boolean;
}

/**
 * Restricts every arm to the rows that ALL arms reached, discarding the rest.
 *
 * Chunk-major ordering means a budget abort lands mid-chunk, so arms processed earlier in that chunk
 * carry rows the later arms never saw. Observed in the $1 smoke run: champion_v9/seed_v8 had 8 rows
 * while momentum_pure/shorts_only had 0. Comparing arm means across unequal row sets is comparing
 * different market windows and would silently bias the whole study toward whichever arms happened to
 * run first. Dropping to the common prefix costs a little data and buys the comparison's validity,
 * which is the only trade worth making here.
 */
export function truncateToCommonRows(perArm: ReadonlyMap<string, readonly ArmRowResult[]>): {
  readonly perArm: Map<string, ArmRowResult[]>;
  readonly rowsCovered: number;
} {
  const armLists = [...perArm.values()];
  let keep = new Set<string>(armLists[0]?.map((r) => r.rowId) ?? []);
  for (const list of armLists.slice(1)) {
    const ids = new Set(list.map((r) => r.rowId));
    keep = new Set([...keep].filter((id) => ids.has(id)));
  }
  const out = new Map<string, ArmRowResult[]>();
  for (const [name, list] of perArm)
    out.set(
      name,
      list.filter((r) => keep.has(r.rowId)),
    );
  return { perArm: out, rowsCovered: keep.size };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export type SwarmAction = 'open_long' | 'open_short' | 'hold';

/**
 * The swarm's scored action, exactly as the 2026-07-31 follow-on pre-registration fixes it:
 * "Majority vote over the parsed action in {open_long, open_short, everything-else}. Entry side is
 * the majority side. No majority, or a tie, resolves to hold."
 *
 * MAJORITY IS OVER THE VOTERS, NOT OVER THE VOTES CAST. A voter whose call failed or whose answer
 * broke the contract casts nothing, so it can only make a majority harder to reach — the same
 * fail-toward-hold direction the pre-registration declares for a tie. Counting a majority of the
 * *cast* votes would let a single surviving voter carry a 3-voter row, which is a single-call arm
 * wearing a swarm's name.
 */
export function majorityVote(votes: readonly string[], voters: number): SwarmAction {
  let long = 0;
  let short = 0;
  for (const v of votes) {
    if (v === 'open_long') long += 1;
    else if (v === 'open_short') short += 1;
  }
  // Strictly more than half, so at most one bucket can ever reach it — including the
  // everything-else bucket, whose win is a hold and needs no branch of its own.
  const needed = Math.floor(voters / 2) + 1;
  if (long >= needed) return 'open_long';
  if (short >= needed) return 'open_short';
  return 'hold';
}

/**
 * CHUNK-MAJOR ordering — a chunk of rows, then all twelve arms within it, then the next chunk. Two
 * reasons, both load-bearing: a budget abort truncates EVERY arm at the same row (so cross-arm
 * comparison stays valid), and each arm's playbook block is cache-warm for the whole chunk instead of
 * thrashing on every row. A partial run reports its true row count and is never presented as complete.
 */
export async function runReplay(
  rows: readonly CorpusRow[],
  arms: readonly { readonly arm: PlaybookArm; readonly content: string }[],
  opts: RunOptions,
  rawFetch: typeof fetch = fetch,
): Promise<RunResult> {
  const systemPrompt = buildSystemPrompt(DEFAULT_FLOOR_PROFILE);
  const blocks = new Map(arms.map(({ arm, content }) => [arm.name, buildPlaybookBlock(content)]));
  const perArm = new Map<string, ArmRowResult[]>(arms.map(({ arm }) => [arm.name, []]));
  const votersFor = (armName: string): number => {
    const n = opts.votesPerArm?.[armName] ?? opts.votesPerRow ?? 1;
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`runReplay: voters for ${armName} must be a positive integer, got ${n}`);
    }
    return n;
  };
  // Refuse at construction rather than discover a bad voter count mid-run, after money is spent.
  for (const { arm } of arms) votersFor(arm.name);
  const meter = new UsdMeter(
    new Decimal(opts.capUsd),
    new Decimal(opts.reservePerCallUsd),
    opts.rates,
  );
  // Every call goes through the instrumented wrapper: without it a rate-limited run is
  // indistinguishable from a run where the model held on every row (run 1, 2026-07-28, VOID).
  const stats = newTransportStats();
  const fetchFn = instrumentedFetch(stats, rawFetch);

  let rowsAttempted = 0;
  let aborted = false;

  for (let start = 0; start < rows.length && !aborted; start += opts.rowsPerChunk) {
    const chunk = rows.slice(start, start + opts.rowsPerChunk);
    for (const { arm } of arms) {
      // A suspended/unfunded account cannot recover mid-run: stop immediately rather than walk the
      // remaining chunks collecting failures (the kimi leg ground for 3h before this existed).
      if (stats.billingStop !== null) {
        aborted = true;
        break;
      }
      if (!meter.canSpend()) {
        aborted = true;
        break;
      }
      const block = blocks.get(arm.name)!;
      const voters = votersFor(arm.name);
      const results = await mapWithConcurrency(chunk, opts.concurrency, async (row) => {
        // The WHOLE row is reserved before its first call: a swarm row that runs out of budget
        // after 1 of 3 votes could not reach a majority and would record a hold nobody voted for.
        if (!meter.canSpend(voters)) return null;
        const calls: Awaited<ReturnType<typeof replayPlanRow>>[] = [];
        for (let v = 0; v < voters; v += 1) {
          const res = await replayPlanRow(opts, systemPrompt, block, row.inputPayload, fetchFn);
          meter.record(res.usage);
          calls.push(res);
        }
        const first = calls[0]!;
        if (voters === 1) {
          // The single-call shape every frozen arm ran under, unchanged — no vote fields, and the
          // RAW action rather than a bucketed one, so decision-change counts stay comparable.
          return {
            rowId: row.id,
            symbol: row.symbol,
            eventTime: row.eventTime,
            ok: first.ok,
            hadUsage: first.usage !== undefined,
            ...(first.action !== undefined ? { action: first.action } : {}),
            ...(first.capsSource !== undefined ? { capsSource: first.capsSource } : {}),
          } satisfies ArmRowResult;
        }
        const votes = calls.flatMap((c) => (c.ok && c.action !== undefined ? [c.action] : []));
        // Report the OFFENDING source when any voter saw non-recorded capabilities, so the
        // run-voiding faithfulness check sees a swarm row exactly as it sees a single-call row.
        const unfaithful = calls.find((c) => c.capsSource !== 'recorded');
        return {
          rowId: row.id,
          symbol: row.symbol,
          eventTime: row.eventTime,
          ok: votes.length > 0,
          hadUsage: calls.some((c) => c.usage !== undefined),
          action: majorityVote(votes, voters),
          capsSource: unfaithful?.capsSource ?? 'recorded',
          calls: calls.length,
          transportedCalls: calls.filter((c) => c.usage !== undefined).length,
          parsedCalls: votes.length,
          votes,
        } satisfies ArmRowResult;
      });
      for (const res of results) {
        if (res === null) {
          aborted = true;
          continue;
        }
        perArm.get(arm.name)!.push(res);
      }
    }
    if (!aborted) rowsAttempted = Math.min(start + opts.rowsPerChunk, rows.length);
    opts.onProgress?.(
      `rows ${rowsAttempted}/${rows.length} · ${meter.snapshot().calls} calls · $${meter.snapshot().usd}` +
        ` · http ok=${stats.ok} 429=${stats.rateLimited} 5xx=${stats.serverError} net=${stats.networkError} retries=${stats.retries}` +
        `${aborted ? ' · ABORTED (budget)' : ''}`,
    );
  }

  const common = truncateToCommonRows(perArm);
  const completion = completionStats(common.perArm);
  let unfaithfulCapsRows = 0;
  for (const list of common.perArm.values()) {
    for (const r of list) if (r.capsSource !== 'recorded') unfaithfulCapsRows += 1;
  }
  return {
    perArm: common.perArm,
    unfaithfulCapsRows,
    rowsAttempted,
    rowsCovered: common.rowsCovered,
    aborted,
    meter: meter.snapshot(),
    transport: stats,
    completion,
    // TRANSPORT rate, not parsed rate — a model that breaks the schema is data, not a broken run.
    voided: completion.transportRate < MIN_TRANSPORT_RATE,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// FOLLOW-ON, Family A — preregistered in research/studies/playbook-space-followon-2026-07-31.md
//
// One scored arm (`haiku_swarm`, N=3 majority vote on the incumbent's own playbook text) and one
// control (`haiku_single`, 1 call, same text). Everything below is a transcription of that frozen
// document; nothing here may be re-derived after a result is seen.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/** The incumbent's playbook text is what both arms run — the architecture is the only variable. */
export const FOLLOWON_PLAYBOOK_ARM = 'champion_v8';
export const FOLLOWON_MODEL = 'claude-haiku-4-5';
export const SWARM_ARM = 'haiku_swarm';
export const SINGLE_ARM = 'haiku_single';
/** Prereg § haiku_swarm: "N = 3 rather than 5", and the reason is that variance is the wrong lever. */
export const SWARM_N = 3;

/** Prereg § Family A alpha: 1 scored arm x 4 horizons = 4 cells, alpha = 0.05 / 4. */
export const FOLLOWON_FAMILY_A_CELLS = 4;
export const FOLLOWON_FAMILY_A_ALPHA = 0.05 / FOLLOWON_FAMILY_A_CELLS;

/** Owner decision 2026-07-30: haiku_swarm $5.10 + haiku_single $1.70. */
export const FOLLOWON_FAMILY_A_AUTHORISED_USD = 6.8;
/** Prereg § The funded ladder: "Funded total: $17.65 of the $18.00 allocation. Hard cap $21.00". */
export const FOLLOWON_HARD_CAP_USD = 21.0;

/**
 * How far a MEASURED haiku rate may push Family A past its $6.80 authorisation before the run
 * refuses to start.
 *
 * Not invented here: the pre-registration sized its own $3.35 of headroom against exactly one
 * scenario — "if haiku calibrates at 0.50x sonnet instead of the assumed 0.35x, a 43% overrun". So
 * 1.43x the authorisation is the document's own stated tolerance, and a projection past it is the
 * case the prereg never funded. Fails CLOSED: this gates spending, so it refuses rather than
 * proceeds.
 */
export const FOLLOWON_OVERRUN_TOLERANCE = 1.43;

/** Prereg § Deployment-bar declarations. Primary horizon declared before any comparison is seen. */
export const DEPLOYMENT_PRIMARY_HORIZON = 24;
/** The robustness clause: h=24 AND at least 3 of the 4 horizons, deliberately stricter than owner. */
export const DEPLOYMENT_MIN_HORIZONS_WON = 3;

/**
 * Minimum observations in EACH of the four halves (arm-early, arm-late, incumbent-early,
 * incumbent-late) for the chronological-halves clause to be DETERMINED.
 *
 * Not a new number: a half-mean is a mean, and this program has exactly one declared minimum n for
 * reading one — `MIN_ENTRIES = 12`, the research bar's clause 7, whose justification is empirical
 * ("the horizon study's n=11 cell showed +6.3% excess and reversed at n=84"). A half is a
 * cell-shaped quantity so it inherits the cell-shaped floor. Declared in the pre-registration record
 * (deployment-bar-halves-clause-2026-07-31.md § 8) BEFORE any run under the new bar, together with
 * the accepted consequence that a low-frequency arm faces a weaker deployment bar than a
 * high-frequency one.
 */
export const DEPLOYMENT_HALF_MIN_ENTRIES = MIN_ENTRIES;

// ── the sequencing constraint (prereg guard 9 — fails OPEN, downgrades attribution) ───────────────
export const PROMPT_SURFACE_FILE = 'src/features/strategy/agentic/agent-prompt.ts';
/** The blob at 2f1c917, the commit that published the predecessor's NO_SURVIVOR results. */
export const INCUMBENT_PROMPT_BLOB = 'c471c33055abad7c7ec0cb9978f81c61bc3c487d';

export interface PromptSurfaceCheck {
  readonly runSha: string;
  /** Blob of PROMPT_SURFACE_FILE at HEAD — the check the prereg writes literally. */
  readonly headBlob: string;
  /** Blob of the file as it sits on disk, which is what the run actually sends. */
  readonly worktreeBlob: string;
  readonly pinnedBlob: string;
  readonly promptControlled: boolean;
  readonly attribution: 'PROMPT-CONTROLLED' | 'BETWEEN-RUN';
  readonly note: string;
}

/**
 * FAILS OPEN, and that direction is the pre-registration's, not a convenience: guard 9 is a
 * measurement-QUALITY gate, so a mismatch downgrades the reported attribution to BETWEEN-RUN rather
 * than voiding a run that already cost real money. An unreadable git tree lands in the same place.
 *
 * The worktree blob is checked alongside HEAD's because HEAD's is what the prereg's command reads
 * while the worktree's is what the process actually loads — a dirty checkout would otherwise satisfy
 * the letter of the constraint while replaying different bytes.
 */
export function checkPromptSurface(cwd = process.cwd()): PromptSurfaceCheck {
  const git = (args: readonly string[]): string => {
    try {
      return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };
  const runSha = git(['rev-parse', 'HEAD']);
  const headBlob = git(['rev-parse', `HEAD:${PROMPT_SURFACE_FILE}`]);
  const worktreeBlob = git(['hash-object', PROMPT_SURFACE_FILE]);
  const promptControlled =
    headBlob === INCUMBENT_PROMPT_BLOB && worktreeBlob === INCUMBENT_PROMPT_BLOB;
  return {
    runSha,
    headBlob,
    worktreeBlob,
    pinnedBlob: INCUMBENT_PROMPT_BLOB,
    promptControlled,
    attribution: promptControlled ? 'PROMPT-CONTROLLED' : 'BETWEEN-RUN',
    note: promptControlled
      ? 'agent-prompt.ts is byte-identical at HEAD and on disk to the blob the predecessor ran — ' +
        'the deployment comparison against the recorded champion_v8 row is prompt-controlled. ' +
        'Provider-side model drift and re-run variance are NOT removed by this and are not fixable ' +
        'within the funded design.'
      : 'agent-prompt.ts differs from the predecessor blob — the deployment comparison is ' +
        'BETWEEN-RUN. No partial credit, and no argument that the differing hunk does not matter.',
  };
}

// ── the design, sized from a MEASURED haiku rate ──────────────────────────────────────────────────
export interface FollowonDesign {
  readonly family: 'A';
  readonly study: string;
  readonly corpusSha256: string;
  readonly rows: number;
  readonly model: string;
  readonly playbookArm: string;
  readonly swarmN: number;
  readonly scoredArms: readonly string[];
  readonly controlArms: readonly string[];
  readonly horizons: readonly number[];
  readonly cells: number;
  readonly alpha: number;
  readonly requiredEdgeBps: number;
  readonly minEntries: number;
  readonly measured: {
    readonly haikuUsdPerCall: number;
    readonly haikuUsdPerCallEffective: number;
    readonly projectedSwarmUsd: number;
    readonly projectedSingleUsd: number;
    readonly projectedFamilyAUsd: number;
  };
  readonly authorisedUsd: number;
  readonly overrunToleranceUsd: number;
  readonly hardCapUsd: number;
}

export const FOLLOWON_DESIGN_FILE = join(
  process.cwd(),
  'research',
  'candidates',
  'playbook-space-followon-design.json',
);

/**
 * Sizes Family A from the measured haiku rate and REFUSES rather than spending through an overrun.
 *
 * The refusal is the point. The predecessor's kimi estimate reversed from 0.61x to 1.9x between two
 * calibrations, and the haiku rate here is the design's one unmeasured number — so a projection that
 * lands past the pre-registration's own stated tolerance is a stop-and-report, not a budget note.
 */
export function sizeFollowonFamilyA(input: {
  readonly rows: number;
  readonly haikuUsdPerCall: number;
  readonly haikuUsdPerCallEffective: number;
  readonly corpusSha256: string;
  readonly calibrationSpentUsd: number;
}): FollowonDesign {
  for (const [name, value] of [
    ['rows', input.rows],
    ['haikuUsdPerCallEffective', input.haikuUsdPerCallEffective],
  ] as const) {
    if (!(value > 0) || !Number.isFinite(value)) {
      throw new Error(
        `sizeFollowonFamilyA: ${name} must be a positive finite number, got ${value}`,
      );
    }
  }
  const projectedSwarmUsd = input.rows * SWARM_N * input.haikuUsdPerCallEffective;
  const projectedSingleUsd = input.rows * input.haikuUsdPerCallEffective;
  const projectedFamilyAUsd = projectedSwarmUsd + projectedSingleUsd;
  const tolerance = FOLLOWON_FAMILY_A_AUTHORISED_USD * FOLLOWON_OVERRUN_TOLERANCE;
  if (projectedFamilyAUsd > tolerance) {
    throw new Error(
      `MEASURED CALIBRATION PUTS FAMILY A OVER ITS AUTHORISATION — projected ` +
        `$${projectedFamilyAUsd.toFixed(2)} (swarm $${projectedSwarmUsd.toFixed(2)} + control ` +
        `$${projectedSingleUsd.toFixed(2)}) at a measured $${input.haikuUsdPerCallEffective.toFixed(6)}/call ` +
        `against the $${FOLLOWON_FAMILY_A_AUTHORISED_USD.toFixed(2)} owner authorisation and a ` +
        `$${tolerance.toFixed(2)} tolerance (the prereg's own 43% overrun scenario). ` +
        `STOP AND REPORT — do not spend through it.`,
    );
  }
  if (input.calibrationSpentUsd + projectedFamilyAUsd > FOLLOWON_HARD_CAP_USD) {
    throw new Error(
      `HARD CAP — calibration $${input.calibrationSpentUsd.toFixed(2)} plus projected ` +
        `$${projectedFamilyAUsd.toFixed(2)} exceeds the $${FOLLOWON_HARD_CAP_USD.toFixed(2)} cap.`,
    );
  }
  return {
    family: 'A',
    study: 'playbook-space-followon-2026-07-31',
    corpusSha256: input.corpusSha256,
    rows: input.rows,
    model: FOLLOWON_MODEL,
    playbookArm: FOLLOWON_PLAYBOOK_ARM,
    swarmN: SWARM_N,
    scoredArms: [SWARM_ARM],
    controlArms: [SINGLE_ARM],
    horizons: [...HORIZONS],
    cells: FOLLOWON_FAMILY_A_CELLS,
    alpha: FOLLOWON_FAMILY_A_ALPHA,
    requiredEdgeBps: REQUIRED_EDGE_BPS,
    minEntries: MIN_ENTRIES,
    measured: {
      haikuUsdPerCall: input.haikuUsdPerCall,
      haikuUsdPerCallEffective: input.haikuUsdPerCallEffective,
      projectedSwarmUsd,
      projectedSingleUsd,
      projectedFamilyAUsd,
    },
    authorisedUsd: FOLLOWON_FAMILY_A_AUTHORISED_USD,
    overrunToleranceUsd: tolerance,
    hardCapUsd: FOLLOWON_HARD_CAP_USD,
  };
}

export function writeFollowonDesign(d: FollowonDesign, file = FOLLOWON_DESIGN_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(d, null, 2), 'utf8');
}

export function loadFollowonDesign(file = FOLLOWON_DESIGN_FILE): FollowonDesign {
  if (!existsSync(file)) {
    throw new Error(
      `no sized follow-on design at ${file} — run the haiku calibration probe first ` +
        `(PLAYBOOK_SPACE_FOLLOWON_CALIBRATE=1). The edge run refuses to size its own family.`,
    );
  }
  return JSON.parse(readFileSync(file, 'utf8')) as FollowonDesign;
}

// ── the two bars, computed ────────────────────────────────────────────────────────────────────────
export interface FamilyVerdict {
  readonly cellsScored: number;
  readonly cellsDeclared: number;
  readonly complete: boolean;
  readonly passes: readonly LaneCell[];
  readonly bestPowered: LaneCell | null;
  readonly verdict: 'SURVIVOR' | 'NO_SURVIVOR' | 'INCOMPLETE';
}

/**
 * The RESEARCH-bar verdict for one family, on the same contract `aggregateVerdict` applies across
 * the model axis and through the same `summariseCells` core: an incomplete family is INCOMPLETE and
 * never NO_SURVIVOR, and ranking (`bestPowered`) is never passing.
 *
 * Only SCORED cells may be passed in. A control's cells never enter — the pre-registration's
 * anti-loophole clause is that a control can never PASS, so the way to honour it is to never hand a
 * control's numbers to a verdict function in the first place.
 */
export function aggregateFamilyVerdict(
  cells: readonly LaneCell[],
  cellsDeclared: number,
): FamilyVerdict {
  const { passes, bestPowered } = summariseCells(cells);
  const complete = cells.length >= cellsDeclared;
  return {
    cellsScored: cells.length,
    cellsDeclared,
    complete,
    passes,
    bestPowered,
    verdict: !complete ? 'INCOMPLETE' : passes.length > 0 ? 'SURVIVOR' : 'NO_SURVIVOR',
  };
}

export interface HorizonComparison {
  readonly h: number;
  readonly armMean: number;
  readonly incumbentMean: number;
  readonly deltaBps: number;
  readonly beats: boolean;
}

export type HalvesVerdict = 'BOTH_WON' | 'HALF_LOST' | 'UNDETERMINED';

/** The four half-means the clause compares, plus the counts and instant that decide DETERMINED. */
export interface DeploymentHalves {
  /** The run's shared split instant, or null when the comparison was handed none. */
  readonly splitAtMs: number | null;
  readonly armEarly: number;
  readonly armLate: number;
  readonly incumbentEarly: number;
  readonly incumbentLate: number;
  readonly armEarlyN: number;
  readonly armLateN: number;
  readonly incumbentEarlyN: number;
  readonly incumbentLateN: number;
  readonly minEntries: number;
  readonly determined: boolean;
  readonly reason: string;
}

export interface DeploymentComparison {
  readonly arm: string;
  readonly incumbent: string;
  readonly primaryHorizon: number;
  readonly perHorizon: readonly HorizonComparison[];
  readonly beatsAtPrimary: boolean;
  readonly horizonsWon: number;
  readonly horizonsCompared: number;
  /**
   * h=24 AND >= 3 of 4 horizons: the ORIGINAL two pre-registered conjuncts, unchanged and reported
   * separately so the halves clause can be told apart from the horizon clause in every output.
   */
  readonly beatsHorizonBar: boolean;
  /** Both original conjuncts AND the halves clause did not MEASURE a lost half. */
  readonly ships: boolean;
  /** Wins at h=24 but misses the 3-of-4 clause. Unchanged in meaning and value by the halves clause. */
  readonly horizonDependent: boolean;
  /** The chronological-halves clause at the PRIMARY horizon only — three-valued, never a boolean. */
  readonly halvesVerdict: HalvesVerdict;
  readonly halves: DeploymentHalves;
  readonly attribution: PromptSurfaceCheck['attribution'];
}

/**
 * The chronological-halves clause, at the primary horizon only.
 *
 * Reads ONLY the `*At` (calendar-split) fields. A cell that carries no `*At` fields — every cell
 * read from a frozen artifact, and every cell computed before a split instant existed — is
 * UNDETERMINED, which is the honest answer and never a failure. It is deliberately NOT satisfiable
 * from `firstHalf`/`secondHalf`: those measure each arm's own rank midpoint, so a BOTH_WON obtained
 * from them would carry the name of a robustness guard while measuring an arithmetic accident
 * (record § 6.3).
 */
function judgeHalves(
  armPrimary: LaneCell | undefined,
  incumbentPrimary: LaneCell | undefined,
  splitAtMs: number | undefined,
): { readonly verdict: HalvesVerdict; readonly halves: DeploymentHalves } {
  const armEarly = armPrimary?.firstHalfAt ?? Number.NaN;
  const armLate = armPrimary?.secondHalfAt ?? Number.NaN;
  const incumbentEarly = incumbentPrimary?.firstHalfAt ?? Number.NaN;
  const incumbentLate = incumbentPrimary?.secondHalfAt ?? Number.NaN;
  const armEarlyN = armPrimary?.nFirstHalfAt ?? 0;
  const armLateN = armPrimary?.nSecondHalfAt ?? 0;
  const incumbentEarlyN = incumbentPrimary?.nFirstHalfAt ?? 0;
  const incumbentLateN = incumbentPrimary?.nSecondHalfAt ?? 0;

  const means = [armEarly, armLate, incumbentEarly, incumbentLate];
  const counts = [armEarlyN, armLateN, incumbentEarlyN, incumbentLateN];
  const allFinite = means.every((v) => Number.isFinite(v));
  const allPowered = counts.every((c) => c >= DEPLOYMENT_HALF_MIN_ENTRIES);
  const determined = allFinite && allPowered;

  // Ties are NOT wins, matching `beats: a.mean > i.mean` on the horizon table.
  const verdict: HalvesVerdict = !determined
    ? 'UNDETERMINED'
    : armEarly > incumbentEarly && armLate > incumbentLate
      ? 'BOTH_WON'
      : 'HALF_LOST';
  const shape = (n: number): string => `${n}`;
  const reason = !allFinite
    ? `a half-mean is not finite (arm ${armEarlyN}/${armLateN} vs incumbent ` +
      `${incumbentEarlyN}/${incumbentLateN} entries) — the clause is UNDETERMINED and fails OPEN. ` +
      'Most often this is a comparator read from a frozen artifact, which carries no per-entry ' +
      'times and can never satisfy the clause at any effort.'
    : !allPowered
      ? `a half holds fewer than ${DEPLOYMENT_HALF_MIN_ENTRIES} entries (arm ` +
        `${shape(armEarlyN)}/${shape(armLateN)}, incumbent ${shape(incumbentEarlyN)}/` +
        `${shape(incumbentLateN)}) — UNDETERMINED, fails OPEN.`
      : verdict === 'BOTH_WON'
        ? `wins BOTH chronological halves at the primary horizon (early ${armEarly.toFixed(1)} vs ` +
          `${incumbentEarly.toFixed(1)}, late ${armLate.toFixed(1)} vs ${incumbentLate.toFixed(1)} bps).`
        : `loses the ${armEarly > incumbentEarly ? 'LATE' : 'EARLY'} half at the primary horizon ` +
          `(early ${armEarly.toFixed(1)} vs ${incumbentEarly.toFixed(1)}, late ${armLate.toFixed(1)} ` +
          `vs ${incumbentLate.toFixed(1)} bps) — a win located in half of a single-regime window. ` +
          'Fails CLOSED: it does not ship.';

  return {
    verdict,
    halves: {
      splitAtMs: splitAtMs ?? null,
      armEarly,
      armLate,
      incumbentEarly,
      incumbentLate,
      armEarlyN,
      armLateN,
      incumbentEarlyN,
      incumbentLateN,
      minEntries: DEPLOYMENT_HALF_MIN_ENTRIES,
      determined,
      reason,
    },
  };
}

/**
 * The DEPLOYMENT bar: a ranking of measured means among options that all have to be somewhere. Not
 * alpha-corrected, because it tests no hypothesis against a null — and evaluated independently of,
 * and regardless of, the research-bar outcome.
 *
 * THE THIRD CONJUNCT, added 2026-07-31 under the pre-registered record
 * `research/studies/deployment-bar-halves-clause-2026-07-31.md`: the arm must also not LOSE either
 * chronological half at the primary horizon. That docstring above is not weakened by it — the clause
 * introduces no null, no p-value and no alpha; it compares the same two measured means twice on
 * disjoint subsets of the same rows. The bar remains a ranking that now has to hold on both halves
 * of the window rather than on the window's average alone.
 *
 * Two failure directions, and they differ: a MEASURED half-loss fails CLOSED (does not ship), an
 * UNDETERMINED half fails OPEN (ships, and is reported). The unattended mint gate is the single
 * caller that refuses on UNDETERMINED, for a reason about authority rather than evidence —
 * `classifyMintGate` in scripts/loop-authoring-core.mjs.
 */
export function compareToIncumbent(
  armName: string,
  armCells: readonly LaneCell[],
  incumbentName: string,
  incumbentCells: readonly LaneCell[],
  attribution: PromptSurfaceCheck['attribution'],
  splitAtMs?: number,
): DeploymentComparison {
  const perHorizon: HorizonComparison[] = [];
  for (const h of HORIZONS) {
    const a = armCells.find((c) => c.h === h);
    const i = incumbentCells.find((c) => c.h === h);
    if (a === undefined || i === undefined) continue;
    perHorizon.push({
      h,
      armMean: a.mean,
      incumbentMean: i.mean,
      deltaBps: a.mean - i.mean,
      beats: a.mean > i.mean,
    });
  }
  const beatsAtPrimary = perHorizon.find((c) => c.h === DEPLOYMENT_PRIMARY_HORIZON)?.beats ?? false;
  const horizonsWon = perHorizon.filter((c) => c.beats).length;
  // The two ORIGINAL conjuncts, isolated. `horizonDependent` is defined against THIS rather than
  // against `ships`, which keeps its value identical to what it was before the halves clause existed
  // and keeps the two refusals distinguishable: "wins h=24 only" and "loses a half" are different
  // findings and a reader must never see the second reported as the first.
  const beatsHorizonBar = beatsAtPrimary && horizonsWon >= DEPLOYMENT_MIN_HORIZONS_WON;
  const { verdict: halvesVerdict, halves } = judgeHalves(
    armCells.find((c) => c.h === DEPLOYMENT_PRIMARY_HORIZON),
    incumbentCells.find((c) => c.h === DEPLOYMENT_PRIMARY_HORIZON),
    splitAtMs,
  );
  const ships = beatsHorizonBar && halvesVerdict !== 'HALF_LOST';
  return {
    arm: armName,
    incumbent: incumbentName,
    primaryHorizon: DEPLOYMENT_PRIMARY_HORIZON,
    perHorizon,
    beatsAtPrimary,
    horizonsWon,
    horizonsCompared: perHorizon.length,
    beatsHorizonBar,
    ships,
    horizonDependent: beatsAtPrimary && !beatsHorizonBar,
    halvesVerdict,
    halves,
    attribution,
  };
}

/**
 * The predecessor's RECORDED rows, which are the Family A comparator because `incumbent_control` is
 * unfunded (prereg § The sequencing constraint). Read from the 2026-07-28 leg artifact rather than
 * re-measured, and the comparison's controlled-vs-between-run status is reported separately.
 *
 * EVERY CELL IS REBUILT FIELD BY FIELD, and that is a safety barrier rather than a style choice.
 *
 * The frozen artifact's cells carry `firstHalf`/`secondHalf` — the INDEX-split fields — and the
 * parse type does not declare them, so before this projection existed they arrived at runtime while
 * being invisible to the compiler. Spreading the parsed object into a `LaneCell` would therefore
 * have made the deployment bar's chronological-halves clause satisfiable from an arm-relative rank
 * artifact: `UNDETERMINED` would silently become a green `BOTH_WON`, reported as a robustness guard
 * that had passed (halves-clause record § 6.3 — "worse than not having the clause"). Listing the
 * fields makes that substitution structurally impossible rather than merely discouraged, and the
 * accompanying spec asserts it.
 *
 * The artifact is frozen and carries no per-row data at all, so the incumbent's per-entry event
 * times cannot be recovered at any effort. Whenever the comparator is this recorded row the halves
 * clause reads UNDETERMINED BY CONSTRUCTION, fails open, and the deployment decision runs on the two
 * original conjuncts exactly as it did before the clause existed (§ 6.2).
 */
export function loadRecordedIncumbentCells(
  arm: string,
  file = join(
    process.cwd(),
    'research',
    'candidates',
    'playbook-space-replay-claude-sonnet-5-2026-07-28.json',
  ),
): { readonly cells: readonly LaneCell[]; readonly corpusSha256: string } {
  if (!existsSync(file)) {
    throw new Error(`predecessor result artifact not found: ${file} — no deployment comparator`);
  }
  const leg = JSON.parse(readFileSync(file, 'utf8')) as {
    manifest: { payloadSha256: string };
    cells: {
      model: string;
      arm: string;
      h: number;
      n: number;
      mean: number;
      ciLo: number;
      verdict: string;
    }[];
  };
  const cells: LaneCell[] = leg.cells
    .filter((c) => c.arm === arm)
    .map((c) => ({
      model: c.model,
      arm: c.arm,
      h: c.h,
      n: c.n,
      mean: c.mean,
      ciLo: c.ciLo,
      verdict: c.verdict,
    }));
  if (cells.length === 0) throw new Error(`predecessor artifact has no recorded rows for ${arm}`);
  return { cells, corpusSha256: leg.manifest.payloadSha256 };
}
