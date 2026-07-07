import Decimal from 'decimal.js';
import type { CandleEvent, CandleInterval } from '../../../domain/types/market-events';
import type { Signal } from '../../../domain/types/signal';
import type { StrategyId, VenueId, SymbolId, EpochMs } from '../../../domain/types/ids';
import type { SubscriptionSpec } from '../../../domain/types/subscription';
import type { Position } from '../../../domain/types/portfolio';
import type { Price } from '../../../domain/types/money';
import { toIndicatorNumber } from '../../../domain/types/money';
import { aggregateCandles } from '../../../domain/indicators/candle-aggregate';
import {
  emaFromNumbers,
  rsiFromNumbers,
  atrFromNumbers,
  pctChange,
} from '../../../domain/indicators/indicators';
import {
  AgentProposeError,
  type AsyncStrategy,
  type AgentClientPort,
  type AgentDecisionInput,
  type AgentContext,
  type AgentDecisionMeta,
  type AgentHtfIndicators,
  type AgentIndicators,
  type AgentPositionSummary,
  type AgentDecisionRecord,
  type AgentDecisionJournalPort,
  type AgentProposal,
  type StrategyInitContext,
} from '../../../ports/agentic-strategy';
import { MAX_REASON_LEN, type LoggerLike } from './anthropic-agent-client';
import {
  evaluatePrescreen,
  type PrescreenOutcome,
  type PrescreenReason,
  type PrescreenThresholds,
} from './prescreen';

export interface AgenticStrategyParams {
  readonly symbol: SymbolId;
  readonly venue: VenueId;
  readonly interval: CandleInterval;
  readonly warmupBars: number;
  // Model id recorded on every journal entry — the client's own config carries the model it
  // actually calls; this is the strategy's account of it for the journal row. Optional (falls back
  // to DEFAULT_MODEL_ID) so existing callers that predate this field still compile.
  readonly model?: string;
  // Cost-floor pre-screen gate (see prescreen.ts): consulted before every LLM call unless disabled.
  // Optional/absent ⇒ disabled, so existing callers that predate this field stay byte-identical.
  readonly prescreenEnabled?: boolean;
  readonly prescreenThresholds?: PrescreenThresholds;
  // W2.1 stale-entry sweep: a resting non-reduce-only order older than this many observed decide
  // cycles gets a CANCEL_OPEN (risk-reducing; routed by SignalSink to an order-cancel, never to the
  // gateway). Optional/absent/0 ⇒ disabled, so existing callers stay byte-identical.
  readonly entryTtlBars?: number;
}

export interface AgenticStrategyDeps {
  readonly journal?: AgentDecisionJournalPort;
  // Fires once per detected LONG→FLAT round trip, with the running closed-trade count. A later
  // reflection task subscribes; the strategy itself takes no action beyond counting and calling it.
  readonly onClosedTrade?: (count: number) => void;
  // Fires once per decide() call when the prescreen gate is enabled, with its outcome — mirrors the
  // onClosedTrade seam. Optional/no-op-defaulted so existing tests/callers stay valid. `reason` is
  // the finer PrescreenReason behind the outcome (absent for 'failopen_error': evaluatePrescreen
  // itself threw, so no reason was ever computed).
  readonly onPrescreen?: (outcome: PrescreenOutcome, reason?: PrescreenReason) => void;
  readonly logger?: LoggerLike;
}

const MAX_DECISION_HISTORY = 10;
const INDICATOR_WARMUP_CLOSES = 21;
const MAX_JOURNAL_RATIONALE_LEN = 2000;
const NOOP_LOGGER: LoggerLike = { warn: () => undefined };

const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

const HTF_TARGET_MS: Record<'h1' | 'h4', number> = { h1: 3_600_000, h4: 14_400_000 };
// Placeholder journal `model` value for callers that predate AgenticStrategyParams.model (e.g. the
// composition root's construction, wired for real by a later module-wiring task).
const DEFAULT_MODEL_ID = 'unknown';

// Concrete agentic strategy: a thin in-process host-side shell that delegates each decision to the
// out-of-process agent client. It enriches the host's snapshot with computed indicators (own
// timeframe + aggregated HTF), the strategy's own position, and a rolling trail of its own past
// decisions before handing off — it still owns NO trading logic itself (Risk still sizes/vetoes
// every proposed signal). The agent's proposed signals flow through the Risk chokepoint (the host
// calls recordSignal); the host imposes the wall-clock timeout, so decide just enriches and
// delegates. Live access is EARNED via the promotion gate, never assumed (see ports/agentic-strategy.ts).
export class AgenticStrategy implements AsyncStrategy {
  readonly kind = 'agentic' as const;
  readonly id: StrategyId;
  readonly subscriptions: SubscriptionSpec;
  readonly warmup: { readonly interval: CandleInterval; readonly bars: number };

  private readonly client: AgentClientPort;
  private readonly symbol: SymbolId;
  private readonly venue: VenueId;
  private readonly model: string;
  private readonly baseIntervalMs: number;
  private readonly journal?: AgentDecisionJournalPort;
  private readonly onClosedTrade?: (count: number) => void;
  private readonly onPrescreen?: (outcome: PrescreenOutcome, reason?: PrescreenReason) => void;
  private readonly logger: LoggerLike;
  private readonly prescreenEnabled: boolean;
  private readonly prescreenThresholds?: PrescreenThresholds;
  private readonly entryTtlBars: number;
  // W2.1 stale-entry sweep state. OpenOrderSummary carries no timestamps, so age is measured in
  // observed decide cycles: clientOrderId → the snapshot eventTime this strategy FIRST saw the order
  // resting. cancelRequestedAt records when a CANCEL_OPEN was emitted for an id so it isn't re-spammed
  // every bar, but re-arms after another TTL window (covers a lost/failed cancel). Both prune to the
  // currently-open set each cycle; in-memory by design — after a restart, ages restart at zero and a
  // still-resting order is swept AGENTIC_ENTRY_TTL_BARS later (this is also the organic cleanup path
  // for legacy resting orders recovered at boot).
  private readonly entryFirstSeen = new Map<string, EpochMs>();
  private readonly entryCancelRequestedAt = new Map<string, EpochMs>();
  // Venue minimum-notional for this symbol, captured in onInit. Used only to reclassify a sub-minimum
  // "dust" position as flat in the agent's view (see buildContext). null ⇒ unavailable ⇒ no
  // reclassification (fail safe to the prior LONG-when-any-qty behavior).
  private minNotional: Price | null = null;

  // Ring buffer of past decisions, newest-last, capped — self-consistency context handed to the
  // agent each call. The client itself stays stateless; this trail lives host-side in the strategy.
  private readonly history: AgentDecisionRecord[] = [];
  // Combined (realized + unrealized) PnL at the time the most recently pushed, not-yet-annotated
  // history record was made — diffed against the next call's combined PnL to fill that record's
  // outcome.positionPnlDelta just before it is superseded by the new decision.
  private lastCombinedPnl: Decimal | null = null;
  private lastPositionSide: 'LONG' | 'FLAT' | null = null;
  private closedTrades = 0;

  constructor(
    id: StrategyId,
    params: AgenticStrategyParams,
    client: AgentClientPort,
    deps: AgenticStrategyDeps = {},
  ) {
    this.id = id;
    this.client = client;
    this.symbol = params.symbol;
    this.venue = params.venue;
    this.model = params.model ?? DEFAULT_MODEL_ID;
    this.baseIntervalMs = INTERVAL_MS[params.interval];
    this.journal = deps.journal;
    this.onClosedTrade = deps.onClosedTrade;
    this.onPrescreen = deps.onPrescreen;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.prescreenEnabled = params.prescreenEnabled ?? false;
    this.prescreenThresholds = params.prescreenThresholds;
    this.entryTtlBars = params.entryTtlBars ?? 0;
    this.subscriptions = {
      venue: params.venue,
      symbols: [params.symbol],
      channels: { candles: [params.interval] },
    };
    this.warmup = { interval: params.interval, bars: params.warmupBars };
  }

  onInit(ctx: StrategyInitContext): void {
    // Capture the venue minimum-notional for this symbol so buildContext can treat a sub-minimum
    // "dust" position as flat (see its own comment). Absent ⇒ null ⇒ no dust reclassification.
    this.minNotional = ctx.symbolConstraints.get(this.symbol)?.minNotional ?? null;
  }

  async decide(input: AgentDecisionInput): Promise<Signal[]> {
    // Deterministic and prescreen-independent: resting GTC entries otherwise rest forever (nothing
    // enforces expiresAt on ACKED orders — boot 10c8af0c recovered 55 of them). Computed first so
    // both the quiet-hold path and the LLM path return it.
    const staleCancels = this.staleEntryCancels(input);
    const context = this.buildContext(input);
    // Captured before trackClosedTrade advances lastPositionSide to THIS call's side — this is the
    // side the strategy was actually carrying while the PREVIOUS (still-unannotated) decision's
    // outcome accrued, which is what annotatePreviousOutcome needs to render "(held long)"/"(flat)"
    // against the right decision. null (never annotated before) is treated as FLAT — the strategy
    // starts flat.
    const heldDuringPrev = this.lastPositionSide ?? 'FLAT';
    this.trackClosedTrade(context.position.side);

    const prescreenReason = this.evaluatePrescreenGate(input, context);
    if (prescreenReason !== null) {
      return [
        ...staleCancels,
        ...this.recordQuietHold(input, context, heldDuringPrev, prescreenReason),
      ];
    }

    let proposal: AgentProposal;
    try {
      proposal = await this.client.propose({ ...input, context });
    } catch (err) {
      this.recordErrorJournalEntry(input, err);
      throw err;
    }

    const signals = proposal.signals;
    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
    const lastClose = lastCandle ? toIndicatorNumber(lastCandle.close) : NaN;

    // decision is the client's own account when present; the stub client (and any client that
    // omits it) leaves this to a signal-inferred fallback so the decision trail stays populated.
    const decision = proposal.decision ?? this.inferStubDecision(signals);

    this.annotatePreviousOutcome(lastClose, context.position, lastCandle, heldDuringPrev);

    this.history.push({
      eventTime: input.snapshot.eventTime,
      action: decision.action,
      close: lastClose,
      // Truncated to the same bound the client itself applies to a fresh rationale (MAX_REASON_LEN)
      // before this re-enters a later prompt as recentDecisions — an un-truncated rationale (up to
      // MAX_JOURNAL_RATIONALE_LEN) would otherwise carry ~10x more unframed prior-model free text
      // into every subsequent call than the playbook's own DATA-framed block does.
      reason: decision.rationale.slice(0, MAX_REASON_LEN),
    });
    if (this.history.length > MAX_DECISION_HISTORY) this.history.shift();

    this.recordJournalEntry(input, decision, proposal);

    return [...staleCancels, ...signals];
  }

  // W2.1 stale-entry sweep — runs every decide cycle, prescreen-skipped ones included. Emits
  // CANCEL_OPEN for this strategy's own resting BUY orders whose observed resting age (event-time
  // since first sighting) exceeds entryTtlBars × the base interval: risk-reducing by construction
  // (never places orders), exempt from the entry cap and the DRAINING filter (strategy-host
  // RISK_REDUCING), intercepted by SignalSink before the gateway. Reduce-only exits are IOC and
  // never rest, so only BUY entries are swept.
  private staleEntryCancels(input: AgentDecisionInput): Signal[] {
    if (this.entryTtlBars <= 0) return [];
    const open = input.snapshot.portfolio.openOrders.filter(
      (o) => o.symbol === this.symbol && o.side === 'BUY',
    );
    const openIds = new Set<string>(open.map((o) => o.clientOrderId as string));
    for (const id of [...this.entryFirstSeen.keys()]) {
      if (!openIds.has(id)) this.entryFirstSeen.delete(id);
    }
    for (const id of [...this.entryCancelRequestedAt.keys()]) {
      if (!openIds.has(id)) this.entryCancelRequestedAt.delete(id);
    }

    // Ref price resolved BEFORE any id is marked cancel-requested: a no-price bail must not burn
    // the request slot and silently suppress the sweep for a TTL window (reviewer note).
    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
    const ticker = input.snapshot.tickers.get(this.symbol);
    const refPrice = lastCandle?.close ?? ticker?.last;
    if (refPrice === undefined) return [];

    const now = input.snapshot.eventTime;
    const ttlMs = this.entryTtlBars * this.baseIntervalMs;
    let staleFound = false;
    for (const o of open) {
      const id = o.clientOrderId as string;
      const firstSeen = this.entryFirstSeen.get(id);
      if (firstSeen === undefined) {
        this.entryFirstSeen.set(id, now);
        continue;
      }
      if (now - firstSeen < ttlMs) continue;
      // Already requested: re-arm only after another full TTL window (covers a lost/failed cancel
      // without re-spamming every bar while the venue works the first one).
      const requestedAt = this.entryCancelRequestedAt.get(id);
      if (requestedAt !== undefined && now - requestedAt < ttlMs) continue;
      this.entryCancelRequestedAt.set(id, now);
      staleFound = true;
    }
    if (!staleFound) return [];

    return [
      {
        strategyId: this.id,
        venue: this.venue,
        symbol: this.symbol,
        kind: 'CANCEL_OPEN',
        strength: 1,
        refPrice,
        // Never consumed by Risk (SignalSink intercepts CANCEL_OPEN before the gateway), so the
        // seq only needs to be a plausible provenance marker.
        basedOnSeq: lastCandle?.seq ?? ticker?.seq ?? 0n,
        eventTime: now,
        ttlMs: this.baseIntervalMs,
        dedupeKey: `${this.id}:${this.symbol}:agentic:cancel_open:${now}`,
        reason: `stale entry: resting > ${this.entryTtlBars} bars — cancel-open sweep`,
      },
    ];
  }

  // Cost-floor gate (see prescreen.ts). Disabled ⇒ null unconditionally: no counter, no evaluation,
  // unchanged behavior. Enabled ⇒ evaluated over the same candle window buildContext already read for
  // this call, reusing its dust-aware LONG/FLAT classification (context.position.side) rather than
  // re-deriving position-open from the raw portfolio. Returns the quiet reason string when the LLM
  // call should be skipped, else null (either "consult" or the gate itself failed open on an error).
  private evaluatePrescreenGate(input: AgentDecisionInput, context: AgentContext): string | null {
    if (!this.prescreenEnabled || !this.prescreenThresholds) return null;

    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    try {
      const result = evaluatePrescreen({
        closes: candles.map((c) => toIndicatorNumber(c.close)),
        highs: candles.map((c) => toIndicatorNumber(c.high)),
        lows: candles.map((c) => toIndicatorNumber(c.low)),
        positionOpen: context.position.side === 'LONG',
        thresholds: this.prescreenThresholds,
      });
      if (result.consult) {
        this.onPrescreen?.('called', result.reason);
        return null;
      }
      this.onPrescreen?.('skipped_quiet', result.reason);
      return result.reason;
    } catch (err) {
      this.logger.warn(
        `prescreen evaluation failed, failing open to the LLM: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.onPrescreen?.('failopen_error');
      return null;
    }
  }

  // Deterministic HOLD path taken when the prescreen gate skips the LLM call entirely: no client
  // call, no token/decide counters (MetricsWrappingAgentClient never runs), an honest journal row
  // naming the prescreen reason under a distinct 'prescreen' model tag, and the same empty-signal
  // result shape decide() returns for any other HOLD. Unlike a real decision, this skip is NOT pushed
  // into the history ring: the ring is rendered to the LLM as its own prior decisions (agent-prompt.ts),
  // and a prescreen skip was never seen or reasoned about by the model — presenting it as such would
  // fabricate a decision the agent never made. annotatePreviousOutcome still runs unconditionally so
  // the last REAL decision's outcome (price move, PnL delta) keeps accruing through the quiet period.
  private recordQuietHold(
    input: AgentDecisionInput,
    context: AgentContext,
    heldDuringPrev: 'LONG' | 'FLAT',
    reason: string,
  ): Signal[] {
    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
    const lastClose = lastCandle ? toIndicatorNumber(lastCandle.close) : NaN;
    const rationale = `prescreen: ${reason} — LLM not consulted`;

    this.annotatePreviousOutcome(lastClose, context.position, lastCandle, heldDuringPrev);

    this.recordQuietJournalEntry(input, rationale);

    return [];
  }

  onStop(): void {
    this.history.length = 0;
    this.lastCombinedPnl = null;
    this.lastPositionSide = null;
  }

  // Computed indicators (own timeframe + HTF) + own position + decision trail, over the host's
  // immutable snapshot copy.
  private buildContext(input: AgentDecisionInput): AgentContext {
    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    const closes = candles.map((c) => toIndicatorNumber(c.close));
    const highs = candles.map((c) => toIndicatorNumber(c.high));
    const lows = candles.map((c) => toIndicatorNumber(c.low));
    const lastClose = closes.length > 0 ? closes[closes.length - 1]! : null;

    const indicators: AgentIndicators | null =
      closes.length < INDICATOR_WARMUP_CLOSES
        ? null
        : {
            lastClose: closes[closes.length - 1]!,
            emaFast: emaFromNumbers(closes, 9),
            emaSlow: emaFromNumbers(closes, 21),
            rsi14: rsiFromNumbers(closes, 14),
            atr14: atrFromNumbers(highs, lows, closes, 14),
            ret1: pctChange(closes, 1),
            ret5: pctChange(closes, 5),
            ret20: pctChange(closes, 20),
          };

    const openOrders = input.snapshot.portfolio.openOrders.length;
    // applyFillToPortfolio deletes a position once signedQty hits zero (portfolio-state.service.ts),
    // so a matched entry is always LONG and always carries a real avgEntry — there is no separate
    // "flat position record" to special-case.
    let held: Position | undefined;
    for (const p of input.snapshot.portfolio.positions.values()) {
      if (p.symbol === this.symbol && p.signedQty.gt(0)) {
        held = p;
        break;
      }
    }

    // A held position whose notional is below the venue minimum is DUST: a reduce-only exit sized to
    // that sub-minNotional qty is rejected BELOW_MINIMUM by the sizer, so it can never be closed.
    // Surfacing it as LONG only makes the agent spam un-executable exits (and never reach flat, which
    // also starves round-trip accounting). Treat it as FLAT so the agent holds or re-enters — a fresh
    // entry absorbs the dust into a tradable position. minNotional comes from onInit; null ⇒ skip the
    // reclassification. Decimal comparison only — no float on the money path.
    const heldIsDust =
      held !== undefined &&
      this.minNotional !== null &&
      held.signedQty.mul(held.avgEntry).lt(this.minNotional);

    const position: AgentPositionSummary =
      held !== undefined && !heldIsDust
        ? {
            side: 'LONG',
            qty: held.signedQty.toFixed(),
            avgEntry: held.avgEntry.toFixed(),
            realizedPnl: held.realizedPnl.toFixed(),
            unrealizedPnlPct:
              lastClose !== null ? (lastClose / toIndicatorNumber(held.avgEntry) - 1) * 100 : null,
            openOrders,
          }
        : {
            side: 'FLAT',
            qty: '0',
            avgEntry: null,
            realizedPnl: '0',
            unrealizedPnlPct: null,
            openOrders,
          };

    return {
      indicators,
      position,
      recentDecisions: [...this.history],
      htf: this.buildHtfContext(candles),
    };
  }

  private buildHtfContext(candles: readonly CandleEvent[]): AgentContext['htf'] {
    return {
      h1: this.buildHtfIndicators(candles, HTF_TARGET_MS.h1),
      h4: this.buildHtfIndicators(candles, HTF_TARGET_MS.h4),
    };
  }

  // factor is only meaningful when the target timeframe folds evenly into whole base-interval
  // buckets and by more than 1 bar (factor === 1 would just be the strategy's own timeframe again).
  private buildHtfIndicators(
    candles: readonly CandleEvent[],
    targetMs: number,
  ): AgentHtfIndicators | null {
    const factor = targetMs / this.baseIntervalMs;
    if (!Number.isInteger(factor) || factor < 2) return null;

    const htfCandles = aggregateCandles(candles, factor, this.baseIntervalMs).filter(
      (c) => c.closed,
    );
    if (htfCandles.length < INDICATOR_WARMUP_CLOSES) return null;

    const closes = htfCandles.map((c) => toIndicatorNumber(c.close));
    return {
      emaFast: emaFromNumbers(closes, 9),
      emaSlow: emaFromNumbers(closes, 21),
      rsi14: rsiFromNumbers(closes, 14),
    };
  }

  // Stub-only fallback: no client-supplied decision to draw confidence/rationale from (the no-op
  // StubAgentClient, or any client that omits `decision`), so just enough is inferred from the
  // mapped signals to keep the decision trail and journal populated.
  private inferStubDecision(signals: readonly Signal[]): AgentDecisionMeta {
    let action: AgentDecisionMeta['action'] = 'hold';
    if (signals.some((s) => s.kind === 'ENTER_LONG')) action = 'long';
    else if (signals.some((s) => s.kind === 'EXIT_LONG' || s.kind === 'FLATTEN')) action = 'flat';
    return { action, confidence: 0, rationale: '' };
  }

  // Fills in the outcome of the PREVIOUS (still-unannotated) history record before this call's
  // decision supersedes it as the ring's tail — priceMovePct off the two decisions' close prices,
  // positionPnlDelta off the exact combined-PnL delta since that decision was made, heldDuring off
  // the position side that was current as of THAT prior decision (lastPositionSide has already been
  // advanced to the CURRENT call's side by trackClosedTrade before decide() reaches here, so it is
  // captured up front, ahead of that advance, by the caller).
  private annotatePreviousOutcome(
    currentClose: number,
    position: AgentPositionSummary,
    lastCandle: CandleEvent | undefined,
    heldDuring: 'LONG' | 'FLAT',
  ): void {
    const currentCombinedPnl = this.computeCombinedPnl(position, lastCandle?.close);
    if (this.lastCombinedPnl !== null && this.history.length > 0) {
      const prev = this.history[this.history.length - 1]!;
      // NaN/non-finite guard: an undercandled call seeds close as NaN (see decide()), and prev.close
      // <= 0 makes the percentage move meaningless — either poisons the prompt as a literal "NaN%".
      // Left null (not omitted) so the outcome is still recorded for positionPnlDelta/heldDuring.
      const priceMovePct =
        Number.isFinite(currentClose) && Number.isFinite(prev.close) && prev.close > 0
          ? ((currentClose - prev.close) / prev.close) * 100
          : null;
      const positionPnlDelta = currentCombinedPnl.minus(this.lastCombinedPnl).toFixed();
      this.history[this.history.length - 1] = {
        ...prev,
        outcome: { priceMovePct, positionPnlDelta, heldDuring },
      };
    }
    this.lastCombinedPnl = currentCombinedPnl;
  }

  private computeCombinedPnl(
    position: AgentPositionSummary,
    closePrice: Price | undefined,
  ): Decimal {
    const realized = new Decimal(position.realizedPnl);
    if (position.side !== 'LONG' || closePrice === undefined) return realized;
    // avgEntry is always non-null on a LONG summary (buildContext's held/LONG invariant above).
    const unrealized = closePrice.minus(new Decimal(position.avgEntry!)).times(position.qty);
    return realized.plus(unrealized);
  }

  private trackClosedTrade(side: 'LONG' | 'FLAT'): void {
    if (this.lastPositionSide === 'LONG' && side === 'FLAT') {
      this.closedTrades += 1;
      this.onClosedTrade?.(this.closedTrades);
    }
    this.lastPositionSide = side;
  }

  // basedOnSeq/refPrice for the journal ride on whichever market-data point is freshest, mirroring
  // AnthropicAgentClient's own convention (ticker preferred, else the last closed candle); an
  // 'exec' trigger and a symbol with neither yet fall back to a neutral 0n/null.
  private deriveMarketBasis(input: AgentDecisionInput): {
    readonly basedOnSeq: bigint;
    readonly refPrice: Price | null;
  } {
    const ticker = input.snapshot.tickers.get(this.symbol);
    if (ticker) return { basedOnSeq: ticker.seq, refPrice: ticker.last };
    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
    if (lastCandle) return { basedOnSeq: lastCandle.seq, refPrice: lastCandle.close };
    return { basedOnSeq: 0n, refPrice: null };
  }

  // proposal is absent only for the prescreen quiet-HOLD path (recordQuietHold) — no client call was
  // ever made, so there is no usage/latency/playbook telemetry to map through; those fields fall back
  // to the same null/'' the client-omits-decision stub path already uses.
  private recordJournalEntry(
    input: AgentDecisionInput,
    decision: AgentDecisionMeta,
    proposal?: AgentProposal,
  ): void {
    if (!this.journal) return;
    const { basedOnSeq, refPrice } = this.deriveMarketBasis(input);
    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
    try {
      this.journal.record({
        strategyId: this.id,
        symbol: this.symbol,
        venue: this.venue,
        triggerKind: input.trigger.kind,
        basedOnSeq,
        eventTime: input.snapshot.eventTime,
        model: this.model,
        action: decision.action,
        confidence: decision.confidence,
        rationale: decision.rationale.slice(0, MAX_JOURNAL_RATIONALE_LEN),
        refPrice: refPrice ? refPrice.toFixed() : null,
        close: lastCandle ? lastCandle.close.toFixed() : null,
        inputTokens: proposal?.usage?.inputTokens ?? null,
        outputTokens: proposal?.usage?.outputTokens ?? null,
        latencyMs: proposal?.latencyMs ?? null,
        playbookVersion: proposal?.playbookVersion ?? null,
        promptHash: proposal?.promptHash ?? '',
        inputPayload: proposal?.inputPayload ?? null,
      });
    } catch {
      // A journal failure must never affect trading — it's an analysis artifact, not a safety
      // interlock (see AGENT_DECISION_JOURNAL doc in ports/agentic-strategy.ts).
    }
  }

  private recordErrorJournalEntry(input: AgentDecisionInput, err: unknown): void {
    if (!this.journal) return;
    const { basedOnSeq, refPrice } = this.deriveMarketBasis(input);
    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
    const kind = err instanceof AgentProposeError ? err.kind : 'RETRYABLE';
    const status = err instanceof AgentProposeError ? err.status : undefined;
    try {
      this.journal.record({
        strategyId: this.id,
        symbol: this.symbol,
        venue: this.venue,
        triggerKind: input.trigger.kind,
        basedOnSeq,
        eventTime: input.snapshot.eventTime,
        model: this.model,
        action: 'error',
        confidence: null,
        // Never the underlying message: it may echo transport detail beyond kind/status. Never the
        // key, never the response body.
        rationale: status !== undefined ? `${kind} (status ${status})` : kind,
        refPrice: refPrice ? refPrice.toFixed() : null,
        close: lastCandle ? lastCandle.close.toFixed() : null,
        inputTokens: null,
        outputTokens: null,
        latencyMs: null,
        playbookVersion: null,
        promptHash: '',
        inputPayload: null,
      });
    } catch {
      // See recordJournalEntry — a journal failure must never affect trading.
    }
  }

  // model is 'prescreen' (not this.model) — an honest account that no LLM call was made for this
  // row, distinguishable at a glance from every client-sourced decision on the same strategyId.
  private recordQuietJournalEntry(input: AgentDecisionInput, rationale: string): void {
    if (!this.journal) return;
    const { basedOnSeq, refPrice } = this.deriveMarketBasis(input);
    const candles = input.snapshot.candles.get(this.symbol) ?? [];
    const lastCandle = candles.length > 0 ? candles[candles.length - 1] : undefined;
    try {
      this.journal.record({
        strategyId: this.id,
        symbol: this.symbol,
        venue: this.venue,
        triggerKind: input.trigger.kind,
        basedOnSeq,
        eventTime: input.snapshot.eventTime,
        model: 'prescreen',
        action: 'hold',
        confidence: null,
        rationale: rationale.slice(0, MAX_JOURNAL_RATIONALE_LEN),
        refPrice: refPrice ? refPrice.toFixed() : null,
        close: lastCandle ? lastCandle.close.toFixed() : null,
        inputTokens: null,
        outputTokens: null,
        latencyMs: null,
        playbookVersion: null,
        promptHash: '',
        inputPayload: null,
      });
    } catch {
      // See recordJournalEntry — a journal failure must never affect trading.
    }
  }
}
