import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectMetric, makeCounterProvider, makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import Decimal from 'decimal.js';
import { Counter, Gauge } from 'prom-client';
import {
  balanceWithinEpsilon,
  classifyVenueOpenOrder,
  driftStrictlyGrowing,
} from '../../../domain/trading/oms/reconcile';
import {
  reduce,
  TERMINAL_ORDER_STATES,
  TransitionError,
  type OrderEvent,
  type OrderRecord,
} from '../../../domain/trading/oms/reducer';
import type { FillRecord } from '../../../domain/trading/types/exec-report';
import type { ClientOrderId, EpochMs, SymbolId } from '../../../domain/common/types/ids';
import { isOurClientOrderId, type VenueId } from '../../../domain/common/types/ids';
import { feeAmount, price, qty } from '../../../domain/common/types/money';
import { venueForSymbol } from '../../../domain/venue/types/venue-map';
import { CLOCK, type ClockPort } from '../../../ports/common/clock';
import {
  EXCHANGE_PORT,
  VENUE_EXCHANGE_PORTS,
  type ExchangeOrderState,
  type ExchangePort,
  type VenueFill,
  type VenuePosition,
} from '../../../ports/venue/exchange';
import {
  EXECUTION_STORE,
  RECON_CONFIG,
  type ExecutionStorePort,
  type ReconConfig,
  AXIS_NOT_RUN,
} from '../../../ports/trading/execution';
import { OPS_EVENTS, type OpsEventPort } from '../../../ports/common/observability';
import { KILL_SWITCH, type KillSwitchPort } from '../../../ports/trading/risk';
import { VENUE_REGISTRY, type VenueRuntimeDescriptor } from '../../../ports/venue/venue-registry';
import { FillIngestorService } from './fill-ingestor.service';
import { OrderBookService } from './order-book.service';
import { PortfolioStateService } from './portfolio-state.service';

// Backlog #24: every mismatch carries a class so the counter (and its alert) can separate the
// shared-wallet foreign-order steady state and other benign classes from actionable ones. Halting
// classes keep their historical halts[] names; the warn-only classes had no in-code discriminator
// before this (only comments), so these names are the canonical taxonomy.
type MismatchClass =
  | 'unknown_ours_open' // halting: our COID prefix on the venue, no local row anywhere (in-memory or durable)
  | 'stale_venue_open' // actionable: venue-open COID resolved TERMINAL via the in-memory or durable
  // tier — usually a sampling-order race (this axis reads localOpen ONCE, after every symbol's
  // fetchOpenOrders), self-clearing within one pass (2026-07-31 incident, boot 4753ef53). Non-halting
  // ON ITS OWN, but a per-coid streak (staleVenueOpenStreak) surviving cfg.driftPasses consecutive
  // passes escalates to the same UNKNOWN_OURS_OPEN halt unknown_ours_open uses — that is a race that
  // never resolved, i.e. the order is genuinely still live at the venue. Deliberately NOT in
  // NON_ACTIONABLE_CLASSES below: unlike the three benign classes, even a non-escalating occurrence
  // points at a real staleness problem, not routine noise, so it must keep blocking the clean stamp.
  | 'fill_for_unknown_order' // halting: our-prefix trade, no local order
  | 'balance_drift' // halting: balance beyond ε
  | 'balance_leak' // halting: within ε but monotone-growing drift
  | 'position_drift' // halting: Defect A — venue/local signed-position qty beyond ε
  | 'foreign_open_order' // benign: manual trading on the shared key
  | 'adopted_terminal' // benign: a cancel/expiry we missed via the stream, adopted from venue truth
  | 'backfilled_fill' // benign: a fill we missed via the stream, re-applied
  | 'adopt_query_failure' // transient: order held open locally but fetchOrder failed
  | 'adopt_non_adoptable' // suspicious: venue status inconsistent with absence from open orders
  | 'fill_overflow' // halting: I4 — backfilled fills exceed the order's qty + one step
  | 'fill_fold_failed' // suspicious: the fill row committed but its fold threw (row without a fold)
  | 'sweep_failure'; // transient: a per-symbol open-orders/trades/balances sweep threw

// Pass 47 (2026-07-29): the full MismatchClass enumeration, used only to seed each class's zero
// series at construction (see the constructor below) — kept as a plain list rather than derived from
// the type (TypeScript unions carry no runtime member list), so a class added to MismatchClass above
// without a matching entry here silently keeps that one class unseeded rather than failing to compile.
const ALL_MISMATCH_CLASSES: readonly MismatchClass[] = [
  'unknown_ours_open',
  'stale_venue_open',
  'fill_for_unknown_order',
  'balance_drift',
  'balance_leak',
  'position_drift',
  'foreign_open_order',
  'adopted_terminal',
  'backfilled_fill',
  'adopt_query_failure',
  'adopt_non_adoptable',
  'fill_overflow',
  'fill_fold_failed',
  'sweep_failure',
];

// Pass 49 (2026-07-30): reconciliation_runs_total's own `result` label. Type derived FROM the array
// (not the other way around, per agent-metrics-recorder.service.ts:77-78's own convention) so the
// writer (reconcileOnce, below) and the construction-time zero-seed (also below) read the SAME
// closed set — a fifth member added to a hand-written union type would compile and go unseeded,
// exactly the drift a derived type rules out. `skipped` is deliberately NOT a member — it is written
// only against the fixed `{venue:'all'}` child (the re-entrancy branch in reconcile()), never
// per-venue, so it is seeded as its own single child rather than crossed with every venue.
//
// This duplicates OpsEvent's 'reconcile.pass' member's own `result` field type (already imported into
// this file from ports/common/observability.ts) rather than referencing it: that field's type is not
// itself exported — extracting it would need an `Extract<OpsEvent, { event: 'reconcile.pass' }>['result']`
// indirection in place of the array-derived pattern this file already uses for ALL_MISMATCH_CLASSES.
// Keep the two lists in sync if either changes.
const ALL_PASS_RESULTS = ['clean', 'mismatch', 'halt', 'error'] as const;
type ReconRunResult = (typeof ALL_PASS_RESULTS)[number];

interface PassAccumulator {
  readonly mismatches: Map<MismatchClass, number>;
  readonly halts: string[];
  // Audit counts for the reconciliations row (2026-07-29). Mutable by design: each axis adds what it
  // actually examined, so a row records the work the pass did rather than a constant.
  //
  // READ A ZERO CAREFULLY — it has THREE causes on the symbol-swept axes, and only the first means
  // "the venue had none": (1) swept and genuinely empty; (2) every symbol's sweep THREW, so the venue
  // was never read at all (the documented live shape — 93,738 binance sweep_failure increments over
  // 39h on 2026-07-27); (3) the venue's symbol set is empty. Cases 2 and 3 are absences of
  // observation, not observations of absence. `sweep_failure` in the same row's mismatch classes
  // separates 1 from 2 — except where a halt from another axis takes over `detail`, which is why this
  // note exists rather than a claim that a 0 is self-explanatory. A DISABLED axis is the one case
  // encoded in-band: it writes AXIS_NOT_RUN (below), never 0.
  openOrdersChecked: number;
  tradesChecked: number;
  balancesChecked: number;
}

// `mismatches` stays the RAW total every pre-existing consumer already reads (the reconciliations
// row, the runs counter's result label, ops events). `actionableMismatches` is additive and feeds
// exactly one decision: whether runOnePass may stamp lastCleanAt (Task C3).
interface PassResult {
  readonly mismatches: number;
  readonly actionableMismatches: number;
  readonly halted: boolean;
}

function bump(acc: PassAccumulator, cls: MismatchClass): void {
  acc.mismatches.set(cls, (acc.mismatches.get(cls) ?? 0) + 1);
}

function totalMismatches(acc: PassAccumulator): number {
  let total = 0;
  for (const n of acc.mismatches.values()) total += n;
  return total;
}

// Task C3 (2026-07-27 incident). The clean stamp below used to demand a LITERAL process-wide zero,
// which made auto-resume unreachable in practice: on a shared demo wallet the benign classes are a
// documented 24/7 steady state, so one venue's routine noise permanently starved cleanWithin/
// cleanAfter/cleanIsLatest and RecoveryCoordinatorService could never resume ANY halt — including
// halts with nothing to do with reconciliation. Live proof: 39h halted, lastCleanAt never once set,
// reconciliation_last_success_timestamp_seconds pinned at 0.
//
// Membership is copied from the taxonomy comments above, not invented here: the three 'benign'
// classes (already excluded from the ReconciliationMismatch alert in observability/alerts.rules.yml
// for exactly this reason) plus 'sweep_failure', whose own comment reads "transient ... re-checked
// next pass" — verified 2026-07-27 by reproducing a failing venue's entire sweep read-only, in the
// same container, with the app's own credentials and an identically-constructed ccxt client: 48/48
// succeeded, i.e. the failures were client-state, not venue divergence.
//
// DELIBERATELY EXCLUDED: 'adopt_query_failure' (a specific order's true state is unknown) and
// 'adopt_non_adoptable' ('suspicious' per its own comment). Both still block the clean stamp.
const NON_ACTIONABLE_CLASSES: ReadonlySet<MismatchClass> = new Set<MismatchClass>([
  'foreign_open_order',
  'adopted_terminal',
  'backfilled_fill',
  'sweep_failure',
]);

// Counts only mismatches that represent a real, unexplained divergence. This NEVER feeds `halted`,
// the halts[] list, or the persisted `mismatches` total — it exists solely to decide whether a pass
// may stamp lastCleanAt. A halting class still halts exactly as before (hard rule 6 untouched).
function actionableMismatches(acc: PassAccumulator): number {
  let total = 0;
  for (const [cls, n] of acc.mismatches) if (!NON_ACTIONABLE_CLASSES.has(cls)) total += n;
  return total;
}

// 2026-07-27 incident: 39h / 93,738 binance sweep_failure increments with the `detail` column lying
// "clean" the whole time (sweep_failure never pushes to acc.halts, and the halts-or-clean expression
// below had no other branch). class:count keeps the row falsifiable without repeating a raw error
// body (that lives only in the rate-limited WARN — see logAxisError). Sorted by class name so the
// string is stable across passes/tests, not insertion-order-dependent.
function summarizeMismatches(acc: PassAccumulator): string {
  return [...acc.mismatches.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cls, n]) => `${cls}:${n}`)
    .join(',');
}

// Shared by describeError (below) and the axis-error counter's error_class label — ccxt's exception
// hierarchy is a small closed set, so the constructor name alone is a bounded-cardinality label.
function errorClassName(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

// Compact, redaction-safe error description for the reconciliations row: class name + a truncated
// message (ccxt errors can be verbose; secrets never appear in a class name, and the message cap
// bounds what a venue error body can drag into the row).
function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `${errorClassName(err)}:${message}`.slice(0, 160);
}

// Same 2026-07-27 incident: the four sweep catches below discarded the caught error entirely, so a
// constant 48-mismatch/pass binance failure ran for 39h with nothing to diagnose it by even though a
// read-only reproduction of the identical sweep, in the same container, succeeded. One WARN per
// venue:axis per interval so a 30s-cadence pass sweeping dozens of symbols cannot flood the log; the
// counter below stays per-event/unrate-limited so alerting never loses an increment to this throttle.
const AXIS_ERROR_LOG_INTERVAL_MS = 60_000;

type ReconAxis = 'openOrders' | 'trades' | 'positions' | 'balances';

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

// Task C4 (2026-07-27 incident): the ONLY diagnostic surface for a per-symbol axis sweep throw —
// sweep_failure on RECON_MISMATCH_COUNTER above says a symbol failed, never which error. error_class
// is the caught error's constructor name (or `typeof` for a non-Error throw); ccxt's exception
// hierarchy is a small closed set so cardinality stays bounded. @Optional so directly-constructed
// unit tests need not supply it.
export const RECON_AXIS_ERROR_COUNTER = makeCounterProvider({
  name: 'reconciliation_axis_error_total',
  help: 'Per-event sweep errors by venue/axis/error_class — the cause behind sweep_failure (Task C4)',
  labelNames: ['venue', 'axis', 'error_class'] as const,
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
  // UNKNOWN_OURS second tier (2026-07-31 incident): keyed `${venue}|${coid}` — mirrors
  // positionDivergenceStreak's own per-key consecutive-pass counter. Bumped by
  // resolveUnknownOursOpen/escalateStaleVenueOpen whenever the SAME coid resolves stale_venue_open
  // again; deleted by reconcileOpenOrders the moment that coid drops out of the venue's own
  // fetchOpenOrders result, so a resolved race can never accumulate toward the escalation threshold
  // across passes.
  private readonly staleVenueOpenStreak = new Map<string, number>();
  // Task C4: keyed `${venue}:${axis}` — rate-limits the diagnostic WARN below, never the counter
  // (which is per-event so alerting cannot lose an increment to this throttle).
  private readonly lastAxisErrorLogAt = new Map<string, EpochMs>();
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
  private inFlight: Promise<PassResult> | undefined;

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
    // Task C4: appended last, after every pre-existing constructor param, so no existing positional
    // construction site (this file's own reconciliation.spec.ts fixture, module-isolation boot specs)
    // needs updating — @Optional, same convention as mismatchCounter/runsCounter above.
    @Optional()
    @InjectMetric('reconciliation_axis_error_total')
    private readonly axisErrorCounter?: Counter<string>,
  ) {
    // Pass 47 (2026-07-29): prom-client only materialises a labeled child once it is touched, so
    // before this seed a process that had never hit one of the 13 classes above exported NO series
    // for it at all — indistinguishable from an empty vector caused by unbound telemetry or a renamed
    // metric (same defect Pass 44 fixed for market_stream_forced_reconnects_total). WATCH-V4-1/2
    // (research/loop/state.md) read reconciliation_mismatch_total{class="adopt_non_adoptable"} and
    // {class="fill_overflow"} expecting "stays 0" to be a real reading — before this seed, on a
    // process where neither class had ever fired, that expectation was actually a void read (§C.9).
    // Measurement-only and must never block a boot: wrapped so a misbehaving counter can never escape
    // this constructor (fail OPEN).
    if (this.mismatchCounter) {
      try {
        for (const cls of ALL_MISMATCH_CLASSES) this.mismatchCounter.inc({ class: cls }, 0);
      } catch {
        /* metrics must never throw into a trading path */
      }
    }

    // Pass 49 (2026-07-30): the runs-counter twin, in its OWN try/catch — a throw here must never be
    // able to un-seed the mismatch-class block above, and vice versa; sharing one try would let either
    // counter's failure silently cancel the other's seed. Live-verified: a halt whose child receives
    // exactly one increment is invisible to increase() forever after (a lazily-created child sits at 1
    // permanently, so any LATER window's increase() reads 0) — demonstrated live on the sibling
    // agentic_reflection_outcomes_total (reads 1, `increase(...[24h])` reads 0). Sustained re-halts
    // still fire today (TSDB: {result="halt",venue="binanceusdm"} climbed 4→20 over 9 consecutive
    // evaluations on 2026-07-26, and again for venue="binance" on 2026-07-27) — this seed is what
    // makes a SINGLE halt increment visible too, closing the gap between "re-halts happen to page" and
    // "every halt pages." Venue source matches reconcileEveryVenue's own condition (below) exactly —
    // venuePorts AND venueRegistry both present and non-empty — so the seed can never name a venue
    // that condition would route to the legacy this.exchange fallback instead (a populated registry
    // with no venuePorts would otherwise seed a child no writer can ever move: the fabricated-child
    // lie this file's own ALL_MISMATCH_CLASSES comment warns against, one level down).
    if (this.runsCounter) {
      try {
        const venues =
          this.venuePorts && this.venueRegistry && this.venueRegistry.size > 0
            ? [...this.venueRegistry.values()].map((d) => d.venue)
            : [this.exchange.venue];
        for (const venue of venues) {
          for (const result of ALL_PASS_RESULTS) this.runsCounter.inc({ venue, result }, 0);
        }
        this.runsCounter.inc({ venue: 'all', result: 'skipped' }, 0);
      } catch {
        /* metrics must never throw into a trading path */
      }
    }

    // Pass 50 (2026-07-30): reconciliation_axis_error_total's own zero-seed, in its OWN try/catch for
    // the same non-cross-cancellation reason as the runsCounter block above. `error_class` is
    // deliberately NOT enumerated — it is a ccxt exception constructor name, an OPEN set this file
    // only discovers at runtime (errorClassName below), so inventing members would be the exact
    // fabricated-child lie ALL_MISMATCH_CLASSES' own comment warns against, one level down. Crossed
    // instead with the explicit sentinel error_class:'none' (log-event-metrics.ts's NONE_EVENT is the
    // same convention) over the two genuinely closed dimensions: venue and axis. openOrders/trades run
    // unconditionally for every venue this pass reaches; positions/balances are seeded ONLY where that
    // VENUE'S OWN ReconConfig actually enables the axis (venueReconConfig — perpCapable / non-demo
    // environment) — seeding an axis a venue's own config has turned off (every configured venue today
    // has balanceAxis off, per venueReconConfig's own comment) would itself be an unreachable child.
    if (this.axisErrorCounter) {
      try {
        if (this.venuePorts && this.venueRegistry && this.venueRegistry.size > 0) {
          for (const descriptor of this.venueRegistry.values()) {
            const port = this.venuePorts.get(descriptor.venue);
            if (!port) continue;
            const venueCfg = this.venueReconConfig(descriptor);
            this.axisErrorCounter.inc(
              { venue: descriptor.venue, axis: 'openOrders', error_class: 'none' },
              0,
            );
            this.axisErrorCounter.inc(
              { venue: descriptor.venue, axis: 'trades', error_class: 'none' },
              0,
            );
            /* v8 ignore next -- the `?? true` fallback is unreachable here: venueReconConfig (above) always sets positionAxis to descriptor.perpCapable, a required boolean, never undefined; the `??` exists only for the single-venue path's own `this.cfg.positionAxis ?? true` below, where cfg.positionAxis genuinely is optional */
            if ((venueCfg.positionAxis ?? true) && port.fetchPositions !== undefined) {
              this.axisErrorCounter.inc(
                { venue: descriptor.venue, axis: 'positions', error_class: 'none' },
                0,
              );
            }
            if (venueCfg.balanceAxis) {
              this.axisErrorCounter.inc(
                { venue: descriptor.venue, axis: 'balances', error_class: 'none' },
                0,
              );
            }
          }
        } else {
          const venue = this.exchange.venue;
          this.axisErrorCounter.inc({ venue, axis: 'openOrders', error_class: 'none' }, 0);
          this.axisErrorCounter.inc({ venue, axis: 'trades', error_class: 'none' }, 0);
          if ((this.cfg.positionAxis ?? true) && this.exchange.fetchPositions !== undefined) {
            this.axisErrorCounter.inc({ venue, axis: 'positions', error_class: 'none' }, 0);
          }
          if (this.cfg.balanceAxis) {
            this.axisErrorCounter.inc({ venue, axis: 'balances', error_class: 'none' }, 0);
          }
        }
      } catch {
        /* metrics must never throw into a trading path */
      }
    }
  }

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
  async reconcile(): Promise<PassResult> {
    const inFlight = this.inFlight;
    if (inFlight !== undefined) {
      // Visible, never silent — but the visibility lives in the counter below, not in this log line.
      // reconciliation_runs_total{venue="all",result="skipped"} is scraped and is exactly what
      // ReconcilerStalled (observability/alerts.rules.yml) is built to ignore: its expr sums only
      // result=~"clean|mismatch|halt" over a 10m window, deliberately EXCLUDING result="skipped", so a
      // coalesced tick can never masquerade as a completed pass (`a03b35d`, 2026-07-30, narrowed the
      // expr from result!="error" for exactly that reason — skipped alone was contributing 9.23 of a
      // 28.72 window sum). debug is therefore the right level for this line: it carries no per-occurrence
      // payload (no venue, no duration, no elapsed-in-flight) that the counter beside it doesn't already
      // capture, so at warn it was strictly less informative noise dominating the warn bucket
      // (~214 occurrences/3.6h, ~1:1 against completed passes) for zero added signal. This is a
      // measurement/observability-only edit on a path that fails OPEN by design: the log call must
      // never block reconciliation, and the re-entrancy guard and kill-switch detection inside
      // reconcileOnce are untouched — a coalescing tick still can never bypass or swallow a HALT.
      //
      // A MODERATE SKIP RATE IS EXPECTED AND HEALTHY — do not read it as a fault. Measured in the
      // 2026-07-22 soak: 62 skips/hour against 57-58 completed passes per venue (119 ≈ the 120 ticks
      // an hour of 30s ticks produces). Because a pass takes ~60s, the 30s interval means a fresh pass
      // starts almost immediately after the previous one ends — the skipped ticks act as the retry that
      // keeps passes running BACK-TO-BACK, which is the best available cadence. Widening the interval
      // to "stop the skips" would make it strictly worse (a 60s tick landing mid-pass would skip to
      // 120s). What IS alarming: a sustained 100% skip rate, or completed-pass count trending toward
      // zero — that means a pass is wedged, not merely slow.
      this.log.debug(
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

  private async runOnePass(): Promise<PassResult> {
    // ASYMMETRIC STAMPING, deliberately fail-closed (security review, 2026-07-22). A CLEAN verdict is
    // credited to the instant the pass STARTED — the earliest moment its observations could describe —
    // never to completion. A multi-second pass that read venue truth at t0 and returns clean at t0+45s
    // would otherwise stamp a "clean" newer than a divergence detected at t0+25s by another pass,
    // satisfying cleanWithin/cleanAfter/cleanIsLatest and resuming into the un-cleared divergence.
    // A NON-clean verdict is stamped at completion (and, for a halt, at DETECTION inside reconcileOnce),
    // i.e. always the LATEST possible instant — so the clean-vs-dirty comparison can never favour clean.
    const startedAt = this.clock.now();
    let result: PassResult;
    try {
      result = await this.reconcileEveryVenue();
    } catch (err) {
      // A pass that threw before completing is NOT a clean confirmation — mark the latest outcome
      // non-clean so cleanIsLatest() blocks auto-resume until a fresh clean pass genuinely runs (a
      // persisting error also independently ages out cleanWithin). Fail CLOSED.
      this.lastMismatchAt = this.clock.now();
      throw err;
    }
    // Task C3: `actionableMismatches`, not the raw total — see NON_ACTIONABLE_CLASSES above. The
    // `!result.halted` conjunct is UNCHANGED, so a live halting divergence (the current
    // POSITION_DRIFT re-halting every pass) still blocks the stamp exactly as it always did.
    if (result.actionableMismatches === 0 && !result.halted) {
      this.lastCleanAt = startedAt;
      // Process-wide stamp only — matches lastCleanAt. Per-venue clean in reconcileOnce used to
      // refresh this gauge while another venue mismatched (adversarial review 2026-07-24).
      this.lastSuccessGauge?.set(startedAt / 1000);
    } else {
      this.lastMismatchAt = this.clock.now();
    }
    return result;
  }

  private async reconcileEveryVenue(): Promise<PassResult> {
    if (this.venuePorts && this.venueRegistry && this.venueRegistry.size > 0) {
      let mismatches = 0;
      let actionable = 0;
      let halted = false;
      for (const descriptor of this.venueRegistry.values()) {
        const port = this.venuePorts.get(descriptor.venue);
        if (!port) {
          this.log.error(`no exchange port registered for venue "${descriptor.venue}" — skipping`);
          continue;
        }
        const result = await this.reconcileOnce(port, this.venueReconConfig(descriptor));
        mismatches += result.mismatches;
        actionable += result.actionableMismatches;
        halted = halted || result.halted;
      }
      return { mismatches, actionableMismatches: actionable, halted };
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

  private async reconcileOnce(exchange: ExchangePort, cfg: ReconConfig): Promise<PassResult> {
    const acc: PassAccumulator = {
      mismatches: new Map(),
      halts: [],
      openOrdersChecked: 0,
      tradesChecked: 0,
      balancesChecked: 0,
    };
    const startedAt = this.clock.now();

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
    const finishedAt = this.clock.now();
    await this.store.saveReconciliation({
      ts: finishedAt,
      venue: exchange.venue,
      mismatches: mismatchTotal,
      halted,
      // Measured across the whole axis chain including a thrown pass — an errored pass's cost is the
      // most interesting duration there is (the 2026-07-28 venue outage ran passes to timeout).
      // Clamped: measurement-only, feeds no decision, so it fails OPEN on a backwards wall clock.
      durationMs: Math.max(0, finishedAt - startedAt),
      openOrdersChecked: acc.openOrdersChecked,
      tradesChecked: acc.tradesChecked,
      // Distinguishes "compared no assets" from "the axis never ran", which is the live case: every
      // configured venue is `demo`, so venueReconConfig turns balanceAxis off on all of them.
      balancesChecked: cfg.balanceAxis ? acc.balancesChecked : AXIS_NOT_RUN,
      detail:
        passError !== undefined
          ? `PASS_ERROR:${describeError(passError)}`
          : acc.halts.length > 0
            ? acc.halts.join(',')
            : mismatchTotal > 0
              ? summarizeMismatches(acc) // H1 fix: sweep_failure etc. never populate acc.halts — 'clean' must not lie
              : 'clean',
    });
    // Per-class increments (#24); a clean pass increments nothing — increase() over an absent
    // series is 0, so the alert semantics are unchanged from the old 0-inc.
    for (const [cls, n] of acc.mismatches) this.mismatchCounter?.inc({ class: cls }, n);
    const result: ReconRunResult =
      passError !== undefined
        ? 'error'
        : halted
          ? 'halt'
          : mismatchTotal > 0
            ? 'mismatch'
            : 'clean';
    this.runsCounter?.inc({ venue: exchange.venue, result });
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
    return { mismatches: mismatchTotal, actionableMismatches: actionableMismatches(acc), halted };
  }

  // Task C4 diagnostic pair for the four axis-sweep catches below. FAIL OPEN, deliberately: this is a
  // measurement/veto-only side-channel describing a sweep failure, never a control-flow input to it —
  // a throwing logger or a throwing prom-client counter must never abort the very sweep it is trying
  // to describe (the 2026-07-27 incident this exists for was already the result of one bare `catch {}`
  // destroying diagnosability; a second silent failure mode here would repeat it).
  private logAxisError(venue: VenueId, axis: ReconAxis, err: unknown): void {
    const key = `${venue}:${axis}`;
    const now = this.clock.now();
    const last = this.lastAxisErrorLogAt.get(key);
    if (last !== undefined && now - last < AXIS_ERROR_LOG_INTERVAL_MS) return;
    this.lastAxisErrorLogAt.set(key, now);
    try {
      this.log.warn(`reconcile sweep failure venue=${venue} axis=${axis}: ${describeError(err)}`);
    } catch {
      /* observability must never throw into a trading path */
    }
  }

  private incAxisErrorCounter(venue: VenueId, axis: ReconAxis, err: unknown): void {
    try {
      this.axisErrorCounter?.inc({ venue, axis, error_class: errorClassName(err) });
    } catch {
      /* metrics must never throw into a trading path */
    }
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
      } catch (err) {
        this.logAxisError(exchange.venue, 'openOrders', err);
        this.incAxisErrorCounter(exchange.venue, 'openOrders', err);
        bump(acc, 'sweep_failure'); // could not sweep this symbol's open orders — surfaced, re-checked next pass
        failedSymbols.add(symbol);
      }
    }
    acc.openOrdersChecked += venueOpen.length;
    const localOpen = this.portfolio.snapshot().openOrders;
    const localCoids = new Set<string>(localOpen.map((o) => o.clientOrderId));
    const venueCoids = new Set<string>(venueOpen.map((o) => o.clientOrderId));

    for (const vo of venueOpen) {
      const verdict = classifyVenueOpenOrder(vo.clientOrderId, localCoids.has(vo.clientOrderId));
      if (verdict === 'UNKNOWN_OURS') {
        await this.resolveUnknownOursOpen(exchange, vo.clientOrderId, cfg, acc);
      } else if (verdict === 'FOREIGN') {
        bump(acc, 'foreign_open_order'); // manual trading on the key — WARN + ignore
      }
    }

    // staleVenueOpenStreak reset: a coid stops being visited by the loop above the instant it drops
    // out of `venueOpen` — self-clearing causes A/B (see resolveUnknownOursOpen) never get bumped
    // again, but their old streak count would otherwise sit in the map forever and let a LATER,
    // unrelated re-appearance resume counting from where a fully-resolved race left off. Swept once
    // per venue per pass, scoped to this venue's own key prefix only.
    const streakPrefix = `${exchange.venue}|`;
    for (const key of this.staleVenueOpenStreak.keys()) {
      if (!key.startsWith(streakPrefix)) continue;
      if (!venueCoids.has(key.slice(streakPrefix.length))) this.staleVenueOpenStreak.delete(key);
    }

    // Local order we believe open but the venue does not list: adopt the venue's terminal truth.
    // Skipped for symbols whose sweep failed — absence there is fetch failure, not venue truth
    // (adoptTerminal re-queries per order anyway, but there is no point burning calls on a venue
    // that just refused the symbol).
    // Venue filter: never fetchOrder a spot coid against binanceusdm (or vice versa) — that was
    // minting false adopt_query_failure on every dual-venue pass (2026-07-24 EdgePolicy soak T+0).
    for (const lo of localOpen) {
      if (venueForSymbol(lo.symbol) !== exchange.venue) continue;
      if (venueCoids.has(lo.clientOrderId)) continue;
      if (failedSymbols.has(lo.symbol)) continue;
      await this.adoptTerminal(exchange, lo.clientOrderId, lo.symbol, acc);
    }
  }

  // UNKNOWN_OURS second tier (2026-07-31 incident, boot 4753ef53): classifyVenueOpenOrder's verdict
  // above is computed against `localOpen`, sampled ONCE after every symbol's fetchOpenOrders loop —
  // an order resting at the venue when ITS symbol was swept, then cancelled/filled locally before the
  // loop finished, reads as "our prefix, absent locally" purely from that timing gap, not a real
  // divergence. cbt019fb74b74127d468e1bd84cd515dc50 (BTC LIMIT SELL) was cancelled at 17:30:32.611,
  // 27.3s before the stale read engaged the kill switch on it. Mirrors the trade axis's own two-tier
  // resolution (resolveVenueOrder's in-memory-first pass-start-index, then the durable
  // loadOrderByVenueOrderId fallback at reconcileTrade's tier-2): OrderBookService is authoritative
  // FIRST because it is never pruned within a process, so a terminal record there proves the venue
  // read was simply stale.
  //
  // A single terminal resolution does NOT by itself prove the sampling race, though — it collapses
  // three distinct causes into one reading: (A) the sampling race above, which cannot survive a
  // second, INDEPENDENT venue read; (B) venue eventual consistency, which also self-clears; (C) the
  // order is genuinely still resting live at the venue and our terminal fold was wrong (a
  // venue-confirmed cancel that never applied, a second instance on the key, a manual venue action) —
  // this does NOT self-clear. escalateStaleVenueOpen's per-coid consecutive-pass streak is what tells
  // C apart from A/B: a repeated stale_venue_open reading cannot widen a race that one independent
  // venue sample already resolved, so a streak surviving `cfg.driftPasses` passes on the SAME coid is
  // cause C, and escalates to the same UNKNOWN_OURS_OPEN halt the pre-change code always issued.
  private async resolveUnknownOursOpen(
    exchange: ExchangePort,
    coid: ClientOrderId,
    cfg: ReconConfig,
    acc: PassAccumulator,
  ): Promise<void> {
    const rec = this.orders.get(coid);
    if (rec !== undefined) {
      if (TERMINAL_ORDER_STATES.has(rec.state)) {
        bump(acc, 'stale_venue_open'); // gone terminal locally between this coid's symbol sweep and the local read
        this.escalateStaleVenueOpen(exchange, coid, cfg, acc);
      }
      return; // tracked and non-terminal ⇒ KNOWN by any honest reading; nothing to record
    }
    // Absent from OrderBookService entirely: a just-restarted process, a recovery gap, or true
    // corruption. Fall through to the durable tier, venue-scoped by the row's own persisted `venue`
    // column (loadOrderByClientOrderId — the same discipline venueOrderIndex applies to venueOrderId
    // lookups) — never by clientOrderId shape alone (isOurClientOrderId matches prefix only, no
    // venue/mode). FAIL CLOSED: a throw, a miss, and a wrong-venue row all resolve `durable` to null
    // identically and fall through to the halt below — "could not confirm this is ours on THIS venue"
    // is never treated as confirmed.
    let durable: OrderRecord | null;
    try {
      durable = await this.store.loadOrderByClientOrderId(exchange.venue, coid);
    } catch {
      durable = null;
    }
    if (durable !== null) {
      if (TERMINAL_ORDER_STATES.has(durable.state)) {
        bump(acc, 'stale_venue_open'); // durably terminal too — the in-memory book merely hadn't caught up
        this.escalateStaleVenueOpen(exchange, coid, cfg, acc);
        return;
      }
      // Durably ours on this venue, still non-terminal, yet absent from OrderBookService ⇒ the
      // in-memory projection was lost while the order was genuinely live — exactly the
      // FILL_FOR_UNKNOWN_ORDER shape the trade axis halts on at reconcileTrade's own durable tier.
      // Fall through to the halt below; never auto-cancel what we cannot fully account for (rule 6).
    }
    bump(acc, 'unknown_ours_open');
    acc.halts.push(`UNKNOWN_OURS_OPEN:${coid}`); // I1: our prefix, no live local row anywhere ⇒ corruption
  }

  // Cause C escalation (resolveUnknownOursOpen above). Reset lives in reconcileOpenOrders, not here:
  // this method only ever runs for a coid present in THIS pass's venueOpen, so it cannot itself
  // observe the coid's absence on a later pass — that is the signal that the race actually resolved.
  private escalateStaleVenueOpen(
    exchange: ExchangePort,
    coid: ClientOrderId,
    cfg: ReconConfig,
    acc: PassAccumulator,
  ): void {
    const key = `${exchange.venue}|${coid}`;
    const streak = (this.staleVenueOpenStreak.get(key) ?? 0) + 1;
    this.staleVenueOpenStreak.set(key, streak);
    if (streak > cfg.driftPasses) {
      acc.halts.push(`UNKNOWN_OURS_OPEN:${coid}`); // cause C: still resting live at the venue, not a sampling race
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
      // Venue 'closed' (filled) must NOT fold as CANCELED/EXPIRED — that would retire without fills.
      // Force a targeted myTrades backfill (same path as axis-2), then re-check local state.
      if (venueOrder.status === 'closed') {
        await this.backfillClosedOrderTrades(exchange, coid, symbol, acc);
        const after = this.orders.get(coid);
        if (after !== undefined && !TERMINAL_ORDER_STATES.has(after.state)) {
          bump(acc, 'adopt_non_adoptable');
        }
        return;
      }
      bump(acc, 'adopt_non_adoptable'); // 'open'/other inconsistent with absence from open orders — WARN
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

  /** Lookback for closed-order trade recovery when the running trades checkpoint is past the fill. */
  private static readonly ADOPT_CLOSED_LOOKBACK_MS = 7 * 86_400_000;

  private async backfillClosedOrderTrades(
    exchange: ExchangePort,
    coid: ClientOrderId,
    symbol: SymbolId,
    acc: PassAccumulator,
  ): Promise<void> {
    const rec = this.orders.get(coid);
    if (rec?.venueOrderId === undefined) {
      bump(acc, 'adopt_non_adoptable');
      return;
    }
    const since = Math.max(
      0,
      this.clock.now() - ReconciliationService.ADOPT_CLOSED_LOOKBACK_MS,
    ) as EpochMs;
    let trades: readonly VenueFill[];
    try {
      trades = await exchange.fetchMyTrades(symbol, since);
    } catch {
      bump(acc, 'adopt_query_failure');
      return;
    }
    const byVenueId = new Map<string, OrderRecord>([[rec.venueOrderId, rec]]);
    for (const t of trades) {
      if (t.clientOrderId !== rec.venueOrderId && t.clientOrderId !== coid) continue;
      await this.reconcileTrade(exchange, t, byVenueId, acc);
    }
  }

  // Only the terminals an open (ACKED/PARTIALLY_FILLED) order may LEGALLY reach are adopted:
  // canceled and expired. 'rejected' is reachable only from SUBMITTING, so a venue 'rejected' on an
  // order we already hold an ack for is a contradiction, not an adopt — surfaced as a WARN (and the
  // reducer would reject the illegal fold anyway). 'open' stays non-adoptable; 'closed' is handled
  // above via trade backfill (never a synthetic cancel).
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
    const byVenueId = this.venueOrderIndex(exchange);
    for (const symbol of this.sweepSymbols(exchange, cfg)) {
      const key = `${exchange.venue}|${symbol}`;
      const checkpoint = this.checkpoints.get(key) ?? (0 as EpochMs);
      const since = Math.max(0, checkpoint - cfg.overlapMs) as EpochMs;
      let trades: readonly VenueFill[];
      try {
        trades = await exchange.fetchMyTrades(symbol, since);
      } catch (err) {
        this.logAxisError(exchange.venue, 'trades', err);
        this.incAxisErrorCounter(exchange.venue, 'trades', err);
        bump(acc, 'sweep_failure'); // could not sweep this symbol's trades — surfaced
        continue;
      }
      acc.tradesChecked += trades.length;
      for (const t of trades) {
        await this.reconcileTrade(exchange, t, byVenueId, acc);
        if (t.venueTimestamp > (this.checkpoints.get(key) ?? 0))
          this.checkpoints.set(key, t.venueTimestamp);
      }
    }
  }

  // venueOrderId → order, for THIS venue only. Two rules, both learned the hard way:
  //
  //  1. VENUE-SCOPED. A venue order id is unique only per venue (order.repository.ts's
  //     findByVenueOrderId is venue-scoped for exactly this reason), while this.orders.all() is
  //     book-wide — one process, both venues. An unqualified index can therefore hand a perp trade a
  //     SPOT order, folding the fill onto the wrong symbol's position and filing it under the wrong
  //     intent. A record whose symbol is unknown is NOT indexed: it falls through to the venue-scoped
  //     durable tier, which can answer the venue question this record cannot.
  //  2. REBUILT ON DEMAND, not cached across the pass. A pass issues dozens of sequential REST calls
  //     over ~60s; an order ACKed after a cached snapshot was taken would miss every in-memory tier
  //     and reach the durable tier as a non-terminal "lost in memory" order — a false
  //     FILL_FOR_UNKNOWN_ORDER halt of the whole book. Callers re-read on a miss (resolveVenueOrder).
  private venueOrderIndex(exchange: ExchangePort): Map<string, OrderRecord> {
    const index = new Map<string, OrderRecord>();
    for (const rec of this.orders.all()) {
      if (rec.venueOrderId === undefined) continue;
      if (rec.symbol === undefined) continue;
      if (venueForSymbol(rec.symbol) !== exchange.venue) continue;
      index.set(rec.venueOrderId, rec);
    }
    return index;
  }

  // The pass-start index first (cheap), then one fresh scan before concluding the order is unknown —
  // so an order that ACKed mid-pass resolves instead of halting the book.
  private resolveVenueOrder(
    exchange: ExchangePort,
    byVenueId: ReadonlyMap<string, OrderRecord>,
    venueOrderId: string,
  ): OrderRecord | undefined {
    return byVenueId.get(venueOrderId) ?? this.venueOrderIndex(exchange).get(venueOrderId);
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

    const viaVenueId = this.resolveVenueOrder(exchange, byVenueId, t.clientOrderId);
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

  // Fold from the LIVE book record, never the caller's snapshot. byVenueId (reconcileTrades) is
  // built ONCE per pass, so when one pass backfills several trades of the SAME order every fold
  // would restart from that snapshot's cumQty: the reducer's own stale-fill guard compares against
  // the record it is handed, so each fold looks fresh, journals a non-monotone FILL, and commit()
  // regresses the book to the LAST trade's qty alone. The venue-FILLED order is then stranded
  // non-terminal, which reports adopt_non_adoptable on every subsequent pass — an actionable class,
  // so the clean stamp (and RecoveryCoordinatorService's auto-resume with it) is starved forever.
  // Same defect and same remedy as demo-fill-poller.service.ts's 2026-07-11 fix; this call site was
  // missed then. Live proof 2026-07-27: BCH/USDT:USDT, 8 trades in one pass, cum_qty 0.045 of 0.365.
  private async applyTrade(t: VenueFill, rec: OrderRecord, acc: PassAccumulator): Promise<void> {
    const live = this.orders.get(rec.clientOrderId) ?? rec;
    let applied: boolean;
    try {
      ({ applied } = await this.ingestor.ingest(
        live,
        this.toFillRecord(t, live.clientOrderId),
        `reconcile:${t.venueTradeId}`,
      ));
    } catch (err) {
      // Contained deliberately, and for ANY throw past ingest's saveFill — not just the reducer's.
      // Two independent reasons, both learned here:
      //   1. reconcileOnce rethrows, so an escaping error skips the positions and balances axes —
      //      the 2026-07-07 100%-reconcile-downtime shape adoptTerminal already guards against.
      //   2. saveFill commits the fill row BEFORE the fold (fill-ingestor.service.ts), so the row
      //      survives the throw and reconcileTrade's hasFill filter skips this trade on every later
      //      pass. Whatever threw is therefore never re-detected: loud once, silent forever.
      // Because of (2) the residue — a committed fill row whose fold never landed — is NOT
      // self-healing, at runtime or at boot (rebuildCumFromFills folds through the same reducer and
      // refuses identically). Repair is manual; see docs/runbook.md § Reconciliation mismatch.
      // The reason string carries the symbol so the append-only kill-switch audit and the
      // reconciliations `detail` column stay diagnosable without the container log (the C4 lesson),
      // matching BALANCE_DRIFT:${asset} / POSITION_DRIFT:${symbol} below.
      const detail = `${t.symbol} trade ${t.venueTradeId} on ${live.clientOrderId}`;
      if (err instanceof TransitionError) {
        // I4 cumQty overflow: the journal now holds more filled qty than qty + one step. Folding
        // cumulatively is what makes this reachable per PASS rather than per TRADE. Fail CLOSED —
        // a money-model divergence HALTs (rule 6, never auto-flattened).
        bump(acc, 'fill_overflow');
        acc.halts.push(`FILL_OVERFLOW:${t.symbol}`);
        this.log.error(`fill overflow: ${detail} folds past qty ${live.qty.toFixed()} + step`);
        return;
      }
      // Anything else (a journal write, the portfolio fold, the equity sample) is contained ONLY
      // when the fill row actually committed — that is what makes the trade unretryable and the
      // escape harmful. A throw AT saveFill leaves no row, so the trade IS retried next pass and the
      // pass-error accounting (runs{result=error} + a PASS_ERROR reconciliations row) is the correct,
      // already-pinned outcome: rethrow, exactly as before this containment existed.
      if (!(await this.store.hasFill(t.venue, t.symbol, t.venueTradeId))) throw err;
      // Row committed, fold did not land. Transient infrastructure rather than a proven money
      // divergence, so it is surfaced as an actionable mismatch — blocking THIS pass's clean stamp —
      // without halting the book on a database blip.
      bump(acc, 'fill_fold_failed');
      this.log.error(`fill fold failed: ${detail} — ${describeError(err)}`);
      return;
    }
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
    } catch (err) {
      this.logAxisError(exchange.venue, 'positions', err);
      this.incAxisErrorCounter(exchange.venue, 'positions', err);
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
    } catch (err) {
      this.logAxisError(exchange.venue, 'balances', err);
      this.incAxisErrorCounter(exchange.venue, 'balances', err);
      bump(acc, 'sweep_failure');
      return;
    }
    const local = this.portfolio.snapshot().balances;
    acc.balancesChecked += local.size;
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
