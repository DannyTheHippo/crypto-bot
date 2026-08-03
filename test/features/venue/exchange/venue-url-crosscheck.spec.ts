import { describe, it, expect } from 'vitest';
import { venuePrivateUrlCrossCheckOk } from '../../../../src/shared/venue-safety/venue-url-crosscheck';
import { venuePrivateUrl } from '../../../../src/features/trading/composition/exchange-adapters.module';
import { resolveUrlCrossCheck } from '../../../../src/features/trading/composition/key-probe.module';

// Lives under test/features (not test/shared) because the production gate runs
// `vitest run test/features test/domain test/ports test/livegate` — a spec for a live-gate conjunct
// must be ON that gate, and the rail that consumes it is features/venue/exchange's key probe.
describe('venuePrivateUrlCrossCheckOk (live gate (c) URL conjunct)', () => {
  it('refuses a LIVE base URL under a sandboxed environment', () => {
    expect(venuePrivateUrlCrossCheckOk('binance', 'https://api.binance.com/api/v3', 'demo')).toBe(
      false,
    );
    expect(
      venuePrivateUrlCrossCheckOk('binance', 'https://api.binance.com/api/v3', 'testnet'),
    ).toBe(false);
    expect(
      venuePrivateUrlCrossCheckOk('binanceusdm', 'https://fapi.binance.com/fapi/v1', 'demo'),
    ).toBe(false);
  });

  it('accepts the demo/testnet hosts under their own sandbox environment', () => {
    expect(
      venuePrivateUrlCrossCheckOk('binance', 'https://demo-api.binance.com/api/v3', 'demo'),
    ).toBe(true);
    expect(
      venuePrivateUrlCrossCheckOk('binance', 'https://testnet.binance.vision/api/v3', 'testnet'),
    ).toBe(true);
    expect(
      venuePrivateUrlCrossCheckOk('binanceusdm', 'https://demo-fapi.binance.com/fapi/v1', 'demo'),
    ).toBe(true);
    expect(
      venuePrivateUrlCrossCheckOk(
        'binanceusdm',
        'https://testnet.binancefuture.com/fapi/v1',
        'testnet',
      ),
    ).toBe(true);
  });

  it('accepts the live hosts only on a live boot', () => {
    expect(venuePrivateUrlCrossCheckOk('binance', 'https://api.binance.com/api/v3', 'live')).toBe(
      true,
    );
    expect(
      venuePrivateUrlCrossCheckOk('binanceusdm', 'https://fapi.binance.com/fapi/v1', 'live'),
    ).toBe(true);
    // The mirror image of the first case: a sandbox host must not pass as live either.
    expect(
      venuePrivateUrlCrossCheckOk('binance', 'https://demo-api.binance.com/api/v3', 'live'),
    ).toBe(false);
  });

  it('refuses an unrecognised host, an unknown venue, an unparseable URL, and a paper boot (fail closed)', () => {
    expect(venuePrivateUrlCrossCheckOk('binance', 'https://api.evil.example/api/v3', 'live')).toBe(
      false,
    );
    expect(venuePrivateUrlCrossCheckOk('kraken', 'https://api.kraken.com', 'live')).toBe(false);
    expect(venuePrivateUrlCrossCheckOk('binance', 'not-a-url', 'live')).toBe(false);
    expect(venuePrivateUrlCrossCheckOk('binance', 'https://api.binance.com/api/v3', 'paper')).toBe(
      false,
    );
  });

  // A near-miss the Set-membership form must not wave through: the host is compared whole, so a
  // look-alike prefix/suffix of an allowed host is refused.
  it('refuses look-alike hosts that merely contain an allowed host string', () => {
    expect(
      venuePrivateUrlCrossCheckOk('binance', 'https://api.binance.com.evil.example/api/v3', 'live'),
    ).toBe(false);
    expect(
      venuePrivateUrlCrossCheckOk('binance', 'https://demo-api.binance.com.co/api/v3', 'demo'),
    ).toBe(false);
  });
});

// Ties the allow-list to what ccxt 4.5.58 ACTUALLY resolves (offline, no network): if a ccxt bump
// repoints a rail, this fails alongside the sandbox-URL regression test instead of silently turning
// the gate conjunct false (or, worse, true against the wrong host).
describe('resolveUrlCrossCheck against the real ccxt url tree (pinned 4.5.58)', () => {
  it('passes for every credentialed environment the bot can boot into', () => {
    expect(resolveUrlCrossCheck('demo')).toBe(true);
    expect(resolveUrlCrossCheck('testnet')).toBe(true);
    expect(resolveUrlCrossCheck('live')).toBe(true);
  });

  it('refuses a paper boot (no venue credentials, no legitimate host)', () => {
    expect(resolveUrlCrossCheck('paper')).toBe(false);
  });

  it('reads the mode-mutated private base URL for both rails', () => {
    expect(venuePrivateUrl('binance', 'demo')).toBe('https://demo-api.binance.com/api/v3');
    expect(venuePrivateUrl('binance', 'testnet')).toBe('https://testnet.binance.vision/api/v3');
    expect(venuePrivateUrl('binance', 'live')).toBe('https://api.binance.com/api/v3');
    expect(venuePrivateUrl('binanceusdm', 'demo')).toBe('https://demo-fapi.binance.com/fapi/v1');
    expect(venuePrivateUrl('binanceusdm', 'testnet')).toBe(
      'https://testnet.binancefuture.com/fapi/v1',
    );
    expect(venuePrivateUrl('binanceusdm', 'live')).toBe('https://fapi.binance.com/fapi/v1');
  });
});
