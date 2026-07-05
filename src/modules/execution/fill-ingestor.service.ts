import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  InjectMetric,
  makeCounterProvider,
  makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';
import { Counter, Histogram } from 'prom-client';
import { EXECUTION_STORE, type ExecutionStorePort } from '../../ports/execution';
import { KILL_SWITCH, type KillSwitchPort } from '../../ports/risk';
import { reduce, type OrderRecord, type OrderState } from '../../domain/oms/reducer';
import { decodeClientOrderId } from '../../domain/types/ids';
import type { FillRecord } from '../../domain/types/exec-report';
import { OrderBookService } from './order-book.service';
import { PortfolioStateService } from './portfolio-state.service';
import { EquitySamplerService } from './equity-sampler.service';

// §8 fills_total — incremented once per newly-inserted (non-duplicate) fill. @Optional so
// direct-construction unit tests (which omit this param) still compile; the
// counter === undefined branch is covered by those tests.
export const FILLS_COUNTER = makeCounterProvider({
  name: 'fills_total',
  help: 'Fills ingested (non-duplicate) through the fill ingestor',
});

// §8 fill-rate numerator (filled side) + decision slippage. orders_filled_qty_total is the numerator
// over orders_submitted_qty_total; orders_fully_filled_total counts orders reaching FILLED. Decision
// slippage = signed bps of execution price vs the signal's reference price (positive = adverse): the
// total cost from the strategy's decision reference through to the fill. @Optional throughout so the
// direct-construction unit tests cover the metric-absent branch.
export const ORDERS_FILLED_QTY_COUNTER = makeCounterProvider({
  name: 'orders_filled_qty_total',
  help: 'Total filled quantity, by type and time-in-force (fill-rate numerator)',
  labelNames: ['type', 'tif'] as const,
});

export const ORDERS_FULLY_FILLED_COUNTER = makeCounterProvider({
  name: 'orders_fully_filled_total',
  help: 'Orders that reached FILLED, by type and time-in-force',
  labelNames: ['type', 'tif'] as const,
});

export const SLIPPAGE_DECISION_HISTOGRAM = makeHistogramProvider({
  name: 'order_slippage_decision_bps',
  help: 'Execution vs signal reference price, signed bps, positive = adverse (§8 decision slippage)',
  labelNames: ['venue', 'symbol', 'side', 'type'] as const,
  buckets: [-50, -20, -10, -5, -2, -1, 0, 1, 2, 5, 10, 20, 50],
});

// §8 profitability — captured at the fill fold (the round-trip realized PnL is already returned by the
// pure fold; no money-path domain change). fees_paid_total sums fees across currencies; round_trips_total
// counts completed round trips by result; trade_pnl_usdt distributes per-round-trip realized PnL (buckets
// tuned to BASE_NOTIONAL≈100, so _sum/_count give cumulative realized-from-round-trips and avg trade PnL).
// @Optional throughout so the direct-construction unit tests cover the metric-absent branch.
export const FEES_PAID_COUNTER = makeCounterProvider({
  name: 'fees_paid_total',
  help: 'Fees paid across all fills, by fee currency (§8)',
  labelNames: ['ccy'] as const,
});

export const ROUND_TRIPS_COUNTER = makeCounterProvider({
  name: 'round_trips_total',
  help: 'Completed round trips by result (win = round-trip PnL > 0, else loss)',
  labelNames: ['result'] as const,
});

export const TRADE_PNL_HISTOGRAM = makeHistogramProvider({
  name: 'trade_pnl_usdt',
  help: 'Realized PnL per completed round trip, USDT (net of quote fees); _sum/_count give cumulative + avg',
  buckets: [-10, -5, -2, -1, -0.5, -0.2, 0, 0.2, 0.5, 1, 2, 5, 10],
});

const TERMINAL: ReadonlySet<OrderState> = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);

export interface IngestResult {
  readonly applied: boolean; // false when the fill was a duplicate (already in the fill table)
  readonly record: OrderRecord; // the order after folding (unchanged on a duplicate)
}

// §6.6 — the ONE fill pipeline shared by every source (WS/paper exec reports, the SUBMIT/CANCEL
// query-loop backfill, and reconciliation's fetchMyTrades sweep). A fill is idempotent on
// (venue, symbol, venueTradeId): a duplicate applies nothing — no journal row, no position
// effect, no equity sample — so redelivery and overlap-window re-reads converge. cumQty advances
// by the freshly-inserted fill's qty (the in-memory mirror of "recomputed from the fill table",
// safe because the dedupe gate runs first); the resulting FILL fold is journaled under the
// caller's dedupeKey (reportId for stream fills, a reconcile key for backfills).
@Injectable()
export class FillIngestorService {
  constructor(
    @Inject(EXECUTION_STORE) private readonly store: ExecutionStorePort,
    @Inject(KILL_SWITCH) private readonly killSwitch: KillSwitchPort,
    private readonly orders: OrderBookService,
    private readonly portfolio: PortfolioStateService,
    private readonly sampler: EquitySamplerService,
    @Optional() @InjectMetric('fills_total') private readonly fillsCounter?: Counter<string>,
    @Optional()
    @InjectMetric('orders_filled_qty_total')
    private readonly filledQtyCounter?: Counter<string>,
    @Optional()
    @InjectMetric('orders_fully_filled_total')
    private readonly fullyFilledCounter?: Counter<string>,
    @Optional()
    @InjectMetric('order_slippage_decision_bps')
    private readonly slippageDecision?: Histogram<string>,
    @Optional()
    @InjectMetric('fees_paid_total')
    private readonly feesPaidCounter?: Counter<string>,
    @Optional()
    @InjectMetric('round_trips_total')
    private readonly roundTripsCounter?: Counter<string>,
    @Optional()
    @InjectMetric('trade_pnl_usdt')
    private readonly tradePnl?: Histogram<string>,
  ) {}

  async ingest(rec: OrderRecord, fill: FillRecord, dedupeKey: string): Promise<IngestResult> {
    const coid = fill.clientOrderId;
    const { inserted, conflict } = await this.store.saveFill(
      fill,
      decodeClientOrderId(coid).intentId,
    );
    // §6.6 I3 — a tradeId we already hold with a different payload is corruption; halt, never apply.
    if (conflict) {
      this.killSwitch.engage('FILL_PAYLOAD_CONFLICT', false);
      return { applied: false, record: rec };
    }
    if (!inserted) return { applied: false, record: rec };
    this.fillsCounter?.inc();

    const newCum = rec.cumQty.add(fill.qty); // cumulative; the dedupe above guarantees no double-count
    const next = reduce(rec, { type: 'FILL', cumQty: newCum });
    await this.store.appendOrderEvent({
      clientOrderId: coid,
      dedupeKey,
      event: { type: 'FILL', cumQty: newCum },
      derivedState: next.state,
      cumQty: next.cumQty.toFixed(),
    });
    this.orders.commit(next);

    const intent = this.portfolio.inFlightIntent(coid);
    if (intent !== undefined) {
      const application = this.portfolio.applyFill(intent, fill);
      // §8 fill-rate numerator + decision slippage. The .toNumber() calls are the sanctioned
      // export boundary; bps is signed so positive = adverse for both sides.
      this.filledQtyCounter?.inc(
        { type: intent.type, tif: intent.timeInForce },
        fill.qty.toNumber(),
      );
      const sign = intent.side === 'BUY' ? 1 : -1;
      const slipBps = fill.price
        .sub(intent.refPrice)
        .div(intent.refPrice)
        .mul(10000 * sign);
      this.slippageDecision?.observe(
        { venue: intent.venue, symbol: intent.symbol, side: intent.side, type: intent.type },
        slipBps.toNumber(),
      );
      if (next.state === 'FILLED') {
        this.fullyFilledCounter?.inc({ type: intent.type, tif: intent.timeInForce });
      }
      // §8 profitability. Fees are counted per fill; round-trip metrics fire only when the fill
      // closed the position to flat. .toNumber() is the sanctioned display export boundary.
      if (fill.fee) {
        this.feesPaidCounter?.inc({ ccy: fill.fee.ccy }, fill.fee.amount.toNumber());
      }
      // roundTripRealizedPnl is non-null exactly when the fill closed the position to flat
      // (== application.closedToFlat); the null-check both signals the round trip and narrows the
      // type. Net of quote fees, so >0 = win and ≤0 = loss (a fee-only wash nets a loss).
      if (application.roundTripRealizedPnl !== null) {
        const pnl = application.roundTripRealizedPnl;
        this.roundTripsCounter?.inc({ result: pnl.gt(0) ? 'win' : 'loss' });
        this.tradePnl?.observe(pnl.toNumber());
      }
    }
    if (TERMINAL.has(next.state)) {
      this.portfolio.clearInFlight(coid);
      this.portfolio.closeOrder(coid);
    }
    await this.sampler.sample(); // equity sampled on every fill (§8)
    return { applied: true, record: next };
  }
}
