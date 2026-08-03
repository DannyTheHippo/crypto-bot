import { makeCounterProvider } from '@willsoto/nestjs-prometheus';
import Decimal from 'decimal.js';
import { DEFAULT_FILTERS } from '../../../domain/trading/risk/default-filters';
import type { SymbolFilters } from '../../../domain/trading/risk/evaluate';
import { venueForSymbol } from '../../../domain/venue/types/venue-map';
import type { SymbolId, VenueId } from '../../../domain/common/types/ids';

// Boot-time drift check for DEFAULT_FILTERS (domain/trading/risk/default-filters.ts), the static,
// hand-maintained, probe-dated table that is the ONLY source of tickSize/stepSize/minNotional for
// BOTH the position sizer and the risk engine's F1 re-validation. ExchangePort has no loadMarkets,
// so nothing has ever compared that table against the venue: a venue that re-tiers a symbol's
// LOT_SIZE silently mis-sizes every order for it until a human notices, and the table's own comments
// record that eight of sixteen hand-estimated rows were wrong the last time anyone checked.
//
// FAILURE DIRECTION, split deliberately along "is this a measurement or a verdict":
//   • a POSITIVE mismatch (the venue answered, and its filters disagree with the table, or it does
//     not list the symbol, or it lists it as not trading) FAILS CLOSED — the symbol is refused and
//     never enabled. This guards order sizing, which is money; a wrongly-rounded order is a real
//     order at a wrong size, and refusing to trade one symbol is strictly cheaper than that.
//   • an ABSENT measurement (the venue is unreachable, loadMarkets throws, the market row is
//     unparseable) FAILS OPEN — logged as unverified, the static table stands. The table is
//     deterministic, committed and probe-dated; letting a venue hiccup at boot ground the whole bot
//     would make this checker itself the biggest availability risk in the boot path.
// Paper never calls this (the static table IS the venue there — see the caller's own gate).

// Public shape of the seam: one raw venue market row per symbol, exactly as the venue reports it.
// Kept `unknown` because the caller owns venue construction (ccxt lives in the composition root and
// the market-data feature, neither of which this feature may import) while the FILTER SEMANTICS —
// which Binance filterType carries which field, and that every one of them is a decimal STRING —
// belong here next to the table they are compared against.
export type RawVenueMarkets = ReadonlyMap<string, unknown>;

export interface DriftLog {
  error(message: string): void;
  warn(message: string): void;
  log(message: string): void;
}

// `expected` is always the DEFAULT_FILTERS value, `actual` the venue's, both verbatim strings — a
// drift row is evidence an operator uses to correct the table, so neither side is normalised.
export interface FilterDriftRow {
  readonly symbol: string;
  readonly field: 'tickSize' | 'stepSize' | 'minNotional' | 'status' | 'unlisted';
  readonly expected: string;
  readonly actual: string;
}

export interface FilterDriftReport {
  readonly refused: ReadonlySet<string>;
  readonly drifts: readonly FilterDriftRow[];
  // Symbols whose venue could not be read at all — NOT refused (see the fail-open half above).
  readonly unverified: readonly string[];
  readonly checked: number;
}

export const VENUE_FILTER_DRIFT_COUNTER = makeCounterProvider({
  name: 'venue_filter_drift_total',
  help: 'Symbols refused at boot because the venue disagreed with the static DEFAULT_FILTERS table, by field',
  labelNames: ['symbol', 'field'] as const,
});

// The three fields a drifted value silently MIS-SIZES an order through: tickSize and stepSize are
// the rounding quanta the sizer applies, minNotional the floor it sizes up to. minQty is compared by
// neither — a stale minQty produces a venue REJECTION (loud, per-order, immediately visible), never
// a wrong-sized fill, so refusing a whole symbol for it would trade a visible failure for an
// invisible one.
const COMPARED: readonly (keyof Pick<SymbolFilters, 'tickSize' | 'stepSize' | 'minNotional'>)[] = [
  'tickSize',
  'stepSize',
  'minNotional',
];

// Binance reports filters as zero-padded decimal strings ("0.01000000" for a table's "0.01"), so the
// comparison is decimal-VALUE equality via Decimal — never string equality (which would report drift
// on every row) and never a float (hard rule 1). A non-numeric answer throws out of Decimal and is
// caught by the caller's own per-symbol guard, landing the symbol in `unverified`.
function sameValue(a: string, b: string): boolean {
  return new Decimal(a).eq(new Decimal(b));
}

function filterField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// Narrow one raw venue market row (ccxt's `market.info` = one Binance exchangeInfo symbol entry) to
// the filters this table cares about. Reads the RAW filter array rather than ccxt's unified
// `precision`/`limits`, which are native NUMBERS — parsing money-adjacent quanta out of a float is
// exactly what hard rule 1 forbids, and 1e-8 tick sizes do not survive the round trip intact.
// Returns undefined when the row is not the expected shape (fail open — the caller reports the
// symbol unverified rather than refusing it on a parse it does not understand).
export function parseVenueFilters(
  raw: unknown,
): { filters: Partial<SymbolFilters>; status?: string } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const row = raw as Record<string, unknown>;
  const rawFilters = row['filters'];
  if (!Array.isArray(rawFilters)) return undefined;
  const filters: { tickSize?: string; stepSize?: string; minQty?: string; minNotional?: string } =
    {};
  for (const entry of rawFilters as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const f = entry as Record<string, unknown>;
    switch (f['filterType']) {
      case 'PRICE_FILTER':
        filters.tickSize = filterField(f, 'tickSize');
        break;
      case 'LOT_SIZE':
        filters.stepSize = filterField(f, 'stepSize');
        filters.minQty = filterField(f, 'minQty');
        break;
      // Spot answers NOTIONAL{minNotional}; USDⓈ-M fapi answers MIN_NOTIONAL{notional}. Both spellings
      // are accepted because this checker runs against both venues off one code path.
      case 'NOTIONAL':
      case 'MIN_NOTIONAL':
        filters.minNotional = filterField(f, 'minNotional') ?? filterField(f, 'notional');
        break;
      default:
        break;
    }
  }
  const status = row['status'];
  return { filters, status: typeof status === 'string' ? status : undefined };
}

// Compare every configured symbol against its own venue's live filters. Loads each venue's markets
// AT MOST ONCE (one exchangeInfo/loadMarkets round trip per venue per boot, never per symbol).
export async function checkVenueFilterDrift(
  symbols: readonly SymbolId[],
  loadVenueMarkets: (venue: VenueId) => Promise<RawVenueMarkets>,
  log: DriftLog,
  onDrift?: (row: FilterDriftRow) => void,
): Promise<FilterDriftReport> {
  const refused = new Set<string>();
  const drifts: FilterDriftRow[] = [];
  const unverified: string[] = [];
  const markets = new Map<VenueId, RawVenueMarkets | undefined>();
  let checked = 0;

  const refuse = (row: FilterDriftRow): void => {
    refused.add(row.symbol);
    drifts.push(row);
    onDrift?.(row);
  };

  for (const symbol of symbols) {
    const key = String(symbol);
    const expected = DEFAULT_FILTERS.get(key);
    if (expected === undefined) continue; // startTrading already fails the boot on a filter-less symbol
    const venue = venueForSymbol(symbol);
    if (!markets.has(venue)) {
      try {
        markets.set(venue, await loadVenueMarkets(venue));
      } catch (err) {
        markets.set(venue, undefined);
        log.warn(
          `venue filter drift: venue "${venue}" market load failed (${err instanceof Error ? err.message : String(err)}) — ` +
            'symbols on it stay on the static DEFAULT_FILTERS table (unverified, fail open)',
        );
      }
    }
    const venueMarkets = markets.get(venue);
    if (venueMarkets === undefined) {
      unverified.push(key);
      continue;
    }
    const raw = venueMarkets.get(key);
    if (raw === undefined) {
      refuse({ symbol: key, field: 'unlisted', expected: 'listed', actual: 'absent' });
      continue;
    }
    const parsed = parseVenueFilters(raw);
    if (parsed === undefined) {
      unverified.push(key);
      log.warn(
        `venue filter drift: ${key} market row is not a recognised filter shape — unverified`,
      );
      continue;
    }
    checked += 1;
    // 'TRADING' is Binance's own tradable status on both the spot and fapi exchangeInfo payloads; a
    // row that omits status entirely is treated as tradable (the venue said nothing, so this is the
    // absent-measurement half, not a verdict).
    if (parsed.status !== undefined && parsed.status !== 'TRADING') {
      refuse({ symbol: key, field: 'status', expected: 'TRADING', actual: parsed.status });
      continue;
    }
    for (const field of COMPARED) {
      const actual = parsed.filters[field];
      if (actual === undefined) continue; // the venue did not report this filter — nothing to contradict
      let matches: boolean;
      try {
        matches = sameValue(expected[field], actual);
      } catch {
        unverified.push(key);
        log.warn(`venue filter drift: ${key} ${field}="${actual}" is not a decimal — unverified`);
        break;
      }
      if (!matches) {
        refuse({ symbol: key, field, expected: expected[field], actual });
      }
    }
  }

  if (drifts.length > 0) {
    log.error(
      `VENUE FILTER DRIFT — DEFAULT_FILTERS disagrees with the venue; these symbols are REFUSED for ` +
        `this boot (fix domain/trading/risk/default-filters.ts and redeploy): ` +
        drifts
          .map((d) => `${d.symbol} ${d.field} table=${d.expected} venue=${d.actual}`)
          .join('; '),
    );
  } else if (checked > 0) {
    log.log(`venue filter drift: ${checked} symbol(s) verified against venue filters, no drift`);
  }
  return { refused, drifts, unverified, checked };
}
