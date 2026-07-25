import type { CandleEvent } from '../../../domain/venue/types/market-events';
import { toIndicatorNumber } from '../../../domain/common/types/money';
import { atrFromNumbers } from '../../../domain/strategy/indicators/indicators';
import { symbolId } from '../../../domain/common/types/ids';
import {
  venueForSymbol,
  SPOT_VENUE_ID,
  PERP_VENUE_ID,
} from '../../../domain/venue/types/venue-map';

// Basket entries are plain strings (ccxt symbol shape) here, not the branded SymbolId the domain
// layer mints — venueForSymbol only needs the pure BASE/QUOTE[:SETTLE] shape splitSymbol parses, so
// a bare cast (never validated elsewhere in this basket-ranking-only module) is the smaller-blast-
// radius reuse of the single-source venueForSymbol/venue-map.ts rather than re-deriving the
// settle-suffix check locally.
function venueOf(symbol: string) {
  return venueForSymbol(symbolId(symbol));
}

// U1 (Design § Universe: wide static basket, scanner-gated active menu). Deterministic, no-LLM
// ranking of the configured basket into an "active menu" the batched consult path serves — idle
// (non-menu) instances still stream/warm candles and hold positions, they just aren't consulted.
//
// Data source (WORK1): reuses the SAME 15m candle stream each agentic-N strategy instance already
// folds for its own indicators (see agentic.strategy.ts's buildContext — closes/highs/lows via
// toIndicatorNumber, ATR via atrFromNumbers). No new market-data dependency: each strategy instance
// calls recordCandles(symbol, candles, now) on its own decide cadence (wired by I1), so this service
// never touches the exchange/ticker layer directly. 24h quote volume is DERIVED (sum of the last 96
// 15m closes × volumes — 96 × 15m = 24h) rather than read from a dedicated 24h-ticker endpoint,
// because that stream is not already plumbed to the agentic lane; deriving from candles the
// strategies already hold is the smaller-blast-radius reuse. Reference-grade only (ranking signal),
// never a money path — plain numbers, matching indicators.ts's own convention.

// 24h at the strategies' 15m base interval (matches agentic.strategy.ts's INTERVAL_MS['15m']).
const QUOTE_VOLUME_WINDOW_BARS = 96;
// Matches the ATR period agentic.strategy.ts's own buildContext uses (atr14) — same warmup shape,
// so a symbol that has warmed up enough to decide has also warmed up enough to be scanned.
const ATR_PERIOD = 14;
// Hysteresis band (v3 spec §5.3): an incumbent active symbol stays active until its combined rank
// falls below 12, even though only the top `menuSize` (8 by default, v3 AGENTIC_ACTIVE_MENU_SIZE)
// are freshly promoted — 1.5x the menu, preserving v2's own 12->18 ratio. Deliberately NOT a config
// knob (AGENTIC_ACTIVE_MENU_SIZE already tunes the menu itself) — this is pure anti-churn plumbing,
// not a risk/economics lever, so it stays a fixed constant.
const DEFAULT_HYSTERESIS_RANK = 12;

// v3 spec §5.3: venue floor — the combined verdict needs evidence from BOTH venues, so a one-venue
// hot streak must never zero the other's trip accrual. Fixed at 2 (not a knob), same fixed-constant
// discipline as the hysteresis band above.
const VENUE_FLOOR = 2;

export interface ScanMetrics {
  readonly quoteVolume24h: number;
  readonly atrPct: number;
}

export interface RankedSymbol {
  readonly symbol: string;
  readonly quoteVolume24h: number | null;
  readonly atrPct: number | null;
  readonly volumeRank: number | null;
  readonly atrRank: number | null;
  // Combined score (see recompute()'s own comment for the exact formula). Infinity for a symbol with
  // no metrics recorded yet (never ranked below an actually-scored symbol).
  readonly score: number;
  // 1-indexed position in the combined ranking — the number the rank-18 hysteresis band compares
  // against.
  readonly rank: number;
  readonly pinned: boolean;
  readonly active: boolean;
}

export interface UniverseScannerLoggerLike {
  log(msg: string): void;
}

const NOOP_LOGGER: UniverseScannerLoggerLike = { log: () => undefined };

// W1 (Grafana rebuild): narrow structural hook mirroring the logger's own convention above — this
// module never imports features/common/observability (the boundaries wall runs the other way, same
// as agentic.strategy.ts's AgentMetricsRecorder callers), so the composition root adapts the real
// recorder's setActiveMenu/recordMenuChurn methods to this shape.
export interface UniverseScannerMetricsLike {
  setActiveMenu(symbols: readonly string[]): void;
  recordMenuChurn(menuIn: number, menuOut: number): void;
}

const NOOP_METRICS: UniverseScannerMetricsLike = {
  setActiveMenu: () => undefined,
  recordMenuChurn: () => undefined,
};

export interface UniverseScannerConfig {
  // The configured basket (TRADING_SYMBOLS) — the universe this service ranks. Fixed at construction;
  // U1 does not support a runtime basket rebuild (Design § Universe: "no runtime lifecycle rebuild").
  readonly basket: readonly string[];
  // AGENTIC_ACTIVE_MENU_SIZE — top-N of the combined ranking that is freshly promoted active each
  // recompute. Clamped to basket.length (a menuSize larger than the basket just selects everything).
  readonly menuSize: number;
  readonly hysteresisRank?: number;
  // Position/resting-order pin (WORK3): a symbol this answers true for is ALWAYS active regardless
  // of rank. Safe default: no pins (every symbol is ranked purely on the scanner's own metrics) — a
  // caller that has no clean position-query wiring yet can omit this without ever stranding a
  // position from consults incorrectly (it would just also need to fall inside the hysteresis band,
  // same as any other incumbent).
  readonly isPinned?: (symbol: string) => boolean;
  readonly logger?: UniverseScannerLoggerLike;
  readonly metrics?: UniverseScannerMetricsLike;
}

// Derives {quoteVolume24h, atrPct} from a symbol's own 15m candle history — the SAME closes/highs/
// lows/atrFromNumbers path agentic.strategy.ts's buildContext uses for its own indicators. Returns
// null while warmup is short of ATR_PERIOD+1 bars (mirrors buildContext's own INDICATOR_WARMUP_CLOSES
// gate) or when the latest close is non-positive (defensive: never divide by a bad reference price).
export function deriveScanMetrics(candles: readonly CandleEvent[]): ScanMetrics | null {
  if (candles.length < ATR_PERIOD + 1) return null;
  const closes = candles.map((c) => toIndicatorNumber(c.close));
  const highs = candles.map((c) => toIndicatorNumber(c.high));
  const lows = candles.map((c) => toIndicatorNumber(c.low));
  const lastClose = closes[closes.length - 1]!;
  if (!(lastClose > 0)) return null;
  const atr = atrFromNumbers(highs, lows, closes, ATR_PERIOD);
  if (!Number.isFinite(atr)) return null;

  const window = candles.slice(Math.max(0, candles.length - QUOTE_VOLUME_WINDOW_BARS));
  let quoteVolume24h = 0;
  for (const c of window) {
    quoteVolume24h += toIndicatorNumber(c.close) * toIndicatorNumber(c.volume);
  }

  return { quoteVolume24h, atrPct: atr / lastClose };
}

function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class UniverseScannerService {
  private readonly basket: readonly string[];
  private readonly menuSize: number;
  private readonly hysteresisRank: number;
  private readonly isPinned: (symbol: string) => boolean;
  private readonly logger: UniverseScannerLoggerLike;
  private readonly metricsHook: UniverseScannerMetricsLike;

  private readonly metrics = new Map<string, ScanMetrics>();
  // undefined = never recomputed yet. Deliberately NOT pre-seeded to the full basket: recompute()'s
  // hysteresis rule reads this as "the incumbent set", and a full-basket pre-seed would make the
  // very FIRST recompute treat every basket member as an incumbent — silently retaining everything
  // inside the rank-18 band on the very first boot ranking, before the scanner has ever chosen an
  // active menu. isActive()/activeMenu() below supply the "everything active" safe default instead,
  // without polluting recompute()'s own incumbent bookkeeping.
  private active: Set<string> | undefined;
  private lastRanking: readonly RankedSymbol[] = [];
  private lastRecomputedDayKey: string | undefined;

  constructor(cfg: UniverseScannerConfig) {
    this.basket = cfg.basket;
    this.menuSize = cfg.menuSize;
    this.hysteresisRank = cfg.hysteresisRank ?? DEFAULT_HYSTERESIS_RANK;
    this.isPinned = cfg.isPinned ?? (() => false);
    this.logger = cfg.logger ?? NOOP_LOGGER;
    this.metricsHook = cfg.metrics ?? NOOP_METRICS;
  }

  // Ingest a symbol's latest candle window (called by each agentic-N instance on its own decide
  // cadence — I1 wires the call site). Storage ONLY — deliberately does NOT trigger a recompute
  // itself (see maybeRecompute's own comment for why): the basket's ~24 instances warm up and start
  // reporting independently, so triggering off ingestion would let the FIRST symbol to warm up
  // recompute the whole ranking off a single data point, racing the rest of the basket's warmup.
  // I1 drives maybeRecompute/recompute on its own cadence once warmup has had a chance to complete.
  // No-ops while the symbol hasn't warmed up enough to derive metrics yet (deriveScanMetrics returns
  // null); the symbol then stays in the "unranked" tail (score=Infinity) until it warms up, so it can
  // never win a menu slot on stale/absent data.
  recordCandles(symbol: string, candles: readonly CandleEvent[]): void {
    const derived = deriveScanMetrics(candles);
    if (derived === null) return;
    this.metrics.set(symbol, derived);
  }

  // Direct metrics ingestion (bypasses candle derivation) — the entry point the ranking/hysteresis
  // spec suite uses for exact fixture volumes/ATRs; recordCandles above is a thin convenience wrapper
  // over the same map for the real runtime path. Storage only, same non-triggering contract.
  recordMetrics(symbol: string, metrics: ScanMetrics): void {
    this.metrics.set(symbol, metrics);
  }

  // Daily-at-00:00-UTC + once-at-boot cadence (Design § Universe), expressed as a UTC-calendar-date
  // boundary check rather than an owned timer: this service holds no setInterval (mirrors
  // CrossSymbolContextService's own no-timer convention), so it stays trivially unit-testable and I1
  // is free to drive it from any cadence of its own choosing (e.g. the SAME periodic tick that already
  // drives app.module.ts's other driverTimers) without risking a double-recompute — the day-key guard
  // makes every call idempotent within a UTC day. The FIRST call ever (lastRecomputedDayKey undefined)
  // always recomputes, which is the boot trigger — I1 calls this once after the basket has had a
  // chance to warm up, not on the first raw ingest event.
  maybeRecompute(now: number): boolean {
    const dayKey = utcDayKey(now);
    if (this.lastRecomputedDayKey === dayKey) return false;
    this.recompute(now);
    return true;
  }

  // Forces a recompute regardless of the day-key cadence — the boot-time / test entry point.
  recompute(now: number): void {
    const ranked = this.basket.map((symbol) => ({ symbol, metrics: this.metrics.get(symbol) }));
    const withMetrics = ranked.filter(
      (r): r is { symbol: string; metrics: ScanMetrics } => r.metrics !== undefined,
    );

    // Quorum guard: a scan without at least a menu's worth of scored symbols is PROVISIONAL — at
    // boot the recompute can race candle warmup (all scores null), and stamping the day key then
    // would freeze an arbitrary alphabetical menu until the next UTC day, silencing consults for
    // the unlucky tail (L1 soak finding, 2026-07-18). Leave `active` untouched (undefined at boot
    // = everything active, the documented fail-open default) and do NOT stamp the day key, so
    // maybeRecompute keeps retrying on its driving tick until real metrics exist.
    const quorum = Math.min(this.menuSize, this.basket.length);
    if (withMetrics.length < quorum) {
      this.logger.log(
        JSON.stringify({
          event: 'universe_scan_skipped',
          reason: 'metrics_below_quorum',
          scored: withMetrics.length,
          quorum,
        }),
      );
      return;
    }
    this.lastRecomputedDayKey = utcDayKey(now);

    // Two independent rank orders (1 = best): descending quote volume, descending ATR%.
    const byVolume = [...withMetrics].sort(
      (a, b) => b.metrics.quoteVolume24h - a.metrics.quoteVolume24h,
    );
    const volumeRank = new Map<string, number>();
    byVolume.forEach((r, i) => volumeRank.set(r.symbol, i + 1));

    const byAtr = [...withMetrics].sort((a, b) => b.metrics.atrPct - a.metrics.atrPct);
    const atrRank = new Map<string, number>();
    byAtr.forEach((r, i) => atrRank.set(r.symbol, i + 1));

    // Combined score: product of the two rank orders (Design § Universe: "score = 24h quote volume
    // rank x ATR% rank") — lower is better (rank 1 x rank 1 = 1 is the best possible score). A
    // symbol absent from metrics (never warmed up / never recorded) gets Infinity so it always sorts
    // to the unranked tail, behind every scored symbol, and can only become active via the pin path.
    const scored = this.basket.map((symbol) => {
      const vr = volumeRank.get(symbol) ?? null;
      const ar = atrRank.get(symbol) ?? null;
      const score = vr !== null && ar !== null ? vr * ar : Number.POSITIVE_INFINITY;
      return { symbol, volumeRank: vr, atrRank: ar, score, metrics: this.metrics.get(symbol) };
    });
    // Ascending by score (best first); alphabetical tie-break for determinism (fixed fixture inputs
    // must produce one exact expected ordering, never sort-stability luck).
    scored.sort((a, b) => a.score - b.score || a.symbol.localeCompare(b.symbol));

    // Empty (never Set(basket)) on the FIRST recompute — see the `active` field's own comment: a
    // full-basket incumbent set would spuriously hysteresis-retain everything inside the rank-18
    // band on the very first boot ranking.
    const previousActive = this.active ?? new Set<string>();
    const menuSize = Math.min(this.menuSize, this.basket.length);
    const candidateActive = new Set<string>(scored.slice(0, menuSize).map((r) => r.symbol));

    scored.forEach((r, i) => {
      const rank = i + 1;
      // Hysteresis: an incumbent (previously active) symbol outside the fresh top-N stays active
      // until its combined rank drops below the hysteresis band.
      if (previousActive.has(r.symbol) && rank <= this.hysteresisRank) {
        candidateActive.add(r.symbol);
      }
      // Pin: an open-position/resting-order symbol is ALWAYS active, independent of rank or
      // hysteresis — a position must never lose its consult.
      if (this.isPinned(r.symbol)) {
        candidateActive.add(r.symbol);
      }
    });
    // Pins can name a symbol the ranking loop above never iterated only if it were outside `basket`,
    // which cannot happen (isPinned is only meaningful for basket members in this design) — no
    // further pass needed.

    // v3 spec §5.3 venue floor: after ranking+hysteresis+pinning, if fewer than VENUE_FLOOR of
    // either venue's symbols made the active set, promote that venue's best-ranked non-active
    // members (in combined-rank order) until the floor is met or the venue's own basket is
    // exhausted. Fail direction: the floor only ever ADDS symbols (fail OPEN toward coverage) — it
    // never evicts a symbol another rule already selected, so it can only grow candidateActive
    // beyond menuSize, same overflow class as the pin path above. Only meaningful for a genuinely
    // mixed-venue basket (production's 24-spot + 16-perp combined basket, always both) — a
    // single-venue basket (every fixture/toy basket in this spec file that predates v3) has no
    // "other venue" whose accrual needs protecting, so the floor is inert there by construction
    // rather than forcing a spot-only menuSize:1 basket up to 2 active symbols.
    const basketVenues = new Set(this.basket.map((s) => venueOf(s)));
    if (basketVenues.size > 1) {
      for (const venue of [SPOT_VENUE_ID, PERP_VENUE_ID] as const) {
        const activeOfVenue = [...candidateActive].filter((s) => venueOf(s) === venue);
        if (activeOfVenue.length >= VENUE_FLOOR) continue;
        for (const r of scored) {
          if (candidateActive.has(r.symbol) || venueOf(r.symbol) !== venue) continue;
          candidateActive.add(r.symbol);
          if ([...candidateActive].filter((s) => venueOf(s) === venue).length >= VENUE_FLOOR) {
            break;
          }
        }
      }
    }

    const menuIn = [...candidateActive].filter((s) => !previousActive.has(s));
    const menuOut = [...previousActive].filter((s) => !candidateActive.has(s));

    this.metricsHook.setActiveMenu([...candidateActive]);
    this.metricsHook.recordMenuChurn(menuIn.length, menuOut.length);

    this.active = candidateActive;
    this.lastRanking = scored.map((r, i) => ({
      symbol: r.symbol,
      quoteVolume24h: r.metrics?.quoteVolume24h ?? null,
      atrPct: r.metrics?.atrPct ?? null,
      volumeRank: r.volumeRank,
      atrRank: r.atrRank,
      score: r.score,
      rank: i + 1,
      pinned: this.isPinned(r.symbol),
      active: candidateActive.has(r.symbol),
    }));

    // Structured journal line (WORK5) — no new DB table, the service logger is the sink (mirrors
    // reflection.service.ts/agentic.strategy.ts's own `logger: LoggerLike` convention, narrowed to
    // `log` here since this is routine daily activity, not a warning).
    this.logger.log(
      JSON.stringify({
        event: 'universe_scan',
        date: utcDayKey(now),
        menuSize,
        ranked: this.lastRanking.map((r) => ({ symbol: r.symbol, rank: r.rank, score: r.score })),
        menuIn,
        menuOut,
      }),
    );
  }

  // Safe default before the first recompute (WORK4): everything is active, so a fresh instance can
  // never silently gate a symbol out before it has ranked anything.
  isActive(symbol: string): boolean {
    return this.active === undefined ? true : this.active.has(symbol);
  }

  activeMenu(): readonly string[] {
    return this.active === undefined ? [...this.basket] : [...this.active];
  }

  ranking(): readonly RankedSymbol[] {
    return this.lastRanking;
  }
}
