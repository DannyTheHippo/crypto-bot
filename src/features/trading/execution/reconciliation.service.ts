import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectMetric, makeCounterProvider, makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import { Counter, Gauge } from 'prom-client';
import Decimal from 'decimal.js';
import { CLOCK, type ClockPort } from '../../../ports/clock';
import { KILL_SWITCH, type KillSwitchPort } from '../../../ports/risk';
import {
  EXCHANGE_PORT,
  type ExchangePort,
  type ExchangeOrderState,
  type VenueFill,
  type VenuePosition,
} from '../../../ports/exchange';
import {
  EXECUTION_STORE,
  RECON_CONFIG,
  type ExecutionStorePort,
  type ReconConfig,
} from '../../../ports/execution';
import { reduce, TransitionError, type OrderEvent } from '../../../domain/oms/reducer';
import { isOurClientOrderId } from '../../../domain/types/ids';
import { price, qty, feeAmount } from '../../../domain/types/money';
import {
  classifyVenueOpenOrder,
  balanceWithinEpsilon,
  driftStrictlyGrowing,
} from '../../../domain/oms/reconcile';
import type { ClientOrderId, SymbolId, EpochMs } from '../../../domain/types/ids';
import type { FillRecord } from '../../../domain/types/exec-report';
import { OrderBookService } from './order-book.service';
import { PortfolioStateService } from './portfolio-state.service';
import { FillIngestorService } from './fill-ingestor.service';

// Backlog #24: every mismatch carries a class so the counter (and its alert) can separate the
// shared-wallet foreign-order steady state and other benign classes from actionable ones. Halting
// classes keep their historical halts[] names; the warn-only classes had no in-code discriminator
// before this (only comments), so these names are the canonical taxonomy.
type MismatchClass =
  | 'unknown_ours_open' // halting: our COID prefix on the venue, no local row
  | 'fill_for_unknown_order' // halting: our-prefix trade, no local order
  | 'balance_drift' // halting: balance beyond ε
  | 'balance_leak' // halting: within ε but monotone-growing drift
  | 'position_drift' // halting: Defect A — venue/local signed-position qty beyond ε
  | 'foreign_open_order' // benign: manual trading on the shared key
  | 'adopted_terminal' // benign: a cancel/expiry we missed via the stream, adopted from venue truth
  | 'backfilled_fill' // benign: a fill we missed via the stream, re-applied
  | 'adopt_query_failure' // transient: order held open locally but fetchOrder failed
  | 'adopt_non_adoptable' // suspicious: venue status inconsistent with absence from open orders
  | 'sweep_failure'; // transient: a per-symbol open-orders/trades/balances sweep threw

interface PassAccumulator {
  readonly mismatches: Map<MismatchClass, number>;
  readonly halts: string[];
}

function bump(acc: PassAccumulator, cls: MismatchClass): void {
  acc.mismatches.set(cls, (acc.mismatches.get(cls) ?? 0) + 1);
}

function totalMismatches(acc: PassAccumulator): number {
  let total = 0;
  for (const n of acc.mismatches.values()) total += n;
  return total;
}

// Compact, redaction-safe error description for the reconciliations row: class name + a truncated
// message (ccxt errors can be verbose; secrets never appear in a class name, and the message cap
// bounds what a venue error body can drag into the row).
function describeError(err: unknown): string {
  const name = err instanceof Error ? err.constructor.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  return `${name}:${message}`.slice(0, 160);
}

// §8/§10 reconciliation_mismatch_total — incremented per pass by the pass's mismatch count, split
// by mismatch class since backlog #24 (a clean pass increments nothing — increase() handles the
// absent series). Registers to the default prom-client registry that /metrics scrapes; @Optional so
// the directly-constructed unit tests need not supply it. Drives the ReconciliationMismatch alert,
// which excludes the benign classes (foreign_open_order/adopted_terminal/backfilled_fill).
export const RECON_MISMATCH_COUNTER = makeCounterProvider({
  name: 'reconciliation_mismatch_total',
  help: 'Reconciliation mismatches detected per pass, by class (§6.4, backlog #24)',
  labelNames: ['class'] as const,
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
  private readonly positionDivergenceStreak = new Map<string, number>();

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(EXCHANGE_PORT) private readonly exchange: ExchangePort,
    @Inject(EXECUTION_STORE) private readonly store: ExecutionStorePort,
    @Inject(KILL_SWITCH) private readonly killSwitch: KillSwitchPort,
    @Inject(RECON_CONFIG) private readonly cfg: ReconConfig,
    private readonly orders: OrderBookService,
    private readonly portfolio: PortfolioStateService,
    private readonly ingestor: FillIngestorService,
    @Optional()
    @InjectMetric('reconciliation_mismatch_total')
    private readonly mismatchCounter?: Counter<string>,
    @Optional()
    @InjectMetric('reconciliation_runs_total')
    private readonly runsCounter?: Counter<string>,
    @Optional()
    @InjectMetric('reconciliation_last_success_timestamp_seconds')
    private readonly lastSuccessGauge?: Gauge<string>,
  ) {}

  async reconcile(): Promise<{ mismatches: number; halted: boolean }> {
    const acc: PassAccumulator = { mismatches: new Map(), halts: [] };

    // An axis throw past its own per-item guards must still land in the reconciliations row and the
    // runs counter — a pass that silently never completes is indistinguishable from a healthy idle
    // reconciler (exactly the failure mode that hid the symbol-less fetchOpenOrders throw for weeks).
    let passError: unknown;
    try {
      await this.reconcileOpenOrders(acc);
      await this.reconcileTrades(acc);
      if ((this.cfg.positionAxis ?? true) && this.exchange.fetchPositions !== undefined) {
        await this.reconcilePositions(acc);
      }
      if (this.cfg.balanceAxis) await this.reconcileBalances(acc);
    } catch (err) {
      passError = err;
    }

    const halted = acc.halts.length > 0;
    if (halted) this.killSwitch.engage(`RECONCILE_MISMATCH:${acc.halts.join(',')}`, false); // never auto-flatten

    const mismatchTotal = totalMismatches(acc);
    await this.store.saveReconciliation({
      ts: this.clock.now(),
      venue: this.exchange.venue,
      mismatches: mismatchTotal,
      halted,
      detail:
        passError !== undefined
          ? `PASS_ERROR:${describeError(passError)}`
          : acc.halts.join(',') || 'clean',
    });
    // Per-class increments (#24); a clean pass increments nothing — increase() over an absent
    // series is 0, so the alert semantics are unchanged from the old 0-inc.
    for (const [cls, n] of acc.mismatches) this.mismatchCounter?.inc({ class: cls }, n);
    const result =
      passError !== undefined
        ? 'error'
        : halted
          ? 'halt'
          : mismatchTotal > 0
            ? 'mismatch'
            : 'clean';
    this.runsCounter?.inc({ result });
    if (result === 'clean') this.lastSuccessGauge?.set(this.clock.now() / 1000);
    // Rethrow the ORIGINAL axis throw unchanged (whatever its type) so the driver's logged catch
    // surfaces the true cause.
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- original throw, type unknown
    if (passError !== undefined) throw passError;
    return { mismatches: mismatchTotal, halted };
  }

  // Axis 1 — open orders joined on clientOrderId. Swept PER SYMBOL: ccxt's binance throws on a
  // symbol-less fetchOpenOrders() by default (the global endpoint is rate-limit-punished), which
  // used to abort the whole pass before any row/counter was written. Cost of the per-symbol sweep:
  // FOREIGN orders on symbols outside the sweep set are no longer observed — acceptable, they were
  // WARN-only and the sweep set covers everything the bot trades or holds.
  //
  // Push 3 P7f fix 3: this whole axis is REGULAR-RAIL ONLY by construction, not by an explicit
  // filter here — `venueOpen` comes from fetchOpenOrders (which never returns an algo/conditional
  // order; that rail is fetchOpenAlgoOrders, a separate primitive) and `localOpen` comes from
  // portfolio.snapshot().openOrders, which execution-gate.service.ts's own fix 1 and
  // boot-recovery.service.ts's fix 3 both keep free of algo-rail orders (isAlgoRailIntent-gated at
  // their own registration sites). So neither `adoptTerminal`'s per-order fetchOrder query (never
  // sees an algo clientOrderId — no adopt_query_failure spam off this axis) nor UNKNOWN_OURS/
  // FOREIGN classification ever has an algo order to misclassify. A venue-side algo cancel/expiry
  // is the STRATEGY's own reconcile concern (AgenticStrategy.manageVenueStopPerp's
  // fetchOpenAlgoOrders scan, plus HaltCoordinatorService's registry sweep — Push 3 P7f fix 7),
  // never this service's — the algo rail's boot truth lives there, not in this axis or in
  // boot-recovery's regular-rail restore.
  private async reconcileOpenOrders(acc: PassAccumulator): Promise<void> {
    const venueOpen: ExchangeOrderState[] = [];
    const failedSymbols = new Set<SymbolId>();
    for (const symbol of this.sweepSymbols()) {
      try {
        venueOpen.push(...(await this.exchange.fetchOpenOrders(symbol)));
      } catch {
        bump(acc, 'sweep_failure'); // could not sweep this symbol's open orders — surfaced, re-checked next pass
        failedSymbols.add(symbol);
      }
    }
    const localOpen = this.portfolio.snapshot().openOrders;
    const localCoids = new Set<string>(localOpen.map((o) => o.clientOrderId));
    const venueCoids = new Set<string>(venueOpen.map((o) => o.clientOrderId));

    for (const vo of venueOpen) {
      const verdict = classifyVenueOpenOrder(vo.clientOrderId, localCoids.has(vo.clientOrderId));
      if (verdict === 'UNKNOWN_OURS') {
        bump(acc, 'unknown_ours_open');
        acc.halts.push('UNKNOWN_OURS_OPEN'); // I1: our prefix, no local row ⇒ corruption (no auto-cancel)
      } else if (verdict === 'FOREIGN') {
        bump(acc, 'foreign_open_order'); // manual trading on the key — WARN + ignore
      }
    }

    // Local order we believe open but the venue does not list: adopt the venue's terminal truth.
    // Skipped for symbols whose sweep failed — absence there is fetch failure, not venue truth
    // (adoptTerminal re-queries per order anyway, but there is no point burning calls on a venue
    // that just refused the symbol).
    for (const lo of localOpen) {
      if (venueCoids.has(lo.clientOrderId)) continue;
      if (failedSymbols.has(lo.symbol)) continue;
      await this.adoptTerminal(lo.clientOrderId, lo.symbol, acc);
    }
  }

  private async adoptTerminal(
    coid: ClientOrderId,
    symbol: SymbolId,
    acc: PassAccumulator,
  ): Promise<void> {
    let venue: ExchangeOrderState;
    try {
      venue = await this.exchange.fetchOrder(coid, symbol);
    } catch {
      bump(acc, 'adopt_query_failure'); // an order we hold open but cannot query — surfaced, re-checked next pass
      return;
    }
    const event = this.terminalEventFor(venue.status);
    if (event === undefined) {
      bump(acc, 'adopt_non_adoptable'); // 'open'/'closed' here is inconsistent with absence from open orders — WARN
      return;
    }
    bump(acc, 'adopted_terminal'); // adopting a terminal we missed via the stream
    try {
      await this.fold(coid, event);
    } catch (err) {
      // A fold the reducer refuses is that one order's problem, never the pass's: rethrowing here
      // turned a single stranded CANCEL_PENDING order into 100% reconcile downtime on 2026-07-07
      // (the trades/balances axes never ran). The mismatch above stands and the order is
      // re-examined next pass; anything but a state-machine refusal still aborts as before.
      if (!(err instanceof TransitionError)) throw err;
    }
  }

  // Only the terminals an open (ACKED/PARTIALLY_FILLED) order may LEGALLY reach are adopted:
  // canceled and expired. 'rejected' is reachable only from SUBMITTING, so a venue 'rejected' on an
  // order we already hold an ack for is a contradiction, not an adopt — surfaced as a WARN (and the
  // reducer would reject the illegal fold anyway). 'open'/'closed' are likewise non-adopt here.
  private terminalEventFor(status: ExchangeOrderState['status']): OrderEvent | undefined {
    switch (status) {
      case 'canceled':
        return { type: 'VENUE_CANCELED' };
      case 'expired':
        return { type: 'VENUE_EXPIRED' };
      default:
        return undefined;
    }
  }

  // Axis 2 — trades since the per-(venue,symbol) checkpoint minus an overlap window.
  private async reconcileTrades(acc: PassAccumulator): Promise<void> {
    for (const symbol of this.sweepSymbols()) {
      const key = `${this.exchange.venue}|${symbol}`;
      const checkpoint = this.checkpoints.get(key) ?? (0 as EpochMs);
      const since = Math.max(0, checkpoint - this.cfg.overlapMs) as EpochMs;
      let trades: readonly VenueFill[];
      try {
        trades = await this.exchange.fetchMyTrades(symbol, since);
      } catch {
        bump(acc, 'sweep_failure'); // could not sweep this symbol's trades — surfaced
        continue;
      }
      for (const t of trades) {
        await this.reconcileTrade(t, acc);
        if (t.venueTimestamp > (this.checkpoints.get(key) ?? 0))
          this.checkpoints.set(key, t.venueTimestamp);
      }
    }
  }

  private async reconcileTrade(t: VenueFill, acc: PassAccumulator): Promise<void> {
    if (!isOurClientOrderId(t.clientOrderId)) return; // foreign trade on the key — ignore
    const rec = this.orders.get(t.clientOrderId);
    if (rec === undefined) {
      bump(acc, 'fill_for_unknown_order');
      acc.halts.push('FILL_FOR_UNKNOWN_ORDER'); // our prefix, no local order ⇒ corruption (§6.4)
      return;
    }
    const { applied } = await this.ingestor.ingest(
      rec,
      this.toFillRecord(t),
      `reconcile:${t.venueTradeId}`,
    );
    if (applied) bump(acc, 'backfilled_fill'); // a fill we had missed via the stream — backfilled + WARN
  }

  // Axis 3 (Defect A fail-closed backstop) — venue net signed position per symbol vs the local
  // aggregate. PERP-ONLY by config (positionAxis, set in reconConfigFrom): the shared adapter
  // defines fetchPositions on every venue (vacuous off-perp) while the local positions map holds
  // spot positions too, so method presence alone must never enable this axis. This is the backstop
  // for exactly the geometry an unrecovered venue-fired algo stop produces (a phantom local
  // position with no venue counterpart, or vice versa) when AlgoStopRecoveryService's own retries
  // never resolve it. Safety gate, fail CLOSED — but debounced ONE pass: a fired stop flattens the
  // venue instantly while the local book heals only when recovery runs (≤10s fill poll), and the
  // 30s reconcile timer is independent, so the FIRST divergent pass records the mismatch without
  // halting and the SECOND consecutive one HALTs through the same kill-switch path as every other
  // axis — never an order, never a flatten (CLAUDE.md rule 6). A divergence that outlives a full
  // reconcile period is precisely the unrecovered case the axis exists for.
  private async reconcilePositions(acc: PassAccumulator): Promise<void> {
    const symbols = this.sweepSymbols();
    let venuePositions: readonly VenuePosition[];
    try {
      venuePositions = await this.exchange.fetchPositions!(symbols);
    } catch {
      bump(acc, 'sweep_failure'); // could not read venue positions — surfaced, re-checked next pass (fail OPEN)
      return;
    }
    const venueBySymbol = new Map<string, Decimal>();
    for (const p of venuePositions) venueBySymbol.set(p.symbol, new Decimal(p.signedQty));

    const localBySymbol = new Map<string, Decimal>();
    for (const p of this.portfolio.snapshot().positions.values()) {
      if (p.venue !== this.exchange.venue) continue;
      const prior = localBySymbol.get(p.symbol) ?? new Decimal(0);
      localBySymbol.set(p.symbol, prior.add(p.signedQty));
    }

    for (const symbol of symbols) {
      const venueQty = venueBySymbol.get(symbol) ?? new Decimal(0);
      const localQty = localBySymbol.get(symbol) ?? new Decimal(0);
      const within = balanceWithinEpsilon(localQty, venueQty, this.cfg.epsAbs, this.cfg.epsRel);
      if (!within) {
        bump(acc, 'position_drift'); // counted every divergent pass — visibility precedes the halt
        const streak = (this.positionDivergenceStreak.get(symbol) ?? 0) + 1;
        this.positionDivergenceStreak.set(symbol, streak);
        if (streak >= 2) {
          acc.halts.push(`POSITION_DRIFT:${symbol}`); // second consecutive divergent pass ⇒ HALT, no auto-flatten
        }
      } else {
        this.positionDivergenceStreak.delete(symbol);
      }
    }
  }

  // Axis 4 — balances per asset within ε; within-ε drift recorded, monotone growth escalates.
  private async reconcileBalances(acc: PassAccumulator): Promise<void> {
    let venueBalances: ReadonlyMap<string, { free: string; locked: string }>;
    try {
      venueBalances = await this.exchange.fetchBalances();
    } catch {
      bump(acc, 'sweep_failure');
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
        bump(acc, 'balance_drift');
        acc.halts.push(`BALANCE_DRIFT:${asset}`); // beyond ε ⇒ HALT, no auto-flatten
      } else if (driftStrictlyGrowing(history, this.cfg.driftPasses)) {
        bump(acc, 'balance_leak');
        acc.halts.push(`BALANCE_LEAK:${asset}`); // within ε but a systematic, growing leak ⇒ HALT
      }
    }
  }

  // The configured trading universe unioned with symbols carrying live local state — so the sweeps
  // observe venue truth even before the bot holds anything, and keep observing residue after a
  // config change drops a symbol.
  private sweepSymbols(): SymbolId[] {
    const snap = this.portfolio.snapshot();
    const set = new Set<SymbolId>(this.cfg.sweepSymbols as SymbolId[]);
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
      clientOrderId: coid,
      dedupeKey: `reconcile:${event.type}`,
      event,
      derivedState: next.state,
      cumQty: next.cumQty.toFixed(),
    });
    if (!applied) return;
    this.orders.commit(next);
    this.portfolio.clearInFlight(coid);
    this.portfolio.closeOrder(coid);
  }

  private toFillRecord(t: VenueFill): FillRecord {
    return {
      venue: t.venue,
      symbol: t.symbol,
      venueTradeId: t.venueTradeId,
      clientOrderId: t.clientOrderId,
      price: price(t.price),
      qty: qty(t.qty),
      fee: t.fee ? { ccy: t.fee.ccy, amount: feeAmount(t.fee.amount) } : null,
      liquidity: t.liquidity,
      venueTimestamp: t.venueTimestamp,
      source: 'rest_reconcile',
    };
  }
}
