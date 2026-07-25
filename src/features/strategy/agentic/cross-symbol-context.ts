import Decimal from 'decimal.js';
import type { AgentCrossSymbol } from '../../../ports/strategy/agentic-strategy';

// Cross-symbol relative-strength context (2026-07-12, Fable session). WHY: each agentic instance
// trades ONE symbol and its runtime candle history is siloed to that symbol — an instance deciding
// SOL literally cannot see that BTC is the strongest and XRP the weakest of the basket right now.
// The 2026-07-12 multi-strategy search (reports/loop/multi-strategy-search-2026-07-12.md, 4,562
// backtests) found cross-sectional relative strength was the STRONGEST family of everything tested
// (long-short daily momentum, Sharpe 1.12, +45% holdout) — the closest anything came to an edge —
// while the entire price-TA space was empty. This service closes the information gap: it lets each
// instance see where its symbol ranks on trailing return so the model can lean into strength and
// avoid the laggard. It is CONTEXT ONLY — it never proposes, sizes, or vetoes; Risk still owns every
// order. A single instance is shared across all agentic-N strategies (wired in app.module.ts's
// register factory), so instance BTC records BTC's return and instance SOL reads BTC/ETH/…/SOL.
//
// Money discipline: trailing returns are reference-grade CONTEXT (a ranking signal), not a money
// path — computed with Decimal and rendered to fixed-precision strings, never fed to sizing/PnL.

const RENDER_DP = 4; // return rendered as a percentage string to this many decimals

interface Entry {
  readonly returnFraction: Decimal;
  readonly at: number;
}

export class CrossSymbolContextService {
  // symbol → the latest trailing-return this instance recorded, with the eventTime it was seen.
  private readonly latest = new Map<string, Entry>();
  // Entries older than this (ms) are ignored when ranking — a symbol whose instance has stopped
  // deciding (drained/halted) must not pollute the ranking with a stale figure. Generous: several
  // decide cadences at 15m.
  private readonly staleMs: number;

  constructor(staleMs = 90 * 60 * 1000) {
    this.staleMs = staleMs;
  }

  // Record `symbol`'s trailing return (a fraction, e.g. 0.042 = +4.2%) observed at `at` (ms).
  record(symbol: string, returnFraction: Decimal, at: number): void {
    this.latest.set(symbol, { returnFraction, at });
  }

  // Rank `symbol` against every other symbol with a FRESH (non-stale) recorded return, as of `now`.
  // Returns null when fewer than 2 symbols (incl. this one) have fresh data — no meaningful ranking.
  rank(symbol: string, now: number): AgentCrossSymbol | null {
    const fresh: Array<{ symbol: string; ret: Decimal }> = [];
    for (const [sym, entry] of this.latest) {
      if (now - entry.at > this.staleMs) continue;
      fresh.push({ symbol: sym, ret: entry.returnFraction });
    }
    const own = fresh.find((f) => f.symbol === symbol);
    if (own === undefined || fresh.length < 2) return null;
    // Descending by return: rank 1 = strongest.
    fresh.sort((a, b) => b.ret.comparedTo(a.ret));
    const rank = fresh.findIndex((f) => f.symbol === symbol) + 1;
    const strongest = fresh[0]!;
    const weakest = fresh[fresh.length - 1]!;
    const pct = (d: Decimal): string => d.mul(100).toDecimalPlaces(RENDER_DP).toFixed();
    return {
      rank,
      of: fresh.length,
      ownReturnPct: pct(own.ret),
      strongest: { symbol: strongest.symbol, returnPct: pct(strongest.ret) },
      weakest: { symbol: weakest.symbol, returnPct: pct(weakest.ret) },
    };
  }
}
