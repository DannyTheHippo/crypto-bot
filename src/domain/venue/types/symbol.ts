import type { SymbolId } from '../../common/types/ids';

// Unified ccxt symbol format is BASE/QUOTE (e.g. BTC/USDT), or ccxt's linear-swap perp form
// BASE/QUOTE:SETTLE (e.g. BTC/USDT:USDT) where the :SETTLE suffix names the settlement asset —
// almost always identical to QUOTE, but kept separate rather than folded into quote so
// base/quote asset comparisons (fee classification, position sizing) never see the raw
// "USDT:USDT" string. Anything else is a config error surfaced at parse time, never silently
// mis-split.
export interface AssetPair {
  readonly base: string;
  readonly quote: string;
  readonly settle?: string;
}

export function splitSymbol(symbol: SymbolId): AssetPair {
  const parts = symbol.split('/');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error(
      `unsupported symbol format (expected BASE/QUOTE or BASE/QUOTE:SETTLE): "${symbol}"`,
    );
  }
  const colonIdx = parts[1]!.indexOf(':');
  if (colonIdx === -1) {
    return { base: parts[0]!, quote: parts[1]! };
  }
  const quote = parts[1]!.slice(0, colonIdx);
  const settle = parts[1]!.slice(colonIdx + 1);
  if (quote === '' || settle === '') {
    throw new Error(
      `unsupported symbol format (expected BASE/QUOTE or BASE/QUOTE:SETTLE): "${symbol}"`,
    );
  }
  return { base: parts[0]!, quote, settle };
}

// One representative symbol per DISTINCT base asset, in first-occurrence order. A configured
// universe routinely lists the same underlying on more than one venue/product (e.g. 'BTC/USDT' spot
// and 'BTC/USDT:USDT' perp) — equal-weighting the raw symbol strings would hold a dual-listed asset
// twice, which is not a buy-and-hold basket over the universe. Built for
// PassiveBenchmarkRepository's basket derivation (database/repositories/trading/
// passive-benchmark.repository.ts); kept here rather than inline so it shares splitSymbol's own
// unit coverage and stays reusable by any future basket/universe consumer.
export function distinctBaseAssetRepresentatives(symbols: readonly string[]): readonly string[] {
  const seenBases = new Set<string>();
  const representatives: string[] = [];
  for (const symbol of symbols) {
    const { base } = splitSymbol(symbol as SymbolId);
    if (seenBases.has(base)) continue;
    seenBases.add(base);
    representatives.push(symbol);
  }
  return representatives;
}
