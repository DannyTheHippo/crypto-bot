import { Injectable, Inject } from '@nestjs/common';
import {
  type ExchangePort,
  type VenueCapabilities,
  type PlaceOrderRequest,
  type ExchangeAck,
  type ExchangeOrderState,
  type VenueFill,
  type CredentialCheck,
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
import { normalizeOrderState, normalizeTrade, normalizeBalances } from './ccxt-normalize';

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
}
