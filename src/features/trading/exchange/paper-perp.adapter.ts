import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { CLOCK, type ClockPort } from '../../../ports/clock';
import {
  AdapterError,
  type ExchangePort,
  type VenueCapabilities,
  type PlaceOrderRequest,
  type ExchangeAck,
  type ExchangeOrderState,
  type VenueFill,
  type CredentialCheck,
} from '../../../ports/exchange';
import {
  EXEC_OUTBOX,
  EXEC_REPORT_NOTIFY,
  type ExecOutboxPort,
  type ExecReportNotify,
} from '../../../ports/execution';
import {
  bookWalk,
  tradeThroughFill,
  type SimFill,
  type InsufficientDepthPolicy,
} from '../../../domain/paper/fill';
import { mulberry32 } from '../../../domain/rng/prng';
import { price, qty, feeAmount, roundToMoneyPrecision } from '../../../domain/types/money';
import {
  clientOrderId as makeClientOrderId,
  epochMs,
  type ClientOrderId,
  type SymbolId,
  type VenueId,
  type EpochMs,
} from '../../../domain/types/ids';
import type { OrderLevel } from '../../../domain/types/market-events';
import type { ExecReport, FillReport } from '../../../domain/types/exec-report';
import {
  assertSwapPrivateUrlSafe,
  type SwapBootMode,
} from '../../../shared/venue-safety/swap-url-guard';

export const PAPER_PERP_CONFIG = Symbol('PAPER_PERP_CONFIG');

// A funding-payment settlement row, shaped to mirror the funding_events table
// (src/database/schemas/trading/trading.schema.ts). Kept adapter-local (not ports/execution.ts)
// rather than widening a shared port: nothing outside this adapter consumes it this pass.
export interface FundingEventPayload {
  readonly mode: 'paper' | 'testnet' | 'live';
  readonly strategyId: string;
  readonly venue: VenueId;
  readonly symbol: SymbolId;
  readonly fundingRate: string;
  readonly markPrice: string;
  readonly signedQty: string;
  readonly paymentQuote: string;
  readonly fundingTime: EpochMs;
}

export interface FundingSinkPort {
  record(row: FundingEventPayload): Promise<void>;
}

export const FUNDING_SINK = Symbol('FUNDING_SINK');

export interface PaperPerpConfig {
  readonly seed: number;
  readonly fees: { readonly makerBps: string; readonly takerBps: string };
  readonly latency: { readonly submitMs: [number, number]; readonly eventMs: [number, number] };
  readonly insufficientDepthPolicy: InsufficientDepthPolicy;
  readonly reorderDelivery?: boolean;
  // Single settlement asset for every configured symbol (e.g. 'USDT' — both BTC/USDT:USDT and
  // ETH/USDT:USDT settle in it). USD-M swap is single-quote by construction (unlike spot, which
  // splits per-symbol base/quote custody), so one balance bucket covers the whole adapter.
  readonly settlementAsset: string;
  // Isolated-margin balance the paper account starts with, denominated in settlementAsset.
  readonly startingMargin: string;
  // PERP_LEVERAGE_CAP: isolated one-way margin, one leverage figure applied to every symbol.
  readonly leverage: string;
  // PERP_MMR_FALLBACK: see the why-comment on liqPrice below.
  readonly mmrFallback: string;
  readonly mode: 'paper' | 'testnet' | 'live';
  readonly strategyId: string;
  // Fail-closed boot guard (§ swap-url-guard): when the adapter would resolve a private swap base
  // URL (a future non-paper wiring), refuse construction unless that URL is a known non-live host.
  // Absent in the pure-simulation paper path (no URL to check).
  readonly boot?: { readonly swapMode: SwapBootMode; readonly privateBaseUrl: string };
}

interface Balance {
  free: Decimal;
  locked: Decimal;
}

// Signed position ledger: qty > 0 is long, < 0 is short. avgEntry is the volume-weighted average
// entry price of the CURRENT signed side (reset to the fill price on a zero-cross flip). margin is
// THIS position's isolated allocation out of the account's settlementAsset balance — moved
// free↔locked as the position opens/adds (locks more) or reduces/closes (releases proportionally).
interface Position {
  signedQty: Decimal;
  avgEntry: Decimal;
  margin: Decimal;
}

interface Resting {
  readonly clientOrderId: ClientOrderId;
  readonly venueOrderId: string;
  readonly symbol: SymbolId;
  readonly side: 'BUY' | 'SELL';
  readonly limitPrice: Decimal;
  readonly reduceOnly: boolean;
  remaining: Decimal;
}

interface OrderSnap {
  venueOrderId: string;
  status: ExchangeOrderState['status'];
  cumQty: Decimal;
  qty: Decimal;
}

// PaperPerpAdapter: the swap sibling of PaperExchangeAdapter (paper-exchange.adapter.ts) — same
// ExchangePort seam, same outbox-delivered FillReport contract (§6.5): the OMS cannot tell a spot
// paper fill from a perp paper fill. Constructor/outbox/notify/seq wiring mirrors the spot adapter
// exactly. What differs is settlement: a perp has no base asset to custody, so instead of
// crediting base/debiting quote a fill updates a signed position ledger and realizes PnL into a
// single quote-margin balance (isolated one-way margin — one position per symbol, no hedge mode).
// Unlike the spot adapter's per-ORDER lock (custody escrow released at order finalize), margin
// here is allocated/released per-POSITION at fill time (settlePerpFill) — an order-level lock
// would leak on every position close, since the margin genuinely belongs to the position, not the
// order that opened it.
@Injectable()
export class PaperPerpAdapter implements ExchangePort {
  readonly venue: VenueId;
  readonly capabilities: VenueCapabilities = {
    clientOrderId: true,
    fetchOrderByClientId: true,
    wsUserStream: true,
    stp: false,
    sandbox: true,
  };

  private readonly balances = new Map<string, Balance>();
  private readonly positions = new Map<SymbolId, Position>();
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
  private readonly leverage: Decimal;
  private readonly mmrFallback: Decimal;
  private readonly settlementAsset: string;
  private seq = 0;

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(EXEC_OUTBOX) private readonly outbox: ExecOutboxPort,
    @Inject(EXEC_REPORT_NOTIFY) private readonly notify: ExecReportNotify,
    @Inject(FUNDING_SINK) private readonly fundingSink: FundingSinkPort,
    @Inject(PAPER_PERP_CONFIG) private readonly cfg: PaperPerpConfig,
    venue: VenueId,
  ) {
    this.venue = venue;
    if (cfg.boot !== undefined) {
      assertSwapPrivateUrlSafe(cfg.boot.privateBaseUrl, cfg.boot.swapMode);
    }
    this.rng = mulberry32(cfg.seed);
    this.takerBps = new Decimal(cfg.fees.takerBps);
    this.makerBps = new Decimal(cfg.fees.makerBps);
    this.leverage = new Decimal(cfg.leverage);
    this.mmrFallback = new Decimal(cfg.mmrFallback);
    this.settlementAsset = cfg.settlementAsset;
    this.balances.set(this.settlementAsset, {
      free: new Decimal(cfg.startingMargin),
      locked: new Decimal(0),
    });
  }

  // ── Market-data feed (paper-only, mirrors the spot adapter's ingestBook/ingestTrade) ──────
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
        'quote',
      );
      if (sim) await this.fill(order, sim);
    }
  }

  // Mark-price feed: the ONLY liquidation trigger. Real venues stream mark price continuously
  // (index + basis, not the raw last-trade print); this adapter takes it as an injected value so
  // the liq path stays deterministic and testable offline, same seam philosophy as ingestBook.
  async ingestMark(symbol: SymbolId, mark: Decimal): Promise<void> {
    await this.checkLiquidation(symbol, mark);
  }

  // Funding settlement at a venue funding timestamp. payment = −signedQty × markPrice ×
  // fundingRate (Binance convention: positive fundingRate ⇒ longs pay, shorts receive). No-op on
  // a flat position (nothing to settle) — mirrors real venues, which never charge funding on zero
  // exposure.
  async applyFunding(
    symbol: SymbolId,
    fundingRate: string,
    markPrice: string,
    fundingTime: EpochMs,
  ): Promise<void> {
    const pos = this.positions.get(symbol);
    if (pos === undefined || pos.signedQty.isZero()) return;
    const rate = new Decimal(fundingRate);
    const mark = new Decimal(markPrice);
    const payment = pos.signedQty.neg().mul(mark).mul(rate);
    this.bal(this.settlementAsset).free = this.bal(this.settlementAsset).free.add(payment);
    await this.fundingSink.record({
      mode: this.cfg.mode,
      strategyId: this.cfg.strategyId,
      venue: this.venue,
      symbol,
      fundingRate,
      markPrice,
      signedQty: pos.signedQty.toFixed(),
      paymentQuote: payment.toFixed(),
      fundingTime,
    });
  }

  // ── ExchangePort ──────────────────────────────────────────────────────────────────────────
  async placeOrder(req: PlaceOrderRequest): Promise<ExchangeAck> {
    // Push 3 P7a: the real swap venue's STOP_MARKET is a separate ALGO/conditional rail this
    // adapter does not simulate (no local liq-style trigger-watch loop exists for it); silently
    // treating one as a plain MARKET order would corrupt paper P&L/behavior tests. Fail closed.
    if (req.triggerPrice !== undefined) {
      throw new AdapterError(
        'TERMINAL_REJECT',
        'UNSUPPORTED_ORDER_TYPE',
        `paper-perp: trigger orders (${req.type}) are unsupported in paper simulation`,
      );
    }
    const orderQty = new Decimal(req.qty);
    const venueOrderId = `paper-perp-ord-${this.next()}`;

    // Fast-fail solvency estimate (non-mutating, top-of-book only): the AUTHORITATIVE check is the
    // deep-walk simulation in settleLegs (checks the total margin needed across every book level a
    // market order would actually touch, before mutating anything) — a resting limit's actual fill
    // price/qty isn't known yet either way. This is only a cheap early reject. Skipped for
    // reduceOnly — a closing order never needs fresh margin.
    if (!req.reduceOnly) {
      const estimate = this.computeMarginEstimate(req);
      if (this.bal(this.settlementAsset).free.lt(estimate)) {
        throw new AdapterError(
          'TERMINAL_REJECT',
          'INSUFFICIENT_FUNDS',
          `paper-perp: insufficient margin`,
        );
      }
    }

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
      reduceOnly: req.reduceOnly,
      remaining: orderQty,
    };

    if (req.type === 'MARKET') {
      await this.fillMarket(order, undefined);
    } else if (
      req.limitPrice !== undefined &&
      this.isMarketable(req.side, req.symbol, new Decimal(req.limitPrice))
    ) {
      await this.fillMarket(order, new Decimal(req.limitPrice));
      if (order.remaining.gt(0)) this.resting.set(req.clientOrderId, order);
    } else {
      this.resting.set(req.clientOrderId, order);
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
        `paper-perp: ${clientOrderId} not open`,
      );
    }
    this.resting.delete(clientOrderId);
    this.snaps.set(clientOrderId, { ...snap, status: 'canceled' });
    await this.emit({
      kind: 'CANCEL_ACK',
      reportId: `paper-perp-rpt-${this.next()}`,
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
      return Promise.reject(new AdapterError('TERMINAL_REJECT', 'ORDER_NOT_FOUND', 'paper-perp'));
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
      keyFingerprint: 'paper-perp',
    });
  }

  // Read-only helper for tests/observers — not part of ExchangePort (no fetchPositions this pass
  // per the B1 scope: the port is not widened).
  positionOf(symbol: SymbolId): { signedQty: string; avgEntry: string; margin: string } {
    const pos = this.positions.get(symbol) ?? {
      signedQty: new Decimal(0),
      avgEntry: new Decimal(0),
      margin: new Decimal(0),
    };
    return {
      signedQty: pos.signedQty.toFixed(),
      avgEntry: pos.avgEntry.toFixed(),
      margin: pos.margin.toFixed(),
    };
  }

  // ── Fill mechanics (mirrors paper-exchange.adapter.ts's fillMarket/fill) ──────────────────
  private async fillMarket(order: Resting, limitCap: Decimal | undefined): Promise<void> {
    const book = this.books.get(order.symbol);
    if (book === undefined) {
      throw new AdapterError(
        'TERMINAL_REJECT',
        'NO_BOOK',
        `paper-perp: no book for ${order.symbol}`,
      );
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
      'quote',
      this.cfg.insufficientDepthPolicy,
    );
    await this.settleLegs(order, sims);
  }

  private async fill(order: Resting, sim: SimFill): Promise<void> {
    await this.settleLegs(order, [sim]);
  }

  // Two-phase atomic settlement for a full set of fill legs (one book-walk market order can
  // produce several legs, one per level touched). Phase 1 simulates every leg against CLONES of
  // the live position/balance (capping any reduceOnly leg at the live position size along the
  // way, § FIX 2) purely to total the margin the WHOLE set would consume — nothing outside the
  // clones is touched, so a shortfall discovered on a later leg (deep-walk pricing, not just
  // top-of-book) never leaves an earlier leg half-settled. Phase 2 only mutates the live ledger
  // and emits fill reports once every leg is confirmed affordable: a market order either fills
  // (however many legs it takes) or is rejected whole, exactly like a real venue — never a
  // mid-walk throw after partial emission.
  private async settleLegs(order: Resting, sims: readonly SimFill[]): Promise<void> {
    if (sims.length === 0) return;

    const livePos = this.positions.get(order.symbol) ?? {
      signedQty: new Decimal(0),
      avgEntry: new Decimal(0),
      margin: new Decimal(0),
    };
    const liveBal = this.bal(this.settlementAsset);

    // Phase 1 — simulate.
    const posSim: Position = { ...livePos };
    const balSim: Balance = { free: liveBal.free, locked: liveBal.locked };
    const legs: SimFill[] = [];
    for (const raw of sims) {
      const sim = order.reduceOnly ? this.capReduceOnlySim(order.side, posSim, raw) : raw;
      if (sim === null) continue; // reduceOnly leg that would open/add: dropped, not filled
      this.settlePerpFill(posSim, balSim, order.side, sim);
      legs.push(sim);
    }

    // Phase 2 — commit: only now does the live ledger change or a report leave the adapter.
    this.positions.set(order.symbol, posSim);
    liveBal.free = balSim.free;
    liveBal.locked = balSim.locked;

    // order.remaining/cumQty account by the ORIGINAL per-level qty (not the reduceOnly-capped
    // qty): a reduceOnly order that only partially filled its capped legs still fully consumes
    // the requested qty — the dropped excess never resolves into a fill, on this leg or any
    // later one, so it must not linger as a resting remainder either (§ FIX 2 "completes as a
    // full close"). cumQty instead reflects only what actually settled (the `legs` sum), so it
    // stays truthful against `this.trades`/the emitted reports below.
    const requestedQty = sims.reduce((acc, s) => acc.add(s.qty), new Decimal(0));
    const settledQty = legs.reduce((acc, s) => acc.add(s.qty), new Decimal(0));
    order.remaining = order.remaining.sub(requestedQty);

    const snap = this.snaps.get(order.clientOrderId)!;
    const cumQty = snap.cumQty.add(settledQty);
    const filled = order.remaining.lte(0);
    this.snaps.set(order.clientOrderId, { ...snap, cumQty, status: filled ? 'closed' : 'open' });
    if (filled) this.resting.delete(order.clientOrderId);

    for (const sim of legs) {
      const venueTradeId = `paper-perp-trade-${this.next()}`;
      const venueTimestamp = this.eventTime();
      this.trades.push({
        venue: this.venue,
        symbol: order.symbol,
        venueTradeId,
        clientOrderId: order.clientOrderId,
        price: sim.price.toFixed(),
        qty: sim.qty.toFixed(),
        fee: { ccy: this.settlementAsset, amount: sim.fee.amount.toFixed() },
        liquidity: sim.liquidity,
        venueTimestamp,
      });

      const report: FillReport = {
        kind: 'FILL',
        reportId: `paper-perp-rpt-${this.next()}`,
        clientOrderId: order.clientOrderId,
        venue: this.venue,
        symbol: order.symbol,
        eventTime: this.eventTime(),
        ingestTime: this.clock.now(),
        venueTradeId,
        price: sim.price,
        qty: sim.qty,
        fee: { ccy: this.settlementAsset, amount: sim.fee.amount },
        liquidity: sim.liquidity,
        venueTimestamp,
      };
      await this.emit(report);
    }
  }

  // reduceOnly must cap, never flip (§ FIX 2): on a real venue a reduceOnly order's fill is capped
  // at the currently open position size and any excess is simply dropped (the order completes as
  // a full close, it does not open the opposite side) — this paper adapter stands in for the
  // venue, so it enforces the same rule rather than letting settlePerpFill's ordinary flip branch
  // run unchecked. A leg that would OPEN or ADD (position flat — e.g. an earlier leg of this same
  // walk already closed it — or same-direction) is dropped outright (null): passing it through
  // would hand settlePerpFill's openOrAdd branch a reduceOnly fill, exactly the flip this guard
  // exists to prevent. Only the closing (opposite-sign) leg is ever capped; qty and its fee
  // (billed on that qty) are trimmed together so the emitted report matches what actually settled.
  private capReduceOnlySim(side: 'BUY' | 'SELL', pos: Position, sim: SimFill): SimFill | null {
    const direction = side === 'BUY' ? 1 : -1;
    const deltaQty = sim.qty.mul(direction);
    const sameSign = pos.signedQty.isZero() || pos.signedQty.mul(deltaQty).gte(0);
    if (sameSign) return null;
    const cap = pos.signedQty.abs();
    if (sim.qty.lte(cap)) return sim;
    const bps = sim.liquidity === 'taker' ? this.takerBps : this.makerBps;
    const feeRaw = roundToMoneyPrecision(sim.price.mul(cap).mul(bps).div(10_000));
    return {
      price: sim.price,
      qty: qty(cap),
      fee: { ccy: sim.fee.ccy, amount: feeAmount(feeRaw) },
      liquidity: sim.liquidity,
    };
  }

  // Applies a fill to the signed position ledger, isolated margin, and realized PnL. Pure on the
  // given pos/bal (no map lookups) so callers can run it against either the live state or a clone
  // (§ settleLegs's phase-1 simulation). Increasing (or opening) a position locks
  // addNotional/leverage more margin (free→locked) and re-averages entry over the combined
  // notional. Reducing/flipping releases margin proportional to the closed fraction (locked→free)
  // AND realizes PnL on the closed portion (closingQty × (fillPrice − avgEntry), signed by the
  // position's PRE-fill side) before any remainder opens a new position at the fill price. Fee is
  // always billed in the settlement asset (feeCcy is passed as 'quote' at every call site — a perp
  // has no base asset to custody, so bookWalk/tradeThroughFill's base/quote fee split collapses to
  // quote-only here).
  private settlePerpFill(pos: Position, bal: Balance, side: 'BUY' | 'SELL', sim: SimFill): void {
    const direction = side === 'BUY' ? 1 : -1;
    const deltaQty = sim.qty.mul(direction);
    const sameSign = pos.signedQty.isZero() || pos.signedQty.mul(deltaQty).gte(0);

    if (sameSign) {
      this.openOrAdd(pos, bal, sim.price, sim.qty);
      pos.signedQty = pos.signedQty.add(deltaQty);
    } else {
      const closingQty = Decimal.min(sim.qty, pos.signedQty.abs());
      const existingSign = pos.signedQty.gt(0) ? 1 : -1;
      const priorAbsQty = pos.signedQty.abs();

      const realized = closingQty.mul(sim.price.sub(pos.avgEntry)).mul(existingSign);
      const releasedMargin = priorAbsQty.isZero()
        ? new Decimal(0)
        : pos.margin.mul(closingQty).div(priorAbsQty);
      pos.margin = pos.margin.sub(releasedMargin);
      bal.locked = bal.locked.sub(releasedMargin);
      bal.free = bal.free.add(releasedMargin).add(realized);

      const remainderQty = sim.qty.sub(closingQty);
      if (remainderQty.gt(0)) {
        // Flips through zero: the closing leg above fully offset the prior side (margin is now
        // ~0); the remainder opens a fresh position at the fill price. Never reached for a
        // reduceOnly order — capReduceOnlySim already trimmed sim.qty down to closingQty above.
        pos.signedQty = new Decimal(0);
        pos.avgEntry = sim.price;
        this.openOrAdd(pos, bal, sim.price, remainderQty);
        pos.signedQty = remainderQty.mul(direction);
      } else {
        pos.signedQty = pos.signedQty.add(closingQty.mul(-existingSign));
      }
    }

    bal.free = bal.free.sub(sim.fee.amount);
  }

  // Shared open/add-to-position leg: locks addNotional/leverage more margin and re-averages entry.
  // Throws INSUFFICIENT_FUNDS if free margin can't cover it — the authoritative solvency check
  // (placeOrder's pre-check is only a non-mutating fast-fail estimate).
  private openOrAdd(pos: Position, bal: Balance, fillPrice: Decimal, fillQty: Decimal): void {
    const addNotional = fillPrice.mul(fillQty);
    const addMargin = addNotional.div(this.leverage);
    if (bal.free.lt(addMargin)) {
      throw new AdapterError(
        'TERMINAL_REJECT',
        'INSUFFICIENT_FUNDS',
        `paper-perp: insufficient margin`,
      );
    }
    bal.free = bal.free.sub(addMargin);
    bal.locked = bal.locked.add(addMargin);
    pos.margin = pos.margin.add(addMargin);

    const priorAbsQty = pos.signedQty.abs();
    const newAbsQty = priorAbsQty.add(fillQty);
    const openNotional = pos.avgEntry.mul(priorAbsQty);
    pos.avgEntry = newAbsQty.isZero()
      ? pos.avgEntry
      : roundToMoneyPrecision(openNotional.add(addNotional).div(newAbsQty));
  }

  // ── Liquidation (local model; § task: isolated one-way margin) ────────────────────────────
  // long liq = entry × (1 − 1/leverage + MMR); short liq = entry × (1 + 1/leverage − MMR).
  // MMR (maintenance-margin-rate) is a CONSERVATIVE HARDCODED FALLBACK (~0.005, PERP_MMR_FALLBACK)
  // for the 1-2× BTC/ETH leverage bracket per Binance's published tiered leverage-bracket table —
  // real MMR is tier-dependent (scales with position notional) and the venue is the source of
  // truth. TODO(fetchLeverageTiers): replace this constant with a per-symbol/per-notional lookup
  // once the adapter has a wired venue client to call fetchLeverageTiers against; using a single
  // conservative low-leverage-tier MMR in the meantime is the fail-SAFE direction (it triggers
  // liquidation EARLIER, before a real higher-tier MMR would).
  private liqPrice(pos: Position): Decimal {
    const invLev = new Decimal(1).div(this.leverage);
    return pos.signedQty.gt(0)
      ? pos.avgEntry.mul(new Decimal(1).sub(invLev).add(this.mmrFallback))
      : pos.avgEntry.mul(new Decimal(1).add(invLev).sub(this.mmrFallback));
  }

  private async checkLiquidation(symbol: SymbolId, mark: Decimal): Promise<void> {
    const pos = this.positions.get(symbol);
    if (pos === undefined || pos.signedQty.isZero()) return;
    const liq = this.liqPrice(pos);
    const crossed = pos.signedQty.gt(0) ? mark.lte(liq) : mark.gte(liq);
    if (!crossed) return;
    await this.forceClose(symbol, pos, liq);
  }

  // Force-close: mints a fill exactly like a normal exit (via settlePerpFill's reducing leg —
  // fillPrice = liqPrice is precisely where realized loss ≈ −(margin − maintenanceMargin), so the
  // account is left holding ≈ maintenanceMargin, matching a real liquidation's residual), but with
  // a venueTradeId/reportId carrying a "-liq-" segment — the distinguishable liquidation reason.
  // VenueFill/FillReport carry no free-form reason field (never widened — B1 scope); the ID prefix
  // mirrors the existing paper-ord-/paper-trade- convention for encoding fill provenance in the ID.
  private async forceClose(symbol: SymbolId, pos: Position, liq: Decimal): Promise<void> {
    const closeQty = pos.signedQty.abs();
    const closingSide: 'BUY' | 'SELL' = pos.signedQty.gt(0) ? 'SELL' : 'BUY';
    const liqFillPrice = price(liq);
    const liqFillQty = qty(closeQty);
    const zeroFee = feeAmount(new Decimal(0));
    const sim: SimFill = {
      price: liqFillPrice,
      qty: liqFillQty,
      fee: { ccy: 'quote', amount: zeroFee },
      liquidity: 'taker',
    };
    this.settlePerpFill(pos, this.bal(this.settlementAsset), closingSide, sim);
    this.positions.set(symbol, pos);

    const liqClientOrderId = makeClientOrderId(`paper-perp-liq-${symbol}-${this.next()}`);
    const venueTradeId = `paper-perp-liq-trade-${this.next()}`;
    const venueTimestamp = this.eventTime();
    this.trades.push({
      venue: this.venue,
      symbol,
      venueTradeId,
      clientOrderId: liqClientOrderId,
      price: liqFillPrice.toFixed(),
      qty: liqFillQty.toFixed(),
      fee: { ccy: this.settlementAsset, amount: zeroFee.toFixed() },
      liquidity: 'taker',
      venueTimestamp,
    });

    const report: FillReport = {
      kind: 'FILL',
      reportId: `paper-perp-liq-rpt-${this.next()}`,
      clientOrderId: liqClientOrderId,
      venue: this.venue,
      symbol,
      eventTime: this.eventTime(),
      ingestTime: this.clock.now(),
      venueTradeId,
      price: liqFillPrice,
      qty: liqFillQty,
      fee: { ccy: this.settlementAsset, amount: zeroFee },
      liquidity: 'taker',
      venueTimestamp,
    };
    await this.emit(report);
  }

  // ── Reference pricing / misc ────────────────────────────────────────────────────────────
  private computeMarginEstimate(req: PlaceOrderRequest): Decimal {
    const ref =
      req.limitPrice !== undefined
        ? new Decimal(req.limitPrice)
        : req.side === 'BUY'
          ? this.bestAsk(req.symbol)
          : this.bestBid(req.symbol);
    return ref.mul(req.qty).div(this.leverage);
  }

  private bestAsk(symbol: SymbolId): Decimal {
    const book = this.books.get(symbol);
    if (book === undefined || book.asks.length === 0) {
      throw new AdapterError(
        'TERMINAL_REJECT',
        'NO_BOOK',
        `paper-perp: no book to price market ${symbol}`,
      );
    }
    return book.asks[0]!.price;
  }

  private bestBid(symbol: SymbolId): Decimal {
    const book = this.books.get(symbol);
    if (book === undefined || book.bids.length === 0) {
      throw new AdapterError(
        'TERMINAL_REJECT',
        'NO_BOOK',
        `paper-perp: no book to price market ${symbol}`,
      );
    }
    return book.bids[0]!.price;
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

  private async emit(report: ExecReport): Promise<void> {
    await this.outbox.append({ reportId: report.reportId, report });
    if (this.cfg.reorderDelivery !== true) await this.notify();
  }

  private next(): number {
    this.seq += 1;
    return this.seq;
  }

  private eventTime(): EpochMs {
    const [lo, hi] = this.cfg.latency.eventMs;
    const offset = Math.floor(lo + this.rng() * (hi - lo));
    return epochMs(this.clock.now() + offset);
  }
}
