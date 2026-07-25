import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { KILL_SWITCH, type KillSwitchPort } from '../../../ports/trading/risk';
import {
  EQUITY_LIMITS,
  type EquityLimits,
  type EquitySample,
} from '../../../ports/trading/execution';
import { dailyLossTripped, drawdownTripped } from '../../../domain/trading/risk/equity-monitor';
import { PortfolioStateService } from './portfolio-state.service';

// §5 post-trade monitors — the PRIMARY owners of C1 (daily loss) and C2 (drawdown). Subscribed to
// the equity sampler, they evaluate every sample (per-fill + 5s). Three pinned behaviours:
//   • UTC rollover re-anchors start-of-day equity (peak is NOT reset — drawdown is all-time);
//   • PRECEDENCE on a same-sample double trip: drawdown wins, so the kill switch engages with
//     flatten=true (daily loss alone halts WITHOUT flattening — you do not force-sell into a daily
//     loss; the operator decides). A single engage call, never two, so the flatten is never lost;
//   • re-trip is idempotent: once halted the monitor stops engaging (the kill-switch reducer would
//     absorb it anyway, but guarding on RUNNING also keeps the halt reason from churning). A later
//     drawdown after a daily-loss halt is therefore absorbed — operator-owned, manual resume only.
// Hysteresis band for causeCleared (security review, 2026-07-22). Clearing must NOT be the bare
// negation of tripping against the SAME threshold: equity hovering at the limit would flap trip/clear
// sample by sample, letting RecoveryCoordinatorService resume straight back into a cause that re-trips
// on the very next sample. Clearing therefore requires recovery to within (1 − CLEAR_BAND) of the
// limit — strictly harder to clear than to trip.
//
// FAIL CLOSED (rules/code-hygiene.md failure-direction): this band only ever TIGHTENS the clear test.
// The trip test in onSample below is deliberately untouched, so protection still engages at exactly
// the configured limit — the band can delay a resume, never delay a halt. 0.25 (recover to 75% of the
// limit) is a loop-domain measurement choice, tunable if soak evidence says the band is too wide.
const CLEAR_BAND = new Decimal('0.25');

@Injectable()
export class EquityMonitorService {
  private lastSessionDate: string | undefined;
  // Monotonic count of equity samples OBSERVED, incremented before any early return so it advances
  // even while halted (EquitySamplerService's 5s tick runs regardless of kill-switch state). Read by
  // RecoveryCoordinatorService so its 2-pass debounce counts two DISTINCT observations rather than
  // sampling one 5s-old value twice on consecutive 1s ticks — see observationSeq's own comment.
  private observations = 0;

  constructor(
    private readonly portfolio: PortfolioStateService,
    @Inject(KILL_SWITCH) private readonly killSwitch: KillSwitchPort,
    @Inject(EQUITY_LIMITS) private readonly limits: EquityLimits,
  ) {}

  onSample(sample: EquitySample): void {
    this.observations += 1; // before every early return — see the field's own comment
    const equity = new Decimal(sample.equity);

    // Re-anchor at the UTC day boundary regardless of kill state — start-of-day bookkeeping.
    if (this.lastSessionDate !== undefined && sample.sessionDateUtc !== this.lastSessionDate) {
      this.portfolio.anchorStartOfDay(equity);
    }
    this.lastSessionDate = sample.sessionDateUtc;

    if (this.killSwitch.state() !== 'RUNNING') return; // already halted — re-trip absorbed

    const dd = drawdownTripped(new Decimal(sample.peak), equity, this.limits.maxDrawdownPct);
    const dl = dailyLossTripped(this.portfolio.sodEquity(), equity, this.limits.maxDailyLoss);
    if (dd) {
      this.killSwitch.engage('MAX_DRAWDOWN', true); // drawdown flattens (precedence over daily loss)
    } else if (dl) {
      this.killSwitch.engage('DAILY_LOSS', false); // daily loss halts; positions ride, operator decides
    }
  }

  // RecoveryCoordinatorService's per-cause condition-clearing read (owner-authorized auto-resume,
  // 2026-07-22): re-evaluates the SAME pure predicates onSample uses above, against the LIVE current
  // equity/peak/sod — EquitySamplerService's 5s tick keeps these current unconditionally, regardless
  // of kill-switch state (equity-sampler.service.ts's sample() calls portfolio.recordEquity() before
  // ever consulting state). DAILY_LOSS clears via EITHER of dailyLossTripped's own inputs moving: a
  // UTC-day rollover re-anchors sodUtc := equity elsewhere in this class (making the diff ~0), OR
  // equity recovers above the trip threshold against an unchanged sod — no separate "did the day
  // roll over" branch is needed, dailyLossTripped already folds both. MAX_DRAWDOWN clears ONLY via
  // equity recovering against the NEVER-RESET peak (see this class's own header comment on why
  // drawdown is all-time, not per-day) — a fully-flattened position (MAX_DRAWDOWN always flattens)
  // cannot itself move equity, so this cause is expected to require either fresh capital or a long
  // mark-to-market recovery before it clears; that is intended conservatism, not a bug.
  //
  // HYSTERESIS (security review, 2026-07-22): each cause is tested against a limit TIGHTENED by
  // CLEAR_BAND, never against the raw trip threshold — see CLEAR_BAND's own comment for why the bare
  // negation flaps. Both predicates take their limit as an exact string, so the band is applied in
  // Decimal and rendered with toFixed() — no float ever touches a money path (CLAUDE.md rule 1).
  causeCleared(cause: 'MAX_DRAWDOWN' | 'DAILY_LOSS'): boolean {
    const equity = this.portfolio.snapshot().equity;
    const tightened = (limit: string): string =>
      new Decimal(limit).mul(new Decimal(1).sub(CLEAR_BAND)).toFixed();
    if (cause === 'MAX_DRAWDOWN') {
      return !drawdownTripped(
        this.portfolio.peakEquity(),
        equity,
        tightened(this.limits.maxDrawdownPct),
      );
    }
    return !dailyLossTripped(
      this.portfolio.sodEquity(),
      equity,
      tightened(this.limits.maxDailyLoss),
    );
  }

  // RecoveryCoordinatorService's debounce input: a monotonic per-sample counter. Its
  // REQUIRED_CLEAN_PASSES=2 runs on a 1s tick, but equity is only rewritten every 5s by
  // EquitySamplerService — so without this, two "consecutive clean passes" are usually ONE observation
  // counted twice and the debounce protects against nothing. The coordinator requires this value to
  // ADVANCE between clean passes, making the debounce two genuinely independent confirmations.
  observationSeq(): number {
    return this.observations;
  }
}
