import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { KILL_SWITCH, type KillSwitchPort } from '../../ports/risk';
import { EQUITY_LIMITS, type EquityLimits, type EquitySample } from '../../ports/execution';
import { dailyLossTripped, drawdownTripped } from '../../domain/risk/equity-monitor';
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
@Injectable()
export class EquityMonitorService {
  private lastSessionDate: string | undefined;

  constructor(
    private readonly portfolio: PortfolioStateService,
    @Inject(KILL_SWITCH) private readonly killSwitch: KillSwitchPort,
    @Inject(EQUITY_LIMITS) private readonly limits: EquityLimits,
  ) {}

  onSample(sample: EquitySample): void {
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
}
