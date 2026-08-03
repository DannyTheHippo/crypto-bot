import { Injectable, Inject } from '@nestjs/common';
import {
  AdapterError,
  type ExchangePort,
  type VenueCapabilities,
  type PlaceOrderRequest,
  type ExchangeAck,
  type ExchangeOrderState,
  type VenueFill,
  type CredentialCheck,
  type AlgoOrderState,
  type AlgoOrderHistoryView,
  type VenuePosition,
  type VenueFundingPayment,
} from '../../../ports/venue/exchange';
import {
  clientOrderId,
  symbolId,
  type ClientOrderId,
  type SymbolId,
  type VenueId,
  type EpochMs,
} from '../../../domain/common/types/ids';
import { splitSymbol } from '../../../domain/venue/types/symbol';
import { toAdapterError } from './error-classifier';
import { CCXT_ORDER_CLIENT, type CcxtOrderClient } from './ccxt-order-client';
import {
  normalizeOrderState,
  normalizeTrade,
  normalizeBalances,
  normalizeAlgoOrder,
  normalizeAlgoHistory,
  normalizeFundingPayment,
} from './ccxt-normalize';

// Shared with pinPerpVenueDefaults below: the only swap-capable venue this pass wires.
const PERP_VENUE_ID = 'binanceusdm';

// Binance's raw market id for a linear swap: base+quote with the :SETTLE suffix dropped
// ("BTC/USDT:USDT" → "BTCUSDT"). The raw algo-order rows carry THIS form in their `symbol`
// field, never the unified symbol (#54, probe-verified 2026-07-16) — a filter comparing only
// the unified form silently dropped every row.
function rawMarketId(symbol: SymbolId): string {
  const { base, quote } = splitSymbol(symbol);
  return `${base}${quote}`;
}

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
        // TERMINAL_REJECT, not a bare Error: this throw is PRE-NETWORK (createOrder is only called
        // below), so nothing can exist venue-side. ExecutionGate classifies any non-AdapterError as
        // OUTCOME_AMBIGUOUS → SUBMIT_UNKNOWN, which would reserve exposure and arm the rule-5 60s
        // kill switch over an order that was provably never sent.
        if (String(this.venue) === PERP_VENUE_ID) {
          throw new AdapterError(
            'TERMINAL_REJECT',
            'VENUE_RAIL_MISMATCH',
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
        // TERMINAL_REJECT for the same pre-network reason as the STOP_LOSS_LIMIT mismatch above.
        if (String(this.venue) !== PERP_VENUE_ID) {
          throw new AdapterError(
            'TERMINAL_REJECT',
            'VENUE_RAIL_MISMATCH',
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
      // An ack without an id is the one case that is neither a success nor a reject: createOrder
      // RESOLVED, so the order may well be resting venue-side, but there is no identity to ack it
      // with. String(undefined) would write the literal "undefined" as the venueOrderId (poisoning
      // reconciliation's venueOrderIndex), and a TERMINAL_REJECT would abandon a possibly-live
      // order. OUTCOME_AMBIGUOUS hands it to the query-by-clientOrderId loop, the only thing that
      // can resolve it (rule 5: never blind-resubmit, query first). toAdapterError below passes an
      // AdapterError through unchanged, so this classification survives the catch.
      if (order.id === undefined || order.id === '') {
        throw new AdapterError(
          'OUTCOME_AMBIGUOUS',
          'ACK_MISSING_VENUE_ORDER_ID',
          `createOrder resolved without a venue order id for clientOrderId ${req.clientOrderId}`,
        );
      }
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

  // §10c credential probe over the SAME endpoint KeyProbeService uses. This is NOT live gate (c):
  // that gate runs through KEY_PROBE → KeyProbeService.probeAll() → ModeControlService.keysValid(),
  // and this method has no production caller (the routing facade in
  // composition/exchange-adapters.module.ts says so at its own delegation). It answers venue truth
  // anyway, because the previous hardcoded {valid:true, canTrade:true, withdrawalsEnabled:false}
  // asserted "withdrawals are proven disabled" to any future caller without ever asking the venue.
  //
  // Failure direction — permission gate, so it fails CLOSED off-sandbox: an unprobeable restriction
  // set answers withdrawalsEnabled:true, because "we could not verify withdrawals are disabled"
  // must never read as "withdrawals are disabled". On a sandbox the env/url wall carries the safety
  // (no real funds) and Spot Testnet exposes no sapi at all, so it degrades to the testnet posture
  // exactly like KeyProbeService.fetchRestrictions does.
  async validateCredentials(): Promise<CredentialCheck> {
    try {
      const r = await this.client.sapiGetAccountApiRestrictions();
      const withdrawalsEnabled = r['enableWithdrawals'] === true;
      // apiRestrictions is ACCOUNT-wide; the surface flag that matters is this adapter's own venue.
      const surfaceEnabled =
        String(this.venue) === PERP_VENUE_ID
          ? r['enableFutures'] === true
          : r['enableSpotAndMarginTrading'] === true;
      // Cross-margin borrow is forbidden on BOTH surfaces (§7.1), so it invalidates the key here
      // too — mirroring KeyProbeService.recompute rather than inventing a looser rule.
      const marginEnabled = r['enableMargin'] === true;
      return {
        valid: surfaceEnabled && !withdrawalsEnabled && !marginEnabled,
        canTrade: surfaceEnabled,
        withdrawalsEnabled,
        keyFingerprint: 'ccxt',
      };
    } catch {
      if (this.capabilities.sandbox) {
        return { valid: true, canTrade: true, withdrawalsEnabled: false, keyFingerprint: 'ccxt' };
      }
      return { valid: false, canTrade: false, withdrawalsEnabled: true, keyFingerprint: 'ccxt' };
    }
  }

  // Backlog #51 (Phase-8 perp deploy checklist): delegate the venue-side margin/leverage pin to
  // the client. Gated by venue — on a spot venue there is nothing to pin and the method is a
  // deliberate no-op (the boot call site invokes it unconditionally on every non-paper boot).
  // Client-side the implementation is fail-closed; see RealCcxtOrderClient.pinPerpVenueDefaults.
  // Unlike placeOrder's rail-mismatch pair (typed TERMINAL_REJECT AdapterErrors), this throw and
  // the missing-client-method throws in fetchOpenAlgoOrders/cancelAlgoOrder/fetchAlgoOrderStatus/
  // fetchPositions stay BARE Errors on purpose: none is on the order-submission path, so no OMS
  // classification is derived from them — they are boot-time/query-path wiring faults whose callers
  // already defer correctly (boot engages the kill switch; recoverSymbol retries next sweep).
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
      // #54 (probe-verified 2026-07-16): demo-fapi answers with a BARE ARRAY (empty and non-empty
      // alike); the documented production shape is { total, orders }. The {orders}-only destructure
      // threw TypeError on every live demo call — FLAG 1's root cause.
      const raw = await this.client.fapiPrivateGetOpenAlgoOrders();
      const rows = Array.isArray(raw) ? raw : (raw?.orders ?? []);
      // Raw rows carry the VENUE market id ("BTCUSDT"), never the unified symbol (same probe) —
      // match either form, and stamp the unified symbol on the row handed to normalizeAlgoOrder so
      // AlgoOrderState.symbol keeps its unified-SymbolId contract.
      const rawId = symbol === undefined ? undefined : rawMarketId(symbol);
      return rows
        .filter((o) => symbol === undefined || o.symbol === String(symbol) || o.symbol === rawId)
        .map((o) =>
          normalizeAlgoOrder(
            symbol === undefined ? o : { ...o, symbol: String(symbol) },
            symbol ?? symbolId(''),
          ),
        );
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

  // Defect A (algo-stop-recovery.service.ts): a bounded history query for one clientAlgoId. Venue-
  // gated identically to fetchOpenAlgoOrders/cancelAlgoOrder above. This is a MEASUREMENT primitive
  // for the caller — recoverSymbol treats a throw the same as an undefined answer (fail OPEN: retry
  // next sweep, never proof the stop is safe); the adapter itself still throws fail-closed when the
  // perp client is missing the implicit method, matching every other perp-only primitive's posture.
  async fetchAlgoOrderStatus(
    clientAlgoId: string,
    symbol: SymbolId,
    sinceMs: EpochMs,
  ): Promise<AlgoOrderHistoryView | undefined> {
    if (String(this.venue) !== PERP_VENUE_ID) return undefined;
    if (this.client.fapiPrivateGetAllAlgoOrders === undefined) {
      throw new Error(
        'algo rail: the perp venue client does not implement fapiPrivateGetAllAlgoOrders (fail-closed)',
      );
    }
    try {
      const raw = await this.client.fapiPrivateGetAllAlgoOrders({
        symbol: rawMarketId(symbol),
        startTime: sinceMs,
        limit: 100,
      });
      const rows = Array.isArray(raw) ? raw : (raw?.orders ?? []);
      // Match by clientAlgoId ONLY (never orderId, never a decoded venue id) — clientAlgoId is the
      // same clientOrderId string the intent minted at placement, the one stable key this rail and
      // our OMS both index on.
      const row = rows.find((o) => o.clientAlgoId === clientAlgoId);
      if (row === undefined) return undefined;
      let view = normalizeAlgoHistory(row);
      // Best-effort refinement: the sweep endpoint's algoStatus can lag the terminal transition by
      // one poll on some rows; the single-query endpoint is the more current source when available.
      // A refinement failure is silently ignored — the sweep-derived view (already fail-OPEN on
      // RESTING/UNKNOWN) stands.
      if (
        view !== undefined &&
        (view.status === 'RESTING' || view.status === 'UNKNOWN') &&
        this.client.fapiPrivateGetAlgoOrder !== undefined
      ) {
        try {
          const refined = normalizeAlgoHistory(
            await this.client.fapiPrivateGetAlgoOrder({ algoId: row.algoId }),
          );
          if (refined !== undefined) view = refined;
        } catch {
          // best-effort only; fall through with the sweep-derived view
        }
      }
      return view;
    } catch (e) {
      throw toAdapterError(e);
    }
  }

  // Defect A: the position-recon fail-closed backstop (wired into reconciliation by a later
  // dispatch). Venue-gated like every other perp-only primitive above.
  async fetchPositions(symbols?: readonly SymbolId[]): Promise<readonly VenuePosition[]> {
    if (String(this.venue) !== PERP_VENUE_ID) return [];
    if (this.client.fetchPositions === undefined) {
      throw new Error(
        'position read: the perp venue client does not implement fetchPositions (fail-closed)',
      );
    }
    try {
      const raw = await this.client.fetchPositions(
        symbols === undefined ? undefined : symbols.map((s) => String(s)),
        {},
      );
      // Raw rows carry the VENUE market id in info.symbol ("BTCUSDT", same convention as the algo
      // rail) — resolve it back to the unified SymbolId the caller requested with, mirroring
      // fetchOpenAlgoOrders' own rawMarketId matching; ccxt's own unified `symbol` is the fallback
      // for a row the caller didn't request by unified id (e.g. a full sweep with symbols omitted).
      const byRawId = new Map<string, SymbolId>((symbols ?? []).map((s) => [rawMarketId(s), s]));
      // #54's own lesson: never filter rows here — a flat (positionAmt "0") row is still a fact the
      // caller compares against local state; only the caller's own comparison decides significance.
      return raw.map((p) => {
        const rawId = p.info?.symbol;
        const resolved =
          (rawId !== undefined ? byRawId.get(rawId) : undefined) ??
          (p.symbol !== undefined ? symbolId(p.symbol) : symbolId(rawId ?? ''));
        return {
          symbol: resolved,
          signedQty: p.info?.positionAmt ?? '0',
          entryPrice: p.info?.entryPrice,
        };
      });
    } catch (e) {
      throw toAdapterError(e);
    }
  }

  // P5b (funding-ingest.service.ts): perp funding-payment settlement history. Unlike
  // fetchPositions above (a fail-closed safety backstop), this backs a measurement/promotion gate
  // — fails OPEN: a non-perp venue or a client double that omits fetchFundingHistory answers []
  // rather than throwing, so the ingest poller degrades to "no data this poll" instead of taking
  // down the caller.
  async fetchFundingPayments(
    symbol: SymbolId,
    sinceMs: EpochMs,
  ): Promise<readonly VenueFundingPayment[]> {
    if (String(this.venue) !== PERP_VENUE_ID) return [];
    if (this.client.fetchFundingHistory === undefined) return [];
    try {
      const raw = await this.client.fetchFundingHistory(String(symbol), sinceMs, undefined, {});
      return raw.map((e) => normalizeFundingPayment(e, this.venue, symbol));
    } catch (e) {
      throw toAdapterError(e);
    }
  }
}
