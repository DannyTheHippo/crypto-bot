export interface ResolvedVenueUrls {
  readonly restSpot: string;
  readonly wsSpot: string;
  readonly wsApiSpot: string;
}

/**
 * Resolves the REST and WS base URLs for a ccxt pro exchange instance
 * after the environment mode has been applied (setSandboxMode/enableDemoTrading/live).
 *
 * ccxt's url tree shape is venue-specific. This function encodes the known
 * structure for Binance at ccxt 4.5.58.
 *
 * Binance: urls.api.public (REST spot), urls.api.ws.spot (WS streams),
 *          urls.api['ws-api'].spot (WS-API).
 */
export function resolveVenueUrls(
  exchange: {
    urls: {
      api?: Record<string, unknown>;
    };
    hostname?: string;
  },
  venueId: string,
): ResolvedVenueUrls {
  const api = exchange.urls?.api ?? {};
  const hostname: string = exchange.hostname ?? '';

  function sub(s: unknown): string {
    if (typeof s !== 'string') return '';
    return hostname ? s.replace(/\{hostname\}/g, hostname) : s;
  }

  if (venueId === 'binance') {
    const ws = api['ws'] as Record<string, unknown> | undefined;
    const wsApi = ws?.['ws-api'] as Record<string, unknown> | undefined;
    return {
      restSpot: sub(api['public']),
      wsSpot: sub(ws?.['spot']),
      wsApiSpot: sub(wsApi?.['spot']),
    };
  }

  // Generic fallback for future venues
  const ws = api['ws'] as Record<string, unknown> | undefined;
  return {
    restSpot: sub(api['public'] ?? api['rest']),
    wsSpot: sub(ws?.['spot'] ?? ws?.['public']),
    wsApiSpot: '',
  };
}
