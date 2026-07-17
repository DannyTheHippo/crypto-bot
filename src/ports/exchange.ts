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
  // STOP_LOSS_LIMIT/STOP_MARKET mirror OrderIntent's trigger-order variants (Push 3 P7a).
  readonly type: 'LIMIT' | 'MARKET' | 'LIMIT_MAKER' | 'STOP_LOSS_LIMIT' | 'STOP_MARKET';
  readonly qty: string;
  readonly limitPrice?: string;
  // Trigger/stop price for STOP_LOSS_LIMIT/STOP_MARKET; absent for every other type.
  readonly triggerPrice?: string;
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

// Push 3 P7a: the swap venue's ALGO/conditional-order rail (binanceusdm STOP_MARKET). It is NOT
// the regular order book (fetchOpenOrders/cancelOrder 404 against it — -2013/-2011) so it is
// surfaced through its own pair of primitives, gated the same way as pinPerpVenueDefaults: only a
// swap-capable adapter implements them, spot/paper adapters lack the methods. clientAlgoId is the
// OMS dedupe key on this rail (mirrors clientOrderId on the regular rail) — see the mapping-site
// comment in CcxtExchangeAdapter.placeOrder for the persistence contract this implies.
export interface AlgoOrderState {
  readonly algoId: string;
  readonly clientAlgoId?: string;
  readonly symbol: SymbolId;
  readonly side: 'BUY' | 'SELL';
  readonly type: string;
  readonly qty: string;
  readonly triggerPrice: string;
  readonly status: string;
  readonly reduceOnly: boolean;
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

// Defect A (2026-07-16): a venue-fired algo stop's history record, queried by clientAlgoId — the
// only lookup key that survives the ambiguity that started this (the spawned market order's
// clientOrderId is venue-generated and unmappable by decodeClientOrderId). status is deliberately
// coarser than the raw algoStatus vocabulary: NEW collapses to RESTING, TRIGGERED/FINISHED collapse
// to TRIGGERED (both mean "the order fired and the algo rail's job is done"), and anything the
// adapter does not recognize collapses to UNKNOWN rather than being trusted — recoverSymbol treats
// UNKNOWN/RESTING identically (retry next sweep, never a fold).
export interface AlgoOrderHistoryView {
  readonly algoId: string;
  readonly clientAlgoId?: string;
  readonly status: 'RESTING' | 'TRIGGERED' | 'CANCELED' | 'EXPIRED' | 'UNKNOWN';
  readonly spawnedOrderId?: string;
  readonly qty: string;
  readonly triggerPrice: string;
  readonly updateTimeMs?: EpochMs;
}

// Defect A: venue-truth position read, the fail-closed backstop a later dispatch wires into
// reconciliation's position axis (a phantom local position with no venue-side counterpart, or vice
// versa, is exactly what an unrecovered algo-stop fill produces). signedQty is the raw venue string
// (never the unified float `contracts`) — money never crosses this seam as a native number.
export interface VenuePosition {
  readonly symbol: SymbolId;
  readonly signedQty: string;
  readonly entryPrice?: string;
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
  // Push 3 P7a (backlog: P7d lifecycle consumes these): the swap algo rail's round-trip
  // primitives. Optional — only the swap-capable adapter implements them (spot/paper adapters
  // omit both; a caller must `?.`-guard exactly like pinPerpVenueDefaults above).
  fetchOpenAlgoOrders?(symbol?: SymbolId): Promise<readonly AlgoOrderState[]>;
  cancelAlgoOrder?(algoId: string, symbol: SymbolId): Promise<void>;
  // Defect A (algo-stop-recovery.service.ts, commit-1 of 2): a bounded history query for one
  // clientAlgoId, sinceMs-scoped to the intent's own createdAt (never an unbounded sweep). Optional,
  // same venue-gating posture as the algo pair above — spot/paper adapters omit it, callers `?.`-guard.
  // Measurement primitive: a throw/undefined answer is fail-OPEN for the caller (recoverSymbol retries
  // next sweep; it is never treated as proof the stop is safe).
  fetchAlgoOrderStatus?(
    clientAlgoId: string,
    symbol: SymbolId,
    sinceMs: EpochMs,
  ): Promise<AlgoOrderHistoryView | undefined>;
  // Defect A: venue position read (the position-recon fail-closed backstop a later dispatch wires
  // up). Optional — spot/paper adapters have no perp position concept and omit it.
  fetchPositions?(symbols?: readonly SymbolId[]): Promise<readonly VenuePosition[]>;
}

// Re-exported so adapters and the OMS share the reducer's state vocabulary at the seam.
export type { OrderState };
