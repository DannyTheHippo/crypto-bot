import type { Exchange } from 'ccxt';

export const CCXT_ORDER_CLIENT = Symbol('CCXT_ORDER_CLIENT');

// Structural types narrowing only the ccxt order-API surface the adapter reads.
// Money fields arrive as strings when the exchange is constructed with number: String;
// we type them string | number | undefined and stringify defensively in normalize.

export interface CcxtOrder {
  id?: string | number;
  clientOrderId?: string;
  status?: string;
  filled?: string | number;
  amount?: string | number;
  symbol?: string;
}

export interface CcxtTrade {
  id?: string | number;
  order?: string;
  timestamp?: number;
  price?: string | number;
  amount?: string | number;
  cost?: string | number;
  side?: string;
  takerOrMaker?: string;
  fee?: { cost?: string | number; currency?: string } | null;
}

export type CcxtBalances = Record<string, unknown>;

export interface CcxtOrderClient {
  createOrder(
    symbol: string,
    type: string,
    side: string,
    amount: string,
    price: string | undefined,
    params: Record<string, unknown>,
  ): Promise<CcxtOrder>;

  cancelOrder(
    id: string | undefined,
    symbol: string,
    params: Record<string, unknown>,
  ): Promise<CcxtOrder>;

  fetchOrder(
    id: string | undefined,
    symbol: string,
    params: Record<string, unknown>,
  ): Promise<CcxtOrder>;

  fetchOpenOrders(symbol: string | undefined): Promise<CcxtOrder[]>;

  fetchBalance(): Promise<CcxtBalances>;

  fetchMyTrades(
    symbol: string,
    since: number | undefined,
    limit: number | undefined,
    params: Record<string, unknown>,
  ): Promise<CcxtTrade[]>;

  // Binance implicit endpoint GET /sapi/v1/account/apiRestrictions (§10c key-restriction probe).
  // Absent on Spot Testnet (throws NotSupported) — the KeyProbe degrades by environment.
  sapiGetAccountApiRestrictions(): Promise<Record<string, unknown>>;
}

// Delegates each method to the live ccxt Exchange using the same as unknown as {...}
// narrowing pattern as RealWatchSource. Constructed at the composition root in a later increment.
export class RealCcxtOrderClient implements CcxtOrderClient {
  constructor(private readonly exchange: Exchange) {}

  createOrder(
    symbol: string,
    type: string,
    side: string,
    amount: string,
    price: string | undefined,
    params: Record<string, unknown>,
  ): Promise<CcxtOrder> {
    return (
      this.exchange as unknown as {
        createOrder(
          s: string,
          t: string,
          side: string,
          amount: string,
          price: string | undefined,
          params: Record<string, unknown>,
        ): Promise<CcxtOrder>;
      }
    ).createOrder(symbol, type, side, amount, price, params);
  }

  cancelOrder(
    id: string | undefined,
    symbol: string,
    params: Record<string, unknown>,
  ): Promise<CcxtOrder> {
    return (
      this.exchange as unknown as {
        cancelOrder(
          id: string | undefined,
          symbol: string,
          params: Record<string, unknown>,
        ): Promise<CcxtOrder>;
      }
    ).cancelOrder(id, symbol, params);
  }

  fetchOrder(
    id: string | undefined,
    symbol: string,
    params: Record<string, unknown>,
  ): Promise<CcxtOrder> {
    return (
      this.exchange as unknown as {
        fetchOrder(
          id: string | undefined,
          symbol: string,
          params: Record<string, unknown>,
        ): Promise<CcxtOrder>;
      }
    ).fetchOrder(id, symbol, params);
  }

  fetchOpenOrders(symbol: string | undefined): Promise<CcxtOrder[]> {
    return (
      this.exchange as unknown as {
        fetchOpenOrders(symbol: string | undefined): Promise<CcxtOrder[]>;
      }
    ).fetchOpenOrders(symbol);
  }

  fetchBalance(): Promise<CcxtBalances> {
    return (
      this.exchange as unknown as {
        fetchBalance(): Promise<CcxtBalances>;
      }
    ).fetchBalance();
  }

  fetchMyTrades(
    symbol: string,
    since: number | undefined,
    limit: number | undefined,
    params: Record<string, unknown>,
  ): Promise<CcxtTrade[]> {
    return (
      this.exchange as unknown as {
        fetchMyTrades(
          symbol: string,
          since: number | undefined,
          limit: number | undefined,
          params: Record<string, unknown>,
        ): Promise<CcxtTrade[]>;
      }
    ).fetchMyTrades(symbol, since, limit, params);
  }

  sapiGetAccountApiRestrictions(): Promise<Record<string, unknown>> {
    return (
      this.exchange as unknown as {
        sapiGetAccountApiRestrictions(): Promise<Record<string, unknown>>;
      }
    ).sapiGetAccountApiRestrictions();
  }
}
