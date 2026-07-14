import { describe, it, expect } from 'vitest';
import { buildCcxtExchange } from '../../../src/features/trading/market-data/ccxt-stream.adapter';
import { resolveVenueUrls } from '../../../src/features/trading/market-data/venue-urls';
import { assertSwapPrivateUrlSafe } from '../../../src/shared/venue-safety/swap-url-guard';
import type { VenueConfig, VenueEnvironment } from '../../../src/ports/app-config';

describe('resolveVenueUrls generic fallback (unknown venue)', () => {
  it('uses api.public / ws.spot and leaves wsApi empty', () => {
    const fake = {
      urls: { api: { public: 'https://api.kraken.test', ws: { spot: 'wss://ws.kraken.test' } } },
    };
    const u = resolveVenueUrls(fake, 'kraken');
    expect(u.restSpot).toBe('https://api.kraken.test');
    expect(u.wsSpot).toBe('wss://ws.kraken.test');
    expect(u.wsApiSpot).toBe('');
  });

  it('falls back to api.rest / ws.public when primary keys are absent', () => {
    const fake = {
      urls: { api: { rest: 'https://rest.x.test', ws: { public: 'wss://pub.x.test' } } },
    };
    const u = resolveVenueUrls(fake, 'somevenue');
    expect(u.restSpot).toBe('https://rest.x.test');
    expect(u.wsSpot).toBe('wss://pub.x.test');
  });
});

// SANDBOX-URL REGRESSION TEST (CLAUDE.md: bumping ccxt requires re-running this).
// Asserts the base URLs that setSandboxMode/enableDemoTrading/live resolve to against
// the PINNED ccxt 4.5.58. If a ccxt bump silently repoints any environment, this fails
// loudly instead of trading against the wrong venue. URL resolution is offline (no network).
//
// Discrepancies vs docs/design-plan.md §3.5 (asserting ccxt's ACTUAL 4.5.58 values):
//   - Binance testnet REST: ccxt = ".../api/v3"; plan shorthand said ".../api".
//   - Binance testnet streams: ccxt = ".../ws"; plan said ".../ws/stream" (legacy path).
//   - Binance live WS carries explicit ports (:9443 streams, :443 ws-api).

function urls(id: string, environment: VenueEnvironment) {
  const cfg: VenueConfig = { id, environment };
  const ex = buildCcxtExchange(cfg);
  return resolveVenueUrls(
    ex as unknown as { urls: { api?: Record<string, unknown> }; hostname?: string },
    id,
  );
}

describe('Binance sandbox/demo/live URL resolution (ccxt 4.5.58)', () => {
  it('live', () => {
    const u = urls('binance', 'live');
    expect(u.restSpot).toBe('https://api.binance.com/api/v3');
    expect(u.wsSpot).toBe('wss://stream.binance.com:9443/ws');
    expect(u.wsApiSpot).toBe('wss://ws-api.binance.com:443/ws-api/v3');
  });

  it('testnet (setSandboxMode) → testnet.binance.vision', () => {
    const u = urls('binance', 'testnet');
    expect(u.restSpot).toBe('https://testnet.binance.vision/api/v3');
    expect(u.wsSpot).toBe('wss://stream.testnet.binance.vision/ws');
    expect(u.wsApiSpot).toBe('wss://ws-api.testnet.binance.vision/ws-api/v3');
    // Human-readable anchor: every spot endpoint is on the testnet host, never production.
    // (restSwapPublic/restSwapPrivate are the binanceusdm-only fields, empty here by design —
    // excluded from this loop rather than iterating Object.values, which would break on them.)
    for (const v of [u.restSpot, u.wsSpot, u.wsApiSpot]) {
      expect(v).toContain('testnet.binance.vision');
    }
  });

  it('demo (enableDemoTrading) → demo-*.binance.com', () => {
    const u = urls('binance', 'demo');
    expect(u.restSpot).toBe('https://demo-api.binance.com/api/v3');
    expect(u.wsSpot).toBe('wss://demo-stream.binance.com/ws');
    expect(u.wsApiSpot).toBe('wss://demo-ws-api.binance.com/ws-api/v3');
  });
});

// USD-M swap (binanceusdm) — same regression-test rationale as the spot suite above: pins the
// PUBLIC (market-data) and PRIVATE (trading) REST bases ccxt 4.5.58 actually resolves to for each
// environment, verified offline against the installed ccxt build. At 4.5.58, public and private
// both go through the fapi* host (no separate market-data host for USD-M swap).
describe('Binance USD-M swap (binanceusdm) URL resolution (ccxt 4.5.58)', () => {
  it('live → fapi.binance.com', () => {
    const u = urls('binanceusdm', 'live');
    expect(u.restSwapPublic).toBe('https://fapi.binance.com/fapi/v1');
    expect(u.restSwapPrivate).toBe('https://fapi.binance.com/fapi/v1');
  });

  it('testnet (setSandboxMode) → testnet.binancefuture.com', () => {
    const u = urls('binanceusdm', 'testnet');
    expect(u.restSwapPublic).toBe('https://testnet.binancefuture.com/fapi/v1');
    expect(u.restSwapPrivate).toBe('https://testnet.binancefuture.com/fapi/v1');
  });

  it('demo (enableDemoTrading) → demo-fapi.binance.com', () => {
    const u = urls('binanceusdm', 'demo');
    expect(u.restSwapPublic).toBe('https://demo-fapi.binance.com/fapi/v1');
    expect(u.restSwapPrivate).toBe('https://demo-fapi.binance.com/fapi/v1');
  });
});

// Fail-closed boot guard: a non-live swap boot must never resolve against the live fapi host.
describe('assertSwapPrivateUrlSafe (fail-closed swap boot guard)', () => {
  it('throws when a non-live mode resolves to the live fapi.binance.com host', () => {
    expect(() => assertSwapPrivateUrlSafe('https://fapi.binance.com/fapi/v1', 'paper')).toThrow(
      /refusing to boot/,
    );
    expect(() => assertSwapPrivateUrlSafe('https://fapi.binance.com/fapi/v1', 'testnet')).toThrow(
      /refusing to boot/,
    );
    expect(() => assertSwapPrivateUrlSafe('https://fapi.binance.com/fapi/v1', 'demo')).toThrow(
      /refusing to boot/,
    );
  });

  it('passes for the testnet/demo hosts in a matching non-live mode', () => {
    expect(() =>
      assertSwapPrivateUrlSafe('https://testnet.binancefuture.com/fapi/v1', 'testnet'),
    ).not.toThrow();
    expect(() =>
      assertSwapPrivateUrlSafe('https://demo-fapi.binance.com/fapi/v1', 'paper'),
    ).not.toThrow();
  });

  it('never checks the host in live mode', () => {
    expect(() =>
      assertSwapPrivateUrlSafe('https://fapi.binance.com/fapi/v1', 'live'),
    ).not.toThrow();
  });
});

// CCXT CAPABILITY-METADATA REGRESSION (CLAUDE.md: bumping ccxt requires re-running this).
// ccxt 4.5.58's binanceusdm.describe() UNDER-REPORTS its inherited pro-streaming capabilities:
// the watch* methods are inherited from binance and work (empirically verified 2026-07-14 against
// demo-fapi — ticker/OHLCV/book/trades all return live data), but has.watch* come back undefined,
// which made assertCapabilities false-negative and crash-loop the perp lane at boot. buildCcxtExchange
// patches the verified-true capabilities. If a ccxt bump corrects the upstream metadata this stays
// green (idempotent); if a bump instead REMOVES a method, the boot probe would catch it — but pin the
// metadata contract here so the fix is not silently lost.
describe('binanceusdm pro-streaming capability augmentation (ccxt 4.5.58 has-map quirk)', () => {
  it('reports watchTicker/watchOHLCV/watchOrderBook/watchTrades as supported', () => {
    const ex = buildCcxtExchange({ id: 'binanceusdm', environment: 'demo' });
    const has = ex.has as Record<string, unknown>;
    expect(has['watchTicker']).toBe(true);
    expect(has['watchOHLCV']).toBe(true);
    expect(has['watchOrderBook']).toBe(true);
    expect(has['watchTrades']).toBe(true);
  });

  it('does NOT touch a spot binance venue (its has-map is already correct)', () => {
    const ex = buildCcxtExchange({ id: 'binance', environment: 'demo' });
    const has = ex.has as Record<string, unknown>;
    // untouched — binance already reports these; assertion guards against an over-broad patch
    expect(has['watchTicker']).toBe(true);
  });
});
