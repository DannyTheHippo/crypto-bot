import { describe, it, expect } from 'vitest';
import { buildCcxtExchange } from '../../../src/modules/market-data/ccxt-stream.adapter';
import { resolveVenueUrls } from '../../../src/modules/market-data/venue-urls';
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
    // Human-readable anchor: every endpoint is on the testnet host, never production.
    for (const v of Object.values(u)) expect(v).toContain('testnet.binance.vision');
  });

  it('demo (enableDemoTrading) → demo-*.binance.com', () => {
    const u = urls('binance', 'demo');
    expect(u.restSpot).toBe('https://demo-api.binance.com/api/v3');
    expect(u.wsSpot).toBe('wss://demo-stream.binance.com/ws');
    expect(u.wsApiSpot).toBe('wss://demo-ws-api.binance.com/ws-api/v3');
  });
});
