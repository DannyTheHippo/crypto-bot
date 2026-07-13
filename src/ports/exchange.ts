import type { VenueId, SymbolId, ClientOrderId, EpochMs } from '../domain/types/ids';
import type { OrderState } from '../domain/oms/reducer';

export const EXCHANGE_PORT = Symbol('EXCHANGE_PORT');

// §3.1 ExchangePort — the venue seam. Money crosses as canonical decimal STRINGS here
// (never native float, never Decimal — the adapter owns conversion to/from venue wire
// types). The OMS cannot distinguish a CcxtExchangeAdapter from the PaperExchangeAdapter:
// both implement this interface, both throw ccxt-shaped errors, both deliver async order
// events through the exec-report outbox (§6.5).

export interface VenueCapabilities {
  readonly clientOrderId: boolean; // accepts a caller-supplied client order id
  readonly fetchOrderByClientId: boolean; // fetchOrder lookup keyed by clientOrderId (§6.2)
  readonly wsUserStream: boolean; // pushes order/trade updates over a user-data stream
  readonly stp: boolean; // self-trade prevention available
  readonly sandbox: boolean; // a usable testnet/demo environment exists
}

// Money as strings at the seam (§3.1). type/side/tif mirror OrderIntent's domain unions.
export interface PlaceOrderRequest {
  readonly clientOrderId: ClientOrderId;
  readonly symbol: SymbolId;
  readonly side: 'BUY' | 'SELL';
  readonly type: 'LIMIT' | 'MARKET' | 'LIMIT_MAKER';
  readonly qty: string;
  readonly limitPrice?: string;
  readonly timeInForce: 'GTC' | 'IOC' | 'FOK';
  readonly reduceOnly: boolean;
}

// Synchronous venue acceptance (the REST ack). Fills/cancels arrive asynchronously as
// ExecReports through the outbox; a venue REJECT is thrown as a ccxt-shaped error, never
// returned here, so a resolved ack always means "accepted".
export interface ExchangeAck {
  readonly clientOrderId: ClientOrderId;
  readonly venueOrderId: string;
}

// Venue truth for the §6 query loops (fetchOrder / fetchOpenOrders). cumQty/price as strings.
export interface ExchangeOrderState {
  readonly clientOrderId: ClientOrderId;
  readonly venueOrderId: string;
  readonly symbol: SymbolId;
  readonly status: 'open' | 'closed' | 'canceled' | 'rejected' | 'expired';
  readonly cumQty: string;
  readonly qty: string;
}

// One realized trade as reported by the venue (fetchMyTrades / paper mint). Money as strings.
export interface VenueFill {
  readonly venue: VenueId;
  readonly symbol: SymbolId;
  readonly venueTradeId: string;
  readonly clientOrderId: ClientOrderId;
  readonly price: string;
  readonly qty: string;
  readonly fee: { readonly ccy: string; readonly amount: string } | null;
  readonly liquidity: 'maker' | 'taker';
  readonly venueTimestamp: EpochMs;
}

// §10c credential probe: auth + permission flags. withdrawalsEnabled MUST be false for a
// live key (the live gate refuses otherwise); canTrade gates order placement.
export interface CredentialCheck {
  readonly valid: boolean;
  readonly canTrade: boolean;
  readonly withdrawalsEnabled: boolean;
  readonly keyFingerprint: string;
}

// §6.3 adapter-owned error classification. Adapters (ccxt or paper) catch venue/transport
// failures and rethrow as a typed AdapterError so the OMS decides the reducer event from
// errorClass alone — never by inspecting a raw ccxt class. The full ccxt→class mapping is
// snapshot-tested in Phase 6; OUTCOME_AMBIGUOUS is the safe default for anything unmapped.
export type AdapterErrorClass =
  | 'TRANSPORT_RETRYABLE'
  | 'OUTCOME_AMBIGUOUS'
  | 'TERMINAL_REJECT'
  | 'AUTH_FATAL'
  | 'MAINTENANCE';

export class AdapterError extends Error {
  constructor(
    readonly errorClass: AdapterErrorClass,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

export interface ExchangePort {
  readonly venue: VenueId;
  readonly capabilities: VenueCapabilities;
  placeOrder(req: PlaceOrderRequest): Promise<ExchangeAck>;
  cancelOrder(clientOrderId: ClientOrderId, symbol: SymbolId): Promise<ExchangeAck>;
  fetchOrder(clientOrderId: ClientOrderId, symbol: SymbolId): Promise<ExchangeOrderState>;
  fetchOpenOrders(symbol?: SymbolId): Promise<readonly ExchangeOrderState[]>;
  fetchBalances(): Promise<ReadonlyMap<string, { free: string; locked: string }>>;
  fetchMyTrades(symbol: SymbolId, since: EpochMs): Promise<readonly VenueFill[]>;
  validateCredentials(): Promise<CredentialCheck>;
  // Backlog #51 (Phase-8 perp deploy checklist): pin venue-side isolated margin + the configured
  // leverage per symbol at boot, BEFORE the first order — account defaults are never trusted.
  // Optional: only perp-capable adapters expose it (spot/paper adapters lack the method and the
  // boot call no-ops via `?.`). Implementations are fail-closed — a pin failure throws and the
  // boot dies rather than trading on unknown venue-side leverage/margin mode.
  pinPerpVenueDefaults?(symbols: readonly SymbolId[], leverage: number): Promise<void>;
}

// Re-exported so adapters and the OMS share the reducer's state vocabulary at the seam.
export type { OrderState };
