import { Inject, Injectable, Optional } from '@nestjs/common';
import Decimal from 'decimal.js';
import { CLOCK, type ClockPort } from '../../../ports/common/clock';
import { FEED_HEALTH, type FeedHealthPort } from '../../../ports/venue/market-data';
import {
  EXECUTION_STORE,
  EQUITY_OBSERVER,
  type ExecutionStorePort,
  type EquitySample,
  type EquityObserver,
} from '../../../ports/trading/execution';
import { PortfolioStateService } from './portfolio-state.service';

// §8 post-trade equity sampling: equity = cash + Σ signedQty × mark (Decimal), on every fill
// AND every 5 s. Owns the equity_curve write and ratchets peakEquity (the input C1/C2 read).
// A symbol with no live mark is valued at its average entry (zero unrealized) rather than
// dropped — never silently fabricate PnL.
@Injectable()
export class EquitySamplerService {
  constructor(
    private readonly portfolio: PortfolioStateService,
    @Inject(FEED_HEALTH) private readonly feed: FeedHealthPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(EXECUTION_STORE) private readonly store: ExecutionStorePort,
    @Optional() @Inject(EQUITY_OBSERVER) private readonly observer?: EquityObserver,
  ) {}

  async sample(): Promise<EquitySample> {
    const now = this.clock.now();
    const cash = this.portfolio.cashBalance();
    let equity = cash;
    let unrealized = new Decimal(0);
    for (const p of this.portfolio.livePositions()) {
      const ref = this.feed.getRefPrice(p.symbol);
      const mark = ref ? ref.mid : p.avgEntry;
      equity = equity.add(p.signedQty.mul(mark));
      unrealized = unrealized.add(p.signedQty.mul(mark.sub(p.avgEntry)));
    }
    this.portfolio.recordEquity(equity, unrealized);

    const sample: EquitySample = {
      ts: now,
      equity: equity.toFixed(),
      cash: cash.toFixed(),
      unrealized: unrealized.toFixed(),
      peak: this.portfolio.peakEquity().toFixed(),
      sessionDateUtc: new Date(now).toISOString().slice(0, 10),
    };
    await this.store.savePortfolioSample(sample, [...this.portfolio.livePositions()]);
    this.observer?.(sample); // post-trade monitors (C1/C2) evaluate every sample
    return sample;
  }
}
