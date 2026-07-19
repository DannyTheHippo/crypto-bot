import Decimal from 'decimal.js';

// P5 (Design § Learning & measurement stack): exec-quality digest — maker fill rate, missed-entry
// opportunity cost, and post-fill adverse drift over a rolling window of recent entry attempts.
// Rendered into BOTH the live decide payload (agent-prompt.ts's BuildMarketPayloadExtras.execQuality
// — a rendered STRING, not a structured object; digest() below returns that exact type) and the
// reflection digest (reflection.service.ts), so the model learns when maker patience pays vs when
// taker urgency was worth the extra cost.
//
// Data source (documented, WORK1 — investigated, not assumed): no production fan-out of
// ExecReport/order-lifecycle events reaches the agentic composition root today
// (strategy-host.ts's enqueueExecReport has zero production callers — verified by a full-tree
// search; the method is exercised only by test fixtures). recordEntryAttempt below is therefore a
// clean, host-fed SEAM rather than a subscription onto an existing fan-out: whoever the composition
// root eventually points at the order lifecycle (an order's terminal state — FILLED/EXPIRED/
// CANCELED — joined with that order's own limitPrice/style, e.g. via the orders/fills tables) calls
// it once per terminal entry attempt. Until that wiring lands, digest() simply stays undefined
// (fail-open omission, the SAME "absent ⇒ no key" convention every other optional payload block in
// this codebase already uses) — this service is never a hard dependency the trading path can break
// on, and an unwired instance is indistinguishable from "not enough data yet".
//
// Money-path note: limitPrice/fillPrice arrive as decimal STRINGS (money hard rule 1). The bps
// figures derived from them are RESEARCH/OBSERVABILITY metrics, never re-minted into a Price/Qty and
// never fed back into a money path — the same "Decimal in, plain number out" convention
// counterfactual-scoring.ts's own header documents for its own bps math.
//
// Forward resolution (the two things that are NOT knowable at record() time): an EXPIRED/CANCELLED
// attempt's "missed move" and a FILLED attempt's "adverse drift" both need a price N bars AFTER the
// attempt's terminal time. Attempts are queued in `pending` and resolved lazily (resolvePending,
// called from digest()) via an injected priceLookup pull — never computed eagerly on record(). An
// attempt whose resolution price isn't available yet (priceLookup returns undefined — not enough
// forward history) simply stays pending and is retried on the next resolvePending() call; it is
// never dropped for that reason alone (only the rolling window's own age/count cap ever drops it).

export type ExecQualitySide = 'long' | 'short';
export type ExecQualityOutcome = 'filled' | 'expired' | 'cancelled';

export interface ExecQualityEntryAttempt {
  readonly symbol: string;
  readonly side: ExecQualitySide;
  readonly style: 'maker' | 'taker';
  // The order's intended entry price — a resting maker limit price for a maker attempt. A taker
  // attempt reaching this service is always 'filled' (a taker order fills-or-rejects immediately; it
  // never expires/cancels unfilled), so limitPrice there is just the reference price it crossed —
  // still the correct drift baseline.
  readonly limitPrice: string;
  readonly outcome: ExecQualityOutcome;
  // Present iff outcome === 'filled'.
  readonly fillPrice?: string;
  // Epoch ms the attempt reached its terminal state (fill/expiry/cancel) — the anchor resolvePending
  // measures N bars forward from.
  readonly terminalAt: number;
}

// Pull-based (not push): the service asks for a price at-or-after a given time rather than being fed
// a candle stream, so it never needs to buffer candle history itself. Returns undefined when the
// caller has no price yet for that point (not enough forward history) — see resolvePending's own
// comment on why that leaves the attempt pending rather than resolving to a bad value.
export type ExecQualityPriceLookup = (symbol: string, atOrAfterMs: number) => string | undefined;

export interface ExecQualityServiceConfig {
  readonly priceLookup: ExecQualityPriceLookup;
  readonly nowFn?: () => number;
  // Bars forward from terminalAt the missed-move/adverse-drift resolution price is read at, and the
  // bar duration used to convert that into a resolveAt timestamp. Defaults mirror the agentic lane's
  // 15m base interval (matches agentic.strategy.ts's own INTERVAL_MS['15m'], also referenced by
  // universe-scanner.service.ts's QUOTE_VOLUME_WINDOW_BARS comment) — kept a config knob here rather
  // than imported, so this observability service carries no dependency on the strategy's internals.
  readonly resolutionBars?: number;
  readonly barIntervalMs?: number;
}

interface PendingResolution {
  readonly attempt: ExecQualityEntryAttempt;
  readonly resolveAt: number;
}

interface ResolvedMiss {
  readonly kind: 'missed';
  readonly at: number;
  // Positive = price ran favorably (relative to the declined side) after the attempt expired/
  // cancelled unfilled — a genuine missed opportunity. Negative = the unfilled order would have lost
  // money anyway; not filling was fine.
  readonly bps: number;
}

interface ResolvedDrift {
  readonly kind: 'drift';
  readonly at: number;
  // Positive = adverse move (against the side taken) within the resolution window after fill.
  // Negative = favorable drift — a "clean" fill.
  readonly bps: number;
}

type ResolvedEntry = ResolvedMiss | ResolvedDrift;

const DEFAULT_RESOLUTION_BARS = 8;
const DEFAULT_BAR_INTERVAL_MS = 900_000; // 15m — see ExecQualityServiceConfig's own comment
const WINDOW_MAX_ENTRIES = 50;
const WINDOW_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// digest() stays undefined below this many TOTAL attempts in the window — fail-open omission
// matching every other "absent ⇒ no key" optional payload block (agent-prompt.ts's own convention).
const MIN_ATTEMPTS_FOR_DIGEST = 5;

function bpsMove(from: string, to: string): number {
  return new Decimal(to).minus(from).div(from).times(10_000).toNumber();
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export class ExecQualityService {
  private readonly priceLookup: ExecQualityPriceLookup;
  private readonly nowFn: () => number;
  private readonly resolutionBars: number;
  private readonly barIntervalMs: number;

  private attempts: ExecQualityEntryAttempt[] = [];
  private pending: PendingResolution[] = [];
  private resolved: ResolvedEntry[] = [];

  constructor(cfg: ExecQualityServiceConfig) {
    this.priceLookup = cfg.priceLookup;
    this.nowFn = cfg.nowFn ?? Date.now;
    this.resolutionBars = cfg.resolutionBars ?? DEFAULT_RESOLUTION_BARS;
    this.barIntervalMs = cfg.barIntervalMs ?? DEFAULT_BAR_INTERVAL_MS;
  }

  // Called once per terminal entry attempt (see this file's header comment on the seam this feeds).
  // Storage only — resolution of the forward-looking metrics happens lazily in resolvePending, never
  // here, so recordEntryAttempt never depends on priceLookup already having forward data available.
  recordEntryAttempt(attempt: ExecQualityEntryAttempt): void {
    this.attempts.push(attempt);
    this.pending.push({
      attempt,
      resolveAt: attempt.terminalAt + this.resolutionBars * this.barIntervalMs,
    });
    this.prune(this.nowFn());
  }

  private prune(now: number): void {
    const cutoff = now - WINDOW_MAX_AGE_MS;
    this.attempts = this.attempts.filter((a) => a.terminalAt >= cutoff);
    if (this.attempts.length > WINDOW_MAX_ENTRIES) {
      this.attempts = this.attempts.slice(this.attempts.length - WINDOW_MAX_ENTRIES);
    }
    // A pending attempt that has aged out of the window is no longer worth resolving — dropping it
    // here (rather than only at resolveAt) bounds `pending`'s size to the window regardless of how
    // long priceLookup keeps returning undefined for it.
    this.pending = this.pending.filter((p) => p.attempt.terminalAt >= cutoff);
    this.resolved = this.resolved.filter((r) => r.at >= cutoff);
  }

  // Resolves every pending attempt whose forward-resolution time has arrived, via the injected
  // priceLookup. A lookup miss (undefined) leaves the attempt pending for the next call — see this
  // file's header comment. Private: exercised indirectly through digest(), which always resolves
  // before rendering so the digest never reports stale pending counts.
  private resolvePending(): void {
    const now = this.nowFn();
    const stillPending: PendingResolution[] = [];
    for (const p of this.pending) {
      if (p.resolveAt > now) {
        stillPending.push(p);
        continue;
      }
      const price = this.priceLookup(p.attempt.symbol, p.resolveAt);
      if (price === undefined) {
        stillPending.push(p);
        continue;
      }
      if (p.attempt.outcome === 'filled') {
        // Contract guard (never expected — the DTO documents fillPrice as present iff filled): drop
        // rather than resolve on a missing baseline. Fails open (never blocks/throws), same posture
        // as every other guard in this file.
        if (p.attempt.fillPrice === undefined) continue;
        const raw = bpsMove(p.attempt.fillPrice, price);
        // Adverse = moved against the side taken: for long, a drop is adverse (negate raw, since
        // bpsMove is signed "up is positive"); for short, a rise is adverse (raw as-is).
        const adverseBps = p.attempt.side === 'long' ? -raw : raw;
        this.resolved.push({ kind: 'drift', at: p.resolveAt, bps: adverseBps });
      } else {
        const raw = bpsMove(p.attempt.limitPrice, price);
        // Favorable = the move the missed fill would have captured: for long, a rise is favorable
        // (raw as-is); for short, a drop is favorable (negate raw).
        const missBps = p.attempt.side === 'long' ? raw : -raw;
        this.resolved.push({ kind: 'missed', at: p.resolveAt, bps: missBps });
      }
    }
    this.pending = stillPending;
    this.prune(now);
  }

  // undefined until MIN_ATTEMPTS_FOR_DIGEST total attempts have landed in the rolling window — see
  // this constant's own comment. Consumers (agent-prompt.ts's BuildMarketPayloadExtras.execQuality,
  // reflection.service.ts's ReflectionServiceDeps.execQuality) both treat `undefined` as "omit the
  // key entirely", never as a zeroed/empty block.
  digest(): string | undefined {
    this.resolvePending();
    if (this.attempts.length < MIN_ATTEMPTS_FOR_DIGEST) return undefined;

    // Maker fill rate (Design § Learning, WORK1a) is scoped to MAKER attempts only — a taker order
    // always fills-or-rejects immediately (never expires/cancels unfilled, see the DTO's own
    // comment), so folding taker attempts into the denominator would silently inflate the rate.
    const makerAttempts = this.attempts.filter((a) => a.style === 'maker');
    const makerFilled = makerAttempts.filter((a) => a.outcome === 'filled').length;
    const fillRatePct =
      makerAttempts.length > 0 ? (makerFilled / makerAttempts.length) * 100 : null;

    const misses = this.resolved.filter((r): r is ResolvedMiss => r.kind === 'missed');
    const drifts = this.resolved.filter((r): r is ResolvedDrift => r.kind === 'drift');
    const meanMissBps = average(misses.map((m) => m.bps));
    const meanDriftBps = average(drifts.map((d) => d.bps));

    const fmt = (v: number | null): string => (v === null ? 'n/a' : v.toFixed(1));
    // Compact (~70 chars typical, well under the ~400-char budget) — one line the model reads
    // alongside its other digests, not a table.
    return (
      `execQuality: fillRate=${fmt(fillRatePct)}% missedMoveBps=${fmt(meanMissBps)} ` +
      `adverseDriftBps=${fmt(meanDriftBps)} n=${this.attempts.length}`
    );
  }
}
