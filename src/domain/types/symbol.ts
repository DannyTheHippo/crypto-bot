import type { SymbolId } from './ids';

// Unified ccxt symbol format is BASE/QUOTE (e.g. BTC/USDT). v1 supports only this shape;
// anything else is a config error surfaced at parse time, never silently mis-split.
export interface AssetPair {
  readonly base: string;
  readonly quote: string;
}

export function splitSymbol(symbol: SymbolId): AssetPair {
  const parts = symbol.split('/');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error(`unsupported symbol format (expected BASE/QUOTE): "${symbol}"`);
  }
  return { base: parts[0]!, quote: parts[1]! };
}
