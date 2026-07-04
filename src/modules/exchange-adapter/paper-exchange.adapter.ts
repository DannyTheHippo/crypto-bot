import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { CLOCK, type ClockPort } from '../../ports/clock';
import {
  AdapterError,
  type ExchangePort,
  type VenueCapabilities,
  type PlaceOrderRequest,
  type ExchangeAck,
  type ExchangeOrderState,
  type VenueFill,
  type CredentialCheck,
} from '../../ports/exchange';
import {
  EXEC_OUTBOX,
  EXEC_REPORT_NOTIFY,
  type ExecOutboxPort,
  type ExecReportNotify,
} from '../../ports/execution';
import {
  bookWalk,
  tradeThroughFill,
  type SimFill,
  type FeeCcy,
  type InsufficientDepthPolicy,
} from '../../domain/paper/fill';
import { mulberry32 } from '../../domain/rng/prng';
import { splitSymbol } from '../../domain/types/symbol';
import { price, qty } from '../../domain/types/money';
import {
  epochMs,
  type ClientOrderId,
  type SymbolId,
  type VenueId,
  type EpochMs,
} from '../../domain/types/ids';
import type { OrderLevel } from '../../domain/types/market-events';
import type { ExecReport, FillReport } from '../../domain/types/exec-report';

export const PAPER_CONFIG = Symbol('PAPER_CONFIG');

// Phase-5 paper fee currency is the fill's base or quote; the third-asset (BNB) path is unit-
// covered in applyFillToPortfolio and wired through paper in a later phase (needs a fee-asset
// price model). 'quote' | 'base' exercises both cash/position fee regimes end-to-end.
export interface PaperConfig {
  readonly seed: number;
  readonly takerBuffer: string; // extra quote fraction locked on buys to cover walk slippage
  readonly fees: {
    readonly makerBps: string;
    readonly takerBps: string;
    readonly feeCurrency: FeeCcy;
  };
  readonly latency: { readonly submitMs: [number, number]; readonly eventMs: [number, number] };
  readonly insufficientDepthPolicy: InsufficientDepthPolicy;
  readonly reorderDelivery?: boolean;
  readonly startingBalances: Readonly<Record<string, string>>;
}

interface Balance {
  free: Decimal;
  locked: Decimal;
}
interface Resting {
  readonly clientOrderId: ClientOrderId;
  readonly venueOrderId: string;
  readonly symbol: SymbolId;
  readonly side: 'BUY' | 'SELL';
  readonly limitPrice: Decimal;
  remaining: Decimal;
  readonly lockAsset: string;
  lockRemaining: Decimal;
}
interface OrderSnap {
  venueOrderId: string;
  status: ExchangeOrderState['status'];
  cumQty: Decimal;
  qty: Decimal;
}

// PaperExchangeAdapter (§6.5): same ExchangePort as a venue, ccxt-shaped AdapterError rejects,
// fills delivered through the same EXEC_OUTBOX — the OMS cannot tell it apart. Determinism:
// injected ClockPort (virtual time), seeded mulberry32, and a monotonic seq so same-timestamp
// events have a total order independent of microtask scheduling (the "byte-identical" guarantee).
@Injectable()
export class PaperExchangeAdapter implements ExchangePort {
  readonly venue: VenueId;
  readonly capabilities: VenueCapabilities = {
    clientOrderId: true,
    fetchOrderByClientId: true,
    wsUserStream: true,
    stp: false,
    sandbox: true,
  };

  private readonly balances = new Map<string, Balance>();
  private readonly resting = new Map<string, Resting>();
  private readonly books = new Map<
    string,
    { bids: readonly OrderLevel[]; asks: readonly OrderLevel[] }
  >();
  private readonly snaps = new Map<string, OrderSnap>();
  private readonly trades: VenueFill[] = [];
  private readonly rng: () => number;
  private readonly takerBps: Decimal;
  private readonly makerBps: Decimal;
  private readonly takerBuffer: Decimal;
  private seq = 0;

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(EXEC_OUTBOX) private readonly outbox: ExecOutboxPort,
    @Inject(EXEC_REPORT_NOTIFY) private readonly notify: ExecReportNotify,
    @Inject(PAPER_CONFIG) private readonly cfg: PaperConfig,
    venue: VenueId,
  ) {
    this.venue = venue;
    this.rng = mulberry32(cfg.seed);
    this.takerBps = new Decimal(cfg.fees.takerBps);
    this.makerBps = new Decimal(cfg.fees.makerBps);
    this.takerBuffer = new Decimal(cfg.takerBuffer);
    for (const [asset, amount] of Object.entries(cfg.startingBalances)) {
      this.balances.set(asset, { free: new Decimal(amount), locked: new Decimal(0) });
    }
  }

  // ── Market-data feed (paper-only; wired from MarketData or a recorded fixture) ────────────
  ingestBook(symbol: SymbolId, bids: readonly OrderLevel[], asks: readonly OrderLevel[]): void {
    this.books.set(symbol, { bids, asks });
  }

  async ingestTrade(symbol: SymbolId, print: { price: Decimal; qty: Decimal }): Promise<void> {
    for (const order of [...this.resting.values()]) {
      if (order.symbol !== symbol) continue;
      const sim = tradeThroughFill(
        order.side,
        price(order.limitPrice),
        order.remaining,
        { price: price(print.price), qty: qty(print.qty) },
        this.makerBps,
        this.cfg.fees.feeCurrency,
      );
      if (sim) await this.fill(order, sim);
    }
  }

  // ── ExchangePort ──────────────────────────────────────────────────────────────────────────
  async placeOrder(req: PlaceOrderRequest): Promise<ExchangeAck> {
    const { base, quote } = splitSymbol(req.symbol);
    const orderQty = new Decimal(req.qty);
    const venueOrderId = `paper-ord-${this.next()}`;

    const { lockAsset, lockAmount } = this.computeLock(req, base, quote);
    const bal = this.bal(lockAsset);
    if (bal.free.lt(lockAmount)) {
      throw new AdapterError(
        'TERMINAL_REJECT',
        'INSUFFICIENT_FUNDS',
        `paper: insufficient ${lockAsset}`,
      );
    }
    bal.free = bal.free.sub(lockAmount);
    bal.locked = bal.locked.add(lockAmount);
    this.snaps.set(req.clientOrderId, {
      venueOrderId,
      status: 'open',
      cumQty: new Decimal(0),
      qty: orderQty,
    });

    const order: Resting = {
      clientOrderId: req.clientOrderId,
      venueOrderId,
      symbol: req.symbol,
      side: req.side,
      limitPrice: req.limitPrice !== undefined ? new Decimal(req.limitPrice) : new Decimal(0),
      remaining: orderQty,
      lockAsset,
      lockRemaining: lockAmount,
    };

    if (req.type === 'MARKET') {
      await this.fillMarket(order, undefined);
    } else if (
      req.limitPrice !== undefined &&
      this.isMarketable(req.side, req.symbol, new Decimal(req.limitPrice))
    ) {
      await this.fillMarket(order, new Decimal(req.limitPrice)); // marketable-on-arrival: cross capped at limit
      if (order.remaining.gt(0)) this.resting.set(req.clientOrderId, order); // remainder rests
    } else {
      this.resting.set(req.clientOrderId, order); // passive limit: waits for trade-through
    }
    return { clientOrderId: req.clientOrderId, venueOrderId };
  }

  async cancelOrder(clientOrderId: ClientOrderId): Promise<ExchangeAck> {
    const order = this.resting.get(clientOrderId);
    const snap = this.snaps.get(clientOrderId);
    if (order === undefined || snap === undefined) {
      throw new AdapterError(
        'TERMINAL_REJECT',
        'ORDER_NOT_FOUND',
        `paper: ${clientOrderId} not open`,
      );
    }
    this.release(order);
    this.resting.delete(clientOrderId);
    this.snaps.set(clientOrderId, { ...snap, status: 'canceled' });
    await this.emit({
      kind: 'CANCEL_ACK',
      reportId: `paper-rpt-${this.next()}`,
      clientOrderId,
      venue: this.venue,
      symbol: order.symbol,
      eventTime: this.eventTime(),
      ingestTime: this.clock.now(),
    });
    return { clientOrderId, venueOrderId: order.venueOrderId };
  }

  fetchOrder(clientOrderId: ClientOrderId, symbol: SymbolId): Promise<ExchangeOrderState> {
    const snap = this.snaps.get(clientOrderId);
    if (snap === undefined)
      return Promise.reject(new AdapterError('TERMINAL_REJECT', 'ORDER_NOT_FOUND', 'paper'));
    return Promise.resolve({
      clientOrderId,
      venueOrderId: snap.venueOrderId,
      symbol,
      status: snap.status,
      cumQty: snap.cumQty.toFixed(),
      qty: snap.qty.toFixed(),
    });
  }

  fetchOpenOrders(symbol?: SymbolId): Promise<readonly ExchangeOrderState[]> {
    const open = [...this.resting.values()]
      .filter((o) => symbol === undefined || o.symbol === symbol)
      .map((o): ExchangeOrderState => {
        const snap = this.snaps.get(o.clientOrderId)!;
        return {
          clientOrderId: o.clientOrderId,
          venueOrderId: o.venueOrderId,
          symbol: o.symbol,
          status: 'open',
          cumQty: snap.cumQty.toFixed(),
          qty: snap.qty.toFixed(),
        };
      });
    return Promise.resolve(open);
  }

  fetchBalances(): Promise<ReadonlyMap<string, { free: string; locked: string }>> {
    const out = new Map<string, { free: string; locked: string }>();
    for (const [asset, b] of this.balances)
      out.set(asset, { free: b.free.toFixed(), locked: b.locked.toFixed() });
    return Promise.resolve(out);
  }

  fetchMyTrades(symbol: SymbolId, since: EpochMs): Promise<readonly VenueFill[]> {
    return Promise.resolve(
      this.trades.filter((t) => t.symbol === symbol && t.venueTimestamp >= since),
    );
  }

  validateCredentials(): Promise<CredentialCheck> {
    return Promise.resolve({
      valid: true,
      canTrade: true,
      withdrawalsEnabled: false,
      keyFingerprint: 'paper',
    });
  }

  // ── Fill mechanics ──────────────────────────────────────────────────────────────────────
  private async fillMarket(order: Resting, limitCap: Decimal | undefined): Promise<void> {
    const book = this.books.get(order.symbol);
    if (book === undefined) {
      this.release(order); // do not strand the placement lock on a no-book reject
      throw new AdapterError('TERMINAL_REJECT', 'NO_BOOK', `paper: no book for ${order.symbol}`);
    }
    let levels = order.side === 'BUY' ? book.asks : book.bids;
    if (limitCap !== undefined) {
      levels = levels.filter((l) =>
        order.side === 'BUY' ? l.price.lte(limitCap) : l.price.gte(limitCap),
      );
    }
    const sims = bookWalk(
      order.remaining,
      levels,
      this.takerBps,
      this.cfg.fees.feeCurrency,
      this.cfg.insufficientDepthPolicy,
    );
    for (const sim of sims) await this.fill(order, sim);
  }

  private async fill(order: Resting, sim: SimFill): Promise<void> {
    order.remaining = order.remaining.sub(sim.qty);
    this.settle(order, sim);
    const snap = this.snaps.get(order.clientOrderId)!;
    const cumQty = snap.cumQty.add(sim.qty);
    const filled = order.remaining.lte(0);
    this.snaps.set(order.clientOrderId, { ...snap, cumQty, status: filled ? 'closed' : 'open' });

    // Translate the model's 'quote'|'base' fee currency to the actual asset so every downstream
    // ledger (FillRecord → applyFillToPortfolio, balance reconciliation) keys on a real asset.
    const { base, quote } = splitSymbol(order.symbol);
    const feeAsset = sim.fee.ccy === 'base' ? base : quote;
    const venueTradeId = `paper-trade-${this.next()}`;
    const venueTimestamp = this.eventTime();
    this.trades.push({
      venue: this.venue,
      symbol: order.symbol,
      venueTradeId,
      clientOrderId: order.clientOrderId,
      price: sim.price.toFixed(),
      qty: sim.qty.toFixed(),
      fee: { ccy: feeAsset, amount: sim.fee.amount.toFixed() },
      liquidity: sim.liquidity,
      venueTimestamp,
    });

    if (filled) {
      this.release(order); // release any over-lock remainder
      this.resting.delete(order.clientOrderId);
    }

    const report: FillReport = {
      kind: 'FILL',
      reportId: `paper-rpt-${this.next()}`,
      clientOrderId: order.clientOrderId,
      venue: this.venue,
      symbol: order.symbol,
      eventTime: this.eventTime(),
      ingestTime: this.clock.now(),
      venueTradeId,
      price: sim.price,
      qty: sim.qty,
      fee: { ccy: feeAsset, amount: sim.fee.amount },
      liquidity: sim.liquidity,
      venueTimestamp,
    };
    await this.emit(report);
  }

  // Convert a per-order lock into actual spend/receipt. Fee in quote reduces proceeds / adds to
  // cost; fee in base reduces credited base. Over-lock (the taker buffer) is released on finalize.
  // sim.fee.ccy is the model's 'quote'|'base' literal (paper config), not an asset name.
  private settle(order: Resting, sim: SimFill): void {
    const { base, quote } = splitSymbol(order.symbol);
    const notional = sim.price.mul(sim.qty);
    const quoteFee = sim.fee.ccy === 'quote' ? sim.fee.amount : new Decimal(0);
    const baseFee = sim.fee.ccy === 'base' ? sim.fee.amount : new Decimal(0);
    if (order.side === 'BUY') {
      const cost = notional.add(quoteFee);
      this.consumeLock(order, cost);
      this.bal(base).free = this.bal(base).free.add(sim.qty.sub(baseFee));
    } else {
      this.consumeLock(order, sim.qty);
      this.bal(quote).free = this.bal(quote).free.add(notional.sub(quoteFee));
    }
  }

  private consumeLock(order: Resting, amount: Decimal): void {
    const take = Decimal.min(amount, order.lockRemaining);
    order.lockRemaining = order.lockRemaining.sub(take);
    const bal = this.bal(order.lockAsset);
    bal.locked = bal.locked.sub(take);
  }

  private release(order: Resting): void {
    if (order.lockRemaining.lte(0)) return;
    const bal = this.bal(order.lockAsset);
    bal.locked = bal.locked.sub(order.lockRemaining);
    bal.free = bal.free.add(order.lockRemaining);
    order.lockRemaining = new Decimal(0);
  }

  private computeLock(
    req: PlaceOrderRequest,
    base: string,
    quote: string,
  ): { lockAsset: string; lockAmount: Decimal } {
    if (req.side === 'SELL') return { lockAsset: base, lockAmount: new Decimal(req.qty) };
    const ref =
      req.limitPrice !== undefined ? new Decimal(req.limitPrice) : this.bestAsk(req.symbol);
    const amount = ref.mul(req.qty).mul(this.takerBuffer.add(1));
    return { lockAsset: quote, lockAmount: amount };
  }

  private bestAsk(symbol: SymbolId): Decimal {
    const book = this.books.get(symbol);
    if (book === undefined || book.asks.length === 0) {
      throw new AdapterError(
        'TERMINAL_REJECT',
        'NO_BOOK',
        `paper: no book to price market ${symbol}`,
      );
    }
    return book.asks[0]!.price;
  }

  private isMarketable(side: 'BUY' | 'SELL', symbol: SymbolId, limit: Decimal): boolean {
    const book = this.books.get(symbol);
    if (book === undefined) return false;
    if (side === 'BUY') return book.asks.length > 0 && book.asks[0]!.price.lte(limit);
    return book.bids.length > 0 && book.bids[0]!.price.gte(limit);
  }

  private bal(asset: string): Balance {
    let b = this.balances.get(asset);
    if (b === undefined) {
      b = { free: new Decimal(0), locked: new Decimal(0) };
      this.balances.set(asset, b);
    }
    return b;
  }

  // Auto-deliver: drain to the OMS as soon as a report lands. Instant market fills thus arrive
  // while the order is SUBMITTING (legal implicit ack, §6.1); resting-limit fills arrive after
  // the ACK. reorderDelivery hands delivery timing to the test so §6.1's reordering rows
  // (fill-before-ack, late-fill-after-cancel) can be exercised explicitly.
  private async emit(report: ExecReport): Promise<void> {
    await this.outbox.append({ reportId: report.reportId, report });
    if (this.cfg.reorderDelivery !== true) await this.notify();
  }

  private next(): number {
    this.seq += 1;
    return this.seq;
  }

  // Timestamp realism: a seeded latency offset on the virtual clock (advances the PRNG
  // deterministically). Fills emit synchronously; latency is metadata, not a real delay.
  private eventTime(): EpochMs {
    const [lo, hi] = this.cfg.latency.eventMs;
    const offset = Math.floor(lo + this.rng() * (hi - lo));
    return epochMs(this.clock.now() + offset);
  }
}
