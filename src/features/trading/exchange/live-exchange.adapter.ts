import { Injectable } from '@nestjs/common';
import type {
  ExchangePort,
  VenueCapabilities,
  PlaceOrderRequest,
  ExchangeAck,
  ExchangeOrderState,
  VenueFill,
  CredentialCheck,
} from '../../../ports/exchange';
import { LIVE_ADAPTER_CAP } from '../../../ports/mode-control';
import type { VenueId, SymbolId, ClientOrderId, EpochMs } from '../../../domain/types/ids';

// §10: the live-only ExchangePort. It is a thin guarded WRAPPER around a real CcxtExchangeAdapter
// (built with live URLs + credentials at the composition root) — it adds NO venue logic of its own,
// only the two backstops that keep live unreachable from CI:
//   1. the constructor throws unconditionally under NODE_ENV=test/ci or CI (so a CI process can never
//      hold a live client even if the inner adapter were somehow constructed), and
//   2. it requires the genuine LIVE_ADAPTER_CAP capability token (mintable only by the composition
//      root at a live boot) — any other token is refused.
// Under test/ci configMode is forced paper, so this class is never constructed; the live-gate matrix
// asserts no instance exists. Delegation is exercised only at the out-of-session live RUN.
@Injectable()
export class LiveExchangeAdapter implements ExchangePort {
  readonly venue: VenueId;
  readonly capabilities: VenueCapabilities;
  private readonly inner: ExchangePort;

  constructor(cap: symbol, inner: ExchangePort) {
    if (
      process.env['NODE_ENV'] === 'test' ||
      process.env['NODE_ENV'] === 'ci' ||
      process.env['CI']
    ) {
      throw new Error('LiveExchangeAdapter must never be constructed under NODE_ENV=test/ci or CI');
    }
    if (cap !== LIVE_ADAPTER_CAP) {
      throw new Error('LiveExchangeAdapter requires the LIVE_ADAPTER_CAP capability token');
    }
    this.inner = inner;
    this.venue = inner.venue;
    this.capabilities = inner.capabilities;
  }

  placeOrder(req: PlaceOrderRequest): Promise<ExchangeAck> {
    return this.inner.placeOrder(req);
  }

  cancelOrder(coid: ClientOrderId, symbol: SymbolId): Promise<ExchangeAck> {
    return this.inner.cancelOrder(coid, symbol);
  }

  fetchOrder(coid: ClientOrderId, symbol: SymbolId): Promise<ExchangeOrderState> {
    return this.inner.fetchOrder(coid, symbol);
  }

  fetchOpenOrders(symbol?: SymbolId): Promise<readonly ExchangeOrderState[]> {
    return this.inner.fetchOpenOrders(symbol);
  }

  fetchBalances(): Promise<ReadonlyMap<string, { free: string; locked: string }>> {
    return this.inner.fetchBalances();
  }

  fetchMyTrades(symbol: SymbolId, since: EpochMs): Promise<readonly VenueFill[]> {
    return this.inner.fetchMyTrades(symbol, since);
  }

  validateCredentials(): Promise<CredentialCheck> {
    return this.inner.validateCredentials();
  }
}
