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

// P5b: ccxt's unified FundingHistory row (fetchFundingHistory) — id/symbol/timestamp/amount only
// (ccxt/js/src/base/types.d.ts); no fundingRate/markPrice/position qty on the unified type.
export interface CcxtFundingHistoryEntry {
  id?: string | number;
  symbol?: string;
  timestamp?: number;
  amount?: string | number;
}

// Defect A (position-recon backstop): ccxt's unified fetchPositions row. `contracts` is the unified
// FLOAT field — never read (float ban); `info.positionAmt`/`info.entryPrice` are the raw venue
// strings the adapter surfaces instead. `info.symbol` is the raw market id ("BTCUSDT"), the same
// form RawAlgoOrder.symbol carries.
export interface CcxtPosition {
  symbol?: string;
  contracts?: string | number;
  info?: { symbol?: string; positionAmt?: string; entryPrice?: string };
}

// Push 3 P7a: the swap venue's ALGO/conditional-order rail (STOP_MARKET). ccxt has no unified
// support for it — these are raw fapi endpoint response shapes, narrowed defensively like every
// other CcxtOrder field above.
export interface RawAlgoOrder {
  algoId?: string | number;
  clientAlgoId?: string;
  symbol?: string;
  side?: string;
  orderType?: string;
  quantity?: string | number;
  triggerPrice?: string | number;
  algoStatus?: string;
  reduceOnly?: boolean;
  // Defect A: the regular-rail order the algo spawned. The demo venue's allAlgoOrders/algoOrder
  // rows carry it as `actualOrderId` (keyed probe 2026-07-17; CANCELED rows carry '' = absent);
  // `orderId` is the documented-prod-shape name kept as fallback. Absent on a still-resting row.
  actualOrderId?: string | number;
  orderId?: string | number;
  // Live demo-fapi rows deliver these as JSON strings; the normalizer coerces via Number.
  updateTime?: string | number;
  triggerTime?: string | number;
}

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

  // Backlog #51 (Phase-8 perp deploy checklist): pin venue-side isolated margin + leverage per
  // symbol. Optional — only meaningful on a swap-capable exchange; the adapter gates the call by
  // venue so a spot instance never receives it.
  pinPerpVenueDefaults?(symbols: readonly string[], leverage: number): Promise<void>;

  // Push 3 P7a (backlog: P7d lifecycle consumes these): raw fapi algo-rail round-trip. ccxt has no
  // unified createOrder-adjacent query/cancel for conditional/algo orders, so these call the
  // implicit endpoints directly (probe-verified 2026-07-13). Optional — swap-capable exchange only;
  // the adapter gates by venue so a spot instance never receives it.
  // Response shape differs by environment (#54, probe-verified 2026-07-16): demo-fapi answers with
  // a BARE ARRAY of rows (empty and non-empty alike); the documented production shape is
  // { total, orders }. The adapter accepts both — declaring only {orders} made the destructure
  // throw on every live demo call.
  fapiPrivateGetOpenAlgoOrders?(): Promise<{ orders: RawAlgoOrder[] } | RawAlgoOrder[]>;
  fapiPrivateDeleteAlgoOrder?(params: { algoId: string }): Promise<unknown>;

  // Defect A (algo-stop-recovery.service.ts): the historical-sweep and single-query counterparts to
  // fapiPrivateGetOpenAlgoOrders above — GET /fapi/v1/allAlgoOrders and GET /fapi/v1/algoOrder
  // (pinned ccxt 4.5.58, verified present; fapiPrivateGetAlgoHistoricalOrders does NOT exist).
  // Response-shape union mirrors the open-orders endpoint (#54): demo-fapi may answer a bare array
  // where prod answers { total, orders }; the single-query endpoint answers one bare row object.
  // Both optional — same swap-capable-only gating as every other fapiPrivate* method here.
  fapiPrivateGetAllAlgoOrders?(
    params: Record<string, unknown>,
  ): Promise<{ orders: RawAlgoOrder[] } | RawAlgoOrder[]>;
  fapiPrivateGetAlgoOrder?(params: Record<string, unknown>): Promise<RawAlgoOrder>;

  // Defect A (position-recon backstop): ccxt's unified position query. Optional — spot/paper
  // adapters have no perp position concept; the adapter gates by venue like every other
  // perp-only method here.
  fetchPositions?(
    symbols: string[] | undefined,
    params: Record<string, unknown>,
  ): Promise<CcxtPosition[]>;

  // P5b (funding-ingest.service.ts): ccxt's unified fetchFundingHistory — perp-only, same optional/
  // venue-gated posture as fetchPositions above.
  fetchFundingHistory?(
    symbol: string,
    since: number | undefined,
    limit: number | undefined,
    params: Record<string, unknown>,
  ): Promise<CcxtFundingHistoryEntry[]>;
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

  // Backlog #51: venue-side account-config pin, fail-closed. Binance answers an already-set margin
  // mode with error -4046 ("No need to change margin type") and an unchanged leverage either
  // succeeds or reports "not modified" — both are the DESIRED state, so they count as success.
  // -4067 ("Position side cannot be changed if there exists open orders") also surfaces from
  // setMarginMode when resting orders block a margin-type change: tolerate ONLY when the venue
  // already reports isolated for that symbol (verified via fetchPositions); otherwise throw —
  // trading on unknown/cross margin with open orders is still fail-closed.
  async pinPerpVenueDefaults(symbols: readonly string[], leverage: number): Promise<void> {
    if (!Number.isInteger(leverage) || leverage < 1) {
      throw new Error(
        `perp pin: leverage must be a positive integer, got ${leverage} (fail-closed)`,
      );
    }
    const ex = this.exchange as unknown as {
      setMarginMode(mode: string, symbol: string): Promise<unknown>;
      setLeverage(leverage: number, symbol: string): Promise<unknown>;
      fetchPositions?(
        symbols?: string[],
        params?: Record<string, unknown>,
      ): Promise<
        readonly { symbol?: string; marginMode?: string; info?: { marginType?: string } }[]
      >;
    };
    const alreadySet = (err: unknown): boolean => {
      const msg = err instanceof Error ? err.message : String(err);
      return msg.includes('-4046') || /no need to change|not modified/i.test(msg);
    };
    const openOrdersBlockMarginChange = (err: unknown): boolean => {
      const msg = err instanceof Error ? err.message : String(err);
      return msg.includes('-4067') || /cannot be changed if there exists open orders/i.test(msg);
    };
    const marginAlreadyIsolated = async (symbol: string): Promise<boolean> => {
      if (ex.fetchPositions === undefined) return false;
      try {
        const rows = await ex.fetchPositions([symbol]);
        for (const row of rows) {
          if (row.symbol !== undefined && row.symbol !== symbol) continue;
          const mode = (row.marginMode ?? row.info?.marginType ?? '').toLowerCase();
          if (mode === 'isolated') return true;
          if (mode === 'cross') return false;
        }
        return false;
      } catch {
        return false;
      }
    };
    for (const symbol of symbols) {
      try {
        await ex.setMarginMode('isolated', symbol);
      } catch (err) {
        if (alreadySet(err)) {
          // desired state
        } else if (openOrdersBlockMarginChange(err) && (await marginAlreadyIsolated(symbol))) {
          // Resting orders block the setMarginMode round-trip, but venue already isolated — pin
          // goal met; continue to leverage. (2026-07-24 HYPE crash-loop: -4067 with open stops.)
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `perp pin: setMarginMode(isolated, ${symbol}) failed: ${msg} (fail-closed)`,
          );
        }
      }
      try {
        await ex.setLeverage(leverage, symbol);
      } catch (err) {
        if (!alreadySet(err)) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `perp pin: setLeverage(${leverage}, ${symbol}) failed: ${msg} (fail-closed)`,
          );
        }
      }
    }
  }

  // Push 3 P7a: raw fapi algo-rail round-trip (probe-verified 2026-07-13; response-shape union
  // corrected 2026-07-16, see the interface comment). No unified ccxt method exists for either
  // call — same defensive `as unknown as {...}` narrowing as every other method above.
  fapiPrivateGetOpenAlgoOrders(): Promise<{ orders: RawAlgoOrder[] } | RawAlgoOrder[]> {
    return (
      this.exchange as unknown as {
        fapiPrivateGetOpenAlgoOrders(): Promise<{ orders: RawAlgoOrder[] } | RawAlgoOrder[]>;
      }
    ).fapiPrivateGetOpenAlgoOrders();
  }

  fapiPrivateDeleteAlgoOrder(params: { algoId: string }): Promise<unknown> {
    return (
      this.exchange as unknown as {
        fapiPrivateDeleteAlgoOrder(params: { algoId: string }): Promise<unknown>;
      }
    ).fapiPrivateDeleteAlgoOrder(params);
  }

  // Defect A: same `as unknown as {...}` narrowing as every other fapiPrivate* delegation above.
  fapiPrivateGetAllAlgoOrders(
    params: Record<string, unknown>,
  ): Promise<{ orders: RawAlgoOrder[] } | RawAlgoOrder[]> {
    return (
      this.exchange as unknown as {
        fapiPrivateGetAllAlgoOrders(
          params: Record<string, unknown>,
        ): Promise<{ orders: RawAlgoOrder[] } | RawAlgoOrder[]>;
      }
    ).fapiPrivateGetAllAlgoOrders(params);
  }

  fapiPrivateGetAlgoOrder(params: Record<string, unknown>): Promise<RawAlgoOrder> {
    return (
      this.exchange as unknown as {
        fapiPrivateGetAlgoOrder(params: Record<string, unknown>): Promise<RawAlgoOrder>;
      }
    ).fapiPrivateGetAlgoOrder(params);
  }

  fetchPositions(
    symbols: string[] | undefined,
    params: Record<string, unknown>,
  ): Promise<CcxtPosition[]> {
    return (
      this.exchange as unknown as {
        fetchPositions(
          symbols: string[] | undefined,
          params: Record<string, unknown>,
        ): Promise<CcxtPosition[]>;
      }
    ).fetchPositions(symbols, params);
  }

  fetchFundingHistory(
    symbol: string,
    since: number | undefined,
    limit: number | undefined,
    params: Record<string, unknown>,
  ): Promise<CcxtFundingHistoryEntry[]> {
    return (
      this.exchange as unknown as {
        fetchFundingHistory(
          symbol: string,
          since: number | undefined,
          limit: number | undefined,
          params: Record<string, unknown>,
        ): Promise<CcxtFundingHistoryEntry[]>;
      }
    ).fetchFundingHistory(symbol, since, limit, params);
  }
}
