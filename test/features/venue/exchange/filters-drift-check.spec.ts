import { describe, expect, it, vi } from 'vitest';
import {
  checkVenueFilterDrift,
  parseVenueFilters,
  type DriftLog,
  type RawVenueMarkets,
} from '../../../../src/features/venue/exchange/filters-drift-check';
import { DEFAULT_FILTERS } from '../../../../src/domain/trading/risk/default-filters';
import { symbolId, venueId, type VenueId } from '../../../../src/domain/common/types/ids';

// The checker guards ORDER SIZING: DEFAULT_FILTERS is the only source of tickSize/stepSize/
// minNotional for both the position sizer and the risk engine's F1 re-validation, and this is the
// only thing that ever compares that hand-maintained table against the venue. Both halves of its
// declared failure direction are pinned below — a positive mismatch refuses the symbol (fail
// CLOSED), an absent measurement leaves the table standing (fail OPEN).

const SPOT = 'BTC/USDT';
const PERP = 'BTC/USDT:USDT';
// Read from the table rather than restated: these rows are probe-dated and get corrected, and a
// fixture that hardcoded them would start asserting the OLD venue truth the moment one is.
const SPOT_TABLE = DEFAULT_FILTERS.get(SPOT)!;
const PERP_TABLE = DEFAULT_FILTERS.get(PERP)!;

interface RowSpec {
  tickSize?: string;
  stepSize?: string;
  minQty?: string;
  minNotional?: string;
  // Spot answers NOTIONAL{minNotional}; USDⓈ-M fapi answers MIN_NOTIONAL{notional} — the checker
  // accepts both spellings off one code path, so both are exercised.
  notionalShape?: 'spot' | 'fapi';
  status?: string;
}

function marketRow(spec: RowSpec): unknown {
  const filters: Record<string, unknown>[] = [];
  if (spec.tickSize !== undefined)
    filters.push({ filterType: 'PRICE_FILTER', tickSize: spec.tickSize });
  if (spec.stepSize !== undefined || spec.minQty !== undefined)
    filters.push({ filterType: 'LOT_SIZE', stepSize: spec.stepSize, minQty: spec.minQty });
  if (spec.minNotional !== undefined) {
    filters.push(
      spec.notionalShape === 'fapi'
        ? { filterType: 'MIN_NOTIONAL', notional: spec.minNotional }
        : { filterType: 'NOTIONAL', minNotional: spec.minNotional },
    );
  }
  return { status: spec.status ?? 'TRADING', filters };
}

// The venue's own answer for a symbol whose table row is CORRECT, in the venue's zero-padded
// spelling ("0.01000000" for a table's "0.01") — the padding is what makes the comparison
// decimal-VALUE equality rather than string equality.
function agreeingRow(
  table: { tickSize: string; stepSize: string; minQty: string; minNotional: string },
  notionalShape: 'spot' | 'fapi' = 'spot',
): unknown {
  const pad = (v: string): string => (v.includes('.') ? `${v}000000` : `${v}.00000000`);
  return marketRow({
    tickSize: pad(table.tickSize),
    stepSize: pad(table.stepSize),
    minQty: pad(table.minQty),
    minNotional: pad(table.minNotional),
    notionalShape,
  });
}

function logSpy(): DriftLog & { errors: string[]; warns: string[]; logs: string[] } {
  const errors: string[] = [];
  const warns: string[] = [];
  const logs: string[] = [];
  return {
    errors,
    warns,
    logs,
    error: (m) => errors.push(m),
    warn: (m) => warns.push(m),
    log: (m) => logs.push(m),
  };
}

function loader(byVenue: Record<string, RawVenueMarkets | Error>) {
  const calls: VenueId[] = [];
  const load = (venue: VenueId): Promise<RawVenueMarkets> => {
    calls.push(venue);
    const answer = byVenue[String(venue)];
    if (answer === undefined || answer instanceof Error) {
      return Promise.reject(answer ?? new Error(`no markets for ${String(venue)}`));
    }
    return Promise.resolve(answer);
  };
  return { load, calls };
}

const SPOT_VENUE = String(venueId('binance'));
const PERP_VENUE = String(venueId('binanceusdm'));

describe('checkVenueFilterDrift (boot-time DEFAULT_FILTERS drift guard)', () => {
  it('refuses a symbol whose venue tick/step/minNotional all disagree with the table, reporting both sides verbatim', async () => {
    const log = logSpy();
    const drifted = marketRow({
      tickSize: '0.05',
      stepSize: '0.001',
      minQty: SPOT_TABLE.minQty,
      minNotional: '10',
    });
    const { load } = loader({ [SPOT_VENUE]: new Map([[SPOT, drifted]]) });
    const rows: { symbol: string; field: string }[] = [];

    const report = await checkVenueFilterDrift([symbolId(SPOT)], load, log, (r) =>
      rows.push({ symbol: r.symbol, field: r.field }),
    );

    expect([...report.refused]).toEqual([SPOT]);
    expect(report.unverified).toEqual([]);
    expect(report.checked).toBe(1);
    // Exact strings on both sides: the drift row is the evidence an operator corrects the table
    // from, so neither the table's value nor the venue's is normalised on the way out.
    expect(report.drifts).toEqual([
      { symbol: SPOT, field: 'tickSize', expected: SPOT_TABLE.tickSize, actual: '0.05' },
      { symbol: SPOT, field: 'stepSize', expected: SPOT_TABLE.stepSize, actual: '0.001' },
      { symbol: SPOT, field: 'minNotional', expected: SPOT_TABLE.minNotional, actual: '10' },
    ]);
    // One counter increment per drifted FIELD, not per symbol.
    expect(rows).toEqual([
      { symbol: SPOT, field: 'tickSize' },
      { symbol: SPOT, field: 'stepSize' },
      { symbol: SPOT, field: 'minNotional' },
    ]);
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]).toContain(`${SPOT} tickSize table=${SPOT_TABLE.tickSize} venue=0.05`);
  });

  it('enables a symbol whose venue agrees, across the venue zero-padding and both minNotional spellings', async () => {
    const log = logSpy();
    const { load, calls } = loader({
      [SPOT_VENUE]: new Map([[SPOT, agreeingRow(SPOT_TABLE)]]),
      [PERP_VENUE]: new Map([[PERP, agreeingRow(PERP_TABLE, 'fapi')]]),
    });

    const report = await checkVenueFilterDrift([symbolId(SPOT), symbolId(PERP)], load, log);

    expect([...report.refused]).toEqual([]);
    expect(report.drifts).toEqual([]);
    expect(report.unverified).toEqual([]);
    expect(report.checked).toBe(2);
    expect(log.errors).toEqual([]);
    expect(log.logs[0]).toContain('2 symbol(s) verified');
    // One loadMarkets per VENUE per boot, never per symbol.
    expect(calls.map(String)).toEqual([SPOT_VENUE, PERP_VENUE]);
  });

  it('refuses a symbol the venue does not list at all (fail closed)', async () => {
    const log = logSpy();
    const { load } = loader({ [SPOT_VENUE]: new Map() });

    const report = await checkVenueFilterDrift([symbolId(SPOT)], load, log);

    expect([...report.refused]).toEqual([SPOT]);
    expect(report.drifts).toEqual([
      { symbol: SPOT, field: 'unlisted', expected: 'listed', actual: 'absent' },
    ]);
    expect(report.checked).toBe(0); // never parsed ⇒ never counted as checked
  });

  it('refuses a symbol the venue lists as not trading (fail closed)', async () => {
    const log = logSpy();
    const halted = marketRow({ ...SPOT_TABLE, status: 'BREAK' });
    const { load } = loader({ [SPOT_VENUE]: new Map([[SPOT, halted]]) });

    const report = await checkVenueFilterDrift([symbolId(SPOT)], load, log);

    expect([...report.refused]).toEqual([SPOT]);
    expect(report.drifts).toEqual([
      { symbol: SPOT, field: 'status', expected: 'TRADING', actual: 'BREAK' },
    ]);
  });

  it('treats a status-less market row as tradable — the venue said nothing, so there is no verdict to fail on', async () => {
    const log = logSpy();
    const noStatus = { filters: [{ filterType: 'PRICE_FILTER', tickSize: SPOT_TABLE.tickSize }] };
    const { load } = loader({ [SPOT_VENUE]: new Map([[SPOT, noStatus]]) });

    const report = await checkVenueFilterDrift([symbolId(SPOT)], load, log);

    expect([...report.refused]).toEqual([]);
    expect(report.checked).toBe(1);
  });

  // The fail-OPEN half, exactly as the implementation's own header declares it: an ABSENT
  // measurement (venue unreachable, loadMarkets throws) leaves the static table standing rather
  // than grounding the boot — this checker must never become the biggest availability risk in the
  // boot path. Verified against the code, not just the comment: nothing here reaches `refused`.
  it('leaves symbols on the static table when the venue cannot be read at all (fail open), and does not retry that venue', async () => {
    const log = logSpy();
    const { load, calls } = loader({
      [SPOT_VENUE]: new Error('ETIMEDOUT loadMarkets'),
      [PERP_VENUE]: new Map([[PERP, agreeingRow(PERP_TABLE, 'fapi')]]),
    });

    const report = await checkVenueFilterDrift(
      [symbolId(SPOT), symbolId('ETH/USDT'), symbolId(PERP)],
      load,
      log,
    );

    expect([...report.refused]).toEqual([]);
    expect(report.drifts).toEqual([]);
    expect(report.unverified).toEqual([SPOT, 'ETH/USDT']);
    expect(report.checked).toBe(1); // only the reachable venue's symbol
    // The failed load is cached as undefined: one attempt per venue, however many symbols ride on it.
    expect(calls.map(String)).toEqual([SPOT_VENUE, PERP_VENUE]);
    expect(log.warns[0]).toContain('ETIMEDOUT loadMarkets');
    expect(log.warns[0]).toContain('fail open');
    expect(log.errors).toEqual([]);
  });

  it('reports an unrecognised market shape unverified rather than refusing it (fail open)', async () => {
    const log = logSpy();
    const { load } = loader({ [SPOT_VENUE]: new Map([[SPOT, { filters: 'not-an-array' }]]) });

    const report = await checkVenueFilterDrift([symbolId(SPOT)], load, log);

    expect([...report.refused]).toEqual([]);
    expect(report.unverified).toEqual([SPOT]);
    expect(report.checked).toBe(0);
    expect(log.warns[0]).toContain('not a recognised filter shape');
  });

  it('reports a non-decimal filter value unverified rather than refusing it (fail open)', async () => {
    const log = logSpy();
    const junk = marketRow({ tickSize: 'n/a', stepSize: SPOT_TABLE.stepSize });
    const { load } = loader({ [SPOT_VENUE]: new Map([[SPOT, junk]]) });

    const report = await checkVenueFilterDrift([symbolId(SPOT)], load, log);

    expect([...report.refused]).toEqual([]);
    expect(report.unverified).toEqual([SPOT]);
    expect(log.warns[0]).toContain('tickSize="n/a" is not a decimal');
  });

  it('ignores a filter the venue does not report — an absent field contradicts nothing', async () => {
    const log = logSpy();
    const partial = marketRow({ tickSize: SPOT_TABLE.tickSize }); // no LOT_SIZE, no NOTIONAL
    const { load } = loader({ [SPOT_VENUE]: new Map([[SPOT, partial]]) });

    const report = await checkVenueFilterDrift([symbolId(SPOT)], load, log);

    expect([...report.refused]).toEqual([]);
    expect(report.drifts).toEqual([]);
    expect(report.checked).toBe(1);
  });

  it('skips a symbol with no table row at all — the boot already fails those elsewhere', async () => {
    const log = logSpy();
    const load = vi.fn(() => Promise.resolve<RawVenueMarkets>(new Map()));

    const report = await checkVenueFilterDrift([symbolId('NOTATABLEROW/USDT')], load, log);

    expect([...report.refused]).toEqual([]);
    expect(report.checked).toBe(0);
    expect(load).not.toHaveBeenCalled(); // no table row ⇒ no venue round trip
  });

  // A stale minQty is deliberately NOT compared: it produces a loud per-order venue REJECTION, so
  // refusing the whole symbol for it would trade a visible failure for an invisible one.
  it('does not refuse a symbol for a minQty the table disagrees with', async () => {
    const log = logSpy();
    const row = marketRow({ ...SPOT_TABLE, minQty: '999' });
    const { load } = loader({ [SPOT_VENUE]: new Map([[SPOT, row]]) });

    const report = await checkVenueFilterDrift([symbolId(SPOT)], load, log);

    expect([...report.refused]).toEqual([]);
    expect(report.drifts).toEqual([]);
  });
});

describe('parseVenueFilters', () => {
  it('reads both the spot NOTIONAL and the fapi MIN_NOTIONAL spelling', () => {
    expect(
      parseVenueFilters(marketRow({ minNotional: '5', notionalShape: 'spot' }))?.filters
        .minNotional,
    ).toBe('5');
    expect(
      parseVenueFilters(marketRow({ minNotional: '50', notionalShape: 'fapi' }))?.filters
        .minNotional,
    ).toBe('50');
  });

  it('returns undefined for a row that is not a filter-carrying object', () => {
    expect(parseVenueFilters(null)).toBeUndefined();
    expect(parseVenueFilters('BTC/USDT')).toBeUndefined();
    expect(parseVenueFilters({ filters: {} })).toBeUndefined();
  });

  it('ignores empty and non-string filter values rather than reading them as a venue answer', () => {
    const parsed = parseVenueFilters({
      status: 'TRADING',
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '' },
        { filterType: 'LOT_SIZE', stepSize: 0.001 },
        'not-an-object',
      ],
    });
    expect(parsed?.filters.tickSize).toBeUndefined();
    expect(parsed?.filters.stepSize).toBeUndefined();
    expect(parsed?.status).toBe('TRADING');
  });
});
