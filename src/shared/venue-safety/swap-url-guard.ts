// Fail-closed boot guard: a non-live swap adapter (paper/testnet/demo) must never resolve its
// private base URL to the live fapi.binance.com host — a resolveVenueUrls/ccxt regression (or a
// stray live override reaching a paper boot) would otherwise let a "paper" instance silently
// point at money-moving endpoints. Lives in shared (not market-data) so both the URL resolver's
// own tests and a feature-owned adapter (exchange/paper-perp.adapter.ts) can wire the same check
// without crossing the features/* wall (eslint-plugin-boundaries: a feature imports only itself).
export type SwapBootMode = 'paper' | 'testnet' | 'demo' | 'live';

const SAFE_NON_LIVE_SWAP_HOSTS = new Set(['demo-fapi.binance.com', 'testnet.binancefuture.com']);

export function assertSwapPrivateUrlSafe(url: string, mode: SwapBootMode): void {
  if (mode === 'live') return;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`swap private base URL is not a valid URL: "${url}"`);
  }
  if (!SAFE_NON_LIVE_SWAP_HOSTS.has(host)) {
    throw new Error(
      `refusing to boot a non-live ("${mode}") swap adapter against host "${host}" — expected ` +
        `one of [${[...SAFE_NON_LIVE_SWAP_HOSTS].join(', ')}] (fail-closed).`,
    );
  }
}
