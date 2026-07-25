import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { InjectMetric, makeCounterProvider } from '@willsoto/nestjs-prometheus';
import { Counter } from 'prom-client';
import Decimal from 'decimal.js';
import { CLOCK, type ClockPort } from '../../../ports/common/clock';
import { FEED_HEALTH, type FeedHealthPort } from '../../../ports/venue/market-data';
import {
  RISK_ENGINE_DEPS,
  RISK_JOURNAL,
  type RiskEnginePort,
  type RiskEngineDeps,
  type RiskJournalPort,
} from '../../../ports/trading/risk';
import { evaluate, type MarkInfo, type RiskEvalInput } from '../../../domain/trading/risk/evaluate';
import { mintApproval } from '../../../domain/trading/risk/proof';
import { KillSwitchService } from './kill-switch.service';
import { RateBucketsService } from './rate-buckets.service';
import { CrossingRegistryService } from './crossing-registry.service';
import type { OrderIntent } from '../../../domain/trading/types/order-intent';
import type { PortfolioSnapshot } from '../../../domain/trading/types/portfolio';
import type { RiskDecision } from '../../../domain/trading/types/risk-decision';
import { epochMs, type EpochMs } from '../../../domain/common/types/ids';

// §8 rejection taxonomy — risk stage. eslint-plugin-boundaries forbids features/trading/risk importing the
// execution gate's orders_rejected_total, so risk vetoes are counted here by reason code; the
// dashboard unions this with orders_rejected_total{stage=oms|exchange} for the full taxonomy.
// @Optional injection so the directly-constructed unit tests cover the metric-absent branch.
export const RISK_REJECTIONS_COUNTER = makeCounterProvider({
  name: 'risk_rejections_total',
  help: 'Risk-engine vetoes by reason code (§5/§8 rejection taxonomy, risk stage)',
  labelNames: ['code'] as const,
});

@Injectable()
export class RiskEngineService implements RiskEnginePort {
  private readonly log = new Logger('RiskEngine');

  constructor(
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(RISK_ENGINE_DEPS) private readonly deps: RiskEngineDeps,
    @Inject(FEED_HEALTH) private readonly feed: FeedHealthPort,
    private readonly killSwitch: KillSwitchService,
    private readonly rates: RateBucketsService,
    private readonly crossing: CrossingRegistryService,
    @Inject(RISK_JOURNAL) private readonly journal: RiskJournalPort,
    @Optional()
    @InjectMetric('risk_rejections_total')
    private readonly riskRejects?: Counter<string>,
  ) {}

  // Journal every decision and, for a veto, count it by reason code for the §8 rejection taxonomy.
  // The no-op default journals nothing; the DB-backed RiskDecisionJournalAdapter inserts
  // fire-and-forget (an ANALYSIS artifact, not a safety interlock — order_events, written
  // synchronously in ExecutionGate's write-ahead path, is the durability guarantee that gates side
  // effects). So `record` returning does NOT imply the risk_decisions row is durable.
  private record(decision: RiskDecision): void {
    this.journal.record(decision);
    if (decision.verdict === 'REJECTED') {
      for (const code of decision.reasons) this.riskRejects?.inc({ code });
    }
  }

  // Strategy path: isFlatten=false ⇒ normal rate buckets, hard-reject on band/notional/exposure.
  evaluate(intent: OrderIntent, snapshot: PortfolioSnapshot): RiskDecision {
    return this.run(intent, snapshot, false);
  }

  // Kill-switch FLATTEN path (§5 G0 carve-out): isFlatten=true ⇒ band/notional CLAMP instead of
  // reject, passes G0 while FLATTENING, and draws from the RESERVED flatten rate bucket so a
  // strategy storm can never starve the bot's ability to flatten.
  evaluateFlatten(intent: OrderIntent, snapshot: PortfolioSnapshot): RiskDecision {
    return this.run(intent, snapshot, true);
  }

  private run(intent: OrderIntent, snapshot: PortfolioSnapshot, isFlatten: boolean): RiskDecision {
    const now = this.clock.now();

    // Missing exchange filters means incomplete venue config — reject rather than
    // risk a NaN-rounded quantity (the sizer also guards this upstream).
    const filters = this.deps.filters.get(intent.symbol);
    if (!filters) {
      const decision: RiskDecision = {
        verdict: 'REJECTED',
        intent,
        reasons: ['LIMITS_INCOMPLETE'],
      };
      this.record(decision);
      return decision;
    }

    // Build the freshness-stamped mark from the feed-health port.
    //
    // Health is the best of the two channels that CAN produce the mark: getRefPrice is fed by BOTH
    // the ticker and the order-book channels (teeing-market-stream.ts's observe() calls setRef() from
    // a TICKER event and from an ORDER_BOOK_SNAPSHOT alike). Probing 'book' alone vetoed every symbol
    // outside the active menu — book is subscribed per-menu, and health() answers its unknown-channel
    // default 'GAP' otherwise — which also vetoed reduce-only EXITS and protective stops, so a
    // position could become unexitable through the strategy path once its book parked.
    //
    // This DELIBERATELY REPEALS XA6's "a lite (non-menu, unpositioned) symbol must not pass entry
    // gates either" invariant, which the book probe implemented. That invariant is now carried where
    // it belongs — the off-menu proposal block in batching-agent-client.ts — rather than by vetoing on
    // a channel that did not produce the price. Dated record: reports/loop/LOG.md, 2026-07-22.
    //
    // NOT a weakening of the staleness gate: evaluate.ts bounds the ref price's own age on BOTH sides,
    // so a quiet feed and a future-stamped one still veto. Caveat this does not solve: getRefPrice
    // returns no provenance, so this cannot probe the channel that actually wrote the price — a
    // DEGRADED book is tolerated while the ticker is LIVE. That is sound only because a DEGRADED
    // channel's own last write is older than STALE_THRESHOLD_MS, so the age bound vetoes it anyway.
    const ref = this.feed.getRefPrice(intent.symbol);
    const mark: MarkInfo | undefined = ref
      ? {
          mid: ref.mid,
          ageMs: now - ref.at,
          feedHealth:
            this.feed.health(intent.venue, intent.symbol, 'book') === 'LIVE' ||
            this.feed.health(intent.venue, intent.symbol, 'ticker') === 'LIVE'
              ? 'LIVE'
              : this.feed.health(intent.venue, intent.symbol, 'ticker'),
          lastTrade: ref.mid, // flatten's stale carve-out (P1) falls back to last trade with band ×2
        }
      : undefined;

    // Pre-trade exposure across all positions, valued at average entry (Phase-4 proxy
    // until the portfolio layer supplies live marks per symbol).
    let gross = new Decimal(0);
    let net = new Decimal(0);
    for (const p of snapshot.positions.values()) {
      const notional = p.signedQty.mul(p.avgEntry);
      gross = gross.add(notional.abs());
      net = net.add(notional);
    }
    // Reserved exposure: resting-or-in-flight ENTRY orders (reduceOnly=false) commit capital before
    // they fill, but positions-only accounting above is blind to them — a resting entry on one
    // symbol was invisible to another symbol's gross/net headroom, so sequential entries could each
    // individually clear E2/E3 while the aggregate (filled + pending) breached the cap (CONFIRMED
    // risk-cap bypass; mirrors E1's own inFlightIntents fold below, which already guards the
    // per-symbol case). Reduce-only orders only ever shrink exposure, so they reserve nothing. Valued
    // at each order's own limit price; falls back to its own refPrice for the (never-hit for a
    // non-reduce-only entry) undefined case. FAILS CLOSED: a partially-filled order's already-filled
    // leg is counted here AND in snapshot.positions above — deliberate over-reservation, never
    // under-reservation (risk gates fail closed).
    for (const f of snapshot.inFlightIntents) {
      if (f.reduceOnly) continue;
      const notional = f.qty.mul(f.limitPrice ?? f.refPrice);
      gross = gross.add(notional.abs());
      net = net.add(f.side === 'BUY' ? notional : notional.neg());
    }

    // The flatten path draws from the reserved flatten bucket (isFlatten=true); the strategy path
    // (incl. a strategy's own reduce-only EXIT_LONG) draws from the normal buckets.
    const rate = this.rates.check(intent.symbol, intent.strategyId, isFlatten);
    const input: RiskEvalInput = {
      intent,
      isFlatten,
      snapshot,
      limits: this.deps.limits,
      killState: this.killSwitch.state(),
      effectiveMode: this.deps.mode,
      mark,
      filters,
      rate,
      wouldCross: this.crossing.wouldCross(
        intent.strategyId,
        intent.symbol,
        intent.side,
        intent.limitPrice,
      ),
      currentGross: gross,
      currentNet: net,
      now,
    };

    const result = evaluate(input);
    const decision = this.finalize(result, now);
    this.record(decision); // journaled fire-and-forget (see record()); durability is order_events, not this
    // Diagnostic (2026-07-23): STALE_DATA collapses four distinct failures — no ref price at all, a
    // future/negative-age stamp, a genuinely aged mark, or a non-LIVE feed. The risk_decisions row
    // records only the taxonomy reason, so a veto was previously un-diagnosable without a redeploy
    // (this cost a mis-aimed fix earlier this session). Name the sub-cause here; Logger.warn is
    // non-throwing and off the money result.
    if (decision.verdict === 'REJECTED' && decision.reasons.includes('STALE_DATA')) {
      const cause =
        mark === undefined
          ? 'no-ref-price'
          : mark.ageMs < 0
            ? `future-stamp(age=${mark.ageMs}ms)`
            : mark.feedHealth !== 'LIVE'
              ? `feed=${mark.feedHealth}`
              : `aged(age=${mark.ageMs}ms)`;
      this.log.warn(`STALE_DATA veto ${String(intent.symbol)}@${String(intent.venue)}: ${cause}`);
    }
    return decision;
  }

  private finalize(result: ReturnType<typeof evaluate>, now: EpochMs): RiskDecision {
    if (result.verdict === 'REJECTED') {
      if (result.halt) this.killSwitch.engage(result.halt, result.halt === 'MAX_DRAWDOWN');
      return { verdict: 'REJECTED', intent: result.intent, reasons: result.reasons };
    }
    const approved = mintApproval(result.intent, this.deps.key, {
      nonce: Buffer.from(this.deps.randomBytes(16)).toString('hex'),
      approvedAtMs: epochMs(now),
      limitsVersion: this.deps.limitsVersion,
      snapshotSeq: result.intent.refSeq,
    });
    return result.verdict === 'APPROVED'
      ? { verdict: 'APPROVED', approved }
      : { verdict: 'RESIZED', approved, originalQty: result.originalQty, reasons: result.reasons };
  }
}
