import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectMetric, makeCounterProvider, makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import { Counter, Gauge } from 'prom-client';
import Decimal from 'decimal.js';
import { CLOCK, type ClockPort } from '../../../ports/clock';
import { KILL_SWITCH, type KillSwitchPort } from '../../../ports/risk';
import {
  EXCHANGE_PORT,
  VENUE_EXCHANGE_PORTS,
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
import {
  reduce,
  TransitionError,
  TERMINAL_ORDER_STATES,
  type OrderEvent,
  type OrderRecord,
} from '../../../domain/oms/reducer';
import { isOurClientOrderId, type VenueId } from '../../../domain/types/ids';
import { venueForSymbol } from '../../../domain/types/venue-map';
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
import { VENUE_REGISTRY, type VenueRuntimeDescriptor } from '../../../ports/venue-registry';
import { OPS_EVENTS, type OpsEventPort } from '../../../ports/observability';

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
  help: 'Reconciliation passes by venue and result (v3 spec §8 — one series per per-venue pass)',
  labelNames: ['venue', 'result'] as const,
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
  private readonly log = new Logger('Reconciliation');
  // RecoveryCoordinatorService's own universal precondition read (owner-authorized auto-resume,
  // 2026-07-22): the wall-clock of the last pass that closed with zero mismatches and no halt,
  // across every venue this call covered. Stamped ONLY inside reconcile() below — never by a second,
  // independently-triggered pass — because reconcile()/reconcileOnce() mutate this.checkpoints/
  // driftHistory/positionDivergenceStreak without a re-entrancy lock; a second concurrent caller
  // could interleave with the scheduled 30s pass (trading-runtime.module.ts) and corrupt that state.
  // RecoveryCoordinatorService reads this via cleanWithin() instead of calling reconcile() itself.
  private lastCleanAt: EpochMs | undefined;
  // Security-review fix (2026-07-22, M1-residual): the wall-clock of the last pass that did NOT close
  // clean — a mismatch/halt pass OR a pass that threw before completing. Stamped in the SAME one place
  // (reconcile() below) and symmetric to lastCleanAt. cleanWithin/cleanAfter only bound the AGE and
  // post-halt-freshness of the last CLEAN stamp; neither notices a fresh DIRTY pass landing after that
  // stamp when the halt's reason string is byte-identical (reconcileOnce re-engages the same
  // `RECONCILE_MISMATCH:<halts>` string every dirty pass, so RecoveryCoordinatorService's
  // reason-change-keyed haltedSinceAt never re-arms). cleanIsLatest() below closes that hole: a clean
  // stamp only counts if NO non-clean pass has run since. An errored pass counts as non-clean
  // (fail-closed: "could not confirm" is never "confirmed clean").
  private lastMismatchAt: EpochMs | undefined;
  // The currently-running pass, or undefined when idle — see reconcile()'s own re-entrancy comment.
  // Concurrent callers coalesce onto this instead of starting an interleaved second pass.
  private inFlight: Promise<{ mismatches: number; halted: boolean }> | undefined;

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    // Legacy single-venue path — kept exactly as-is for module-isolation boot specs and the existing
    // reconciliation.spec.ts fixture, which construct this service directly with one exchange/cfg
    // pair. Production (v3) wiring instead supplies venuePorts/venueRegistry below; when BOTH are
    // present reconcile() iterates VENUE_REGISTRY (§1.5) and this single exchange/cfg pair is unused.
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
    // v3 §1.5: one venue-keyed exchange port per registry venue. @Optional so every pre-existing
    // construction site (single-venue boot specs, reconciliation.spec.ts) compiles and behaves
    // unchanged — reconcile() falls back to the single this.exchange/this.cfg pair whenever either
    // of these is absent or the registry is empty.
    @Optional()
    @Inject(VENUE_EXCHANGE_PORTS)
    private readonly venuePorts?: ReadonlyMap<VenueId, ExchangePort>,
    @Optional()
    @Inject(VENUE_REGISTRY)
    private readonly venueRegistry?: ReadonlyMap<VenueId, VenueRuntimeDescriptor>,
    // Backlog #52: diagnostic side-channel, never a control-flow input — @Optional so every
    // pre-existing direct-construction unit test keeps constructing without it (OpsEventsModule
    // binds the real one at the composition root).
    @Optional()
    @Inject(OPS_EVENTS)
    private readonly opsEvents?: OpsEventPort,
  ) {}

  // v3 §1.5: one pass per venue per tick, one reconciliations row per venue pass. Mismatches sum
  // across venues; halted is true if ANY venue's pass halted (the kill switch is one book-level
  // instance — engaging it for one venue's mismatch already stops the whole book, §1.3). A per-venue
  // axis throw is isolated to that venue's pass (caught inside reconcileOnce) so one venue's outage
  // never prevents the other venue's pass — or its own reconciliations row — from completing.
  // RE-ENTRANCY GUARD (security review, 2026-07-22): the scheduled driver is an UNGUARDED
  // setInterval(30_000) fire-and-forget (trading-runtime.module.ts), while ONE pass issues ~80 strictly
  // sequential REST calls (40 symbols × fetchOpenOrders/fetchMyTrades, venues serialized in
  // reconcileEveryVenue, plus per-order adoptTerminal fetchOrder). A pass exceeding the 30s interval —
  // hence a SECOND concurrent caller — is routine at the committed basket size, not exotic. That is
  // exactly the hazard lastCleanAt's own field comment names (checkpoints/driftHistory/
  // positionDivergenceStreak are mutated without a lock and would interleave), and it also let a slow
  // CLEAN pass land its stamp AFTER a newer pass had already found a divergence. Concurrent callers now
  // coalesce onto the in-flight pass instead of starting a second one.
  async reconcile(): Promise<{ mismatches: number; halted: boolean }> {
    const inFlight = this.inFlight;
    if (inFlight !== undefined) {
      // Visible, never silent: a chronically slow reconciler must show up as skipped passes rather than
      // as a mysteriously idle cadence (the same "a silent skip once hid a per-pass throw for weeks"
      // lesson the driver's own catch comment records).
      //
      // A MODERATE SKIP RATE IS EXPECTED AND HEALTHY — do not read it as a fault. Measured in the
      // 2026-07-22 soak: 62 skips/hour against 57-58 completed passes per venue (119 ≈ the 120 ticks
      // an hour of 30s ticks produces). Because a pass takes ~60s, the 30s interval means a fresh pass
      // starts almost immediately after the previous one ends — the skipped ticks act as the retry that
      // keeps passes running BACK-TO-BACK, which is the best available cadence. Widening the interval
      // to "stop the skips" would make it strictly worse (a 60s tick landing mid-pass would skip to
      // 120s). What IS alarming: a sustained 100% skip rate, or completed-pass count trending toward
      // zero — that means a pass is wedged, not merely slow.
      this.log.warn(
        'reconcile pass still in flight — skipping this tick (coalesced onto the running pass)',
      );
      this.runsCounter?.inc({ venue: 'all', result: 'skipped' });
      return inFlight;
    }
    const run = this.runOnePass();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async runOnePass(): Promise<{ mismatches: number; halted: boolean }> {
    // ASYMMETRIC STAMPING, deliberately fail-closed (security review, 2026-07-22). A CLEAN verdict is
    // credited to the instant the pass STARTED — the earliest moment its observations could describe —
    // never to completion. A multi-second pass that read venue truth at t0 and returns clean at t0+45s
    // would otherwise stamp a "clean" newer than a divergence detected at t0+25s by another pass,
    // satisfying cleanWithin/cleanAfter/cleanIsLatest and resuming into the un-cleared divergence.
    // A NON-clean verdict is stamped at completion (and, for a halt, at DETECTION inside reconcileOnce),
    // i.e. always the LATEST possible instant — so the clean-vs-dirty comparison can never favour clean.
    const startedAt = this.clock.now();
    let result: { mismatches: number; halted: boolean };
    try {
      result = await this.reconcileEveryVenue();
    } catch (err) {
      // A pass that threw before completing is NOT a clean confirmation — mark the latest outcome
      // non-clean so cleanIsLatest() blocks auto-resume until a fresh clean pass genuinely runs (a
      // persisting error also independently ages out cleanWithin). Fail CLOSED.
      this.lastMismatchAt = this.clock.now();
      throw err;
    }
    if (result.mismatches === 0 && !result.halted) {
      this.lastCleanAt = startedAt;
    } else {
      this.lastMismatchAt = this.clock.now();
    }
    return result;
  }

  private async reconcileEveryVenue(): Promise<{ mismatches: number; halted: boolean }> {
    if (this.venuePorts && this.venueRegistry && this.venueRegistry.size > 0) {
      let mismatches = 0;
      let halted = false;
      for (const descriptor of this.venueRegistry.values()) {
        const port = this.venuePorts.get(descriptor.venue);
        if (!port) {
          this.log.error(`no exchange port registered for venue "${descriptor.venue}" — skipping`);
          continue;
        }
        const result = await this.reconcileOnce(port, this.venueReconConfig(descriptor));
        mismatches += result.mismatches;
        halted = halted || result.halted;
      }
      return { mismatches, halted };
    }
    return this.reconcileOnce(this.exchange, this.cfg);
  }

  // Read-only, no network: RecoveryCoordinatorService's own "reconcile clean" universal precondition,
  // WITHOUT triggering a second concurrent reconcile() call (see lastCleanAt's own comment on why
  // that would be unsafe). Fail-closed by construction: `maxAgeMs` bounds how stale "clean" may be —
  // a scheduler outage (no reconcile() call inside the window) reads as NOT clean, never a
  // permanently-stale true.
  cleanWithin(maxAgeMs: number, now: EpochMs): boolean {
    return this.lastCleanAt !== undefined && now - this.lastCleanAt <= maxAgeMs;
  }

  // Security-review fix (2026-07-22, M1): cleanWithin ALONE is a staleness bound, not a "cleared
  // SINCE this problem started" bound — a reconcile pass that ran clean 45s BEFORE a halt engaged
  // still reads as "fresh" for up to RECONCILE_FRESHNESS_MS after the halt, letting
  // RecoveryCoordinatorService resume a RECONCILE_MISMATCH halt in ~2 ticks without a SINGLE fresh
  // post-halt reconcile pass ever having re-examined the diverged state. `haltedAt` is the caller's
  // own record of when the CURRENTLY-active problem was flagged (RecoveryCoordinatorService tracks
  // this off killSwitch.reason() changes, never here — this service has no halt-timing knowledge of
  // its own). Fail closed via strict `>`: a clean pass at the EXACT halt instant does not count (it
  // cannot have observed the problem that caused the halt).
  cleanAfter(haltedAt: EpochMs): boolean {
    return this.lastCleanAt !== undefined && this.lastCleanAt > haltedAt;
  }

  // Security-review fix (2026-07-22, M1-residual): the LATEST reconcile pass closed clean — no
  // mismatch/halt/errored pass has run since the last clean stamp. cleanWithin (staleness) and
  // cleanAfter (post-halt freshness) both check only whether SOME clean stamp exists in their window;
  // neither notices a fresh DIRTY pass landing after a clean stamp when the re-halt reason string is
  // byte-identical (reconcileOnce re-engages `RECONCILE_MISMATCH:<halts>` verbatim every dirty pass,
  // so RecoveryCoordinatorService's reason-change-keyed haltedSinceAt never re-arms). Requiring
  // lastCleanAt > lastMismatchAt closes that hole regardless of the reason string. Fail CLOSED: never
  // stamped clean ⇒ false; a dirty/errored pass at the SAME instant as the clean stamp (strict >) ⇒
  // false.
  cleanIsLatest(): boolean {
    if (this.lastCleanAt === undefined) return false;
    return this.lastMismatchAt === undefined || this.lastCleanAt > this.lastMismatchAt;
  }

  // §1.5: per-venue tunables derived from the registry descriptor, sharing the base config's
  // epsAbs/epsRel/overlapMs/driftPasses. balanceAxis is off when the venue's environment is 'demo'
  // (a shared multi-asset demo account the bot does not own end-to-end — same rationale as v2's
  // testnet+demo carve-out, now keyed off the venue's OWN environment instead of the whole boot's
  // sandbox flavor); positionAxis mirrors perpCapable exactly (Defect A's axis is perp-only by
  // construction); sweepSymbols is the venue's own symbol subset.
  private venueReconConfig(descriptor: VenueRuntimeDescriptor): ReconConfig {
    return {
      ...this.cfg,
      balanceAxis: descriptor.config.environment !== 'demo',
      positionAxis: descriptor.perpCapable,
      sweepSymbols: descriptor.symbols,
    };
  }

  private async reconcileOnce(
    exchange: ExchangePort,
    cfg: ReconConfig,
  ): Promise<{ mismatches: number; halted: boolean }> {
    const acc: PassAccumulator = { mismatches: new Map(), halts: [] };

    // An axis throw past its own per-item guards must still land in the reconciliations row and the
    // runs counter — a pass that silently never completes is indistinguishable from a healthy idle
    // reconciler (exactly the failure mode that hid the symbol-less fetchOpenOrders throw for weeks).
    let passError: unknown;
    try {
      await this.reconcileOpenOrders(exchange, cfg, acc);
      await this.reconcileTrades(exchange, cfg, acc);
      if ((cfg.positionAxis ?? true) && exchange.fetchPositions !== undefined) {
        await this.reconcilePositions(exchange, cfg, acc);
      }
      if (cfg.balanceAxis) await this.reconcileBalances(exchange, cfg, acc);
    } catch (err) {
      passError = err;
    }

    const halted = acc.halts.length > 0;
    if (halted) {
      // Stamped at DETECTION, atomically with the engage — NOT at the end of the pass (security review,
      // 2026-07-22). A multi-venue pass halts on venue A and then keeps sweeping venue B's 16 symbols
      // for seconds afterward; stamping only in runOnePass would leave cleanIsLatest() reading true for
      // that whole window, long enough for RecoveryCoordinatorService's 2-tick debounce to fit inside it
      // and auto-resume on a divergence THIS pass had already found. Fail CLOSED: the divergence counts
      // from the instant it is known.
      this.lastMismatchAt = this.clock.now();
      this.killSwitch.engage(`RECONCILE_MISMATCH:${acc.halts.join(',')}`, false); // never auto-flatten
    }

    const mismatchTotal = totalMismatches(acc);
    await this.store.saveReconciliation({
      ts: this.clock.now(),
      venue: exchange.venue,
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
    this.runsCounter?.inc({ venue: exchange.venue, result });
    if (result === 'clean') this.lastSuccessGauge?.set(this.clock.now() / 1000);
    this.opsEvents?.emit({
      event: 'reconcile.pass',
      result,
      mismatchClasses: [...acc.mismatches.keys()],
      venue: exchange.venue,
    });
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
  private async reconcileOpenOrders(
    exchange: ExchangePort,
    cfg: ReconConfig,
    acc: PassAccumulator,
  ): Promise<void> {
    const venueOpen: ExchangeOrderState[] = [];
    const failedSymbols = new Set<SymbolId>();
    for (const symbol of this.sweepSymbols(exchange, cfg)) {
      try {
        venueOpen.push(...(await exchange.fetchOpenOrders(symbol)));
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
      await this.adoptTerminal(exchange, lo.clientOrderId, lo.symbol, acc);
    }
  }

  private async adoptTerminal(
    exchange: ExchangePort,
    coid: ClientOrderId,
    symbol: SymbolId,
    acc: PassAccumulator,
  ): Promise<void> {
    let venueOrder: ExchangeOrderState;
    try {
      venueOrder = await exchange.fetchOrder(coid, symbol);
    } catch {
      bump(acc, 'adopt_query_failure'); // an order we hold open but cannot query — surfaced, re-checked next pass
      return;
    }
    const event = this.terminalEventFor(venueOrder.status);
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
  private async reconcileTrades(
    exchange: ExchangePort,
    cfg: ReconConfig,
    acc: PassAccumulator,
  ): Promise<void> {
    // MATCHING (mirrors demo-fill-poller.service.ts): ccxt's unified myTrades carries `order` = the
    // VENUE numeric order id as VenueFill.clientOrderId (Binance has no clientOrderId on myTrades),
    // so a trade is resolved to a local order via the venueOrderId recorded on ACK first — the
    // cb-prefix coid lookup below only ever matches an adapter (paper) that echoes our own
    // clientOrderId directly. Built once per pass, not per trade (this.orders.all() is a full scan).
    const byVenueId = new Map<string, OrderRecord>();
    for (const rec of this.orders.all()) {
      if (rec.venueOrderId !== undefined) byVenueId.set(rec.venueOrderId, rec);
    }
    for (const symbol of this.sweepSymbols(exchange, cfg)) {
      const key = `${exchange.venue}|${symbol}`;
      const checkpoint = this.checkpoints.get(key) ?? (0 as EpochMs);
      const since = Math.max(0, checkpoint - cfg.overlapMs) as EpochMs;
      let trades: readonly VenueFill[];
      try {
        trades = await exchange.fetchMyTrades(symbol, since);
      } catch {
        bump(acc, 'sweep_failure'); // could not sweep this symbol's trades — surfaced
        continue;
      }
      for (const t of trades) {
        await this.reconcileTrade(exchange, t, byVenueId, acc);
        if (t.venueTimestamp > (this.checkpoints.get(key) ?? 0))
          this.checkpoints.set(key, t.venueTimestamp);
      }
    }
  }

  private async reconcileTrade(
    exchange: ExchangePort,
    t: VenueFill,
    byVenueId: ReadonlyMap<string, OrderRecord>,
    acc: PassAccumulator,
  ): Promise<void> {
    // FIRST FILTER (2026-07-19 spot-lane false-HALT): an already-recorded fill is a pure no-op no
    // matter how it would classify below. Checked BEFORE any classification — without this, a
    // long-terminal order the checkpoint/overlap window keeps re-surfacing (the symbol went quiet,
    // so the checkpoint never advances past it) re-triggers tier-2's durable lookup, and re-halts,
    // on EVERY pass forever. This alone stops the recurrence; tier-2's terminal/non-terminal split
    // below is what makes the (rarer) genuinely-new backfill and the genuinely-lost-state HALT land
    // correctly once this filter has ruled out "already seen it."
    if (await this.store.hasFill(t.venue, t.symbol, t.venueTradeId)) return;

    const viaVenueId = byVenueId.get(t.clientOrderId);
    if (viaVenueId !== undefined) {
      await this.applyTrade(t, viaVenueId, acc);
      return;
    }
    if (isOurClientOrderId(t.clientOrderId)) {
      // Our own coid literally appears on the trade (the paper adapter's shape, or a genuine venue
      // echo). I1's write-ahead makes "our prefix, no local row" impossible except corruption —
      // unconditional HALT, exactly the pre-cluster-A axis-2 semantics. Never routed through the
      // durable venue-order-id lookup below: that question (does SOME order of ours own this venue
      // order id?) does not apply here — the trade already names OUR clientOrderId, not a venue id.
      const rec = this.orders.get(t.clientOrderId);
      if (rec === undefined) {
        bump(acc, 'fill_for_unknown_order');
        acc.halts.push('FILL_FOR_UNKNOWN_ORDER'); // our prefix, no local order ⇒ corruption (§6.4)
        return;
      }
      await this.applyTrade(t, rec, acc);
      return;
    }
    // Not our coid and unresolved via the venueOrderId index: on the real venue this is the ccxt
    // myTrades shape (a bare numeric venue order id), which could be one of OUR orders or a
    // stranger's manual trade on the account — ambiguous from the trade alone. Second tier before
    // concluding "foreign": I1's write-ahead persists the order durably before any network call, so
    // a venue order id this process's own store still holds is OURS, not a stranger's — but WHICH
    // classification depends on whether that durable order is terminal:
    //   • non-terminal (should still be live but the in-memory projection was lost — crash, a second
    //     instance, a recovery gap) ⇒ corruption, HALT — unchanged, fail closed (rule 6).
    //   • terminal (FILLED/CANCELED/EXPIRED — boot recovery deliberately never rehydrates these, per
    //     loadOpenOrders' WHERE terminal_at IS NULL) AND the filter above already ruled out
    //     already-recorded ⇒ this IS the missed-fill recovery this axis exists for, just discovered
    //     via the durable tier instead of the in-memory index — ingest it.
    const durable = await this.store.loadOrderByVenueOrderId(exchange.venue, t.clientOrderId);
    if (durable !== null) {
      if (TERMINAL_ORDER_STATES.has(durable.state)) {
        await this.applyTrade(t, durable, acc);
        return;
      }
      bump(acc, 'fill_for_unknown_order');
      acc.halts.push('FILL_FOR_UNKNOWN_ORDER'); // non-terminal + lost in memory ⇒ corruption (§6.4)
      return;
    }
    // Neither in-memory nor durable resolves it: genuinely foreign (manual account activity) — WARN-free ignore.
    this.log.debug(
      `ignoring foreign trade ${t.venueTradeId} on ${t.symbol} (venue order id ${t.clientOrderId})`,
    );
  }

  private async applyTrade(t: VenueFill, rec: OrderRecord, acc: PassAccumulator): Promise<void> {
    const { applied } = await this.ingestor.ingest(
      rec,
      this.toFillRecord(t, rec.clientOrderId),
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
  private async reconcilePositions(
    exchange: ExchangePort,
    cfg: ReconConfig,
    acc: PassAccumulator,
  ): Promise<void> {
    const symbols = this.sweepSymbols(exchange, cfg);
    let venuePositions: readonly VenuePosition[];
    try {
      venuePositions = await exchange.fetchPositions!(symbols);
    } catch {
      bump(acc, 'sweep_failure'); // could not read venue positions — surfaced, re-checked next pass (fail OPEN)
      return;
    }
    const venueBySymbol = new Map<string, Decimal>();
    for (const p of venuePositions) venueBySymbol.set(p.symbol, new Decimal(p.signedQty));

    const localBySymbol = new Map<string, Decimal>();
    for (const p of this.portfolio.snapshot().positions.values()) {
      if (p.venue !== exchange.venue) continue;
      const prior = localBySymbol.get(p.symbol) ?? new Decimal(0);
      localBySymbol.set(p.symbol, prior.add(p.signedQty));
    }

    for (const symbol of symbols) {
      const venueQty = venueBySymbol.get(symbol) ?? new Decimal(0);
      const localQty = localBySymbol.get(symbol) ?? new Decimal(0);
      const within = balanceWithinEpsilon(localQty, venueQty, cfg.epsAbs, cfg.epsRel);
      // v3: keyed by venue+symbol (not symbol alone) — two venues can share a base asset's ticker
      // shape but never the same streak bucket, so a spot-side divergence can never mask or amplify
      // a perp-side one sharing the same symbol string.
      const streakKey = `${exchange.venue}|${symbol}`;
      if (!within) {
        bump(acc, 'position_drift'); // counted every divergent pass — visibility precedes the halt
        const streak = (this.positionDivergenceStreak.get(streakKey) ?? 0) + 1;
        this.positionDivergenceStreak.set(streakKey, streak);
        if (streak >= 2) {
          acc.halts.push(`POSITION_DRIFT:${symbol}`); // second consecutive divergent pass ⇒ HALT, no auto-flatten
        }
      } else {
        this.positionDivergenceStreak.delete(streakKey);
      }
    }
  }

  // Axis 4 — balances per asset within ε; within-ε drift recorded, monotone growth escalates.
  private async reconcileBalances(
    exchange: ExchangePort,
    cfg: ReconConfig,
    acc: PassAccumulator,
  ): Promise<void> {
    let venueBalances: ReadonlyMap<string, { free: string; locked: string }>;
    try {
      venueBalances = await exchange.fetchBalances();
    } catch {
      bump(acc, 'sweep_failure');
      return;
    }
    const local = this.portfolio.snapshot().balances;
    for (const [asset, bal] of local) {
      const localTotal = bal.free.add(bal.locked);
      const v = venueBalances.get(asset);
      const venueTotal = v ? new Decimal(v.free).add(new Decimal(v.locked)) : new Decimal(0);
      const within = balanceWithinEpsilon(localTotal, venueTotal, cfg.epsAbs, cfg.epsRel);
      const drift = venueTotal.sub(localTotal).abs();
      // v3: keyed by venue+asset — the spot USDT wallet and the perp USDT margin balance are
      // DIFFERENT balances that happen to share an asset ticker; a shared per-asset-only key would
      // let one venue's growing leak reset or double-count against the other's history.
      const historyKey = `${exchange.venue}|${asset}`;
      const history = this.driftHistory.get(historyKey) ?? [];
      history.push(drift);
      // driftStrictlyGrowing only ever reads the last cfg.driftPasses entries — trim the front so
      // this per-asset array does not grow one Decimal per pass forever.
      if (history.length > cfg.driftPasses) history.splice(0, history.length - cfg.driftPasses);
      this.driftHistory.set(historyKey, history);

      if (!within) {
        bump(acc, 'balance_drift');
        acc.halts.push(`BALANCE_DRIFT:${asset}`); // beyond ε ⇒ HALT, no auto-flatten
      } else if (driftStrictlyGrowing(history, cfg.driftPasses)) {
        bump(acc, 'balance_leak');
        acc.halts.push(`BALANCE_LEAK:${asset}`); // within ε but a systematic, growing leak ⇒ HALT
      }
    }
  }

  // The configured trading universe unioned with symbols carrying live local state — so the sweeps
  // observe venue truth even before the bot holds anything, and keep observing residue after a
  // config change drops a symbol. v3: local open orders/positions are filtered to THIS venue only —
  // the book-level portfolio holds both venues' state, and sweeping a spot symbol against the perp
  // exchange port (or vice versa) would mis-query venue truth entirely.
  private sweepSymbols(exchange: ExchangePort, cfg: ReconConfig): SymbolId[] {
    const snap = this.portfolio.snapshot();
    const set = new Set<SymbolId>(cfg.sweepSymbols as SymbolId[]);
    // OpenOrderSummary carries no venue field — venue is a pure function of symbol (venueForSymbol),
    // so deriving it here needs no widening of that DTO (owned by workstream #8).
    for (const o of snap.openOrders)
      if (venueForSymbol(o.symbol) === exchange.venue) set.add(o.symbol);
    for (const p of snap.positions.values()) if (p.venue === exchange.venue) set.add(p.symbol);
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

  private toFillRecord(t: VenueFill, coid: ClientOrderId): FillRecord {
    return {
      venue: t.venue,
      symbol: t.symbol,
      venueTradeId: t.venueTradeId,
      clientOrderId: coid,
      price: price(t.price),
      qty: qty(t.qty),
      fee: t.fee ? { ccy: t.fee.ccy, amount: feeAmount(t.fee.amount) } : null,
      liquidity: t.liquidity,
      venueTimestamp: t.venueTimestamp,
      source: 'rest_reconcile',
    };
  }
}
