import Decimal from 'decimal.js';
import { symbolId } from '../../../domain/types/ids';
import type { PortfolioSnapshot } from '../../../domain/types/portfolio';
import type { AgentPortfolioBlock, AgentPortfolioPosition } from '../../../ports/agentic-strategy';
import {
  computeBasketBtcBeta,
  BTC_BENCHMARK_SYMBOL,
  type BenchmarkCandle,
} from './benchmark-alpha';
import type { PriceHistoryStore } from './price-history-store';

// I1 (Design § Enriched model inputs, § Live-scale economics): the batch payload's portfolio-state
// block — capped equity/free quote/gross exposure/open positions, built from the SAME
// PortfolioSnapshot the sizer's own $1k-book cap reads (risk.module.ts's equityCapFor sources
// config.risk.equityCap off the SAME AppConfig field) so the model's view of the book and the
// sizer's sizing equity can never drift onto two different figures. USDT is this deployment's one
// quote currency (mirrors app.module.ts's logPortfolio's own balances.get('USDT') convention).
// W3 Part 2 wired correlation (basket-vs-BTC beta) off the shared PriceHistoryStore — absent
// priceHistory dep, or too little basket-wide return history, still omits the block (see
// buildCorrelation below), the SAME fail-open convention this whole payload already uses.
export function buildAgentPortfolioBlock(
  snapshot: PortfolioSnapshot,
  equityCap: string | undefined,
  priceHistory?: PriceHistoryStore,
): AgentPortfolioBlock {
  const cappedEquity =
    equityCap !== undefined
      ? Decimal.min(snapshot.equity, new Decimal(equityCap))
      : snapshot.equity;
  const freeQuote = snapshot.balances.get('USDT')?.free ?? new Decimal(0);

  let grossExposure = new Decimal(0);
  const positions: AgentPortfolioPosition[] = [];
  for (const p of snapshot.positions.values()) {
    if (p.signedQty.isZero()) continue;
    const notional = p.signedQty.abs().mul(p.avgEntry);
    grossExposure = grossExposure.plus(notional);
    positions.push({
      symbol: String(p.symbol),
      side: p.signedQty.isNegative() ? 'SHORT' : 'LONG',
      qty: p.signedQty.abs().toFixed(),
      notional: notional.toFixed(),
    });
  }

  return {
    cappedEquity: cappedEquity.toFixed(),
    freeQuote: freeQuote.toFixed(),
    grossExposure: grossExposure.toFixed(),
    positions,
    ...buildCorrelation(priceHistory),
  };
}

// btcBeta uses the store's WHOLE available window (not trip-scoped like the trackRecord block's
// netVsEqualWeightBasketBps — a portfolio correlation snapshot describes CURRENT risk stance, not a
// specific evidence window). BTC itself is excluded from the basket side: "basket-vs-BTC" means the
// REST of the traded universe against BTC (agent-prompt.ts's own correlation-budgeting copy: "most
// altcoin longs are largely one leveraged bet on BTC's own direction") — folding BTC into its own
// comparison basket would trivially bias beta toward 1 and defeat the point of the metric.
function buildCorrelation(
  priceHistory: PriceHistoryStore | undefined,
): Pick<AgentPortfolioBlock, 'correlation'> {
  if (priceHistory === undefined) return {};
  const btcCandles = priceHistory.seriesFor(symbolId(BTC_BENCHMARK_SYMBOL));
  const perSymbolCandles = new Map<string, readonly BenchmarkCandle[]>();
  for (const symbol of priceHistory.symbols()) {
    if (String(symbol) === BTC_BENCHMARK_SYMBOL) continue;
    perSymbolCandles.set(symbol, priceHistory.seriesFor(symbol));
  }
  const btcBeta = computeBasketBtcBeta(perSymbolCandles, btcCandles);
  if (btcBeta === null) return {};
  const magnitude = Math.abs(btcBeta);
  const band = magnitude >= 1.3 ? 'high' : magnitude >= 0.7 ? 'moderate' : 'low';
  return {
    correlation: {
      btcBeta,
      summary: `basket beta to BTC ${btcBeta.toFixed(2)} (${band} correlation) — alt positions move roughly ${btcBeta.toFixed(2)}x BTC's own return`,
    },
  };
}
