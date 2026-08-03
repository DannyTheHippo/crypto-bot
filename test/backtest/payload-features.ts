import { baseAssetOf, makeRand } from './live-frame';

// ── Payload-microstructure subgroup search: PURE extraction + statistics ─────────────────────────
//
// Pre-registration: research/studies/payload-microstructure-prereg-2026-08-04.md. Every constant,
// feature, cut and threshold in this file is frozen THERE FIRST — this module implements that
// document and adds no knob of its own. A value here that disagrees with the pre-registration is a
// defect in this file, not a licence to update the document.
//
// No I/O, no clock, no process/env access. The DB-gated spec (payload-subgroup.spec.ts) gathers rows
// and renders; every judgement lives here.
//
// FAILURE DIRECTION — this is a MEASUREMENT and it FAILS OPEN. Nothing here can block a pass, a
// deploy or trading; a cell it cannot compute reads UNDETERMINED or UNDERPOWERED BY NAME rather than
// silently vanishing into an average. Reference-grade floats throughout (order-book and forward-
// return display numbers, per root CLAUDE.md rule 1) — never a money path.

// ── frozen constants (pre-registration §6, §7, §8) ───────────────────────────────────────────────

/** The bar. STRATEGY_INTERVAL=15m — same constant as scripts/loop-forward-return-core.mjs:43. */
export const BAR_MS = 900_000;

/** Ported from scripts/loop-forward-return-core.mjs:46 so this study scores at the same horizons as
 *  every sibling instrument. */
export const HORIZONS = [1, 4, 8, 24] as const;

/** Ported from scripts/loop-forward-return-core.mjs:52 — "never act on a sub-n>=12 cell". */
export const MIN_ENTRIES = 12;

/** Ported from scripts/loop-forward-return-core.mjs:76. The bootstrap resamples BASE ASSETS, so a
 *  handful of assets is a handful of effective observations however many rows there are; below five
 *  the order statistics are a lattice artifact, not a measurement of sampling error. */
export const MIN_CLUSTERS = 5;

/** Ported from scripts/loop-forward-return-core.mjs:110. Gaps are not missing-at-random — the lane
 *  goes down during incidents, which correlate with market events — so a horizon past this share
 *  reads UNDETERMINED rather than reporting the calm-biased subsample that survived. */
export const MAX_GAP_SHARE = 0.2;

export const N_BOOT = 20_000;

/** Ported from scripts/loop-forward-return-core.mjs:99. Frozen so two runs over identical rows give
 *  byte-identical intervals — otherwise a run could be repeated until it liked its interval. */
export const BOOTSTRAP_SEED = 20260731;

/** This study's own, distinct from BOOTSTRAP_SEED so the placebo stream cannot couple to the
 *  interval stream. */
export const PLACEBO_SEED = 20260804;

export const N_PLACEBO = 200;

/** Family-wise α (pre-registration §7). The per-cell α is this divided by the DECLARED cell count. */
export const ALPHA_FAMILY = 0.05;

// ── features (pre-registration §3) ───────────────────────────────────────────────────────────────

export type FeatureId = 'A1' | 'A2' | 'A3' | 'B1' | 'B2' | 'C1' | 'C2' | 'D1';
export type CutKind = 'median' | 'sign';

export const CUTS: readonly CutKind[] = ['median', 'sign'];

export interface FeatureSpec {
  readonly id: FeatureId;
  readonly family: string;
  readonly label: string;
  /**
   * The feature's SIGNED form, before direction alignment: raw for the neutral-zero features, `x - 1`
   * for the neutral-one RATIO features (B1/B2), whose definitional balance point is 1.0 — equal
   * long/short accounts, equal taker buy/sell volume. A definitional neutral is not a tuned
   * threshold; no threshold in this study was chosen by looking at an outcome.
   *
   * Returns null when the block or field is absent/unusable on this row — that row simply leaves this
   * feature's population, and its absence is counted by the caller rather than coerced to zero.
   */
  readonly signed: (payload: PayloadShape) => number | null;
}

/** The subset of the rendered user-message payload this study reads. Every field is optional because
 *  every block is rendered under the omit-entirely convention (agent-prompt.ts:1370-1397) — an absent
 *  key means the feed did not ride in, never that the value was zero. */
export interface PayloadShape {
  readonly bookStructure?: {
    readonly micropriceBps?: unknown;
    readonly depthWeightedImbalance10?: unknown;
    readonly bidDepthNotional25bps?: unknown;
    readonly askDepthNotional25bps?: unknown;
  };
  readonly positioning?: {
    readonly longShortRatio?: unknown;
    readonly takerBuySellRatio?: unknown;
  };
  readonly derivatives?: {
    readonly fundingRate?: unknown;
    readonly basisBps?: unknown;
  };
  readonly fundingHistory?: {
    readonly recent?: unknown;
    readonly predicted?: unknown;
  };
}

/** A finite number, or null. Never coerces: a null/undefined/string/NaN field leaves the population
 *  instead of becoming a 0 that would sit on one side of every sign cut. */
function num(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

/**
 * The eight frozen features. Ordered A1..D1 exactly as the pre-registration table lists them, so the
 * declared cell count (8 x 2 x 4 = 64) is readable off this array's length rather than restated.
 *
 * Field names read from the rendered builders in src/features/strategy/agentic/agent-prompt.ts:
 * buildBookStructureBlock (:869-940), buildDerivativesBlock (:952-981), buildFundingHistoryBlock
 * (:990-997), buildPositioningBlock (:1028-1048).
 */
export const FEATURES: readonly FeatureSpec[] = [
  {
    id: 'A1',
    family: 'bookStructure',
    label: 'micropriceBps',
    signed: (p) => num(p.bookStructure?.micropriceBps),
  },
  {
    id: 'A2',
    family: 'bookStructure',
    label: 'depthWeightedImbalance10',
    signed: (p) => num(p.bookStructure?.depthWeightedImbalance10),
  },
  {
    id: 'A3',
    family: 'bookStructure',
    label: 'depthImbalance25bps',
    // Scale-free by construction. The raw notionals are dominated by symbol identity (a BTC book
    // against a NEAR book), so a median split on either raw side would be a split on WHICH SYMBOL —
    // and the cluster bootstrap would then be resampling the very thing the cut encodes.
    signed: (p) => {
      const bid = num(p.bookStructure?.bidDepthNotional25bps);
      const ask = num(p.bookStructure?.askDepthNotional25bps);
      if (bid === null || ask === null) return null;
      const total = bid + ask;
      if (!(total > 0)) return null;
      return (bid - ask) / total;
    },
  },
  {
    id: 'B1',
    family: 'positioning',
    label: 'longShortRatio',
    signed: (p) => {
      const v = num(p.positioning?.longShortRatio);
      return v === null ? null : v - 1;
    },
  },
  {
    id: 'B2',
    family: 'positioning',
    label: 'takerBuySellRatio',
    // May be null while the rest of the positioning block is valid (agent-prompt.ts:1042-1046) — the
    // row leaves B2's population only, never the whole family's.
    signed: (p) => {
      const v = num(p.positioning?.takerBuySellRatio);
      return v === null ? null : v - 1;
    },
  },
  {
    id: 'C1',
    family: 'derivatives',
    label: 'fundingRate',
    signed: (p) => num(p.derivatives?.fundingRate),
  },
  {
    id: 'C2',
    family: 'derivatives',
    label: 'basisBps',
    signed: (p) => num(p.derivatives?.basisBps),
  },
  {
    id: 'D1',
    family: 'fundingHistory',
    label: 'fundingTrendDelta (predicted - mean(recent))',
    // RECONSTRUCTS the derivatives-v2 field `fundingTrendDelta`, which was never rendered on a single
    // entry row (derivativesV2Enabled off for the whole entry history — pre-registration §2.3). Same
    // quantity, computed from the block that does render.
    signed: (p) => {
      const recent = p.fundingHistory?.recent;
      const predicted = num(p.fundingHistory?.predicted);
      if (predicted === null || !Array.isArray(recent) || recent.length === 0) return null;
      let sum = 0;
      for (const r of recent) {
        const v = num(r);
        if (v === null) return null;
        sum += v;
      }
      return predicted - sum / recent.length;
    },
  },
];

/** 8 features x 2 cut types x 4 horizons — the Bonferroni denominator, DERIVED from the frozen lists
 *  rather than typed as a literal, so it cannot drift from them. Pre-registration §7 states 64. */
export const DECLARED_CELLS = FEATURES.length * CUTS.length * HORIZONS.length;

export const ALPHA_CELL = ALPHA_FAMILY / DECLARED_CELLS;

// ── payload parsing (guarded — the column is TEXT, not jsonb) ────────────────────────────────────

/**
 * `agent_decisions.input_payload` is a TEXT column. A bare `::jsonb` cast in SQL throws on the FIRST
 * unparseable row and takes the entire read down with it, so parsing happens here, per row, inside a
 * guard — and an unparseable row is returned as null so the caller can COUNT it by name rather than
 * lose it silently into a smaller denominator.
 */
export function parsePayload(text: string | null): PayloadShape | null {
  if (text === null || text === '') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    // A payload that parses to an array or a scalar is not the rendered user message; it is refused
    // here so a malformed row is COUNTED as unparseable rather than silently contributing no features.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── the price grid (ported from scripts/loop-forward-return-core.mjs:307-401) ────────────────────
//
// Ported rather than imported: that module is `.mjs` and this repo's tsconfig has no allowJs, so a
// direct import cannot typecheck. The convention is reproduced exactly — same de-duplication, same
// off-grid refusal, same TIME-TARGET lookup, same status vocabulary — and the port is named here so a
// future divergence is visible rather than silent.

export interface GridRow {
  readonly eventTime: number;
  readonly venue: string;
  readonly symbol: string;
  readonly close: number;
}

export interface Series {
  readonly ts: number[];
  readonly close: number[];
}

/** Key on (venue, symbol), NEVER symbol alone: the same symbol string on `binance` and `binanceusdm`
 *  is two different books, and a forward return crossing between them would be pure fiction. */
export function gridKey(venue: string, symbol: string): string {
  return `${venue} ${symbol}`;
}

export interface Grid {
  readonly series: Map<string, Series>;
  readonly rejected: number;
  readonly offGrid: number;
}

export function buildGrid(rows: readonly GridRow[]): Grid {
  const series = new Map<string, Series>();
  let rejected = 0;
  let offGrid = 0;
  for (const r of rows) {
    const t = r.eventTime;
    const c = r.close;
    if (!Number.isFinite(t) || !Number.isFinite(c) || !(c > 0)) {
      rejected += 1;
      continue;
    }
    // A row off the 15m grid cannot be the bar the close convention describes, whatever its
    // trigger_kind claims — refusing it here means the measurement does not depend on the SQL filter
    // being right.
    if (t % BAR_MS !== 0) {
      offGrid += 1;
      continue;
    }
    const k = gridKey(r.venue, r.symbol);
    let s = series.get(k);
    if (!s) {
      s = { ts: [], close: [] };
      series.set(k, s);
    }
    s.ts.push(t);
    s.close.push(c);
  }
  for (const s of series.values()) {
    const order = s.ts.map((_, i) => i).sort((a, b) => s.ts[a]! - s.ts[b]!);
    const ts = order.map((i) => s.ts[i]!);
    const close = order.map((i) => s.close[i]!);
    s.ts.length = 0;
    s.close.length = 0;
    // One (venue,symbol) can carry more than one row at the same event_time (a decide plus a quiet
    // row). Same bar, same close — keep the first.
    for (let i = 0; i < ts.length; i += 1) {
      if (i > 0 && ts[i] === ts[i - 1]) continue;
      s.ts.push(ts[i]!);
      s.close.push(close[i]!);
    }
  }
  return { series, rejected, offGrid };
}

function lowerBound(ts: readonly number[], target: number): number {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type FwdStatus = 'ok' | 'gap' | 'pending' | 'no_series' | 'no_entry_bar' | 'bad_price';

export interface FwdResult {
  readonly status: FwdStatus;
  readonly bps: number | null;
}

/**
 * Direction-signed forward return in bps, `h` bars ahead of `t0`, anchored on the DECISION-BAR CLOSE.
 *
 * The lookup is by TIME TARGET (`t0 + h * BAR_MS`), never by array offset: the live series has holes
 * (the lane goes down), and indexing `i + h` across a hole silently measures a longer horizon than it
 * reports. A match more than one bar past target is a GAP yielding no observation, never a
 * mislabelled one.
 *
 * `pending` (the forward bar has not happened yet) and `gap` (it should exist and does not) are kept
 * apart because pooling them would turn every fresh window into a false gap-rule failure.
 */
export function forwardBps(
  series: ReadonlyMap<string, Series>,
  venue: string,
  symbol: string,
  t0: number,
  h: number,
  dir: number,
): FwdResult {
  const s = series.get(gridKey(venue, symbol));
  if (!s || s.ts.length === 0) return { status: 'no_series', bps: null };
  const i0 = lowerBound(s.ts, t0);
  // The entry's own bar must be present and EXACT — an entry scored off a neighbouring bar's close is
  // a different measurement wearing this one's name.
  if (i0 >= s.ts.length || s.ts[i0] !== t0) return { status: 'no_entry_bar', bps: null };
  const target = t0 + h * BAR_MS;
  const i1 = lowerBound(s.ts, target);
  if (i1 >= s.ts.length) {
    return { status: s.ts[s.ts.length - 1]! < target ? 'pending' : 'gap', bps: null };
  }
  if (s.ts[i1]! - target > BAR_MS) return { status: 'gap', bps: null };
  const c0 = s.close[i0]!;
  const c1 = s.close[i1]!;
  if (!(c0 > 0) || !(c1 > 0)) return { status: 'bad_price', bps: null };
  return { status: 'ok', bps: dir * ((c1 - c0) / c0) * 10_000 };
}

// ── entries and the direction-aligned frame (pre-registration §4) ────────────────────────────────

export interface EntryRow {
  readonly eventTime: number;
  readonly venue: string;
  readonly symbol: string;
  readonly action: string;
  readonly payloadText: string | null;
}

export interface ScoredEntry {
  readonly eventTime: number;
  readonly venue: string;
  readonly symbol: string;
  readonly dir: 1 | -1;
  /** ALIGNED feature values (`dir * signed`), present features only. A feature absent from this map
   *  means the row is outside that feature's population — never that its value was zero. */
  readonly aligned: ReadonlyMap<FeatureId, number>;
}

export interface EntryExtraction {
  readonly entries: readonly ScoredEntry[];
  /** Rows whose TEXT payload would not parse as a JSON object. Named and counted, never dropped
   *  silently — the whole reason parsing is not a `::jsonb` cast. */
  readonly unparseable: number;
  /** Rows carrying no payload at all (NULL column). */
  readonly noPayload: number;
  /** Rows with an unusable action/venue/symbol/event_time, or an event_time off the 15m grid. */
  readonly unusable: number;
  readonly offGrid: number;
  /** Per-feature present count over the entries that survived. */
  readonly presence: ReadonlyMap<FeatureId, number>;
}

export function extractEntries(rows: readonly EntryRow[]): EntryExtraction {
  const entries: ScoredEntry[] = [];
  const presence = new Map<FeatureId, number>(FEATURES.map((f) => [f.id, 0]));
  let unparseable = 0;
  let noPayload = 0;
  let unusable = 0;
  let offGrid = 0;

  for (const r of rows) {
    const dir = r.action === 'open_long' ? 1 : r.action === 'open_short' ? -1 : null;
    if (dir === null || typeof r.venue !== 'string' || typeof r.symbol !== 'string') {
      unusable += 1;
      continue;
    }
    if (!Number.isFinite(r.eventTime)) {
      unusable += 1;
      continue;
    }
    if (r.eventTime % BAR_MS !== 0) {
      offGrid += 1;
      continue;
    }
    if (r.payloadText === null) {
      noPayload += 1;
      continue;
    }
    const payload = parsePayload(r.payloadText);
    if (payload === null) {
      unparseable += 1;
      continue;
    }
    const aligned = new Map<FeatureId, number>();
    for (const f of FEATURES) {
      const s = f.signed(payload);
      if (s === null || !Number.isFinite(s)) continue;
      aligned.set(f.id, dir * s);
      presence.set(f.id, (presence.get(f.id) ?? 0) + 1);
    }
    entries.push({
      eventTime: r.eventTime,
      venue: r.venue,
      symbol: r.symbol,
      dir,
      aligned,
    });
  }

  return { entries, unparseable, noPayload, unusable, offGrid, presence };
}

// ── cuts (pre-registration §5) ───────────────────────────────────────────────────────────────────

/** Sample median. Even-length ⇒ the mean of the two central values, the usual convention. */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * HIGH membership for a frozen cut. Ties on the median go to the LOW group — declared in the
 * pre-registration before scoring so the tie rule could not be chosen after seeing an outcome.
 */
export function isHigh(cut: CutKind, alignedValue: number, medianValue: number): boolean {
  return cut === 'median' ? alignedValue > medianValue : alignedValue >= 0;
}

// ── statistics (pre-registration §8) ─────────────────────────────────────────────────────────────

export interface Obs {
  readonly symbol: string;
  readonly value: number;
}

export interface PairedDelta {
  readonly bases: number;
  readonly draws: readonly number[];
  /** Draws whose resample carried zero observations for one side. COUNTED, never dropped — dropping
   *  them narrows the interval exactly as if every draw had been well behaved. */
  readonly degenerate: number;
}

/**
 * PAIRED cluster bootstrap for the difference of two group means scored on the SAME base-asset
 * clusters. Ported from `pairedClusterBootstrapDelta` (scripts/loop-forward-return-core.mjs:214-254):
 * the SAME resampled base-asset list is applied to both sides in each draw, because subtracting two
 * independently-resampled intervals overstates the variance of a difference.
 *
 * Clusters are sorted before resampling, so the frozen seed actually buys byte-identical reruns
 * regardless of psql row order.
 */
export function pairedClusterBootstrapDelta(
  high: readonly Obs[],
  low: readonly Obs[],
  rand: () => number,
  nBoot: number,
): PairedDelta {
  const group = (obs: readonly Obs[]): Map<string, number[]> => {
    const byAsset = new Map<string, number[]>();
    for (const o of obs) {
      const key = baseAssetOf(o.symbol);
      const list = byAsset.get(key);
      if (list) list.push(o.value);
      else byAsset.set(key, [o.value]);
    }
    return byAsset;
  };
  const byHigh = group(high);
  const byLow = group(low);
  const bases = [...new Set([...byHigh.keys(), ...byLow.keys()])].sort();
  const draws: number[] = [];
  let degenerate = 0;
  for (let b = 0; b < nBoot; b += 1) {
    let sumH = 0;
    let countH = 0;
    let sumL = 0;
    let countL = 0;
    for (let k = 0; k < bases.length; k += 1) {
      const pick = bases[(rand() * bases.length) | 0]!;
      for (const v of byHigh.get(pick) ?? []) {
        sumH += v;
        countH += 1;
      }
      for (const v of byLow.get(pick) ?? []) {
        sumL += v;
        countL += 1;
      }
    }
    if (countH === 0 || countL === 0) {
      degenerate += 1;
      continue;
    }
    draws.push(sumH / countH - sumL / countL);
  }
  draws.sort((a, b) => a - b);
  return { bases: bases.length, draws, degenerate };
}

function meanOf(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;
}

function clusterCount(obs: readonly Obs[]): number {
  return new Set(obs.map((o) => baseAssetOf(o.symbol))).size;
}

/** Distinct BASE assets behind a list of symbol strings — the cluster unit, exported so the spec
 *  reports the same count the bootstrap actually resamples rather than a symbol-string count (spot
 *  BTC/USDT and perp BTC/USDT:USDT are one cluster, not two). */
export function baseAssetsOf(symbols: readonly string[]): number {
  return new Set(symbols.map(baseAssetOf)).size;
}

export interface CellResult {
  readonly featureId: FeatureId;
  readonly cut: CutKind;
  readonly h: number;
  readonly nHigh: number;
  readonly nLow: number;
  readonly kHigh: number;
  readonly kLow: number;
  readonly powered: boolean;
  /** Δ = mean(HIGH) − mean(LOW), bps. Present for every scored cell — but see `renderCell`: it never
   *  leaves this module in a string separated from its power label. */
  readonly delta: number | null;
  /** The Bonferroni-corrected interval, ONLY on a powered cell. Null on an underpowered one: an
   *  interval printed beside an UNDERPOWERED label still gets copied into a sentence without it. */
  readonly ciLo: number | null;
  readonly ciHi: number | null;
  readonly degenerateDraws: number;
  readonly excludesZero: boolean;
}

/**
 * One cell. The powered/underpowered decision is made on BOTH groups independently: n >= MIN_ENTRIES
 * AND clusters >= MIN_CLUSTERS on each side. The two clauses are independent by design — 20
 * observations concentrated on 3 assets is 3 effective observations for a cluster bootstrap.
 */
export function computeCell(
  featureId: FeatureId,
  cut: CutKind,
  h: number,
  high: readonly Obs[],
  low: readonly Obs[],
  opts: { readonly nBoot?: number; readonly seed?: number } = {},
): CellResult {
  const kHigh = clusterCount(high);
  const kLow = clusterCount(low);
  const mHigh = meanOf(high.map((o) => o.value));
  const mLow = meanOf(low.map((o) => o.value));
  const delta = mHigh === null || mLow === null ? null : mHigh - mLow;
  const powered =
    high.length >= MIN_ENTRIES &&
    low.length >= MIN_ENTRIES &&
    kHigh >= MIN_CLUSTERS &&
    kLow >= MIN_CLUSTERS;

  if (!powered || delta === null) {
    return {
      featureId,
      cut,
      h,
      nHigh: high.length,
      nLow: low.length,
      kHigh,
      kLow,
      powered: false,
      delta,
      ciLo: null,
      ciHi: null,
      degenerateDraws: 0,
      excludesZero: false,
    };
  }

  const nBoot = opts.nBoot ?? N_BOOT;
  const sortedHigh = [...high].sort(
    (a, b) => a.symbol.localeCompare(b.symbol) || a.value - b.value,
  );
  const sortedLow = [...low].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.value - b.value);
  const { draws, degenerate } = pairedClusterBootstrapDelta(
    sortedHigh,
    sortedLow,
    makeRand(opts.seed ?? BOOTSTRAP_SEED),
    nBoot,
  );
  // The BONFERRONI-corrected two-sided interval: 1 - ALPHA_CELL coverage, not 95%. At N_BOOT=20000
  // the lower endpoint is order statistic ~#8, so this endpoint is itself resolution-limited — it is
  // a BOUND, never a precision claim (pre-registration §7).
  const qLo = ALPHA_CELL / 2;
  const qHi = 1 - ALPHA_CELL / 2;
  const idx = (q: number): number =>
    Math.min(draws.length - 1, Math.max(0, Math.floor(q * draws.length)));
  const ciLo = draws.length === 0 ? null : draws[idx(qLo)]!;
  const ciHi = draws.length === 0 ? null : draws[idx(qHi)]!;
  return {
    featureId,
    cut,
    h,
    nHigh: high.length,
    nLow: low.length,
    kHigh,
    kLow,
    powered: true,
    delta,
    ciLo,
    ciHi,
    degenerateDraws: degenerate,
    excludesZero: ciLo !== null && ciHi !== null && (ciLo > 0 || ciHi < 0),
  };
}

/** The verbatim reading for a PRESENT-but-underpowered cell, frozen in pre-registration §11. Minted
 *  here so no caller can assemble a looser paraphrase. */
export const UNDERPOWERED_READING =
  'recorded, not evidence; no point estimate may be quoted; the cell re-reads when it reaches ' +
  `n >= ${MIN_ENTRIES} and k >= ${MIN_CLUSTERS}, and this pre-registration's alpha already covers ` +
  'that re-read';

const fmtBps = (v: number | null): string =>
  v === null || !Number.isFinite(v) ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(1)} bps`;

/**
 * Every number this module lets out is welded to its power label IN THE SAME STRING — same chokepoint
 * convention as `summarise` in scripts/loop-forward-return-core.mjs:420. An UNDERPOWERED cell emits
 * NO point estimate at all: the way an unattributable estimate does damage is by being lifted into a
 * sentence away from its caveat, and the safest way to honour that is not to carry it.
 */
export function renderCell(c: CellResult): string {
  const head = `${c.featureId}/${c.cut}/h=${c.h} nHigh=${c.nHigh} nLow=${c.nLow} kHigh=${c.kHigh} kLow=${c.kLow}`;
  if (!c.powered) {
    const failed: string[] = [];
    if (c.nHigh < MIN_ENTRIES) failed.push(`nHigh=${c.nHigh}<${MIN_ENTRIES}`);
    if (c.nLow < MIN_ENTRIES) failed.push(`nLow=${c.nLow}<${MIN_ENTRIES}`);
    if (c.kHigh < MIN_CLUSTERS) failed.push(`kHigh=${c.kHigh}<${MIN_CLUSTERS}`);
    if (c.kLow < MIN_CLUSTERS) failed.push(`kLow=${c.kLow}<${MIN_CLUSTERS}`);
    return `${head} PRESENT but UNDERPOWERED (${failed.join(', ')}) — ${UNDERPOWERED_READING}`;
  }
  return (
    `${head} POWERED delta=${fmtBps(c.delta)} ` +
    `${((1 - ALPHA_CELL) * 100).toFixed(6)}% CI [${fmtBps(c.ciLo)}, ${fmtBps(c.ciHi)}] ` +
    `${c.excludesZero ? 'EXCLUDES 0' : 'includes 0'} degenerateDraws=${c.degenerateDraws}`
  );
}

// ── the scoring pass ─────────────────────────────────────────────────────────────────────────────

export interface HorizonAccounting {
  readonly h: number;
  readonly ok: number;
  readonly gap: number;
  readonly pending: number;
  readonly noSeries: number;
  readonly noEntryBar: number;
  readonly badPrice: number;
  readonly gapShare: number;
  /** True when the non-benign miss share exceeds MAX_GAP_SHARE — all 16 cells at this horizon then
   *  read UNDETERMINED rather than reporting a calm-biased subsample. */
  readonly undetermined: boolean;
}

export interface ScoreResult {
  readonly cells: readonly CellResult[];
  readonly horizons: readonly HorizonAccounting[];
  readonly medians: ReadonlyMap<FeatureId, number>;
  /** max |Δ| over every SCORED cell — the placebo's family-wise statistic (pre-registration §9). */
  readonly maxAbsDelta: number;
}

/** Per-entry, per-horizon forward returns. Computed once and shared across all 8 features and both
 *  cuts, because the outcome does not depend on the cut. */
function returnsByHorizon(
  entries: readonly ScoredEntry[],
  series: ReadonlyMap<string, Series>,
  anchors: readonly number[],
): { readonly bps: (number | null)[][]; readonly accounting: HorizonAccounting[] } {
  const bps: (number | null)[][] = [];
  const accounting: HorizonAccounting[] = [];
  for (const h of HORIZONS) {
    const row: (number | null)[] = [];
    let ok = 0;
    let gap = 0;
    let pending = 0;
    let noSeries = 0;
    let noEntryBar = 0;
    let badPrice = 0;
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i]!;
      const r = forwardBps(series, e.venue, e.symbol, anchors[i]!, h, e.dir);
      if (r.status === 'ok') {
        ok += 1;
        row.push(r.bps);
      } else {
        row.push(null);
        if (r.status === 'gap') gap += 1;
        else if (r.status === 'pending') pending += 1;
        else if (r.status === 'no_series') noSeries += 1;
        else if (r.status === 'no_entry_bar') noEntryBar += 1;
        else badPrice += 1;
      }
    }
    // `pending` is excluded from the denominator on purpose: a horizon that has not elapsed yet is
    // not a hole, and counting it as one would make every fresh window read UNDETERMINED.
    const nonBenign = gap + noSeries + noEntryBar + badPrice;
    const attempted = ok + nonBenign;
    const gapShare = attempted === 0 ? 0 : nonBenign / attempted;
    bps.push(row);
    accounting.push({
      h,
      ok,
      gap,
      pending,
      noSeries,
      noEntryBar,
      badPrice,
      gapShare,
      undetermined: attempted > 0 && gapShare > MAX_GAP_SHARE,
    });
  }
  return { bps, accounting };
}

/**
 * The full 64-cell pass over one set of anchors. `anchors[i]` is the bar entry `i` is scored from —
 * its own `eventTime` for the real run, a randomly drawn bar for a placebo realization. Everything
 * else (feature values, group memberships, direction, base asset) is identical between the two, which
 * is what makes the placebo a test of the TIMING LINK and nothing else.
 */
export function scoreCells(
  entries: readonly ScoredEntry[],
  series: ReadonlyMap<string, Series>,
  anchors: readonly number[],
  opts: { readonly nBoot?: number; readonly seed?: number } = {},
): ScoreResult {
  const { bps, accounting } = returnsByHorizon(entries, series, anchors);

  const medians = new Map<FeatureId, number>();
  for (const f of FEATURES) {
    const values: number[] = [];
    for (const e of entries) {
      const v = e.aligned.get(f.id);
      if (v !== undefined) values.push(v);
    }
    const m = median(values);
    if (m !== null) medians.set(f.id, m);
  }

  const cells: CellResult[] = [];
  let maxAbsDelta = 0;
  for (let hi = 0; hi < HORIZONS.length; hi += 1) {
    const h = HORIZONS[hi]!;
    if (accounting[hi]!.undetermined) continue;
    const row = bps[hi]!;
    for (const f of FEATURES) {
      const m = medians.get(f.id);
      if (m === undefined) continue;
      for (const cut of CUTS) {
        const high: Obs[] = [];
        const low: Obs[] = [];
        for (let i = 0; i < entries.length; i += 1) {
          const e = entries[i]!;
          const x = e.aligned.get(f.id);
          const y = row[i];
          if (x === undefined || y === null || y === undefined) continue;
          (isHigh(cut, x, m) ? high : low).push({ symbol: e.symbol, value: y });
        }
        const cell = computeCell(f.id, cut, h, high, low, opts);
        cells.push(cell);
        if (cell.delta !== null && Number.isFinite(cell.delta)) {
          maxAbsDelta = Math.max(maxAbsDelta, Math.abs(cell.delta));
        }
      }
    }
  }

  return { cells, horizons: accounting, medians, maxAbsDelta };
}

// ── placebo (pre-registration §9) ────────────────────────────────────────────────────────────────

export interface PlaceboResult {
  readonly realizations: number;
  readonly observedMaxAbsDelta: number;
  readonly maxAbsDeltas: readonly number[];
  readonly atLeastAsExtreme: number;
  /** (1 + #{maxAbsDelta >= observed}) / (1 + realizations) — the +1 keeps it a valid p-value rather
   *  than one that can read exactly 0. */
  readonly p: number;
  /** Entries whose (venue,symbol) series was missing, so no placebo anchor could be drawn for them —
   *  they fall back to their own eventTime and are COUNTED here rather than dropped. */
  readonly noSeries: number;
}

/**
 * Random-bar placebo. Each entry's anchor is redrawn uniformly from THAT ENTRY'S OWN (venue,symbol)
 * series, so group sizes, cluster composition and feature marginals are bit-identical to the real run
 * and only the timing link between feature and return is destroyed.
 *
 * The bootstrap is deliberately NOT run inside the placebo: the placebo calibrates the family-wise
 * error rate of the max statistic, which the per-cell interval does not measure, and 200 x 64
 * bootstraps would buy nothing the max statistic does not already give.
 */
export function runPlacebo(
  entries: readonly ScoredEntry[],
  series: ReadonlyMap<string, Series>,
  observedMaxAbsDelta: number,
  opts: { readonly realizations?: number; readonly seed?: number } = {},
): PlaceboResult {
  const realizations = opts.realizations ?? N_PLACEBO;
  const rand = makeRand(opts.seed ?? PLACEBO_SEED);
  const maxAbsDeltas: number[] = [];
  let noSeries = 0;
  for (let r = 0; r < realizations; r += 1) {
    const anchors: number[] = [];
    for (const e of entries) {
      const s = series.get(gridKey(e.venue, e.symbol));
      if (!s || s.ts.length === 0) {
        if (r === 0) noSeries += 1;
        anchors.push(e.eventTime);
        continue;
      }
      anchors.push(s.ts[(rand() * s.ts.length) | 0]!);
    }
    maxAbsDeltas.push(scoreCells(entries, series, anchors, { nBoot: 0 }).maxAbsDelta);
  }
  const atLeastAsExtreme = maxAbsDeltas.filter((m) => m >= observedMaxAbsDelta).length;
  return {
    realizations,
    observedMaxAbsDelta,
    maxAbsDeltas,
    atLeastAsExtreme,
    p: (1 + atLeastAsExtreme) / (1 + realizations),
    noSeries,
  };
}
