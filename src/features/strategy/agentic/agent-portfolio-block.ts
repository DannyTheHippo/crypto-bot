import Decimal from 'decimal.js';
import { symbolId, venueId, type VenueId } from '../../../domain/common/types/ids';
import { DEFAULT_FILTERS } from '../../../domain/trading/risk/default-filters';
import type { PortfolioSnapshot } from '../../../domain/trading/types/portfolio';
import type {
  AgentPortfolioBlock,
  AgentPortfolioPosition,
  AgentPortfolioVenue,
} from '../../../ports/strategy/agentic-strategy';
import {
  computeBasketBtcBeta,
  BTC_BENCHMARK_SYMBOL,
  type BenchmarkCandle,
} from './benchmark-alpha';
import type { PriceHistoryStore } from './price-history-store';

// DISPLAY-ONLY rendering of the money/quantity strings this block puts in the prompt payload. Nothing
// produced here is stored, returned to a caller, or fed back into a computation: the PortfolioSnapshot
// is untouched, every Decimal accumulated below (grossExposure, headroom, venueOpenNotional) keeps
// full precision, and the trim happens on the very last step — the string. The model's only sizing
// input is a sizeFraction it proposes; no order qty, price, or balance is ever derived from these
// strings, and the two callers (agentic-bridge.module.ts's payload extras, trading-runtime.module.ts's
// periodic log line) both consume the block as text.
//
// Same sanctioned shape as agent-prompt.ts's per-candle `reduce` helper, and the same reasoning: still
// Decimal all the way to the rendered string — .toDecimalPlaces()/.toSignificantDigits() never drop to
// a native float (money hard rule), they only trim the rendered precision of context data. Held
// deliberately un-exported so a rounded string cannot leave this module (the module itself is already
// walled inside features/strategy/agentic by eslint-plugin-boundaries).
//
// Quote vs quantity split: a QUOTE amount's meaning is absolute — a cent is the smallest unit anyone
// acts on, so a `212.41000000000000014` tail is pure token noise — hence fixed decimals. A QUANTITY's
// meaning is scale-relative (0.00012345 BTC and 12345678 SHIB are each one position), so a fixed
// decimal count would erase the small-lot one and pad the large-lot one — hence significant digits,
// the same trim the candle helper applies to prices and volumes.
const QUOTE_DISPLAY_DECIMALS = 2;
const QTY_SIGNIFICANT_DIGITS = 6;

// ROUND_HALF_UP = nearest cent, the neutral choice for a figure nobody transacts on. Hard rule 1's
// "venue-facing rounding is explicit and directional" binds on the sizer/adapter path, not here —
// these strings never reach a venue.
function renderQuote(d: Decimal): string {
  return d.toDecimalPlaces(QUOTE_DISPLAY_DECIMALS, Decimal.ROUND_HALF_UP).toFixed();
}

function renderQty(d: Decimal): string {
  return d.toSignificantDigits(QTY_SIGNIFICANT_DIGITS, Decimal.ROUND_HALF_UP).toFixed();
}

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
  // v3 §6.4: keyed by venue id string (AppConfig.venueCapitalSplit's own shape — a plain zod-parsed
  // record, never a VenueId-keyed Map) — one entry per configured venue. Absent ⇒ perVenue omitted
  // (see buildPerVenue's own comment).
  venueCapitalShare?: Readonly<Record<string, string>>,
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
    // Dust still counts toward grossExposure: that figure is the book's TRUE gross, the same one
    // risk-engine.service.ts's exposure check and the sizer's headroom clamp compute — only the
    // per-position row below is dropped, so the model never sees an understated exposure.
    grossExposure = grossExposure.plus(notional);
    // A position under the venue minNotional is un-exitable dust: a reduce-only exit sized to that qty
    // is rejected BELOW_MINIMUM by the sizer, so listing it only buys exit proposals that can never
    // execute (agentic.strategy.ts's heldIsDust reclassifies the per-symbol summary to FLAT for
    // exactly this reason — the batch-wide block owes the model the same view). minNotional comes from
    // the SAME DEFAULT_FILTERS table Risk/Execution enforce, keyed by market id. No row for the symbol
    // ⇒ keep the row: fail open, never hide a position we cannot classify.
    const minNotional = DEFAULT_FILTERS.get(String(p.symbol))?.minNotional;
    if (minNotional !== undefined && notional.lt(minNotional)) continue;
    positions.push({
      symbol: String(p.symbol),
      side: p.signedQty.isNegative() ? 'SHORT' : 'LONG',
      qty: renderQty(p.signedQty.abs()),
      notional: renderQuote(notional),
    });
  }

  return {
    cappedEquity: renderQuote(cappedEquity),
    freeQuote: renderQuote(freeQuote),
    grossExposure: renderQuote(grossExposure),
    positions,
    ...buildCorrelation(priceHistory),
    ...buildPerVenue(snapshot, venueCapitalShare),
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

// v3 §6.4: one perVenue entry per venue named in venueCapitalShare (AppConfig.venueCapitalSplit).
// Fail-open, same convention as buildCorrelation above: absent venueCapitalShare OR absent
// snapshot.venueBalances (the composition root hasn't wired a venue-keyed balance source yet)
// omits the WHOLE array rather than rendering a misleadingly-zeroed freeCash. headroom/openNotional/
// reservedNotional mirror position-sizer.service.ts's applyVenueHeadroomClamp/venueOpenNotional/
// venueReservedNotional arithmetic exactly (those are private methods — this is a from-scratch
// reimplementation for this payload-rendering consumer, not a refactor of the sizer's own code path;
// position-sizer.service.ts stays the authoritative twin for the actual sizing clamp). USDT is this
// deployment's one quote/settle currency on both venues (mirrors freeQuote's own hardcoded 'USDT'
// lookup above), so one balance-map key serves spot's quote asset and perp's settle asset alike.
function buildPerVenue(
  snapshot: PortfolioSnapshot,
  venueCapitalShare: Readonly<Record<string, string>> | undefined,
): Pick<AgentPortfolioBlock, 'perVenue'> {
  if (venueCapitalShare === undefined || snapshot.venueBalances === undefined) return {};
  const venueKeys = Object.keys(venueCapitalShare);
  if (venueKeys.length === 0) return {};

  const perVenue: AgentPortfolioVenue[] = venueKeys.map((key) => {
    const venue = venueId(key);
    const capitalShare = venueCapitalShare[key]!;
    const freeCash = snapshot.venueBalances?.get(venue)?.get('USDT')?.free ?? new Decimal(0);
    const headroom = new Decimal(capitalShare)
      .sub(venueOpenNotional(snapshot, venue))
      .sub(venueReservedNotional(snapshot, venue));
    return {
      venue: key,
      freeCash: renderQuote(freeCash),
      // capitalShare is the operator-authored config string verbatim (AppConfig.venueCapitalSplit) —
      // never a computed Decimal, so it carries no precision tail to trim.
      capitalShare,
      headroom: renderQuote(headroom),
    };
  });
  return { perVenue };
}

// venueOpenNotional(v) = Σ over ALL positions on venue v (any strategy/symbol) of |signedQty| ×
// avgEntry — see position-sizer.service.ts's own identically-named private method for the
// authoritative twin (same proxy risk-engine.service.ts's gross/net exposure calc already uses).
function venueOpenNotional(snapshot: PortfolioSnapshot, venue: VenueId): Decimal {
  let sum = new Decimal(0);
  for (const p of snapshot.positions.values()) {
    if (p.venue !== venue) continue;
    sum = sum.add(p.signedQty.abs().mul(p.avgEntry));
  }
  return sum;
}

// venueReservedNotional(v) = Σ over in-flight ENTRY (¬reduceOnly) intents on venue v, valued at each
// order's own limit price (falls back to refPrice) — see position-sizer.service.ts's own
// identically-named private method for the authoritative twin.
function venueReservedNotional(snapshot: PortfolioSnapshot, venue: VenueId): Decimal {
  let sum = new Decimal(0);
  for (const f of snapshot.inFlightIntents) {
    if (f.venue !== venue || f.reduceOnly) continue;
    sum = sum.add(f.qty.mul(f.limitPrice ?? f.refPrice));
  }
  return sum;
}
