import { Injectable, Inject } from '@nestjs/common';
import {
  type ExchangePort,
  type VenueCapabilities,
  type PlaceOrderRequest,
  type ExchangeAck,
  type ExchangeOrderState,
  type VenueFill,
  type CredentialCheck,
  type AlgoOrderState,
} from '../../../ports/exchange';
import {
  clientOrderId,
  symbolId,
  type ClientOrderId,
  type SymbolId,
  type VenueId,
  type EpochMs,
} from '../../../domain/types/ids';
import { toAdapterError } from './error-classifier';
import { CCXT_ORDER_CLIENT, type CcxtOrderClient } from './ccxt-order-client';
import {
  normalizeOrderState,
  normalizeTrade,
  normalizeBalances,
  normalizeAlgoOrder,
} from './ccxt-normalize';

// Shared with pinPerpVenueDefaults below: the only swap-capable venue this pass wires.
const PERP_VENUE_ID = 'binanceusdm';

@Injectable()
export class CcxtExchangeAdapter implements ExchangePort {
  readonly venue: VenueId;
  readonly capabilities: VenueCapabilities;

  constructor(
    @Inject(CCXT_ORDER_CLIENT) private readonly client: CcxtOrderClient,
    venue: VenueId,
    sandbox = false,
  ) {
    this.venue = venue;
    this.capabilities = {
      clientOrderId: true,
      fetchOrderByClientId: true,
      wsUserStream: true,
      stp: false,
      sandbox,
    };
  }

  async placeOrder(req: PlaceOrderRequest): Promise<ExchangeAck> {
    let ccxtType: string;
    const params: Record<string, unknown> = {
      clientOrderId: req.clientOrderId,
    };

    switch (req.type) {
      case 'LIMIT':
        ccxtType = 'limit';
        params['timeInForce'] = req.timeInForce;
        break;
      case 'MARKET':
        ccxtType = 'market';
        // timeInForce is not meaningful for market orders
        break;
      case 'LIMIT_MAKER':
        ccxtType = 'limit';
        // No timeInForce param: Binance rejects extras on LIMIT_MAKER (-1106 "Parameter
        // 'timeInForce' sent when not required") and pinned ccxt 4.5.58 forwards it verbatim
        // (timeInForceIsRequired unset for this type, only 'PO' is stripped). postOnly alone is
        // the idiomatic ccxt post-only expression; the intent still persists its GTC.
        params['postOnly'] = true;
        break;
      case 'STOP_LOSS_LIMIT':
        // Probe-verified (binance demo): a STOP_LOSS_LIMIT rests on the REGULAR spot order rail
        // (unified type still echoes 'limit'; raw info.type='STOP_LOSS_LIMIT') — fully
        // OMS-compatible via fetchOpenOrders/cancelOrder as-is. STOP_MARKET is a different,
        // non-fungible swap-only rail (see below); fail closed on a mismatched venue rather than
        // silently place the wrong kind of order.
        if (String(this.venue) === PERP_VENUE_ID) {
          throw new Error(
            `STOP_LOSS_LIMIT is spot-only; venue ${String(this.venue)} is the swap venue (fail-closed)`,
          );
        }
        ccxtType = 'limit';
        params['timeInForce'] = req.timeInForce;
        params['stopLossPrice'] = req.triggerPrice;
        break;
      case 'STOP_MARKET':
        // Probe-verified: on the swap venue a STOP_MARKET is an ALGO/conditional order (a
        // separate rail — response carries info.algoId/algoStatus, never appears in
        // fetchOpenOrders, and regular fetchOrder/cancelOrder 404 against it with -2013/-2011).
        // Spot has no equivalent rail; fail closed rather than place a plain market order the
        // caller never asked for.
        if (String(this.venue) !== PERP_VENUE_ID) {
          throw new Error(
            `STOP_MARKET is swap-only; venue ${String(this.venue)} is not the swap venue (fail-closed)`,
          );
        }
        ccxtType = 'market';
        params['stopPrice'] = req.triggerPrice;
        // OMS rule 5 note: the algo rail is NOT the regular order book (fetchOpenOrders/
        // cancelOrder don't see it), so its dedupe key is clientAlgoId, not clientOrderId.
        // clientAlgoId here is the SAME generated clientOrderId string — intent persistence
        // upstream (signal-sink/execution) already journaled that id before this call, so the
        // dedupe contract holds on this rail too, just under a different venue-side name.
        params['clientAlgoId'] = req.clientOrderId;
        break;
    }

    // Gated to the swap venue: on spot, reduceOnly is meaningless and some order paths
    // reject unknown params outright, so the flag never reaches a spot createOrder call.
    if (req.reduceOnly && String(this.venue) === PERP_VENUE_ID) {
      params['reduceOnly'] = true;
    }

    try {
      const order = await this.client.createOrder(
        req.symbol,
        ccxtType,
        req.side.toLowerCase(),
        req.qty,
        req.limitPrice,
        params,
      );
      return { clientOrderId: req.clientOrderId, venueOrderId: String(order.id) };
    } catch (e) {
      throw toAdapterError(e);
    }
  }

  async cancelOrder(coid: ClientOrderId, symbol: SymbolId): Promise<ExchangeAck> {
    try {
      const order = await this.client.cancelOrder(undefined, symbol, { clientOrderId: coid });
      return { clientOrderId: coid, venueOrderId: String(order.id) };
    } catch (e) {
      throw toAdapterError(e);
    }
  }

  async fetchOrder(coid: ClientOrderId, symbol: SymbolId): Promise<ExchangeOrderState> {
    try {
      const order = await this.client.fetchOrder(undefined, symbol, { clientOrderId: coid });
      return normalizeOrderState(order, coid, symbol);
    } catch (e) {
      throw toAdapterError(e);
    }
  }

  async fetchOpenOrders(symbol?: SymbolId): Promise<readonly ExchangeOrderState[]> {
    try {
      const orders = await this.client.fetchOpenOrders(symbol);
      return orders.map((o) => {
        // Each open-order row carries its own symbol; ExchangeOrderState.symbol is required.
        const orderSymbol = o.symbol !== undefined ? symbolId(o.symbol) : (symbol ?? symbolId(''));
        const coid = clientOrderId(o.clientOrderId ?? '');
        return normalizeOrderState(o, coid, orderSymbol);
      });
    } catch (e) {
      throw toAdapterError(e);
    }
  }

  async fetchBalances(): Promise<ReadonlyMap<string, { free: string; locked: string }>> {
    try {
      const balances = await this.client.fetchBalance();
      return normalizeBalances(balances);
    } catch (e) {
      throw toAdapterError(e);
    }
  }

  async fetchMyTrades(symbol: SymbolId, since: EpochMs): Promise<readonly VenueFill[]> {
    try {
      const trades = await this.client.fetchMyTrades(symbol, since, undefined, {});
      return trades.map((t) => normalizeTrade(t, this.venue, symbol));
    } catch (e) {
      throw toAdapterError(e);
    }
  }

  // Phase-7 increment-2 wires the real apiRestrictions probe.
  validateCredentials(): Promise<CredentialCheck> {
    return Promise.resolve({
      valid: true,
      canTrade: true,
      withdrawalsEnabled: false,
      keyFingerprint: 'ccxt',
    });
  }

  // Backlog #51 (Phase-8 perp deploy checklist): delegate the venue-side margin/leverage pin to
  // the client. Gated by venue — on a spot venue there is nothing to pin and the method is a
  // deliberate no-op (the boot call site invokes it unconditionally on every non-paper boot).
  // Client-side the implementation is fail-closed; see RealCcxtOrderClient.pinPerpVenueDefaults.
  async pinPerpVenueDefaults(symbols: readonly SymbolId[], leverage: number): Promise<void> {
    if (String(this.venue) !== PERP_VENUE_ID) return;
    if (this.client.pinPerpVenueDefaults === undefined) {
      throw new Error(
        'perp pin: the perp venue client does not implement pinPerpVenueDefaults (fail-closed)',
      );
    }
    await this.client.pinPerpVenueDefaults(
      symbols.map((s) => String(s)),
      leverage,
    );
  }

  // Push 3 P7a (backlog: P7d lifecycle consumes these). Venue-gated like pinPerpVenueDefaults
  // above, but the spot answer differs: a query for a rail that never exists on spot is
  // vacuously an empty list, not an error — mirrors fetchOpenOrders(symbol) returning [] rather
  // than throwing when there is simply nothing open.
  async fetchOpenAlgoOrders(symbol?: SymbolId): Promise<readonly AlgoOrderState[]> {
    if (String(this.venue) !== PERP_VENUE_ID) return [];
    if (this.client.fapiPrivateGetOpenAlgoOrders === undefined) {
      throw new Error(
        'algo rail: the perp venue client does not implement fapiPrivateGetOpenAlgoOrders (fail-closed)',
      );
    }
    try {
      const { orders } = await this.client.fapiPrivateGetOpenAlgoOrders();
      return orders
        .filter((o) => symbol === undefined || o.symbol === String(symbol))
        .map((o) => normalizeAlgoOrder(o, symbol ?? symbolId('')));
    } catch (e) {
      throw toAdapterError(e);
    }
  }

  // Unlike the query above, an explicit cancel-by-id against a rail that cannot exist on this
  // venue is a caller bug, not a benign empty answer — fail closed rather than silently no-op,
  // the same posture as the STOP_MARKET venue-mismatch throw in placeOrder.
  async cancelAlgoOrder(algoId: string, symbol: SymbolId): Promise<void> {
    if (String(this.venue) !== PERP_VENUE_ID) {
      throw new Error(
        `cancelAlgoOrder is swap-only; venue ${String(this.venue)} is not the swap venue (fail-closed)`,
      );
    }
    if (this.client.fapiPrivateDeleteAlgoOrder === undefined) {
      throw new Error(
        'algo rail: the perp venue client does not implement fapiPrivateDeleteAlgoOrder (fail-closed)',
      );
    }
    // symbol is accepted for ExchangePort symmetry with cancelOrder(coid, symbol); the raw
    // Binance algo-cancel endpoint keys on algoId alone (probe-verified), so it is not forwarded.
    void symbol;
    try {
      await this.client.fapiPrivateDeleteAlgoOrder({ algoId });
    } catch (e) {
      throw toAdapterError(e);
    }
  }
}
