import { Injectable, OnModuleInit, OnModuleDestroy, Optional, Inject } from '@nestjs/common';
import { InjectMetric, makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import { Gauge } from 'prom-client';
import { performance } from 'perf_hooks';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../ports/app-config';
import { KILL_SWITCH, type KillSwitchPort } from '../../ports/risk';
import { PORTFOLIO_VIEW, type PortfolioViewPort } from '../../ports/execution';
import { EventLoopHealthIndicator } from './event-loop-health.indicator';

export const EVENT_LOOP_DELAY_GAUGE = makeGaugeProvider({
  name: 'event_loop_delay_p99_seconds',
  help: 'Event loop delay p99 in seconds',
});

export const EVENT_LOOP_UTILIZATION_GAUGE = makeGaugeProvider({
  name: 'event_loop_utilization',
  help: 'Event loop utilization ratio',
});

export const MODE_INFO_GAUGE = makeGaugeProvider({
  name: 'mode_info',
  help: 'Trading mode info',
  labelNames: ['requested', 'effective'],
});

export const BOOT_INFO_GAUGE = makeGaugeProvider({
  name: 'boot_info',
  help: 'Boot info',
  labelNames: ['boot_id'],
});

// §5/§8 kill-switch state, sampled in the 5s loop: only the active state's series carries 1 (the
// gauge is reset each tick so stale states do not linger). Drives the KillSwitchEngaged /
// HaltedDegraded alerts (kill_switch_state{state!="RUNNING"} == 1).
export const KILL_SWITCH_STATE_GAUGE = makeGaugeProvider({
  name: 'kill_switch_state',
  help: 'Kill switch state (1 on the currently-active state label)',
  labelNames: ['state'],
});

// §8 trading metrics — PULLED from the canonical PortfolioSnapshot on the 5s sample loop. Ledger
// truth is Decimal in Postgres; these gauges are display-grade float exports (design §8: "Prometheus
// floats are display-grade exports"). Labeled gauges are reset each tick so a closed position's
// series does not linger. Unrealized PnL is embedded in equity (cash + Σ position×mark).
export const EQUITY_GAUGE = makeGaugeProvider({ name: 'equity_usdt', help: 'Account equity (cash + Σ position×mark), USDT' });
export const CASH_GAUGE = makeGaugeProvider({ name: 'cash_usdt', help: 'Free quote (USDT) balance' });
export const PEAK_EQUITY_GAUGE = makeGaugeProvider({ name: 'peak_equity_usdt', help: 'Peak equity high-water mark, USDT' });
export const DAY_PNL_GAUGE = makeGaugeProvider({ name: 'day_pnl_usdt', help: 'Equity − start-of-day-UTC equity, USDT' });
export const DRAWDOWN_GAUGE = makeGaugeProvider({ name: 'drawdown_ratio', help: '(peak − equity) / peak, 0..1' });
export const REALIZED_PNL_GAUGE = makeGaugeProvider({ name: 'realized_pnl_usdt', help: 'Realized PnL per strategy/symbol, USDT', labelNames: ['strategy', 'symbol'] });
export const POSITION_QTY_GAUGE = makeGaugeProvider({ name: 'position_qty', help: 'Signed position quantity per strategy/symbol', labelNames: ['strategy', 'symbol'] });
export const POSITION_NOTIONAL_GAUGE = makeGaugeProvider({ name: 'position_notional_usdt', help: 'abs(position) × avgEntry per strategy/symbol, USDT', labelNames: ['strategy', 'symbol'] });
export const OPEN_ORDERS_GAUGE = makeGaugeProvider({ name: 'open_orders', help: 'Open (resting) order count' });
export const IN_FLIGHT_GAUGE = makeGaugeProvider({ name: 'in_flight_intents', help: 'In-flight (reserved) intent count' });

@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  private sampleInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    @InjectMetric('event_loop_delay_p99_seconds')
    private readonly loopDelayGauge: Gauge<string>,
    @InjectMetric('event_loop_utilization')
    private readonly loopUtilizationGauge: Gauge<string>,
    @InjectMetric('mode_info')
    private readonly modeInfoGauge: Gauge<string>,
    @InjectMetric('boot_info')
    private readonly bootInfoGauge: Gauge<string>,
    @InjectMetric('kill_switch_state')
    private readonly killSwitchGauge: Gauge<string>,
    @InjectMetric('equity_usdt') private readonly equityGauge: Gauge<string>,
    @InjectMetric('cash_usdt') private readonly cashGauge: Gauge<string>,
    @InjectMetric('peak_equity_usdt') private readonly peakEquityGauge: Gauge<string>,
    @InjectMetric('day_pnl_usdt') private readonly dayPnlGauge: Gauge<string>,
    @InjectMetric('drawdown_ratio') private readonly drawdownGauge: Gauge<string>,
    @InjectMetric('realized_pnl_usdt') private readonly realizedPnlGauge: Gauge<string>,
    @InjectMetric('position_qty') private readonly positionQtyGauge: Gauge<string>,
    @InjectMetric('position_notional_usdt') private readonly positionNotionalGauge: Gauge<string>,
    @InjectMetric('open_orders') private readonly openOrdersGauge: Gauge<string>,
    @InjectMetric('in_flight_intents') private readonly inFlightGauge: Gauge<string>,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly eventLoopIndicator: EventLoopHealthIndicator,
    // @Optional so observability can boot standalone (no kill switch) — the gauge is simply not set.
    @Optional() @Inject(KILL_SWITCH) private readonly killSwitch?: KillSwitchPort,
    // @Optional so observability boots standalone; in the running app the composition root bridges
    // PORTFOLIO_VIEW into global scope so the trading gauges are populated from the canonical snapshot.
    @Optional() @Inject(PORTFOLIO_VIEW) private readonly portfolio?: PortfolioViewPort,
  ) {}

  onModuleInit() {
    const mode = this.configService.get('mode', { infer: true });
    const app = this.configService.get('app', { infer: true });

    this.modeInfoGauge
      .labels({ requested: mode.requestedMode || 'paper', effective: mode.configMode })
      .set(1);
    this.bootInfoGauge.labels({ boot_id: app.bootId }).set(1);

    let prevElu = performance.eventLoopUtilization();

    this.sampleInterval = setInterval(() => {
      const monitor = this.eventLoopIndicator.getMonitor();
      if (monitor) {
        this.loopDelayGauge.set(monitor.percentile(99) / 1e9);
        monitor.reset();
      }
      const elu = performance.eventLoopUtilization(prevElu);
      prevElu = performance.eventLoopUtilization();
      this.loopUtilizationGauge.set(elu.utilization);

      if (this.killSwitch) {
        this.killSwitchGauge.reset(); // only the current state carries 1
        this.killSwitchGauge.labels({ state: this.killSwitch.state() }).set(1);
      }

      if (this.portfolio) {
        const snap = this.portfolio.snapshot();
        this.equityGauge.set(snap.equity.toNumber());
        this.cashGauge.set(snap.balances.get('USDT')?.free.toNumber() ?? 0);
        this.peakEquityGauge.set(snap.peakEquity.toNumber());
        this.dayPnlGauge.set(snap.equity.minus(snap.sodEquityUtc).toNumber());
        this.drawdownGauge.set(
          snap.peakEquity.gt(0) ? snap.peakEquity.minus(snap.equity).div(snap.peakEquity).toNumber() : 0,
        );
        this.openOrdersGauge.set(snap.openOrders.length);
        this.inFlightGauge.set(snap.inFlightIntents.length);
        // Reset labeled series each tick so a position that closed since last sample drops to absent.
        this.realizedPnlGauge.reset();
        this.positionQtyGauge.reset();
        this.positionNotionalGauge.reset();
        for (const pos of snap.positions.values()) {
          const labels = { strategy: pos.strategyId, symbol: pos.symbol };
          this.realizedPnlGauge.labels(labels).set(pos.realizedPnl.toNumber());
          this.positionQtyGauge.labels(labels).set(pos.signedQty.toNumber());
          this.positionNotionalGauge.labels(labels).set(pos.signedQty.abs().mul(pos.avgEntry).toNumber());
        }
      }
    }, 5000);
  }

  onModuleDestroy() {
    if (this.sampleInterval) {
      clearInterval(this.sampleInterval);
      this.sampleInterval = null;
    }
  }
}
