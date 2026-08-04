import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import Decimal from 'decimal.js';
import { sumFeesQuote, walkRoundTrips } from '../../../domain/trading/risk/round-trips';
import {
  PASSIVE_BENCHMARK,
  PROMOTION_READINESS_CONFIG,
  PROMOTION_STATS,
  type PassiveBenchmarkPort,
  type PerModelTokenTotals,
  type PromotionBlockedReason,
  type PromotionReadiness,
  type PromotionReadinessConfig,
  type PromotionReadinessPort,
  type PromotionStatsPort,
} from '../../../ports/trading/promotion';

const DEMO_MODE = 'testnet' as const;
const MIN_ROUND_TRIPS = 30;
const MIN_WINDOW_DAYS = 14;
const MTOK = new Decimal(1_000_000);
const DAY_MS = 24 * 60 * 60 * 1000;

// The round-trip walk + fee-conversion rules live in src/domain/trading/risk/round-trips.ts (pure, shared
// with the agentic reflection-evidence feed) — this service owns only the VERDICT: which reasons
// gate `permitted`, the LLM cost math, and the evidence window. PromotionFillRow is structurally a
// domain RoundTripFill, so rows flow into the walk unchanged. The extraction is behavior-preserving:
// realizedPnl stays GROSS of fees per cycle, with the cross-cycle sumFeesQuote subtracted once here.
//
// mode-control is a 100%-branch coverage glob (vitest.config.ts) — every conditional here is
// exercised by promotion-readiness.service.spec.ts's fake-stats-port branch matrix.
@Injectable()
export class PromotionReadinessService implements PromotionReadinessPort {
  private readonly log = new Logger(PromotionReadinessService.name);
  // Per-process latch (defect 142 follow-up): evaluate() runs every 5 min (PromotionMetricsService)
  // and 'prescreen'/'plan-executor' are internal row tags, not model ids — permanently unpriceable,
  // ~3 warns/tick without this, 2:1 noise over the one signal (a real rename drift like
  // claude-opus-4-8) the warning exists to surface.
  private readonly warnedModels = new Set<string>();

  constructor(
    @Optional() @Inject(PROMOTION_STATS) private readonly stats: PromotionStatsPort | undefined,
    @Inject(PROMOTION_READINESS_CONFIG) private readonly cfg: PromotionReadinessConfig,
    // Optional so the port can land dark: unbound ⇒ the benchmark clause never fires and the verdict
    // is byte-identical to the pre-2026-07-27 gate. Binding it at the composition root is the enable.
    // Trailing + `?` (rather than this file's `| undefined` convention for stats above) so every
    // existing 2-arg construction — three test suites, incl. both livegate matrices — keeps
    // compiling untouched. Same semantics: unbound ⇒ clause never fires.
    @Optional()
    @Inject(PASSIVE_BENCHMARK)
    private readonly benchmark?: PassiveBenchmarkPort,
  ) {}

  async evaluate(): Promise<PromotionReadiness> {
    if (this.stats === undefined) {
      return notPermitted(['NO_STATS_SOURCE'], zeroEvidence());
    }

    // Evidence epoch (W4+W13, owner 2026-07-08): both stats reads and the window anchor gate on the
    // owner-declared instant so a post-fix configuration is judged on post-fix evidence, not the
    // sunk experimentation hole. Absent ⇒ all-time (both branches exercised under the 100% glob).
    // STRADDLE BOUND (reviewer 2026-07-08, comment corrected 2026-07-18): fills are filtered by
    // venue_timestamp >= epoch BEFORE the walk (fillsForMode, below) — this is a data-layer filter,
    // so the service has NO signal here to detect or repair a straddle (it cannot see position state
    // as of the epoch instant). A round trip that OPENED before the epoch and closed after loses its
    // opening fill; the dominant effect (round-trip-evidence.reader.ts documents the same shape) is a
    // never-closing PHANTOM cycle whose signedQty never returns to dust, which SUPPRESSES round-trip
    // count going forward for that (strategyId, symbol) — the fail-CLOSED/under-count direction, not
    // a false-permit one: neither the ≥30-round-trip floor nor the 14-day window can be inflated by a
    // dropped opening fill, and the four live gates + bootId arming ceremony still bind behind the
    // verdict regardless. This safety argument depends on a PRECONDITION this service cannot verify
    // by itself: the epoch must be declared at a FLAT-position instant for every strategy in scope
    // (true for the 2026-07-08 deploy, both strategies were dust-flat) — an epoch declared mid-
    // position is the only way a straddle can occur at all, and is an operational discipline, not a
    // code-enforced invariant. A safe in-service repair (excluding a straddling cycle from evidence
    // in either direction) was assessed and declined: fillsForMode already discarded the opening fill
    // at the data layer before this function runs, so there is nothing left here to detect a straddle
    // from — doing that correctly needs a port/query change (fetch pre-epoch position state or widen
    // the fill window), which is a scope expansion beyond this fix, not a cheap in-service filter.
    const epochMs = this.cfg.evidenceEpochMs;
    // P5b: funding rides the SAME mode + evidence-epoch window as fillsForMode above — a stats port
    // that never implemented fundingNetForMode (older fake/impl) degrades to "no funding data"
    // rather than throwing (measurement gate fails OPEN).
    const [fills, tokenTotals, funding] = await Promise.all([
      this.stats.fillsForMode(DEMO_MODE, epochMs),
      this.stats.llmTokenTotals(epochMs),
      this.stats.fundingNetForMode?.(DEMO_MODE, epochMs) ??
        Promise.resolve({ netQuote: '0', hasRows: false, ingestedThroughMs: null }),
    ]);

    const dustNotional = new Decimal(this.cfg.dustNotional);
    const { cycles, unconvertibleFeeAsset } = walkRoundTrips(fills, dustNotional);
    const hasUnresolvedFill = fills.some((f) => f.strategyId === null || f.side === null);

    const realizedPnl = cycles.reduce((sum, c) => sum.plus(c.realizedPnl), new Decimal(0));
    const fees = sumFeesQuote(fills);
    const llmCostUsd = this.llmCostUsd(tokenTotals);
    // fundingNet is already signed (POSITIVE received / NEGATIVE paid — VenueFundingPayment's own
    // sign-convention comment) so it ADDS, unlike fees/llmCostUsd which subtract.
    const fundingNet = new Decimal(funding.netQuote);
    const netPnl = realizedPnl.minus(fees).minus(llmCostUsd).plus(fundingNet);
    // Blocking: funding was EXPECTED (perp + shorts, composition root) and zero rows exist
    // in-window (stalled/disabled ingest poller — FundingIngestService.pollOne swallows errors and
    // continues). netPnl above forces fundingNet=0 in this case, which can only ever OVERSTATE
    // net-of-cost PnL (funding is a cost the lane may be paying). This is a permission/safety gate
    // (narrows who may attempt live arming), so it fails CLOSED via reasons below, not open.
    const fundingDataMissing = (this.cfg.fundingDataExpected ?? false) && !funding.hasRows;

    const firstClosedAt = cycles.length > 0 ? Math.min(...cycles.map((c) => c.closedAt)) : null;
    const lastClosedAt = cycles.length > 0 ? Math.max(...cycles.map((c) => c.closedAt)) : null;
    // Keyed off cycles.length (not first/last null-checks): first/last are null together or set
    // together, so a null-check pair would carry an unreachable mixed branch under the 100% glob.
    // The window START anchors at max(firstClosedAt, epoch): a partial first day inside the epoch
    // must not inflate the measured window (an epoch set after firstClosedAt would otherwise let a
    // pre-epoch trade widen it). windowStart falls to firstClosedAt when the epoch is unset or older.
    const windowStart =
      firstClosedAt !== null && epochMs !== undefined
        ? Math.max(firstClosedAt, epochMs)
        : firstClosedAt;
    const windowDays =
      cycles.length > 0 && windowStart !== null ? (lastClosedAt! - windowStart) / DAY_MS : 0;

    // Passive benchmark (2026-07-27). "net-of-cost > 0" certifies value destruction as success — a
    // strategy earning +3% while the basket earns +12% clears it. So the bar is now ALSO "beat the
    // alternative", not merely "beat zero". Absent port or an uncomputable window drops the clause
    // (measurement gap, same fail-open as funding data) — which is deliberately the pre-wiring
    // behavior, so the port can land dark and be enabled by binding it at the composition root.
    const passivePnlQuote =
      windowStart !== null && lastClosedAt !== null
        ? ((await this.benchmark?.passivePnlQuote(windowStart, lastClosedAt)) ?? null)
        : null;
    const belowPassiveBenchmark =
      passivePnlQuote !== null && netPnl.lte(new Decimal(passivePnlQuote));

    const reasons: PromotionBlockedReason[] = [];
    if (hasUnresolvedFill) reasons.push('UNRESOLVED_FILL');
    if (unconvertibleFeeAsset) reasons.push('UNCONVERTIBLE_FEE_ASSET');
    if (cycles.length < MIN_ROUND_TRIPS) reasons.push('INSUFFICIENT_ROUND_TRIPS');
    if (netPnl.lte(0)) reasons.push('NON_POSITIVE_NET_PNL');
    if (windowDays < MIN_WINDOW_DAYS) reasons.push('INSUFFICIENT_WINDOW');
    if (fundingDataMissing) reasons.push('FUNDING_DATA_MISSING');
    if (belowPassiveBenchmark) reasons.push('BELOW_PASSIVE_BENCHMARK');

    // Per-trip win = net-of-fee PnL > 0 (realized − feesQuote). LLM spend is a book-level cost, not
    // attributed per trip — same definition as RoundTripEvidence.netPnl / trackRecord.winRate.
    const wins = cycles.reduce((n, c) => (c.realizedPnl.minus(c.feesQuote).gt(0) ? n + 1 : n), 0);
    const winRate = cycles.length > 0 ? wins / cycles.length : 0;

    const evidence = {
      roundTrips: cycles.length,
      winRate,
      realizedPnl: realizedPnl.toFixed(),
      fees: fees.toFixed(),
      llmCostUsd: llmCostUsd.toFixed(),
      fundingNet: fundingNet.toFixed(),
      netPnl: netPnl.toFixed(),
      windowDays,
      firstClosedAt,
      lastClosedAt,
      fundingDataMissing,
      // Defect 143: the funding sum is only re-derivable if the recorded verdict says which ingest
      // watermark it covers. Replaying this instant as fundingNetForMode's asOfMs reproduces the
      // exact netQuote this verdict used. Evidence only — no reason keys off it.
      fundingIngestedThroughMs: funding.ingestedThroughMs ?? null,
      passivePnlQuote,
      reasons,
    };

    return reasons.length === 0 ? { permitted: true, evidence } : { permitted: false, evidence };
  }

  // Σ over models of (in×rateIn + out×rateOut + cacheRead×rateCacheRead + cacheCreation×rateCacheWrite)
  // / 1M — each model priced at its OWN rates (W4+W13). All Decimal-on-strings (rates are decimal
  // strings from config). An empty perModel list yields 0 (no LLM calls in the window).
  private llmCostUsd(tokenTotals: { perModel: readonly PerModelTokenTotals[] }): Decimal {
    return tokenTotals.perModel.reduce((sum, m) => {
      // All-zero rows (e.g. 'prescreen'/'plan-executor' journal tags) cost 0 x any rate = 0
      // regardless of which rate resolves, so the unpriced-model warn below is skippable here
      // without touching netPnl either way.
      const hasTokens =
        m.inputTokens > 0 ||
        m.outputTokens > 0 ||
        m.cacheReadTokens > 0 ||
        m.cacheCreationTokens > 0;
      const r = this.ratesFor(m.model, hasTokens);
      const cost = new Decimal(m.inputTokens)
        .div(MTOK)
        .mul(r.input)
        .plus(new Decimal(m.outputTokens).div(MTOK).mul(r.output))
        .plus(new Decimal(m.cacheReadTokens).div(MTOK).mul(r.cacheRead))
        .plus(new Decimal(m.cacheCreationTokens).div(MTOK).mul(r.cacheWrite));
      return sum.plus(cost);
    }, new Decimal(0));
  }

  // Rate resolution order: the model's own entry in tokenPrices → the flat default-model rates
  // (used both when tokenPrices is absent and for the default model itself, which the caller is
  // expected to also list, but the default covers it either way) → for an UNKNOWN model when a
  // tokenPrices map IS configured, the MOST EXPENSIVE rate per component across every configured
  // rate set (defaults + all mapped models). Fail-closed: a cost row naming a model the operator
  // never priced can only ever OVER-count, never silently under-count, inside a live-arming gate.
  private ratesFor(
    model: string,
    hasTokens: boolean,
  ): {
    input: Decimal;
    output: Decimal;
    cacheRead: Decimal;
    cacheWrite: Decimal;
  } {
    const defaults = {
      input: new Decimal(this.cfg.tokenPriceInputPerMtok),
      output: new Decimal(this.cfg.tokenPriceOutputPerMtok),
      cacheRead: new Decimal(this.cfg.tokenPriceCacheReadPerMtok ?? '0'),
      cacheWrite: new Decimal(this.cfg.tokenPriceCacheWritePerMtok ?? '0'),
    };
    const map = this.cfg.tokenPrices;
    if (map === undefined) return defaults;
    const entry = map[model];
    if (entry !== undefined) {
      return {
        input: new Decimal(entry.inputPerMtok),
        output: new Decimal(entry.outputPerMtok),
        cacheRead: new Decimal(entry.cacheReadPerMtok),
        cacheWrite: new Decimal(entry.cacheWritePerMtok),
      };
    }
    const pools = [
      defaults,
      ...Object.values(map).map((e) => ({
        input: new Decimal(e.inputPerMtok),
        output: new Decimal(e.outputPerMtok),
        cacheRead: new Decimal(e.cacheReadPerMtok),
        cacheWrite: new Decimal(e.cacheWritePerMtok),
      })),
    ];
    // Unknown model with a map configured: fail-closed to the most expensive rate per component
    // (see this method's own header comment for the direction). Defect 142 (2026-08-04): this
    // fallback previously left no trace of WHICH model triggered it — a config drift (e.g. a rename
    // that drops an old model id, as happened to claude-opus-4-8) is otherwise invisible outside a
    // manual evidence read. Pure side-effect: never alters the returned rates, so it cannot change
    // the arming verdict or netPnl.
    //
    // Skip entirely when the row carries no tokens (internal journal tags like 'prescreen' /
    // 'plan-executor', never a real model id): 0 x any rate = 0, so netPnl is provably unaffected
    // either way, and this service ticks every 5 min (PromotionMetricsService) — warning on those
    // permanently-unpriceable tags buried the one signal this warn exists for 2:1 in its own noise.
    // Latched per (model) for the process lifetime once a warn does fire, so a real drift logs once,
    // not every tick.
    if (hasTokens && !this.warnedModels.has(model)) {
      this.warnedModels.add(model);
      this.log.warn(
        `promotion cost model "${model}" has no AGENTIC_TOKEN_PRICES_JSON entry — pricing at the fail-closed max-of-configured rate; add an entry to price it exactly.`,
      );
    }
    return {
      input: Decimal.max(...pools.map((p) => p.input)),
      output: Decimal.max(...pools.map((p) => p.output)),
      cacheRead: Decimal.max(...pools.map((p) => p.cacheRead)),
      cacheWrite: Decimal.max(...pools.map((p) => p.cacheWrite)),
    };
  }
}

function zeroEvidence() {
  return {
    roundTrips: 0,
    winRate: 0,
    realizedPnl: '0',
    fees: '0',
    llmCostUsd: '0',
    fundingNet: '0',
    netPnl: '0',
    windowDays: 0,
    firstClosedAt: null,
    lastClosedAt: null,
    fundingDataMissing: false,
    fundingIngestedThroughMs: null,
    // No stats source ⇒ no window ⇒ nothing to benchmark against. Null, never '0': a zero here
    // would read as "passive earned nothing", which the NON_POSITIVE_NET_PNL clause would then
    // silently double-count against a break-even strategy.
    passivePnlQuote: null,
  };
}

function notPermitted(
  reasons: PromotionBlockedReason[],
  evidence: Omit<PromotionReadiness['evidence'], 'reasons'>,
): PromotionReadiness {
  return { permitted: false, evidence: { ...evidence, reasons } };
}
