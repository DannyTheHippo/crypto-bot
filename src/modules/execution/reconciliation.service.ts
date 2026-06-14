import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectMetric, makeCounterProvider, makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import { Counter, Gauge } from 'prom-client';
import Decimal from 'decimal.js';
import { CLOCK, type ClockPort } from '../../ports/clock';
import { KILL_SWITCH, type KillSwitchPort } from '../../ports/risk';
import {
  EXCHANGE_PORT, type ExchangePort, type ExchangeOrderState, type VenueFill,
} from '../../ports/exchange';
import {
  EXECUTION_STORE, RECON_CONFIG,
  type ExecutionStorePort, type ReconConfig,
} from '../../ports/execution';
import { reduce, type OrderEvent } from '../../domain/oms/reducer';
import { isOurClientOrderId } from '../../domain/types/ids';
import { price, qty, feeAmount } from '../../domain/types/money';
import { classifyVenueOpenOrder, balanceWithinEpsilon, driftStrictlyGrowing } from '../../domain/oms/reconcile';
import type { ClientOrderId, SymbolId, EpochMs } from '../../domain/types/ids';
import type { FillRecord } from '../../domain/types/exec-report';
import { OrderBookService } from './order-book.service';
import { PortfolioStateService } from './portfolio-state.service';
import { FillIngestorService } from './fill-ingestor.service';

interface PassAccumulator {
  mismatches: number;
  readonly halts: string[];
}

// §8/§10 reconciliation_mismatch_total — incremented per pass by the pass's mismatch count (0 on a
// clean pass). Registers to the default prom-client registry that /metrics scrapes; @Optional so
// the directly-constructed unit tests need not supply it. Drives the ReconciliationMismatch alert.
export const RECON_MISMATCH_COUNTER = makeCounterProvider({
  name: 'reconciliation_mismatch_total',
  help: 'Reconciliation mismatches detected per pass (§6.4)',
});

// §8 reconciliation visibility: count every pass by result, and stamp the last clean pass so a
// dashboard/alert can show "time since last successful reconcile" (a stalled reconciler is itself a
// fault). Both @Optional so directly-constructed unit tests need not supply them.
export const RECON_RUNS_COUNTER = makeCounterProvider({
  name: 'reconciliation_runs_total',
  help: 'Reconciliation passes by result (§8)',
  labelNames: ['result'] as const,
});

export const RECON_LAST_SUCCESS_GAUGE = makeGaugeProvider({
  name: 'reconciliation_last_success_timestamp_seconds',
  help: 'Unix time of the last clean (no-mismatch, not-halted) reconciliation pass (§8)',
});

// §6.4 reconciliation — serialized per venue, run on cadence/triggers. Compares venue truth against
// local state across three axes and applies the taxonomy. The cardinal rule: a material mismatch
// HALTs and is NEVER auto-flattened (flattening on a model just proven wrong can create or double
// the very position the discrepancy mis-stated, at the worst liquidity). The one risk-reducing
// action allowed while halted — cancelling known open orders — is the kill switch's job, not this
// service's. Every pass persists a reconciliations row; a non-zero mismatch count pages.
@Injectable()
export class ReconciliationService {
  private readonly checkpoints = new Map<string, EpochMs>();
  private readonly driftHistory = new Map<string, Decimal[]>();

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(EXCHANGE_PORT) private readonly exchange: ExchangePort,
    @Inject(EXECUTION_STORE) private readonly store: ExecutionStorePort,
    @Inject(KILL_SWITCH) private readonly killSwitch: KillSwitchPort,
    @Inject(RECON_CONFIG) private readonly cfg: ReconConfig,
    private readonly orders: OrderBookService,
    private readonly portfolio: PortfolioStateService,
    private readonly ingestor: FillIngestorService,
    @Optional() @InjectMetric('reconciliation_mismatch_total') private readonly mismatchCounter?: Counter<string>,
    @Optional() @InjectMetric('reconciliation_runs_total') private readonly runsCounter?: Counter<string>,
    @Optional() @InjectMetric('reconciliation_last_success_timestamp_seconds') private readonly lastSuccessGauge?: Gauge<string>,
  ) {}

  async reconcile(): Promise<{ mismatches: number; halted: boolean }> {
    const acc: PassAccumulator = { mismatches: 0, halts: [] };

    await this.reconcileOpenOrders(acc);
    await this.reconcileTrades(acc);
    await this.reconcileBalances(acc);

    const halted = acc.halts.length > 0;
    if (halted) this.killSwitch.engage(`RECONCILE_MISMATCH:${acc.halts.join(',')}`, false); // never auto-flatten

    await this.store.saveReconciliation({
      ts: this.clock.now(), venue: this.exchange.venue,
      mismatches: acc.mismatches, halted, detail: acc.halts.join(',') || 'clean',
    });
    this.mismatchCounter?.inc(acc.mismatches); // 0 on a clean pass; the alert fires on an increase
    const result = halted ? 'halt' : acc.mismatches > 0 ? 'mismatch' : 'clean';
    this.runsCounter?.inc({ result });
    if (result === 'clean') this.lastSuccessGauge?.set(this.clock.now() / 1000);
    return { mismatches: acc.mismatches, halted };
  }

  // Axis 1 — open orders joined on clientOrderId.
  private async reconcileOpenOrders(acc: PassAccumulator): Promise<void> {
    const venueOpen = await this.exchange.fetchOpenOrders();
    const localOpen = this.portfolio.snapshot().openOrders;
    const localCoids = new Set<string>(localOpen.map((o) => o.clientOrderId));
    const venueCoids = new Set<string>(venueOpen.map((o) => o.clientOrderId));

    for (const vo of venueOpen) {
      const verdict = classifyVenueOpenOrder(vo.clientOrderId, localCoids.has(vo.clientOrderId));
      if (verdict === 'UNKNOWN_OURS') {
        acc.mismatches += 1;
        acc.halts.push('UNKNOWN_OURS_OPEN'); // I1: our prefix, no local row ⇒ corruption (no auto-cancel)
      } else if (verdict === 'FOREIGN') {
        acc.mismatches += 1; // manual trading on the key — WARN + ignore
      }
    }

    // Local order we believe open but the venue does not list: adopt the venue's terminal truth.
    for (const lo of localOpen) {
      if (venueCoids.has(lo.clientOrderId)) continue;
      await this.adoptTerminal(lo.clientOrderId, lo.symbol, acc);
    }
  }

  private async adoptTerminal(coid: ClientOrderId, symbol: SymbolId, acc: PassAccumulator): Promise<void> {
    let venue: ExchangeOrderState;
    try {
      venue = await this.exchange.fetchOrder(coid, symbol);
    } catch {
      acc.mismatches += 1; // an order we hold open but cannot query — surfaced, re-checked next pass
      return;
    }
    const event = this.terminalEventFor(venue.status);
    if (event === undefined) {
      acc.mismatches += 1; // 'open'/'closed' here is inconsistent with absence from open orders — WARN
      return;
    }
    acc.mismatches += 1; // adopting a terminal we missed via the stream
    await this.fold(coid, event);
  }

  // Only the terminals an open (ACKED/PARTIALLY_FILLED) order may LEGALLY reach are adopted:
  // canceled and expired. 'rejected' is reachable only from SUBMITTING, so a venue 'rejected' on an
  // order we already hold an ack for is a contradiction, not an adopt — surfaced as a WARN (and the
  // reducer would reject the illegal fold anyway). 'open'/'closed' are likewise non-adopt here.
  private terminalEventFor(status: ExchangeOrderState['status']): OrderEvent | undefined {
    switch (status) {
      case 'canceled': return { type: 'VENUE_CANCELED' };
      case 'expired': return { type: 'VENUE_EXPIRED' };
      default: return undefined;
    }
  }

  // Axis 2 — trades since the per-(venue,symbol) checkpoint minus an overlap window.
  private async reconcileTrades(acc: PassAccumulator): Promise<void> {
    for (const symbol of this.symbolsOfInterest()) {
      const key = `${this.exchange.venue}|${symbol}`;
      const checkpoint = this.checkpoints.get(key) ?? (0 as EpochMs);
      const since = Math.max(0, checkpoint - this.cfg.overlapMs) as EpochMs;
      let trades: readonly VenueFill[];
      try {
        trades = await this.exchange.fetchMyTrades(symbol, since);
      } catch {
        acc.mismatches += 1; // could not sweep this symbol's trades — surfaced
        continue;
      }
      for (const t of trades) {
        await this.reconcileTrade(t, acc);
        if (t.venueTimestamp > (this.checkpoints.get(key) ?? 0)) this.checkpoints.set(key, t.venueTimestamp);
      }
    }
  }

  private async reconcileTrade(t: VenueFill, acc: PassAccumulator): Promise<void> {
    if (!isOurClientOrderId(t.clientOrderId)) return; // foreign trade on the key — ignore
    const rec = this.orders.get(t.clientOrderId);
    if (rec === undefined) {
      acc.mismatches += 1;
      acc.halts.push('FILL_FOR_UNKNOWN_ORDER'); // our prefix, no local order ⇒ corruption (§6.4)
      return;
    }
    const { applied } = await this.ingestor.ingest(rec, this.toFillRecord(t), `reconcile:${t.venueTradeId}`);
    if (applied) acc.mismatches += 1; // a fill we had missed via the stream — backfilled + WARN
  }

  // Axis 3 — balances per asset within ε; within-ε drift recorded, monotone growth escalates.
  private async reconcileBalances(acc: PassAccumulator): Promise<void> {
    let venueBalances: ReadonlyMap<string, { free: string; locked: string }>;
    try {
      venueBalances = await this.exchange.fetchBalances();
    } catch {
      acc.mismatches += 1;
      return;
    }
    const local = this.portfolio.snapshot().balances;
    for (const [asset, bal] of local) {
      const localTotal = bal.free.add(bal.locked);
      const v = venueBalances.get(asset);
      const venueTotal = v ? new Decimal(v.free).add(new Decimal(v.locked)) : new Decimal(0);
      const within = balanceWithinEpsilon(localTotal, venueTotal, this.cfg.epsAbs, this.cfg.epsRel);
      const drift = venueTotal.sub(localTotal).abs();
      const history = this.driftHistory.get(asset) ?? [];
      history.push(drift);
      this.driftHistory.set(asset, history);

      if (!within) {
        acc.mismatches += 1;
        acc.halts.push(`BALANCE_DRIFT:${asset}`); // beyond ε ⇒ HALT, no auto-flatten
      } else if (driftStrictlyGrowing(history, this.cfg.driftPasses)) {
        acc.mismatches += 1;
        acc.halts.push(`BALANCE_LEAK:${asset}`); // within ε but a systematic, growing leak ⇒ HALT
      }
    }
  }

  private symbolsOfInterest(): SymbolId[] {
    const snap = this.portfolio.snapshot();
    const set = new Set<SymbolId>();
    for (const o of snap.openOrders) set.add(o.symbol);
    for (const p of snap.positions.values()) set.add(p.symbol);
    return [...set];
  }

  // Journal-before-commit (I1), then commit only if the journal accepted the row (replay-safe),
  // then retire the order from the in-flight reserve and open-order set.
  private async fold(coid: ClientOrderId, event: OrderEvent): Promise<void> {
    // fold is only reached for a local open order, which is always present in the book.
    const next = reduce(this.orders.get(coid)!, event);
    const { applied } = await this.store.appendOrderEvent({
      clientOrderId: coid, dedupeKey: `reconcile:${event.type}`, event,
      derivedState: next.state, cumQty: next.cumQty.toFixed(),
    });
    if (!applied) return;
    this.orders.commit(next);
    this.portfolio.clearInFlight(coid);
    this.portfolio.closeOrder(coid);
  }

  private toFillRecord(t: VenueFill): FillRecord {
    return {
      venue: t.venue, symbol: t.symbol, venueTradeId: t.venueTradeId, clientOrderId: t.clientOrderId,
      price: price(t.price), qty: qty(t.qty),
      fee: t.fee ? { ccy: t.fee.ccy, amount: feeAmount(t.fee.amount) } : null,
      liquidity: t.liquidity, venueTimestamp: t.venueTimestamp, source: 'rest_reconcile',
    };
  }
}
