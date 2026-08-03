import { Injectable } from '@nestjs/common';
import type {
  ExchangePort,
  VenueCapabilities,
  PlaceOrderRequest,
  ExchangeAck,
  ExchangeOrderState,
  VenueFill,
  CredentialCheck,
  AlgoOrderState,
  AlgoOrderHistoryView,
  VenuePosition,
  VenueFundingPayment,
} from '../../../ports/venue/exchange';
import { LIVE_ADAPTER_CAP } from '../../../ports/trading/mode-control';
import type { VenueId, SymbolId, ClientOrderId, EpochMs } from '../../../domain/common/types/ids';

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

  // Push 3 P7d (P7a gap): the swap algo-rail round-trip, delegated like every other method above.
  // pinPerpVenueDefaults is the ONE method deliberately left undelegated — that omission is
  // documented at its call site (trading-runtime.module.ts's startTrading): a live perp deployment
  // pins venue defaults as part of its own out-of-session RUN ceremony. Everything else a live boot
  // touches must be here, because a missing method is INVISIBLE to the caller — the optional members
  // of ExchangePort are `?.`-guarded or presence-tested everywhere, so a non-delegation degrades to
  // "the venue has nothing to say" rather than to an error.
  //
  // `?.` guards the inner adapter lacking a method (spot/paper). Each fallback matches the posture
  // the port declares for that method, never a convenient one:
  //   • fetchOpenAlgoOrders / fetchFundingPayments — vacuously empty (mirrors CcxtExchangeAdapter's
  //     own spot answer; both back measurement paths that fail OPEN on an absent venue rail);
  //   • fetchAlgoOrderStatus — `undefined`, the port's own "could not tell" answer, which
  //     AlgoStopRecoveryService retries next sweep rather than treating as proof the stop is gone;
  //   • cancelAlgoOrder / fetchPositions — reject loudly, FAIL CLOSED. A caller reaching
  //     cancelAlgoOrder believes an algo order exists and must not be told the cancel silently
  //     no-opped; an empty position list is indistinguishable from "the account is flat" and would
  //     drive reconciliation's position axis to a POSITION_DRIFT HALT on fabricated venue truth
  //     (CcxtExchangeAdapter.fetchPositions throws for exactly this reason).
  fetchOpenAlgoOrders(symbol?: SymbolId): Promise<readonly AlgoOrderState[]> {
    return this.inner.fetchOpenAlgoOrders?.(symbol) ?? Promise.resolve([]);
  }

  cancelAlgoOrder(algoId: string, symbol: SymbolId): Promise<void> {
    if (!this.inner.cancelAlgoOrder) {
      return Promise.reject(
        new Error('LiveExchangeAdapter: inner adapter does not implement cancelAlgoOrder'),
      );
    }
    return this.inner.cancelAlgoOrder(algoId, symbol);
  }

  fetchAlgoOrderStatus(
    clientAlgoId: string,
    symbol: SymbolId,
    sinceMs: EpochMs,
  ): Promise<AlgoOrderHistoryView | undefined> {
    return (
      this.inner.fetchAlgoOrderStatus?.(clientAlgoId, symbol, sinceMs) ?? Promise.resolve(undefined)
    );
  }

  fetchPositions(symbols?: readonly SymbolId[]): Promise<readonly VenuePosition[]> {
    if (!this.inner.fetchPositions) {
      return Promise.reject(
        new Error('LiveExchangeAdapter: inner adapter does not implement fetchPositions'),
      );
    }
    return this.inner.fetchPositions(symbols);
  }

  fetchFundingPayments(
    symbol: SymbolId,
    sinceMs: EpochMs,
  ): Promise<readonly VenueFundingPayment[]> {
    return this.inner.fetchFundingPayments?.(symbol, sinceMs) ?? Promise.resolve([]);
  }
}
