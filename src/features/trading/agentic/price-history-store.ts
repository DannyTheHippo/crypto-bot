import type { SymbolId } from '../../../domain/types/ids';
import type { CandleEvent } from '../../../domain/types/market-events';
import type { BenchmarkCandle } from './benchmark-alpha';

// W3 Part 2 (Design § Learning & measurement stack): a small in-memory rolling price-history store,
// per symbol, that benchmark-alpha.ts's computeEqualWeightBasketReturnFraction and the portfolio
// correlation block (agent-portfolio-block.ts) both need a genuine multi-symbol candle source for —
// the gap both of those modules' own header comments documented ("no shared multi-symbol/basket
// price-history store exists yet"). Fed at the composition root from the SAME candle path
// AgenticStrategyDeps.onCandleMetrics already taps (I1b — universe-scanner.service.ts's own
// recordCandles consumer is the existing precedent for this exact wiring shape), so this needs no new
// market-data subscription: app.module.ts's onCandleMetrics closure calls both consumers off the one
// per-instance decide()-cadence candle window. Storage only — no decision logic, no money path.
//
// recordWindow is idempotent/merge-safe by design: onCandleMetrics re-delivers each instance's own
// OWN rolling candle window (heavily overlapping the previous call's window, not just the newest bar)
// on every decide() call that lands on a candle trigger, so a naive push would duplicate bars already
// stored. Only candles strictly newer than the last stored eventTime are appended.
//
// Coverage note: like benchmark-alpha.ts's own header warns for computeHoldReturnFraction, this store
// can only hold what onCandleMetrics has actually delivered — a symbol whose strategy instance rarely
// lands a candle-close trigger (cadence gate, busy conflation, DRAINING) accumulates a genuinely
// sparser series. Callers reading seriesFor MUST apply the same coverage-tolerance guard
// agentic.strategy.ts's computeBenchmarkAlpha already uses for the BTC benchmark (near-endpoint bars
// within a small tolerance), never assume a dense, gap-free window.
// ~30 days at the lane's 15m base interval (INTERVAL_MS['15m'] in agentic.strategy.ts) — 2x headroom
// over the promotion gate's own >=14-day earned-live evidence window (CLAUDE.md hard rule 4),
// generous enough that a slow-cadence strategy's TRACK_RECORD_WINDOW_TRIPS(15)-trip evidence span
// (agentic.strategy.ts) rarely exceeds it, bounded so per-symbol memory never grows unbounded across
// the ~24-symbol spot basket (soon ~16-symbol perp, per W3's own task brief).
const DEFAULT_MAX_BARS = 2_880;

export class PriceHistoryStore {
  private readonly maxBars: number;
  private readonly bySymbol = new Map<string, BenchmarkCandle[]>();

  constructor(maxBars: number = DEFAULT_MAX_BARS) {
    this.maxBars = maxBars;
  }

  recordWindow(symbol: SymbolId, candles: readonly CandleEvent[]): void {
    const hist = this.bySymbol.get(symbol) ?? [];
    const lastEventTime = hist.length > 0 ? hist[hist.length - 1]!.eventTime : -Infinity;
    for (const c of candles) {
      if (!c.closed || c.eventTime <= lastEventTime) continue;
      hist.push({ eventTime: c.eventTime, close: c.close.toFixed() });
    }
    if (hist.length > this.maxBars) hist.splice(0, hist.length - this.maxBars);
    this.bySymbol.set(symbol, hist);
  }

  // Oldest→newest, matching benchmark-alpha.ts's own BenchmarkCandle ordering contract. A defensive
  // copy — callers must not mutate the returned array.
  seriesFor(symbol: SymbolId): readonly BenchmarkCandle[] {
    return [...(this.bySymbol.get(symbol) ?? [])];
  }

  symbols(): readonly SymbolId[] {
    return [...this.bySymbol.keys()] as SymbolId[];
  }
}
