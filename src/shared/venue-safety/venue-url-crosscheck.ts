// Live gate (c)'s URL conjunct (KeyProbeResult.urlCrossCheckOk): the credentialed rails' effective
// PRIVATE REST base URL must be the host the BOOTED environment is supposed to talk to — the live
// hosts only on a live boot, the sandbox hosts only once setSandboxMode/enableDemoTrading has been
// applied. Sibling of swap-url-guard.ts: that guard THROWS at boot for the non-live swap rail; this
// one returns a verdict instead, because gate (c) consumes it as a conjunct rather than as a boot
// refusal. Lives in shared/ for the same boundaries reason (composition and feature code both need it).
//
// FAILURE DIRECTION: permission/safety gate ⇒ fails CLOSED. Unknown venue, unparseable URL,
// unrecognised host, a host belonging to a DIFFERENT environment, or a paper boot all return false,
// which drives keysValid false and leaves the effective mode at paper.
export type VenueUrlEnvironment = 'paper' | 'testnet' | 'demo' | 'live';

// Per-venue private-REST host, one per environment, at the PINNED ccxt 4.5.58 — the same values
// test/features/venue/market-data/sandbox-url.spec.ts pins for the resolved base URLs (spot reads
// urls.api.private, USD-M swap reads urls.api.fapiPrivate). A ccxt bump that repoints any rail makes
// that regression test fail first; this table is the second wall behind it. `paper` has no entry: a
// paper boot holds no venue credentials, so there is no host that could legitimately match.
const PRIVATE_HOSTS: Readonly<
  Record<string, Readonly<Record<'testnet' | 'demo' | 'live', string>>>
> = {
  binance: {
    live: 'api.binance.com',
    testnet: 'testnet.binance.vision',
    demo: 'demo-api.binance.com',
  },
  binanceusdm: {
    live: 'fapi.binance.com',
    testnet: 'testnet.binancefuture.com',
    demo: 'demo-fapi.binance.com',
  },
};

export function venuePrivateUrlCrossCheckOk(
  venue: string,
  url: string,
  environment: VenueUrlEnvironment,
): boolean {
  if (environment === 'paper') return false;
  const hosts = PRIVATE_HOSTS[venue];
  if (hosts === undefined) return false;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return host === hosts[environment];
}
